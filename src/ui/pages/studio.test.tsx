/**
 * P3 写作工作台 · 页面级测试。
 *
 * **这一份替代了被删除的 `canvas.test.tsx`（342 行）与 `canvas-teardown.test.tsx`（161 行）。**
 * 任务书 §0.2 要求「删测试必须补回来」，所以下面四个 describe 的标题就是那张对应表：
 *
 * | 旧（CanvasPage）                     | 新（StudioPage）                        |
 * |--------------------------------------|-----------------------------------------|
 * | ①3 条记录 → 渲染 3 张卡              | ①素材列表条数 = 库里记录数              |
 * | ②拖动后位置写库、重挂载仍在          | ②勾选素材 + 正文写库、重挂载仍在        |
 * | ③空态给可执行提示                    | ③无素材时中间给引导，不是空白           |
 * | ④teardown 不产生 unhandled rejection | ④见 `studio-teardown.test.tsx`（同文件保留） |
 *
 * 另外补的新功能测试：最多 3 条、关卡片 = 取消勾选、合集筛选、AI 无模型提示、
 * AI 上下文实际字符串、替换正文要先确认、悬空 id 清理。
 *
 * 约定：AI **一律注入假实现**（CHARTER §13.2：AI 不得为验收发起付费调用），
 * 断言的是我们喂给 `chat()` 的那个 prompt 字符串，而不是模型回复得好不好。
 */
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StudioPage } from './StudioPage';
import type { StudioAIPrompt, StudioPageProps } from './StudioPage';
import { createRecord, removeRecord } from '../../core/records';
import { closeDatabase, destroyDatabase, getSetting } from '../../core/storage';
import { STUDIO_DRAFT_KEY } from '../../core/studio/draft';
import type { StudioDraft } from '../../core/studio/draft';
import { STUDIO_SYSTEM_PROMPT } from '../../core/studio/context';
import { addToCollection, createCollection } from '../../core/library';
import type { AICatalog } from '../../adapters/ai-models/catalog';
import { makeAudioBlob } from '../../test/blob-helpers';

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

/** 左栏素材条（data-studio-material = 记录 id） */
function materialItems(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-studio-material]'));
}

/** 中栏展开的卡片 */
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

/** 往受控 textarea 里输入（React 18 监听 input 事件） */
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

async function readDraft(): Promise<StudioDraft | undefined> {
  const row = await getSetting(STUDIO_DRAFT_KEY);
  return row?.value as StudioDraft | undefined;
}

/** 一份「有一个可用文本模型」的目录（不联网：pickModel 只看形状） */
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

/** 只有生图模型 = 「没有可用文本模型」 */
function catalogWithoutTextModel(): AICatalog {
  const catalog = catalogWithTextModel();
  catalog.providers[0].connections[0].models = [
    {
      id: 'model-2',
      displayName: 'cogview-4',
      modelId: 'cogview-4',
      caps: ['image'],
      enabled: true,
    },
  ];
  return catalog;
}

/* ================================================================== */
/* ① 等价旧「3 条记录 → 渲染 3 张卡」：素材列表条数 = 库里记录数        */
/* ================================================================== */

describe('① 素材列表条数 = 库里记录数（替代旧的「3 条记录渲染 3 张卡」）', () => {
  it('3 条记录 → 左栏 3 条素材；纯录音记录给可读占位而不是空白', async () => {
    await createRecord({ text: '凌晨三点的梦：会呼吸的图书馆', tags: ['梦'] });
    await createRecord({ text: '想把地铁报站声做成一首歌', tags: ['灵感'] });
    // 纯录音记录（没有文字）—— 素材条要给可读占位，而不是一条空白
    await createRecord({
      audio: { blob: makeAudioBlob(), mimeType: 'audio/webm', durationMs: 4300 },
    });

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 3, '左栏渲染 3 条素材');

    expect(materialItems()).toHaveLength(3);
    expect(container.textContent).toContain('凌晨三点的梦：会呼吸的图书馆');
    expect(container.textContent).toContain('（无文字，仅录音）');
    // 没勾选时中栏一张卡都没有（卡片是「勾选的结果」，不是「记录的镜像」）
    expect(cards()).toHaveLength(0);
  });

  it('加第 4 条记录 → 左栏变 4 条（条数始终等于库里的记录数）', async () => {
    await createRecord({ text: '一' });
    await createRecord({ text: '二' });
    await createRecord({ text: '三' });

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 3, '先看到 3 条');

    await createRecord({ text: '四' });
    unmount();
    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 4, '第 4 条也出现在左栏');
    expect(materialItems()).toHaveLength(4);
  });
});

