/**
 * 模型的真实上下文窗口（离线表）。
 *
 * 数据来自 `scripts/sync-model-meta.mjs` 同步的公开名录（models.dev + LiteLLM），
 * 文件是 `context.json`，**不联网也能用**，也不会让弹窗等网络。
 *
 * 为什么要这张表：应用默认按 128k 估算会话预算，而模型实际窗口差别很大
 * （glm-4.7-flash 200k / MiniMax-M3 512k / deepseek-flash 1M）。
 * 用户勾「1M」是**声明**；这张表是**已知事实**，优先于声明。
 */
import data from './context.json';
import { canonicalModelId } from './aliases';

interface ContextTable {
  updatedAt: string;
  source: string;
  contexts: Record<string, number>;
}

const table = data as ContextTable;

/** 去掉连字符、下划线、空格：中转站与官方写法经常不一致（gpt-6.1-sol / gpt-6.1sol） */
function normalizeModelId(modelId: string): string {
  return modelId.toLowerCase().replace(/[^a-z0-9.]/g, '');
}

/**
 * 名录里查得到的窗口；查不到返回 undefined（调用方自己决定怎么兜底）。
 *
 * 查找顺序：别名表 → 原名 → 去掉日期后缀（`xxx-20260101`）。
 * 只做这三种**确定性**还原，不做模糊匹配——猜错窗口比不知道更糟。
 */
export function knownContextFor(modelId: string): number | undefined {
  const lookup = (id: string): number | undefined => {
    const key = normalizeModelId(id);
    if (key === '') return undefined;
    const hit = table.contexts[key];
    return typeof hit === 'number' && hit > 0 ? hit : undefined;
  };

  const canonical = canonicalModelId(modelId);
  const direct = lookup(canonical);
  if (direct) return direct;

  // 去掉尾部日期（-20260101 / -1017 这种 4~8 位数字）
  const stripped = canonical.replace(/[-_](\d{4,8})$/u, '');
  return stripped === canonical ? undefined : lookup(stripped);
}

/** 名录里有多少条（给「选型指南 / 关于」这类页面显示数据规模） */
export function modelMetaSize(): number {
  return Object.keys(table.contexts).length;
}

export const MODEL_META_UPDATED_AT = table.updatedAt;
