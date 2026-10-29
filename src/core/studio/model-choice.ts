/**
 * 写作工作台用哪个模型（P4 §3.2）。
 *
 * 委托人原话：「模型可切换」——右上的模型名要能点开换成目录里另一个 text 模型，
 * 且下次打开沿用。
 *
 * 三条取舍：
 * 1. **候选集来自目录，不自己拼字符串**：`listModelsByCap(catalog, 'text')` 是既有适配器
 *    的出口（它已经处理了「只看当前连接那张模型表」「跳过本地部署厂商」两条硬语义）。
 *    这里只加一层「显示名 · 厂商」的排版，不复制筛选逻辑 —— 复制一份就会和生成路径对不上；
 * 2. **选中的是一条具体的模型**，所以存 `{ providerId, modelId }`（不是只存 modelId：
 *    同一个 modelId 可能同时挂在官方的和一条中转的连接下，凭证与地址都不同）；
 * 3. **没选过 = 走 `pickModel` 的默认挑法**；选过但那条连接/模型被删了 → **不静默换成别的**，
 *    而是返回 `ok:false` + 可执行提示，让界面显示「未配置」并给出跳转
 *    （静默换模型 = 用户以为在用 A，实际在用 B，账单和风格都会错）。
 */
import {
  activeConnectionFor,
  findProvider,
  listModelsByCap,
  pickModel,
} from '../../adapters/ai-models/catalog';
import type { AICatalog, PickModelResult } from '../../adapters/ai-models/catalog';
import { getSetting, putSetting } from '../storage';

export const STUDIO_MODEL_KEY = 'studio-model';

export interface StudioModelChoice {
  providerId: string;
  modelId: string;
}

/** 下拉里的一行：`显示名 · 厂商` */
export interface StudioModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  displayName: string;
  /** 连接是否可用（地址非空）；不可用也列出来，但标灰不给选 */
  usable: boolean;
  /** 菜单上看得见的那一行字 */
  label: string;
}

export const MODEL_NOT_CONFIGURED = '未配置';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeChoice(raw: unknown): StudioModelChoice | null {
  if (!isPlainObject(raw)) return null;
  const providerId = typeof raw.providerId === 'string' ? raw.providerId.trim() : '';
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
  if (providerId === '' || modelId === '') return null;
  return { providerId, modelId };
}

export async function loadModelChoice(): Promise<StudioModelChoice | null> {
  const row = await getSetting(STUDIO_MODEL_KEY);
  if (!row) return null;
  return normalizeChoice(row.value);
}

export async function saveModelChoice(
  choice: StudioModelChoice | null,
  now = Date.now(),
): Promise<void> {
  const value = choice ? normalizeChoice(choice) : null;
  await putSetting({ key: STUDIO_MODEL_KEY, value, updatedAt: now });
}

/** 下拉候选：目录里所有带 text 能力的模型，格式 `显示名 · 厂商` */
export function studioModelOptions(catalog: AICatalog | null): StudioModelOption[] {
  if (!catalog) return [];
  return listModelsByCap(catalog, 'text').map((item) => ({
    providerId: item.providerId,
    providerName: item.providerName,
    modelId: item.modelId,
    displayName: item.displayName,
    usable: item.usable,
    label: `${item.displayName} · ${item.providerName}`,
  }));
}

const DELETED_CONNECTION_HINT =
  '上次用的模型所属的连接已经被删掉了 —— 去 AI 配置重新选一条，或者在上面换一个模型';

const MODEL_GONE_HINT =
  '上次用的模型已经不在这个连接里了 —— 去 AI 配置确认一下，或者在上面换一个模型';

/**
 * 这次到底发给谁：显式选择优先，没选过就 `pickModel` 默认挑。
 * 返回形状与 `pickModel` 一致，页面只认 `ok / provider / connection / model / hint`。
 */
export function resolveStudioModel(
  catalog: AICatalog | null,
  choice: StudioModelChoice | null,
): PickModelResult | null {
  if (!catalog) return null; // 目录还没读出来：页面显示「正在读取模型配置…」
  if (!choice) return pickModel(catalog, 'text');

  const provider = findProvider(catalog, choice.providerId);
  if (!provider) return { ok: false, hint: DELETED_CONNECTION_HINT };

  const connection = activeConnectionFor(catalog, provider.id);
  if (!connection || connection.baseUrl.trim() === '') {
    return { ok: false, hint: DELETED_CONNECTION_HINT };
  }

  const model = connection.models.find(
    (item) =>
      item.modelId === choice.modelId &&
      item.enabled !== false &&
      item.caps.includes('text') &&
      item.modelId.trim() !== '',
  );
  if (!model) return { ok: false, hint: MODEL_GONE_HINT };

  return { ok: true, provider, connection, model };
}
