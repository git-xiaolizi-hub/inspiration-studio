/**
 * M3R9 §1/§2/§3/§4 判据：自检「按 key 的真实能力」来，而不是拿厂商默认模型硬试。
 *
 * 这一层直接用 **mock HTTP server**（`nodeFetch`）跑真实 HTTP 行为，不是假对象：
 * 「列表 200 / 404」「1212」「404 + model_not_allowed」「路径候选」都是服务端行为，
 * 用假对象测不出「到底发了几个请求、打的是哪个地址」。
 *
 * 对照承接方的真机实测（任务书 §0）：
 * - 灵绘 `GET /v1/models` 与 `/models` 都 200；`claude-opus-5-5` 是 404 model_not_allowed；
 * - 智谱对生图/视频模型发同步 chat → 400 + code 1212；
 * - 火山方舟没有 /models（404，无 body code）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AIErrorCode } from './types';
import { listModels, runSelfTest } from './client';
import type { FetchLike, ListModelsResult, ProbeResult, ProviderInput } from './client';
import { runConnectionSelfTest } from './self-test';
import { nodeFetch, startMockServer } from '../../test/mock-http-server';
import type { MockHandler, MockServer } from '../../test/mock-http-server';

const JSON_HEADERS = { 'content-type': 'application/json' };

function replyJson(body: unknown, status = 200): MockHandler {
  return (_request, response) => {
    response.writeHead(status, JSON_HEADERS);
    response.end(JSON.stringify(body));
  };
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

afterEach(() => {
  server = null;
});

/** 真发请求（打到 mock server 上）的两个探针 —— 与生产代码同一份实现 */
function realProbes(): {
  selfTest: (input: ProviderInput) => Promise<ProbeResult>;
  listModels: (input: ProviderInput) => Promise<ListModelsResult>;
} {
  const fetchImpl: FetchLike = nodeFetch;
  return {
    selfTest: (input) => runSelfTest(input, { fetchImpl }),
    listModels: (input) => listModels(input, { fetchImpl }),
  };
}

/* ------------------------------------------------------------------ */
/* 判据 1：列表 200 且有文本模型 → 用列表里的第一个文本模型               */
/* ------------------------------------------------------------------ */

describe('M3R9 §1 判据 1：列表能拿到时，用列表里的第一个文本模型', () => {
  it('列表里第一个是 gemini-3.8-flash（文本）→ 自检就用它，且结果里出现该模型名', async () => {
    await withServer(
      {
        '/v1/models': replyJson({
          data: [{ id: 'gemini-3.8-flash' }, { id: 'claude-opus-5-5' }],
        }),
        '/v1/chat/completions': replyJson({ choices: [{ message: { content: '' } }] }),
      },
      async (target) => {
        const outcome = await runConnectionSelfTest(
          {
            baseUrl: target.baseUrl,
            apiKey: 'sk-test',
            // 模型表里放的是「厂商默认」的 opus —— 正是它会 404，所以要看列表
            selectedModel: { modelId: 'claude-opus-5-5', caps: ['text', 'vision'] },
            connectionModels: [{ modelId: 'claude-opus-5-5', caps: ['text', 'vision'] }],
          },
          realProbes(),
        );

        expect(outcome.sentSyncRequest).toBe(true);
        expect(outcome.probe.ok).toBe(true);
        // ① 用的是列表里的第一个文本模型，不是模型表里的 opus
        expect(outcome.probe.testedModel).toBe('gemini-3.8-flash');
        expect(outcome.probe.modelSource).toBe('listed');
        // ② 请求体里的 model 也是它
        const chatHit = target.hits.find((hit) => hit.path === '/v1/chat/completions');
        expect(JSON.parse(chatHit?.body ?? '{}').model).toBe('gemini-3.8-flash');
      },
    );
  });

  it('列表里的生图/视频模型会被跳过（cogview / seedance 不作候选）', async () => {
    await withServer(
      {
        '/v1/models': replyJson({
          data: [{ id: 'cogview-4' }, { id: 'doubao-seedance-2-5-260628' }, { id: 'glm-5.3-flash' }],
        }),
        '/v1/chat/completions': replyJson({ choices: [{ message: { content: '' } }] }),
      },
      async (target) => {
        const outcome = await runConnectionSelfTest(
          { baseUrl: target.baseUrl, apiKey: 'sk-test', connectionModels: [] },
          realProbes(),
        );
        expect(outcome.probe.testedModel).toBe('glm-5.3-flash');
      },
    );
  });
});

