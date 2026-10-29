/**
 * 视频 UI 判据（§4.3 + 判据 3 / 11）。
 *
 * 用的是**真适配器 + mock server**（不是假 adapter），所以这里同时验证了
 * "UI → 适配器 → 轮询状态机 → 落盘"的整条链路；只有 fetch 的出口是注入的。
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

const VIDEO_URL = 'https://cdn.example.com/generated/ui-video.mp4';

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

async function waitFor(check: () => boolean, label = '条件'): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 4000) throw new Error(`等待超时：${label}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
    await flush();
  });
}

/** 受控输入：直接改 value 不会触发 React 的 onChange，必须用原型 setter + 派发 input */
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

function text(): string {
  return container.textContent ?? '';
}

/**
 * 当前状态机阶段（读 `data-phase`）。
 * 不能用 `text().includes('运行中')` —— 阶段徽章把五个阶段名都渲染出来了，
 * 那样断言会永远为真（M4b 自己踩过的坑）。
 */
function currentPhase(): string | null {
  return container.querySelector('[data-phase]')?.getAttribute('data-phase') ?? null;
}

function findButton(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((button) =>
    (button.textContent ?? '').includes(label),
  );
  if (!found) throw new Error(`找不到按钮：${label}（当前按钮：${Array.from(container.querySelectorAll('button')).map((b) => b.textContent).join(' / ')}）`);
  return found;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  Reflect.deleteProperty(URL, 'createObjectURL');
});

function stubCreateObjectURL(): void {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob) => `blob:mock/${blob.size}`,
  });
}

function binaryResponse(bytes: Uint8Array, contentType = 'video/mp4'): Response {
  return {
    ok: true,
    status: 200,
    statusText: '',
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => '',
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

function makeAdapter(target: MockServer, now = () => Date.now()): ArkVideoAdapter {
  return new ArkVideoAdapter({
    apiKey: 'test-key',
    baseUrl: target.baseUrl,
    pollIntervalMs: 0,
    now,
    fetchImpl: (input, init) => {
      if (input.startsWith(target.baseUrl)) return nodeFetch(input, init);
      if (input === VIDEO_URL) return Promise.resolve(binaryResponse(new Uint8Array([7, 7])));
      return Promise.reject(new Error(`未预期的请求：${input}`));
    },
  });
}

function json(body: unknown, status = 200): MockHandler {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
}

/** 手动放行的等待器：让"运行中"这一步在 DOM 里停住，从而能断言状态变化 */
function makeGates(): { sleep: (ms: number) => Promise<void>; open: () => Promise<void>; pending: () => number } {
  const resolvers: Array<() => void> = [];
  return {
    sleep: () =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
      }),
    open: async () => {
      // 可能"还没走到第一次 sleep"，所以要等 gate 真的出现再放行（否则会空放一次，随后死等）
      const started = Date.now();
      while (resolvers.length === 0) {
        if (Date.now() - started > 3000) throw new Error('等待 gate 出现超时');
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
      }
      resolvers.shift()?.();
      await act(async () => {
        await flush();
        await flush();
      });
    },
    pending: () => resolvers.length,
  };
}

