/**
 * P2b · 首页的置顶 / 合集 / 合集内排序（真 DOM 行为）。
 *
 * 这一套盯的是任务书 §4「真浏览器验证」里能在 jsdom 里复现的部分：
 * 置顶后从「全部」消失、置顶顺序、刷新后仍在、合集筛选、拖拽换序、
 * **「全部」视图不响应拖拽**、组合筛选叠加、删记录后不报错、空合集名被拒绝。
 *
 * 备份往返（导出 zip → 清库 → 导入）在 `core/backup/library-backup.test.ts`。
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordListPage } from './RecordListPage';
import { closeDatabase, destroyDatabase } from '../../core/storage';
import { createRecord, removeRecord } from '../../core/records';
import { saveVoiceSettings } from '../../core/settings';
import { createCollection, loadLibrary, saveLibrary } from '../../core/library';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(async () => {
  await destroyDatabase();
  // 先把语音方式定下来，免得首启引导面板挡在列表前面
  await saveVoiceSettings({ mode: 'record-only' });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  // 让未完成的 IndexedDB 查询 / 300ms 搜索防抖定时器先落地再卸载（同 nav.test.tsx）
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  await closeDatabase();
});

async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * 轮询直到断言通过，最多等 3s。
 *
 * 为什么需要：P5 之后全量测试从 78 个文件跑，并发变高，`await click()` 之后
 * 单次 flush 有时还没等到 IndexedDB 查询回来（列表仍是上一帧的空数组）。
 * 即时断言就会偶发红 —— 不是代码错，是「测试没等」。
 */
async function waitFor(check: () => void, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  for (;;) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() - start >= timeoutMs) throw lastError;
    }
  }
}

function mount(): void {
  root = createRoot(container);
  act(() => {
    root?.render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <RecordListPage />
      </MemoryRouter>,
    );
  });
}

/** 「刷新页面」= 卸载再挂载：数据只能从 IndexedDB 里拿回来 */
async function remount(): Promise<void> {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  mount();
  await flush();
}

async function click(element: Element | null): Promise<void> {
  expect(element, '要点的元素应该存在').not.toBeNull();
  await act(async () => {
    (element as HTMLElement).click();
  });
  await flush();
}

async function typeInto(input: HTMLInputElement | null, value: string): Promise<void> {
  expect(input, '输入框应该存在').not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    // 搜索有 300ms 防抖
    await new Promise((resolve) => setTimeout(resolve, 360));
  });
  await flush();
}

const allList = () => container.querySelector('ul[data-view="all"]') as HTMLUListElement | null;
const collectionList = () =>
  container.querySelector('ul[data-view="collection"]') as HTMLUListElement | null;

function texts(list: HTMLUListElement | null): string[] {
  if (!list) return [];
  return Array.from(list.querySelectorAll('.record-text')).map((node) => node.textContent ?? '');
}

function allItems(): HTMLLIElement[] {
  return Array.from(container.querySelectorAll('ul[data-view] > li')) as HTMLLIElement[];
}

function itemByText(text: string): HTMLLIElement {
  const found = allItems().find((item) => item.textContent?.includes(text));
  expect(found, `列表里应该有「${text}」`).toBeDefined();
  return found!;
}

function pinnedCards(): HTMLLIElement[] {
  return Array.from(container.querySelectorAll('.pinned-card')) as HTMLLIElement[];
}

function collectionChips(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('.collection-chip')) as HTMLButtonElement[];
}

function dragEvent(type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  return event;
}

/**
 * 拖拽必须分三个 act 派发：dragstart 里 setDragId 是 React 状态，
 * 同一次 act 内 drop 拿到的还是旧闭包（dragId 仍是 null）。
 */
