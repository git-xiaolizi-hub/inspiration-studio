/**
 * M3R5 §3：连接行的「DOM 度量」判据（jsdom 里没有真实布局，所以用结构 + CSS 断言替代）。
 *
 * 为什么不在这个测试里比像素：jsdom 不做排版，`getBoundingClientRect()` 一律返回 0，
 * 拿它断言「控件右边界 ≤ 卡片右边界 − 12」永远是 0 ≤ −12 → 假绿。真实像素由承接方
 * 在 Edge（`Emulation.setDeviceMetricsOverride` 1280×900）里量，数字写在 M3R5-REPORT.md。
 *
 * 这个测试守的是「让浏览器算得出正确像素」的那几件事：
 *  1. 结构：连接表容器带 `data-conn-grid`，7 列 `data-col` 顺序固定为
 *     当前 | 协议 | base_url | key | 备注 | 计费方式(+倍率) | 删除；每行 8 个列级控件；
 *  2. 样式：`styles.css` 里这个网格有 `grid-template-columns`（可收缩的 minmax/fr）
 *     + 每个格 `min-width: 0`（input/select 默认 min-width:auto，不给 0 就会撑破网格）；
 *  3. 窄屏要换行、且仍走同一个网格（不许退回固定像素列宽）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AIConfigPanel } from './AIConfigPanel';
import { closeDatabase, destroyDatabase } from '../../core/storage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 去掉注释再断言：否则 `grid-template-columns` 里 /* 协议 */ 这样的行内注释会被当成轨道
// （jsdom 环境里 import.meta.url 是 http:// 开头，读不了文件，所以走 cwd 相对路径）
const CSS = readFileSync(resolve(process.cwd(), 'src/ui/styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** 取出以 `selector {` 开头的第一条规则（含嵌套的同前缀规则用 all 取全部） */
function ruleBlocks(selectorStart: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const at = CSS.indexOf(selectorStart, from);
    if (at === -1) break;
    const open = CSS.indexOf('{', at);
    const close = CSS.indexOf('}', open);
    if (open === -1 || close === -1) break;
    blocks.push(CSS.slice(open + 1, close));
    from = close + 1;
  }
  return blocks;
}

/** body 里所有声明拍平成 [prop, value]（够用：CSS 是扁平的，没有嵌套语法） */
function declarations(block: string): Array<[string, string]> {
  return block
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.includes(':'))
    .map((chunk) => {
      const at = chunk.indexOf(':');
      return [chunk.slice(0, at).trim(), chunk.slice(at + 1).trim()] as [string, string];
    });
}

function declaredValue(block: string, prop: string): string | null {
  const hit = declarations(block).find(([name]) => name === prop);
  return hit ? hit[1] : null;
}

