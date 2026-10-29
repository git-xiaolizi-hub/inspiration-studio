/**
 * Ark Seedance 的视频常量 —— **只放"已被官方文档或任务书确证"的东西**。
 *
 * ⚠️ 两套模型名必须并存，转换只在这一处：见 `ARK_MODEL_ID` / `PRICE_TABLE_MODEL_NAME`。
 */

/** 官方 API 根（任务书 §3 已确认；`/api/v3` 自带版本段，拼路径时不要再补 /v1） */
export const ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

/**
 * 调用 API 时传的**版本化模型 ID**（任务书 §3 原文：`doubao-seedance-2-5-260628`）。
 * 注意它与价格表里的 `doubao-seedance-2.5` **不是同一个字符串**：
 * 价格表按**模型族名**计费，API 传**版本化 ID**。两者只在这里各出现一次，别在别处硬编码。
 */
export const ARK_MODEL_ID = 'doubao-seedance-2-5-260628';

/** 价格表 / 预估器里用的模型族名（`OFFICIAL_PRICE_TABLE.models` 的键） */
export const PRICE_TABLE_MODEL_NAME = 'doubao-seedance-2.5';

/** 提交任务：POST {base}/contents/generations/tasks */
export const TASKS_PATH = '/contents/generations/tasks';

/** 官方建议轮询间隔 30 秒 */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** 官方 Python 示例的轮询上限：30 分钟 */
export const DEFAULT_POLL_TIMEOUT_MS = 30 * 60 * 1000;

/** 单次 HTTP 请求超时（提交/查询各自计时；官方未给数字，属工程默认值） */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** 素材分流的体积门槛（任务书 §4.2：< 5MB → base64；≥ 5MB → 必须公网 URL） */
export const INLINE_MEDIA_MAX_BYTES = 5 * 1024 * 1024;

/** 官方接口限制（CHARTER §4 特殊约束第 2 条）：单图 < 30MB、单音频 < 15MB、视频 < 200MB */
export const IMAGE_MAX_BYTES = 30 * 1024 * 1024;
export const AUDIO_MAX_BYTES = 15 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024;

/** 请求体总大小上限 64MB（提交前估算，超了直接拒绝，不发请求） */
export const REQUEST_BODY_MAX_BYTES = 64 * 1024 * 1024;

/** 官方时长范围（4–30 秒），另有 -1 = 模型自选 */
export const MIN_DURATION_SEC = 4;
export const MAX_DURATION_SEC = 30;

/**
 * Draft 相关（官方文档 `ark-seedance-2.5.txt`「教程 / 样片」章节）：
 * - Draft 只支持 480p，设别的分辨率会报错；
 * - 基于 Draft 出成片**只支持 1080p**；
 * - Draft 任务 ID 有效期 7 天。
 */
export const DRAFT_RESOLUTION = '480p' as const;
export const DRAFT_FINAL_RESOLUTION = '1080p' as const;
export const DRAFT_TASK_ID_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 官方肖像素材方案（UI 警告里的链接，取自 `ark-portrait-alt.txt` 的"Markdown 版本"行） */
export const PORTRAIT_ASSET_GUIDE_URL =
  'https://ark.volcengine.com/region:cn-beijing/docs/seedance-portrait-asset-guide.md';
export const ARK_CONSOLE_URL = 'https://ark.volcengine.com/region:cn-beijing/apikey';
