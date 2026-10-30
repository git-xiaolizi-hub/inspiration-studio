/**
 * R7b 界面层：设置页 AI 配置卡 / 推荐配置弹窗 / 详情弹窗。
 *
 * 这里锁的是**任务书里最容易做错的四处**（定高、三层增删边界、厂商自动识别、排序兜底），
 * 以及「卡片 6 个就折」这个数字。真浏览器里的像素验收另有截图与报告。
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIConfigCard } from './AIConfigCard';
import { AI_CONFIG_CARD_MAX_FLAT, moveModelKey, nudgeModelKey } from './detail-order';
import { initialDraft, recommendedGroups, reorderGroups } from './RecommendDialog';
import { addConnection, createDefaultCatalog, loadCatalog } from '../../adapters/ai-models/catalog';
import { closeDatabase, destroyDatabase, putSetting } from '../../core/storage';
import { readModelOrder, readModelRoles, writeModelOrder } from '../../adapters/ai-models/model-prefs';
import type { AICatalog, ModelCap, ModelEntry } from '../../adapters/ai-models/catalog';

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
  });
}

async function waitFor(check: () => boolean, label = '条件'): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 4000) throw new Error(`等待超时：${label}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function click(element: HTMLElement | null | undefined): Promise<void> {
  if (!element) throw new Error('要点的元素不存在');
  await act(async () => {
    element.click();
    await flush();
    await flush();
  });
}

function text(): string {
  return container.textContent ?? '';
}

function q<T extends HTMLElement>(selector: string): T | null {
  return container.querySelector(selector) as T | null;
}

function qa<T extends HTMLElement>(selector: string): T[] {
  return Array.from(container.querySelectorAll(selector)) as T[];
}

function byLabel<T extends HTMLElement>(label: string): T | null {
  return container.querySelector(`[aria-label="${label}"]`) as T | null;
}

/** React 受控输入：走原生 setter 再派发事件 */
async function setValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  const proto =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    await flush();
  });
}

function modelEntry(modelId: string, caps: ModelCap[], caps2: ModelCap[] = []): ModelEntry {
  return {
    id: `row-${modelId}`,
    displayName: modelId,
    modelId,
    caps: [...caps, ...caps2],
    price: null,
    priceStatus: '未核实',
    enabled: true,
  };
}

/** 两台厂商、共 10 个模型（6 个文本 + 2 个生图 + 1 个视频 + 1 个音频） */
function catalogTen(): AICatalog {
  const deepseek = {
    id: 'deepseek',
    name: 'DeepSeek',
    builtin: true,
    activeConnectionId: 'conn-ds',
    connections: [
      {
        id: 'conn-ds',
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-test',
        protocol: 'openai' as const,
        multiplier: 1,
        models: [
          modelEntry('deepseek-flash', ['text'], ['vision']),
          modelEntry('deepseek-chat', ['text']),
          modelEntry('deepseek-reasoner', ['text']),
          modelEntry('deepseek-lite', ['text']),
          modelEntry('deepseek-long', ['text']),
          modelEntry('deepseek-audio', ['audio']),
        ],
      },
    ],
  };
  const linghui = {
    id: 'linghui',
    name: '灵绘（中转）',
    builtin: true,
    activeConnectionId: 'conn-lh',
    connections: [
      {
        id: 'conn-lh',
        label: '灵绘',
        baseUrl: 'https://xn--ai-xg4e312c.com',
        apiKey: 'sk-lh',
        protocol: 'openai' as const,
        multiplier: 0.1,
        models: [
          modelEntry('gpt-image-2.5-flare', ['image']),
          modelEntry('gpt-image-2.5-sunburst', ['image']),
          modelEntry('doubao-seedance-2-5-260628', ['video']),
          modelEntry('claude-opus-5-5', ['text'], ['vision']),
        ],
      },
    ],
  };
  return { providers: [deepseek, linghui], updatedAt: Date.now() };
}

async function mountCard(): Promise<void> {
  await mount(
    <MemoryRouter>
      <AIConfigCard />
    </MemoryRouter>,
  );
  await waitFor(() => q('[data-block="model-vendors"]') !== null, '卡片渲染');
}

/**
 * 打开「推荐配置」。弹窗会先读一次已有配置再渲染表单（避免异步回填把用户操作刷掉），
 * 所以点完必须等 `.ai-rec-group` 出现，不能立刻查输入框。
 */
async function openRecommend(useRecommended = true): Promise<void> {
  await click(q('[data-testid="ai-card-recommend"]') as HTMLElement);
  await waitFor(() => qa('.ai-rec-group').length > 0, '配置表单渲染');
  if (!useRecommended) return;
  // R7d：弹窗初始只有一条空地址，三组常用搭配要点「推荐配置」才生成
  const preset = [...document.querySelectorAll('button')].find(
    (node) => (node.textContent ?? '').trim() === '推荐配置',
  );
  if (preset) await click(preset as HTMLButtonElement);
  await waitFor(() => qa('.ai-rec-group').length === 3, '三组推荐生成');
}