/* ================================================================== */
/* ② 等价旧「拖动后位置写库、重挂载仍在」：勾选 + 正文写库、重挂载仍在   */
/* ================================================================== */

describe('② 勾选素材 + 正文写库，重挂载仍在（替代旧的「拖动写库、重挂载仍在」）', () => {
  it('勾 2 条 + 写正文 → settings.studio-draft 落库；重挂载后卡片与正文都还在', async () => {
    const first = await createRecord({ text: '素材甲：图书馆在呼吸' });
    const second = await createRecord({ text: '素材乙：地铁报站声' });

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 2, '左栏就绪');

    click(materialButton(first.id));
    click(materialButton(second.id));
    await waitFor(() => cards().length === 2, '中栏出现 2 张卡');
    expect(materialButton(first.id).getAttribute('aria-pressed')).toBe('true');

    typeBody('图书馆在呼吸。不是比喻。');
    // 自动保存：500ms 防抖 + 一次写库
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    await flush(3);

    const draft = await readDraft();
    expect(draft?.body).toBe('图书馆在呼吸。不是比喻。');
    expect(draft?.materialIds).toEqual([first.id, second.id]);

    unmount();
    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => cards().length === 2, '重挂载后卡片还在');
    expect(bodyInput().value).toBe('图书馆在呼吸。不是比喻。');
    expect(materialButton(first.id).getAttribute('aria-pressed')).toBe('true');
    expect(materialButton(second.id).getAttribute('aria-pressed')).toBe('true');
  });

  it('状态栏读的是真实状态：输入后「保存中…」→ 落库后「已自动保存」', async () => {
    await createRecord({ text: '一条素材' });
    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 1, '左栏就绪');

    typeBody('写几个字');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    await flush(4);

    const stat = container.querySelector('[data-studio-save]');
    expect(stat?.getAttribute('data-studio-save')).toBe('saved');
    expect(stat?.textContent).toContain('已自动保存');
    // 字数在正文那一条状态上（顶栏只报保存状态，避免同一句话说两遍）
    expect(container.querySelector('[data-studio-stat]')?.textContent).toContain('4 字');
  });
});

/* ================================================================== */
/* ③ 等价旧「空态给可执行提示」：无素材时中间给引导，不是空白           */
/* ================================================================== */

describe('③ 无素材时中间给引导（替代旧的空态可执行提示）', () => {
  it('库里有记录但一条没勾 → 中栏是引导文案 + 告诉用户先勾一条', async () => {
    await createRecord({ text: '等着被勾的素材' });
    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 1, '左栏就绪');

    const empty = container.querySelector('[data-studio-empty]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('还没有展开的素材');
    expect(empty?.textContent).toContain('先勾一条试试');
    // 中栏不是白板：正文输入框始终在（可以不带素材直接写）
    expect(bodyInput()).not.toBeNull();
  });

  it('库里一条记录都没有 → 左栏与中栏都给「去写一条」这一步，不是空白', async () => {
    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(
      () => (container.textContent ?? '').includes('还没有记录'),
      '左栏空态提示',
    );

    expect(container.querySelector('[data-studio-material]')).toBeNull();
    expect(container.querySelector('[data-studio-empty]')?.textContent).toContain('左栏还是空的');

    const toHome = Array.from(container.querySelectorAll('a')).find(
      (item) => item.textContent === '去首页写一条',
    );
    expect(toHome).toBeDefined();
    expect(toHome?.getAttribute('href')).toBe('/');
  });
});

/* ================================================================== */
/* 勾选上限：第 5 条只提示，不勾上（P4c §1：上限 3 → 4）                */
/* ================================================================== */

