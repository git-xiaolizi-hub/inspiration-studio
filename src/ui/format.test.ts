import { describe, expect, it } from 'vitest';
import { formatDateTime, startOfToday } from './format';

/**
 * P0.5 · `startOfToday()` 的时区语义。
 *
 * 关键点：它必须按**本地时区**划天。如果写成 `Date.UTC(...)` 或
 * `new Date().setUTCHours(0,0,0,0)`，在东八区会把 00:00–08:00 写下的记录算成「昨天」。
 *
 * 这几条断言在 UTC+8 / UTC / UTC-4 下都成立（期望值一律从本地分量推出来），
 * 而「本地零点」的断言（getHours() === 0）只有在实现真的用本地时区时才过 ——
 * 换成 UTC 划天，非 UTC 时区下立刻红。
 */
describe('startOfToday：本地时区当天 00:00', () => {
  it('返回的是本地零点（时/分/秒/毫秒全为 0），且日期与传入时间同一天', () => {
    const now = new Date(2026, 9, 21, 14, 37, 12, 456).getTime();
    const start = startOfToday(now);
    const startDate = new Date(start);

    expect(startDate.getHours()).toBe(0);
    expect(startDate.getMinutes()).toBe(0);
    expect(startDate.getSeconds()).toBe(0);
    expect(startDate.getMilliseconds()).toBe(0);

    expect(startDate.getFullYear()).toBe(2026);
    expect(startDate.getMonth()).toBe(9);
    expect(startDate.getDate()).toBe(21);
  });

  it('now 落在 [start, start + 24h) 之间', () => {
    const now = Date.now();
    const start = startOfToday(now);

    expect(start).toBeLessThanOrEqual(now);
    expect(now - start).toBeLessThan(24 * 3600_000);
  });

  it('边界：当天 00:00:00.000 返回自身；23:59:59.999 返回当天零点', () => {
    const midnight = new Date(2026, 9, 21, 0, 0, 0, 0).getTime();
    const lastMs = new Date(2026, 9, 21, 23, 59, 59, 999).getTime();

    expect(startOfToday(midnight)).toBe(midnight);
    expect(startOfToday(lastMs)).toBe(midnight);
  });

  it('不是 UTC 划天：UTC 日期与本地日期不同的时间戳，仍算到本地那一天', () => {
    // 这个瞬间在 UTC 是 10-20 20:00，在东八区是 10-21 04:00。
    // 若实现按 UTC 划天，返回的本地时间会是 08:00（getHours() !== 0），这条立刻失败。
    const ts = Date.UTC(2026, 9, 20, 20, 0, 0);
    const start = startOfToday(ts);
    const startDate = new Date(start);
    const nowLocal = new Date(ts);

    expect(startDate.getHours()).toBe(0);
    expect(startDate.getDate()).toBe(nowLocal.getDate());
    expect(startDate.getMonth()).toBe(nowLocal.getMonth());
    expect(ts).toBeGreaterThanOrEqual(start);
    expect(ts - start).toBeLessThan(24 * 3600_000);
  });

  it('跨年边界：2027-01-01 00:30 的零点落在 1 月 1 日，不是 12 月 31 日', () => {
    const earlyNewYear = new Date(2027, 0, 1, 0, 30, 0, 0).getTime();
    const startDate = new Date(startOfToday(earlyNewYear));

    expect(startDate.getFullYear()).toBe(2027);
    expect(startDate.getMonth()).toBe(0);
    expect(startDate.getDate()).toBe(1);
  });

  it('不传参时用当前时间（与传 Date.now() 结果相同）', () => {
    // 两次调用之间存在毫秒级跨越的风险；容忍「跨过了零点」这一种情况
    const a = startOfToday();
    const b = startOfToday(Date.now());
    expect(Math.abs(a - b)).toBeLessThan(24 * 3600_000);
    expect(new Date(a).getHours()).toBe(0);
  });

  it('与「按 UTC 划天」的写法对比：只要本机不是 UTC，两者就必须不同（证明用的是本地零点）', () => {
    const ts = Date.UTC(2026, 9, 20, 20, 0, 0);
    const utcMidnight = new Date(ts);
    utcMidnight.setUTCHours(0, 0, 0, 0);
    const offsetMinutes = -new Date(ts).getTimezoneOffset();

    if (offsetMinutes === 0) {
      // 本机就是 UTC 时两种写法等价，这条不构成区分（靠上面 getHours()===0 那条兜住）
      expect(startOfToday(ts)).toBe(utcMidnight.getTime());
      return;
    }

    expect(startOfToday(ts)).not.toBe(utcMidnight.getTime());
    // 且恰好是「本地年月日 + 00:00」那个瞬间
    const local = new Date(ts);
    expect(startOfToday(ts)).toBe(
      new Date(local.getFullYear(), local.getMonth(), local.getDate()).getTime(),
    );
  });
});

describe('formatDateTime（回归：本轮碰过这个文件，确认没改坏）', () => {
  it('格式化成本地时间 "YYYY-MM-DD HH:mm"', () => {
    expect(formatDateTime(new Date(2026, 9, 21, 9, 5).getTime())).toBe('2026-10-21 09:05');
  });

  it('非法时间戳返回破折号', () => {
    expect(formatDateTime(0)).toBe('—');
    expect(formatDateTime(Number.NaN)).toBe('—');
  });
});
