import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createRecord } from '../core/records';
import { closeDatabase, destroyDatabase } from '../core/storage';
import { saveVoiceSettings } from '../core/settings';

// React 18 的 act 环境标记
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(async () => {
  await destroyDatabase();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  window.location.hash = '';
  Reflect.deleteProperty(navigator, 'onLine');
  vi.unstubAllGlobals();
  await closeDatabase();
});

/** 挂载应用并等异步读库完成（没有 testing-library，用轮询 + act 代替） */
async function renderAndWait(hash: string, ready: (text: string) => boolean): Promise<string> {
  window.location.hash = hash;
  root = createRoot(container);
  await act(async () => {
    root?.render(<App />);
    await Promise.resolve();
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const text = container.textContent ?? '';
    if (ready(text)) return text;
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
  }
  return container.textContent ?? '';
}

describe('离线可用', () => {
  it('断网（onLine=false）时列表页正常显示本地记录，且全程不发 fetch', async () => {
    await createRecord({ text: '断网也要能看', tags: ['梦'] });

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const text = await renderAndWait('', (value) => value.includes('断网也要能看'));

    expect(text).toContain('断网也要能看');
    expect(text).toContain('当前离线');
    expect(text).not.toContain('网络错误');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('首次启动语音选择（裁决 1）', () => {
  it('从未设置时展示 A/B/C 三选一；C（本地模型）在断网且探测不到模型时灰置', async () => {
    const text = await renderAndWait('', (value) => value.includes('先选一下语音转写方式'));

    expect(text).toContain('仅录音备忘');
    expect(text).toContain('云端 STT');
    expect(text).toContain('ModelScope');

    const localOption = Array.from(container.querySelectorAll('button')).find((button) =>
      (button.textContent ?? '').includes('whisper.cpp'),
    );
    expect(localOption).toBeDefined();
    // §4.1 授权更新：原断言锁的是 M2 的「未实现 → 暂不可选」。
    // 现在 C 项由「探测到本地模型」决定：本用例 onLine=false（探测被跳过）+ 测试环境没有模型文件，
    // 所以仍然灰置；但文案已换成实现后的说法，"暂不可选"不应再出现。
    // 「探测到模型即可选」的正向路径见 src/ui/ai-config/ai-config-ui.test.tsx。
    expect(localOption?.disabled).toBe(true);
    expect(container.textContent).toContain('使用本地模型（base，78MB，随应用发布）');
    expect(container.textContent).not.toContain('暂不可选');
  });

  it('已经选过之后再进列表页不再弹引导', async () => {
    await saveVoiceSettings({ mode: 'record-only' });

    const text = await renderAndWait('', (value) => value.includes('记录列表'));

    expect(text).not.toContain('先选一下语音转写方式');
    expect(text).toContain('仅录音备忘');
  });
});

describe('设置页', () => {
  it('语音区块渲染三种模式，默认选中「仅录音」', async () => {
    await saveVoiceSettings({ mode: 'record-only' });

    await renderAndWait('#/settings', (value) => value.includes('保存语音设置'));

    const radios = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[name="voice-mode"]'),
    );
    expect(radios).toHaveLength(3);
    const recordOnly = radios.find((radio) => radio.value === 'record-only');
    const whisper = radios.find((radio) => radio.value === 'local-whisper');
    expect(recordOnly?.checked).toBe(true);
    expect(whisper?.disabled).toBe(true);
    expect(container.textContent).toContain('还没下载（约 52MB，解压占 78MB）');
  });
});
