/**
 * 美元兑人民币汇率（2026-10-29 委托人提出）。
 *
 * 为什么要有它：国外模型的官方价是美元。软件把「官方价 × 倍率」当人民币估，
 * 前提是中转站 ¥1=$1；用户若走官方按量付费，倍率应当等于真实汇率。
 * 把 6.8 写死会随时间失真，所以：
 *
 * 1. 联网取最新价（两个源，都是国内可直连且带 `Access-Control-Allow-Origin: *` 的）；
 * 2. 成功就存本地（localStorage），断网时继续用最后一次拿到的值；
 * 3. 全都失败才退回常量 6.8，并在界面上标明「离线估值」。
 *
 * 注意：刷新汇率**不会**改写用户已经填好的倍率——那是用户的配置，不是我们的状态。
 */

export interface FxSnapshot {
  /** 1 美元 = rate 人民币 */
  rate: number;
  /** 取到的时间戳（ms）；用 fallback 时是 0 */
  fetchedAt: number;
  source: FxSource;
}

export type FxSource = 'tencent' | 'exchangerate' | 'cache' | 'fallback';

/** 全都失败时的兜底值 */
export const FALLBACK_USD_CNY = 6.8;

/** 缓存多久算「旧」（超过就在后台再拉一次，但仍然先用缓存） */
export const FX_TTL_MS = 6 * 60 * 60 * 1000;

const STORAGE_KEY = 'fx-usd-cny';

/** 腾讯财经外汇行情：`v_whUSDCNY="310~美元人民币~USDCNY~6.6621~…"`，第 4 段是最新价 */
const TENCENT_URL = 'https://qt.gtimg.cn/q=whUSDCNY';
/** 备用源：返回 JSON 的 rates.CNY */
const EXCHANGERATE_URL = 'https://api.exchangerate-api.com/v4/latest/USD';

function isUsable(rate: unknown): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 1 && rate < 20;
}

/** 解析腾讯那段 `~` 分隔的报文；GBK 里只有数字与中文名，我们只取数字 */
export function parseTencentFx(raw: string): number | null {
  const match = /v_whUSDCNY="([^"]*)"/.exec(raw);
  if (!match) return null;
  const parts = match[1].split('~');
  // 0 市场码 / 1 中文名 / 2 代码 / 3 最新价
  const rate = Number(parts[3]);
  return isUsable(rate) ? rate : null;
}

export function parseExchangerateFx(raw: unknown): number | null {
  const rate = Number((raw as { rates?: Record<string, unknown> } | null)?.rates?.CNY);
  return isUsable(rate) ? rate : null;
}

/** 同步读缓存：有就用，没有就 6.8。界面首帧不该等网络 */
export function readFxCache(): FxSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { rate: FALLBACK_USD_CNY, fetchedAt: 0, source: 'fallback' };
    const parsed = JSON.parse(raw) as Partial<FxSnapshot>;
    if (!isUsable(parsed.rate)) return { rate: FALLBACK_USD_CNY, fetchedAt: 0, source: 'fallback' };
    return {
      rate: parsed.rate,
      fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0,
      source: 'cache',
    };
  } catch {
    return { rate: FALLBACK_USD_CNY, fetchedAt: 0, source: 'fallback' };
  }
}

function writeFxCache(snapshot: FxSnapshot): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ rate: snapshot.rate, fetchedAt: snapshot.fetchedAt, source: snapshot.source }),
    );
  } catch {
    /* 存不进去也不影响本次使用 */
  }
}

export function isFxStale(snapshot: FxSnapshot, now = Date.now()): boolean {
  if (snapshot.fetchedAt === 0) return true;
  return now - snapshot.fetchedAt > FX_TTL_MS;
}

async function fetchTencent(signal?: AbortSignal): Promise<number> {
  const res = await fetch(TENCENT_URL, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`tencent ${res.status}`);
  // 这条报文是 GBK。不特意解 GBK：整串里 ASCII（引号、~、数字）在 GBK 与 UTF-8 下字节一致，
  // 只有中文名会变成替换字符，而我们只读第 4 段的数字——少一层解码就少一个失败点。
  const rate = parseTencentFx(await res.text());
  if (rate === null) throw new Error('tencent payload');
  return rate;
}

async function fetchExchangerate(signal?: AbortSignal): Promise<number> {
  const res = await fetch(EXCHANGERATE_URL, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`exchangerate ${res.status}`);
  const rate = parseExchangerateFx(await res.json());
  if (rate === null) throw new Error('exchangerate payload');
  return rate;
}

/**
 * 联网刷新一次。
 * 成功 → 写缓存并返回新值；两个源都失败 → 返回缓存（并标 source='cache'），
 * 缓存也没有才返回 6.8 的 fallback。**不会抛错**：汇率拿不到不该阻断任何操作。
 */
export async function refreshFx(options: { signal?: AbortSignal } = {}): Promise<FxSnapshot> {
  const sources: Array<[FxSource, (signal?: AbortSignal) => Promise<number>]> = [
    ['tencent', fetchTencent],
    ['exchangerate', fetchExchangerate],
  ];
  for (const [source, run] of sources) {
    try {
      const rate = await run(options.signal);
      const snapshot: FxSnapshot = { rate: Math.round(rate * 10000) / 10000, fetchedAt: Date.now(), source };
      writeFxCache(snapshot);
      return snapshot;
    } catch {
      /* 换下一个源 */
    }
  }
  const cached = readFxCache();
  return cached;
}

/** 「6.66 · 10-29 更新」/「6.80 · 离线估值」这类给用户看的短句 */
export function formatFxHint(snapshot: FxSnapshot): string {
  const rate = snapshot.rate.toFixed(snapshot.rate >= 10 ? 1 : 2);
  if (snapshot.fetchedAt === 0) return `${rate} · 离线估值`;
  const at = new Date(snapshot.fetchedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${rate} · ${day} 更新`;
}
