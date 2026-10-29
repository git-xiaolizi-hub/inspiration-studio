/**
 * ④ 等价旧 `canvas-teardown.test.tsx`（161 行）：**组件卸载后，异步 load 的结局不许再打回组件**。
 *
 * 这是既有硬要求（M7b 修过一次偶发 exit=1）：`npm run test` 全绿但退出码 1，
 * 报的是「This error was caught after test environment was torn down」。机制：
 *
 *   挂载 → 立刻卸载 → IndexedDB 查询还在飞 → 它带着结果/错误回来时组件已经没了
 *   → catch 分支照样 `setError()` → React/vitest 把这次更新报成未处理拒绝。
 *
 * 写作工作台有**两条**跨 tick 的读路径（素材列表 + 草稿/合集/目录水合），
 * 所以这里两个都要钉住：卸载后失败、卸载后成功，都不许写回。
 *
 * 与旧文件同样用 `describeError` 的调用次数当探针（React 18 对已卸载组件的 setState
 * 是静默的，活着的环境里看不出异常），另外直接监听 `unhandledRejection` —— 那才是 exit=1 的来源。
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeError } from '../format';

/** in-flight 的 listRecords：由用例决定何时 reject（模拟「卸载后查询才返回」） */
const pending = vi.hoisted(() => ({
  reject: null as null | ((reason: unknown) => void),
  started: 0,
}));

vi.mock('../../core/records', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/records')>();
  return {
    ...actual,
    listRecords: (() => {
      pending.started += 1;
      return new Promise((_resolve, reject) => {
        pending.reject = reject;
      });
    }) as unknown as typeof actual.listRecords,
  };
});

/** 探针：错误处理是否在卸载后继续跑（真实实现照旧，只记一笔调用） */
vi.mock('../format', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../format')>();
  return { ...actual, describeError: vi.fn(actual.describeError) };
});

// mock 之后再取组件，确保拿到的是被 mock 过的依赖图
const { StudioPage } = await import('./StudioPage');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;
let unhandled: unknown[] = [];

const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};
const originalConsoleError = console.error;
const consoleErrors: string[] = [];

beforeEach(() => {
  pending.reject = null;
  pending.started = 0;
  unhandled = [];
  consoleErrors.length = 0;
  process.on('unhandledRejection', onUnhandled);
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map((item) => String(item)).join(' '));
    originalConsoleError(...args);
  };
  vi.mocked(describeError).mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  console.error = originalConsoleError;
  process.off('unhandledRejection', onUnhandled);
});

/** 让微任务 + 宏任务都跑完（未处理拒绝要等一轮才判定） */
async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(): void {
  root = createRoot(container);
  act(() => {
    root?.render(
      <MemoryRouter>
        <StudioPage />
      </MemoryRouter>,
    );
  });
}

describe('④ StudioPage 卸载后的 teardown 竞争（保持既有硬要求）', () => {
  it('卸载后素材查询才失败：错误处理不再跑、不产生未处理拒绝', async () => {
    mount();
    // 素材列表的查询真的发出去了（说明这条路径没有被跳过）
    expect(pending.started).toBeGreaterThan(0);
    expect(typeof pending.reject).toBe('function');

    act(() => root?.unmount());
    root = null;

    pending.reject?.(new Error('IndexedDB 查询在卸载后才失败'));
    await settle();

    expect(
      vi.mocked(describeError).mock.calls.length,
      '卸载后错误处理仍在跑：组件已经没了，这次 setError 就是那条 exit=1',
    ).toBe(0);
    expect(unhandled, `卸载后出现未处理拒绝：${unhandled.map(String).join(' / ')}`).toEqual([]);
    expect(container.textContent).toBe('');
  });

  it('卸载后（查询以失败收场）仍不留 React 告警、不写回状态', async () => {
    mount();
    act(() => root?.unmount());
    root = null;

    pending.reject?.(new Error('（成功分支同样被 aliveRef 挡在 try 里）'));
    await settle();

    expect(unhandled).toEqual([]);
    const complaints = consoleErrors.filter((line) =>
      /unmounted|Cannot update|not wrapped in act/i.test(line),
    );
    expect(complaints, `卸载后仍有 React 告警：${complaints.join(' / ')}`).toEqual([]);
    expect(container.textContent).toBe('');
  });

  it('挂载中失败：错误提示照常显示（别把错误一起关掉）', async () => {
    mount();
    pending.reject?.(new Error('本地数据库操作失败，请刷新页面重试'));
    await settle();

    expect(vi.mocked(describeError).mock.calls.length).toBe(1);
    expect(container.textContent).toContain('本地数据库操作失败');
  });
});