async function seedCatalog(catalog: AICatalog): Promise<void> {
  await putSetting({ key: 'ai-catalog', value: catalog, updatedAt: Date.now() });
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

describe('A. 设置页 AI 配置卡', () => {
  it('两个入口按钮齐全：配置模型 / 选型指南', async () => {
    await mountCard();
    const labels = qa('.ai-card-actions .button').map((node) => node.textContent);
    expect(labels).toEqual(['配置模型', '选型指南']);
    expect(qa('.ai-card-actions a').map((node) => node.getAttribute('href'))).toEqual([
      '/model-guide',
    ]);
  });

  it('空状态：虚线框 + 引导文案，详情按钮禁用', async () => {
    await mountCard();
    await waitFor(() => text().includes('还没有配置任何模型'), '空状态文案');
    expect(q('.ai-card-empty')).not.toBeNull();
    expect(text()).toContain('点「配置模型」');
    expect(q<HTMLButtonElement>('[data-testid="ai-card-detail"]')?.disabled).toBe(true);
  });

  it('10 个模型时只平铺 6 个，第 7 个起折成「还有 4 个 ›」', async () => {
    await seedCatalog(catalogTen());
    await mountCard();
    await waitFor(() => text().includes('已配置 10 个模型'), '已配置计数');
    const chips = qa('.ai-chip:not(.ai-chip-more)');
    expect(chips).toHaveLength(AI_CONFIG_CARD_MAX_FLAT);
    expect(text()).toContain('还有 4 个 ›');
  });

  it('点标签上的 × 只删这一个模型，计数跟着掉', async () => {
    await seedCatalog(catalogTen());
    await mountCard();
    await waitFor(() => text().includes('已配置 10 个模型'), '已配置计数');
    await click(q('.ai-chip .ai-chip-x'));
    await waitFor(() => text().includes('已配置 9 个模型'), '删掉一个后计数');
    expect(qa('.ai-chip:not(.ai-chip-more)').length).toBe(6);
  });
});

describe('B. 推荐配置弹窗', () => {
  it('初始只有一条空地址；点「推荐配置」后三组：DeepSeek / 方舟 / 灵绘三把 Key', async () => {
    await mountCard();
    await openRecommend();
    await waitFor(() => text().includes('配置模型'), '弹窗打开');
    expect(qa('.ai-rec-group')).toHaveLength(3);
    const urls = qa<HTMLInputElement>('.ai-rec-url').map((input) => input.value);
    expect(urls).toEqual([
      'https://api.deepseek.com',
      'https://ark.cn-beijing.volces.com/api/v3',
      'https://xn--ai-xg4e312c.com',
    ]);
    expect(qa('.ai-rec-key-line')).toHaveLength(5);
    expect(qa('.ai-rec-model-line')).toHaveLength(6);
    // 第三组两把 Key 的协议 / 计费方式不同（OpenAI 生图走中转 0.1 / Anthropic 写作走中转 1.1）
    // 协议：收起状态是按钮，显示简称（全名在展开列表里）
    const protos = qa<HTMLButtonElement>('.ai-rec-proto').map((button) =>
      (button.textContent ?? '').replace('▾', '').trim(),
    );
    expect(protos).toEqual(['OpenAI', 'OpenAI', 'OpenAI', 'OpenAI', 'Anthropic']);
    // 计费方式：DeepSeek / 方舟 = 国内按量（数字固定 1，不再显示输入框）；灵绘两把 = 中转站
    const billings = qa<HTMLButtonElement>('.ai-rec-billing').map((button) => button.dataset.value);
    expect(billings).toEqual(['domestic', 'domestic', 'relay', 'relay', 'relay']);
    // 数字框一直都在（1 / 0 / 汇率都要看得见），四种方式都能手改
    const multipliers = qa<HTMLInputElement>('.ai-rec-mult');
    expect(multipliers.map((input) => input.value)).toEqual(['1', '1', '0.1', '0.3', '1.1']);
    expect(multipliers.every((input) => input.readOnly === false)).toBe(true);
  });

  it('模型行单独测：请求体里就是这一行的模型（不是「随便挑一个文本模型」）', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    await mountCard();
    await openRecommend();
    await waitFor(() => text().includes('推荐配置'), '弹窗打开');

    // 填一把 Key，否则测试按钮只会提示「先填 Key」
    const keyInput = q<HTMLInputElement>('.ai-rec-key');
    if (!keyInput) throw new Error('找不到 Key 输入框');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(keyInput, 'sk-test-only');
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });

    const firstModelTest = q('[aria-label="测试模型 deepseek-flash"]');
    await click(firstModelTest);
    await waitFor(() => bodies.length > 0, '发出请求');
    expect(bodies[0]).toContain('deepseek-flash');
    await waitFor(() => q('.ai-rec-model-flag.is-ok') !== null, '打勾');
    vi.unstubAllGlobals();
  });

  it('四种方式各自记倍率：订阅填 0.05，切走再切回来还是 0.05', async () => {
    await mountCard();
    await openRecommend();
    await waitFor(() => text().includes('推荐配置'), '弹窗打开');

    const billing = () => q<HTMLButtonElement>('.ai-rec-billing') as HTMLButtonElement;
    const mult = () => document.querySelector('.ai-rec-mult') as HTMLInputElement;
    const pick = async (label: string) => {
      await click(billing());
      const option = Array.from(document.querySelectorAll('.ai-rec-menu button')).find((button) =>
        (button.textContent ?? '').startsWith(label),
      ) as HTMLButtonElement | undefined;
      if (!option) throw new Error(`没有 ${label} 选项`);
      await click(option);
    };

    // 订阅方式下把「按订阅折算成按量」的 0.05 填进去
    await pick('官方订阅');
    await setValue(mult(), '0.05');
    expect(mult().value).toBe('0.05');

    // 去中转站填 0.35
    await pick('中转站');
    await setValue(mult(), '0.35');

    // 切回订阅：0.05 必须还在
    await pick('官方订阅');
    expect(mult().value).toBe('0.05');
    // 再切回中转站：0.35 也还在
    await pick('中转站');
    expect(mult().value).toBe('0.35');
  });

  it('「国外按量 → 中转站」切回来要还原用户填过的倍率（不是留下汇率）', async () => {
    await mountCard();
    await openRecommend();
    await waitFor(() => text().includes('推荐配置'), '弹窗打开');

    const billing = () => q<HTMLButtonElement>('.ai-rec-billing') as HTMLButtonElement;
    const mult = () => (document.querySelector('.ai-rec-mult') as HTMLInputElement);
    const pick = async (label: string) => {
      await click(billing());
      const option = Array.from(document.querySelectorAll('.ai-rec-menu button')).find((button) =>
        (button.textContent ?? '').startsWith(label),
      ) as HTMLButtonElement | undefined;
      if (!option) throw new Error(`没有 ${label} 选项`);
      await click(option);
    };

    // 先切到中转站（第一把 Key 默认是「国内按量」），再填 0.35
    await pick('中转站');
    await setValue(mult(), '0.35');
    expect(mult().value).toBe('0.35');

    // 切到国外按量：显示汇率
    await pick('国外按量');
    expect(billing().dataset.value).toBe('overseas');
    expect(Number(mult().value)).toBeGreaterThan(1);

    // 切回中转站：必须是 0.35，而不是刚才那个汇率
    await pick('中转站');
    expect(billing().dataset.value).toBe('relay');
    expect(mult().value).toBe('0.35');
  });

  it('已经配过的连接：打开推荐配置直接回填，并标「已配置」', async () => {
    await seedCatalog(catalogTen());
    await mountCard();
    await openRecommend();
    await waitFor(() => text().includes('推荐配置'), '弹窗打开');
    await waitFor(() => text().includes('已配置'), '回填完成');

    const firstKey = q<HTMLInputElement>('.ai-rec-key');
    expect((firstKey?.value ?? '').length).toBeGreaterThan(0);
    expect(qa('.ai-rec-tag').length).toBeGreaterThan(0);
    // 回填的是已有配置里的协议/计费方式，不是模板默认值
    expect(q<HTMLButtonElement>('.ai-rec-proto')?.dataset.value).toBe('openai');
  });

  it('同一连接保存两次，不会长出第二条', async () => {
    await mountCard();
    const saveOnce = async () => {
      await openRecommend();
      await waitFor(() => text().includes('推荐配置'), '弹窗打开');
      const keyInput = q<HTMLInputElement>('.ai-rec-key');
      if (!keyInput) throw new Error('找不到 Key 输入框');
      await setValue(keyInput, 'sk-dedup-test');
      const save = q<HTMLButtonElement>('[data-testid="ai-recommend-save"]');
      if (!save) throw new Error('找不到保存按钮');
      await click(save);
      await waitFor(() => q('.ai-rec-key') === null, '保存后关闭');
    };

    await saveOnce();
    await saveOnce();

    const saved = await loadCatalog();
    const deepseek = saved.providers.find((provider) => provider.id === 'deepseek');
    const sameUrl = (deepseek?.connections ?? []).filter((item) =>
      item.baseUrl.includes('api.deepseek.com'),
    );
    expect(sameUrl).toHaveLength(1);
  });

  it('同一地址同协议的第二把 Key 会新建连接，模型不会并进第一把', async () => {
    // 先造一条已配置的灵绘连接（OpenAI 协议，只有生图模型）
    let catalog = createDefaultCatalog();
    catalog = addConnection(catalog, 'linghui', {
      label: '灵绘',
      baseUrl: 'https://xn--ai-xg4e312c.com',
      apiKey: 'sk-first',
      protocol: 'openai',
      multiplier: 0.1,
      billingMode: 'relay',
      models: [
        { id: 'm1', displayName: 'gpt-image-2.5-flare', modelId: 'gpt-image-2.5-flare', caps: ['image'], enabled: true },
      ],
    }).catalog;
    await seedCatalog(catalog);

    await mountCard();
    await openRecommend();
    await waitFor(() => text().includes('已配置'), '回填完成');

    // 在灵绘那把 Key 上点「再加一把 Key」（第三组第一行，索引 2）
    const addKeyButtons = qa('[aria-label="再加一把 Key"]');
    await click(addKeyButtons[2] as HTMLButtonElement);

    const keys = qa<HTMLInputElement>('.ai-rec-key');
    // 推荐后：deepseek 1 + 方舟 1 + 灵绘 3（原有 openai + 补的 gemini + 补的 opus），再加一把 = 6
    expect(keys).toHaveLength(6);
    await setValue(keys[5] as HTMLInputElement, 'sk-second');

    // 新那把 Key 的模型改成 gemini
    const modelLines = qa('.ai-rec-model-line');
    const lastModel = modelLines[modelLines.length - 1]?.querySelector('select') as HTMLSelectElement | null;
    expect(lastModel).not.toBeNull();
    await setValue(lastModel as HTMLSelectElement, 'gemini-4-argon');

    const save = q<HTMLButtonElement>('[data-testid="ai-recommend-save"]');
    await click(save);
    await waitFor(() => q('.ai-rec-key') === null, '保存后关闭');

    const saved = await loadCatalog();
    const linghui = saved.providers.find((provider) => provider.id === 'linghui');
    const conns = linghui?.connections ?? [];
    expect(conns).toHaveLength(2);

    const first = conns.find((item) => item.apiKey === 'sk-first');
    const second = conns.find((item) => item.apiKey === 'sk-second');
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    // 关键：gemini 属于第二把，没被并进第一把
    expect(first?.models.map((model) => model.modelId)).not.toContain('gemini-4-argon');
    expect(second?.models.map((model) => model.modelId)).toContain('gemini-4-argon');
  });

  it('灵绘已有两把 Key（openai + anthropic）：原样再保存一次，两把的模型都不能掉', async () => {
    let catalog = createDefaultCatalog();
    catalog = addConnection(catalog, 'linghui', {
      label: '灵绘',
      baseUrl: 'https://xn--ai-xg4e312c.com',
      apiKey: 'sk-image',
      protocol: 'openai',
      multiplier: 0.1,
      billingMode: 'relay',
      models: [
        { id: 'm1', displayName: 'gpt-image-2.5-flare', modelId: 'gpt-image-2.5-flare', caps: ['image'], enabled: true },
      ],
    }).catalog;
    catalog = addConnection(catalog, 'linghui', {
      label: '灵绘',
      baseUrl: 'https://xn--ai-xg4e312c.com',
      apiKey: 'sk-claude',
      protocol: 'anthropic',
      multiplier: 1.1,
      billingMode: 'relay',
      models: [
        { id: 'm2', displayName: 'claude-opus-5-5', modelId: 'claude-opus-5-5', caps: ['text'], enabled: true },
      ],
    }).catalog;
    await seedCatalog(catalog);

    await mountCard();
    await openRecommend();
    await waitFor(() => text().includes('已配置'), '回填完成');

    // 打开后应该有两把 Key（不是只剩一把）
    expect(qa('.ai-rec-key')).toHaveLength(5); // deepseek + 方舟 + 灵绘三把（原有两把 + 补的 gemini）

    const save = q<HTMLButtonElement>('[data-testid="ai-recommend-save"]');
    await click(save);
    await waitFor(() => q('.ai-rec-key') === null, '保存后关闭');

    const saved = await loadCatalog();
    const linghui = saved.providers.find((provider) => provider.id === 'linghui');
    const conns = linghui?.connections ?? [];
    expect(conns.map((item) => item.protocol).sort()).toEqual(['anthropic', 'openai']);
    const claude = conns.find((item) => item.protocol === 'anthropic');
    expect(claude?.models.map((model) => model.modelId)).toContain('claude-opus-5-5');
    expect(claude?.apiKey).toBe('sk-claude');
  });

  it('粘贴 url 后 500ms 内自动识别厂商（moonshot → 月之暗面 / Kimi）', async () => {
    await mountCard();
    await openRecommend();
    const url = byLabel<HTMLInputElement>('服务地址 1');
    expect(url).not.toBeNull();
    await setValue(url as HTMLInputElement, 'https://api.moonshot.cn/v1');
    // 自绘下拉：值在按钮的 data-value 上
    const vendorBefore = byLabel<HTMLButtonElement>('厂商 1')?.dataset.value;
    expect(vendorBefore).toBe('deepseek');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    expect(byLabel<HTMLButtonElement>('厂商 1')?.dataset.value).toBe('moonshot');
  });

  it('选「自定义」→ 多出一个名称输入框，且能选回内置厂商', async () => {
    await mountCard();
    await openRecommend();
    await click(byLabel<HTMLButtonElement>('厂商 1') as HTMLButtonElement);
    const customOption = Array.from(document.querySelectorAll('.ai-rec-menu button')).find(
      (button) => (button.textContent ?? '').includes('自定义'),
    ) as HTMLButtonElement | undefined;
    expect(customOption).toBeTruthy();
    await click(customOption as HTMLButtonElement);

    expect(byLabel<HTMLButtonElement>('厂商 1')?.dataset.value).toBe('custom');
    const input = byLabel<HTMLInputElement>('厂商名 1');
    expect(input).not.toBeNull();
    await setValue(input as HTMLInputElement, '我的中转站');
    expect(byLabel<HTMLInputElement>('厂商名 1')?.value).toBe('我的中转站');

    // 下拉还在：能选回内置厂商（旧的 select 版本选了自定义就回不去了）
    await click(byLabel<HTMLButtonElement>('厂商 1') as HTMLButtonElement);
    const deepseekOption = Array.from(document.querySelectorAll('.ai-rec-menu button')).find(
      (button) => (button.textContent ?? '').includes('DeepSeek'),
    ) as HTMLButtonElement | undefined;
    await click(deepseekOption as HTMLButtonElement);
    expect(byLabel<HTMLButtonElement>('厂商 1')?.dataset.value).toBe('deepseek');
    expect(q('[aria-label="厂商名 1"]')).toBeNull();
  });

  it('三层 ＋：组 +1、Key +1、模型 +1', async () => {
    await mountCard();
    await openRecommend();
    // 弹窗要先读完已有配置才渲染表单（读之前显示「正在读取…」）
    await waitFor(() => qa('.ai-rec-group').length === 3, '三组渲染');
    expect(qa('.ai-rec-group')).toHaveLength(3);
    // 新增一整组 = 地址 + 一条 Key + 一条模型
    await click(byLabel('再加一组'));
    expect(qa('.ai-rec-group')).toHaveLength(4);
    expect(qa('.ai-rec-key-line')).toHaveLength(6);
    expect(qa('.ai-rec-model-line')).toHaveLength(7);
    // 同一地址再加一把 Key（含它名下一条模型）
    await click(byLabel('再加一把 Key'));
    expect(qa('.ai-rec-key-line')).toHaveLength(7);
    expect(qa('.ai-rec-model-line')).toHaveLength(8);
    // 这把 Key 下再加一个模型
    await click(byLabel('再加一个模型'));
    expect(qa('.ai-rec-model-line')).toHaveLength(9);
  });

  it('删到边界时 × 禁用：最后一组 / 最后一把 Key / 最后一个模型', async () => {
    await mountCard();
    await openRecommend();

    // 模型：第 1 组只有 1 个模型 → 它的 × 一开始就是禁用的
    const modelDeletes = qa<HTMLButtonElement>('.ai-rec-model-line .ai-mini-del');
    expect(modelDeletes[0].disabled).toBe(true);

    // 组：从最后一组删起，删到只剩第一组，剩下的 × 禁用（每次删完重新取节点）
    const groupDeletes = (): HTMLButtonElement[] =>
      qa<HTMLButtonElement>('[aria-label="删除整组"]');
    await click(groupDeletes().at(-1));
    await click(groupDeletes().at(-1));
    expect(qa('.ai-rec-group')).toHaveLength(1);
    expect(groupDeletes()[0].disabled).toBe(true);

    // Key：每组只有 1 把时，那把的 × 禁用
    expect(qa('.ai-rec-key-line')).toHaveLength(1);
    const keyDeletes = qa<HTMLButtonElement>('.ai-rec-key-line .ai-mini-del');
    expect(keyDeletes[0].disabled).toBe(true);
    // 界面没有被删空：仍有一组、一把 Key、一个模型
    expect(qa('.ai-rec-group')).toHaveLength(1);
    expect(qa('.ai-rec-key-line')).toHaveLength(1);
    expect(qa('.ai-rec-model-line')).toHaveLength(1);
  });

  it('全空时保存禁用；有 Key 时保存并跳过空行', async () => {
    await mountCard();
    await openRecommend();
    const save = q<HTMLButtonElement>('[data-testid="ai-recommend-save"]');
    expect(save?.disabled).toBe(true);

    // 只填第一把 Key → 其余 3 把空着被跳过，只有 1 组被保存
    await setValue(byLabel<HTMLInputElement>('API Key 1-1') as HTMLInputElement, 'sk-deepseek');
    await waitFor(() => q<HTMLButtonElement>('[data-testid="ai-recommend-save"]')?.disabled === false, '保存可用');
    await click(q('[data-testid="ai-recommend-save"]'));

    await waitFor(() => text().includes('已保存'), '保存提示');
    expect(text()).toContain('已保存 1 组连接，4 把 Key 空着被跳过');
    // 卡片立刻刷新出了新模型（不用手动刷新）
    await waitFor(() => text().includes('已配置 1 个模型'), '卡片刷新');
  });
});

