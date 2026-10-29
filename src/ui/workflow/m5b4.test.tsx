/**
 * 判据 7：面板里的编辑闭环（点「另存为副本并编辑」→ 改名 + 改正文 → 保存在面板生效；
 * 正文 < 50 字 → 红字且不落库）。
 *
 * 只点**现成的那个查看面板**：用例里没有任何"新增入口/路由"的操作，
 * 全部通过 `wf-inspector` 上带 data-testid 的控件完成 —— 入口唯一化由这个文件守着。
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase } from '../../core/storage';
import { createCustomPrompt, listCustomPrompts, resetCustomPromptCache } from '../../core/custom-prompts';
import { loadPackForWorkflow, packSystemPrompt } from './packs';
import { WorkflowPage } from './WorkflowPage';
import { useWorkflowStore } from './store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom 没有 ResizeObserver，而 @xyflow/react 的节点观察者一挂载就要用 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const CUSTOM_BODY =
  '你是一位写梦的编辑。请把这段梦写成三百字以内的整体解读：先复述画面，再指出最稳的情绪，' +
  '最后给一句可执行的自我清点。不提命运、不做诊断、不预言。';

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(async () => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly = class {
    m22 = 1;
    constructor() {}
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  await destroyDatabase();
  resetCustomPromptCache();
  useWorkflowStore.getState().reset();
});

afterEach(async () => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  useWorkflowStore.getState().reset();
  await closeDatabase();
  resetCustomPromptCache();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function text(): string {
  return container.textContent ?? '';
}

/** React 受控输入：必须走原型上的 setter 再派发 input，直接改 .value 不会触发 onChange */
function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('拿不到 value setter');
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function clickTestId(id: string): Promise<void> {
  const target = byTestId(id);
  if (!target) throw new Error(`找不到 ${id}；现有 testid：${listTestIds()}`);
  await act(async () => {
    target.click();
  });
  await flush();
}

function listTestIds(): string {
  return Array.from(container.querySelectorAll('[data-testid]'))
    .map((element) => element.getAttribute('data-testid'))
    .join(', ');
}

async function mountWithPackNode(): Promise<string> {
  // 先放一个「提示词包」节点并打开它的查看面板（真实入口就是节点上的「查看提示词」）
  const nodeId = useWorkflowStore.getState().addNode('pack');
  useWorkflowStore.getState().openInspector(nodeId);

  root = createRoot(container);
  act(() => {
    // 真实入口（`ui/workflow/index.tsx`）就是用 Provider 包着这个页面
    root?.render(
      <ReactFlowProvider>
        <WorkflowPage />
      </ReactFlowProvider>,
    );
  });
  await flush();
  return nodeId;
}

describe('画板路径（判据 2 / 3）：packSystemPrompt 走同一份解析', () => {
  it('有副本时用副本正文、保留校验清单；没有副本时仍是内置全文', async () => {
    // 改动前就成立的事实：内置全文含两段契约
    const builtinDream = packSystemPrompt('dream-interpretation');
    expect(builtinDream).toContain('机器校验清单');
    expect(builtinDream).toContain('硬禁止');

    await createCustomPrompt({
      basePackId: 'dream-interpretation',
      name: '画板版',
      body: CUSTOM_BODY,
    });

    const withCustom = packSystemPrompt('dream-interpretation');
    expect(withCustom.startsWith(CUSTOM_BODY)).toBe(true);
    expect(withCustom).toContain('机器校验清单');
    expect(withCustom).not.toBe(builtinDream);
    expect(loadPackForWorkflow('dream-interpretation').body).toBe(CUSTOM_BODY);

    // 别的 pack 不受牵连（副本按 packId 解析）
    expect(packSystemPrompt('video-storyboard')).not.toContain(CUSTOM_BODY);
  });
});

