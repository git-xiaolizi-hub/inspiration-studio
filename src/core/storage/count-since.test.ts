import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase, putRecord } from './index';
import { countRecords, countSince } from './queries';
import type { RecordRow } from './db';

/**
 * P0.5 · `countSince()`（首页「今天 N 条」的数据来源）。
 *
 * 这里造的是**表行**（RecordRow）而不是走 `createRecord()`：
 * 要精确控制 `createdAt`（今天 / 昨天 / 边界那一毫秒），走业务层造不出历史时间。
 */

/** 本地时区 2026-10-21 的 00:00:00.000 —— 和 UI 的 startOfToday() 同口径 */
const START_OF_DAY = new Date(2026, 9, 21, 0, 0, 0, 0).getTime();
const NOON_TODAY = new Date(2026, 9, 21, 12, 0, 0, 0).getTime();
/** 昨天最后一毫秒 */
const LAST_MS_OF_YESTERDAY = START_OF_DAY - 1;

function row(id: string, createdAt: number): RecordRow {
  return {
    id,
    text: `记录 ${id}`,
    tags: [],
    createdAt,
    updatedAt: createdAt,
  };
}

async function seed(rows: RecordRow[]): Promise<void> {
  for (const item of rows) await putRecord('records', item);
}

beforeEach(async () => {
  await destroyDatabase();
});

afterEach(async () => {
  await closeDatabase();
});

describe('countSince：按 createdAt 索引统计', () => {
  it('空库返回 0', async () => {
    expect(await countSince(START_OF_DAY)).toBe(0);
    expect(await countRecords()).toBe(0);
  });

  it('三条今天 + 两条昨天 → 3', async () => {
    await seed([
      row('today-1', NOON_TODAY),
      row('today-2', NOON_TODAY + 60_000),
      row('today-3', NOON_TODAY + 120_000),
      row('yesterday-1', LAST_MS_OF_YESTERDAY),
      row('yesterday-2', START_OF_DAY - 6 * 3600_000),
    ]);

    // 总数是 5（首页标题的「共 5 条」来自 queryRecords 的 total，两者必须一致）
    expect(await countRecords()).toBe(5);
    expect(await countSince(START_OF_DAY)).toBe(3);
  });

  it('边界值：刚好等于 since 的那一条要算进去，少 1 毫秒的不算', async () => {
    await seed([row('exactly-at-midnight', START_OF_DAY), row('one-ms-before', START_OF_DAY - 1)]);

    expect(await countSince(START_OF_DAY)).toBe(1);
  });

  it('全部是昨天的记录 → 0（UI 据此不显示「今天 0 条」）', async () => {
    await seed([row('y1', LAST_MS_OF_YESTERDAY), row('y2', START_OF_DAY - 3600_000)]);

    expect(await countRecords()).toBe(2);
    expect(await countSince(START_OF_DAY)).toBe(0);
  });

  it('since 为未来时间 → 0；非有限数 → 0（不把 NaN 丢给 Dexie 索引）', async () => {
    await seed([row('today', NOON_TODAY)]);

    expect(await countSince(NOON_TODAY + 3600_000)).toBe(0);
    expect(await countSince(Number.NaN)).toBe(0);
  });
});
