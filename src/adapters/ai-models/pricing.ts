/**
 * 生成前费用预估（M3 核心）。
 *
 * 这份实现是 `docs/reference/estimate_cost.py` 的 TS 移植（公式、数据结构、自检点都对齐），
 * 并且把三件事当硬要求：
 *
 * 1. **价格表是数据不是代码**：`PriceTable` 可整体替换（UI 里改、或从 JSON 导入），
 *    缺档位时**宁可报错也不猜**（`error` 字段），避免把推断当事实。
 * 2. **估算必须被标注**：字符→token 是估算；帧率 24 是假设值（官方未公布）；
 *    非官方来源的价格标「未验证 YYYY-MM」。
 * 3. **样片是两步独立计费**：Draft(480p) 与 成片(目标分辨率) 分别显示金额，
 *    并给出"值不值得用"的盈亏平衡阈值。
 *
 * 官方公式（火山方舟）：
 *     token = (输入视频秒 + 输出视频秒) × 宽 × 高 × 帧率 ÷ 1024
 * 注意 480p 的 token/秒是 9607.5（非整数）：**按整段乘再取整**。
 * 若先按秒取整（9607×30=288,210）会得到 ¥20.16 —— 那是错的。
 */

export type VideoResolution = '480p' | '720p' | '1080p' | '4k';
/** 价格档位：sd = 480p/720p，hd = 1080p，uhd = 4k */
export type PriceBand = 'sd' | 'hd' | 'uhd';

/** 输出像素（官方公式里的宽/高）。480p 的 854×480 已由 9607.5 token/秒 交叉验证。 */
export const DIMS: Record<VideoResolution, { width: number; height: number }> = {
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
};

/** ⚠️ 假设值：官方价格页没给帧率，24 与公开统计的 9607.5 token/秒 一致 */
export const DEFAULT_FPS = 24;

export interface VideoRatePair {
  /** 输入不含视频（单价更高） */
  withoutInputVideo: number | null;
  /** 输入含视频（单价更低） */
  withInputVideo: number | null;
}

export interface VideoPriceModel {
  bands: Partial<Record<VideoResolution, PriceBand>>;
  rate: Partial<Record<PriceBand, VideoRatePair>>;
}

export interface ImagePriceRow {
  /**
   * 这一条基础价原本是哪种货币（2026-10-29 委托人提出）。
   * 表整体声明 currency:'CNY' 且**按中转站 ¥1=$1 折算**，
   * 所以国外模型填的是美元数字、当人民币用；这个字段只用来在界面上
   * 说明「官方 $X，按 ¥1=$1 折 ¥X」，不参与计算。
   */
  listCurrency?: 'CNY' | 'USD';
  perImage: number | null;
  /** 官方对大像素图的加价（如 seedream 5.0 pro > 261 万像素为 0.60 元/张） */
  highResPerImage?: number | null;
  /** 展示给用户的口径说明（一行为限） */
  note?: string;
  verified: boolean;
  verifiedAt?: string;
}

export interface TextPriceRow {
  /** 同 ImagePriceRow.listCurrency：只用于说明基础价原本的币种 */
  listCurrency?: 'CNY' | 'USD';
  /** 元 / 百万 token（产品默认取**高峰价**，保守上界） */
  inputPerMTokens: number | null;
  /** 输入命中缓存的单价（官方确有该档；不填不影响估算） */
  inputCacheHitPerMTokens?: number | null;
  outputPerMTokens: number | null;
  /** 口径说明：峰谷价、阶梯价、音频价等官方附注 */
  note?: string;
  verified: boolean;
  verifiedAt?: string;
}

export interface PriceTable {
  schemaVersion: 1;
  /** 价格来源，展示给用户看（越具体越好） */
  source: string;
  verified: boolean;
  /** 抓取时间（YYYY-MM 或完整日期） */
  verifiedAt: string;
  currency: 'CNY';
  models: Record<string, VideoPriceModel>;
  image: Record<string, ImagePriceRow>;
  text: Record<string, TextPriceRow>;
}

