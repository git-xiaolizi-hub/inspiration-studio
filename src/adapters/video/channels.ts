/**
 * 按模型挑视频适配器（M3R3 §3：删掉「通道」概念）。
 *
 * M4c 那版把「Seedance（付费）」与「CogVideoX-Flash（免费通道）」做成了两个并列"通道"，
 * 还另配一套"免费通道配置"。承接方判定没必要：**模型表里带 `video` 能力的模型就是全部可选面**，
 * 选了哪个模型就用哪个适配器，免费与否是模型自己的属性。
 *
 * 于是本文件只剩两件事：
 * 1. `adapterForModel()`：模型名 → 适配器（`cogvideox*` → 智谱，`doubao-seedance*` → 火山方舟，
 *    其它 → 一句可执行提示，例如本地部署的 minimax-h3 这一版没接）；
 * 2. `actualCostForChannel()`：免费模型的记账口径（恒为 0，不是"按 0 元单价算"）。
 *
 * 两个适配器（`ark-adapter` / `zhipu-adapter`）的代码一行没改 —— 这里只决定**用哪一个**。
 */
import { FREE_TRIAL_PRICE_TABLE, OFFICIAL_PRICE_TABLE } from '../ai-models/pricing';
import type { PriceTable } from '../ai-models/pricing';
import { ArkVideoAdapter } from './ark-adapter';
import { FREE_CHANNEL_CAPABILITIES, PAID_CHANNEL_CAPABILITIES } from './capabilities';
import type { VideoChannelCapabilities } from './capabilities';
import { PRICE_TABLE_MODEL_NAME } from './constants';
import type { VideoAdapter, VideoResolution } from './types';
import { ZhipuVideoAdapter } from './zhipu-adapter';
import { ZHIPU_BASE_URL, ZHIPU_MODEL_ID } from './zhipu-constants';

/** 适配器可选能力（不放进 `VideoAdapter` 契约：第二家不一定有，UI 也只在有的时候接） */
export interface ChannelAdapterExtras {
  isAborted?: (taskId: string) => boolean;
  listenRetry?: (listener: (info: { attempt: number; delayMs: number }) => void) => () => void;
}

export type ChannelAdapter = VideoAdapter & ChannelAdapterExtras;

export type VideoAdapterKind = 'ark' | 'zhipu';

