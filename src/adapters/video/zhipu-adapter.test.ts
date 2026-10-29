/**
 * 智谱 CogVideoX-Flash 适配器判据（M4c §4.3 的 12–19 条；全部 mock server，零真实网络）。
 *
 * 12 提交：路径 `/videos/generations`、Bearer、body **只含确认过的字段**
 * 13 轮询三态 + 状态大小写不敏感
 * 14 429/1305 → 指数退避重试，间隔递增，最终成功
 * 15 重试耗尽 → `rate_limited` 可读错误（**不是** `unknown`）
 * 16 能力裁剪：`references.videos` → 显式报错且一个请求都不发
 * 17 能力裁剪：`draft_mode` → 同上
 * 18 结果 URL：三种响应形态 + 全失败给可读错误
 * 19 免费通道记账：`actualCost === 0`
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ArkVideoAdapter } from './ark-adapter';
import { ZhipuVideoAdapter, isFreeTierBusy, parseZhipuTask } from './zhipu-adapter';
import { requireZhipuVideoResult } from './zhipu-extract';
import { actualCostForChannel, adapterForModel } from './channels';
import { FREE_CHANNEL_CAPABILITIES, PAID_CHANNEL_CAPABILITIES } from './capabilities';
import { isVideoError } from './errors';
import type { VideoGenerationRequest, ZhipuAdapterConfig, ZhipuRetryInfo } from './types';
import { nodeFetch, startMockServer } from '../../test/mock-http-server';
import type { MockHandler, MockServer } from '../../test/mock-http-server';

const JSON_HEADERS = { 'content-type': 'application/json' };
const VIDEO_URL = 'https://cdn.example.com/zhipu/generated.mp4';

function replyJson(body: unknown, status = 200): MockHandler {
  return (_request, response) => {
    response.writeHead(status, JSON_HEADERS);
    response.end(JSON.stringify(body));
  };
}

/** 免费池拥挤的实测原文（任务书 §3） */
const BUSY_BODY = { error: { code: '1305', message: '该模型当前访问量过大，请您稍后再试' } };

let server: MockServer | null = null;

async function withServer<T>(
  handlers: Record<string, MockHandler>,
  run: (target: MockServer) => Promise<T>,
): Promise<T> {
  server = await startMockServer(handlers);
  try {
    return await run(server);
  } finally {
    await server.close();
    server = null;
  }
}

function makeAdapter(
  target: MockServer,
  overrides: Partial<ZhipuAdapterConfig> = {},
): { adapter: ZhipuVideoAdapter; sleeps: number[]; retries: ZhipuRetryInfo[] } {
  const sleeps: number[] = [];
  const retries: ZhipuRetryInfo[] = [];
  const adapter = new ZhipuVideoAdapter({
    apiKey: 'zhipu-test-key',
    baseUrl: target.baseUrl,
    pollIntervalMs: 0,
    // 抖动给 0 → 等待时间确定，才能断言"间隔递增"
    random: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onRetry: (info) => retries.push(info),
    fetchImpl: (input, init) => {
      if (input.startsWith(target.baseUrl)) return nodeFetch(input, init);
      return Promise.reject(new Error(`测试里出现了未预期的请求：${input}`));
    },
    ...overrides,
  });
  return { adapter, sleeps, retries };
}