describe('素材上限 4 条', () => {
  it('勾第 5 条 → 提示「最多 4 条」，卡片仍是 4 张，第 5 条不勾上', async () => {
    const records = [
      await createRecord({ text: '素材1' }),
      await createRecord({ text: '素材2' }),
      await createRecord({ text: '素材3' }),
      await createRecord({ text: '素材4' }),
      await createRecord({ text: '素材5' }),
    ];

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 5, '左栏 5 条');

    // createdAt 精确到毫秒可能相同 → 一律按 id 点，不依赖顺序
    click(materialButton(records[0].id));
    click(materialButton(records[1].id));
    click(materialButton(records[2].id));
    click(materialButton(records[3].id));
    await waitFor(() => cards().length === 4, '4 张卡');

    click(materialButton(records[4].id));
    await flush(3);

    expect(cards()).toHaveLength(4);
    expect(materialButton(records[4].id).getAttribute('aria-pressed')).toBe('false');
    expect(container.textContent).toContain('最多 4 条');
  });

  it('关掉一张卡就能再勾一条（上限是「同时展开」，不是「一辈子只能选 4 条」）', async () => {
    const records = [
      await createRecord({ text: '素材1' }),
      await createRecord({ text: '素材2' }),
      await createRecord({ text: '素材3' }),
      await createRecord({ text: '素材4' }),
      await createRecord({ text: '素材5' }),
    ];

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 5, '左栏 5 条');

    click(materialButton(records[0].id));
    click(materialButton(records[1].id));
    click(materialButton(records[2].id));
    click(materialButton(records[3].id));
    await waitFor(() => cards().length === 4, '4 张卡');

    click(materialButton(records[4].id));
    await flush(2);
    click(container.querySelector<HTMLElement>('.studio-card-close'));
    await waitFor(() => cards().length === 3, '关掉一张');

    click(materialButton(records[4].id));
    await waitFor(() => cards().length === 4, '再勾第 5 条就成功了');
    expect(materialButton(records[4].id).getAttribute('aria-pressed')).toBe('true');
  });
});

/* ================================================================== */
/* 关闭卡片 = 取消勾选                                                 */
/* ================================================================== */

describe('关闭卡片', () => {
  it('点 ✕ → 卡片消失，左侧对应项同时取消勾选', async () => {
    const first = await createRecord({ text: '会被关掉的素材' });
    const second = await createRecord({ text: '留下的素材' });

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 2, '左栏就绪');
    click(materialButton(first.id));
    click(materialButton(second.id));
    await waitFor(() => cards().length === 2, '2 张卡');

    const firstCard = cards().find((item) => item.dataset.studioCard === first.id);
    click(firstCard?.querySelector('.studio-card-close') ?? null);

    await waitFor(() => cards().length === 1, '卡片只剩一张');
    expect(cards()[0].dataset.studioCard).toBe(second.id);
    expect(materialButton(first.id).getAttribute('aria-pressed')).toBe('false');
  });
});

/* ================================================================== */
/* 合集筛选（复用 P2b 的 library）                                     */
/* ================================================================== */

describe('合集筛选（复用 P2b 的 library，不改查询层签名）', () => {
  it('点合集 chip 只列该合集的记录；再点「全部」回到全量', async () => {
    const inCollection = await createRecord({ text: '进了合集的梦' });
    await createRecord({ text: '没进合集的梦' });

    const library = await createCollection('我的短片');
    await addToCollection(library.collections[0].id, inCollection.id);

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 2, '先看到 2 条');

    const chip = Array.from(container.querySelectorAll<HTMLElement>('.studio-chip')).find((item) =>
      (item.textContent ?? '').includes('我的短片'),
    );
    click(chip ?? null);
    await waitFor(() => materialItems().length === 1, '合集里只剩 1 条');
    expect(materialItems()[0].dataset.studioMaterial).toBe(inCollection.id);

    const allChip = Array.from(container.querySelectorAll<HTMLElement>('.studio-chip')).find(
      (item) => (item.textContent ?? '').startsWith('全部'),
    );
    click(allChip ?? null);
    await waitFor(() => materialItems().length === 2, '回到全量');
  });
});

/* ================================================================== */
/* AI 面板：无文本模型 vs 有文本模型                                   */
/* ================================================================== */

