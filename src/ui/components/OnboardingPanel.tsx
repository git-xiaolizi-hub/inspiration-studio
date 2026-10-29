import { useEffect, useState } from 'react';
import type { VoiceMode } from '../../core/settings';
import { detectLocalModel, type LocalModelInfo } from '../../adapters/asr/local-whisper';

interface Props {
  onChosen: (mode: VoiceMode) => void | Promise<void>;
  busy?: boolean;
  error?: string | null;
  /** 本地模型探测（默认查 public/models/；测试注入假实现） */
  asrProbe?: { detect: () => Promise<LocalModelInfo | null> };
}

/**
 * 探测是"HTTP GET 静态资源"式的动作：**断网时不发**，直接当没探测到。
 * （M2 的离线用例把"离线全程不发 fetch"钉死了；M3 不能为了点亮 C 项破坏它。）
 */
const DEFAULT_PROBE = {
  detect: () =>
    typeof navigator !== 'undefined' && navigator.onLine === false
      ? Promise.resolve(null)
      : detectLocalModel(),
};

/**
 * 首次启动的语音方式选择（裁决 1：默认只录音，不强制下载任何东西）。
 * 做成覆盖层而不是独立路由：用户关掉浏览器再回来不会卡在一个"必须先选"的空页面上，
 * 底层列表页始终已经渲染好（断网刷新也不会白屏）。
 *
 * M3：C 项（本地识别）从"暂不可选"改为"探测到模型即可选"——模型已随应用发布。
 */
export function OnboardingPanel({ onChosen, busy = false, error, asrProbe }: Props) {
  const probe = asrProbe ?? DEFAULT_PROBE;
  const [localModel, setLocalModel] = useState<LocalModelInfo | null>(null);
  const [probing, setProbing] = useState(true);

  useEffect(() => {
    let cancelled = false;
    probe
      .detect()
      .then((detected) => {
        if (cancelled) return;
        setLocalModel(detected);
      })
      .catch(() => {
        if (!cancelled) setLocalModel(null);
      })
      .finally(() => {
        if (!cancelled) setProbing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [probe]);

  const localDisabled = busy || localModel === null;

  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <h2 id="onboarding-title">先选一下语音转写方式</h2>
        <p className="muted">
          三种都能随时在「设置 → 语音」里改。默认选「仅录音」，不需要任何配置、也不花一分钱。
        </p>

        <div className="option-list">
          <button
            type="button"
            className="option-card recommended"
            onClick={() => void onChosen('record-only')}
            disabled={busy}
          >
            <strong>A. 仅录音备忘（推荐，默认）</strong>
            <span className="muted">
              录音存本地，自己听、自己整理。不需要配置，不上传任何数据。
            </span>
          </button>

          <button
            type="button"
            className="option-card"
            onClick={() => void onChosen('cloud-stt')}
            disabled={busy}
          >
            <strong>B. 配置云端 STT</strong>
            <span className="muted">
              用自己的 API key 做语音转文字（按量计费，费用由你承担）。选完到「设置」里填地址与
              key。
            </span>
          </button>

          <button
            type="button"
            className="option-card"
            onClick={() => void onChosen('local-whisper')}
            disabled={localDisabled}
          >
            <strong>C. 使用本地模型（base，78MB，随应用发布）</strong>
            <span className="muted">
              {localModel
                ? `whisper.cpp · 完全离线，不上传音频，不花钱；已检测到 ${localModel.label}（${localModel.sizeMB}MB）。`
                : probing
                  ? 'whisper.cpp · 正在检测本地模型…（模型随应用发布，来源 ModelScope）'
                  : 'whisper.cpp · 未检测到本地模型，请先运行 npm run model:whisper（来源 ModelScope）'}
            </span>
          </button>
        </div>

        {error && <p className="error">{error}</p>}
        <p className="muted small">
          配置阶段不会发起任何真实模型调用；连通性自检只在你点按钮时发 1 个 token。
        </p>
      </section>
    </div>
  );
}
