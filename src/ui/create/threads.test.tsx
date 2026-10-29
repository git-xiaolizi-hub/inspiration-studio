/**
 * 创作页「会话化」判据（M5a3 §6）。
 *
 * 覆盖 9 条：
 * 1 首轮走 runPack（不是 chat）          6 失败轮不进上下文
 * 2 追问走 chat，messages 顺序正确        7 线程往返（保存→读回→刷新还在）
 * 3 追问的 system 含记录正文              8 备份 zip 里有 threads.json，且能导回
 * 4 停止 → 不写 turn                      9 60% 阈值出现黄条
 * 5 重新生成 → 轮数不变、末轮仍是 assistant
 *
 * 全部 mock，零真实网络（`src/test/setup.ts` 里 fetch 默认直接失败）。
 */
import JSZip from 'jszip';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CreatePage } from './CreatePage';
import type { FollowUpPrompt } from './CreatePage';
import { createDefaultCatalog } from '../../adapters/ai-models/catalog';
import type { AICatalog } from '../../adapters/ai-models/catalog';
import { OFFICIAL_PRICE_TABLE } from '../../adapters/ai-models/pricing';
import { exportBackupZip, importBackupZip } from '../../core/backup';
import { createRecord } from '../../core/records';
import { destroyDatabase } from '../../core/storage';
import {
  createThread,
  listThreadsByKind,
  setThreadTurns,
} from '../../core/threads';
import type { Thread } from '../../core/threads';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DREAM_TEXT = '我梦见一间没有窗户的厨房，灶上一锅汤在冒泡，汤里浮着一把黄铜钥匙。';

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
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
  for (let index = 0; index < 8; index += 1) {
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

/** 一份够用的小模型表：智谱（文本） */
function makeCatalog(): AICatalog {
  const catalog = createDefaultCatalog();
  const zhipu = catalog.providers.find((provider) => provider.id === 'zhipu');
  if (!zhipu) throw new Error('默认目录里应当有智谱');
  zhipu.activeConnectionId = 'zp-1';
  zhipu.connections = [
    {
      id: 'zp-1',
      label: '智谱官方（测试）',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'test-key',
      protocol: 'openai',
      models: [
        {
          id: 'zp-text',
          displayName: 'glm-5.3-flash',
          modelId: 'glm-5.3-flash',
          caps: ['text'],
        },
      ],
    },
  ];
  return catalog;
}

/** 首轮 pack 的合格输出（interpretation 够长、3 个 symbol 且带推测词） */
function dreamJson(): string {
  const interpretation =
    '先把画面复述一遍：厨房没有窗户，汤在灶上冒泡，汤里浮着一把黄铜钥匙。' +
    '没有窗户的厨房可能意味着你此刻待在一个"只能向内看"的位置，外面的信息进不来。' +
    '汤一直在冒泡，像是某件还在持续进行的事，它没有停，但也还没到能盛出来的程度。' +
    '钥匙浮在汤里，这一点最扎眼：通常是"能打开什么的东西"被放进了正在被煮的东西里，' +
    '也许可以读成"答案就在你正在熬的那件事里"，而不是在别处。' +
    '黄铜这个材质常常和旧物、旧关系连在一起，它可能指一件你早就拥有、但一直没用的东西。' +
    '上面这些只是联想层面的可能性，不是对你处境的判断。';
  return JSON.stringify({
    interpretation,
    symbols: [
      { symbol: '没有窗户的厨房', meaning: '可能是"只能向内看"的位置，也许是某段不想被打扰的时间。' },
      { symbol: '汤在冒泡', meaning: '也许指某件还在慢慢熬的事，还没到能盛出来的时候。' },
      { symbol: '黄铜钥匙', meaning: '可能意味着答案就在你正在做的这件事里。' },
    ],
    disclaimer: '以上是心理联想的视角，不构成任何心理诊断或医疗建议。',
  });
}

function text(): string {
  return container.textContent ?? '';
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

async function clickTestId(id: string): Promise<void> {
  const target = byTestId(id);
  if (!target) throw new Error(`找不到 ${id}；页面文字：${text().slice(0, 200)}`);
  await act(async () => {
    (target as HTMLButtonElement).click();
  });
  await flush();
}

async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    if (setter) setter.call(textarea, value);
    else textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function sendFollowUpUi(message: string): Promise<void> {
  const input = byTestId('thread-input') as HTMLTextAreaElement | null;
  if (!input) throw new Error(`没有追问输入框；页面文字：${text().slice(0, 200)}`);
  await typeInto(input, message);
  await clickTestId('thread-send');
}

interface MountOptions {
  generateText?: () => Promise<string>;
  generateFollowUp?: (prompt: FollowUpPrompt) => Promise<{ text: string; tokens?: number }>;
  contextWindow?: number;
  recordId: string;
}

function renderPage(options: MountOptions): void {
  mount(
    <MemoryRouter>
      <CreatePage
        catalog={makeCatalog()}
        priceTable={OFFICIAL_PRICE_TABLE}
        recordId={options.recordId}
        generateText={options.generateText ?? (async () => dreamJson())}
        generateFollowUp={
          options.generateFollowUp ?? (async () => ({ text: '（默认追问回答）' }))
        }
        contextWindow={options.contextWindow}
      />
    </MemoryRouter>,
  );
}

function turnRoles(): string[] {
  return Array.from(container.querySelectorAll('[data-testid^="thread-turn-"]'))
    .filter((node) => (node.getAttribute('data-testid') ?? '').match(/^thread-turn-\d+$/))
    .map((node) => node.getAttribute('data-role') ?? '');
}

/* ------------------------------------------------------------------ */
/* 1. 首轮走 runPack                                                   */
/* ------------------------------------------------------------------ */

describe('判据 1：首轮走 runPack（结构化），不是 chat', () => {
  it('点「生成解梦」只调用 pack 生成器，追问生成器一次都没被调', async () => {
    const record = await createRecord({ text: DREAM_TEXT });
    let packCalls = 0;
    let chatCalls = 0;

    renderPage({
      recordId: record.id,
      generateText: async () => {
        packCalls += 1;
        return dreamJson();
      },
      generateFollowUp: async () => {
        chatCalls += 1;
        return { text: '不该被调用' };
      },
    });
    await flush();

    await clickTestId('create-start');

    expect(packCalls).toBe(1);
    expect(chatCalls).toBe(0);

    // 首轮渲染的是结构化卡片（不是自由文本段落）
    const card = container.querySelector('[data-kind="dream"]');
    expect(card).not.toBeNull();
    expect(card?.textContent ?? '').toContain('黄铜钥匙');

    // 线程落库：1 条线程、1 轮 assistant、带 structured
    const threads = await listThreadsByKind(record.id, 'dream');
    expect(threads).toHaveLength(1);
    expect(threads[0].turns).toHaveLength(1);
    expect(threads[0].turns[0].role).toBe('assistant');
    expect(threads[0].turns[0].structured).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* 2 & 3. 追问走 chat，messages 顺序 / system 含正文                    */
/* ------------------------------------------------------------------ */

describe('判据 2/3：追问走 chat，上下文顺序正确且 system 含记录正文', () => {
  it('messages = [首轮 assistant, 用户新问题]，system 里有记录正文', async () => {
    const record = await createRecord({ text: DREAM_TEXT });
    const prompts: FollowUpPrompt[] = [];

    renderPage({
      recordId: record.id,
      generateFollowUp: async (prompt) => {
        prompts.push(prompt);
        return { text: '钥匙在汤里，可能意味着答案就在你正在熬的那件事里。', tokens: 321 };
      },
    });
    await flush();
    await clickTestId('create-start');
    await sendFollowUpUi('那汤里浮着的钥匙是什么意思？');

    expect(prompts).toHaveLength(1);
    const [prompt] = prompts;

    // system = pack 提示词 + 记录正文
    expect(prompt.system).toContain('【记录正文】');
    expect(prompt.system).toContain(DREAM_TEXT);

    // messages：首轮 assistant 在前、用户新问题在后，中间没有 JSON 残渣
    expect(prompt.messages.map((message) => message.role)).toEqual(['assistant', 'user']);
    expect(prompt.messages[0].content).toContain('黄铜钥匙');
    expect(prompt.messages[0].content).not.toContain('{');
    expect(prompt.messages[1].content).toBe('那汤里浮着的钥匙是什么意思？');

    // 追问回答是自由文本 turn（没有 structured），且 token 用量照实存
    const [thread] = await listThreadsByKind(record.id, 'dream');
    expect(thread.turns).toHaveLength(3);
    expect(thread.turns[2].role).toBe('assistant');
    expect(thread.turns[2].structured).toBeUndefined();
    expect(thread.turns[2].tokens).toBe(321);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 停止                                                             */
/* ------------------------------------------------------------------ */

describe('判据 4：停止 → 不写入 turn', () => {
  it('生成中停止后，迟到的回答被丢弃（只有用户那一条留下）', async () => {
    const record = await createRecord({ text: DREAM_TEXT });
    let release: (value: { text: string }) => void = () => {};
    const pending = new Promise<{ text: string }>((resolve) => {
      release = resolve;
    });

    renderPage({
      recordId: record.id,
      generateFollowUp: () => pending,
    });
    await flush();
    await clickTestId('create-start');

    const input = byTestId('thread-input') as HTMLTextAreaElement;
    await typeInto(input, '我想停下来');
    const send = byTestId('thread-send') as HTMLButtonElement;
    await act(async () => {
      send.click();
    });
    await flush();

    // 生成中：停止按钮出现
    expect(byTestId('thread-stop')).not.toBeNull();
    await clickTestId('thread-stop');

    // 迟到的结果回来
    await act(async () => {
      release({ text: '这句不该被写进线程' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    const [thread] = await listThreadsByKind(record.id, 'dream');
    expect(thread.turns).toHaveLength(2); // 首轮 assistant + 用户那句
    expect(thread.turns[1].role).toBe('user');
    expect(text()).not.toContain('这句不该被写进线程');
  });
});

/* ------------------------------------------------------------------ */
/* 5. 重新生成                                                          */
/* ------------------------------------------------------------------ */

describe('判据 5：重新生成 → 轮数不变、末轮仍是 assistant', () => {
  it('替换最后一轮而不是追加一轮', async () => {
    const record = await createRecord({ text: DREAM_TEXT });
    let answer = 0;

    renderPage({
      recordId: record.id,
      generateFollowUp: async () => {
        answer += 1;
        return { text: `第 ${answer} 次回答：钥匙可能指你已经拥有的旧物。` };
      },
    });
    await flush();
    await clickTestId('create-start');
    await sendFollowUpUi('钥匙是什么意思？');

    const before = turnRoles();
    expect(before).toEqual(['assistant', 'user', 'assistant']);

    // 最后一轮的「重新生成」按钮
    await clickTestId('thread-regenerate-2');

    const after = turnRoles();
    expect(after).toEqual(['assistant', 'user', 'assistant']);
    expect(text()).toContain('第 2 次回答');

    const [thread] = await listThreadsByKind(record.id, 'dream');
    expect(thread.turns).toHaveLength(3);
    expect(thread.turns[2].role).toBe('assistant');
    expect(thread.turns[2].content).toContain('第 2 次回答');
  });
});

/* ------------------------------------------------------------------ */
/* 6. 失败轮不进上下文                                                  */
/* ------------------------------------------------------------------ */

describe('判据 6：失败 turn 不进上下文', () => {
  it('第一次追问报错 → 标错的轮留在库里，但下一条请求的 messages 里没有它', async () => {
    const record = await createRecord({ text: DREAM_TEXT });
    const prompts: FollowUpPrompt[] = [];
    let attempt = 0;

    renderPage({
      recordId: record.id,
      generateFollowUp: async (prompt) => {
        prompts.push(prompt);
        attempt += 1;
        if (attempt === 1) throw new Error('HTTP 429：限流了，稍后再试');
        return { text: '第二次答上来了：钥匙是旧物的意思。' };
      },
    });
    await flush();
    await clickTestId('create-start');

    await sendFollowUpUi('第一次提问');
    // 失败轮：错误标在 turn 上
    expect(byTestId('thread-turn-error-2')).not.toBeNull();
    expect(text()).toContain('HTTP 429');

    await sendFollowUpUi('第二次提问');
    expect(prompts).toHaveLength(2);

    const second = prompts[1];
    // 失败轮（assistant + error）不出现；用户的两句话都要在（它们真的说过）
    expect(second.messages.map((message) => message.role)).toEqual([
      'assistant',
      'user',
      'user',
    ]);
    expect(second.messages.map((message) => message.content)).toEqual([
      expect.stringContaining('黄铜钥匙'),
      '第一次提问',
      '第二次提问',
    ]);
    expect(JSON.stringify(second.messages)).not.toContain('429');

    // 库里仍留着那轮错误（刷新后用户还能看见并重试）
    // assistant(首轮) / user / error / user / assistant = 5 轮
    const [thread] = await listThreadsByKind(record.id, 'dream');
    expect(thread.turns).toHaveLength(5);
    expect(thread.turns[2].error).toContain('429');
    expect(thread.turns[4].content).toContain('第二次答上来了');
  });
});

/* ------------------------------------------------------------------ */
/* 7. 线程往返                                                          */
/* ------------------------------------------------------------------ */

describe('判据 7：线程往返（保存 → 读回 → 重新挂载还在）', () => {
  it('turns 长度与顺序一致，刷新页面后会话仍在', async () => {
    const record = await createRecord({ text: DREAM_TEXT });

    renderPage({ recordId: record.id });
    await flush();
    await clickTestId('create-start');
    await sendFollowUpUi('第一问');
    await sendFollowUpUi('第二问');

    expect(turnRoles()).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant']);

    const [stored] = await listThreadsByKind(record.id, 'dream');
    expect(stored.turns.map((turn) => turn.role)).toEqual([
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(stored.turns.map((turn) => turn.content)).toEqual([
      expect.stringContaining('黄铜钥匙'),
      '第一问',
      expect.stringContaining('默认追问回答'),
      '第二问',
      expect.stringContaining('默认追问回答'),
    ]);

    // 模拟刷新：卸载后重新挂载（只从库里读）
    act(() => root?.unmount());
    root = null;
    container.innerHTML = '';

    renderPage({ recordId: record.id });
    await flush();

    expect(byTestId('thread-panel')).not.toBeNull();
    expect(turnRoles()).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(text()).toContain('第二问');
  });
});

/* ------------------------------------------------------------------ */
/* 8. 备份包含 threads                                                 */
/* ------------------------------------------------------------------ */

describe('判据 8：备份把 threads 一起带走（且能导回）', () => {
  it('导出 zip 里有 threads.json，导入后线程原样恢复', async () => {
    const record = await createRecord({ text: DREAM_TEXT });

    renderPage({ recordId: record.id });
    await flush();
    await clickTestId('create-start');
    await sendFollowUpUi('那钥匙呢？');

    const exported = await exportBackupZip(new Date(2026, 9, 19));
    expect(exported.entries).toContain('threads.json');

    const zip = await JSZip.loadAsync(exported.blob);
    const file = zip.file('threads.json');
    expect(file).not.toBeNull();
    const parsed = JSON.parse(await file!.async('string')) as {
      format: string;
      threads: Array<{ id: string; recordId: string; turns: unknown[] }>;
    };
    expect(parsed.format).toBe('ia-v2-threads');
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.threads[0].recordId).toBe(record.id);
    expect(parsed.threads[0].turns).toHaveLength(3);

    // 换设备：清库 → 从 zip 导入 → 会话回来了
    await destroyDatabase();
    const imported = await importBackupZip(exported.blob, { mode: 'replace' });
    expect(imported.threads).toBe(1);

    const restored = await listThreadsByKind(record.id, 'dream');
    expect(restored).toHaveLength(1);
    expect(restored[0].turns).toHaveLength(3);
    expect(restored[0].turns[2].content).toContain('（默认追问回答）');
  });
});

/* ------------------------------------------------------------------ */
/* 9. 60% 阈值                                                         */
/* ------------------------------------------------------------------ */

describe('判据 9：上下文超过窗口 60% 出现黄条（不自动截断）', () => {
  it('超长历史 + 小窗口 → 黄条与「开新会话」都在，历史一轮没少', async () => {
    const record = await createRecord({ text: DREAM_TEXT });
    const longLine = '这一句很长'.repeat(60);
    const thread: Thread = await createThread({ recordId: record.id, kind: 'dream' });
    await setThreadTurns(thread.id, [
      { role: 'user', content: longLine, at: 1 },
      { role: 'assistant', content: longLine, at: 2 },
      { role: 'user', content: longLine, at: 3 },
      { role: 'assistant', content: longLine, at: 4 },
    ]);

    // 窗口设小，让 4 轮长文本稳稳超过 60%
    renderPage({ recordId: record.id, contextWindow: 300 });
    await flush();

    expect(byTestId('thread-warn')).not.toBeNull();
    expect(byTestId('thread-warn')?.textContent ?? '').toContain('这个会话已经很长');
    expect(byTestId('thread-new-from-warn')).not.toBeNull();
    expect(byTestId('thread-tokens')?.textContent ?? '').toContain('估算');

    // 不自动截断：4 轮都在，而且照样发得出去（发出去的是全量历史）
    expect(turnRoles()).toHaveLength(4);
    const prompts: FollowUpPrompt[] = [];
    act(() => root?.unmount());
    root = null;
    container.innerHTML = '';
    renderPage({
      recordId: record.id,
      contextWindow: 300,
      generateFollowUp: async (prompt) => {
        prompts.push(prompt);
        return { text: '收到' };
      },
    });
    await flush();
    await sendFollowUpUi('还要继续');
    expect(prompts[0].messages).toHaveLength(5); // 4 轮 + 这次提问
  });

  it('窗口足够大时不出现黄条', async () => {
    const record = await createRecord({ text: DREAM_TEXT });
    renderPage({ recordId: record.id });
    await flush();
    await clickTestId('create-start');

    expect(byTestId('thread-warn')).toBeNull();
  });
});
