import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chat,
  endpointCandidates,
  extractModelNames,
  listModels,
  runSelfTest,
} from './client';
import { AIErrorCode } from './types';
import { nodeFetch, startMockServer } from '../../test/mock-http-server';
import type { MockHandler, MockServer } from '../../test/mock-http-server';

const JSON_HEADERS = { 'content-type': 'application/json' };

function replyJson(body: unknown, status = 200): MockHandler {
  return (_request, response) => {
    response.writeHead(status, JSON_HEADERS);
    response.end(JSON.stringify(body));
  };
}

function replyText(body: string, status = 200, contentType = 'text/html'): MockHandler {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': contentType });
    response.end(body);
  };
}

/** 只在测试期间挂起的 handler：用来测超时 */
const hang: MockHandler = () => {
  /* 故意不响应 */
};

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const baseInput = { apiKey: 'sk-test-1234567890', model: 'gpt-test' };

describe('地址候选：带 /v1 与不带 /v1 的站都能对上', () => {
  it('无版本段 → 先试原样路径，再试补 /v1（M3R9 §4 反了顺序）', () => {
    expect(endpointCandidates('https://relay.example.com', 'chat')).toEqual([
      'https://relay.example.com/chat/completions',
      'https://relay.example.com/v1/chat/completions',
    ]);
    // 拉列表同理：用户填的就是先打的那个（灵绘 /models 与 /v1/models 都 200，实测见 M3R9 §0）
    expect(endpointCandidates('https://relay.example.com', 'models')).toEqual([
      'https://relay.example.com/models',
      'https://relay.example.com/v1/models',
    ]);
  });

  it('已带版本段（/v1、/v4、/api/v3）→ 不重复拼 /v1', () => {
    expect(endpointCandidates('https://api.deepseek.com/v1', 'chat')).toEqual([
      'https://api.deepseek.com/v1/chat/completions',
    ]);
    expect(endpointCandidates('https://open.bigmodel.cn/api/paas/v4', 'models')).toEqual([
      'https://open.bigmodel.cn/api/paas/v4/models',
    ]);
    expect(endpointCandidates('https://ark.cn-beijing.volces.com/api/v3/', 'chat')).toEqual([
      'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    ]);
  });
});

describe('连通性自检（mock HTTP server）', () => {
  it('成功：POST /v1/chat/completions，body 里 max_tokens 必须为 1', async () => {
    await withServer(
      {
        '/v1/chat/completions': replyJson({
          choices: [{ message: { content: '' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      },
      async (target) => {
        const result = await runSelfTest(
          // 站没有 /models 之外的路由：原样地址 404 → 自动补 /v1 命中（M3R9 §4）
          { ...baseInput, baseUrl: target.baseUrl },
          { fetchImpl: nodeFetch },
        );

        expect(result.ok).toBe(true);
        expect(result.url).toBe(`${target.baseUrl}/v1/chat/completions`);
        expect(result.usage?.total_tokens).toBe(2);
        // §1-④：结果必须说清「用的是哪个模型测的」
        expect(result.testedModel).toBe('gpt-test');

        const sent = JSON.parse(target.hits[target.hits.length - 1].body) as Record<string, unknown>;
        expect(sent.max_tokens).toBe(1);
        expect(sent.model).toBe('gpt-test');
        expect(target.hits[target.hits.length - 1].method).toBe('POST');
        expect(target.hits[target.hits.length - 1].headers.authorization).toBe(`Bearer ${baseInput.apiKey}`);
      },
    );
  });

  it('401 → unauthorized，人话里不能出现 "HTTP 401"', async () => {
    await withServer(
      { '/v1/chat/completions': replyJson({ error: { message: 'invalid key' } }, 401) },
      async (target) => {
        const result = await runSelfTest(
          { ...baseInput, baseUrl: target.baseUrl },
          { fetchImpl: nodeFetch },
        );
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe(AIErrorCode.UNAUTHORIZED);
        expect(result.error?.userMessage).toContain('API Key 无效');
        expect(result.error?.userMessage).not.toContain('HTTP');
        expect(result.error?.retryable).toBe(false);
      },
    );
  });

  it('403 → forbidden（站端限制，不是 key 错）', async () => {
    await withServer(
      { '/v1/chat/completions': replyJson({ error: { message: 'group not allowed' } }, 403) },
      async (target) => {
        const result = await runSelfTest(
          { ...baseInput, baseUrl: target.baseUrl },
          { fetchImpl: nodeFetch },
        );
        expect(result.error?.code).toBe(AIErrorCode.FORBIDDEN);
        expect(result.error?.userMessage).toContain('没有访问权限');
      },
    );
  });

  it('404（无权限码）→ model_not_found（两个候选地址都试过）', async () => {
    await withServer(
      {
        '/v1/chat/completions': replyJson({ error: { message: 'no such model' } }, 404),
        '/chat/completions': replyJson({ error: { message: 'no such model' } }, 404),
      },
      async (target) => {
        const result = await runSelfTest(
          { ...baseInput, baseUrl: target.baseUrl },
          { fetchImpl: nodeFetch },
        );
        expect(result.error?.code).toBe(AIErrorCode.MODEL_NOT_FOUND);
        // M3R9 §4：原样地址先打，404 才补 /v1
        expect(target.hits.map((hit) => hit.path)).toEqual([
          '/chat/completions',
          '/v1/chat/completions',
        ]);
      },
    );
  });

  it('429 → rate_limit（可重试）', async () => {
    await withServer(
      { '/v1/chat/completions': replyJson({ error: { message: 'slow down' } }, 429) },
      async (target) => {
        const result = await runSelfTest(
          { ...baseInput, baseUrl: target.baseUrl },
          { fetchImpl: nodeFetch },
        );
        expect(result.error?.code).toBe(AIErrorCode.RATE_LIMIT);
        expect(result.error?.retryable).toBe(true);
        expect(result.error?.userMessage).toContain('限流');
      },
    );
  });

  it('余额不足：400 + body 提到余额 → insufficient_quota（不能当成参数错）', async () => {
    await withServer(
      {
        '/v1/chat/completions': replyJson(
          { error: { message: '账户余额不足，请充值', code: 'insufficient_quota' } },
          400,
        ),
      },
      async (target) => {
        const result = await runSelfTest(
          { ...baseInput, baseUrl: target.baseUrl },
          { fetchImpl: nodeFetch },
        );
        expect(result.error?.code).toBe(AIErrorCode.INSUFFICIENT_QUOTA);
        expect(result.error?.userMessage).toBe('账户余额不足，请充值后重试');
      },
    );
  });

  it('非 JSON（200 + HTML）→ invalid_response', async () => {
    await withServer(
      { '/v1/chat/completions': replyText('<!doctype html><html>站点首页</html>') },
      async (target) => {
        const result = await runSelfTest(
          { ...baseInput, baseUrl: target.baseUrl },
          { fetchImpl: nodeFetch },
        );
        expect(result.error?.code).toBe(AIErrorCode.INVALID_RESPONSE);
        expect(result.error?.userMessage).toContain('不是 JSON');
      },
    );
  });

  it('超时：服务器不响应 → timeout（不挂死，按注入的超时时间返回）', async () => {
    await withServer({ '/v1/chat/completions': hang, '/chat/completions': hang }, async (target) => {
      const started = Date.now();
      const result = await runSelfTest(
        { ...baseInput, baseUrl: target.baseUrl },
        { fetchImpl: nodeFetch, timeoutMs: 120 },
      );
      const elapsed = Date.now() - started;
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe(AIErrorCode.TIMEOUT);
      expect(elapsed).toBeLessThan(2000);
    });
  });

  it('1210 → image_not_supported（明确提示换视觉模型）', async () => {
    await withServer(
      { '/v1/chat/completions': replyJson({ error: { code: 1210, message: 'model does not support image' } }, 400) },
      async (target) => {
        const result = await runSelfTest(
          { ...baseInput, baseUrl: target.baseUrl },
          { fetchImpl: nodeFetch },
        );
        expect(result.error?.code).toBe(AIErrorCode.IMAGE_NOT_SUPPORTED);
        expect(result.error?.userMessage).toContain('此模型不支持图片输入');
        expect(result.error?.userMessage).toContain('deepseek-flash');
      },
    );
  });

  it('1214 → invalid_image_format（提示换 PNG/JPEG）', async () => {
    await withServer(
      { '/v1/chat/completions': replyJson({ error: { code: '1214', message: 'invalid image format' } }, 400) },
      async (target) => {
        const result = await runSelfTest(
          { ...baseInput, baseUrl: target.baseUrl },
          { fetchImpl: nodeFetch },
        );
        expect(result.error?.code).toBe(AIErrorCode.INVALID_IMAGE_FORMAT);
        expect(result.error?.userMessage).toContain('图片格式');
      },
    );
  });

  it('连接被拒 → network_error', async () => {
    const result = await runSelfTest(
      { ...baseInput, baseUrl: 'http://127.0.0.1:1' },
      { fetchImpl: nodeFetch, timeoutMs: 500 },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(AIErrorCode.NETWORK_ERROR);
  });

  it('Anthropic 协议：POST /v1/messages + x-api-key 头', async () => {
    await withServer(
      {
        '/v1/messages': replyJson({ content: [{ type: 'text', text: '' }] }),
      },
      async (target) => {
        const result = await runSelfTest(
          { ...baseInput, baseUrl: target.baseUrl, protocol: 'anthropic' },
          { fetchImpl: nodeFetch },
        );
        expect(result.ok).toBe(true);
        expect(result.url).toBe(`${target.baseUrl}/v1/messages`);
        expect(target.hits[0].headers['x-api-key']).toBe('sk-test-1234567890');
        expect(target.hits[0].headers['anthropic-version']).toBe('2023-06-01');
      },
    );
  });

  it('Responses 协议：POST /v1/responses + input/max_output_tokens，{output_text} 取到文本', async () => {
    await withServer({ '/v1/responses': replyJson({ output_text: 'OK' }) }, async (target) => {
      const result = await runSelfTest(
        { ...baseInput, baseUrl: target.baseUrl, protocol: 'responses' },
        { fetchImpl: nodeFetch },
      );
      expect(result.ok).toBe(true);
      expect(result.url).toBe(`${target.baseUrl}/v1/responses`);
      expect(result.content).toBe('OK');

      const sent = JSON.parse(target.hits[0].body) as Record<string, unknown>;
      expect(sent.model).toBe(baseInput.model);
      // /responses 的入参叫 input、上限叫 max_output_tokens
      expect(sent.input).toBe('ping');
      expect(sent.max_output_tokens).toBe(1);
      expect(sent.messages).toBeUndefined();
      expect(sent.max_tokens).toBeUndefined();
      // 认证头与 OpenAI 一致（Bearer）
      expect(String(target.hits[0].headers.authorization)).toContain('Bearer ');
    });
  });

  it('Responses 协议 401 → unauthorized（人话「API Key 无效」，不出现 HTTP）', async () => {
    await withServer(
      { '/v1/responses': replyJson({ error: { message: 'invalid key' } }, 401) },
      async (target) => {
        const result = await runSelfTest(
          { ...baseInput, baseUrl: target.baseUrl, protocol: 'responses' },
          { fetchImpl: nodeFetch },
        );
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe(AIErrorCode.UNAUTHORIZED);
        expect(result.error?.userMessage).toContain('API Key 无效');
        expect(result.error?.userMessage).not.toContain('HTTP');
      },
    );
  });

  it('Responses 协议：output[].content[].text 形状也能取到；取不到只返回空串，不看内容判成败', async () => {
    await withServer(
      {
        '/v1/responses': replyJson({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
        }),
      },
      async (target) => {
        const nested = await runSelfTest(
          { ...baseInput, baseUrl: target.baseUrl, protocol: 'responses' },
          { fetchImpl: nodeFetch },
        );
        expect(nested.ok).toBe(true);
        expect(nested.content).toBe('OK');
      },
    );

    await withServer({ '/v1/responses': replyJson({ id: 'resp_1' }) }, async (target) => {
      const bare = await runSelfTest(
        { ...baseInput, baseUrl: target.baseUrl, protocol: 'responses' },
        { fetchImpl: nodeFetch },
      );
      // 解析不出文本也不算失败：只看 status（防御式，§4.1）
      expect(bare.ok).toBe(true);
      expect(bare.content).toBe('');
    });
  });

  it('Responses 协议下拉模型列表同样走 /models（不看协议）', async () => {
    await withServer(
      { '/v1/models': replyJson({ data: [{ id: 'gpt-6.1-sol' }] }) },
      async (target) => {
        const result = await listModels(
          { ...baseInput, baseUrl: target.baseUrl, protocol: 'responses' },
          { fetchImpl: nodeFetch },
        );
        expect(result.ok).toBe(true);
        expect(result.models).toEqual(['gpt-6.1-sol']);
        // M3R9 §4：先打原样地址（这里 404），补 /v1 才命中
        expect(target.hits.map((hit) => hit.path)).toEqual(['/models', '/v1/models']);
      },
    );
  });

  it('注入的 fetchImpl 生效 → 全局 fetch 一次都没被调用', async () => {
    const globalFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', globalFetch);

    await withServer({ '/v1/chat/completions': replyJson({ choices: [] }) }, async (target) => {
      await runSelfTest({ ...baseInput, baseUrl: target.baseUrl }, { fetchImpl: nodeFetch });
    });

    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe('拉模型列表（失败也要试带 /v1 的地址）', () => {
  it('没有 /v1 的站：原样 /models 直接成功（M3R9 §4 顺序反了，先打用户填的）', async () => {
    await withServer(
      { '/models': replyJson({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }) },
      async (target) => {
        const result = await listModels({ ...baseInput, baseUrl: target.baseUrl }, { fetchImpl: nodeFetch });
        expect(result.ok).toBe(true);
        expect(result.models).toEqual(['deepseek-chat', 'deepseek-reasoner']);
        expect(result.url).toBe(`${target.baseUrl}/models`);
        expect(target.hits.map((hit) => hit.path)).toEqual(['/models']);
      },
    );
  });

  it('/v1/models 正常时不打第二个地址（地址自带 /v1 的情况）', async () => {
    await withServer(
      { '/v1/models': replyJson({ models: [{ name: 'glm-5.3' }, 'glm-5.3-flash'] }) },
      async (target) => {
        const result = await listModels(
          { ...baseInput, baseUrl: `${target.baseUrl}/v1` },
          { fetchImpl: nodeFetch },
        );
        expect(result.ok).toBe(true);
        expect(result.models).toEqual(['glm-5.3', 'glm-5.3-flash']);
        expect(target.hits).toHaveLength(1);
      },
    );
  });

  it('两个地址都不行 → 失败但提示可以手填（UI 据此降级）', async () => {
    await withServer({}, async (target) => {
      const result = await listModels({ ...baseInput, baseUrl: target.baseUrl }, { fetchImpl: nodeFetch });
      expect(result.ok).toBe(false);
      expect(result.error?.userMessage).toContain('手填');
      expect(result.error?.message).toContain('已尝试');
      // M3R9 §4：原样 → 补 /v1
      expect(target.hits.map((hit) => hit.path)).toEqual(['/models', '/v1/models']);
    });
  });

  it('extractModelNames 兼容三种形状', () => {
    expect(extractModelNames({ data: [{ id: 'a' }] })).toEqual(['a']);
    expect(extractModelNames({ models: [{ name: 'b' }, { model: 'c' }] })).toEqual(['b', 'c']);
    expect(extractModelNames(['d', { id: 'e' }, 'd'])).toEqual(['d', 'e']);
  });
});

describe('拉模型列表：404 是「没有列表接口」，不是连不上（M3R §6）', () => {
  it('两个地址都 404 → models_not_listed，文案说清「没有模型列表接口」且不提「连不上服务器」', async () => {
    await withServer({}, async (target) => {
      const result = await listModels({ ...baseInput, baseUrl: target.baseUrl }, { fetchImpl: nodeFetch });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe(AIErrorCode.MODELS_NOT_LISTED);
      expect(result.error?.userMessage).toContain('这家没有模型列表接口');
      expect(result.error?.userMessage).toContain('火山方舟');
      expect(result.error?.userMessage).toContain('不影响保存和使用');
      expect(result.error?.userMessage).not.toContain('连不上服务器');
      // 技术细节：GET + 命中地址 + 404 + 耗时 + 响应体前 200 字
      expect(result.diagnostics?.method).toBe('GET');
      expect(result.diagnostics?.url).toBe(`${target.baseUrl}/v1/models`);
      expect(result.diagnostics?.status).toBe(404);
      expect(typeof result.diagnostics?.elapsedMs).toBe('number');
      // M3R9 §4：原样 → 补 /v1，命中地址是最后一个
      expect(result.diagnostics?.attemptedUrls).toEqual([
        `${target.baseUrl}/models`,
        `${target.baseUrl}/v1/models`,
      ]);
    });
  });

  it('200 但不是 OpenAI 格式 → invalid_response + 「接口返回的不是 OpenAI 格式」', async () => {
    await withServer(
      { '/v1/models': replyJson({ hello: 'world' }), '/models': replyJson({ hello: 'world' }) },
      async (target) => {
        const result = await listModels(
          { ...baseInput, baseUrl: target.baseUrl },
          { fetchImpl: nodeFetch },
        );
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe(AIErrorCode.INVALID_RESPONSE);
        expect(result.error?.userMessage).toContain('接口返回的不是 OpenAI 格式');
        expect(result.error?.userMessage).not.toContain('连不上服务器');
        expect(result.diagnostics?.bodyPreview).toContain('hello');
      },
    );
  });
});

describe('技术细节（M3R §6）：自检也要给 METHOD / 状态 / error.name / 响应前 200 字', () => {
  it('超时：error.name 是 AbortError，状态 0，body 为空', async () => {
    await withServer({ '/v1/chat/completions': hang, '/chat/completions': hang }, async (target) => {
      const result = await runSelfTest(
        { ...baseInput, baseUrl: target.baseUrl },
        { fetchImpl: nodeFetch, timeoutMs: 120 },
      );
      expect(result.error?.code).toBe(AIErrorCode.TIMEOUT);
      expect(result.diagnostics?.method).toBe('POST');
      expect(result.diagnostics?.status).toBe(0);
      expect(result.diagnostics?.errorName).toBe('AbortError');
      expect(result.diagnostics?.bodyPreview).toBe('');
      expect(result.diagnostics?.attemptedUrls.length).toBeGreaterThan(0);
    });
  });

  it('401：状态与响应体前 200 字都留在诊断里（主提示仍是人话）', async () => {
    await withServer(
      { '/v1/chat/completions': replyJson({ error: { message: 'invalid key' } }, 401) },
      async (target) => {
        const result = await runSelfTest(
          { ...baseInput, baseUrl: target.baseUrl },
          { fetchImpl: nodeFetch },
        );
        expect(result.diagnostics?.status).toBe(401);
        expect(result.diagnostics?.method).toBe('POST');
        expect(result.diagnostics?.url).toBe(`${target.baseUrl}/v1/chat/completions`);
        expect(result.diagnostics?.bodyPreview).toContain('invalid key');
        expect(result.error?.userMessage).not.toContain('HTTP');
      },
    );
  });

  it('响应体超过 200 字只截前 200 字（诊断块不塞整页 HTML）', async () => {
    const longBody = `<html>${'x'.repeat(500)}</html>`;
    await withServer(
      { '/v1/chat/completions': replyText(longBody) },
      async (target) => {
        const result = await runSelfTest(
          { ...baseInput, baseUrl: `${target.baseUrl}/v1` },
          { fetchImpl: nodeFetch },
        );
        expect(result.diagnostics?.bodyPreview.length).toBe(200);
      },
    );
  });
});

describe('正式对话（M4 用，M3 不发）', () => {
  it('成功解析 content 与 usage', async () => {
    await withServer(
      {
        '/v1/chat/completions': replyJson({
          choices: [{ message: { content: '你好' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      },
      async (target) => {
        const response = await chat(
          { ...baseInput, baseUrl: target.baseUrl },
          { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] },
          { fetchImpl: nodeFetch },
        );
        expect(response.success).toBe(true);
        if (response.success) {
          expect(response.content).toBe('你好');
          expect(response.usage?.total_tokens).toBe(5);
        }
      },
    );
  });
});