describe('C0. 未生效连接的模型可见', () => {
  it('第二把 Key 的模型也能用：卡片与详情都列出来，不再有「未生效」', async () => {
    let catalog = createDefaultCatalog();
    catalog = addConnection(catalog, 'linghui', {
      label: '灵绘',
      baseUrl: 'https://xn--ai-xg4e312c.com',
      apiKey: 'sk-image',
      protocol: 'openai',
      multiplier: 0.1,
      billingMode: 'relay',
      models: [
        { id: 'm1', displayName: 'gpt-image-2.5-flare', modelId: 'gpt-image-2.5-flare', caps: ['image'], enabled: true },
      ],
    }).catalog;
    catalog = addConnection(catalog, 'linghui', {
      label: '灵绘',
      baseUrl: 'https://xn--ai-xg4e312c.com',
      apiKey: 'sk-claude',
      protocol: 'anthropic',
      multiplier: 1.1,
      billingMode: 'relay',
      models: [
        { id: 'm2', displayName: 'claude-opus-5-5', modelId: 'claude-opus-5-5', caps: ['text'], enabled: true },
      ],
    }).catalog;
    await seedCatalog(catalog);
    await mountCard();

    await waitFor(() => text().includes('已配置 2 个模型'), '两把 Key 的模型都算已配置');
    await click(q('.ai-detail-open, [data-testid="ai-card-detail"], .ai-chip-more'));
    await waitFor(() => text().includes('已配置的模型'), '详情弹窗');

    const rows = qa('.ai-detail-row');
    expect(rows).toHaveLength(2);
    expect(text()).toContain('claude-opus-5-5');
    expect(text()).not.toContain('未生效');
  });
});

