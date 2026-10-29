/**
 * M5b4 的 UI 层判据（jsdom 能验的那一半；真浏览器证据在 M5b4-REPORT.md §5）。
 *
 * 守四件事：
 * 1. 「图片源」节点真能选/上传，且**超 10MB 在进库前就被拒**（节点上红字，一个字节不写库）；
 * 2. 点开节点能看到**完整输出**（节点上是前 200 字，检查器里是全文，复制拿到的也是全文）；
 * 3. 「提示词包」节点的模型下拉：没配 → 标黄「未配置模型」；选了 → 节点上写实际模型名且落进 data；
 * 4. 执行模式会记住上次选择；"暂停中刷新"能认出上次被中断（提示 + 不显示成运行中）。
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase } from '../../core/storage';
import {
  WorkflowPage,
  consumeInterruptedRun,
  markRunStarted,
  readExecMode,
  writeExecMode,
} from './WorkflowPage';
import { useWorkflowStore } from './store';
import type { ModelOption } from './store';
import { NODE_OUTPUT_PREVIEW_CHARS } from './WorkflowNodes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

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
  useWorkflowStore.getState().reset();
  try {
    globalThis.localStorage?.clear();
  } catch {
    /* ignore */
  }
});

afterEach(async () => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  useWorkflowStore.getState().reset();
  await closeDatabase();
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

async function mount(): Promise<void> {
  root = createRoot(container);
  act(() => {
    root?.render(
      <ReactFlowProvider>
        <WorkflowPage />
      </ReactFlowProvider>,
    );
  });
  await flush();
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('拿不到 value setter');
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('图片源节点：选已有产物 / 上传超限提前拒绝', () => {
  it('节点里有「已有图片」下拉与上传口；11MB 的图在进库前被拒（红字，不写 sourceMediaId）', async () => {
    const nodeId = useWorkflowStore.getState().addNode('imageSource');
    await mount();

    const select = byTestId('wf-source-select') as HTMLSelectElement | null;
    const upload = byTestId('wf-source-upload') as HTMLInputElement | null;
    expect(select, '图片源节点要有「已有图片」下拉').not.toBeNull();
    expect(upload, '图片源节点要有上传口').not.toBeNull();
    expect(upload?.accept).toBe('image/*');

    // 11MB 的假文件：真实 File（jsdom 有）
    const bytes = new Uint8Array(11 * 1024 * 1024);
    const file = new File([bytes], 'huge.png', { type: 'image/png' });
    Object.defineProperty(upload!, 'files', { value: [file], configurable: true });

    await act(async () => {
      upload!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const data = useWorkflowStore.getState().nodes.find((item) => item.id === nodeId)?.data;
    expect(data?.sourceMediaId).toBeUndefined();
    expect(data?.error ?? '').toContain('10.0 MB');
    expect(container.textContent ?? '').toContain('10.0 MB');
  });
});

describe('中间产物：节点上摘要、检查器里全文', () => {
  it('节点显示前 200 字，检查器显示全文，「复制」拿到的也是全文', async () => {
    const long = '梦'.repeat(NODE_OUTPUT_PREVIEW_CHARS) + '这一段只在检查器里看得到';
    const nodeId = useWorkflowStore.getState().addNode('pack');
    useWorkflowStore.getState().updateNodeData(nodeId, { status: 'ok', resultText: long });
    useWorkflowStore.getState().openInspector(nodeId);

    await mount();

    const preview = byTestId('wf-node-output');
    expect(preview, '节点上要有自己那一步的结果').not.toBeNull();
    expect(preview?.textContent ?? '').toContain('…');
    expect((preview?.textContent ?? '').length).toBeLessThan(long.length);

    const full = byTestId('wf-inspector-text');
    expect(full, '检查器要显示完整输出').not.toBeNull();
    expect(full?.textContent).toBe(long);

    // 复制：把剪贴板换成自己的实现，确认复制的是全文而不是摘要
    const copied: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: async (text: string) => void copied.push(text) },
      configurable: true,
    });
    const copyButton = byTestId('wf-copy-output');
    expect(copyButton).not.toBeNull();
    await act(async () => {
      copyButton!.click();
    });
    await flush();
    expect(copied).toEqual([long]);
  });
});

describe('提示词包：可以指定模型', () => {
  const options: ModelOption[] = [
    { key: 'prov-a::model-a', providerId: 'prov-a', modelId: 'model-a', label: '甲厂 / 模型甲' },
    { key: 'prov-b::model-b', providerId: 'prov-b', modelId: 'model-b', label: '乙厂 / 模型乙' },
  ];

  it('选中模型后节点小字写实际模型名，并把 providerId/modelId 落进节点 data', async () => {
    await mount();
    // 页面挂载会从 AI 配置重新灌一遍 models —— 所以注入要放在 mount 之后
    useWorkflowStore.getState().setModels({ text: options, image: [], video: [] });
    useWorkflowStore.getState().setTextDefault({
      providerId: 'prov-a',
      modelId: 'model-a',
      label: '甲厂 / 模型甲',
    });
    const nodeId = useWorkflowStore.getState().addNode('pack');
    await flush();

    // 默认跟随：小字显示「默认：…」
    expect(byTestId('wf-pack-model-label')?.textContent).toContain('默认：甲厂 / 模型甲');
    expect(byTestId('wf-pack-model-label')?.getAttribute('data-warn')).toBe('false');

    const select = byTestId('wf-pack-model') as HTMLSelectElement;
    setValue(select, 'model-b');
    await flush();

    const data = useWorkflowStore.getState().nodes.find((item) => item.id === nodeId)?.data;
    expect(data?.modelId).toBe('model-b');
    expect(data?.providerId).toBe('prov-b');
    expect(byTestId('wf-pack-model-label')?.textContent).toContain('乙厂 / 模型乙');
    // 落库字段：providerId 是配置，不是运行期状态
    const persisted = useWorkflowStore.getState().toWorkflow().nodes.find((item) => item.id === nodeId);
    expect(persisted?.data.providerId).toBe('prov-b');
    expect(persisted?.data.modelId).toBe('model-b');
  });

  it('一个文本模型都没配 → 标黄「未配置模型」', async () => {
    await mount();
    useWorkflowStore.getState().setModels({ text: [], image: [], video: [] });
    useWorkflowStore.getState().setTextDefault(null);
    useWorkflowStore.getState().addNode('pack');
    await flush();

    const label = byTestId('wf-pack-model-label');
    expect(label?.textContent).toContain('未配置模型');
    expect(label?.getAttribute('data-warn')).toBe('true');
    expect(label?.className).toContain('wf-node-model-warn');
  });
});

describe('执行模式与"暂停中刷新"', () => {
  it('执行模式记住上次选择（默认自动跑完）', () => {
    expect(readExecMode()).toBe('auto');
    writeExecMode('step');
    expect(readExecMode()).toBe('step');
    writeExecMode('auto');
    expect(readExecMode()).toBe('auto');
  });

  it('上次运行没结束时留下标记：刷新后给出「被中断」提示，且只提示一次', () => {
    expect(consumeInterruptedRun()).toBeNull();
    markRunStarted('wf-1');
    const notice = consumeInterruptedRun();
    expect(notice).toContain('上次执行被中断');
    expect(consumeInterruptedRun()).toBeNull();
  });

  it('页面上真的显示那句提示（不是"运行中"）', async () => {
    markRunStarted('wf-1');
    await mount();
    const banner = container.querySelector('[role="status"]');
    expect(banner?.textContent ?? '').toContain('上次执行被中断');
    expect(container.textContent ?? '').not.toContain('运行中…');
  });
});
