import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, destroyDatabase } from '../storage';
import {
  defaultVoiceSettings,
  getVoiceSettings,
  runCloudSttSelfTest,
  saveVoiceSettings,
  validateCloudSttForm,
  VOICE_MODE_LABELS,
} from './index';

beforeEach(async () => {
  await destroyDatabase();
});

afterEach(async () => {
  await closeDatabase();
});

const VALID_STT = {
  baseUrl: 'https://api.example.com/v1/audio/transcriptions',
  apiKey: 'sk-test-1234567890',
  model: 'whisper-1',
};

describe('语音设置持久化', () => {
  it('首次启动没有设置（返回 null，用于触发引导）', async () => {
    expect(await getVoiceSettings()).toBeNull();
  });

  it('默认选「本地模型」（78MB 随包发布），保存后能读回', async () => {
    // R6：默认值 record-only → local-whisper（模型 78MB 已随应用发布，默认不用等于白占体积）
    expect(defaultVoiceSettings().mode).toBe('local-whisper');

    await saveVoiceSettings({ mode: 'record-only' });

    const settings = await getVoiceSettings();
    expect(settings?.mode).toBe('record-only');
    expect(settings?.updatedAt).toBeGreaterThan(0);

    // 关闭再开库（≈ 刷新页面）后仍在
    await closeDatabase();
    expect((await getVoiceSettings())?.mode).toBe('record-only');
  });

  it('切到云端 STT 保存配置，再切回 A 也不丢配置', async () => {
    await saveVoiceSettings({ mode: 'cloud-stt', cloudStt: VALID_STT });
    expect((await getVoiceSettings())?.cloudStt?.model).toBe('whisper-1');

    await saveVoiceSettings({ mode: 'record-only' });
    const settings = await getVoiceSettings();
    expect(settings?.mode).toBe('record-only');
    expect(settings?.cloudStt).toEqual(VALID_STT);
  });

  it('三个模式都有中文标签', () => {
    expect(VOICE_MODE_LABELS['record-only']).toContain('仅录音');
    expect(VOICE_MODE_LABELS['cloud-stt']).toContain('云端 STT');
    expect(VOICE_MODE_LABELS['local-whisper']).toContain('M2.5');
  });
});

describe('云端 STT 表单校验', () => {
  it('合法表单没有错误', () => {
    expect(validateCloudSttForm(VALID_STT)).toEqual({});
  });

  it('空表单逐字段报错', () => {
    const errors = validateCloudSttForm({});
    expect(errors.baseUrl).toBeTruthy();
    expect(errors.apiKey).toBeTruthy();
    expect(errors.model).toBeTruthy();
  });

  it('地址必须以 http(s) 开头，key 不能太短', () => {
    const errors = validateCloudSttForm({ baseUrl: 'api.example.com', apiKey: 'sk-1', model: 'x' });
    expect(errors.baseUrl).toContain('http');
    expect(errors.apiKey).toContain('太短');
  });
});

describe('「测试连通」状态机（mock，不发真实请求）', () => {
  it('不注入 probe 时只做表单校验，并明确告知不发请求', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const state = await runCloudSttSelfTest(VALID_STT);

    expect(state.status).toBe('validated');
    expect(state.message).toContain('M2 不会发起真实请求');
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('表单不合法 → invalid + 字段错误，同样不发请求', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const state = await runCloudSttSelfTest({ baseUrl: 'ftp://x', apiKey: '', model: '' });

    expect(state.status).toBe('invalid');
    expect(state.fieldErrors?.apiKey).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('注入 mock probe：成功 → validated', async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true, message: 'mock 通了' });
    const state = await runCloudSttSelfTest(VALID_STT, { probe });

    expect(state.status).toBe('validated');
    expect(state.message).toBe('mock 通了');
    expect(probe).toHaveBeenCalledWith(VALID_STT);
  });

  it('注入 mock probe：失败 / 抛异常 → invalid', async () => {
    const failing = await runCloudSttSelfTest(VALID_STT, {
      probe: async () => ({ ok: false, message: 'mock 401' }),
    });
    expect(failing.status).toBe('invalid');
    expect(failing.message).toBe('mock 401');

    const throwing = await runCloudSttSelfTest(VALID_STT, {
      probe: async () => {
        throw new Error('boom');
      },
    });
    expect(throwing.status).toBe('invalid');
    expect(throwing.message).toContain('请求异常');
  });
});
