/**
 * 智谱 CogVideoX-Flash 适配器（M4c，免费试跑通道）。
 *
 * 端点与字段全部来自任务书 §3（取自官方 OpenAPI）：
 * - 提交 `POST {base}/videos/generations`
 * - 查询 `GET  {base}/async-result/{id}`
 * - 状态 `PROCESSING | SUCCESS | FAIL`（**按大小写不敏感处理**，见 parseZhipuTask）
 * - 429/1305 = 免费池拥挤 → **指数退避 + 抖动重试**，不当作失败终止
 *
 * 与 Ark 的关系：
 * - 复用 `task-runner.ts`（轮询状态机）、`storage.ts`（落盘 / 24h / blob URL）、
 *   `errors.ts`（分类骨架）、`extract.ts`（任务 ID 提取）——**没有一个需要改签名**；
 * - 不复用 `payload.ts`：字段集与素材语义完全不同（详见报告 §5）。
 *
 * 取消仍是**本地取消**：智谱没有确认过的取消接口，不发任何 DELETE。
 */
import { VideoError, classifyVideoFailure, isVideoError } from './errors';
import { rewriteForDevProxy } from '../shared/dev-proxy';
import { requireTaskId } from './extract';
import { storeFetchedVideo } from './storage';
import { buildZhipuPayload } from './zhipu-payload';
import { requireZhipuVideoResult } from './zhipu-extract';
import {
  ZHIPU_ASYNC_RESULT_PATH,
  ZHIPU_BASE_URL,
  ZHIPU_BUSY_CODE,
  ZHIPU_BUSY_PATTERN,
  ZHIPU_BUSY_STATUS,
  ZHIPU_CONSOLE_URL,
  ZHIPU_DOWNLOAD_TIMEOUT_MS,
  ZHIPU_MAX_RETRIES,
  ZHIPU_MODEL_ID,
  ZHIPU_POLL_INTERVAL_MS,
  ZHIPU_POLL_TIMEOUT_MS,
  ZHIPU_REQUEST_TIMEOUT_MS,
  ZHIPU_RETRY_DELAYS_MS,
  ZHIPU_RETRY_JITTER_RATIO,
  ZHIPU_VIDEO_PATH,
} from './zhipu-constants';
import type {
  VideoAdapter,
  VideoFetchLike,
  VideoGenerationRequest,
  VideoTask,
  VideoTaskStatus,
  ZhipuAdapterConfig,
  ZhipuRetryInfo,
} from './types';

type ResolvedConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  quality: 'speed' | 'quality';
  fps: number;
  withAudio: boolean;
  movementAmplitude: 'auto' | 'small' | 'medium' | 'large';
  sendDuration: boolean;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  requestTimeoutMs: number;
  downloadTimeoutMs: number;
  maxRetries: number;
  retryDelaysMs: number[];
  retryJitterRatio: number;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchImpl: VideoFetchLike;
  now: () => number;
};

/** 一家站的 HTTP 失败：内部类型，只用来判断"要不要重试"，不对外暴露 */
class HttpFailure extends Error {
  readonly status: number;

  readonly bodyText: string;

  readonly code?: string;

  readonly serverMessage?: string;

  constructor(status: number, bodyText: string) {
    super(`HTTP ${status}`);
    this.name = 'ZhipuHttpFailure';
    this.status = status;
    this.bodyText = bodyText;
    const parsed = parseErrorBody(bodyText);
    this.code = parsed.code;
    this.serverMessage = parsed.message;
  }
}

/** 错误体形状未完全确证：`{error:{code,message}}` 与 `{code,message}` 都试 */
export function parseErrorBody(text: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    const rawCode = error?.code ?? parsed.code;
    const rawMessage = error?.message ?? parsed.message;
    return {
      code: typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : undefined,
      message: typeof rawMessage === 'string' ? rawMessage : undefined,
    };
  } catch {
    return {};
  }
}

/** 免费池拥挤：状态码 429 或业务码 1305 或中文 message 命中关键词 */
export function isFreeTierBusy(input: { status?: number; code?: string; text?: string }): boolean {
  if (input.status === ZHIPU_BUSY_STATUS) return true;
  if (input.code === ZHIPU_BUSY_CODE) return true;
  return ZHIPU_BUSY_PATTERN.test(input.text ?? '');
}

