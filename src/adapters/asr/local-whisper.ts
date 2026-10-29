/**
 * 本地 whisper 适配层（M2.5）—— UI 唯一入口。
 *
 *   transcribe(blob, opts) → 文本
 *   isAvailable()          → 模型目录是否可访问
 *
 * 关键取舍（详见 docs/ASR-NOTES.md）：
 * - 模型随应用发布（public/models/），运行时零下载：ModelScope 没有 CORS 头，直连已被证伪；
 * - 默认 whisper-base：tiny 中文实测出「打摩願」「於10邊」这类繁体+错字，base 是简体且可用；
 * - 音频转换零第三方依赖：AudioContext.decodeAudioData + OfflineAudioContext 重采样到 16kHz 单声道。
 */
import type { LocalModelId } from './protocol';
import { decodeAudioBlob } from './audio-decode';
import { AsrError } from './errors';
import {
  createWhisperClient,
  type AsrWorkerLike,
  type TranscribeOptions,
  type WhisperClient,
} from './worker-client';

export interface LocalModelInfo {
  id: LocalModelId;
  /** 给用户看的短名：base / tiny */
  label: string;
  sizeMB: number;
  note?: string;
}

/** 探测顺序 = 优先级：base 优先，tiny 只作为省空间备选 */
export const LOCAL_MODELS: readonly LocalModelInfo[] = [
  { id: 'whisper-base', label: 'base', sizeMB: 78 },
  { id: 'whisper-tiny', label: 'tiny', sizeMB: 44, note: '中文准确率明显更差' },
];

export const DEFAULT_LOCAL_MODEL_ID: LocalModelId = 'whisper-base';

/** 模型目录的绝对 URL：按页面 base 算，dev / 子路径部署 / file:// 打包都能用 */
export function modelsBaseUrl(): string {
  const base = import.meta.env.BASE_URL || '/';
  const normalized = base.endsWith('/') ? base : `${base}/`;
  const documentBase =
    typeof document !== 'undefined' && document.baseURI ? document.baseURI : 'http://localhost/';
  return new URL(`${normalized}models/`, documentBase).href;
}

export interface DetectDeps {
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  baseUrl?: string;
  /** 探测超时：模型目录是本地静态资源，超过这个时间基本就是没有 */
  timeoutMs?: number;
}

async function probeFile(
  fetchImpl: NonNullable<DetectDeps['fetchImpl']>,
  url: string,
  timeoutMs: number,
): Promise<boolean> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller?.signal,
    });
    return Boolean(response?.ok);
  } catch {
    return false;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * 探测随应用发布的模型：只看本地静态目录里有没有 config.json。
 * 不发任何跨域请求（同一 origin），也不碰 ModelScope / HF。
 */
export async function detectLocalModel(deps: DetectDeps = {}): Promise<LocalModelInfo | null> {
  const fetchImpl =
    deps.fetchImpl ?? (typeof fetch === 'function' ? (fetch as DetectDeps['fetchImpl']) : undefined);
  if (!fetchImpl) return null;

  const baseUrl = deps.baseUrl ?? modelsBaseUrl();
  const timeoutMs = deps.timeoutMs ?? 4000;

  for (const model of LOCAL_MODELS) {
    const url = new URL(`${model.id}/config.json`, baseUrl).href;
    if (await probeFile(fetchImpl, url, timeoutMs)) return model;
  }
  return null;
}

/** 供 UI 判断「C 项能不能点亮」 */
export async function isAvailable(): Promise<boolean> {
  return (await detectLocalModel()) !== null;
}

/* ------------------------------------------------------------------ */
/* 转写（模型探测结果按会话缓存，避免每次录音都发一轮探测）            */
/* ------------------------------------------------------------------ */

let resolvedModel: LocalModelInfo | null | undefined;

/** 测试用：清掉探测缓存 */
export function resetLocalModelCache(): void {
  resolvedModel = undefined;
}

async function resolveModel(): Promise<LocalModelInfo> {
  if (resolvedModel === undefined) resolvedModel = await detectLocalModel();
  if (!resolvedModel) {
    throw new AsrError(
      'MODEL_MISSING',
      '没找到本地模型（public/models/whisper-base 或 whisper-tiny）',
    );
  }
  return resolvedModel;
}

function createAsrWorker(): AsrWorkerLike {
  if (typeof Worker === 'undefined') {
    throw new AsrError('LOAD_FAILED', '当前环境不支持 Web Worker，无法本地转写');
  }
  return new Worker(new URL('../../workers/asr.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as AsrWorkerLike;
}

let client: WhisperClient | null = null;
let clientModelId: LocalModelId | null = null;

function getClient(model: LocalModelInfo): WhisperClient {
  if (client && clientModelId === model.id) return client;
  client?.dispose();
  client = createWhisperClient({
    createWorker: createAsrWorker,
    decode: (blob) => decodeAudioBlob(blob),
    modelBaseUrl: modelsBaseUrl(),
    modelId: model.id,
    language: 'chinese',
  });
  clientModelId = model.id;
  return client;
}

export interface LocalTranscribeOptions extends TranscribeOptions {
  /** 只在需要强制重探测时用（例如用户刚跑完 npm run model:whisper） */
  refreshModel?: boolean;
}

/** Blob（webm/opus、mp4…）→ 中文文本。失败抛 AsrError（带 code，UI 据此给人话） */
export async function transcribe(
  blob: Blob,
  options: LocalTranscribeOptions = {},
): Promise<string> {
  if (options.refreshModel) resetLocalModelCache();

  const model = await resolveModel();
  try {
    return await getClient(model).transcribe(blob, {
      language: options.language,
      onProgress: options.onProgress,
      signal: options.signal,
    });
  } catch (error) {
    // 模型目录被删/加载失败时，下次重新探测一遍，而不是一直用坏结果
    if (error instanceof AsrError && (error.code === 'MODEL_MISSING' || error.code === 'LOAD_FAILED')) {
      resetLocalModelCache();
    }
    throw error;
  }
}

/** UI 注入用的最小接口（测试里传假的即可） */
export interface AsrAdapter {
  transcribe(blob: Blob, options?: LocalTranscribeOptions): Promise<string>;
}

export const localWhisperAdapter: AsrAdapter = { transcribe };

/** 关闭 Worker（页面卸载时可选调用；模型缓存也随之释放） */
export function disposeLocalWhisper(): void {
  client?.dispose();
  client = null;
  clientModelId = null;
}
