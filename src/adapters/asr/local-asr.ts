/**
 * 本地语音模型适配层 —— UI 唯一入口。
 *
 *   transcribe(blob, opts) → 文本
 *   isAvailable()          → 模型是否就绪（下载过 / 静态目录里有）
 *
 * 模型是 SenseVoice-Small（onnxruntime-web），不再是 whisper：
 * 同样的 3 分钟录音，whisper-base 只转出前 30 秒、没有标点、同音字错一半；
 * SenseVoice 一次给全文、自带标点。对照实验见 docs。
 *
 * 从哪加载：Cache Storage（用户点下载）→ 静态目录（桌面版/开发机）。
 */
import type { LocalModelId } from './protocol';
import { decodeAudioBlob } from './audio-decode';
import { AsrError } from './errors';
import { MODEL_PACKS, isPackCached } from './model-store';
import {
  createWhisperClient,
  type AsrWorkerLike,
  type TranscribeOptions,
  type WhisperClient,
} from './worker-client';

export interface LocalModelInfo {
  id: LocalModelId;
  /** 给用户看的短名 */
  label: string;
  /** 占用空间（MB） */
  sizeMB: number;
  note?: string;
}

/** 可下载的本地模型（来自统一的模型包清单） */
export const LOCAL_MODELS: readonly LocalModelInfo[] = MODEL_PACKS.map((pack) => ({
  id: pack.id,
  label: pack.label,
  sizeMB: pack.sizeMB,
}));

export const DEFAULT_LOCAL_MODEL_ID: LocalModelId = 'sense-voice';

/** 模型目录的绝对 URL */
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
  timeoutMs?: number;
  /** 测试用：跳过 Cache Storage 查询 */
  skipCache?: boolean;
}

async function probeFile(
  fetchImpl: NonNullable<DetectDeps['fetchImpl']>,
  url: string,
  timeoutMs: number,
): Promise<boolean> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(url, { method: 'GET', cache: 'no-store', signal: controller?.signal });
    if (!response?.ok) return false;
    // 只认 200 不够：静态托管在文件不存在时会回退 index.html 并返回 200。
    const text = await response.text();
    return !text.trimStart().startsWith('<');
  } catch {
    return false;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * 探测模型在哪：
 * 1. **浏览器缓存**（用户点过「下载」）；
 * 2. 站点静态目录 `public/models/`（桌面版 / 开发机）。
 */
export async function detectLocalModel(deps: DetectDeps = {}): Promise<LocalModelInfo | null> {
  const baseUrl = deps.baseUrl ?? modelsBaseUrl();

  for (const model of LOCAL_MODELS) {
    if (deps.skipCache !== true && (await isPackCached(model.id))) return model;

    const fetchImpl =
      deps.fetchImpl ?? (typeof fetch === 'function' ? (fetch as DetectDeps['fetchImpl']) : undefined);
    if (!fetchImpl) continue;
    const url = new URL(`${model.id}/tokens.txt`, baseUrl).href;
    if (await probeFile(fetchImpl, url, deps.timeoutMs ?? 4000)) return model;
  }
  return null;
}

/** 供 UI 判断「本地模型这一项能不能选」 */
export async function isAvailable(): Promise<boolean> {
  return (await detectLocalModel()) !== null;
}

/* ------------------------------------------------------------------ */
/* 转写（探测结果按会话缓存，避免每次录音都发一轮探测）                */
/* ------------------------------------------------------------------ */

let resolvedModel: LocalModelInfo | null | undefined;

export function resetLocalModelCache(): void {
  resolvedModel = undefined;
}

async function resolveModel(): Promise<LocalModelInfo> {
  if (resolvedModel === undefined) resolvedModel = await detectLocalModel();
  if (!resolvedModel) {
    throw new AsrError('MODEL_MISSING', '本地模型还没下载');
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
  /** 强制重新探测（例如用户刚下载完模型） */
  refreshModel?: boolean;
}

/** Blob（webm/opus、mp4…）→ 中文文本。失败抛 AsrError（带 code，UI 据此给人话） */
export async function transcribe(blob: Blob, options: LocalTranscribeOptions = {}): Promise<string> {
  if (options.refreshModel) resetLocalModelCache();

  const model = await resolveModel();
  try {
    return await getClient(model).transcribe(blob, {
      language: options.language,
      onProgress: options.onProgress,
      signal: options.signal,
    });
  } catch (error) {
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

export const localAsrAdapter: AsrAdapter = { transcribe };

/** 兼容旧名字 */
export const localWhisperAdapter = localAsrAdapter;

export function disposeLocalAsr(): void {
  client?.dispose();
  client = null;
  clientModelId = null;
}

export const disposeLocalWhisper = disposeLocalAsr;
