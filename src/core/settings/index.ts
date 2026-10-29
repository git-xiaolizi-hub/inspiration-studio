/**
 * 语音设置（M2，裁决 1 的第一版落地）。
 *
 * 三个模式：
 * - record-only（默认）：只录音备忘，不需要任何配置；
 * - cloud-stt：配置 base_url / api_key / model。**M2 只做表单校验 + mock 状态机**，
 *   「测试连通」不发任何真实请求（CHARTER §13.2：AI 不得为验收发起付费调用）；
 * - local-whisper：随应用发布的本地模型（M2.5 落地），离线可用、不花钱。
 *   模型文件不进 git，用 `npm run model:whisper` 拉到 public/models/ 后才会点亮。
 *
 * 持久化在 settings 表：`{ key: 'voice', value: VoiceSettings, updatedAt }`。
 */
import { getSetting, putSetting } from '../storage';

export const VOICE_SETTING_KEY = 'voice';

export type VoiceMode = 'record-only' | 'cloud-stt' | 'local-whisper';

export interface CloudSttConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface VoiceSettings {
  mode: VoiceMode;
  cloudStt?: CloudSttConfig;
  updatedAt: number;
}

/**
 * 默认值：本地模型（R6 起）。
 *
 * 为什么改：`public/models/whisper-base` **78MB 已经随包发布**，
 * 默认却停在「只录音」，等于白占体积、还要用户自己去发现这功能。
 * 委托人的口径：「默认就该用它」；想只留录音的人再切到 `record-only`（切换时会提醒 78MB）。
 *
 * 注意：老备份里存的仍是显式的 `record-only`，读取时以库里的值为准，
 * 这个默认值只对「从未设置过」的库生效。
 */
export function defaultVoiceSettings(): VoiceSettings {
  return { mode: 'local-whisper', updatedAt: 0 };
}

export const VOICE_MODE_LABELS: Record<VoiceMode, string> = {
  'record-only': '仅录音备忘（默认，无需配置）',
  'cloud-stt': '配置云端 STT（自带 key，按量计费）',
  'local-whisper': '本地识别 whisper（M2.5 落地，离线运行）',
};

export function isVoiceMode(value: unknown): value is VoiceMode {
  return value === 'record-only' || value === 'cloud-stt' || value === 'local-whisper';
}

/** 读取语音设置；返回 null 表示"从未设置过"（首次启动要引导） */
export async function getVoiceSettings(): Promise<VoiceSettings | null> {
  const row = await getSetting(VOICE_SETTING_KEY);
  const value = row?.value;
  if (!value || typeof value !== 'object') return null;

  const candidate = value as Partial<VoiceSettings>;
  if (!isVoiceMode(candidate.mode)) return null;

  const settings: VoiceSettings = {
    mode: candidate.mode,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
  };
  if (candidate.cloudStt && typeof candidate.cloudStt === 'object') {
    const cloud = candidate.cloudStt as Partial<CloudSttConfig>;
    settings.cloudStt = {
      baseUrl: typeof cloud.baseUrl === 'string' ? cloud.baseUrl : '',
      apiKey: typeof cloud.apiKey === 'string' ? cloud.apiKey : '',
      model: typeof cloud.model === 'string' ? cloud.model : '',
    };
  }
  return settings;
}

/** 保存语音设置（局部更新：不传的字段沿用已存在的值） */
export async function saveVoiceSettings(
  patch: Partial<Omit<VoiceSettings, 'updatedAt'>> & { mode: VoiceMode },
): Promise<VoiceSettings> {
  const existing = await getVoiceSettings();
  const next: VoiceSettings = {
    mode: patch.mode,
    updatedAt: Date.now(),
  };

  const cloudStt = patch.cloudStt ?? existing?.cloudStt;
  if (cloudStt) next.cloudStt = cloudStt;

  await putSetting({
    key: VOICE_SETTING_KEY,
    value: next,
    updatedAt: next.updatedAt,
  });
  return next;
}

/* ------------------------------------------------------------------ */
/* 云端 STT 表单校验 + 自检状态机（mock，不发真实请求）                 */
/* ------------------------------------------------------------------ */

export type SelfTestStatus = 'idle' | 'validating' | 'validated' | 'invalid';

export interface SelfTestState {
  status: SelfTestStatus;
  /** 给人看的一句话结论 */
  message?: string;
  /** 逐字段错误，UI 直接挂在输入框下面 */
  fieldErrors?: Partial<Record<keyof CloudSttConfig, string>>;
}

/** 校验表单（纯函数，测试直接断言） */
export function validateCloudSttForm(
  config: Partial<CloudSttConfig>,
): Partial<Record<keyof CloudSttConfig, string>> {
  const errors: Partial<Record<keyof CloudSttConfig, string>> = {};
  const baseUrl = (config.baseUrl ?? '').trim();
  const apiKey = (config.apiKey ?? '').trim();
  const model = (config.model ?? '').trim();

  if (!baseUrl) {
    errors.baseUrl = '请填写服务地址，例如 https://api.example.com/v1/audio/transcriptions';
  } else if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
    errors.baseUrl = '地址必须以 http:// 或 https:// 开头';
  }

  if (!apiKey) {
    errors.apiKey = '请填写 API key';
  } else if (apiKey.length < 8) {
    errors.apiKey = 'API key 太短，检查是否复制完整';
  }

  if (!model) {
    errors.model = '请填写模型名，例如 whisper-1';
  }

  return errors;
}

/** 真实探测函数签名：M2 不实现，M3 接 AI 适配器时注入 */
export type SttProbe = (config: CloudSttConfig) => Promise<{ ok: boolean; message?: string }>;

/**
 * 「测试连通」的状态机。
 *
 * M2 的约束：即使按钮被点，也**不发起任何网络请求**。
 * - 不传 probe：只做表单校验，通过后返回 validated + 明确文案；
 * - 传 probe（仅测试注入 mock）：走 validating → validated/invalid 两条分支，
 *   用来验证状态机本身正确，而不是验证厂商接口。
 */
export async function runCloudSttSelfTest(
  config: Partial<CloudSttConfig>,
  deps: { probe?: SttProbe } = {},
): Promise<SelfTestState> {
  const fieldErrors = validateCloudSttForm(config);
  if (Object.keys(fieldErrors).length > 0) {
    return {
      status: 'invalid',
      message: '表单没填完，先补齐下面标出的字段',
      fieldErrors,
    };
  }

  const normalized: CloudSttConfig = {
    baseUrl: (config.baseUrl ?? '').trim(),
    apiKey: (config.apiKey ?? '').trim(),
    model: (config.model ?? '').trim(),
  };

  if (!deps.probe) {
    return {
      status: 'validated',
      message: '表单校验通过。M2 不会发起真实请求；真正的连通性检查在 M3 接入后提供。',
    };
  }

  try {
    const result = await deps.probe(normalized);
    if (result.ok) {
      return { status: 'validated', message: result.message ?? '连通性检查通过（mock）' };
    }
    return { status: 'invalid', message: result.message ?? '连通性检查失败（mock）' };
  } catch {
    return { status: 'invalid', message: '连通性检查失败（mock）：请求异常' };
  }
}
