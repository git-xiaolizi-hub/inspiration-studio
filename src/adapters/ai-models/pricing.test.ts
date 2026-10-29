import { describe, expect, it } from 'vitest';
import {
  charsToTokens,
  checkBudget,
  clonePriceTable,
  DEFAULT_FPS,
  draftAdvice,
  draftLines,
  estimateImage,
  estimateText,
  estimateVideo,
  formatYuan,
  OFFICIAL_PRICE_TABLE,
  priceKeyForTextModel,
  videoTokens,
} from './pricing';
import type { PriceTable } from './pricing';

/** 金额比较：任务书要求三个算例误差 ≤ ¥0.01 */
function expectYuan(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.01);
}

describe('视频 token 公式（官方：(输入秒+输出秒)×宽×高×帧率÷1024）', () => {
  it('480p 的 token/秒 = 9607.5，整段取整后 1 秒是 9607（不是 9608）', () => {
    expect(videoTokens(0, 1, '480p')).toBe(9607);
    // 30 秒必须按整段乘：9607.5 × 30 = 288,225
    expect(videoTokens(0, 30, '480p')).toBe(288_225);
  });

  it('720p / 1080p 的整段值', () => {
    expect(videoTokens(0, 30, '720p')).toBe(648_000);
    expect(videoTokens(6, 12, '1080p')).toBe(874_800);
  });

  it('帧率默认 24，且是假设值（可被覆盖）', () => {
    expect(DEFAULT_FPS).toBe(24);
    expect(videoTokens(0, 10, '720p', 12)).toBe(108_000);
  });
});

describe('三个官方算例（误差 ≤ ¥0.01）', () => {
  it('30 秒 720p 不含输入视频 = ¥45.36', () => {
    const result = estimateVideo({ model: 'doubao-seedance-2.5', res: '720p', outSec: 30 });
    expect(result.error).toBeUndefined();
    expectYuan(result.total, 45.36);
    expect(result.items[0].tokens).toBe(648_000);
    expect(result.items[0].rate).toBe(70);
  });

  it('30 秒 480p = ¥20.18（不是 20.16 —— 那说明按秒取整了）', () => {
    const result = estimateVideo({ model: 'doubao-seedance-2.5', res: '480p', outSec: 30 });
    expectYuan(result.total, 20.18);
    expect(Math.abs(result.total - 20.16)).toBeGreaterThan(0.01);
  });

  it('12 秒 1080p + 6 秒输入视频 = ¥40.24（走含输入视频低价档）', () => {
    const result = estimateVideo({
      model: 'doubao-seedance-2.5',
      res: '1080p',
      outSec: 12,
      inVideoSec: 6,
    });
    expect(result.hasInputVideo).toBe(true);
    expect(result.items[0].rate).toBe(46);
    expectYuan(result.total, 40.24);
  });

  it('30 秒 480p + 10 秒输入视频 = ¥16.14（参考实现自检第 4 项）', () => {
    const result = estimateVideo({
      model: 'doubao-seedance-2.5',
      res: '480p',
      outSec: 30,
      inVideoSec: 10,
    });
    expect(Math.abs(result.total - 16.14)).toBeLessThan(0.02);
  });
});

describe('样片（Draft）两步分别计费', () => {
  const draft = estimateVideo({ model: 'doubao-seedance-2.5', res: '720p', outSec: 30, draft: true });

  it('两行金额：Draft ¥20.18（480p）→ 成片 ¥45.36（720p）', () => {
    const lines = draftLines(draft);
    expect(lines).toEqual({ draft: 'Draft ¥20.18（480p）', final: '成片 ¥45.36（720p）' });
    expect(draft.items).toHaveLength(2);
    expectYuan(draft.total, 65.54);
  });

  it('溢价约 44%，并给出「废片率 > 44%」的阈值提示', () => {
    expect(draft.overheadRatio).toBeGreaterThan(0.4);
    expect(draft.overheadRatio).toBeLessThan(0.48);
    expect(draftAdvice(draft)).toBe('样片值得用，当且仅当废片率 > 44%');
  });

  it('直接出成片时没有阈值提示（不制造噪音）', () => {
    const single = estimateVideo({ model: 'doubao-seedance-2.5', res: '720p', outSec: 30 });
    expect(draftAdvice(single)).toBeNull();
    expect(draftLines(single)).toBeNull();
  });
});

