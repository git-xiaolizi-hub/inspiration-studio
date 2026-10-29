/**
 * Ark Seedance 2.5 适配器（M4b 正式实现）。
 *
 * 端点与字段只按**任务书 §3 已确认的形状**写，未确认的一律防御式处理并在报告里标"未验证"：
 * - 提交：`POST {base}/contents/generations/tasks`
 * - 查询：`GET  {base}/contents/generations/tasks/{id}`（官方建议 30 秒间隔）
 * - 状态：`succeeded` / `failed` / `running` 已确认；**其他值按"进行中"处理并原样记录**
 * - 用量：`usage.completion_tokens`（官方计价页口径）
 *
 * 取消：**本地取消**。官方 QPS 表里出现了"取消或删除视频生成任务"这一行，
 * 但**没有给出端点/HTTP 方法**，所以本适配器不发任何取消请求，只停止轮询并把任务标 `aborted`，
 * 同时保留 task_id 供用户事后查询（任务可能仍在服务端计费）。
 */
import {
  ARK_BASE_URL,
  ARK_MODEL_ID,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  REQUEST_BODY_MAX_BYTES,
  TASKS_PATH,
} from './constants';
import { VideoError, classifyVideoFailure } from './errors';
import { rewriteForDevProxy } from '../shared/dev-proxy';
import { PREFLIGHT_TIMEOUT_MS, preflightOk } from '../shared/cors';
import { assertPayloadFits } from './media';
import { requireTaskId, requireVideoResult } from './extract';
import { buildDraftFinalizePayload, buildTaskPayload } from './payload';
import type { ArkTaskPayload } from './payload';
import { makeBlobUrl, saveVideoArtifact } from './storage';
import type {
  ArkAdapterConfig,
  VideoAdapter,
  VideoFetchLike,
  VideoGenerationRequest,
  VideoTask,
  VideoTaskStatus,
} from './types';

type ResolvedConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  pollTimeoutMs: number;
  downloadTimeoutMs: number;
  maxRequestBodyBytes: number;
  fetchImpl: VideoFetchLike;
  now: () => number;
  watermark: boolean;
  generateAudio: boolean;
};

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export class ArkVideoAdapter implements VideoAdapter {
  private readonly config: ResolvedConfig;

  /** 本地取消集合：只影响"要不要继续轮询"，不代表服务端已取消 */
  private readonly aborted = new Set<string>();

  /** 最近一次提交的请求体大小（字节），UI 可展示，也用于判据 7 的断言 */
  private lastRequestBytes = 0;

  constructor(config: ArkAdapterConfig) {
    if (!config.apiKey || config.apiKey.trim() === '') {
      throw new VideoError('auth', '缺少火山方舟 API Key', {
        detail: 'Ark 的鉴权是 Authorization: Bearer <key>',
      });
    }
    this.config = {
      apiKey: config.apiKey.trim(),
      baseUrl: (config.baseUrl ?? ARK_BASE_URL).replace(/\/+$/, ''),
      model: config.model ?? ARK_MODEL_ID,
      pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      pollTimeoutMs: config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
      downloadTimeoutMs: config.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
      maxRequestBodyBytes: config.maxRequestBodyBytes ?? REQUEST_BODY_MAX_BYTES,
      fetchImpl: config.fetchImpl ?? ((input, init) => fetch(input, init)),
      now: config.now ?? (() => Date.now()),
      watermark: config.watermark ?? false,
      generateAudio: config.generateAudio ?? true,
    };
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  get pollIntervalMs(): number {
    return this.config.pollIntervalMs;
  }

  get pollTimeoutMs(): number {
    return this.config.pollTimeoutMs;
  }

  get model(): string {
    return this.config.model;
  }

  get lastRequestBodyBytes(): number {
    return this.lastRequestBytes;
  }

  /* ---------------------------------------------------------------- */
  /* 提交                                                             */
  /* ---------------------------------------------------------------- */

  async submit(req: VideoGenerationRequest): Promise<{ task_id: string }> {
    const payload = buildTaskPayload(req, {
      model: this.config.model,
      watermark: this.config.watermark,
      generateAudio: this.config.generateAudio,
    });
    return this.createTask(payload);
  }

  /**
   * 样片第二步：基于 Draft 任务 ID 出成片。
   * 依据 `ark-seedance-2.5.txt`「Step2:生成正式视频」：content 里放 draft_task，分辨率只能 1080p。
   * （任务书原来的兜底方案是"把 Draft 视频当 reference_video"，文档里查到了更准的做法，故采用文档。）
   */
  async submitFromDraft(draftTaskId: string): Promise<{ task_id: string }> {
    const payload = buildDraftFinalizePayload(draftTaskId, {
      model: this.config.model,
      watermark: this.config.watermark,
    });
    return this.createTask(payload);
  }

  private async createTask(payload: ArkTaskPayload): Promise<{ task_id: string }> {
    // 先估算请求体，超 64MB 直接拒绝 —— 一个字节都不发（判据 7）
    this.lastRequestBytes = assertPayloadFits(payload, this.config.maxRequestBodyBytes);
    const raw = await this.request('POST', TASKS_PATH, payload);
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
    const raw = await this.request('GET', `${TASKS_PATH}/${encodeURIComponent(taskId)}`);
    return parseTask(raw, taskId);
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

  /** 用户事后想继续看（刷新后重新轮询）时清掉本地取消标记 */
  resume(taskId: string): void {
    this.aborted.delete(taskId);
  }

  /* ---------------------------------------------------------------- */
  /* 下载入库                                                         */
  /* ---------------------------------------------------------------- */

  async downloadAndStore(videoUrl: string, taskId: string): Promise<string> {
    if (!/^https?:\/\//i.test(videoUrl)) {
      throw new VideoError('unknown', `视频地址不是 http(s) URL：${videoUrl.slice(0, 80)}`);
    }
    const response = await this.sendWithTimeout(
      videoUrl,
      { method: 'GET' },
      this.config.downloadTimeoutMs,
      { withAuth: false },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw classifyVideoFailure({ status: response.status, bodyText: text });
    }
    const buffer = await response.arrayBuffer();
    const mimeType = response.headers?.get?.('content-type') ?? 'video/mp4';
    const blob = new Blob([buffer], { type: mimeType });
    const artifact = await saveVideoArtifact({
      taskId,
      blob,
      remoteUrl: videoUrl,
      mimeType,
      now: this.config.now,
    });
    try {
      return makeBlobUrl(artifact.blob);
    } catch (error) {
      // 已落盘，只是这个环境给不出 blob URL（例如某些测试环境）
      throw new VideoError('unknown', `视频已存到本地库，但当前环境生不出播放地址：${String(error)}`, {
        detail: `用任务 ID ${taskId} 调 getVideoArtifact 可取回`,
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* 内部：HTTP                                                       */
  /* ---------------------------------------------------------------- */

  private headers(withAuth: boolean, hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (hasBody) headers['content-type'] = 'application/json';
    if (withAuth) headers.authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const url = path.startsWith('http') ? path : `${this.config.baseUrl}${path}`;
    const response = await this.sendWithTimeout(
      url,
      {
        method,
        headers: this.headers(true, body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      this.config.requestTimeoutMs,
      { withAuth: true },
    );

    const text = await response.text();

    if (!response.ok) {
      throw failureFromBody(response.status, text);
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

  private async sendWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    _options: { withAuth: boolean },
  ): Promise<Response> {
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
      // M3R10 §3：DEV 下把方舟地址改写成 dev server 的 /__px/ark（生产是恒等函数）
      return await this.config.fetchImpl(rewriteForDevProxy(url), {
        ...init,
        signal: controller?.signal,
      });
    } catch (error) {
      if (timedOut) throw classifyVideoFailure({ timedOut: true });
      const message = error instanceof Error ? error.message : String(error);
      /**
       * M3R11 §1：TypeError 时补探 `OPTIONS` —— 预检通过说明站支持跨域，这次失败其实
       * 是「被拒但读不到详情」（方舟 401 不带 ACAO），文案要指向 Key / 模型名。
       */
      const errorName = error instanceof Error ? error.name : 'Error';
      const corsPreflightPassed =
        errorName === 'TypeError'
          ? await preflightOk(url, {
              fetchImpl: (target, init) => this.config.fetchImpl(target, init as RequestInit),
              timeoutMs: Math.min(PREFLIGHT_TIMEOUT_MS, timeoutMs),
            })
          : undefined;
      throw classifyVideoFailure({
        networkFailed: true,
        message,
        errorName,
        elapsedMs: Date.now() - started,
        corsPreflightPassed,
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}

/** 从错误响应体里挖 code/message（形状未验证：{error:{code,message}} 与 {code,message} 都试） */
function failureFromBody(status: number, text: string): VideoError {
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
    // 不是 JSON：走关键词分类
  }
  return classifyVideoFailure({ status, bodyText: text, code, message });
}

const KNOWN_STATUSES: VideoTaskStatus[] = ['queued', 'running', 'succeeded', 'failed'];

/**
 * 把查询响应转成 VideoTask。
 * - 未知状态 → `running` + `raw_status` 原样保留（任务书 §3）
 * - `failed` → 带 `error`，分类由 UI 侧的 `describeTask` 做
 */
export function parseTask(raw: unknown, taskId: string): VideoTask {
  const root = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawStatus = typeof root.status === 'string' ? root.status : '';

  if (rawStatus === 'succeeded') {
    const result = requireVideoResult(root);
    return {
      task_id: taskId,
      status: 'succeeded',
      result: {
        video_url: result.video_url,
        last_frame_url: result.last_frame_url,
        usage: result.usage,
      },
      raw_status: rawStatus,
      url_path: result.url_path,
    };
  }

  if (rawStatus === 'failed') {
    const errorRecord =
      root.error !== null && typeof root.error === 'object'
        ? (root.error as Record<string, unknown>)
        : {};
    return {
      task_id: taskId,
      status: 'failed',
      error: {
        code: typeof errorRecord.code === 'string' ? errorRecord.code : String(errorRecord.code ?? ''),
        message:
          typeof errorRecord.message === 'string'
            ? errorRecord.message
            : JSON.stringify(root.error ?? {}).slice(0, 300),
      },
      raw_status: rawStatus,
    };
  }

  const known = KNOWN_STATUSES.find((status) => status === rawStatus);
  const progressRaw = Number(root.progress);
  return {
    task_id: taskId,
    status: known ?? 'running',
    progress: Number.isFinite(progressRaw) && progressRaw > 0 ? progressRaw : undefined,
    raw_status: rawStatus || undefined,
  };
}