/**
 * 官方价格（`docs/reference/pricing-2026-10.md`，2026-10 抓取）。
 * 单位：视频 / 文本 = 元 / 百万 token；图片 = 元 / 张。
 *
 * 三条纪律（都写进了数据，不是注释而已）：
 * 1. 只抄 `pricing-2026-10.md` 里的数，没列的一律 null（UI 报「未录入」，不猜）；
 * 2. 文本取**高峰价**（空闲时段为半价，属官方口径，估算取保守上界）；
 * 3. OpenAI / Anthropic / gpt-image-2.5 无官方中文页可核 → 保持 null。
 *
 * 价格数据来自 `docs/reference/pricing-2026-10.md`（2026-10 抓取），现已完整：
 * `doubao-seedance-2.0` 的 1080p 档（51.00 / 31.00）在 M4b 首项按官方页勘误填入
 * （CHARTER §13.5 授权改动 `pricing.test.ts` 里那条把它当作"未录入档位"的断言）。
 * 注意：`doubao-seedance-2.5` 官方未给 4k 价 → 该档位仍**不在 bands 里**，
 * 因此"未录入的档位直接报错"这条规则现在由 2.5 / 4k 承接。
 */
export const OFFICIAL_PRICE_TABLE: PriceTable = {
  schemaVersion: 1,
  source: '火山方舟官方价格页 / DeepSeek 官方文档',
  verified: true,
  verifiedAt: '2026-10',
  currency: 'CNY',
  models: {
    'doubao-seedance-2.5': {
      bands: { '480p': 'sd', '720p': 'sd', '1080p': 'hd' },
      rate: {
        sd: { withoutInputVideo: 70, withInputVideo: 42 },
        hd: { withoutInputVideo: 77, withInputVideo: 46 },
      },
    },
    'doubao-seedance-2.0': {
      bands: { '480p': 'sd', '720p': 'sd', '1080p': 'hd', '4k': 'uhd' },
      rate: {
        sd: { withoutInputVideo: 46, withInputVideo: 28 },
        // 官方价格页：1080p 输入不含视频 51.00 / 含输入视频 31.00（M4b 勘误填入）
        hd: { withoutInputVideo: 51, withInputVideo: 31 },
        uhd: { withoutInputVideo: 26, withInputVideo: 16 },
      },
    },
    'doubao-seedance-2.0-fast': {
      bands: { '480p': 'sd', '720p': 'sd' },
      rate: { sd: { withoutInputVideo: 37, withInputVideo: 22 } },
    },
    'doubao-seedance-2.0-mini': {
      bands: { '480p': 'sd', '720p': 'sd' },
      rate: { sd: { withoutInputVideo: 23, withInputVideo: 14 } },
    },
  },
  image: {
    'doubao-seedream-5-0-pro': {
      perImage: 0.3,
      highResPerImage: 0.6,
      note: '≤261 万像素 0.30 元/张；>261 万像素 0.60 元/张（首张输入图免费，第 2 张起 0.02 元/张）',
      verified: true,
      verifiedAt: '2026-10',
    },
    'doubao-seedream-5-0-flash': {
      perImage: 0.12,
      note: '输入图免费',
      verified: true,
      verifiedAt: '2026-10',
    },
    'doubao-seedream-5-0-lite': {
      perImage: 0.22,
      note: '输入图免费',
      verified: true,
      verifiedAt: '2026-10',
    },
    'doubao-seedream-4-5': { perImage: 0.25, note: '输入图免费', verified: true, verifiedAt: '2026-10' },
    'doubao-seedream-4-0': { perImage: 0.2, note: '输入图免费', verified: true, verifiedAt: '2026-10' },
    // 国外模型：官方报价是美元，表里按「中转站 ¥1=$1」直接当人民币用（委托人口径 2026-10-29）
    'gpt-image-2.5-flare': { listCurrency: 'USD', perImage: null, verified: false, verifiedAt: '2026-10' },
    'gpt-image-2.5-sunburst': { listCurrency: 'USD', perImage: null, verified: false, verifiedAt: '2026-10' },
  },
  text: {
    'deepseek-flash': {
      inputPerMTokens: 2,
      inputCacheHitPerMTokens: 0.04,
      outputPerMTokens: 8,
      note: '高峰价；空闲时段为半价（输入 1.00 / 输出 4.00）。支持图像理解',
      verified: true,
      verifiedAt: '2026-10',
    },
    'deepseek-v4-pro': {
      inputPerMTokens: 9,
      inputCacheHitPerMTokens: 0.3,
      outputPerMTokens: 27,
      note: '高峰价；空闲时段为半价。不支持图像理解',
      verified: true,
      verifiedAt: '2026-10',
    },
    'glm-5.3-flash': {
      inputPerMTokens: 0.8,
      inputCacheHitPerMTokens: 0.23,
      outputPerMTokens: 2.8,
      note: '不分峰谷',
      verified: true,
      verifiedAt: '2026-10',
    },
    'glm-5.2': {
      inputPerMTokens: 8,
      inputCacheHitPerMTokens: 2,
      outputPerMTokens: 28,
      note: '不分峰谷',
      verified: true,
      verifiedAt: '2026-10',
    },
    'doubao-seed-2.1-pro': {
      inputPerMTokens: 6,
      inputCacheHitPerMTokens: 1.2,
      outputPerMTokens: 30,
      note: '不分峰谷',
      verified: true,
      verifiedAt: '2026-10',
    },
    'doubao-seed-2.1-turbo': {
      inputPerMTokens: 3,
      inputCacheHitPerMTokens: 0.6,
      outputPerMTokens: 15,
      note: '不分峰谷',
      verified: true,
      verifiedAt: '2026-10',
    },
    'doubao-seed-2.1-lite': {
      inputPerMTokens: 0.8,
      inputCacheHitPerMTokens: 0.16,
      outputPerMTokens: 2.7,
      note: '音频输入按 12.00 元/百万 token 另行计费',
      verified: true,
      verifiedAt: '2026-10',
    },
    'doubao-seed-2.0-pro': {
      // 序列价：这里填 ≤32K 档（最常见），另两档写进 note，避免假装只有一档
      inputPerMTokens: 3.2,
      inputCacheHitPerMTokens: 0.64,
      outputPerMTokens: 16,
      note: '按上下文阶梯计价：≤32K 3.20/16.00；32–128K 4.80/24.00；128–256K 9.60/48.00',
      verified: true,
      verifiedAt: '2026-10',
    },
  },
};

