/**
 * 构建后清理（M3：消掉 dist/assets 里那份未被引用的 hash 化 wasm，26.8MB）。
 *
 * 背景：transformers.js 打包时会把 onnxruntime 的 asyncify wasm 作为「兜底 URL」塞进产物
 * （`new URL("/assets/ort-wasm-...-<hash>.wasm", import.meta.url)`），而我们的 Worker 在
 * init 前显式把 `wasmPaths` 指到随应用发布的 `public/ort/`（复制于 prebuild）。
 * 于是 dist/assets 里那份 26.8MB 永远不会被加载，却被打进了安装包。
 *
 * 做法（比"直接删"更稳）：把引用**改写成 /ort/ 的固定路径**，再删除 dist/assets 里的 hash 文件。
 * 这样即使某天 wasmPaths 没生效，兜底 URL 依然指向真实存在的文件，不会 404。
 *
 * 判据：`npm run build && ls dist/assets/*.wasm` 无输出。
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ASSETS = join(DIST, 'assets');
const ORT_DIR = join(DIST, 'ort');

if (!existsSync(ASSETS)) {
  console.error('❌ 找不到 dist/assets —— 先跑 vite build');
  process.exit(1);
}

const wasmFiles = readdirSync(ASSETS).filter((name) => name.endsWith('.wasm'));
if (wasmFiles.length === 0) {
  console.log('dist/assets 里没有 wasm，无需清理。');
  process.exit(0);
}

/** 文本产物（js/html）里可能出现 /assets/<name> 的引用 */
const textFiles = readdirSync(ASSETS)
  .filter((name) => name.endsWith('.js') || name.endsWith('.css') || name.endsWith('.html'))
  .map((name) => join(ASSETS, name));
if (existsSync(join(DIST, 'index.html'))) textFiles.push(join(DIST, 'index.html'));

/** ort-wasm-simd-threaded.asyncify-CxOG5pUO.wasm → ort-wasm-simd-threaded.asyncify.wasm */
function withoutHash(name) {
  return name.replace(/-[A-Za-z0-9_-]{8}\.wasm$/, '.wasm');
}

let removed = 0;
let rewritten = 0;

for (const file of wasmFiles) {
  const assetPath = `/assets/${file}`;
  const stableName = withoutHash(file);
  const stableTarget = join(ORT_DIR, stableName);

  let referenced = false;
  for (const textFile of textFiles) {
    const content = readFileSync(textFile, 'utf8');
    if (!content.includes(assetPath)) continue;
    referenced = true;

    if (existsSync(stableTarget)) {
      // 指向随应用发布的固定文件（不带 hash，路径可预测）
      writeFileSync(textFile, content.split(assetPath).join(`/ort/${stableName}`), 'utf8');
      rewritten += 1;
    } else {
      console.error(`❌ ${file} 仍被 ${textFile} 引用，但 dist/ort/${stableName} 不存在，不敢删`);
      process.exit(1);
    }
  }

  const sizeMB = (statSync(join(ASSETS, file)).size / 1048576).toFixed(1);
  unlinkSync(join(ASSETS, file));
  removed += 1;
  console.log(`  删除 dist/assets/${file}（${sizeMB} MB${referenced ? '，引用已改指 /ort/' : '，无引用'}）`);
}

console.log(
  `构建后清理完成：删除 ${removed} 个 wasm，改写 ${rewritten} 处引用（运行时用 dist/ort/ 里的固定文件）。`,
);
