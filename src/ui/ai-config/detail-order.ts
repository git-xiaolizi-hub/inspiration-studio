/**
 * 详情弹窗的纯逻辑（R7b §C）。
 *
 * 单独一个文件是为了 Vite 的 Fast Refresh：组件文件里一旦同时导出普通值/函数，
 * 改动它就会退化成整页刷新（开发时会丢状态）。这里只放常量与纯函数。
 */

/** 卡片上最多平铺几个标签（第 7 个起折成「还有 N 个 ›」） */
/**
 * 卡片上最多平铺几个标签。
 *
 * **这是初始值与兜底值，不是硬上限**（R7b 修复）：卡片宽度不够时，两行其实放不下 6 个，
 * 旧实现按固定 6 个切片 + CSS 裁切 = 第 5、6 个被静默吃掉，还会出现「已配置 5 个却只显示 4 个」。
 * 现在由 `AIConfigCard` 在真实布局下量出实际能放几个，量不出来（jsdom / 未布局）才用这个值。
 */
export const AI_CONFIG_CARD_MAX_FLAT = 6;

/** 「工作流设计」独一行的语义说明（任务书 §C.1，一字不改） */
export const AGENT_ROLE_HINT =
  '「工作流设计」是让 AI 帮你搭工作流模板时用的模型，比日常写作吃力得多 —— 建议单独挑最强的那个，不用和写作共用。';

/** 把某一行从 from 挪到 to（`after` = 落在 to 之后） */
export function moveModelKey(
  keys: readonly string[],
  from: string,
  to: string,
  after: boolean,
): string[] {
  if (from === to) return [...keys];
  if (!keys.includes(from)) return [...keys];
  const rest = keys.filter((key) => key !== from);
  const targetIndex = rest.indexOf(to);
  if (targetIndex < 0) return [...keys];
  rest.splice(after ? targetIndex + 1 : targetIndex, 0, from);
  return rest;
}

/** ↑ / ↓ 兜底：与相邻一位交换 */
export function nudgeModelKey(keys: readonly string[], key: string, delta: -1 | 1): string[] {
  const index = keys.indexOf(key);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= keys.length) return [...keys];
  const next = [...keys];
  next[index] = keys[target];
  next[target] = key;
  return next;
}
