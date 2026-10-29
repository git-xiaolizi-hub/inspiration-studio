/**
 * M3R10 §1 / §5-1..3：把 `TypeError: Failed to fetch` 正确分类成 CORS，而**不是**网络不可达。
 *
 * 为什么这些用例重要：实测（2026-10-18）火山方舟与灵绘在浏览器里的表现，
 * 与「网络真不通」在 JS 侧**一模一样**（无状态码 + TypeError + 几十毫秒）。
 * 旧判据把它们混成一句「检查网络与代理，以及 base_url 是否写错」——
 * 用户会照着去改一个本来完全正确的地址。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CORS_BLOCKED_HINT,
  CORS_BLOCKED_SENTENCE,
  CORS_FAST_FAILURE_MS,
  REJECTED_UNREADABLE_SENTENCE,
  decideCorsOrRejected,
  looksLikeCorsBlock,
  preflightOk,
} from './cors';

describe('M3R10 §5-1：TypeError + 无状态码 + 快 → CORS_BLOCKED', () => {
  it('实测形态（方舟 61ms / 灵绘 57ms）：TypeError、无 status、耗时几十毫秒 → 判 CORS', () => {
    expect(looksLikeCorsBlock({ status: 0, errorName: 'TypeError', elapsedMs: 61 })).toBe(true);
    expect(looksLikeCorsBlock({ status: undefined, errorName: 'TypeError', elapsedMs: 57 })).toBe(
      true,
    );
  });

  it('耗时正好卡在上限内算 CORS，到上限就不算（边界不能靠"大概"）', () => {
    expect(looksLikeCorsBlock({ errorName: 'TypeError', elapsedMs: CORS_FAST_FAILURE_MS - 1 })).toBe(
      true,
    );
    expect(looksLikeCorsBlock({ errorName: 'TypeError', elapsedMs: CORS_FAST_FAILURE_MS })).toBe(
      false,
    );
  });

  it('慢速 TypeError（如 DNS 解析失败、真连接被断）→ 不算 CORS，仍交网络分类', () => {
    // CORS 拦截在本地完成，不会耗到几秒；这里宁可漏报也不谎报
    expect(looksLikeCorsBlock({ errorName: 'TypeError', elapsedMs: 9000 })).toBe(false);
  });

  it('异常名不是 TypeError（Node 侧的 ECONNREFUSED 等）→ 不算 CORS', () => {
    expect(looksLikeCorsBlock({ errorName: 'Error', elapsedMs: 30 })).toBe(false);
    expect(looksLikeCorsBlock({ errorName: '', elapsedMs: 30 })).toBe(false);
    expect(looksLikeCorsBlock({ errorName: undefined, elapsedMs: 30 })).toBe(false);
  });

  it('缺耗时 → 不猜，判不了就不算 CORS', () => {
    expect(looksLikeCorsBlock({ errorName: 'TypeError' })).toBe(false);
    expect(looksLikeCorsBlock({ errorName: 'TypeError', elapsedMs: Number.NaN })).toBe(false);
  });
});

describe('M3R10 §5-3：有状态码就不是 CORS（不能被误判）', () => {
  it('401 / 403 / 404 / 429 带着 TypeError 与 30ms 也一律不算 CORS', () => {
    // 拿到响应 = 跨域是放行的，必须继续走原有的状态码分类
    for (const status of [200, 401, 403, 404, 429, 500]) {
      expect(looksLikeCorsBlock({ status, errorName: 'TypeError', elapsedMs: 30 })).toBe(false);
    }
  });
});

describe('M3R10 §5-2 + M3R11 §1：CORS 文案逐字，且不得出现误导提示', () => {
  it('那句话逐字对得上（M3R11 §1 给的原话，已把「豆包」写进可选厂商）', () => {
    expect(CORS_BLOCKED_SENTENCE).toBe(
      '这家不允许浏览器直连（服务器未开放跨域）。中转站常见。桌面版可用；Web 版请改用智谱 / 豆包 / DeepSeek / Kimi / 阿里百炼。',
    );
  });

  it('含「不允许浏览器直连」，且**不含**「检查网络与代理」（判据 §5-2 两条同时断言）', () => {
    expect(CORS_BLOCKED_SENTENCE).toContain('不允许浏览器直连');
    expect(CORS_BLOCKED_SENTENCE).not.toContain('检查网络与代理');
    // 「base_url 是否写错」是同一类误导（用户会去改一个正确的地址），一并挡住
    expect(CORS_BLOCKED_SENTENCE).not.toContain('base_url');
  });

  it('连接行/自检失败处的那行小字也逐字对得上，且同样不提网络', () => {
    expect(CORS_BLOCKED_HINT).toBe('浏览器直连被这家拒绝（CORS）。用桌面版可正常调用。');
    expect(CORS_BLOCKED_HINT).not.toContain('检查网络与代理');
  });
});

/**
 * M3R11 §1：**第二段判定**。方舟的 401 不带 ACAO，所以「key 写错」在浏览器里
 * 也是一条 `TypeError`；只有探一次 OPTIONS 才分得开「被拦」与「被拒但读不到」。
 */