/**
 * 免费试跑（智谱 BigModel，2026-10 官方核实，见 `docs/reference/free-models.md`）。
 *
 * **为什么另立一张表、不并进 `OFFICIAL_PRICE_TABLE`**：
 * 那张表的键集合被既有断言逐字锁死（`pricing-table.test.ts`：视频 4 个型号 / 文本 8 个 /
 * 图片 6 个），而 M4d-fix 本轮只授权改一条断言（`video-decoupling` 的两行→三行）。
 * 免费档位不属于「官方付费价格」，混进去只会让「这个数从哪来」变糊。
 *
 * 口径：官方标免费 → 单价一律 `0`（不是 null）。`null` 在本项目里表示「未录入，别猜」。
 */
export const FREE_TRIAL_PRICE_TABLE: PriceTable = {
  schemaVersion: 1,
  source: '智谱官方（免费模型）',
  verified: true,
  verifiedAt: '2026-10',
  currency: 'CNY',
  models: {
    'cogvideox-flash': {
      bands: { '480p': 'sd', '720p': 'sd' },
      rate: { sd: { withoutInputVideo: 0, withInputVideo: 0 } },
    },
  },
  image: {
    'cogview-3-flash': {
      perImage: 0,
      note: '官方标免费（0 元/张）；免费池会排队 429',
      verified: true,
      verifiedAt: '2026-10',
    },
  },
  text: {
    'glm-4.7-flash': {
      inputPerMTokens: 0,
      outputPerMTokens: 0,
      note: '官方标免费（0 元/百万 token）；200K 上下文 / 128K 输出',
      verified: true,
      verifiedAt: '2026-10',
    },
    'glm-4v-flash': {
      // 视觉理解走同一个 chat 接口，按文本计费口径记；输出上限 1K
      inputPerMTokens: 0,
      outputPerMTokens: 0,
      note: '视觉理解（图像输入），官方标免费；输出上限 1K。glm-4.6v-flash 长期不可用，不要预置',
      verified: true,
      verifiedAt: '2026-10',
    },
  },
};

