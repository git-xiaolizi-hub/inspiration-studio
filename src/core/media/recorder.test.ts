import { describe, expect, it } from 'vitest';
import {
  audioExtensionFor,
  formatDuration,
  pickAudioMimeType,
  startRecording,
  type RecorderAdapter,
} from './recorder';

/** 手写的 MediaRecorder 假实现：jsdom 没有 MediaRecorder，状态机与分片合并必须能单独测 */
class FakeRecorder implements RecorderAdapter {
  readonly mimeType: string;

  state = 'inactive';

  ondataavailable: ((event: { data: Blob }) => void) | null = null;

  onstop: ((event?: unknown) => void) | null = null;

  onerror: ((event?: unknown) => void) | null = null;

  constructor(mimeType = 'audio/webm;codecs=opus') {
    this.mimeType = mimeType;
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    this.onstop?.();
  }

  emit(size: number): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) });
  }
}

describe('mimeType 探测', () => {
  it('优先 audio/webm;codecs=opus', () => {
    expect(pickAudioMimeType((type) => type === 'audio/webm;codecs=opus')).toBe(
      'audio/webm;codecs=opus',
    );
  });

  it('Safari 只支持 mp4 时回落到 audio/mp4', () => {
    expect(pickAudioMimeType((type) => type === 'audio/mp4')).toBe('audio/mp4');
  });

  it('全都不支持时返回 null（让浏览器用默认值）', () => {
    expect(pickAudioMimeType(() => false)).toBeNull();
  });

  it('mimeType 映射成文件后缀', () => {
    expect(audioExtensionFor('audio/webm;codecs=opus')).toBe('webm');
    expect(audioExtensionFor('audio/mp4')).toBe('m4a');
    expect(audioExtensionFor('audio/ogg;codecs=opus')).toBe('ogg');
    expect(audioExtensionFor('')).toBe('bin');
  });
});

describe('录音状态机', () => {
  it('合并分片并按墙钟算时长', async () => {
    const recorder = new FakeRecorder();
    let clock = 0;
    const session = startRecording(recorder, { now: () => clock });

    recorder.start();
    recorder.emit(4);
    recorder.emit(6);
    clock = 4300;

    const audio = await session.stop();

    expect(audio.blob.size).toBe(10);
    expect(audio.mimeType).toBe('audio/webm;codecs=opus');
    expect(audio.blob.type).toBe('audio/webm;codecs=opus');
    expect(audio.durationMs).toBe(4300);
    expect(session.isRecording()).toBe(false);
  });

  it('一片都没录到时抛 EMPTY，而不是保存空文件', async () => {
    const recorder = new FakeRecorder();
    const session = startRecording(recorder, { now: () => 0 });
    recorder.start();

    await expect(session.stop()).rejects.toMatchObject({ code: 'EMPTY' });
  });

  it('取消录音抛 CANCELLED，且不产生结果', async () => {
    const recorder = new FakeRecorder();
    const session = startRecording(recorder, { now: () => 0 });
    recorder.start();
    recorder.emit(8);

    session.cancel();

    await expect(session.stop()).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('重复 stop 返回同一个 promise（不会二次 resolve 或挂死）', async () => {
    const recorder = new FakeRecorder();
    const session = startRecording(recorder, { now: () => 0 });
    recorder.start();
    recorder.emit(2);

    const first = session.stop();
    const second = session.stop();
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ durationMs: 0 });
  });

  it('从未开始就 stop 抛 NOT_RECORDING', async () => {
    const recorder = new FakeRecorder();
    const session = startRecording(recorder, { now: () => 0 });

    await expect(session.stop()).rejects.toMatchObject({ code: 'NOT_RECORDING' });
  });

  it('recorder 报错时抛 ERROR', async () => {
    const recorder = new FakeRecorder();
    const session = startRecording(recorder, { now: () => 0 });
    recorder.start();

    recorder.onerror?.();
    await expect(session.stop()).rejects.toMatchObject({ code: 'ERROR' });
  });
});

describe('时长格式化', () => {
  it('毫秒转 m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5000)).toBe('0:05');
    expect(formatDuration(63_000)).toBe('1:03');
    expect(formatDuration(Number.NaN)).toBe('0:00');
  });
});