/* ------------------------------------------------------------------ */
/* 判据 2：列表 404（方舟）→ 用模型表里的文本模型；只有视频 → 零请求      */
/* ------------------------------------------------------------------ */

describe('M3R9 §1/§2 判据 2：拉不到列表时的退回路径', () => {
  it('列表 404（方舟没有 /models）→ 退回模型表里的文本模型，仍然发一次同步请求', async () => {
    await withServer(
      {
        // 两个候选地址都 404：这家没有列表接口
        '/chat/completions': replyJson({ choices: [{ message: { content: '' } }] }),
      },
      async (target) => {
        const outcome = await runConnectionSelfTest(
          {
            baseUrl: target.baseUrl,
            apiKey: 'sk-test',
            selectedModel: { modelId: 'doubao-seed-2.1-pro', caps: ['text', 'vision'] },
            connectionModels: [
              { modelId: 'doubao-seedance-2-5-260628', caps: ['video'] },
              { modelId: 'doubao-seed-2.1-pro', caps: ['text', 'vision'] },
            ],
          },
          realProbes(),
        );

        expect(outcome.listing?.ok).toBe(false);
        expect(outcome.listing?.error?.code).toBe(AIErrorCode.MODELS_NOT_LISTED);
        // 退回模型表里的文本模型（不是那条视频模型）
        expect(outcome.probe.testedModel).toBe('doubao-seed-2.1-pro');
        expect(outcome.probe.modelSource).toBe('connection');
        expect(outcome.sentSyncRequest).toBe(true);
      },
    );
  });

  it('模型表只有视频模型 → 零请求 + 可执行提示（§2 核心）', async () => {
    await withServer(
      { '/v1/models': replyJson({ data: [{ id: 'glm-5.3-flash' }] }) },
      async (target) => {
        const outcome = await runConnectionSelfTest(
          {
            baseUrl: target.baseUrl,
            apiKey: 'sk-test',
            connectionModels: [{ modelId: 'doubao-seedance-2-5-260628', caps: ['video'] }],
          },
          realProbes(),
        );

        // ① 一个请求都没发（连列表都没拉）
        expect(target.hits).toHaveLength(0);
        expect(outcome.sentSyncRequest).toBe(false);
        // ② 提示是 §2 的原文，且告诉用户点哪个标签
        expect(outcome.probe.ok).toBe(false);
        expect(outcome.probe.error?.code).toBe(AIErrorCode.NO_SYNC_MODEL);
        expect(outcome.probe.error?.userMessage).toContain('只有生图/视频模型');
        expect(outcome.probe.error?.userMessage).toContain('glm-5.3-flash');
        expect(outcome.probe.error?.userMessage).toContain('deepseek-flash');
      },
    );
  });

  it('手动选中生图模型去测（模型表里另有文本模型）→ 仍然零请求 + 提示（§2 同一条规则）', async () => {
    await withServer(
      { '/v1/models': replyJson({ data: [{ id: 'glm-5.3-flash' }] }) },
      async (target) => {
        const outcome = await runConnectionSelfTest(
          {
            baseUrl: target.baseUrl,
            apiKey: 'sk-test',
            selectedModel: { modelId: 'cogview-4', caps: ['image'] },
            connectionModels: [
              { modelId: 'glm-5.3-flash', caps: ['text', 'vision'] },
              { modelId: 'cogview-4', caps: ['image'] },
            ],
          },
          realProbes(),
        );

        expect(target.hits).toHaveLength(0);
        expect(outcome.sentSyncRequest).toBe(false);
        expect(outcome.probe.error?.code).toBe(AIErrorCode.NO_SYNC_MODEL);
        expect(outcome.probe.error?.userMessage).toContain('cogview-4');
        expect(outcome.probe.error?.userMessage).toContain('不支持同步自检');
      },
    );
  });

  it('连接里一个模型都没有、站上也拉不到 → 零请求 + 让用户点标签', async () => {
    await withServer({}, async (target) => {
      const outcome = await runConnectionSelfTest(
        { baseUrl: target.baseUrl, apiKey: 'sk-test', connectionModels: [] },
        realProbes(),
      );
      // 拉列表试了两个地址，但**没有**发同步 chat
      expect(target.hits.every((hit) => hit.method === 'GET')).toBe(true);
      expect(outcome.sentSyncRequest).toBe(false);
      expect(outcome.probe.error?.userMessage).toContain('还没有可用的文本模型');
    });
  });
});

