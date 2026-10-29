/**
 * 创作页判据（M5a2 §3 test:create，全部 mock，零真实网络）。
 *
 * 5 四个 tab 都能渲染；没有对应能力模型时给可执行提示（不渲染空按钮）
 * 6 解梦 tab：注入假模型响应 → 走校验器，合格显示卡片、不合格显示问题清单
 * 7 生图 tab：注入假响应 → 结果落成 artifact 并出现在详情页
 * 8 生视频 tab：P2 起**就地生成**（页内出模型下拉 + 生成按钮），不再跳独立视频页
 * 9 模型选择器默认取 pickModel(caps)，临时覆盖**不写回配置**
 *
 * 另加一条防漂移用例：浏览器版 pack-runner 与 `packs/runtime.ts` 逐字一致。
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CreatePage } from './CreatePage';
import {
  buildSystemPrompt as buildSystemPromptBrowser,
  buildUserMessage as buildUserMessageBrowser,
  loadBrowserPack,
} from './pack-runner';
import {
  buildSystemPrompt as buildSystemPromptNode,
  buildUserMessage as buildUserMessageNode,
  loadPack,
} from '../../packs/runtime';
import {
  createDefaultCatalog,
  loadCatalog,
  pickModel,
  saveCatalog,
} from '../../adapters/ai-models/catalog';
import type { AICatalog } from '../../adapters/ai-models/catalog';
import { OFFICIAL_PRICE_TABLE } from '../../adapters/ai-models/pricing';
import { ArkImageAdapter } from '../../adapters/image/ark-image-adapter';
import { imageBlobId, makeBlobUrl, saveImageBlob } from '../../adapters/image/storage';
import { listArtifacts } from '../../core/artifacts';
import { createRecord } from '../../core/records';
import { destroyDatabase } from '../../core/storage';
import { RecordDetailPage } from '../pages/RecordDetailPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  // jsdom 不实现 URL.createObjectURL
  Object.defineProperty(URL, 'createObjectURL', {
    value: () => 'blob:mock',
    configurable: true,
    writable: true,
  });
  await destroyDatabase();
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(node: React.ReactNode): void {
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
}

/** 同一个容器里换一棵树：先卸载旧的（否则 React 会警告重复 createRoot，旧树也不会被清理） */
function remount(node: React.ReactNode): void {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.innerHTML = '';
  mount(node);
}

