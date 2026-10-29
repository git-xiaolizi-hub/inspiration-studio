/**
 * 「已配置的模型」的扁平视图（R7b 界面层）。
 *
 * 卡片上的标签行、详情弹窗的列表、五个角色的候选集都从这一份数据出发，
 * 所以「卡片显示几个模型」与「详情里列出几个模型」永远一致 —— 不会出现
 * 卡片说 5 个、弹窗说 6 个那种对不上。
 *
 * 取哪一份模型表：**该厂商当前生效的连接**（`activeConnectionOf`），
 * 与 `pickModel` / `listModelsByCap` 完全同一口径。别的连接里的模型不显示，
 * 因为在生成时根本不会被选中；要换到别的连接，在 AI 配置页点「当前」即可。
 *
 * 跳过的两类（与 `listModelsByCap` 一致）：
 * - 本地部署类厂商（只做占位，本应用这一版不调用）；
 * - 地址为空的连接（还没配好，不算「已配置」）。
 */
import {
  activeConnectionOf,
  isLocalProvider,
  modelKeyOf,
} from '../../adapters/ai-models/catalog';
import type { AICatalog, ModelCap } from '../../adapters/ai-models/catalog';

export interface ConfiguredModel {
  /** `providerId:connectionId:modelId` —— 与 `settings.modelOrder` / `modelRoles` 同一个 key */
  key: string;
  providerId: string;
  providerName: string;
  connectionId: string;
  /** 模型行的行 id（删行要用它，`removeModel` 的第三个参数） */
  modelRowId: string;
  modelId: string;
  displayName: string;
  caps: ModelCap[];
}

/** 目录 → 扁平的已配置模型（顺序 = 厂商顺序 + 表内顺序，未排序） */
export function configuredModels(catalog: AICatalog): ConfiguredModel[] {
  const rows: ConfiguredModel[] = [];
  for (const provider of catalog.providers) {
    if (isLocalProvider(provider)) continue;
    const connection = activeConnectionOf(provider);
    if (!connection || connection.baseUrl.trim() === '') continue;
    for (const model of connection.models) {
      if (model.enabled === false) continue;
      const modelId = model.modelId.trim();
      if (modelId === '') continue;
      rows.push({
        key: modelKeyOf(provider.id, connection.id, modelId),
        providerId: provider.id,
        providerName: provider.name,
        connectionId: connection.id,
        modelRowId: model.id,
        modelId,
        displayName: model.displayName.trim() === '' ? modelId : model.displayName,
        caps: [...model.caps],
      });
    }
  }
  return rows;
}

/** 标签上显示的名字：优先实际模型 id（等宽字体那一段），拿不到才退回菜单名 */
export function modelLabel(row: ConfiguredModel): string {
  return row.modelId || row.displayName;
}
