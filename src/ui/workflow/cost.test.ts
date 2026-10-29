import { describe, expect, it } from 'vitest';
import { OFFICIAL_PRICE_TABLE, estimateVideo } from '../../adapters/ai-models/pricing';
import { costConfirmText, quoteForNode } from './cost';
import type { ExecNode } from './types';

const imageNode = (modelId: string): ExecNode => ({
  id: 'img',
  type: 'image',
  data: { modelId },
});

const videoNode = (modelId: string, resolution?: '480p' | '720p' | '1080p', durationSec?: number): ExecNode => ({
  id: 'vid',
  type: 'video',
  data: { modelId, resolution, durationSec },
});

describe('生图报价', () => {
  it('免费档（cogview-3-flash）→ 0 元且标 free', () => {
    const quote = quoteForNode(imageNode('cogview-3-flash'), { priceTable: OFFICIAL_PRICE_TABLE });
    expect(quote).not.toBeNull();
    expect(quote?.free).toBe(true);
    expect(quote?.amount).toBe(0);
    expect(costConfirmText(quote!)).toContain('本次免费');
  });

  it('付费档（doubao-seedream-5-0-pro）→ 按张计 0.30', () => {
    const quote = quoteForNode(imageNode('doubao-seedream-5-0-pro'), {
      priceTable: OFFICIAL_PRICE_TABLE,
    });
    expect(quote?.free).toBe(false);
    expect(quote?.amount).toBeCloseTo(0.3, 5);
    expect(costConfirmText(quote!)).toMatch(/^本次将花费 ≈¥0\.30（.+ 1 张），继续？$/);
  });

  it('价格表未录入（gpt-image-2.5）→ 0 元但必须提示"未录入"', () => {
    const quote = quoteForNode(imageNode('gpt-image-2.5'), { priceTable: OFFICIAL_PRICE_TABLE });
    expect(quote?.amount).toBe(0);
    expect(quote?.notices.join(' ')).toContain('未录入');
  });

  it('没选模型 → null（不问钱，交给处理器报"还没选模型"）', () => {
    expect(quoteForNode(imageNode(''), { priceTable: OFFICIAL_PRICE_TABLE })).toBeNull();
  });
});

describe('视频报价', () => {
  it('seedance 2.5 / 480p / 5 秒 → 与 estimateVideo 同一口径，且必须带"停止不阻止计费"', () => {
    const quote = quoteForNode(videoNode('doubao-seedance-2-5-260628', '480p', 5), {
      priceTable: OFFICIAL_PRICE_TABLE,
    });
    const expected = estimateVideo({
      model: 'doubao-seedance-2.5',
      res: '480p',
      outSec: 5,
      table: OFFICIAL_PRICE_TABLE,
    });

    expect(quote).not.toBeNull();
    expect(quote?.amount).toBeCloseTo(expected.total, 6);
    expect(quote?.spec).toBe('5 秒 · 480p');
    expect(quote?.notices.join(' ')).toContain('本地「停止」不会阻止服务端继续跑并计费');
  });

  it('计费倍率只乘金额，并同屏提示', () => {
    const base = quoteForNode(videoNode('doubao-seedance-2-5-260628', '720p', 5), {
      priceTable: OFFICIAL_PRICE_TABLE,
    });
    const doubled = quoteForNode(videoNode('doubao-seedance-2-5-260628', '720p', 5), {
      priceTable: OFFICIAL_PRICE_TABLE,
      multiplier: 2,
    });
    expect(doubled?.amount).toBeCloseTo((base?.amount ?? 0) * 2, 6);
    expect(doubled?.notices.join(' ')).toContain('倍率');
  });

  it('视频默认参数是最便宜的一档（480p / 5 秒）', () => {
    const quote = quoteForNode(videoNode('doubao-seedance-2-5-260628'), {
      priceTable: OFFICIAL_PRICE_TABLE,
    });
    expect(quote?.spec).toBe('5 秒 · 480p');
  });
});

describe('对话框文案', () => {
  it('付费：固定格式「本次将花费 ≈¥X.XX（模型 规格），继续？」', () => {
    const text = costConfirmText({
      nodeId: 'x',
      kind: 'video',
      amount: 12.345,
      modelId: 'doubao-seedance-2-5-260628',
      spec: '5 秒 · 480p',
      free: false,
      notices: [],
    });
    expect(text).toBe('本次将花费 ≈¥12.35（doubao-seedance-2-5-260628 5 秒 · 480p），继续？');
  });
});
