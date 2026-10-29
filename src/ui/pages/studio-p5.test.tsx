/**
 * P5 · 写作台的三个新出口（真 DOM 行为）：
 *
 * 1. **存为记录**（本轮核心里程碑）：正文 → 一条 `role='draft'` 的记录，`sourceIds` = 当前素材；
 *    `savedFingerprint` 防重复（存完不动 → 「已保存」禁用；改一个字 → 恢复可点；再存一版允许）；
 * 2. **复制素材**：左栏 hover 的「复制」= 另存一条副本（原记录一个字都不改）；
 * 3. **左侧三段筛选**：全部 / 我写的 / AI 产出（内存过滤，不建索引）。
 *
 * 约定同 `studio.test.tsx`：AI 一律注入假实现，绝不发真请求。
 */
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StudioPage } from './StudioPage';
import type { StudioPageProps } from './StudioPage';
import { createRecord, listRecords } from '../../core/records';
import { closeDatabase, destroyDatabase, getSetting } from '../../core/storage';
import { STUDIO_DRAFT_KEY } from '../../core/studio/draft';
import type { StudioDraft } from '../../core/studio/draft';
import type { AICatalog } from '../../adapters/ai-models/catalog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(async () => {
  await destroyDatabase();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  await closeDatabase();
});

async function flush(times = 3): Promise<void> {
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

function mountStudio(props: StudioPageProps = {}): void {
  root = createRoot(container);
  const element: ReactElement = (
    <MemoryRouter initialEntries={['/studio']}>
      <Routes>
        <Route path="/studio" element={<StudioPage {...props} />} />
        <Route path="/" element={<p>记录列表占位</p>} />
        <Route path="/ai-config" element={<p>AI 配置占位</p>} />
      </Routes>
    </MemoryRouter>
  );
  act(() => root?.render(element));
}

function unmount(): void {
  if (!root) return;
  act(() => root?.unmount());
  root = null;
}

function materialItems(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-studio-material]'));
}

function cards(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-studio-card]'));
}

function materialButton(recordId: string): HTMLElement {
  const found = materialItems().find((item) => item.dataset.studioMaterial === recordId);
  if (!found) throw new Error(`左栏找不到素材 ${recordId}`);
  return found;
}

function click(element: Element | null): void {
  if (!element) throw new Error('要点的元素不存在');
  act(() => (element as HTMLElement).click());
}

function bodyInput(): HTMLTextAreaElement {
  const found = container.querySelector<HTMLTextAreaElement>('[data-studio-body]');
  if (!found) throw new Error('找不到正文输入框');
  return found;
}

