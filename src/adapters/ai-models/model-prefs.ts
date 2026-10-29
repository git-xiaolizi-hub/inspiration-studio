/**
 * 模型显示顺序 + 五个角色的默认模型（R7a §D §E）。
 *
 * 存在哪儿：沿用 `settings` 表的两个 key（`ai-model-order` / `ai-model-roles`）。
 * **不建新表、不升 Dexie 版本**（理由同 `core/library`：建表要重放 v1–v4 全部迁移，
 * 风险远大于收益），而且 settings 本来就在备份范围内，两个新 key 自动跟着备份走。
 *
 * 语义边界：
 * - `modelOrder` 只决定**卡片/列表上的显示顺序**，不决定"生成时用哪个"（那是 `modelRoles`）；
 * - 顺序里没有的 key 排在后面（保持原有相对顺序）——绝不因为"没排过"就把模型藏起来；
 * - 模型删了 / 连接删了都会留死 key：读的时候宽松清洗，另提供 `pruneDanglingModelRefs`
 *   做真正的悬空清理（写法照 `core/library` 的 `pruneDangling`：没变化就不写库）。
 */
import { getSetting, putSetting } from '../../core/storage';
import { MODEL_ROLES, modelKeysOf, pickModel } from './catalog';
import type { AICatalog, ModelCap, ModelRole, ModelRoles, PickModelResult } from './catalog';

export const MODEL_ORDER_KEY = 'ai-model-order';
export const MODEL_ROLES_KEY = 'ai-model-roles';

/** 去重 + 只留非空字符串，保持出现顺序（照 `library` 的 cleanIdList） */
function cleanKeyList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const key = item.trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

/** 任意来源的值 → `string[]`；形状不对 = 空数组（脏数据不该让整页崩） */
export function normalizeModelOrder(raw: unknown): string[] {
  return cleanKeyList(raw);
}

/** 任意来源的值 → `ModelRoles`；只留五个已知角色 + 非空字符串值 */
export function normalizeModelRoles(raw: unknown): ModelRoles {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const row = raw as Record<string, unknown>;
  const roles: ModelRoles = {};
  for (const role of MODEL_ROLES) {
    const value = row[role];
    if (typeof value !== 'string') continue;
    const key = value.trim();
    if (key !== '') roles[role] = key;
  }
  return roles;
}

/* ------------------------------------------------------------------ */
/* 读写                                                               */
/* ------------------------------------------------------------------ */

export async function readModelOrder(): Promise<string[]> {
  try {
    const row = await getSetting(MODEL_ORDER_KEY);
    return normalizeModelOrder(row?.value);
  } catch {
    // 读不出来不算错误：退化为「没有自定义顺序」，列表按原顺序显示
    return [];
  }
}

export async function writeModelOrder(order: readonly string[]): Promise<string[]> {
  const value = normalizeModelOrder(order);
  await putSetting({ key: MODEL_ORDER_KEY, value, updatedAt: Date.now() });
  return value;
}

export async function readModelRoles(): Promise<ModelRoles> {
  try {
    const row = await getSetting(MODEL_ROLES_KEY);
    return normalizeModelRoles(row?.value);
  } catch {
    return {};
  }
}

export async function writeModelRoles(roles: ModelRoles): Promise<ModelRoles> {
  const value = normalizeModelRoles(roles);
  await putSetting({ key: MODEL_ROLES_KEY, value, updatedAt: Date.now() });
  return value;
}

/* ------------------------------------------------------------------ */
/* 排序                                                               */
/* ------------------------------------------------------------------ */

/**
 * 按 `order` 排序：
 * - 在 order 里的按 order 的位置排；
 * - 不在 order 里的排在后面，**保持原有相对顺序**；
 * - order 里不存在的 key 自然被丢弃（没有对应元素可比）。
 *
 * 纯函数、稳定排序（不能因为"没排过"把顺序打乱）。
 */
export function orderModels<T extends { key: string }>(items: readonly T[], order: readonly string[]): T[] {
  const rank = new Map<string, number>();
  order.forEach((key, index) => {
    if (typeof key !== 'string') return;
    const clean = key.trim();
    if (clean === '' || rank.has(clean)) return;
    rank.set(clean, index);
  });
  if (rank.size === 0) return [...items];
  const UNRANKED = Number.POSITIVE_INFINITY;
  return items
    .map((item, index) => ({ item, index, rank: rank.get(item.key) ?? UNRANKED }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}

/* ------------------------------------------------------------------ */
/* 悬空清理                                                           */
/* ------------------------------------------------------------------ */

export interface ModelPrefs {
  order: string[];
  roles: ModelRoles;
}

/**
 * 清掉指向「已经不存在的模型」的 key（模型删了、连接删了都会留死 key）。
 *
 * 写法照 `core/library` 的 `pruneDangling`：没变化就**不写库**（打开页面不该产生写入）。
 * 角色指针被清掉 = 当没配（`pickModel` 退回旧行为），不抛错。
 */
export async function pruneDanglingModelRefs(validKeys: Set<string>): Promise<ModelPrefs> {
  const order = await readModelOrder();
  const roles = await readModelRoles();

  const keptOrder = order.filter((key) => validKeys.has(key));
  const keptRoles: ModelRoles = {};
  let rolesChanged = false;
  for (const role of MODEL_ROLES) {
    const key = roles[role];
    if (key === undefined) continue;
    if (validKeys.has(key)) {
      keptRoles[role] = key;
    } else {
      rolesChanged = true;
    }
  }

  const orderChanged = keptOrder.length !== order.length;
  if (!orderChanged && !rolesChanged) return { order, roles };

  if (orderChanged) await writeModelOrder(keptOrder);
  if (rolesChanged) await writeModelRoles(keptRoles);
  return { order: keptOrder, roles: keptRoles };
}

/** 便捷版：按当前目录算合法 key 再清理（AI 配置页挂载时调用） */
export async function pruneMissingModelRefs(catalog: AICatalog): Promise<ModelPrefs> {
  return pruneDanglingModelRefs(modelKeysOf(catalog));
}

/* ------------------------------------------------------------------ */
/* 读库版选模型（同步的 `pickModel` 不碰存储）                          */
/* ------------------------------------------------------------------ */

/** `pickModel(catalog, cap, await readModelRoles())` 的一行版 */
export async function pickModelWithRoles(catalog: AICatalog, cap: ModelCap): Promise<PickModelResult> {
  const roles = await readModelRoles();
  return pickModel(catalog, cap, roles);
}

/** 便于上层只从这里 import 角色相关类型（实际定义在 catalog.ts） */
export type { ModelRole, ModelRoles };
