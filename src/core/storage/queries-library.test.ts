/**
 * P2b · 查询层的组合筛选语义（数据层）。
 *
 * 任务书 §3 的口径：**先合集（若有）→ 再标签 → 再搜索 → 再分页**。
 * 这里直接把四步的中间结果断言出来，避免"只在 UI 上看着对"。
 *
 * 另外锁住 `excludeIds`：它是「全部区不重复显示置顶」的实现手段，
 * 加了排除项之后 total / pageCount 必须跟着变小（否则分页会翻到空页）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase } from './index';
import { createRecord, removeRecord } from '../records';
import { queryRecords, queryRecordsByIds, queryRecordsInOrder } from './queries';

beforeEach(async () => {
  await destroyDatabase();
});

afterEach(async () => {
  await closeDatabase();
});

/** 造 N 条记录，text 里带序号，带同一个标签「梦」 */
async function seed(count: number, tag = '梦'): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const record = await createRecord({ text: `第 ${index + 1} 条：一座会呼吸的图书馆`, tags: [tag] });
    ids.push(record.id);
  }
  return ids;
}

describe('excludeIds（全部区排除置顶）', () => {
  it('排除后 total 变小，被排除的 id 不再出现', async () => {
    const ids = await seed(12);
    const excluded = [ids[0], ids[5]];

    const result = await queryRecords({ excludeIds: excluded, pageSize: 20 });
    expect(result.total).toBe(10);
    expect(result.items.map((row) => row.id)).not.toContain(ids[0]);
    expect(result.items.map((row) => row.id)).not.toContain(ids[5]);
  });

  it('排除 + 分页：末页条数正确（不会翻到空页）', async () => {
    const ids = await seed(25);
    const result = await queryRecords({ excludeIds: [ids[0], ids[1], ids[2]], pageSize: 10, page: 3 });
    expect(result.total).toBe(22);
    expect(result.pageCount).toBe(3);
    expect(result.items).toHaveLength(2);
  });

  it('排除 + 标签：先标签后排除，仍然只返回该标签的记录', async () => {
    const dreamIds = await seed(6, '梦');
    const other = await createRecord({ text: '别的标签', tags: ['脚本'] });

    const result = await queryRecords({ tag: '梦', excludeIds: [dreamIds[0]] });
    expect(result.total).toBe(5);
    expect(result.items.map((row) => row.id)).not.toContain(dreamIds[0]);
    expect(result.items.map((row) => row.id)).not.toContain(other.id);
  });

  it('排除 + 搜索：搜索词命中的置顶记录也被排除', async () => {
    const ids = await seed(4);
    const result = await queryRecords({ search: '图书馆', excludeIds: [ids[3]] });
    expect(result.total).toBe(3);
    expect(result.items.map((row) => row.id)).not.toContain(ids[3]);
  });

  it('不传 excludeIds 时行为与原来一致（快路径不受影响）', async () => {
    await seed(3);
    const result = await queryRecords();
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(3);
  });

  it('排除全部记录：返回空结果，不崩', async () => {
    const ids = await seed(2);
    const result = await queryRecords({ excludeIds: ids });
    expect(result).toMatchObject({ total: 0, page: 1, pageCount: 0, items: [] });
  });
});

describe('合集视图：先合集 → 再标签 → 再搜索 → 再分页', () => {
  it('顺序来自 ids，不来自 createdAt', async () => {
    const ids = await seed(4);
    const ordered = [ids[2], ids[0], ids[3], ids[1]];
    const result = await queryRecordsInOrder(ordered, {});
    expect(result.items.map((row) => row.id)).toEqual(ordered);
  });

  it('悬空 id 自动跳过（记录被删了合集照样能打开）', async () => {
    const ids = await seed(3);
    await removeRecord(ids[1]);
    const result = await queryRecordsInOrder(ids, {});
    expect(result.items.map((row) => row.id)).toEqual([ids[0], ids[2]]);
    expect(result.total).toBe(2);
  });

  it('四者叠加：合集 ∩ 标签 ∩ 搜索，再分页', async () => {
    // 合集内 5 条：3 条「梦」且含「图书馆」，2 条别的
    const insideIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      insideIds.push((await createRecord({ text: `图书馆 ${index}`, tags: ['梦'] })).id);
    }
    insideIds.push((await createRecord({ text: '图书馆外的一条', tags: ['脚本'] })).id);
    insideIds.push((await createRecord({ text: '梦里的别的东西', tags: ['梦'] })).id);
    // 合集外还有一条命中的，必须不出现
    await createRecord({ text: '图书馆但不在合集里', tags: ['梦'] });

    const filtered = await queryRecordsInOrder(insideIds, { tag: '梦', search: '图书馆' });
    expect(filtered.items.map((row) => row.id)).toEqual(insideIds.slice(0, 3));

    const paged = await queryRecordsInOrder(insideIds, { tag: '梦', search: '图书馆', pageSize: 2, page: 2 });
    expect(paged.total).toBe(3);
    expect(paged.pageCount).toBe(2);
    expect(paged.items.map((row) => row.id)).toEqual([insideIds[2]]);
  });

  it('queryRecordsByIds 在不分页时给出全部命中项（置顶区用）', async () => {
    const ids = await seed(5);
    const rows = await queryRecordsByIds([ids[4], ids[1]], {});
    expect(rows.map((row) => row.id)).toEqual([ids[4], ids[1]]);
  });

  it('空合集：返回空结果而不是全库', async () => {
    await seed(3);
    const result = await queryRecordsInOrder([], {});
    expect(result).toMatchObject({ total: 0, items: [], page: 1, pageCount: 0 });
  });
});
