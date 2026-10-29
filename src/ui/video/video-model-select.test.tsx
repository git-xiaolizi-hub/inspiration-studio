/**
 * 「生视频」区块的模型选择判据（M3R3 §3：删掉「通道 / 免费通道」分离设计）。
 *
 * P2：判据一条没改，被测组件从 `VideoPage`（随 `/video` 一起删掉）换成
 * `VideoGenerationSection` —— 它就是单卡创作「生视频」tab 里渲染的那块。
 *
 * 页面只剩一个模型下拉：内容 = 模型表里 `caps` 含 `video` 的模型；
 * 选中哪个模型就按它的能力位渲染参数，免费与否是模型自己的属性。
 *
 * 外加保留 M4c 的 429 拥挤重试链路（真适配器 + mock server），因为那条判据与"通道"无关。
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoGenerationPanel } from './VideoGenerationPanel';
import { VIDEO_MODEL_EMPTY_HINT, VideoGenerationSection } from './VideoGenerationSection';
import type { VideoGenerationSectionProps } from './VideoGenerationSection';
import { ZhipuVideoAdapter } from '../../adapters/video/zhipu-adapter';
import { FREE_CHANNEL_CAPABILITIES } from '../../adapters/video/capabilities';
import type { ChannelAdapter } from '../../adapters/video/channels';
import { nodeFetch, startMockServer } from '../../test/mock-http-server';
import type { MockHandler } from '../../test/mock-http-server';
import {
  applyPresetTag,
  createDefaultCatalog,
  findProvider,
  presetTagsFor,
} from '../../adapters/ai-models/catalog';
import type { AICatalog, Provider } from '../../adapters/ai-models/catalog';
import { OFFICIAL_PRICE_TABLE } from '../../adapters/ai-models/pricing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ZHIPU_VIDEO_URL = 'https://cdn.example.com/zhipu/ui.mp4';

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
    if (Date.now() - started > 5000) throw new Error(`等待超时：${label}`);
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

async function selectModel(modelId: string): Promise<void> {
  const select = container.querySelector('select[aria-label="视频模型"]') as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (!setter) throw new Error('拿不到 select 的 value setter');
  const option = Array.from(select.options).find((item) => item.value.endsWith(`::${modelId}`));
  if (!option) throw new Error(`下拉里没有模型：${modelId}`);
  await act(async () => {
    setter.call(select, option.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    await flush();
  });
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

function text(): string {
  return container.textContent ?? '';
}

function currentPhase(): string | null {
  return container.querySelector('[data-phase]')?.getAttribute('data-phase') ?? null;
}

function findButton(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((button) =>
    (button.textContent ?? '').includes(label),
  );
  if (!found) {
    throw new Error(
      `找不到按钮：${label}（当前按钮：${Array.from(container.querySelectorAll('button'))
        .map((b) => b.textContent)
        .join(' / ')}）`,
    );
  }
  return found;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
});

/** 真适配器里最省的那个替身：这些用例只看"选了模型后 UI 认到了哪一支" */
function fakeAdapter(name: string): ChannelAdapter {
  return {
    submit: async () => ({ task_id: `${name}-task` }),
    poll: async () => ({ task_id: `${name}-task`, status: 'running' as const }),
    cancel: async () => undefined,
    downloadAndStore: async () => 'blob:fake',
  } as ChannelAdapter;
}

/** 用预设标签搭模型表（与用户点标签的路径一致；连接会用厂商默认 base_url） */
function catalogWith(spec: Record<string, string[]>): AICatalog {
  let catalog = createDefaultCatalog();
  for (const [providerId, modelIds] of Object.entries(spec)) {
    const provider = findProvider(catalog, providerId);
    if (!provider) throw new Error(`没有这个厂商：${providerId}`);
    const tags = presetTagsFor(provider);
    for (const modelId of modelIds) {
      const tag = tags.find((item) => item.modelId === modelId);
      if (!tag) throw new Error(`${providerId} 没有标签 ${modelId}`);
      catalog = applyPresetTag(catalog, providerId, tag);
    }
  }
  return catalog;
}

const baseProps: VideoGenerationSectionProps = {
  spent: 0,
  budgetLimit: null,
  priceTable: OFFICIAL_PRICE_TABLE,
  sleep: async () => undefined,
};

async function mountPage(props: Partial<VideoGenerationSectionProps>): Promise<void> {
  await mount(<VideoGenerationSection {...baseProps} {...props} />);
  await waitFor(() => text().includes('视频生成'), '页面渲染');
}

