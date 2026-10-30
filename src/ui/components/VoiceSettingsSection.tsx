import { useEffect, useMemo, useState } from 'react';
import type { CloudSttConfig, SelfTestState, VoiceMode, VoiceSettings } from '../../core/settings';
import { defaultVoiceSettings, runCloudSttSelfTest, saveVoiceSettings, validateCloudSttForm } from '../../core/settings';
import { detectLocalModel, type LocalModelInfo } from '../../adapters/asr/local-asr';
import type { ModelPack, PackProgress } from '../../adapters/asr/model-store';
import { LocalModelDialog } from './LocalModelDialog';
import { describeError } from '../format';
import { Dialog } from './Dialog';

/** 可用性探测可注入：生产用真实探测，测试里传假的不发任何请求 */
export interface LocalModelProbe {
  detect: () => Promise<LocalModelInfo | null>;
}

const DEFAULT_PROBE: LocalModelProbe = { detect: () => detectLocalModel() };

interface Props {
  /** 已保存的设置；null = 首次（还没选过） */
  initial: VoiceSettings | null;
  onSaved: (settings: VoiceSettings) => void;
  /** 本地模型探测（默认查缓存 + public/models/） */
  asrProbe?: LocalModelProbe;
  /** 模型下载器（测试里注入假的，不发真实请求） */
  download?: (id: ModelPack['id'], onProgress: (p: PackProgress) => void) => Promise<void>;
}

/**
 * 三种模式按**质量从低到高**排（R6 §3.1）。
 *
 * 委托人原话：「排序反了」。旧顺序是 云端 / 本地 / 仅录音（按实现难度排的），
 * 对用户来说应该从最省事的往上走：只留录音 → 本地转写 → 云端转写。
 */
const MODES: VoiceMode[] = ['record-only', 'local-whisper', 'cloud-stt'];

/** 选项标题：一句话说清「这个模式到底做什么」 */
const CARD_LABELS: Record<VoiceMode, string> = {
  'record-only': '仅作记录',
  'local-whisper': '本地模型',
  'cloud-stt': '云端模型',
};

/**
 * 模型缺失时的提示。
 *
 * ⚠️ 这两句都是既有断言锁死的文本，**一个字都不能动**
 * （`offline.test.tsx` 锁「M2.5 提供；模型约 100–300MB，下载源已定为 ModelScope」，
 * `asr-ui.test.tsx` 锁「未找到本地模型，请先运行 npm run model:whisper」）。
 * 卡片里会被省略号截断，但读屏和测试拿到的都是完整文本。
 */
const LOCAL_MODEL_MISSING_HINT =
  '还没下载（229MB，中文最准）。点右边「配置…」下载；' +
  '不想下载就先用「云端模型」或「仅作记录」。';

function localModelLabel(model: LocalModelInfo): string {
  const suffix = model.note ? `，${model.note}` : '';
  return `使用本地模型（${model.label}，${model.sizeMB}MB${suffix}）`;
}

/** 云端 STT 预设：只填地址和模型名，key 仍然用户自己填（不代填、不代存） */
const STT_PRESETS: { id: string; name: string; baseUrl: string; model: string; fit: string }[] = [
  {
    id: 'sensevoice',
    name: '硅基流动 · SenseVoice',
    baseUrl: 'https://api.siliconflow.cn/v1/audio/transcriptions',
    model: 'FunAudioLLM/SenseVoiceSmall',
    fit: '中文 / 粤语 / 中英混说',
  },
  {
    id: 'openai-whisper',
    name: 'OpenAI · whisper-1',
    baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'whisper-1',
    fit: '英文 / 需要时间轴',
  },
  {
    id: 'relay',
    name: '中转站（任意兼容地址）',
    baseUrl: '',
    model: 'whisper-1',
    fit: '没有官方 key 时用',
  },
];

function cardDesc(
  candidate: VoiceMode,
  localModel: LocalModelInfo | null,
  cloudConfigured: boolean,
): string {
  if (candidate === 'record-only') return '只存录音，不转文字';
  if (candidate === 'cloud-stt') {
    return cloudConfigured ? '转写更准，按量计费（key 只存在这台设备）' : '转写更准，需自备 key，按量计费';
  }
  return localModel ? `${localModelLabel(localModel)}；离线，不联网、不花钱` : LOCAL_MODEL_MISSING_HINT;
}

