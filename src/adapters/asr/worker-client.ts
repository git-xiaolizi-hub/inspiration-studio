/**
 * 主线程 ↔ ASR Worker 的客户端（M2.5）。
 *
 * 职责边界：
 * - 主线程只做「Blob → 16kHz PCM」（audio-decode）与消息收发；
 * - 推理、模型加载全在 Worker；worker 创建与音频解码都可注入，测试里用假实现即可
 *   （jsdom 既没有 Worker 也没有 AudioContext）。
 *
 * 取消语义：主线程发 { type:'cancel', id }，立刻让调用方拿到 CANCELLED，
 * worker 那边即使算出结果也会丢弃（见 asr-worker-core）。
 */
import type { AsrResponse, LocalModelId } from './protocol';
import { AsrError } from './errors';
import type { TranscriptProgress } from '../../workers/asr-worker-core';

/** Worker 的最小可测子集（jsdom 里没有真 Worker） */
export interface AsrWorkerLike {
  postMessage(message: unknown): void;
  terminate?: () => void;
  onmessage: ((event: { data: AsrResponse }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
}

export interface TranscribeOptions {
  language?: string;
  onProgress?: (progress: TranscriptProgress) => void;
  signal?: AbortSignal;
}

export interface WhisperClientOptions {
  createWorker: () => AsrWorkerLike;
  decode: (blob: Blob) => Promise<Float32Array>;
  /** 模型目录绝对 URL（以 / 结尾） */
  modelBaseUrl: string;
  modelId: LocalModelId;
  language?: string;
  /** 请求 id 生成用，测试可注入递增函数 */
  now?: () => number;
}

export interface WhisperClient {
  transcribe(blob: Blob, options?: TranscribeOptions): Promise<string>;
  dispose(): void;
}

interface PendingEntry {
  resolve: (text: string) => void;
  reject: (error: unknown) => void;
  onProgress?: (progress: TranscriptProgress) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export function createWhisperClient(options: WhisperClientOptions): WhisperClient {
  const pending = new Map<string, PendingEntry>();
  const now = options.now ?? (() => Date.now());
  let worker: AsrWorkerLike | null = null;
  let seq = 0;

  function settle(id: string): PendingEntry | undefined {
    const entry = pending.get(id);
    if (!entry) return undefined;
    pending.delete(id);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    return entry;
  }

  function failAll(error: unknown): void {
    for (const id of [...pending.keys()]) settle(id)?.reject(error);
  }

  function handleMessage(message: AsrResponse): void {
    if (!message || typeof message !== 'object') return;
    const entry = pending.get(message.id);
    if (!entry) return; // 已取消/已结束的请求，迟到消息直接丢

    if (message.type === 'progress') {
      entry.onProgress?.({ stage: message.stage, pct: message.pct });
      return;
    }
    if (message.type === 'result') {
      settle(message.id)?.resolve(message.text);
      return;
    }
    if (message.type === 'error') {
      settle(message.id)?.reject(new AsrError(message.code, message.message));
    }
  }

  function ensureWorker(): AsrWorkerLike {
    if (worker) return worker;
    const created = options.createWorker();
    created.onmessage = (event) => handleMessage(event?.data as AsrResponse);
    created.onerror = () => {
      // Worker 整体挂了：把所有等待中的请求都按「加载失败」处理，别让 UI 永远转圈
      failAll(new AsrError('LOAD_FAILED', '本地识别模块启动失败（Worker 异常）'));
    };
    worker = created;
    return created;
  }

  async function transcribe(blob: Blob, opts: TranscribeOptions = {}): Promise<string> {
    if (!blob || blob.size === 0) {
      throw new AsrError('BAD_AUDIO', '录音是空的，没有可转写的内容');
    }
    if (opts.signal?.aborted) throw new AsrError('CANCELLED', '已取消转写');

    const audio = await options.decode(blob);
    // 解码可能耗时几秒，期间用户点了取消
    if (opts.signal?.aborted) throw new AsrError('CANCELLED', '已取消转写');
    if (!audio || audio.length === 0) {
      throw new AsrError('BAD_AUDIO', '录音里没有可识别的声音');
    }

    const activeWorker = ensureWorker();
    seq += 1;
    const id = `asr-${seq}-${now()}`;

    return new Promise<string>((resolve, reject) => {
      const entry: PendingEntry = { resolve, reject, onProgress: opts.onProgress, signal: opts.signal };

      if (opts.signal) {
        entry.onAbort = () => {
          if (!pending.has(id)) return;
          settle(id);
          activeWorker.postMessage({ type: 'cancel', id });
          reject(new AsrError('CANCELLED', '已取消转写'));
        };
        opts.signal.addEventListener('abort', entry.onAbort, { once: true });
      }

      pending.set(id, entry);
      activeWorker.postMessage({
        type: 'transcribe',
        id,
        audio,
        language: opts.language ?? options.language ?? 'chinese',
        modelBaseUrl: options.modelBaseUrl,
        modelId: options.modelId,
      });
    });
  }

  return {
    transcribe,
    dispose() {
      failAll(new AsrError('CANCELLED', '本地识别已关闭'));
      try {
        worker?.terminate?.();
      } catch {
        // 已经终止过就算了
      }
      worker = null;
    },
  };
}