describe('C. 详情弹窗', () => {
  it('五个角色下拉 + 音频徽标 + 未配置的音频角色', async () => {
    await seedCatalog(catalogTen());
    await mountCard();
    await waitFor(() => text().includes('已配置 10 个模型'), '已配置计数');
    await click(q('[data-testid="ai-card-detail"]'));
    await waitFor(() => text().includes('已配置的模型 · 10 个'), '详情弹窗');

    const roleLabels = ['写作', '生图', '视频', '音频', '工作流设计'];
    for (const label of roleLabels) {
      expect(byLabel<HTMLSelectElement>(`默认${label}模型`)).not.toBeNull();
    }
    // 候选集按能力来：生图角色只列生图模型
    const imageSelect = byLabel<HTMLSelectElement>('默认生图模型') as HTMLSelectElement;
    expect(imageSelect.options).toHaveLength(3); // 未配置 + 2 个生图模型
    // 音频有模型 → 音频角色可选；红色音频徽标出现在列表里
    expect(q('.ai-badge-audio')).not.toBeNull();
  });

  it('音频一个模型都没有时，音频角色显示「未配置」且下拉只有这一项', async () => {
    const catalog = catalogTen();
    // 把音频模型删掉
    catalog.providers[0].connections[0].models = catalog.providers[0].connections[0].models.filter(
      (model) => !model.caps.includes('audio'),
    );
    await seedCatalog(catalog);
    await mountCard();
    await waitFor(() => text().includes('已配置 9 个模型'), '已配置计数');
    await click(q('[data-testid="ai-card-detail"]'));
    const audioSelect = byLabel<HTMLSelectElement>('默认音频模型') as HTMLSelectElement;
    expect(audioSelect.options).toHaveLength(1);
    expect(audioSelect.options[0].textContent).toBe('未配置');
  });

  it('改动角色即时写库：重开弹窗仍是新值', async () => {
    await seedCatalog(catalogTen());
    await mountCard();
    await waitFor(() => text().includes('已配置 10 个模型'), '已配置计数');
    await click(q('[data-testid="ai-card-detail"]'));
    const writing = byLabel<HTMLSelectElement>('默认写作模型') as HTMLSelectElement;
    const target = Array.from(writing.options).find((option) => option.value.includes('deepseek-chat'));
    expect(target).toBeDefined();
    await setValue(writing, target?.value ?? '');
    const saved = await readModelRoles();
    expect(saved.writing).toContain('deepseek-chat');

    // 关掉再打开：下拉仍是新值
    await click(q<HTMLButtonElement>('.modal-actions .button'));
    await click(q('[data-testid="ai-card-detail"]'));
    expect(byLabel<HTMLSelectElement>('默认写作模型')?.value).toContain('deepseek-chat');
  });

  it('↑ ↓ 兜底：能移动该行，并把顺序写进 settings.modelOrder', async () => {
    await seedCatalog(catalogTen());
    await writeModelOrder([]);
    await mountCard();
    await waitFor(() => text().includes('已配置 10 个模型'), '已配置计数');
    await click(q('[data-testid="ai-card-detail"]'));

    const firstKey = qa('.ai-detail-row')[0].getAttribute('data-model-key');
    const secondKey = qa('.ai-detail-row')[1].getAttribute('data-model-key');
    await click(byLabel(`下移 ${firstKey?.split(':').pop()}`));

    const order = await readModelOrder();
    expect(order[0]).toBe(secondKey);
    expect(order[1]).toBe(firstKey);
    expect(qa('.ai-detail-row')[0].getAttribute('data-model-key')).toBe(secondKey);
  });
});

