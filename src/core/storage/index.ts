/**
 * IndexedDB 适配层（M1 手写实现 → M2 换成 Dexie，对外 API 签名不变）
 *
 * 职责边界：
 * - 只负责"把数据可靠地写进本地库 / 读出来 / 报清楚错"，不含业务规则
 *   （标签规范化、搜索、分页等属于 `core/records` 与 `storage/queries`）。
 * - 对外暴露 CRUD、配额查询、导入导出（导出结果是普通对象，zip 打包由 `core/backup` 负责）。
 *
 * 保留的 M1 防御点：
 * - 写入前主动查配额，空间不够时抛可识别的 `StorageQuotaError`，绝不让数据静默丢失；
 * - Blob（音频/视频）按 size 计费，且会递归进嵌套对象（修掉 M1 报告里的第 6 个坑）；
 * - 打开失败 / 事务失败统一翻译成 `StorageError`。
 *
 * M2 的变化只在内部：事务换 Dexie 管理，表结构见 `db.ts`。
 */
import Dexie, { type Table } from 'dexie';
import { STORE_NAMES, StorageError, StorageQuotaError } from './types';
import type { StorageRecord, StoreName } from './types';
import { DB_NAME, closeDatabaseInstance, getDatabase } from './db';
import type { RowLike, SettingsRow } from './db';

/** 预留安全余量：配额的 2%，但不少于 512KB，避免写到"差一点就满"然后浏览器事务失败 */
const QUOTA_RESERVE_RATIO = 0.02;
const QUOTA_RESERVE_MIN_BYTES = 512 * 1024;

const EXPORT_FORMAT = 'inspiration-assistant-export';
const EXPORT_VERSION = 1;

export interface QuotaSnapshot {
  /** 已用字节 */
  usage: number;
  /** 配额上限字节 */
  quota: number;
  /** 剩余可用字节 */
  available: number;
  /** 已用百分比（0–100） */
  percentUsed: number;
}

/**
 * 通用导出产物：普通对象，直接 JSON.stringify 即可。
 * media 里的 Blob 在这里是"原样取出"，序列化成文件由 `core/backup` 的 zip 导出负责。
 */
export interface ExportBundle {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  stores: Record<StoreName, unknown[]>;
}

export interface ImportOptions {
  /** merge（默认）按主键覆盖写入；replace 先清空目标仓库再写入 */
  mode?: 'merge' | 'replace';
}

export interface ImportResult {
  imported: number;
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

/** 按逻辑仓库名取 Dexie 表，并把泛型收敛成 RowLike（单处断言，避免每个调用点都 as） */
function tableFor(store: StoreName): Table<RowLike, string> {
  const db = getDatabase();
  const table = { records: db.records, settings: db.settings, media: db.media }[store];
  return table as unknown as Table<RowLike, string>;
}

/** 把底层异常翻译成可识别错误（配额类单独归类） */
export function toStorageError(error: unknown): StorageError {
  return translateError(error);
}

/** 把底层异常翻译成可识别错误（配额类单独归类） */
function translateError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;

  const name = (error as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return new StorageQuotaError(
      '本地存储空间不足，浏览器拒绝了这次写入，请清理数据或导出备份后重试',
    );
  }
  if (name === 'DataError' || name === 'SchemaError') {
    return new StorageError('INVALID_PAYLOAD', '写入的数据结构不合法，无法存入本地库', error);
  }
  if (name === 'MissingAPIError' || name === 'InvalidStateError') {
    return new StorageError('UNAVAILABLE', '当前浏览器环境不支持该存储操作', error);
  }
  return new StorageError('DB_ERROR', '本地数据库操作失败', error);
}

/**
 * 校验并补齐主键。
 * - records / media：必须有非空字符串 id（沿用 M1 的约定）；
 * - settings：主键是 key；为了让 M1 里以 `{ id: 'app' }` 写设置的旧调用继续可用，
 *   缺少 key 时用 id 兜底补一个（不改调用方数据，只在落库副本上加字段）。
 */