async function dragOnto(source: HTMLLIElement, target: HTMLLIElement): Promise<void> {
  await act(async () => {
    source.dispatchEvent(dragEvent('dragstart'));
  });
  await act(async () => {
    target.dispatchEvent(dragEvent('dragover'));
  });
  await flush(1);
  await act(async () => {
    target.dispatchEvent(dragEvent('drop'));
  });
  await flush();
}

/** 造记录时错开几毫秒：createdAt 相同的话时间倒序会退化成按 id 排，断言就不稳 */
async function createSpaced(text: string, tags: string[] = []): Promise<{ id: string }> {
  await new Promise((resolve) => setTimeout(resolve, 3));
  return createRecord({ text, tags });
}

describe('A. 置顶', () => {
  it('点卡片右上角 📌：进置顶区，同时从「全部」里消失（不重复）', async () => {
    const first = await createRecord({ text: '第一条：会呼吸的图书馆', tags: ['梦'] });
    await createRecord({ text: '第二条：房间里的家具', tags: ['灵感'] });

    mount();
    await flush();
    expect(texts(allList())).toHaveLength(2);
    expect(pinnedCards()).toHaveLength(0);

    await click(itemByText('第一条').querySelector('.record-pin'));

    expect(pinnedCards()).toHaveLength(1);
    expect(pinnedCards()[0].textContent).toContain('第一条：会呼吸的图书馆');
    expect(texts(allList())).toEqual(['第二条：房间里的家具']);
    expect((await loadLibrary()).pins).toEqual([first.id]);
  });

  it('置顶 3 条：置顶区按置顶先后顺序显示', async () => {
    const a = await createRecord({ text: 'A 记录' });
    const b = await createRecord({ text: 'B 记录' });
    const c = await createRecord({ text: 'C 记录' });

    mount();
    await flush();

    await click(itemByText('C 记录').querySelector('.record-pin'));
    await click(itemByText('A 记录').querySelector('.record-pin'));
    await click(itemByText('B 记录').querySelector('.record-pin'));

    expect(pinnedCards().map((card) => card.textContent ?? '')).toEqual([
      expect.stringContaining('C 记录'),
      expect.stringContaining('A 记录'),
      expect.stringContaining('B 记录'),
    ]);
    expect((await loadLibrary()).pins).toEqual([c.id, a.id, b.id]);
  });

  it('置顶后刷新页面：仍在置顶区，且仍不在「全部」里', async () => {
    await createRecord({ text: '会被置顶的记录' });
    await createRecord({ text: '普通记录' });

    mount();
    await flush();
    await click(itemByText('会被置顶的记录').querySelector('.record-pin'));
    await remount();

    expect(pinnedCards()).toHaveLength(1);
    expect(pinnedCards()[0].textContent).toContain('会被置顶的记录');
    expect(texts(allList())).toEqual(['普通记录']);
  });

  it('置顶后再点一次 📌：取消置顶，回到「全部」', async () => {
    await createRecord({ text: '来回置顶的记录' });
    mount();
    await flush();

    await click(itemByText('来回置顶的记录').querySelector('.record-pin'));
    expect(pinnedCards()).toHaveLength(1);

    await click(pinnedCards()[0].querySelector('.pin-toggle'));
    expect(pinnedCards()).toHaveLength(0);
    expect(texts(allList())).toEqual(['来回置顶的记录']);
    expect((await loadLibrary()).pins).toEqual([]);
  });

  it('没有置顶时，「置顶」区块整个不渲染（不留空标题）', async () => {
    await createRecord({ text: '一条普通记录' });
    mount();
    await flush();

    expect(container.querySelector('.pinned-section')).toBeNull();
    expect(container.textContent).not.toContain('置顶');
  });
});