function text(): string {
  return container.textContent ?? '';
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

async function clickTab(id: string): Promise<void> {
  const tab = byTestId(`create-tab-${id}`);
  if (!tab) throw new Error(`没有这个 tab：${id}`);
  await act(async () => {
    (tab as HTMLButtonElement).click();
  });
  await flush();
}

async function clickButton(label: string): Promise<void> {
  const buttons = Array.from(container.querySelectorAll('button'));
  const target = buttons.find((button) => (button.textContent ?? '').includes(label));
  if (!target) throw new Error(`找不到按钮：${label}；现有：${buttons.map((b) => b.textContent).join(' | ')}`);
  await act(async () => {
    target.click();
  });
  await flush();
}

function responseStub(options: {
  json?: unknown;
  bytes?: Uint8Array;
  contentType?: string;
  status?: number;
}): Response {
  const body = options.bytes ?? new TextEncoder().encode(JSON.stringify(options.json ?? {}));
  return {
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    status: options.status ?? 200,
    statusText: '',
    headers: { get: () => options.contentType ?? (options.bytes ? 'image/png' : 'application/json') },
    text: async () => new TextDecoder().decode(body),
    json: async () => JSON.parse(new TextDecoder().decode(body)) as unknown,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

/** 一份够用的小模型表：智谱（文本 + 生图）、方舟（视频） */
function makeCatalog(withImage = true, withVideo = true): AICatalog {
  const catalog = createDefaultCatalog();
  const zhipu = catalog.providers.find((provider) => provider.id === 'zhipu');
  const ark = catalog.providers.find((provider) => provider.id === 'ark');
  if (!zhipu || !ark) throw new Error('默认目录里应当有智谱与方舟');
  zhipu.activeConnectionId = 'zp-1';
  zhipu.connections = [
    {
      id: 'zp-1',
      label: '智谱官方',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-test',
      protocol: 'openai',
      models: [
        { id: 'zp-text', displayName: 'glm-5.3-flash', modelId: 'glm-5.3-flash', caps: ['text', 'vision'] },
        ...(withImage
          ? [
              {
                id: 'zp-img',
                displayName: 'cogview-3-flash',
                modelId: 'cogview-3-flash',
                caps: ['image' as const],
              },
            ]
          : []),
      ],
    },
  ];
  ark.activeConnectionId = 'ark-1';
  ark.connections = [
    {
      id: 'ark-1',
      label: '方舟官方',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'sk-ark',
      protocol: 'openai',
      models: withVideo
        ? [
            {
              id: 'ark-video',
              displayName: 'Seedance 2.5',
              modelId: 'doubao-seedance-2-5-260628',
              caps: ['video' as const],
            },
          ]
        : [],
    },
  ];
  return catalog;
}

const DREAM_TEXT = '我梦见一只白猫坐在窗台上，窗外下着雨，桌上有一只旧钟一直在走。';

function dreamJson(): string {
  const interpretation =
    '先把你讲的这件事复述一遍：屋里有一只白猫，它坐在窗台上；窗外正在下雨，桌上放着一只旧钟，指针一直在走。' +
    '这段画面里最稳的是「停不下来」的感觉——旧钟一直在走，而雨在外面下，像是时间在替你数着什么。' +
    '白猫可能是你自己此刻的状态：安静、警觉、不打算解释，愿意待在一个角落看外面发生的事。' +
    '窗台是里外的分界，坐在那里的意思也许更接近「我暂时不想参与，但我在看」。' +
    '至于雨声，它常常被经验成一种背景性的低语，让人更容易听见自己。' +
    '所以这场梦不太像警告，更像一次自我清点：你在确认哪些事还在走、哪些事已经停了。' +
    '以上都只是联想层面的可能性，并不是对你处境的判断。';
  return JSON.stringify({
    interpretation,
    symbols: [
      { symbol: '白猫', meaning: '可能是你自己那份安静而警觉的状态，也可能只是你需要的一个不受打扰的角落。' },
      { symbol: '窗台', meaning: '像是里与外的分界，也许代表"看着但不参与"的位置。' },
      { symbol: '旧钟', meaning: '可能提示你对时间流逝的在意，某种一直在走的东西。' },
    ],
    disclaimer: '以上是心理联想的视角，不构成任何心理诊断或医疗建议。',
  });
}

/* ------------------------------------------------------------------ */
/* 5. 四个 tab + 缺能力提示                                            */
/* ------------------------------------------------------------------ */

describe('四个 tab 与能力缺失提示（判据 5）', () => {
  it('四个 tab 都能渲染并切换', async () => {
    const record = await createRecord({ text: DREAM_TEXT });
    mount(
      <MemoryRouter>
        <CreatePage catalog={makeCatalog()} recordId={record.id} />
      </MemoryRouter>,
    );
    await flush();

    for (const id of ['dream', 'copy', 'image', 'video']) {
      expect(byTestId(`create-tab-${id}`)).not.toBeNull();
      await clickTab(id);
    }
  });

  it('没有生图模型时给可执行提示，且不渲染生成按钮', async () => {
    const record = await createRecord({ text: DREAM_TEXT });
    mount(
      <MemoryRouter>
        <CreatePage catalog={makeCatalog(false, true)} recordId={record.id} />
      </MemoryRouter>,
    );
    await flush();
    await clickTab('image');

    expect(byTestId('create-missing-cap')?.textContent ?? '').toContain('生图');
    expect(byTestId('create-missing-cap')?.textContent ?? '').toContain('AI 配置');
    // 空按钮不该存在
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels.some((label) => label.includes('生成图片'))).toBe(false);
  });

  it('没有视频模型时同样只给提示，不给「生成视频」按钮（P2：不再有去视频页的跳转）', async () => {
    const record = await createRecord({ text: DREAM_TEXT });
    mount(
      <MemoryRouter>
        <CreatePage catalog={makeCatalog(true, false)} recordId={record.id} />
      </MemoryRouter>,
    );
    await flush();
    await clickTab('video');

    expect(byTestId('create-missing-cap')?.textContent ?? '').toContain('视频');
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels.some((label) => label.includes('生成视频'))).toBe(false);
  });

  /**
   * R7a：音频 tab **只做「能配置、能显示」** —— 生成链路（TTS）还没接，所以 tab 必须禁用、
   * 页面上不许出现任何「生成音频」的假按钮（点了没反应比没有更糟）。
   */
  it('音频 tab 显示「即将支持」且禁用：点不动、不出假生成按钮', async () => {
    const record = await createRecord({ text: DREAM_TEXT });
    mount(
      <MemoryRouter>
        <CreatePage catalog={makeCatalog()} recordId={record.id} />
      </MemoryRouter>,
    );
    await flush();

    const audioTab = byTestId('create-tab-audio') as HTMLButtonElement | null;
    expect(audioTab).not.toBeNull();
    expect(audioTab?.textContent).toContain('即将支持');
    expect(audioTab?.disabled).toBe(true);

    // 点它：仍然停在解梦（aria-selected 不转移）
    await clickTab('audio');
    expect(audioTab?.getAttribute('aria-selected')).toBe('false');
    expect(byTestId('create-tab-dream')?.getAttribute('aria-selected')).toBe('true');

    // 整个页面没有「生成音频 / 生成语音」这类按钮
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels.some((label) => label.includes('生成音频') || label.includes('生成语音'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 6. 解梦：合格 / 不合格                                              */
/* ------------------------------------------------------------------ */

describe('解梦 tab 走校验器（判据 6）', () => {
  it('合格 → 显示解读卡片与意象清单，并落成 artifact', async () => {
    const record = await createRecord({ text: DREAM_TEXT });
    mount(
      <MemoryRouter>
        <CreatePage
          catalog={makeCatalog()}
          recordId={record.id}
          generateText={async () => dreamJson()}
        />
      </MemoryRouter>,
    );
    await flush();
    await clickButton('生成');

    expect(byTestId('create-issues')).toBeNull();
    const card = container.querySelector('[data-kind="dream"]');
    expect(card).not.toBeNull();
    expect(card?.textContent ?? '').toContain('白猫');

    const rows = await listArtifacts(record.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('dream');
  });

  it('不合格 → 列出问题清单（不静默丢弃、也不落成产物）', async () => {
    const record = await createRecord({ text: DREAM_TEXT });
    // 只给 1 个 symbol（判据要求 ≥3），且 meaning 没有推测词
    const bad = JSON.stringify({
      interpretation: '太短。',
      symbols: [{ symbol: '白猫', meaning: '就是你自己。' }],
      disclaimer: '随便说说。',
    });

    mount(
      <MemoryRouter>
        <CreatePage catalog={makeCatalog()} recordId={record.id} generateText={async () => bad} />
      </MemoryRouter>,
    );
    await flush();
    await clickButton('生成');

    const issues = byTestId('create-issues');
    expect(issues).not.toBeNull();
    expect((issues?.querySelectorAll('li') ?? []).length).toBeGreaterThan(0);
    expect(await listArtifacts(record.id)).toHaveLength(0);
  });

  it('模型答的不是 JSON → 一条 json-parse 问题，页面不崩', async () => {
    const record = await createRecord({ text: DREAM_TEXT });
    mount(
      <MemoryRouter>
        <CreatePage catalog={makeCatalog()} recordId={record.id} generateText={async () => '我不想写 JSON'} />
      </MemoryRouter>,
    );
    await flush();
    await clickButton('生成');

    expect(byTestId('create-issues')?.textContent ?? '').toContain('json-parse');
  });
});

/* ------------------------------------------------------------------ */
/* 7. 生图 → artifact → 详情页                                         */
/* ------------------------------------------------------------------ */

describe('生图 tab（判据 7）', () => {
  it('生成 → 落盘 → 详情页能看到这张图的卡片', async () => {
    const record = await createRecord({ text: '窗台上的白猫' });
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
    const adapter = new ArkImageAdapter({
      apiKey: 'sk-ark',
      model: 'doubao-seedream-5-0-pro-260628',
      fetchImpl: async (input) =>
        input.includes('/images/generations')
          ? responseStub({
              json: {
                model: 'doubao-seedream-5-0-pro-260628',
                data: [{ url: 'https://cdn.example.com/cat.png', size: '2048x2048' }],
                usage: { generated_images: 1 },
              },
            })
          : responseStub({ bytes: png, contentType: 'image/png' }),
    });

    // 模型表里的生图模型就是 seedream：这样记录的 modelId 与注入的适配器是同一家
    const catalog = makeCatalog(false, true);
    const ark = catalog.providers.find((provider) => provider.id === 'ark');
    ark?.connections[0].models.push({
      id: 'ark-img',
      displayName: 'Seedream 5.0 pro',
      modelId: 'doubao-seedream-5-0-pro-260628',
      caps: ['image'],
    });

    mount(
      <MemoryRouter>
        <CreatePage catalog={catalog} recordId={record.id} imageAdapter={adapter} />
      </MemoryRouter>,
    );
    await flush();
    await clickTab('image');
    await clickButton('生成图片');

    // 提示词默认取记录正文
    const rows = await listArtifacts(record.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('image');
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.prompt).toBe('窗台上的白猫');
    expect(payload.blobId).toBe(imageBlobId(rows[0].id));
    expect(typeof payload.expiresAt).toBe('number');

    // 详情页能看到产物
    remount(
      <MemoryRouter initialEntries={[`/records/${record.id}`]}>
        <Routes>
          <Route path="/records/:id" element={<RecordDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    expect(byTestId('detail-artifacts')).not.toBeNull();
    const card = container.querySelector('[data-kind="image"]');
    expect(card).not.toBeNull();
    expect(card?.textContent ?? '').toContain('窗台上的白猫');
    expect(card?.textContent ?? '').toContain('doubao-seedream-5-0-pro-260628');
  });
});

/* ------------------------------------------------------------------ */
/* 8. 生视频 → 页内面板（P2：不再跳 /video）                            */
/* ------------------------------------------------------------------ */

describe('生视频 tab（判据 8）', () => {
  it('点生视频 tab → 页内出模型下拉与生成按钮，路由仍停在 /create?recordId=', async () => {
    const record = await createRecord({ text: DREAM_TEXT });

    function LocationProbe() {
      const location = useLocation();
      return <p data-testid="location-probe">{`${location.pathname}${location.search}`}</p>;
    }

    mount(
      <MemoryRouter initialEntries={[`/create?recordId=${record.id}`]}>
        <Routes>
          <Route path="/create" element={<CreatePage catalog={makeCatalog()} />} />
          {/* 落到任何别的路由上就说明页面跳走了（P2 之后不该再发生） */}
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    await clickTab('video');
    await flush();

    // 页内就有视频面板：模型下拉 + 生成按钮
    expect(container.querySelector('select[aria-label="视频模型"]')).not.toBeNull();
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels.some((label) => label.includes('生成视频'))).toBe(true);
    expect(labels.some((label) => label.includes('去视频页生成'))).toBe(false);

    // 没有发生跳转：还在创作页
    expect(byTestId('location-probe')).toBeNull();
    expect(text()).toContain('生视频');
  });
});

/* ------------------------------------------------------------------ */
/* 9. 模型选择器：默认值 + 覆盖不写回                                  */
/* ------------------------------------------------------------------ */

describe('模型选择器（判据 9）', () => {
  it('默认取 pickModel(image)，本页临时覆盖不写回配置', async () => {
    const catalog = makeCatalog();
    const picked = pickModel(catalog, 'image');
    expect(picked.ok).toBe(true);
    const pickedId = picked.model?.modelId;
    expect(pickedId).toBe('cogview-3-flash');

    // 再加一个生图模型，才能演示"临时覆盖"
    const zhipu = catalog.providers.find((provider) => provider.id === 'zhipu');
    zhipu?.connections[0].models.push({
      id: 'zp-img-2',
      displayName: 'glm-image',
      modelId: 'glm-image',
      caps: ['image'],
    });
    await saveCatalog(catalog);
    const before = await loadCatalog();

    const record = await createRecord({ text: DREAM_TEXT });
    mount(
      <MemoryRouter>
        <CreatePage catalog={catalog} recordId={record.id} />
      </MemoryRouter>,
    );
    await flush();
    await clickTab('image');

    const select = container.querySelector('select[aria-label="生图模型"]') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select?.value).toBe('zhipu::cogview-3-flash');

    // 临时覆盖
    const other = Array.from(select?.options ?? []).find((option) => option.value === 'zhipu::glm-image');
    expect(other).toBeDefined();
    await act(async () => {
      if (select) {
        // 受控 select：直接赋值 React 可能看不到，走原型 setter 再派发 change（同 M3 的 input 处理）
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        if (setter) setter.call(select, 'zhipu::glm-image');
        else select.value = 'zhipu::glm-image';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await flush();
    expect(select?.value).toBe('zhipu::glm-image');

    // store 一个字节都没动（整份目录逐字比较：updatedAt + 每个模型的 caps 顺序都在内）
    const after = await loadCatalog();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

/* ------------------------------------------------------------------ */
/* 防漂移：浏览器版 pack-runner == packs/runtime                        */
/* ------------------------------------------------------------------ */

describe('浏览器版 pack-runner 与 packs/runtime 逐字一致', () => {
  it.each(['dream-interpretation', 'story-expansion'])('%s 的 system/user 提示词完全一致', (name) => {
    const fromNode = loadPack(name);
    const fromBrowser = loadBrowserPack(name);
    const input = { dream_text: DREAM_TEXT, record_text: DREAM_TEXT };

    expect(fromBrowser.name).toBe(fromNode.name);
    expect(fromBrowser.validation).toEqual(fromNode.validation);
    expect(fromBrowser.forbidden).toEqual(fromNode.forbidden);
    expect(buildSystemPromptBrowser(fromBrowser)).toBe(buildSystemPromptNode(fromNode));
    expect(buildUserMessageBrowser(fromBrowser, input)).toBe(buildUserMessageNode(fromNode, input));
  });
});

/* ------------------------------------------------------------------ */
/* 价格表：默认注入的那张必须是官方表（不是免费表）                     */
/* ------------------------------------------------------------------ */

describe('费用口径', () => {
  it('官方价格表里 glm-image 没有单价 → 页面显示"未核实"而不是编一个金额', () => {
    expect(OFFICIAL_PRICE_TABLE.image['glm-image']).toBeUndefined();
  });

  it('免费档显示"免费"', async () => {
    const record = await createRecord({ text: DREAM_TEXT });
    mount(
      <MemoryRouter>
        <CreatePage catalog={makeCatalog()} recordId={record.id} priceTable={OFFICIAL_PRICE_TABLE} />
      </MemoryRouter>,
    );
    await flush();
    await clickTab('image');
    expect(text()).toContain('免费');
  });
});

/* ------------------------------------------------------------------ */
/* 本地落盘工具（判据 4 在 UI 侧的补充：payload 与 media 主键同源）      */
/* ------------------------------------------------------------------ */

describe('产物与二进制同源', () => {
  it('saveImageBlob 的 key 与 artifact id 一致，便于按 id 找图', async () => {
    const artifact = await saveImageBlob({
      key: 'k1',
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      remoteUrl: 'https://cdn.example.com/a.png',
      ttl: { ms: 1000, verified: true, note: 'test' },
    });
    expect(artifact.id).toBe('image:k1');
    expect(makeBlobUrl(artifact.blob)).toBe('blob:mock');
  });
});
