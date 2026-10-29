/**
 * 火山方舟 Seedream 生图适配器。
 *
 * 端点与字段只按官方原文写（`ark.volcengine.com/region:cn-beijing/docs/image-generation-api.md`，
 * 摘要见 M5a2-REPORT §1.2）：
 * - `POST https://ark.cn-beijing.volces.com/api/v3/images/generations`，`Authorization: Bearer <key>`
 * - 请求 Body：`model`(必) / `prompt` / `image` / `size` / `response_format` / `output_format` /
 *   `watermark` / `sequential_image_generation` / `stream` / `tools` / …
 * - 响应：`{model, created, data:[{url|b64_json, size, output_format, error?, z_index?, …}], usage:{generated_images, output_tokens}}`
 * - 链接：**生成后 24 小时内失效**
 *
 * 只发 `model / prompt / size / response_format`（后者显式要 url；`watermark` 不传=默认加，
 * `sequential_image_generation` 不传=默认 disabled，即单图）。
 * ⚠️ 组图（`sequential_image_generation: 'auto'`）**只有 lite / 4.5 / 4.0 支持**，
 *    5.0 pro / flash 不支持 —— 所以"多张"统一走发 N 次，不用组图参数（换模型也不会突然失效）。
 */
import {
  ARK_IMAGE_BASE_URL,
  ARK_IMAGE_MODEL,
  ARK_IMAGE_PATH,
  ARK_IMAGE_URL_TTL,
  ARK_SEEDREAM_SIZES,
} from './constants';
import { AbstractImageAdapter } from './base-adapter';
import type { ImageBody } from './base-adapter';
import { ImageError } from './errors';
import type {
  ArkImageAdapterConfig,
  ImageAspect,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageUrlTtl,
} from './types';

export class ArkImageAdapter extends AbstractImageAdapter {
  readonly id = 'ark-image-adapter';

  readonly urlTtl: ImageUrlTtl = ARK_IMAGE_URL_TTL;

  /** 不传就不发这个字段（官方默认 true，不替用户关水印） */
  private readonly watermark?: boolean;

  constructor(config: ArkImageAdapterConfig) {
    super(config, { baseUrl: ARK_IMAGE_BASE_URL, model: ARK_IMAGE_MODEL });
    this.watermark = config.watermark;
  }

  protected endpointPath(): string {
    return ARK_IMAGE_PATH;
  }

  protected sizeForAspect(aspect: ImageAspect): string {
    return ARK_SEEDREAM_SIZES[aspect];
  }

  protected buildBody(req: ImageGenerationRequest, size: string): ImageBody {
    const body: ImageBody = {
      model: this.cfg.model,
      prompt: req.prompt,
      size,
      // 官方默认就是 url；写明是为了不依赖默认值（默认值改了我们不该跟着变）
      response_format: 'url',
    };
    if (this.watermark !== undefined) body.watermark = this.watermark;
    return body;
  }

  protected parseResponse(json: unknown): ImageGenerationResult {
    const root = json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : {};
    const data = root.data;

    if (!Array.isArray(data)) {
      throw new ImageError('unknown', '响应里没有 data 字段（地址或鉴权可能不对）', {
        detail: JSON.stringify(root).slice(0, 300),
      });
    }

    const images: Array<{ url?: string; b64?: string }> = [];
    const failures: Array<{ code?: string; message?: string }> = [];

    for (const item of data) {
      if (item === null || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const url = row.url;
      const b64 = row.b64_json;
      if (typeof url === 'string' && url !== '') images.push({ url });
      else if (typeof b64 === 'string' && b64 !== '') images.push({ b64 });

      // 组图场景下某张失败会带 error（单图场景也是同一个字段）
      if (row.error !== null && typeof row.error === 'object' && images.length === 0) {
        const error = row.error as Record<string, unknown>;
        failures.push({
          code: typeof error.code === 'string' ? error.code : undefined,
          message: typeof error.message === 'string' ? error.message : undefined,
        });
      }
    }

    if (images.length === 0) {
      const first = failures[0];
      throw new ImageError('unknown', `没有拿到图片：${first?.message ?? '响应 data 为空'}`, {
        code: first?.code,
        detail: JSON.stringify(root).slice(0, 300),
      });
    }

    const usageRoot = root.usage;
    const generated =
      usageRoot !== null && typeof usageRoot === 'object'
        ? Number((usageRoot as Record<string, unknown>).generated_images)
        : NaN;

    return {
      images,
      usage: { images: Number.isFinite(generated) ? generated : images.length },
    };
  }
}