describe('B. 合集', () => {
  it('新建合集 → 卡片 ⋯ 加入 2 条 → 点 chip 只显示这 2 条', async () => {
    await createRecord({ text: '第一条：短片开头' });
    await createRecord({ text: '第二条：不要加进来的' });
    await createRecord({ text: '第三条：片尾' });

    mount();
    await flush();

    await click(container.querySelector('.collection-add'));
    await typeInto(container.querySelector('.collection-input'), '我的短片');
    await click(container.querySelector('.collection-form-button'));
    expect(collectionChips().map((chip) => chip.textContent)).toEqual(['我的短片0']);

    // 第一条：打开 ⋯ 勾选合集
    await click(itemByText('第一条').querySelector('.record-more'));
    await click(container.querySelector('.record-menu input[type="checkbox"]'));

    // 第三条
    await click(itemByText('第三条').querySelector('.record-more'));
    await click(container.querySelector('.record-menu input[type="checkbox"]'));

    const library = await loadLibrary();
    expect(library.collections[0].recordIds).toHaveLength(2);

    await click(collectionChips()[0]);
    expect(collectionList()).not.toBeNull();
    expect(texts(collectionList())).toEqual(['第一条：短片开头', '第三条：片尾']);
    // 置顶区在合集视图里不出现（它是全局区块）
    expect(container.querySelector('.pinned-section')).toBeNull();
  });

  it('再点一次选中的 chip 退出合集，回到全部（时间倒序）', async () => {
    await createRecord({ text: '第一条' });
    await createRecord({ text: '第二条' });
    mount();
    await flush();

    await click(container.querySelector('.collection-add'));
    await typeInto(container.querySelector('.collection-input'), '合集甲');
    await click(container.querySelector('.collection-form-button'));

    await click(itemByText('第一条').querySelector('.record-more'));
    await click(container.querySelector('.record-menu input[type="checkbox"]'));

    await click(collectionChips()[0]);
    expect(collectionList()).not.toBeNull();

    await click(collectionChips()[0]);
    expect(allList()).not.toBeNull();
    expect(texts(allList())).toHaveLength(2);
  });

  it('空合集名被拒绝：给出提示，且不创建合集', async () => {
    await createRecord({ text: '一条记录' });
    mount();
    await flush();

    await click(container.querySelector('.collection-add'));
    await click(container.querySelector('.collection-form-button'));

    expect(container.querySelector('.library-error')?.textContent).toContain('合集名不能为空');
    expect(collectionChips()).toHaveLength(0);
    expect((await loadLibrary()).collections).toHaveLength(0);
  });

  it('合集 ⋯ 菜单：删除要两次确认，删掉后 chip 消失、记录还在', async () => {
    await createRecord({ text: '留下的记录' });
    mount();
    await flush();

    await click(container.querySelector('.collection-add'));
    await typeInto(container.querySelector('.collection-input'), '临时合集');
    await click(container.querySelector('.collection-form-button'));
    await click(collectionChips()[0]);

    await click(container.querySelector('.collection-more'));
    const deleteItem = Array.from(container.querySelectorAll('.collection-menu-item')).find((node) =>
      node.textContent?.includes('删除合集'),
    );
    await click(deleteItem ?? null);
    // 第一次只进入确认态，库没变
    expect((await loadLibrary()).collections).toHaveLength(1);

    const confirmItem = container.querySelector('.collection-menu-item.danger');
    expect(confirmItem?.textContent).toContain('确认删除');
    await click(confirmItem);

    expect((await loadLibrary()).collections).toHaveLength(0);
    expect(collectionChips()).toHaveLength(0);
    expect(allList()).not.toBeNull();
    expect(texts(allList())).toEqual(['留下的记录']);
  });

  it('置顶卡也有 ⋯ 菜单：置顶之后仍然能加进合集', async () => {
    const record = await createRecord({ text: '先置顶再进合集' });
    await saveLibrary({ pins: [record.id], collections: [] });
    await createCollection('合集A');

    mount();
    await flush();
    expect(pinnedCards()).toHaveLength(1);

    await click(pinnedCards()[0].querySelector('.pinned-more'));
    await click(container.querySelector('.record-menu input[type="checkbox"]'));

    expect((await loadLibrary()).collections[0].recordIds).toEqual([record.id]);
  });

  it('重命名合集', async () => {
    mount();
    await flush();
    await click(container.querySelector('.collection-add'));
    await typeInto(container.querySelector('.collection-input'), '旧名字');
    await click(container.querySelector('.collection-form-button'));

    await click(collectionChips()[0]);
    await click(container.querySelector('.collection-more'));
    await click(container.querySelector('.collection-menu-item'));
    await typeInto(container.querySelector('.collection-input'), '新名字');
    await click(container.querySelector('.collection-form-button'));

    expect((await loadLibrary()).collections[0].name).toBe('新名字');
    expect(collectionChips()[0].textContent).toContain('新名字');
  });
});

