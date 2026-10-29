/**
 * P5 · 成品主次与示例（真 DOM 行为）。
 *
 * 盯的是任务书「真浏览器验证」里能在 jsdom 里复现的部分：
 * - 列表角标「成品」+「来自 N 条素材」；
 * - 详情页下方「来源素材」区块（可点开），**来源被删后显示「素材已删除」且不报错**；
 * - 副本标记；
 * - 首页空态「载入一组示例」→ 3 条真记录 → 删光再点一次仍是 3 条（幂等）。
 *
 * 备份往返在 `core/backup/records-role-backup.test.ts`，指纹在 `core/studio/draft.test.ts`。
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordListPage } from './RecordListPage';
import { RecordDetailPage } from './RecordDetailPage';
import { closeDatabase, destroyDatabase } from '../../core/storage';
import { getDatabase } from '../../core/storage/db';
import { createRecord, duplicateRecord, removeRecord } from '../../core/records';
import { sampleRecordIdList } from '../../core/records/examples';
import { saveVoiceSettings } from '../../core/settings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(async () => {
  await destroyDatabase();
  // 先定下语音方式，免得首启引导面板挡在列表前面
  await saveVoiceSettings({ mode: 'record-only' });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
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

async function waitFor(predicate: () => boolean, what = '条件', timeout = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await flush(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`超时未满足：${what}`);
}

function mountList(): void {
  root = createRoot(container);
  act(() => {
    root?.render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <RecordListPage />
      </MemoryRouter>,
    );
  });
}

function mountDetail(recordId: string): void {
  root = createRoot(container);
  act(() => {
    root?.render(
      <MemoryRouter
        initialEntries={[`/records/${recordId}`]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/records/:id" element={<RecordDetailPage />} />
          <Route path="/" element={<p>列表占位</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

/** 列表里某条记录的卡片（li），按它的链接找 —— 卡片上没有专门的 id 属性 */
function cardOf(recordId: string): HTMLElement | null {
  const link = container.querySelector<HTMLAnchorElement>(`a[href="/records/${recordId}"]`);
  return link?.closest('li') ?? null;
}

function items(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.record-item'));
}

function click(element: Element | null): void {
  if (!element) throw new Error('要点的元素不存在');
  act(() => (element as HTMLElement).click());
}

/* ================================================================== */
/* 记录列表：成品角标 + 来自 N 条素材 + 副本                            */
/* ================================================================== */

describe('P5 记录列表：成品角标与来源条数', () => {
  it('成品卡有「成品」角标 + 「来自 2 条素材」；笔记卡两个都没有', async () => {
    const first = await createRecord({ text: '素材甲：图书馆在呼吸' });
    const second = await createRecord({ text: '素材乙：地铁报站声' });
    const draft = await createRecord({
      text: '图书馆在呼吸。不是比喻。',
      role: 'draft',
      sourceIds: [first.id, second.id],
    });

    mountList();
    await waitFor(() => items().length === 3, '列表渲染 3 条');

    const draftCard = cardOf(draft.id);
    expect(draftCard).not.toBeNull();
    expect(draftCard?.dataset.recordRole).toBe('draft');
    expect(draftCard?.querySelector('[data-record-role-badge="draft"]')?.textContent).toBe('成品');
    expect(draftCard?.querySelector('[data-record-source-count]')?.textContent).toContain(
      '来自 2 条素材',
    );

    const noteCard = cardOf(first.id);
    expect(noteCard?.dataset.recordRole).toBe('note');
    expect(noteCard?.querySelector('[data-record-role-badge="draft"]')).toBeNull();
    expect(noteCard?.querySelector('[data-record-source-count]')).toBeNull();
  });

  it('成品没有来源时不显示「来自 0 条素材」（不写空话）', async () => {
    const draft = await createRecord({ text: '纯手写的成品，没有素材', role: 'draft' });

    mountList();
    await waitFor(() => items().length === 1, '列表渲染 1 条');

    const card = cardOf(draft.id);
    expect(card?.querySelector('[data-record-role-badge="draft"]')).not.toBeNull();
    expect(card?.querySelector('[data-record-source-count]')).toBeNull();
    expect(container.textContent).not.toContain('来自 0 条素材');
  });

  it('副本卡标「副本」，原记录卡不标', async () => {
    const original = await createRecord({ text: '要被复制的那条' });
    const copy = await duplicateRecord(original.id);

    mountList();
    await waitFor(() => items().length === 2, '列表渲染 2 条');

    expect(cardOf(copy.id)?.querySelector('[data-record-role-badge="copy"]')?.textContent).toBe(
      '副本',
    );
    expect(cardOf(original.id)?.querySelector('[data-record-role-badge="copy"]')).toBeNull();
  });
});

/* ================================================================== */
/* 记录详情：来源素材区块                                               */
/* ================================================================== */

