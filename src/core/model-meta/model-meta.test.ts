import { describe, expect, it } from 'vitest';
import { knownContextFor, MODEL_META_UPDATED_AT, modelMetaSize } from './index';
import { canonicalModelId } from './aliases';

describe('模型窗口名录', () => {
  it('名录本身有数据（同步脚本跑过）', () => {
    expect(modelMetaSize()).toBeGreaterThan(3000);
    expect(MODEL_META_UPDATED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('常见模型能查到真实窗口，且不是一律 1M', () => {
    expect(knownContextFor('deepseek-flash')).toBe(1_000_000);
    expect(knownContextFor('glm-4.7-flash')).toBe(200_000);
    expect(knownContextFor('MiniMax-M3')).toBe(512_000);
    expect(knownContextFor('doubao-seed-2-1-pro-260628')).toBe(256_000);
  });

  it('别名表能还原中转站的写法', () => {
    expect(canonicalModelId('deepseek-v4.1-flash-1017')).toBe('deepseek-flash');
    expect(knownContextFor('deepseek-v4.1-flash-1017')).toBe(1_000_000);
    expect(knownContextFor('deepseek-v4-flash')).toBe(1_000_000);
    // 大小写、连字符、空格都不敏感
    expect(knownContextFor('DeepSeek_V4.1 Flash')).toBe(1_000_000);
  });

  it('去掉尾部日期也能认出来', () => {
    expect(knownContextFor('claude-opus-5-5-20260101')).toBe(knownContextFor('claude-opus-5-5'));
  });

  it('查不到的返回 undefined，不猜', () => {
    expect(knownContextFor('my-private-model-x1')).toBeUndefined();
    expect(knownContextFor('')).toBeUndefined();
  });
});
