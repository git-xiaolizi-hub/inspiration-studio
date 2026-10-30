/**
 * 本地模型的通用位置常量 + 缓存键（零依赖，主线程和 Worker 都能安全引用）。
 *
 * 之前这些放在 model-store.ts 里，但那个文件 import 了 JSZip，
 * 被 Worker 引用会把解压库一起打进 Worker 包 —— 所以拆出来。
 */
import type { LocalModelId } from './protocol';

/** Cache Storage 的桶名。删桶即卸载模型。 */
export const MODEL_CACHE_NAME = 'hermes-asr-models';

export interface ModelPack {
  id: LocalModelId;
  /** 给用户看的名字 */
  label: string;
  /** 下载总大小（MB） */
  downloadMB: number;
  /** 占用的空间（MB） */
  sizeMB: number;
  /**
   * 站点 `public/model-packs/<id>/` 下的文件清单。
   * onnx 因为超过 GitHub Pages 单文件 100MB 上限，被切成若干 `*.partNN`，
   * 下载后按顺序拼回一个整体。
   */
  files: string[];
  /** 拼回之后的文件名（存缓存用） */
  modelFile: string;
  /** 词表 */
  tokensFile: string;
}

export const MODEL_PACKS: readonly ModelPack[] = [
  {
    id: 'sense-voice',
    label: 'SenseVoice',
    downloadMB: 229,
    sizeMB: 229,
    files: ['model.int8.onnx.part00', 'model.int8.onnx.part01', 'model.int8.onnx.part02', 'tokens.txt'],
    modelFile: 'model.int8.onnx',
    tokensFile: 'tokens.txt',
  },
];

export function findPack(id: LocalModelId): ModelPack | null {
  return MODEL_PACKS.find((pack) => pack.id === id) ?? null;
}

/** 模型目录的绝对 URL（dev / 子路径部署都能用） */
export function modelsDirUrl(): string {
  const base = import.meta.env.BASE_URL || '/';
  const normalized = base.endsWith('/') ? base : `${base}/`;
  const documentBase =
    typeof globalThis.document !== 'undefined' && globalThis.document.baseURI
      ? globalThis.document.baseURI
      : 'http://localhost/';
  return new URL(`${normalized}models/`, documentBase).href;
}

/** 单个模型文件的缓存键：与 transformers / ORT 读取时用的路径口径一致 */
export function modelFileKey(id: LocalModelId, relativePath: string): string {
  return new URL(`${id}/${relativePath}`, modelsDirUrl()).href;
}

/** 压缩包/分片在站点内的地址 */
export function packPartUrl(id: LocalModelId, file: string): string {
  const base = import.meta.env.BASE_URL || '/';
  const normalized = base.endsWith('/') ? base : `${base}/`;
  const documentBase =
    typeof globalThis.document !== 'undefined' && globalThis.document.baseURI
      ? globalThis.document.baseURI
      : 'http://localhost/';
  return new URL(`${normalized}model-packs/${id}/${file}`, documentBase).href;
}
