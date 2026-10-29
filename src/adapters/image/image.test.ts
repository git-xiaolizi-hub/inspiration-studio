/**
 * 生图适配器判据（M5a2 §3 test:image，全部 mock，零真实外网）。
 *
 * 1 三个适配器各自的请求体形状（**断言固定字段集，不多传**）
 * 2 `adapterForModel` 分派：cogview→zhipu、seedream→ark、gpt-image→openai、未知→可执行提示
 * 3 401 / 429 / 内容违规 三类分类正确
 * 4 结果下载入库（mock 二进制）→ 返回 blob URL；时效字段存在
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArkImageAdapter } from './ark-image-adapter';
import { OpenAIImageAdapter } from './openai-image-adapter';
import { ZhipuImageAdapter } from './zhipu-image-adapter';
import {
  adapterForModel,
  adapterKindForImageModel,
  imagePriceFor,
  isFreeImageModel,
} from './channels';
import { NO_IMAGE_ADAPTER_HINT } from './constants';
import { ImageError, isImageError } from './errors';
import { imageArtifactId, imageBlobId } from './storage';
import { getArtifact } from '../../core/artifacts';
import { getRecord } from '../../core/storage';
import { nodeFetch, startMockServer } from '../../test/mock-http-server';
import type { MockHandler, MockServer } from '../../test/mock-http-server';
import type { ImageFetchLike } from './types';

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * 让适配器打到 mock server 上：把 `https://<host>` 换成 mock 的 127.0.0.1 端口。
 * 这样断言的仍是**真实路径**（`/api/paas/v4/images/generations` 等），不是随手写的假路径。
 */
function viaMock(target: MockServer): ImageFetchLike {
  return (input, init) => {
    const url = new URL(input);
    const patched = `${target.baseUrl}${url.pathname}${url.search}`;
    return nodeFetch(patched, init);
  };
}

function jsonReply(body: unknown, status = 200): MockHandler {
  return (_request, response) => {
    response.writeHead(status, JSON_HEADERS);
    response.end(JSON.stringify(body));
  };
}

let server: MockServer | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

beforeEach(() => {
  // jsdom 不实现 URL.createObjectURL（与 M4b 同一处缺口）
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      value: () => 'blob:mock-image',
      configurable: true,
      writable: true,
    });
  }
});

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

/* ------------------------------------------------------------------ */
/* 1. 请求体形状（不许多传字段）                                        */
/* ------------------------------------------------------------------ */

