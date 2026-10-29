/**
 * 「图片源 / 视频源」节点的素材层（M5b4 §4.1）。
 *
 * 三条硬约束（任务书原文）：
 * 1. 节点里**只存引用**（`sourceArtifactId` / `sourceMediaId`），不把 base64 塞进工作流 JSON
 *    —— 否则一次保存就是几十 MB，IndexedDB 与备份都会炸；
 * 2. 体积上限在**进库之前**就拒绝（图片 10MB / 视频 100MB），
 *    不让用户等到 IndexedDB 报一个看不懂的错误；
 * 3. 「已有产物」与「本地上传」走**同一个出口**（`resolveSourceMedia`），
 *    下游（生视频的首帧图 / 参考视频口 / 输出节点）不需要知道素材是从哪来的。
 */

import { getArtifact, readBlobId } from '../../core/artifacts';
import { getDatabase } from '../../core/storage/db';
import { getRecord, putRecord } from '../../core/storage';
import type { MediaRef } from './executor';
import type { ExecNode, WFNodeData } from './types';

/** 图片源上限 10MB（任务书 §4.1） */
export const IMAGE_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
/** 视频源上限 100MB（任务书 §4.1） */
export const VIDEO_SOURCE_MAX_BYTES = 100 * 1024 * 1024;

export type SourceKind = 'image' | 'video';

export const SOURCE_MAX_BYTES: Record<SourceKind, number> = {
  image: IMAGE_SOURCE_MAX_BYTES,
  video: VIDEO_SOURCE_MAX_BYTES,
};

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const KIND_LABEL: Record<SourceKind, string> = { image: '图片', video: '视频' };

/**
 * 进库前的体积检查（**纯函数**，UI 与测试共用同一句文案）。
 * 返回 null = 通过；返回字符串 = 拒绝原因（提前拒绝，不发请求、不写库）。
 */
export function checkSourceFileSize(kind: SourceKind, size: number): string | null {
  const max = SOURCE_MAX_BYTES[kind];
  if (!Number.isFinite(size) || size <= 0) {
    return `${KIND_LABEL[kind]}文件是空的（0 字节）：换一个文件`;
  }
  if (size > max) {
    return `${KIND_LABEL[kind]}不能超过 ${formatSize(max)}（这个文件 ${formatSize(size)}）：换一个小一点的，或先压缩`;
  }
  return null;
}

/** 图片源只接 image/*、视频源只接 video/*（用 MIME 判断，不看扩展名） */
export function checkSourceFileType(kind: SourceKind, mimeType: string): string | null {
  if (mimeType.trim() === '') return null; // 有些浏览器/系统给不出 type，交给后面的真实读取失败去报
  if (mimeType.startsWith(`${kind}/`)) return null;
  return `${KIND_LABEL[kind]}源只能放${KIND_LABEL[kind]}：这个文件是 ${mimeType}`;
}

export interface SourceFileInput {
  name: string;
  size: number;
  type: string;
}

/** 一次做完两个检查（UI 的 onChange 里第一句就是它） */
export function checkSourceFile(kind: SourceKind, file: SourceFileInput): string | null {
  return checkSourceFileSize(kind, file.size) ?? checkSourceFileType(kind, file.type);
}

function makeSourceId(): string {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  const suffix =
    globalCrypto && typeof globalCrypto.randomUUID === 'function'
      ? globalCrypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return `workflow-source:${suffix}`;
}

/** blob: 预览地址：环境不支持（jsdom）时返回空串，绝不抛 */
export function safeObjectUrl(blob: Blob): string {
  const factory = typeof URL !== 'undefined' ? URL.createObjectURL : undefined;
  if (typeof factory !== 'function') return '';
  try {
    return factory.call(URL, blob);
  } catch {
    return '';
  }
}

export interface StoredSourceFile {
  sourceMediaId: string;
  fileName: string;
  fileSize: number;
}

/**
 * 上传：字节进 `media` 表（与音频/图片/视频同一套约定），返回要写进节点 data 的引用。
 * 超限在这里再拒一次（UI 已经拒过；直接调这个函数时也不能写进去）。
 */
export async function storeSourceFile(
  kind: SourceKind,
  file: SourceFileInput & { arrayBuffer: () => Promise<ArrayBuffer> },
): Promise<StoredSourceFile> {
  const problem = checkSourceFile(kind, file);
  if (problem !== null) throw new Error(problem);

  const id = makeSourceId();
  const mimeType = file.type.trim() === '' ? `${kind}/*` : file.type;
  const blob = new Blob([await file.arrayBuffer()], { type: mimeType });
  await putRecord('media', {
    id,
    // 故意不用记录 id：写成记录 id 会被"删记录级联删音频"顺手删掉
    recordId: id,
    blob,
    mimeType,
    durationMs: 0,
    createdAt: Date.now(),
  });
  return { sourceMediaId: id, fileName: file.name, fileSize: file.size };
}

/** 媒体行（media 表里那一条）；`remoteUrl` 是历史产物才有的公网地址 */
interface MediaRowLike {
  id: string;
  blob?: Blob;
  mimeType?: string;
  recordId?: string;
  createdAt?: number;
  remoteUrl?: string;
  size?: number;
}

