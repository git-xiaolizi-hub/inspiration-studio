/**
 * 录音能力（M2）：mimeType 探测 + MediaRecorder 薄封装。
 *
 * 之所以把 MediaRecorder 包一层：
 * - jsdom / 测试环境没有 MediaRecorder，纯逻辑（分片合并、时长、状态机）要能单独测；
 * - Safari 只出 audio/mp4，Chrome 出 webm/opus，探测顺序写死在这里，UI 不关心；
 * - MediaRecorder 的 blob 常缺 duration 元数据（webm 尤甚），时长只能自己按墙钟算。
 */

/** 按优先级从高到低探测的 mimeType：Chrome/Firefox 吃 opus，Safari 只认 mp4 */
export const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
] as const;

export type RecordingErrorCode =
  'UNSUPPORTED' | 'PERMISSION_DENIED' | 'NOT_RECORDING' | 'EMPTY' | 'CANCELLED' | 'ERROR';

export class RecordingError extends Error {
  readonly code: RecordingErrorCode;

  constructor(code: RecordingErrorCode, message: string) {
    super(message);
    this.name = 'RecordingError';
    this.code = code;
  }
}

/** 录好的音频（尚未落库） */
export interface RecordedAudio {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

/** MediaRecorder 的最小可测子集：只要这几个成员，测试里可以手写假实现 */
export interface RecorderAdapter {
  readonly mimeType?: string;
  readonly state?: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface RecordingSession {
  readonly mimeType: string;
  /** 停止并拿到结果；重复调用返回同一个 promise */
  stop(): Promise<RecordedAudio>;
  /** 放弃本次录音（不会产生结果） */
  cancel(): void;
  isRecording(): boolean;
}

export interface RecordingOptions {
  /** 注入时钟，测试用；默认 performance.now() */
  now?: () => number;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** 选一个当前环境支持的 mimeType；都不支持返回 null，调用方让浏览器用默认值 */
export function pickAudioMimeType(isTypeSupported?: (mimeType: string) => boolean): string | null {
  const supports = isTypeSupported ?? defaultIsTypeSupported;
  for (const candidate of AUDIO_MIME_CANDIDATES) {
    if (supports(candidate)) return candidate;
  }
  return null;
}

function defaultIsTypeSupported(mimeType: string): boolean {
  if (typeof MediaRecorder === 'undefined') return false;
  if (typeof MediaRecorder.isTypeSupported !== 'function') return false;
  return MediaRecorder.isTypeSupported(mimeType);
}

/** mimeType → 文件后缀（zip 导出命名用） */
export function audioExtensionFor(mimeType: string): string {
  const normalized = (mimeType || '').toLowerCase();
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('mp4') || normalized.includes('aac') || normalized.includes('m4a')) {
    return 'm4a';
  }
  if (normalized.includes('ogg') || normalized.includes('opus')) return 'ogg';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
  return 'bin';
}

/**
 * 包一个已创建好的 recorder，接管分片收集与停止逻辑。
 * 调用方负责 `recorder.start()`（测试里可以自己模拟分片事件）。
 */
export function startRecording(
  recorder: RecorderAdapter,
  options: RecordingOptions = {},
): RecordingSession {
  const now = options.now ?? defaultNow;
  const startedAt = now();
  const chunks: Blob[] = [];

  let settled = false;
  let cancelled = false;

  let resolveStop!: (value: RecordedAudio) => void;
  let rejectStop!: (reason: unknown) => void;
  const finished = new Promise<RecordedAudio>((resolve, reject) => {
    resolveStop = resolve;
    rejectStop = reject;
  });

  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    rejectStop(error);
  };

  recorder.ondataavailable = (event) => {
    if (settled || !event || !event.data) return;
    chunks.push(event.data);
  };

  recorder.onerror = () => {
    fail(new RecordingError('ERROR', '录音过程中出错，请重试'));
  };

  recorder.onstop = () => {
    if (settled) return;
    settled = true;

    if (cancelled) {
      rejectStop(new RecordingError('CANCELLED', '录音已取消'));
      return;
    }
    if (chunks.length === 0) {
      rejectStop(new RecordingError('EMPTY', '没有录到声音，请检查麦克风权限后重试'));
      return;
    }

    const mimeType = recorder.mimeType ?? chunks[0]?.type ?? '';
    const blob = mimeType ? new Blob(chunks, { type: mimeType }) : new Blob(chunks);
    resolveStop({
      blob,
      mimeType,
      durationMs: Math.max(0, Math.round(now() - startedAt)),
    });
  };

  return {
    mimeType: recorder.mimeType ?? '',
    isRecording() {
      return recorder.state === 'recording';
    },
    stop() {
      if (!settled && recorder.state === 'inactive') {
        fail(new RecordingError('NOT_RECORDING', '录音尚未开始或已结束'));
        return finished;
      }
      if (!settled) recorder.stop();
      return finished;
    },
    cancel() {
      cancelled = true;
      chunks.length = 0;
      if (!settled && recorder.state !== 'inactive') recorder.stop();
      if (!settled) fail(new RecordingError('CANCELLED', '录音已取消'));
    },
  };
}

/** 申请麦克风：把浏览器的英文错误名翻译成能照着做的中文提示 */
export async function requestMicrophone(): Promise<MediaStream> {
  const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
    throw new RecordingError('UNSUPPORTED', '当前浏览器不支持录音（缺少麦克风接口）');
  }
  try {
    return await mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new RecordingError(
        'PERMISSION_DENIED',
        '麦克风权限被拒绝：请在浏览器地址栏的站点设置里允许麦克风后重试',
      );
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      throw new RecordingError('UNSUPPORTED', '没有检测到麦克风设备');
    }
    throw new RecordingError('ERROR', '无法开始录音，请重试');
  }
}

/** 用真实浏览器 MediaRecorder 开始录制；不支持时抛 UNSUPPORTED */
export function startMediaRecording(
  stream: MediaStream,
  options: RecordingOptions & { timesliceMs?: number } = {},
): RecordingSession {
  if (typeof MediaRecorder === 'undefined') {
    throw new RecordingError('UNSUPPORTED', '当前浏览器不支持录音（MediaRecorder 不可用）');
  }
  const mimeType = pickAudioMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

  const session = startRecording(recorder as unknown as RecorderAdapter, options);
  // 250ms 一片：既有缓冲又不至于停止时只有一个巨大分片（Safari 上分片时机不稳定）
  recorder.start(options.timesliceMs ?? 250);
  return session;
}

/** 释放麦克风（不释放的话浏览器会一直显示录音中） */
export function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // 已停止的轨道再 stop 不报错，这里只是兜底
    }
  }
}

/** 毫秒 → "1:03"，列表与播放器显示用 */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0:00';
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
