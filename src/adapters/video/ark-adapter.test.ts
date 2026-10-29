/**
 * Ark 适配器判据（mock server，全程零真实网络 —— CHARTER §13.2）。
 *
 * 覆盖 CHARTER §2 M4b 列的 5 项 + 任务书 §4.4 的 6 项：
 * 1 提交成功 → task_id（含 Authorization / body 形状）
 * 2 排队 → 运行 → 成功 + 视频 URL + usage
 * 3 下载到 IndexedDB + 24 小时到期提示（注入时钟）
 * 4 失败分类：余额不足 / 内容违规 / 素材格式错（+ 文档确证的参数冲突码）
 * 5/8 本地取消：不再发新轮询 + 标记 aborted
 * 6 素材分流（见 media.test.ts）
 * 7 请求体超限提前拒绝（不发请求）
 * 9 视频 URL 三形态提取 + 都取不到时报可读错误
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArkVideoAdapter, parseTask } from './ark-adapter';
import type { ArkAdapterConfig, VideoGenerationRequest } from './types';
import { VideoTaskRunner } from './task-runner';
import { artifactNotice, getVideoArtifact, isArtifactExpired } from './storage';
import { describeTask, isVideoError } from './errors';
import { requireVideoResult } from './extract';
import { nodeFetch, startMockServer } from '../../test/mock-http-server';
import type { MockHandler, MockServer } from '../../test/mock-http-server';

const JSON_HEADERS = { 'content-type': 'application/json' };
const VIDEO_URL = 'https://cdn.example.com/generated/video.mp4';

function replyJson(body: unknown, status = 200): MockHandler {
  return (_request, response) => {
    response.writeHead(status, JSON_HEADERS);
    response.end(JSON.stringify(body));
  };
}

/** 二进制响应桩（mock server 的 nodeFetch 只解文本，下载路径单独给一个 Response） */
function binaryResponse(bytes: Uint8Array, contentType = 'video/mp4'): Response {
  return {
    ok: true,
    status: 200,
    statusText: '',
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => '',
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

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
  overrides: Partial<ArkAdapterConfig> = {},
  videoBytes: Uint8Array = new Uint8Array([1, 2, 3, 4, 5]),
): ArkVideoAdapter {
  return new ArkVideoAdapter({
    apiKey: 'test-key',
    baseUrl: target.baseUrl,
    pollIntervalMs: 0,
    fetchImpl: (input, init) => {
      if (input.startsWith(target.baseUrl)) return nodeFetch(input, init);
      if (input === VIDEO_URL) return Promise.resolve(binaryResponse(videoBytes));
      return Promise.reject(new Error(`测试里出现了未预期的请求：${input}`));
    },
    ...overrides,
  });
}

function baseRequest(overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest {
  return {
    prompt: '一只猫在雨里走，电影感',
    params: { duration: 5, resolution: '720p', ratio: 'adaptive' },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(URL, 'createObjectURL');
});

/**
 * jsdom 不实现 `URL.createObjectURL`（与 `navigator.storage` 同类缺口，见 seat-notes §1）。
 * 这里补一个**只返回 blob: 前缀**的桩：产品代码仍走标准 API，测试只补环境能力。
 */
function stubCreateObjectURL(): void {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob) => `blob:mock/${blob.size}`,
  });
}

describe('判据 1：提交成功 → task_id', () => {
  it('POST /contents/generations/tasks，带 Bearer，body 形状与任务书 §3 一致', async () => {
    await withServer({ '/contents/generations/tasks': replyJson({ id: 'task-abc' }) }, async (target) => {
      const adapter = makeAdapter(target);
      const result = await adapter.submit(baseRequest());

      expect(result).toEqual({ task_id: 'task-abc' });
      expect(target.hits).toHaveLength(1);
      const hit = target.hits[0];
      expect(hit.method).toBe('POST');
      expect(hit.headers.authorization).toBe('Bearer test-key');
      const body = JSON.parse(hit.body) as Record<string, unknown>;
      expect(body.model).toBe('doubao-seedance-2-5-260628');
      expect(body.content).toEqual([{ type: 'text', text: '一只猫在雨里走，电影感' }]);
      expect(body).toMatchObject({
        ratio: 'adaptive',
        duration: 5,
        resolution: '720p',
        draft: false,
        watermark: false,
        generate_audio: true,
      });
    });
  });

  it('创建响应里 id 的字段名未验证：id / task_id / data.id 都认，并记录命中路径', async () => {
    await withServer({ '/contents/generations/tasks': replyJson({ data: { id: 'from-data' } }) }, async (target) => {
      const adapter = makeAdapter(target);
      await expect(adapter.submit(baseRequest())).resolves.toEqual({ task_id: 'from-data' });
    });

    await withServer({ '/contents/generations/tasks': replyJson({ task_id: 'from-snake' }) }, async (target) => {
      const adapter = makeAdapter(target);
      await expect(adapter.submit(baseRequest())).resolves.toEqual({ task_id: 'from-snake' });
    });
  });

  it('响应里找不到任务 ID → 可读错误（不静默返回空）', async () => {
    await withServer({ '/contents/generations/tasks': replyJson({ status: 'ok' }) }, async (target) => {
      const adapter = makeAdapter(target);
      await expect(adapter.submit(baseRequest())).rejects.toThrowError(/找不到任务 ID/);
    });
  });

  it('没有 API Key 时构造即失败（更早暴露）', () => {
    expect(() => new ArkVideoAdapter({ apiKey: '  ' })).toThrowError(/缺少火山方舟 API Key/);
  });
});

