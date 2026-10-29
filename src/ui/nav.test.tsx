import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

/**
 * P0.5 · 外壳导航的「收起但不失联」。
 *
 * 上一轮出过的事故：导航砍成三项的同时顺手删了 `/model-guide` 路由。
 * 所以这里锁两件事：
 *  1. 顶栏**只有三项**（首页 / 创作 / 设置）——D2 决议；
 *  2. 原六项入口搬到设置页后**都能点到**，且八个路由一个不少（改 URL 也不落到「页面不存在」）。
 *     P2 起 `/video` 被授权删掉（九个变八个）：视频能力并进了单卡创作的「生视频」tab，
 *     所以这里少的是**一个已知路由**，而且专门加了一条用例盯「访问它落到兜底页」。
 *
 * 注意：这些是**新增**断言。`App.test.tsx` 里的锁定断言（`toContain('记录列表')` 等）一个字没改。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  // 让页面里未完成的 IndexedDB 查询 / 300ms 搜索防抖定时器先落地再卸载：
  // 否则它们在 jsdom 环境销毁后才 setState，vitest 会报一串 "environment was torn down"。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  window.location.hash = '';
});

function renderAt(hash: string): HTMLElement {
  window.location.hash = hash;
  root = createRoot(container);
  act(() => {
    root?.render(<App />);
  });
  return container;
}

function hrefsOf(scope: ParentNode, selector: string): string[] {
  return Array.from(scope.querySelectorAll(selector)).map(
    (node) => node.getAttribute('href') ?? '',
  );
}

describe('顶栏收成三项（D2）', () => {
  it('首页顶栏只有三个链接：/ · /create · /settings，文字是 首页 / 创作 / 设置', () => {
    const dom = renderAt('');
    const nav = dom.querySelector('.app-nav');
    expect(nav).not.toBeNull();

    expect(hrefsOf(nav as ParentNode, 'a')).toEqual(['#/', '#/create', '#/settings']);
    expect((nav as HTMLElement).textContent?.replace(/\s+/g, '')).toBe('首页创作设置');
  });

  it('不再把 画布 / 画板 / 视频 / AI 配置 放在顶栏', () => {
    const dom = renderAt('');
    const navHrefs = hrefsOf(dom.querySelector('.app-nav') as ParentNode, 'a');

    for (const moved of ['#/canvas', '#/workflow', '#/video', '#/ai-config', '#/model-guide']) {
      expect(navHrefs).not.toContain(moved);
    }
  });

  it('顶栏没有「+ 新建记录」按钮，也没有额外的「导入」入口（入口唯一性）', () => {
    const dom = renderAt('');
    const nav = dom.querySelector('.app-nav') as HTMLElement;

    expect(nav.querySelector('button')).toBeNull();
    expect(nav.textContent).not.toContain('新建');
    expect(nav.textContent).not.toContain('导入');
  });

  it('产品名固定为「灵感工坊」（「灵感手记」只是设计稿占位名）', () => {
    const dom = renderAt('');
    expect(dom.querySelector('.app-header h1')?.textContent).toBe('灵感工坊');
  });
});

describe('设置页承接原六项入口（收起导航 ≠ 眼睛看不到页面）', () => {
  /**
   * R6：委托人判「快捷创作完全没有必要，直接从导航栏过去更方便」→ 整块删除。
   * 授权范围：原来断言它**存在**的四条用例（磁贴文案 / 四行顺序 / 六块标题 / 左目录顺序）
   * 改成断言新结构。**路由一个都没删** —— 下面「八个路由一个不少」那组仍然逐条渲染。
   */
  it('「快捷创作」整块已删除（页面里搜不到，三个磁贴随之消失）', () => {
    const dom = renderAt('#/settings');
    expect(dom.querySelector('[data-block="create-tools"]')).toBeNull();
    expect(dom.querySelector('.entry-tiles')).toBeNull();
    expect(dom.textContent ?? '').not.toContain('快捷创作');
    expect(dom.textContent ?? '').not.toContain('工作流画板');
    expect(dom.textContent ?? '').not.toContain('单卡创作');
  });

  it('「AI 配置」区块：配置模型按钮 + 选型指南链接（自由配置入口已并入弹窗）', () => {
    const dom = renderAt('#/settings');
    const block = dom.querySelector('[data-block="model-vendors"]');
    expect(block).not.toBeNull();
    expect(block?.querySelector('h3')?.textContent).toBe('AI 配置');
    // R7d：配置只有一个入口（弹窗），剩下的是选型指南。`/ai-config` 老地址会重定向到设置页。
    expect(hrefsOf(block as ParentNode, '.ai-card-actions a')).toEqual(['#/model-guide']);
    expect(block?.querySelector('[data-testid="ai-card-recommend"]')?.textContent).toBe('配置模型');
  });

  it('R7b 起只有四张卡，两行两列：高卡一行（AI 配置 / 用户数据）、矮卡一行（语音识别 / 外观主题）', () => {
    const dom = renderAt('#/settings');
    const cards = Array.from(dom.querySelectorAll('.settings-grid > section.card'));
    const order = cards.map((card) => card.getAttribute('data-block'));

    // DOM 顺序就是视觉顺序（网格只是把左右两栏钉死），所以直接断言完整序列
    // 委托人 2026-10-28：把较高的两张放同一行、较矮的两张放同一行；DOM 顺序跟视觉一致
    expect(order).toEqual(['model-vendors', 'userdata', 'voice', 'theme']);
    expect(cards).toHaveLength(4);
  });

  it('四张卡的标题：AI 配置 / 语音识别 / 外观主题 / 用户数据（预算限额也删了）', () => {
    const dom = renderAt('#/settings');
    const titleOf = (block: string): string | undefined =>
      dom.querySelector(`[data-block="${block}"] > h3`)?.textContent ?? undefined;

    expect(titleOf('model-vendors')).toBe('AI 配置');
    expect(titleOf('voice')).toBe('语音识别');
    expect(titleOf('theme')).toBe('外观主题');
    expect(titleOf('userdata')).toBe('用户数据');

    // R6 删掉的第二张卡
    expect(dom.querySelector('[data-block="spend"]')).toBeNull();
    expect(dom.textContent ?? '').not.toContain('预算限额');
    // 预算的输入框 / 只读读数 / 重置按钮一起消失（数据层的 budgetLimit 与 ai-spend 字段保留）
    expect(dom.querySelector('input[aria-label="预算上限"]')).toBeNull();
    expect(dom.textContent ?? '').not.toContain('重置累计');
  });

  it('左目录同步成四项，顺序与卡片视觉顺序一致：AI 配置 / 用户数据 / 语音识别 / 外观主题', () => {
    const dom = renderAt('#/settings');
    // 目录项里带一个装饰图标（<i aria-hidden>），比对文字前先摘掉它
    const labels = Array.from(dom.querySelectorAll('.rail-item')).map((node) => {
      const clone = node.cloneNode(true) as HTMLElement;
      clone.querySelector('.rail-item-icon')?.remove();
      return (clone.textContent ?? '').trim();
    });
    expect(labels).toEqual(['AI 配置', '用户数据', '语音识别', '外观主题']);
  });

  it('设置页不再有「自由配置」入口：配置只在「配置模型」弹窗里做', () => {
    const dom = renderAt('#/settings');
    expect(hrefsOf(dom, 'a')).not.toContain('#/ai-config');
    expect(dom.textContent ?? '').not.toContain('自由配置');
  });

  it('导入入口仍然只有一处（在「用户数据」里，不是顶栏也不是别处新增按钮）', () => {
    const dom = renderAt('#/settings');
    const labels = Array.from(dom.querySelectorAll('input[type="file"]')).map((node) =>
      node.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['导入完整备份']);
  });
});

