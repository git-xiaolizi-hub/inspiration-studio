/**
 * 素材分流（任务书 §4.2 第 1 条 / CHARTER §2 M4b「素材路径策略」）。
 *
 * 三档，**只按体积和类型判断，不猜服务端**：
 *   1. 图片 / 音频 < 5MB 且手上有字节 → 转 `data:<mime>;base64,...`；
 *   2. ≥ 5MB 的图片/音频、**所有视频** → 必须有公网 URL，没有就抛可读错误（三条出路）；
 *   3. 请求体总大小 ≤ 64MB，拼接前先估算、提前拒绝（不发请求）。
 *
 * 为什么不把 6MB 图直接内联：官方限制单图 30MB 是"接受上限"，
 * 但任务书定的产品策略是 5MB 以上走 URL（请求体 64MB 上限下，内联多张会炸）。
 */
import {
  AUDIO_MAX_BYTES,
  IMAGE_MAX_BYTES,
  INLINE_MEDIA_MAX_BYTES,
  REQUEST_BODY_MAX_BYTES,
  VIDEO_MAX_BYTES,
} from './constants';
import { VideoError } from './errors';
import type { MediaAsset, ResolvedMedia } from './types';

export function formatBytes(bytes: number): string {
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

/** 只接受 http/https；`data:`、`blob:`、本地路径都不能当公网 URL 用 */
export function isPublicHttpUrl(value: string | undefined): boolean {
  if (!value) return false;
  return /^https?:\/\/[^\s]+$/i.test(value.trim());
}

/** 字节 → base64（浏览器/jsdom 都有 btoa；按块处理避免 String.fromCharCode 参数过多） */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== 'function') {
    throw new VideoError('invalid_media', '当前环境没有 btoa，无法把素材转成 base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function toDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

function mimeMatches(kind: MediaAsset['kind'], mimeType: string): boolean {
  if (!mimeType) return false;
  if (kind === 'image') return mimeType.startsWith('image/');
  if (kind === 'audio') return mimeType.startsWith('audio/');
  return mimeType.startsWith('video/');
}

function maxBytesFor(kind: MediaAsset['kind']): number {
  if (kind === 'image') return IMAGE_MAX_BYTES;
  if (kind === 'audio') return AUDIO_MAX_BYTES;
  return VIDEO_MAX_BYTES;
}

const KIND_LABEL: Record<MediaAsset['kind'], string> = {
  image: '图片',
  audio: '音频',
  video: '视频',
};

/**
 * 分流一份素材。返回 `{ref, mode}`：`ref` 可以直接塞进请求体的 `url` 字段。
 * 失败一律抛 `VideoError`（category 决定 UI 文案），不返回半成品。
 */
export function resolveMediaRef(asset: MediaAsset): ResolvedMedia {
  const label = KIND_LABEL[asset.kind];
  const name = asset.name ? `「${asset.name}」` : '';

  if (!mimeMatches(asset.kind, asset.mimeType)) {
    throw new VideoError(
      'invalid_media',
      `${label}${name}的 MIME 类型（${asset.mimeType || '空'}）与实际类型不符`,
      { detail: '按扩展名判断类型，不要把音频当图片传' },
    );
  }
  if (asset.size > maxBytesFor(asset.kind)) {
    throw new VideoError(
      'invalid_media',
      `${label}${name}有 ${formatBytes(asset.size)}，超过官方单文件上限 ${formatBytes(
        maxBytesFor(asset.kind),
      )}`,
    );
  }

  // 视频：官方只支持 URL（或素材 ID，本适配器不做素材库）
  if (asset.kind === 'video') {
    if (isPublicHttpUrl(asset.url)) {
      return { kind: 'video', ref: asset.url!.trim(), mode: 'url', size: asset.size };
    }
    throw new VideoError(
      'media_needs_public_url',
      `视频${name}必须提供公网 URL（官方不支持视频走 base64）`,
      { detail: '可用出路：配 TOS 对象存储 / 传图床拿 URL / 降级为只用首尾帧' },
    );
  }

  // 小文件：优先用本地字节转 base64（用户不需要任何外部服务）
  if (asset.size < INLINE_MEDIA_MAX_BYTES && asset.bytes) {
    return {
      kind: asset.kind,
      ref: toDataUrl(asset.bytes, asset.mimeType),
      mode: 'base64',
      size: asset.size,
    };
  }

  // 大文件（或没有字节）：必须有公网 URL
  if (isPublicHttpUrl(asset.url)) {
    return { kind: asset.kind, ref: asset.url!.trim(), mode: 'url', size: asset.size };
  }
  if (asset.size >= INLINE_MEDIA_MAX_BYTES) {
    throw new VideoError(
      'media_needs_public_url',
      `${label}${name}有 ${formatBytes(asset.size)}（≥ 5MB），必须提供公网 URL`,
      {
        detail:
          '三条出路：① 配 TOS 对象存储（公共读）；② 上传图床复制 URL；③ 只保留首尾帧（< 5MB 可 base64）',
      },
    );
  }
  throw new VideoError('invalid_media', `${label}${name}没有可用的数据（既没有字节也没有 URL）`);
}

/** UTF-8 字节数：不额外分配 Buffer，用于估算请求体（base64 与 JSON 都是 ASCII 为主） */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function estimatePayloadBytes(payload: unknown): number {
  return utf8ByteLength(JSON.stringify(payload));
}

/** 请求体超限就抛错（在发请求之前调用 → 判据 7「不发请求」） */
export function assertPayloadFits(
  payload: unknown,
  limitBytes: number = REQUEST_BODY_MAX_BYTES,
): number {
  const bytes = estimatePayloadBytes(payload);
  if (bytes > limitBytes) {
    throw new VideoError(
      'request_too_large',
      `请求体 ${formatBytes(bytes)}，超过上限 ${formatBytes(limitBytes)}`,
      { detail: '减少内联素材或改用公网 URL；也可降级为只用首尾帧' },
    );
  }
  return bytes;
}
