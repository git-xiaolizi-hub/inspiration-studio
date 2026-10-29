import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { RecordAudio, RecordEntity } from '../../core/records/types';
import { createRecord, updateRecord } from '../../core/records';
import { getVoiceSettings, type VoiceMode } from '../../core/settings';
import { localWhisperAdapter, type AsrAdapter } from '../../adapters/asr/local-whisper';
import { appendTranscript, normalizeTranscript } from '../../adapters/asr/transcript';
import { describeAsrError, isAsrCancel } from '../../adapters/asr/errors';
import { describeError } from '../format';
import { AudioRecorderField } from './AudioRecorderField';

/** 转写状态（本地识别，M2.5） */
type TranscriptionState =
  | { status: 'idle' }
  | { status: 'running'; stage: string; pct: number }
  | { status: 'error'; message: string };

interface Props {
  /** 有 initial 就是编辑，没有就是新建 */
  initial?: RecordEntity;
  onSaved: (entity: RecordEntity) => void;
  onCancel?: () => void;
  /** 本地识别适配器（默认真 worker；测试注入假的，避免真推理） */
  asr?: AsrAdapter;
}

const STAGE_LABELS: Record<string, string> = {
  'loading-model': '加载本地模型',
  transcribing: '识别语音',
};

/**
 * 新建 / 编辑表单：文字 + 标签 + 录音可以同时存在（契约 §2.2 的记录实体）。
 * 音频改动单独跟踪：undefined = 没动，null = 删掉，对象 = 新录的。
 *
 * M2.5：语音模式 = 本地识别时，录完自动转写并**追加**到正文（不覆盖已写内容）。
 * 转写失败只提示，不影响保存 —— 录音与记录照常落库（降级，不丢数据）。
 */
export function RecordEditor({ initial, onSaved, onCancel, asr }: Props) {
  const adapter = asr ?? localWhisperAdapter;
  const [text, setText] = useState(initial?.text ?? '');
  const [tagsInput, setTagsInput] = useState((initial?.tags ?? []).join(', '));
  const [audioPatch, setAudioPatch] = useState<RecordAudio | null | undefined>(undefined);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('record-only');
  const [transcription, setTranscription] = useState<TranscriptionState>({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // 读语音设置：决定录完是否自动转写
  useEffect(() => {
    let cancelled = false;
    getVoiceSettings()
      .then((settings) => {
        if (!cancelled) setVoiceMode(settings?.mode ?? 'record-only');
      })
      .catch(() => {
        // 读不到设置就按「仅录音」处理，不影响记记录
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 卸载时中止转写，避免回调打到已卸载组件
  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [],
  );

  async function startTranscription(audio: RecordAudio): Promise<void> {
    const controller = new AbortController();
    abortRef.current = controller;
    setTranscription({ status: 'running', stage: '准备音频', pct: 0 });

    try {
      const transcript = await adapter.transcribe(audio.blob, {
        onProgress: (progress) => {
          if (controller.signal.aborted) return;
          setTranscription({
            status: 'running',
            stage: STAGE_LABELS[progress.stage] ?? '识别中',
            pct: progress.pct,
          });
        },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      const transcriptText = normalizeTranscript(transcript);
      if (!transcriptText) {
        // 转写结果为空：不写空行、不覆盖，只提示
        setTranscription({ status: 'error', message: '没有识别到文字（录音已保存，可手动补写）。' });
        return;
      }
      // 用函数式更新：转写期间用户可能还在打字，不能拿旧闭包里的 text 覆盖
      setText((previous) => appendTranscript(previous, transcriptText));
      setTranscription({ status: 'idle' });
    } catch (caught) {
      if (isAsrCancel(caught) || controller.signal.aborted) {
        setTranscription({ status: 'idle' });
        return;
      }
      setTranscription({ status: 'error', message: describeAsrError(caught) });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function handleAudioChange(audio: RecordAudio | null): void {
    setAudioPatch(audio);
    abortRef.current?.abort();
    abortRef.current = null;

    if (!audio || voiceMode !== 'local-whisper') {
      setTranscription({ status: 'idle' });
      return;
    }
    void startTranscription(audio);
  }

  function handleCancelTranscription(): void {
    abortRef.current?.abort();
    abortRef.current = null;
    setTranscription({ status: 'idle' });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const entity = initial
        ? await updateRecord(
            initial.id,
            audioPatch === undefined
              ? { text, tags: tagsInput }
              : { text, tags: tagsInput, audio: audioPatch },
          )
        : await createRecord(
            audioPatch ? { text, tags: tagsInput, audio: audioPatch } : { text, tags: tagsInput },
          );
      onSaved(entity);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="record-editor" onSubmit={handleSubmit}>
      <label className="field">
        <span>内容</span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          placeholder="把梦/灵感写下来。也可以只录音，不写字。"
        />
      </label>

      <label className="field">
        <span>标签（用逗号分隔，如：梦, 分镜）</span>
        <input
          type="text"
          value={tagsInput}
          onChange={(event) => setTagsInput(event.target.value)}
          placeholder="梦, 分镜"
        />
      </label>

      <div className="field">
        <span>录音备忘（可选）</span>
        <AudioRecorderField
          initialAudio={initial?.audio}
          onChange={handleAudioChange}
          disabled={saving}
        />
      </div>

      {transcription.status === 'running' && (
        <div className="button-row" role="status">
          <span className="muted small">
            转写中…（可取消）
            {` · ${transcription.stage}`}
            {transcription.pct > 0 ? ` ${transcription.pct}%` : ''}
          </span>
          <button type="button" className="button ghost" onClick={handleCancelTranscription}>
            取消转写
          </button>
        </div>
      )}
      {transcription.status === 'error' && (
        <p className="error small">{transcription.message}</p>
      )}

      {error && <p className="error">{error}</p>}

      <div className="button-row">
        <button type="submit" className="button primary" disabled={saving}>
          {saving ? '保存中…' : initial ? '保存修改' : '保存记录'}
        </button>
        {onCancel && (
          <button type="button" className="button ghost" onClick={onCancel} disabled={saving}>
            取消
          </button>
        )}
      </div>
    </form>
  );
}
