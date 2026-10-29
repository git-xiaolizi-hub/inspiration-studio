import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIConfigPanel } from './AIConfigPanel';
import type { AIConfigPanelDeps } from './AIConfigPanel';
import { OnboardingPanel } from '../components/OnboardingPanel';
import { ModelGuidePanel } from '../model-guide/ModelGuidePanel';
import { GUIDE_VENDOR_INTROS } from '../../adapters/ai-models/model-guide';
import { AIErrorCode } from '../../adapters/ai-models/types';
import { makeError } from '../../adapters/ai-models/errors';
import { NON_OPENAI_LIST_MESSAGE } from '../../adapters/ai-models/client';
import type { HttpDiagnostics, ProbeResult, ProviderInput } from '../../adapters/ai-models/client';
import { closeDatabase, deleteRecord, destroyDatabase, putSetting } from '../../core/storage';
import { loadCatalog, pickModel } from '../../adapters/ai-models/catalog';
import type { AICatalog } from '../../adapters/ai-models/catalog';

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

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')) as HTMLButtonElement[];
}

function findButton(label: string): HTMLButtonElement {
  const found = buttons().find((button) => (button.textContent ?? '').includes(label));
  if (!found) {
    throw new Error(
      `找不到按钮：${label}（当前按钮：${buttons()
        .map((button) => button.textContent)
        .join(' / ')}）`,
    );
  }
  return found;
}

function hasButton(label: string): boolean {
  return buttons().some((button) => (button.textContent ?? '').includes(label));
}

function byLabel(label: string): HTMLElement | null {
  return container.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
}

function input(label: string): HTMLInputElement {
  const found = container.querySelector(`input[aria-label="${label}"]`);
  if (!found) throw new Error(`找不到输入框：${label}`);
  return found as HTMLInputElement;
}

function checkbox(label: string): HTMLInputElement {
  const found = container.querySelector(`input[type="checkbox"][aria-label="${label}"]`);
  if (!found) throw new Error(`找不到勾选框：${label}`);
  return found as HTMLInputElement;
}

function selectByLabel(label: string): HTMLSelectElement {
  const found = container.querySelector(`select[aria-label="${label}"]`);
  if (!found) throw new Error(`找不到下拉框：${label}`);
  return found as HTMLSelectElement;
}

/** React 受控输入：必须走原生 setter 再派发事件，直接改 value 不会触发 onChange */
function setValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function setField(label: string, value: string): Promise<void> {
  await act(async () => {
    setValue(input(label), value);
    await flush();
  });
}

async function setSelect(label: string, value: string): Promise<void> {
  await act(async () => {
    setValue(selectByLabel(label), value);
    await flush();
    await flush();
  });
}

function modelRows(): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-model-row]')) as HTMLElement[];
}

/** 连接表的行（0 条连接时只有一行 draft） */
function connectionRows(): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-connection-row]')) as HTMLElement[];
}

function activeConnectionIndex(): number {
  return connectionRows().findIndex((row) => row.getAttribute('data-active') === 'yes');
}

