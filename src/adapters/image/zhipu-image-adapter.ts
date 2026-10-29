/**
 * 智谱 BigModel 生图适配器。
 *
 * 端点与字段只按官方 OpenAPI 原文写（`docs.bigmodel.cn/api-reference/模型-api/图像生成.md`，
 * 摘要见 M5a2-REPORT §1.1）：
 * - `POST /paas/v4/images/generations`，`Authorization: Bearer <key>`
 * - 请求：`model`(必) / `prompt`(必) / `quality` / `size` / `watermark_enabled` / `user_id`
 * - 响应：`{created, data:[{url}], content_filter?:[{role, level}]}`
 *   **`data` 数组目前只含一张图** → 多张只能发多次请求
 * - 图片链接：**30 天**有效（原文见 storage/constants）
 *
 * 只发 `model / prompt / size`：其余三个字段各有副作用（见 constants 的注释）。
 */
import {
  ZHIPU_GLM_IMAGE_SIZES,
  ZHIPU_IMAGE_BASE_URL,
  ZHIPU_IMAGE_PATH,
  ZHIPU_IMAGE_URL_TTL,
  ZHIPU_COGVIEW_SIZES,
  ZHIPU_IMAGE_MODEL,
} from './constants';
import { AbstractImageAdapter, readErrorFields } from './base-adapter';
import type { ImageBody } from './base-adapter';
import { ImageError } from './errors';
import type {
  ImageAspect,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageUrlTtl,
  ZhipuImageAdapterConfig,
} from './types';

export class ZhipuImageAdapter extends AbstractImageAdapter {
  readonly id = 'zhipu-image-adapter';

  readonly urlTtl: ImageUrlTtl = ZHIPU_IMAGE_URL_TTL;

  constructor(config: ZhipuImageAdapterConfig) {
    super(config, { baseUrl: ZHIPU_IMAGE_BASE_URL, model: config.model ?? ZHIPU_IMAGE_MODEL });
  }

  protected endpointPath(): string {
    return ZHIPU_IMAGE_PATH;
  }

  /** `glm-image` 与 cogview 系列的尺寸枚举不同（文档原文里分两套） */
  protected sizeForAspect(aspect: ImageAspect): string {
    const table = this.cfg.model.toLowerCase().includes('glm-image')
      ? ZHIPU_GLM_IMAGE_SIZES
      : ZHIPU_COGVIEW_SIZES;
    return table[aspect];
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
      // 200 但没 data：两家都可能用 200 + 空 data 表示"被审核挡了"
      const filtered = Array.isArray(root.content_filter) && root.content_filter.length > 0;
      throw new ImageError(
        filtered ? 'content_policy' : 'unknown',
        filtered ? '内容审核拦截（响应里只有 content_filter）' : `响应里没有 data 字段：${message ?? ''}`,
        { code, detail: JSON.stringify(root).slice(0, 300) },
      );
    }

    const images: Array<{ url: string }> = [];
    for (const item of data) {
      if (item === null || typeof item !== 'object') continue;
      const url = (item as Record<string, unknown>).url;
      if (typeof url === 'string' && url !== '') images.push({ url });
    }

    if (images.length === 0) {
      const filtered = Array.isArray(root.content_filter) && root.content_filter.length > 0;
      throw new ImageError(
        filtered ? 'content_policy' : 'unknown',
        filtered ? '内容审核拦截：没有返回任何图片地址' : '响应里的 data 没有被识别的图片地址',
        { detail: JSON.stringify(root).slice(0, 300) },
      );
    }

    // 官方响应体**没有 usage**（原文只列 created / data / content_filter）
    return { images, usage: { images: images.length } };
  }
}
