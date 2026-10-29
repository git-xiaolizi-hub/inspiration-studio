/**
 * 存储适配层的公共类型与错误定义。
 * 这一层是"业务逻辑（core）"与"浏览器能力（IndexedDB）"之间的唯一通道，
 * 上层不直接接触 indexedDB API，方便未来替换实现（例如 M6 打包成桌面端时换成 sqlite）。
 */

/** 逻辑仓库名，与 IndexedDB 的 object store 一一对应 */
export const STORE_NAMES = ['records', 'settings', 'media'] as const;

export type StoreName = (typeof STORE_NAMES)[number];

/** 所有可持久化实体的最小约定：必须有字符串主键 id */
export interface StorageRecord {
  id: string;
}

/** 可识别的错误码，UI 层据此给出人话提示，而不是把异常原文丢给用户 */
export type StorageErrorCode =
  | 'QUOTA_EXCEEDED' // 本地空间不足
  | 'UNAVAILABLE' // 当前环境不支持 IndexedDB（隐私模式 / 非浏览器环境）
  | 'INVALID_PAYLOAD' // 写入或导入的数据结构不合法
  | 'DB_ERROR'; // 其它底层数据库错误

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  /** 底层原始错误，便于开发期排查 */
  readonly detail?: unknown;

  constructor(code: StorageErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.detail = detail;
  }
}

/** 空间不足专用子类：上层可用 instanceof 精确捕获 */
export class StorageQuotaError extends StorageError {
  /** 当前已用量（字节），未知时为 undefined */
  readonly usage?: number;

  /** 配额上限（字节），未知时为 undefined */
  readonly quota?: number;

  constructor(message: string, usage?: number, quota?: number, detail?: unknown) {
    super('QUOTA_EXCEEDED', message, detail);
    this.name = 'StorageQuotaError';
    this.usage = usage;
    this.quota = quota;
  }
}
