// M2.5 可行性 spike：用 transformers.js 在本地加载 whisper-tiny（量化 ONNX）并转写一段中文音频。
// 跑法：node scripts/spike-whisper.mjs [音频路径]
// 目的：验证「模型能加载 + 推理能跑 + 中文效果如何」，不涉及任何付费 API。
import { pipeline, env } from '@huggingface/transformers';
import { readFileSync } from 'node:fs';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '.tmp';

/** 极简 WAV 解析：返回 { samples: Float32Array(单声道), sampleRate } */
function readWav(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 RIFF/WAV 文件');
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
        audioFormat: buf.readUInt16LE(body),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt 或 data 块');

  let samples;
  const { bitsPerSample: bits, channels, audioFormat } = fmt;
  if (bits === 16) {
    const n = Math.floor(data.length / 2);
    samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  } else if (bits === 32) {
    const n = Math.floor(data.length / 4);
    samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = data.readFloatLE(i * 4);
  } else if (bits === 8) {
    samples = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) samples[i] = (data[i] - 128) / 128;
  } else {
    throw new Error(`暂不支持 ${bits} 位 WAV（audioFormat=${audioFormat}）`);
  }

  // 多声道 -> 单声道
  if (channels > 1) {
    const n = Math.floor(samples.length / channels);
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += samples[i * channels + c];
      mono[i] = s / channels;
    }
    samples = mono;
  }

  // 线性重采样到 16kHz（whisper 要求）
  const src = fmt.sampleRate;
  if (src !== 16000) {
    const ratio = src / 16000;
    const n = Math.floor(samples.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i * ratio;
      const i0 = Math.floor(x);
      const i1 = Math.min(i0 + 1, samples.length - 1);
      out[i] = samples[i0] + (samples[i1] - samples[i0]) * (x - i0);
    }
    samples = out;
  }
  return { samples, sampleRate: 16000, sourceRate: src, channels };
}

const audioPath = process.argv[2] ?? '.tmp/asr_example.wav';
const { samples, sourceRate, channels } = readWav(audioPath);
console.log(
  `音频: ${audioPath}  源采样率=${sourceRate}Hz  声道=${channels}  时长=${(samples.length / 16000).toFixed(1)}s`,
);

const t0 = Date.now();
const modelId = process.argv[3] ?? 'whisper-tiny';
console.log('模型:', modelId);
const asr = await pipeline('automatic-speech-recognition', modelId, { dtype: 'q8' });
console.log(`pipeline 就绪，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const t1 = Date.now();
const out = await asr(samples, { language: 'chinese', task: 'transcribe' });
console.log(`推理完成，用时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
console.log('转写结果:', JSON.stringify(out, null, 2));
