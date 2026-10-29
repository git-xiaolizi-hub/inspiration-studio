/** 记录领域模型的类型定义（M2）。存储行类型见 `core/storage/db.ts`，这里是对外实体。 */

/** 一条记录附带的音频（完整形态，含二进制） */
export interface RecordAudio {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

/**
 * 记录角色（P5）：笔记 / 写作成品 / AI 产出素材。
 *
 * **不进 Dexie schema、不建索引**（见 `records/meta.ts` 顶部说明）：它是记录行上的一个
 * 普通属性，读的时候用 `normalizeRole()` 归一。旧记录没有这个字段时一律当 `'note'`。
 */
export type RecordRole = 'note' | 'draft' | 'asset';

/** 记录实体（详情页 / 编辑页用的完整形态） */
export interface RecordEntity {
  id: string;
  text: string;
  tags: string[];
  /** epoch 毫秒，便于索引排序 */
  createdAt: number;
  updatedAt: number;
  audio?: RecordAudio;
  /**
   * 情绪标签（卡片墙 chip）。M5a 只**读**：当前数据模型与录入表单都没有情绪字段，
   * 该字段由后续里程碑补录入入口；没有就不显示 chip（不猜、不伪造）。
   */
  emotion?: string;
  /** 是否已有 AI 结果（卡片角标）。同上：M5a 只读，没有写入方时不显示角标 */
  hasAIResult?: boolean;
  /**
   * P5：这条是从哪几条记录派生来的（成品、AI 产出的解梦、副本都用它）。
   * 悬空 id（来源已被删）**不清洗** —— 详情页要能显示「素材已删除」，清洗掉就变成静默丢失。
   */
  sourceIds?: string[];
  /** P5：笔记（默认）/ 写作成品 / AI 产出素材 */
  role?: RecordRole;
}

/** 列表用的轻量摘要：不带 Blob，避免列表页把音频全读进内存 */
export interface RecordSummary {
  id: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  hasAudio: boolean;
  audioDurationMs?: number;
  audioMimeType?: string;
  emotion?: string;
  hasAIResult?: boolean;
  /** P5：见 `RecordEntity.sourceIds` */
  sourceIds?: string[];
  /** P5：见 `RecordEntity.role`（缺省 = 笔记，读方用 `normalizeRole()`） */
  role?: RecordRole;
}

/** 新建 / 编辑时的入参；audio 传 null 表示"清空录音"，传 undefined 表示"不改动" */
export interface RecordInput {
  text?: string;
  tags?: string[] | string;
  audio?: RecordAudio | null;
  /** P5：不传 = 笔记；非法值按笔记处理（见 `normalizeRole`） */
  role?: RecordRole;
  /** P5：不传 = 没有来源 */
  sourceIds?: string[];
}

/** 列表查询入参（转发到 storage/queries） */
export interface ListRecordsOptions {
  tag?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  /** P2b：「全部」区要排除已置顶的记录，避免与置顶区重复 */
  excludeIds?: string[];
}

export interface ListRecordsResult {
  items: RecordSummary[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/** 记录层的业务错误：与存储层的 StorageError 分开，UI 可分别处理 */
export class RecordError extends Error {
  readonly code: 'VALIDATION' | 'NOT_FOUND';

  constructor(code: 'VALIDATION' | 'NOT_FOUND', message: string) {
    super(message);
    this.name = 'RecordError';
    this.code = code;
  }
}