/** 深拷贝一份，避免 UI 改价格表时污染模块常量 */
export function clonePriceTable(table: PriceTable = OFFICIAL_PRICE_TABLE): PriceTable {
  return JSON.parse(JSON.stringify(table)) as PriceTable;
}

/**
 * 官方 token 用量公式。
 * `Math.trunc` 对齐 Python 的 int()（正数下等价于向下取整）——
 * 必须对**整段时长**乘完再取整，不能按秒取整后再累加。
 */
export function videoTokens(
  inVideoSec: number,
  outSec: number,
  res: VideoResolution,
  fps: number = DEFAULT_FPS,
): number {
  const { width, height } = DIMS[res];
  return Math.trunc(((inVideoSec + outSec) * width * height * fps) / 1024);
}

export interface EstimateItem {
  label: string;
  tokens: number;
  /** 元 / 百万 token */
  rate: number;
  cost: number;
}

export interface VideoEstimate {
  model: string;
  res: VideoResolution;
  outSec: number;
  inVideoSec: number;
  fps: number;
  hasInputVideo: boolean;
  items: EstimateItem[];
  total: number;
  /** 计费倍率（1 = 官方价；≠1 时金额已按倍率换算成实付估算） */
  multiplier?: number;
  /** 不走样片时的总价（用于算样片溢价） */
  directTotal?: number;
  /** 样片多花的比例（0.4448 = 贵 44%） */
  overheadRatio?: number;
  error?: string;
  priceSource: string;
  verified: boolean;
  verifiedAt: string;
}

function rateFor(
  table: PriceTable,
  model: string,
  res: VideoResolution,
  hasInputVideo: boolean,
): number | null {
  const modelRow = table.models[model];
  if (!modelRow) return null;
  const band = modelRow.bands[res];
  if (!band) return null;
  const pair = modelRow.rate[band];
  if (!pair) return null;
  return hasInputVideo ? pair.withInputVideo : pair.withoutInputVideo;
}

export interface VideoEstimateInput {
  model: string;
  res: VideoResolution;
  outSec: number;
  inVideoSec?: number;
  draft?: boolean;
  fps?: number;
  table?: PriceTable;
  /**
   * 计费倍率（M3R4 §4.2）：连接上填的分组倍率，默认 1 = 官方价。
   * 只在金额上生效（`rate` 仍是官方单价，便于对照文档）；不传则完全等价于旧行为。
   */
  multiplier?: number;
}

/** 金额按分显示（¥20.18），内部保留浮点，避免中间四舍五入累积误差 */
export function formatYuan(value: number): string {
  return `¥${value.toFixed(2)}`;
}

/**
 * 官方限制：Seedance 2.0 系列与 2.5 在**输入含视频**时，若估算 token 低于门槛，
 * 按门槛计费 → 估值会偏乐观。只要输入含视频就必须显示这句（CHARTER §2 M4）。
 */
export const MIN_TOKEN_NOTICE = '若低于最低 token 用量，按最低用量计费，实际可能高于此估值';

