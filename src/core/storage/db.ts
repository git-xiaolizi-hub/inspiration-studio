/**
 * Dexie 实例与表结构（M2 引入，依据 CHARTER §13.3 裁决）。
 *
 * 三层分工：
 * - 本文件：只描述"库里长什么样"（表、索引、行类型），不含业务规则；
 * - `index.ts`：M1 就在用的通用 CRUD（签名保持不变），内部改成 Dexie；
 * - `queries.ts`：记录专用的索引查询（标签筛选 / 时间倒序 / 分页 / 搜索）。
 *
 * 行类型与对外实体（`core/records`）的区别：记录行里的 audio 只是"引用"
 * （mediaId + mimeType + durationMs），音频二进制单独存 media 表，
 * 避免列表查询把几十 MB 的 Blob 一起读进来。
 */
import Dexie, { type Table } from 'dexie';
import { StorageError } from './types';

export const DB_NAME = 'inspiration-assistant';

/** 数据库 schema 版本（导入/导出与迁移判断用）。M5a2 起"基础三表"仍是 v1。 */
export const SCHEMA_VERSION = 1;

/**
 * M5a2：新增 `artifacts` 表（该条记录的 AI 产物：解梦卡片 / 文案方向 / 生图）。
 *
 * 为什么**不动** `STORE_NAMES`：`STORE_NAMES` 是 `exportData()` / `importData()` 的边界，
 * 备份包（v2）与 M5a 的统一导出都按它来。把 artifacts 塞进去会改变备份包内容，
 * 而本轮硬约束是不改既有断言 → 用 Dexie 的增量版本（v2 只声明新表）加进来，
 * 备份待 M5b 授权后再扩（报告 §4 已列为已知限制）。
 */
export const ARTIFACTS_SCHEMA_VERSION = 2;

/**
 * M5a3：新增 `threads` 表（解梦 / 灵感的会话线程）。
 *
 * 与 artifacts 同一套做法：**不动 `STORE_NAMES`**（那是 exportData/importData 的边界），
 * 用 Dexie 增量版本加表。备份走 `core/backup`（已把 threads.json 一起装进 zip）。
 */
export const THREADS_SCHEMA_VERSION = 3;

/**
 * M5b4：新增 `customPrompts` 表（用户基于内置提示词写的副本）。
 *
 * 与 artifacts / threads 同一套做法：**不动 `STORE_NAMES`**，用 Dexie 增量版本加表。
 * 备份走 `core/backup`（`custom-prompts.json`）—— 用户手写的内容丢了就是数据丢失。
 */
export const CUSTOM_PROMPTS_SCHEMA_VERSION = 4;

/** records 表里指向音频的引用信息 */
export interface RecordAudioRef {
  mediaId: string;
  mimeType: string;
  durationMs: number;
}

/** records 表行 */
export interface RecordRow {
  id: string;
  text: string;
  tags: string[];
  /** epoch 毫秒：用数字才能被 IndexedDB 索引正确排序（ISO 字符串按字典序恰好也对，但数字更省） */
  createdAt: number;
  updatedAt: number;
  audio?: RecordAudioRef;
  /**
   * 情绪标签（M5a 卡片墙 chip 的数据来源）。当前没有任何录入入口，
   * 只保证「导入/未来的写入方带了它，卡片就显示」，没有则不占位。
   */
  emotion?: string;
  /** 是否已有 AI 结果（M5a 卡片角标）。同样只读 */
  hasAIResult?: boolean;
  /**
   * P5：来源记录 id（成品 / AI 产出 / 副本的血缘）。
   *
   * ⚠️ **故意不在 schema 里**：`records` 的索引串仍然只有 `'id, createdAt, *tags'`。
   * Dexie 存的是完整对象，多一个不在 schema 里的普通属性照样能写能读，
   * 所以这一轮**没有 version(5)、没有 upgrade 回调、没有迁移**。
   * 按 role 筛选在内存里做（`core/records` 的 `countRecordsByRole`），
   * 真要提速再加索引 —— 那时才需要升版本。
   */
  sourceIds?: string[];
  /** P5：笔记（默认）/ 写作成品 / AI 产出素材。同样不建索引，读时归一 */
  role?: 'note' | 'draft' | 'asset';
}

/** settings 表行：以 key 为主键，value 存任意可结构化克隆的值 */
export interface SettingsRow {
  key: string;
  value?: unknown;
  updatedAt?: number;
  [extraField: string]: unknown;
}

/** media 表行：音频二进制本体 */
export interface MediaRow {
  id: string;
  recordId: string;
  blob: Blob;
  mimeType: string;
  durationMs: number;
  createdAt: number;
}

/**
 * artifacts 表行（M5a2）：一条记录的 AI 产物。
 *
 * `payload` 是**结构化结果本体**，形状由 `kind` 决定（见 `core/artifacts`）：
 * - `dream` / `copy`：packs 的输出 JSON（已过校验器）
 * - `image`：`ImageArtifactPayload`（提示词、远端地址、media 主键、时效）
 *
 * 二进制（图片字节）不放这里，仍进 `media` 表 —— 与音频/视频同一套约定。
 */
