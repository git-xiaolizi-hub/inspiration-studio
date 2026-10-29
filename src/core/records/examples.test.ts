/**
 * P5 §7：示例卡片（三条真记录，幂等）。
 *
 * 盯两件事：
 * 1. 载入的是**真记录**（进 records 表，能读能删能进合集），不是界面假数据；
 * 2. **幂等**：点两次不会变成 6 条 —— 靠固定 id + `putRecord` 覆盖。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase, getRecord } from '../storage';
import type { RecordRow } from '../storage/db';
import { getDatabase } from '../storage/db';
import { listRecords, removeRecord } from './index';
import { loadExampleRecords, SAMPLE_RECORD_IDS, sampleRecordIdList } from './examples';

beforeEach(async () => {
  await destroyDatabase();
});

afterEach(async () => {
  await closeDatabase();
});

describe('示例卡片：三条真记录 + 主次关系', () => {
  it('载入后库里有 3 条：笔记 / AI 产出 / 成品，成品带两个来源', async () => {
    const result = await loadExampleRecords(1_700_000_000_000);

    expect(result.overwritten).toBe(false);
    expect(result.records).toHaveLength(3);
    expect((await listRecords()).total).toBe(3);

    const [note, asset, draft] = result.records;
    expect(note.id).toBe(SAMPLE_RECORD_IDS.note);
    expect(note.role).toBeUndefined(); // 笔记 = 没有 role 字段
    expect(note.tags).toEqual(['梦']);

    expect(asset.role).toBe('asset');
    expect(asset.sourceIds).toEqual([note.id]);
    expect(asset.tags).toEqual(['解梦']);

    expect(draft.role).toBe('draft');
    expect(draft.sourceIds).toEqual([note.id, asset.id]);

    // 三条都是真行（records 表里查得到）
    for (const id of sampleRecordIdList()) {
      expect(await getRecord<RecordRow>('records', id)).toBeDefined();
    }
  });

  it('幂等：连点两次还是 3 条（固定 id + put 覆盖），第二次标记 overwritten', async () => {
    await loadExampleRecords(1_700_000_000_000);
    const second = await loadExampleRecords(1_700_000_100_000);

    expect(second.overwritten).toBe(true);
    expect(await getDatabase().records.count()).toBe(3);
    expect((await listRecords()).total).toBe(3);

    // 覆盖的是同一条（id 不变），内容与时间戳更新
    const draftRow = await getRecord<RecordRow>('records', SAMPLE_RECORD_IDS.draft);
    expect(draftRow?.createdAt).toBe(1_700_000_100_000);
    expect(draftRow?.role).toBe('draft');
  });

  it('删掉示例再载入一次 → 还是 3 条（不会留下 6 条残骸）', async () => {
    await loadExampleRecords(1_700_000_000_000);
    for (const id of sampleRecordIdList()) await removeRecord(id);
    expect((await listRecords()).total).toBe(0);

    const again = await loadExampleRecords(1_700_000_200_000);
    expect(again.overwritten).toBe(false);
    expect((await listRecords()).total).toBe(3);
  });

  it('成品排最上面（createdAt 倒序），来源关系读得出来', async () => {
    await loadExampleRecords(1_700_000_000_000);
    const page = await listRecords();

    expect(page.items[0].id).toBe(SAMPLE_RECORD_IDS.draft);
    expect(page.items[0].role).toBe('draft');
    expect(page.items[0].sourceIds).toEqual([SAMPLE_RECORD_IDS.note, SAMPLE_RECORD_IDS.asset]);
  });
});