function baseRequest(overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest {
  return {
    prompt: '一只猫在雨里走，电影感',
    params: { duration: 5, resolution: '720p', ratio: '16:9' },
    ...overrides,
  };
}

afterEach(() => {
  Reflect.deleteProperty(URL, 'createObjectURL');
});

describe('判据 12：提交（路径 / 鉴权 / 只含确认过的字段）', () => {
  it('POST /videos/generations，带 Bearer，body 字段集合与任务书 §3 一致', async () => {
    await withServer({ '/videos/generations': replyJson({ id: 'zp-1', task_status: 'PROCESSING' }) }, async (target) => {
      const { adapter } = makeAdapter(target);
      await expect(adapter.submit(baseRequest())).resolves.toEqual({ task_id: 'zp-1' });

      expect(target.hits).toHaveLength(1);
      const hit = target.hits[0];
      expect(hit.method).toBe('POST');
      expect(hit.path).toBe('/videos/generations');
      expect(hit.headers.authorization).toBe('Bearer zhipu-test-key');

      const body = JSON.parse(hit.body) as Record<string, unknown>;
      // 只含确认过的字段；duration 默认不传（未验证），draft/参考视频一律不出现
      expect(Object.keys(body).sort()).toEqual(
        ['fps', 'model', 'movement_amplitude', 'prompt', 'quality', 'size', 'with_audio'].sort(),
      );
      expect(body).toMatchObject({
        model: 'cogvideox-flash',
        prompt: '一只猫在雨里走，电影感',
        quality: 'speed',
        size: '1280x720',
        fps: 30,
        with_audio: false,
        movement_amplitude: 'auto',
      });
      expect(body).not.toHaveProperty('duration');
    });
  });

  it('首尾帧：单首帧 → image_url 是字符串；首+尾 → 数组 [首, 尾]（只收公网 URL）', async () => {
    await withServer({ '/videos/generations': replyJson({ id: 'zp-frames' }) }, async (target) => {
      const { adapter } = makeAdapter(target);

      await adapter.submit(
        baseRequest({
          keyframes: [{ position: 'first', image_url: 'https://img.example.com/a.png' }],
        }),
      );
      const single = JSON.parse(target.hits[0].body) as { image_url?: unknown };
      expect(single.image_url).toBe('https://img.example.com/a.png');

      await adapter.submit(
        baseRequest({
          keyframes: [
            { position: 'first', image_url: 'https://img.example.com/a.png' },
            { position: 'last', image_url: 'https://img.example.com/b.png' },
          ],
        }),
      );
      const pair = JSON.parse(target.hits[1].body) as { image_url?: unknown };
      expect(pair.image_url).toEqual([
        'https://img.example.com/a.png',
        'https://img.example.com/b.png',
      ]);
    });
  });

  it('data URL / 本地文件形态的图片 → 可读错误且不发请求（是否支持 data URL 未验证）', async () => {
    await withServer({ '/videos/generations': replyJson({ id: 'never' }) }, async (target) => {
      const { adapter } = makeAdapter(target);
      try {
        await adapter.submit(
          baseRequest({
            keyframes: [
              { position: 'first', asset: { kind: 'image', mimeType: 'image/png', size: 12, bytes: new Uint8Array(12) } },
            ],
          }),
        );
        throw new Error('应当抛错');
      } catch (error) {
        expect(isVideoError(error)).toBe(true);
        expect(isVideoError(error) && error.category).toBe('media_needs_public_url');
        expect(isVideoError(error) && error.message).toContain('公网 http(s)');
      }
      expect(target.hits).toHaveLength(0);
    });
  });
});

describe('判据 13：轮询三态 + 状态大小写不敏感', () => {
  it('PROCESSING → processing → SUCCESS，第三个带 video_result', async () => {
    const statuses: unknown[] = [
      { task_status: 'PROCESSING' },
      { task_status: 'processing' },
      { task_status: 'SUCCESS', video_result: [{ url: VIDEO_URL, cover_image_url: 'https://c/1.jpg' }] },
    ];
    let index = 0;
    const pollHandler: MockHandler = (_request, response) => {
      const body = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      response.writeHead(200, JSON_HEADERS);
      response.end(JSON.stringify(body));
    };

    await withServer(
      {
        '/videos/generations': replyJson({ id: 'zp-poll' }),
        '/async-result/zp-poll': pollHandler,
      },
      async (target) => {
        const { adapter } = makeAdapter(target);
        const { task_id } = await adapter.submit(baseRequest());

        const first = await adapter.poll(task_id);
        expect(first.status).toBe('running');
        expect(first.raw_status).toBe('PROCESSING');

        const second = await adapter.poll(task_id);
        expect(second.status).toBe('running');

        const third = await adapter.poll(task_id);
        expect(third.status).toBe('succeeded');
        expect(third.result?.video_url).toBe(VIDEO_URL);
        expect(third.url_path).toBe('video_result[0].url');

        const polls = target.hits.filter((hit) => hit.method === 'GET');
        expect(polls).toHaveLength(3);
        expect(polls[0].path).toBe('/async-result/zp-poll');
    expect(polls[0].headers.authorization).toBe('Bearer zhipu-test-key');
      },
    );
  });

  it('混合大小写与未知状态：SUCCESS/FAIL 认得出，未知按进行中并保留原文', () => {
    const ok = parseZhipuTask(
      { task_status: 'Success', video_result: { url: VIDEO_URL } },
      'zp-a',
    );
    expect(ok.status).toBe('succeeded');
    expect(ok.url_path).toBe('video_result.url');

    const fail = parseZhipuTask(
      { task_status: 'fail', error: { code: '1301', message: '内容不合规' } },
      'zp-b',
    );
    expect(fail.status).toBe('failed');
    expect(fail.error?.code).toBe('1301');

    const unknown = parseZhipuTask({ task_status: 'QUEUEING' }, 'zp-c');
    expect(unknown.status).toBe('running');
    expect(unknown.raw_status).toBe('QUEUEING');
  });
});

describe('判据 14：429/1305 → 指数退避 + 抖动，最终成功', () => {
  it('两次拥挤后成功：等待 5s → 15s（递增），重试通知带次数', async () => {
    let attempt = 0;
    const createHandler: MockHandler = (_request, response) => {
      attempt += 1;
      if (attempt <= 2) {
        response.writeHead(429, JSON_HEADERS);
        response.end(JSON.stringify(BUSY_BODY));
        return;
      }
      response.writeHead(200, JSON_HEADERS);
      response.end(JSON.stringify({ id: 'zp-retry', task_status: 'PROCESSING' }));
    };

    await withServer({ '/videos/generations': createHandler }, async (target) => {
      const { adapter, sleeps, retries } = makeAdapter(target);
      await expect(adapter.submit(baseRequest())).resolves.toEqual({ task_id: 'zp-retry' });

      expect(sleeps).toEqual([5_000, 15_000]);
      expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
      expect(retries.map((info) => info.attempt)).toEqual([1, 2]);
      expect(retries[0].delayMs).toBe(5_000);
      // 三次请求是同一端点：不是"换个错误端点"，而是同一个提交在排队
      expect(target.hits.filter((hit) => hit.path === '/videos/generations')).toHaveLength(3);
    });
  });

  it('抖动只增不减：random=1 时等待 = 基础值 × (1 + 0.2)', async () => {
    const createHandler: MockHandler = (_request, response) => {
      response.writeHead(429, JSON_HEADERS);
      response.end(JSON.stringify(BUSY_BODY));
    };
    await withServer({ '/videos/generations': createHandler }, async (target) => {
      const { adapter, sleeps } = makeAdapter(target, { maxRetries: 1, random: () => 1 });
      await expect(adapter.submit(baseRequest())).rejects.toThrowError(/拥挤/);
      expect(sleeps).toEqual([6_000]);
    });
  });

  it('isFreeTierBusy 认得 429 / 1305 / 中文 message 三种形态', () => {
    expect(isFreeTierBusy({ status: 429 })).toBe(true);
    expect(isFreeTierBusy({ status: 400, code: '1305' })).toBe(true);
    expect(isFreeTierBusy({ status: 400, text: '该模型当前访问量过大，请您稍后再试' })).toBe(true);
    expect(isFreeTierBusy({ status: 400, text: '参数错误' })).toBe(false);
  });
});

describe('判据 15：重试耗尽 → 可读错误（不是 unknown）', () => {
  it('连续 429：共 4 次请求（1 + 3 重试），错误归类 rate_limited 且文案说"拥挤"', async () => {
    const createHandler: MockHandler = (_request, response) => {
      response.writeHead(429, JSON_HEADERS);
      response.end(JSON.stringify(BUSY_BODY));
    };

    await withServer({ '/videos/generations': createHandler }, async (target) => {
      const { adapter, sleeps } = makeAdapter(target);
      try {
        await adapter.submit(baseRequest());
        throw new Error('应当抛错');
      } catch (error) {
        expect(isVideoError(error)).toBe(true);
        expect(isVideoError(error) && error.category).toBe('rate_limited');
        expect(isVideoError(error) && error.category).not.toBe('unknown');
        expect(isVideoError(error) && error.message).toContain('拥挤');
        expect(isVideoError(error) && error.retryable).toBe(true);
        expect(isVideoError(error) && error.nextStep).toContain('Seedance');
      }
      expect(sleeps).toEqual([5_000, 15_000, 45_000]);
      expect(target.hits).toHaveLength(4);
    });
  });
});

describe('判据 16 / 17：能力裁剪（显式报错，且不发任何请求）', () => {
  it('references.videos → "不支持视频参考"，零请求', async () => {
    await withServer({ '/videos/generations': replyJson({ id: 'never' }) }, async (target) => {
      const { adapter } = makeAdapter(target);
      try {
        await adapter.submit(
          baseRequest({ references: { videos: [{ role: 'motion', url: 'https://v.example.com/a.mp4' }] } }),
        );
        throw new Error('应当抛错');
      } catch (error) {
        expect(isVideoError(error) && error.category).toBe('unsupported_capability');
        expect(isVideoError(error) && error.message).toContain('不支持视频参考');
        expect(isVideoError(error) && error.nextStep).toContain('Seedance');
      }
      expect(target.hits).toHaveLength(0);
    });
  });

  it('draft_mode: true → "不支持样片模式"，零请求', async () => {
    await withServer({ '/videos/generations': replyJson({ id: 'never' }) }, async (target) => {
      const { adapter } = makeAdapter(target);
      try {
        await adapter.submit(
          baseRequest({ params: { duration: 5, resolution: '720p', ratio: '16:9', draft_mode: true } }),
        );
        throw new Error('应当抛错');
      } catch (error) {
        expect(isVideoError(error) && error.category).toBe('unsupported_capability');
        expect(isVideoError(error) && error.message).toContain('不支持样片模式');
      }
      expect(target.hits).toHaveLength(0);
    });
  });

  it('音频参考 / 参考图角色 / 1080p / 10 秒 都在本地被拒（不能悄悄降级）', async () => {
    await withServer({ '/videos/generations': replyJson({ id: 'never' }) }, async (target) => {
      const { adapter } = makeAdapter(target);
      const cases: Array<[string, VideoGenerationRequest]> = [
        ['音频参考', baseRequest({ references: { audio: [{ url: 'https://a.example.com/a.mp3' }] } })],
        [
          '参考图角色',
          baseRequest({
            references: {
              images: [{ role: 'character', url: 'https://img.example.com/a.png' }],
            },
          }),
        ],
        [
          '1080p',
          baseRequest({ params: { duration: 5, resolution: '1080p', ratio: '16:9' } }),
        ],
        ['10 秒', baseRequest({ params: { duration: 10, resolution: '720p', ratio: '16:9' } })],
      ];

      for (const [label, request] of cases) {
        try {
          await adapter.submit(request);
          throw new Error(`应当抛错：${label}`);
        } catch (error) {
          expect(isVideoError(error), label).toBe(true);
          const videoError = error as InstanceType<typeof Error> & { category?: string };
          expect(videoError.category, label).not.toBe('unknown');
        }
      }
      expect(target.hits).toHaveLength(0);
    });
  });
});

describe('判据 18：结果 URL 提取（三种形态 + 全失败可读错误）', () => {
  it('① video_result[0].url', () => {
    const result = requireZhipuVideoResult({ task_status: 'SUCCESS', video_result: [{ url: 'https://a/1.mp4' }] });
    expect(result.video_url).toBe('https://a/1.mp4');
    expect(result.url_path).toBe('video_result[0].url');
  });

  it('② data.video_result[0].url（被网关包了一层）', () => {
    const result = requireZhipuVideoResult({ task_status: 'SUCCESS', data: { video_result: [{ url: 'https://a/2.mp4' }] } });
    expect(result.video_url).toBe('https://a/2.mp4');
    expect(result.url_path).toBe('data.video_result[0].url');
  });

  it('③ 顶层 video_url（字符串或 {url}）', () => {
    expect(requireZhipuVideoResult({ task_status: 'SUCCESS', video_url: 'https://a/3.mp4' }).url_path).toBe('video_url');
    expect(requireZhipuVideoResult({ task_status: 'SUCCESS', video_url: { url: 'https://a/4.mp4' } }).video_url).toBe(
      'https://a/4.mp4',
    );
  });

  it('三种都取不到 → 可读错误，且说明"响应结构未验证"', () => {
    try {
      requireZhipuVideoResult({ task_status: 'SUCCESS', data: { foo: 'bar' } });
      throw new Error('应当抛错');
    } catch (error) {
      expect(isVideoError(error)).toBe(true);
      expect(isVideoError(error) && error.message).toContain('无法从响应中定位视频地址');
      expect(isVideoError(error) && error.message).toContain('未验证');
    }
  });
});

describe('判据 19：免费通道记账（actualCost === 0）', () => {
  it('免费通道恒为 0；付费通道仍按 usage 反算', () => {
    expect(actualCostForChannel(FREE_CHANNEL_CAPABILITIES, 0, 70, 7.56)).toBe(0);
    // 即使服务端真给了 token 数，免费通道也不该产生花费
    expect(actualCostForChannel(FREE_CHANNEL_CAPABILITIES, 123_456, 70, 7.56)).toBe(0);
    expect(actualCostForChannel(PAID_CHANNEL_CAPABILITIES, 108_000, 70, 7.56)).toBeCloseTo(7.56, 5);
    expect(actualCostForChannel(PAID_CHANNEL_CAPABILITIES, 0, 70, 7.56)).toBe(7.56);
  });
});

describe('M3R3 §3：模型 → 适配器（不再有「通道」概念）', () => {
  const fakeArk = {
    submit: async () => ({ task_id: 'ark' }),
    poll: async () => ({ task_id: 'ark', status: 'running' as const }),
    cancel: async () => undefined,
    downloadAndStore: async () => 'blob:x',
  };

  const fakeZhipu = {
    submit: async () => ({ task_id: 'zp' }),
    poll: async () => ({ task_id: 'zp', status: 'running' as const }),
    cancel: async () => undefined,
    downloadAndStore: async () => 'blob:y',
  };

  it('cogvideox* → 智谱适配器（cogvideox-flash 免费）；doubao-seedance* → 火山方舟（付费）', () => {
    const zhipu = adapterForModel({ modelId: 'cogvideox-flash' }, { zhipuAdapter: fakeZhipu });
    expect(zhipu.ok).toBe(true);
    if (!zhipu.ok) throw new Error('cogvideox-flash 应当可用');
    expect(zhipu.kind).toBe('zhipu');
    expect(zhipu.free).toBe(true);
    expect(zhipu.capabilities.paid).toBe(false);
    expect(zhipu.capabilities.supportsReferenceVideo).toBe(false);
    expect(zhipu.capabilities.supportsDraftMode).toBe(false);
    expect(zhipu.priceModel).toBe('cogvideox-flash');
    expect(zhipu.adapter).toBe(fakeZhipu);

    const ark = adapterForModel({ modelId: 'doubao-seedance-2-5-260628' }, { arkAdapter: fakeArk });
    expect(ark.ok).toBe(true);
    if (!ark.ok) throw new Error('seedance 应当可用');
    expect(ark.kind).toBe('ark');
    expect(ark.free).toBe(false);
    expect(ark.capabilities).toEqual(PAID_CHANNEL_CAPABILITIES);
    expect(ark.priceModel).toBe('doubao-seedance-2.5');
    expect(ark.adapter).toBe(fakeArk);
  });

  it('其它模型 → 可执行提示（本地部署的 minimax-h3 这一版没接）', () => {
    const result = adapterForModel({ modelId: 'minimax-h3', apiKey: 'k' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('minimax-h3 这一版不该有视频适配器');
    expect(result.reason).toContain('没有对应的视频适配器');
    expect(result.hint).toContain('该模型还没有视频适配器');
    expect(result.hint).toContain('minimax-h3');
    // 提示里必须给出「换成哪个」才叫可执行
    expect(result.hint).toContain('doubao-seedance-2-5-260628');
    expect(result.hint).toContain('cogvideox-flash');
  });

  it('不注入适配器时按模型所属连接的地址与 Key 真实构造；缺 Key 给提示而不是抛异常', () => {
    const missing = adapterForModel({ modelId: 'cogvideox-flash', baseUrl: 'https://x.example.com' });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('缺 Key 不该返回可用适配器');
    expect(missing.reason).toContain('API Key');
    expect(missing.hint).toContain('AI 配置');

    const zhipu = adapterForModel({
      modelId: 'cogvideox-flash',
      baseUrl: 'https://x.example.com',
      apiKey: 'k-zhipu',
    });
    expect(zhipu.ok).toBe(true);
    if (zhipu.ok) expect(zhipu.adapter).toBeInstanceOf(ZhipuVideoAdapter);

    const ark = adapterForModel({ modelId: 'doubao-seedance-2-5-260628', apiKey: 'k-ark' });
    expect(ark.ok).toBe(true);
    if (ark.ok) expect(ark.adapter).toBeInstanceOf(ArkVideoAdapter);
  });

  it('cogvideox-3 走智谱适配器，但不算免费（价格未核实就不按 0 元记账）', () => {
    const result = adapterForModel({ modelId: 'cogvideox-3' }, { zhipuAdapter: fakeZhipu });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('cogvideox-3 应当走智谱适配器');
    expect(result.kind).toBe('zhipu');
    expect(result.free).toBe(false);
    expect(result.capabilities.paid).toBe(true);
    expect(result.priceModel).toBe('cogvideox-3');
  });
});