function prepareRow(store: StoreName, value: unknown): RowLike {
  if (typeof value !== 'object' || value === null) {
    throw new StorageError('INVALID_PAYLOAD', '写入的数据必须是非空对象');
  }

  const candidate = value as { id?: unknown; key?: unknown };

  if (store === 'settings') {
    if (typeof candidate.key === 'string' && candidate.key.length > 0) return value as RowLike;
    if (typeof candidate.id === 'string' && candidate.id.length > 0) {
      return { ...(value as RowLike), key: candidate.id };
    }
    throw new StorageError('INVALID_PAYLOAD', '写入 settings 的数据必须带有非空字符串 key');
  }

  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    throw new StorageError('INVALID_PAYLOAD', '写入的数据必须是非空对象，且带有非空字符串 id');
  }
  return value as RowLike;
}

/**
 * 估算一条数据占用的字节数。
 * - Blob 用 size（最准）；
 * - 字符串按 UTF-8 长度；
 * - 数组 / 普通对象递归求和（M1 只对顶层 Blob 精确，嵌套 Blob 会被 JSON.stringify 成 `{}`）；
 * - 其它标量按 8 字节粗估。
 */
export function estimateValueSize(value: unknown): number {
  if (typeof value === 'undefined' || value === null) return 0;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value === 'string') return new TextEncoder().encode(value).length;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateValueSize(item), 0);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record).reduce(
      (sum, key) => sum + new TextEncoder().encode(key).length + estimateValueSize(record[key]),
      0,
    );
  }
  return 0;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** 写入前检查配额；环境不支持查询时不拦截，交由浏览器事务兜底 */
async function assertQuotaForWrite(incomingBytes: number): Promise<void> {
  const snapshot = await estimateQuota();
  if (!snapshot) return;

  const reserve = Math.max(snapshot.quota * QUOTA_RESERVE_RATIO, QUOTA_RESERVE_MIN_BYTES);
  if (snapshot.usage + incomingBytes + reserve > snapshot.quota) {
    throw new StorageQuotaError(
      `本地存储空间不足：已用 ${formatBytes(snapshot.usage)} / 上限 ${formatBytes(
        snapshot.quota,
      )}，本次需要 ${formatBytes(incomingBytes)}`,
      snapshot.usage,
      snapshot.quota,
    );
  }
}

/* ------------------------------------------------------------------ */
/* CRUD                                                               */
/* ------------------------------------------------------------------ */

/** 新增或覆盖一条记录（按主键覆盖） */
export async function putRecord<T extends StorageRecord>(store: StoreName, value: T): Promise<T> {
  const row = prepareRow(store, value);
  await assertQuotaForWrite(estimateValueSize(row));

  try {
    await tableFor(store).put(row);
    return value;
  } catch (error) {
    throw translateError(error);
  }
}

/** 按主键读取一条记录，不存在返回 undefined */
export async function getRecord<T extends StorageRecord>(
  store: StoreName,
  id: string,
): Promise<T | undefined> {
  try {
    return (await tableFor(store).get(id)) as T | undefined;
  } catch (error) {
    throw translateError(error);
  }
}

/** 读取某个仓库的全部记录（按主键升序；业务排序请用 `queries.ts` 的索引查询） */
export async function getAllRecords<T extends StorageRecord>(store: StoreName): Promise<T[]> {
  try {
    return (await tableFor(store).toArray()) as unknown as T[];
  } catch (error) {
    throw translateError(error);
  }
}

/* ------------------------------------------------------------------ */
/* settings 专用（主键是 key，不满足 StorageRecord 的 id 约束）         */
/* ------------------------------------------------------------------ */

/** 读一条设置项（key 为主键） */
export async function getSetting(key: string): Promise<SettingsRow | undefined> {
  try {
    return (await tableFor('settings').get(key)) as SettingsRow | undefined;
  } catch (error) {
    throw translateError(error);
  }
}

/** 写一条设置项（同样走配额预检） */
export async function putSetting(row: SettingsRow): Promise<SettingsRow> {
  const prepared = prepareRow('settings', row);
  await assertQuotaForWrite(estimateValueSize(prepared));
  try {
    await tableFor('settings').put(prepared);
    return row;
  } catch (error) {
    throw translateError(error);
  }
}

/** 按主键删除一条记录（不存在时静默成功，符合幂等语义） */
export async function deleteRecord(store: StoreName, id: string): Promise<void> {
  try {
    await tableFor(store).delete(id);
  } catch (error) {
    throw translateError(error);
  }
}

/** 清空某个仓库 */
export async function clearStore(store: StoreName): Promise<void> {
  try {
    await tableFor(store).clear();
  } catch (error) {
    throw translateError(error);
  }
}

