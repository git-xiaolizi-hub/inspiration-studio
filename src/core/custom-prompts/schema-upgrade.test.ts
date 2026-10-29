/**
 * 老库升级：v3（records/settings/media/artifacts/threads）→ v4（多一张 customPrompts）。
 *
 * 这条用例守的是**用户已有数据**：Dexie 加表的写法一旦写错（比如新版本 stores 里
 * 只声明新表但写成"重建"语义），升级时旧表会被清掉，而所有单测都是"空库起步"，
 * 抓不到这种事故。
 */
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabaseInstance, DB_NAME, getDatabase } from '../storage/db';

beforeEach(async () => {
  closeDatabaseInstance();
  await Dexie.delete(DB_NAME);
});

afterEach(async () => {
  closeDatabaseInstance();
  await Dexie.delete(DB_NAME);
});

describe('schema 升级 v3 → v4', () => {
  it('旧表数据原样保留，新表可用', async () => {
    // 一份"上一个版本"的库：版本号停在 3，只有五张旧表
    const legacy = new Dexie(DB_NAME);
    legacy.version(1).stores({
      records: 'id, createdAt, *tags',
      settings: 'key',
      media: 'id, recordId',
    });
    legacy.version(2).stores({ artifacts: 'id, recordId, kind, createdAt' });
    legacy.version(3).stores({ threads: 'id, recordId, kind, updatedAt' });
    await legacy.open();

    const now = 1_700_000_000_000;
    await legacy.table('records').put({
      id: 'r-legacy',
      text: '升级前写的梦',
      tags: ['梦'],
      createdAt: now,
      updatedAt: now,
    });
    await legacy.table('settings').put({ key: 'voice-mode', value: 'local' });
    await legacy.table('threads').put({
      id: 't-legacy',
      recordId: 'r-legacy',
      kind: 'dream',
      packId: 'dream-interpretation',
      turns: [],
      createdAt: now,
      updatedAt: now,
    });
    legacy.close();

    // 这一版的库（版本 4）
    const db = getDatabase();
    const records = await db.records.toArray();
    expect(records).toHaveLength(1);
    expect(records[0].text).toBe('升级前写的梦');
    expect(await db.settings.get('voice-mode')).toMatchObject({ value: 'local' });
    expect(await db.threads.count()).toBe(1);

    // 新表存在且可写
    await db.customPrompts.put({
      id: 'cp_legacy',
      basePackId: 'dream-interpretation',
      name: '升级后新建的副本',
      body: '一段足够长的自定义正文，用来证明新表在升级后的库里可以正常写入。',
      createdAt: now,
      updatedAt: now,
    });
    expect(await db.customPrompts.count()).toBe(1);
    expect(await db.customPrompts.where('basePackId').equals('dream-interpretation').count()).toBe(1);
  });
});
