#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(here, '..', 'dist', 'src', 'main.js');

if (existsSync(distEntry)) {
  await import(pathToFileURL(distEntry).href);
} else {
  console.error('gitreview: 找不到构建产物，请先运行 `npm run build`（或用 `npx tsx src/main.ts` 直接运行源码）。');
  process.exit(1);
}