/**
 * 把 onnxruntime 的 WASM 运行时复制到 `public/ort/`（M2.5 构建期步骤）。
 *
 * 为什么需要：transformers.js 默认把 `env.backends.onnx.wasm.wasmPaths` 指向
 * `cdn.jsdelivr.net`。对"离线可用、数据不出本机"的应用，这等于第一次本地转写必须联网，
 * 而且 jsdelivr 在部分网络下不可达。把这两个文件随应用发布，Worker 里指到本地即可。
 *
 * 文件名保持原样（不带 hash）：worker 里用固定 URL 前缀拼，路径可预测。
 * 由 `npm run predev` / `prebuild` 自动执行；文件不进 git（public/ort/ 已忽略）。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const TARGET_DIR = join(ROOT, 'public', 'ort');

/** asyncify 变体 = transformers.js 对现代浏览器的默认选择 */
const FILES = [
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
];

let copied = 0;
mkdirSync(TARGET_DIR, { recursive: true });

for (const file of FILES) {
  const source = join(SOURCE_DIR, file);
  const target = join(TARGET_DIR, file);
  if (!existsSync(source)) {
    console.error(`❌ 缺少 ${source} —— 依赖没装好？先跑 npm install`);
    process.exit(1);
  }
  if (existsSync(target) && statSync(target).size === statSync(source).size) {
    continue;
  }
  copyFileSync(source, target);
  copied += 1;
  console.log(`  复制 ${file}（${(statSync(source).size / 1048576).toFixed(1)} MB）`);
}

console.log(
  copied === 0
    ? `ort 运行时已就绪（${FILES.length} 个文件无需更新）`
    : `ort 运行时已就绪：${TARGET_DIR}`,
);
