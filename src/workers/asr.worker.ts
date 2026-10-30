/**
 * ASR Worker 入口（M2.5）。
 *
 * 这个文件只做三件事：把 `self` 包成最小端口、把内核接上、把消息转进去。
 * 所有可测逻辑在 `asr-worker-core.ts`；所有 onnxruntime 细节在 `sensevoice-pipeline.ts`
 * —— 后者只在 Worker 里被 import，主包不会被 78MB 模型库拖大。
 */
import { createAsrWorkerCore } from './asr-worker-core';
import { createLocalTranscriber } from './sensevoice-pipeline';
import type { AsrResponse } from '../adapters/asr/protocol';

interface WorkerPort {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

const port = globalThis as unknown as WorkerPort;

const core = createAsrWorkerCore({
  createTranscriber: createLocalTranscriber,
  post: (message: AsrResponse) => port.postMessage(message),
});

port.addEventListener('message', (event) => core.handle(event.data));
