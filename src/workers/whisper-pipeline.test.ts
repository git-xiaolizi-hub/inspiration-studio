import { describe, expect, it, vi } from 'vitest';

/** 记录 transformers 调用参数的假实现 */
const asrCalls: Record<string, unknown>[] = [];

vi.mock('@huggingface/transformers', () => {
  const asr = async (_audio: Float32Array, options: Record<string, unknown>) => {
    asrCalls.push(options);
    return { text: '森林里下了一场大雨' };
  };
  return {
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: async () => Object.assign(asr, { processor: { feature_extractor: {} }, tokenizer: {} }),
  };
});

const { createWhisperTranscriber, resetWhisperPipelineCache } = await import('./whisper-pipeline');

describe('本地转写：切片参数', () => {
  it('长音频必须按 30 秒窗口滚动，不能整段喂（否则 30 秒之后全丢）', async () => {
    resetWhisperPipelineCache();
    asrCalls.length = 0;

    const transcriber = await createWhisperTranscriber({
      modelBaseUrl: 'http://localhost/models/',
      modelId: 'whisper-base',
      onProgress: () => undefined,
    });

    const result = await transcriber(new Float32Array(16000 * 169), { language: 'chinese' });

    expect(result.text).toBe('森林里下了一场大雨');
    expect(asrCalls).toHaveLength(1);
    expect(asrCalls[0].chunk_length_s).toBe(30);
    expect(asrCalls[0].stride_length_s).toBe(5);
    expect(asrCalls[0].language).toBe('chinese');
  });
});
