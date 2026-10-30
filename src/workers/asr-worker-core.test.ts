import { describe, expect, it, vi } from 'vitest';
import { createAsrWorkerCore } from './asr-worker-core';
import type { AsrResponse } from '../adapters/asr/protocol';

function createHarness(createTranscriber: Parameters<typeof createAsrWorkerCore>[0]['createTranscriber']) {
  const posted: AsrResponse[] = [];
  const core = createAsrWorkerCore({ createTranscriber, post: (message) => posted.push(message) });
  return { core, posted };
}

const request = (id: string) => ({
  type: 'transcribe' as const,
  id,
  audio: new Float32Array([0.1, 0.2, 0.3]),
  modelBaseUrl: 'http://localhost/models/',
  modelId: 'sense-voice' as const,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ASR Worker 内核：消息协议', () => {
  it('转写成功：先报加载/推理进度，再回 result', async () => {
    const { core, posted } = createHarness(async ({ onProgress }) => {
      onProgress({ stage: 'loading-model', pct: 40 });
      return async () => {
        onProgress({ stage: 'transcribing', pct: 0 });
        return { text: '这是一个梦' };
      };
    });

    core.handle(request('a'));
    await flush();

    expect(posted.map((message) => message.type)).toEqual([
      'progress',
      'progress',
      'progress',
      'progress',
      'result',
    ]);
    expect(posted.every((message) => message.id === 'a')).toBe(true);
    const result = posted.at(-1);
    expect(result).toMatchObject({ type: 'result', text: '这是一个梦' });
    expect(core.pendingCount()).toBe(0);
  });

  it('取消后丢弃结果，不向主线程回 result', async () => {
    let release!: (value: { text: string }) => void;
    const { core, posted } = createHarness(async () => (audio) =>
      new Promise((resolve) => {
        release = resolve;
        void audio;
      }),
    );

    core.handle(request('b'));
    await flush();
    core.handle({ type: 'cancel', id: 'b' });
    release({ text: '不该出现' });
    await flush();

    expect(posted.some((message) => message.type === 'result')).toBe(false);
    expect(posted.some((message) => message.type === 'error')).toBe(false);
  });

  it('加载阶段被取消：连推理都不做，也不回任何结果', async () => {
    let resolveFactory!: (transcriber: () => Promise<{ text: string }>) => void;
    const transcriber = vi.fn(async () => ({ text: '不该被调用' }));
    const { core, posted } = createHarness(
      () => new Promise((resolve) => {
        resolveFactory = resolve;
      }),
    );

    core.handle(request('c'));
    await flush();
    core.handle({ type: 'cancel', id: 'c' });
    resolveFactory(transcriber);
    await flush();

    expect(transcriber).not.toHaveBeenCalled();
    expect(posted.filter((message) => message.type === 'result')).toHaveLength(0);
  });

  it('加载失败 → LOAD_FAILED；推理失败 → TRANSCRIBE_FAILED', async () => {
    const loadFail = createHarness(async () => {
      throw new Error('模型文件读不到');
    });
    loadFail.core.handle(request('d'));
    await flush();
    const loadError = loadFail.posted.at(-1);
    expect(loadError).toMatchObject({ type: 'error', id: 'd', code: 'LOAD_FAILED' });
    expect(loadError?.type === 'error' ? loadError.message : '').toContain('模型文件读不到');

    const inferFail = createHarness(async () => async () => {
      throw new Error('推理崩了');
    });
    inferFail.core.handle(request('e'));
    await flush();
    expect(inferFail.posted.at(-1)).toMatchObject({
      type: 'error',
      id: 'e',
      code: 'TRANSCRIBE_FAILED',
    });
  });

  it('显式带 code 的错误原样透传（例如模型缺失）', async () => {
    const failure = Object.assign(new Error('没找到本地模型'), { code: 'MODEL_MISSING' });
    const { core, posted } = createHarness(async () => {
      throw failure;
    });

    core.handle(request('f'));
    await flush();

    expect(posted.at(-1)).toMatchObject({ type: 'error', code: 'MODEL_MISSING' });
  });

  it('非法请求（audio 不是 Float32Array）回 BAD_AUDIO，不调推理', async () => {
    const createTranscriber = vi.fn();
    const { core, posted } = createHarness(createTranscriber as never);

    core.handle({ type: 'transcribe', id: 'g', audio: [1, 2, 3], modelBaseUrl: 'x', modelId: 'sense-voice' });

    expect(createTranscriber).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ type: 'error', id: 'g', code: 'BAD_AUDIO' });
  });

  it('未知消息类型 / 空消息直接忽略，不抛异常', () => {
    const { core, posted } = createHarness(vi.fn() as never);
    expect(() => {
      core.handle(null);
      core.handle({ type: 'ping' });
      core.handle('字符串');
    }).not.toThrow();
    expect(posted).toHaveLength(0);
  });
});