describe('八个路由一个不少（真渲染，不是看代码）', () => {
  const routes: Array<{ hash: string; marker: string; label: string }> = [
    { hash: '', marker: '记录列表', label: '/' },
    { hash: '#/records/nav-1', marker: '记录详情', label: '/records/:id' },
    { hash: '#/settings', marker: '设置', label: '/settings' },
    { hash: '#/ai-config', marker: 'AI 配置', label: '/ai-config' },
    { hash: '#/model-guide', marker: '怎么选厂商与模型', label: '/model-guide' },
    { hash: '#/studio', marker: '写作工作台', label: '/studio' },
    { hash: '#/workflow', marker: '正在加载画板', label: '/workflow' },
    { hash: '#/create', marker: '创作', label: '/create' },
  ];

  for (const route of routes) {
    it(`${route.label} 渲染成功，不落到「页面不存在」`, () => {
      const text = renderAt(route.hash).textContent ?? '';
      expect(text).not.toContain('页面不存在');
      expect(text).toContain(route.marker);
    });
  }
});

/**
 * P2：`/video` 是**唯一被授权删除**的路由（委托方：「视频页是冗余，应该加入单卡创作」）。
 * 访问它必须落到兜底路由 —— 不许白屏，也不许再出现「视频生成」那一页。
 */
