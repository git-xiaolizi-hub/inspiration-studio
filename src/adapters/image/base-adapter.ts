/**
 * 三个生图适配器的公共骨架。
 *
 * 它们只差三件事：**端点**、**请求字段**、**响应字段**。其余（参数校验、count 拆成 N 次单张请求、
 * 下载落盘、超时）完全一样 —— 复制三遍的后果已经在本项目里验证过（M4c：修了一个忘了另一个）。
 *
 * 硬纪律：
 * - `negative` 一律拒绝：两家图像接口文档里都没有这个字段，**不能悄悄丢掉**；
 * - `count` 不是请求字段：两家官方接口都没有 `n`，只能发 N 次（明确计费 N 次）；
 * - 不自动重试（除 429）：同步接口 + 按张计费，重发可能重复扣费。
 */
import { MAX_IMAGE_COUNT, SIZE_PATTERN } from './constants';
import { ImageError } from './errors';
import { downloadBytes, postJson, withRateLimitRetry } from './http';
import { b64ToBlob, makeBlobUrl, saveImageBlob } from './storage';
import type {
  BaseImageAdapterConfig,
  ImageAdapter,
  ImageAspect,
  ImageFetchLike,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageUrlTtl,
} from './types';

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

export interface ResolvedBaseConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchImpl: ImageFetchLike;
  maxRetries: number;
  retryDelaysMs: number[];
  sleep: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; status?: number; code?: string; message?: string }) => void;
}

export type ImageBody = Record<string, unknown>;

export abstract class AbstractImageAdapter implements ImageAdapter {
  abstract readonly id: string;

  abstract readonly urlTtl: ImageUrlTtl;

  protected readonly cfg: ResolvedBaseConfig;

  /** 最近一次**实际发出去**的请求体（判据 1 逐字断言字段集；也便于排查"到底传了什么"） */
  lastRequestBody: ImageBody | null = null;

  constructor(config: BaseImageAdapterConfig, defaults: { baseUrl: string; model: string }) {
    if (!config.apiKey || config.apiKey.trim() === '') {
      throw new ImageError('auth', '缺少 API Key', {
        detail: '生图接口用 Authorization: Bearer <key> 鉴权',
      });
    }
    this.cfg = {
      apiKey: config.apiKey.trim(),
      baseUrl: (config.baseUrl ?? defaults.baseUrl).replace(/\/+$/, ''),
      model: (config.model ?? defaults.model).trim(),
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchImpl: config.fetchImpl ?? ((input, init) => fetch(input, init)),
      maxRetries: config.maxRetries ?? 0,
      retryDelaysMs: config.retryDelaysMs ?? [5000, 15000],
      sleep: config.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      onRetry: config.onRetry,
    };
  }

  get model(): string {
    return this.cfg.model;
  }

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  /* ---------------------------------------------------------------- */
  /* 子类必须实现的三件事                                              */
  /* ---------------------------------------------------------------- */

  protected abstract endpointPath(): string;

  /** 请求体：**只放文档确证过的字段**，顺序无关，字段集由测试逐字断言 */
  protected abstract buildBody(req: ImageGenerationRequest, size: string): ImageBody;

  /** 响应体 → 统一的 `{images, usage}`；形状不对就抛可读错误 */
  protected abstract parseResponse(json: unknown): ImageGenerationResult;

  /* 尺寸表由子类按模型挑（glm-image 与 cogview 的枚举不一样） */
  protected abstract sizeForAspect(aspect: ImageAspect): string;

  protected resolveSize(req: ImageGenerationRequest): string {
    const explicit = req.size?.trim();
    if (explicit) {
      if (!SIZE_PATTERN.test(explicit)) {
        throw new ImageError('invalid_params', `尺寸格式不对：「${explicit}」，应写成 1024x1024`);
      }
      return explicit;
    }
    return this.sizeForAspect(req.aspect ?? '1:1');
  }

  /* ---------------------------------------------------------------- */
  /* 生成                                                              */
  /* ---------------------------------------------------------------- */

  async generate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    this.assertRequest(req);
    const size = this.resolveSize(req);
    const count = Math.min(Math.max(1, Math.trunc(req.count ?? 1)), MAX_IMAGE_COUNT);

