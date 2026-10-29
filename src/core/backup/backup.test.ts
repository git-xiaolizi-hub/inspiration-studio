import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearStore, closeDatabase, destroyDatabase } from '../storage';
import { createRecord, getRecordEntity, listRecords } from '../records';
import { BACKUP_FORMAT, BACKUP_VERSION, exportBackupZip, importBackupZip } from './index';
import { bytesEqual, makeAudioBlob, readBlobBytes } from '../../test/blob-helpers';

const AUDIO_BYTES = [11, 22, 33, 44, 55, 66, 77, 88];

beforeEach(async () => {
  await destroyDatabase();
});

afterEach(async () => {
  await closeDatabase();
});

/** 读 zip（jsdom 的 Blob 没有 arrayBuffer，用 helper 转 Uint8Array 再喂给 JSZip） */
async function openZip(blob: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await readBlobBytes(blob));
}

async function readJson<T>(zip: JSZip, name: string): Promise<T> {
  const file = zip.file(name);
  expect(file, `zip 里应该有 ${name}`).not.toBeNull();
  return JSON.parse(await file!.async('string')) as T;
}

/** 造一份"手工损坏"的备份包 */
async function buildZip(files: Record<string, string | Uint8Array>): Promise<Blob> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  const buffer = await zip.generateAsync({ type: 'arraybuffer' });
  return new Blob([buffer], { type: 'application/zip' });
}

describe('导出 zip', () => {
  it('文件名是 records_YYYYMMDD.zip，manifest 与 records.json 结构正确', async () => {
    await createRecord({ text: '梦一', tags: ['梦'] });
    const withAudio = await createRecord({
      text: '带录音的梦',
      tags: ['梦', '分镜'],
      audio: {
        blob: makeAudioBlob(AUDIO_BYTES),
        mimeType: 'audio/webm;codecs=opus',
        durationMs: 4300,
      },
    });

    const result = await exportBackupZip(new Date(2026, 9, 17, 10, 30));
    expect(result.filename).toBe('records_20261017.zip');
    expect(result.blob.type).toBe('application/zip');

    const zip = await openZip(result.blob);
    const manifest = await readJson<{
      format: string;
      version: number;
      exportedAt: string;
      counts: { records: number; media: number };
    }>(zip, 'manifest.json');

    expect(manifest.format).toBe(BACKUP_FORMAT);
    expect(manifest.version).toBe(BACKUP_VERSION);
    expect(manifest.exportedAt).toBe(new Date(2026, 9, 17, 10, 30).toISOString());
    expect(manifest.counts).toEqual({ records: 2, media: 1 });

    const recordsJson = await readJson<{
      format: string;
      version: number;
      records: Array<{
        id: string;
        text: string;
        tags: string[];
        createdAt: number;
        updatedAt: number;
        audio?: { file: string; mimeType: string; durationMs: number };
      }>;
    }>(zip, 'records.json');

    expect(recordsJson.format).toBe(BACKUP_FORMAT);
    expect(recordsJson.records).toHaveLength(2);

    const audioEntry = recordsJson.records.find((entry) => entry.id === withAudio.id);
    expect(audioEntry?.audio).toEqual({
      file: `media/${withAudio.id}.webm`,
      mimeType: 'audio/webm;codecs=opus',
      durationMs: 4300,
    });

    // records.json 里绝对不能有音频二进制：没有 blob 字段，条目长度也是元数据级别
    const entryJson = JSON.stringify(audioEntry);
    expect(entryJson).not.toContain('blob');
    expect(entryJson.length).toBeLessThan(500);

    // 音频本体在 media/ 下，字节一致
    const mediaFile = zip.file(`media/${withAudio.id}.webm`);
    expect(mediaFile).not.toBeNull();
    const mediaBytes = await mediaFile!.async('uint8array');
    expect(bytesEqual(mediaBytes, AUDIO_BYTES)).toBe(true);
  });

  it('没有记录时也能导出（空备份可恢复）', async () => {
    const result = await exportBackupZip();
    const zip = await openZip(result.blob);
    const manifest = await readJson<{ counts: { records: number; media: number } }>(
      zip,
      'manifest.json',
    );
    expect(manifest.counts).toEqual({ records: 0, media: 0 });
  });
});

