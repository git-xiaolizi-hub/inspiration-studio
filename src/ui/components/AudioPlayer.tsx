import { useEffect, useMemo } from 'react';
import type { RecordAudio } from '../../core/records/types';
import { formatDuration } from '../../core/media/recorder';

/** 音频回放：把 Blob 转成 object URL，卸载时释放（否则内存一直涨） */
export function AudioPlayer({ audio }: { audio: RecordAudio }) {
  const url = useMemo(() => {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
    try {
      return URL.createObjectURL(audio.blob);
    } catch {
      return null;
    }
  }, [audio]);

  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  return (
    <div className="audio-player">
      {url ? (
        <audio controls src={url} preload="metadata">
          你的浏览器不支持音频播放
        </audio>
      ) : (
        <span className="muted">当前环境无法播放音频</span>
      )}
      <span className="muted">时长 {formatDuration(audio.durationMs)}</span>
    </div>
  );
}
