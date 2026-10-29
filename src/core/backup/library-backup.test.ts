/**
 * P2b · 判据：置顶与合集必须跟着备份走（任务书 §1.2）。
 *
 * 断言的是**包里的字节**（settings.json 里真有 `library` 这一条），
 * 以及「导出 → 清库 → 导入」之后库里的 pins / collections 逐字回来。
 */
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase } from '../storage';
import { createRecord } from '../records';
import {
  addToCollection,
  createCollection,
  loadLibrary,
  reorderCollection,
  setPinned,
} from '../library';
import { exportBackupZip, importBackupZip } from './index';
import { readBlobBytes } from '../../test/blob-helpers';

beforeEach(async () => {
  await destroyDatabase();
});

afterEach(async () => {
  await closeDatabase();
});

async function openZip(blob: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await readBlobBytes(blob));
}

describe('备份往返（置顶 + 合集）', () => {
  it('settings.json 里带 library；清库导入后置顶与合集完整回来', async () => {
    const first = await createRecord({ text: '凌晨三点的梦：一座会呼吸的图书馆。', tags: ['梦'] });
    const second = await createRecord({ text: '一个人的房间如果十年没变。', tags: ['灵感'] });
    const third = await createRecord({ text: '退潮后的沙滩上有一艘白船。', tags: ['灵感'] });

    await setPinned(first.id, true);
    await setPinned(third.id, true);
    await createCollection('我的短片');
    const collectionId = (await loadLibrary()).collections[0].id;
    await addToCollection(collectionId, third.id);
    await addToCollection(collectionId, second.id);
    await reorderCollection(collectionId, 0, 1);

    const before = await loadLibrary();
    expect(before.collections[0].recordIds).toEqual([second.id, third.id]);

    const exported = await exportBackupZip(new Date(2026, 9, 21));

    // 1) 包里有字节：settings.json 的 settings 数组里能找到 key=library
    const zip = await openZip(exported.blob);
    const settingsFile = zip.file('settings.json');
    expect(settingsFile).not.toBeNull();
    const settingsJson = JSON.parse(await settingsFile!.async('string')) as {
      settings: Array<{ key: string; value: unknown }>;
    };
    const libraryEntry = settingsJson.settings.find((item) => item.key === 'library');
    expect(libraryEntry).toBeDefined();
    expect(libraryEntry!.value).toEqual(before);

    // 2) 清库（≈ 浏览器数据被清掉）→ 导入 → 逐字回来
    await destroyDatabase();

    const imported = await importBackupZip(exported.blob, { mode: 'replace' });
    expect(imported.settings).toBeGreaterThan(0);

    expect(await loadLibrary()).toEqual(before);
  });
});