describe('状态机可视化（判据 3：UI 显示排队 → 运行 → 成功）', () => {
  it('三次轮询依次点亮 排队中 / 运行中 / 生成成功，并把视频落盘', async () => {
    stubCreateObjectURL();
    const gate = makeGates();
    const statuses = [
      { status: 'queued' },
      { status: 'running' },
      { status: 'succeeded', content: [{ type: 'video_url', video_url: { url: VIDEO_URL } }], usage: { completion_tokens: 108_000 } },
    ];
    let index = 0;
    const pollHandler: MockHandler = (_request, response) => {
      const body = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    const server = await startMockServer({
      '/contents/generations/tasks': json({ id: 'task-ui' }),
      '/contents/generations/tasks/task-ui': pollHandler,
    });

    try {
      await mount(
        <VideoGenerationPanel adapter={makeAdapter(server)} spent={0} budgetLimit={null} sleep={gate.sleep} />,
      );
      await typePrompt('一只猫在雨里走');
      await click(findButton('生成视频'));

      await waitFor(() => currentPhase() === 'queued', '排队中');
      await gate.open();
      await waitFor(() => currentPhase() === 'running', '运行中');
      await gate.open();
      await waitFor(() => currentPhase() === 'succeeded', '生成成功');
      await waitFor(() => container.querySelector('video') !== null, '视频落盘');

      expect(text()).toContain('24 小时');
      // 花费按接口 usage 反算（108000 token × ¥70/M = ¥7.56），而不是只用估值
      expect(text()).toContain('实际用量');
      expect(text()).toContain('108,000 token');
      expect(text()).toContain('¥7.56');
      const video = container.querySelector('video');
      expect(video?.getAttribute('src')).toBe('blob:mock/2');
      expect(text()).toContain('任务 ID：task-ui');
    } finally {
      await server.close();
    }
  });

  it('失败时显示分类与下一步（余额不足）', async () => {
    const server = await startMockServer({
      '/contents/generations/tasks': json({ id: 'task-fail-ui' }),
      '/contents/generations/tasks/task-fail-ui': json({
        status: 'failed',
        error: { code: 'AccountOverdueError', message: '账户余额不足' },
      }),
    });

    try {
      await mount(
        <VideoGenerationPanel
          adapter={makeAdapter(server)}
          spent={0}
          budgetLimit={null}
          sleep={async () => undefined}
        />,
      );
      await typePrompt('一只猫在雨里走');
      await click(findButton('生成视频'));
      await waitFor(() => currentPhase() === 'failed', '生成失败');
      expect(text()).toContain('余额不足');
      expect(text()).toContain('下一步');
      expect(text()).toContain('¥200');
    } finally {
      await server.close();
    }
  });
});

describe('预算闸门（判据 11：未确认不发创建请求）', () => {
  it('超预算时第一次点击只要求确认，服务端收不到创建请求；确认后才提交', async () => {
    const server = await startMockServer({
      '/contents/generations/tasks': json({ id: 'task-budget' }),
      '/contents/generations/tasks/task-budget': json({
        status: 'succeeded',
        content: [{ type: 'video_url', video_url: { url: VIDEO_URL } }],
        usage: { completion_tokens: 1 },
      }),
    });

    try {
      stubCreateObjectURL();
      await mount(
        <VideoGenerationPanel
          adapter={makeAdapter(server)}
          spent={0}
          budgetLimit={1}
          sleep={async () => undefined}
        />,
      );

      // 720p / 5 秒 = ¥7.56 > 预算 ¥1 → 必须先确认
      await typePrompt('一只猫在雨里走');
      await click(findButton('仍需生成'));
      expect(server.hits).toHaveLength(0);
      expect(text()).toContain('超出预算');

      await click(findButton('确认生成（已超预算）'));
      await waitFor(() => server.hits.length > 0, '创建请求');
      const creates = server.hits.filter((hit) => hit.method === 'POST');
      expect(creates).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('预算未设置时不拦（按钮直接是「生成视频」）', async () => {
    const server = await startMockServer({});
    try {
      await mount(<VideoGenerationPanel adapter={makeAdapter(server)} spent={0} budgetLimit={null} />);
      expect(() => findButton('生成视频')).not.toThrow();
      expect(text()).not.toContain('仍需生成');
    } finally {
      await server.close();
    }
  });
});

describe('预估与真人脸警告（§4.3）', () => {
  it('提交前就显示预估金额、样片两行、价格来源与 24 小时口径', async () => {
    const server = await startMockServer({});
    try {
      await mount(<VideoGenerationPanel adapter={makeAdapter(server)} spent={2} budgetLimit={50} />);
      expect(text()).toContain('本次约 ¥7.56');
      expect(text()).toContain('价格来源');
      expect(text()).toContain('本机累计已花 ¥2.00');

      // 打开样片模式 → 两行金额 + 1080p 限制提示
      const draftCheckbox = container.querySelector('input[aria-label="样片模式"]') as HTMLInputElement;
      await act(async () => {
        draftCheckbox.click();
        await flush();
      });
      expect(text()).toContain('Draft ¥');
      expect(text()).toContain('成片 ¥');
      expect(text()).toContain('只能 1080p');
    } finally {
      await server.close();
    }
  });

  it('真人脸警告常驻，并链接官方肖像素材方案', async () => {
    const server = await startMockServer({});
    try {
      await mount(<VideoGenerationPanel adapter={makeAdapter(server)} spent={0} budgetLimit={null} />);
      expect(text()).toContain('不支持含真人人脸的参考图');
      const link = container.querySelector('a[href*="seedance-portrait-asset-guide"]');
      expect(link).not.toBeNull();
    } finally {
      await server.close();
    }
  });

  it('附加参考图后再提示一次，并在提交时把素材按 < 5MB 转成 base64', async () => {
    const server = await startMockServer({ '/contents/generations/tasks': json({ id: 'task-img' }) });
    try {
      stubCreateObjectURL();
      await mount(
        <VideoGenerationPanel
          adapter={makeAdapter(server)}
          spent={0}
          budgetLimit={null}
          sleep={async () => undefined}
          readFile={async () => new Uint8Array([1, 2, 3])}
        />,
      );

      const input = container.querySelector('input[aria-label="参考图"]') as HTMLInputElement;
      const file = new File([new Uint8Array([1, 2, 3])], 'ref.png', { type: 'image/png' });
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await flush();
      });
      expect(text()).toContain('已附加参考素材');

      await typePrompt('一只猫在雨里走');
      await click(findButton('生成视频'));
      await waitFor(() => server.hits.length > 0, '创建请求');
      const body = JSON.parse(server.hits[0].body) as {
        content: Array<{ type: string; image_url?: { url: string }; role?: string }>;
      };
      const image = body.content.find((item) => item.type === 'image_url');
      expect(image?.role).toBe('reference_image');
      expect(image?.image_url?.url.startsWith('data:image/png;base64,')).toBe(true);
    } finally {
      await server.close();
    }
  });
});
