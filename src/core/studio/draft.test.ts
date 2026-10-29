/**
 * P3 · 写作工作台草稿（settings.studio-draft）。
 *
 * 盯四件事：形状与任务书 §3.4 一致、脏数据回落空草稿且**不写回**、
 * 素材上限 4 条（P4c §1 从 3 提到 4）、悬空 id 清理（记录删了草稿不该带残骸）。
 *
 * P4c 追加：`moveMaterialId`（展示区拖拽换序）—— 数组顺序 = 【素材N】编号，
 * 所以最后一段用例把「换序」和「上下文里的编号」串起来钉住。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase, getSetting, putSetting } from '../storage';
import { createRecord, removeRecord } from '../records';
import { buildStudioContext } from './context';
import {
  AUTOSAVE_DELAY_MS,
  MAX_MATERIALS,
  STUDIO_DRAFT_KEY,
  cleanMaterialIds,
  countBodyChars,
  emptyDraft,
  fingerprintDraft,
  loadDraft,
  moveMaterialId,
  normalizeDraft,
  pruneDraftMaterials,
  saveDraft,
} from './draft';

beforeEach(async () => {
  await destroyDatabase();
});

afterEach(async () => {
  await closeDatabase();
});

async function readRaw(): Promise<unknown> {
  return (await getSetting(STUDIO_DRAFT_KEY))?.value;
}

describe('草稿的形状与清洗', () => {
  it('默认是空草稿，防抖延迟按任务书是 500ms、素材上限 4 条', () => {
    expect(emptyDraft()).toEqual({ body: '', materialIds: [], updatedAt: 0 });
    expect(AUTOSAVE_DELAY_MS).toBe(500);
    expect(MAX_MATERIALS).toBe(4);
  });

  it('normalizeDraft：非对象 / 字段类型不对 → 回落空草稿，不抛异常', () => {
    expect(normalizeDraft(null)).toEqual(emptyDraft());
    expect(normalizeDraft('一段字符串')).toEqual(emptyDraft());
    expect(normalizeDraft(42)).toEqual(emptyDraft());
    expect(normalizeDraft({ body: 123, materialIds: 'abc', updatedAt: 'soon' })).toEqual(
      emptyDraft(),
    );
  });

  it('正文不做 trim（用户敲的首尾空行要原样读回），素材 id 去重并截到 4 条', () => {
    const draft = normalizeDraft({
      body: '\n\n  图书馆在呼吸。\n\n',
      materialIds: ['a', 'a', ' b ', '', 'c', 'd', 'e'],
      updatedAt: 1234,
    });

    expect(draft.body).toBe('\n\n  图书馆在呼吸。\n\n');
    expect(draft.materialIds).toEqual(['a', 'b', 'c', 'd']);
    expect(draft.updatedAt).toBe(1234);
  });

  it('cleanMaterialIds：上限 4 条，越界的第 5 条不会被偷偷塞进库', () => {
    expect(cleanMaterialIds(['1', '2', '3', '4', '5'])).toEqual(['1', '2', '3', '4']);
    expect(cleanMaterialIds(undefined)).toEqual([]);
  });
});

describe('读写落库', () => {
  it('saveDraft 之后 loadDraft 读回同一份（正文 + 素材顺序 + updatedAt 被刷新）', async () => {
    const saved = await saveDraft({ body: '图书馆在呼吸。', materialIds: ['m1', 'm2'], updatedAt: 0 }, 777);

    expect(saved.updatedAt).toBe(777);
    expect(await loadDraft()).toEqual(saved);
    expect(await readRaw()).toEqual(saved);
  });

  it('从未保存过 → 空草稿；库里的脏数据 → 空草稿且**不写回**（别把用户正文清成空）', async () => {
    expect(await loadDraft()).toEqual(emptyDraft());

    await putSetting({ key: STUDIO_DRAFT_KEY, value: '{坏掉的 JSON', updatedAt: 1 });
    expect(await loadDraft()).toEqual(emptyDraft());
    // 关键：读脏数据不会覆盖原值
    expect(await readRaw()).toBe('{坏掉的 JSON');
  });

  it('字数按非空白字符算（换行与缩进不计）', () => {
    expect(countBodyChars('图书馆在呼吸。\n\n不是比喻。')).toBe(12);
    expect(countBodyChars('   ')).toBe(0);
  });
});

describe('悬空素材 id（记录被删之后）', () => {
  it('pruneDraftMaterials 只清失效的 id，正文一字不动；无变化时返回同一个对象', () => {
    const draft = { body: '正文', materialIds: ['a', 'b'], updatedAt: 5 };

    expect(pruneDraftMaterials(draft, new Set(['a']))).toEqual({
      body: '正文',
      materialIds: ['a'],
      updatedAt: 5,
    });
    expect(pruneDraftMaterials(draft, new Set(['a', 'b']))).toBe(draft);
  });

  it('真删一条记录：草稿里的 id 被清掉，再读回来也不带残骸', async () => {
    const keep = await createRecord({ text: '留下的素材' });
    const gone = await createRecord({ text: '会被删掉的素材' });

    await saveDraft({ body: '正文', materialIds: [keep.id, gone.id], updatedAt: 0 });
    await removeRecord(gone.id);

    const draft = await loadDraft();
    const pruned = pruneDraftMaterials(draft, new Set([keep.id]));
    expect(pruned.materialIds).toEqual([keep.id]);
    expect(pruned.body).toBe('正文');

    await saveDraft(pruned);
    expect((await loadDraft()).materialIds).toEqual([keep.id]);
  });
});

/* ================================================================== */
/* P4c §6.2 · 展示区换序 → AI 上下文里的【素材N】编号跟着变              */
/* ================================================================== */