let container: HTMLDivElement;
let root: Root | null = null;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 4000) throw new Error(`等待超时：${label}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function mountPanel(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AIConfigPanel />);
    await flush();
  });
  await waitFor(
    () => Boolean(container.querySelector('[data-conn-grid]')),
    '连接网格渲染',
  );
  await waitFor(
    () =>
      (Array.from(container.querySelectorAll('button')).find((button) =>
        (button.textContent ?? '').includes('保存配置'),
      ) as HTMLButtonElement | undefined)?.disabled === false,
    '配置读取完成',
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
    await flush();
  });
}

beforeEach(async () => {
  await destroyDatabase();
});

afterEach(async () => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  await closeDatabase();
});

/* ------------------------------------------------------------------ */
/* 1. 结构断言                                                          */
/* ------------------------------------------------------------------ */

describe('M3R5 §1 连接行：容器带 data-conn-grid，6 列顺序固定', () => {
  it('容器就是连接表本身（table.connection-table[data-conn-grid]）', async () => {
    await mountPanel();
    const grid = container.querySelector('[data-conn-grid]');
    expect(grid).not.toBeNull();
    expect(grid?.tagName).toBe('TABLE');
    expect(grid?.classList.contains('connection-table')).toBe(true);
    // 表头与被撑破时的区别：表头必须仍在这张表里（不许为了布局把 thead 挪走）
    expect(grid?.querySelector('thead')).not.toBeNull();
  });

  it('表头 6 列的 data-col 顺序 = 协议 | base_url | key | 备注 | 计费方式 | 删除', async () => {
    await mountPanel();
    const headers = Array.from(container.querySelectorAll('[data-conn-grid] thead th'));
    expect(headers.map((th) => th.getAttribute('data-col'))).toEqual([
      'active',
      'protocol',
      'base_url',
      'key',
      'note',
      'multiplier',
      'remove',
    ]);
    expect(headers.map((th) => (th.textContent ?? '').trim())).toEqual([
      '当前',
      '协议',
      'base_url',
      'API Key',
      '备注',
      '计费方式',
      '删除',
    ]);
  });

  it('每行的 7 个格 data-col 与表头一一对应，列级控件顺序 = 单选 | 下拉 | 地址 | Key | 备注 | 计费方式 | 删除', async () => {
    await mountPanel();
    // 先建出 1 条真实连接（0 条时的 draft 行没有「当前连接」radio，会漏测）
    await click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        (button.textContent ?? '').includes('＋ 新建连接'),
      ) as HTMLButtonElement,
    );

    const row = container.querySelector('[data-connection-row]') as HTMLElement;
    expect(row).not.toBeNull();

    const cells = Array.from(row.children) as HTMLElement[];
    expect(cells.map((cell) => cell.getAttribute('data-col'))).toEqual([
      'active',
      'protocol',
      'base_url',
      'key',
      'note',
      'multiplier',
      'remove',
    ]);

    // 每列一个控件：M3R6 起「当前」单选独立成第一列
    const primary = [
      cells[0].querySelector('input[type="radio"]'),
      cells[1].querySelector('select'),
      cells[2].querySelector('input[type="text"]'),
      cells[3].querySelector('input[type="password"]'),
      cells[4].querySelector('input[type="text"]'),
      cells[5].querySelector('select'),
      cells[6].querySelector('button'),
    ];
    expect(primary.map((el) => el?.getAttribute('aria-label'))).toEqual([
      '当前连接 1',
      '协议 1',
      '服务地址 1',
      'API Key 1',
      '连接备注 1',
      '计费方式 1',
      '删除连接 1',
    ]);

    // 首列的 radio 必须是同一组（name 一致 = 互斥）
    expect(cells[0].querySelector('input')?.getAttribute('name')).toBe('active-conn');
    // 「备注」列只剩一个文本框（radio 已经搬走）
    const noteCellInputs = Array.from(cells[4].querySelectorAll('input'));
    expect(noteCellInputs).toHaveLength(1);
    expect(noteCellInputs[0].getAttribute('aria-label')).toBe('连接备注 1');

    // 计费方式这一格是「下拉 + 倍率输入」两个控件（中转站才需要填数字）
    expect(cells[5].querySelectorAll('select, input')).toHaveLength(2);
    expect(cells[5].querySelector('input')?.getAttribute('aria-label')).toBe('倍率 1');

    const all = Array.from(row.querySelectorAll('input, select, button, textarea'));
    expect(all).toHaveLength(8);
  });

  it('6 列各自都在同一个网格里（不许再有 nth-child 定死像素列宽的老写法）', () => {
    // 老的「撑破卡片」写法：给某列写死最小宽度并把地址栏 width:100%
    expect(CSS).not.toContain('.connection-table th:nth-child(1)');
    expect(CSS).not.toContain('min-width: 210px');
    expect(CSS).not.toContain('min-width: 240px');
    expect(CSS).not.toContain('min-width: 200px');
  });
});

/* ------------------------------------------------------------------ */
/* 2. 样式断言（CSS 里必须能收缩 + 防撑破）                              */
/* ------------------------------------------------------------------ */

describe('M3R5 §1 样式：网格可收缩，格子 min-width: 0', () => {
  it('连接表是 display:grid + grid-template-columns，且用 minmax/fr（可收缩）', () => {
    const blocks = ruleBlocks('.ai-config-page .connection-table {');
    expect(blocks.length).toBeGreaterThan(0);
    const base = blocks[0];
    expect(declaredValue(base, 'display')).toBe('grid');
    const template = declaredValue(base, 'grid-template-columns');
    expect(template).not.toBeNull();
    expect(template).toContain('minmax(');
    // 7 条轨道 = 7 列（先把 minmax(...) 折成一个占位符，再数空格分隔的轨道）
    const tracks = (template ?? '').replace(/minmax\([^)]*\)/g, 'TRACK').trim().split(/\s+/);
    expect(tracks).toHaveLength(7);
    // 四列可伸缩 + 三列定宽（当前 / 倍率 / 删除按钮不需要大空间）
    expect((template ?? '').match(/minmax\(/g) ?? []).toHaveLength(4);
    // 列间距走 gap，不再靠单元格左右 padding 撑出对齐（那种对齐一换行就散）
    expect(declaredValue(base, 'column-gap')).not.toBeNull();
  });

  it('每个格（th/td）都有 min-width: 0 —— 否则 input 不肯收缩，还是会把卡片撑破', () => {
    const blocks = ruleBlocks('.ai-config-page .connection-table th,');
    const cellRule = blocks.find((block) => declaredValue(block, 'min-width') === '0');
    expect(cellRule).toBeDefined();
  });

  it('格内控件也 min-width: 0（覆盖 .model-table input 的 min-width: 90px）', () => {
    const blocks = ruleBlocks('.ai-config-page .connection-table td :is(input, select)');
    const block = blocks[0];
    expect(block).toBeDefined();
    expect(declaredValue(block, 'min-width')).toBe('0');
    expect(declaredValue(block, 'width')).toBe('100%');
  });

  it('窄屏（<1000px）有换行规则，仍然用同一个网格（不许回到固定像素）', () => {
    const at = CSS.indexOf('@media (max-width: 999px)');
    expect(at).toBeGreaterThan(-1);
    const open = CSS.indexOf('{', at);
    // 取到媒体查询结束（内部规则是扁平的：找到与之配对的收尾大括号）
    let depth = 0;
    let close = -1;
    for (let index = open; index < CSS.length; index += 1) {
      if (CSS[index] === '{') depth += 1;
      if (CSS[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    expect(close).toBeGreaterThan(open);
    const media = CSS.slice(open + 1, close);
    expect(media).toContain('.ai-config-page .connection-table');
    expect(media).toContain('grid-template-columns');
    expect(media).toContain('minmax(0');
  });
});

/* ------------------------------------------------------------------ */
/* 3. 高度：说明文字合并成一行（结构层可断言的部分）                      */
/* ------------------------------------------------------------------ */

describe('M3R5 §2 说明文字：连接区只留一行字，长句进 title', () => {
  it('连接卡片里只剩 1 条说明段落，且 0 条连接时提示被并进这一行', async () => {
    await mountPanel();
    const card = container.querySelector('[data-block="connections"]') as HTMLElement;
    const notes = Array.from(card.querySelectorAll('p.muted'));
    expect(notes).toHaveLength(1);

    const line = notes[0];
    // 长句（"多一条就多一行，不做嵌套…"）挪进 title，不再占版面高度
    expect(line.getAttribute('title') ?? '').toContain('不做嵌套');
    // 删掉的那段其实还在（hover 能看），且原提示语仍是正文的一部分
    expect(line.textContent ?? '').toContain('一行 = 一条连接');
    expect(line.querySelector('[data-testid="first-connection-hint"]')?.textContent ?? '').toContain(
      '这里填的就是这家厂商的第一条连接',
    );
    // 不许有用 <br> 强行折行的偷懒做法
    expect(line.querySelector('br')).toBeNull();
  });
});