export function shouldShowMinTokenNotice(estimate: VideoEstimate): boolean {
  return estimate.hasInputVideo;
}

/**
 * 文本模型 id → 价格表键。
 *
 * 两处命名不一样，必须归一，否则文本预估会显示「价格表未录入」：
 * - 接口侧（尤其方舟）：**版本化 + 连字符** —— `doubao-seed-2-1-pro-260628`；
 * - 价格表侧：**族名 + 点号** —— `doubao-seed-2.1-pro`。
 *
 * 做法：先削尾部日期段（`-\d{6}`），命中就直接用；否则按「忽略 `-` 与 `.`」去表里找
 * 同形键。**不做字符串拼装** —— `doubao-seed-2-1-pro` 里有两个连字符位置可能变成点号，
 * 猜一边必然错一边（首版就这么错过）。找不到就回原值，由调用方显示「未录入」，不编价格。
 */
export function priceKeyForTextModel(
  modelId: string,
  table: PriceTable = OFFICIAL_PRICE_TABLE,
): string {
  const base = modelId.trim().replace(/-\d{6}$/, '');
  if (table.text[base]) return base;
  const shape = (value: string): string => value.toLowerCase().replace(/[.-]/g, '');
  const wanted = shape(base);
  const hit = Object.keys(table.text).find((key) => shape(key) === wanted);
  return hit ?? base;
}

/**
 * 文本档位的主行文案：`输入 ¥2.00 / 输出 ¥8.00 · 每百万 token`。
 * 未录入时返回 null（UI 改显示「未录入，请手动填」）。
 */
export function textRateLine(row: TextPriceRow | null | undefined): string | null {
  const input = row?.inputPerMTokens ?? null;
  const output = row?.outputPerMTokens ?? null;
  if (input === null && output === null) return null;
  const part = (value: number | null): string => (value === null ? '未录入' : formatYuan(value));
  return `输入 ${part(input)} / 输出 ${part(output)} · 每百万 token`;
}

/**
 * 视频预估。`draft: true` = 两步（先 480p 样片，再按目标分辨率出成片）。
 * 返回对象永远带 `priceSource` / `verified` / `verifiedAt`，UI 必须原样展示来源。
 */
export function estimateVideo(input: VideoEstimateInput): VideoEstimate {
  const table = input.table ?? OFFICIAL_PRICE_TABLE;
  const fps = input.fps ?? DEFAULT_FPS;
  const inVideoSec = input.inVideoSec ?? 0;
  const hasInputVideo = inVideoSec > 0;
  // 倍率只乘在金额上：rate 仍是官方单价，用户能拿去和厂商文档对照
  const factor =
    typeof input.multiplier === 'number' && Number.isFinite(input.multiplier) && input.multiplier >= 0
      ? input.multiplier
      : 1;

  const result: VideoEstimate = {
    model: input.model,
    res: input.res,
    outSec: input.outSec,
    inVideoSec,
    fps,
    hasInputVideo,
    items: [],
    total: 0,
    multiplier: factor,
    priceSource: table.source,
    verified: table.verified,
    verifiedAt: table.verifiedAt,
  };

  const suffix = hasInputVideo ? `含输入视频 ${inVideoSec}s` : '不含输入视频';

  if (!input.draft) {
    const rate = rateFor(table, input.model, input.res, hasInputVideo);
    if (rate === null) {
      result.error = `价格表未录入 ${input.model} / ${input.res} / ${suffix} 的单价`;
      return result;
    }
    const tokens = videoTokens(inVideoSec, input.outSec, input.res, fps);
    const item: EstimateItem = {
      label: `生成 ${input.res} 成片 ${trimNum(input.outSec)}s（${suffix}）`,
      tokens,
      rate,
      cost: (tokens / 1e6) * rate * factor,
    };
    result.items.push(item);
    result.total = item.cost;
    return result;
  }

  // 样片：① 480p 草稿 ② 以草稿为前提出成片（草稿视频本身不计 token）
  const draftRate = rateFor(table, input.model, '480p', hasInputVideo);
  const finalRate = rateFor(table, input.model, input.res, hasInputVideo);
  if (draftRate === null || finalRate === null) {
    result.error = `价格表未录入样片所需单价（480p=${String(draftRate)}，${input.res}=${String(finalRate)}）`;
    return result;
  }

  const draftTokens = videoTokens(inVideoSec, input.outSec, '480p', fps);
  const finalTokens = videoTokens(inVideoSec, input.outSec, input.res, fps);
  result.items.push({
    label: `① 生成样片 480p ${trimNum(input.outSec)}s（${suffix}）`,
    tokens: draftTokens,
    rate: draftRate,
    cost: (draftTokens / 1e6) * draftRate * factor,
  });
  result.items.push({
    label: `② 基于样片出成片 ${input.res} ${trimNum(input.outSec)}s（${suffix}）`,
    tokens: finalTokens,
    rate: finalRate,
    cost: (finalTokens / 1e6) * finalRate * factor,
  });
  result.total = result.items.reduce((sum, item) => sum + item.cost, 0);

  const direct = estimateVideo({
    model: input.model,
    res: input.res,
    outSec: input.outSec,
    inVideoSec,
    draft: false,
    fps,
    table,
    multiplier: factor,
  });
  if (!direct.error && direct.total > 0) {
    result.directTotal = direct.total;
    result.overheadRatio = result.total / direct.total - 1;
  }
  return result;
}

