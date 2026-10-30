import { describe, expect, it } from 'vitest';
import { downloadPack, findPack, modelFileKey, packPartUrl, removePack } from './model-store';

/** 最小可用的 Cache Storage 替身 */
function fakeCache(): Cache & { store: Map<string, Blob> } {
  const store = new Map<string, Blob>();
  const toKey = (request: Request | string): string =>
    typeof request === 'string' ? new URL(request, 'http://localhost/').href : request.url;

  return {
    store,
    async match(request: Request | string): Promise<Response | undefined> {
      const blob = store.get(toKey(request));
      return blob ? new Response(blob) : undefined;
    },
    async put(request: Request | string, response: Response): Promise<void> {
      // jsdom 的 Response.blob() 对大 body 不可靠（实测 120MB 只剩 13 字节），
      // 这里存 arrayBuffer，读的时候再用 Uint8Array 包回去。
      store.set(toKey(request), new Blob([new Uint8Array(await response.arrayBuffer())]));
    },
    async keys(): Promise<Request[]> {
      return [...store.keys()].map((url) => new Request(url));
    },
    async delete(request: Request | string): Promise<boolean> {
      return store.delete(toKey(request));
    },
  } as unknown as Cache & { store: Map<string, Blob> };
}

const pack = findPack('sense-voice')!;
/** 每个分片 60MB 太慢，测试里用小块代替（只验证拼接逻辑） */
const partBlob = () => new Blob([new Uint8Array(40 * 1024 * 1024)]);

describe('本地模型仓库（分片下载）', () => {
  it('模型包清单：SenseVoice，229MB，onnx 被切成三片', () => {
    expect(pack.label).toBe('SenseVoice');
    expect(pack.sizeMB).toBe(229);
    expect(pack.files.filter((f) => f.endsWith('.part00'))).toHaveLength(1);
    expect(packPartUrl('sense-voice', pack.files[0]).endsWith(`/model-packs/sense-voice/${pack.files[0]}`)).toBe(
      true,
    );
  });

  it('三片拼成一个整体写进缓存，词表单独一份', async () => {
    const cache = fakeCache();
    const stages: string[] = [];
    const written = new Map<string, Blob>();
    await downloadPack('sense-voice', (p) => stages.push(p.stage), {
      cache,
      put: async (key, blob) => {
        written.set(key, blob);
      },
      blobs: {
        [pack.files[0]]: partBlob(),
        [pack.files[1]]: partBlob(),
        [pack.files[2]]: partBlob(),
        [pack.tokensFile]: new Blob(['<unk> 0\n<s> 1\n']),
      },
    });

    expect(stages.at(-1)).toBe('done');
    const model = written.get(modelFileKey('sense-voice', pack.modelFile));
    const tokens = written.get(modelFileKey('sense-voice', pack.tokensFile));
    expect(model?.size).toBe(120 * 1024 * 1024);
    expect(tokens).toBeDefined();
  });

  it('分片不完整（远小于 100MB）要报错，不能当成成功', async () => {
    const cache = fakeCache();
    await expect(
      downloadPack('sense-voice', () => undefined, {
        cache,
        blobs: {
          [pack.files[0]]: new Blob(['x']),
          [pack.files[1]]: new Blob(['x']),
          [pack.files[2]]: new Blob(['x']),
          [pack.tokensFile]: new Blob(['t']),
        },
      }),
    ).rejects.toThrow(/不完整/);
  });

  it('HTTP 404 直接抛，不静默', async () => {
    const cache = fakeCache();
    await expect(
      downloadPack('sense-voice', () => undefined, {
        cache,
        fetchImpl: async () => new Response('not found', { status: 404 }),
      }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('删缓存只删这个模型的文件', async () => {
    const cache = fakeCache();
    await downloadPack('sense-voice', () => undefined, {
      cache,
      blobs: {
        [pack.files[0]]: partBlob(),
        [pack.files[1]]: partBlob(),
        [pack.files[2]]: partBlob(),
        [pack.tokensFile]: new Blob(['t']),
      },
    });
    cache.store.set('http://localhost/other/file.bin', new Blob(['x']));

    await removePack('sense-voice', cache);
    expect([...cache.store.keys()]).toEqual(['http://localhost/other/file.bin']);
  });
});
