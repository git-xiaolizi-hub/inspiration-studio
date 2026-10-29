/**
 * 生图适配层统一出口。
 *
 * 与视频模块同样的解耦纪律：主应用对这里的引用只允许出现在
 * `src/ui/create/CreatePage.tsx`（+ `src/core/artifacts` 的数据层），
 * 想整块停用生图时删掉 `src/adapters/image` 与 `src/ui/create` 并去掉那几条引用即可。
 */
export { ArkImageAdapter } from './ark-image-adapter';
export { ZhipuImageAdapter } from './zhipu-image-adapter';
export { OpenAIImageAdapter } from './openai-image-adapter';
export { AbstractImageAdapter, readErrorFields } from './base-adapter';
export type { ImageBody, ResolvedBaseConfig } from './base-adapter';
export {
  adapterForModel,
  adapterKindForImageModel,
  imagePriceFor,
  IMAGE_DEFAULT_MODELS,
  isFreeImageModel,
  priceKeyForImageModel,
} from './channels';
export type {
  ImageAdapterForModelDeps,
  ImageAdapterForModelFail,
  ImageAdapterForModelOk,
  ImageAdapterForModelResult,
  ImageModelTarget,
  ImagePriceInfo,
} from './channels';
export {
  ARK_IMAGE_BASE_URL,
  ARK_IMAGE_FIELDS,
  ARK_IMAGE_MODEL,
  ARK_IMAGE_PATH,
  ARK_IMAGE_URL_TTL,
  ARK_SEEDREAM_SIZES,
  MAX_IMAGE_COUNT,
  NO_IMAGE_ADAPTER_HINT,
  OPENAI_IMAGE_FIELDS,
  OPENAI_IMAGE_MODEL,
  OPENAI_IMAGE_PATH,
  OPENAI_IMAGE_SIZES,
  OPENAI_IMAGE_URL_TTL,
  SIZE_PATTERN,
  ZHIPU_COGVIEW_SIZES,
  ZHIPU_GLM_IMAGE_SIZES,
  ZHIPU_IMAGE_BASE_URL,
  ZHIPU_IMAGE_FIELDS,
  ZHIPU_IMAGE_MODEL,
  ZHIPU_IMAGE_PATH,
  ZHIPU_IMAGE_URL_TTL,
} from './constants';
export type { ImageAdapterKind } from './constants';
export {
  IMAGE_CATEGORY_MESSAGES,
  ImageError,
  classifyImageFailure,
  isImageError,
} from './errors';
export type { ImageErrorCategory, ImageFailureInput } from './errors';
export { classifyImageFailure as classifyImageHttpFailure } from './errors';
export { downloadBytes, failureFromBody, postJson, withRateLimitRetry } from './http';
export type { JsonResponse, PostJsonOptions } from './http';
export {
  b64ToBlob,
  getStoredImage,
  imageArtifactId,
  imageBlobId,
  imageTtlNotice,
  makeBlobUrl,
  revokeBlobUrl,
  saveImageBlob,
} from './storage';
export type { SaveImageBlobInput } from './storage';
export type {
  ArkImageAdapterConfig,
  BaseImageAdapterConfig,
  ImageAdapter,
  ImageArtifact,
  ImageArtifactPayload,
  ImageAspect,
  ImageFetchLike,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageRetryInfo,
  ImageUrlTtl,
  OpenAIImageAdapterConfig,
  ZhipuImageAdapterConfig,
} from './types';
