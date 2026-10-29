/** 置顶 / 合集的类型与业务错误（P2b）。存储形状 = 任务书 §1 逐字一致。 */

export interface Collection {
  /** `crypto.randomUUID()`；老环境降级为 `col_…` */
  id: string;
  name: string;
  /** 数组顺序 = 合集内拖拽后的顺序 */
  recordIds: string[];
  createdAt: number;
}

export interface Library {
  /** 数组顺序 = 置顶区显示顺序 */
  pins: string[];
  collections: Collection[];
}

export class LibraryError extends Error {
  readonly code: 'INVALID_NAME' | 'NOT_FOUND' | 'INVALID_RECORD';

  constructor(code: 'INVALID_NAME' | 'NOT_FOUND' | 'INVALID_RECORD', message: string) {
    super(message);
    this.name = 'LibraryError';
    this.code = code;
  }
}
