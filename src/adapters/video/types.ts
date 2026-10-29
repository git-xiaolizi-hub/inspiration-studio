/**
 * 视频适配器接口契约（对应 CHARTER §4）+ M4b 的 Ark 实现所需配置。
 *
 * 三条纪律（写成类型而不是注释）：
 * 1. `fetchImpl` 可注入 —— 判据全部走 mock server，绝不发真实请求（CHARTER §13.2）；
 * 2. `VideoTask.status` 只有终态/非终态两种语义，**未知状态按"进行中"处理并原样记录在 `raw_status`**；
 * 3. 取消是**本地取消**（停止轮询 + 标 `aborted`），不假装有官方取消接口。
 */

export type VideoResolution = '480p' | '720p' | '1080p';
export type VideoRatio = '16:9' | '9:16' | '1:1' | 'adaptive';

/**
 * `aborted` 是 M4b 新增：任务书要求"本地取消后任务标记 aborted"。
 * CHARTER §4 原文只有 queued/running/succeeded/failed，这里**只增加一个成员**，
 * 语义是"本地停止追踪"，不代表服务端任务已取消（见 ArkVideoAdapter.cancel 注释）。
 */
export type VideoTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'aborted';

/**
 * 参考图/视频/音频。
 *
 * M4b 追加了可选 `asset`：小文件（< 5MB）要走 base64 时，手上只有字节没有 URL，
 * 需要一个能携带字节的入口。`url` 因此变成可选，但**请求体形状不变**——
 * 仍是 `image_url.url` / `video_url.url` / `audio_url.url`（见 `payload.ts`）。
 */
export interface ReferenceImages {
  url?: string;
  role: 'character' | 'scene' | 'style';
  asset?: MediaAsset;
}

export interface ReferenceVideos {
  url?: string;
  role: 'motion' | 'editing_target';
  asset?: MediaAsset;
}

export interface VideoGenerationRequest {
  prompt: string;
  references?: {
    images?: ReferenceImages[];
    videos?: ReferenceVideos[];
    audio?: Array<{ url?: string; asset?: MediaAsset }>;
  };
  /** 首尾帧：position 为 first/last 或第 n 个关键帧序号 */
  keyframes?: Array<{ position: 'first' | 'last' | number; image_url?: string; asset?: MediaAsset }>;
  params: {
    /** 4–30 秒；-1 表示由模型自选 */
    duration: number | -1;
    resolution: VideoResolution;
    ratio: VideoRatio;
    /** true = 生成 Draft（480p 样片） */
    draft_mode?: boolean;
  };
}

export interface VideoTask {
  task_id: string;
  status: VideoTaskStatus;
  /** 0–100 */
  progress?: number;
  result?: {
    /** 有效期 24 小时，下载上限 100 次 */
    video_url: string;
    last_frame_url?: string;
    usage: { completion_tokens: number };
  };
  error?: { code: string; message: string };
  /**
   * 服务端返回的原始状态字符串（`queued`/`running`/`succeeded`/`failed` 之外的未知值也原样保留）。
   * 未验证：M4b 只确证了这四种取值。
   */
  raw_status?: string;
  /** 视频 URL 实际命中的响应路径（防御式提取时记录，便于真跑后校正） */
  url_path?: string;
}

export interface VideoAdapter {
  submit(req: VideoGenerationRequest): Promise<{ task_id: string }>;
  poll(task_id: string): Promise<VideoTask>;
  cancel(task_id: string): Promise<void>;
  /** 自动下载并存入 IndexedDB，返回本地 blob URL */
  downloadAndStore(video_url: string, task_id: string): Promise<string>;
}

/** 与 `ai-models/client` 的探针类型同形，避免视频模块反过来依赖 AI 客户端的实现 */
export type VideoFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ArkAdapterConfig {
  apiKey: string;
  baseUrl?: string;
  /** 版本化模型 ID（`doubao-seedance-2-5-260628`）；不传则用 `ARK_MODEL_ID` */
  model?: string;
  /** 官方建议 30 秒轮询一次 */
  pollIntervalMs?: number;
  /** 单次 HTTP 请求超时（提交/轮询各自计时），默认 30 秒 */
  requestTimeoutMs?: number;
  /** 整个任务的最长轮询时长，默认 30 分钟（官方示例同值） */
  pollTimeoutMs?: number;
  /** 下载成片的超时（大文件默认给 10 分钟） */
  downloadTimeoutMs?: number;
  /**
   * 请求体上限，默认 64MB（官方限制）。
   * 留成可配置**只为测试能廉价地验证"超限提前拒绝"**，生产不要改大。
   */
  maxRequestBodyBytes?: number;
  /** 可注入的 fetch（测试用 mock server） */
  fetchImpl?: VideoFetchLike;
  /** 可注入时钟（24 小时有效期提示必须能假造时间） */
  now?: () => number;
  /** 顶层参数默认值；任务书未给的字段一律不发送 */
  watermark?: boolean;
  generateAudio?: boolean;
}

