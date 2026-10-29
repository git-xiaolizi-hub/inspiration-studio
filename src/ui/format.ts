/** 把各类错误翻译成用户能照着做的一句话（UI 层统一出口） */
import { StorageError, StorageQuotaError } from '../core/storage/types';
import { RecordError } from '../core/records/types';
import { RecordingError } from '../core/media/recorder';

export function describeError(error: unknown): string {
  if (error instanceof StorageQuotaError) return error.message;
  if (error instanceof StorageError) {
    switch (error.code) {
      case 'UNAVAILABLE':
        return '当前浏览器不允许使用本地存储（可能是隐私模式），请换普通窗口打开';
      case 'INVALID_PAYLOAD':
        return error.message;
      case 'QUOTA_EXCEEDED':
        return '本地空间不足，请先导出备份再清理旧记录';
      default:
        return '本地数据库操作失败，请刷新页面重试；若仍失败请先导出备份';
    }
  }
  if (error instanceof RecordError) return error.message;
  if (error instanceof RecordingError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return '操作失败，请重试';
}

/** 文件大小显示 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

/** 时间戳 → "2026-10-17 14:05" */
export function formatDateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  const date = new Date(timestamp);
  const pad = (value: number) => `${value}`.padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/**
 * 本地时区「今天 00:00:00.000」的 epoch 毫秒（P0.5 的「今天 N 条」用它当 since）。
 *
 * 为什么不用 `Date.UTC(...)` / `toISOString().slice(0,10)`：
 * 那两者按 **UTC** 划天。中国是 UTC+8，用 UTC 划天会让 00:00–08:00 写下的记录
 * 被算成「昨天」（反过来在 UTC-x 时区会把昨天傍晚算成今天）。
 *
 * 用 `new Date(y, m, d)` 这种「本地分量」构造，夏令时切换日也由运行时按本地规则处理：
 * 那天 00:00 一定存在（切换都发生在凌晨更深的位置），不会算错。
 */
export function startOfToday(now: number = Date.now()): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