describe('请求体形状：只发文档确证过的字段（判据 1）', () => {
  it('智谱：{model, prompt, size} —— 不发 quality / watermark_enabled / user_id', async () => {
    await withServer(
      { '/api/paas/v4/images/generations': jsonReply({ created: 1, data: [{ url: 'https://cdn/x.png' }] }) },
      async (target) => {
        const adapter = new ZhipuImageAdapter({
          apiKey: 'test-key',
          model: 'glm-image',
          fetchImpl: viaMock(target),
        });
        const result = await adapter.generate({ prompt: '窗台上的猫', aspect: '3:4', model: 'glm-image' });

        expect(server?.hits[0].method).toBe('POST');
        expect(server?.hits[0].path).toBe('/api/paas/v4/images/generations');
        expect(server?.hits[0].headers.authorization).toBe('Bearer test-key');

        const body = JSON.parse(server?.hits[0].body ?? '{}') as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(['model', 'prompt', 'size']);
        // glm-image 的 3:4 枚举是 1056x1568（与 cogview 的 768x1344 不同）
        expect(body.size).toBe('1056x1568');
        expect(result.size).toBe('1056x1568');
        expect(result.images).toEqual([{ url: 'https://cdn/x.png' }]);
        // 官方响应体没有 usage → 本地计数并注明
        expect(result.usage?.images).toBe(1);
      },
    );
  });

  it('方舟：{model, prompt, size, response_format} —— 不传 watermark / sequential_image_generation', async () => {
    await withServer(
      {
        '/api/v3/images/generations': jsonReply({
          model: 'doubao-seedream-5-0-pro-260628',
          created: 1784696685,
          data: [{ url: 'https://cdn/y.jpeg', size: '2048x2048', output_format: 'jpeg' }],
          usage: { generated_images: 1, output_tokens: 23107, total_tokens: 23107 },
        }),
      },
      async (target) => {
        const adapter = new ArkImageAdapter({
          apiKey: 'test-key',
          model: 'doubao-seedream-5-0-pro-260628',
          fetchImpl: viaMock(target),
        });
        const result = await adapter.generate({ prompt: '海边日落', model: 'doubao-seedream-5-0-pro-260628' });

        const body = JSON.parse(server?.hits[0].body ?? '{}') as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(['model', 'prompt', 'response_format', 'size']);
        expect(body.response_format).toBe('url');
        expect(body.size).toBe('2048x2048');
        expect(body).not.toHaveProperty('watermark');
        expect(body).not.toHaveProperty('sequential_image_generation');

        // usage 取官方字段 generated_images
        expect(result.usage?.images).toBe(1);
      },
    );
  });

  it('OpenAI 兼容：{model, prompt, size}，且必须带用户给的 base_url', async () => {
    await withServer(
      { '/v1/images/generations': jsonReply({ created: 1, data: [{ url: 'https://cdn/z.png' }] }) },
      async (target) => {
        const adapter = new OpenAIImageAdapter({
          apiKey: 'test-key',
          baseUrl: `${target.baseUrl}/v1`,
          model: 'gpt-image-2.5-flare',
          fetchImpl: viaMock(target),
        });
        await adapter.generate({ prompt: '水墨山', model: 'gpt-image-2.5-flare', aspect: '16:9' });

        const body = JSON.parse(server?.hits[0].body ?? '{}') as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(['model', 'prompt', 'size']);
        // 16:9 官方尺寸里没有 → 落到 1536x1024（报告 §1.3 标注为近似）
        expect(body.size).toBe('1536x1024');
      },
    );
  });

  it('没有 base_url 的 OpenAI 兼容适配器直接报参数错，不发请求', () => {
    expect(
      () => new OpenAIImageAdapter({ apiKey: 'test-key', baseUrl: '', model: 'gpt-image-2.5' }),
    ).toThrowError(/base_url/);
  });

  it('负向提示词：显式拒绝（两家图像接口都没有这个字段），一个请求都不发', async () => {
    await withServer({}, async (target) => {
      const adapter = new ZhipuImageAdapter({ apiKey: 'test-key', fetchImpl: viaMock(target) });
      await expect(
        adapter.generate({ prompt: '猫', negative: '模糊', model: 'cogview-4' }),
      ).rejects.toMatchObject({ category: 'unsupported_capability' });
      expect(server?.hits).toHaveLength(0);
    });
  });

  it('count = N 时发 N 次单张请求（官方接口没有 n），并累计张数', async () => {
    await withServer(
      { '/api/paas/v4/images/generations': jsonReply({ created: 1, data: [{ url: 'https://cdn/x.png' }] }) },
      async (target) => {
        const adapter = new ZhipuImageAdapter({ apiKey: 'test-key', fetchImpl: viaMock(target) });
        const result = await adapter.generate({ prompt: '猫', model: 'cogview-3-flash', count: 3 });
        expect(server?.hits).toHaveLength(3);
        expect(result.images).toHaveLength(3);
        expect(result.usage?.images).toBe(3);
      },
    );
  });
});

/* ------------------------------------------------------------------ */
/* 2. 分派                                                             */
/* ------------------------------------------------------------------ */