export interface ArtifactRow {
  id: string;
  recordId: string;
  /** dream | copy | image */
  kind: string;
  payload: unknown;
  modelId: string;
  /** 本次实际花费（元）；免费/未核实价格时为 0，另由 payload 或 UI 注明 */
  cost: number;
  createdAt: number;
}

/**
 * 会话轮（M5a3）。`structured` 只有**首轮**带上：那是 pack 的结构化输出（用于渲染
 * DreamCard / CopyCard 并过校验器）；追问轮是自由文本，不带结构化。
 *
 * `error` 有值 = 这一轮失败了。**失败轮不进上下文**（`contextTurns()` 会滤掉），
 * 但要在库里留痕 —— 用户刷新后还能看见"这句没答上来"并点重试。
 */
export interface TurnRow {
  role: 'user' | 'assistant';
  content: string;
  at: number;
  structured?: unknown;
  error?: string;
  /** 模型返回的 token 用量；拿不到就不写（不编） */
  tokens?: number;
}

/** threads 表行（M5a3）：一条记录 + 一种 pack 的一条会话 */
export interface ThreadRow {
  id: string;
  recordId: string;
  /** dream | copy（生图/生视频没有会话） */
  kind: string;
  packId: string;
  title?: string;
  turns: TurnRow[];
  createdAt: number;
  updatedAt: number;
}

/**
 * customPrompts 表行（M5b4）：用户手写/改写的提示词副本。
 *
 * 只有 `body` 是"可改的正文"；validation / forbidden 仍由 pack 的 frontmatter 提供 ——
 * 形状与 `core/custom-prompts` 的 `CustomPrompt` 逐字一致（那边是对外模型，这边是行）。
 */
export interface CustomPromptRow {
  id: string;
  basePackId: string;
  name: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 通用 CRUD 视角下的行：只需要"有一个可作主键的字段"。
 * 用显式索引签名而不是 any，避免 lint 报 no-explicit-any。
 */
export interface RowLike {
  id?: string;
  key?: string;
  [field: string]: unknown;
}

/**
 * Dexie 子类。
 * 表属性用 `!` 声明、在构造函数里由 `version().stores()` 赋值 —— 这是 Dexie 官方推荐写法，
 * 不要在外面 `new Table()` 手动赋值，否则版本升级时索引信息会丢。
 */
export class InspirationDatabase extends Dexie {
  records!: Table<RecordRow, string>;

  settings!: Table<SettingsRow, string>;

  media!: Table<MediaRow, string>;

  /** M5a2：AI 产物（不从 STORE_NAMES 走，见 ARTIFACTS_SCHEMA_VERSION 的注释） */
  artifacts!: Table<ArtifactRow, string>;

  /** M5a3：解梦 / 灵感的会话线程 */
  threads!: Table<ThreadRow, string>;

  /** M5b4：自定义提示词副本（按 basePackId 索引 = "这个 pack 有哪些副本"） */
  customPrompts!: Table<CustomPromptRow, string>;

  constructor(name: string = DB_NAME) {
    super(name);

    // 只用字符串形式的 schema 描述，Dexie 会把现有库的结构对不上的表重建（见 M2 报告"坑"一节）
    this.version(SCHEMA_VERSION).stores({
      // id 主键；createdAt 支持时间倒序 + 分页；*tags 是多值索引，一个标签对应多条索引项
      records: 'id, createdAt, *tags',
      // 设置以 key 为主键（voice / quota 等配置项平铺）
      settings: 'key',
      // 音频按 id 存；recordId 普通索引用于"删记录时级联删音频"
      media: 'id, recordId',
    });

    // v2 只声明新表：Dexie 按版本增量升级，其余三表不受影响（加表不需要 upgrade() 回调）
    this.version(ARTIFACTS_SCHEMA_VERSION).stores({
      artifacts: 'id, recordId, kind, createdAt',
    });

    // v3 同理：只加 threads（按 recordId 索引 = 「这条记录有哪些会话」；kind 用于筛解梦/灵感）
    this.version(THREADS_SCHEMA_VERSION).stores({
      threads: 'id, recordId, kind, updatedAt',
    });

    // v4：自定义提示词副本。索引名就是键路径 basePackId（Dexie 里 `.where('basePackId')`），
    // 任务书写的「按 basePackId 建索引」即此意；主键仍是 `cp_…` 的 id。
    this.version(CUSTOM_PROMPTS_SCHEMA_VERSION).stores({
      customPrompts: 'id, basePackId, updatedAt',
    });
  }
}

let instance: InspirationDatabase | null = null;

/** 取（或惰性创建）数据库单例；环境不支持时抛 UNAVAILABLE，而不是让 Dexie 内部报奇怪错误 */
export function getDatabase(): InspirationDatabase {
  if (typeof indexedDB === 'undefined') {
    throw new StorageError('UNAVAILABLE', '当前环境不支持本地存储（IndexedDB），无法保存数据');
  }
  if (!instance) instance = new InspirationDatabase();
  return instance;
}

/** 关闭当前连接并丢弃实例（下次 getDatabase() 会重新打开） */
export function closeDatabaseInstance(): void {
  if (!instance) return;
  try {
    instance.close();
  } finally {
    instance = null;
  }
}

/** 只读地看一眼当前实例（测试与诊断用，不会创建新的库连接） */
export function peekDatabase(): InspirationDatabase | null {
  return instance;
}