const okProbe = (): ProbeResult => ({
  ok: true,
  url: 'http://127.0.0.1:9/v1/chat/completions',
  status: 200,
  elapsedMs: 12,
  content: '',
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

const failureDiagnostics = (overrides: Partial<HttpDiagnostics> = {}): HttpDiagnostics => ({
  method: 'POST',
  url: 'https://relay.example.com/v1/chat/completions',
  status: 0,
  elapsedMs: 5001,
  errorName: 'TypeError',
  bodyPreview: '',
  attemptedUrls: ['https://relay.example.com/v1/chat/completions'],
  ...overrides,
});

function failProbe(
  code: AIErrorCode,
  message: string,
  diagnostics?: HttpDiagnostics,
): ProbeResult {
  return {
    ok: false,
    url: 'https://relay.example.com/v1/chat/completions',
    status: 401,
    elapsedMs: 5,
    error: makeError(code, message),
    diagnostics: diagnostics ?? failureDiagnostics({ status: 401 }),
  };
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
  vi.unstubAllGlobals();
  await closeDatabase();
});

async function mountPanel(deps: AIConfigPanelDeps = {}): Promise<void> {
  await mount(<AIConfigPanel deps={deps} />);
  await waitFor(() => Boolean(container.querySelector('[data-testid="ai-config-page"]')), '配置页渲染');
  // 等配置从 IndexedDB 读回来（按钮在 loaded 之前是 disabled）：否则预设/拉列表的结果会被覆盖
  await waitFor(() => findButton('保存配置').disabled === false, '配置读取完成');
}

function unmountPanel(): void {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
}

/* ------------------------------------------------------------------ */
/* M3R4 §1 整页只有 6 块，顺序固定                                       */
/* ------------------------------------------------------------------ */

describe('M3R4 §1 配置页结构：6 块，顺序固定', () => {
  it('从上到下恰好是 厂商 → 连接表 → 操作行 → 预设标签 → 已选模型表 → 保存', async () => {
    await mountPanel();
    const blocks = Array.from(container.querySelectorAll('[data-block]')).map(
      (element) => element.getAttribute('data-block'),
    );
    expect(blocks).toEqual(['vendor', 'connections', 'actions', 'tags', 'models', 'save']);
  });

  it('操作行与连接表在同一块里（拉取模型列表不需要滚到第二页）', async () => {
    await mountPanel();
    const connections = container.querySelector('[data-block="connections"]');
    expect(connections?.querySelector('[data-block="actions"]')).not.toBeNull();
    expect(connections?.querySelector('table.connection-table')).not.toBeNull();
    // 连接表头就是 §1.1 的 6 列
    const headers = Array.from(connections?.querySelectorAll('th') ?? []).map(
      (th) => th.textContent ?? '',
    );
    expect(headers).toEqual(['当前', '协议', 'base_url', 'API Key', '备注', '计费方式', '删除']);
  });
});

/* ------------------------------------------------------------------ */
/* §1.1 连接表：一行 = 一条连接                                          */
/* ------------------------------------------------------------------ */

describe('§1 连接表：一条连接一行，行内 6 个控件', () => {
  it('一个厂商下两行连接，各自的 base_url 与 key 互不串；改哪行哪行成为当前连接', async () => {
    await mountPanel();

    await setField('服务地址 1', 'https://one.example.com/v4');
    await setField('API Key 1', 'key-one');

    await click(findButton('＋ 新建连接'));
    expect(connectionRows()).toHaveLength(2);
    await setField('连接备注 2', '分组二');
    await setField('服务地址 2', 'https://two.example.com/v4');
    await setField('API Key 2', 'key-two');

    // 第 1 行的值没被第 2 行覆盖
    expect(input('服务地址 1').value).toBe('https://one.example.com/v4');
    expect(input('API Key 1').value).toBe('key-one');
    expect(input('服务地址 2').value).toBe('https://two.example.com/v4');
    expect(input('API Key 2').value).toBe('key-two');

    // 最后编辑的是第 2 行 → 它是当前连接
    expect(activeConnectionIndex()).toBe(1);

    // 点第 1 行的「当前连接」radio → 切回去，两行的值仍然各归各位
    await click(byLabel('当前连接 1') as HTMLElement);
    expect(activeConnectionIndex()).toBe(0);
    expect(input('服务地址 1').value).toBe('https://one.example.com/v4');
    expect(input('API Key 2').value).toBe('key-two');

    // 删到 0 条：回到「第 1 条连接」空行，页面不崩（M3R3 §1.5 不退化）
    await click(byLabel('删除连接 1') as HTMLElement);
    await click(byLabel('删除连接 1') as HTMLElement);
    expect(connectionRows()).toHaveLength(1);
    expect(connectionRows()[0].getAttribute('data-connection-row')).toBe('draft');
    expect(text()).toContain('这里填的就是这家厂商的第一条连接');
    expect(text()).not.toContain('还没有连接');
    expect(input('服务地址 1').value).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* M3R4 §5 判据 3：三条不同协议的连接                                    */
/* ------------------------------------------------------------------ */

describe('M3R4 §4.1 连接表能同时挂三种协议', () => {
  it('openai / anthropic / responses 三条互不干扰，保存后协议原样落库', async () => {
    await mountPanel();

    await setField('服务地址 1', 'https://a.example.com/v1');
    await setSelect('协议 1', 'openai');

    await click(findButton('＋ 新建连接'));
    await setField('服务地址 2', 'https://b.example.com');
    await setSelect('协议 2', 'anthropic');

    await click(findButton('＋ 新建连接'));
    await setField('服务地址 3', 'https://c.example.com');
    await setSelect('协议 3', 'responses');

    expect(connectionRows()).toHaveLength(3);
    expect(selectByLabel('协议 1').value).toBe('openai');
    expect(selectByLabel('协议 2').value).toBe('anthropic');
    expect(selectByLabel('协议 3').value).toBe('responses');

    // responses 选项必须带「实验性·未验证」
    const responsesOption = Array.from(selectByLabel('协议 1').options).find(
      (option) => option.value === 'responses',
    );
    // M3R6 §4：可见文字只留协议名，端点后缀进 title
    expect(responsesOption?.textContent).toBe('Responses（实验性）');
    expect(selectByLabel('协议 1').title).toContain('/chat/completions');

    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '保存三种协议');

    const saved = await loadCatalog();
    const provider = saved.providers[0];
    expect(provider.connections.map((item) => item.protocol)).toEqual([
      'openai',
      'anthropic',
      'responses',
    ]);
    expect(provider.connections.map((item) => item.baseUrl)).toEqual([
      'https://a.example.com/v1',
      'https://b.example.com',
      'https://c.example.com',
    ]);
  });

  it('当前连接的协议会传进连通性自检（responses → protocol: "responses"）', async () => {
    const selfTest = vi.fn(async (input: ProviderInput) => {
      void input;
      return okProbe();
    });
    await mountPanel({ selfTest });

    await setField('服务地址 1', 'https://c.example.com');
    await setSelect('协议 1', 'responses');
    await click(findButton('测试连通'));

    expect(selfTest).toHaveBeenCalledTimes(1);
    const passed = selfTest.mock.calls[0][0] as ProviderInput;
    expect(passed.protocol).toBe('responses');
    expect(passed.baseUrl).toBe('https://c.example.com');
  });
});

/* ------------------------------------------------------------------ */
/* M3R3 §1：表单即连接（0 条连接时也存得下去）                          */
/* ------------------------------------------------------------------ */

function connectionRowIds(): string[] {
  return connectionRows()
    .map((row) => row.getAttribute('data-connection-row') ?? '')
    .filter((value) => value !== '' && value !== 'draft');
}

describe('M3R3 §1 表单即连接：不点「新建连接」也存得下', () => {
  it('选厂商 → 只填 base_url 与 Key → 保存 → 重载后配置仍在（承接方卡住的真实路径）', async () => {
    await mountPanel();
    await click(findButton('DeepSeek'));
    // M3R9 §5：点厂商 chip 就把连接建出来（地址已按 VENDOR_META 填好），用户只剩填 Key 一件事
    expect(connectionRowIds()).toHaveLength(1);
    expect(input('服务地址 1').value).toBe('https://api.deepseek.com');

    // 关键：**全程不点「＋ 新建连接」**
    await setField('服务地址 1', 'https://api.deepseek.com');
    await setField('API Key 1', 'key-deepseek-test');

    // 表格里立刻就有这条连接（还没点保存就已经生效）
    expect(connectionRowIds()).toHaveLength(1);
    expect(connectionRows()[0].getAttribute('data-active')).toBe('yes');
    expect(text()).not.toContain('还没有连接');

    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '保存成功');

    const saved = await loadCatalog();
    const deepseek = saved.providers.find((provider) => provider.id === 'deepseek');
    expect(deepseek?.connections).toHaveLength(1);
    expect(deepseek?.connections[0].baseUrl).toBe('https://api.deepseek.com');
    expect(deepseek?.connections[0].apiKey).toBe('key-deepseek-test');

    // 重载页面：承接方就是在这里发现「填的东西没了」
    unmountPanel();
    await mountPanel();
    await click(findButton('DeepSeek'));
    expect(input('服务地址 1').value).toBe('https://api.deepseek.com');
    expect(input('API Key 1').value).toBe('key-deepseek-test');
    expect(connectionRowIds()).toHaveLength(1);
  });

  it('0 条连接时改「连接备注」也能建出连接（不只 base_url / key 能触发）', async () => {
    await mountPanel();
    expect(connectionRowIds()).toHaveLength(0);

    await setField('连接备注 1', '我的智谱');

    expect(connectionRowIds()).toHaveLength(1);
    expect(input('连接备注 1').value).toBe('我的智谱');
    // 新建的那条会带出厂商默认地址，避免用户还要再填一次
    expect(input('服务地址 1').value).toBe('https://open.bigmodel.cn/api/paas/v4');
  });

  it('点「＋ 新建连接」得到第 2、3 行，三行互不覆盖', async () => {
    await mountPanel();
    await setField('服务地址 1', 'https://one.example.com');
    await setField('API Key 1', 'key-one');

    await click(findButton('＋ 新建连接'));
    await setField('服务地址 2', 'https://two.example.com');
    await setField('API Key 2', 'key-two');

    await click(findButton('＋ 新建连接'));
    await setField('服务地址 3', 'https://three.example.com');
    await setField('API Key 3', 'key-three');

    expect(connectionRows()).toHaveLength(3);
    expect([1, 2, 3].map((index) => input(`服务地址 ${index}`).value)).toEqual([
      'https://one.example.com',
      'https://two.example.com',
      'https://three.example.com',
    ]);
    expect([1, 2, 3].map((index) => input(`API Key ${index}`).value)).toEqual([
      'key-one',
      'key-two',
      'key-three',
    ]);
  });

  it('删到最后一条后回到「第 1 条连接」空态；再填字段能重新建出来（旧 Key 不残留）', async () => {
    await mountPanel();
    await setField('服务地址 1', 'https://solo.example.com');
    await setField('API Key 1', 'key-solo');
    expect(connectionRowIds()).toHaveLength(1);

    await click(byLabel('删除连接 1') as HTMLElement);
    expect(connectionRowIds()).toHaveLength(0);
    expect(input('服务地址 1').value).toBe('');
    expect(input('API Key 1').value).toBe('');
    expect(text()).toContain('这里填的就是这家厂商的第一条连接');

    // 0 条连接时保存也不能失败（「没建连接」不是保存失败的理由）
    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '0 条连接也能保存');

    await setField('服务地址 1', 'https://again.example.com');
    expect(connectionRowIds()).toHaveLength(1);
    expect(input('服务地址 1').value).toBe('https://again.example.com');
    expect(input('API Key 1').value).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* §8-2 切厂商 → 自动带出 activeConnection 与默认模型                    */
/* ------------------------------------------------------------------ */

describe('§1.3 切厂商自动带出连接与模型', () => {
  it('配好的连接与默认模型在切走再切回后自动恢复', async () => {
    await mountPanel();

    await click(findButton('DeepSeek'));
    await setField('服务地址 1', 'https://api.deepseek.com/v1');
    await setField('API Key 1', 'key-deepseek');
    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '第一次保存');

    // 切到智谱：没有配过的连接 → M3R9 §5 立刻按 VENDOR_META 建一条（地址已就位、Key 空）
    await click(findButton('智谱'));
    expect(input('服务地址 1').value).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(input('API Key 1').value).toBe('');

    // 切回 DeepSeek：连接与默认模型都自动带出
    await click(findButton('DeepSeek'));
    expect(input('服务地址 1').value).toBe('https://api.deepseek.com/v1');
    expect(input('API Key 1').value).toBe('key-deepseek');
    expect(input('请求模型 1').value).toBe('deepseek-flash');
    // M3R6：模型行不再有单选，第一列是「启用」复选框（默认勾上）
    expect(checkbox('启用 1').checked).toBe(true);
    expect(container.querySelector('input[type="radio"][aria-label^="选择模型"]')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* §8-3 预设标签：补 modelId/caps/note，不覆盖 base_url                  */
/* ------------------------------------------------------------------ */

describe('§2 预设标签', () => {
  it('点「cogview-3-flash（生图，免费测试）」→ 新行带 modelId + 生图标签 + 备注，且不动已填的 base_url', async () => {
    await mountPanel();
    await setField('服务地址 1', 'https://my-relay.example.com/v4');

    expect(modelRows()).toHaveLength(1);
    await click(findButton('cogview-3-flash（生图，免费测试）'));
    await waitFor(() => modelRows().length === 2, '标签加了一行模型');

    expect(input('服务地址 1').value).toBe('https://my-relay.example.com/v4');
    expect(input('显示名 2').value).toBe('cogview-3-flash（生图，免费测试）');
    expect(input('请求模型 2').value).toBe('cogview-3-flash');
    expect(checkbox('能力 生图 2').checked).toBe(true);
    expect(checkbox('能力 文本 2').checked).toBe(false);
    expect(text()).toContain('备注：免费测试');
  });

  it('标签按厂商分别显示：火山方舟有 seedance，OpenAI 没有厂商标签但标注「国内需中转」', async () => {
    await mountPanel();
    await click(findButton('火山方舟'));
    expect(hasButton('doubao-seedance-2-5-260628（视频，推荐）')).toBe(true);

    await click(findButton('OpenAI'));
    expect(hasButton('doubao-seedance-2-5-260628（视频，推荐）')).toBe(false);
    expect(text()).toContain('国内需中转');
  });
});

/* ------------------------------------------------------------------ */
/* §8-4 模型表增删；删到 0 行不崩                                        */
/* ------------------------------------------------------------------ */

describe('§2 已选模型表增删', () => {
  it('「＋ 手动添加」加一行，删到 0 行时显示空态且仍能保存', async () => {
    await mountPanel();
    // M3R6：模型表在连接里 —— 还没连接 = 还没有模型表
    expect(modelRows()).toHaveLength(0);

    // 点「手动添加」会先把第 1 条连接建出来（预填厂商默认模型）+ 一行空白
    await click(findButton('＋ 手动添加'));
    expect(modelRows()).toHaveLength(2);
    await setField('上下文窗口 2', '128000');
    expect(input('上下文窗口 2').value).toBe('128000');

    for (let index = 0; index < 2; index += 1) {
      const deleteButtons = Array.from(
        container.querySelectorAll('button[aria-label^="删除模型"]'),
      ) as HTMLButtonElement[];
      await click(deleteButtons[0]);
    }

    expect(modelRows()).toHaveLength(0);
    expect(text()).toContain('填完上面的服务地址与 Key 后会自动带出默认模型');
    // 页面没崩：空模型表也能保存
    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '空模型表也能保存');
  });

  it('模型表 6 列：启用 | 菜单名 | 实际模型 | 上下文 | 能力 | 删除（第一列不是单选）', async () => {
    await mountPanel();
    // 模型表在连接里：先填地址把第 1 条连接建出来（会预填厂商默认模型）
    await setField('服务地址 1', 'https://relay.example.com');
    const modelTable = container.querySelector(
      '[data-block="models"] table.model-table',
    ) as HTMLTableElement | null;
    expect(modelTable).not.toBeNull();
    expect(Array.from(modelTable?.querySelectorAll('th') ?? []).map((th) => th.textContent ?? '')).toEqual([
      '启用',
      '菜单显示名',
      '实际请求模型',
      '上下文窗口',
      '能力标签',
      '删除',
    ]);
    expect(container.querySelector('input[aria-label="启用 1"]')).not.toBeNull();
    expect(container.querySelector('input[type="radio"][aria-label^="选择模型"]')).toBeNull();
  });

  it('能力勾选列 5 个：文本 / 视觉 / 生图 / 视频 / 音频（R7a 加了 audio）', async () => {
    await mountPanel();
    await setField('服务地址 1', 'https://relay.example.com');

    const row = modelRows()[0];
    expect(row).toBeDefined();
    const chips = Array.from(row.querySelectorAll('input[aria-label^="能力 "]')).map(
      (input) => (input as HTMLInputElement).getAttribute('aria-label') ?? '',
    );
    expect(chips).toEqual(['能力 文本 1', '能力 视觉 1', '能力 生图 1', '能力 视频 1', '能力 音频 1']);
    // 音频默认不勾（没凭名字猜能力）
    const audio = row.querySelector('input[aria-label="能力 音频 1"]') as HTMLInputElement | null;
    expect(audio?.checked).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* §8-5 404 拉列表：info 样式 + 不写「连不上服务器」+ 保存仍成功          */
/* ------------------------------------------------------------------ */

describe('§6 拉列表 404 是「这家没有列表接口」，不是网络错误', () => {
  it('info 样式 + 指定文案 + 技术细节齐全，且保存仍然成功', async () => {
    const diagnostics = failureDiagnostics({
      method: 'GET',
      url: 'https://ark.cn-beijing.volces.com/api/v3/models',
      status: 404,
      elapsedMs: 123,
      errorName: '-',
      bodyPreview: '{"error":{"message":"not found"}}',
    });

    await mountPanel({
      listModels: async () => ({
        ok: false,
        models: [],
        url: diagnostics.url,
        error: makeError(
          AIErrorCode.MODELS_NOT_LISTED,
          'HTTP 404（没有模型列表接口）',
          {
            userMessage:
              '这家没有模型列表接口（火山方舟就是这样），请用上面的预设标签选模型 —— 不影响保存和使用。拉取失败也可以手填模型名',
          },
        ),
        diagnostics,
      }),
    });

    await click(findButton('火山方舟'));
    await click(findButton('＋ 新建连接'));
    await click(findButton('拉取模型列表'));
    await waitFor(() => text().includes('没有模型列表接口'), '404 info 文案');

    const info = container.querySelector('[data-kind="info"]');
    expect(info).not.toBeNull();
    expect(info?.className).toContain('notice-info');
    // 不是红色错误
    expect(container.querySelector('[data-kind="error"]')).toBeNull();
    expect(text()).not.toContain('连不上服务器');
    expect(text()).toContain('不影响保存和使用');

    // 技术细节：METHOD URL / 状态 / 耗时 / error.name / 响应前 200 字
    expect(text()).toContain('GET https://ark.cn-beijing.volces.com/api/v3/models');
    expect(text()).toContain('HTTP 状态');
    expect(text()).toContain('404');
    expect(text()).toContain('123 ms');
    expect(text()).toContain('error.name');
    expect(text()).toContain('响应前 200 字');
    expect(text()).toContain('not found');

    // 拉列表失败不得阻止保存
    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '404 之后仍可保存');
    const saved = await loadCatalog();
    const ark = saved.providers.find((provider) => provider.id === 'ark');
    expect(ark?.connections[0].baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(ark?.connections[0].models[0].modelId).toBe('doubao-seed-2-1-pro-260628');
  });
});

/* ------------------------------------------------------------------ */
/* §8-6 401 / 超时 / 非 OpenAI 格式：三类各说各的话                     */
/* ------------------------------------------------------------------ */

describe('§6 五类失败拆开（不再一律「连不上服务器」）', () => {
  it('401 → 「API Key 无效或无权限」+ 到控制台确认；状态码只在技术细节里', async () => {
    await mountPanel({
      selfTest: async () => failProbe(AIErrorCode.UNAUTHORIZED, 'HTTP 401：invalid key'),
    });
    // M3R9 §1：自检要有「可用的文本模型」才会发同步请求 —— 点厂商 chip 即建出连接与默认模型
    await click(findButton('智谱'));
    await click(findButton('测试连通'));
    await waitFor(() => text().includes('API Key 无效或无权限'), '401 人话');

    const error = container.querySelector('[data-kind="error"]');
    expect(error?.querySelector('p')?.textContent).toContain('API Key 无效或无权限');
    expect(error?.querySelector('p')?.textContent).toContain('控制台');
    expect(error?.querySelector('p')?.textContent).not.toContain('HTTP 401');
    expect(error?.querySelector('details')?.textContent).toContain('HTTP 401');
  });

  it('超时 → 「连不上服务器（连接超时）」+ 检查网络/代理 + 是否漏写 https://', async () => {
    await mountPanel({
      selfTest: async () =>
        failProbe(
          AIErrorCode.TIMEOUT,
          '请求超时（AbortController 触发）',
          failureDiagnostics({ status: 0, errorName: 'AbortError', elapsedMs: 15000 }),
        ),
    });
    await click(findButton('智谱'));
    await click(findButton('测试连通'));
    await waitFor(() => text().includes('连不上服务器（连接超时）'), '超时人话');

    const error = container.querySelector('[data-kind="error"]');
    const message = error?.querySelector('p')?.textContent ?? '';
    expect(message).toContain('检查网络与代理');
    expect(message).toContain('漏写 https://');
    // error.name 必须在技术细节里（这是排查「超时 vs 被拒」的关键）
    expect(error?.querySelector('details')?.textContent).toContain('AbortError');
    expect(error?.querySelector('details')?.textContent).toContain('15000 ms');
  });

  it('200 但没有 data[] → 「接口返回的不是 OpenAI 格式」', async () => {
    await mountPanel({
      listModels: async () => ({
        ok: false,
        models: [],
        url: 'https://relay.example.com/v1/models',
        error: makeError(AIErrorCode.INVALID_RESPONSE, '响应里没有模型列表', {
          userMessage: NON_OPENAI_LIST_MESSAGE,
        }),
        diagnostics: failureDiagnostics({ method: 'GET', status: 200, errorName: '-' }),
      }),
    });
    await click(findButton('拉取模型列表'));
    await waitFor(() => text().includes('接口返回的不是 OpenAI 格式'), '非 OpenAI 格式文案');

    expect(container.querySelector('[data-kind="error"]')).not.toBeNull();
    expect(container.querySelector('[data-kind="info"]')).toBeNull();
    expect(text()).toContain('请用预设标签或手填');
  });

  it('1210 → 提示「此模型不支持图片输入」并给出可换的模型（M3 断言原样保留）', async () => {
    await mountPanel({
      selfTest: async () => failProbe(AIErrorCode.IMAGE_NOT_SUPPORTED, 'code 1210'),
    });
    await click(findButton('智谱'));
    await click(findButton('测试连通'));
    await waitFor(() => text().includes('此模型不支持图片输入'), '1210 人话提示');

    expect(text()).toContain('deepseek-flash');
    expect(text()).toContain('claude 全系');
  });

  it('1214 → 提示图片格式错（与 1210 是两句不同的话，M3 断言原样保留）', async () => {
    await mountPanel({
      selfTest: async () => failProbe(AIErrorCode.INVALID_IMAGE_FORMAT, 'code 1214'),
    });
    await click(findButton('智谱'));
    await click(findButton('测试连通'));
    await waitFor(() => text().includes('图片格式不被接受'), '1214 人话提示');
    expect(text()).not.toContain('此模型不支持图片输入');
  });

  it('成功：显示实际命中的地址与耗时（用户能看到 /v1 拼得对不对）', async () => {
    await mountPanel({ selfTest: async () => okProbe() });
    await click(findButton('智谱'));
    await click(findButton('测试连通'));
    await waitFor(() => text().includes('连通正常'), '成功提示');
    expect(text()).toContain('/v1/chat/completions');
    expect(text()).toContain('HTTP 200');
    // §1-④：结果里必须写清「用的是哪个模型测的」——智谱这条连接的默认模型
    expect(text()).toContain('用 glm-5.3-flash 测试');
    expect(container.querySelector('[data-kind="error"]')).toBeNull();
  });

  it('拉列表成功 → 选择即把模型加入模型表', async () => {
    await mountPanel({
      listModels: async () => ({
        ok: true,
        models: ['deepseek-chat', 'deepseek-reasoner'],
        url: 'https://api.deepseek.com/v1/models',
        diagnostics: failureDiagnostics({ method: 'GET', status: 200, errorName: '-' }),
      }),
    });
    await click(findButton('DeepSeek'));
    await click(findButton('拉取模型列表'));
    await waitFor(() => Boolean(container.querySelector('select[aria-label="站上拉到的模型"]')), '下拉出现');

    await setSelect('站上拉到的模型', 'deepseek-reasoner');
    await waitFor(() => modelRows().length === 2, '加入模型表');
    expect(input('请求模型 2').value).toBe('deepseek-reasoner');
    expect(text()).toContain('从站上拉取');
  });
});

/* ------------------------------------------------------------------ */
/* §8-8 自定义厂商：新建 → 复用                                          */
/* ------------------------------------------------------------------ */

describe('§3 自定义厂商', () => {
  it('新建后可直接用；保存再重载，切回该厂商不必重填 base_url', async () => {
    await mountPanel();
    await click(findButton('＋ 自定义'));
    await setField('新厂商名称', '灵绘 gpt 组');
    await setField('新厂商地址', 'https://linghui.example.com');
    await setField('新厂商备注', 'gpt 组');
    await click(findButton('保存新厂商'));

    expect(hasButton('灵绘 gpt 组')).toBe(true);
    // 选中新厂商后地址自动带出（不用反复填）
    expect(input('服务地址 1').value).toBe('https://linghui.example.com');
    expect(input('连接备注 1').value).toBe('gpt 组');
    expect(input('请求模型 1').value).toBe('claude-opus-5-5');

    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '保存自定义厂商');

    const saved: AICatalog = await loadCatalog();
    expect(saved.providers.some((provider) => provider.name === '灵绘 gpt 组')).toBe(true);

    // 重载后再切回来：base_url 仍在（复用，不重填）
    unmountPanel();
    await mountPanel();
    await click(findButton('灵绘 gpt 组'));
    expect(input('服务地址 1').value).toBe('https://linghui.example.com');
    expect(input('API Key 1').value).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* M3R4 §3 三块已从配置页删掉（判据 1）                                  */
/* ------------------------------------------------------------------ */

describe('M3R4 §3 配置页不再有费用预估 / 能力汇总 / 价格展示', () => {
  it('四个禁止出现的字符串一个都不在：生成前费用预估 / 当前可用能力 / 元/百万 token / 保存价格表', async () => {
    await mountPanel();
    const body = text();
    expect(body).not.toContain('生成前费用预估');
    expect(body).not.toContain('当前可用能力');
    expect(body).not.toContain('元/百万 token');
    expect(body).not.toContain('保存价格表');
  });

  it('预估与价格块整块下线：没有金额、没有价格行、没有能力体检', async () => {
    await mountPanel();
    const body = text();
    // 45.36 / 20.18 / 40.24 这些算例属于视频页与 pricing.ts，不在这里
    expect(body).not.toContain('¥45.36');
    expect(body).not.toContain('（估算）');
    expect(container.querySelector('[data-price-for]')).toBeNull();
    expect(container.querySelector('[data-cap]')).toBeNull();
    expect(container.querySelector('select[aria-label="输出分辨率"]')).toBeNull();
    expect(container.querySelector('input[aria-label="预算上限"]')).toBeNull();
  });

  it('顶部有「了解如何选择厂商与模型？」链接指向 /model-guide', async () => {
    await mountPanel();
    const link = container.querySelector('a[href="#/model-guide"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('了解如何选择厂商与模型？');
  });

  it('三套专用面板已删除：页面上没有「文本模型 / 图片模型 / 视频模型」三个独立配置区', async () => {
    await mountPanel();
    expect(text()).not.toContain('文本模型 / 图片模型 / 视频模型');
    expect(hasButton('免费试跑')).toBe(false);
    // 免费模型只作为智谱下的预设标签存在
    expect(hasButton('cogvideox-flash（视频，免费测试，拥堵）')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* M3R4 §4.2 倍率：填 0.35 存得住，-1 被拒（判据 5）                     */
/* ------------------------------------------------------------------ */

describe('M3R4 §4.2 倍率列：0.35 可持久化，-1 被本地拒绝', () => {
  it('填 0.35 → 保存 → 重载后仍是 0.35', async () => {
    await mountPanel();
    await setField('服务地址 1', 'https://relay.example.com');
    expect(input('倍率 1').value).toBe('1');

    await setField('倍率 1', '0.35');
    expect(input('倍率 1').value).toBe('0.35');

    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '保存倍率');

    const saved = await loadCatalog();
    expect(saved.providers[0].connections[0].multiplier).toBe(0.35);

    unmountPanel();
    await mountPanel();
    expect(input('倍率 1').value).toBe('0.35');
    expect(input('服务地址 1').value).toBe('https://relay.example.com');
  });

  it('填 -1 → 给「倍率要填一个 ≥ 0 的数字」提示，输入保留但不写库；NaN 同样被拒', async () => {
    await mountPanel();
    await setField('服务地址 1', 'https://relay.example.com');
    await setField('倍率 1', '0.35');
    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '先存一个合法值');

    await setField('倍率 1', '-1');
    await waitFor(() => text().includes('倍率要填一个'), '负数被拒并提示');
    // 框里留着用户敲的字（否则会以为「怎么又变回 1 了」）
    expect(input('倍率 1').value).toBe('-1');

    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '被拒之后仍可保存其它字段');
    const saved = await loadCatalog();
    expect(saved.providers[0].connections[0].multiplier).toBe(0.35);

    await setField('倍率 1', '-0.5');
    await waitFor(() => text().includes('倍率要填一个'), '负数（小数）也被拒');
    expect((await loadCatalog()).providers[0].connections[0].multiplier).toBe(0.35);
  });

  it('计费方式列有说明（官方价 × 倍率 = 实付估算）', async () => {
    await mountPanel();
    const multiplierInput = input('倍率 1');
    expect(multiplierInput.getAttribute('title') ?? '').toContain('官方价 × 倍率');
  });
});

/* ------------------------------------------------------------------ */
/* M5a：配置页不再有第二套导出（备份统一到「设置 → 数据与备份」）          */
/* ------------------------------------------------------------------ */

describe('M5a 备份统一：配置页不再有导出/导入', () => {
  it('判据 5 回归：找不到「导出配置 JSON」按钮，也没有「更多：导出 / 导入」折叠块', async () => {
    await mountPanel();
    const labels = Array.from(container.querySelectorAll('button, summary, a')).map(
      (item) => item.textContent ?? '',
    );
    expect(labels.some((label) => label.includes('导出配置 JSON'))).toBe(false);
    expect(labels.some((label) => label.includes('导入配置文件'))).toBe(false);
    expect(labels.some((label) => label.includes('更多：导出 / 导入'))).toBe(false);
    expect(container.querySelector('input[type="file"]')).toBeNull();
    // 保存按钮还在（删的是导出，不是整个底部）
    expect(findButton('保存配置')).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* 引导页 C 项（§4.1）：探测到模型即可选 —— M3/M2.5 既有断言原样保留       */
/* ------------------------------------------------------------------ */

describe('引导页 C 项（§4.1）：探测到模型即可选', () => {
  it('探测到 base 模型 → C 项可点、文案为「使用本地模型（base，78MB，随应用发布）」', async () => {
    const onChosen = vi.fn();
    await mount(
      <OnboardingPanel
        onChosen={onChosen}
        asrProbe={{ detect: async () => ({ id: 'whisper-base', label: 'base', sizeMB: 78 }) }}
      />,
    );

    await waitFor(() => {
      const button = Array.from(container.querySelectorAll('button')).find((item) =>
        (item.textContent ?? '').includes('使用本地模型'),
      );
      return Boolean(button) && button?.disabled === false;
    }, 'C 项点亮');

    const localOption = Array.from(container.querySelectorAll('button')).find((item) =>
      (item.textContent ?? '').includes('使用本地模型'),
    ) as HTMLButtonElement;
    expect(localOption.textContent).toContain('使用本地模型（base，78MB，随应用发布）');
    expect(text()).not.toContain('暂不可选');

    await click(localOption);
    expect(onChosen).toHaveBeenCalledWith('local-whisper');
  });

  it('探测不到模型 → 灰置，并说明模型随应用发布 + 来源 ModelScope', async () => {
    await mount(<OnboardingPanel onChosen={() => undefined} asrProbe={{ detect: async () => null }} />);
    await waitFor(() => text().includes('未检测到本地模型'), '未检测到提示');

    const localOption = Array.from(container.querySelectorAll('button')).find((item) =>
      (item.textContent ?? '').includes('使用本地模型'),
    ) as HTMLButtonElement;
    expect(localOption.disabled).toBe(true);
    expect(text()).toContain('ModelScope');
  });
});

/* ------------------------------------------------------------------ */
/* M3R2：厂商顺序 / 中转标记 / 10 个新标签 / 本地部署 / 文案与推广链接    */
/* ------------------------------------------------------------------ */

function tabs(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button[role="tab"]')) as HTMLButtonElement[];
}

/** M3R4 §2：本地部署前移到灵绘之前 */
const VENDOR_TAB_LABELS = [
  '智谱',
  'DeepSeek',
  '火山方舟（豆包）',
  '月之暗面 / Kimi',
  '阿里百炼 / 千问',
  'MiniMax',
  'Anthropic',
  'OpenAI',
  'Google / Gemini',
  '本地部署',
  '灵绘（中转）',
];

const NEW_MODEL_TAGS: Array<{ tab: string; tag: string; modelId: string; cap: string }> = [
  { tab: '智谱', tag: 'glm-image（旗舰生图，推荐英文提示词）', modelId: 'glm-image', cap: '生图' },
  { tab: '智谱', tag: 'cogview-4（生图，中文支持更好）', modelId: 'cogview-4', cap: '生图' },
  { tab: '智谱', tag: 'cogvideox-3（旗舰视频）', modelId: 'cogvideox-3', cap: '视频' },
  { tab: '月之暗面 / Kimi', tag: 'kimi-k3.1-pro（文本+视觉，1M 上下文）', modelId: 'kimi-k3.1-pro', cap: '视觉' },
  { tab: '灵绘（中转）', tag: 'claude-opus-5-5（文本+视觉，推荐）', modelId: 'claude-opus-5-5', cap: '视觉' },
  { tab: '灵绘（中转）', tag: 'gpt-6.1-sol（文本+视觉，推荐）', modelId: 'gpt-6.1-sol', cap: '视觉' },
  { tab: '灵绘（中转）', tag: 'gpt-image-2.5-flare（生图，快）', modelId: 'gpt-image-2.5-flare', cap: '生图' },
  {
    tab: '灵绘（中转）',
    tag: 'gemini-4-argon（文本+视觉，推荐，擅长写作）',
    modelId: 'gemini-4-argon',
    cap: '视觉',
  },
  { tab: '本地部署', tag: 'qwen-image-2.1（生图，本地部署推荐）', modelId: 'qwen-image-2.1', cap: '生图' },
  { tab: '本地部署', tag: 'minimax-h3（视频，本地部署推荐）', modelId: 'minimax-h3', cap: '视频' },
];

describe('M3R2 §1 厂商顺序（页面上看到的顺序）', () => {
  it('11 家按 M3R4 §2 的顺序排（本地部署在灵绘之前），自定义入口在最后', async () => {
    await mountPanel();
    const labels = tabs().map((tab) =>
      (tab.textContent ?? '')
        .replace('（国内需中转）', '')
        // M3R10 §2：chip 上多了「· 浏览器版不可用」角标。本用例判的是**顺序**，
        // 角标是正交信息（由 M3R10 那组用例单独断言），这里一并剥掉。
        .replace('· 浏览器版不可用', '')
        .trim(),
    );
    expect(labels.slice(0, VENDOR_TAB_LABELS.length)).toEqual(VENDOR_TAB_LABELS);
    expect(labels[labels.length - 1]).toContain('自定义');
    expect(labels).toHaveLength(VENDOR_TAB_LABELS.length + 1);
  });

  it('OpenAI / Anthropic / Gemini 三个 tab 都带「国内需中转」', async () => {
    await mountPanel();
    const relayTabs = tabs()
      .filter((tab) => (tab.textContent ?? '').includes('国内需中转'))
      .map((tab) => (tab.textContent ?? '').replace('（国内需中转）', '').trim());
    expect(relayTabs).toEqual(['Anthropic', 'OpenAI', 'Google / Gemini']);
    // 国内直连的不许乱标
    expect(findButton('智谱').textContent).not.toContain('国内需中转');
    expect(findButton('月之暗面').textContent).not.toContain('国内需中转');
  });
});

describe('M3R2 §2 新增 10 个模型标签：点选即填入', () => {
  it('逐条点选，模型表拿到 modelId + 能力标签 + 备注（价格展示已移出配置页）', async () => {
    await mountPanel();
    for (const item of NEW_MODEL_TAGS) {
      await click(findButton(item.tab));
      await click(findButton(item.tag));
      await waitFor(
        () =>
          Array.from(container.querySelectorAll('input[aria-label^="请求模型"]')).some(
            (element) => (element as HTMLInputElement).value === item.modelId,
          ),
        `${item.modelId} 进模型表`,
      );

      const rows = modelRows();
      const rowIndex = rows.findIndex(
        (row) =>
          (row.querySelector('input[aria-label^="请求模型"]') as HTMLInputElement).value === item.modelId,
      );
      expect(rowIndex, `${item.modelId} 行`).toBeGreaterThanOrEqual(0);
      const row = rows[rowIndex];
      expect((row.querySelector(`input[aria-label="能力 ${item.cap} ${rowIndex + 1}"]`) as HTMLInputElement).checked).toBe(
        true,
      );
      expect(row.textContent).toContain('备注：');
    }
  });
});

describe('M3R2 §3 本地部署：提示 ComfyUI，且不发任何请求', () => {
  it('点本地模型后出现 ComfyUI 提示；fetch 与注入的网络函数一次都没被调用', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const selfTest = vi.fn(async () => okProbe());
    const listModels = vi.fn(async () => ({
      ok: true as const,
      models: [],
      url: '',
      diagnostics: failureDiagnostics(),
    }));

    await mountPanel({ selfTest, listModels });
    expect(container.querySelector('[data-testid="local-deploy-notice"]')).toBeNull();

    await click(findButton('本地部署'));
    await click(findButton('minimax-h3（视频，本地部署推荐）'));
    await waitFor(
      () => Boolean(container.querySelector('[data-testid="local-deploy-notice"]')),
      'ComfyUI 提示出现',
    );

    const notice = container.querySelector('[data-testid="local-deploy-notice"]');
    expect(notice?.textContent).toContain('ComfyUI');
    expect(notice?.textContent).toContain('现在可以先记下来');

    // 只登记模型：不发请求、也不假装能调用
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(selfTest).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
    expect(input('服务地址 1').value).toBe('');
    expect(input('请求模型 2').value).toBe('minimax-h3');
  });
});

describe('M3R2 §4 §6 文案纪律（里程碑代号与推广链接）', () => {
  it('首启弹窗不含「M3」，改为「配置阶段不会发起任何真实模型调用」', async () => {
    await mount(<OnboardingPanel onChosen={() => undefined} asrProbe={{ detect: async () => null }} />);
    await waitFor(() => text().includes('未检测到本地模型'), '引导页渲染');
    expect(text()).not.toContain('M3');
    expect(text()).toContain('配置阶段不会发起任何真实模型调用');
  });

  it('model-guide 页：灵绘链接标「开发者推荐 · 含邀请码」，厂商介绍至少 6 段，并解释倍率', async () => {
    await mount(<ModelGuidePanel />);
    expect(text()).toContain('最后更新：2026-10');
    expect(text()).toContain('开发者推荐 · 含邀请码');
    expect(text()).toContain('?aff=HSXNT7WHZ62T');
    const intros = container.querySelectorAll('[data-vendor-intro]');
    expect(intros.length).toBeGreaterThanOrEqual(6);
    expect(intros.length).toBe(GUIDE_VENDOR_INTROS.length);
    // M3R4 §4.2：倍率解释放在 model-guide（配置页不再显示价格）
    expect(text()).toContain('实付 ≈ 官方价 × 倍率');
  });

  it('AI 配置页只放 base_url，不出现带邀请码的推广链接', async () => {
    await mountPanel();
    await click(findButton('灵绘（中转）'));
    await click(findButton('claude-opus-5-5（文本+视觉，推荐）'));
    expect(input('服务地址 1').value).toBe('https://xn--ai-xg4e312c.com');
    expect(text()).not.toContain('?aff=');
    expect(text()).not.toContain('register');
    expect(text()).not.toContain('开发者推荐 · 含邀请码');
  });
});

/* ------------------------------------------------------------------ */
/* M3R6 判据：连接行单选移首列、模型行改启用、协议文字缩短、模型表随连接   */
/* ------------------------------------------------------------------ */

describe('M3R6 §5-3 连接行：「当前」单选独立成第一列', () => {
  it('第一列表头是「当前」；每行第一个控件是 radio 且 name 相同；备注列只剩文本框', async () => {
    await mountPanel();
    await setField('服务地址 1', 'https://one.example.com');
    await click(findButton('＋ 新建连接'));

    const rows = connectionRows();
    expect(rows).toHaveLength(2);
    rows.forEach((row, index) => {
      const cells = Array.from(row.children) as HTMLElement[];
      expect(cells[0].getAttribute('data-col')).toBe('active');
      const radio = cells[0].querySelector('input') as HTMLInputElement;
      expect(radio.type).toBe('radio');
      expect(radio.name).toBe('active-conn');
      expect(radio.getAttribute('aria-label')).toBe(`当前连接 ${index + 1}`);

      // 备注列回到纯文本：不再夹着 radio
      const noteCell = cells.find((cell) => cell.getAttribute('data-col') === 'note') as HTMLElement;
      const noteInputs = Array.from(noteCell.querySelectorAll('input'));
      expect(noteInputs).toHaveLength(1);
      expect(noteInputs[0].type).toBe('text');
      expect(noteInputs[0].getAttribute('aria-label')).toBe(`连接备注 ${index + 1}`);
    });

    // 同一厂商内互斥：name 一样，且只有一个 checked
    const radios = Array.from(
      container.querySelectorAll('input[type="radio"][name="active-conn"]'),
    ) as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios.filter((item) => item.checked)).toHaveLength(1);
    // 刚点过「＋ 新建连接」→ 第 2 条是当前
    expect(activeConnectionIndex()).toBe(1);
  });
});

describe('M3R6 §5-4 模型行第一列是「启用」复选框', () => {
  it('第一个控件是 checkbox（不是 radio）；取消勾选后保存，pickModel("image") 不再返回它', async () => {
    await mountPanel();
    await setField('服务地址 1', 'https://relay.example.com');
    await click(findButton('cogview-3-flash（生图，免费测试）'));

    const rows = modelRows();
    const target = rows.find(
      (item) =>
        (item.querySelector('input[aria-label^="请求模型"]') as HTMLInputElement).value ===
        'cogview-3-flash',
    );
    expect(target).toBeDefined();
    const cells = Array.from((target as HTMLElement).children) as HTMLElement[];
    expect(cells[0].getAttribute('data-col')).toBe('enabled');
    const enable = cells[0].querySelector('input') as HTMLInputElement;
    expect(enable.type).toBe('checkbox');
    expect(enable.checked).toBe(true);

    // 取消启用 → 行还在（不删行），只是不参与选择
    await click(enable);
    expect((target as HTMLElement).getAttribute('data-enabled')).toBe('no');
    expect(modelRows()).toHaveLength(rows.length);

    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '保存停用状态');
    const saved = await loadCatalog();
    expect(pickModel(saved, 'image').ok).toBe(false);
  });
});

describe('M3R6 §5-6 协议下拉：可见文字不含端点后缀', () => {
  it('三项可见文字都短；/chat/completions 这类后缀只在 title 里', async () => {
    await mountPanel();
    await setField('服务地址 1', 'https://relay.example.com');

    const select = selectByLabel('协议 1');
    const labels = Array.from(select.options).map((option) => option.textContent ?? '');
    expect(labels).toEqual(['OpenAI 兼容', 'Anthropic', 'Responses（实验性）']);
    for (const label of labels) {
      expect(label).not.toContain('（/chat');
      expect(label).not.toContain('（/messages');
    }
    expect(select.title).toBe('POST https://relay.example.com/chat/completions');

    await setSelect('协议 1', 'anthropic');
    expect(selectByLabel('协议 1').title).toBe('POST https://relay.example.com/messages');
  });
});

describe('M3R6 §5-1 切连接：模型表整体跟着换', () => {
  it('两条连接的模型表互不相同，点「当前」切换后表内容随之改变', async () => {
    await mountPanel();
    await setField('服务地址 1', 'https://a.example.com');
    await click(findButton('cogview-3-flash（生图，免费测试）'));
    expect(modelRows()).toHaveLength(2);

    await click(findButton('＋ 新建连接'));
    await setField('服务地址 2', 'https://b.example.com');
    // 新连接只有预填的那条默认模型
    expect(modelRows()).toHaveLength(1);
    expect(input('请求模型 1').value).toBe('glm-5.3-flash');

    await click(byLabel('当前连接 1') as HTMLElement);
    expect(modelRows()).toHaveLength(2);
    expect(input('请求模型 2').value).toBe('cogview-3-flash');
  });
});

describe('M3R7 §1 连接默认模型不再丢（走 UI 路径）', () => {
  it('只填 base_url 与 Key → 保存 → 面板 1 行 deepseek-flash，且持久化里 models 非空', async () => {
    await mountPanel();
    await click(findButton('DeepSeek'));
    // M3R9 §5：点厂商 chip 即建出连接（地址已填好）
    expect(connectionRowIds()).toHaveLength(1);
    expect(input('服务地址 1').value).toBe('https://api.deepseek.com');

    // 全程不点「＋ 新建连接」、不点预设标签
    await setField('服务地址 1', 'https://api.deepseek.com');
    await setField('API Key 1', 'key-deepseek-ui');

    expect(modelRows()).toHaveLength(1);
    expect(input('请求模型 1').value).toBe('deepseek-flash');
    expect(text()).not.toContain('填完上面的服务地址与 Key 后会自动带出默认模型');

    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '保存成功');

    const saved = await loadCatalog();
    const deepseek = saved.providers.find((provider) => provider.id === 'deepseek');
    expect(deepseek?.connections).toHaveLength(1);
    expect((deepseek?.connections[0].models ?? []).length).toBeGreaterThan(0);
    expect(deepseek?.connections[0].models.map((model) => model.modelId)).toEqual(['deepseek-flash']);
  });

  it('点预设标签（同一个点两次）→ 保存 → 有且只有 1 行，不重复添加', async () => {
    await mountPanel();
    await click(findButton('DeepSeek'));

    await click(findButton('deepseek-flash（文本+视觉，推荐）'));
    await click(findButton('deepseek-flash（文本+视觉，推荐）'));
    expect(modelRows()).toHaveLength(1);

    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '保存成功');

    const saved = await loadCatalog();
    const deepseek = saved.providers.find((provider) => provider.id === 'deepseek');
    expect(deepseek?.connections[0].models.map((model) => model.modelId)).toEqual(['deepseek-flash']);
  });

  it('升级上来的老存档（连接在、模型表空）→ 填地址与 Key 自动补回默认模型并落库', async () => {
    // M3R6 之前的形状：模型挂在厂商下，连接里没有 models 字段 → normalizeCatalog 不迁移
    await putSetting({
      key: 'ai-catalog',
      value: {
        providers: [
          {
            id: 'deepseek',
            name: 'DeepSeek',
            builtin: true,
            models: [
              { id: 'model-legacy', displayName: 'deepseek-flash', modelId: 'deepseek-flash', caps: ['text'], enabled: true },
            ],
            lastModelId: 'model-legacy',
            connections: [
              { id: 'conn-legacy', label: 'DeepSeek', baseUrl: '', apiKey: '', protocol: 'openai', multiplier: 1 },
            ],
            activeConnectionId: 'conn-legacy',
          },
        ],
        updatedAt: 0,
      },
      updatedAt: 0,
    });

    await mountPanel();
    await click(findButton('DeepSeek'));
    expect(connectionRowIds()).toEqual(['conn-legacy']);
    expect(modelRows()).toHaveLength(0);
    expect(text()).toContain('填完上面的服务地址与 Key 后会自动带出默认模型');

    await setField('服务地址 1', 'https://api.deepseek.com');
    expect(modelRows()).toHaveLength(1);
    expect(input('请求模型 1').value).toBe('deepseek-flash');

    await setField('API Key 1', 'sk-legacy-archive');
    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '保存成功');

    const saved = await loadCatalog();
    const deepseek = saved.providers.find((provider) => provider.id === 'deepseek');
    expect(deepseek?.activeConnectionId).toBe('conn-legacy');
    expect(deepseek?.connections[0].models.map((model) => model.modelId)).toEqual(['deepseek-flash']);
  });
});

describe('M3R6 §1.3 复制模型表到其他连接', () => {
  it('把当前连接的模型表复制给另一条连接，保存后两张表一致', async () => {
    await mountPanel();
    await setField('服务地址 1', 'https://a.example.com');
    await click(findButton('cogview-3-flash（生图，免费测试）'));
    expect(modelRows()).toHaveLength(2);

    await click(findButton('＋ 新建连接'));
    await setField('服务地址 2', 'https://b.example.com');
    expect(modelRows()).toHaveLength(1);

    // 切回第 1 条（源），再复制给第 2 条
    await click(byLabel('当前连接 1') as HTMLElement);
    expect(modelRows()).toHaveLength(2);

    const copySelect = selectByLabel('复制模型表到');
    const target = Array.from(copySelect.options)
      .map((option) => option.value)
      .find((value) => value !== '');
    expect(target).toBeTruthy();
    await setSelect('复制模型表到', target as string);
    await click(byLabel('复制模型表') as HTMLElement);
    await waitFor(() => text().includes('已把当前连接的'), '复制完成提示');

    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '保存复制结果');
    const saved = await loadCatalog();
    const zhipu = saved.providers[0];
    expect(zhipu.connections).toHaveLength(2);
    expect(zhipu.connections[1].models.map((model) => model.modelId)).toEqual(
      zhipu.connections[0].models.map((model) => model.modelId),
    );
  });
});

/* ------------------------------------------------------------------ */
/* M3R9 §5 点厂商 chip 就预填 base_url                                   */
/* ------------------------------------------------------------------ */

describe('M3R9 §5 点厂商 chip 即建连接并预填 base_url', () => {
  it('点厂商 → 连接自动出现、base_url 已按 VENDOR_META 填好、倍率 1、备注是厂商名', async () => {
    await mountPanel();
    expect(connectionRows()).toHaveLength(1);
    expect(connectionRows()[0].getAttribute('data-connection-row')).toBe('draft');

    await click(findButton('DeepSeek'));
    // 连接已经建出来（不再是 draft 空行）
    expect(connectionRowIds()).toHaveLength(1);
    expect(input('服务地址 1').value).toBe('https://api.deepseek.com');
    expect(input('倍率 1').value).toBe('1');
    expect(input('连接备注 1').value).toBe('DeepSeek');
    // 协议按厂商元数据
    expect(selectByLabel('协议 1').value).toBe('openai');
    // 智谱用的是 /v4 版本段，也要原样带出来
    await click(findButton('智谱'));
    expect(input('服务地址 1').value).toBe('https://open.bigmodel.cn/api/paas/v4');
    // Anthropic 是 anthropic 协议
    await click(findButton('Anthropic'));
    expect(selectByLabel('协议 1').value).toBe('anthropic');
  });

  it('已有连接时不重复建、也不覆盖用户改过的地址（M3R9 §5 后半段）', async () => {
    await mountPanel();
    await click(findButton('DeepSeek'));
    await setField('服务地址 1', 'https://my-own-relay.example.com');

    // 切走再切回：地址还是用户改过的那个，连接数仍是 1
    await click(findButton('智谱'));
    await click(findButton('DeepSeek'));
    expect(connectionRowIds()).toHaveLength(1);
    expect(input('服务地址 1').value).toBe('https://my-own-relay.example.com');

    // 再点一次同一个厂商也不该多出第二条连接
    await click(findButton('DeepSeek'));
    expect(connectionRowIds()).toHaveLength(1);
  });

  it('点厂商预填后仍可直接保存（地址已就位，只差 Key）', async () => {
    await mountPanel();
    await click(findButton('DeepSeek'));
    await setField('API Key 1', 'key-deepseek-1');
    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '保存成功');

    const saved = await loadCatalog();
    const deepseek = saved.providers.find((provider) => provider.id === 'deepseek');
    expect(deepseek?.connections[0].baseUrl).toBe('https://api.deepseek.com');
    expect(deepseek?.connections[0].label).toBe('DeepSeek');
  });
});

/* ------------------------------------------------------------------ */
/* M3R9 §1/§2/§3 自检走真实决策树（UI 路径 + 注入探针）                   */
/* ------------------------------------------------------------------ */

describe('M3R9 §2 只有生图/视频模型时：零请求 + 可执行提示', () => {
  it('手动选中生图模型去测 → 自检不发请求（注入的两个探针都没被调用）+ info 样式提示', async () => {
    const selfTest = vi.fn(async () => okProbe());
    const listModels = vi.fn(async () => ({
      ok: true as const,
      models: ['glm-5.3-flash'],
      url: '',
      diagnostics: failureDiagnostics({ method: 'GET', status: 200, errorName: '-' }),
    }));

    await mountPanel({ selfTest, listModels });
    // 点智谱 → 建出连接与默认模型（glm-5.3-flash，文本）
    await click(findButton('智谱'));
    // 点生图标签 → 这一行成为「上次用的」（lastModelId），也就是自检会选中的那行
    await click(findButton('cogview-3-flash（生图，免费测试）'));
    await waitFor(() => modelRows().length === 2, '生图标签加进模型表');

    await click(findButton('测试连通'));
    await waitFor(() => text().includes('不支持同步自检'), '§2 提示');

    // 一个请求都没发出去（§2 的硬要求：别拿生图模型去烧一次 400）
    expect(selfTest).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
    // 提示可执行：点名是哪个模型、并告诉用户点哪个文本标签
    expect(text()).toContain('cogview-3-flash');
    expect(text()).toContain('glm-5.3-flash');
    expect(text()).toContain('deepseek-flash');
    expect(text()).toContain('创作页实测');
    // 这类不是红色错误，是 info
    const notice = container.querySelector('[data-kind="info"]');
    expect(notice).not.toBeNull();
  });

  it('连接里只有生图/视频模型（没有文本模型）→ 用 §2 的原文提示，同样零请求', async () => {
    const selfTest = vi.fn(async () => okProbe());
    const listModels = vi.fn(async () => ({
      ok: false as const,
      models: [],
      url: '',
      error: makeError(AIErrorCode.MODELS_NOT_LISTED, 'HTTP 404（没有模型列表接口）'),
      diagnostics: failureDiagnostics({ method: 'GET', status: 404, errorName: '-' }),
    }));

    await mountPanel({ selfTest, listModels });
    // 火山方舟的默认模型是文本（doubao-seed-2-1-pro-260628），先删掉它，只留视频模型
    await click(findButton('火山方舟'));
    await click(findButton('doubao-seedance-2-5-260628（视频，推荐）'));
    await waitFor(() => modelRows().length === 2, '视频标签加进模型表');
    const textRow = modelRows().find(
      (row) =>
        (row.querySelector('input[aria-label^="请求模型"]') as HTMLInputElement).value ===
        'doubao-seed-2-1-pro-260628',
    );
    expect(textRow).toBeDefined();
    await click(textRow?.querySelector('button[aria-label^="删除模型"]') as HTMLElement);
    await waitFor(() => modelRows().length === 1, '只剩视频模型');

    await click(findButton('测试连通'));
    await waitFor(() => text().includes('只有生图/视频模型'), '§2 原文提示');

    expect(selfTest).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
    expect(text()).toContain('glm-5.3-flash');
    expect(text()).toContain('创作页实测');
    expect(container.querySelector('[data-kind="info"]')).not.toBeNull();
    expect(container.querySelector('[data-kind="error"]')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* M3R8 真 reload：已配置的厂商不能被换掉（否则模型表看着变空）          */
/* ------------------------------------------------------------------ */

/** 当前选中的厂商页签（`aria-selected`） */
function selectedProviderTab(): string | null {
  const tab = container.querySelector('[role="tab"][aria-selected="true"]');
  return tab ? (tab.textContent ?? '').trim() : null;
}

/** 等一拍，让 best-effort 的「记住当前厂商」写库落地 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('M3R10 §2 + M3R11 §2：让用户在配置**之前**就知道这家浏览器版用不了', () => {
  it('chip 只给实测被拦的厂商标「· 浏览器版不可用」：灵绘有；方舟 / ＋ 自定义 / 智谱都没有', async () => {
    await mountPanel();
    const chipLabel = (name: string): string => {
      const button = buttons().find((candidate) => (candidate.textContent ?? '').includes(name));
      return (button?.textContent ?? '').trim();
    };

    /**
     * M3R11 §2：方舟实测**能**直连（预检 204 + 业务响应可读），必须去掉角标；
     * 「＋ 自定义」也不再标 —— 用户可能填的是 CORS 放行的站，一律标会误伤。
     */
    expect(chipLabel('灵绘')).toContain('· 浏览器版不可用');
    expect(chipLabel('火山方舟')).not.toContain('浏览器版不可用');
    expect(chipLabel('＋ 自定义')).not.toContain('浏览器版不可用');

    // 实测 CORS 放行的厂商一个都不能被误标
    for (const name of ['智谱', 'DeepSeek', 'Kimi', '阿里百炼']) {
      expect(chipLabel(name)).not.toContain('浏览器版不可用');
    }
  });

  it('切到灵绘：连接块里出现那行小字（判据逐字）', async () => {
    await mountPanel();
    expect(container.querySelector('[data-testid="web-cors-notice"]')).toBeNull();

    await click(findButton('灵绘'));
    await waitFor(
      () => container.querySelector('[data-testid="web-cors-notice"]') !== null,
      '灵绘的 CORS 小字',
    );
    expect(text()).toContain('浏览器直连被这家拒绝（CORS）。用桌面版可正常调用。');
  });

  it('切到方舟不再出现那行小字（M3R11：方舟可直连，不许再吓用户）', async () => {
    await mountPanel();
    await click(findButton('火山方舟'));
    await waitFor(() => modelRows().length >= 1, '方舟的连接模型表渲染');
    expect(container.querySelector('[data-testid="web-cors-notice"]')).toBeNull();
  });

  it('切到智谱：那行小字消失（不是常驻提示）', async () => {
    await mountPanel();
    await click(findButton('灵绘'));
    await waitFor(
      () => container.querySelector('[data-testid="web-cors-notice"]') !== null,
      '灵绘小字先出现',
    );
    await click(findButton('智谱'));
    await waitFor(
      () => container.querySelector('[data-testid="web-cors-notice"]') === null,
      '智谱不应有这行小字',
    );
  });
});

describe('M3R10 §1+§2：自检被 CORS 拦时的呈现', () => {
  it('CORS_BLOCKED → 落在 info 块（不是红色报错）+ 那行小字 + 不含「检查网络与代理」', async () => {
    await mountPanel({
      selfTest: async () =>
        failProbe(
          AIErrorCode.CORS_BLOCKED,
          'fetch 抛 TypeError 且无 HTTP 状态码（耗时 61ms）',
          failureDiagnostics({ status: 0, elapsedMs: 61 }),
        ),
    });
    await click(findButton('火山方舟'));
    await click(findButton('测试连通'));
    await waitFor(() => text().includes('不允许浏览器直连'), 'CORS 人话');

    // 归到 info：这不是用户配错了什么，红色报错会让人去翻配置
    expect(container.querySelector('[data-kind="info"]')).not.toBeNull();
    expect(container.querySelector('[data-kind="error"]')).toBeNull();
    expect(container.querySelector('[data-testid="self-test-cors-hint"]')?.textContent).toContain(
      '用桌面版可正常调用',
    );
    // 禁止的误导文案一个都不能出现
    expect(text()).not.toContain('检查网络与代理');
    expect(text()).not.toContain('base_url 是否写错');
    // 但技术细节仍要给（排查用）
    expect(container.querySelector('[data-testid="self-test-diagnostics"]')?.textContent).toContain(
      'TypeError',
    );
  });

  it('超时仍然是 error 块 + 网络文案（旧行为没被顺手改掉）', async () => {
    await mountPanel({
      selfTest: async () =>
        failProbe(
          AIErrorCode.TIMEOUT,
          '请求超时（AbortController 触发）',
          failureDiagnostics({ status: 0, errorName: 'AbortError', elapsedMs: 15000 }),
        ),
    });
    await click(findButton('智谱'));
    await click(findButton('测试连通'));
    await waitFor(() => text().includes('连不上服务器（连接超时）'), '超时文案');
    expect(container.querySelector('[data-kind="error"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="self-test-cors-hint"]')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* M3R8 刷新（重新挂载）后模型表不该变空                                  */
/* ------------------------------------------------------------------ */

describe('M3R8 刷新（重新挂载）后模型表不该变空', () => {
  it('在 DeepSeek 上填地址 + Key 保存 → 重新挂载（= Page.reload）→ 仍停在 DeepSeek，模型表 1 行', async () => {
    await mountPanel();
    await click(findButton('DeepSeek'));
    await setField('服务地址 1', 'https://api.deepseek.com');
    await setField('API Key 1', 'sk-m3r8-reload');
    expect(modelRows()).toHaveLength(1);

    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '保存成功');
    await settle();

    // 真 reload 在测试里的等价物：整棵 React 树卸载后重新挂载，组件内 state 全部丢失
    unmountPanel();
    await mountPanel();

    expect(selectedProviderTab()).toContain('DeepSeek');
    expect(modelRows()).toHaveLength(1);
    expect(input('请求模型 1').value).toBe('deepseek-flash');
    expect(input('服务地址 1').value).toBe('https://api.deepseek.com');
    // 这正是实机上的症状文案：它不该再出现
    expect(text()).not.toContain('填完上面的服务地址与 Key 后会自动带出默认模型');
  });

  it('上次看的厂商会被记住：智谱配好连接、切到 Kimi、重新挂载 → 仍停在 Kimi', async () => {
    await mountPanel();
    await setField('服务地址 1', 'https://open.bigmodel.cn/api/paas/v4');
    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '保存智谱连接');

    await click(findButton('月之暗面 / Kimi'));
    expect(selectedProviderTab()).toContain('Kimi');
    await settle();

    unmountPanel();
    await mountPanel();

    // 「上次点开的页签」优先于「第一条有连接的厂商」
    expect(selectedProviderTab()).toContain('Kimi');
  });

  it('没存过偏好时也不会落到空表：先配 DeepSeek，再清掉偏好设置，重新挂载仍停在 DeepSeek', async () => {
    await mountPanel();
    await click(findButton('DeepSeek'));
    await setField('服务地址 1', 'https://api.deepseek.com');
    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '保存成功');
    await settle();

    unmountPanel();
    // 模拟「换台机器 / 清过缓存」：库里只有 catalog，没有「上次看的厂商」
    await deleteRecord('settings', 'ai-config-active-provider');
    await mountPanel();

    expect(selectedProviderTab()).toContain('DeepSeek');
    expect(modelRows()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 计费方式（2026-10-29 委托人提出）：下拉决定「那个数字」是什么意思      */
/* ------------------------------------------------------------------ */

describe('计费方式下拉：四种方式联动倍率，只有需要填数字的才给输入框', () => {
  it('切「官方订阅」→ 倍率变 0 并变只读；切回「中转站」→ 又能改', async () => {
    await mountPanel();
    await setField('服务地址 1', 'https://relay.example.com');

    expect(selectByLabel('计费方式 1').value).toBe('relay');
    expect(input('倍率 1').value).toBe('1');
    expect(input('倍率 1').readOnly).toBe(false);

    await setSelect('计费方式 1', 'subscription');
    expect(selectByLabel('计费方式 1').value).toBe('subscription');
    // 数字框一直在（1 / 0 要让人看得见），而且仍然可以手改
    expect(input('倍率 1').value).toBe('0');
    expect(input('倍率 1').readOnly).toBe(false);

    await setSelect('计费方式 1', 'relay');
    expect(input('倍率 1').value).toBe('1');
  });

  it('「国外按量」默认汇率 6.8，且能改；保存后存的是 billingMode + 数值', async () => {
    await mountPanel();
    await setField('服务地址 1', 'https://api.openai.com/v1');

    await setSelect('计费方式 1', 'overseas');
    expect(input('倍率 1').value).toBe('6.8');

    await setField('倍率 1', '7.2');
    await click(findButton('保存配置'));
    await waitFor(() => text().includes('配置已保存'), '保存计费方式');

    const saved = await loadCatalog();
    expect(saved.providers[0].connections[0].billingMode).toBe('overseas');
    expect(saved.providers[0].connections[0].multiplier).toBe(7.2);
  });
});
