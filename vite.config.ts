/// <reference types="vitest" />
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = dirname(fileURLToPath(import.meta.url));
/** 工作流模块的入口（可选模块：这一份文件在不在，决定插件介不介入） */
const WORKFLOW_ENTRY = resolvePath(projectRoot, 'src/ui/workflow/index.tsx');

/**
 * 「可选模块」兜底（M5b）。
 *
 * CHARTER 把工作向画板定为**可选模块**：删掉 `src/ui/workflow/` 后其余功能照样能构建。
 * 但 `App.tsx` 里那一行 `lazy(() => import('./ui/workflow'))` 在目录消失后就变成
 * "解析不到的模块"，Rollup 会直接 fail —— 那样"能整块删掉"就只是口号。
 *
 * 判据只看一件事：**入口文件在不在**。
 * - 在 → 插件返回 null，完全不介入（正常解析、正常打包、类型照常检查）；
 * - 不在 → 返回一个空组件，让构建通过（运行时点进 /workflow 是空白页）。
 *
 * ⚠️ 第一版用 `this.resolve(..., { skipSelf: true })` 试探"能不能解析"，实测在
 * `enforce: 'pre'` 阶段拿到 null（内置 resolve 还没跑），结果**模块存在时也被换成了空壳** ——
 * 产物里 workflow chunk 只有 0.05 kB，等于功能被静默剔掉。改成文件存在性判断后修正。
 */
function optionalUiModules(): Plugin {
  const VIRTUAL_PREFIX = '\0virtual:missing-ui-module:';
  const TARGET = 'ui/workflow';

  return {
    name: 'optional-ui-modules',
    enforce: 'pre',
    resolveId(source) {
      // 只处理相对导入：vitest 会把**测试文件的绝对路径**也丢进 resolveId，
      // 而绝对路径里同样含 `ui/workflow` —— 上一版会把测试文件替换成 index.tsx，
      // 于是全量跑时这 5 个套件全报 "No test suite found"（单独跑不复现）。
      if (!source.startsWith('.')) return null;
      if (!source.includes(TARGET)) return null;
      // 入口存在 → **显式**给出入口文件；不存在 → 虚拟空壳。
      // 为什么要显式：实测 Rollup/Vite 这条链上不解析"目录 + index.tsx"
      // （`import('./ui/workflow')` 会报 Could not resolve），显式返回绝对路径最稳。
      return existsSync(WORKFLOW_ENTRY) ? WORKFLOW_ENTRY : `${VIRTUAL_PREFIX}${source}`;
    },
    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      return 'export default function MissingOptionalModule() {\n  return null;\n}\n';
    },
  };
}

// 纯前端应用：不做 SSR，构建产物为静态文件（M6 再由打包器包成桌面应用）
export default defineConfig({
  /**
   * 部署到子路径（GitHub Pages 的项目页是 /<仓库名>/）时由 CI 传 `VITE_BASE`；
   * 本地开发与桌面版打包不传，仍是根路径 `/`。
   */
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), optionalUiModules()],
  /**
   * M3R10 §3；**M3R11 §4 收窄**：开发期反向代理。
   *
   * 只有 `VENDOR_META[id].webCors === 'blocked'` 的厂商才需要它（现在只剩灵绘：
   * `OPTIONS` → 403，nginx 直接拒预检）。**方舟已移除** —— 它实测支持 CORS
   * （`OPTIONS` → 204，业务响应可读），走代理反而测不到真实 CORS。
   *
   * 请求层只在 `import.meta.env.DEV` 时把被拦厂商的绝对地址改写成 `/__px/<厂商 id>`
   * （见 `src/adapters/shared/dev-proxy.ts`）——生产构建里那段代码被常量折叠摇掉，
   * 产物 grep 不到 `__px`（判据 §5-6）。
   *
   * ⚠️ 挂载名必须与 `dev-proxy.ts` 里的 `/__px/${id}` 逐字一致；不一致时
   * `dev-proxy.test.ts` 会红（它直接读本文件交叉核对）。
   */
  server: {
    port: 5173,
    proxy: {
      '/__px/linghui': {
        target: 'https://xn--ai-xg4e312c.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__px\/linghui/, ''),
      },
    },
  },
  // ASR Worker 里用动态 import 懒加载 transformers.js（不进主包），
  // 而 iife 格式不支持代码分割，所以 worker 必须用 ES 模块格式。
  worker: { format: 'es' },
  build: { outDir: 'dist', sourcemap: false },
  test: {
    environment: 'jsdom',
    // IndexedDB 在 jsdom 里不存在，测试里由各用例显式引入 fake-indexeddb
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    restoreMocks: true,
  },
});
