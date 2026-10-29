import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  THEMES,
  THEME_MATRIX,
  applyTheme,
  currentTheme,
  isThemeName,
  moodOf,
  resolveTheme,
  schemeOf,
  themeMeta,
} from './index';

describe('主题表', () => {
  it('恰好 4 套，名字不重复', () => {
    expect(THEMES).toHaveLength(4);
    expect(new Set(THEMES.map((t) => t.name)).size).toBe(4);
  });

  it('两浅两深，两克制两梦幻（2×2 矩阵成立）', () => {
    const light = THEMES.filter((t) => t.scheme === 'light');
    const dark = THEMES.filter((t) => t.scheme === 'dark');
    const calm = THEMES.filter((t) => t.mood === 'calm');
    const dream = THEMES.filter((t) => t.mood === 'dream');
    expect([light.length, dark.length, calm.length, dream.length]).toEqual([2, 2, 2, 2]);
  });

  it('每套都有说明与代表色', () => {
    for (const t of THEMES) {
      expect(t.description.length).toBeGreaterThan(8);
      expect(t.swatch).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('isThemeName', () => {
  it('认得四个合法名', () => {
    for (const n of ['clay', 'violet', 'neon', 'amber']) expect(isThemeName(n)).toBe(true);
  });
  it('拒绝脏数据（localStorage 可能被手改）', () => {
    for (const bad of ['', 'Clay', 'dark', null, undefined, 0, {}]) expect(isThemeName(bad)).toBe(false);
  });
});

describe('矩阵推导：深浅 × 气质 → 主题', () => {
  it('浅色 + 克制 = clay', () => expect(resolveTheme('light', 'calm', false)).toBe('clay'));
  it('浅色 + 梦幻 = violet', () => expect(resolveTheme('light', 'dream', false)).toBe('violet'));
  it('深色 + 克制 = amber', () => expect(resolveTheme('dark', 'calm', false)).toBe('amber'));
  it('深色 + 梦幻 = neon', () => expect(resolveTheme('dark', 'dream', false)).toBe('neon'));

  it('system 跟随系统：系统深色时取深色', () => {
    expect(resolveTheme('system', 'calm', true)).toBe('amber');
    expect(resolveTheme('system', 'dream', true)).toBe('neon');
  });
  it('system 跟随系统：系统浅色时取浅色', () => {
    expect(resolveTheme('system', 'calm', false)).toBe('clay');
    expect(resolveTheme('system', 'dream', false)).toBe('violet');
  });

  it('四个组合与矩阵表一致（防止表与函数各写一份）', () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const mood of ['calm', 'dream'] as const) {
        expect(resolveTheme(scheme, mood, false)).toBe(THEME_MATRIX[scheme][mood]);
      }
    }
  });
});

describe('schemeOf / moodOf 与表自洽', () => {
  it('每套主题的深浅与气质都能反查回来', () => {
    for (const t of THEMES) {
      expect(schemeOf(t.name)).toBe(t.scheme);
      expect(moodOf(t.name)).toBe(t.mood);
    }
  });
});

describe('themeMeta', () => {
  it('拿得到元数据', () => {
    expect(themeMeta('clay').label).toBe('柔和奶油');
  });
  it('未知主题要抛错，不能静默返回默认', () => {
    // @ts-expect-error 故意传非法值
    expect(() => themeMeta('nope')).toThrow(/未知主题/);
  });
});

describe('显示名（P1.5：委托人指定的四个叫法）', () => {
  it('顺序与名字都对得上', () => {
    // 2026-10-28 委托人指定：奶油 → 琥珀 → 紫色 → 蓝色（前两个主推）
    expect(THEMES.map((t) => t.label)).toEqual(['柔和奶油', '暖夜琥珀', '罗兰梦境', '霓虹深空']);
  });

  it('旧名字不再出现在主题表里（界面上不该再有「奶油手作 / 紫罗兰梦」）', () => {
    const labels = THEMES.map((t) => t.label);
    for (const oldName of ['奶油手作', '紫罗兰梦']) expect(labels).not.toContain(oldName);
  });

  it('每套主题都有深浅属性（data-scheme 靠它，删了就丢滚动条/原生控件配色）', () => {
    for (const t of THEMES) expect(['light', 'dark']).toContain(t.scheme);
  });
});

describe('applyTheme / currentTheme', () => {
  it('写到 documentElement 上，并同时设置 data-scheme', () => {
    applyTheme('neon');
    expect(document.documentElement.getAttribute('data-theme')).toBe('neon');
    expect(document.documentElement.getAttribute('data-scheme')).toBe('dark');
    expect(currentTheme()).toBe('neon');
  });

  it('切换主题会覆盖旧值', () => {
    applyTheme('violet');
    applyTheme('clay');
    expect(currentTheme()).toBe('clay');
    expect(document.documentElement.getAttribute('data-scheme')).toBe('light');
  });

  it('没设置过时回落到默认主题', () => {
    document.documentElement.removeAttribute('data-theme');
    expect(currentTheme()).toBe(DEFAULT_THEME);
  });

  it('属性被填了脏值时也回落到默认（不崩）', () => {
    document.documentElement.setAttribute('data-theme', 'garbage');
    expect(currentTheme()).toBe(DEFAULT_THEME);
  });
});
