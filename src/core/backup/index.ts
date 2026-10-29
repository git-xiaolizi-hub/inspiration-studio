/**
 * 备份：**一份 zip 装下全部**（M2 起做记录/音频，M5a 扩成完整备份）。
 *
 * 包结构（v2）：
 *   manifest.json    { format:"ia-v2-backup", version:2, exportedAt, app, containsKey, counts }
 *   records.json     记录（audio 只有元数据 + 文件名）
 *   media/<id>.<ext> 音频二进制本体（有音频才有）
 *   threads.json     解梦/灵感的会话线程（M5a3；真的有会话时才写）
 *   ai-catalog.json  AI 配置（厂商 / 连接 / 模型表；按 containsKey 决定是否含 key）
 *   settings.json    设置（voice、canvas-mode、canvas-positions、ai-spend…）
 *   price-table.json 价格表
 *
 * 为什么 M5a 要合并：原来「记录列表 → 备份」和「AI 配置 → 更多：导出/导入」是两个地方、
 * 两种文件，用户要自己记住"哪份备份漏了配置"。现在只有一个入口（设置 → 数据与备份）。
 *
 * 版本策略：
 * - v1 包（只有 manifest/records/media）**仍可导入**，缺的几类不动本机数据；
 * - `version > BACKUP_VERSION` → 报「备份来自更新版本」，**校验失败一律不写库**。
 *
 * 音频不走 base64（体积 +33%，几十 MB 会把 JSON.parse 拖爆），
 * 用户也能直接解压听；全程走文件（Blob + <a download> / <input type="file">），不碰剪贴板。
 */
import JSZip from 'jszip';
import { getDatabase } from '../storage/db';
import type {
  CustomPromptRow,
  MediaRow,
  RecordRow,
  SettingsRow,
  ThreadRow,
  TurnRow,
} from '../storage/db';
import { StorageError, StorageQuotaError } from '../storage/types';
import { toStorageError } from '../storage';
import { audioExtensionFor } from '../media/recorder';
import {
  AI_CATALOG_KEY,
  buildCatalogFile,
  loadCatalog,
  normalizeCatalog,
  parseCatalogFile,
} from '../../adapters/ai-models/catalog';
import type { AICatalog } from '../../adapters/ai-models/catalog';
import { AI_PRICE_TABLE_KEY, loadPriceTable } from '../../adapters/ai-models/config-store';
import type { PriceTable } from '../../adapters/ai-models/pricing';
import { hydrateCustomPrompts } from '../custom-prompts';
import { DEFAULT_RECORD_ROLE, normalizeRole, normalizeSourceIds } from '../records/meta';

export const BACKUP_FORMAT = 'ia-v2-backup';
/** v2：新增 ai-catalog / settings / price-table 三类条目（M5a 备份统一） */
export const BACKUP_VERSION = 2;
export const BACKUP_APP = 'Inspiration Assistant';

export const SETTINGS_FILE_FORMAT = 'ia-v2-settings';
export const PRICE_TABLE_FILE_FORMAT = 'ia-v2-price-table';
/** M5a3：解梦/灵感的会话线程（换设备后会话不该全丢 —— 这是数据丢失级 bug） */
export const THREADS_FILE_FORMAT = 'ia-v2-threads';
/** M5b4：自定义提示词副本（用户手写的正文，丢了就是数据丢失） */
export const CUSTOM_PROMPTS_FILE_FORMAT = 'ia-v2-custom-prompts';

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  app: string;
  /** 这份包里有没有 API Key（导入时要提示用户） */
  containsKey: boolean;
  counts: { records: number; media: number };
}

/** records.json 里的单条记录：audio 只有元数据 + 文件名，没有二进制 */
export interface BackupRecordEntry {
  id: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  audio?: { file: string; mimeType: string; durationMs: number };
  /** 卡片墙 chip / 角标的数据（有就带上，没有不写，保持 records.json 精简） */
  emotion?: string;
  hasAIResult?: boolean;
  /**
   * P5：来源血缘与角色。
   *
   * ⚠️ 任务书 §2.2 说「records 整体在 zip 内，两个字段自动带上，不需要改备份代码」——
   * **实测不成立**：导出是**白名单构造** `entry`（见 `exportBackupZip` 的 `for (const row of rows)`），
   * 不写进 `BackupRecordEntry` 的字段会被丢掉。所以这里加可选字段、导出/导入各补三行。
   * （若真按原判断不动，备份往返会静默把成品降级成笔记、来源全丢。）
   */
  sourceIds?: string[];
  role?: 'note' | 'draft' | 'asset';
}