/* ------------------------------------------------------------------ */
/* 判据 3：1212 → 文案含「不支持同步调用」                              */
/* ------------------------------------------------------------------ */

describe('M3R9 §3 判据 3：业务码 1212 映射', () => {
  it('1212 → 人话含「不支持同步调用」，且点明是哪个模型（不是一句「请求参数被拒」）', async () => {
    await withServer(
      {
        '/v1/models': replyJson({ data: [{ id: 'glm-image' }] }),
        // 真机实测的形状：智谱 400 + code 1212
        '/chat/completions': replyJson(
          { error: { code: 1212, message: '当前模型不支持 SYNC 调用方式' } },
          400,
        ),
      },
      async (target) => {
        const outcome = await runConnectionSelfTest(
          {
            baseUrl: target.baseUrl,
            apiKey: 'sk-test',
            connectionModels: [{ modelId: 'glm-image', caps: ['text'] }],
          },
          realProbes(),
        );
        expect(outcome.probe.ok).toBe(false);
        expect(outcome.probe.error?.code).toBe(AIErrorCode.SYNC_NOT_SUPPORTED);
        expect(outcome.probe.error?.userMessage).toContain('不支持同步调用');
        expect(outcome.probe.error?.userMessage).toContain('glm-image');
        // 原始技术信息留在 message 里（可折叠区看得到）
        expect(outcome.probe.error?.message).toContain('1212');
      },
    );
  });

  it('只有文案「不支持SYNC」没有数字码 → 同样归到 sync_not_supported', async () => {
    await withServer(
      {
        '/chat/completions': replyJson({ error: { message: '当前模型不支持SYNC' } }, 400),
      },
      async (target) => {
        const result = await runSelfTest(
          { baseUrl: target.baseUrl, apiKey: 'sk-test', model: 'cogvideox-3' },
          { fetchImpl: nodeFetch },
        );
        expect(result.error?.code).toBe(AIErrorCode.SYNC_NOT_SUPPORTED);
        expect(result.error?.userMessage).toContain('不支持同步调用');
      },
    );
  });
});

/* ------------------------------------------------------------------ */
/* 判据 4：404 + model_not_allowed → 「分组没有权限」，不能说成「没有列表接口」 */
/* ------------------------------------------------------------------ */