describe('moveMaterialId（展示区拖拽换序）', () => {
  it('把第 1 条挪到最后 / 把最后一条挪到最前，其余相对顺序不变', () => {
    expect(moveMaterialId(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveMaterialId(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveMaterialId(['a', 'b', 'c', 'd'], 1, 2)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('越界 / 非整数 / 原地不动 → 原样返回**同一个数组**（调用方据此跳过写库）', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveMaterialId(ids, 0, 0)).toBe(ids);
    expect(moveMaterialId(ids, -1, 1)).toBe(ids);
    expect(moveMaterialId(ids, 1, 3)).toBe(ids);
    expect(moveMaterialId(ids, 1.5, 2)).toBe(ids);
    expect(moveMaterialId([], 0, 0)).toEqual([]);
  });

  it('换序之后【素材1】【素材2】跟着变 —— 顺序就是喂给模型的编号', () => {
    const materials = [
      { text: '解梦：潮水是情绪的周期。' },
      { text: '凌晨三点的图书馆。' },
      { text: '地铁报站声当鼓点。' },
    ];
    const before = buildStudioContext(materials, '正文一句。');

    // 用户把第 1 条拖到最后（对应 materialIds 的 0 → 2）
    const order = moveMaterialId(
      materials.map((_, index) => String(index)),
      0,
      2,
    );
    const reordered = order.map((key) => materials[Number(key)]);
    const after = buildStudioContext(reordered, '正文一句。');

    // 换序前：【素材1】= 解梦；换序后：【素材1】= 图书馆，解梦掉到【素材3】
    expect(before.startsWith('【素材1】解梦')).toBe(true);
    expect(after.startsWith('【素材1】凌晨三点的图书馆。')).toBe(true);
    expect(after).toContain('【素材3】解梦：潮水是情绪的周期。');
    // 正文段一个字没动
    expect(after.endsWith('【正文】正文一句。')).toBe(true);
  });
});

/* ================================================================== */
/* P5：「存为记录」的指纹 + 指纹落库（savedFingerprint）                 */
/* ================================================================== */

describe('P5：存为记录的防重复指纹', () => {
  it('同正文同素材 = 同指纹（容器没有变化）', () => {
    const a = fingerprintDraft('图书馆在呼吸。', ['r1', 'r2']);
    const b = fingerprintDraft('图书馆在呼吸。', ['r1', 'r2']);
    expect(a).toBe(b);
  });

  it('素材顺序不同 = 同指纹（换序不是新内容 → 排序后拼接）', () => {
    expect(fingerprintDraft('正文', ['r2', 'r1'])).toBe(fingerprintDraft('正文', ['r1', 'r2']));
  });

  it('改一个字 / 多一个空格 = 不同指纹（正文不 trim）', () => {
    const base = fingerprintDraft('图书馆在呼吸。', ['r1']);
    expect(fingerprintDraft('图书馆在呼吸！', ['r1'])).not.toBe(base);
    expect(fingerprintDraft('图书馆在呼吸。 ', ['r1'])).not.toBe(base);
    expect(fingerprintDraft('图书馆在呼', ['r1'])).not.toBe(base);
  });

  it('素材加一条 / 少一条 = 不同指纹', () => {
    const base = fingerprintDraft('正文', ['r1']);
    expect(fingerprintDraft('正文', ['r1', 'r2'])).not.toBe(base);
    expect(fingerprintDraft('正文', [])).not.toBe(base);
  });

  it('没有素材也能算（草稿可以不带素材存成记录）', () => {
    const fingerprint = fingerprintDraft('只有正文', []);
    expect(typeof fingerprint).toBe('string');
    // 结构 = 哈希:正文长度:素材 id（这里没有素材，最后一段是空串）
    const parts = fingerprint.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[1]).toBe('4');
    expect(parts[2]).toBe('');
    expect(fingerprintDraft('只有正文', [])).toBe(fingerprint);
  });
});

describe('P5：savedFingerprint 跟着草稿落库', () => {
  it('saveDraft 写进去、loadDraft 读回来（刷新后按钮仍是「已保存」）', async () => {
    const saved = await saveDraft({
      body: '存过的正文',
      materialIds: ['r1'],
      updatedAt: 0,
      savedFingerprint: fingerprintDraft('存过的正文', ['r1']),
    });
    expect(saved.savedFingerprint).toBe(fingerprintDraft('存过的正文', ['r1']));

    const loaded = await loadDraft();
    expect(loaded.savedFingerprint).toBe(fingerprintDraft('存过的正文', ['r1']));
    expect(loaded.body).toBe('存过的正文');
  });

  it('脏值 / 缺字段 → 当作「从没存过」（不抛异常，也不写一个假指纹）', () => {
    expect(normalizeDraft({ body: 'x', materialIds: [] }).savedFingerprint).toBeUndefined();
    expect(
      normalizeDraft({ body: 'x', materialIds: [], savedFingerprint: 42 }).savedFingerprint,
    ).toBeUndefined();
    expect(
      normalizeDraft({ body: 'x', materialIds: [], savedFingerprint: '' }).savedFingerprint,
    ).toBeUndefined();
    expect(
      normalizeDraft({ body: 'x', materialIds: [], savedFingerprint: 'abc' }).savedFingerprint,
    ).toBe('abc');
  });

  it('清掉悬空素材时指纹不丢（pruneDraftMaterials 只动 materialIds）', () => {
    const draft = {
      body: '正文',
      materialIds: ['keep', 'gone'],
      updatedAt: 0,
      savedFingerprint: 'fp',
    };
    const pruned = pruneDraftMaterials(draft, new Set(['keep']));
    expect(pruned.materialIds).toEqual(['keep']);
    expect(pruned.savedFingerprint).toBe('fp');
  });
});