/* ------------------------------------------------------------------ */
/* 配额                                                               */
/* ------------------------------------------------------------------ */

/**
 * 查询配额。返回 null 表示当前环境无法查询（例如 jsdom、老浏览器），
 * 调用方应把它当作"未知"处理，而不是"没有空间"。
 */
export async function estimateQuota(): Promise<QuotaSnapshot | null> {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!storage || typeof storage.estimate !== 'function') return null;

  try {
    const { usage = 0, quota = 0 } = await storage.estimate();
    if (!quota || quota <= 0) return null;
    return {
      usage,
      quota,
      available: Math.max(quota - usage, 0),
      percentUsed: (usage / quota) * 100,
    };
  } catch {
    // 查询失败不影响主流程，视为未知
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 导入导出（纯数据，不含压缩逻辑）                                    */
/* ------------------------------------------------------------------ */

/**
 * 导出全部数据为普通对象。
 * 注意：media 仓库里的 Blob 不能直接 JSON 序列化，zip 导出（`core/backup`）会单独按二进制处理；
 * 这里保持"原样取出"，不在存储层做格式转换。
 */
export async function exportData(): Promise<ExportBundle> {
  const stores = {} as Record<StoreName, unknown[]>;
  for (const name of STORE_NAMES) {
    stores[name] = await getAllRecords(name);
  }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    stores,
  };
}

function assertBundle(bundle: unknown): asserts bundle is ExportBundle {
  const candidate = bundle as Partial<ExportBundle> | null;
  if (!candidate || typeof candidate !== 'object') {
    throw new StorageError('INVALID_PAYLOAD', '导入内容不是合法的 JSON 对象');
  }
  if (candidate.format !== EXPORT_FORMAT) {
    throw new StorageError('INVALID_PAYLOAD', `导入内容格式不符，缺少 ${EXPORT_FORMAT} 标识`);
  }
  if (typeof candidate.version !== 'number' || candidate.version > EXPORT_VERSION) {
    throw new StorageError('INVALID_PAYLOAD', '导入文件来自更新版本的应用，请先升级后再导入');
  }
  if (!candidate.stores || typeof candidate.stores !== 'object') {
    throw new StorageError('INVALID_PAYLOAD', '导入内容缺少 stores 字段');
  }
}

/**
 * 导入数据。
 * - mode=merge：按主键覆盖写入，不动其它记录
 * - mode=replace：先清空对应仓库再写入
 * 三个仓库放在同一个 Dexie 事务里，避免导入一半失败留下半截数据。
 */
export async function importData(
  bundle: unknown,
  options: ImportOptions = {},
): Promise<ImportResult> {
  assertBundle(bundle);
  const mode = options.mode ?? 'merge';
  const db = getDatabase();

  // 先校验全部内容再动库：校验期间不改任何状态
  const groups: Array<{ store: StoreName; rows: RowLike[] }> = [];
  for (const name of STORE_NAMES) {
    const items = bundle.stores[name];
    if (items === undefined) continue;
    if (!Array.isArray(items)) {
      throw new StorageError('INVALID_PAYLOAD', `导入内容中 ${name} 不是数组`);
    }
    groups.push({ store: name, rows: items.map((item) => prepareRow(name, item)) });
  }

  const incomingBytes = groups.reduce(
    (sum, group) => sum + group.rows.reduce((inner, row) => inner + estimateValueSize(row), 0),
    0,
  );
  await assertQuotaForWrite(incomingBytes);

  let imported = 0;
  try {
    await db.transaction('rw', db.records, db.settings, db.media, async () => {
      for (const group of groups) {
        const table = tableFor(group.store);
        if (mode === 'replace') await table.clear();
        if (group.rows.length > 0) await table.bulkPut(group.rows);
        imported += group.rows.length;
      }
    });
  } catch (error) {
    throw translateError(error);
  }

  return { imported };
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

/** 关闭连接（切换用户 / 测试清理时用） */
export async function closeDatabase(): Promise<void> {
  closeDatabaseInstance();
}

/** 彻底删除本地库（"清空所有数据"用；不可恢复） */
export async function destroyDatabase(): Promise<void> {
  closeDatabaseInstance();
  if (typeof indexedDB === 'undefined') return;

  try {
    await Dexie.delete(DB_NAME);
  } catch (error) {
    throw translateError(error);
  }
}
