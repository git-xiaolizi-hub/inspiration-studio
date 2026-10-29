import { describe, expect, it } from 'vitest';
import {
  COLLAPSED_WIDTH,
  DEFAULT_DISPLAY_HEIGHT,
  DEFAULT_LEFT_WIDTH,
  DEFAULT_RIGHT_WIDTH,
  DEFAULT_STUDIO_LAYOUT,
  H_SPLITTER_HEIGHT,
  MIN_CENTER_WIDTH,
  MIN_DISPLAY_HEIGHT,
  MIN_EDITOR_HEIGHT,
  MIN_LEFT_WIDTH,
  MIN_RIGHT_WIDTH,
  SPLITTER_WIDTH,
  clampLayout,
  collapseAll,
  expandAll,
  fitDisplayHeight,
  isAllCollapsed,
  maxDisplayHeight,
  maxLeftWidth,
  maxRightWidth,
  normalizeLayout,
  paneWidth,
  resizeDisplayHeight,
  resizeLeft,
  resizeRight,
  type StudioLayout,
} from './layout';

/**
 * P4 · 布局纯函数守卫。
 *
 * 这些函数决定「拖到哪停住」「窗口变小后怎么夹」「脏数据怎么兜」——
 * 出错不会报错，只会让某一栏被挤没或拖不动。所以逐条钉住边界值。
 */

const TOTAL = 1440;

const layout = (patch: Partial<StudioLayout> = {}): StudioLayout => ({
  ...DEFAULT_STUDIO_LAYOUT,
  ...patch,
});

describe('normalizeLayout：脏数据永不抛异常', () => {
  it('非对象一律回默认', () => {
    for (const bad of [null, undefined, 0, 'x', [], true]) {
      expect(normalizeLayout(bad)).toEqual(DEFAULT_STUDIO_LAYOUT);
    }
  });

  it('宽度小于下限 → 抬到下限', () => {
    expect(normalizeLayout({ leftWidth: 10 }).leftWidth).toBe(MIN_LEFT_WIDTH);
    expect(normalizeLayout({ rightWidth: 10 }).rightWidth).toBe(MIN_RIGHT_WIDTH);
  });

  it('宽度大于上限 → 压到上限（防手改库填 99999）', () => {
    expect(normalizeLayout({ leftWidth: 99999 }).leftWidth).toBeLessThanOrEqual(900);
    expect(normalizeLayout({ rightWidth: 99999 }).rightWidth).toBeLessThanOrEqual(900);
  });

  it('非数字 → 回默认值', () => {
    const got = normalizeLayout({ leftWidth: 'abc', rightWidth: NaN });
    expect(got.leftWidth).toBe(DEFAULT_LEFT_WIDTH);
    expect(got.rightWidth).toBe(DEFAULT_RIGHT_WIDTH);
  });

  it('小数四舍五入（避免 246.7 这种宽度进 DOM）', () => {
    expect(normalizeLayout({ leftWidth: 246.7 }).leftWidth).toBe(247);
  });

  it('折叠只认字面 true：字符串 "true"、1 都不算', () => {
    expect(normalizeLayout({ leftCollapsed: 'true' }).leftCollapsed).toBe(false);
    expect(normalizeLayout({ leftCollapsed: 1 }).leftCollapsed).toBe(false);
    expect(normalizeLayout({ leftCollapsed: true }).leftCollapsed).toBe(true);
  });

  it('缺字段 → 各自回默认，不互相影响', () => {
    const got = normalizeLayout({ leftWidth: 300 });
    expect(got.leftWidth).toBe(300);
    expect(got.rightWidth).toBe(DEFAULT_RIGHT_WIDTH);
    expect(got.displayCollapsed).toBe(false);
  });
});

describe('paneWidth：折叠时就是 36px，与实际拖动宽度无关', () => {
  it('展开时返回存的宽度', () => {
    expect(paneWidth(layout({ leftWidth: 320 }), 'left')).toBe(320);
    expect(paneWidth(layout({ rightWidth: 400 }), 'right')).toBe(400);
  });

  it('折叠时一律 36', () => {
    expect(paneWidth(layout({ leftWidth: 320, leftCollapsed: true }), 'left')).toBe(COLLAPSED_WIDTH);
    expect(paneWidth(layout({ rightWidth: 400, rightCollapsed: true }), 'right')).toBe(COLLAPSED_WIDTH);
  });

  it('折叠不覆盖原来的宽度（展开要还原）', () => {
    const collapsed = layout({ leftWidth: 320, leftCollapsed: true });
    expect(paneWidth(collapsed, 'left')).toBe(36);
    expect(paneWidth({ ...collapsed, leftCollapsed: false }, 'left')).toBe(320);
  });
});

