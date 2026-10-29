/**
 * 记录业务逻辑（M2）：CRUD、标签、录音关联、列表查询。
 *
 * 关键设计：
 * 1. **音频不进 records 表**：records 行只存 `{ mediaId, mimeType, durationMs }`，
 *    二进制放 media 表。列表页只读 records 行，不会把几十 MB 音频读进内存；
 *    zip 导出时 records.json 也因此天然"不含音频二进制"。
 * 2. **一条记录一条音轨**（media.id === recordId）：契约里 audio 是单数，
 *    这样级联删除、导出命名 media/<recordId>.<ext> 都无需额外映射。
 * 3. **删记录级联删音频**：走 media 表的 recordId 索引，不依赖 id 是否相同。
 */
import { deleteRecord, getRecord, putRecord } from '../storage';
import { getDatabase } from '../storage/db';
import type { MediaRow, RecordAudioRef, RecordRow } from '../storage/db';
import { listTags as listTagCounts, queryRecords, queryRecordsByIds, queryRecordsInOrder } from '../storage/queries';
import { DEFAULT_RECORD_ROLE, normalizeRole, normalizeSourceIds } from './meta';
import { RecordError } from './types';
import type {
  ListRecordsOptions,
  ListRecordsResult,
  RecordAudio,
  RecordEntity,
  RecordInput,
  RecordRole,
  RecordSummary,
} from './types';

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 30;

/** 生成记录 id；jsdom / 老浏览器没有 crypto.randomUUID 时降级 */
export function createRecordId(): string {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }
  const random = () => Math.random().toString(36).slice(2, 10);
  return `rec_${Date.now().toString(36)}_${random()}${random()}`;
}

/** 标签规范化：支持逗号/中文逗号/顿号分隔的字符串，去空白、去 #、去重、限长 */
export function normalizeTags(input: string[] | string | undefined): string[] {
  if (input === undefined) return [];
  const raw = Array.isArray(input) ? input : input.split(/[,，、]/);

  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().replace(/^#+/, '').trim().slice(0, MAX_TAG_LENGTH);
    if (!tag || result.includes(tag)) continue;
    result.push(tag);
    if (result.length >= MAX_TAGS) break;
  }
  return result;
}

export function normalizeText(input: string | undefined): string {
  return typeof input === 'string' ? input.trim() : '';
}

/* ------------------------------------------------------------------ */
/* 音频（media 表）                                                    */
/* ------------------------------------------------------------------ */

async function saveAudio(recordId: string, audio: RecordAudio): Promise<RecordAudioRef> {
  const row: MediaRow = {
    id: recordId,
    recordId,
    blob: audio.blob,
    mimeType: audio.mimeType || 'application/octet-stream',
    durationMs: Math.max(0, Math.round(audio.durationMs)),
    createdAt: Date.now(),
  };
  // 走通用 CRUD，写入前的配额预检一并生效（Blob 按 size 计费）
  await putRecord('media', row);
  return { mediaId: row.id, mimeType: row.mimeType, durationMs: row.durationMs };
}

async function deleteAudio(recordId: string): Promise<void> {
  await getDatabase().media.where('recordId').equals(recordId).delete();
}

/** 读取一条记录的音轨（详情页回放用） */
export async function getRecordAudio(recordId: string): Promise<RecordAudio | undefined> {
  const media = await getDatabase().media.where('recordId').equals(recordId).first();
  if (!media) return undefined;
  return { blob: media.blob, mimeType: media.mimeType, durationMs: media.durationMs };
}

/* ------------------------------------------------------------------ */
/* 实体拼装                                                            */
/* ------------------------------------------------------------------ */