describe('判据 2：排队 → 运行 → 成功（含视频地址与用量）', () => {
  it('三次轮询依次返回 queued / running / succeeded', async () => {
    const statuses = [
      { status: 'queued' },
      { status: 'running' },
      {
        status: 'succeeded',
        content: [{ type: 'video_url', video_url: { url: VIDEO_URL } }],
        usage: { completion_tokens: 648_000 },
      },
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
        '/contents/generations/tasks': replyJson({ id: 'task-poll' }),
        '/contents/generations/tasks/task-poll': pollHandler,
      },
      async (target) => {
        const adapter = makeAdapter(target);
        const { task_id } = await adapter.submit(baseRequest());

        const first = await adapter.poll(task_id);
        expect(first.status).toBe('queued');
        const second = await adapter.poll(task_id);
        expect(second.status).toBe('running');
        const third = await adapter.poll(task_id);
        expect(third.status).toBe('succeeded');
        expect(third.result?.video_url).toBe(VIDEO_URL);
        expect(third.result?.usage.completion_tokens).toBe(648_000);
        expect(third.url_path).toBe('content[0].video_url.url');

        // 轮询用的必须是 GET + 同一个 task id
        const polls = target.hits.filter((hit) => hit.method === 'GET');
        expect(polls).toHaveLength(3);
        expect(polls[0].path).toBe('/contents/generations/tasks/task-poll');
        expect(polls[0].headers.authorization).toBe('Bearer test-key');
      },
    );
  });

  it('未知状态按"进行中"处理，但原始状态原样保留（任务书 §3）', () => {
    const task = parseTask({ status: 'processing', progress: 40 }, 'task-x');
    expect(task.status).toBe('running');
    expect(task.raw_status).toBe('processing');
    expect(task.progress).toBe(40);
  });

  it('failed 状态带 error，由 describeTask 翻译（不在适配器里假装知道错误码全集）', () => {
    const task = parseTask({ status: 'failed', error: { code: 'X', message: 'y' } }, 'task-y');
    expect(task.status).toBe('failed');
    expect(task.error).toEqual({ code: 'X', message: 'y' });
  });
});

describe('判据 3 + 10：结果落盘 IndexedDB 与 24 小时到期提示（注入时钟）', () => {
  it('downloadAndStore 存进本地库、返回 blob URL，并记录 24 小时有效期', async () => {
    const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
    stubCreateObjectURL();
    await withServer({}, async (target) => {
      const adapter = makeAdapter(target, { now: () => T0 }, new Uint8Array([9, 9, 9]));
      const url = await adapter.downloadAndStore(VIDEO_URL, 'task-store');
      expect(url.startsWith('blob:')).toBe(true);

      const artifact = await getVideoArtifact('task-store');
      expect(artifact).toBeDefined();
      expect(artifact?.size).toBe(3);
      expect(artifact?.mimeType).toBe('video/mp4');
      expect(artifact?.expiresAt).toBe(T0 + 24 * 60 * 60 * 1000);
      expect(artifact?.downloadLimit).toBe(100);

      const fresh = artifactNotice(artifact!, T0 + 60_000);
      expect(fresh).toContain('24 小时');
      expect(fresh).toContain('失效');

      // 24 小时之后：远端链接失效，但本地副本还在（不能说"没了"）
      const expiredAt = T0 + 24 * 60 * 60 * 1000 + 1;
      expect(isArtifactExpired(artifact!, expiredAt)).toBe(true);
      const expired = artifactNotice(artifact!, expiredAt);
      expect(expired).toContain('已');
      expect(expired).toContain('本地副本仍可播放');
    });
  });
});