export interface RecordsJson {
  format: typeof BACKUP_FORMAT;
  version: number;
  records: BackupRecordEntry[];
}

export interface SettingsJson {
  format: typeof SETTINGS_FILE_FORMAT;
  version: number;
  settings: Array<{ key: string; value: unknown; updatedAt?: number }>;
}

export interface PriceTableJson {
  format: typeof PRICE_TABLE_FILE_FORMAT;
  version: number;
  table: PriceTable;
}

/**
 * threads.json（M5a3）：会话线程整表。
 *
 * 为什么**不**并进 records.json：记录正文是用户手写的，线程是 AI 对话，
 * 两换代际不同（线程的 turns 里有 structured / error / tokens）；
 * 拆成一个文件后，老版本应用读到这份 zip 只是"多了一个不认识的条目"，不会崩。
 */
export interface ThreadsJson {
  format: typeof THREADS_FILE_FORMAT;
  version: number;
  threads: ThreadRow[];
}

/**
 * custom-prompts.json（M5b4）：自定义提示词副本整表。
 *
 * 为什么不并进 settings.json：settings 里的是"配置"（语音、画布模式），丢了可以重设；
 * 这里装的是**用户手写的正文**，语义上更接近 records.json。单独一个条目也让
 * 老版本应用读到它时只是"多了一个不认识的条目"，不会崩。
 */
export interface CustomPromptsJson {
  format: typeof CUSTOM_PROMPTS_FILE_FORMAT;
  version: number;
  prompts: CustomPromptRow[];
}

export interface ExportBackupResult {
  filename: string;
  blob: Blob;
  manifest: BackupManifest;
  /** 实际写进 zip 的条目名（报告与测试都对着它断言，避免"以为导了"） */
  entries: string[];
}

export interface ImportBackupResult {
  mode: 'merge' | 'replace';
  imported: number;
  media: number;
  /** 记录里声明了音频但 zip 里找不到对应文件的数量（数据残缺的备份） */
  missingMedia: number;
  /** 恢复的设置条数（不含 AI 配置与价格表） */
  settings: number;
  /** 恢复的会话线程条数（M5a3；包里有 threads.json 才有） */
  threads: number;
  /** 恢复的自定义提示词副本条数（M5b4；包里有 custom-prompts.json 才有） */
  customPrompts: number;
  aiCatalog: boolean;
  priceTable: boolean;
  manifest: BackupManifest;
}

export interface ExportBackupOptions {
  /** 默认不含 key；勾选「包含 API Key」才写进 ai-catalog.json */
  includeKey?: boolean;
  /**
   * 设置页「高级：只导出某一类」用。
   * - { records:true, aiCatalog:false, settings:false, priceTable:false } → 仅记录
   * - { records:false, aiCatalog:true, settings:false, priceTable:false } → 仅 AI 配置
   */
  include?: Partial<{
    records: boolean;
    aiCatalog: boolean;
    settings: boolean;
    priceTable: boolean;
    /** 自定义提示词副本（默认跟着备份走：用户手写的内容） */
    customPrompts: boolean;
  }>;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** records_YYYYMMDD.zip（本地日期，用户看的是"今天导出的"） */
export function backupFilename(date: Date = new Date(), options: { withKey?: boolean } = {}): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  // 带 API Key 的包加 KEY- 前缀：文件列表里一眼能看出这是「明文密码本」，避免误传给别人。
  // 前缀用 ASCII，跨平台/邮件附件不会因为中文名乱码。
  return `${options.withKey ? 'KEY-' : ''}records_${year}${month}${day}.zip`;
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('读取 Blob 失败'));
    reader.readAsArrayBuffer(blob);
  });
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StorageError('INVALID_PAYLOAD', `${what} 不是合法 JSON，备份包可能已损坏`);
  }
}