describe('M3R9 §3 判据 4：404 的两种含义必须分开', () => {
  it('自检遇到 404 + model_not_allowed → 「分组没有权限」，且不在「两个地址」上白打一次', async () => {
    await withServer(
      {
        // 灵绘真机形状
        '/chat/completions': replyJson(
          { error: { code: 'model_not_allowed', message: '当前 API Key 或分组不允许调用此模型' } },
          404,
        ),
        '/v1/chat/completions': replyJson({ error: { code: 'model_not_allowed' } }, 404),
      },
      async (target) => {
        const result = await runSelfTest(
          { ...{ apiKey: 'sk-test', model: 'claude-opus-5-5' }, baseUrl: target.baseUrl },
          { fetchImpl: nodeFetch },
        );

        expect(result.error?.code).toBe(AIErrorCode.MODEL_NOT_ALLOWED);
        expect(result.error?.userMessage).toContain('分组没有权限');
        expect(result.error?.userMessage).toContain('claude-opus-5-5');
        expect(result.error?.userMessage).toContain('拉取模型列表');
        // 关键：不能说成「这家没有模型列表接口」
        expect(result.error?.userMessage).not.toContain('没有模型列表接口');
        // 权限问题换地址也没用 → 只打了第一个候选
        expect(target.hits).toHaveLength(1);
      },
    );
  });

  it('拉列表遇到 404 + model_not_allowed → 也是「分组没有权限」，不是 MODELS_NOT_LISTED', async () => {
    await withServer(
      { '/models': replyJson({ error: { code: 'model_not_allowed' } }, 404) },
      async (target) => {
        const result = await listModels(
          { apiKey: 'sk-test', model: 'claude-opus-5-5', baseUrl: target.baseUrl },
          { fetchImpl: nodeFetch },
        );
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe(AIErrorCode.MODEL_NOT_ALLOWED);
        expect(result.error?.userMessage).toContain('分组没有权限');
        expect(result.error?.message).not.toContain('没有模型列表接口');
      },
    );
  });
});

/* ------------------------------------------------------------------ */
/* 判据 5：光秃秃的 404 → 保持 MODELS_NOT_LISTED 文案                    */
/* ------------------------------------------------------------------ */

describe('M3R9 §3 判据 5：无 body code 的 404 仍是「没有列表接口」', () => {
  it('404 且 body 里没有权限码 → MODELS_NOT_LISTED，文案仍是「这家没有模型列表接口」', async () => {
    await withServer(
      { '/models': replyJson({ error: { message: 'not found' } }, 404) },
      async (target) => {
        const result = await listModels(
          { apiKey: 'sk-test', model: 'doubao-seed-2.1-pro', baseUrl: target.baseUrl },
          { fetchImpl: nodeFetch },
        );
        expect(result.error?.code).toBe(AIErrorCode.MODELS_NOT_LISTED);
        expect(result.error?.userMessage).toContain('这家没有模型列表接口');
        expect(result.error?.userMessage).toContain('火山方舟');
        expect(result.error?.userMessage).not.toContain('分组没有权限');
      },
    );
  });

  it('同一家：拉列表 404（无码）但自检能通 → 两条信息各说各的，不互相污染', async () => {
    await withServer(
      { '/chat/completions': replyJson({ choices: [{ message: { content: '' } }] }) },
      async (target) => {
        const probes = realProbes();
        const listing = await probes.listModels({
          apiKey: 'sk-test',
          model: 'doubao-seed-2.1-pro',
          baseUrl: target.baseUrl,
        });
        expect(listing.error?.code).toBe(AIErrorCode.MODELS_NOT_LISTED);

        const probe = await probes.selfTest({
          apiKey: 'sk-test',
          model: 'doubao-seed-2.1-pro',
          baseUrl: target.baseUrl,
        });
        expect(probe.ok).toBe(true);
      },
    );
  });
});

/* ------------------------------------------------------------------ */
/* 判据 7：路径候选 —— /v1/models 404 但 /models 200 → 判连通成功         */
/* ------------------------------------------------------------------ */

