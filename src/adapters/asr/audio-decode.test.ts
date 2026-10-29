import { describe, expect, it, vi } from 'vitest';
import {
  AudioDecodeError,
  decodeAudioBlob,
  downmixToMono,
  resampleLinear,
  type AudioContextLike,
  type OfflineAudioContextLike,
} from './audio-decode';

function fakeDecodedBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0]?.length ?? 0,
    duration: (channels[0]?.length ?? 0) / sampleRate,
    getChannelData: (index: number) => channels[index],
  } as unknown as AudioBuffer;
}

function fakeAudioContext(
  decoded: AudioBuffer,
  onClose?: () => void,
): AudioContextLike {
  return {
    decodeAudioData: async () => decoded,
    close: async () => {
      onClose?.();
    },
  };
}

interface OfflineRecorder {
  renderedLengths: number[];
  started: boolean;
  copied: Float32Array | null;
}

function fakeOfflineContext(target: OfflineRecorder): OfflineAudioContextLike {
  return {
    createBuffer: (_channels, length, _sampleRate) =>
      ({
        length,
        copyToChannel: (data: Float32Array) => {
          target.copied = data.slice();
        },
      }) as unknown as AudioBuffer,
    createBufferSource: () => ({
      buffer: null,
      connect: () => undefined,
      start: () => {
        target.started = true;
      },
    }),
    destination: {},
    startRendering: async () => {
      const length = target.renderedLengths.at(-1) ?? 0;
      return {
        getChannelData: () => new Float32Array(length).fill(0.25),
      } as unknown as AudioBuffer;
    },
  };
}

describe('多声道 → 单声道 / 线性重采样（纯函数）', () => {
  it('双声道取平均，单声道原样返回', () => {
    expect(Array.from(downmixToMono([new Float32Array([1, -1]), new Float32Array([0, 1])]))).toEqual([
      0.5, 0,
    ]);
    const mono = new Float32Array([0.3, 0.4]);
    expect(downmixToMono([mono])).toBe(mono);
    expect(downmixToMono([]).length).toBe(0);
  });

  it('44.1k → 16k 长度按比例缩短，采样率相同则原样返回', () => {
    const input = new Float32Array(4410).fill(0.1);
    const out = resampleLinear(input, 44100, 16000);
    expect(out.length).toBe(Math.floor((4410 / 44100) * 16000));

    const same = new Float32Array(10);
    expect(resampleLinear(same, 16000, 16000)).toBe(same);
  });
});

describe('decodeAudioBlob：把录音 Blob 变成 16kHz 单声道 PCM', () => {
  it('解码 + 下混 + 用 OfflineAudioContext 重采样到 16k', async () => {
    const left = new Float32Array(44100).fill(0.5);
    const right = new Float32Array(44100).fill(-0.5);
    let closed = false;
    const recorder: OfflineRecorder = { renderedLengths: [], started: false, copied: null };

    const result = await decodeAudioBlob(new Blob([new Uint8Array(16)]), {
      createAudioContext: () => fakeAudioContext(fakeDecodedBuffer([left, right], 44100), () => {
        closed = true;
      }),
      createOfflineContext: (_channels, length, _sampleRate) => {
        recorder.renderedLengths.push(length);
        return fakeOfflineContext(recorder);
      },
    });

    expect(result.length).toBe(16000);
    expect(result[0]).toBeCloseTo(0.25);
    expect(recorder.started).toBe(true);
    // 送进 OfflineAudioContext 的必须是已下混的单声道（L + R = 0）
    expect(recorder.copied?.length).toBe(44100);
    expect(recorder.copied?.[0]).toBeCloseTo(0);
    expect(closed).toBe(true);
  });

  it('本来就是 16k 单声道时不重采样，直接返回解码数据', async () => {
    const mono = new Float32Array([0.1, 0.2, 0.3]);
    const createOfflineContext = vi.fn();

    const result = await decodeAudioBlob(new Blob([new Uint8Array(4)]), {
      createAudioContext: () => fakeAudioContext(fakeDecodedBuffer([mono], 16000)),
      createOfflineContext: createOfflineContext as unknown as () => OfflineAudioContextLike,
    });

    expect(Array.from(result)).toHaveLength(3);
    [0.1, 0.2, 0.3].forEach((expected, index) => {
      expect(result[index]).toBeCloseTo(expected, 5);
    });
    expect(createOfflineContext).not.toHaveBeenCalled();
  });

  it('OfflineAudioContext 不可用时退回线性插值，不整条失败', async () => {
    const mono = new Float32Array(3200).fill(0.5);
    const result = await decodeAudioBlob(new Blob([new Uint8Array(4)]), {
      createAudioContext: () => fakeAudioContext(fakeDecodedBuffer([mono], 32000)),
      createOfflineContext: () => {
        throw new AudioDecodeError('没有 OfflineAudioContext');
      },
    });

    expect(result.length).toBe(1600);
    expect(result[0]).toBeCloseTo(0.5);
  });

  it('空录音 / 解码失败都抛 BAD_AUDIO，并关掉 AudioContext', async () => {
    await expect(decodeAudioBlob(new Blob([]))).rejects.toMatchObject({ code: 'BAD_AUDIO' });

    let closed = false;
    await expect(
      decodeAudioBlob(new Blob([new Uint8Array(4)]), {
        createAudioContext: () =>
          ({
            decodeAudioData: async () => {
              throw new Error('EncodingError');
            },
            close: async () => {
              closed = true;
            },
          }) as AudioContextLike,
      }),
    ).rejects.toMatchObject({ code: 'BAD_AUDIO' });
    expect(closed).toBe(true);
  });
});
