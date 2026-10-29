/**
 * 生图适配器接口契约（M5a2）。
 *
 * 三条纪律（写成类型而不是注释）：
 * 1. `fetchImpl` 可注入 —— 判据全部走 mock server / 注入的 fetch，绝不发真实请求（CHARTER §13.2）；
 * 2. **只发文档确证过的字段**。字段集在 `constants.ts` 里逐家写死，测试按"不多传"逐字断言；
 * 3. 结果 URL 的时效是**厂商文档给的事实**，不是统一 24 小时 —— 三家各写各的（见 `URL_TTL`）。
 */

export type ImageAspect = '1:1' | '3:4' | '4:3' | '16:9' | '9:16';

export interface ImageGenerationRequest {
  prompt: string;
  /**
   * 负向提示词。
   * ⚠️ 智谱 / 方舟的**图像**接口文档里都没有这个字段（视频接口也没有）。
   * 传了就显式抛 `unsupported_capability`，绝不悄悄丢掉。
   */
  negative?: string | null;
  /** 直接指定像素尺寸（`1024x1024`）。给了就不看 `aspect`。 */
  size?: string;
  aspect?: ImageAspect;
  /** 出图张数。**注意：这两家官方接口都没有 `n` 字段**，适配器会发 N 次单张请求（= 扣 N 次费）。 */
  count?: number;
  /** 模型编码（`cogview-3-flash` / `doubao-seedream-5-0-pro-260628` / `gpt-image-2.5` …） */
  model: string;
}

export interface ImageGenerationResult {
  /**
   * `url` 与 `b64` 至少有一个。
   * 两家中文站都默认返回 `url`；`b64` 只在调用方明确要 base64 时才出现（Ark 的 `b64_json`）。
   */
  images: Array<{ url?: string; b64?: string }>;
  /**
   * 张数。
   * - 方舟：响应体 `usage.generated_images`（官方原文）；
   * - 智谱：响应体里**没有** usage 字段 → 用实际拿到的张数（本地计数，不是账单）；
   * - OpenAI 兼容中转：响应体没有 usage → 同上。
   */
  usage?: { images: number };
  /** 本次请求实际发出去的尺寸（`size` 与 `aspect` 二选一时用得上，报告里也对着它核对） */
  size?: string;
}

export interface ImageAdapter {
  readonly id: string;
  generate(req: ImageGenerationRequest): Promise<ImageGenerationResult>;
  /** 下载并存入 IndexedDB，返回本地 blob URL */
  downloadAndStore(url: string, key: string): Promise<string>;
  /** 该适配器给出的远端 URL 有效期（毫秒）与是否核实过 */
  readonly urlTtl: ImageUrlTtl;
}

export interface ImageUrlTtl {
  ms: number;
  /**
   * true = 厂商文档原文写明了（报告里贴了原文）；
   * false = 没拿到原文，按**保守值**处理，UI 必须显示「未核实」。
   */
  verified: boolean;
  /** 一句话口径（UI 同屏显示，不藏在 tooltip 里） */
  note: string;
}

/** 与 `ai-models/client` 的探针类型同形，避免图片模块反过来依赖 AI 客户端的实现 */
export type ImageFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 三家共用的构造参数（每家再各加自己的默认值） */
export interface BaseImageAdapterConfig {
  apiKey: string;
  baseUrl?: string;
  /** 模型编码；不传则用该家的默认模型 */
  model?: string;
  timeoutMs?: number;
  fetchImpl?: ImageFetchLike;
  /** 可注入时钟（时效提示必须能假造时间） */
  now?: () => number;
  /** 排队/限流的重试次数，默认 0（不自动重试：生图按张计费，重试=重复扣费） */
  maxRetries?: number;
  /** 重试前的基础等待（默认 5000 / 15000） */
  retryDelaysMs?: number[];
  /** 注入的等待器（测试里不真等） */
  sleep?: (ms: number) => Promise<void>;
  /** 重试通知（UI 显示「排队重试中（第 n 次）」） */
  onRetry?: (info: ImageRetryInfo) => void;
}

export interface ImageRetryInfo {
  attempt: number;
  delayMs: number;
  status?: number;
  code?: string;
  message?: string;
}

/** 智谱：默认模型 `cogview-3-flash`（官方免费档），其余同基类 */
export type ZhipuImageAdapterConfig = BaseImageAdapterConfig;

export interface ArkImageAdapterConfig extends BaseImageAdapterConfig {
  /** 默认 `doubao-seedream-5-0-pro-260628`；`model` 见基类 */
  /** 水印开关。**不传就不发这个字段**（官方默认 true） */
  watermark?: boolean;
}

/** OpenAI 兼容：默认模型 `gpt-image-2.5`，base_url 必填（中转站地址各不相同） */
export type OpenAIImageAdapterConfig = BaseImageAdapterConfig;

/* ------------------------------------------------------------------ */
/* 结果落盘（远端链接会失效）                                          */
/* ------------------------------------------------------------------ */

export interface ImageArtifactPayload {
  prompt: string;
  /** 远端地址（失效后仅作追溯） */
  remoteUrl: string;
  /** media 表里那一行的主键 */
  blobId: string;
  mimeType: string;
  /** 字节数（便于不读 blob 就展示） */
  size: number;
  /** 远端 URL 失效时间（epoch 毫秒） */
  expiresAt: number;
  /** 时效口径是否核实过（false → UI 必须显示「未核实」） */
  ttlVerified: boolean;
  ttlNote: string;
  /** 实际请求的尺寸 */
  imageSize?: string;
}

/** 落盘后的图片（与 video 的 VideoArtifact 同思路：远端会失效，本地副本不会） */
export interface ImageArtifact {
  /** 主键 = `image:<key>` */
  id: string;
  remoteUrl: string;
  blob: Blob;
  mimeType: string;
  size: number;
  createdAt: number;
  expiresAt: number;
  ttlVerified: boolean;
  ttlNote: string;
}
