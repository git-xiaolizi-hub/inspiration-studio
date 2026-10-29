/**
 * M3R4 §4.2：连接上的「倍率」必须能在视频页的费用提示里生效。
 *
 * 这里测的是**桥接层**（`estimateVideoRequest`）：配置页不再显示预估，倍率唯一的用户可见出口
 * 就是视频页那句「预计花费」+ notices。倍率不传 = 1，与旧行为完全一致。
 */
import { describe, expect, it } from 'vitest';
import { estimateVideoRequest } from './estimate';
import { OFFICIAL_PRICE_TABLE } from '../ai-models/pricing';
import type { VideoGenerationRequest } from './types';

function request(overrides: Record<string, unknown> = {}): VideoGenerationRequest {
  return {
    prompt: '海边日落',
    params: {
      duration: 5,
      resolution: '720p',
      ratio: 'adaptive',
      draft_mode: false,
      ...overrides,
    },
    references: {},
  } as unknown as VideoGenerationRequest;
}

const BASE = {
  request: request(),
  priceTable: OFFICIAL_PRICE_TABLE,
  priceModel: 'doubao-seedance-2.5',
};

describe('倍率接进视频页的费用提示', () => {
  it('不传倍率：金额 = 官方价，notices 里不出现「倍率」', () => {
    const official = estimateVideoRequest(BASE);
    expect(official.estimate.multiplier).toBe(1);
    expect(official.notices.some((line) => line.includes('倍率'))).toBe(false);
    expect(official.estimate.total).toBeCloseTo(7.56, 2);
  });

  it('倍率 0.35：金额 ×0.35，并在 notices 里明说是按倍率换算的（不悄悄改数）', () => {
    const discounted = estimateVideoRequest({ ...BASE, multiplier: 0.35 });
    expect(discounted.estimate.multiplier).toBe(0.35);
    expect(discounted.estimate.total).toBeCloseTo(7.56 * 0.35, 2);
    const notice = discounted.notices.find((line) => line.includes('倍率'));
    expect(notice).toContain('×0.35');
    expect(notice).toContain('官方价 × 倍率');
    expect(notice).toContain('AI 配置 → 连接');
    // rate 仍是官方单价（用户能拿去和厂商文档对照）
    expect(discounted.estimate.items[0].rate).toBe(
      estimateVideoRequest(BASE).estimate.items[0].rate,
    );
  });

  it('样片模式同样按倍率换算（两行金额一起乘）', () => {
    const draftRequest = { request: request({ draft_mode: true, resolution: '1080p' }), priceTable: OFFICIAL_PRICE_TABLE, priceModel: 'doubao-seedance-2.5' };
    const official = estimateVideoRequest(draftRequest);
    const discounted = estimateVideoRequest({ ...draftRequest, multiplier: 0.35 });
    expect(official.lines).not.toBeNull();
    expect(discounted.lines).not.toBeNull();
    expect(discounted.estimate.total).toBeCloseTo(official.estimate.total * 0.35, 4);
  });
});
