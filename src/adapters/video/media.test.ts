import { describe, expect, it } from 'vitest';
import {
  assertPayloadFits,
  bytesToBase64,
  estimatePayloadBytes,
  formatBytes,
  isPublicHttpUrl,
  resolveMediaRef,
  toDataUrl,
  utf8ByteLength,
} from './media';
import { REQUEST_BODY_MAX_BYTES } from './constants';
import { isVideoError } from './errors';
import type { MediaAsset } from './types';

const MB = 1024 * 1024;

function image(size: number, extra: Partial<MediaAsset> = {}): MediaAsset {
  return { kind: 'image', mimeType: 'image/png', size, bytes: new Uint8Array(size), ...extra };
}

describe('素材分流（判据 6：< 5MB → base64；≥ 5MB → 必须 URL；视频只能 URL）', () => {
  it('4.9MB 图片走 base64 data URL', () => {
    const asset = image(Math.round(4.9 * MB));
    const resolved = resolveMediaRef(asset);
    expect(resolved.mode).toBe('base64');
    expect(resolved.ref.startsWith('data:image/png;base64,')).toBe(true);
    // base64 是 4/3 膨胀：长度应接近 size * 4/3（再加前缀）
    expect(resolved.ref.length).toBeGreaterThan(asset.size * 1.3);
  });

  it('6MB 图片（无 URL）报错，并给出三条出路', () => {
    const asset = image(6 * MB);
    try {
      resolveMediaRef(asset);
      throw new Error('应当抛错');
    } catch (error) {
      expect(isVideoError(error)).toBe(true);
      if (!isVideoError(error)) return;
      expect(error.category).toBe('media_needs_public_url');
      expect(error.nextStep).toContain('TOS');
      expect(error.nextStep).toContain('图床');
      expect(error.nextStep).toContain('首尾帧');
    }
  });

  it('6MB 图片带公网 URL → 走 URL', () => {
    const resolved = resolveMediaRef(image(6 * MB, { url: 'https://cdn.example.com/a.png', bytes: undefined }));
    expect(resolved.mode).toBe('url');
    expect(resolved.ref).toBe('https://cdn.example.com/a.png');
  });

  it('任意视频没有 URL 就必须报错（视频不支持 base64）', () => {
    const asset: MediaAsset = { kind: 'video', mimeType: 'video/mp4', size: 2 * MB, bytes: new Uint8Array(8) };
    expect(() => resolveMediaRef(asset)).toThrowError(/公网 URL/);
  });

  it('视频有 URL（哪怕 180MB）→ 走 URL，不做 base64', () => {
    const resolved = resolveMediaRef({
      kind: 'video',
      mimeType: 'video/mp4',
      size: 180 * MB,
      url: 'https://cdn.example.com/clip.mp4',
    });
    expect(resolved.mode).toBe('url');
  });

  it('音频 6MB 也要 URL（与图片同一条 5MB 线）', () => {
    expect(() =>
      resolveMediaRef({ kind: 'audio', mimeType: 'audio/mpeg', size: 6 * MB, bytes: new Uint8Array(16) }),
    ).toThrowError(/必须提供公网 URL/);
  });

  it('MIME 与实际类型不符直接拒（把音频塞进 image_url 是最常见的错）', () => {
    try {
      resolveMediaRef({ kind: 'image', mimeType: 'audio/mpeg', size: 1024, bytes: new Uint8Array(8) });
      throw new Error('应当抛错');
    } catch (error) {
      expect(isVideoError(error) && error.category).toBe('invalid_media');
    }
  });

  it('超过官方单文件上限（图片 30MB）也拒', () => {
    try {
      resolveMediaRef({
        kind: 'image',
        mimeType: 'image/png',
        size: 31 * MB,
        url: 'https://cdn.example.com/a.png',
      });
      throw new Error('应当抛错');
    } catch (error) {
      expect(isVideoError(error) && error.category).toBe('invalid_media');
      expect(isVideoError(error) && error.message).toContain('30.0 MB');
    }
  });

  it('不是 http(s) 的地址不算公网 URL', () => {
    expect(isPublicHttpUrl('https://a.com/x.png')).toBe(true);
    expect(isPublicHttpUrl('file:///c:/x.png')).toBe(false);
    expect(isPublicHttpUrl('blob:http://localhost/1')).toBe(false);
    expect(isPublicHttpUrl('data:image/png;base64,AAA')).toBe(false);
  });
});

describe('请求体大小（判据 7：超 64MB 提前拒绝）', () => {
  it('官方上限就是 64MB（常量写死，不允许悄悄调大）', () => {
    expect(REQUEST_BODY_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it('超过 64MB 的请求体直接抛错（不是发出去再失败）', () => {
    const huge = { data: 'a'.repeat(REQUEST_BODY_MAX_BYTES + 1) };
    try {
      assertPayloadFits(huge);
      throw new Error('应当抛错');
    } catch (error) {
      expect(isVideoError(error) && error.category).toBe('request_too_large');
    }
  });

  it('刚好小于上限时放行，并返回估算字节数', () => {
    const payload = { data: 'a'.repeat(1024) };
    const bytes = assertPayloadFits(payload, 4096);
    expect(bytes).toBeGreaterThan(1024);
    expect(bytes).toBe(estimatePayloadBytes(payload));
  });

  it('字节估算：ASCII 与中文都按 UTF-8 算', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('中')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('base64 编码不使用 Buffer（浏览器与测试环境一致）', () => {
    const encoded = bytesToBase64(new Uint8Array([0, 1, 2, 253, 254, 255]));
    expect(encoded).toBe('AAEC/f7/');
    expect(toDataUrl(new Uint8Array([104, 105]), 'image/png')).toBe('data:image/png;base64,aGk=');
  });
});