/** 模型入口：`modelId` 必须有；地址与 Key 来自它所属厂商的当前连接 */
export interface VideoModelTarget {
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface AdapterForModelDeps {
  /** 注入已构造好的适配器（测试 / 宿主自己管理生命周期时用） */
  arkAdapter?: ChannelAdapter;
  zhipuAdapter?: ChannelAdapter;
}

export interface AdapterForModelOk {
  ok: true;
  kind: VideoAdapterKind;
  adapter: ChannelAdapter;
  capabilities: VideoChannelCapabilities;
  /** 免费模型：预估显示「免费」、不进累计花费 */
  free: boolean;
  /** 预估用的价格表与模型键（每个模型可能在不同表里） */
  priceTable: PriceTable;
  priceModel: string;
}

export interface AdapterForModelFail {
  ok: false;
  /** 人话原因（为什么这个模型现在用不了） */
  reason: string;
  /** 可执行下一步 */
  hint: string;
}

export type AdapterForModelResult = AdapterForModelOk | AdapterForModelFail;

export const NO_VIDEO_ADAPTER_HINT =
  '该模型还没有视频适配器（如本地部署的 minimax-h3）：去 AI 配置换一个已接入的模型，或把模型名改成 doubao-seedance-2-5-260628 / cogvideox-flash';

/** 模型名 → 适配器种类（大小写不敏感，允许带日期段） */
export function adapterKindForModel(modelId: string): VideoAdapterKind | null {
  const id = modelId.trim().toLowerCase();
  if (id === '') return null;
  if (id.includes('cogvideo')) return 'zhipu';
  if (id.includes('seedance')) return 'ark';
  return null;
}

/** 免费模型：只认官方标免费的那一个（cogvideox-flash），别的 cogvideox 不跟着算免费 */
export function isFreeVideoModel(modelId: string): boolean {
  return adapterKindForModel(modelId) === 'zhipu' && modelId.trim().toLowerCase().includes('flash');
}

/**
 * 智谱系列的能力面（结构能力与 `cogvideox-flash` 相同：固定 5 秒、只认首尾帧 URL、无样片）；
 * `paid` 单独按模型判定 —— 未核实价格的型号不能顺手标成"免费"。
 */
function zhipuCapabilities(free: boolean): VideoChannelCapabilities {
  return free ? FREE_CHANNEL_CAPABILITIES : { ...FREE_CHANNEL_CAPABILITIES, paid: true };
}

/**
 * 模型 → 适配器。**永不抛异常**：拿不到就返回带原因与下一步的失败结果。
 *
 * 凭据来自模型所属厂商的当前连接（AI 配置页里填的那条）；
 * 注入适配器时（测试 / 宿主托管）不校验凭据，直接用注入的那一个。
 */
export function adapterForModel(
  model: VideoModelTarget,
  deps: AdapterForModelDeps = {},
): AdapterForModelResult {
  const modelId = model.modelId.trim();
  const kind = adapterKindForModel(modelId);
  if (!kind) {
    return {
      ok: false,
      reason: `模型表里的「${modelId || '（未填模型名）'}」没有对应的视频适配器。`,
      hint: NO_VIDEO_ADAPTER_HINT,
    };
  }

  const free = kind === 'zhipu' ? isFreeVideoModel(modelId) : false;
  const capabilities = kind === 'ark' ? PAID_CHANNEL_CAPABILITIES : zhipuCapabilities(free);
  const priceTable = free ? FREE_TRIAL_PRICE_TABLE : OFFICIAL_PRICE_TABLE;
  const priceModel = free ? ZHIPU_MODEL_ID : kind === 'ark' ? PRICE_TABLE_MODEL_NAME : modelId;

  if (kind === 'ark') {
    if (deps.arkAdapter) {
      return { ok: true, kind, adapter: deps.arkAdapter, capabilities, free, priceTable, priceModel };
    }
    const apiKey = (model.apiKey ?? '').trim();
    if (!apiKey) {
      return {
        ok: false,
        reason: '这个模型所属的连接还没填火山方舟 API Key，现在发请求一定失败。',
        hint: '去 AI 配置 → 火山方舟（豆包）的连接里填上 API Key（保存配置后回到这一页）。',
      };
    }
    const baseUrl = (model.baseUrl ?? '').trim();
    return {
      ok: true,
      kind,
      adapter: new ArkVideoAdapter({ apiKey, baseUrl: baseUrl || undefined }),
      capabilities,
      free,
      priceTable,
      priceModel,
    };
  }

  if (deps.zhipuAdapter) {
    return { ok: true, kind, adapter: deps.zhipuAdapter, capabilities, free, priceTable, priceModel };
  }
  const apiKey = (model.apiKey ?? '').trim();
  if (!apiKey) {
    return {
      ok: false,
      reason: '这个模型所属的连接还没填智谱 API Key（免费模型也要 Key，只是不收费）。',
      hint: '去 AI 配置 → 智谱的连接里填上 API Key（保存配置后回到这一页）。',
    };
  }
  return {
    ok: true,
    kind,
    adapter: new ZhipuVideoAdapter({
      apiKey,
      baseUrl: (model.baseUrl ?? '').trim() || ZHIPU_BASE_URL,
      model: modelId,
    }),
    capabilities,
    free,
    priceTable,
    priceModel,
  };
}

/**
 * 本次实际花费（元）。
 * 免费模型**恒为 0** —— 不是"按 0 元单价算"，而是"这条路径根本不进记账"（判据 19）。
 */
export function actualCostForChannel(
  capabilities: Pick<VideoChannelCapabilities, 'paid'>,
  tokens: number,
  rate: number | null,
  estimateTotal: number,
): number {
  if (!capabilities.paid) return 0;
  if (rate !== null && tokens > 0) return (tokens / 1_000_000) * rate;
  return estimateTotal;
}

/** 模型允许的分辨率；当前值不在列表里就回落到第一个（换模型时用） */
export function coerceResolution(
  capabilities: Pick<VideoChannelCapabilities, 'resolutions'>,
  current: string,
): VideoResolution {
  const allowed = capabilities.resolutions;
  return allowed.find((item) => item === current) ?? allowed[0] ?? '720p';
}
