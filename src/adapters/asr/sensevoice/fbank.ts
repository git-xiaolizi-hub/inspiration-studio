/**
 * SenseVoice 的前端特征：Kaldi 风格 fbank(80) → LFR(7/6) → CMVN。
 *
 * 为什么手写而不是用现成库：
 * - transformers.js 只认 whisper 那套（log-mel 128、自己的 processor），SenseVoice 用它跑不了；
 * - 这条链只有 200 行，且必须和 sherpa-onnx 的结果逐字对上（对照实验在 04-env-tools/asr-test）。
 *
 * 关键参数（改任何一个都会让输出变成乱码）：
 *   采样率 16k / 帧长 25ms(400) / 帧移 10ms(160) / FFT 512 / 80 mel / low_freq 20Hz /
 *   hamming 窗 / 预加重 0.97 / 每帧去直流 / LFR m=7 n=6 / CMVN 用模型 metadata 里的均值与倒数标准差。
 */

export const FEATURE_CONFIG = {
  sampleRate: 16000,
  frameLength: 400,
  frameShift: 160,
  fftSize: 512,
  melBins: 80,
  lowFreq: 20,
  preEmphasis: 0.97,
  lfrM: 7,
  lfrN: 6,
} as const;

/** 原地做 radix-2 复数 FFT（长度必须是 2 的幂） */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

function hzToMel(hz: number): number {
  return 1127.0 * Math.log(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (Math.exp(mel / 1127.0) - 1);
}

/** Kaldi 的三角 mel 滤波器组，形状 [melBins, fftSize/2+1] */
export function melFilterbank(cfg = FEATURE_CONFIG): Float32Array[] {
  const bins = cfg.fftSize / 2 + 1;
  const nyquist = cfg.sampleRate / 2;
  const melLow = hzToMel(cfg.lowFreq);
  const melHigh = hzToMel(nyquist);
  const points = new Float32Array(cfg.melBins + 2);
  for (let i = 0; i < points.length; i += 1) {
    points[i] = melToHz(melLow + ((melHigh - melLow) * i) / (cfg.melBins + 1));
  }
  const binIndex = Array.from(points, (hz) => Math.floor(((cfg.fftSize + 1) * hz) / cfg.sampleRate));

  const bank: Float32Array[] = [];
  for (let m = 1; m <= cfg.melBins; m += 1) {
    const row = new Float32Array(bins);
    const left = binIndex[m - 1];
    const center = binIndex[m];
    const right = binIndex[m + 1];
    for (let k = left; k < center; k += 1) {
      row[k] = (k - left) / Math.max(center - left, 1);
    }
    for (let k = center; k < right; k += 1) {
      row[k] = (right - k) / Math.max(right - center, 1);
    }
    bank.push(row);
  }
  return bank;
}

export interface FbankResult {
  data: Float32Array;
  frames: number;
  dim: number;
}

/** 16k 单声道 PCM → 帧 × 80 的对数 mel 能量 */
export function computeFbank(samples: Float32Array, cfg = FEATURE_CONFIG): FbankResult {
  const { frameLength, frameShift, fftSize, melBins } = cfg;

  // 预加重
  const emphasized = new Float32Array(samples.length);
  emphasized[0] = samples[0] ?? 0;
  for (let i = 1; i < samples.length; i += 1) {
    emphasized[i] = samples[i] - cfg.preEmphasis * samples[i - 1];
  }

  const frames = samples.length < frameLength ? 0 : 1 + Math.floor((samples.length - frameLength) / frameShift);
  const window = new Float32Array(frameLength);
  for (let i = 0; i < frameLength; i += 1) {
    window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (frameLength - 1));
  }

  const bank = melFilterbank(cfg);
  const out = new Float32Array(frames * melBins);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const power = new Float32Array(fftSize / 2 + 1);

  for (let f = 0; f < frames; f += 1) {
    const start = f * frameShift;
    let mean = 0;
    for (let i = 0; i < frameLength; i += 1) mean += emphasized[start + i];
    mean /= frameLength;

    re.fill(0);
    im.fill(0);
    for (let i = 0; i < frameLength; i += 1) {
      re[i] = (emphasized[start + i] - mean) * window[i];
    }
    fft(re, im);
    for (let k = 0; k < power.length; k += 1) {
      power[k] = re[k] * re[k] + im[k] * im[k];
    }
    for (let m = 0; m < melBins; m += 1) {
      const row = bank[m];
      let sum = 0;
      for (let k = 0; k < row.length; k += 1) sum += row[k] * power[k];
      out[f * melBins + m] = Math.log(sum + 1e-10);
    }
  }

  return { data: out, frames, dim: melBins };
}

/**
 * 低帧率：把连续 m 帧拼成一行（每 n 帧取一次），首尾各复制边缘帧补齐。
 * 80 → 560 维，正是模型输入最后一维。
 */
export function applyLfr(input: FbankResult, cfg = FEATURE_CONFIG): FbankResult {
  const { lfrM: m, lfrN: n } = cfg;
  const { data, frames, dim } = input;
  if (frames === 0) return { data: new Float32Array(0), frames: 0, dim: dim * m };

  const pad = Math.floor((m - 1) / 2);
  const paddedFrames = frames + pad * 2;
  // 与 sherpa-onnx 一致：能完整放下 m 帧就产出一行，所以是 floor 不是 ceil
  const rows = Math.floor((paddedFrames - m) / n) + 1;
  const out = new Float32Array(rows * dim * m);

  const frameAt = (index: number): number => {
    const clamped = Math.min(Math.max(index - pad, 0), frames - 1);
    return clamped;
  };

  for (let r = 0; r < rows; r += 1) {
    for (let j = 0; j < m; j += 1) {
      const src = frameAt(r * n + j);
      out.set(data.subarray(src * dim, src * dim + dim), (r * dim * m) + j * dim);
    }
  }
  return { data: out, frames: rows, dim: dim * m };
}

/** 原地 CMVN：(x + negMean) * invStd */
export function applyCmvn(feats: FbankResult, negMean: readonly number[], invStd: readonly number[]): void {
  const dim = feats.dim;
  if (negMean.length !== dim || invStd.length !== dim) {
    throw new Error(`CMVN 维度不匹配：特征 ${dim}，参数 ${negMean.length}/${invStd.length}`);
  }
  for (let f = 0; f < feats.frames; f += 1) {
    const offset = f * dim;
    for (let d = 0; d < dim; d += 1) {
      feats.data[offset + d] = (feats.data[offset + d] + negMean[d]) * invStd[d];
    }
  }
}