describe('排序纯函数', () => {
  const keys = ['a', 'b', 'c'];

  it('moveModelKey：插到目标之前 / 之后', () => {
    expect(moveModelKey(keys, 'a', 'c', false)).toEqual(['b', 'a', 'c']);
    expect(moveModelKey(keys, 'a', 'c', true)).toEqual(['b', 'c', 'a']);
    expect(moveModelKey(keys, 'a', 'a', true)).toEqual(['a', 'b', 'c']);
    expect(moveModelKey(keys, 'x', 'c', true)).toEqual(['a', 'b', 'c']);
  });

  it('nudgeModelKey：到边界时原样返回，不越界', () => {
    expect(nudgeModelKey(keys, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(nudgeModelKey(keys, 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(nudgeModelKey(keys, 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(nudgeModelKey(keys, 'c', 1)).toEqual(['a', 'b', 'c']);
  });

  it('初始草稿是空地址；recommendedGroups 是 deepseek / 方舟 / 灵绘三把 Key', () => {
    expect(initialDraft().map((group) => group.baseUrl)).toEqual(['']);
    const draft = recommendedGroups();
    expect(draft.map((group) => group.vendor)).toEqual(['deepseek', 'ark', 'linghui']);
    expect(draft[2].keys.map((key) => key.protocol)).toEqual(['openai', 'openai', 'anthropic']);
    expect(draft[2].keys[0].models.map((model) => model.modelId)).toEqual([
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
    ]);
  });
});

describe('D. 一个入口：载入已有配置 / 推荐置顶 / 拖拽顺序 / 删掉要落库', () => {
  /** 灵绘 + 两把 Key（openai 生图 / anthropic claude） */
  async function seedLinghui(): Promise<void> {
    let catalog = createDefaultCatalog();
    catalog = addConnection(catalog, 'linghui', {
      label: '灵绘',
      baseUrl: 'https://xn--ai-xg4e312c.com',
      apiKey: 'sk-image',
      protocol: 'openai',
      multiplier: 0.1,
      billingMode: 'relay',
      models: [{ id: 'm1', displayName: 'gpt-image-2.5-flare', modelId: 'gpt-image-2.5-flare', caps: ['image'], enabled: true }],
    }).catalog;
    catalog = addConnection(catalog, 'linghui', {
      label: '灵绘',
      baseUrl: 'https://xn--ai-xg4e312c.com',
      apiKey: 'sk-claude',
      protocol: 'anthropic',
      multiplier: 1.1,
      billingMode: 'relay',
      models: [{ id: 'm2', displayName: 'claude-opus-5-5', modelId: 'claude-opus-5-5', caps: ['text'], enabled: true }],
    }).catalog;
    await seedCatalog(catalog);
  }

  it('打开弹窗直接列出全部已有配置（不再套三组模板）', async () => {
    await seedLinghui();
    await mountCard();
    await openRecommend(false);

    expect(qa('.ai-rec-group')).toHaveLength(1);
    expect(qa<HTMLInputElement>('.ai-rec-key')).toHaveLength(2);
    expect(qa<HTMLInputElement>('.ai-rec-url')[0].value).toBe('https://xn--ai-xg4e312c.com');
    // 一把 OpenAI、一把 Anthropic，协议都回填了
    const protos = qa<HTMLButtonElement>('.ai-rec-proto').map((button) =>
      (button.textContent ?? '').replace('▾', '').trim(),
    );
    expect(protos).toEqual(['OpenAI', 'Anthropic']);
  });

  it('点「推荐配置」：三组插到最上面，已有的组只补齐缺的 Key，不重复生成', async () => {
    await seedLinghui();
    await mountCard();
    await openRecommend(false);
    const preset = [...document.querySelectorAll('button')].find(
      (node) => (node.textContent ?? '').trim() === '推荐配置',
    );
    await click(preset as HTMLButtonElement);
    await waitFor(() => qa('.ai-rec-group').length === 3, '三组');

    const urls = qa<HTMLInputElement>('.ai-rec-url').map((input) => input.value);
    expect(urls).toEqual([
      'https://api.deepseek.com',
      'https://ark.cn-beijing.volces.com/api/v3',
      'https://xn--ai-xg4e312c.com',
    ]);
    // 灵绘还是同一组：原有两把 + 补的 gemini（opus 已存在，不再加）
    expect(qa('.ai-rec-key')).toHaveLength(5);
    expect(text()).toContain('gemini-4-carbon');
  });

  it('拖拽纯函数：把 from 挪到 to 的位置；未知 id 原样返回', () => {
    const draft = recommendedGroups();
    const moved = reorderGroups(draft, draft[2].id, draft[0].id);
    expect(moved.map((group) => group.vendor)).toEqual(['linghui', 'deepseek', 'ark']);
    expect(reorderGroups(draft, 'x', draft[0].id)).toBe(draft);
    expect(reorderGroups(draft, draft[0].id, 'x')).toBe(draft);
  });

  it('拖拽后保存：顺序写进 catalog.groupOrder，下次打开还是这个顺序', async () => {
    await mountCard();
    await openRecommend();
    const grips = qa<HTMLElement>('.ai-rec-grip');
    const groups = qa<HTMLElement>('.ai-rec-group');
    const dataTransfer = { effectAllowed: '', setData: () => undefined, getData: () => '' };
    await act(async () => {
      grips[2].dispatchEvent(
        Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer }),
      );
    });
    await act(async () => {
      groups[0].dispatchEvent(new Event('drop', { bubbles: true }));
    });

    // 三组各填一把 Key，保存后三组都会落库（顺序才看得出来）
    await setValue(byLabel<HTMLInputElement>('API Key 1-1') as HTMLInputElement, 'sk-1');
    await setValue(byLabel<HTMLInputElement>('API Key 2-1') as HTMLInputElement, 'sk-2');
    await setValue(byLabel<HTMLInputElement>('API Key 3-1') as HTMLInputElement, 'sk-3');
    await click(q('[data-testid="ai-recommend-save"]'));
    await waitFor(() => q('.ai-rec-key') === null, '保存后关闭');

    const saved = await loadCatalog();
    expect(saved.groupOrder?.[0]).toBe('linghui|https://xn--ai-xg4e312c.com');
    expect(initialDraft(saved).map((group) => group.vendor)).toEqual(['linghui', 'deepseek', 'ark']);
  });

  it('删掉一组再保存：那条连接会从配置里消失', async () => {
    await seedLinghui();
    await mountCard();
    await openRecommend(false);
    // 删掉灵绘这一组（先加一组空白组，否则最后一组的 × 是禁用的）
    expect(qa('.ai-rec-group')).toHaveLength(1);
    await click(byLabel('再加一组'));
    const deletes = qa<HTMLButtonElement>('[aria-label="删除整组"]');
    await click(deletes[0]);
    await click(q('[data-testid="ai-recommend-save"]'));
    await waitFor(() => q('.ai-rec-key') === null, '保存后关闭');

    const saved = await loadCatalog();
    const linghui = saved.providers.find((provider) => provider.id === 'linghui');
    expect(linghui?.connections ?? []).toHaveLength(0);
  });
});

describe('E. 组头注册链接 + 模型行的「1M」声明', () => {
  it('注册链接跟着各自的组走，顶部不再堆一排', async () => {
    await mountCard();
    await openRecommend();
    // 顶部那排「去注册 …」已经不在了
    expect(q('.ai-regs')).toBeNull();
    // 三组各自的组头里各有一条
    const links = qa<HTMLAnchorElement>('.ai-rec-group-links a');
    expect(links.length).toBe(3);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      expect.stringContaining('platform.deepseek.com'),
      expect.stringContaining('console.volcengine.com'),
      expect.stringContaining('xn--ai-xg4e312c'),
    ]);
  });

  it('文本模型默认勾 1M；取消勾 = 明确 128k，两个值都能落库并回填', async () => {
    await mountCard();
    await openRecommend();

    // deepseek-flash 是文本模型 → 一进来就是勾着的
    expect(byLabel('1M 上下文 1-1')?.getAttribute('aria-pressed')).toBe('true');

    await setValue(byLabel<HTMLInputElement>('API Key 1-1') as HTMLInputElement, 'sk-deepseek');
    await click(q('[data-testid="ai-recommend-save"]'));
    await waitFor(() => q('.ai-rec-key') === null, '保存后关闭');

    const saved = await loadCatalog();
    const first = saved.providers.find((provider) => provider.id === 'deepseek')?.connections[0]?.models[0];
    expect(first?.modelId).toBe('deepseek-flash');
    expect(first?.contextLength).toBe(1048576);

    // 再打开：仍是勾着
    await openRecommend(false);
    const again = byLabel<HTMLButtonElement>('1M 上下文 1-1') as HTMLButtonElement;
    expect(again.getAttribute('aria-pressed')).toBe('true');

    // 取消勾 → 保存成明确的 128k（不是"未声明"）
    await click(again);
    expect(byLabel('1M 上下文 1-1')?.getAttribute('aria-pressed')).toBe('false');
    await click(q('[data-testid="ai-recommend-save"]'));
    await waitFor(() => q('.ai-rec-key') === null, '保存后关闭');

    const after = await loadCatalog();
    expect(
      after.providers.find((provider) => provider.id === 'deepseek')?.connections[0]?.models[0]
        ?.contextLength,
    ).toBe(128000);
  });
});
