import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalModelDialog } from './LocalModelDialog';
import { MODEL_PACKS } from '../../adapters/asr/model-spec';
import type { PackProgress } from '../../adapters/asr/model-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

const pkg = MODEL_PACKS[0];

async function mount(node: React.ReactElement): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(node);
  });
}

const q = (selector: string) => container.querySelector(selector);
const click = async (el: Element) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
};

async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  vi.restoreAllMocks();
});

describe('本地模型管理弹窗', () => {
  it('已下载：显示「使用中」和删除；未使用时给「使用」', async () => {
    await mount(
      <LocalModelDialog
        open
        onDismiss={() => undefined}
        activeId={pkg.id}
        onUse={() => undefined}
        cacheState={async () => true}
      />,
    );
    await flush();

    expect(container.textContent).toContain('使用中');
    expect(q(`[data-testid="local-model-remove-${pkg.id}"]`)).not.toBeNull();
    // 已经是当前模型 → 不再给「使用」按钮
    expect(q(`[data-testid="local-model-use-${pkg.id}"]`)).toBeNull();
  });

  it('已下载但不是当前模型 → 点「使用」回调出去', async () => {
    const used: string[] = [];
    await mount(
      <LocalModelDialog
        open
        onDismiss={() => undefined}
        activeId={null}
        onUse={(pack) => used.push(pack.id)}
        cacheState={async () => true}
      />,
    );
    await flush();

    expect(container.textContent).not.toContain('使用中');
    await click(q(`[data-testid="local-model-use-${pkg.id}"]`) as Element);
    expect(used).toEqual([pkg.id]);
  });

  it('未下载 → 点「下载」显示进度，成功后变成已下载', async () => {
    let present = false;
    await mount(
      <LocalModelDialog
        open
        onDismiss={() => undefined}
        activeId={null}
        onUse={() => undefined}
        cacheState={async () => present}
        download={async (_id, onProgress: (p: PackProgress) => void) => {
          onProgress({ stage: 'downloading', pct: 50 });
          present = true;
          onProgress({ stage: 'done' });
        }}
      />,
    );
    await flush();

    expect(container.textContent).toContain('未下载');
    const btn = q(`[data-testid="local-model-download-${pkg.id}"]`) as HTMLButtonElement;
    expect(btn.textContent).toContain('下载');

    await click(btn);
    await flush(40);

    expect(container.textContent).toContain('已下载');
    expect(q(`[data-testid="local-model-remove-${pkg.id}"]`)).not.toBeNull();
  });

  it('删除后回到未下载状态', async () => {
    let present = true;
    await mount(
      <LocalModelDialog
        open
        onDismiss={() => undefined}
        activeId={null}
        onUse={() => undefined}
        cacheState={async () => present}
        remove={async () => {
          present = false;
        }}
      />,
    );
    await flush();
    expect(container.textContent).toContain('已下载');

    await click(q(`[data-testid="local-model-remove-${pkg.id}"]`) as Element);
    await flush(40);

    expect(container.textContent).toContain('未下载');
    expect(q(`[data-testid="local-model-download-${pkg.id}"]`)).not.toBeNull();
  });
});