describe('M3R9 §4 判据 7：路径候选「原样 → 补 /v1」', () => {
  it('{base}/models 200（{base}/v1/models 404）→ 拉列表成功，且只打了一次', async () => {
    await withServer(
      { '/models': replyJson({ data: [{ id: 'gemini-3.8-flash' }] }) },
      async (target) => {
        const result = await listModels(
          { apiKey: 'sk-test', model: 'gemini-3.8-flash', baseUrl: target.baseUrl },
          { fetchImpl: nodeFetch },
        );
        expect(result.ok).toBe(true);
        expect(result.models).toEqual(['gemini-3.8-flash']);
        expect(result.url).toBe(`${target.baseUrl}/models`);
        expect(target.hits.map((hit) => hit.path)).toEqual(['/models']);
      },
    );
  });

  it('{base}/v1/models 404 而 {base}/models 200 → 补 /v1 后自动命中，判连通成功', async () => {
    await withServer(
      {
        // 站上只有补 /v1 才有的那套路由（用户填的地址少了 /v1）
        '/v1/models': replyJson({ data: [{ id: 'gemini-3.8-flash' }] }),
        '/v1/chat/completions': replyJson({ choices: [{ message: { content: '' } }] }),
      },
      async (target) => {
        const outcome = await runConnectionSelfTest(
          { baseUrl: target.baseUrl, apiKey: 'sk-test', connectionModels: [] },
          realProbes(),
        );
        // 原样 /models 404 → 补 /v1 命中
        expect(target.hits.map((hit) => hit.path)[0]).toBe('/models');
        expect(outcome.listing?.ok).toBe(true);
        expect(outcome.listing?.url).toBe(`${target.baseUrl}/v1/models`);
        // 同步自检也跟着命中 /v1
        expect(outcome.probe.ok).toBe(true);
        expect(outcome.probe.url).toBe(`${target.baseUrl}/v1/chat/completions`);
        // §1-④：结果显示「用哪个模型 + 实际命中的地址」
        expect(outcome.probe.testedModel).toBe('gemini-3.8-flash');
      },
    );
  });

  it('地址已带 /v1 时不补第二次（deepseek 这种）', async () => {
    await withServer(
      { '/v1/models': replyJson({ data: [{ id: 'deepseek-flash' }] }) },
      async (target) => {
        const result = await listModels(
          { apiKey: 'sk-test', model: 'deepseek-flash', baseUrl: `${target.baseUrl}/v1` },
          { fetchImpl: nodeFetch },
        );
        expect(result.ok).toBe(true);
        expect(target.hits.map((hit) => hit.path)).toEqual(['/v1/models']);
      },
    );
  });
});

/* ------------------------------------------------------------------ */
/* 能力判定本身                                                         */
/* ------------------------------------------------------------------ */

describe('M3R9 §1-② 能力过滤：caps 优先，判断不了才按名字猜', () => {
  it('caps 含 text/vision 才可同步自检；image/video 一律不可', async () => {
    const { canSyncTest } = await import('./client');
    expect(canSyncTest('x', ['text'])).toBe(true);
    expect(canSyncTest('x', ['vision'])).toBe(true);
    expect(canSyncTest('x', ['text', 'vision'])).toBe(true);
    expect(canSyncTest('x', ['image'])).toBe(false);
    expect(canSyncTest('x', ['video'])).toBe(false);
    expect(canSyncTest('x', ['image', 'video'])).toBe(false);
  });

  it('没有 caps → 按名字排除生图/视频前缀', async () => {
    const { canSyncTest, pickListedTextModel } = await import('./client');
    expect(canSyncTest('doubao-seedance-2-5-260628')).toBe(false);
    expect(canSyncTest('cogview-4')).toBe(false);
    expect(canSyncTest('cogvideox-3')).toBe(false);
    expect(canSyncTest('gpt-image-2.5-flare')).toBe(false);
    expect(canSyncTest('gpt-image-2.5-sunburst')).toBe(false);
    expect(canSyncTest('qwen-image-2.1')).toBe(false);
    expect(canSyncTest('minimax-h3')).toBe(false);
    expect(canSyncTest('gemini-3.8-flash')).toBe(true);
    expect(canSyncTest('deepseek-v4-pro')).toBe(true);
    // 认不出的一律当文本（宁可试一次，也不把可用的模型漏掉）
    expect(canSyncTest('some-unknown-model')).toBe(true);

    expect(pickListedTextModel(['cogview-4', 'gemini-3.8-flash'])).toBe('gemini-3.8-flash');
    expect(pickListedTextModel([])).toBeUndefined();
    // 全是生图/视频时仍然给出一个兜底（留情给上层决定）
    expect(pickListedTextModel(['cogview-4'])).toBe('cogview-4');
  });
});
