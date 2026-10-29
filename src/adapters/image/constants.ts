/**
 * 生图适配器的常量：端点、字段集、尺寸表、URL 时效。
 *
 * **每一个数字/字段都能在报告 `M5a2-REPORT.md` §1 找到文档原文**。
 * 没查到原文的东西一律标 `verified: false`，并且 UI 必须把它显示出来。
 */
import type { ImageAspect, ImageUrlTtl } from './types';

/* ------------------------------------------------------------------ */
/* 端点                                                                */
/* ------------------------------------------------------------------ */

/** 智谱 BigModel（`openapi.json` 里 `servers[0].url = https://open.bigmodel.cn/api/`） */
export const ZHIPU_IMAGE_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
/** 智谱官方文档页给出的完整路径：`POST /paas/v4/images/generations` */
export const ZHIPU_IMAGE_PATH = '/images/generations';

/** 火山方舟：`POST https://ark.cn-beijing.volces.com/api/v3/images/generations` */
export const ARK_IMAGE_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const ARK_IMAGE_PATH = '/images/generations';

/** OpenAI 兼容（走用户配置的 base_url + 中转） */
export const OPENAI_IMAGE_PATH = '/images/generations';

export const ZHIPU_CONSOLE_URL = 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys';
export const ARK_CONSOLE_URL = 'https://ark.volcengine.com/region:cn-beijing/apiKey';

/* ------------------------------------------------------------------ */
/* 请求字段集（判据 1：断言"不多传"）                                   */
/* ------------------------------------------------------------------ */

/**
 * 智谱 `CreateImageRequest` 的**全部**文档字段：
 * model / prompt / quality / size / watermark_enabled / user_id（原文见报告 §1.1）。
 * 适配器只发前三个 + size —— 其余三个各有副作用（quality 会改变耗时与计费档、
 * watermark_enabled 关水印需要签免责声明、user_id 是给终端用户追踪的），不该由我们默认发。
 */
export const ZHIPU_IMAGE_FIELDS = ['model', 'prompt', 'size'] as const;

/**
 * 方舟 Body 字段（原文见报告 §1.2）：prompt / image / layer_decomposition / size /
 * optimize_prompt_options / output_format / background / response_format /
 * sequential_image_generation / max_images / stream / tools / watermark / model。
 * 适配器只发 model / prompt / size / response_format：
 * - `response_format: 'url'` 显式要 URL（官方默认也是 url，写明是为了不依赖默认值）；
 * - `watermark` 不传 = 官方默认 true（不替用户关水印）；
 * - `sequential_image_generation` 不传 = 官方默认 `disabled`（只要单图）。
 */
export const ARK_IMAGE_FIELDS = ['model', 'prompt', 'size', 'response_format'] as const;

/**
 * OpenAI 兼容形状。⚠️ **未核实**：`platform.openai.com` 本机返回 403（Cloudflare），
 * 拿不到原文，所以这里只保留"任何 OpenAI 兼容 images 端点都认"的最小三件套，
 * 不传 `n` / `quality` / `response_format`（这些在 gpt-image 系列上各有约束，猜错就是 400）。
 */
export const OPENAI_IMAGE_FIELDS = ['model', 'prompt', 'size'] as const;

/* ------------------------------------------------------------------ */
/* 尺寸表                                                              */
/* ------------------------------------------------------------------ */

/**
 * 智谱 glm-image 推荐枚举（原文：「`glm-image` 推荐枚举值：`1280x1280` (默认),
 * `1568×1056`, `1056×1568`, `1472×1088`, `1088×1472`, `1728×960`, `960×1728`」）。
 */
export const ZHIPU_GLM_IMAGE_SIZES: Record<ImageAspect, string> = {
  '1:1': '1280x1280',
  '3:4': '1056x1568',
  '4:3': '1568x1056',
  '16:9': '1728x960',
  '9:16': '960x1728',
};

/**
 * 智谱 cogview 系列推荐枚举（原文：「其它模型推荐枚举值：`1024x1024` (默认),
 * `768x1344`, `864x1152`, `1344x768`, `1152x864`, `1440x720`, `720x1440`」）。
 * `864x1152` / `1152x864` 是 3:4 / 4:3 的另一种；这里取 `768x1344` / `1344x768`，
 * 与 3:4=0.571、4:3=1.75 更接近。
 */
