/**
 * 浏览器直连被 CORS 拦死的判定（M3R10；M3R11 改为**两段判定**）。
 *
 * 为什么单独一个模块：**三个适配器家族**（AI 对话 `ai-models`、生图 `image`、
 * 视频 `video`）各有自己的一套错误分类，但「这次失败到底是不是 CORS」是同一件事，
 * 判据必须只有一份 —— 否则修了一家忘了另外两家（M4c 踩过同类坑）。
 *
 * ⚠️ M3R11 §0：**上一轮的核心判断是错的**。方舟（豆包）浏览器可以直连 ——
 * 用真 key 实测：`OPTIONS /api/v3/chat/completions` → 204（反射任意 Origin），
 * `POST` → 响应可读（HTTP 404，`InvalidEndpointOrModel.NotFound`）。
 * 上一轮之所以判「拦死」，是因为只看**未带 key 的 401** —— 而方舟的 401 **恰好不带
 * `access-control-allow-origin`**：
 *
 * | 方舟的响应类型 | 带 ACAO |
 * |---|---|
 * | OPTIONS 预检 | ✅ |
 * | 业务响应（404 等） | ✅ |
 * | **401 鉴权失败** | ❌ |
 *
 * 后果：**key 写错时，浏览器里看到的只是 `TypeError`，与「被 CORS 拦」在 JS 侧完全
 * 一样**。所以「TypeError → CORS_BLOCKED」会把用户送去换厂商，而真正该做的是核对 key。
 *
 * 两段判定（M3R11 §1）：
 * 1. 先按老判据认出「像 CORS 的失败」（无状态码 + `error.name === 'TypeError'` + 快）；
 * 2. 再发一次 `OPTIONS` 探该地址 —— **能读到状态码即视为预检通过**：
 *    - 通过 → `REJECTED_UNREADABLE`（站支持 CORS，但这次请求被拒且读不到详情）；
 *    - 不通过（预检也抛 TypeError / 403）→ `CORS_BLOCKED`（真·不许浏览器直连）。
 */

/**
 * 耗时上限：CORS 拦截在本地完成（实测 57–66ms），远快于任何真实超时。
 * 超过这个数还抛 TypeError 的，更可能是 DNS / 连接层问题，宁可归到网络不可达
 * （那样用户去查网络是对的），也不要谎报 CORS。
 */
export const CORS_FAST_FAILURE_MS = 3000;

/**
 * 必须逐字出现在用户可见文案里的那句结论（M3R10 §5-2；M3R11 §1 更新措辞）。
 * M3R11 起把「豆包（方舟）」写进可选厂商 —— 方舟已实测可直连。
 */
export const CORS_BLOCKED_SENTENCE =
  '这家不允许浏览器直连（服务器未开放跨域）。中转站常见。桌面版可用；Web 版请改用智谱 / 豆包 / DeepSeek / Kimi / 阿里百炼。';

/**
 * M3R11 §1：预检通过、但业务请求仍失败且读不到详情时的结论。**必须逐字**。
 *
 * 禁止把它说成「网络不通 / 检查代理」—— 站是通的，问题在 key / 模型名 / 分组权限。
 */
export const REJECTED_UNREADABLE_SENTENCE =
  '服务器拒绝了这次请求，但浏览器读不到详情（多半是 Key 无效、模型名不对，或该 Key 没有这个模型的权限）。请先核对 Key 与模型名；仍不行再点「拉取模型列表」看这家给了什么模型。';

/** 连接行 / 自检失败处的那行小字（判据 §2）。 */
export const CORS_BLOCKED_HINT = '浏览器直连被这家拒绝（CORS）。用桌面版可正常调用。';

export interface CorsSignal {
  /** HTTP 状态码；没拿到响应时是 0 或 undefined */
  status?: number;
  /** fetch 抛出的异常名（`TypeError` = 浏览器拦截的典型形态） */
  errorName?: string;
  /** 从发起到抛异常的耗时 */
  elapsedMs?: number;
}

/**
 * 这次失败是不是「像 CORS 拦的」。**只说明形态像**，还要过第二段（`preflightOk`）
 * 才能断言是 CORS。
 *
 * 有状态码一律不算 —— 401/403/404/429 都是**拿到了响应**，跨域是放行的，
 * 必须继续走原有的状态码分类（判据 §5-3：不能被误判成 CORS）。
 */
export function looksLikeCorsBlock(signal: CorsSignal): boolean {
  const { status, errorName, elapsedMs } = signal;
  if (typeof status === 'number' && status !== 0) return false;
  if (errorName !== 'TypeError') return false;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return false;
  return elapsedMs < CORS_FAST_FAILURE_MS;
}

/** 探针用的最小 fetch 形状（与各适配器的 FetchLike 结构兼容，避免交叉依赖） */
export type PreflightFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number }>;

export interface PreflightOptions {
  /** 注入用（单测 / 适配器自己的 fetch 实现）；缺省用全局 fetch */
  fetchImpl?: PreflightFetchLike;
  /** 预检超时；默认 5s —— 预检本身极快，慢到这个量级基本就是没戏 */
  timeoutMs?: number;
}

export const PREFLIGHT_TIMEOUT_MS = 5000;

/**
 * 第二段判定：对该地址发一次 `OPTIONS`，**能读到状态码即视为预检通过**。
 *
 * 为什么是状态码：浏览器只有在 CORS 检查通过时才会把响应交给 JS；
 * 被拦时 `fetch` 只会抛 `TypeError`，连 403 都看不到。所以「拿到了 status」这件事
 * 本身就是「这站放行跨域」的证据（状态码是 204 / 404 / 405 都无所谓）。
 *
 * 注：`Access-Control-Request-Method/-Headers` 在浏览器里属于 forbidden header，
 * JS 设置会被静默忽略（真正发预检时浏览器自己加）；这里写出来是为了脚本/curl
 * 复现时一眼看出探的是什么。`OPTIONS` 本身不是 safelisted method，所以浏览器会
 * 为这次探测自己再发一次预检 —— 正是我们要的结果。
 */
export async function preflightOk(url: string, options: PreflightOptions = {}): Promise<boolean> {
  const impl =
    options.fetchImpl ??
    (typeof fetch === 'function' ? (fetch as unknown as PreflightFetchLike) : null);
  if (!impl) return false;

  const timeoutMs = options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const response = await impl(url, {
      method: 'OPTIONS',
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
      signal: controller?.signal,
    });
    return typeof response?.status === 'number';
  } catch {
    // 预检本身被拦 / 超时 / 地址非法 —— 都算「预检没过」
    return false;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * M3R11 §1 的两段判定本体：给「像 CORS 的失败」一个最终归类。
 *
 * `preflightPassed === undefined` 表示**没探**（例如非浏览器环境、或探针自己不可用），
 * 这时保守地按老的 `CORS_BLOCKED` 走 —— 老行为、老文案，不让回归。
 */
export function decideCorsOrRejected(
  preflightPassed: boolean | undefined,
): 'cors_blocked' | 'rejected_unreadable' {
  return preflightPassed === true ? 'rejected_unreadable' : 'cors_blocked';
}
