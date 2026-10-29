/**
 * P5 · 判据：**导出备份 → 清库 → 导入**，成品与来源关系必须完整回来。
 *
 * 为什么值得单开一个文件：导出是**白名单构造** `BackupRecordEntry`（见 `backup/index.ts`），
 * 不写进白名单的字段会被静默丢掉 —— 任务书 §2.2 原本判断「两个字段自动带上，不用改备份代码」，
 * 实测不成立。这个文件就是那条判断的反证与守卫。
 */
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase } from '../storage';
import { createRecord, getRecordEntity } from '../records';
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

describe('P5 备份往返：成品角色与来源血缘', () => {
  it('records.json 里带 role / sourceIds；清库导入后成品与来源完整回来', async () => {
    const note = await createRecord({ text: '凌晨三点的梦：会呼吸的图书馆', tags: ['梦'] });
    const asset = await createRecord({
      text: '解梦：图书馆象征被压抑的记忆',
      tags: ['解梦'],
      role: 'asset',
      sourceIds: [note.id],
    });
    const draft = await createRecord({
      text: '图书馆在呼吸。不是比喻。',
      role: 'draft',
      sourceIds: [note.id, asset.id],
    });

    const exported = await exportBackupZip(new Date(2026, 9, 26));

    // 1) 包里的字节：两个字段真的写进 records.json 了
    const zip = await openZip(exported.blob);
    const recordsFile = zip.file('records.json');
    expect(recordsFile).not.toBeNull();
    const recordsJson = JSON.parse(await recordsFile!.async('string')) as {
      records: Array<Record<string, unknown>>;
    };
    const draftEntry = recordsJson.records.find((entry) => entry.id === draft.id);
    expect(draftEntry?.role).toBe('draft');
    expect(draftEntry?.sourceIds).toEqual([note.id, asset.id]);
    const assetEntry = recordsJson.records.find((entry) => entry.id === asset.id);
    expect(assetEntry?.role).toBe('asset');
    // 笔记不该凭空多出字段（白名单只在非默认值时写）
    const noteEntry = recordsJson.records.find((entry) => entry.id === note.id);
    expect('role' in (noteEntry as object)).toBe(false);

    // 2) 清库（≈ 浏览器数据被清掉）→ replace 导入 → 逐字回来
    await destroyDatabase();
    await importBackupZip(exported.blob, { mode: 'replace' });

    const draftBack = await getRecordEntity(draft.id);
    expect(draftBack?.role).toBe('draft');
    expect(draftBack?.sourceIds).toEqual([note.id, asset.id]);
    expect(draftBack?.text).toBe('图书馆在呼吸。不是比喻。');

    const assetBack = await getRecordEntity(asset.id);
    expect(assetBack?.role).toBe('asset');
    expect(assetBack?.sourceIds).toEqual([note.id]);

    const noteBack = await getRecordEntity(note.id);
    expect(noteBack?.role).toBeUndefined();
    expect(noteBack?.sourceIds).toBeUndefined();
  });

  it('导入旧包（条目里没有这两个字段）不报错，按笔记处理', async () => {
    // 造一个「P5 之前」的包：records.json 里只有老字段
    const zip = new JSZip();
    zip.file(
      'manifest.json',
      JSON.stringify({
        format: 'ia-v2-backup',
        version: 2,
        exportedAt: new Date(2026, 0, 1).toISOString(),
        app: 'Inspiration Assistant',
        containsKey: false,
        counts: { records: 1, media: 0 },
      }),
    );
    zip.file(
      'records.json',
      JSON.stringify({
        format: 'ia-v2-backup',
        version: 2,
        records: [
          {
            id: 'old-style',
            text: '旧版本导出的梦',
            tags: ['梦'],
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
          },
        ],
      }),
    );
    const buffer = await zip.generateAsync({ type: 'uint8array' });

    await destroyDatabase();
    await importBackupZip(buffer, { mode: 'replace' });

    const entity = await getRecordEntity('old-style');
    expect(entity?.text).toBe('旧版本导出的梦');
    expect(entity?.role).toBeUndefined();
    expect(entity?.sourceIds).toBeUndefined();
  });

  it('脏值（role 拼错 / sourceIds 非数组）导入时不炸，归一成默认', async () => {
    const zip = new JSZip();
    zip.file(
      'manifest.json',
      JSON.stringify({
        format: 'ia-v2-backup',
        version: 2,
        exportedAt: new Date(2026, 0, 1).toISOString(),
        app: 'Inspiration Assistant',
        containsKey: false,
        counts: { records: 1, media: 0 },
      }),
    );
    zip.file(
      'records.json',
      JSON.stringify({
        format: 'ia-v2-backup',
        version: 2,
        records: [
          {
            id: 'dirty',
            text: '手改过的备份包',
            tags: [],
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            role: 'finshed',
            sourceIds: 'not-an-array',
          },
        ],
      }),
    );
    const buffer = await zip.generateAsync({ type: 'uint8array' });

    await destroyDatabase();
    await importBackupZip(buffer, { mode: 'replace' });

    const entity = await getRecordEntity('dirty');
    expect(entity?.text).toBe('手改过的备份包');
    expect(entity?.role).toBeUndefined();
    expect(entity?.sourceIds).toBeUndefined();
  });
});
