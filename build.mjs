import { mkdir, readFile, writeFile } from 'node:fs/promises';

const page = await readFile(new URL('index.html', import.meta.url), 'utf8');
const worker = await readFile(new URL('worker.mjs', import.meta.url), 'utf8');
const directory = new URL('dist/server/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('index.js', directory),
  worker.replace("import { page } from './page.mjs';", () => 'const page = ' + JSON.stringify(page) + ';'));
