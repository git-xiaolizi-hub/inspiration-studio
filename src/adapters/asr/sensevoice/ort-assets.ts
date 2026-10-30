/**
 * onnxruntime-web 的 wasm 资源地址。
 *
 * 为什么用 public/ort-sv/ 而不是 `?url` 导入：
 * onnxruntime-web 的 package.json `exports` 只暴露入口（`.` / `./wasm` / `./all`…），
 * 不暴露 dist 下的单个文件，`import 'onnxruntime-web/dist/xxx.wasm?url'` 会被 Vite 拒绝。
 * 所以由 scripts/sync-ort.mjs 在 dev/build 前把运行时拷进 public/ort-sv/。
 *
 * 用 threaded 构建但只开单线程：GitHub Pages 不返回 COOP/COEP，没有 SharedArrayBuffer，
 * 多线程 wasm 会直接失败。
 */
const base = import.meta.env.BASE_URL || '/';
const normalized = base.endsWith('/') ? base : `${base}/`;

/**
 * 只给目录：ORT 的 `wasmPaths` 传目录时，它会自己拼 `ort-wasm-simd-threaded.wasm`，
 * 且用打包在 `ort.bundle.min.mjs` 里的 JS 胶水 —— 不需要再去 import 外部的 .mjs，
 * 避开「/public 下的 .mjs 被 Vite 拦截」这个坑（真踩过）。
 */
export const ORT_ASSETS = {
  wasm: `${normalized}ort-sv/ort-wasm-simd-threaded.wasm`,
} as const;
