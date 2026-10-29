/**
 * 汇率服务：解析 / 双源兜底 / 本地缓存 / 离线估值。
 *
 * 网络是 mock 的——这里锁的是「拿到什么报文，落什么状态」，
 * 真实可达性靠人工验证（2026-10-29 实测：qt.gtimg.cn 与 exchangerate-api 都 200 且带 CORS）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_USD_CNY,
  FX_TTL_MS,
  formatFxHint,
  isFxStale,
  parseExchangerateFx,
  parseTencentFx,
  readFxCache,
  refreshFx,
} from './index';

const TENCENT_BODY =
  'v_pv_none_match="1";v_whUSDCNY="310~美元人民币~USDCNY~6.6621~0~20261029110706~6.6660~6.6640~6.6644~6.6620~6.6621~6.6622~-0.0039~-0.06~-0.19~-0.43~-0.72~-1.48~-4.65~7.1332~6.6620~2026-10-29";';

function mockFetch(map: Record<string, () => Response | Promise<Response>>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const hit = Object.keys(map).find((key) => url.includes(key));
      if (!hit) throw new TypeError('network down');
      return map[hit]();
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('报文解析', () => {
  it('腾讯那条（GBK 文本里只取数字）：第 4 段是最新价', () => {
    expect(parseTencentFx(TENCENT_BODY)).toBe(6.6621);
  });

  it('腾讯返回空/畸形 → null，不是 NaN', () => {
    expect(parseTencentFx('v_pv_none_match="1";')).toBeNull();
    expect(parseTencentFx('v_whUSDCNY="310~美元人民币~USDCNY~abc";')).toBeNull();
    expect(parseTencentFx('v_whUSDCNY="310~美元人民币~USDCNY~0";')).toBeNull();
  });

  it('备用源取 rates.CNY', () => {
    expect(parseExchangerateFx({ rates: { CNY: 7.1234 } })).toBe(7.1234);
    expect(parseExchangerateFx({ rates: {} })).toBeNull();
    expect(parseExchangerateFx(null)).toBeNull();
  });
});

describe('refreshFx：先腾讯，失败再备用源，都失败用缓存', () => {
  it('腾讯成功 → source=tencent，并写进缓存', async () => {
    mockFetch({
      'qt.gtimg.cn': () => new Response(TENCENT_BODY, { status: 200 }),
    });
    const snapshot = await refreshFx();
    expect(snapshot.rate).toBe(6.6621);
    expect(snapshot.source).toBe('tencent');
    expect(snapshot.fetchedAt).toBeGreaterThan(0);

    const cached = readFxCache();
    expect(cached.rate).toBe(6.6621);
    expect(cached.source).toBe('cache');
  });

  it('腾讯挂了 → 落到备用源', async () => {
    mockFetch({
      'exchangerate-api.com': () => new Response(JSON.stringify({ rates: { CNY: 7.05 } }), { status: 200 }),
    });
    const snapshot = await refreshFx();
    expect(snapshot.rate).toBe(7.05);
    expect(snapshot.source).toBe('exchangerate');
  });

  it('两个源都挂 → 用缓存里的上一份（断网可用）', async () => {
    localStorage.setItem('fx-usd-cny', JSON.stringify({ rate: 6.9, fetchedAt: Date.now() - 1000 }));
    mockFetch({});
    const snapshot = await refreshFx();
    expect(snapshot.rate).toBe(6.9);
    expect(snapshot.source).toBe('cache');
  });

  it('两个源都挂且没有缓存 → 常量 6.8，并标 fallback', async () => {
    mockFetch({});
    const snapshot = await refreshFx();
    expect(snapshot.rate).toBe(FALLBACK_USD_CNY);
    expect(snapshot.source).toBe('fallback');
    expect(snapshot.fetchedAt).toBe(0);
  });
});

describe('缓存新鲜度与文案', () => {
  it('超过 TTL 才算旧；fallback 永远算旧', () => {
    const fresh = { rate: 6.9, fetchedAt: Date.now(), source: 'cache' as const };
    expect(isFxStale(fresh)).toBe(false);
    expect(isFxStale({ ...fresh, fetchedAt: Date.now() - FX_TTL_MS - 1 })).toBe(true);
    expect(isFxStale({ rate: 6.8, fetchedAt: 0, source: 'fallback' })).toBe(true);
  });

  it('文案：离线写「离线估值」，在线写「MM-DD 更新」', () => {
    expect(formatFxHint({ rate: 6.8, fetchedAt: 0, source: 'fallback' })).toBe('6.80 · 离线估值');
    const at = new Date(2026, 9, 29, 11, 7).getTime();
    expect(formatFxHint({ rate: 6.6621, fetchedAt: at, source: 'tencent' })).toBe('6.66 · 10-29 更新');
  });
});
