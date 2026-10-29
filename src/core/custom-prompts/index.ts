/**
 * 自定义提示词副本：「基于内置提示词改一份，之后跑 pack 用他的副本」。
 *
 * 三条设计约束（都不是审美问题）：
 *
 * 1. **只覆盖 `body`**。真正发出去的 system prompt = `body + 机器校验清单 + 硬禁止`
 *    （`buildSystemPrompt` 拼的），后两段是 `validatePackOutput` 的契约。让用户改整段
 *    等于让他改校验契约，产物会立刻变成"模型没按格式回答"。所以副本里只存正文，
 *    校验清单与硬禁止永远从 pack 的 frontmatter 来。
 *
 * 2. **同步解析 + 异步落库**。`loadBrowserPack()` / `loadPackForWorkflow()` 都是同步函数，
 *    而副本在 IndexedDB 里。于是这里维护一份**内存快照**：
 *    `hydrateCustomPrompts()` 把表读进缓存（幂等），之后解析一律读缓存；
 *    写操作先 await hydrate 再落库并同步更新缓存。
 *    缓存没加载好时**一律回落内置正文** —— 宁可这一次用内置，也不要页面炸掉。
 *
 * 3. **解析只有一份**。`withCustomPrompt()` 是这个仓库里唯一把副本叠到 pack 上的地方，
 *    画板（`ui/workflow/packs.ts`）与创作页（`ui/create/pack-runner.ts`）都调它，
 *    不允许各写一份 —— 否则"画板里改了、去创作页还是旧的"会被当成 bug。
 *
 * 类型上刻意**不 import `BrowserPack`**：那是 UI 层的类型，core 反过来依赖 UI 会把
 * 分层搞反。这里只用 `{ body: string }` 这个结构约束，泛型返回原类型，
 * 调用方拿到的仍然是 `BrowserPack`。
 */
import { getDatabase } from '../storage/db';

/** 正文下限（字）。太短的自定义正文通常意味着用户只是删空了内置提示词 */
export const CUSTOM_PROMPT_MIN_BODY = 50;

