/**
 * 智谱 BigModel（CogVideoX-Flash，免费）常量 —— **只放任务书 §3 确证过的东西**。
 *
 * 确证来源（任务书 §3，取自官方 OpenAPI）：
 * - Base `https://open.bigmodel.cn/api/paas/v4`
 * - 提交 `POST /videos/generations`，查询 `GET /async-result/{id}`
 * - 模型 `cogvideox-flash`（官方模型总览：「免费视频生成模型 | 图像、文本」）
 * - 请求体字段：`model` / `prompt` / `quality` / `size` / `fps` / `with_audio` /
 *   `movement_amplitude` / `image_url` / `duration`（后两者可选）
 * - 状态枚举 `PROCESSING | SUCCESS | FAIL`（大小写按防御式处理）
 * - 429 繁忙：`{"error":{"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}}`
 *
 * ⚠️ 未确证、按"能不传就不传 / 本地先拒"处理的东西（报告 §4 有清单）：
 * - `size` 的合法枚举：只有 `1280x720` 是任务书给的**例值**，其余尺寸是本项目推导的；
 * - `duration` 是否被该模型接受：**默认不传**（`sendDuration: false`）；
 * - SUCCESS 时结果 URL 的字段位置。
 */
export const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

/** 提交：POST {base}/videos/generations */
export const ZHIPU_VIDEO_PATH = '/videos/generations';

/** 查询：GET {base}/async-result/{id} */
export const ZHIPU_ASYNC_RESULT_PATH = '/async-result';

/** 免费模型 ID（别与价格表键混为一谈：免费通道根本不进价格表） */
export const ZHIPU_MODEL_ID = 'cogvideox-flash';

/** 免费池拥挤的状态码与业务码（任务书 §3 实测值） */
export const ZHIPU_BUSY_STATUS = 429;
export const ZHIPU_BUSY_CODE = '1305';
/** 关键词兜底：有些网关把 1305 包在 200/400 里，或者只给中文 message */
export const ZHIPU_BUSY_PATTERN = /1305|访问量过大|访问人数过多|请稍后再试/i;

/**
 * 退避重试（任务书 §3：默认 3 次，间隔 5s/15s/45s，可配）。
 * 抖动只**增加**等待（0–20%），保证"间隔递增"这一点能被测试确定地断言。
 */
export const ZHIPU_MAX_RETRIES = 3;
export const ZHIPU_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
export const ZHIPU_RETRY_JITTER_RATIO = 0.2;

/** 轮询间隔/超时（官方未给建议值，属工程默认：免费池出片通常 1–3 分钟） */
export const ZHIPU_POLL_INTERVAL_MS = 10_000;
export const ZHIPU_POLL_TIMEOUT_MS = 20 * 60 * 1000;
export const ZHIPU_REQUEST_TIMEOUT_MS = 30_000;
export const ZHIPU_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** 免费通道放行的分辨率（1080p 是否支持未验证 → 本地拒绝，不赌） */
export const ZHIPU_SUPPORTED_RESOLUTIONS = ['480p', '720p'] as const;

/**
 * 固定时长 5 秒（任务书 §3 的例值），且**默认不把 duration 写进请求体**。
 * 原因：`duration` 是否被 `cogvideox-flash` 接受未验证，传错会白白浪费一次免费额度。
 */
export const ZHIPU_FIXED_DURATION = 5;
/** `sendDuration: true` 时允许的时长（仍未验证，只放行官方常见档位） */
export const ZHIPU_DURATION_CHOICES = [5, 10];

/** 画面比例 → size（`resolution/ratio` 为键）。**只有 `720p/16:9` 是任务书例值**，其余为推导 */
export const ZHIPU_SIZE_TABLE: Record<string, string> = {
  '480p/16:9': '854x480',
  '480p/9:16': '480x854',
  '480p/1:1': '480x480',
  '480p/adaptive': '854x480',
  '720p/16:9': '1280x720',
  '720p/9:16': '720x1280',
  '720p/1:1': '1024x1024',
  '720p/adaptive': '1280x720',
};

/** 只有这一个尺寸有文档例值，其余一律标"未验证"（供报告/UI 提示用） */
export const ZHIPU_DOCUMENTED_SIZE = '1280x720';

export function zhipuSizeFor(resolution: string, ratio: string): string | null {
  return ZHIPU_SIZE_TABLE[`${resolution}/${ratio}`] ?? null;
}

/** 智谱控制台（auth 类错误的下一步） */
export const ZHIPU_CONSOLE_URL = 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys';
