/**
 * 本地识别的错误类型 + 给人看的文案（M2.5）。
 *
 * UI 只认 `AsrError.code`，文案统一在这里改，避免每个组件各写一套。
 */
import type { AsrErrorCode } from './protocol';

export class AsrError extends Error {
  readonly code: AsrErrorCode;

  constructor(code: AsrErrorCode, message: string) {
    super(message);
    this.name = 'AsrError';
    this.code = code;
  }
}

export function isAsrCancel(error: unknown): boolean {
  if (error instanceof AsrError) return error.code === 'CANCELLED';
  return (error as { name?: string } | null)?.name === 'AbortError';
}

/** 把任意异常翻译成「能照着做」的中文；未知异常兜底不暴露堆栈 */
export function describeAsrError(error: unknown): string {
  if (error instanceof AsrError) {
    switch (error.code) {
      case 'MODEL_MISSING':
        return '没找到本地模型。请先运行 npm run model:whisper 把模型放进 public/models/，然后刷新页面。';
      case 'LOAD_FAILED':
        return '本地模型加载失败。录音已保存，可以稍后重试或改用「仅录音」。';
      case 'BAD_AUDIO':
        return `${error.message}。录音已保存，可以手动补文字。`;
      case 'TRANSCRIBE_FAILED':
        return '这次没转写成功。录音和记录都已保留，可以重试。';
      case 'CANCELLED':
        return '已取消转写。';
      default:
        return '本地识别出了点问题。录音和记录都已保留。';
    }
  }
  return '本地识别出了点问题。录音和记录都已保留。';
}
