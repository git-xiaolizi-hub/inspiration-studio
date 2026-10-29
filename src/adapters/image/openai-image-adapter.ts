/**
 * OpenAI 兼容生图适配器（走用户配置的 base_url，通常是中转站）。
 *
 * ⚠️ **本适配器的字段集未核实**：`platform.openai.com` 在本机返回 403（Cloudflare），
 * 拿不到官方原文。按任务书的"不许编 API 形状"这条，这里的处理是：
 * - 只发 `model / prompt / size` 三个**任何 OpenAI 兼容 images 端点都必须认**的字段；
 *   不传 `n`（各代 gpt-image 对 n 的支持不一致）、不传 `response_format`（gpt-image 系列只回 b64）、
 *   不传 `quality`（取值随模型变化）；
 * - 响应解析**同时容忍** `data[].url` 与 `data[].b64_json`，不假设一定有哪一个；
 * - URL 时效标 `verified: false`（按 1 小时保守处理，UI 会显示「未核实」）。
 *
 * 报告 §1.3 把这三点列成"缺什么"，接真中转时先抓一次真实响应再补字段。
 */
import {
  OPENAI_IMAGE_MODEL,
  OPENAI_IMAGE_PATH,
  OPENAI_IMAGE_SIZES,
  OPENAI_IMAGE_URL_TTL,
} from './constants';
import { AbstractImageAdapter, readErrorFields } from './base-adapter';
import type { ImageBody } from './base-adapter';
import { ImageError } from './errors';
import type {
  ImageAspect,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageUrlTtl,
  OpenAIImageAdapterConfig,
} from './types';

export class OpenAIImageAdapter extends AbstractImageAdapter {
  readonly id = 'openai-image-adapter';

  readonly urlTtl: ImageUrlTtl = OPENAI_IMAGE_URL_TTL;

  constructor(config: OpenAIImageAdapterConfig) {
    // base_url 必须由用户给：中转站地址各不相同，没有"官方默认"可填（也不许猜）
    super(config, { baseUrl: config.baseUrl ?? '', model: OPENAI_IMAGE_MODEL });
    if (!config.baseUrl || config.baseUrl.trim() === '') {
      throw new ImageError('invalid_params', 'OpenAI 兼容生图需要一个 base_url（中转站地址）', {
        detail: '去 AI 配置 → 该厂商的连接里填服务地址；适配器不猜默认地址',
      });
    }
  }

  protected endpointPath(): string {
    return OPENAI_IMAGE_PATH;
  }

  protected sizeForAspect(aspect: ImageAspect): string {
    return OPENAI_IMAGE_SIZES[aspect];
  }

  protected buildBody(req: ImageGenerationRequest, size: string): ImageBody {
    return {
      model: this.cfg.model,
      prompt: req.prompt,
      size,
    };
  }

  protected parseResponse(json: unknown): ImageGenerationResult {
    const root = json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : {};
    const data = root.data;

    if (!Array.isArray(data)) {
      const { code, message } = readErrorFields(root);
      throw new ImageError('unknown', `响应里没有 data 字段：${message ?? '（空）'}`, {
        code,
        detail: JSON.stringify(root).slice(0, 300),
      });
    }

    const images: Array<{ url?: string; b64?: string }> = [];
    for (const item of data) {
      if (item === null || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      if (typeof row.url === 'string' && row.url !== '') images.push({ url: row.url });
      else if (typeof row.b64_json === 'string' && row.b64_json !== '') images.push({ b64: row.b64_json });
    }

    if (images.length === 0) {
      const { code, message } = readErrorFields(root);
      throw new ImageError('unknown', `响应 data 里既没有 url 也没有 b64_json：${message ?? ''}`, {
        code,
        detail: JSON.stringify(root).slice(0, 300),
      });
    }

    return { images, usage: { images: images.length } };
  }
}
