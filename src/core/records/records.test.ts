import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase, getRecord, putRecord } from '../storage';
import type { RecordRow } from '../storage/db';
import { getDatabase } from '../storage/db';
import {
  countRecordsByRole,
  createRecord,
  duplicateRecord,
  getRecordAudio,
  getRecordEntity,
  listAllTags,
  listRecords,
  normalizeTags,
  normalizeText,
  removeRecord,
  updateRecord,
} from './index';
import { bytesEqual, makeAudioBlob, readBlobBytes } from '../../test/blob-helpers';

const AUDIO_BYTES = [11, 22, 33, 44, 55, 66];

beforeEach(async () => {
  await destroyDatabase();
});

afterEach(async () => {
  await closeDatabase();
});

describe('标签与文本规范化', () => {
  it('normalizeTags 支持逗号/中文逗号/顿号，去 # 去空白去重', () => {
    expect(normalizeTags(' #梦, 梦 、分镜，分镜 ')).toEqual(['梦', '分镜']);
    expect(normalizeTags(['梦', ' 梦 ', '', '#广告'])).toEqual(['梦', '广告']);
    expect(normalizeTags(undefined)).toEqual([]);
  });

  it('normalizeText 去掉首尾空白', () => {
    expect(normalizeText('  梦见会飞的鲸鱼  ')).toBe('梦见会飞的鲸鱼');
    expect(normalizeText(undefined)).toBe('');
  });
});