describe('P5 记录详情：来源素材', () => {
  it('正文在上、来源在下方列出，每条能点开跳到那条记录', async () => {
    const first = await createRecord({ text: '凌晨三点的梦：会呼吸的图书馆', tags: ['梦'] });
    const second = await createRecord({ text: '想把地铁报站声做成一首歌' });
    const draft = await createRecord({
      text: '图书馆在呼吸。不是比喻。',
      role: 'draft',
      sourceIds: [first.id, second.id],
    });

    mountDetail(draft.id);
    await waitFor(
      () => container.querySelector('[data-record-sources]') !== null,
      '来源素材区块出现',
    );
    await waitFor(
      () => container.querySelectorAll('[data-record-source]').length === 2,
      '列出 2 条来源',
    );

    const block = container.querySelector('[data-record-sources]') as HTMLElement;
    expect(block.textContent).toContain('来源素材');
    expect(block.textContent).toContain('这条成品是从下面 2 条记录来的。');

    const links = Array.from(block.querySelectorAll('a'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `/records/${first.id}`,
      `/records/${second.id}`,
    ]);
    expect(block.textContent).toContain('凌晨三点的梦：会呼吸的图书馆');

    // 正文在上（来源区块在正文之后，DOM 顺序也要对）
    const body = container.querySelector('.record-body') as HTMLElement;
    expect(body.textContent).toContain('图书馆在呼吸。不是比喻。');
    expect(body.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('删掉其中一条来源 → 那一行显示「素材已删除」，整页不报错', async () => {
    const kept = await createRecord({ text: '还在的素材' });
    const gone = await createRecord({ text: '会被删掉的素材' });
    const draft = await createRecord({
      text: '成品正文不受影响',
      role: 'draft',
      sourceIds: [kept.id, gone.id],
    });

    await removeRecord(gone.id);

    mountDetail(draft.id);
    await waitFor(
      () => container.querySelectorAll('[data-record-source]').length === 2,
      '两条来源位置都在（缺的那条补「已删除」）',
    );
    await flush(4);

    const missing = container.querySelectorAll('[data-record-source-missing]');
    expect(missing).toHaveLength(1);
    expect(missing[0].textContent).toContain('素材已删除');
    // 位置对得上：素材 2 才是被删的那条
    expect(missing[0].textContent).toContain('素材 2');
    // 剩下的那条仍然能点
    expect(container.querySelector(`a[href="/records/${kept.id}"]`)).not.toBeNull();
    // 正文还在，页面没报错
    expect(container.querySelector('.record-body')?.textContent).toContain('成品正文不受影响');
    expect(container.querySelector('.error')).toBeNull();
  });

  it('没有来源的记录不渲染来源区块（不留空标题）', async () => {
    const note = await createRecord({ text: '一条普通笔记' });

    mountDetail(note.id);
    await waitFor(
      () => (container.querySelector('.record-body')?.textContent ?? '') !== '',
      '正文渲染',
    );

    expect(container.querySelector('[data-record-sources]')).toBeNull();
  });
});

/* ================================================================== */
/* 示例卡片                                                           */
/* ================================================================== */

describe('P5 示例卡片（空库 → 载入一组示例）', () => {
  it('空库首页给「载入一组示例」；点一下变 3 条，成品带来源、能看见主次', async () => {
    mountList();
    await waitFor(() => container.querySelector('[data-load-examples]') !== null, '空态按钮出现');
    expect(container.textContent).toContain('还没有记录');

    click(container.querySelector('[data-load-examples]'));
    await waitFor(() => items().length === 3, '载入后 3 条');

    const [noteId, assetId, draftId] = sampleRecordIdList();
    expect(cardOf(draftId)?.querySelector('[data-record-role-badge="draft"]')?.textContent).toBe(
      '成品',
    );
    expect(cardOf(draftId)?.querySelector('[data-record-source-count]')?.textContent).toContain(
      '来自 2 条素材',
    );
    // 三条都在（笔记 / AI 产出 / 成品），正文是任务书里那三句
    expect(container.textContent).toContain('会呼吸的图书馆');
    expect(container.textContent).toContain('解梦');
    expect(container.textContent).toContain('图书馆在呼吸。不是比喻');
    expect(cardOf(noteId)).not.toBeNull();
    expect(cardOf(assetId)).not.toBeNull();
  });

  it('幂等：删光示例再点一次 → 还是 3 条（不是 6 条）', async () => {
    mountList();
    await waitFor(() => container.querySelector('[data-load-examples]') !== null, '空态按钮出现');
    click(container.querySelector('[data-load-examples]'));
    await waitFor(() => items().length === 3, '第一次载入 3 条');

    // 模拟「用户把示例删了」（现有能力：删记录）→ 刷新回空态
    act(() => root?.unmount());
    root = null;
    for (const id of sampleRecordIdList()) await removeRecord(id);

    mountList();
    await waitFor(() => container.querySelector('[data-load-examples]') !== null, '又回到空态');
    click(container.querySelector('[data-load-examples]'));
    await waitFor(() => items().length === 3, '第二次载入仍是 3 条');

    expect(await getDatabase().records.count()).toBe(3);
  });
});