export interface CustomPrompt {
  /** `cp_` + 随机 */
  id: string;
  /** 内置 pack 的 id：dream-interpretation / story-expansion / image-prompt-optimizer / video-storyboard */
  basePackId: string;
  /** 用户给副本起的名字，非空 */
  name: string;
  /** **只覆盖 pack 的正文**，不覆盖 validation / forbidden */
  body: string;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* 内存快照                                                            */
/* ------------------------------------------------------------------ */

/** basePackId → 该 pack 当前生效的副本（同一 pack 有多份时取 updatedAt 最新的） */
const snapshot = new Map<string, CustomPrompt>();
let hydrated = false;
let hydrating: Promise<void> | null = null;

function nowOf(prompt: CustomPrompt): number {
  return Number.isFinite(prompt.updatedAt) ? prompt.updatedAt : 0;
}

/** 整表 → 快照：同一 pack 只留最新的一份（"当前生效"必须是确定的） */
function applyRows(rows: CustomPrompt[]): void {
  snapshot.clear();
  const ordered = rows
    .filter((row) => typeof row.basePackId === 'string' && row.basePackId !== '')
    .slice()
    .sort((a, b) => nowOf(a) - nowOf(b));
  for (const row of ordered) snapshot.set(row.basePackId, row);
}

function applyOne(prompt: CustomPrompt): void {
  const current = snapshot.get(prompt.basePackId);
  if (current && nowOf(current) > nowOf(prompt)) return;
  snapshot.set(prompt.basePackId, prompt);
}

/**
 * 读库填充快照（幂等）。页面挂载时调一次；写操作内部也会先调它。
 *
 * 失败**不抛**：老库里没有这张表、或者浏览器禁了 IndexedDB，都只是"这次用内置"，
 * 不该让整页白屏。`force` 用于导入备份后强制重读。
 */
export async function hydrateCustomPrompts(force = false): Promise<void> {
  if (hydrated && !force) return;
  if (hydrating) return hydrating;
  hydrating = (async () => {
    try {
      const rows = (await getDatabase().customPrompts.toArray()) as CustomPrompt[];
      applyRows(rows);
    } catch {
      snapshot.clear();
    } finally {
      hydrated = true;
      hydrating = null;
    }
  })();
  return hydrating;
}

/** 同步取"这个 pack 当前生效的副本"；快照没准备好时返回 undefined（= 用内置） */
export function cachedCustomPromptFor(basePackId: string): CustomPrompt | undefined {
  return snapshot.get(basePackId);
}

/** 测试与导入后用：丢掉快照，下一次 hydrate 会重新读 */
export function resetCustomPromptCache(): void {
  snapshot.clear();
  hydrated = false;
  hydrating = null;
}

/* ------------------------------------------------------------------ */
/* 解析：唯一一处把副本叠到 pack 上                                     */
/* ------------------------------------------------------------------ */

/** 只要有 `body` 就能叠（pack 的具体类型由调用方决定，返回值保持原类型） */
export interface PackWithBody {
  body: string;
}

/** 解析顺序：有副本 → 用副本 body；否则用内置 */
export function withCustomPrompt<T extends PackWithBody>(pack: T, custom?: CustomPrompt): T {
  return custom ? { ...pack, body: custom.body } : pack;
}

/** 画板与创作页共用的入口：按 packId 从快照取副本，再叠上去 */
export function withCustomPromptFor<T extends PackWithBody>(pack: T, basePackId: string): T {
  return withCustomPrompt(pack, cachedCustomPromptFor(basePackId));
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

export function createCustomPromptId(): string {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return `cp_${globalCrypto.randomUUID()}`;
  }
  return `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 保存前的校验：返回错误文案（null = 通过）。UI 与写库共用同一套口径 */
export function validateCustomPromptDraft(draft: { name: string; body: string }): string | null {
  const name = draft.name.trim();
  if (name === '') return '副本名不能为空';
  const body = draft.body.trim();
  if (body === '') return `提示词正文不能为空（至少 ${CUSTOM_PROMPT_MIN_BODY} 字）`;
  if (body.length < CUSTOM_PROMPT_MIN_BODY) {
    return `提示词正文至少 ${CUSTOM_PROMPT_MIN_BODY} 字，现在 ${body.length} 字（太短会把内置提示词改没）`;
  }
  return null;
}

export async function listCustomPrompts(basePackId?: string): Promise<CustomPrompt[]> {
  const table = getDatabase().customPrompts;
  const rows = (basePackId === undefined
    ? await table.toArray()
    : await table.where('basePackId').equals(basePackId).toArray()) as CustomPrompt[];
  return rows.slice().sort((a, b) => nowOf(a) - nowOf(b));
}

export async function getCustomPrompt(id: string): Promise<CustomPrompt | undefined> {
  return (await getDatabase().customPrompts.get(id)) as CustomPrompt | undefined;
}

export async function getCustomPromptForPack(basePackId: string): Promise<CustomPrompt | undefined> {
  const rows = await listCustomPrompts(basePackId);
  return rows.length > 0 ? rows[rows.length - 1] : undefined;
}

export interface CreateCustomPromptInput {
  basePackId: string;
  name: string;
  body: string;
}

/**
 * 建一份副本。校验不通过**直接抛**（UI 会先调 `validateCustomPromptDraft` 显示红字，
 * 这里再挡一次是为了防止别处绕过 UI 写出半份数据）。
 */
export async function createCustomPrompt(
  input: CreateCustomPromptInput,
  now: number = Date.now(),
): Promise<CustomPrompt> {
  const problem = validateCustomPromptDraft(input);
  if (problem !== null) throw new Error(problem);
  if (input.basePackId.trim() === '') throw new Error('缺少基础提示词包');

  await hydrateCustomPrompts();
  const prompt: CustomPrompt = {
    id: createCustomPromptId(),
    basePackId: input.basePackId,
    name: input.name.trim(),
    body: input.body,
    createdAt: now,
    updatedAt: now,
  };
  await getDatabase().customPrompts.put(prompt);
  applyOne(prompt);
  return prompt;
}

export async function updateCustomPrompt(
  id: string,
  patch: { name?: string; body?: string },
  now: number = Date.now(),
): Promise<CustomPrompt> {
  await hydrateCustomPrompts();
  const current = await getCustomPrompt(id);
  if (!current) throw new Error('这份副本已经不存在了（可能被删除或来自另一台设备）');

  const next: CustomPrompt = {
    ...current,
    name: patch.name === undefined ? current.name : patch.name.trim(),
    body: patch.body === undefined ? current.body : patch.body,
    updatedAt: now,
  };
  const problem = validateCustomPromptDraft(next);
  if (problem !== null) throw new Error(problem);

  await getDatabase().customPrompts.put(next);
  applyOne(next);
  return next;
}

export async function removeCustomPrompt(id: string): Promise<void> {
  await hydrateCustomPrompts();
  const current = await getCustomPrompt(id);
  await getDatabase().customPrompts.delete(id);
  if (!current) return;
  snapshot.delete(current.basePackId);
  // 同一 pack 理论上还有更早的副本 → 让快照回到"最新的一份"
  const rest = await listCustomPrompts(current.basePackId);
  if (rest.length > 0) snapshot.set(current.basePackId, rest[rest.length - 1]);
}

/** 「保存」的语义：这个 pack 已经有副本就更新它，没有才新建（避免点两次生成两份） */
export async function saveCustomPromptForPack(
  basePackId: string,
  draft: { name: string; body: string },
  now: number = Date.now(),
): Promise<CustomPrompt> {
  const problem = validateCustomPromptDraft(draft);
  if (problem !== null) throw new Error(problem);
  const existing = cachedCustomPromptFor(basePackId) ?? (await getCustomPromptForPack(basePackId));
  if (existing) return updateCustomPrompt(existing.id, { name: draft.name, body: draft.body }, now);
  return createCustomPrompt({ basePackId, name: draft.name, body: draft.body }, now);
}

/** 「还原为内置」：删掉这个 pack 的副本（UI 语义就是"回到内置原文"） */
export async function restoreBuiltinPrompt(basePackId: string): Promise<number> {
  const rows = await listCustomPrompts(basePackId);
  for (const row of rows) await removeCustomPrompt(row.id);
  snapshot.delete(basePackId);
  return rows.length;
}
