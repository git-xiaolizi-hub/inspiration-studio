import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSettingsSection } from './VoiceSettingsSection';
import { RecordEditor } from './RecordEditor';
import type { RecordEntity } from '../../core/records/types';
import { getVoiceSettings, saveVoiceSettings } from '../../core/settings';
import { closeDatabase, destroyDatabase } from '../../core/storage';
import { getRecordEntity } from '../../core/records';
import { AsrError } from '../../adapters/asr/errors';
import type { AsrAdapter, LocalTranscribeOptions } from '../../adapters/asr/local-whisper';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

/** 假 MediaRecorder：录一次固定 4 字节音频，stop 时同步吐分片 */
class FakeMediaRecorder {
  static isTypeSupported(): boolean {
    return true;
  }

  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_stream: unknown, _options?: unknown) {
    void _stream;
    void _options;
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({
      data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType }),
    });
    this.onstop?.();
  }
}

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
    if (Date.now() - started > 3000) throw new Error(`等待超时：${label}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function findButton(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((button) =>
    (button.textContent ?? '').includes(text),
  );
  if (!found) throw new Error(`找不到按钮：${text}`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
  });
}

function textarea(): HTMLTextAreaElement {
  const element = container.querySelector('textarea');
  if (!element) throw new Error('找不到正文输入框');
  return element as HTMLTextAreaElement;
}

const INITIAL_RECORD: RecordEntity = {
  id: 'r-asr-1',
  text: '原来的正文',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(async () => {
  await destroyDatabase();
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
});

afterEach(async () => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'mediaDevices');
  await closeDatabase();
});

async function recordOnce(): Promise<void> {
  await click(findButton('录音'));
  await waitFor(
    () => Array.from(container.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('停止')),
    '进入录音状态',
  );
  await click(findButton('停止'));
}

describe('设置 → 语音：C 项由模型是否就绪决定', () => {
  it('模型缺失：isAvailable=false → C 项禁用，并给出可执行提示', async () => {
    await mount(
      <VoiceSettingsSection
        initial={null}
        onSaved={() => undefined}
        asrProbe={{ detect: async () => null }}
      />,
    );

    const radio = container.querySelector<HTMLInputElement>('input[value="local-whisper"]');
    expect(radio?.disabled).toBe(true);
    expect(container.textContent).toContain('还没下载（约 52MB，解压占 78MB）');
  });

  it('模型就绪：C 项可选中，显示 base/78MB 并保存为 local-whisper', async () => {
    await mount(
      <VoiceSettingsSection
        initial={null}
        onSaved={() => undefined}
        asrProbe={{
          detect: async () => ({ id: 'whisper-base', label: 'base', sizeMB: 78 }),
        }}
      />,
    );

    const radio = container.querySelector<HTMLInputElement>('input[value="local-whisper"]');
    await waitFor(() => radio?.disabled === false, 'C 项点亮');
    expect(container.textContent).toContain('使用本地模型（base，78MB）');

    await click(radio as HTMLInputElement);
    // 模型已就绪时直接选中，不再弹「要不要下载」的确认
    expect(radio?.checked).toBe(true);

    await click(findButton('保存语音设置'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const saved = await getVoiceSettings();
    expect(saved?.mode).toBe('local-whisper');
  });
});

describe('录音后自动转写（本地识别）', () => {
  beforeEach(async () => {
    await saveVoiceSettings({ mode: 'local-whisper' });
  });

  it('转写成功 → 文本追加到已有正文（保留原文字 + 空行）', async () => {
    const transcribe = vi.fn(
      async (_blob: Blob, _options?: LocalTranscribeOptions): Promise<string> => {
        _options?.onProgress?.({ stage: 'loading-model', pct: 100 });
        return '这是转写出来的文字';
      },
    );
    await mount(<RecordEditor initial={INITIAL_RECORD} onSaved={() => undefined} asr={{ transcribe }} />);

    await recordOnce();
    await waitFor(() => textarea().value.includes('这是转写出来的文字'), '转写文本落地');

    expect(textarea().value).toBe('原来的正文\n\n这是转写出来的文字');
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect((transcribe.mock.calls[0][0] as Blob).size).toBeGreaterThan(0);
  });

  it('取消 → 状态复位，不留半成品文本', async () => {
    const transcribe = vi.fn(
      (_blob: Blob, options?: LocalTranscribeOptions): Promise<string> =>
        new Promise((_resolve, reject) => {
          options?.onProgress?.({ stage: 'transcribing', pct: 0 });
          options?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
          });
        }),
    );
    await mount(<RecordEditor initial={INITIAL_RECORD} onSaved={() => undefined} asr={{ transcribe }} />);

    await recordOnce();
    await waitFor(() => (container.textContent ?? '').includes('转写中…（可取消）'), '出现转写中');

    await click(findButton('取消转写'));
    await waitFor(() => !(container.textContent ?? '').includes('转写中…'), '转写状态复位');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(textarea().value).toBe('原来的正文');
    expect(container.textContent).not.toContain('已取消转写');
  });

  it('模型加载失败 → 提示人话，正文不动，记录与录音照常保存', async () => {
    const transcribe = vi.fn(async (): Promise<string> => {
      throw new AsrError('LOAD_FAILED', '本地模型加载失败');
    });
    const onSaved = vi.fn();
    await mount(<RecordEditor onSaved={onSaved} asr={{ transcribe }} />);

    await recordOnce();
    await waitFor(
      () => (container.textContent ?? '').includes('本地模型加载失败'),
      '出现降级提示',
    );
    expect(textarea().value).toBe('');

    await click(findButton('保存记录'));
    await waitFor(() => onSaved.mock.calls.length > 0, '保存完成');

    const saved = onSaved.mock.calls[0][0] as RecordEntity;
    expect(saved.audio).toBeDefined();
    const stored = await getRecordEntity(saved.id);
    expect(stored?.audio?.blob.size).toBe(4);
    expect(stored?.text).toBe('');
  });
});

describe('ASR 适配器接口（UI 只依赖这个形状）', () => {
  it('AsrAdapter.transcribe(blob, opts) 的契约在类型层面成立', () => {
    const adapter: AsrAdapter = { transcribe: async () => 'x' };
    expect(typeof adapter.transcribe).toBe('function');
  });
});

describe('本地模型按需下载（走「配置…」弹窗）', () => {
  it('未安装 → 弹窗里点下载 → 自动切换到本地模型并保存', async () => {
    let progressed = false;
    await mount(
      <VoiceSettingsSection
        initial={null}
        onSaved={() => undefined}
        asrProbe={{ detect: async () => null }}
        download={async (_id, onProgress) => {
          onProgress({ stage: 'downloading', pct: 40 });
          progressed = true;
          onProgress({ stage: 'saving', pct: 100 });
          onProgress({ stage: 'done' });
        }}
      />,
    );

    await click(container.querySelector('[data-testid="voice-local-config"]') as HTMLButtonElement);
    await waitFor(() => !!container.querySelector('[data-testid="local-model-whisper-base"]'), '弹窗打开');

    const downloadBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="local-model-download-whisper-base"]',
    );
    expect(downloadBtn?.textContent).toContain('下载');

    await click(downloadBtn as HTMLButtonElement);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(progressed).toBe(true);
    const saved = await getVoiceSettings();
    expect(saved?.mode).toBe('local-whisper');
    expect(saved?.localModelId).toBe('whisper-base');
  });

  it('下载失败要显示人话错误，不能假装成功', async () => {
    await mount(
      <VoiceSettingsSection
        initial={null}
        onSaved={() => undefined}
        asrProbe={{ detect: async () => null }}
        download={async () => {
          throw new Error('下载失败：HTTP 404');
        }}
      />,
    );

    await click(container.querySelector('[data-testid="voice-local-config"]') as HTMLButtonElement);
    await waitFor(() => !!container.querySelector('[data-testid="local-model-whisper-base"]'), '弹窗打开');
    await click(
      container.querySelector('[data-testid="local-model-download-whisper-base"]') as HTMLButtonElement,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(container.textContent).toContain('HTTP 404');
  });
});
