/**
 * transformers.js 的加载细节（M2.5）。
 *
 * 两条硬规则放在这里，别散落到 UI：
 * 1. 只在 Worker 里 `import`（懒加载）—— 主包不能被 transformers.js 拖大；
 * 2. `allowRemoteModels = false` + `localModelPath` 指向随应用发布的目录 ——
 *    ModelScope 不返回 CORS 头，浏览器本来也直连不了，运行时零下载。
 *
 * 模型文件已实测：base 量化版 encoder 23MB + decoder 53MB（合计 78MB），
 * 加载 1.1s、5.5s 音频推理 1.6s（Node/onnxruntime-node 环境）。
 *
 * ---------------------------------------------------------------------------
 * M2.5-FIX（真机缺陷，2026-10-17）：`localModelPath` 必须是「站内路径」，不能给绝对 URL
 * ---------------------------------------------------------------------------
 * 症状：浏览器里进度跑到 100%，随后 `Cannot read properties of null (reading 'feature_extractor')`。
 *
 * 根因不在模型、不在推理，而在**组件根本没被构造出来**：
 * `pipeline()` 会先用 `get_file_metadata()` 探测 `preprocessor_config.json` /
 * `tokenizer_config.json` 是否存在，决定要不要加载 processor / tokenizer
 * （见 @huggingface/transformers 4.3.1 的 utils/model_registry/get_files.js 与 pipelines.js）。
 * 而 `get_file_metadata()` 对「http(s) 开头的 localPath」会**直接跳过本地分支**：
 *
 *     const isURL = isValidUrl(localPath, ['http:', 'https:']);
 *     if (!isURL) { ... getFile(localPath) ... }   // ← 只有非 URL 才会去取文件
 *
 * 我们之前把 `env.localModelPath` 设成了 `http://host/models/`（绝对 URL），于是探测走不到本地分支，
 * 而 `allowRemoteModels = false` 又禁止远端，结果一律判为「文件不存在」：
 * processor → null、tokenizer → null，`pipeline()` 不报错，直到推理时才崩。
 * 文件本身一直取得到（同路径直接 `fetch` 是 200），所以对照实验看着「一切正常」。
 *
 * Node 侧 spike（scripts/spike-whisper.mjs）用的是 `.tmp` 这种纯路径，永远不会踩到，
 * 这就是「Node 能跑、浏览器不能跑」的差异来源。
 *
 * 修正：把模型目录换算成同源 pathname（`/models/`）再交给 transformers.js；
 * 并在 `pipeline()` 之后显式检查 processor / tokenizer，缺失就直接抛可读错误，
 * 免得下次又变成推理阶段一句莫名其妙的 null。
 */
/**
 * onnxruntime 的 WASM 运行时放哪：
 * transformers.js 默认把 `env.backends.onnx.wasm.wasmPaths` 指向 cdn.jsdelivr.net，
 * 对「离线可用、数据不出本机」的应用不可接受（首次转写必须联网，jsdelivr 在部分网络还不通）。
 * 我们的 `scripts/copy-ort-runtime.mjs` 已把 wasm/mjs 复制到 `public/ort/`，
 * 这里按 models 目录推出同级 ort 目录，完全绕开 CDN。
 */
import type { Transcriber, TranscriberFactory } from './asr-worker-core';
import { MODEL_CACHE_NAME } from '../adapters/asr/model-spec';

interface WhisperOutput {
  text?: string;
}

type RawAsr = ((audio: Float32Array, options: Record<string, unknown>) => Promise<WhisperOutput | WhisperOutput[]>) & {
  processor?: { feature_extractor?: unknown } | null;
  tokenizer?: unknown;
};

/** 同一模型只加载一次：切页面、连续录音都不该重新读 78MB */
const pipelineCache = new Map<string, Promise<RawAsr>>();

interface ProgressPayload {
  status?: string;
  progress?: number;
  file?: string;
}

function mapLoadingProgress(payload: ProgressPayload): { stage: 'loading-model'; pct: number } {
  const pct = typeof payload.progress === 'number' ? Math.round(payload.progress) : 0;
  return { stage: 'loading-model', pct: Math.min(100, Math.max(0, pct)) };
}

/**
 * 组件真的加载起来之后，transformers.js 会按**每个文件、每次读到一块**回调进度，
 * 于是 pct 会在 0→100 之间反复跳（tokenizer/config/encoder/decoder 各自一遍）。
 * 对 UI 来说这就是「进度条满格又掉回去」，所以这里做成单调递增 + 去重：
 * 已经报过的百分比不再报，回退的也不报。
 */
function createProgressReporter(
  onProgress: (progress: { stage: 'loading-model'; pct: number }) => void,
): (payload: ProgressPayload) => void {
  let reported = -1;
  return (payload) => {
    const next = mapLoadingProgress(payload).pct;
    if (next <= reported) return;
    reported = next;
    onProgress({ stage: 'loading-model', pct: next });
  };
}

/** 把绝对/相对地址解析成绝对 URL（Worker 里 `location` 指向 worker 脚本本身，同源） */
function resolveUrl(url: string): URL | null {
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    return new URL(url, base);
  } catch {
    return null;
  }
}

