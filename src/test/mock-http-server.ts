/**
 * 测试专用：最小 mock HTTP server + 一个基于 node:http 的 fetch 实现。
 *
 * 为什么不用全局 fetch：`src/test/setup.ts` 把全局 fetch 换成"立刻失败"的桩，
 * 目的就是禁止测试里出现"看起来是 mock、其实在真发请求"的行为。
 * 这里显式把 `nodeFetch` 注入给客户端，请求只打到 127.0.0.1 的临时端口上，
 * 测的是**真实的 HTTP 行为**（状态码、body、超时、非 JSON），不是假对象。
 *
 * 注意：本文件不是 *.test.ts，不会被 vitest 当作用例收集。
 */
import { createServer, request as httpRequest } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { FetchLike } from '../adapters/ai-models/client';

export interface MockRequest {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

export type MockHandler = (request: MockRequest, response: ServerResponse) => void;

export interface MockServer {
  baseUrl: string;
  /** 收到过的请求（按顺序） */
  hits: MockRequest[];
  close: () => Promise<void>;
}

export async function startMockServer(handlers: Record<string, MockHandler>): Promise<MockServer> {
  const hits: MockRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const path = (request.url ?? '/').split('?')[0];
      const record: MockRequest = {
        method: request.method ?? 'GET',
        path,
        // 请求体按 utf8 暴露成字符串（现有用例都是 JSON）；二进制响应用 makeResponse 的 arrayBuffer
        body: Buffer.concat(chunks).toString('utf8'),
        headers: request.headers,
      };
      hits.push(record);
      const handler = handlers[path];
      if (handler) {
        handler(record, response);
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `没有为 ${path} 配 mock` } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        // 超时用例会留下挂起的连接：先强拆，再 close，否则测试会卡住
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** 极简 Response 桩：只提供客户端实际用到的 ok / status / headers.get / text / arrayBuffer */
function makeResponse(status: number, body: Buffer, contentType: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    text: async () => body.toString('utf8'),
    json: async () => JSON.parse(body.toString('utf8')) as unknown,
    // 二进制响应（图片/音频）用这个；`text()` 仍按 utf8（现有用例不受影响）
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  } as unknown as Response;
}

/** 只用 node:http 的 fetch，绕开测试环境里被禁用的全局 fetch */
export const nodeFetch: FetchLike = (input, init) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key] = String(value);
    }

    const request = httpRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? 'GET',
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('end', () => {
          const contentType = String(response.headers['content-type'] ?? '');
          resolve(makeResponse(response.statusCode ?? 500, Buffer.concat(chunks), contentType));
        });
      },
    );

    request.on('error', (error) => reject(error));

    if (init?.signal) {
      const signal = init.signal;
      if (signal.aborted) {
        request.destroy();
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      signal.addEventListener('abort', () => {
        request.destroy();
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }

    if (typeof init?.body === 'string') request.write(init.body);
    request.end();
  });