/** 下拉里的一项：`ref` 直接写进节点 data */
export interface SourceOption {
  key: string;
  ref: Pick<WFNodeData, 'sourceArtifactId' | 'sourceMediaId'>;
  label: string;
  mimeType: string;
  size: number;
  /** 预览地址（blob:）；拿不到就是空串 —— 假地址比没有更糟 */
  url: string;
  /** 公网地址（只有远端产物才有；参考视频必须要它） */
  publicUrl?: string;
  createdAt: number;
}

function payloadField(payload: unknown, key: string): unknown {
  if (payload === null || typeof payload !== 'object') return undefined;
  return (payload as Record<string, unknown>)[key];
}

/**
 * 「已有产物」列表（按时间倒序）。
 * - 图片：`artifacts` 表里 kind=image 的那些（画板生成 / 创作页生成的都在这里）；
 * - 视频：`media` 表里 mimeType=video/* 的那些（视频本来就不进 artifacts，见 M4b 报告的取舍）。
 */
export async function listSourceOptions(kind: SourceKind): Promise<SourceOption[]> {
  const options: SourceOption[] = [];

  if (kind === 'image') {
    const rows = await getDatabase()
      .artifacts.where('kind')
      .equals('image')
      .toArray();
    for (const row of rows) {
      const blobId = readBlobId(row.payload);
      const media = blobId ? await getRecord<MediaRowLike>('media', blobId) : undefined;
      const url = media?.blob ? safeObjectUrl(media.blob) : '';
      const prompt = payloadField(row.payload, 'prompt');
      options.push({
        key: `artifact:${row.id}`,
        ref: { sourceArtifactId: row.id },
        label: typeof prompt === 'string' && prompt.trim() !== '' ? prompt.trim().slice(0, 40) : row.id,
        mimeType: media?.mimeType ?? 'image/png',
        size: media?.blob?.size ?? Number(payloadField(row.payload, 'size') ?? 0),
        url,
        publicUrl:
          typeof payloadField(row.payload, 'remoteUrl') === 'string'
            ? (payloadField(row.payload, 'remoteUrl') as string)
            : undefined,
        createdAt: row.createdAt,
      });
    }
    options.sort((a, b) => b.createdAt - a.createdAt);
    return options;
  }

  const rows = (await getDatabase().media.toArray()) as MediaRowLike[];
  for (const row of rows) {
    const mimeType = row.mimeType ?? '';
    if (!mimeType.startsWith('video/')) continue;
    options.push({
      key: `media:${row.id}`,
      ref: { sourceMediaId: row.id },
      label: row.id,
      mimeType,
      size: row.blob?.size ?? row.size ?? 0,
      url: row.blob ? safeObjectUrl(row.blob) : '',
      publicUrl: typeof row.remoteUrl === 'string' && row.remoteUrl !== '' ? row.remoteUrl : undefined,
      createdAt: row.createdAt ?? 0,
    });
  }
  options.sort((a, b) => b.createdAt - a.createdAt);
  return options;
}

/**
 * 节点 → 可以交给下游 / 适配器的素材。
 * 拿不到字节或引用为空时**抛可读错误**（执行器会把它写进节点的 error）。
 */
export async function resolveSourceMedia(node: ExecNode): Promise<MediaRef> {
  const data = node.data;
  const want: SourceKind = node.type === 'videoSource' ? 'video' : 'image';
  const kindLabel = want === 'image' ? '图片源' : '视频源';

  if (data.sourceArtifactId) {
    const artifact = await getArtifact(data.sourceArtifactId);
    if (!artifact) {
      throw new Error(`这个「${kindLabel}」指向的产物已经不在了（${data.sourceArtifactId}）：重新选一张`);
    }
    const blobId = readBlobId(artifact.payload);
    const media = blobId ? await getRecord<MediaRowLike>('media', blobId) : undefined;
    const mimeType = media?.mimeType ?? (payloadField(artifact.payload, 'mimeType') as string) ?? '';
    const remoteUrl = payloadField(artifact.payload, 'remoteUrl');
    return {
      kind: want,
      url: media?.blob ? safeObjectUrl(media.blob) : '',
      mimeType,
      artifactId: artifact.id,
      blobId,
      publicUrl: typeof remoteUrl === 'string' && /^https?:\/\//i.test(remoteUrl) ? remoteUrl : undefined,
      name: data.fileName,
      size: media?.blob?.size ?? data.fileSize,
    };
  }

  if (data.sourceMediaId) {
    const row = await getRecord<MediaRowLike>('media', data.sourceMediaId);
    if (!row) {
      throw new Error(`这个「${kindLabel}」上传的文件已经不在了（${data.sourceMediaId}）：重新上传一次`);
    }
    return {
      kind: want,
      url: row.blob ? safeObjectUrl(row.blob) : '',
      mimeType: row.mimeType ?? `${want}/*`,
      blobId: row.id,
      publicUrl:
        typeof row.remoteUrl === 'string' && /^https?:\/\//i.test(row.remoteUrl) ? row.remoteUrl : undefined,
      name: data.fileName,
      size: row.blob?.size ?? data.fileSize,
    };
  }

  throw new Error(`「${kindLabel}」还没选素材：从已有产物里选一个，或上传本地文件`);
}