describe('判据 7：面板内编辑副本', () => {
  it('另存为副本 → 改名改正文 → 保存后面板显示副本名，节点出现「自定义」角标', async () => {
    const nodeId = await mountWithPackNode();

    // 默认只读态：显示的是内置
    expect(byTestId('wf-custom-usage')?.textContent).toContain('内置');
    expect(byTestId('wf-pack-prompt')?.textContent?.length).toBeGreaterThan(200);

    await clickTestId('wf-custom-start');

    const nameInput = byTestId('wf-custom-name') as HTMLInputElement | null;
    const bodyInput = byTestId('wf-custom-body') as HTMLTextAreaElement | null;
    expect(nameInput, '编辑态要有副本名输入框').not.toBeNull();
    expect(bodyInput, '编辑态要有正文输入框').not.toBeNull();
    // 预填：名字是「<内置名> 的副本」，正文是当前生效的正文
    expect(nameInput?.value).toBe('解梦 的副本');
    expect((bodyInput?.value ?? '').length).toBeGreaterThan(200);
    // 只读契约区：校验清单与硬禁止列在灰底块里，并注明不随副本修改
    expect(text()).toContain('由系统维护，不随副本修改');
    expect(text()).toContain('硬禁止');

    setValue(nameInput!, '我的解梦版');
    setValue(bodyInput!, CUSTOM_BODY);
    await clickTestId('wf-custom-save');

    // 面板立刻回到只读态，并显示副本名
    expect(byTestId('wf-custom-usage')?.textContent).toContain('我的解梦版');
    expect(byTestId('wf-custom-name')).toBeNull();
    expect(byTestId('wf-pack-prompt')?.textContent).toContain(CUSTOM_BODY);
    // 校验清单仍在生效的 system prompt 里
    expect(byTestId('wf-pack-prompt')?.textContent).toContain('机器校验清单');

    const rows = await listCustomPrompts('dream-interpretation');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('我的解梦版');
    expect(rows[0].body).toBe(CUSTOM_BODY);

    // 节点角标：data 里记下副本 id（刷新后靠它继续显示）
    const node = useWorkflowStore.getState().nodes.find((item) => item.id === nodeId);
    expect(node?.data.customPromptId).toBe(rows[0].id);
  });

  it('正文 < 50 字时点保存：红字提示且不落库', async () => {
    await mountWithPackNode();
    await clickTestId('wf-custom-start');

    const nameInput = byTestId('wf-custom-name') as HTMLInputElement;
    const bodyInput = byTestId('wf-custom-body') as HTMLTextAreaElement;
    setValue(nameInput, '太短版');
    setValue(bodyInput, '写短一点就好');
    await clickTestId('wf-custom-save');

    const error = byTestId('wf-custom-error');
    expect(error, '不合格时必须有红字提示').not.toBeNull();
    expect(error?.textContent).toContain('至少 50 字');
    // 仍是编辑态（没有偷偷保存）
    expect(byTestId('wf-custom-save')).not.toBeNull();
    expect(await listCustomPrompts()).toHaveLength(0);
    // 面板上显示的仍是内置
    expect(byTestId('wf-custom-usage')?.textContent).toContain('内置');
  });

  it('删除副本需要二次确认，确认后回到内置', async () => {
    await mountWithPackNode();
    await clickTestId('wf-custom-start');
    setValue(byTestId('wf-custom-name') as HTMLInputElement, '我的解梦版');
    setValue(byTestId('wf-custom-body') as HTMLTextAreaElement, CUSTOM_BODY);
    await clickTestId('wf-custom-save');
    expect(await listCustomPrompts()).toHaveLength(1);

    await clickTestId('wf-custom-start');
    await clickTestId('wf-custom-remove');
    // 只是要确认，没删
    expect(text()).toContain('确认删除');
    expect(await listCustomPrompts()).toHaveLength(1);

    await clickTestId('wf-custom-remove-confirm');
    expect(byTestId('wf-custom-usage')?.textContent).toContain('内置');
    expect(await listCustomPrompts()).toHaveLength(0);
  });

  it('「还原为内置」直接回到内置正文（面板显示「内置」）', async () => {
    await mountWithPackNode();
    await clickTestId('wf-custom-start');
    setValue(byTestId('wf-custom-name') as HTMLInputElement, '我的解梦版');
    setValue(byTestId('wf-custom-body') as HTMLTextAreaElement, CUSTOM_BODY);
    await clickTestId('wf-custom-save');

    await clickTestId('wf-custom-start');
    const buttons = Array.from(container.querySelectorAll('.wf-inspector-actions button'));
    const restore = buttons.find((button) => (button.textContent ?? '').includes('还原为内置'));
    expect(restore, '有副本时编辑态要有「还原为内置」').toBeDefined();
    await act(async () => {
      (restore as HTMLButtonElement).click();
    });
    await flush();

    expect(byTestId('wf-custom-usage')?.textContent).toContain('内置');
    expect(byTestId('wf-pack-prompt')?.textContent).not.toContain(CUSTOM_BODY);
    expect(await listCustomPrompts()).toHaveLength(0);
  });
});
