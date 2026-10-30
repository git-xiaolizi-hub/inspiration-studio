import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { downloadPack, findPack, modelFileKey, packUrl, removePack } from './model-store';
import type { PackProgress } from './model-store';

/** 最小可用的 Cache Storage 替身：只要 match / put / keys / delete */
function fakeCache() {
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
      store.set(toKey(request), await response.blob());
    },
    async keys(): Promise<Request[]> {
      return [...store.keys()].map((url) => new Request(url));
    },
    async delete(request: Request | string): Promise<boolean> {
      return store.delete(toKey(request));
    },
  } as unknown as Cache & { store: Map<string, Blob> };
}

async function makeZip(): Promise<Blob> {
  const zip = new JSZip();
  zip.file('whisper-base/config.json', '{"model_type":"whisper"}');
  zip.file('whisper-base/tokenizer.json', '{}');
  zip.file('whisper-base/onnx/encoder_model_quantized.onnx', new Uint8Array([1, 2, 3, 4]));
  return await zip.generateAsync({ type: 'blob' });
}

describe('本地模型仓库', () => {
  it('模型清单里有 whisper-base，压缩包地址跟着 base 走', () => {
    const pack = findPack('whisper-base');
    expect(pack).not.toBeNull();
    expect(pack?.sizeMB).toBe(78);
    expect(packUrl(pack!).endsWith('/model-packs/whisper-base.zip')).toBe(true);
  });

  it('解压后按 transformers 的路径写进缓存（去掉顶层目录）', async () => {
    const cache = fakeCache();
    const stages: PackProgress['stage'][] = [];
    await downloadPack('whisper-base', (p) => stages.push(p.stage), {
      cache,
      zipBlob: await makeZip(),
    });

    expect(stages).toContain('downloading');
    expect(stages).toContain('extracting');
    expect(stages.at(-1)).toBe('done');

    const keys = [...cache.store.keys()];
    expect(keys).toHaveLength(3);
    expect(keys.some((k) => k.endsWith('/models/whisper-base/config.json'))).toBe(true);
    expect(keys.some((k) => k.endsWith('/models/whisper-base/onnx/encoder_model_quantized.onnx'))).toBe(
      true,
    );
    // 顶层目录不能被带进键里，否则 transformers 的 localPath 对不上
    expect(keys.some((k) => k.includes('/models/whisper-base/whisper-base/'))).toBe(false);
  });

  it('缓存键与 transformers 的 localPath 口径一致', () => {
    const key = modelFileKey('whisper-base', 'config.json');
    expect(key.endsWith('/models/whisper-base/config.json')).toBe(true);
  });

  it('下载失败要抛错（HTTP 404），不能静默成功', async () => {
    const cache = fakeCache();
    await expect(
      downloadPack('whisper-base', () => undefined, {
        cache,
        fetchImpl: async () => new Response('not found', { status: 404 }),
      }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('删缓存只删这个模型的文件', async () => {
    const cache = fakeCache();
    await downloadPack('whisper-base', () => undefined, { cache, zipBlob: await makeZip() });
    cache.store.set('http://localhost/other/file.bin', new Blob(['x']));

    await removePack('whisper-base', cache);
    expect([...cache.store.keys()]).toEqual(['http://localhost/other/file.bin']);
  });
});