/**
 * 「设置 → 语音识别」区块（R6 重做）。
 *
 * 与 P1 版的区别：
 * 1. 顺序改成 仅作记录 → 本地模型 → 云端模型（质量从低到高）；
 * 2. 三个选项**竖排成半行小卡**（每项一行：单选框 + 名称 + 一句小字），整卡 ≤200px；
 * 3. 默认选中「本地模型」（78MB 随包发布，不用白不用）；
 * 4. 切走 / 切回本地模型各弹一次提醒（78MB 的去留）；
 * 5. 云端 STT 的三个字段不再插进页面，改成「配置…」弹窗。
 *
 * 行为边界没变：`保存语音设置` 仍然是一次显式保存；「测试连通」仍然只做表单校验
 * （M2 契约：不为验收发真实付费请求）。
 */
export function VoiceSettingsSection({ initial, onSaved, asrProbe, download }: Props) {
  const probe = asrProbe ?? DEFAULT_PROBE;
  const [mode, setMode] = useState<VoiceMode>(initial?.mode ?? defaultVoiceSettings().mode);
  const [baseUrl, setBaseUrl] = useState(initial?.cloudStt?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(initial?.cloudStt?.apiKey ?? '');
  const [model, setModel] = useState(initial?.cloudStt?.model ?? '');
  const [selfTest, setSelfTest] = useState<SelfTestState>({ status: 'idle' });
  const [localModel, setLocalModel] = useState<LocalModelInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 云端配置弹窗 */
  const [cloudOpen, setCloudOpen] = useState(false);
  /** 本地模型管理弹窗 */
  const [localOpen, setLocalOpen] = useState(false);
  /** 当前选中的本地模型 id（下载/切换后更新，用于弹窗里的「使用中」） */
  const [activeLocalId, setActiveLocalId] = useState<string | null>(initial?.localModelId ?? null);

  // 只在挂载时探测一次：默认「不可用」，探测成功再点亮（首帧文案因此是确定的，不会闪）
  useEffect(() => {
    let cancelled = false;
    probe
      .detect()
      .then((detected) => {
        if (!cancelled) setLocalModel(detected);
      })
      .catch(() => {
        if (!cancelled) setLocalModel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [probe]);

  const cloudConfig: CloudSttConfig = { baseUrl, apiKey, model };
  const cloudErrors = useMemo(() => validateCloudSttForm(cloudConfig), [baseUrl, apiKey, model]);
  const cloudConfigured = Object.keys(cloudErrors).length === 0;

  /**
   * 选一个模式。
   *
   * 早先「本地 → 仅记录」会弹一次「模型占 78MB，要切吗」——现在模型存在浏览器缓存里、
   * 在「配置…」里随时能删，这个弹窗只是每次拦一下，委托人明确要求去掉。
   */
  function pickMode(next: VoiceMode): void {
    if (next === mode) return;
    setMode(next);
  }

  async function handleSelfTest() {
    // 先把状态切到 validating，让"点下去有反应"可被观察到
    setSelfTest({ status: 'validating', message: '正在校验表单…（不会发起网络请求）' });
    const result = await runCloudSttSelfTest(cloudConfig);
    setSelfTest(result);
  }

  /** 选一个本地模型作为当前模型：切模式 + 存 id + 关弹窗 */
  async function handleUseLocal(pack: ModelPack) {
    setLocalModel({ id: pack.id as LocalModelInfo['id'], label: pack.label, sizeMB: pack.sizeMB });
    setActiveLocalId(pack.id);
    setMode('local-whisper');
    setLocalOpen(false);
    try {
      const saved = await saveVoiceSettings({ mode: 'local-whisper', localModelId: pack.id });
      onSaved(saved);
      setNotice('已切换到本地模型，以后录音会自动转文字。');
    } catch (caught) {
      setError(describeError(caught));
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveVoiceSettings(
        mode === 'cloud-stt' ? { mode, cloudStt: cloudConfig } : { mode },
      );
      onSaved(saved);
      setNotice('已保存。随时可以回来改。');
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSaving(false);
    }
  }

  const saveBlocked = mode === 'cloud-stt' && !cloudConfigured;

  return (
    <section className="card" data-block="voice">
      <h3>语音识别</h3>
      <p className="settings-block-sub">
        本地模型（离线可用、需下载），云端模型（需联网、按量计费）。
      </p>
      <div className="voice-options">
        {MODES.map((candidate) => {
          const isLocal = candidate === 'local-whisper';
          const localDisabled = isLocal && localModel === null;
          const isCloud = candidate === 'cloud-stt';
          return (
            <div className="voice-row" key={candidate}>
              <label className={`voice-opt ${localDisabled ? 'disabled' : ''}`}>
                <input
                  type="radio"
                  name="voice-mode"
                  value={candidate}
                  checked={mode === candidate}
                  onChange={() => pickMode(candidate)}
                  disabled={localDisabled}
                />
                <span className="voice-opt-title">
                  {CARD_LABELS[candidate]}
                  {isCloud && !cloudConfigured && (
                    <span className="voice-opt-tag is-warn">未配置</span>
                  )}
                </span>
                <span className="voice-opt-desc">
                  {cardDesc(candidate, localModel, cloudConfigured)}
                </span>
              </label>
              {isCloud && (
                <button
                  type="button"
                  className="voice-opt-link"
                  onClick={() => {
                    setSelfTest({ status: 'idle' });
                    setCloudOpen(true);
                  }}
                >
                  配置…
                </button>
              )}
              {isLocal && (
                <button
                  type="button"
                  className="voice-opt-link"
                  data-testid="voice-local-config"
                  onClick={() => setLocalOpen(true)}
                >
                  配置…
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="button-row">
        <button
          type="button"
          className="button primary"
          onClick={() => void handleSave()}
          disabled={saving || saveBlocked}
        >
          {saving ? '保存中…' : '保存语音设置'}
        </button>
        {saveBlocked && <span className="error small">云端还没配置：先点「配置…」填好地址与 key</span>}
        {notice && <span className="success small">{notice}</span>}
        {error && <span className="error small">{error}</span>}
      </div>

      {/* ---- 本地模型管理：下载 / 切换 / 删除 ---- */}
      <LocalModelDialog
        open={localOpen}
        onDismiss={() => setLocalOpen(false)}
        activeId={activeLocalId ?? localModel?.id ?? null}
        onUse={(pack) => void handleUseLocal(pack)}
        download={download}
      />

      {/* ---- 云端 STT 配置：三栏不再插进页面，改成弹窗 ---- */}
      <Dialog
        open={cloudOpen}
        title="云端语音识别配置"
        label="云端 STT 配置"
        onDismiss={() => setCloudOpen(false)}
        actions={[
          { label: '关闭', onClick: () => setCloudOpen(false) },
          {
            label: '保存并关闭',
            kind: 'primary',
            onClick: () => {
              setMode('cloud-stt');
              setCloudOpen(false);
            },
            testId: 'cloud-stt-apply',
          },
        ]}
      >
        <p className="modal-sub">
          走你自己的 key（OpenAI 兼容的 /audio/transcriptions）。key 只存在这台设备的浏览器里。
        </p>
        <div className="stt-presets">
          <span className="stt-presets-title">没配过？从这三个里挑一个：</span>
          {STT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="stt-preset"
              data-testid={`stt-preset-${preset.id}`}
              onClick={() => {
                setBaseUrl(preset.baseUrl);
                setModel(preset.model);
                setSelfTest({ status: 'idle' });
              }}
            >
              <span className="stt-preset-name">{preset.name}</span>
              <span className="stt-preset-fit">{preset.fit}</span>
            </button>
          ))}
          <span className="stt-presets-note">
            中文、粤语、中英混说选 SenseVoice（便宜、快、自带标点）；
            纯英文或要时间轴选 whisper-1；想更准但要按分钟付费选 gpt-4o-transcribe。
          </span>
        </div>
        <div className="stt-form">
          <label className="field">
            <span>服务地址（base_url）</span>
            <input
              type="text"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1/audio/transcriptions"
            />
            {selfTest.fieldErrors?.baseUrl && (
              <span className="error small">{selfTest.fieldErrors.baseUrl}</span>
            )}
          </label>

          <label className="field">
            <span>API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-..."
              autoComplete="off"
            />
            {selfTest.fieldErrors?.apiKey && (
              <span className="error small">{selfTest.fieldErrors.apiKey}</span>
            )}
          </label>

          <label className="field">
            <span>模型</span>
            <input
              type="text"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="whisper-1"
            />
            {selfTest.fieldErrors?.model && (
              <span className="error small">{selfTest.fieldErrors.model}</span>
            )}
          </label>

          <div className="button-row">
            <button
              type="button"
              className="button"
              onClick={() => void handleSelfTest()}
              disabled={selfTest.status === 'validating'}
            >
              {selfTest.status === 'validating' ? '校验中…' : '测试连通'}
            </button>
            {selfTest.status !== 'idle' && (
              <span className={selfTest.status === 'invalid' ? 'error small' : 'success small'}>
                {selfTest.message}
              </span>
            )}
          </div>
        </div>
      </Dialog>
    </section>
  );
}
