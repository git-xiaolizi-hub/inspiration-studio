/**
 * 本地语音模型的「规格」：只放常量，不带任何依赖。
 *
 * 为什么要单独一个文件：Worker（whisper-pipeline）只需要桶名，
 * 如果从 model-store.ts 里拿，会把 JSZip 打进 Worker 包。这里零依赖，谁都能安全引用。
 */
import type { LocalModelId } from './protocol';

/** Cache Storage 的桶名。删桶即卸载模型。 */
export const MODEL_CACHE_NAME = 'hermes-asr-models';

export interface ModelPack {
  id: LocalModelId;
  /** 给用户看的短名 */
  label: string;
  /** 解压后占用的空间（MB） */
  sizeMB: number;
  /** 压缩包大小（MB），用于下载前的提示 */
  zipMB: number;
  /** 站点内 model-packs/ 下的文件名 */
  fileName: string;
}

export const MODEL_PACKS: readonly ModelPack[] = [
  { id: 'whisper-base', label: 'base', sizeMB: 78, zipMB: 52, fileName: 'whisper-base.zip' },
];

export function findPack(id: LocalModelId): ModelPack | null {
  return MODEL_PACKS.find((pack) => pack.id === id) ?? null;
}
