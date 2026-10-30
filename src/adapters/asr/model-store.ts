/**
 * 本地语音模型的「按需下载」仓库（R7l）。
 *
 * 背景：`public/models/` 在 .gitignore 里，78MB 不进仓库 —— 网页版根本没有模型文件。
 * 所以模型改成**可选下载**：用户主动点「下载并启用」才拉，拉下来解压后存进
 * Cache Storage，transformers.js 通过 customCache 直接读缓存，刷新不用重下。
 *
 * 为什么走 GitHub Pages 而不是 Release 直链：
 * - Release 资产的域（github.com → objects.githubusercontent.com）**不发 CORS 头**，
 *   浏览器 `fetch` 直接 `TypeError: Failed to fetch`（实测，2026-10-30）；
 * - GitHub Pages 的静态资源带 `Access-Control-Allow-Origin: *`（curl 实测），
 *   而且部署后的应用与模型同源，本地 dev 也能跨域读；
 * - 所以：Release 里放人可手动下载的包，站点里放应用自己取的那份（构建时从 Release 拉取，
 *   不把 78MB 提交进 git，见 .github/workflows/deploy-pages.yml）。
 */
import JSZip from 'jszip';
import { MODEL_CACHE_NAME, findPack, type ModelPack } from './model-spec';
import type { LocalModelId } from './protocol';

export { MODEL_CACHE_NAME, MODEL_PACKS, findPack } from './model-spec';
export type { ModelPack } from './model-spec';

export function packUrl(pack: ModelPack): string {
  const base = import.meta.env.BASE_URL || '/';
  const normalized = base.endsWith('/') ? base : `${base}/`;
  const documentBase =
    typeof document !== 'undefined' && document.baseURI ? document.baseURI : 'http://localhost/';
  return new URL(`${normalized}model-packs/${pack.fileName}`, documentBase).href;
}

/**
 * 模型目录的绝对 URL。
 *
 * 故意重复一份 local-whisper 的 `modelsBaseUrl`：那边要 import 本文件的 `isPackCached`，
 * 互相 import 会成环。两边口径必须一致（BASE_URL + document.baseURI）。
 */
export function modelsDirUrl(): string {
  const base = import.meta.env.BASE_URL || '/';
  const normalized = base.endsWith('/') ? base : `${base}/`;
  const documentBase =
    typeof document !== 'undefined' && document.baseURI ? document.baseURI : 'http://localhost/';
  return new URL(`${normalized}models/`, documentBase).href;
}

/**
 * 单个模型文件的缓存键：与 transformers.js 的 `env.localModelPath + modelId + /path` 完全一致。
 * 用绝对 URL 存，Worker 里用同样的相对路径 match 时会被解析成同一个键。
 */
export function modelFileKey(id: LocalModelId, relativePath: string): string {
  return new URL(`${id}/${relativePath}`, modelsDirUrl()).href;
}

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
    return Boolean(await cache.match(modelFileKey(id, 'config.json')));
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
  | { stage: 'extracting' }
  | { stage: 'saving'; pct: number }
  | { stage: 'done' };

export interface DownloadDeps {
  fetchImpl?: (input: RequestInfo | URL) => Promise<Response>;
  cache?: Cache | null;
  /** 跳过流式读取（测试里用 Blob 直接喂） */
  zipBlob?: Blob;
}

/** 读流并报进度；拿不到 content-length 时按已知压缩包大小估 */
async function readWithProgress(
  response: Response,
  fallbackTotal: number,
  onPct: (pct: number) => void,
): Promise<Blob> {
  const total = Number(response.headers.get('content-length') ?? 0) || fallbackTotal;
  if (!response.body) return await response.blob();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastPct = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      const pct = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
      if (pct !== lastPct) {
        lastPct = pct;
        onPct(pct);
      }
    }
  }
  return new Blob(chunks as BlobPart[]);
}

/**
 * 下载 → 解压 → 写进 Cache Storage。
 *
 * 失败即抛：上层把错误翻译成人话，不要吞。
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

  onProgress({ stage: 'downloading', pct: 0 });

  let zipBlob: Blob;
  if (deps.zipBlob) {
    zipBlob = deps.zipBlob;
  } else {
    const fetchImpl = deps.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!fetchImpl) throw new Error('当前环境不能联网下载');
    const response = await fetchImpl(packUrl(pack));
    if (!response.ok) {
      throw new Error(`下载失败：HTTP ${response.status}（${packUrl(pack)}）`);
    }
    zipBlob = await readWithProgress(response, pack.zipMB * 1024 * 1024, (pct) =>
      onProgress({ stage: 'downloading', pct }),
    );
  }
  onProgress({ stage: 'downloading', pct: 100 });

  onProgress({ stage: 'extracting' });
  const zip = await JSZip.loadAsync(zipBlob);
  const entries = Object.values(zip.files).filter((file) => !file.dir);
  if (entries.length === 0) throw new Error('压缩包是空的，可能是下载被截断');

  let done = 0;
  for (const entry of entries) {
    // 压缩包内路径形如 whisper-base/onnx/encoder_model_quantized.onnx
    const relative = entry.name.replace(/^[^/]+\//, '');
    const body = await entry.async('blob');
    await cache.put(
      new Request(modelFileKey(id, relative)),
      new Response(body, { headers: { 'content-type': guessType(relative) } }),
    );
    done += 1;
    onProgress({ stage: 'saving', pct: Math.round((done / entries.length) * 100) });
  }

  // 自检：config.json 必须真的落盘，否则后面 pipeline 会以「文件不存在」失败
  if (!(await cache.match(modelFileKey(id, 'config.json')))) {
    throw new Error('模型文件没有写进缓存，请重试');
  }
  onProgress({ stage: 'done' });
}

function guessType(path: string): string {
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.onnx')) return 'application/octet-stream';
  if (path.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
