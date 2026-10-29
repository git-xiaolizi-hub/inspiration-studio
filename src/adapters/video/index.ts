/**
 * 视频模块统一出口（`src/adapters/video/` 与 `src/ui/video/` 是这一层的全部新增面）。
 *
 * 解耦纪律（**P2 起换了口径**）：不再要求「整块删掉只改 3 行」——视频能力已经是单卡创作的
 * 核心 tab，删掉它就是掉功能。现在的判据是**引用点收敛**：消费侧（`src/` 里除这两个目录以外）
 * 对视频模块的 import 必须恰好等于 `video-decoupling.test.ts` 里那张白名单，
 * 且不存在 `VideoPage` 组件与 `/video` 路由。加新入口 = 那里会红，逼你显式登记理由。
 */
export { ArkVideoAdapter, parseTask } from './ark-adapter';
export {
  ZhipuVideoAdapter,
  isFreeTierBusy,
  parseErrorBody,
  parseZhipuTask,
  tailorForZhipu,
} from './zhipu-adapter';
export {
  FREE_CHANNEL_CAPABILITIES,
  PAID_CHANNEL_CAPABILITIES,
  unsupportedCapabilityHint,
} from './capabilities';
export type { VideoChannelCapabilities } from './capabilities';
export {
  actualCostForChannel,
  adapterForModel,
  adapterKindForModel,
  coerceResolution,
  isFreeVideoModel,
  NO_VIDEO_ADAPTER_HINT,
} from './channels';
export type {
  AdapterForModelDeps,
  AdapterForModelOk,
  AdapterForModelResult,
  ChannelAdapter,
  ChannelAdapterExtras,
  VideoAdapterKind,
  VideoModelTarget,
} from './channels';
export {
  ZHIPU_ASYNC_RESULT_PATH,
  ZHIPU_BASE_URL,
  ZHIPU_BUSY_CODE,
  ZHIPU_BUSY_STATUS,
  ZHIPU_CONSOLE_URL,
  ZHIPU_DOCUMENTED_SIZE,
  ZHIPU_FIXED_DURATION,
  ZHIPU_MODEL_ID,
  ZHIPU_POLL_INTERVAL_MS,
  ZHIPU_POLL_TIMEOUT_MS,
  ZHIPU_RETRY_DELAYS_MS,
  ZHIPU_SIZE_TABLE,
  ZHIPU_SUPPORTED_RESOLUTIONS,
  ZHIPU_VIDEO_PATH,
  zhipuSizeFor,
} from './zhipu-constants';
export { requireZhipuVideoResult, extractZhipuVideoResult } from './zhipu-extract';
export { assertZhipuDuration, assertZhipuSupported, buildZhipuPayload } from './zhipu-payload';
export type { ZhipuBuildOptions, ZhipuMovement, ZhipuQuality, ZhipuTaskPayload } from './zhipu-payload';
export {
  ARK_BASE_URL,
  ARK_CONSOLE_URL,
  ARK_MODEL_ID,
  AUDIO_MAX_BYTES,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  DRAFT_FINAL_RESOLUTION,
  DRAFT_RESOLUTION,
  DRAFT_TASK_ID_TTL_MS,
  IMAGE_MAX_BYTES,
  INLINE_MEDIA_MAX_BYTES,
  MAX_DURATION_SEC,
  MIN_DURATION_SEC,
  PORTRAIT_ASSET_GUIDE_URL,
  PRICE_TABLE_MODEL_NAME,
  REQUEST_BODY_MAX_BYTES,
  VIDEO_MAX_BYTES,
} from './constants';
export { estimateVideoRequest } from './estimate';
export {
  CATEGORY_MESSAGES,
  VideoError,
  classifyTaskError,
  classifyVideoFailure,
  describeTask,
  isVideoError,
} from './errors';
export { extractTaskId, extractVideoResult, requireTaskId, requireVideoResult } from './extract';
export {
  assertPayloadFits,
  bytesToBase64,
  estimatePayloadBytes,
  formatBytes,
  isPublicHttpUrl,
  resolveMediaRef,
  toDataUrl,
} from './media';
export { buildDraftFinalizePayload, buildTaskPayload } from './payload';
export {
  artifactNotice,
  getVideoArtifact,
  isArtifactExpired,
  makeBlobUrl,
  remainingHours,
  revokeBlobUrl,
  saveVideoArtifact,
  storeFetchedVideo,
  videoArtifactId,
} from './storage';
export type { StoreFetchedVideoInput, StoredFetchedVideo } from './storage';
export { VideoTaskRunner, defaultSleep } from './task-runner';
export type { RunnerOptions, RunnerPhase, RunnerSnapshot, PollableAdapter } from './task-runner';
export type {
  ArkAdapterConfig,
  MediaAsset,
  MediaKind,
  ReferenceImages,
  ReferenceVideos,
  ResolvedMedia,
  VideoAdapter,
  VideoArtifact,
  VideoFetchLike,
  VideoGenerationRequest,
  VideoRatio,
  VideoResolution,
  VideoTask,
  VideoTaskStatus,
  ZhipuAdapterConfig,
  ZhipuRetryInfo,
} from './types';
export type { VideoErrorCategory, TaskFailureView } from './errors';
export type { ArkTaskPayload, ArkContentItem } from './payload';
export type { RequestEstimate } from './estimate';
