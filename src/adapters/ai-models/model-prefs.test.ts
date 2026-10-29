// @vitest-environment node
/**
 * R7a §D §E：`settings.modelOrder` / `settings.modelRoles`。
 *
 * 为什么单测跑在 node（不依赖 jsdom）：真正会坏的地方是「写进 IndexedDB / 读出来」
 * 与两个纯函数，和 React 无关（同 `catalog-persistence.test.ts` 的理由）。
 *
 * 锁四条：
 * 1. 排序：order 里没有的排在后面且**保持原有相对顺序**，order 里的死 key 自动丢弃；
 * 2. 空数组 = 不排序（新用户拿到的是原顺序，不是随机顺序）；
 * 3. 悬空清理：模型/连接删了之后，order 与 roles 里的死指针都要清掉，且**没变化不写库**；
 * 4. 角色读回来要清洗（未知角色名、空串、非字符串一律丢），脏数据不抛错。
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase, getSetting, putSetting } from '../../core/storage';
import {
  MODEL_ORDER_KEY,
  MODEL_ROLES_KEY,
  normalizeModelOrder,
  normalizeModelRoles,
  orderModels,
  pruneDanglingModelRefs,
  pruneMissingModelRefs,
  readModelOrder,
  readModelRoles,
  writeModelOrder,
  writeModelRoles,
} from './model-prefs';
import {
  VENDOR_META,
  addConnection,
  applyPresetTag,
  createDefaultCatalog,
  modelKeyOf,
  modelKeysOf,
  PRESET_TAGS,
} from './catalog';

beforeEach(async () => {
  await destroyDatabase();
});

afterEach(async () => {
  await closeDatabase();
});

describe('归一化（脏数据不许让页面崩）', () => {
  it('normalizeModelOrder：非数组 → []；去重、去空、丢非字符串', () => {
    expect(normalizeModelOrder(undefined)).toEqual([]);
    expect(normalizeModelOrder('not-an-array')).toEqual([]);
    expect(normalizeModelOrder({ 0: 'a' })).toEqual([]);
    expect(normalizeModelOrder(['a', 'a', '  b  ', '', '   ', 3, null, 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('normalizeModelRoles：只认五个角色，空串与非字符串一律丢', () => {
    expect(normalizeModelRoles(null)).toEqual({});
    expect(normalizeModelRoles([])).toEqual({});
    expect(normalizeModelRoles('x')).toEqual({});
    expect(
      normalizeModelRoles({
        writing: 'zhipu:conn-1:glm-5.3-flash',
        image: '',
        video: 12,
        audio: '   ',
        agent: 'deepseek:conn-2:deepseek-v4-pro',
        拼错的角色: 'x:y:z',
      }),
    ).toEqual({
      writing: 'zhipu:conn-1:glm-5.3-flash',
      agent: 'deepseek:conn-2:deepseek-v4-pro',
    });
  });
});

describe('orderModels（纯函数）', () => {
  const items = [
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B' },
    { key: 'c', label: 'C' },
    { key: 'd', label: 'D' },
  ];

  it('空 order → 原顺序（新用户不该看到随机排序）', () => {
    expect(orderModels(items, []).map((item) => item.key)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('order 里没有的排在后面，且保持原有相对顺序', () => {
    expect(orderModels(items, ['c', 'a']).map((item) => item.key)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('order 里有不存在的 key → 自动丢弃，不影响结果', () => {
    expect(orderModels(items, ['b', '已删除的模型', 'd']).map((item) => item.key)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });

  it('order 里重复的 key 只认第一次出现的位置', () => {
    expect(orderModels(items, ['d', 'b', 'd']).map((item) => item.key)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('不改动传入的数组（调用方可能直接 setState 原数组）', () => {
    const copy = [...items];
    orderModels(items, ['d']);
    expect(items).toEqual(copy);
  });

  it('空列表 / 单项也正常', () => {
    expect(orderModels([], ['a'])).toEqual([]);
    expect(orderModels([{ key: 'a' }], ['a']).map((item) => item.key)).toEqual(['a']);
  });
});

describe('读写往返（settings 两个 key，不建表、不升版本）', () => {
  it('写进去的顺序去重后原样读回', async () => {
    expect(await readModelOrder()).toEqual([]);
    const saved = await writeModelOrder(['zhipu:c1:m1', 'zhipu:c1:m1', 'deepseek:c2:m2']);
    expect(saved).toEqual(['zhipu:c1:m1', 'deepseek:c2:m2']);
    expect(await readModelOrder()).toEqual(['zhipu:c1:m1', 'deepseek:c2:m2']);

    const row = await getSetting(MODEL_ORDER_KEY);
    expect(row?.value).toEqual(['zhipu:c1:m1', 'deepseek:c2:m2']);
  });

  it('角色写进去只留配置过的那几个', async () => {
    expect(await readModelRoles()).toEqual({});
    await writeModelRoles({ writing: 'a:b:c', agent: '' });
    expect(await readModelRoles()).toEqual({ writing: 'a:b:c' });

    const row = await getSetting(MODEL_ROLES_KEY);
    expect(row?.value).toEqual({ writing: 'a:b:c' });
  });

  it('库里存了脏值（不是对象/数组）→ 读成空，不抛错', async () => {
    await putSetting({ key: MODEL_ORDER_KEY, value: '脏数据', updatedAt: Date.now() });
    await putSetting({ key: MODEL_ROLES_KEY, value: 42, updatedAt: Date.now() });
    expect(await readModelOrder()).toEqual([]);
    expect(await readModelRoles()).toEqual({});
  });
});

/** 一份真实一点的目录：智谱（预填 glm-5.3-flash）+ DeepSeek（预填 deepseek-flash） */
async function seedCatalog() {
  let catalog = createDefaultCatalog();
  const zhipu = addConnection(catalog, 'zhipu', { label: '智谱', baseUrl: VENDOR_META.zhipu.baseUrl });
  catalog = zhipu.catalog;
  const deepseek = addConnection(catalog, 'deepseek', {
    label: 'DeepSeek',
    baseUrl: VENDOR_META.deepseek.baseUrl,
  });
  catalog = deepseek.catalog;
  const cogview = PRESET_TAGS.zhipu.find((tag) => tag.modelId === 'cogview-3-flash');
  if (!cogview) throw new Error('缺少 cogview-3-flash');
  catalog = applyPresetTag(catalog, 'zhipu', cogview);
  return {
    catalog,
    zhipuConnectionId: zhipu.connection.id,
    deepseekConnectionId: deepseek.connection.id,
    glmKey: modelKeyOf('zhipu', zhipu.connection.id, 'glm-5.3-flash'),
    cogviewKey: modelKeyOf('zhipu', zhipu.connection.id, 'cogview-3-flash'),
    deepseekKey: modelKeyOf('deepseek', deepseek.connection.id, 'deepseek-flash'),
  };
}

