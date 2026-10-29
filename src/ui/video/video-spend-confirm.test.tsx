/**
 * R6 · 单次花费提醒（替换掉被删的「预算限额」卡）。
 *
 * 委托人的口径：
 *   「不设总预算上限，保留单次生视频的花费提醒（有小字预览，且在用户点击生视频时先拦截提醒）」
 *
 * 这里只锁两件事：
 * 1. 按钮上方那行小字取的是 `pricing.ts` 的估算（不另写算价）；
 * 2. `askBeforeSubmit` 打开时，**点一次不一定发请求** —— 弹窗点「继续」才发，点「取消」不发。
 *
 * 为什么用 `askBeforeSubmit` 这个宿主开关：旧的 `video-ui.test.tsx` 锁的是
 * 「点一次就提交」的原语义（授权外不许改），生产路径（创作页 → VideoGenerationSection）
 * 传 `true`，所以真实的用户一定先看到确认框。
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { VideoGenerationPanel } from './VideoGenerationPanel';
import { ArkVideoAdapter } from '../../adapters/video/ark-adapter';
import { nodeFetch, startMockServer } from '../../test/mock-http-server';
import type { MockHandler, MockServer } from '../../test/mock-http-server';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(node: React.ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
    await flush();
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
    await flush();
  });
}

function text(): string {
  return container.textContent ?? '';
}

function findButton(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((button) =>
    (button.textContent ?? '').includes(label),
  );
  if (!found) {
    throw new Error(
      `找不到按钮：${label}（当前：${Array.from(container.querySelectorAll('button'))
        .map((b) => b.textContent)
        .join(' / ')}）`,
    );
  }
  return found;
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

async function typePrompt(value: string): Promise<void> {
  const textarea = container.querySelector('textarea[aria-label="视频提示词"]') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) throw new Error('拿不到 textarea 的 value setter');
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
  });
}

function json(body: unknown, status = 200): MockHandler {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
}

function makeAdapter(target: MockServer): ArkVideoAdapter {
  return new ArkVideoAdapter({
    apiKey: 'test-key',
    baseUrl: target.baseUrl,
    pollIntervalMs: 0,
    fetchImpl: (input, init) => {
      if (input.startsWith(target.baseUrl)) return nodeFetch(input, init);
      return Promise.reject(new Error(`未预期的请求：${input}`));
    },
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
});

describe('R6 单次花费提醒：小字预估 + 点击先拦', () => {
  it('按钮上方一行小字，金额来自 pricing.ts 的估算（720p / 5s = ¥7.56）', async () => {
    const server = await startMockServer({});
    try {
      await mount(
        <VideoGenerationPanel
          adapter={makeAdapter(server)}
          spent={0}
          budgetLimit={null}
          askBeforeSubmit
        />,
      );

      const inline = byTestId('estimate-inline');
      expect(inline).not.toBeNull();
      expect(inline?.textContent ?? '').toContain('本次约 ¥7.56');
      expect(inline?.textContent ?? '').toContain('5s 720p');
      // 金额全页只出现一次（小字）；清单里重复的「预计花费 ¥x」已被删掉
      const matches = text().match(/¥7\.56/g) ?? [];
      expect(matches).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('点「生成视频」先弹确认框、不发请求；点「取消」仍然不发', async () => {
    const server = await startMockServer({
      '/contents/generations/tasks': json({ id: 'task-r6' }),
    });
    try {
      await mount(
        <VideoGenerationPanel
          adapter={makeAdapter(server)}
          spent={0}
          budgetLimit={null}
          askBeforeSubmit
        />,
      );

      await typePrompt('一只猫在雨里走');
      await click(findButton('生成视频'));

      // 弹窗出现，并且说的是这一笔的金额
      expect(container.querySelector('[role="dialog"][aria-label="生视频花费确认"]')).not.toBeNull();
      expect(text()).toContain('本次生成预计花费 ¥7.56，继续？');
      expect(server.hits).toHaveLength(0);

      await click(byTestId('video-spend-cancel') as HTMLElement);
      expect(byTestId('video-spend-cancel')).toBeNull();
      expect(server.hits).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('点「继续」才真的提交（服务端只收到一次创建请求）', async () => {
    const server = await startMockServer({
      '/contents/generations/tasks': json({ id: 'task-r6-ok' }),
      '/contents/generations/tasks/task-r6-ok': json({ status: 'queued' }),
    });
    try {
      await mount(
        <VideoGenerationPanel
          adapter={makeAdapter(server)}
          spent={0}
          budgetLimit={null}
          askBeforeSubmit
          sleep={async () => undefined}
        />,
      );

      await typePrompt('一只猫在雨里走');
      await click(findButton('生成视频'));
      expect(server.hits).toHaveLength(0);

      await click(byTestId('video-spend-continue') as HTMLElement);

      const creates = server.hits.filter((hit) => hit.method === 'POST');
      expect(creates).toHaveLength(1);
      // 弹窗提交后收起，不会第二次拦
      expect(byTestId('video-spend-continue')).toBeNull();
    } finally {
      await server.close();
    }
  });
});