describe('价格表是数据：可替换、缺档不猜', () => {
  it('未录入的档位直接报错（seedance-2.5 官方未给 4k 价）', () => {
    const result = estimateVideo({ model: 'doubao-seedance-2.5', res: '4k', outSec: 10 });
    expect(result.total).toBe(0);
    expect(result.error).toContain('价格表未录入');
  });

  it('seedance-2.0 的 1080p 已按官方页勘误填 51/31（不再是未录入）', () => {
    const result = estimateVideo({ model: 'doubao-seedance-2.0', res: '1080p', outSec: 10 });
    expect(result.error).toBeUndefined();
    expect(result.items[0].tokens).toBe(486_000);
    expect(result.items[0].rate).toBe(51);
    expectYuan(result.total, 24.79);
  });

  it('换成自定义价格表后金额随之变化（证明没写死）', () => {
    const table: PriceTable = clonePriceTable();
    table.models['doubao-seedance-2.5'].rate.sd = {
      withoutInputVideo: 140,
      withInputVideo: 42,
    };
    table.source = '某中转站 2026-10（自填）';
    table.verified = false;
    table.verifiedAt = '2026-10';

    const result = estimateVideo({
      model: 'doubao-seedance-2.5',
      res: '720p',
      outSec: 30,
      table,
    });
    expectYuan(result.total, 90.72);
    expect(result.priceSource).toContain('中转站');
    expect(result.verified).toBe(false);
    expect(result.verifiedAt).toBe('2026-10');
  });

  it('官方价格表默认标记为已验证，并带抓取日期', () => {
    expect(OFFICIAL_PRICE_TABLE.verified).toBe(true);
    expect(OFFICIAL_PRICE_TABLE.verifiedAt).toMatch(/^\d{4}-\d{2}/);
    expect(OFFICIAL_PRICE_TABLE.source).toContain('火山方舟');
  });
});

describe('文本 / 图片预估（标注估算）', () => {
  it('字符 → token 按 1.6 字符/token 向上取整', () => {
    expect(charsToTokens(1600)).toBe(1000);
    expect(charsToTokens(1)).toBe(1);
    expect(charsToTokens(0)).toBe(0);
  });

  it('文本：输入 + 输出分别按单价计价', () => {
    const result = estimateText({
      inputChars: 1600,
      outputChars: 800,
      priceRow: { inputPerMTokens: 1, outputPerMTokens: 2, verified: true, verifiedAt: '2026-10' },
    });
    expect(result.items[0].tokens).toBe(1000);
    expect(result.items[1].tokens).toBe(500);
    expect(result.total).toBeCloseTo(0.001 + 0.001, 6);
    expect(result.estimated).toBe(true);
  });

  it('未填单价 → 报错而不是按 0 元糊弄', () => {
    const result = estimateText({
      inputChars: 1000,
      priceRow: { inputPerMTokens: null, outputPerMTokens: null, verified: false },
    });
    expect(result.error).toContain('未录入');
    expect(result.total).toBe(0);
  });

  it('图片：张数 × 单价；未填单价则报错', () => {
    expect(estimateImage({ count: 3, priceRow: { perImage: 0.5, verified: true } }).total).toBe(1.5);
    expect(estimateImage({ count: 3, priceRow: { perImage: null, verified: false } }).error).toContain(
      '未录入',
    );
  });
});

describe('预算闸门：触顶必须停下确认', () => {
  it('未超预算：不拦，摘要格式固定', () => {
    const verdict = checkBudget({ estimate: 45.36, spent: 10, budget: 100 });
    expect(verdict.exceeded).toBe(false);
    expect(verdict.requiresConfirm).toBe(false);
    expect(verdict.summary).toBe('本机累计已花 ¥10.00 / 预算 ¥100.00');
  });

  it('会超预算：requiresConfirm=true，并说明超多少', () => {
    const verdict = checkBudget({ estimate: 45.36, spent: 90, budget: 100 });
    expect(verdict.exceeded).toBe(true);
    expect(verdict.requiresConfirm).toBe(true);
    expect(verdict.projected).toBeCloseTo(135.36, 2);
    expect(verdict.message).toContain('超出预算 ¥35.36');
  });

  it('没设预算 → 不拦（也不显示假的剩余额度）', () => {
    const verdict = checkBudget({ estimate: 45.36, spent: 500, budget: null });
    expect(verdict.exceeded).toBe(false);
    expect(verdict.remaining).toBeNull();
    expect(verdict.summary).toContain('本机累计已花 ¥500.00');
  });

  it('formatYuan 固定两位小数', () => {
    expect(formatYuan(20.17575)).toBe('¥20.18');
    expect(formatYuan(45)).toBe('¥45.00');
  });
});