describe('悬空 id 清理（照 core/library 的 pruneDangling：没变化不写库）', () => {
  it('模型删了 / 连接删了 → order 与 roles 里的死 key 都被清掉，活的保留', async () => {
    const { catalog, glmKey, cogviewKey, deepseekKey } = await seedCatalog();
    await writeModelOrder([deepseekKey, 'zhipu:conn-已删除:glm-5.3-flash', glmKey, cogviewKey]);
    await writeModelRoles({ writing: deepseekKey, image: 'zhipu:conn-已删除:cogview-3-flash', agent: glmKey });

    const valid = modelKeysOf(catalog);
    const pruned = await pruneDanglingModelRefs(valid);

    expect(pruned.order).toEqual([deepseekKey, glmKey, cogviewKey]);
    expect(pruned.roles).toEqual({ writing: deepseekKey, agent: glmKey });
    expect(await readModelOrder()).toEqual([deepseekKey, glmKey, cogviewKey]);
    expect(await readModelRoles()).toEqual({ writing: deepseekKey, agent: glmKey });
  });

  it('没有悬空时第二次调用不再写库（updatedAt 不变）', async () => {
    const { catalog, glmKey } = await seedCatalog();
    await writeModelOrder([glmKey]);
    await pruneMissingModelRefs(catalog);
    const before = await getSetting(MODEL_ORDER_KEY);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await pruneMissingModelRefs(catalog);
    const after = await getSetting(MODEL_ORDER_KEY);

    expect(again.order).toEqual([glmKey]);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it('全空时也不写库、不抛错', async () => {
    const catalog = createDefaultCatalog();
    const pruned = await pruneMissingModelRefs(catalog);
    expect(pruned).toEqual({ order: [], roles: {} });
    expect(await getSetting(MODEL_ORDER_KEY)).toBeUndefined();
    expect(await getSetting(MODEL_ROLES_KEY)).toBeUndefined();
  });

  it('modelKeysOf 只收 modelId 非空的行（刚点「手工添加」的空行不算）', async () => {
    const { catalog, glmKey, cogviewKey, deepseekKey } = await seedCatalog();
    const keys = modelKeysOf(catalog);
    expect(keys.has(glmKey)).toBe(true);
    expect(keys.has(cogviewKey)).toBe(true);
    expect(keys.has(deepseekKey)).toBe(true);
    expect([...keys].some((key) => key.endsWith(':'))).toBe(false);
  });
});