describe('记录 CRUD', () => {
  it('新建记录后能读回文本、标签与时间戳', async () => {
    const created = await createRecord({ text: '  梦境测试  ', tags: ['梦', '梦', '分镜'] });

    expect(created.text).toBe('梦境测试');
    expect(created.tags).toEqual(['梦', '分镜']);
    expect(created.createdAt).toBe(created.updatedAt);
    expect(created.audio).toBeUndefined();

    const entity = await getRecordEntity(created.id);
    expect(entity?.text).toBe('梦境测试');
    expect(entity?.tags).toEqual(['梦', '分镜']);

    // 刷新页面（= 重新打开库）后仍在：这里通过关闭再读模拟
    await closeDatabase();
    expect((await getRecordEntity(created.id))?.text).toBe('梦境测试');
  });

  it('文字与标签都为空的记录被拒绝（VALIDATION）', async () => {
    await expect(createRecord({ text: '   ' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('更新记录改文本与标签，createdAt 不变、updatedAt 前进', async () => {
    const created = await createRecord({ text: '初稿', tags: ['梦'] });

    const updated = await updateRecord(created.id, {
      text: '改稿：雨夜霓虹',
      tags: ['梦', '广告'],
    });

    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    expect(updated.text).toBe('改稿：雨夜霓虹');
    expect(updated.tags).toEqual(['梦', '广告']);

    const reread = await getRecordEntity(created.id);
    expect(reread?.text).toBe('改稿：雨夜霓虹');
  });

  it('更新不存在的记录抛 NOT_FOUND', async () => {
    await expect(updateRecord('no-such-id', { text: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('不能把文字和录音同时清空', async () => {
    const created = await createRecord({ text: '只有文字' });
    await expect(updateRecord(created.id, { text: '', audio: null })).rejects.toMatchObject({
      code: 'VALIDATION',
    });

    // 拒绝之后原记录不能被改坏
    expect((await getRecordEntity(created.id))?.text).toBe('只有文字');
  });
});

describe('录音与记录的关联', () => {
  it('音频存 media 表，records 行只留引用（导出 JSON 天然不含二进制）', async () => {
    const blob = makeAudioBlob(AUDIO_BYTES);
    const created = await createRecord({
      text: '录一段想法',
      tags: ['灵感'],
      audio: { blob, mimeType: 'audio/webm;codecs=opus', durationMs: 4300 },
    });

    // records 行：只有引用，没有 blob
    const row = await getRecord<RecordRow>('records', created.id);
    expect(row?.audio).toEqual({
      mediaId: created.id,
      mimeType: 'audio/webm;codecs=opus',
      durationMs: 4300,
    });
    expect('blob' in (row?.audio ?? {})).toBe(false);

    // media 表：一条音轨，recordId 指向记录
    const mediaRows = await getDatabase().media.toArray();
    expect(mediaRows).toHaveLength(1);
    expect(mediaRows[0].recordId).toBe(created.id);
    expect(mediaRows[0].durationMs).toBe(4300);

    // 对外实体：读回来的是可播放的 Blob，字节一致
    const entity = await getRecordEntity(created.id);
    expect(entity?.text).toBe('录一段想法');
    expect(entity?.audio?.mimeType).toBe('audio/webm;codecs=opus');
    expect(entity?.audio?.durationMs).toBe(4300);
    expect(bytesEqual(await readBlobBytes(entity!.audio!.blob), AUDIO_BYTES)).toBe(true);
  });

  it('列表摘要带时长但不带 Blob', async () => {
    await createRecord({
      text: '带录音的记录',
      audio: {
        blob: makeAudioBlob(AUDIO_BYTES),
        mimeType: 'audio/webm;codecs=opus',
        durationMs: 5000,
      },
    });

    const page = await listRecords();
    expect(page.items).toHaveLength(1);
    expect(page.items[0].hasAudio).toBe(true);
    expect(page.items[0].audioDurationMs).toBe(5000);
    expect('audio' in page.items[0]).toBe(false);
  });

  it('删除记录时级联删除音频', async () => {
    const created = await createRecord({
      text: '要删掉的记录',
      audio: { blob: makeAudioBlob(), mimeType: 'audio/webm;codecs=opus', durationMs: 1000 },
    });
    expect(await getDatabase().media.count()).toBe(1);

    await removeRecord(created.id);

    expect(await getRecordEntity(created.id)).toBeUndefined();
    expect(await getDatabase().media.count()).toBe(0);
    expect(await getRecordAudio(created.id)).toBeUndefined();
  });

  it('把 audio 设为 null 会删掉音轨并保留文字', async () => {
    const created = await createRecord({
      text: '先录音后删录音',
      audio: { blob: makeAudioBlob(), mimeType: 'audio/webm;codecs=opus', durationMs: 2000 },
    });

    const updated = await updateRecord(created.id, { audio: null });

    expect(updated.audio).toBeUndefined();
    expect(updated.text).toBe('先录音后删录音');
    expect(await getDatabase().media.count()).toBe(0);
  });
});

describe('列表：标签筛选 / 时间倒序 / 分页 / 搜索', () => {
  /** 直接写行，方便造出确定的 createdAt 序列（走公开 CRUD 的话时间戳都是"现在"） */
  async function seed(count: number, base = 1_700_000_000_000): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const row: RecordRow = {
        id: `seed-${index.toString().padStart(2, '0')}`,
        text: index === 7 ? '雨夜霓虹的分镜' : `第 ${index} 条`,
        tags: index % 2 === 0 ? ['梦'] : ['广告'],
        createdAt: base + index * 1000,
        updatedAt: base + index * 1000,
      };
      await putRecord('records', row);
    }
  }

  it('每页 20 条、时间倒序、两页无重叠', async () => {
    await seed(25);

    const first = await listRecords({ page: 1, pageSize: 20 });
    expect(first.total).toBe(25);
    expect(first.pageCount).toBe(2);
    expect(first.items).toHaveLength(20);
    // 倒序：第一条是最新的 seed-24
    expect(first.items[0].id).toBe('seed-24');
    expect(first.items[19].id).toBe('seed-05');
    for (let index = 1; index < first.items.length; index += 1) {
      expect(first.items[index - 1].createdAt).toBeGreaterThan(first.items[index].createdAt);
    }

    const second = await listRecords({ page: 2, pageSize: 20 });
    expect(second.items).toHaveLength(5);
    expect(second.items[0].id).toBe('seed-04');
    expect(second.items[4].id).toBe('seed-00');

    const overlap = second.items.filter((item) => first.items.some((prev) => prev.id === item.id));
    expect(overlap).toHaveLength(0);
  });

  it('页码超出范围时夹到最后一页', async () => {
    await seed(25);
    const page = await listRecords({ page: 99, pageSize: 20 });
    expect(page.page).toBe(2);
    expect(page.items).toHaveLength(5);
  });

  it('按标签筛选只返回带该标签的记录', async () => {
    await seed(10);

    const dreams = await listRecords({ tag: '梦' });
    expect(dreams.total).toBe(5);
    expect(dreams.items.every((item) => item.tags.includes('梦'))).toBe(true);

    const ads = await listRecords({ tag: '广告' });
    expect(ads.total).toBe(5);

    expect((await listRecords({ tag: '不存在' })).total).toBe(0);
  });

  it('搜索匹配正文与标签，忽略大小写', async () => {
    await seed(10);
    const byText = await listRecords({ search: '霓虹' });
    expect(byText.total).toBe(1);
    expect(byText.items[0].id).toBe('seed-07');

    const byTag = await listRecords({ search: '广告' });
    expect(byTag.total).toBe(5);
  });

  it('标签云给出每个标签的使用次数', async () => {
    await seed(10);
    const tags = await listAllTags();
    expect(tags).toEqual(
      expect.arrayContaining([
        { tag: '梦', count: 5 },
        { tag: '广告', count: 5 },
      ]),
    );
  });
});

/* ================================================================== */
/* P5：role / sourceIds（新增字段，加法用例 —— 上面的断言一条没动）      */
/* ================================================================== */

describe('P5：成品与来源（两个可选字段，不升 Dexie 版本）', () => {
  it('成品写进去能读回来：role=draft + sourceIds 保序', async () => {
    const first = await createRecord({ text: '素材甲：图书馆在呼吸' });
    const second = await createRecord({ text: '素材乙：地铁报站声' });

    const created = await createRecord({
      text: '图书馆在呼吸。不是比喻。',
      role: 'draft',
      sourceIds: [second.id, first.id],
    });

    expect(created.role).toBe('draft');
    // 顺序 = 传入顺序（= 展示区里的素材编号顺序），不排序
    expect(created.sourceIds).toEqual([second.id, first.id]);

    const entity = await getRecordEntity(created.id);
    expect(entity?.role).toBe('draft');
    expect(entity?.sourceIds).toEqual([second.id, first.id]);

    // 列表摘要也带（列表页的角标与「来自 N 条素材」都读它）
    const page = await listRecords();
    const summary = page.items.find((item) => item.id === created.id);
    expect(summary?.role).toBe('draft');
    expect(summary?.sourceIds).toHaveLength(2);
  });

  it('默认值不落库：普通笔记的行里没有 role / sourceIds 两个键', async () => {
    const note = await createRecord({ text: '一条普通笔记' });

    const row = await getRecord<RecordRow>('records', note.id);
    expect(row).toBeDefined();
    // 关键：不是 role:'note' 而是**根本没有这个属性** —— 旧库的形状保持不变
    expect('role' in (row as object)).toBe(false);
    expect('sourceIds' in (row as object)).toBe(false);

    // 但读出来是合法的默认形态（读时归一，不是写时补字段）
    expect(note.role).toBeUndefined();
    expect(note.sourceIds).toBeUndefined();
  });

  it('旧记录（行里没有这两个字段）照样读，不报错', async () => {
    // 模拟 M5 之前写下的行：直接 put 一个没有 role / sourceIds 的对象
    const legacy: RecordRow = {
      id: 'legacy-row',
      text: '旧版本写下的梦',
      tags: ['梦'],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    await putRecord('records', legacy);

    const entity = await getRecordEntity('legacy-row');
    expect(entity?.text).toBe('旧版本写下的梦');
    expect(entity?.role).toBeUndefined();

    const page = await listRecords();
    expect(page.items.find((item) => item.id === 'legacy-row')?.text).toBe('旧版本写下的梦');
  });

  it('非法 role 不会写进去（归一后再落库），来源里的空 id 被丢掉', async () => {
    const created = await createRecord({
      text: '脏值测试',
      // @ts-expect-error 故意传非法值：数据层要兜住，而不是让脏值进库
      role: 'finshed',
      sourceIds: ['a', '', 'a', 42 as unknown as string],
    });

    expect(created.role).toBeUndefined();
    expect(created.sourceIds).toEqual(['a']);

    const row = await getRecord<RecordRow>('records', created.id);
    expect('role' in (row as object)).toBe(false);
    expect(row?.sourceIds).toEqual(['a']);
  });

  it('改正文不会把成品变回笔记（role / sourceIds 跟着旧值走）', async () => {
    const source = await createRecord({ text: '来源素材' });
    const draft = await createRecord({
      text: '初版成品',
      role: 'draft',
      sourceIds: [source.id],
    });

    const updated = await updateRecord(draft.id, { text: '改过的成品' });

    expect(updated.text).toBe('改过的成品');
    expect(updated.role).toBe('draft');
    expect(updated.sourceIds).toEqual([source.id]);

    const reread = await getRecordEntity(draft.id);
    expect(reread?.role).toBe('draft');
  });
});

describe('P5：复制素材（原记录一个字都不改）', () => {
  it('复制出新记录：正文与标签相同、role=note、sourceIds=[原 id]，原记录不变', async () => {
    const original = await createRecord({ text: '凌晨三点的梦', tags: ['梦', '灵感'] });
    const before = await getRecordEntity(original.id);

    const copy = await duplicateRecord(original.id);

    expect(copy.id).not.toBe(original.id);
    expect(copy.text).toBe(original.text);
    expect(copy.tags).toEqual(original.tags);
    expect(copy.role).toBeUndefined(); // = 笔记
    expect(copy.sourceIds).toEqual([original.id]);

    // 原记录逐字没动（包括 updatedAt）
    expect(await getRecordEntity(original.id)).toEqual(before);
    // 库里现在是两条
    expect((await listRecords()).total).toBe(2);
  });

  it('复制一条不存在的记录 → NOT_FOUND', async () => {
    await expect(duplicateRecord('no-such-id')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('只有录音没有文字的记录复制不了（VAL_IDATION），且不会生成空记录', async () => {
    const audioOnly = await createRecord({
      audio: { blob: makeAudioBlob(), mimeType: 'audio/webm', durationMs: 1200 },
    });

    await expect(duplicateRecord(audioOnly.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await listRecords()).total).toBe(1);
  });
});

describe('P5：countRecordsByRole（三段筛选的数字）', () => {
  it('全部 / 我写的（note+draft）/ AI 产出（asset）分别计数', async () => {
    await createRecord({ text: '笔记一' });
    await createRecord({ text: '笔记二' });
    await createRecord({ text: '成品一', role: 'draft', sourceIds: ['x'] });
    await createRecord({ text: 'AI 产出', role: 'asset', sourceIds: ['x'] });

    const counts = await countRecordsByRole();
    expect(counts).toEqual({ all: 4, mine: 3, ai: 1 });
  });

  it('空库是 0/0/0（不是 NaN，也不抛）', async () => {
    expect(await countRecordsByRole()).toEqual({ all: 0, mine: 0, ai: 0 });
  });
});
