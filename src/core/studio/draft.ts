/**
 * 写作工作台的草稿（P3）。
 *
 * 存哪儿：现有 `settings` 表的一个 key `studio-draft`（`{ key, value, updatedAt }`）。
 *
 * **为什么不建新表**：与 P2b 的 `library` 同一个理由 —— 建表要升 Dexie 版本，会触发
 * 全库迁移（`db.ts` 里 v1–v4 每一版都要重放）。草稿就是「一段正文 + 最多 4 个素材 id」，
 * 一个 JSON 足够；而且 settings 本来就在备份 zip 内，换设备也跟着走。
 *
 * 形状（任务书 §3.4 逐字一致）：
 *
 * ```ts
 * { body: string, materialIds: string[], updatedAt: number }
 * ```
 *
 * 两条边界：
 * 1. **素材最多 4 条**（`MAX_MATERIALS`，P4c 从 3 提到 4）—— 上限在这里兜，UI 只是第一个拦截点；
 *    手改库 / 旧数据越界时，读回来也只取前 4 条，后面的**不丢原文**（记录本体在 records 表里）。
 * 2. **悬空 id**：记录被删之后 materialIds 里会留残骸。`pruneDraftMaterials()` 负责清掉，
 *    页面的 load 路径必须调它 —— 否则中栏会去渲染一条不存在的素材。
 *
 * 脏数据策略与 `library` 一致：读的时候宽松清洗（非法 JSON / 形状不对 → 空草稿），
 * **读到脏数据不写回**（下一次真正的写操作才落库），避免「只是打开页面」就把用户正文清空。
 */
import { getSetting, putSetting } from '../storage';

export const STUDIO_DRAFT_KEY = 'studio-draft';

/** 中栏最多展开几张素材卡（P4c §1：3 → 4；4 条比 3 条更能填满展示区） */
export const MAX_MATERIALS = 4;

/** 正文自动保存的防抖延迟（任务书 §3.2：500ms） */
export const AUTOSAVE_DELAY_MS = 500;

/** 素材列表一次取多少条（任务书 §3.1：分页去掉，取最近 200 条即可） */
export const MATERIAL_PAGE_SIZE = 200;

export interface StudioDraft {
  body: string;
  /** 顺序 = 中栏卡片的顺序（素材 1、素材 2…） */
  materialIds: string[];
  /** 0 = 从未保存过 */
  updatedAt: number;
  /**
   * P5：「存为记录」的防重复指纹（`fingerprintDraft(body, materialIds)` 的产物）。
   *
   * 只在**存成功之后**写；正文或素材一变，当前指纹就和它对不上，按钮恢复可点。
   * 没有这个字段（旧草稿 / 从没存过）= 从未存过。
   */
  savedFingerprint?: string;
}

export function emptyDraft(): StudioDraft {
  return { body: '', materialIds: [], updatedAt: 0 };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 去重 + 只保留非空字符串 + 截到 MAX_MATERIALS，保持出现顺序 */
export function cleanMaterialIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= MAX_MATERIALS) break;
  }
  return result;
}

/**
 * 把任意来源的值清洗成 `StudioDraft`。永不抛异常：脏数据不该让工作台白屏。
 *
 * `body` **不 trim**：正文里的首尾空行是用户自己敲的，读回来要一模一样。
 */
export function normalizeDraft(raw: unknown): StudioDraft {
  if (!isPlainObject(raw)) return emptyDraft();
  const body = typeof raw.body === 'string' ? raw.body : '';
  const materialIds = cleanMaterialIds(raw.materialIds);
  const updatedAt =
    typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0
      ? raw.updatedAt
      : 0;
  const draft: StudioDraft = { body, materialIds, updatedAt };
  // 指纹只是一串不透明字符：非空字符串才收，脏值当「没存过」（不抛异常）
  if (typeof raw.savedFingerprint === 'string' && raw.savedFingerprint !== '') {
    draft.savedFingerprint = raw.savedFingerprint;
  }
  return draft;
}

