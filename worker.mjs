import { page } from './page.mjs';

async function readJSON(url) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(5500),
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error('upstream HTTP ' + response.status);
  return response.json();
}

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[۰-۹٠-٩]/g, c => String(c.charCodeAt(0) - (c <= '٩' ? 0x660 : 0x6f0)))
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function torobPrice(value) {
  const text = String(value ?? '').replace(/[۰-۹٠-٩]/g, c => String(c.charCodeAt(0) - (c <= '٩' ? 0x660 : 0x6f0)))
    .replace(/[,٬]/g, '').trim();
  const match = text.match(/^(?:از\s+)?(\d+)\s*(?:تومان)?$/u);
  return match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0 ? Number(match[1]) : null;
}

async function checkMarket(title, english) {
  const url = new URL('https://api.torob.com/v4/base-product/search/');
  url.search = new URLSearchParams({ query: title, page: '0', sort: 'popularity' });
  try {
    const data = await readJSON(url);
    if (!Array.isArray(data.results)) throw new Error('format');
    const titles = [normalize(title), normalize(english)].filter(Boolean);
    const candidates = [];
    for (const row of data.results) {
      if (![row.name1, row.name2].some(name => titles.includes(normalize(name)))) continue;
      const price = torobPrice(row.price);
      const target = new URL(row.web_client_absolute_url || '/', 'https://torob.com');
      if (!price || target.origin !== 'https://torob.com' || !target.pathname.startsWith('/p/')) continue;
      candidates.push({ price, url: target.href });
    }
    candidates.sort((a, b) => a.price - b.price);
    return { state: candidates.length ? 'matched' : 'no_match', offer: candidates[0] || null };
  } catch {
    return { state: 'unavailable' };
  }
}

function structuredProduct(value) {
  const entries = Array.isArray(value) ? value : [value, ...(value?.['@graph'] || [])];
  return entries.find(entry => [entry?.['@type']].flat().includes('Product') && typeof entry.name === 'string');
}

async function readProductPage(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(6000),
    headers: { Accept: 'text/html' }
  });
  if (!response.ok || !['www.digikala.com', 'digikala.com'].includes(new URL(response.url || url).hostname)) {
    throw new Error('product page HTTP ' + response.status);
  }
  const html = await response.text();
  for (const script of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let product;
    try { product = structuredProduct(JSON.parse(script[1])); } catch { continue; }
    if (!product) continue;
    const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    const amount = Number(offer?.price);
    const currency = { IRR: 10, IRT: 1 }[offer?.priceCurrency];
    const inStock = String(offer?.availability).split('/').pop() === 'InStock';
    const price = currency && inStock && Number.isFinite(amount) && amount > 0 ? amount / currency : null;
    return { title: product.name, price };
  }
  throw new Error('product schema missing');
}

async function checkProduct(input) {
  let url;
  try { url = new URL(input); } catch { return { error: 'invalid' }; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return { error: 'invalid' };
  const id = url.pathname.match(/^\/product\/dkp-(\d{1,12})(?:\/|$)/)?.[1];
  if (!['www.digikala.com', 'digikala.com'].includes(url.hostname) || !id) return { error: 'unsupported' };

  let product;
  try {
    const data = await readJSON('https://api.digikala.com/v2/product/' + id + '/');
    product = data.data?.product;
    if (!product?.title_fa) throw new Error('format');
  } catch (error) {
    const canonical = 'https://www.digikala.com/product/dkp-' + id + '/';
    const slug = url.pathname.split('/')[3];
    try {
      const fallback = await readProductPage(canonical + (slug ? slug + '/' : ''));
      return {
        id, ...fallback, url: canonical, priceSource: 'page',
        market: await checkMarket(fallback.title),
        checkedAt: new Date().toISOString()
      };
    } catch (pageError) {
      console.warn('Digikala sources unavailable', id, error.message, pageError.message);
      let searchTitle;
      try { searchTitle = slug && decodeURIComponent(slug).replace(/-/g, ' ').trim(); } catch {}
      return { error: 'source', id, searchTitle };
    }
  }

  const variant = product.default_variant;
  const price = variant?.price?.selling_price;
  const list = variant?.price?.rrp_price;
  return {
    id, title: product.title_fa,
    url: 'https://www.digikala.com/product/dkp-' + id + '/',
    price: Number.isSafeInteger(price) && price > 0 && product.status === 'marketable' ? price / 10 : null,
    list: Number.isSafeInteger(list) && list > price ? list / 10 : null,
    variant: variant?.id ? [variant.id, variant.seller?.id, variant.color?.id, variant.warranty?.id].join(':') : null,
    variantLabel: [variant?.color?.title, variant?.seller?.title].filter(Boolean).join('، '),
    market: await checkMarket(product.title_fa, product.title_en),
    checkedAt: new Date().toISOString()
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/api/check' && request.method === 'GET') {
      const input = url.searchParams.get('url') || '';
      const result = input.length > 2048 ? { error: 'invalid' } : await checkProduct(input);
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    }
    return new Response(null, { status: 404 });
  }
};