/**
 * 把通用分类"翻译成智谱口径"。
 * 起因（真实的抽象缺口）：`CATEGORY_MESSAGES` 里 auth / 余额 / 审核的下一步写死了**火山方舟**
 * 控制台与 Seedance 的限制，第二家复用时会指错地方 → 用 `nextStepOverride` 只覆盖这三类。
 */
export function tailorForZhipu(error: VideoError): VideoError {
  const rebuild = (nextStepOverride: string) =>
    new VideoError(error.category, error.message, {
      code: error.code,
      retryable: error.retryable,
      detail: error.detail,
      nextStepOverride,
    });

  if (error.category === 'auth') {
    return rebuild(
      `到智谱开放平台确认 Key 有效、且该 Key 所属项目已开通 ${ZHIPU_MODEL_ID}（免费）：${ZHIPU_CONSOLE_URL}`,
    );
  }
  if (error.category === 'insufficient_balance') {
    return rebuild(
      `免费模型本不该计费。若返回余额/额度类错误，多半是 Key 所属项目没有这个免费模型的权限：${ZHIPU_CONSOLE_URL}`,
    );
  }
  if (error.category === 'content_policy') {
    return rebuild('换掉触发审核的素材或措辞后重试（免费模型同样有内容审核）；或用 Seedance 重试');
  }
  return error;
}

export class ZhipuVideoAdapter implements VideoAdapter {
  private readonly config: ResolvedConfig;

  /** 本地取消集合（同 Ark：只停止轮询，不代表服务端已停下） */
  private readonly aborted = new Set<string>();

  /** 重试订阅者（UI 订阅它显示"拥挤，排队重试中（第 n 次）"） */
  private readonly retryListeners = new Set<(info: ZhipuRetryInfo) => void>();

