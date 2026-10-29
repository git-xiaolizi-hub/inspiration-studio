/**
 * 会话的上下文预算（M5a3 §4）。
 *
 * 口径说明（报告里也写了）：
 * - 模型表里**没有**上下文窗口字段，所以窗口只能取一个默认值
 *   （`DEFAULT_CONTEXT_WINDOW = 128k`，可用 `CreatePage` 的 `contextWindow` 属性覆盖）；
 * - token 数是**按字符粗估**（汉字 ≈1 token、其余 ≈4 字符/token），界面上必须写「≈」和「估算」；
 * - 到 60% 只提示、**不自动截断**：悄悄丢历史比变慢/变贵更糟，用户得知道发生了什么。
 */

/** 默认窗口：128k。模型表没有窗口字段，别假装精确（见文件头） */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 提示阈值：窗口的 60% */
export const CONTEXT_WARN_RATIO = 0.6;

const CJK =
  /[\u1100-\u11ff\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;

/**
 * 字符 → token 的粗估：汉字/全角标点按 1 个 token，其余（英文、空白、标点）按 4 字符 1 token。
 * 这是**估算**：真实用量以 `usage` 为准，拿不到就只显示 ≈。
 */
export function estimateTokens(text: string): number {
  if (text === '') return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** 一轮会话（含 system 提示词）的累计估算：system + 每条 turn 的 content */
export function estimateConversationTokens(
  systemText: string,
  turns: ReadonlyArray<{ content: string }>,
): number {
  let total = estimateTokens(systemText);
  for (const turn of turns) total += estimateTokens(turn.content);
  return total;
}

export interface ContextBudget {
  tokens: number;
  window: number;
  /** 0–1；窗口非法时为 0 */
  ratio: number;
  /** 百分比（取整，给界面显示） */
  percent: number;
  /** 是否触发「这个会话已经很长」提示 */
  warn: boolean;
}

export function contextBudget(tokens: number, window: number = DEFAULT_CONTEXT_WINDOW): ContextBudget {
  const safeWindow = Number.isFinite(window) && window > 0 ? window : DEFAULT_CONTEXT_WINDOW;
  const ratio = tokens / safeWindow;
  return {
    tokens,
    window: safeWindow,
    ratio,
    percent: Math.max(0, Math.round(ratio * 100)),
    warn: ratio >= CONTEXT_WARN_RATIO,
  };
}