describe('maxLeftWidth / maxRightWidth：必须给中栏留 420', () => {
  it('默认布局下，左栏上限 = 总宽 - 两条分隔条 - 右栏 - 中栏', () => {
    const l = layout();
    expect(maxLeftWidth(TOTAL, l)).toBe(TOTAL - SPLITTER_WIDTH * 2 - DEFAULT_RIGHT_WIDTH - MIN_CENTER_WIDTH);
  });

  it('右栏折叠后，左栏可以拉得更宽', () => {
    const open = maxLeftWidth(TOTAL, layout());
    const collapsed = maxLeftWidth(TOTAL, layout({ rightCollapsed: true }));
    expect(collapsed).toBeGreaterThan(open);
  });

  it('右栏上限同理（扣左栏）', () => {
    const l = layout();
    expect(maxRightWidth(TOTAL, l)).toBe(TOTAL - SPLITTER_WIDTH * 2 - DEFAULT_LEFT_WIDTH - MIN_CENTER_WIDTH);
  });
});

describe('resizeLeft：拖到哪停住', () => {
  it('拖太窄 → 停在下限 180', () => {
    expect(resizeLeft(layout(), 50, TOTAL).leftWidth).toBe(MIN_LEFT_WIDTH);
  });

  it('拖太宽 → 停在「给中栏留 420」的那条线', () => {
    const got = resizeLeft(layout(), 5000, TOTAL);
    expect(got.leftWidth).toBe(maxLeftWidth(TOTAL, layout()));
  });

  it('中间值原样接受', () => {
    expect(resizeLeft(layout(), 300, TOTAL).leftWidth).toBe(300);
  });

  it('total 拿不到（jsdom 里 clientWidth=0）→ 原样返回，不猜', () => {
    const before = layout();
    expect(resizeLeft(before, 300, 0)).toBe(before);
    expect(resizeLeft(before, 300, Number.NaN)).toBe(before);
  });

  it('宽度没变 → 返回同一个对象（React 不会白重渲染）', () => {
    const before = layout({ leftWidth: 300 });
    expect(resizeLeft(before, 300, TOTAL)).toBe(before);
  });
});

describe('resizeRight：方向相反，边界同理', () => {
  it('拖太窄 → 停在 260', () => {
    expect(resizeRight(layout(), 10, TOTAL).rightWidth).toBe(MIN_RIGHT_WIDTH);
  });

  it('拖太宽 → 停在「给中栏留 420」的那条线', () => {
    const got = resizeRight(layout(), 5000, TOTAL);
    expect(got.rightWidth).toBe(maxRightWidth(TOTAL, layout()));
  });
});

describe('clampLayout：窗口变小后的兜底', () => {
  it('窗口窄到放不下时，两栏都被夹到能放下', () => {
    const wide = layout({ leftWidth: 600, rightWidth: 600 });
    const got = clampLayout(wide, 1200);
    const used = paneWidth(got, 'left') + paneWidth(got, 'right') + SPLITTER_WIDTH * 2;
    expect(used + MIN_CENTER_WIDTH).toBeLessThanOrEqual(1200 + 1); // 允许 1px 取整
  });

  it('放得下时不动（返回同一对象）', () => {
    const before = layout();
    expect(clampLayout(before, TOTAL)).toBe(before);
  });

  it('total 无效 → 原样返回', () => {
    const before = layout({ leftWidth: 600 });
    expect(clampLayout(before, 0)).toBe(before);
  });

  it('折叠状态下不会把折叠栏「撑开」', () => {
    const collapsed = layout({ leftWidth: 600, leftCollapsed: true });
    const got = clampLayout(collapsed, 1200);
    expect(got.leftCollapsed).toBe(true);
    expect(paneWidth(got, 'left')).toBe(COLLAPSED_WIDTH);
  });
});