/* ------------------------------------------------------------------ */
/* M4c：智谱免费通道的适配器配置                                        */
/* ------------------------------------------------------------------ */

export interface ZhipuAdapterConfig {
  /** 智谱 BigModel API Key（鉴权头写法见 zhipu-adapter 的 headers()） */
  apiKey: string;
  baseUrl?: string;
  /** 免费模型 ID，默认 `cogvideox-flash` */
  model?: string;
  /** 速度优先还是质量优先（请求体里的 `quality`） */
  quality?: 'speed' | 'quality';
  fps?: number;
  /** 免费模型出无声视频，默认 false，不要改true */
  withAudio?: boolean;
  movementAmplitude?: 'auto' | 'small' | 'medium' | 'large';
  /**
   * 是否把 `duration` 写进请求体。**默认 false**：
   * 该模型是否接受 duration 未验证，传错要白排一次队。
   */
  sendDuration?: boolean;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  requestTimeoutMs?: number;
  downloadTimeoutMs?: number;
  /** 429/1305 的重试次数（默认 3） */
  maxRetries?: number;
  /** 每次重试前的基础等待（默认 5000/15000/45000） */
  retryDelaysMs?: number[];
  /** 抖动比例（默认 0.2，只增不减） */
  retryJitterRatio?: number;
  /** 注入的随机源（测试里给 0 → 延迟确定） */
  random?: () => number;
  /** 注入的等待器（测试里不真等） */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: VideoFetchLike;
  now?: () => number;
  /** 重试通知（UI 显示「免费模型拥挤，排队重试中（第 n 次）」）；也可用 listenRetry 订阅 */
  onRetry?: (info: ZhipuRetryInfo) => void;
}

export interface ZhipuRetryInfo {
  /** 第几次重试（1 开始） */
  attempt: number;
  /** 这次等待多少毫秒（含抖动） */
  delayMs: number;
  status?: number;
  code?: string;
  message?: string;
}

/* ------------------------------------------------------------------ */
/* 素材（M4b 分流用）                                                  */
/* ------------------------------------------------------------------ */

export type MediaKind = 'image' | 'audio' | 'video';

/** 用户手上的一份素材：要么有字节（可转 base64），要么有已经可用的 URL */
export interface MediaAsset {
  kind: MediaKind;
  mimeType: string;
  /** 体积（字节）。没有字节时必须由调用方给出，用于判断是否 ≥ 5MB */
  size: number;
  bytes?: Uint8Array;
  /** 公网 URL（图片/音频可省，视频必需） */
  url?: string;
  name?: string;
}

export type MediaRefMode = 'base64' | 'url';

export interface ResolvedMedia {
  kind: MediaKind;
  /** 直接塞进请求体的字符串：`data:image/png;base64,...` 或公网 URL */
  ref: string;
  mode: MediaRefMode;
  size: number;
}

/* ------------------------------------------------------------------ */
/* 结果落盘（视频 URL 24 小时失效 / 下载上限 100 次）                   */
/* ------------------------------------------------------------------ */

export const VIDEO_URL_TTL_MS = 24 * 60 * 60 * 1000;
export const VIDEO_DOWNLOAD_LIMIT = 100;

export interface VideoArtifact {
  /** 主键：`video:<taskId>` */
  id: string;
  taskId: string;
  blob: Blob;
  mimeType: string;
  /** 字节数（blob.size 的副本，便于不读 blob 就能展示） */
  size: number;
  /** 落盘时间（epoch 毫秒） */
  createdAt: number;
  /** 远端 URL 失效时间（epoch 毫秒）= 落盘时间 + 24h */
  expiresAt: number;
  /** 官方限制：同一 URL 下载上限 100 次 */
  downloadLimit: number;
  /** 已下载次数（本地记录，用于提示；不代表服务端计数） */
  downloadCount: number;
  /** 远端 URL（失效后仅作追溯） */
  remoteUrl: string;
}