async function hydrate(row: RecordRow): Promise<RecordEntity> {
  const entity: RecordEntity = {
    id: row.id,
    text: row.text ?? '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.emotion) entity.emotion = row.emotion;
  if (row.hasAIResult === true) entity.hasAIResult = true;
  applyMeta(entity, row);
  if (!row.audio) return entity;

  const audio = await getRecordAudio(row.id);
  if (!audio) {
    // media 行丢失（手动删库/导入异常）：不假装有音频，避免播放时崩
    return entity;
  }
  return { ...entity, audio };
}

/**
 * P5：把两个新字段从行搬到对外对象上。
 *
 * 两条纪律：
 * 1. **只在非默认值时才写字段** —— 笔记、无来源的记录身上不会多出 `role: 'note'` /
 *    `sourceIds: []`，既有的 `toEqual` 断言与备份 JSON 因此一字不变；
 * 2. 一律过 `normalizeRole` / `normalizeSourceIds` —— 旧行没有字段、脏行有非法值，
 *    读出来都是合法形态。
 */
function applyMeta<T extends { role?: RecordRole; sourceIds?: string[] }>(
  target: T,
  row: RecordRow,
): T {
  const role = normalizeRole(row.role);
  if (role !== DEFAULT_RECORD_ROLE) target.role = role;
  const sourceIds = normalizeSourceIds(row.sourceIds);
  if (sourceIds.length > 0) target.sourceIds = sourceIds;
  return target;
}

/** 行 + 可选音频 → 对外实体（显式构造，避免把 row 的 audioRef 误当成 RecordAudio 逃过类型检查） */
function toEntity(row: RecordRow, audio?: RecordAudio): RecordEntity {
  const entity: RecordEntity = {
    id: row.id,
    text: row.text ?? '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.emotion) entity.emotion = row.emotion;
  if (row.hasAIResult === true) entity.hasAIResult = true;
  applyMeta(entity, row);
  if (audio) entity.audio = audio;
  return entity;
}

function toSummary(row: RecordRow): RecordSummary {
  const summary: RecordSummary = {
    id: row.id,
    text: row.text ?? '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasAudio: Boolean(row.audio),
  };
  if (row.audio) {
    summary.audioDurationMs = row.audio.durationMs;
    summary.audioMimeType = row.audio.mimeType;
  }
  if (row.emotion) summary.emotion = row.emotion;
  if (row.hasAIResult === true) summary.hasAIResult = true;
  return applyMeta(summary, row);
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

/** 新建记录：至少要有文字或录音之一，否则拒绝（避免空记录污染列表） */
export async function createRecord(input: RecordInput = {}): Promise<RecordEntity> {
  const text = normalizeText(input.text);
  const tags = normalizeTags(input.tags);
  const audio = input.audio ?? null;

  if (!text && !audio) {
    throw new RecordError('VALIDATION', '记录至少需要文字或录音');
  }

  const id = createRecordId();
  const now = Date.now();
  const audioRef = audio ? await saveAudio(id, audio) : undefined;

  const row: RecordRow = { id, text, tags, createdAt: now, updatedAt: now };
  if (audioRef) row.audio = audioRef;
  applyRowMeta(row, input);

  try {
    await putRecord('records', row);
  } catch (error) {
    // 记录没写进去就别留孤儿音频（配额不足 / 浏览器事务失败都会走到这里）
    if (audioRef) await deleteAudio(id).catch(() => undefined);
    throw error;
  }

  return audio ? toEntity(row, audio) : toEntity(row);
}

/**
 * P5：把入参里的 `role` / `sourceIds` 归一后写进行。
 *
 * **默认值不落库**（笔记 / 无来源不写字段）：records 行保持精简，旧断言与备份 JSON 不变；
 * 读的时候 `applyMeta` 会把「没有字段」解释成笔记。
 */
function applyRowMeta(row: RecordRow, input: RecordInput): void {
  const role = normalizeRole(input.role);
  if (role !== DEFAULT_RECORD_ROLE) row.role = role;
  const sourceIds = normalizeSourceIds(input.sourceIds);
  if (sourceIds.length > 0) row.sourceIds = sourceIds;
}

/**
 * 更新记录。
 * - `audio` 不传 = 不动音频；传 null = 删音频；传对象 = 覆盖音频。
 */
export async function updateRecord(id: string, patch: RecordInput): Promise<RecordEntity> {
  const existing = await getRecord<RecordRow>('records', id);
  if (!existing) throw new RecordError('NOT_FOUND', '记录不存在或已被删除');

  const text = patch.text === undefined ? existing.text : normalizeText(patch.text);
  const tags = patch.tags === undefined ? existing.tags : normalizeTags(patch.tags);

  let audioRef: RecordAudioRef | undefined = existing.audio;
  let audio: RecordAudio | undefined;

  if (patch.audio === null) {
    await deleteAudio(id);
    audioRef = undefined;
  } else if (patch.audio) {
    audioRef = await saveAudio(id, patch.audio);
    audio = patch.audio;
  } else {
    audio = await getRecordAudio(id);
  }

  if (!text && !audioRef) {
    throw new RecordError('VALIDATION', '记录至少需要文字或录音，不能把两者都清空');
  }

  const row: RecordRow = {
    id,
    text,
    tags,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  if (audioRef) row.audio = audioRef;
  /*
   * P5：改正文**不能把成品变回笔记**。
   *
   * 这一行是必须的：`row` 是重新构造的，如果不把 existing 上的 `role` / `sourceIds`
   * 搬过来，「编辑成品正文」这一步就会静默丢掉「成品」身份与来源血缘 —— 数据丢失里
   * 最讨厌的一种（用户什么都没做错）。
   * 入参显式给了就以入参为准（`applyRowMeta` 只写非默认值）。
   */
  const inherited: RecordInput = {
    role: patch.role ?? normalizeRole(existing.role),
    sourceIds: patch.sourceIds ?? normalizeSourceIds(existing.sourceIds),
  };
  applyRowMeta(row, inherited);

  await putRecord('records', row);

  if (audio) return toEntity(row, audio);
  return toEntity(row);
}

/** 读一条记录的完整实体（含音频 Blob） */
export async function getRecordEntity(id: string): Promise<RecordEntity | undefined> {
  const row = await getRecord<RecordRow>('records', id);
  if (!row) return undefined;
  return hydrate(row);
}

/** 删除记录，并级联删除它的音频 */
export async function removeRecord(id: string): Promise<void> {
  await deleteAudio(id);
  await deleteRecord('records', id);
}

/** 分页 + 标签筛选 + 搜索的列表查询 */
export async function listRecords(options: ListRecordsOptions = {}): Promise<ListRecordsResult> {
  const result = await queryRecords(options);
  return {
    items: result.items.map(toSummary),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    pageCount: result.pageCount,
  };
}

/** 标签云（含使用次数） */
export function listAllTags(): Promise<Array<{ tag: string; count: number }>> {
  return listTagCounts();
}

/* ------------------------------------------------------------------ */
/* P2b：置顶区 / 合集视图的查询（新增函数，不动上面既有函数）           */
/* ------------------------------------------------------------------ */

/**
 * 按给定 id 顺序取摘要（置顶区用）。
 *
 * 顺序 = 传入 ids 的顺序（= `library.pins` 的顺序 = 置顶先后），
 * 悬空 id 自动跳过 —— 删掉一条置顶记录后置顶区不会空转，也不会报错。
 */
export async function listRecordsByIds(
  ids: string[],
  options: { tag?: string; search?: string } = {},
): Promise<RecordSummary[]> {
  const rows = await queryRecordsByIds(ids, options);
  return rows.map(toSummary);
}

/** 合集视图的分页查询：先合集（ids 顺序）→ 再标签 → 再搜索 → 再分页 */
export async function listRecordsInOrder(
  ids: string[],
  options: ListRecordsOptions = {},
): Promise<ListRecordsResult> {
  const result = await queryRecordsInOrder(ids, options);
  return {
    items: result.items.map(toSummary),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    pageCount: result.pageCount,
  };
}

/* ------------------------------------------------------------------ */
/* P5：复制素材 / 角色统计（新增函数，不动上面任何既有函数）             */
/* ------------------------------------------------------------------ */

/**
 * 复制一条记录（左栏素材项 hover 的「复制」）。
 *
 * 语义（任务书 §5）：
 * - 新记录的 `text` / `tags` 与原记录**相同**；
 * - `role` 固定 `'note'`（副本是"我写的"，不是成品 —— 否则列表里会多一个没意义的「成品」角标）；
 * - `sourceIds: [原记录 id]` 保留血缘，日后能看到「这条是从哪条抄出来的」；
 * - **原记录一个字都不改**：只读不写。
 *
 * 音频不复制（`audio` 不进 `RecordInput`）：副本是"拿这段文字去做别的事"，
 * 把几十 MB 的音频再存一份既费空间又容易让用户以为是两条独立录音。
 */
export async function duplicateRecord(id: string): Promise<RecordEntity> {
  const existing = await getRecord<RecordRow>('records', id);
  if (!existing) throw new RecordError('NOT_FOUND', '记录不存在或已被删除，复制不了');

  const text = normalizeText(existing.text);
  if (!text) {
    throw new RecordError('VALIDATION', '这条记录没有文字（只有录音），没有可复制的内容');
  }

  return createRecord({
    text,
    tags: Array.isArray(existing.tags) ? existing.tags : [],
    role: 'note',
    sourceIds: [existing.id],
  });
}

export interface RecordRoleCounts {
  /** 全部记录数 */
  all: number;
  /** 我写的 = note + draft */
  mine: number;
  /** AI 产出 = asset */
  ai: number;
}

/**
 * 按角色统计条数（左侧素材区三段筛选 chip 上的数字）。
 *
 * **内存扫一遍全表**：这一轮明确不建 `role` 索引（不升 Dexie 版本），
 * 几千条记录的 `toArray()` 在个人使用规模下是毫秒级；等真的数据量大到卡了再加索引。
 * 也正因为不建索引，这个数字是「全库口径」，与列表当前只取 200 条（`MATERIAL_PAGE_SIZE`）
 * 无关 —— chip 上写的是"库里有多少"，不是"这一页有多少"。
 */
export async function countRecordsByRole(): Promise<RecordRoleCounts> {
  const rows = await getDatabase().records.toArray();
  let ai = 0;
  for (const row of rows) {
    if (normalizeRole(row.role) === 'asset') ai += 1;
  }
  return { all: rows.length, mine: rows.length - ai, ai };
}
