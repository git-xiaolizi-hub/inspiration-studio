/**
 * 置顶 + 合集（P2b）。
 *
 * 存在哪儿：现有 `settings` 表的一个 key `library`（`{ key: 'library', value: Library }`）。
 *
 * **为什么不建新表**：建表要升 Dexie 版本，会触发全库迁移（`db.ts` 里 v1–v4 每一版都要
 * 重放），风险远大于收益。个人使用规模（几千条以内）一个 JSON 足够；而且 settings 本来
 * 就在备份范围内（`core/backup` 的 `settings.json`），置顶与合集自动跟着备份走。
 *
 * 语义边界（任务书 §1）：
 * - `pins` 的数组顺序 = 置顶区显示顺序（后置顶的排在后面）；
 * - `collections[].recordIds` 的数组顺序 = 合集内拖拽后的顺序；
 * - 只有这两个数组对顺序有发言权，「全部」区永远按 createdAt 倒序（不在这里管）。
 *
 * 脏数据策略：读的时候宽松清洗（非法 JSON / 形状不对 → 回落空库），**读到脏数据不写回**
 * （下一次真正的写操作才落库）。这样即使库被外部改坏，也不会在「只是打开首页」时把用户
 * 数据覆盖成空。
 */
import { getRecord, getSetting, putSetting } from '../storage';
import type { RecordRow } from '../storage/db';
import { LibraryError } from './types';
import type { Collection, Library } from './types';

export { LibraryError } from './types';
export type { Collection, Library } from './types';

export const LIBRARY_SETTING_KEY = 'library';

/** 合集名上限（与标签的 30 字符同一量级，避免 chip 被长名撑破） */
export const MAX_COLLECTION_NAME = 40;

