/**
 * 外观主题（P1.5）：四个**具名**选项，一组互斥单选。
 *
 * 委托人原话：「跟随系统似乎没有必要了…不如直接给用户展示主题名称吧：
 * 柔和奶油、罗兰梦境、霓虹深空、暖夜琥珀」。
 *
 * 断言走**真交互**（点 radio → 改 <html> 属性 + 落库），不只查文案：
 * 上一轮的教训是「jsdom 全绿但按钮点不动」，所以这里必须验到 data-theme 真的变了。
 *
 * 注意：落库走 IndexedDB（fake-indexeddb），一次点击要跨好几个 tick 才写完。
 * 所以断言一律用 waitFor 轮询，不写「等 0ms 就断言」—— 那是必翻的假失败。
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeSection } from './ThemeSection';
import { closeDatabase, destroyDatabase, getSetting, putSetting } from '../../core/storage';
import { THEME_SETTING_KEY } from '../../core/theme/session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(node: ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
    await flush();
    await flush();
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
    await flush();
  });
  root = null;
  container.remove();
}

/** 按 value 找那一组的 radio（不按索引：索引不是标识） */
function radio(value: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`input[name="theme"][value="${value}"]`);
  if (!found) throw new Error(`找不到 theme=${value} 的选项`);
  return found;
}

async function click(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.click();
    await flush();
  });
}

/** 等一个条件成立（最多 2 秒）。IndexedDB 的写入要跨几个 tick。 */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 2000) throw new Error(`等待超时：${label}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function themeAttr(): string | null {
  return document.documentElement.getAttribute('data-theme');
}

beforeEach(async () => {
  await destroyDatabase();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-scheme');
});

afterEach(async () => {
  await unmount();
  await closeDatabase();
});

describe('外观主题：四个具名选项', () => {
  it('四个真选项全是 radio，另有两个「敬请期待」占位（不是 radio、不可点）', async () => {
    await mount(<ThemeSection />);
    const all = container.querySelectorAll('input');
    expect(all.length).toBe(4);
    for (const input of Array.from(all)) {
      expect((input as HTMLInputElement).type).toBe('radio');
      expect((input as HTMLInputElement).name).toBe('theme');
    }
    expect(Array.from(all).map((input) => (input as HTMLInputElement).value)).toEqual([
      'clay',
      'amber',
      'violet',
      'neon',
    ]);
  });

  it('四个显示名就是委托人给的叫法，顺序一致', async () => {
    await mount(<ThemeSection />);
    const labels = Array.from(container.querySelectorAll('.theme-option-label')).map((node) =>
      (node.textContent ?? '').trim(),
    );
    // 占位块也会命中 .theme-option-label，所以只比前四个真选项
    expect(labels.slice(0, 4)).toEqual(['柔和奶油', '暖夜琥珀', '罗兰梦境', '霓虹深空']);
    expect(labels.slice(4)).toEqual(['敬请期待', '敬请期待']);
  });

  it('每个选项都有那句一行的说明', async () => {
    await mount(<ThemeSection />);
    const hints = Array.from(container.querySelectorAll('.theme-option:not(.is-placeholder) .theme-option-hint')).map(
      (node) => node.textContent ?? '',
    );
    expect(hints).toHaveLength(4);
    for (const hint of hints) expect(hint.length).toBeGreaterThan(8);
  });

  it('不再有「跟随系统」「深浅」「气质」，也不露内部代号', async () => {
    await mount(<ThemeSection />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('跟随系统');
    expect(text).not.toContain('深浅');
    expect(text).not.toContain('气质');
    for (const codeName of ['clay', 'amber', 'violet', 'neon']) {
      expect(text).not.toContain(codeName);
    }
  });

  it('首次打开（无任何存储）默认「柔和奶油」', async () => {
    await mount(<ThemeSection />);
    expect(radio('clay').checked).toBe(true);
    for (const other of ['violet', 'neon', 'amber']) expect(radio(other).checked).toBe(false);
  });

  it('区块标题是「外观主题」，四个主题名都在；提示行已按委托人要求删除', async () => {
    await mount(<ThemeSection />);
    expect(container.querySelector('h3')?.textContent).toBe('外观主题');
    const text = container.textContent ?? '';
    for (const label of ['柔和奶油', '暖夜琥珀', '罗兰梦境', '霓虹深空']) {
      expect(text).toContain(label);
    }
    // 委托人 2026-10-28：删掉「当前：…；外观随备份一起导出/导入…」这行小字
    expect(text).not.toContain('当前：');
  });
});

describe('外观主题：点选真的生效并落库', () => {
  it('点「暖夜琥珀」→ data-theme=amber / data-scheme=dark，库里只存 theme', async () => {
    await mount(<ThemeSection />);
    await click(radio('amber'));
    await waitFor(() => themeAttr() === 'amber', '暖夜琥珀生效');
    expect(document.documentElement.getAttribute('data-scheme')).toBe('dark');
    expect(radio('amber').checked).toBe(true);

    const row = await getSetting(THEME_SETTING_KEY);
    expect(row?.value).toMatchObject({ theme: 'amber' });
    expect(row?.value).not.toHaveProperty('scheme');
  });

  it('点「罗兰梦境」→ violet / light；再点「霓虹深空」→ neon / dark', async () => {
    await mount(<ThemeSection />);
    await click(radio('violet'));
    await waitFor(() => themeAttr() === 'violet', '罗兰梦境生效');
    expect(document.documentElement.getAttribute('data-scheme')).toBe('light');

    await click(radio('neon'));
    await waitFor(() => themeAttr() === 'neon', '霓虹深空生效');
    expect(document.documentElement.getAttribute('data-scheme')).toBe('dark');
  });

  it('选中态跟着落库值走：重挂载后仍是上次选的那一套', async () => {
    await mount(<ThemeSection />);
    await click(radio('neon'));
    await waitFor(() => themeAttr() === 'neon', '霓虹深空生效');

    await unmount();
    await mount(<ThemeSection />);
    await waitFor(() => radio('neon').checked, '重挂载后仍是霓虹深空');
  });

  it('库里是 M7 的旧偏好（深色 + 克制）→ 面板显示「暖夜琥珀」被选中', async () => {
    await putSetting({
      key: THEME_SETTING_KEY,
      value: { theme: 'clay', scheme: 'dark', mood: 'calm', updatedAt: 1 },
      updatedAt: 1,
    });
    await mount(<ThemeSection />);
    await waitFor(() => radio('amber').checked, '旧数据折算成暖夜琥珀');
    expect(radio('amber').checked).toBe(true);
  });
});
