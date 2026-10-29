/**
 * P2b · 置顶 / 合集数据层。
 *
 * 这里逐条盯任务书 §1.1 的六个边界（重复置顶 / 重复加入 / 空名 / 重排越界 /
 * 悬空 id / 脏数据），另外补三条自己踩到的：置顶顺序、合集顺序、脏数据不写回。
 * 备份往返在 `src/core/backup/library-backup.test.ts`（要开 zip，单独一套）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase, getSetting, putSetting } from '../storage';
import {
  addToCollection,
  collectionsContaining,
  createCollection,
  deleteCollection,
  emptyLibrary,
  LIBRARY_SETTING_KEY,
  LibraryError,
  loadLibrary,
  normalizeLibrary,
  pruneDangling,
  pruneMissing,
  removeFromCollection,
  renameCollection,
  reorderCollection,
  saveLibrary,
  setPinned,
} from './index';
import { createRecord, removeRecord } from '../records';

beforeEach(async () => {
  await destroyDatabase();
});

afterEach(async () => {
  await closeDatabase();
});

async function readRaw(): Promise<unknown> {
  return (await getSetting(LIBRARY_SETTING_KEY))?.value;
}

async function onlyCollectionId(): Promise<string> {
  const library = await loadLibrary();
  expect(library.collections).toHaveLength(1);
  return library.collections[0].id;
}

describe('读写与形状', () => {
  it('没有数据时返回空库', async () => {
    expect(await loadLibrary()).toEqual({ pins: [], collections: [] });
  });

  it('写进去再读回来，形状就是任务书 §1 的 JSON', async () => {
    const library = await saveLibrary({
      pins: ['r1'],
      collections: [{ id: 'c1', name: '我的短片', recordIds: ['r1'], createdAt: 1 }],
    });

    expect(await readRaw()).toEqual({
      pins: ['r1'],
      collections: [{ id: 'c1', name: '我的短片', recordIds: ['r1'], createdAt: 1 }],
    });
    expect(await loadLibrary()).toEqual(library);
  });

  it('存的是 settings 表的一个 key（不新建表、不升版本）', async () => {
    await setPinned('r1', true);
    const row = await getSetting(LIBRARY_SETTING_KEY);
    expect(row?.key).toBe('library');
    expect(typeof row?.updatedAt).toBe('number');
  });
});

describe('边界 1：重复置顶不产生重复项', () => {
  it('连点两次置顶，pins 里只有一条', async () => {
    await setPinned('r1', true);
    const library = await setPinned('r1', true);
    expect(library.pins).toEqual(['r1']);
  });

  it('取消置顶后可以重新置顶，且回到末尾（置顶先后 = 显示顺序）', async () => {
    await setPinned('r1', true);
    await setPinned('r2', true);
    await setPinned('r1', false);
    const library = await setPinned('r1', true);
    expect(library.pins).toEqual(['r2', 'r1']);
  });

  it('取消一条没被置顶的记录：静默无变化', async () => {
    await setPinned('r1', true);
    const library = await setPinned('r9', false);
    expect(library.pins).toEqual(['r1']);
  });

  it('空 id 会被拒绝（不写一条脏 pin）', async () => {
    await expect(setPinned('   ', true)).rejects.toBeInstanceOf(LibraryError);
  });
});

describe('边界 2：重复加入同一合集不产生重复项', () => {
  it('加入两次，recordIds 只有一份', async () => {
    await createCollection('我的短片');
    const id = await onlyCollectionId();
    await addToCollection(id, 'r1');
    const library = await addToCollection(id, 'r1');
    expect(library.collections[0].recordIds).toEqual(['r1']);
  });

  it('移出后再加入，回到末尾', async () => {
    await createCollection('名单');
    const id = await onlyCollectionId();
    await addToCollection(id, 'r1');
    await addToCollection(id, 'r2');
    await removeFromCollection(id, 'r1');
    const library = await addToCollection(id, 'r1');
    expect(library.collections[0].recordIds).toEqual(['r2', 'r1']);
  });

  it('移出一条不在合集里的记录：静默无变化', async () => {
    await createCollection('名单');
    const id = await onlyCollectionId();
    await addToCollection(id, 'r1');
    const library = await removeFromCollection(id, 'r9');
    expect(library.collections[0].recordIds).toEqual(['r1']);
  });

  it('collectionsContaining 给出卡片菜单的勾选态', async () => {
    await createCollection('A');
    await createCollection('B');
    const [a, b] = (await loadLibrary()).collections;
    await addToCollection(a.id, 'r1');
    await addToCollection(b.id, 'r1');
    expect(collectionsContaining(await loadLibrary(), 'r1').sort()).toEqual([a.id, b.id].sort());
  });
});

describe('边界 3：合集名 —— 空名拒绝、重名允许', () => {
  it('空字符串 / 纯空白都拒绝', async () => {
    await expect(createCollection('')).rejects.toBeInstanceOf(LibraryError);
    await expect(createCollection('   ')).rejects.toBeInstanceOf(LibraryError);
  });

  it('重命名成空名也拒绝，原名保留', async () => {
    await createCollection('原名');
    const id = await onlyCollectionId();
    await expect(renameCollection(id, '  ')).rejects.toBeInstanceOf(LibraryError);
    expect((await loadLibrary()).collections[0].name).toBe('原名');
  });

  it('重名允许（不强制唯一）', async () => {
    await createCollection('同名');
    const library = await createCollection('同名');
    expect(library.collections.map((item) => item.name)).toEqual(['同名', '同名']);
  });

  it('名字两端空白会被去掉，超长被截断', async () => {
    const library = await createCollection('  我的短片  ');
    expect(library.collections[0].name).toBe('我的短片');

    const long = await createCollection('长'.repeat(60));
    expect(long.collections[1].name).toHaveLength(40);
  });

  it('重命名 / 删除不存在的合集会报 NOT_FOUND（UI 据此提示而不是静默失败）', async () => {
    await expect(renameCollection('nope', 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deleteCollection('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('删除合集只删分组，不动 pins 与记录本身', async () => {
    const created = await createRecord({ text: '一条记录' });
    await createCollection('临时');
    const id = await onlyCollectionId();
    await addToCollection(id, created.id);
    await setPinned(created.id, true);

    const library = await deleteCollection(id);
    expect(library.collections).toEqual([]);
    expect(library.pins).toEqual([created.id]);
  });
});

describe('边界 4：重排越界不崩、原样返回', () => {
  async function seeded(): Promise<{ id: string; before: string[] }> {
    await createCollection('排序');
    const id = await onlyCollectionId();
    for (const rid of ['r1', 'r2', 'r3']) await addToCollection(id, rid);
    return { id, before: ['r1', 'r2', 'r3'] };
  }

  it('正常重排：把第 1 项移到第 3 位', async () => {
    const { id, before } = await seeded();
    const library = await reorderCollection(id, 0, 2);
    expect(library.collections[0].recordIds).toEqual(['r2', 'r3', 'r1']);
    expect(before).toEqual(['r1', 'r2', 'r3']);
  });

  it('负索引 / 超过长度 / 小数 / 非数字：原样返回且不写库', async () => {
    const { id, before } = await seeded();
    const stampBefore = (await getSetting(LIBRARY_SETTING_KEY))?.updatedAt;

    for (const [from, to] of [
      [-1, 1],
      [0, 3],
      [3, 0],
      [0.5, 1],
      [Number.NaN, 1],
    ]) {
      const library = await reorderCollection(id, from, to);
      expect(library.collections[0].recordIds).toEqual(before);
    }
    expect((await getSetting(LIBRARY_SETTING_KEY))?.updatedAt).toBe(stampBefore);
  });

  it('from === to 不动（拖到自己身上不该写库）', async () => {
    const { id, before } = await seeded();
    const library = await reorderCollection(id, 1, 1);
    expect(library.collections[0].recordIds).toEqual(before);
  });

  it('空合集里重排：不崩', async () => {
    await createCollection('空的');
    const id = await onlyCollectionId();
    const library = await reorderCollection(id, 0, 0);
    expect(library.collections[0].recordIds).toEqual([]);
  });
});

describe('边界 5：悬空 id 清理', () => {
  it('pruneDangling 清掉 pins 与 recordIds 里已不存在的 id，空合集保留', async () => {
    await createCollection('会空的合集');
    const id = await onlyCollectionId();
    for (const rid of ['r1', 'r2', 'r3']) await addToCollection(id, rid);
    await setPinned('r1', true);
    await setPinned('gone', true);

    const library = await pruneDangling(new Set(['r1', 'r3']));
    expect(library.pins).toEqual(['r1']);
    expect(library.collections[0].recordIds).toEqual(['r1', 'r3']);

    const emptied = await pruneDangling(new Set([]));
    expect(emptied.pins).toEqual([]);
    expect(emptied.collections[0].recordIds).toEqual([]);
    expect(emptied.collections).toHaveLength(1);
  });

  it('没有悬空 id 时不写库（避免每次打开首页都改一次 settings）', async () => {
    await setPinned('r1', true);
    const stampBefore = (await getSetting(LIBRARY_SETTING_KEY))?.updatedAt;
    await pruneDangling(new Set(['r1']));
    expect((await getSetting(LIBRARY_SETTING_KEY))?.updatedAt).toBe(stampBefore);
  });

  it('pruneMissing：真的删掉一条被置顶的记录后，pins 里不留它', async () => {
    const record = await createRecord({ text: '会被删掉的记录' });
    const other = await createRecord({ text: '留下的记录' });
    await setPinned(record.id, true);
    await setPinned(other.id, true);
    await createCollection('合集');
    const id = await onlyCollectionId();
    await addToCollection(id, record.id);

    await removeRecord(record.id);
    const library = await pruneMissing();
    expect(library.pins).toEqual([other.id]);
    expect(library.collections[0].recordIds).toEqual([]);
  });
});

describe('边界 6：脏数据回落空库，不崩、不覆盖', () => {
  const DIRTY: unknown[] = [
    'not-an-object',
    '{broken json',
    42,
    null,
    [],
    { pins: 'nope', collections: [] },
    { pins: [], collections: 'nope' },
    { pins: [1, 2, null], collections: [{ id: '', name: 'x' }, 'x', { id: 'c', name: '' }] },
  ];

  it('各种脏形状都返回空库，不抛异常', async () => {
    expect(normalizeLibrary('{broken json')).toEqual(emptyLibrary());
    for (const value of DIRTY) {
      await putSetting({ key: LIBRARY_SETTING_KEY, value, updatedAt: 1 });
      expect(await loadLibrary()).toEqual({ pins: [], collections: [] });
    }
  });

  it('读到脏数据不写回：库里的原值原样留着，等下次真正的写操作再修', async () => {
    await putSetting({ key: LIBRARY_SETTING_KEY, value: '{broken json', updatedAt: 1 });
    await loadLibrary();
    expect((await getSetting(LIBRARY_SETTING_KEY))?.value).toBe('{broken json');

    // 真正的写操作才落库（这里写一条置顶 → 库变成合法形状）
    const library = await setPinned('r1', true);
    expect(library.pins).toEqual(['r1']);
    expect(await readRaw()).toEqual({ pins: ['r1'], collections: [] });
  });

  it('半坏的数据只丢坏条目，好的条目照常可用', () => {
    const library = normalizeLibrary({
      pins: ['r1', 'r1', '', 3],
      collections: [
        { id: 'c1', name: '好的', recordIds: ['r1', 'r1', 'r2', null], createdAt: 5 },
        { id: 'c1', name: '重复 id', recordIds: [], createdAt: 6 },
        { id: 'c2', name: '', recordIds: [], createdAt: 7 },
        'not-an-object',
      ],
    });

    expect(library.pins).toEqual(['r1']);
    expect(library.collections).toEqual([
      { id: 'c1', name: '好的', recordIds: ['r1', 'r2'], createdAt: 5 },
    ]);
  });
});