export function emptyLibrary(): Library {
  return { pins: [], collections: [] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 去重 + 只保留非空字符串，保持出现顺序 */
function cleanIdList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * 把任意来源的值清洗成 `Library`。
 * - 顶层形状不对（不是对象 / pins 或 collections 不是数组）→ 空库；
 * - 单条合集形状不对 → 丢掉这一条，不影响其它；
 * - 不抛异常：脏数据不该让首页白屏。
 */
export function normalizeLibrary(raw: unknown): Library {
  if (!isPlainObject(raw)) return emptyLibrary();
  if (!Array.isArray(raw.pins) || !Array.isArray(raw.collections)) return emptyLibrary();

  const pins = cleanIdList(raw.pins);

  const seenIds = new Set<string>();
  const collections: Collection[] = [];
  for (const item of raw.collections) {
    if (!isPlainObject(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!id || !name) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    collections.push({
      id,
      name: name.slice(0, MAX_COLLECTION_NAME),
      recordIds: cleanIdList(item.recordIds),
      createdAt: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0,
    });
  }

  return { pins, collections };
}

/** 读库；无数据 / 脏数据都返回空库（不写回） */
export async function loadLibrary(): Promise<Library> {
  const row = await getSetting(LIBRARY_SETTING_KEY);
  if (!row) return emptyLibrary();
  return normalizeLibrary(row.value);
}

/** 写库（内部用；所有写操作最终都走这里） */
export async function saveLibrary(library: Library): Promise<Library> {
  const value = normalizeLibrary(library);
  await putSetting({ key: LIBRARY_SETTING_KEY, value, updatedAt: Date.now() });
  return value;
}

function requireCollection(library: Library, collectionId: string): Collection {
  const collection = library.collections.find((item) => item.id === collectionId);
  if (!collection) throw new LibraryError('NOT_FOUND', '合集不存在或已被删除');
  return collection;
}

function normalizeName(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new LibraryError('INVALID_NAME', '合集名不能为空');
  return trimmed.slice(0, MAX_COLLECTION_NAME);
}

function newId(): string {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }
  return `col_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 置顶 / 取消置顶（边界 1：重复置顶不产生重复项） */
export async function setPinned(recordId: string, pinned: boolean): Promise<Library> {
  const id = typeof recordId === 'string' ? recordId.trim() : '';
  if (!id) throw new LibraryError('INVALID_RECORD', '记录 id 不能为空');

  const library = await loadLibrary();
  const without = library.pins.filter((item) => item !== id);
  const pins = pinned ? [...without, id] : without;
  return saveLibrary({ ...library, pins });
}

/** 新建合集（边界 3：空名拒绝，重名允许） */
export async function createCollection(name: string, createdAt = Date.now()): Promise<Library> {
  const clean = normalizeName(name);
  const library = await loadLibrary();
  const collection: Collection = { id: newId(), name: clean, recordIds: [], createdAt };
  return saveLibrary({ ...library, collections: [...library.collections, collection] });
}

export async function renameCollection(id: string, name: string): Promise<Library> {
  const clean = normalizeName(name);
  const library = await loadLibrary();
  requireCollection(library, id);
  return saveLibrary({
    ...library,
    collections: library.collections.map((item) => (item.id === id ? { ...item, name: clean } : item)),
  });
}

/** 删除合集：只删分组，不动记录本体 */
export async function deleteCollection(id: string): Promise<Library> {
  const library = await loadLibrary();
  requireCollection(library, id);
  return saveLibrary({ ...library, collections: library.collections.filter((item) => item.id !== id) });
}

/** 加入合集（边界 2：同一合集加入两次不产生重复项） */
export async function addToCollection(collectionId: string, recordId: string): Promise<Library> {
  const library = await loadLibrary();
  const collection = requireCollection(library, collectionId);
  if (collection.recordIds.includes(recordId)) return library;
  return saveLibrary({
    ...library,
    collections: library.collections.map((item) =>
      item.id === collectionId ? { ...item, recordIds: [...item.recordIds, recordId] } : item,
    ),
  });
}

export async function removeFromCollection(collectionId: string, recordId: string): Promise<Library> {
  const library = await loadLibrary();
  const collection = requireCollection(library, collectionId);
  if (!collection.recordIds.includes(recordId)) return library;
  return saveLibrary({
    ...library,
    collections: library.collections.map((item) =>
      item.id === collectionId
        ? { ...item, recordIds: item.recordIds.filter((rid) => rid !== recordId) }
        : item,
    ),
  });
}

/**
 * 合集内重排：把 fromIndex 的项移动到 toIndex。
 *
 * 边界 4：索引不是整数 / 越界 / from === to → **原样返回**，不写库、不抛异常
 * （拖拽时指针可能落在卡片缝隙里，这里必须是哑的）。
 */
export async function reorderCollection(
  collectionId: string,
  fromIndex: number,
  toIndex: number,
): Promise<Library> {
  const library = await loadLibrary();
  const collection = requireCollection(library, collectionId);
  const length = collection.recordIds.length;

  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return library;
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= length || toIndex >= length) return library;
  if (fromIndex === toIndex) return library;

  const next = [...collection.recordIds];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);

  return saveLibrary({
    ...library,
    collections: library.collections.map((item) =>
      item.id === collectionId ? { ...item, recordIds: next } : item,
    ),
  });
}

/**
 * 清理悬空 id（边界 5）：记录被删后，pins / recordIds 里残留的 id 要清掉。
 * 空合集**保留**（用户建的分组是他的组织方式，不因为清空而消失）。
 */
export async function pruneDangling(validIds: Set<string>): Promise<Library> {
  const library = await loadLibrary();
  const keep = (id: string) => validIds.has(id);

  const pins = library.pins.filter(keep);
  const collections = library.collections.map((item) => {
    const recordIds = item.recordIds.filter(keep);
    return recordIds.length === item.recordIds.length ? item : { ...item, recordIds };
  });

  const pinsChanged = pins.length !== library.pins.length;
  const collectionsChanged = collections.some((item, index) => item !== library.collections[index]);
  if (!pinsChanged && !collectionsChanged) return library;

  return saveLibrary({ pins, collections });
}

/**
 * 便捷版 pruneDangling：只核对库里**被引用到的**那些 id（不是全表扫），
 * 首页挂载时调用。返回清理后的库（没变化时不写库）。
 */
export async function pruneMissing(): Promise<Library> {
  const library = await loadLibrary();
  const referenced = new Set<string>([
    ...library.pins,
    ...library.collections.flatMap((item) => item.recordIds),
  ]);
  if (referenced.size === 0) return library;

  const valid = new Set<string>();
  await Promise.all(
    Array.from(referenced).map(async (id) => {
      const row = await getRecord<RecordRow>('records', id);
      if (row) valid.add(id);
    }),
  );

  return pruneDangling(valid);
}

/** 查一条记录在哪些合集里（卡片 ⋯ 菜单的勾选状态） */
export function collectionsContaining(library: Library, recordId: string): string[] {
  return library.collections.filter((item) => item.recordIds.includes(recordId)).map((item) => item.id);
}

/** 合集在不在库里（UI 判断选中态是否失效） */
export function findCollection(library: Library, id: string | null): Collection | null {
  if (!id) return null;
  return library.collections.find((item) => item.id === id) ?? null;
}