describe('isAllCollapsed / collapseAll / expandAll', () => {
  it('三块都收才算「全部收起」', () => {
    expect(isAllCollapsed(layout())).toBe(false);
    expect(isAllCollapsed(layout({ leftCollapsed: true, rightCollapsed: true }))).toBe(false);
    expect(
      isAllCollapsed(layout({ leftCollapsed: true, rightCollapsed: true, displayCollapsed: true })),
    ).toBe(true);
  });

  it('collapseAll 之后 isAllCollapsed 为真', () => {
    expect(isAllCollapsed(collapseAll(layout()))).toBe(true);
  });

  it('expandAll 之后 isAllCollapsed 为假，且宽度还原', () => {
    const collapsed = collapseAll(layout({ leftWidth: 320, rightWidth: 400 }));
    const opened = expandAll(collapsed);
    expect(isAllCollapsed(opened)).toBe(false);
    expect(opened.leftWidth).toBe(320);
    expect(opened.rightWidth).toBe(400);
  });

  it('重复收起 / 展开是幂等的（不会来回抖）', () => {
    const once = collapseAll(layout());
    expect(collapseAll(once)).toEqual(once);
    const open = expandAll(layout());
    expect(expandAll(open)).toEqual(open);
  });
});

/* ================================================================== */
/* P4c §4 · 展示区高度（横向分隔条）                                    */
/* ================================================================== */

describe('displayHeight：默认值 / 脏数据 / 分隔条上下限', () => {
  it('默认 320；缺字段回默认，越界抬到 120', () => {
    expect(DEFAULT_STUDIO_LAYOUT.displayHeight).toBe(DEFAULT_DISPLAY_HEIGHT);
    expect(normalizeLayout({}).displayHeight).toBe(DEFAULT_DISPLAY_HEIGHT);
    expect(normalizeLayout({ displayHeight: 'abc' }).displayHeight).toBe(DEFAULT_DISPLAY_HEIGHT);
    expect(normalizeLayout({ displayHeight: 10 }).displayHeight).toBe(MIN_DISPLAY_HEIGHT);
    expect(normalizeLayout({ displayHeight: 5000 }).displayHeight).toBeLessThanOrEqual(2000);
    expect(normalizeLayout({ displayHeight: 333.6 }).displayHeight).toBe(334);
  });

  it('中栏 800 时：往下最多到 800 - 7 - 200 = 593，再往下就停住', () => {
    expect(maxDisplayHeight(800)).toBe(800 - H_SPLITTER_HEIGHT - MIN_EDITOR_HEIGHT);
    const got = resizeDisplayHeight(layout(), 5000, 800);
    expect(got.displayHeight).toBe(maxDisplayHeight(800));
    // 再来一次也一样（到限制就停，不反弹）
    expect(resizeDisplayHeight(got, 5000, 800)).toBe(got);
  });

  it('往上最多到 120（展示区最小），再往上也停住', () => {
    const got = resizeDisplayHeight(layout(), -400, 800);
    expect(got.displayHeight).toBe(MIN_DISPLAY_HEIGHT);
  });

  it('正常区间内拖动 = 拖多少算多少；原地不动返回同一对象', () => {
    expect(resizeDisplayHeight(layout(), 420, 800).displayHeight).toBe(420);
    const before = layout();
    expect(resizeDisplayHeight(before, DEFAULT_DISPLAY_HEIGHT, 800)).toBe(before);
  });

  it('中栏高度拿不到（0）时原样返回，不猜', () => {
    const before = layout();
    expect(resizeDisplayHeight(before, 500, 0)).toBe(before);
    expect(maxDisplayHeight(0)).toBe(MIN_DISPLAY_HEIGHT);
  });

  it('窗口变矮 → 只夹**渲染值**，不动存的值（fitDisplayHeight 是纯函数）', () => {
    const stored = layout({ displayHeight: 500 });
    // 中栏只剩 500：展示区只能到 500-7-200 = 293
    expect(fitDisplayHeight(stored.displayHeight, 500)).toBe(293);
    // 存的值没被改写
    expect(stored.displayHeight).toBe(500);
    // 中栏够高时原样
    expect(fitDisplayHeight(320, 800)).toBe(320);
  });
});
