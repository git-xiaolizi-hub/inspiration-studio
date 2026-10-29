/**
 * 模型 → 生图适配器（与 `video/channels.ts` 同形）。
 *
 * 只做三件事：
 * 1. `adapterKindForImageModel()`：模型名 → 哪一家（大小写/日期后缀不敏感）；
 * 2. `adapterForModel()`：装配适配器，**永不抛异常**（拿不到就给原因 + 可执行下一步）；
 * 3. `imagePriceFor()`：这张图按哪张价格表、多少钱（免费档 0 元、未录入就是 null）。
 *
 * `glm-image` / `cogview-*` → 智谱，`doubao-seedream*` → 方舟，`gpt-image*` / `dall-e*` → OpenAI 兼容。
 */
import { FREE_TRIAL_PRICE_TABLE, OFFICIAL_PRICE_TABLE } from '../ai-models/pricing';
import type { ImagePriceRow, PriceTable } from '../ai-models/pricing';
import { ArkImageAdapter } from './ark-image-adapter';
import { NO_IMAGE_ADAPTER_HINT, OPENAI_IMAGE_MODEL, ZHIPU_IMAGE_MODEL } from './constants';
import type { ImageAdapterKind } from './constants';
import { OpenAIImageAdapter } from './openai-image-adapter';
import type { ImageAdapter } from './types';
import { ZhipuImageAdapter } from './zhipu-image-adapter';

export type { ImageAdapterKind } from './constants';

/** 模型入口：`modelId` 必须有；地址与 Key 来自它所属厂商的当前连接 */
export interface ImageModelTarget {
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface ImageAdapterForModelDeps {
  /** 注入已构造好的适配器（测试 / 宿主自己管理生命周期时用） */
  zhipuAdapter?: ImageAdapter;
  arkAdapter?: ImageAdapter;
  openaiAdapter?: ImageAdapter;
}

export interface ImageAdapterForModelOk {
  ok: true;
  kind: ImageAdapterKind;
  adapter: ImageAdapter;
  /** 官方标免费的档位（cogview-3-flash）：预估显示「免费」，不进累计花费 */
  free: boolean;
  priceTable: PriceTable;
  priceModel: string;
  priceRow: ImagePriceRow | null;
}

export interface ImageAdapterForModelFail {
  ok: false;
  reason: string;
  hint: string;
}

export type ImageAdapterForModelResult = ImageAdapterForModelOk | ImageAdapterForModelFail;

/** 模型名 → 适配器种类（大小写不敏感，允许带日期段） */
export function adapterKindForImageModel(modelId: string): ImageAdapterKind | null {
  const id = modelId.trim().toLowerCase();
  if (id === '') return null;
  if (id.includes('cogview') || id.includes('glm-image')) return 'zhipu';
  if (id.includes('seedream')) return 'ark';
  if (id.includes('gpt-image') || id.includes('dall-e')) return 'openai';
  return null;
}

/**
 * 免费档：只认官方标免费的 `cogview-3-flash`。
 * 其余 cogview / glm-image 都没核实过价格 → **不跟着算免费**（宁可显示"未核实"）。
 */
export function isFreeImageModel(modelId: string): boolean {
  return adapterKindForImageModel(modelId) === 'zhipu' && modelId.trim().toLowerCase().includes('cogview-3-flash');
}

/**
 * 价格表里的键：去掉版本日期段（`doubao-seedream-5-0-pro-260628` → `doubao-seedream-5-0-pro`）。
 * 价格表按"型号族"记价，接口按"版本化 model id"调用，两者必须能对上。
 */
export function priceKeyForImageModel(modelId: string): string {
  return modelId.trim().replace(/-\d{6}$/, '');
}

export interface ImagePriceInfo {
  /** 命中的价格行；null = 价格表里没有这一行（UI 必须显示"未核实"） */
  row: ImagePriceRow | null;
  free: boolean;
  priceModel: string;
  table: PriceTable;
}

/** 按模型找价格行：免费档去免费表，其它去官方表（两张表都不改结构） */
export function imagePriceFor(
  modelId: string,
  officialTable: PriceTable = OFFICIAL_PRICE_TABLE,
): ImagePriceInfo {
  const free = isFreeImageModel(modelId);
  const priceModel = priceKeyForImageModel(modelId);
  const table = free ? FREE_TRIAL_PRICE_TABLE : officialTable;
  return { row: table.image[priceModel] ?? null, free, priceModel, table };
}

/**
 * 模型 → 适配器。**永不抛异常**：拿不到就返回带原因与下一步的失败结果。
 *
 * 凭据来自模型所属厂商的当前连接（AI 配置页里填的那条）；
 * 注入适配器时（测试 / 宿主托管）不校验凭据，直接用注入的那一个。
 */
export function adapterForModel(
  model: ImageModelTarget,
  deps: ImageAdapterForModelDeps = {},
): ImageAdapterForModelResult {
  const modelId = model.modelId.trim();
  const kind = adapterKindForImageModel(modelId);
  if (!kind) {
    return {
      ok: false,
      reason: `模型表里的「${modelId || '（未填模型名）'}」没有对应的生图适配器。`,
      hint: NO_IMAGE_ADAPTER_HINT,
    };
  }

  const { row, free, priceModel, table } = imagePriceFor(modelId);

  const ok = (adapter: ImageAdapter): ImageAdapterForModelOk => ({
    ok: true,
    kind,
    adapter,
    free,
    priceTable: table,
    priceModel,
    priceRow: row,
  });

  if (kind === 'zhipu' && deps.zhipuAdapter) return ok(deps.zhipuAdapter);
  if (kind === 'ark' && deps.arkAdapter) return ok(deps.arkAdapter);
  if (kind === 'openai' && deps.openaiAdapter) return ok(deps.openaiAdapter);

  const apiKey = (model.apiKey ?? '').trim();
  if (!apiKey) {
    return {
      ok: false,
      reason: `这个模型所属的连接还没填 ${kind === 'zhipu' ? '智谱' : kind === 'ark' ? '火山方舟' : '中转站'} 的 API Key，现在发请求一定失败。`,
      hint: '去 AI 配置 → 对应厂商的连接里填上 API Key（保存后回到创作页）。',
    };
  }

  const baseUrl = (model.baseUrl ?? '').trim();

  if (kind === 'zhipu') {
    return ok(new ZhipuImageAdapter({ apiKey, baseUrl: baseUrl || undefined, model: modelId }));
  }
  if (kind === 'ark') {
    return ok(new ArkImageAdapter({ apiKey, baseUrl: baseUrl || undefined, model: modelId }));
  }

  // OpenAI 兼容端没有"官方默认地址"可填：base_url 必填
  if (!baseUrl) {
    return {
      ok: false,
      reason: 'OpenAI 兼容生图需要一个 base_url（中转站地址），你这条连接还没填。',
      hint: `去 AI 配置 → 该厂商的连接里填服务地址（模型名保持 ${OPENAI_IMAGE_MODEL} 或你中转站的实际名字）。`,
    };
  }
  return ok(new OpenAIImageAdapter({ apiKey, baseUrl, model: modelId }));
}

/** 默认模型（配置页提示与 UI 文案共用，避免两处写不同的名字） */
export const IMAGE_DEFAULT_MODELS: Record<ImageAdapterKind, string> = {
  zhipu: ZHIPU_IMAGE_MODEL,
  ark: 'doubao-seedream-5-0-pro',
  openai: OPENAI_IMAGE_MODEL,
};
