import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AsrResponse } from './protocol';
import { AsrError } from './errors';
import { createWhisperClient, type AsrWorkerLike } from './worker-client';
import { detectLocalModel, isAvailable, LOCAL_MODELS, modelsBaseUrl } from './local-whisper';

class FakeWorker implements AsrWorkerLike {
  onmessage: ((event: { data: AsrResponse }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: AsrResponse): void {
    this.onmessage?.({ data: message });
  }

  fail(): void {
    this.onerror?.({});
  }
}

const audio = () => new Float32Array([0.1, 0.2, 0.3, 0.4]);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(overrides: { decode?: (blob: Blob) => Promise<Float32Array> } = {}) {
  const worker = new FakeWorker();
  const client = createWhisperClient({
    createWorker: () => worker,
    decode: overrides.decode ?? (async () => audio()),
    modelBaseUrl: 'http://localhost:3000/models/',
    modelId: 'whisper-base',
    now: () => 1,
  });
  return { worker, client };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('模型探测（只看随应用发布的静态目录）', () => {
  it('200 但返回的是 index.html（静态托管回退）→ 判定为没有模型', async () => {
    const fetchImpl = vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200 }));
    const detected = await detectLocalModel({
      fetchImpl,
      baseUrl: 'http://localhost:3000/models/',
      skipCache: true,
    });
    expect(detected).toBeNull();
  });

  it('base 的 config.json 可访问 → 返回 base，且只请求本地同源地址', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('{}', { status: 200 });
    });

    const detected = await detectLocalModel({ fetchImpl, baseUrl: 'http://localhost:3000/models/' });

    expect(detected?.id).toBe('whisper-base');
    expect(detected?.sizeMB).toBe(78);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('http://localhost:3000/models/whisper-base/config.json');
    expect(new URL(calls[0]).origin).toBe('http://localhost:3000');
  });

  it('base 缺失时退回 tiny（中文明显更差，但仍可用）', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // 正文要是 JSON 才算真的存在（200 空串现在会被判成缺文件）
      return new Response(url.includes('whisper-tiny') ? '{}' : '', {
        status: url.includes('whisper-tiny') ? 200 : 404,
      });
    });

    const detected = await detectLocalModel({ fetchImpl, baseUrl: 'http://localhost:3000/models/' });

    expect(detected?.id).toBe('whisper-tiny');
    expect(detected?.note).toContain('中文准确率明显更差');
    expect(LOCAL_MODELS.map((model) => model.id)).toEqual(['whisper-base', 'whisper-tiny']);
  });

  it('都缺失 / 请求抛错 → null，isAvailable 为 false', async () => {
    expect(
      await detectLocalModel({
        fetchImpl: async () => new Response('', { status: 404 }),
        baseUrl: 'http://localhost:3000/models/',
      }),
    ).toBeNull();

    expect(
      await detectLocalModel({
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
        baseUrl: 'http://localhost:3000/models/',
      }),
    ).toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    expect(await isAvailable()).toBe(false);
  });

  it('模型目录按页面 base 解析（不写死 /models）', () => {
    expect(modelsBaseUrl()).toBe('http://localhost:3000/models/');
  });
});

describe('Worker 客户端：消息、进度、取消', () => {
  it('转写：发给 Worker 的是 16k PCM + 模型信息，收到 result 才 resolve', async () => {
    const { worker, client } = setup();
    const progress: string[] = [];

    const promise = client.transcribe(new Blob([new Uint8Array([1])]), {
      onProgress: (value) => progress.push(`${value.stage}:${value.pct}`),
    });
    await flush();

    const posted = worker.posted[0] as {
      type: string;
      id: string;
      audio: Float32Array;
      modelId: string;
      modelBaseUrl: string;
      language: string;
    };
    expect(posted.type).toBe('transcribe');
    expect(posted.audio).toBeInstanceOf(Float32Array);
    expect(posted.modelId).toBe('whisper-base');
    expect(posted.modelBaseUrl).toBe('http://localhost:3000/models/');
    expect(posted.language).toBe('chinese');

    worker.emit({ type: 'progress', id: posted.id, stage: 'loading-model', pct: 30 });
    worker.emit({ type: 'progress', id: posted.id, stage: 'transcribing', pct: 0 });
    worker.emit({ type: 'result', id: posted.id, text: '梦到一片海' });

    await expect(promise).resolves.toBe('梦到一片海');
    expect(progress).toEqual(['loading-model:30', 'transcribing:0']);
  });

  it('取消：立刻以 CANCELLED 结束，通知 Worker 丢弃，迟到结果被忽略', async () => {
    const { worker, client } = setup();
    const controller = new AbortController();

    const promise = client.transcribe(new Blob([new Uint8Array([1])]), {
      signal: controller.signal,
    });
    await flush();
    const id = (worker.posted[0] as { id: string }).id;

    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(AsrError);
    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(worker.posted).toContainEqual({ type: 'cancel', id });

    // 迟到的结果不能再改状态（promise 已经 reject）
    expect(() => worker.emit({ type: 'result', id, text: '不该出现' })).not.toThrow();
  });

  it('已经取消过的 signal 直接抛 CANCELLED，不创建 Worker、不发消息', async () => {
    const { worker, client } = setup();
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.transcribe(new Blob([new Uint8Array([1])]), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(worker.posted).toHaveLength(0);
  });

  it('Worker 整体崩溃 → 等待中的请求以 LOAD_FAILED 结束（不会永远转圈）', async () => {
    const { worker, client } = setup();
    const promise = client.transcribe(new Blob([new Uint8Array([1])]));
    await flush();

    worker.fail();

    await expect(promise).rejects.toMatchObject({ code: 'LOAD_FAILED' });
  });

  it('空录音 / 解码为空 → BAD_AUDIO', async () => {
    const { worker, client } = setup({ decode: async () => new Float32Array(0) });
    await expect(client.transcribe(new Blob([]))).rejects.toMatchObject({ code: 'BAD_AUDIO' });
    await expect(client.transcribe(new Blob([new Uint8Array([1])]))).rejects.toMatchObject({
      code: 'BAD_AUDIO',
    });
    expect(worker.posted).toHaveLength(0);
  });

  it('dispose 会终止 Worker 并结束等待中的请求', async () => {
    const { worker, client } = setup();
    const promise = client.transcribe(new Blob([new Uint8Array([1])]));
    await flush();

    client.dispose();

    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(worker.terminated).toBe(true);
  });
});

describe('测试期间不产生任何真实网络请求', () => {
  it('探测与转写都走注入实现，全局 fetch 一次都没被调用', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('测试环境不允许真实网络');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const detected = await detectLocalModel({
      fetchImpl: async () => new Response('{}', { status: 200 }),
      baseUrl: 'http://localhost:3000/models/',
    });
    expect(detected?.id).toBe('whisper-base');

    const { worker, client } = setup();
    const promise = client.transcribe(new Blob([new Uint8Array([1])]));
    await flush();
    const id = (worker.posted[0] as { id: string }).id;
    worker.emit({ type: 'result', id, text: '本地结果' });
    await expect(promise).resolves.toBe('本地结果');

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
