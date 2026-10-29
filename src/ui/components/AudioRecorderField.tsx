import { useEffect, useMemo, useRef, useState } from 'react';
import type { RecordAudio } from '../../core/records/types';
import {
  formatDuration,
  requestMicrophone,
  startMediaRecording,
  stopStream,
  type RecordingSession,
} from '../../core/media/recorder';
import { describeError } from '../format';
import { AudioPlayer } from './AudioPlayer';

interface Props {
  /** 编辑既有记录时的已保存音频 */
  initialAudio?: RecordAudio;
  /** 用户录制完成或删除音频时回调；只有用户真正改动才触发 */
  onChange: (audio: RecordAudio | null) => void;
  disabled?: boolean;
}

/**
 * 录音控件：录音 → 停止 → 回放 / 重录 / 删除。
 * 只在浏览器里调用 MediaRecorder；状态机与 mimeType 探测在 core/media 里单测过。
 */
export function AudioRecorderField({ initialAudio, onChange, disabled = false }: Props) {
  const [current, setCurrent] = useState<RecordAudio | null>(initialAudio ?? null);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<RecordingSession | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(
    () => () => {
      clearTimer();
      sessionRef.current?.cancel();
      sessionRef.current = null;
      stopStream(streamRef.current);
      streamRef.current = null;
    },
    [],
  );

  const hint = useMemo(
    () =>
      '录音只存在本机。若「设置 → 语音」选了本地识别，录完会自动转写并追加到正文；' +
      '转写失败也不会丢录音。',
    [],
  );

  async function handleStart() {
    setError(null);
    try {
      const stream = await requestMicrophone();
      streamRef.current = stream;
      sessionRef.current = startMediaRecording(stream);
      setElapsedMs(0);
      setRecording(true);
      clearTimer();
      timerRef.current = window.setInterval(() => setElapsedMs((value) => value + 200), 200);
    } catch (caught) {
      stopStream(streamRef.current);
      streamRef.current = null;
      setRecording(false);
      setError(describeError(caught));
    }
  }

  async function handleStop() {
    clearTimer();
    setRecording(false);

    const session = sessionRef.current;
    sessionRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    if (!session) return;

    try {
      const audio = await session.stop();
      setCurrent(audio);
      onChange(audio);
    } catch (caught) {
      setError(describeError(caught));
    }
  }

  function handleDiscard() {
    clearTimer();
    sessionRef.current?.cancel();
    sessionRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    setRecording(false);
    setElapsedMs(0);
  }

  function handleRemove() {
    setCurrent(null);
    onChange(null);
  }

  return (
    <div className="recorder">
      <div className="recorder-row">
        {recording ? (
          <>
            <span className="recording-dot" aria-hidden="true" />
            <span>录音中… {formatDuration(elapsedMs)}</span>
            <button type="button" className="button" onClick={handleStop} disabled={disabled}>
              停止
            </button>
            <button
              type="button"
              className="button ghost"
              onClick={handleDiscard}
              disabled={disabled}
            >
              放弃
            </button>
          </>
        ) : current ? (
          <button type="button" className="button" onClick={handleStart} disabled={disabled}>
            重新录制
          </button>
        ) : (
          <button type="button" className="button" onClick={handleStart} disabled={disabled}>
            ● 录音
          </button>
        )}

        {current && !recording && (
          <button type="button" className="button ghost" onClick={handleRemove} disabled={disabled}>
            删除录音
          </button>
        )}
      </div>

      {current && !recording && <AudioPlayer audio={current} />}

      {!current && !recording && <p className="muted small">{hint}</p>}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
