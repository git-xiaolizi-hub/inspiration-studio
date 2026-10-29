/**
 * 开发期反向代理的地址改写（M3R10 §3；M3R11 §4 收窄）。
 *
 * 用途：**只有被 CORS 拦死的厂商**才需要 dev 代理 —— 浏览器直连会被拦，桌面版
 * （Tauri 从 Rust 侧发请求）不受 CORS 管，而开发期要能真机验证适配器逻辑。
 *
 * ⚠️ M3R11 §4：**方舟不再走代理**。上一轮把 `/__px/ark` 也挂上了，但方舟实测
 * 支持 CORS（`OPTIONS` → 204，业务响应可读，见 `docs/reference/cors-matrix.md`
 * §1c）。走代理反而**测不到真实 CORS**：代理是本地同源，永远"通"。
 * 判定来源只有一个：`VENDOR_META[id].webCors === 'blocked'`（不是 host 硬编码）——
 * 这样以后哪家被放开/被拦，只改厂商标的一个字段，这里自动跟随。
 *
 * 铁律：**只有开发环境才改写**。生产构建必须原样使用用户填的 base_url ——
 * 打包成桌面版后没有 dev server，改写会让所有请求打到不存在的 `/__px/...` 上。
 *
 * **为什么守卫与地址表必须在同一个函数体里**（判据 §5-6 靠这个成立）：
 * vite 构建时把 `import.meta.env.DEV` 替换成字面量 `false`，于是首行变成
 * `if (true) return url;` → 无条件 return，其后所有语句（含挂载前缀）成了不可达代码，
 * 被压缩器整体删除 —— 这就是「构建产物 grep 不到 `__px`」的机制。
 * ⚠️ 所以挂载前缀**不能**抽成另一个（仍被引用的）常量：那样它是"活代码"，
 * `__px` 就会照原样留在生产产物里。映射逻辑一律内联在本函数内。
 *
 * **为什么还要排掉 test 模式**（实测踩到的坑，M3R10 报告 §4-①）：
 * vitest 也不设 `NODE_ENV=production`，所以 `import.meta.env.DEV` 在单测里**也是 true**。
 * 而 `ArkImageAdapter` 这类适配器把 base_url 默认成 `ark.cn-beijing.volces.com` 本身，
 * 于是单测里会被改写成**相对路径** `/__px/ark/...`，测试用的 mock fetch 拿到相对路径
 * `new URL()` 直接抛 —— 结果是被误判成 `cors_blocked`（实测两条生图用例变红）。
 * 单测打的是 mock server，**根本不该有 dev 代理**：代理是 dev server 的事，
 * 不是单元测试的事。所以用 `MODE === 'test'` 明确排掉；
 * `dev-proxy.test.ts` 用 `vi.stubEnv('MODE', 'development')` 单独验真映射。
 *
 * vite.config.ts 里的挂载名与本文件必须一致（改了一处忘了另一处 →
 * `dev-proxy.test.ts` 会红，它直接读 vite.config.ts 原文交叉核对）。
 *
 * 注：本改写**不**动 `endpointCandidates` 的返回值，只在真正发请求那一刻改写。
 * 否则这个纯函数在 DEV 下会返回相对路径，把它已有的一批地址断言全打翻。
 */
import { VENDOR_META } from '../ai-models/catalog';

/**
 * 请求层唯一的入口：DEV（且不是单测）时把 **`webCors === 'blocked'` 的厂商**地址
 * 改写成 dev server 的代理路径，其余情况**一个字符都不改**
 * （含：CORS 放行的厂商、合法但不匹配的地址、压根不是 URL 的串）。
 */
export function rewriteForDevProxy(url: string): string {
  if (!import.meta.env.DEV || import.meta.env.MODE === 'test') return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // 不是合法 URL（用户可能只填了半截地址）：原样交给下游去报「地址不合法」
    return url;
  }
  /**
   * 地址表**内联在这里**（见文件头注释：抽出去就存活代码，`__px` 会漏进生产产物）。
   * 数据源是厂商表，不是硬编码的 host 列表 —— 谁被拦，谁才被代理。
   */
  for (const [id, meta] of Object.entries(VENDOR_META)) {
    if (meta.webCors !== 'blocked') continue;
    let origin: URL;
    try {
      origin = new URL(meta.baseUrl);
    } catch {
      continue;
    }
    // 只按 host 匹配；`parsed.host` 不含路径，所以"域名出现在路径里"不会被误改
    if (origin.host !== parsed.host) continue;
    return `/__px/${id}${parsed.pathname}${parsed.search}`;
  }
  return url;
}