  constructor(config: ZhipuAdapterConfig) {
    if (!config.apiKey || config.apiKey.trim() === '') {
      throw new VideoError('auth', '缺少智谱 BigModel API Key', {
        detail: '免费通道必须单独配置 Key（视频页的「免费通道配置」）；不配就不会出现这个通道',
      });
    }
    this.config = {
      apiKey: config.apiKey.trim(),
      baseUrl: (config.baseUrl ?? ZHIPU_BASE_URL).replace(/\/+$/, ''),
      model: config.model ?? ZHIPU_MODEL_ID,
      quality: config.quality ?? 'speed',
      fps: config.fps ?? 30,
      withAudio: config.withAudio === true,
      movementAmplitude: config.movementAmplitude ?? 'auto',
      sendDuration: config.sendDuration === true,
      pollIntervalMs: config.pollIntervalMs ?? ZHIPU_POLL_INTERVAL_MS,
      pollTimeoutMs: config.pollTimeoutMs ?? ZHIPU_POLL_TIMEOUT_MS,
      requestTimeoutMs: config.requestTimeoutMs ?? ZHIPU_REQUEST_TIMEOUT_MS,
      downloadTimeoutMs: config.downloadTimeoutMs ?? ZHIPU_DOWNLOAD_TIMEOUT_MS,
      maxRetries: config.maxRetries ?? ZHIPU_MAX_RETRIES,
      retryDelaysMs: config.retryDelaysMs ?? [...ZHIPU_RETRY_DELAYS_MS],
      retryJitterRatio: config.retryJitterRatio ?? ZHIPU_RETRY_JITTER_RATIO,
      random: config.random ?? (() => Math.random()),
      sleep: config.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      fetchImpl: config.fetchImpl ?? ((input, init) => fetch(input, init)),
      now: config.now ?? (() => Date.now()),
    };
    if (config.onRetry) this.retryListeners.add(config.onRetry);
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  get model(): string {
    return this.config.model;
  }

  get pollIntervalMs(): number {
    return this.config.pollIntervalMs;
  }

  get pollTimeoutMs(): number {
    return this.config.pollTimeoutMs;
  }

  /** UI 订阅重试事件；返回取消订阅函数 */
  listenRetry(listener: (info: ZhipuRetryInfo) => void): () => void {
    this.retryListeners.add(listener);
    return () => this.retryListeners.delete(listener);
  }

  /* ---------------------------------------------------------------- */
  /* 提交                                                             */
  /* ---------------------------------------------------------------- */

  async submit(req: VideoGenerationRequest): Promise<{ task_id: string }> {
    // 能力裁剪 / 参数校验全部在 buildZhipuPayload 里、**发请求之前**完成（判据 16 / 17）
    const payload = buildZhipuPayload(req, {
      model: this.config.model,
      quality: this.config.quality,
      fps: this.config.fps,
      withAudio: this.config.withAudio,
      movementAmplitude: this.config.movementAmplitude,
      sendDuration: this.config.sendDuration,
    });
    const raw = await this.requestWithRetry('POST', ZHIPU_VIDEO_PATH, payload);
    const { task_id } = requireTaskId(raw);
    return { task_id };
  }

  /* ---------------------------------------------------------------- */
  /* 轮询                                                             */
  /* ---------------------------------------------------------------- */

  async poll(taskId: string): Promise<VideoTask> {
    if (!taskId.trim()) {
      throw new VideoError('unknown', '轮询时任务 ID 为空');
    }
    const raw = await this.requestWithRetry(
      'GET',
      `${ZHIPU_ASYNC_RESULT_PATH}/${encodeURIComponent(taskId)}`,
    );
    return parseZhipuTask(raw, taskId);
  }

  /* ---------------------------------------------------------------- */
  /* 取消（仅本地）                                                    */
  /* ---------------------------------------------------------------- */

  async cancel(taskId: string): Promise<void> {
    this.aborted.add(taskId);
  }

  isAborted(taskId: string): boolean {
    return this.aborted.has(taskId);
  }

  resume(taskId: string): void {
    this.aborted.delete(taskId);
  }

  /* ---------------------------------------------------------------- */
  /* 下载入库（复用 storage 的同一段落盘逻辑）                          */
  /* ---------------------------------------------------------------- */

  async downloadAndStore(videoUrl: string, taskId: string): Promise<string> {
    if (!/^https?:\/\//i.test(videoUrl)) {
      throw new VideoError('unknown', `视频地址不是 http(s) URL：${videoUrl.slice(0, 80)}`);
    }
    let response: Response;
    try {
      response = await this.sendWithTimeout(videoUrl, { method: 'GET' }, this.config.downloadTimeoutMs);
    } catch (error) {
      throw isVideoError(error) ? tailorForZhipu(error) : error;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw tailorForZhipu(classifyVideoFailure({ status: response.status, bodyText: text }));
    }
    const bytes = await response.arrayBuffer();
    const mimeType = response.headers?.get?.('content-type') ?? 'video/mp4';
    try {
      const { blobUrl } = await storeFetchedVideo({
        taskId,
        bytes,
        mimeType,
        remoteUrl: videoUrl,
        now: this.config.now,
      });
      return blobUrl;
    } catch (error) {
      if (isVideoError(error)) throw error;
      throw new VideoError('unknown', `视频已存到本地库，但当前环境生不出播放地址：${String(error)}`, {
        detail: `用任务 ID ${taskId} 调 getVideoArtifact 可取回`,
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* 内部：HTTP + 退避重试                                             */
  /* ---------------------------------------------------------------- */

  private headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (hasBody) headers['content-type'] = 'application/json';
    headers.authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  private async requestWithRetry(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = `${this.config.baseUrl}${path}`;
    let retries = 0;

    for (;;) {
      try {
        return await this.requestOnce(method, url, body);
      } catch (error) {
        const failure = error instanceof HttpFailure ? error : null;
        if (!failure) {
          // 网络/超时：分类后原样抛出（与 Ark 同口径，不在这里重试）
          if (isVideoError(error)) throw tailorForZhipu(error);
          throw error;
        }
        const busy =
          isFreeTierBusy({
            status: failure.status,
            code: failure.code,
            text: `${failure.serverMessage ?? ''} ${failure.bodyText}`,
          }) || isFreeTierBusy({ code: failure.code });

        if (!busy || retries >= this.config.maxRetries) {
          if (busy) {
            throw new VideoError(
              'rate_limited',
              `免费模型拥挤：已自动重试 ${retries} 次仍未成功`,
              {
                code: failure.code ?? String(failure.status),
                retryable: true,
                detail: `${failure.status} ${failure.serverMessage ?? ''} ${failure.bodyText.slice(0, 200)}`,
              },
            );
          }
          throw tailorForZhipu(
            classifyVideoFailure({
              status: failure.status,
              bodyText: failure.bodyText,
              code: failure.code,
              message: failure.serverMessage,
            }),
          );
        }

        retries += 1;
        const base = this.config.retryDelaysMs[Math.min(retries - 1, this.config.retryDelaysMs.length - 1)];
        const jitter = Math.max(0, Math.min(1, this.config.random())) * this.config.retryJitterRatio;
        const delayMs = Math.round(base * (1 + jitter));
        const info: ZhipuRetryInfo = {
          attempt: retries,
          delayMs,
          status: failure.status,
          code: failure.code,
          message: failure.serverMessage,
        };
        for (const listener of this.retryListeners) listener(info);
        await this.config.sleep(delayMs);
      }
    }
  }

  private async requestOnce(method: 'GET' | 'POST', url: string, body?: unknown): Promise<unknown> {
    const response = await this.sendWithTimeout(url, {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    }, this.config.requestTimeoutMs);

    const text = await response.text();
    if (!response.ok) {
      throw new HttpFailure(response.status, text);
    }
    if (text.trim() === '') return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new VideoError('unknown', '响应不是合法 JSON（地址或鉴权可能不对）', {
        detail: text.slice(0, 300),
      });
    }
  }

  private async sendWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (controller) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }
    /** M3R10 §1：耗时与异常名是判「CORS 还是网络不通」的唯一依据 */
    const started = Date.now();
    try {
      // M3R10 §3：DEV 下智谱地址不在挂钩表里 → 恒等；留同一入口以免将来漏改
      return await this.config.fetchImpl(rewriteForDevProxy(url), {
        ...init,
        signal: controller?.signal,
      });
    } catch (error) {
      if (timedOut) throw classifyVideoFailure({ timedOut: true });
      const message = error instanceof Error ? error.message : String(error);
      throw classifyVideoFailure({
        networkFailed: true,
        message,
        errorName: error instanceof Error ? error.name : 'Error',
        elapsedMs: Date.now() - started,
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 响应 → VideoTask                                                    */
/* ------------------------------------------------------------------ */

const ZHIPU_STATUS_MAP: Record<string, VideoTaskStatus> = {
  QUEUED: 'queued',
  PENDING: 'queued',
  PROCESSING: 'running',
  RUNNING: 'running',
  SUCCESS: 'succeeded',
  SUCCEEDED: 'succeeded',
  FAIL: 'failed',
  FAILED: 'failed',
};

/**
 * 把查询响应翻成 `VideoTask`。
 * - **状态大小写不敏感**：官方写 `PROCESSING/SUCCESS/FAIL`，但别家网关有时用小写，
 *   防御式统一 `toUpperCase()` 再查表；表里没有的按"进行中"处理并保留 `raw_status`。
 * - SUCCESS 但取不到 URL → 抛可读错误（响应结构未验证，别静默当成功）。
 */
export function parseZhipuTask(raw: unknown, taskId: string): VideoTask {
  const root = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawStatus = typeof root.task_status === 'string'
    ? root.task_status
    : typeof root.status === 'string'
      ? root.status
      : '';
  const mapped = ZHIPU_STATUS_MAP[rawStatus.trim().toUpperCase()];

  if (mapped === 'succeeded') {
    const result = requireZhipuVideoResult(root);
    const usage = root.usage as Record<string, unknown> | undefined;
    const tokens = Number(usage?.completion_tokens ?? 0);
    return {
      task_id: taskId,
      status: 'succeeded',
      result: {
        video_url: result.video_url,
        usage: { completion_tokens: Number.isFinite(tokens) ? tokens : 0 },
      },
      raw_status: rawStatus,
      url_path: result.url_path,
    };
  }

  if (mapped === 'failed') {
    const errorRecord =
      root.error !== null && typeof root.error === 'object'
        ? (root.error as Record<string, unknown>)
        : {};
    const code = errorRecord.code ?? root.code ?? '';
    const message =
      typeof errorRecord.message === 'string'
        ? errorRecord.message
        : typeof root.message === 'string'
          ? root.message
          : `免费模型返回 ${rawStatus || 'FAIL'}`;
    return {
      task_id: taskId,
      status: 'failed',
      error: { code: String(code), message },
      raw_status: rawStatus,
    };
  }

  const progressRaw = Number(root.progress);
  return {
    task_id: taskId,
    status: mapped ?? 'running',
    progress: Number.isFinite(progressRaw) && progressRaw > 0 ? progressRaw : undefined,
    raw_status: rawStatus || undefined,
  };
}
