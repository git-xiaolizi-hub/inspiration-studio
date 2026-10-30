/**
 * SenseVoice-Small 的推理（onnxruntime-web 版）。
 *
 * 输入：16k 单声道 PCM（Float32Array）
 * 输出：带标点的中文文本
 *
 * 模型的四个输入（来自 onnx 元数据，不是猜的）：
 *   x          [1, T, 560]，T = LFR 之后的帧数
 *   x_length   [1] int32
 *   language   [1] int32   zh=3 en=4 yue=7 ja=11 ko=12 auto=0
 *   text_norm  [1] int32   14=带标点数字规范化(itn)，15=原样
 * 输出：logits [1, T, 25055]，CTC 贪心解码（丢 blank=0、合并连续重复、去掉 <|xx|> 控制符）。
 */
// 只用 wasm 后端：走 `onnxruntime-web/wasm` 这个入口，
// 默认入口会先尝试 jsep（webgpu/webgl）产物，多拉一个 .mjs 还会失败。
import * as ort from 'onnxruntime-web/wasm';
import { applyCmvn, applyLfr, computeFbank } from './fbank';
import { INV_STDDEV, NEG_MEAN } from './cmvn';

export const LANGUAGE_IDS = {
  auto: 0,
  zh: 3,
  en: 4,
  yue: 7,
  ja: 11,
  ko: 12,
} as const;

export type SenseVoiceLanguage = keyof typeof LANGUAGE_IDS;

export const WITH_ITN = 14;
export const WITHOUT_ITN = 15;

/** 模型需要的那几个 wasm 资源，由调用方用打包后的 URL 传进来 */
export interface OrtAssets {
  /** wasm 运行时地址；自己 fetch 成 ArrayBuffer 交给 ORT，不让它去猜 URL */
  wasm: string;
}

let ortReady: Promise<void> | null = null;

/**
 * 初始化 ORT 的 wasm 环境。
 *
 * 这里**不用 `env.wasm.wasmPaths`**：那个选项会让 ORT 去 `import()` 一个胶水 .mjs，
 * 而 Vite 会把这种运行时 import 改写成 `xxx.mjs?import`，静态文件请求直接 500（实测多次）。
 * 直接用 `wasmBinary` 把 wasm 字节喂进去：ORT 不再猜地址，也不需要动态 import 胶水
 * （胶水已经在 ort.wasm.bundle 里内联了）。
 */
function prepareOrt(assets: OrtAssets): Promise<void> {
  ortReady ??= (async () => {
    // GitHub Pages 没有 COOP/COEP 头 → 没有 SharedArrayBuffer → 只能单线程。
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.logLevel = 'error';
    const response = await fetch(assets.wasm);
    if (!response.ok) throw new Error(`wasm 运行时加载失败：HTTP ${response.status}`);
    ort.env.wasm.wasmBinary = new Uint8Array(await response.arrayBuffer());
  })();
  return ortReady;
}

export interface SenseVoiceSession {
  session: ort.InferenceSession;
  tokens: string[];
  transcribe(audio: Float32Array, options?: RecognizeOptions): Promise<string>;
}

export interface RecognizeOptions {
  language?: SenseVoiceLanguage;
  withItn?: boolean;
}

/** tokens.txt 每行是 `token id`；按行号建表（id 与行号一致，这里不信 id、只信顺序） */
export function parseTokens(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const space = line.lastIndexOf(' ');
      return space > 0 ? line.slice(0, space) : line;
    });
}

export async function createSession(
  modelBytes: ArrayBuffer | Uint8Array,
  tokensText: string,
  assets: OrtAssets,
): Promise<SenseVoiceSession> {
  await prepareOrt(assets);
  const bytes = modelBytes instanceof Uint8Array ? modelBytes : new Uint8Array(modelBytes);
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  const tokens = parseTokens(tokensText);

  async function transcribe(audio: Float32Array, options: RecognizeOptions = {}): Promise<string> {
    const language = options.language ?? 'zh';
    const withItn = options.withItn ?? true;

    const fbank = computeFbank(audio);
    if (fbank.frames === 0) return '';
    const lfr = applyLfr(fbank);
    applyCmvn(lfr, NEG_MEAN, INV_STDDEV);

    const feeds: Record<string, ort.Tensor> = {
      x: new ort.Tensor('float32', lfr.data, [1, lfr.frames, lfr.dim]),
      x_length: new ort.Tensor('int32', Int32Array.from([lfr.frames]), [1]),
      language: new ort.Tensor('int32', Int32Array.from([LANGUAGE_IDS[language]]), [1]),
      text_norm: new ort.Tensor('int32', Int32Array.from([withItn ? WITH_ITN : WITHOUT_ITN]), [1]),
    };

    const output = await session.run(feeds);
    const logits = output.logits ?? output[Object.keys(output)[0]];
    return decode(logits, tokens);
  }

  return { session, tokens, transcribe };
}

/** CTC 贪心 + 去掉形如 <|zh|> 的控制符 */
export function decode(logits: ort.Tensor, tokens: string[]): string {
  const [batch, frames, vocab] = logits.dims as [number, number, number];
  const data = logits.data as Float32Array;
  const parts: string[] = [];
  let prev = -1;

  for (let t = 0; t < frames; t += 1) {
    const offset = t * vocab;
    let best = 0;
    let bestScore = -Infinity;
    for (let v = 0; v < vocab; v += 1) {
      const score = data[offset + v];
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    if (best !== 0 && best !== prev) {
      const token = tokens[best];
      if (token && !/^<\|.*\|>$/.test(token)) parts.push(token);
    }
    prev = best;
  }
  void batch;
  return parts.join('');
}