describe('判据 4：失败分类（人话 + 下一步）', () => {
  const cases = [
    {
      label: '余额不足',
      error: { code: 'AccountOverdueError', message: '账户余额不足，请充值' },
      category: 'insufficient_balance',
      nextStepIncludes: '¥200',
    },
    {
      label: '内容违规',
      error: { code: 'OutputVideoSensitiveContentDetected', message: '输出视频包含敏感内容' },
      category: 'content_policy',
      nextStepIncludes: '真人人脸',
    },
    {
      label: '素材格式错',
      error: { code: 'InvalidParameter.ImageFormat', message: '图片格式不支持' },
      category: 'invalid_media',
      nextStepIncludes: '30MB',
    },
  ];

  for (const item of cases) {
    it(`${item.label} → ${item.category}`, () => {
      const task = parseTask({ status: 'failed', error: item.error }, 'task-fail');
      const view = describeTask(task);
      expect(view?.category).toBe(item.category);
      expect(view?.nextStep).toContain(item.nextStepIncludes);
      expect(view?.title).not.toBe('');
    });
  }

  it('提交阶段被拒：402 余额 → insufficient_balance；文档确证的 TaskTypeConstraint → duration_conflict', async () => {
    await withServer(
      {
        '/contents/generations/tasks': replyJson(
          { error: { code: 'AccountOverdueError', message: '余额不足' } },
          402,
        ),
      },
      async (target) => {
        const adapter = makeAdapter(target);
        try {
          await adapter.submit(baseRequest());
          throw new Error('应当抛错');
        } catch (error) {
          expect(isVideoError(error) && error.category).toBe('insufficient_balance');
        }
      },
    );

    await withServer(
      {
        '/contents/generations/tasks': replyJson(
          { error: { code: 'InvalidParameter.TaskTypeConstraint', message: '时长与任务类型冲突' } },
          400,
        ),
      },
      async (target) => {
        const adapter = makeAdapter(target);
        try {
          await adapter.submit(baseRequest());
          throw new Error('应当抛错');
        } catch (error) {
          expect(isVideoError(error) && error.category).toBe('duration_conflict');
          expect(isVideoError(error) && error.code).toBe('InvalidParameter.TaskTypeConstraint');
        }
      },
    );
  });

  it('网络失败归到 network_timeout，并提示"别重复提交"', async () => {
    const adapter = new ArkVideoAdapter({
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:9',
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    try {
      await adapter.submit(baseRequest());
      throw new Error('应当抛错');
    } catch (error) {
      expect(isVideoError(error) && error.category).toBe('network_timeout');
      expect(isVideoError(error) && error.nextStep).toContain('不要重复提交');
    }
  });
});

describe('判据 5 + 8：本地取消（不发任何取消请求）', () => {
  it('轮询中途取消：不再发新轮询，任务标记 aborted，且服务端没收到 DELETE', async () => {
    const pollHandler: MockHandler = (_request, response) => {
      response.writeHead(200, JSON_HEADERS);
      response.end(JSON.stringify({ status: 'running' }));
    };

    await withServer(
      {
        '/contents/generations/tasks': replyJson({ id: 'task-cancel' }),
        '/contents/generations/tasks/task-cancel': pollHandler,
      },
      async (target) => {
        const adapter = makeAdapter(target);
        const { task_id } = await adapter.submit(baseRequest());

        let cancelNow: () => Promise<void> = async () => undefined;
        // 第一次等待期间用户点了取消
        const sleep = async (): Promise<void> => {
          await cancelNow();
        };
        const runner = new VideoTaskRunner(adapter, { pollIntervalMs: 0, sleep, now: () => Date.now() });
        cancelNow = () => runner.cancel(task_id);
        const snapshot = await runner.waitForTask(task_id);

        expect(snapshot.phase).toBe('aborted');
        expect(snapshot.task.status).toBe('aborted');
        expect(snapshot.polls).toBe(1);

        const pollsAfterCancel = target.hits.filter((hit) => hit.path.endsWith(task_id)).length;
        expect(pollsAfterCancel).toBe(1);

        // 再跑一次：一条请求都不该再发
        const again = await runner.waitForTask(task_id);
        expect(again.phase).toBe('aborted');
        expect(target.hits.filter((hit) => hit.path.endsWith(task_id))).toHaveLength(1);

        // 没有任何取消类请求（不编造 DELETE 端点）
        expect(target.hits.filter((hit) => hit.method !== 'POST' && hit.method !== 'GET')).toHaveLength(0);
      },
    );
  });

  it('轮询超时：本地放弃跟踪并标 failed（code=PollTimeout）', async () => {
    const pollHandler: MockHandler = (_request, response) => {
      response.writeHead(200, JSON_HEADERS);
      response.end(JSON.stringify({ status: 'running' }));
    };

    await withServer(
      { '/contents/generations/tasks/task-slow': pollHandler },
      async (target) => {
        const adapter = makeAdapter(target);
        let clock = 0;
        const runner = new VideoTaskRunner(adapter, {
          pollIntervalMs: 0,
          pollTimeoutMs: 60_000,
          now: () => clock,
          sleep: async () => {
            clock += 30_000;
          },
        });
        const snapshot = await runner.waitForTask('task-slow');
        expect(snapshot.phase).toBe('failed');
        expect(snapshot.task.error?.code).toBe('PollTimeout');
        expect(describeTask(snapshot.task)?.category).toBe('network_timeout');
      },
    );
  });
});

describe('判据 7：请求体超限提前拒绝（不发请求）', () => {
  it('估算超限时一个请求都不发', async () => {
    await withServer({ '/contents/generations/tasks': replyJson({ id: 'never' }) }, async (target) => {
      const adapter = makeAdapter(target, { maxRequestBodyBytes: 1024 });
      const image = {
        kind: 'image' as const,
        mimeType: 'image/png',
        size: 2000,
        bytes: new Uint8Array(2000),
      };
      try {
        await adapter.submit(baseRequest({ references: { images: [{ role: 'character', asset: image }] } }));
        throw new Error('应当抛错');
      } catch (error) {
        expect(isVideoError(error) && error.category).toBe('request_too_large');
      }
      expect(target.hits).toHaveLength(0);
    });
  });

  it('素材分流走 base64 时，请求体里是 data URL（4.9MB 图片）', async () => {
    await withServer({ '/contents/generations/tasks': replyJson({ id: 'task-big' }) }, async (target) => {
      const adapter = makeAdapter(target);
      const size = Math.round(4.9 * 1024 * 1024);
      await adapter.submit(
        baseRequest({
          references: {
            images: [
              { role: 'character', asset: { kind: 'image', mimeType: 'image/png', size, bytes: new Uint8Array(size) } },
            ],
          },
        }),
      );
      const body = JSON.parse(target.hits[0].body) as { content: Array<{ type: string; image_url?: { url: string } }> };
      const image = body.content.find((item) => item.type === 'image_url');
      expect(image?.image_url?.url.startsWith('data:image/png;base64,')).toBe(true);
      expect(target.hits[0].body.length).toBeGreaterThan(size);
    });
  });
});

describe('判据 9：视频 URL 防御式提取（三种响应形态）', () => {
  it('① content[] 里 type=video_url', () => {
    const result = requireVideoResult({ content: [{ type: 'video_url', video_url: { url: 'https://a/1.mp4' } }] });
    expect(result.video_url).toBe('https://a/1.mp4');
    expect(result.url_path).toBe('content[0].video_url.url');
  });

  it('② content.video_url（文档线索的写法）', () => {
    const result = requireVideoResult({ content: { video_url: { url: 'https://a/2.mp4' } } });
    expect(result.video_url).toBe('https://a/2.mp4');
    expect(result.url_path).toBe('content.video_url');
  });

  it('③ 顶层 video_url（字符串或对象都认）', () => {
    expect(requireVideoResult({ video_url: 'https://a/3.mp4' }).url_path).toBe('video_url');
    expect(requireVideoResult({ video_url: { url: 'https://a/4.mp4' } }).video_url).toBe('https://a/4.mp4');
  });

  it('三种都取不到 → 报"响应结构未验证"的可读错误', () => {
    try {
      requireVideoResult({ status: 'succeeded', data: { foo: 'bar' } });
      throw new Error('应当抛错');
    } catch (error) {
      expect(isVideoError(error)).toBe(true);
      expect(isVideoError(error) && error.message).toContain('无法从响应中定位视频地址');
      expect(isVideoError(error) && error.message).toContain('未验证');
    }
  });

  it('usage.completion_tokens 缺失时给 0（不猜、不报错）', () => {
    const result = requireVideoResult({ video_url: 'https://a/5.mp4' });
    expect(result.usage.completion_tokens).toBe(0);
  });
});