describe('M3R11 §1：preflightOk / decideCorsOrRejected', () => {
  it('能读到状态码就算通过（方舟预检 204、业务响应 404、405 都算）', async () => {
    for (const status of [204, 404, 405]) {
      const impl = vi.fn(async () => ({ status }));
      await expect(
        preflightOk('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
          fetchImpl: impl,
        }),
      ).resolves.toBe(true);
      expect(impl).toHaveBeenCalledTimes(1);
    }
  });

  it('发的是 OPTIONS，并带上 Access-Control-Request-Method / -Headers（复现证据的形态）', async () => {
    const seen: Array<{ url: string; init: { method?: string; headers?: Record<string, string> } }> = [];
    const impl = async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
      seen.push({ url, init });
      return { status: 204 };
    };
    await preflightOk('https://ark.cn-beijing.volces.com/api/v3/models', { fetchImpl: impl });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://ark.cn-beijing.volces.com/api/v3/models');
    expect(seen[0].init.method).toBe('OPTIONS');
    expect(seen[0].init.headers?.['Access-Control-Request-Method']).toBe('POST');
    expect(seen[0].init.headers?.['Access-Control-Request-Headers']).toContain('authorization');
  });

  it('预检自己就抛（灵绘 nginx 403 / 网络断）→ false，且**不抛异常**', async () => {
    const impl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      preflightOk('https://xn--ai-xg4e312c.com/v1/chat/completions', { fetchImpl: impl }),
    ).resolves.toBe(false);
  });

  it('预检超时会自己中止，不会把整个回合挂住', async () => {
    const impl = (_url: string, init: { signal?: AbortSignal }) =>
      new Promise<{ status: number }>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new TypeError('aborted')));
      });
    await expect(
      preflightOk('https://example.com/v1/chat/completions', { fetchImpl: impl, timeoutMs: 20 }),
    ).resolves.toBe(false);
  });

  it('decideCorsOrRejected：通过 → rejected_unreadable；未通过 / 没探 → cors_blocked（老行为不回归）', () => {
    expect(decideCorsOrRejected(true)).toBe('rejected_unreadable');
    expect(decideCorsOrRejected(false)).toBe('cors_blocked');
    expect(decideCorsOrRejected(undefined)).toBe('cors_blocked');
  });

  it('两段文案各就各位：REJECTED_UNREADABLE 含「Key 无效」，且**不含**「不允许浏览器直连」', () => {
    expect(REJECTED_UNREADABLE_SENTENCE).toContain('Key 无效');
    expect(REJECTED_UNREADABLE_SENTENCE).not.toContain('不允许浏览器直连');
    // 判据 §1：禁止说成「网络不通 / 检查代理」
    expect(REJECTED_UNREADABLE_SENTENCE).not.toContain('网络不通');
    expect(REJECTED_UNREADABLE_SENTENCE).not.toContain('检查代理');
    expect(REJECTED_UNREADABLE_SENTENCE).toContain('拉取模型列表');
  });
});
