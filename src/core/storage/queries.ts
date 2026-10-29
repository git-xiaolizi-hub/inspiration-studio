/**
 * 记录专用索引查询（M2）。
 *
 * 为什么要单独一层：M1 的通用 `getAllRecords()` 只能整表读，做不了
 * "标签筛选 + 时间倒序 + 分页"。这里直接用 Dexie 的索引：
 *
 * - 不带标签、不搜索：`orderBy('createdAt').reverse()` → 索引天然有序，
 *   `offset/limit` 只读当前页，翻到第 50 页也不会把前面的数据读进内存。
 * - 标签筛选：走 `*tags` 多值索引 `where('tags').equals(tag)` 定位候选集；
 *   **注意** IndexedDB 不支持"多值 + 复合"索引，无法让索引同时满足标签与 createdAt 排序，
 *   所以候选集取出后在内存里按 createdAt 倒序排（候选集 = 单个标签的记录数，个人使用规模下可接受）。
 * - 搜索：全文子串匹配没有索引可用（IndexedDB 没有全文索引），只能过滤后排序；
 *   在 M4/M5 数据量大到卡顿时再引入倒排/前缀索引。
 */
import { getDatabase } from './db';
import type { RecordRow } from './db';

export const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

export interface RecordQueryOptions {
  /** 标签精确匹配（多值索引） */
  tag?: string;
  /** 全文子串搜索：匹配正文与标签，忽略大小写 */
  search?: string;
  /** 1 起的页码 */
  page?: number;
  /** 每页条数，默认 20，上限 200 */
  pageSize?: number;
  /**
   * P2b：排除这些 id（首页「全部」区要把已置顶的移出去，避免与置顶区重复）。
   *
   * 这是**新增的可选字段**，既有调用方不传时行为逐字不变。
   * 有排除项时走内存路径（先取候选集再过滤再分页）——置顶通常只有个位数，
   * 而「排除后仍要正确分页/计数」必须知道全集，不能像快路径那样只读当前页。
   */
  excludeIds?: string[];
}

export interface RecordQueryResult {
  items: RecordRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** 时间倒序；createdAt 相同时按 id 稳定排序，保证分页不会跳条目 */
function compareByCreatedAtDesc(a: RecordRow, b: RecordRow): number {
  if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
  return a.id.localeCompare(b.id);
}

function matchesSearch(row: RecordRow, needle: string): boolean {
  if (typeof row.text === 'string' && row.text.toLowerCase().includes(needle)) return true;
  return Array.isArray(row.tags) && row.tags.some((tag) => tag.toLowerCase().includes(needle));
}

/** 多值索引在极端情况下可能对同一主键返回重复项（同一记录重复放了同名标签），这里兜底去重 */
function dedupeById(rows: RecordRow[]): RecordRow[] {
  const seen = new Set<string>();
  const result: RecordRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    result.push(row);
  }
  return result;
}

/**
 * 分页查询记录。
 * 返回的 total / pageCount 是"当前筛选条件下的总数"，UI 用它们算页码。
 */
