import { describe, expect, it } from 'vitest';
import { normalizeChoice, resolveStudioModel, studioModelOptions } from './model-choice';

/**
 * P4 · 模型选择守卫。
 *
 * 重点不是「能选到」，而是「选过的东西消失了怎么办」：
 * 用户上次选的连接被删了、模型从连接里移除了 —— 这两种情况必须给可读提示，
 * 而不是静默回退到别的模型（那会让用户以为用的是自己选的那个，实际不是）。
 */

describe('normalizeChoice：脏数据一律视为「没选过」', () => {
  it('非对象 → null', () => {
    for (const bad of [null, undefined, 0, 'x', [], true]) {
      expect(normalizeChoice(bad)).toBeNull();
    }
  });

  it('缺 providerId 或 modelId → null', () => {
    expect(normalizeChoice({ providerId: 'p1' })).toBeNull();
    expect(normalizeChoice({ modelId: 'm1' })).toBeNull();
    expect(normalizeChoice({ providerId: '', modelId: 'm1' })).toBeNull();
    expect(normalizeChoice({ providerId: 'p1', modelId: '   ' })).toBeNull();
  });

  it('首尾空白被裁掉', () => {
    expect(normalizeChoice({ providerId: ' p1 ', modelId: ' m1 ' })).toEqual({
      providerId: 'p1',
      modelId: 'm1',
    });
  });

  it('非字符串 → null（不把数字 id 当模型名）', () => {
    expect(normalizeChoice({ providerId: 1, modelId: 2 })).toBeNull();
  });
});

describe('studioModelOptions：目录还没读出来时给空数组', () => {
  it('catalog 为 null → []（下拉显示空，而不是崩）', () => {
    expect(studioModelOptions(null)).toEqual([]);
  });
});

describe('resolveStudioModel：目录没读出来时返回 null（页面显示「正在读取」）', () => {
  it('catalog 为 null → null', () => {
    expect(resolveStudioModel(null, null)).toBeNull();
    expect(resolveStudioModel(null, { providerId: 'p1', modelId: 'm1' })).toBeNull();
  });
});

describe('resolveStudioModel：没选过时回落到默认挑一个', () => {
  it('choice 为 null 且目录为空 → 返回 not ok，并给可执行 hint', () => {
    const got = resolveStudioModel({ providers: [], updatedAt: 0 } as never, null);
    expect(got).not.toBeNull();
    expect(got?.ok).toBe(false);
    expect(typeof got?.hint).toBe('string');
    expect((got?.hint ?? '').length).toBeGreaterThan(6);
  });
});

describe('resolveStudioModel：选过的连接/模型消失时给可读提示，不静默换模型', () => {
  it('provider 不存在 → not ok 且提示里提到「连接」', () => {
    const got = resolveStudioModel({ providers: [], updatedAt: 0 } as never, {
      providerId: 'gone',
      modelId: 'm1',
    });
    expect(got?.ok).toBe(false);
    expect(got?.hint).toContain('连接');
  });

  it('provider 存在但没有可用连接 → not ok', () => {
    const catalog = {
      providers: [{ id: 'p1', name: 'P1', builtin: false, connections: [], models: [] }],
      updatedAt: 0,
    } as never;
    const got = resolveStudioModel(catalog, { providerId: 'p1', modelId: 'm1' });
    expect(got?.ok).toBe(false);
  });
});
