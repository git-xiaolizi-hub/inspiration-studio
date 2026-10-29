/**
 * 写作工作台的 AI 上下文构造（P3 §3.3）。
 *
 * 形状是任务书逐字定的：
 *
 * ```
 * 【素材1】…
 * 【素材2】…
 *
 * 【正文】…
 * ```
 *
 * 三条取舍：
 * 1. **纯函数**，不碰网络、不读库 —— 报告里要贴的就是它实际吐出来的字符串，测试也直接比对它；
 * 2. 素材**不截断**：中栏卡片显示全文，喂给模型的也必须是全文（截断会让 AI 写的和用户看的不一致）；
 * 3. 一条素材都没有时**不写空的【素材N】**，只留正文段；正文为空也照样给 `【正文】` 这个标签，
 *    让模型知道「这里本该有正文，但用户还没写」—— 而不是让它以为自己在续写素材。
 */

export interface StudioMaterialLike {
  text: string;
}

/** 单条素材在上下文里的标题：`【素材1】`、`【素材2】`… */
export function materialLabel(index: number): string {
  return `【素材${index + 1}】`;
}

/**
 * 素材 + 正文 → 上下文串。空行只出现在素材块与正文块之间（与样张一致）。
 */
export function buildStudioContext(
  materials: ReadonlyArray<StudioMaterialLike>,
  body: string,
): string {
  const blocks = materials.map((item, index) => `${materialLabel(index)}${item.text.trim()}`);
  const bodyBlock = `【正文】${body.trim()}`;
  return blocks.length === 0 ? bodyBlock : `${blocks.join('\n')}\n\n${bodyBlock}`;
}

/**
 * 完整的 user 消息 = 上面那段上下文 + 用户这次的指令。
 * 指令为空时**不加【要求】段**（有些模型会把空指令当成「随便写」而放飞）。
 */
export function buildStudioUserMessage(
  materials: ReadonlyArray<StudioMaterialLike>,
  body: string,
  instruction: string,
): string {
  const context = buildStudioContext(materials, body);
  const clean = instruction.trim();
  return clean === '' ? context : `${context}\n\n【要求】${clean}`;
}

/** 系统提示：一句话限定角色，不塞产品内部代号（委托人要求文案里不许出现内部名） */
export const STUDIO_SYSTEM_PROMPT =
  '你是一位小说与短片写作搭档。用户会给你若干条素材和一段正在进行中的正文，' +
  '请按用户的要求继续写、改写或压缩，只输出正文本身，不要解释你的思路，也不要重复素材原文。';

/** AI 输入框下面那行小字：「会带上 2 条素材 + 正文全文」 */
export function contextHint(materialCount: number, bodyChars: number): string {
  if (materialCount === 0 && bodyChars === 0) return '还没有素材，也没有正文';
  if (materialCount > 0 && bodyChars > 0) return `会带上 ${materialCount} 条素材 + 正文全文`;
  if (materialCount > 0) return `会带上 ${materialCount} 条素材`;
  return '会带上正文全文';
}