function trimNum(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/**
 * 样片值不值得用的判定语。
 * 例：Draft ¥20.18（480p）→ 成片 ¥45.36（720p）；样片值得用，当且仅当废片率 > 44%。
 */
export function draftAdvice(estimate: VideoEstimate): string | null {
  if (estimate.error || estimate.overheadRatio === undefined || estimate.directTotal === undefined) {
    return null;
  }
  const threshold = Math.round(estimate.overheadRatio * 100);
  return `样片值得用，当且仅当废片率 > ${threshold}%`;
}

/** 样片两行金额（任务书要求分别显示） */
export function draftLines(estimate: VideoEstimate): { draft: string; final: string } | null {
  if (estimate.error || estimate.items.length < 2) return null;
  const [first, second] = estimate.items;
  return {
    draft: `Draft ${formatYuan(first.cost)}（480p）`,
    final: `成片 ${formatYuan(second.cost)}（${estimate.res}）`,
  };
}

/* ------------------------------------------------------------------ */
/* 文本 / 图片                                                         */
/* ------------------------------------------------------------------ */

/**
 * 字符 → token 的粗略换算。
 * 中文大约 1.5–1.8 字/token，英文约 4 字符/token；**这是估算**，
 * 真实用量以接口返回的 usage.prompt_tokens 为准（UI 必须标「估算」）。
 */
export const DEFAULT_CHARS_PER_TOKEN = 1.6;

export function charsToTokens(chars: number, charsPerToken: number = DEFAULT_CHARS_PER_TOKEN): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / Math.max(charsPerToken, 0.1));
}

export interface TextEstimateInput {
  inputChars: number;
  outputChars?: number;
  priceRow?: TextPriceRow | null;
  charsPerToken?: number;
}

export interface TextImageEstimate {
  items: EstimateItem[];
  total: number;
  error?: string;
  /** 字符估算是估算，UI 必须标注 */
  estimated: true;
}