describe('adapterForModel 分派（判据 2）', () => {
  it('cogview → zhipu / seedream → ark / gpt-image → openai', () => {
    expect(adapterKindForImageModel('cogview-3-flash')).toBe('zhipu');
    expect(adapterKindForImageModel('glm-image')).toBe('zhipu');
    expect(adapterKindForImageModel('doubao-seedream-5-0-pro-260628')).toBe('ark');
    expect(adapterKindForImageModel('gpt-image-2.5')).toBe('openai');
    expect(adapterKindForImageModel('dall-e-3')).toBe('openai');
  });

  it('未知模型 → 可执行提示（不抛异常、不猜适配器）', () => {
    const result = adapterForModel({ modelId: 'qwen-image-2.1', apiKey: 'k' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不该成功');
    expect(result.reason).toContain('没有对应的生图适配器');
    expect(result.hint).toBe(NO_IMAGE_ADAPTER_HINT);
  });

  it('缺 Key → 失败并指回去 AI 配置', () => {
    const result = adapterForModel({ modelId: 'cogview-3-flash' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不该成功');
    expect(result.reason).toContain('API Key');
    expect(result.hint).toContain('AI 配置');
  });

  it('注入适配器时直接用注入的（不校验凭据，测试与宿主都走这条）', () => {
    const fake = new ZhipuImageAdapter({ apiKey: 'k', fetchImpl: () => Promise.reject(new Error('no')) });
    const result = adapterForModel({ modelId: 'cogview-4' }, { zhipuAdapter: fake });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('应该成功');
    expect(result.adapter).toBe(fake);
    // 免费只在 cogview-3-flash 上成立
    expect(result.free).toBe(false);
    expect(result.priceRow).toBeNull();
  });

  it('免费档与价格键：cogview-3-flash 命中免费表，版本化 model id 能对上型号族', () => {
    expect(isFreeImageModel('cogview-3-flash')).toBe(true);
    expect(isFreeImageModel('cogview-4')).toBe(false);
    expect(imagePriceFor('cogview-3-flash').row?.perImage).toBe(0);
    expect(imagePriceFor('doubao-seedream-5-0-pro-260628').priceModel).toBe('doubao-seedream-5-0-pro');
    expect(imagePriceFor('doubao-seedream-5-0-pro-260628').row?.perImage).toBe(0.3);
    // 价格表里没有 glm-image → null（UI 必须显示"未核实"，不许编）
    expect(imagePriceFor('glm-image').row).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 3. 失败分类                                                         */
/* ------------------------------------------------------------------ */

describe('失败分类：401 / 429 / 内容违规（判据 3）', () => {
  it('401 → auth（人话 + 下一步）', async () => {
    await withServer(
      { '/api/paas/v4/images/generations': jsonReply({ error: { code: '1000', message: 'Authentication failed' } }, 401) },
      async (target) => {
        const adapter = new ZhipuImageAdapter({ apiKey: 'bad', fetchImpl: viaMock(target) });
        const caught = await adapter
          .generate({ prompt: '猫', model: 'cogview-4' })
          .catch((error: unknown) => error);
        expect(isImageError(caught)).toBe(true);
        expect((caught as ImageError).category).toBe('auth');
        expect((caught as ImageError).nextStep).toContain('控制台');
      },
    );
  });

  it('429 → rate_limited（可重试，且不等于 unknown）', async () => {
    await withServer(
      { '/api/paas/v4/images/generations': jsonReply({ error: { code: '1305', message: '访问量过大' } }, 429) },
      async (target) => {
        const adapter = new ZhipuImageAdapter({ apiKey: 'k', fetchImpl: viaMock(target) });
        const caught = await adapter.generate({ prompt: '猫', model: 'cogview-3-flash' }).catch((error: unknown) => error);
        expect(caught).toBeInstanceOf(ImageError);
        expect((caught as ImageError).category).toBe('rate_limited');
        expect((caught as ImageError).retryable).toBe(true);
        expect((caught as ImageError).nextStep).toContain('免费');
      },
    );
  });

  it('内容违规（HTTP 400 + 审核关键词）→ content_policy，不是 invalid_params', async () => {
    await withServer(
      {
        '/api/v3/images/generations': jsonReply(
          { error: { code: 'OutputImageSensitiveContentDetected', message: '内容审核未通过' } },
          400,
        ),
      },
      async (target) => {
        const adapter = new ArkImageAdapter({ apiKey: 'k', fetchImpl: viaMock(target) });
        const caught = await adapter.generate({ prompt: '...', model: 'doubao-seedream-5-0-pro' }).catch(
          (error: unknown) => error,
        );
        expect((caught as ImageError).category).toBe('content_policy');
        expect((caught as ImageError).code).toBe('OutputImageSensitiveContentDetected');
      },
    );
  });

  it('尺寸格式不对 → 本地就报 invalid_params，不发请求', async () => {
    await withServer({}, async (target) => {
      const adapter = new ZhipuImageAdapter({ apiKey: 'k', fetchImpl: viaMock(target) });
      await expect(
        adapter.generate({ prompt: '猫', size: '1024*1024', model: 'cogview-4' }),
      ).rejects.toMatchObject({ category: 'invalid_params' });
      expect(server?.hits).toHaveLength(0);
    });
  });
});

/* ------------------------------------------------------------------ */
/* 4. 下载落盘                                                         */
/* ------------------------------------------------------------------ */

describe('结果下载入库（判据 4）', () => {
  it('方舟：下载 mock 二进制 → media 表有行、返回 blob URL、时效 24 小时', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    await withServer(
      {
        '/api/v3/images/generations': jsonReply({
          model: 'doubao-seedream-5-0-pro-260628',
          data: [{ url: 'https://cdn.example.com/out.png' }],
          usage: { generated_images: 1 },
        }),
        '/out.png': (_request, response) => {
          response.writeHead(200, { 'content-type': 'image/png' });
          response.end(Buffer.from(png));
        },
      },
      async (target) => {
        const now = 1_700_000_000_000;
        const adapter = new ArkImageAdapter({
          apiKey: 'k',
          model: 'doubao-seedream-5-0-pro-260628',
          fetchImpl: viaMock(target),
          now: () => now,
        });

        const key = 'test-ark-1';
        const blobUrl = await adapter.downloadAndStore('https://cdn.example.com/out.png', key);
        expect(blobUrl.startsWith('blob:')).toBe(true);

        const media = await getRecord<{ id: string; blob: Blob; mimeType: string }>(
          'media',
          imageBlobId(key),
        );
        expect(media).toBeDefined();
        expect(media?.mimeType).toBe('image/png');
        expect(media?.blob.size).toBe(png.byteLength);

        // 下载时不带 Authorization（别把 key 发给 CDN）
        const download = server?.hits.find((hit) => hit.path === '/out.png');
        expect(download?.headers.authorization).toBeUndefined();
      },
    );
  });

  it('时效口径逐家不同：智谱 30 天（已核实）/ 方舟 24 小时（已核实）', () => {
    const zhipu = new ZhipuImageAdapter({ apiKey: 'k' });
    const ark = new ArkImageAdapter({ apiKey: 'k' });
    const openai = new OpenAIImageAdapter({ apiKey: 'k', baseUrl: 'https://relay.example.com/v1' });

    expect(zhipu.urlTtl.ms).toBe(30 * 24 * 60 * 60 * 1000);
    expect(zhipu.urlTtl.verified).toBe(true);
    expect(ark.urlTtl.ms).toBe(24 * 60 * 60 * 1000);
    expect(ark.urlTtl.verified).toBe(true);
    // OpenAI 兼容端没拿到官方原文 → 1 小时保守值 + verified:false
    expect(openai.urlTtl.verified).toBe(false);
    expect(openai.urlTtl.note).toContain('未核实');
  });

  it('产物 id 与 media 主键同源，artifact 记录能按 id 取回', async () => {
    const { saveImageBlob } = await import('./storage');
    const key = 'test-ark-2';
    const artifact = await saveImageBlob({
      key,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      remoteUrl: 'https://cdn.example.com/a.png',
      ttl: new ArkImageAdapter({ apiKey: 'k' }).urlTtl,
      now: () => 1_700_000_000_000,
    });
    expect(artifact.id).toBe(imageArtifactId(key));
    expect(artifact.expiresAt - artifact.createdAt).toBe(24 * 60 * 60 * 1000);

    const { saveArtifact } = await import('../../core/artifacts');
    const row = await saveArtifact({
      id: key,
      recordId: 'rec-1',
      kind: 'image',
      modelId: 'doubao-seedream-5-0-pro',
      cost: 0.3,
      payload: { prompt: '猫', blobId: imageBlobId(key), remoteUrl: artifact.remoteUrl },
    });
    expect((await getArtifact(row.id))?.recordId).toBe('rec-1');
  });
});

/**
 * M3R11 §1：**生图请求层也要把预检结论带进分类**。
 *
 * 只测分类器不够（M3R10 的教训）：少传一个字段，`cors-adapters.test.ts` 照样全绿，
 * 而线上用户看到的仍是「这家不允许浏览器直连」。这里用真适配器 + 假 fetch 走一遍。
 */
describe('M3R11 §1：生图 TypeError 的两段判定（请求层接线）', () => {
  const ARK_TEST_KEY = 'test-key';

  function makeFetch(behavior: 'preflight-ok' | 'preflight-fail') {
    const calls: string[] = [];
    const impl: ImageFetchLike = async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'OPTIONS') {
        if (behavior === 'preflight-ok') return { status: 204 } as unknown as Response;
        throw new TypeError('Failed to fetch');
      }
      throw new TypeError('Failed to fetch');
    };
    return { impl, calls };
  }

  it('OPTIONS 通（方舟 key 错就是这个形态）→ rejected_unreadable', async () => {
    const { impl, calls } = makeFetch('preflight-ok');
    const adapter = new ArkImageAdapter({
      apiKey: ARK_TEST_KEY,
      model: 'doubao-seedream-5-0-pro-260628',
      fetchImpl: impl,
    });
    const error = await adapter
      .generate({ prompt: '海边日落', model: 'doubao-seedream-5-0-pro-260628' })
      .catch((caught: unknown) => caught);
    expect(isImageError(error)).toBe(true);
    expect((error as ImageError).category).toBe('rejected_unreadable');
    // 探的是用户填的原始地址（不是 dev 代理路径）
    expect(calls.some((call) => call.startsWith('OPTIONS https://ark.cn-beijing.volces.com'))).toBe(
      true,
    );
  });

  it('OPTIONS 也被拦 → 仍是 cors_blocked', async () => {
    const { impl } = makeFetch('preflight-fail');
    const adapter = new ArkImageAdapter({
      apiKey: ARK_TEST_KEY,
      model: 'doubao-seedream-5-0-pro-260628',
      fetchImpl: impl,
    });
    const error = await adapter
      .generate({ prompt: '海边日落', model: 'doubao-seedream-5-0-pro-260628' })
      .catch((caught: unknown) => caught);
    expect((error as ImageError).category).toBe('cors_blocked');
  });
});