describe('C. 合集内排序 / 「全部」不许拖', () => {
  async function seedCollection(texts: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const text of texts) ids.push((await createSpaced(text)).id);
    await saveLibrary({
      pins: [],
      collections: [{ id: 'col-1', name: '排序合集', recordIds: ids, createdAt: 1 }],
    });
    return ids;
  }

  it('合集视图里卡片带 draggable 与拖拽手柄；「全部」视图都没有', async () => {
    await seedCollection(['甲', '乙', '丙']);
    mount();
    await flush();

    // 全部视图
    for (const item of allItems()) {
      expect(item.hasAttribute('draggable')).toBe(false);
      expect(item.querySelector('.drag-handle')).toBeNull();
      expect(item.classList.contains('record-item-draggable')).toBe(false);
    }

    await click(collectionChips()[0]);
    const items = allItems();
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.getAttribute('draggable')).toBe('true');
      expect(item.querySelector('.drag-handle')).not.toBeNull();
    }
  });

  it('「全部」视图里派发拖拽事件：顺序不动（不响应拖拽）', async () => {
    await seedCollection(['甲', '乙', '丙']);
    mount();
    await flush();

    const items = allItems();
    const before = (await loadLibrary()).collections[0].recordIds;
    await dragOnto(items[0], items[2]);
    const after = (await loadLibrary()).collections[0].recordIds;

    expect(after).toEqual(before);
    // 「全部」是按时间倒序（丙最后创建 → 排最前），拖拽没有改动它
    expect(texts(allList())).toEqual(['丙', '乙', '甲']);
  });

  it('合集内拖拽换序：写下 recordIds，刷新后顺序保持', async () => {
    await seedCollection(['甲', '乙', '丙']);
    mount();
    await flush();
    await click(collectionChips()[0]);

    const items = allItems();
    await dragOnto(items[0], items[2]);

    expect(texts(collectionList())).toEqual(['乙', '丙', '甲']);

    await remount();
    await click(collectionChips()[0]);
    expect(texts(collectionList())).toEqual(['乙', '丙', '甲']);
  });

  it('拖到自己身上：顺序不变（也不写库）', async () => {
    await seedCollection(['甲', '乙']);
    mount();
    await flush();
    await click(collectionChips()[0]);

    const items = allItems();
    await dragOnto(items[0], items[0]);

    expect(texts(collectionList())).toEqual(['甲', '乙']);
  });
});

