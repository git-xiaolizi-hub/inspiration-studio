/**
 * M3R10 §1：**从真实 fetch 抛异常到 UI 文案**的整条链路。
 *
 * 为什么不能用 `classifyFailure` 直接测：判据要的是「请求层把 `errorName` 与
 * `elapsedMs` 传给分类器」这件事真的发生了。少传一个字段，
 * `errors.test.ts` 那批用例照样全绿，而线上用户看到的仍是旧的误导文案。
 *
 * 做法：注入一个**像浏览器一样**抛 `TypeError: Failed to fetch` 的 fetchImpl，
 * 走 `runSelfTest` / `listModels` 的完整路径（含地址候选循环），断言最终 code 与文案。
 */
import { describe, expect, it } from 'vitest';
import { listModels, runSelfTest } from './client';
import type { FetchLike } from './client';
import { AIErrorCode } from './types';

/**
 * 浏览器被 CORS 拦时的真实形态：抛 `TypeError: Failed to fetch`，耗时几十毫秒。
 * 这里同步抛（不返回 rejected promise）以便耗时可控 —— 与浏览器一致。
 */
const corsLikeFetch: FetchLike = () => {
  const error = new TypeError('Failed to fetch');
  return Promise.reject(error);
};

/** 真网络问题：DNS 解析失败之类，耗时更长，异常名也不是 TypeError */
const dnsLikeFetch: FetchLike = () =>
  Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'Error' }));

const baseInput = { apiKey: 'sk-te...t', model: '', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' };

describe('M3R10 §1：请求层真的把 errorName / elapsedMs 传下去了', () => {
  it('runSelfTest：浏览器式 TypeError → CORS_BLOCKED，文案含「不允许浏览器直连」', async () => {
    const result = await runSelfTest(
      { ...baseInput, model: 'doubao-seed-2.1-pro' },
      { fetchImpl: corsLikeFetch, timeoutMs: 15_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(AIErrorCode.CORS_BLOCKED);
    expect(result.error?.userMessage).toContain('不允许浏览器直连');
    expect(result.error?.userMessage).not.toContain('检查网络与代理');
  });

  it('listModels：同一条链路（拉列表也必须是 CORS 而不是「连不上服务器」）', async () => {
    const result = await listModels(baseInput, { fetchImpl: corsLikeFetch, timeoutMs: 15_000 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(AIErrorCode.CORS_BLOCKED);
    expect(result.error?.userMessage).toContain('不允许浏览器直连');
  });

  it('技术细节里能看出真因：status 记 0、error.name 记 TypeError（给人排查用）', async () => {
    const result = await runSelfTest(
      { ...baseInput, model: 'doubao-seed-2.1-pro' },
      { fetchImpl: corsLikeFetch, timeoutMs: 15_000 },
    );
    expect(result.diagnostics?.status).toBe(0);
    expect(result.diagnostics?.errorName).toBe('TypeError');
    // 地址候选两条都试过（原样 → 补 /v1），这是"地址对不对"能从细节里看出来的前提
    expect(result.diagnostics?.attemptedUrls.length).toBeGreaterThan(0);
  });

  it('真网络问题（非 TypeError）仍然是 NETWORK_ERROR，旧文案保留', async () => {
    const result = await listModels(baseInput, { fetchImpl: dnsLikeFetch, timeoutMs: 15_000 });
    expect(result.error?.code).toBe(AIErrorCode.NETWORK_ERROR);
    expect(result.error?.userMessage).toContain('检查网络与代理');
  });
});

/**
 * M3R11 §1：**从请求层到文案**的第二段判定。
 *
 * 用「方舟 key 写错」的真实形态造一个 fetch：`OPTIONS` 返回 204（站支持跨域），
 * `POST` 抛 `TypeError`（401 不带 ACAO，浏览器读不到）。旧逻辑会报「不允许浏览器直连」，
 * 让用户去换厂商；新逻辑必须说「核对 Key / 模型名」。
 */
const arkWrongKeyFetch: FetchLike = (_input, init) => {
  if (init?.method === 'OPTIONS') {
    return Promise.resolve({ status: 204 } as Response);
  }
  return Promise.reject(new TypeError('Failed to fetch'));
};

describe('M3R11 §1：请求层把预检结论带进分类（两段判定的接线）', () => {
  it('POST 抛 TypeError 但 OPTIONS 通 → REJECTED_UNREADABLE（不是 CORS_BLOCKED）', async () => {
    const result = await runSelfTest(
      { ...baseInput, model: 'doubao-seed-2-1-pro-260628' },
      { fetchImpl: arkWrongKeyFetch, timeoutMs: 15_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(AIErrorCode.REJECTED_UNREADABLE);
    expect(result.error?.userMessage).toContain('Key 无效');
    expect(result.error?.userMessage).not.toContain('不允许浏览器直连');
    // 技术细节里仍要留下 TypeError（给人排查用）
    expect(result.diagnostics?.errorName).toBe('TypeError');
  });

  it('预检也抛（灵绘 nginx 403 形态）→ 仍归 CORS_BLOCKED', async () => {
    const result = await listModels(baseInput, { fetchImpl: corsLikeFetch, timeoutMs: 15_000 });
    expect(result.error?.code).toBe(AIErrorCode.CORS_BLOCKED);
    expect(result.error?.userMessage).toContain('不允许浏览器直连');
  });
});