describe('导入 zip', () => {
  it('导出 → 清空库 → 导入 → 记录与音频完全一致', async () => {
    const textOnly = await createRecord({ text: '广告分镜：雨夜霓虹', tags: ['广告', '分镜'] });
    const withAudio = await createRecord({
      text: '录音备忘',
      tags: ['梦'],
      audio: {
        blob: makeAudioBlob(AUDIO_BYTES),
        mimeType: 'audio/webm;codecs=opus',
        durationMs: 6200,
      },
    });

    const exported = await exportBackupZip();

    // 模拟"用户删掉所有数据/换设备"：连库一起删
    await destroyDatabase();
    expect((await listRecords()).total).toBe(0);

    const result = await importBackupZip(exported.blob, { mode: 'merge' });
    expect(result.imported).toBe(2);
    expect(result.media).toBe(1);
    expect(result.missingMedia).toBe(0);

    const page = await listRecords();
    expect(page.total).toBe(2);
    const ids = page.items.map((item) => item.id).sort();
    expect(ids).toEqual([textOnly.id, withAudio.id].sort());

    const restoredTextOnly = await getRecordEntity(textOnly.id);
    expect(restoredTextOnly?.text).toBe('广告分镜：雨夜霓虹');
    expect(restoredTextOnly?.tags).toEqual(['广告', '分镜']);
    expect(restoredTextOnly?.audio).toBeUndefined();

    const restoredAudio = await getRecordEntity(withAudio.id);
    expect(restoredAudio?.audio?.durationMs).toBe(6200);
    expect(restoredAudio?.audio?.mimeType).toBe('audio/webm;codecs=opus');
    expect(bytesEqual(await readBlobBytes(restoredAudio!.audio!.blob), AUDIO_BYTES)).toBe(true);
  });

  it('同一份包重复导入（merge）不会产生重复数据', async () => {
    await createRecord({ text: '梦一', tags: ['梦'] });
    const exported = await exportBackupZip();

    await importBackupZip(exported.blob, { mode: 'merge' });
    await importBackupZip(exported.blob, { mode: 'merge' });

    expect((await listRecords()).total).toBe(1);
  });

  it('replace 模式会先清空既有记录与音频', async () => {
    await createRecord({ text: '包内记录', tags: ['梦'] });
    const exported = await exportBackupZip();

    const extra = await createRecord({
      text: '包外记录',
      audio: {
        blob: makeAudioBlob(AUDIO_BYTES),
        mimeType: 'audio/webm;codecs=opus',
        durationMs: 1000,
      },
    });

    await importBackupZip(exported.blob, { mode: 'replace' });

    const page = await listRecords();
    expect(page.total).toBe(1);
    expect(page.items[0].text).toBe('包内记录');
    expect(await getRecordEntity(extra.id)).toBeUndefined();
  });

  it('merge 时包内记录没音频、库里原有音频，会一并清掉（不会播到旧声音）', async () => {
    const record = await createRecord({
      text: '先有录音',
      audio: {
        blob: makeAudioBlob(AUDIO_BYTES),
        mimeType: 'audio/webm;codecs=opus',
        durationMs: 1000,
      },
    });

    const zip = await buildZip({
      'manifest.json': JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        exportedAt: new Date().toISOString(),
        counts: { records: 1, media: 0 },
      }),
      'records.json': JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        records: [{ id: record.id, text: '只留文字', tags: ['梦'], createdAt: 1, updatedAt: 1 }],
      }),
    });

    const result = await importBackupZip(zip, { mode: 'merge' });

    expect(result.media).toBe(0);
    const entity = await getRecordEntity(record.id);
    expect(entity?.text).toBe('只留文字');
    expect(entity?.audio).toBeUndefined();
  });

  it('音频文件缺失时跳过音频并计数（不静默假装成功）', async () => {
    const zip = await buildZip({
      'manifest.json': JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        exportedAt: new Date().toISOString(),
        counts: { records: 1, media: 1 },
      }),
      'records.json': JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        records: [
          {
            id: 'orphan-audio',
            text: '音频丢了',
            tags: [],
            createdAt: 1,
            updatedAt: 1,
            audio: { file: 'media/orphan-audio.webm', mimeType: 'audio/webm', durationMs: 900 },
          },
        ],
      }),
    });

    const result = await importBackupZip(zip);

    expect(result.imported).toBe(1);
    expect(result.media).toBe(0);
    expect(result.missingMedia).toBe(1);
    expect((await getRecordEntity('orphan-audio'))?.audio).toBeUndefined();
  });
});

describe('导入校验（INVALID_PAYLOAD）', () => {
  it('不是 zip 的文件被拒绝', async () => {
    await expect(importBackupZip(new Blob(['这不是 zip']))).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
  });

  it('缺 manifest.json 被拒绝', async () => {
    const zip = await buildZip({ 'records.json': JSON.stringify({ records: [] }) });
    await expect(importBackupZip(zip)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('manifest 的 format 不对被拒绝', async () => {
    const zip = await buildZip({
      'manifest.json': JSON.stringify({ format: 'other-tool', version: 1 }),
      'records.json': JSON.stringify({ records: [] }),
    });
    await expect(importBackupZip(zip)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('manifest 版本过新被拒绝', async () => {
    const zip = await buildZip({
      'manifest.json': JSON.stringify({ format: BACKUP_FORMAT, version: 99 }),
      'records.json': JSON.stringify({ records: [] }),
    });
    await expect(importBackupZip(zip)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('缺 records.json 被拒绝', async () => {
    const zip = await buildZip({
      'manifest.json': JSON.stringify({ format: BACKUP_FORMAT, version: 1 }),
    });
    await expect(importBackupZip(zip)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('manifest 不是合法 JSON 被拒绝', async () => {
    const zip = await buildZip({
      'manifest.json': '{ not json',
      'records.json': JSON.stringify({ records: [] }),
    });
    await expect(importBackupZip(zip)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });
});

describe('与通用导出（M1 exportData）共存', () => {
  it('清空记录后 records 与 media 都是空的', async () => {
    await createRecord({
      text: 'x',
      audio: { blob: makeAudioBlob(), mimeType: 'audio/webm', durationMs: 1 },
    });
    await clearStore('records');
    await clearStore('media');
    expect((await listRecords()).total).toBe(0);
  });
});
