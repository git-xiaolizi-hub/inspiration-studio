/**
 * 三家共用的 HTTP 层：POST JSON + 超时 + 失败翻译。
 *
 * 为什么单独一层：三个适配器的差别只在**请求字段与响应字段**，
 * 而"发请求 / 超时 / 把错误体翻成人话"完全一样。复制三遍的后果是
 * 修了一个忘了另两个（M4c 已经踩过同类坑）。
 */
import { ImageError, classifyImageFailure } from './errors';
import type { ImageFetchLike, ImageRetryInfo } from './types';
import { rewriteForDevProxy } from '../shared/dev-proxy';
import { PREFLIGHT_TIMEOUT_MS, preflightOk } from '../shared/cors';

export interface PostJsonOptions {
  url: string;
  apiKey: string;
  body: unknown;
  timeoutMs: number;
  fetchImpl: ImageFetchLike;
  /** 不发 Authorization 的场合（下载 CDN 上的图） */
  withAuth?: boolean;
}

export interface JsonResponse {
  status: number;
  ok: boolean;
  text: string;
  json: unknown;
}

/** 发一次 POST，永远不抛——网络/超时也翻成 ImageError 抛出（调用方只看 ImageError） */
export async function postJson(options: PostJsonOptions): Promise<JsonResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.withAuth !== false) headers.authorization = `Bearer ${options.apiKey}`;

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  if (controller) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
  }

  /** M3R10 §1：记下耗时与异常名 —— 判「CORS 还是网络不通」只看这两样 */
  const started = Date.now();
  let response: Response;
  try {
    response = await options.fetchImpl(rewriteForDevProxy(options.url), {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body),
      signal: controller?.signal,
    });
  } catch (error) {
    if (timedOut) throw classifyImageFailure({ timedOut: true });
    const message = error instanceof Error ? error.message : String(error);
    /**
     * M3R11 §1：TypeError 时补探一次 `OPTIONS`（探用户填的原始地址，不是 dev 代理
     * 路径 —— 代理是本地同源，探它没有意义）。预检通过 ⇒ 站支持跨域 ⇒ 这次的失败
     * 其实是「被拒但读不到详情」（方舟的 401 不带 ACAO），不能报成「浏览器直连被拦」。
     */
    const errorName = error instanceof Error ? error.name : 'Error';
    const corsPreflightPassed =
      errorName === 'TypeError'
        ? await preflightOk(options.url, {
            fetchImpl: (target, init) => options.fetchImpl(target, init as RequestInit),
            timeoutMs: Math.min(PREFLIGHT_TIMEOUT_MS, options.timeoutMs),
          })
        : undefined;
    throw classifyImageFailure({
      networkFailed: true,
      message,
      errorName,
      elapsedMs: Date.now() - started,
      corsPreflightPassed,
    });
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  const text = await response.text();
  let json: unknown = undefined;
  if (text.trim() !== '') {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      if (response.ok) {
        throw new ImageError('unknown', '响应不是合法 JSON（地址可能指到了网页而不是接口）', {
          detail: text.slice(0, 300),
        });
      }
    }
  }

  if (!response.ok) throw failureFromBody(response.status, text);
  return { status: response.status, ok: true, text, json };
}

/** GET 二进制（下载成图）。失败同样翻成 ImageError。 */
export async function downloadBytes(
  url: string,
  options: { timeoutMs: number; fetchImpl: ImageFetchLike },
): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  if (!/^https?:\/\//i.test(url)) {
    throw new ImageError('unknown', `图片地址不是 http(s) URL：${url.slice(0, 80)}`);
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  if (controller) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
  }

  /** M3R10 §1：耗时与异常名是判「CORS 还是网络不通」的唯一依据 */
  const started = Date.now();
  let response: Response;
  try {
    // 下载 CDN 上的图：**不带 Authorization**（把 key 发给第三方 CDN 是泄漏）
    // M3R10 §3：同样过一遍 DEV 代理改写（CDN 域名不在挂钩表里时是恒等）
    response = await options.fetchImpl(rewriteForDevProxy(url), {
      method: 'GET',
      signal: controller?.signal,
    });
  } catch (error) {
    if (timedOut) throw classifyImageFailure({ timedOut: true });
    const message = error instanceof Error ? error.message : String(error);
    throw classifyImageFailure({
      networkFailed: true,
      message,
      errorName: error instanceof Error ? error.name : 'Error',
      elapsedMs: Date.now() - started,
    });
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw classifyImageFailure({ status: response.status, bodyText: text });
  }

  const bytes = await response.arrayBuffer();
  const mimeType = response.headers?.get?.('content-type') ?? '';
  return { bytes, mimeType };
}

/** 从错误响应体里挖 code/message（两家形状都是 `{error:{code,message}}`，但都按防御式取） */
export function failureFromBody(status: number, text: string): ImageError {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    const rawCode = error?.code ?? parsed.code;
    const rawMessage = error?.message ?? parsed.message;
    if (typeof rawCode === 'string' || typeof rawCode === 'number') code = String(rawCode);
    if (typeof rawMessage === 'string') message = rawMessage;
  } catch {
    // 不是 JSON：交给关键词分类
  }
  return classifyImageFailure({ status, bodyText: text, code, message });
}

/**
 * 429 退避重试。
 * ⚠️ 默认 `maxRetries = 0`：生图**按张计费**且是同步接口，
 * "超时/失败自动重发"很容易变成同一张图扣两次费。只有明确的 429（没出图）才值得重试。
 */
export async function withRateLimitRetry<T>(
  attemptOnce: () => Promise<T>,
  options: {
    maxRetries: number;
    retryDelaysMs: number[];
    sleep: (ms: number) => Promise<void>;
    onRetry?: (info: ImageRetryInfo) => void;
  },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      return await attemptOnce();
    } catch (error) {
      lastError = error;
      const isRateLimited = error instanceof ImageError && error.category === 'rate_limited';
      if (!isRateLimited || attempt === options.maxRetries) throw error;
      const delayMs = options.retryDelaysMs[Math.min(attempt, options.retryDelaysMs.length - 1)] ?? 0;
      options.onRetry?.({ attempt: attempt + 1, delayMs, status: 429, code: error.code });
      await options.sleep(delayMs);
    }
  }
  throw lastError;
}