describe('§3.1 模型下拉 = 模型表里 caps 含 video 的模型', () => {
  it('只有视频模型出现；文本 / 视觉 / 生图模型不列出', async () => {
    await mountPage({
      catalog: catalogWith({
        zhipu: ['glm-5.3-flash', 'cogvideox-flash', 'cogview-3-flash'],
        ark: ['doubao-seedance-2-5-260628'],
      }),
      arkAdapter: fakeAdapter('ark'),
      zhipuAdapter: fakeAdapter('zhipu'),
    });

    const options = Array.from(container.querySelectorAll('select[aria-label="视频模型"] option')).map(
      (option) => option.textContent ?? '',
    );
    expect(options).toHaveLength(2);
    expect(options[0]).toContain('cogvideox-flash');
    expect(options[1]).toContain('doubao-seedance-2-5-260628');
    // 文本 / 生图模型一个都不许混进视频下拉
    expect(options.join(' / ')).not.toContain('glm-5.3-flash');
    expect(options.join(' / ')).not.toContain('cogview-3-flash');
  });

  it('模型表里没有视频模型 → 给可执行提示（点哪个模型、去哪个页面）', async () => {
    await mountPage({ catalog: catalogWith({ zhipu: ['glm-5.3-flash'] }) });

    await waitFor(() => container.querySelector('[data-testid="video-model-empty"]') !== null, '空态');
    expect(text()).toContain(VIDEO_MODEL_EMPTY_HINT);
    expect(text()).toContain('你还没有配置视频模型');
    expect(text()).toContain('doubao-seedance-2-5-260628（视频，推荐）');
    expect(text()).toContain('cogvideox-flash（视频，免费测试）');
    expect(container.querySelector('select[aria-label="视频模型"]')).toBeNull();
  });

  it('模型表里的视频模型没有适配器 → 一句可执行提示（本地部署的 minimax-h3）', async () => {
    const custom: Provider = {
      id: 'custom:local-video',
      name: '本地视频组',
      builtin: false,
      connections: [
        {
          id: 'conn-local',
          label: '本地',
          baseUrl: 'http://127.0.0.1:8188',
          apiKey: '',
          protocol: 'openai',
          // M3R6：模型表挂在连接下
          models: [
            {
              id: 'model-local',
              displayName: 'minimax-h3（视频，本地部署推荐）',
              modelId: 'minimax-h3',
              caps: ['video'],
            },
          ],
        },
      ],
      activeConnectionId: 'conn-local',
    };
    const catalog: AICatalog = { providers: [...createDefaultCatalog().providers, custom], updatedAt: 0 };

    await mountPage({ catalog });
    await waitFor(
      () => container.querySelector('[data-testid="video-model-unwired"]') !== null,
      '未接适配器提示',
    );
    expect(text()).toContain('该模型还没有视频适配器');
    expect(text()).toContain('minimax-h3');
    expect(text()).toContain('cogvideox-flash');
  });
});

describe('§3.3 免费 / 付费只剩一行提示（换模型就是换提示）', () => {
  it('cogvideox-flash：免费提示 + 预估显示「免费」+ 不支持的能力直接禁用', async () => {
    await mountPage({
      catalog: catalogWith({ zhipu: ['cogvideox-flash'], ark: ['doubao-seedance-2-5-260628'] }),
      arkAdapter: fakeAdapter('ark'),
      zhipuAdapter: fakeAdapter('zhipu'),
    });

    await selectModel('cogvideox-flash');
    await waitFor(() => text().includes('预计花费 免费'), '免费预估');

    const notice = container.querySelector('[data-testid="free-model-notice"]');
    expect(notice?.textContent).toBe('免费模型：不计费，但可能排队 429，画质有限');
    expect(text()).toContain('预计花费 免费');
    expect(text()).not.toContain('预计花费 ¥');

    const referenceVideo = container.querySelector('input[aria-label="参考视频 URL"]') as HTMLInputElement;
    expect(referenceVideo.disabled).toBe(true);
    expect(text()).toContain('当前模型不支持视频参考');

    const draft = container.querySelector('input[aria-label="样片模式"]') as HTMLInputElement;
    expect(draft.disabled).toBe(true);

    const resolutions = Array.from(
      container.querySelectorAll('select[aria-label="分辨率"] option'),
    ).map((option) => option.textContent);
    expect(resolutions).toEqual(['480p', '720p']);
  });

  it('换成 Seedance：免费提示消失，预估回到金额（¥7.56）', async () => {
    await mountPage({
      catalog: catalogWith({ zhipu: ['cogvideox-flash'], ark: ['doubao-seedance-2-5-260628'] }),
      arkAdapter: fakeAdapter('ark'),
      zhipuAdapter: fakeAdapter('zhipu'),
    });

    await selectModel('doubao-seedance-2-5-260628');
    await waitFor(() => text().includes('本次约 ¥7.56'), '付费预估');

    expect(container.querySelector('[data-testid="free-model-notice"]')).toBeNull();
    expect(text()).not.toContain('免费模型：不计费');
    // 付费模型的能力位回来了
    const draft = container.querySelector('input[aria-label="样片模式"]') as HTMLInputElement;
    expect(draft.disabled).toBe(false);
  });
});

