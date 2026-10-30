/**
 * Worker ↔ 主线程的消息协议（M2.5）。
 *
 * 为什么单独一个文件：`asr.worker.ts` 与主线程适配层都要 import 它。
 * 这里只有类型（type-only），编译后不留下一行运行时代码 ——
 * 否则主线程会因为 import 这个文件而把 worker 里的 transformers.js 拖进主包。
 */

/** 本地模型 id。现在是 SenseVoice-Small（whisper 已下线，见 docs/asr） */
export type LocalModelId = 'sense-voice';

/** 进度阶段：先加载模型（可量化），再推理（whisper 无中间进度，pct 恒为 0 直到完成） */
export type AsrStage = 'loading-model' | 'transcribing';

export type AsrErrorCode =
  | 'MODEL_MISSING'
  | 'LOAD_FAILED'
  | 'BAD_AUDIO'
  | 'TRANSCRIBE_FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface TranscribeRequest {
  type: 'transcribe';
  /** 请求 id：进度/结果/错误都带同一个 id，取消也按 id 定位 */
  id: string;
  /** 16kHz 单声道 PCM，主线程已用 AudioContext + OfflineAudioContext 转好 */
  audio: Float32Array;
  /** 语言：'chinese' | 'english'（SenseVoice 还会自动判断语种，这里只用来选 zh/en 头） */
  language?: string;
  /** 模型目录的**绝对** URL（以 / 结尾），由主线程按页面 base 算好传进来 */
  modelBaseUrl: string;
  modelId: LocalModelId;
}

export interface CancelRequest {
  type: 'cancel';
  id: string;
}

export type AsrRequest = TranscribeRequest | CancelRequest;

export interface ProgressMessage {
  type: 'progress';
  id: string;
  stage: AsrStage;
  /** 0–100；推理阶段无中间进度，发 0 */
  pct: number;
}

export interface ResultMessage {
  type: 'result';
  id: string;
  text: string;
}

export interface ErrorMessage {
  type: 'error';
  id: string;
  code: AsrErrorCode;
  message: string;
}

export type AsrResponse = ProgressMessage | ResultMessage | ErrorMessage;

/** 把任意异常收敛成协议里的错误消息 */
export function toErrorMessage(id: string, error: unknown): ErrorMessage {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown };
    const code = typeof candidate.code === 'string' ? (candidate.code as AsrErrorCode) : 'UNKNOWN';
    const message =
      typeof candidate.message === 'string' && candidate.message
        ? candidate.message
        : '本地识别失败（未知错误）';
    return { type: 'error', id, code, message };
  }
  return { type: 'error', id, code: 'UNKNOWN', message: '本地识别失败（未知错误）' };
}