export async function queryRecords(options: RecordQueryOptions = {}): Promise<RecordQueryResult> {
  const pageSize = clampInt(options.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const requestedPage = clampInt(options.page, 1, Number.MAX_SAFE_INTEGER, 1);
  const tag = options.tag?.trim() ?? '';
  const search = options.search?.trim().toLowerCase() ?? '';

  const db = getDatabase();
  const excluded = new Set((options.excludeIds ?? []).filter((id) => typeof id === 'string' && id !== ''));

  let rows: RecordRow[];
  let total: number;

  if (!tag && !search && excluded.size === 0) {
    // 快路径：完全交给 createdAt 索引做排序与分页
    const collection = db.records.orderBy('createdAt').reverse();
    total = await collection.count();
    const pageCount = Math.ceil(total / pageSize);
    const page = total === 0 ? 1 : Math.min(requestedPage, Math.max(pageCount, 1));
    const offset = (page - 1) * pageSize;
    rows = await collection.offset(offset).limit(pageSize).toArray();
    return { items: rows, total, page, pageSize, pageCount };
  }

  // 慢路径：先按标签走多值索引缩小候选集，再（可选）排除项、过滤搜索词，最后内存排序
  const base = tag ? db.records.where('tags').equals(tag) : db.records.toCollection();
  const candidates = dedupeById(await base.toArray());
  const visible = excluded.size > 0 ? candidates.filter((row) => !excluded.has(row.id)) : candidates;
  const filtered = search ? visible.filter((row) => matchesSearch(row, search)) : visible;
  filtered.sort(compareByCreatedAtDesc);

  total = filtered.length;
  const pageCount = Math.ceil(total / pageSize);
  const page = total === 0 ? 1 : Math.min(requestedPage, Math.max(pageCount, 1));
  const offset = (page - 1) * pageSize;
  rows = filtered.slice(offset, offset + pageSize);

  return { items: rows, total, page, pageSize, pageCount };
}

/** 标签云：列出全部标签与使用次数（走多值索引的 uniqueKeys，不整表读行） */
export async function listTags(): Promise<TagCount[]> {
  const db = getDatabase();
  const tags = (await db.records.orderBy('tags').uniqueKeys()) as unknown as string[];

  const result: TagCount[] = [];
  for (const tag of tags) {
    const count = await db.records.where('tags').equals(tag).count();
    result.push({ tag, count });
  }
  return result.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** 记录总数（设置页/用量展示用，索引计数不读行） */
export async function countRecords(): Promise<number> {
  return getDatabase().records.count();
}

/**
 * 统计 createdAt >= since 的记录数（P0.5「今天 N 条」）。
 *
 * 走 `createdAt` 索引（`db.ts` 的 `records: 'id, createdAt, *tags'`），
 * `where(...).aboveOrEqual(...).count()` 只数索引项、不把行读进内存，也不开游标遍历全表。
 * 边界语义：**恰好等于 since 的算进去**（`since` 取当天 00:00:00.000 时，零点整写的那条属于今天）。
 */
export async function countSince(since: number): Promise<number> {
  if (!Number.isFinite(since)) return 0;
  return getDatabase().records.where('createdAt').aboveOrEqual(since).count();
}

/* ------------------------------------------------------------------ */
/* P2b：按给定 id 顺序取记录（合集视图用）                             */
/* ------------------------------------------------------------------ */

/**
 * 按 `ids` 的**顺序**取行（合集里 recordIds 的数组顺序就是显示顺序）。
 *
 * - 悬空 id（记录已被删）自动跳过，不报错 —— 这是「删了记录合集还能打开」的保证；
 * - 重复 id 只取一次（保持首次出现的位置）。
 *
 * 这是一个**新函数**：`queryRecords` 的既有签名与行为一字未改（任务书 §7 止损条）。
 */
export async function getRecordsByIds(ids: string[]): Promise<RecordRow[]> {
  const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id !== '')));
  if (unique.length === 0) return [];

  const rows = await getDatabase().records.bulkGet(unique);
  const byId = new Map<string, RecordRow>();
  for (const row of rows) {
    if (row) byId.set(row.id, row);
  }
  const result: RecordRow[] = [];
  for (const id of unique) {
    const row = byId.get(id);
    if (row) result.push(row);
  }
  return result;
}

export interface OrderedRecordOptions {
  /** 标签精确匹配 */
  tag?: string;
  /** 全文子串搜索（正文 + 标签，忽略大小写） */
  search?: string;
}

/**
 * 按 id 顺序取行，并按标签 / 搜索过滤（不分页）。
 *
 * 组合筛选的**前两步**（合集 → 标签 → 搜索）都在这里落地：顺序永远是
 * 「先按 recordIds 定位集合 → 再按标签筛 → 再按搜索词筛」，最后才轮到分页
 * （分页在 `queryRecordsInOrder` 里）。
 */
export async function queryRecordsByIds(
  ids: string[],
  options: OrderedRecordOptions = {},
): Promise<RecordRow[]> {
  const rows = await getRecordsByIds(ids);
  const tag = options.tag?.trim() ?? '';
  const search = options.search?.trim().toLowerCase() ?? '';

  return rows.filter((row) => {
    if (tag && !(Array.isArray(row.tags) && row.tags.includes(tag))) return false;
    if (search && !matchesSearch(row, search)) return false;
    return true;
  });
}

/**
 * 合集视图的分页查询：**先合集（ids 顺序）→ 再标签 → 再搜索 → 再分页**。
 *
 * 与 `queryRecords` 的区别：排序源不是 createdAt，而是调用方给的 `ids` 顺序
 * （= 拖拽后的顺序）；因此这里没有「快路径」，候选集就是合集里的那些行。
 */
export async function queryRecordsInOrder(
  ids: string[],
  options: OrderedRecordOptions & { page?: number; pageSize?: number } = {},
): Promise<RecordQueryResult> {
  const pageSize = clampInt(options.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const requestedPage = clampInt(options.page, 1, Number.MAX_SAFE_INTEGER, 1);

  const filtered = await queryRecordsByIds(ids, options);
  const total = filtered.length;
  const pageCount = Math.ceil(total / pageSize);
  const page = total === 0 ? 1 : Math.min(requestedPage, Math.max(pageCount, 1));
  const offset = (page - 1) * pageSize;

  return { items: filtered.slice(offset, offset + pageSize), total, page, pageSize, pageCount };
}