function fail(message: string): never {
  throw new StorageError('INVALID_PAYLOAD', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 这些设置各自走专门的文件，不再重复塞进 settings.json */
const SETTINGS_EXCLUDED_KEYS = new Set<string>([AI_CATALOG_KEY, AI_PRICE_TABLE_KEY]);

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

export async function exportBackupZip(
  date: Date = new Date(),
  options: ExportBackupOptions = {},
): Promise<ExportBackupResult> {
  const include = {
    records: true,
    aiCatalog: true,
    settings: true,
    priceTable: true,
    customPrompts: true,
    ...options.include,
  };
  const includeKey = options.includeKey === true;

  const db = getDatabase();
  const entries: string[] = [];
  const zip = new JSZip();

  /* 记录 + 音频 --------------------------------------------------- */
  const recordEntries: BackupRecordEntry[] = [];
  if (include.records) {
    const rows = (await db.records.toArray()) as RecordRow[];
    const mediaRows = (await db.media.toArray()) as MediaRow[];
    const mediaByRecord = new Map<string, MediaRow>();
    for (const media of mediaRows) mediaByRecord.set(media.recordId, media);

    for (const row of rows) {
      const entry: BackupRecordEntry = {
        id: row.id,
        text: row.text ?? '',
        tags: Array.isArray(row.tags) ? row.tags : [],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
      if (row.emotion) entry.emotion = row.emotion;
      if (row.hasAIResult === true) entry.hasAIResult = true;
      // P5：白名单构造，不显式搬就会丢（见 BackupRecordEntry 的注释）
      const role = normalizeRole(row.role);
      if (role !== DEFAULT_RECORD_ROLE) entry.role = role;
      const sourceIds = normalizeSourceIds(row.sourceIds);
      if (sourceIds.length > 0) entry.sourceIds = sourceIds;

      const media = row.audio ? mediaByRecord.get(row.id) : undefined;
      if (media) {
        const extension = audioExtensionFor(media.mimeType);
        const file = `media/${row.id}.${extension}`;
        entry.audio = { file, mimeType: media.mimeType, durationMs: media.durationMs };
        zip.file(file, await blobToArrayBuffer(media.blob));
        entries.push(file);
      }
      recordEntries.push(entry);
    }

    const recordsJson: RecordsJson = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      records: recordEntries,
    };
    zip.file('records.json', JSON.stringify(recordsJson, null, 2));
    entries.push('records.json');

    /*
     * 会话线程（M5a3）：**跟着记录一起走**。
     * 只有真的存在线程时才写这个条目 —— 没会话时写一个空数组会让"包里多一个文件"
     * 变成既有断言（判据 6 的条目清单）的噪音，而空文件本身也不携带任何信息。
     */
    const threadRows = (await db.threads.toArray()) as ThreadRow[];
    if (threadRows.length > 0) {
      const threadsJson: ThreadsJson = {
        format: THREADS_FILE_FORMAT,
        version: 1,
        threads: threadRows,
      };
      zip.file('threads.json', JSON.stringify(threadsJson, null, 2));
      entries.push('threads.json');
    }
  }

  /* AI 配置（含 key 与否由导出选项决定） ---------------------------- */
  let containsKey = false;
  let catalogJson: string | null = null;
  if (include.aiCatalog) {
    const catalog = await loadCatalog();
    const file = buildCatalogFile(catalog, { includeKey, now: date });
    containsKey = file.containsKey;
    catalogJson = JSON.stringify(file, null, 2);
    zip.file('ai-catalog.json', catalogJson);
    entries.push('ai-catalog.json');
  }

  /* 设置（语音方式、画布模式与位置、花费…） ------------------------- */
  if (include.settings) {
    const rows = (await db.settings.toArray()) as SettingsRow[];
    const settingsJson: SettingsJson = {
      format: SETTINGS_FILE_FORMAT,
      version: 1,
      settings: rows
        .filter((row) => !SETTINGS_EXCLUDED_KEYS.has(row.key))
        .filter((row) => typeof row.key === 'string' && row.key.length > 0)
        .map((row) => {
          const item: { key: string; value: unknown; updatedAt?: number } = {
            key: row.key,
            value: row.value,
          };
          if (typeof row.updatedAt === 'number') item.updatedAt = row.updatedAt;
          return item;
        }),
    };
    zip.file('settings.json', JSON.stringify(settingsJson, null, 2));
    entries.push('settings.json');
  }

  /* 价格表 --------------------------------------------------------- */
  if (include.priceTable) {
    const table = await loadPriceTable();
    const priceTableJson: PriceTableJson = {
      format: PRICE_TABLE_FILE_FORMAT,
      version: 1,
      table,
    };
    zip.file('price-table.json', JSON.stringify(priceTableJson, null, 2));
    entries.push('price-table.json');
  }

  /* 自定义提示词副本（用户手写，必须带走） --------------------------- */
  if (include.customPrompts) {
    const rows = (await db.customPrompts.toArray()) as CustomPromptRow[];
    if (rows.length > 0) {
      const customPromptsJson: CustomPromptsJson = {
        format: CUSTOM_PROMPTS_FILE_FORMAT,
        version: 1,
        prompts: rows,
      };
      zip.file('custom-prompts.json', JSON.stringify(customPromptsJson, null, 2));
      entries.push('custom-prompts.json');
    }
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: date.toISOString(),
    app: BACKUP_APP,
    containsKey,
    counts: {
      records: recordEntries.length,
      media: recordEntries.filter((entry) => entry.audio).length,
    },
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  entries.unshift('manifest.json');

  const buffer = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
  return {
    filename: backupFilename(date, { withKey: includeKey }),
    blob: new Blob([buffer], { type: 'application/zip' }),
    manifest,
    entries,
  };
}

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

type ZipSource = Blob | ArrayBuffer | Uint8Array | string;

function readManifest(raw: unknown): BackupManifest {
  if (!isRecord(raw)) fail('manifest.json 内容不是对象');
  const manifest = raw as Partial<BackupManifest>;

  if (manifest.format !== BACKUP_FORMAT) {
    fail(`不是本应用的备份包（manifest.format 应为 ${BACKUP_FORMAT}）`);
  }
  if (typeof manifest.version !== 'number' || !Number.isFinite(manifest.version)) {
    fail('manifest.version 缺失或不是数字');
  }
  if (manifest.version > BACKUP_VERSION) {
    fail(
      `这份备份来自更新版本的应用（备份 v${manifest.version}，本应用只认到 v${BACKUP_VERSION}）。` +
        '请先升级应用再导入；本次没有写入任何数据。',
    );
  }

  const counts = manifest.counts ?? { records: 0, media: 0 };
  return {
    format: BACKUP_FORMAT,
    version: manifest.version,
    exportedAt: typeof manifest.exportedAt === 'string' ? manifest.exportedAt : '',
    app: typeof manifest.app === 'string' ? manifest.app : BACKUP_APP,
    containsKey: manifest.containsKey === true,
    counts: {
      records: typeof counts.records === 'number' ? counts.records : 0,
      media: typeof counts.media === 'number' ? counts.media : 0,
    },
  };
}

function readEntry(raw: unknown): BackupRecordEntry {
  if (!isRecord(raw)) fail('records.json 里存在非对象条目');
  const entry = raw as Partial<BackupRecordEntry>;
  if (typeof entry.id !== 'string' || entry.id.length === 0) fail('records.json 里有条目缺少 id');

  const result: BackupRecordEntry = {
    id: entry.id,
    text: typeof entry.text === 'string' ? entry.text : '',
    tags: Array.isArray(entry.tags)
      ? entry.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
  };

  if (entry.audio && typeof entry.audio === 'object') {
    const audio = entry.audio as Partial<NonNullable<BackupRecordEntry['audio']>>;
    if (typeof audio.file !== 'string' || audio.file.length === 0) {
      fail(`记录 ${entry.id} 的 audio.file 缺失`);
    }
    result.audio = {
      file: audio.file,
      mimeType: typeof audio.mimeType === 'string' ? audio.mimeType : 'application/octet-stream',
      durationMs: typeof audio.durationMs === 'number' ? audio.durationMs : 0,
    };
  }
  if (typeof entry.emotion === 'string' && entry.emotion !== '') result.emotion = entry.emotion;
  if (entry.hasAIResult === true) result.hasAIResult = true;
  // P5：旧包（v1/v2 早期）没有这两个字段 → 不写，读侧按「笔记 / 无来源」解释
  const role = normalizeRole(entry.role);
  if (role !== DEFAULT_RECORD_ROLE) result.role = role;
  const sourceIds = normalizeSourceIds(entry.sourceIds);
  if (sourceIds.length > 0) result.sourceIds = sourceIds;
  return result;
}

function readSettings(raw: unknown): Array<{ key: string; value: unknown; updatedAt?: number }> {
  if (!isRecord(raw)) fail('settings.json 内容不是对象');
  const list = (raw as Partial<SettingsJson>).settings;
  if (!Array.isArray(list)) fail('settings.json 里没有 settings 数组');
  return list.map((item) => {
    if (!isRecord(item)) fail('settings.json 里存在非对象条目');
    const key = item.key;
    if (typeof key !== 'string' || key.length === 0) fail('settings.json 里有条目缺少 key');
    const entry: { key: string; value: unknown; updatedAt?: number } = { key, value: item.value };
    if (typeof item.updatedAt === 'number') entry.updatedAt = item.updatedAt;
    return entry;
  });
}

function readPriceTable(raw: unknown): PriceTable {
  if (!isRecord(raw)) fail('price-table.json 内容不是对象');
  const table = (raw as Partial<PriceTableJson>).table ?? raw;
  if (!isRecord(table) || !isRecord(table.models)) {
    fail('price-table.json 里没有价格表（models 缺失）');
  }
  return table as unknown as PriceTable;
}

function readTurn(raw: unknown): TurnRow {
  if (!isRecord(raw)) fail('threads.json 里存在非对象的 turn');
  const role = raw.role === 'assistant' ? 'assistant' : raw.role === 'user' ? 'user' : null;
  if (role === null) fail('threads.json 的 turn.role 只能是 user / assistant');
  const turn: TurnRow = {
    role,
    content: typeof raw.content === 'string' ? raw.content : '',
    at: typeof raw.at === 'number' ? raw.at : Date.now(),
  };
  if (raw.structured !== undefined) turn.structured = raw.structured;
  if (typeof raw.error === 'string' && raw.error !== '') turn.error = raw.error;
  if (typeof raw.tokens === 'number' && Number.isFinite(raw.tokens)) turn.tokens = raw.tokens;
  return turn;
}

/**
 * 读 threads.json。整包校验一律"先验后写"：任何一条不合法就抛 INVALID_PAYLOAD，
 * 库一个字节都不动（与 records/media 同一套纪律）。
 */
function readThreads(raw: unknown): ThreadRow[] {
  if (!isRecord(raw)) fail('threads.json 内容不是对象');
  const list = (raw as Partial<ThreadsJson>).threads;
  if (!Array.isArray(list)) fail('threads.json 里没有 threads 数组');
  return list.map((item) => {
    if (!isRecord(item)) fail('threads.json 里存在非对象条目');
    const id = item.id;
    if (typeof id !== 'string' || id === '') fail('threads.json 里有条目缺少 id');
    const recordId = item.recordId;
    if (typeof recordId !== 'string' || recordId === '') fail(`会话 ${id} 缺少 recordId`);
    const turns = Array.isArray(item.turns) ? item.turns : [];
    const row: ThreadRow = {
      id,
      recordId,
      kind: typeof item.kind === 'string' && item.kind !== '' ? item.kind : 'dream',
      packId:
        typeof item.packId === 'string' && item.packId !== ''
          ? item.packId
          : item.kind === 'copy'
            ? 'story-expansion'
            : 'dream-interpretation',
      turns: turns.map(readTurn),
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
    };
    if (typeof item.title === 'string' && item.title !== '') row.title = item.title;
    return row;
  });
}

/**
 * 读 custom-prompts.json（M5b4）。
 *
 * 与 records/threads 同一套纪律：**先整份校验，再写库**。一条不合法就整包拒绝，
 * 不做"能读几条算几条" —— 那样用户会以为备份完整，其实副本被悄悄截断了。
 */
function readCustomPrompts(raw: unknown): CustomPromptRow[] {
  if (!isRecord(raw)) fail('custom-prompts.json 内容不是对象');
  const list = (raw as Partial<CustomPromptsJson>).prompts;
  if (!Array.isArray(list)) fail('custom-prompts.json 里没有 prompts 数组');
  return list.map((item) => {
    if (!isRecord(item)) fail('custom-prompts.json 里存在非对象条目');
    const id = item.id;
    if (typeof id !== 'string' || id === '') fail('custom-prompts.json 里有条目缺少 id');
    const basePackId = item.basePackId;
    if (typeof basePackId !== 'string' || basePackId === '') {
      fail(`提示词副本 ${id} 缺少 basePackId`);
    }
    const name = item.name;
    if (typeof name !== 'string' || name.trim() === '') fail(`提示词副本 ${id} 缺少副本名`);
    const body = item.body;
    // 正文是这份备份里唯一不可再生的内容：空字符串=数据已丢，不能当合法值写进库
    if (typeof body !== 'string' || body.trim() === '') fail(`提示词副本 ${id} 的正文为空`);
    const createdAt = typeof item.createdAt === 'number' ? item.createdAt : Date.now();
    return {
      id,
      basePackId,
      name,
      body,
      createdAt,
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : createdAt,
    };
  });
}

/**
 * merge 模式：包里的连接 key 是空的（导出时没勾「包含 API Key」），
 * 而本机同 id 连接已有 key → 保留本机的，避免"导入一份不含 key 的备份把 key 清空"。
 */
function keepLocalKeys(incoming: AICatalog, local: AICatalog): AICatalog {
  return {
    ...incoming,
    providers: incoming.providers.map((provider) => {
      const localProvider = local.providers.find((item) => item.id === provider.id);
      if (!localProvider) return provider;
      return {
        ...provider,
        connections: provider.connections.map((connection) => {
          if (connection.apiKey !== '') return connection;
          const localConnection = localProvider.connections.find((item) => item.id === connection.id);
          return localConnection ? { ...connection, apiKey: localConnection.apiKey } : connection;
        }),
      };
    }),
  };
}

/**
 * 导入 zip。全部内容**先校验、再写库**：任何一项不合法都抛 INVALID_PAYLOAD，库不受影响。
 * - mode=merge：按 id 覆盖，不动其它记录；settings 按 key 覆盖；
 * - mode=replace：清空 records / media，**并且**（包里带 settings.json 时）重建 settings，
 *   否则会留下"记录换了、画布模式还是旧的"的半套数据。v1 老包没有 settings.json，
 *   于是仍按老语义只清记录，不动用户本机的语音配置。
 */
export async function importBackupZip(
  source: ZipSource,
  options: { mode?: 'merge' | 'replace' } = {},
): Promise<ImportBackupResult> {
  const mode = options.mode ?? 'merge';

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(source);
  } catch {
    throw new StorageError('INVALID_PAYLOAD', '不是合法的 zip 文件，或文件已损坏');
  }

  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) fail('备份包里缺少 manifest.json');

  const manifest = readManifest(parseJson(await manifestFile.async('string'), 'manifest.json'));

  const recordsFile = zip.file('records.json');
  if (!recordsFile) fail('备份包里缺少 records.json');

  const parsed = parseJson(await recordsFile.async('string'), 'records.json');
  const rawRecords = Array.isArray(parsed)
    ? parsed
    : (parsed as Partial<RecordsJson> | null)?.records;
  if (!Array.isArray(rawRecords)) fail('records.json 里没有 records 数组');

  const entries = rawRecords.map(readEntry);

  /* 可选的三类（v1 老包里没有） ------------------------------------ */
  const aiCatalogFile = zip.file('ai-catalog.json');
  let incomingCatalog: AICatalog | null = null;
  if (aiCatalogFile) {
    const result = parseCatalogFile(await aiCatalogFile.async('string'));
    if (!result.ok) fail(`ai-catalog.json 无法识别：${result.error}`);
    incomingCatalog = result.catalog;
  }

  const settingsFile = zip.file('settings.json');
  const incomingSettings = settingsFile
    ? readSettings(parseJson(await settingsFile.async('string'), 'settings.json'))
    : null;

  const priceFile = zip.file('price-table.json');
  const incomingPriceTable = priceFile
    ? readPriceTable(parseJson(await priceFile.async('string'), 'price-table.json'))
    : null;

  const threadsFile = zip.file('threads.json');
  const incomingThreads = threadsFile
    ? readThreads(parseJson(await threadsFile.async('string'), 'threads.json'))
    : null;

  const customPromptsFile = zip.file('custom-prompts.json');
  const incomingCustomPrompts = customPromptsFile
    ? readCustomPrompts(parseJson(await customPromptsFile.async('string'), 'custom-prompts.json'))
    : null;

  // 先把音频全部读进内存再开事务：Dexie 事务里 await 外部异步会让事务提前结束
  const mediaRows: MediaRow[] = [];
  let missingMedia = 0;

  for (const entry of entries) {
    if (!entry.audio) continue;
    const file = zip.file(entry.audio.file);
    if (!file) {
      missingMedia += 1;
      continue;
    }
    const bytes = await file.async('arraybuffer');
    mediaRows.push({
      id: entry.id,
      recordId: entry.id,
      blob: new Blob([bytes], { type: entry.audio.mimeType }),
      mimeType: entry.audio.mimeType,
      durationMs: entry.audio.durationMs,
      createdAt: entry.createdAt,
    });
  }

  const recordRows: RecordRow[] = entries.map((entry) => {
    const row: RecordRow = {
      id: entry.id,
      text: entry.text,
      tags: entry.tags,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    if (entry.emotion) row.emotion = entry.emotion;
    if (entry.hasAIResult) row.hasAIResult = true;
    // P5：角色与来源要跟着走，否则「导出 → 清库 → 导入」后成品会降级成笔记
    if (entry.role) row.role = entry.role;
    if (entry.sourceIds && entry.sourceIds.length > 0) row.sourceIds = entry.sourceIds;
    if (entry.audio) {
      const media = mediaRows.find((candidate) => candidate.recordId === entry.id);
      if (media)
        row.audio = { mediaId: media.id, mimeType: media.mimeType, durationMs: media.durationMs };
    }
    return row;
  });

  const db = getDatabase();

  // AI 配置的合并策略在事务外算好（需要读本机现状）
  const currentCatalog = await loadCatalog();
  const nextCatalog =
    incomingCatalog === null
      ? null
      : mode === 'merge'
        ? keepLocalKeys(normalizeCatalog(incomingCatalog), currentCatalog)
        : normalizeCatalog(incomingCatalog);

  const settingsRows: SettingsRow[] = (incomingSettings ?? []).map((item) => {
    const row: SettingsRow = { key: item.key, value: item.value };
    if (typeof item.updatedAt === 'number') row.updatedAt = item.updatedAt;
    return row;
  });

  if (nextCatalog) {
    settingsRows.push({
      key: AI_CATALOG_KEY,
      value: nextCatalog,
      updatedAt: nextCatalog.updatedAt ?? Date.now(),
    });
  }
  if (incomingPriceTable) {
    settingsRows.push({ key: AI_PRICE_TABLE_KEY, value: incomingPriceTable, updatedAt: Date.now() });
  }

  try {
    await db.transaction(
      'rw',
      db.records,
      db.media,
      db.settings,
      db.threads,
      db.customPrompts,
      async () => {
        if (mode === 'replace') {
          await db.records.clear();
          await db.media.clear();
          // v1 老包里没有 settings.json → 不清设置（保住本机的语音配置）
          if (incomingSettings) await db.settings.clear();
          /*
           * 会话线程只在**包里真的有** threads.json 时才清空重建：
           * 导入一份 M5a3 之前的备份不该把用户现在的会话悄悄删掉（那是不可解释的数据丢失）。
           * 代价是 replace 一个没有 threads.json 的包会留下旧线程（报告 §5 已列）。
           */
          if (incomingThreads !== null) await db.threads.clear();
          // 副本同理：只有包里带了 custom-prompts.json 才整表重建
          if (incomingCustomPrompts !== null) await db.customPrompts.clear();
        }
        for (const row of recordRows) {
          // merge 时若这条记录原来有音频、而新包里没有，必须把旧音轨删掉，否则详情页会播到旧声音
          await db.media.where('recordId').equals(row.id).delete();
          await db.records.put(row);
        }
        if (mediaRows.length > 0) await db.media.bulkPut(mediaRows);
        if (settingsRows.length > 0) await db.settings.bulkPut(settingsRows);
        if (incomingThreads !== null && incomingThreads.length > 0) {
          await db.threads.bulkPut(incomingThreads);
        }
        if (incomingCustomPrompts !== null && incomingCustomPrompts.length > 0) {
          await db.customPrompts.bulkPut(incomingCustomPrompts);
        }
      },
    );
  } catch (error) {
    if (error instanceof StorageError) throw error;
    const translated = toStorageError(error);
    if (translated instanceof StorageQuotaError) throw translated;
    throw translated;
  }

  /*
   * 导入的副本要立刻能被解析到：快照是内存里的，不重读的话画板会继续用旧正文
   * （甚至旧副本的 id 对不上）。强制重读，失败也不影响"已经写进库"这件事。
   */
  await hydrateCustomPrompts(true);

  return {
    mode,
    imported: recordRows.length,
    media: mediaRows.length,
    missingMedia,
    settings: incomingSettings?.length ?? 0,
    threads: incomingThreads?.length ?? 0,
    customPrompts: incomingCustomPrompts?.length ?? 0,
    aiCatalog: nextCatalog !== null,
    priceTable: incomingPriceTable !== null,
    manifest,
  };
}