/**
 * `env.localModelPath` 要的是「站内路径」（默认 `/models/`），不是完整 URL。
 * 详见文件头的 M2.5-FIX 说明：给绝对 URL 会让 transformers.js 的文件探测失效。
 */
export function toLocalModelPath(modelBaseUrl: string): string {
  const trimmed = modelBaseUrl.replace(/\/*$/, '/');
  const url = resolveUrl(trimmed);
  if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
    return url.pathname.replace(/\/*$/, '/');
  }
  return trimmed;
}

async function loadPipeline(
  modelBaseUrl: string,
  modelId: string,
  onProgress: (progress: { stage: 'loading-model'; pct: number }) => void,
): Promise<RawAsr> {
  const { pipeline, env } = await import('@huggingface/transformers');

  env.allowRemoteModels = false; // 绝不联网拉模型
  env.allowLocalModels = true;
  env.localModelPath = toLocalModelPath(modelBaseUrl);

  // 用户点「下载并启用」后，模型文件在 Cache Storage 里（见 adapters/asr/model-store.ts）。
  // transformers 先在缓存里按 localPath 找，找不到再退回本地静态目录 —— 两条路都留着：
  // 网页版靠缓存，桌面版/开发机靠 public/models/。
  if (typeof caches !== 'undefined') {
    try {
      env.useCustomCache = true;
      env.customCache = await caches.open(MODEL_CACHE_NAME);
    } catch {
      env.useCustomCache = false; // 隐私模式等禁用了 Cache Storage：退回静态目录
    }
  }

  // ort 的 wasm 仍要用绝对 URL（WebAssembly.instantiate 只认 URL），所以从绝对地址推
  const modelsUrl = resolveUrl(modelBaseUrl.replace(/\/*$/, '/'));
  const ortBase = modelsUrl
    ? new URL('../ort/', modelsUrl).href
    : new URL('../ort/', typeof location !== 'undefined' ? location.href : 'http://localhost/').href;
  const onnxBackend = (env.backends as { onnx?: { wasm?: { wasmPaths?: unknown } } } | undefined)?.onnx;
  if (onnxBackend?.wasm) {
    onnxBackend.wasm.wasmPaths = {
      wasm: `${ortBase}ort-wasm-simd-threaded.asyncify.wasm`,
      mjs: `${ortBase}ort-wasm-simd-threaded.asyncify.mjs`,
    };
  }

  const reportProgress = createProgressReporter(onProgress);
  const asr = (await pipeline('automatic-speech-recognition', modelId, {
    dtype: 'q8',
    progress_callback: (payload: ProgressPayload) => {
      if (payload?.status === 'progress' || payload?.status === 'download') {
        reportProgress(payload);
      }
    },
  })) as unknown as RawAsr;

  // 组件自检：缺 processor / tokenizer 时 process 阶段必崩，这里提前报清楚
  const hasFeatureExtractor = Boolean(asr.processor?.feature_extractor);
  const hasTokenizer = Boolean(asr.tokenizer);
  if (!hasFeatureExtractor || !hasTokenizer) {
    throw new Error(
      `本地模型组件未就绪：processor.feature_extractor=${hasFeatureExtractor}、tokenizer=${hasTokenizer}` +
        `（localModelPath=${String(env.localModelPath)}，模型目录 ${modelBaseUrl}）`,
    );
  }

  console.info(
    `[asr] ${modelId} 就绪：localModelPath=${String(env.localModelPath)} ` +
      `feature_extractor=${hasFeatureExtractor} tokenizer=${hasTokenizer}`,
  );

  // 进度条收尾：有些文件（如 merges.txt）没有 progress 事件，最后不一定是 100
  onProgress({ stage: 'loading-model', pct: 100 });

  return asr;
}

export const createWhisperTranscriber: TranscriberFactory = async ({
  modelBaseUrl,
  modelId,
  onProgress,
}) => {
  const key = `${modelBaseUrl}|${modelId}`;
  let pending = pipelineCache.get(key);
  const isFirstLoad = !pending;

  if (!pending) {
    pending = loadPipeline(modelBaseUrl, modelId, onProgress);
    pipelineCache.set(key, pending);
    // 加载失败不要缓存失败态，否则重试永远失败
    pending.catch(() => pipelineCache.delete(key));
  }

  const asr = await pending;
  if (!isFirstLoad) onProgress({ stage: 'loading-model', pct: 100 });

  const transcriber: Transcriber = async (audio, options) => {
    // ⚠️ 必须切片：whisper 只在 30 秒窗口内工作，整段直接喂进去，超过 30 秒的部分会被丢掉
    // （真机实测：169 秒的录音只转出 109 个字，正好停在 30 秒处）。
    // chunk_length_s + stride_length_s 让它按窗口滚动，并把接缝处的重叠对齐。
    const output = await asr(audio, {
      language: options.language ?? 'chinese',
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    if (Array.isArray(output)) {
      return { text: output.map((item) => item?.text ?? '').join(' ') };
    }
    return { text: typeof output?.text === 'string' ? output.text : '' };
  };
  return transcriber;
};

/** 测试用：清掉缓存（生产代码不调用） */
export function resetWhisperPipelineCache(): void {
  pipelineCache.clear();
}
