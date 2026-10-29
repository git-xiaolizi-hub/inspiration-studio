import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearStore,
  closeDatabase,
  deleteRecord,
  destroyDatabase,
  estimateQuota,
  exportData,
  getAllRecords,
  getRecord,
  importData,
  putRecord,
} from './index';
import { StorageError, StorageQuotaError } from './types';

const MB = 1024 * 1024;

interface Note {
  id: string;
  text: string;
  tags: string[];
}

/** 让 navigator.storage.estimate() 返回指定的配额快照 */
function mockStorageEstimate(usage: number, quota: number): void {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { estimate: vi.fn().mockResolvedValue({ usage, quota }) },
  });
}

/** 模拟"浏览器没有 Quota API"的情况 */
function removeStorageApi(): void {
  Reflect.deleteProperty(navigator, 'storage');
}

beforeEach(async () => {
  await destroyDatabase();
  removeStorageApi();
});

afterEach(async () => {
  await closeDatabase();
  removeStorageApi();
});

describe('CRUD 基本链路', () => {
  it('put → get → getAll → delete → clear 全部生效', async () => {
    const first: Note = { id: 'n1', text: '梦见会飞的鲸鱼', tags: ['梦'] };
    const second: Note = { id: 'n2', text: '广告分镜：雨夜霓虹', tags: ['广告'] };

    await putRecord('records', first);
    await putRecord('records', second);

    expect(await getRecord<Note>('records', 'n1')).toEqual(first);
    expect((await getAllRecords<Note>('records')).map((n) => n.id).sort()).toEqual(['n1', 'n2']);

    await deleteRecord('records', 'n1');
    expect(await getRecord<Note>('records', 'n1')).toBeUndefined();

    await clearStore('records');
    expect(await getAllRecords<Note>('records')).toEqual([]);
  });

  it('同 id 重复写入是覆盖而不是新增', async () => {
    await putRecord<Note>('records', { id: 'n1', text: '初稿', tags: [] });
    await putRecord<Note>('records', { id: 'n1', text: '改稿', tags: ['改'] });

    const all = await getAllRecords<Note>('records');
    expect(all).toHaveLength(1);
    expect(all[0].text).toBe('改稿');
  });

  it('缺少 id 的写入被拒绝，错误码为 INVALID_PAYLOAD', async () => {
    await expect(
      putRecord('records', { text: '没有 id' } as unknown as Note),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('删除不存在的 id 不报错（幂等）', async () => {
    await expect(deleteRecord('records', 'not-exist')).resolves.toBeUndefined();
  });
});

describe('配额查询与"配额满时写入失败"', () => {
  it('estimateQuota 返回已用量、上限与百分比', async () => {
    mockStorageEstimate(30 * MB, 60 * MB);

    const snapshot = await estimateQuota();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.usage).toBe(30 * MB);
    expect(snapshot?.quota).toBe(60 * MB);
    expect(snapshot?.available).toBe(30 * MB);
    expect(snapshot?.percentUsed).toBeCloseTo(50, 5);
  });

  it('配额满 55MB 时写入抛 StorageQuotaError，且数据没有落库', async () => {
    // 55MB 上限，已用 54.9MB —— 只剩 0.1MB，任意记录都写不进去
    mockStorageEstimate(54.9 * MB, 55 * MB);

    const error = await putRecord<Note>('records', {
      id: 'n-full',
      text: '这条记录不应该写进去',
      tags: [],
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageQuotaError);
    const quotaError = error as StorageQuotaError;
    expect(quotaError.code).toBe('QUOTA_EXCEEDED');
    expect(quotaError.usage).toBe(54.9 * MB);
    expect(quotaError.quota).toBe(55 * MB);
    expect(quotaError.message).toContain('空间不足');

    // 关键：不能静默失败，也不能写进去再丢
    expect(await getRecord<Note>('records', 'n-full')).toBeUndefined();
  });

  it('配额充足时正常写入', async () => {
    mockStorageEstimate(1 * MB, 1024 * MB);

    await expect(
      putRecord<Note>('records', { id: 'n-ok', text: '正常写入', tags: [] }),
    ).resolves.toMatchObject({ id: 'n-ok' });
  });

  it('环境无法查询配额时（无 Quota API）不拦截写入', async () => {
    removeStorageApi();

    await expect(
      putRecord<Note>('settings', { id: 'app', text: '主题', tags: [] } as unknown as Note),
    ).resolves.toBeDefined();
    expect(await estimateQuota()).toBeNull();
  });
});

describe('导入导出', () => {
  const sample: Note[] = [
    { id: 'n1', text: '梦一', tags: ['梦'] },
    { id: 'n2', text: '梦二', tags: ['梦', '分镜'] },
  ];

  it('导出对象可序列化为 JSON，导入后数据复原', async () => {
    for (const note of sample) await putRecord('records', note);

    const bundle = await exportData();
    expect(bundle.format).toBe('inspiration-assistant-export');
    expect(bundle.stores.records).toHaveLength(2);

    // 走一遍真实的 JSON 序列化/反序列化，确保导出结果可落文件
    const roundTripped = JSON.parse(JSON.stringify(bundle)) as unknown;

    await clearStore('records');
    await importData(roundTripped, { mode: 'merge' });

    const restored = await getAllRecords<Note>('records');
    expect(restored.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
    expect(restored.find((n) => n.id === 'n2')?.tags).toEqual(['梦', '分镜']);
  });

  it('replace 模式会先清空目标仓库', async () => {
    await putRecord<Note>('records', { id: 'keep-or-drop', text: '旧数据', tags: [] });

    await importData(
      {
        format: 'inspiration-assistant-export',
        version: 1,
        exportedAt: new Date().toISOString(),
        stores: { records: [sample[0]], settings: [], media: [] },
      },
      { mode: 'replace' },
    );

    const all = await getAllRecords<Note>('records');
    expect(all.map((n) => n.id)).toEqual(['n1']);
  });

  it('格式不合法（缺 format 标识 / 版本过新）时抛 INVALID_PAYLOAD', async () => {
    const invalid = await importData({ stores: { records: [] } }).catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(StorageError);
    expect((invalid as StorageError).code).toBe('INVALID_PAYLOAD');

    const tooNew = await importData({
      format: 'inspiration-assistant-export',
      version: 99,
      exportedAt: new Date().toISOString(),
      stores: { records: [], settings: [], media: [] },
    }).catch((e: unknown) => e);
    expect((tooNew as StorageError).code).toBe('INVALID_PAYLOAD');
  });
});
