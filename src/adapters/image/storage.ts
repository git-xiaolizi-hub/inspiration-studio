/**
 * 生图结果落盘。
 *
 * 为什么必须立刻下载：两家官方文档都写明了链接会失效（智谱 30 天 / 方舟 24 小时），
 * 而"用户当天生成、第二天回来分享"是这类工具最常见的用法。
 * 二进制进 `media` 表（那本来就是"二进制本体"的仓库），元数据由 `core/artifacts` 记。
 *
 * ⚠️ blob URL 这两个小工具**故意没有 import `video/storage`**：
 * 视频模块是可以整块删掉的（`video-decoupling.test.ts` 盯着这件事），
 * 图片模块反向依赖它会让"删视频"变成"删不动"。二十行重复换一条解耦边界，值得。
 */
import { getRecord, putRecord } from '../../core/storage';
import type { ImageArtifact, ImageUrlTtl } from './types';

export function imageArtifactId(key: string): string {
  return `image:${key}`;
}

/** media 表主键：与 artifacts 的 id 同源，便于按 key 找回 */
export function imageBlobId(key: string): string {
  return `image-blob:${key}`;
}

export interface SaveImageBlobInput {
  key: string;
  blob: Blob;
  remoteUrl: string;
  ttl: ImageUrlTtl;
  mimeType?: string;
  now?: () => number;
}

/** 把字节存进 media 表并返回落盘描述（不发任何请求） */
export async function saveImageBlob(input: SaveImageBlobInput): Promise<ImageArtifact> {
  const now = (input.now ?? Date.now)();
  const mimeType = input.mimeType || input.blob.type || 'image/png';
  const blobId = imageBlobId(input.key);

  // 复用存储层的配额预检与错误翻译（不绕过 core/storage）
  await putRecord('media', {
    id: blobId,
    // 故意不写记录 id：写成记录 id 会被"删记录级联删音频"顺手删掉，
    // 而图片产物的生命周期由 `core/artifacts` 自己管（见报告 §3.3）
    recordId: `artifact:${input.key}`,
    blob: new Blob([input.blob], { type: mimeType }),
    mimeType,
    durationMs: 0,
    createdAt: now,
  });

  return {
    id: imageArtifactId(input.key),
    remoteUrl: input.remoteUrl,
    blob: input.blob,
    mimeType,
    size: input.blob.size,
    createdAt: now,
    expiresAt: now + input.ttl.ms,
    ttlVerified: input.ttl.verified,
    ttlNote: input.ttl.note,
  };
}

/** 读回落盘的图片（详情页渲染用） */
export async function getStoredImage(
  blobId: string,
): Promise<{ blob: Blob; mimeType: string } | undefined> {
  const row = await getRecord<{ id: string; blob: Blob; mimeType: string }>('media', blobId);
  if (!row) return undefined;
  return { blob: row.blob, mimeType: row.mimeType };
}

/** blob URL：环境不支持时给出可读错误，而不是返回一个假地址（同 video） */
export function makeBlobUrl(blob: Blob): string {
  const factory = typeof URL !== 'undefined' ? URL.createObjectURL : undefined;
  if (typeof factory !== 'function') {
    throw new Error('当前环境不支持 URL.createObjectURL，无法生成本地预览地址');
  }
  return factory.call(URL, blob);
}

export function revokeBlobUrl(url: string): void {
  if (!url.startsWith('blob:')) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // 已释放或环境不支持：忽略
  }
}

/** `data:image/png;base64,...` 或裸 base64 → Blob（Ark 的 `b64_json` 分支） */
export function b64ToBlob(b64: string, fallbackMime = 'image/png'): Blob {
  const trimmed = b64.trim();
  const match = /^data:([^;]+);base64,(.*)$/s.exec(trimmed);
  const mimeType = match ? match[1] : fallbackMime;
  const payload = match ? match[2] : trimmed;

  const binary =
    typeof atob === 'function'
      ? atob(payload)
      : // jsdom / 老环境兜底
        Buffer.from(payload, 'base64').toString('binary');

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/**
 * UI 提示文案。
 * `verified === false` 时必须把「未核实」写在同一行 —— 不能只说"约 24 小时失效"，
 * 那会把一个没查证的数字说成官方口径（UI-SKELETON §4）。
 */
export function imageTtlNotice(
  artifact: Pick<ImageArtifact, 'expiresAt' | 'ttlNote' | 'ttlVerified'>,
  now: number = Date.now(),
): string {
  const remainingMs = Math.max(0, artifact.expiresAt - now);
  const hours = Math.round((remainingMs / 3_600_000) * 10) / 10;
  const prefix = artifact.ttlVerified ? '' : '（未核实）';
  if (remainingMs <= 0) {
    return `远端图片地址已过期${prefix}：${artifact.ttlNote}；本地副本仍可用`;
  }
  return `远端图片地址约 ${hours} 小时后失效${prefix}：${artifact.ttlNote}；本地副本已保存，不受影响`;
}
