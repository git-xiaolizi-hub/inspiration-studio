/**
 * 本地语音模型的「按需下载」（R7n：从 whisper 换成 SenseVoice）。
 *
 * 数据流：
 *   站点 model-packs/<id>/part00..NN  →  按顺序拼成一个 Blob  →  Cache Storage
 *   词表单独一个文件，也进缓存
 *
 * 为什么分片：GitHub Pages 单文件上限 100MB，而 SenseVoice 的 int8 模型是 229MB。
 * 分片由 CI 在构建时切（见 .github/workflows/deploy-pages.yml），仓库里一个字节都不放。
 *
 * 为什么要自己 fetch wasm：见 sensevoice/ort-assets.ts 的注释（Vite 会给 ORT 的
 * 运行时 import 加 `?import` 后缀，导致 500）。
 */
import { MODEL_CACHE_NAME, findPack, modelFileKey, packPartUrl } from './model-spec';
import type { LocalModelId } from './protocol';

export { MODEL_CACHE_NAME, MODEL_PACKS, findPack, modelFileKey, packPartUrl } from './model-spec';
export type { ModelPack } from './model-spec';

async function openCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(MODEL_CACHE_NAME);
  } catch {
    return null;
  }
}

/** 模型是否已经在浏览器里（下载过） */
export async function isPackCached(id: LocalModelId, cacheOverride?: Cache | null): Promise<boolean> {
  const cache = cacheOverride ?? (await openCache());
  if (!cache) return false;
  try {
    const pack = findPack(id);
    if (!pack) return false;
    return Boolean(await cache.match(modelFileKey(id, pack.tokensFile)));
  } catch {
    return false;
  }
}

export async function removePack(id: LocalModelId, cacheOverride?: Cache | null): Promise<void> {
  const cache = cacheOverride ?? (await openCache());
  if (!cache) return;
  const keys = await cache.keys();
  await Promise.all(
    keys.filter((request) => request.url.includes(`/models/${id}/`)).map((request) => cache.delete(request)),
  );
}

export type PackProgress =
  | { stage: 'downloading'; pct: number }
  | { stage: 'saving'; pct: number }
  | { stage: 'done' };

export interface DownloadDeps {
  fetchImpl?: (input: RequestInfo | URL) => Promise<Response>;
  cache?: Cache | null;
  /** 测试用：跳过真实网络，直接给定每个文件的字节 */
  blobs?: Record<string, Blob>;
  /**
   * 测试用：接管「写缓存」这一步。
   * 为什么要这个口子：jsdom 的 Blob 与 Node 的 Response 不是同一个 realm，
   * `new Response(jsdomBlob)` 会把 body 变成字符串 "[object Blob]"（13 字节），
   * 断言真实字节数就永远失败。生产路径不受影响。
   */
  put?: (key: string, blob: Blob, contentType: string) => Promise<void>;
}

/** 读流并报进度（按整个包的字节数累计） */
async function readWithProgress(
  response: Response,
  onChunk: (bytes: number) => void,
): Promise<Blob> {
  if (!response.body) {
    const blob = await response.blob();
    onChunk(blob.size);
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      onChunk(value.byteLength);
    }
  }
  return new Blob(chunks as BlobPart[]);
}

/**
 * 下载 → 拼装 → 写进 Cache Storage。
 * 失败即抛，上层翻译成人话。
 */
export async function downloadPack(
  id: LocalModelId,
  onProgress: (progress: PackProgress) => void,
  deps: DownloadDeps = {},
): Promise<void> {
  const pack = findPack(id);
  if (!pack) throw new Error(`未知的本地模型：${id}`);

  const cache = 'cache' in deps ? deps.cache : await openCache();
  if (!cache) throw new Error('这个浏览器不支持离线缓存（Cache Storage），没法存模型');

  const fetchImpl = deps.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  const totalBytes = pack.downloadMB * 1024 * 1024;
  let loaded = 0;
  let lastPct = -1;
  onProgress({ stage: 'downloading', pct: 0 });

  const parts: Blob[] = [];
  for (const file of pack.files) {
    if (file === pack.tokensFile) continue; // 词表单独处理
    let blob: Blob;
    if (deps.blobs?.[file]) {
      blob = deps.blobs[file];
      loaded += blob.size;
    } else {
      if (!fetchImpl) throw new Error('当前环境不能联网下载');
      const url = packPartUrl(id, file);
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}（${file}）`);
      blob = await readWithProgress(response, (bytes) => {
        loaded += bytes;
        const pct = Math.min(99, Math.round((loaded / totalBytes) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress({ stage: 'downloading', pct });
        }
      });
    }
    parts.push(blob);
  }

  let tokensBlob: Blob;
  if (deps.blobs?.[pack.tokensFile]) {
    tokensBlob = deps.blobs[pack.tokensFile];
  } else {
    if (!fetchImpl) throw new Error('当前环境不能联网下载');
    const response = await fetchImpl(packPartUrl(id, pack.tokensFile));
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}（词表）`);
    tokensBlob = await response.blob();
  }

  onProgress({ stage: 'saving', pct: 10 });
  const modelBlob = new Blob(parts, { type: 'application/octet-stream' });
  if (modelBlob.size < 100 * 1024 * 1024) {
    throw new Error(`模型文件不完整（只有 ${Math.round(modelBlob.size / 1048576)}MB），请重试`);
  }
  const write =
    deps.put ??
    ((key: string, blob: Blob, contentType: string) =>
      cache.put(new Request(key), new Response(blob, { headers: { 'content-type': contentType } })));
  await write(modelFileKey(id, pack.modelFile), modelBlob, 'application/octet-stream');
  onProgress({ stage: 'saving', pct: 60 });

  await write(modelFileKey(id, pack.tokensFile), tokensBlob, 'text/plain; charset=utf-8');
  onProgress({ stage: 'saving', pct: 100 });

  // 自检：词表必须真的落盘，否则 Worker 里会以「模型不存在」失败
  // 注入了 put 的测试环境不查 cache（写入了别的介质），生产路径照常自检
  if (!deps.put && !(await cache.match(modelFileKey(id, pack.tokensFile)))) {
    throw new Error('模型文件没有写进缓存，请重试');
  }
  onProgress({ stage: 'done' });
}