describe('§3.2 「通道」这套说法已经从页面上消失', () => {
  it('默认（免费模型）与切到 Seedance 两种状态下，都不出现「免费通道」/「保存并启用免费通道」', async () => {
    await mountPage({
      catalog: catalogWith({ zhipu: ['cogvideox-flash'], ark: ['doubao-seedance-2-5-260628'] }),
      arkAdapter: fakeAdapter('ark'),
      zhipuAdapter: fakeAdapter('zhipu'),
    });

    expect(text()).not.toContain('免费通道');
    expect(text()).not.toContain('保存并启用免费通道');
    expect(text()).not.toContain('停用免费通道');
    // 「生成通道」下拉也不存在了：只剩模型下拉
    expect(container.querySelector('select[aria-label="生成通道"]')).toBeNull();
    // 智谱 Key 也不在这一页填（属于 AI 配置里的连接）
    expect(container.querySelector('input[aria-label="智谱 API Key"]')).toBeNull();

    await selectModel('doubao-seedance-2-5-260628');
    expect(text()).not.toContain('免费通道');
    expect(text()).not.toContain('保存并启用免费通道');
    expect(text()).not.toContain('生成通道');
  });
});

describe('判据 14（保留）：429 拥挤时显示「排队重试中（第 n 次）」，最终成功且不计费', () => {
  function makeGates(): { sleep: (ms: number) => Promise<void>; open: () => Promise<void> } {
    const resolvers: Array<() => void> = [];
    return {
      sleep: () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
      open: async () => {
        const started = Date.now();
        while (resolvers.length === 0) {
          if (Date.now() - started > 4000) throw new Error('等待 gate 出现超时');
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
    };
  }

  function binaryResponse(bytes: Uint8Array): Response {
    return {
      ok: true,
      status: 200,
      statusText: '',
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'video/mp4' : null) },
      text: async () => '',
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as Response;
  }

  function json(body: unknown, status = 200): MockHandler {
    return (_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
  }

  it('两次 429 → 两次重试文案 → 生成成功，且不计费', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: (blob: Blob) => `blob:mock/${blob.size}`,
    });
    const gate = makeGates();
    let attempt = 0;
    const createHandler: MockHandler = (_request, response) => {
      attempt += 1;
      if (attempt <= 2) {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { code: '1305', message: '该模型当前访问量过大，请您稍后再试' } }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'zp-ui', task_status: 'PROCESSING' }));
    };

    const server = await startMockServer({
      '/videos/generations': createHandler,
      '/async-result/zp-ui': json({
        task_status: 'SUCCESS',
        video_result: [{ url: ZHIPU_VIDEO_URL }],
      }),
    });

    const adapter = new ZhipuVideoAdapter({
      apiKey: 'key-zhipu',
      baseUrl: server.baseUrl,
      pollIntervalMs: 0,
      random: () => 0,
      sleep: gate.sleep,
      fetchImpl: (input, init) => {
        if (input.startsWith(server.baseUrl)) return nodeFetch(input, init);
        if (input === ZHIPU_VIDEO_URL) return Promise.resolve(binaryResponse(new Uint8Array([4, 4])));
        return Promise.reject(new Error(`未预期的请求：${input}`));
      },
    });

    const onSpend = vi.fn();
    try {
      await mount(
        <VideoGenerationPanel
          adapter={adapter}
          capabilities={FREE_CHANNEL_CAPABILITIES}
          channelLabel="cogvideox-flash（视频，免费测试）"
          spent={2}
          budgetLimit={1}
          onSpend={onSpend}
          sleep={async () => undefined}
        />,
      );

      await typePrompt('一只猫在雨里走');
      await click(findButton('生成视频'));

      await waitFor(() => text().includes('拥挤'), '第一次拥挤文案');
      expect(text()).toContain('排队重试中');
      expect(text()).toContain('第 1 次');
      await gate.open();

      await waitFor(() => text().includes('第 2 次'), '第二次拥挤文案');
      await gate.open();

      await waitFor(() => currentPhase() === 'succeeded', '生成成功');
      await waitFor(() => container.querySelector('video') !== null, '视频落盘');

      expect(text()).toContain('免费模型：本次不计费');
      // 判据 19：免费模型不记账（不是记 0）
      expect(onSpend).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(URL, 'createObjectURL');
      await server.close();
    }
  });
});