export function estimateText(input: TextEstimateInput): TextImageEstimate {
  const row = input.priceRow;
  const inputRate = row?.inputPerMTokens ?? null;
  const outputRate = row?.outputPerMTokens ?? null;
  if (row == null || (inputRate === null && outputRate === null)) {
    return { items: [], total: 0, estimated: true, error: '价格表未录入该模型的文本单价（先填单价再估）' };
  }
  const cpt = input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const inputTokens = charsToTokens(input.inputChars, cpt);
  const outputTokens = charsToTokens(input.outputChars ?? 0, cpt);
  const items: EstimateItem[] = [];
  if (inputRate !== null) {
    items.push({
      label: `输入 ${input.inputChars} 字符 ≈ ${inputTokens} token（估算）`,
      tokens: inputTokens,
      rate: inputRate,
      cost: (inputTokens / 1e6) * inputRate,
    });
  }
  if (outputRate !== null && outputTokens > 0) {
    items.push({
      label: `输出 ${input.outputChars} 字符 ≈ ${outputTokens} token（估算）`,
      tokens: outputTokens,
      rate: outputRate,
      cost: (outputTokens / 1e6) * outputRate,
    });
  }
  return { items, total: items.reduce((sum, item) => sum + item.cost, 0), estimated: true };
}

export interface ImageEstimateInput {
  count: number;
  priceRow?: ImagePriceRow | null;
}

/** 图片预估：张数 × 单价（官方/站方都是按张计费，没有 token 公式可用） */
export function estimateImage(input: ImageEstimateInput): TextImageEstimate {
  const perImage = input.priceRow?.perImage ?? null;
  if (perImage === null) {
    return { items: [], total: 0, estimated: true, error: '价格表未录入该模型的图片单价（按张计）' };
  }
  const count = Math.max(0, Math.trunc(input.count));
  const items: EstimateItem[] = [
    { label: `生成 ${count} 张（按张计费）`, tokens: 0, rate: perImage, cost: count * perImage },
  ];
  return { items, total: count * perImage, estimated: true };
}

/* ------------------------------------------------------------------ */
/* 预算闸门                                                           */
/* ------------------------------------------------------------------ */

export interface BudgetInput {
  /** 本次预估（元） */
  estimate: number;
  /** 已累计花费（元） */
  spent: number;
  /** 预算上限（元）；null = 未设置，不拦 */
  budget: number | null;
}

export interface BudgetVerdict {
  spent: number;
  budget: number | null;
  estimate: number;
  /** 本次生成后会到多少 */
  projected: number;
  remaining: number | null;
  exceeded: boolean;
  /** 触顶必须停下来让用户确认（CHARTER §2 M3） */
  requiresConfirm: boolean;
  /** 固定格式的一行摘要："预计花费 ¥X.XX（估算） | 已用 ¥Y.YY / 预算 ¥Z.ZZ" */
  summary: string;
  message?: string;
}

export function checkBudget(input: BudgetInput): BudgetVerdict {
  const spent = Math.max(0, input.spent);
  const estimate = Math.max(0, input.estimate);
  const projected = spent + estimate;
  const budget = input.budget;
  const remaining = budget === null ? null : budget - spent;
  const exceeded = budget !== null && projected > budget;

  const verdict: BudgetVerdict = {
    spent,
    budget,
    estimate,
    projected,
    remaining,
    exceeded,
    requiresConfirm: exceeded,
    // R6：预算上限已从设置页移除（默认 budget = null），摘要不再重复报「预计花费」——
    // 金额只在上方那行小字与确认框里出现一次，这里只报累计。
    summary:
      budget === null
        ? `本机累计已花 ${formatYuan(spent)}`
        : `本机累计已花 ${formatYuan(spent)} / 预算 ${formatYuan(budget)}`,
  };
  if (exceeded && budget !== null) {
    verdict.message = `这次生成后累计 ${formatYuan(projected)}，超出预算 ${formatYuan(
      projected - budget,
    )}。按成本纪律：先确认再继续，否则请调低时长/分辨率或提高预算。`;
  } else if (budget !== null && remaining !== null && remaining <= 0) {
    verdict.message = `预算已用完（已用 ${formatYuan(spent)} / ${formatYuan(budget)}）。继续生成前请先确认。`;
  }
  return verdict;
}
