/**
 * M4：价格表落地后的数据口径断言。
 *
 * 这些用例只锁「数据里有什么、口径怎么写」，不重复 M3 的公式用例
 * （`pricing.test.ts` 的 194 个不动）。
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_TOKEN_NOTICE,
  OFFICIAL_PRICE_TABLE,
  estimateVideo,
  shouldShowMinTokenNotice,
  textRateLine,
  videoTokens,
} from './pricing';

describe('官方价格表（2026-10）：来源与验证标记', () => {
  it('来源写「火山方舟官方价格页 / DeepSeek 官方文档」，verified 为真', () => {
    expect(OFFICIAL_PRICE_TABLE.source).toBe('火山方舟官方价格页 / DeepSeek 官方文档');
    expect(OFFICIAL_PRICE_TABLE.verified).toBe(true);
    expect(OFFICIAL_PRICE_TABLE.verifiedAt).toBe('2026-10');
  });

  it('视频：2.5 / 2.0 / 2.0-fast / 2.0-mini 四个型号都在表里', () => {
    expect(Object.keys(OFFICIAL_PRICE_TABLE.models)).toEqual([
      'doubao-seedance-2.5',
      'doubao-seedance-2.0',
      'doubao-seedance-2.0-fast',
      'doubao-seedance-2.0-mini',
    ]);
  });

  it('视频：2.5 的 1080p 与 2.0 的 4k 单价与官方页一致', () => {
    expect(OFFICIAL_PRICE_TABLE.models['doubao-seedance-2.5'].rate.hd).toEqual({
      withoutInputVideo: 77,
      withInputVideo: 46,
    });
    expect(OFFICIAL_PRICE_TABLE.models['doubao-seedance-2.0'].rate.uhd).toEqual({
      withoutInputVideo: 26,
      withInputVideo: 16,
    });
    expect(OFFICIAL_PRICE_TABLE.models['doubao-seedance-2.0-fast'].rate.sd).toEqual({
      withoutInputVideo: 37,
      withInputVideo: 22,
    });
    expect(OFFICIAL_PRICE_TABLE.models['doubao-seedance-2.0-mini'].rate.sd).toEqual({
      withoutInputVideo: 23,
      withInputVideo: 14,
    });
  });

  it('视频：2.0 的 1080p 已按官方页勘误填 51/31（M4b 首项；缺档报错规则改由 2.5/4k 承接）', () => {
    expect(OFFICIAL_PRICE_TABLE.models['doubao-seedance-2.0'].rate.hd).toEqual({
      withoutInputVideo: 51,
      withInputVideo: 31,
    });
    const result = estimateVideo({ model: 'doubao-seedance-2.0', res: '1080p', outSec: 10 });
    expect(result.error).toBeUndefined();
    expect(result.items[0].rate).toBe(51);
  });

  it('4k 的 token 公式用 3840×2160（同一套公式，不另写）', () => {
    expect(videoTokens(0, 1, '4k')).toBe(Math.trunc((3840 * 2160 * 24) / 1024));
  });

  it('文本：8 个模型，取高峰价', () => {
    const text = OFFICIAL_PRICE_TABLE.text;
    expect(Object.keys(text)).toHaveLength(8);
    expect(text['deepseek-flash'].inputPerMTokens).toBe(2);
    expect(text['deepseek-flash'].outputPerMTokens).toBe(8);
    expect(text['deepseek-v4-pro'].inputPerMTokens).toBe(9);
    expect(text['deepseek-v4-pro'].outputPerMTokens).toBe(27);
    expect(text['glm-5.3-flash'].outputPerMTokens).toBe(2.8);
    expect(text['glm-5.2'].outputPerMTokens).toBe(28);
    expect(text['doubao-seed-2.1-pro'].outputPerMTokens).toBe(30);
    expect(text['doubao-seed-2.1-turbo'].outputPerMTokens).toBe(15);
    expect(text['doubao-seed-2.1-lite'].outputPerMTokens).toBe(2.7);
    expect(text['doubao-seed-2.0-pro'].inputPerMTokens).toBe(3.2);
    for (const row of Object.values(text)) {
      expect(row.verified).toBe(true);
      expect(row.verifiedAt).toBe('2026-10');
    }
  });

  it('文本：峰谷与阶梯价写进 note，不藏在代码里', () => {
    expect(OFFICIAL_PRICE_TABLE.text['deepseek-flash'].note).toContain('空闲时段为半价');
    expect(OFFICIAL_PRICE_TABLE.text['doubao-seed-2.0-pro'].note).toContain('128–256K');
  });

  it('图片：5 个 seedream 填了单价，gpt-image-2.5 保持 null', () => {
    const image = OFFICIAL_PRICE_TABLE.image;
    expect(image['doubao-seedream-5-0-pro'].perImage).toBe(0.3);
    expect(image['doubao-seedream-5-0-pro'].highResPerImage).toBe(0.6);
    expect(image['doubao-seedream-5-0-flash'].perImage).toBe(0.12);
    expect(image['doubao-seedream-5-0-lite'].perImage).toBe(0.22);
    expect(image['doubao-seedream-4-5'].perImage).toBe(0.25);
    expect(image['doubao-seedream-4-0'].perImage).toBe(0.2);
    // R7a：gpt-image-2.5 这个 id 不存在，实际是 flare / sunburst 两条
    expect(image['gpt-image-2.5-flare'].perImage).toBeNull();
    expect(image['gpt-image-2.5-flare'].verified).toBe(false);
    expect(image['gpt-image-2.5-sunburst'].perImage).toBeNull();
    expect(image['gpt-image-2.5-sunburst'].verified).toBe(false);
  });
});

describe('文本主行与最低用量提示（M4 UI 口径）', () => {
  it('主行文案固定为「输入 ¥2.00 / 输出 ¥8.00 · 每百万 token」', () => {
    expect(textRateLine(OFFICIAL_PRICE_TABLE.text['deepseek-flash'])).toBe(
      '输入 ¥2.00 / 输出 ¥8.00 · 每百万 token',
    );
  });

  it('未录入单价时返回 null（UI 显示「未录入」而不是 ¥0.00）', () => {
    expect(textRateLine({ inputPerMTokens: null, outputPerMTokens: null, verified: false })).toBeNull();
  });

  it('输入含视频时必须提示最低用量限制', () => {
    expect(MIN_TOKEN_NOTICE).toContain('若低于最低 token 用量');
    expect(
      shouldShowMinTokenNotice(estimateVideo({ model: 'doubao-seedance-2.5', res: '720p', outSec: 10 })),
    ).toBe(false);
    expect(
      shouldShowMinTokenNotice(
        estimateVideo({ model: 'doubao-seedance-2.5', res: '720p', outSec: 10, inVideoSec: 5 }),
      ),
    ).toBe(true);
  });
});
