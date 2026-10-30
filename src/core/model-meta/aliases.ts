/**
 * 模型别名表（手工白名单）。
 *
 * 为什么需要：中转站和官方经常给同一个模型起不同名字
 * （`deepseek-v4.1-flash-1017` / `deepseek-v4.1-flash` / `deepseek-v4-flash` 都是 deepseek-flash），
 * 名录里的键只有官方的那个，别名查不到就会掉进「猜测」分支。
 *
 * 维护原则：**只写确认过的等价关系**，一次几条就够，不追求全覆盖。
 * 查不到也没关系——界面上会标成「按默认估」，不会假装知道。
 */
export const MODEL_ALIASES: Record<string, string> = {
  // DeepSeek：官方叫 deepseek-flash，中转站常见带版本号/日期后缀的写法
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4.1-flash-1017': 'deepseek-flash',
  'deepseek-v3.2': 'deepseek-flash',

  // Claude：带日期后缀的常见（claude-opus-5-5-20260101）
  'claude-opus-5-5-20260101': 'claude-opus-5-5',
  'claude-sonnet-5-5-20260101': 'claude-sonnet-5-5',

  // Gemini：中转站常去掉 -argon / -carbon 后缀
  'gemini-4': 'gemini-4-argon',
  'gemini-4-pro': 'gemini-4-argon',

  // GPT
  'gpt-6.1': 'gpt-6.1-sol',
  'gpt-6.1-sol-20260101': 'gpt-6.1-sol',
};

/** 别名表也按同样的规则归一化（大小写、连字符、空格都不敏感） */
export function normalizeAliasKey(modelId: string): string {
  return modelId.toLowerCase().replace(/[^a-z0-9.]/g, '');
}

const NORMALIZED_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(MODEL_ALIASES).map(([alias, target]) => [normalizeAliasKey(alias), target]),
);

/** 别名 → 正式 modelId；没有别名就返回原值 */
export function canonicalModelId(modelId: string): string {
  const key = normalizeAliasKey(modelId);
  return NORMALIZED_ALIASES[key] ?? modelId;
}