describe('/video 已经是死路由（P2 授权删除）', () => {
  it('访问 #/video 落到「页面不存在」，顶栏仍在（不白屏、能自己走出去）', () => {
    const dom = renderAt('#/video');
    expect(dom.textContent ?? '').toContain('页面不存在');
    expect(dom.textContent ?? '').not.toContain('视频生成');
    expect(hrefsOf(dom.querySelector('.app-nav') as ParentNode, 'a')).toEqual([
      '#/',
      '#/create',
      '#/settings',
    ]);
  });
});

/**
 * P1.5 §3：点「首页」要真的回到列表顶部。
 *
 * 委托人报的是「点了没反应」。实测路由是对的，问题分两种：
 * 已经在首页（路由不变 → 组件不重挂载 → 必须由 onClick 滚）、
 * 以及从别的页面回来（新页面挂载时要滚）。
 * jsdom 量不到真实 scrollY，所以这里断的是**真的调了 window.scrollTo 且参数对**；
 * 真实浏览器里的 scrollY 读数见 docs/P1.5-REPORT.md。
 */
describe('点「首页」回到列表顶部（P1.5 §3）', () => {
  function homeLink(dom: HTMLElement): HTMLAnchorElement {
    const found = Array.from(dom.querySelectorAll('.app-nav a')).find(
      (node) => (node.textContent ?? '').trim() === '首页',
    );
    if (!found) throw new Error('顶栏里找不到「首页」');
    return found as HTMLAnchorElement;
  }

  it('① 已经在首页时点「首页」→ 立刻滚顶（路由没变也要有反应）', async () => {
    const dom = renderAt('');
    const spy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    // 挂载时 RecordListPage 已经滚过一次，这里清掉，只看这次点击
    spy.mockClear();

    await act(async () => {
      homeLink(dom).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(spy).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
    spy.mockRestore();
  });

  it('② 从详情页点「首页」→ 回到 #/ 且滚顶', async () => {
    const dom = renderAt('#/records/nav-scroll-1');
    const spy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    await act(async () => {
      homeLink(dom).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(window.location.hash).toBe('#/');
    expect(dom.textContent).toContain('记录列表');
    expect(spy).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
    spy.mockRestore();
  });

  it('③ 从其它页（设置）点「首页」→ 回到 #/ 且滚顶', async () => {
    const dom = renderAt('#/settings');
    const spy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    await act(async () => {
      homeLink(dom).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(window.location.hash).toBe('#/');
    expect(spy).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
    spy.mockRestore();
  });
});