    const images: Array<{ url?: string; b64?: string }> = [];
    let reported = 0;

    // 官方接口没有 n → N 张就是 N 次请求（扣 N 次费）。这里写成一个循环而不是并发：
    // 并发容易被限流，而且失败时用户更难判断"扣了几次"。
    for (let index = 0; index < count; index += 1) {
      const body = this.buildBody(req, size);
      this.lastRequestBody = body;
      const json = await withRateLimitRetry(
        async () => {
          const response = await postJson({
            url: `${this.cfg.baseUrl}${this.endpointPath()}`,
            apiKey: this.cfg.apiKey,
            body,
            timeoutMs: this.cfg.timeoutMs,
            fetchImpl: this.cfg.fetchImpl,
          });
          return response.json;
        },
        {
          maxRetries: this.cfg.maxRetries,
          retryDelaysMs: this.cfg.retryDelaysMs,
          sleep: this.cfg.sleep,
          onRetry: this.cfg.onRetry,
        },
      );
      const parsed = this.parseResponse(json);
      images.push(...parsed.images);
      reported += parsed.usage?.images ?? 0;
    }

    return {
      images,
      // 智谱 / OpenAI 兼容端没有 usage 字段 → 用实际拿到的张数（本地计数，注明不是账单）
      usage: { images: reported > 0 ? reported : images.length },
      size,
    };
  }

  /**
   * `negative` / 空 prompt / 超量张数一律在**发请求之前**拒绝。
   * 这不是"用户体验优化"：悄悄丢掉 negative 会让用户以为约束生效了。
   */
  protected assertRequest(req: ImageGenerationRequest): void {
    if (!req.prompt || req.prompt.trim() === '') {
      throw new ImageError('invalid_params', '提示词为空：生图接口只认 prompt，不能空着发');
    }
    if (req.negative && req.negative.trim() !== '') {
      throw new ImageError('unsupported_capability', '这个生图接口不支持「负向提示词」字段', {
        detail:
          '智谱 CreateImageRequest 与方舟图片生成 Body 参数文档里都没有 negative 字段；' +
          '适配器不会替你静默丢弃它',
      });
    }
    if (typeof req.count === 'number' && (req.count < 1 || req.count > MAX_IMAGE_COUNT)) {
      throw new ImageError(
        'invalid_params',
        `一次最多生成 ${MAX_IMAGE_COUNT} 张（收到 ${req.count}）`,
        { detail: '每张一次请求、各扣一次费；批量请分几次点' },
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* 下载落盘                                                          */
  /* ---------------------------------------------------------------- */

  async downloadAndStore(url: string, key: string): Promise<string> {
    const { bytes, mimeType } = await downloadBytes(url, {
      timeoutMs: this.cfg.timeoutMs,
      fetchImpl: this.cfg.fetchImpl,
    });
    const blob = new Blob([bytes], { type: mimeType || 'image/png' });
    const artifact = await saveImageBlob({
      key,
      blob,
      remoteUrl: url,
      ttl: this.urlTtl,
      mimeType: mimeType || 'image/png',
    });
    try {
      return makeBlobUrl(artifact.blob);
    } catch (error) {
      throw new ImageError('unknown', `图片已存到本地库，但当前环境生不出预览地址：${String(error)}`, {
        detail: `用 ${artifact.id} 调 getStoredImage 可取回`,
      });
    }
  }

  /** `b64_json` 分支：没有远端地址可下载，直接把 base64 落盘 */
  async storeBase64(b64: string, key: string): Promise<string> {
    const blob = b64ToBlob(b64);
    const artifact = await saveImageBlob({
      key,
      blob,
      remoteUrl: '',
      ttl: this.urlTtl,
      mimeType: blob.type || 'image/png',
    });
    return makeBlobUrl(artifact.blob);
  }
}

/** 从 `{error:{code,message}}` / `{code,message}` 里挖错误码（两家都按防御式取） */
export function readErrorFields(json: unknown): { code?: string; message?: string } {
  const root = json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  const error = root.error as Record<string, unknown> | undefined;
  const rawCode = error?.code ?? root.code;
  const rawMessage = error?.message ?? root.message;
  const code =
    typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : undefined;
  const message = typeof rawMessage === 'string' ? rawMessage : undefined;
  return { code, message };
}
