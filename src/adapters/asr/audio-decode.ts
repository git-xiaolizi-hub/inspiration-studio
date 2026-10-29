/**
 * 音频转换（M2.5）：任意浏览器能解码的 Blob（webm/opus、mp4/aac、ogg…）→ 16kHz 单声道 Float32Array。
 *
 * 为什么不引入第三方解码库：
 * - MediaRecorder 的产物（webm/opus、mp4）自己解析容器太重，而浏览器**原生**就能解码；
 * - `AudioContext.decodeAudioData` 负责容器/编码，`OfflineAudioContext` 负责高质量重采样，
 *   两者都是标准 API，零依赖、零网络。
 *
 * whisper 的硬要求：16kHz、单声道、归一化到 [-1, 1]。喂 44.1kHz 立体声会直接转出乱码。
 */

export const WHISPER_SAMPLE_RATE = 16000;

/** 多声道 → 单声道（逐样本取平均，等价于 WebAudio 的 stereo → mono 下混规则） */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];

  const length = Math.min(...channels.map((channel) => channel.length));
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    mono[i] = sum / channels.length;
  }
  return mono;
}

/**
 * 线性插值重采样（兜底路径）。
 * 正常走 OfflineAudioContext，它带抗混叠滤波，质量更好；
 * 这里只在极老的浏览器（没有 OfflineAudioContext）上兜底，避免整条链路直接失败。
 */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number = WHISPER_SAMPLE_RATE,
): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    out[i] = samples[left] + (samples[right] - samples[left]) * weight;
  }
  return out;
}

/** jsdom 的 Blob 没有 arrayBuffer()，老 Safari 也没有 —— 统一兜底 */
export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('读取音频数据失败'));
    reader.readAsArrayBuffer(blob);
  });
}

export class AudioDecodeError extends Error {
  readonly code = 'BAD_AUDIO' as const;

  constructor(message: string) {
    super(message);
    this.name = 'AudioDecodeError';
  }
}

export interface AudioContextLike {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  close?: () => Promise<void>;
}

export interface OfflineAudioContextLike {
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): {
    buffer: AudioBuffer | null;
    connect(target: unknown): void;
    start(when?: number): void;
  };
  destination: unknown;
  startRendering(): Promise<AudioBuffer>;
}

export interface DecodeDeps {
  /** 测试注入 */
  createAudioContext?: () => AudioContextLike;
  createOfflineContext?: (channels: number, length: number, sampleRate: number) => OfflineAudioContextLike;
  sampleRate?: number;
}

function defaultAudioContext(): AudioContextLike {
  const ctor =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!ctor) throw new AudioDecodeError('当前浏览器不支持音频解码（缺少 AudioContext），无法转写');
  return new ctor();
}

function defaultOfflineContext(
  channels: number,
  length: number,
  sampleRate: number,
): OfflineAudioContextLike {
  if (typeof OfflineAudioContext === 'undefined') {
    throw new AudioDecodeError('当前浏览器不支持离线音频处理（缺少 OfflineAudioContext）');
  }
  return new OfflineAudioContext(channels, length, sampleRate);
}

/**
 * Blob → 16kHz 单声道 Float32Array。
 * 所有浏览器相关对象都可注入，测试里不需要真的 AudioContext。
 */
export async function decodeAudioBlob(blob: Blob, deps: DecodeDeps = {}): Promise<Float32Array> {
  if (!blob || blob.size === 0) {
    throw new AudioDecodeError('录音是空的，没有可转写的内容');
  }

  const targetRate = deps.sampleRate ?? WHISPER_SAMPLE_RATE;
  const createAudioContext = deps.createAudioContext ?? defaultAudioContext;
  const createOfflineContext = deps.createOfflineContext ?? defaultOfflineContext;

  let buffer: AudioBuffer;
  let context: AudioContextLike | null = null;
  try {
    context = createAudioContext();
    const bytes = await blobToArrayBuffer(blob);
    buffer = await context.decodeAudioData(bytes);
  } catch (error) {
    if (error instanceof AudioDecodeError) throw error;
    throw new AudioDecodeError('这个录音格式解不开（可能是浏览器不支持的编码），无法转写');
  } finally {
    // Safari 对同时存在的 AudioContext 数量有限制，解完立刻释放
    try {
      await context?.close?.();
    } catch {
      // 关不掉不影响结果
    }
  }

  if (!buffer || buffer.length === 0) {
    throw new AudioDecodeError('录音里没有声音，无法转写');
  }

  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    channels.push(buffer.getChannelData(c));
  }
  const mono = downmixToMono(channels);

  if (buffer.sampleRate === targetRate) return mono;

  // 主路径：OfflineAudioContext 重采样（带抗混叠滤波）
  try {
    const length = Math.max(1, Math.ceil((mono.length / buffer.sampleRate) * targetRate));
    const offline = createOfflineContext(1, length, targetRate);
    const sourceBuffer = offline.createBuffer(1, mono.length, buffer.sampleRate);
    sourceBuffer.copyToChannel(mono, 0);
    const source = offline.createBufferSource();
    source.buffer = sourceBuffer;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const data = rendered.getChannelData(0);
    if (data && data.length > 0) return new Float32Array(data);
    return resampleLinear(mono, buffer.sampleRate, targetRate);
  } catch {
    // 兜底：线性插值（音质略差，但不会让整条链路失败）
    return resampleLinear(mono, buffer.sampleRate, targetRate);
  }
}