export const ZHIPU_COGVIEW_SIZES: Record<ImageAspect, string> = {
  '1:1': '1024x1024',
  '3:4': '768x1344',
  '4:3': '1344x768',
  '16:9': '1440x720',
  '9:16': '720x1440',
};

/**
 * 方舟 Seedream 5.0 pro 的像素取值。
 *
 * 文档给的**是范围不是枚举**（原文：总像素取值 [1280x720(921600), 2048x2048x1.1025(4624220)]，
 * 宽高比 [1/16, 16]）。下面五个值全部落在范围内，且是官方文档里出现的推荐档位：
 * 1:1 2048x2048=4194304；3:4 1728x2304=3981312；4:3 2304x1728；16:9 2560x1440=3686400；
 * 9:16 1440x2560。五个都 ≤ 4624220 且 ≥ 921600。
 */
export const ARK_SEEDREAM_SIZES: Record<ImageAspect, string> = {
  '1:1': '2048x2048',
  '3:4': '1728x2304',
  '4:3': '2304x1728',
  '16:9': '2560x1440',
  '9:16': '1440x2560',
};

/**
 * OpenAI 兼容端的尺寸。
 * ⚠️ **未核实**：本机拿不到官方页，按历史公开口径只给三种（1024x1024 / 1024x1536 / 1536x1024），
 * 16:9 与 9:16 都映射到两种竖/横里最接近的那个（**不是真正的 16:9**，报告 §1.3 已标注）。
 */
export const OPENAI_IMAGE_SIZES: Record<ImageAspect, string> = {
  '1:1': '1024x1024',
  '3:4': '1024x1536',
  '4:3': '1536x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
};

/* ------------------------------------------------------------------ */
/* URL 时效                                                            */
/* ------------------------------------------------------------------ */

const DAY = 24 * 60 * 60 * 1000;

/** 智谱：文档原文「图片的临时链接有效期为 `30` 天，请及时转存图片。」→ 已核实 */
export const ZHIPU_IMAGE_URL_TTL: ImageUrlTtl = {
  ms: 30 * DAY,
  verified: true,
  note: '智谱文档：图片临时链接有效期 30 天',
};

/**
 * 方舟：文档原文「该链接将在生成后 **24 小时内失效**，请务必及时保存图像。」→ 已核实。
 * `response_format: 'b64_json'` 时没有链接，自然也没有这个时效。
 */
export const ARK_IMAGE_URL_TTL: ImageUrlTtl = {
  ms: DAY,
  verified: true,
  note: '方舟文档：图片链接 24 小时内失效',
};

/**
 * OpenAI 兼容中转：**没拿到官方原文**（平台文档本机 403）。
 * 取 1 小时这个**保守值**：宁可提示得早，也不要让用户按 24 小时去等。
 * UI 会同时显示「未核实」，不把它说成官方口径。
 */
export const OPENAI_IMAGE_URL_TTL: ImageUrlTtl = {
  ms: 60 * 60 * 1000,
  verified: false,
  note: '未核实（官方文档未取到）：按 1 小时保守处理',
};

/* ------------------------------------------------------------------ */
/* 模型 → 适配器                                                        */
/* ------------------------------------------------------------------ */

export type ImageAdapterKind = 'zhipu' | 'ark' | 'openai';

/** 每家默认模型（与价格表里的键对齐，不带版本后缀） */
export const ZHIPU_IMAGE_MODEL = 'cogview-3-flash';
export const ARK_IMAGE_MODEL = 'doubao-seedream-5-0-pro';
/**
 * R7a 修复：`gpt-image-2.5` 这个 id 不存在（历史笔误），OpenAI 实际发布的是两条。
 * 默认取 flare（便宜、出图快）；要编辑精度换 sunburst。
 */
export const OPENAI_IMAGE_MODEL = 'gpt-image-2.5-flare';
export const OPENAI_IMAGE_MODEL_ALT = 'gpt-image-2.5-sunburst';

export const NO_IMAGE_ADAPTER_HINT =
  '该模型还没有生图适配器：去 AI 配置换一个已接入的生图模型（cogview-3-flash / glm-image / cogview-4 / doubao-seedream-5-0-pro / gpt-image-2.5-flare / gpt-image-2.5-sunburst）';

/** 一次生成最多几张（防止手误把 count 写成 100 直接烧钱） */
export const MAX_IMAGE_COUNT = 4;

/** 尺寸字符串的语法检查：`1024x1024` */
export const SIZE_PATTERN = /^(\d{3,5})x(\d{3,5})$/;
