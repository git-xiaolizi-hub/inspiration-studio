/**
 * 「这个节点用哪个模型」的唯一一处解析（M5b4 §2）。
 *
 * 为什么要单独一个文件：三处都要同一份答案 ——
 * 1. 节点上的下拉（候选列表 + 默认值）；
 * 2. 执行器的 `runPack`（真正发请求时用哪个 modelId）；
 * 3. 报错文案（"你选的模型不在配置里"必须是一句能照着做的话，不能静默用默认模型）。
 *
 * 纪律（任务书 §2 最后一条）：**用户选了 A 就跑 A**。
 * 选了但配置里没有 → 抛可读错误；没选 → 才跟随"当前默认文本模型"（`pickModel`）。
 */

import { activeConnectionFor, listModelsByCap, pickModel } from '../../adapters/ai-models/catalog';
import type { AICatalog, Connection, ModelCap, ModelEntry } from '../../adapters/ai-models/catalog';
import type { ModelOption } from './store';

/** 模型下拉的候选（与生图 / 生视频节点同一套形状；`key` = providerId::modelId）
 *
 * R7a：`audio` 不参与 —— 工作流暂时没有音频节点，文本/生图/生视频节点各自只要自己那个能力。
 * 真接了音频节点再在这里加，不要提前给一个空下拉。
 */
export function modelOptionsFor(catalog: AICatalog, cap: ModelCap): ModelOption[] {
  return listModelsByCap(catalog, cap).map((model) => ({
    key: `${model.providerId}::${model.modelId}`,
    providerId: model.providerId,
    modelId: model.modelId,
    label: `${model.providerName} / ${model.displayName}`,
    free:
      (cap === 'image' && /cogview-3-flash/i.test(model.modelId)) ||
      (cap === 'video' && /cogvideox-flash/i.test(model.modelId)),
  }));
}

export interface TextModelRef {
  providerId: string;
  modelId: string;
  /** 下拉里显示的那一行（找不到就退回 modelId 本身） */
  label: string;
}

/**
 * 「当前默认文本模型」—— 新节点 / 没选模型的节点跟随它。
 * 一个都没有 → null（界面显示「未配置模型」并标黄，不静默假装有）。
 */
export function defaultTextModelRef(catalog: AICatalog): TextModelRef | null {
  const picked = pickModel(catalog, 'text');
  if (!picked.ok || !picked.provider || !picked.model) return null;
  const model = picked.model;
  return {
    providerId: picked.provider.id,
    modelId: model.modelId,
    label: `${picked.provider.name} / ${model.displayName || model.modelId}`,
  };
}

/** 节点上那句小字：**实际会用的模型名**（避免"以为用了 A 其实用了 B"） */
export function textModelLabel(
  catalog: AICatalog,
  data: { providerId?: string; modelId?: string },
): { label: string; configured: boolean; inherited: boolean } {
  const chosen = (data.modelId ?? '').trim();
  if (chosen === '') {
    const fallback = defaultTextModelRef(catalog);
    return fallback
      ? { label: `默认：${fallback.label}`, configured: true, inherited: true }
      : { label: '未配置模型', configured: false, inherited: true };
  }
  const option = modelOptionsFor(catalog, 'text').find(
    (item) => item.modelId === chosen && (data.providerId === undefined || item.providerId === data.providerId),
  );
  return option
    ? { label: option.label, configured: true, inherited: false }
    : // 选了但配置里已经没有这个模型：标黄（执行时会报可读错误，不会偷偷换模型）
      { label: `未找到：${chosen}`, configured: false, inherited: false };
}

export interface TextModelChoice {
  providerId: string;
  modelId: string;
  connection: Connection;
  model: ModelEntry;
}

export class TextModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextModelError';
  }
}

function usableConnection(connection: Connection | undefined): connection is Connection {
  return Boolean(connection && connection.baseUrl.trim() !== '');
}

/**
 * 解析 pack 节点要用的文本模型。**失败一律抛可读错误**（绝不"找不到就换默认"）。
 */
export function resolveTextModel(
  catalog: AICatalog,
  data: { providerId?: string; modelId?: string },
): TextModelChoice {
  const modelId = (data.modelId ?? '').trim();

  if (modelId === '') {
    const picked = pickModel(catalog, 'text');
    if (!picked.ok || !picked.provider || !picked.model || !picked.connection) {
      throw new TextModelError(picked.hint ?? '没有可用的文本模型：去 AI 配置里加一个');
    }
    return {
      providerId: picked.provider.id,
      modelId: picked.model.modelId,
      connection: picked.connection,
      model: picked.model,
    };
  }

  const providerId = (data.providerId ?? '').trim();
  const provider = providerId === '' ? undefined : catalog.providers.find((item) => item.id === providerId);
  const connection = provider ? activeConnectionFor(catalog, provider.id) : undefined;

  if (!provider || !usableConnection(connection)) {
    throw new TextModelError(
      `这个「提示词包」节点指定的模型「${modelId}」找不到（` +
        `${providerId === '' ? '没有对应的厂商' : `厂商「${provider?.name ?? providerId}」没有生效的连接`}）：` +
        '去 AI 配置里加回来，或在这个节点上重新选一个模型',
    );
  }

  const model = connection.models.find(
    (item) => item.modelId === modelId && item.caps.includes('text'),
  );
  if (!model) {
    throw new TextModelError(
      `厂商「${provider.name}」当前的连接里没有文本模型「${modelId}」：` +
        '检查 AI 配置里的模型表（或在这个节点上重新选一个模型）',
    );
  }

  return { providerId: provider.id, modelId: model.modelId, connection, model };
}