function typeBody(value: string): void {
  const input = bodyInput();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function saveRecordButton(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('[data-studio-save-record]');
  if (!found) throw new Error('找不到「存为记录」按钮');
  return found;
}

function filterButton(key: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-studio-role-filter="${key}"]`);
  if (!found) throw new Error(`找不到筛选 ${key}`);
  return found;
}

async function readDraft(): Promise<StudioDraft | undefined> {
  const row = await getSetting(STUDIO_DRAFT_KEY);
  return row?.value as StudioDraft | undefined;
}

/** 有一个可用文本模型的目录（不联网：pickModel 只看形状） */
function catalogWithTextModel(): AICatalog {
  return {
    providers: [
      {
        id: 'zhipu',
        name: '智谱',
        builtin: true,
        activeConnectionId: 'conn-1',
        connections: [
          {
            id: 'conn-1',
            label: '智谱官方',
            baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
            apiKey: 'test-key',
            protocol: 'openai',
            models: [
              {
                id: 'model-1',
                displayName: 'glm-5.3-flash',
                modelId: 'glm-5.3-flash',
                caps: ['text'],
                enabled: true,
              },
            ],
          },
        ],
      },
    ],
    updatedAt: 0,
  };
}

/* ================================================================== */
/* 存为记录                                                            */
/* ================================================================== */

describe('P5 存为记录', () => {
  it('写正文 + 勾 2 条素材 → 库里多一条成品（role=draft，来源 2 条，标签为空），草稿不清空', async () => {
    const first = await createRecord({ text: '素材甲：图书馆在呼吸' });
    const second = await createRecord({ text: '素材乙：地铁报站声' });

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 2, '左栏就绪');
    click(materialButton(first.id));
    click(materialButton(second.id));
    await waitFor(() => cards().length === 2, '2 张卡');

    typeBody('图书馆在呼吸。不是比喻。');
    await flush(2);

    expect(saveRecordButton().textContent).toBe('存为记录');
    expect(saveRecordButton().disabled).toBe(false);

    await act(async () => {
      saveRecordButton().click();
    });
    await waitFor(
      () => (container.textContent ?? '').includes('已存为记录'),
      '出现保存成功提示',
    );

    const page = await listRecords();
    expect(page.total).toBe(3); // 2 条素材 + 1 条成品
    const draft = page.items.find((item) => item.role === 'draft');
    expect(draft).toBeDefined();
    expect(draft?.text).toBe('图书馆在呼吸。不是比喻。');
    expect(draft?.sourceIds).toEqual([first.id, second.id]);
    expect(draft?.tags).toEqual([]); // 不自动打标签

    // 草稿不清空：正文还在（用户可能接着改再存一版）
    expect(bodyInput().value).toBe('图书馆在呼吸。不是比喻。');
  });

  it('存完不动 → 「已保存」禁用；改一个字 → 恢复可点；再存一版会多一条', async () => {
    const first = await createRecord({ text: '素材甲' });

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 1, '左栏就绪');
    click(materialButton(first.id));
    await waitFor(() => cards().length === 1, '1 张卡');
    typeBody('第一版');
    await flush(2);

    await act(async () => {
      saveRecordButton().click();
    });
    await waitFor(() => saveRecordButton().textContent === '已保存', '按钮变「已保存」');
    expect(saveRecordButton().disabled).toBe(true);

    // 改一个字 → 指纹变了 → 恢复可点
    typeBody('第一版！');
    await flush(2);
    expect(saveRecordButton().textContent).toBe('存为记录');
    expect(saveRecordButton().disabled).toBe(false);

    await act(async () => {
      saveRecordButton().click();
    });
    await waitFor(
      () => (container.textContent ?? '').includes('已存为记录'),
      '第二次保存完成',
    );

    const page = await listRecords();
    expect(page.total).toBe(3); // 1 条素材 + 两版成品
    expect(page.items.filter((item) => item.role === 'draft')).toHaveLength(2);
  });

  it('素材变了也算新内容（加一条素材 → 按钮恢复可点）', async () => {
    const first = await createRecord({ text: '素材甲' });
    const second = await createRecord({ text: '素材乙' });

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 2, '左栏就绪');
    click(materialButton(first.id));
    await waitFor(() => cards().length === 1, '1 张卡');
    typeBody('同样的正文');
    await flush(2);
    await act(async () => {
      saveRecordButton().click();
    });
    await waitFor(() => saveRecordButton().textContent === '已保存', '先存上');

    click(materialButton(second.id));
    await waitFor(() => cards().length === 2, '多一条素材');
    await flush(2);
    expect(saveRecordButton().textContent).toBe('存为记录');
  });

  it('没有正文时按钮不可点（空记录会被数据层拒掉，先让按钮说话）', async () => {
    await createRecord({ text: '一条素材' });

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 1, '左栏就绪');

    expect(saveRecordButton().disabled).toBe(true);
    expect(saveRecordButton().textContent).toBe('存为记录');

    typeBody('有字了');
    await flush(2);
    expect(saveRecordButton().disabled).toBe(false);
  });

  it('指纹落库：重挂载（= 刷新）后按钮仍是「已保存」，不会再骗用户存一次', async () => {
    await createRecord({ text: '一条素材' });

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 1, '左栏就绪');
    typeBody('存过就不再变');
    await flush(2);
    await act(async () => {
      saveRecordButton().click();
    });
    await waitFor(() => saveRecordButton().textContent === '已保存', '先存上');

    expect(typeof (await readDraft())?.savedFingerprint).toBe('string');

    unmount();
    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => bodyInput().value === '存过就不再变', '正文恢复');
    await flush(3);
    expect(saveRecordButton().textContent).toBe('已保存');
  });

  it('展示区里选中的成品卡带「成品」角标', async () => {
    const draft = await createRecord({ text: '一条成品', role: 'draft' });

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 1, '左栏就绪');
    click(materialButton(draft.id));
    await waitFor(() => cards().length === 1, '1 张卡');

    expect(container.querySelector('[data-studio-card-role]')?.textContent).toBe('成品');
  });
});

/* ================================================================== */
/* 复制素材                                                            */
/* ================================================================== */

describe('P5 左栏复制素材', () => {
  it('点「复制」→ 库里多一条副本（笔记 + 来源指向原记录），原记录一个字都没改', async () => {
    const original = await createRecord({ text: '凌晨三点的梦', tags: ['梦'] });

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 1, '左栏就绪');

    const copyButton = container.querySelector<HTMLElement>(
      `[data-studio-material-copy="${original.id}"]`,
    );
    expect(copyButton).not.toBeNull();
    click(copyButton);
    await waitFor(() => materialItems().length === 2, '左栏出现副本');

    const page = await listRecords();
    expect(page.total).toBe(2);
    const copy = page.items.find((item) => item.id !== original.id);
    expect(copy?.text).toBe('凌晨三点的梦');
    expect(copy?.tags).toEqual(['梦']);
    expect(copy?.role).toBeUndefined(); // 笔记
    expect(copy?.sourceIds).toEqual([original.id]);

    const kept = page.items.find((item) => item.id === original.id);
    expect(kept?.text).toBe('凌晨三点的梦');
    expect(kept?.updatedAt).toBe(original.updatedAt);
    expect(kept?.sourceIds).toBeUndefined();
  });
});

/* ================================================================== */
/* 左侧三段筛选                                                        */
/* ================================================================== */

describe('P5 左侧来源筛选', () => {
  it('三段各自筛对，数字是全库口径（全部 3 / 我写的 2 / AI 产出 1）', async () => {
    const note = await createRecord({ text: '我写的笔记' });
    const draft = await createRecord({ text: '我写的成品', role: 'draft', sourceIds: [note.id] });
    const asset = await createRecord({
      text: 'AI 产出的解梦',
      role: 'asset',
      sourceIds: [note.id],
    });

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 3, '左栏 3 条');
    await waitFor(() => filterButton('all').textContent?.includes('3') === true, '数字读回来');

    expect(filterButton('all').textContent).toContain('3');
    expect(filterButton('mine').textContent).toContain('2');
    expect(filterButton('ai').textContent).toContain('1');

    click(filterButton('ai'));
    await flush(2);
    expect(materialItems()).toHaveLength(1);
    expect(materialItems()[0].dataset.studioMaterial).toBe(asset.id);

    click(filterButton('mine'));
    await flush(2);
    expect(materialItems()).toHaveLength(2);
    expect(materialItems().map((item) => item.dataset.studioMaterial).sort()).toEqual(
      [note.id, draft.id].sort(),
    );

    click(filterButton('all'));
    await flush(2);
    expect(materialItems()).toHaveLength(3);
  });

  it('「AI 产出」为空时给一句实话，不是空白', async () => {
    await createRecord({ text: '只有笔记' });

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 1, '左栏就绪');

    click(filterButton('ai'));
    await flush(2);

    expect(materialItems()).toHaveLength(0);
    expect(container.querySelector('[data-studio-role-empty]')?.textContent).toContain(
      '还没有 AI 产出的素材',
    );
  });

  it('有来源的记录在左栏显示「来自「…」」', async () => {
    const note = await createRecord({ text: '凌晨三点的图书馆' });
    await createRecord({ text: '解梦：图书馆象征记忆', role: 'asset', sourceIds: [note.id] });

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 2, '左栏 2 条');
    await flush(4);

    const hints = Array.from(container.querySelectorAll('[data-studio-source-hint]')).map(
      (node) => node.textContent,
    );
    expect(hints.some((text) => (text ?? '').includes('来自「凌晨三点的图书馆'))).toBe(true);
  });
});