/* ------------------------------------------------------------------ */
/* M3R4 §4.2 倍率：只乘金额，不动官方单价                                */
/* ------------------------------------------------------------------ */

describe('倍率 multiplier（官方单价 × 倍率 = 实付估算）', () => {
  it('不传倍率 = 官方价（旧的三个算例一个都不变）', () => {
    const video = estimateVideo({ model: 'doubao-seedance-2.5', res: '720p', outSec: 30 });
    expectYuan(video.total, 45.36);
    expect(video.multiplier).toBe(1);
  });

  it('倍率 0.35：总额 ×0.35，rate 仍是官方单价（可对照文档）', () => {
    const official = estimateVideo({ model: 'doubao-seedance-2.5', res: '720p', outSec: 30 });
    const discounted = estimateVideo({
      model: 'doubao-seedance-2.5',
      res: '720p',
      outSec: 30,
      multiplier: 0.35,
    });
    expect(discounted.multiplier).toBe(0.35);
    expectYuan(discounted.total, 45.36 * 0.35);
    expect(formatYuan(discounted.total)).toBe('¥15.88');
    expect(discounted.items[0].rate).toBe(official.items[0].rate);
    expect(discounted.items[0].tokens).toBe(official.items[0].tokens);
  });

  it('样片两行金额与溢价比例不受倍率影响（同时乘同样的系数）', () => {
    const official = estimateVideo({
      model: 'doubao-seedance-2.5',
      res: '720p',
      outSec: 30,
      draft: true,
    });
    const discounted = estimateVideo({
      model: 'doubao-seedance-2.5',
      res: '720p',
      outSec: 30,
      draft: true,
      multiplier: 0.35,
    });
    expect(discounted.overheadRatio).toBeCloseTo(official.overheadRatio ?? 0, 6);
    expect(formatYuan(discounted.items[0].cost)).toBe('¥7.06');
    expect(draftLines(discounted)?.draft).toContain('¥7.06');
  });

  it('倍率 0 与 2.5 都允许；负数 / NaN 回落成 1（不产生负金额）', () => {
    expect(estimateVideo({ model: 'doubao-seedance-2.5', res: '720p', outSec: 30, multiplier: 0 }).total).toBe(0);
    expect(
      estimateVideo({ model: 'doubao-seedance-2.5', res: '720p', outSec: 30, multiplier: 2.5 }).multiplier,
    ).toBe(2.5);
    const negative = estimateVideo({
      model: 'doubao-seedance-2.5',
      res: '720p',
      outSec: 30,
      multiplier: -1,
    });
    expect(negative.multiplier).toBe(1);
    expectYuan(negative.total, 45.36);
  });
});

/**
 * M3R11 §3：方舟只认版本化 model id，预设里因此改成 `…-260628`；
 * 而价格表按族名记 —— 两者必须能对上，否则文本预估会显示「价格表未录入」。
 */
describe('M3R11 §3：版本化 model id → 价格表族名', () => {
  it('先削尾部日期段；削完命中就直接用（deepseek-flash 这种本来就是族名）', () => {
    expect(priceKeyForTextModel('deepseek-flash')).toBe('deepseek-flash');
    expect(priceKeyForTextModel(' deepseek-flash ')).toBe('deepseek-flash');
    expect(priceKeyForTextModel('doubao-seed-2-1-pro-260628')).toBe('doubao-seed-2.1-pro');
    expect(priceKeyForTextModel('doubao-seed-2-1-pro')).toBe('doubao-seed-2.1-pro');
  });

  it('归一之后真能命中价格表（否则预估页只会说"未录入"）', () => {
    const row = OFFICIAL_PRICE_TABLE.text[priceKeyForTextModel('doubao-seed-2-1-pro-260628')];
    expect(row).toBeDefined();
    expect(row.outputPerMTokens).toBe(30);
  });

  it('价格表里没有的（含生图/视频模型）原样返回，不编一个不存在的键', () => {
    expect(priceKeyForTextModel('doubao-seedance-2-5-260628')).toBe('doubao-seedance-2-5');
    expect(OFFICIAL_PRICE_TABLE.text['doubao-seedance-2-5']).toBeUndefined();
    expect(priceKeyForTextModel('qwen-image-2.1')).toBe('qwen-image-2.1');
  });
});
