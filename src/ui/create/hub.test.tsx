/**
 * 创作入口页（P2 §1）判据。
 *
 * 这里锁六件事：
 *  1. `/create` 不带 recordId → 落入口页（三块磁贴），**不再出现「没有指定记录」这种死路**；
 *  2. `/create?recordId=xxx` → **仍然直达单卡创作**（详情页「进入创作」的深链不许坏）；
 *  3. 三块磁贴的跳转目标：画板 /workflow、工作台 /canvas（暂时）、记录 /create?recordId=；
 *  4. 单卡创作卡里是「最近 7 条 + 查看全部 N 条」；
 *  5. 两卡的标题都是各自卡片的第一子元素（**y 坐标能对齐的结构前提**；
 *     真实像素差在浏览器里量，见 docs/P2-REPORT.md）；
 *  6. 一条记录都没有时不留空白格，给一句能照着做的提示。
 *
 * jsdom 里没有布局引擎，所以「等高 / 同一条水平线」只能断结构；
 * 真实数字（scrollHeight、标题 y、记录数）来自真浏览器读数。
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CreateRoute } from './CreatePage';
import { HUB_RECORD_LIMIT, hubStamp } from './CreateHub';
import { createRecord } from '../../core/records';
import { destroyDatabase } from '../../core/storage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  await destroyDatabase();
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mountAt(entry: string): void {
  root = createRoot(container);
  act(() => {
    root?.render(
      <MemoryRouter initialEntries={[entry]}>
        <CreateRoute />
      </MemoryRouter>,
    );
  });
}

function text(): string {
  return container.textContent ?? '';
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

describe('入口页：三块磁贴（无 recordId）', () => {
  it('落到入口页：三块磁贴都在，且不再出现「没有指定记录」', async () => {
    await createRecord({ text: '凌晨三点的图书馆' });
    mountAt('/create');
    await flush();

    expect(byTestId('hub-tile-workflow')).not.toBeNull();
    expect(byTestId('hub-tile-writing')).not.toBeNull();
    expect(byTestId('hub-tile-card')).not.toBeNull();

    // 委托方原话：以前从这里进去是死路（只有一句「没有指定记录：……」）
    expect(text()).not.toContain('没有指定记录');
    expect(text()).toContain('从一条想法到成片。选一种方式开始。');
    // 单卡创作的 tab 不该在这一页出现（那是 recordId 分支）
    expect(byTestId('create-tab-dream')).toBeNull();
  });

  it('两卡顺序与跳转：画板 → /workflow，工作台 → /studio', async () => {
    mountAt('/create');
    await flush();

    const tiles = Array.from(container.querySelectorAll('.hub-grid > .hub-tile'));
    expect(tiles).toHaveLength(3);
    // 第一行两张卡、第三块跨两列
    expect(tiles[0].getAttribute('href')).toBe('/workflow');
    // P3：画布换成写作工作台，磁贴直指 /studio（/canvas 只是给旧书签留的重定向）
    expect(tiles[1].getAttribute('href')).toBe('/studio');
    expect(tiles[2].getAttribute('href')).toBeNull();
    expect(tiles[2].className).toContain('hub-tile-wide');
  });

  it('「主推」标签在标题内部（同一行右侧），两张卡的标题都是各自卡的第一子元素', async () => {
    mountAt('/create');
    await flush();

    const tileA = byTestId('hub-tile-workflow') as HTMLElement;
    const tileB = byTestId('hub-tile-writing') as HTMLElement;

    const titleA = tileA.querySelector('h3') as HTMLElement;
    const titleB = tileB.querySelector('h3') as HTMLElement;

    expect(titleA.textContent).toBe('工作流画板主推');
    expect(titleB.textContent).toBe('写作工作台');

    // 「主推」是 h3 里的 inline 标签，不是单独一行
    const kicker = titleA.querySelector('.hub-kicker');
    expect(kicker).not.toBeNull();
    expect(kicker?.textContent).toBe('主推');
    expect(titleB.querySelector('.hub-kicker')).toBeNull();

    // 结构前提：标题是各自卡片里的第一个子元素 → 两卡 padding 相同即同一水平线
    expect(tileA.firstElementChild).toBe(titleA);
    expect(tileB.firstElementChild).toBe(titleB);
  });

  it('单卡创作卡：最近 7 条 + 「查看全部 N 条」（N = 总条数）', async () => {
    for (let index = 0; index < 12; index += 1) {
      await createRecord({ text: `第 ${index + 1} 条梦`, tags: ['梦'] });
    }
    mountAt('/create');
    await flush();

    const records = container.querySelectorAll('.hub-recs .hub-rec:not(.hub-rec-more)');
    expect(records).toHaveLength(HUB_RECORD_LIMIT);
    expect(HUB_RECORD_LIMIT).toBe(7);

    const more = byTestId('hub-more');
    expect(more?.textContent?.replace(/\s+/g, '')).toBe('查看全部12条→');

    // 每张记录卡都是单卡创作的深链
    for (const node of Array.from(records)) {
      expect(node.getAttribute('href')).toMatch(/^\/create\?recordId=/);
    }
    // 记录卡底部有标签与时间
    expect(container.querySelector('.hub-rec-tag')?.textContent).toBe('#梦');
    expect(text()).toMatch(/(今天|昨天|\d{2}-\d{2}) \d{2}:\d{2}/);
  });

  it('一条记录都没有：给一句能照着做的提示，不渲染「查看全部」空壳', async () => {
    mountAt('/create');
    await flush();

    expect(text()).toContain('还没有记录');
    expect(text()).toContain('去首页写下第一条');
    expect(byTestId('hub-more')).toBeNull();
  });
});

describe('深链：带 recordId 仍然直达单卡创作（P2 硬要求）', () => {
  it('/create?recordId=xxx 渲染单卡创作，不是入口页', async () => {
    const record = await createRecord({ text: '我梦见一只白猫坐在窗台上。' });
    mountAt(`/create?recordId=${record.id}`);
    await flush();

    // 单卡创作的四个 tab 在
    for (const id of ['dream', 'copy', 'image', 'video']) {
      expect(byTestId(`create-tab-${id}`)).not.toBeNull();
    }
    // 入口页的磁贴不在
    expect(byTestId('hub-tile-workflow')).toBeNull();
    // 记录正文摘要读到了（说明 recordId 确实传进去了）
    expect(text()).toContain('白猫');
  });

  it('recordId 为空串（?recordId=）按「没有记录」处理 → 入口页', async () => {
    const record = await createRecord({ text: '一条记录' });
    expect(record.id).not.toBe('');
    mountAt('/create?recordId=');
    await flush();

    expect(byTestId('hub-tile-workflow')).not.toBeNull();
  });
});

describe('hubStamp：列表页用完整日期，入口页空间窄用相对说法', () => {
  const now = new Date(2026, 9, 21, 15, 30, 0).getTime();

  it('今天 / 昨天 / 更早分别用三种写法', () => {
    expect(hubStamp(new Date(2026, 9, 21, 12, 3).getTime(), now)).toBe('今天 12:03');
    expect(hubStamp(new Date(2026, 9, 20, 23, 41).getTime(), now)).toBe('昨天 23:41');
    expect(hubStamp(new Date(2026, 9, 19, 18, 2).getTime(), now)).toBe('10-19 18:02');
  });

  it('时间戳坏掉时给「—」，不编一个日期', () => {
    expect(hubStamp(0, now)).toBe('—');
    expect(hubStamp(Number.NaN, now)).toBe('—');
  });
});