describe('D. 组合筛选与边界', () => {
  it('合集 + 标签 + 搜索 三者叠加（任务书 §4）', async () => {
    const inside: string[] = [];
    inside.push((await createRecord({ text: '图书馆的梦 一', tags: ['梦'] })).id);
    inside.push((await createRecord({ text: '图书馆的梦 二', tags: ['梦'] })).id);
    inside.push((await createRecord({ text: '图书馆的梦 三', tags: ['脚本'] })).id);
    await createRecord({ text: '图书馆的梦 四（不在合集里）', tags: ['梦'] });

    await saveLibrary({
      pins: [],
      collections: [{ id: 'col-1', name: '梦合集', recordIds: inside, createdAt: 1 }],
    });

    mount();
    await flush();
    await click(collectionChips()[0]);

    // 1) 合集：3 条
    expect(texts(collectionList())).toHaveLength(3);

    // 2) + 标签「梦」：2 条
    const dreamChip = Array.from(container.querySelectorAll('.records-chips .chip')).find((node) =>
      node.textContent?.startsWith('#梦'),
    );
    await click(dreamChip ?? null);
    await waitFor(() =>
      expect(texts(collectionList())).toEqual(['图书馆的梦 一', '图书馆的梦 二']),
    );

    // 3) + 搜索「二」：1 条
    await typeInto(container.querySelector('.search-input'), '二');
    await waitFor(() => expect(texts(collectionList())).toEqual(['图书馆的梦 二']));

    // 4) 清掉搜索与标签：回到 3 条，且顺序仍是 recordIds 的顺序
    await typeInto(container.querySelector('.search-input'), '');
    await click(dreamChip ?? null);
    await waitFor(() =>
      expect(texts(collectionList())).toEqual([
        '图书馆的梦 一',
        '图书馆的梦 二',
        '图书馆的梦 三',
      ]),
    );
  });

  it('合集 + 分页：25 条分两页，页码与内容对得上', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      ids.push((await createRecord({ text: `合集条目 ${index + 1}`, tags: ['梦'] })).id);
    }
    await saveLibrary({
      pins: [],
      collections: [{ id: 'col-1', name: '大合集', recordIds: ids, createdAt: 1 }],
    });

    mount();
    await flush();
    await click(collectionChips()[0]);

    await waitFor(() => expect(texts(collectionList())).toHaveLength(20));
    await waitFor(() =>
      expect(container.querySelector('.pager-info')?.textContent).toContain('第 1 / 2 页'),
    );

    const nextButton = Array.from(container.querySelectorAll('.pager-button')).find((node) =>
      node.textContent?.includes('下一页'),
    );
    await click(nextButton ?? null);

    await waitFor(() => expect(texts(collectionList())).toHaveLength(5));
    await waitFor(() =>
      expect(container.querySelector('.pager-info')?.textContent).toContain('第 2 / 2 页'),
    );
  });

  it('删除一条被置顶的记录：置顶区不再有它，页面不报错，库里也清掉了', async () => {
    const pinned = await createRecord({ text: '会被删掉的置顶记录' });
    await createRecord({ text: '留下的记录' });
    await saveLibrary({ pins: [pinned.id], collections: [] });

    mount();
    await flush();
    expect(pinnedCards()).toHaveLength(1);

    // 详情页删除记录 → 回到首页（这里直接删库 + 重挂载来模拟）
    await removeRecord(pinned.id);
    await remount();

    expect(pinnedCards()).toHaveLength(0);
    expect(container.querySelector('.error')).toBeNull();
    expect(container.textContent).toContain('留下的记录');
    expect((await loadLibrary()).pins).toEqual([]);
  });

  it('合集里有悬空 id：合集照常打开，不崩', async () => {
    const kept = await createRecord({ text: '还在的记录' });
    const gone = await createRecord({ text: '将被删掉的记录' });
    await saveLibrary({
      pins: [],
      collections: [{ id: 'col-1', name: '合集', recordIds: [gone.id, kept.id], createdAt: 1 }],
    });

    mount();
    await flush();
    await removeRecord(gone.id);
    await remount();
    await click(collectionChips()[0]);

    expect(texts(collectionList())).toEqual(['还在的记录']);
    expect(container.querySelector('.error')).toBeNull();
  });

  it('「全部」仍按时间倒序（新增置顶不影响这个语义）', async () => {
    await createSpaced('最早的');
    await createSpaced('中间的');
    await createSpaced('最新的');
    await saveLibrary({ pins: [], collections: [] });

    mount();
    await flush();
    expect(texts(allList())).toEqual(['最新的', '中间的', '最早的']);
  });
});
