/**
 * Worker 内核（M2.5）：消息协议 + 取消 + 进度，全部与 transformers.js 解耦。
 *
 * 为什么要拆出这一层：真正的推理只能在浏览器 Worker 里跑（需要 WASM + 模型文件），
 * 但「消息如何分发、取消如何丢弃结果、错误如何归一」是纯逻辑，可以 100% 单测。
 * `asr.worker.ts` 只剩十几行胶水。
 */
import type {
  AsrErrorCode,
  AsrResponse,
  AsrStage,
  LocalModelId,
  TranscribeRequest,
} from '../adapters/asr/protocol';
import { toErrorMessage } from '../adapters/asr/protocol';

export interface TranscriptProgress {
  stage: AsrStage;
  pct: number;
}

export interface TranscriberOptions {
  language?: string;
}

/** 已就绪的转写函数：吃 16kHz 单声道 PCM，吐文本 */
export type Transcriber = (
  audio: Float32Array,
  options: TranscriberOptions,
) => Promise<{ text: string }>;

export interface CreateTranscriberOptions {
  modelBaseUrl: string;
  modelId: LocalModelId;
  onProgress: (progress: TranscriptProgress) => void;
}

export type TranscriberFactory = (options: CreateTranscriberOptions) => Promise<Transcriber>;

export interface AsrWorkerCoreOptions {
  createTranscriber: TranscriberFactory;
  post: (message: AsrResponse) => void;
}

export interface AsrWorkerCore {
  /** 收到一条消息就调它（worker 的 message 事件把 event.data 传进来） */
  handle(message: unknown): void;
  /** 还在处理中的请求数（测试断言「取消后不再有结果」用） */
  pendingCount(): number;
  /** 已取消但还没收到请求的 id 数（测试用） */
  cancelledCount(): number;
}

function isTranscribeRequest(value: unknown): value is TranscribeRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TranscribeRequest>;
  return (
    candidate.type === 'transcribe' &&
    typeof candidate.id === 'string' &&
    candidate.audio instanceof Float32Array &&
    typeof candidate.modelBaseUrl === 'string' &&
    (candidate.modelId === 'sense-voice')
  );
}

export function createAsrWorkerCore({ createTranscriber, post }: AsrWorkerCoreOptions): AsrWorkerCore {
  /** 被取消的请求 id：迟到的结果直接丢弃，不回主线程 */
  const cancelled = new Set<string>();
  const inFlight = new Set<Promise<void>>();

  async function runTranscribe(request: TranscribeRequest): Promise<void> {
    const { id } = request;
    const isCancelled = () => cancelled.has(id);
    let phase: 'load' | 'infer' = 'load';

    const report = (progress: TranscriptProgress) => {
      if (isCancelled()) return;
      post({ type: 'progress', id, stage: progress.stage, pct: progress.pct });
    };

    try {
      report({ stage: 'loading-model', pct: 0 });
      const transcriber = await createTranscriber({
        modelBaseUrl: request.modelBaseUrl,
        modelId: request.modelId,
        onProgress: report,
      });
      if (isCancelled()) return;

      phase = 'infer';
      report({ stage: 'transcribing', pct: 0 });
      const output = await transcriber(request.audio, { language: request.language });
      if (isCancelled()) return;

      post({ type: 'result', id, text: typeof output?.text === 'string' ? output.text : '' });
    } catch (error) {
      if (isCancelled()) return;
      const message = toErrorMessage(id, error);
      if (message.code === 'UNKNOWN') {
        const fallback: AsrErrorCode = phase === 'load' ? 'LOAD_FAILED' : 'TRANSCRIBE_FAILED';
        post({ ...message, code: fallback, message: `${message.message}（${fallback}）` });
        return;
      }
      post(message);
    } finally {
      cancelled.delete(id);
    }
  }

  return {
    handle(message: unknown) {
      if (!message || typeof message !== 'object') return;
      const type = (message as { type?: unknown }).type;

      if (type === 'cancel') {
        const id = (message as { id?: unknown }).id;
        if (typeof id === 'string') cancelled.add(id);
        return;
      }

      if (type !== 'transcribe') return;

      if (!isTranscribeRequest(message)) {
        const id = typeof (message as { id?: unknown }).id === 'string' ? (message as { id: string }).id : '';
        post({
          type: 'error',
          id,
          code: 'BAD_AUDIO',
          message: '转写请求格式不对：音频必须是 Float32Array，且要带模型目录地址',
        });
        return;
      }

      if (cancelled.has(message.id)) {
        // 极端情况：取消比请求先到 —— 直接丢弃，别白跑一次推理
        cancelled.delete(message.id);
        return;
      }

      const task = runTranscribe(message);
      inFlight.add(task);
      void task.then(() => inFlight.delete(task));
    },
    pendingCount() {
      return inFlight.size;
    },
    cancelledCount() {
      return cancelled.size;
    },
  };
}