describe('AI 面板', () => {
  it('没有可用文本模型 → 给可执行提示 + 去 AI 配置的链接，且**不渲染发送按钮**', async () => {
    await createRecord({ text: '一条素材' });
    mountStudio({ catalog: catalogWithoutTextModel() });
    await waitFor(() => container.querySelector('[data-studio-ai-hint]') !== null, 'AI 提示出现');

    const hint = container.querySelector('[data-studio-ai-hint]') as HTMLElement;
    expect(hint.textContent).toContain('还没有可用的文本模型');
    // 提示必须是「能照着做」的（含厂商与模型名），不是一句「请配置模型」
    expect(hint.textContent).toContain('AI 配置');
    // R7a §G：文本推荐换成 DeepSeek deepseek-flash
    expect(hint.textContent).toContain('deepseek-flash');

    expect(container.querySelector('[data-studio-send]')).toBeNull();
    const link = Array.from(hint.querySelectorAll('a')).find(
      (item) => item.textContent === '去 AI 配置加一个',
    );
    expect(link?.getAttribute('href')).toBe('/ai-config');
  });

  it('有文本模型 → 头部显示模型名，发送时构造的上下文与任务书字字一致', async () => {
    const first = await createRecord({ text: '凌晨三点的梦：一座会呼吸的图书馆。' });
    const second = await createRecord({ text: '想把地铁里的声音做成一首歌。' });

    const seen: StudioAIPrompt[] = [];
    const generate = async (prompt: StudioAIPrompt): Promise<string> => {
      seen.push(prompt);
      return '图书馆在呼吸。书页像退潮后留在沙上的水。';
    };

    mountStudio({ catalog: catalogWithTextModel(), generate });
    await waitFor(() => materialItems().length === 2, '左栏就绪');
    click(materialButton(first.id));
    click(materialButton(second.id));
    await waitFor(() => cards().length === 2, '2 张卡');
    typeBody('图书馆在呼吸。');

    const send = container.querySelector<HTMLElement>('[data-studio-send]');
    expect(send).not.toBeNull();
    expect(container.querySelector('.studio-model')?.textContent).toBe('glm-5.3-flash');
    expect(container.textContent).toContain('会带上 2 条素材 + 正文全文');

    // 填一句要求 → 发送
    const ask = container.querySelector<HTMLTextAreaElement>('.studio-ask') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(ask, '接着写 200 字，不要解释');
      ask.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      send?.click();
    });
    await waitFor(() => seen.length === 1, 'AI 生成被调用一次');

    expect(seen[0].system).toBe(STUDIO_SYSTEM_PROMPT);
    expect(seen[0].user).toBe(
      '【素材1】凌晨三点的梦：一座会呼吸的图书馆。\n' +
        '【素材2】想把地铁里的声音做成一首歌。\n' +
        '\n' +
        '【正文】图书馆在呼吸。\n' +
        '\n' +
        '【要求】接着写 200 字，不要解释',
    );

    await waitFor(
      () => container.querySelectorAll('[data-studio-message="ai"]').length === 1,
      'AI 回复落到对话里',
    );
    expect(container.textContent).toContain('书页像退潮后留在沙上的水');
  });

  it('「用这版替换正文」必须再确认一次才覆盖（一点就覆盖是不可撤销的破坏）', async () => {
    await createRecord({ text: '素材甲' });
    const generate = async (): Promise<string> => '这是 AI 写的版本。';

    mountStudio({ catalog: catalogWithTextModel(), generate });
    await waitFor(() => materialItems().length === 1, '左栏就绪');
    typeBody('我原来写的正文。');

    await act(async () => {
      container.querySelector<HTMLElement>('[data-studio-send]')?.click();
    });
    await waitFor(
      () => container.querySelector('[data-studio-use]') !== null,
      'AI 回复带替换按钮',
    );

    // 第一次点击：只出确认条，正文不变
    click(container.querySelector<HTMLElement>('[data-studio-use]'));
    await flush(2);
    expect(bodyInput().value).toBe('我原来写的正文。');
    const confirm = container.querySelector('[data-studio-confirm-replace]');
    expect(confirm).not.toBeNull();
    expect(container.textContent).toContain('会覆盖现在的正文');

    // 确认后才真的覆盖
    click(confirm);
    await waitFor(() => bodyInput().value === '这是 AI 写的版本。', '正文被替换');

    // 而且替换结果会被自动保存（不是只改了屏幕）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    await flush(3);
    expect((await readDraft())?.body).toBe('这是 AI 写的版本。');
  });
});

/* ================================================================== */
/* 悬空 id：记录被删之后，草稿不该带残骸                               */
/* ================================================================== */

describe('草稿里的悬空素材 id', () => {
  it('引用的记录被删掉 → 挂载不报错、卡片只留存在的那条，草稿里的死 id 被清掉', async () => {
    const kept = await createRecord({ text: '还在的素材' });
    const gone = await createRecord({ text: '会被删掉的素材' });

    // 先造一份「引用了两条」的草稿，再删掉其中一条（模拟另一处删记录 / 备份导入）
    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => materialItems().length === 2, '左栏就绪');
    click(materialButton(kept.id));
    click(materialButton(gone.id));
    await waitFor(() => cards().length === 2, '2 张卡');
    typeBody('正文不能丢。');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    await flush(3);
    expect((await readDraft())?.materialIds).toEqual([kept.id, gone.id]);

    unmount();
    await removeRecord(gone.id);

    mountStudio({ catalog: catalogWithTextModel() });
    await waitFor(() => cards().length === 1, '只剩存在的那条素材');
    await flush(4);

    expect(container.querySelector('.error')).toBeNull();
    expect(cards()[0].dataset.studioCard).toBe(kept.id);
    expect(bodyInput().value).toBe('正文不能丢。');
    // 悬空 id 在挂载时被清掉并写回
    expect((await readDraft())?.materialIds).toEqual([kept.id]);
  });
});