/** 读草稿；无数据 / 脏数据都返回空草稿（不写回） */
export async function loadDraft(): Promise<StudioDraft> {
  const row = await getSetting(STUDIO_DRAFT_KEY);
  if (!row) return emptyDraft();
  return normalizeDraft(row.value);
}

/** 写草稿（返回清洗后的值，调用方据此更新内存） */
export async function saveDraft(draft: StudioDraft, now = Date.now()): Promise<StudioDraft> {
  const value = normalizeDraft({ ...draft, updatedAt: now });
  await putSetting({ key: STUDIO_DRAFT_KEY, value, updatedAt: now });
  return value;
}

/**
 * 清掉已经被删掉的素材 id（P2b `pruneDangling` 的同一个思路）。
 * 只动 materialIds，正文一个字都不碰 —— 草稿的价值就在正文。
 * 没有变化时**原样返回同一个对象**，调用方可以用引用相等判断「要不要写回」。
 */
export function pruneDraftMaterials(draft: StudioDraft, validIds: Set<string>): StudioDraft {
  const materialIds = draft.materialIds.filter((id) => validIds.has(id));
  if (materialIds.length === draft.materialIds.length) return draft;
  return { ...draft, materialIds };
}

/**
 * 把 `ids[from]` 挪到 `to` 位置（P4c §6.2 拖拽换序的唯一出口）。
 *
 * **数组顺序就是【素材N】的编号**（`buildStudioContext` 按下标拼标签），所以这个函数
 * 是「用户拖一下 → AI 看到的编号跟着变」那条链路的起点，必须单独可测。
 *
 * 三条边界：越界 / 非整数 / from === to 时**原样返回同一个数组**（调用方据此判断要不要 setState）。
 */
export function moveMaterialId(ids: string[], from: number, to: number): string[] {
  const size = ids.length;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return ids;
  if (from < 0 || from >= size || to < 0 || to >= size || from === to) return ids;
  const next = ids.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** 正文的字数（中栏状态栏显示「已有 N 字」）：按非空白字符数，中文一字算一个 */
export function countBodyChars(body: string): number {
  return body.replace(/\s+/g, '').length;
}

/* ------------------------------------------------------------------ */
/* P5：「存为记录」的防重复指纹                                         */
/* ------------------------------------------------------------------ */

/**
 * 32 位 FNV-1a（`Math.imul` 保证 32 位乘法不溢出成浮点），输出 8 位十六进制。
 *
 * 为什么不用 `crypto.subtle.digest`：那是**异步** API，而按钮的禁用态要在渲染时同步算；
 * 这里的用途是「判断正文有没有动过」，不是密码学校验，32 位碰撞到同一串正文的概率
 * 在个人使用规模下可以忽略。**真需要抗碰撞就该存正文本身，而不是加大哈希强度。**
 */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 草稿指纹：`正文哈希 : 正文长度 : 排序后的素材 id`
 *
 * 两项输入、三条规则（任务书 §3.3）：
 * 1. **正文**参与（含首尾空白 —— 正文不 trim 是本模块的既有约定，多加一个空格也算改动）；
 * 2. **正文长度**一起进指纹：哈希本身只用 32 位，带上长度可以让「同哈希不同长度」不会
 *    被误判成没变（宁可多存一版，也不要该存时按钮是灰的）；
 * 3. **materialIds 排序后拼接**：只换展示顺序（拖拽换序）不算新内容 —— 存出来的记录
 *    正文一模一样，多存一条只是垃圾。排序用 `localeCompare` 无关的纯字典序 `<`，
 *    保证同一组 id 在任何环境下拼出同一串。
 *
 * 反过来说：**改一个字、加一条素材、去掉一条素材**都会变指纹 → 按钮恢复可点。
 */
export function fingerprintDraft(body: string, materialIds: string[]): string {
  const ids = materialIds.slice().sort().join(',');
  return `${hashText(body)}:${body.length}:${ids}`;
}
