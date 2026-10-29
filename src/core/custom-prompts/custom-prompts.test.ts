/**
 * 自定义提示词副本（判据 1~5）：store / 解析 / 创作页路径 / 还原。
 *
 * 这里的"逐字相等"是刻意的：副本不存在时，跑出去的东西必须与改动前**一个字符都不差**
 * —— 否则这次改动就在静默改变所有既有产物的提示词。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase } from '../storage';
import {
  cachedCustomPromptFor,
  createCustomPrompt,
  hydrateCustomPrompts,
  listCustomPrompts,
  removeCustomPrompt,
  resetCustomPromptCache,
  restoreBuiltinPrompt,
  saveCustomPromptForPack,
  updateCustomPrompt,
  validateCustomPromptDraft,
  withCustomPrompt,
} from './index';
import { buildSystemPrompt, loadBrowserPack } from '../../ui/create/pack-runner';
import { buildSystemPrompt as buildSystemPromptNode, loadPack as loadPackNode } from '../../packs/runtime';

const CUSTOM_BODY =
  '你是一位写梦的编辑。请把这段梦写成三百字以内的整体解读：先复述画面，再指出最稳的情绪，' +
  '最后给一句可执行的自我清点。不提命运、不做诊断、不预言。';

beforeEach(async () => {
  await destroyDatabase();
  resetCustomPromptCache();
});

afterEach(async () => {
  await closeDatabase();
  resetCustomPromptCache();
});

describe('判据 1：副本 store 的 CRUD 与持久化', () => {
  it('写 → 读回 → 字段一致 → 改 → 删', async () => {
    const created = await createCustomPrompt(
      { basePackId: 'dream-interpretation', name: '我的解梦版', body: CUSTOM_BODY },
      1_700_000_000_000,
    );

    expect(created.id.startsWith('cp_')).toBe(true);
    expect(created.createdAt).toBe(1_700_000_000_000);
    expect(created.updatedAt).toBe(1_700_000_000_000);

    // 走库再读一次（不是拿内存里的对象交差）
    const rows = await listCustomPrompts('dream-interpretation');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: created.id,
      basePackId: 'dream-interpretation',
      name: '我的解梦版',
      body: CUSTOM_BODY,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });

    const updated = await updateCustomPrompt(
      created.id,
      { name: '解梦版 v2', body: `${CUSTOM_BODY}再补一句：语气克制。` },
      1_700_000_100_000,
    );
    expect(updated.name).toBe('解梦版 v2');
    expect(updated.createdAt).toBe(1_700_000_000_000);
    expect(updated.updatedAt).toBe(1_700_000_100_000);

    await removeCustomPrompt(created.id);
    expect(await listCustomPrompts()).toHaveLength(0);
    expect(cachedCustomPromptFor('dream-interpretation')).toBeUndefined();
  });

  it('刷新页面（丢掉内存快照）后仍能从库里读回同一份正文', async () => {
    const created = await createCustomPrompt({
      basePackId: 'story-expansion',
      name: '我的文案版',
      body: CUSTOM_BODY,
    });

    // 模拟换页/刷新：快照清空 → 重新 hydrate
    resetCustomPromptCache();
    expect(cachedCustomPromptFor('story-expansion')).toBeUndefined();
    await hydrateCustomPrompts();

    const restored = cachedCustomPromptFor('story-expansion');
    expect(restored?.id).toBe(created.id);
    expect(restored?.body).toBe(CUSTOM_BODY);
  });

  it('同一个 pack 只保留最新的一份生效（按 basePackId 索引查得到）', async () => {
    await createCustomPrompt(
      { basePackId: 'dream-interpretation', name: '旧版', body: CUSTOM_BODY },
      1_700_000_000_000,
    );
    const newer = await createCustomPrompt(
      { basePackId: 'dream-interpretation', name: '新版', body: `${CUSTOM_BODY}（更克制）` },
      1_700_000_200_000,
    );

    expect((await listCustomPrompts('dream-interpretation')).length).toBe(2);
    expect(cachedCustomPromptFor('dream-interpretation')?.id).toBe(newer.id);
    expect(loadBrowserPack('dream-interpretation').body).toBe(`${CUSTOM_BODY}（更克制）`);
  });
});

describe('判据 2：副本只替换正文，机器校验契约原样保留', () => {
  it('buildSystemPrompt 含自定义正文，且仍含 validation / forbidden 的每一条', async () => {
    const builtin = loadBrowserPack('dream-interpretation');
    const custom = await createCustomPrompt({
      basePackId: 'dream-interpretation',
      name: '我的解梦版',
      body: CUSTOM_BODY,
    });

    const prompt = buildSystemPrompt(withCustomPrompt(builtin, custom));

    expect(prompt.startsWith(CUSTOM_BODY)).toBe(true);
    expect(prompt).toContain('机器校验清单');
    expect(prompt).toContain('硬禁止');
    for (const rule of builtin.validation) expect(prompt).toContain(rule);
    for (const rule of builtin.forbidden) expect(prompt).toContain(rule);
    // 内置正文被换掉（不是追加）
    expect(prompt).not.toContain(builtin.body.slice(0, 200));
  });
});

describe('判据 3：没有副本时逐字等于内置原文', () => {
  it('创作页取 pack 与 Node 侧 runtime 逐字一致', () => {
    const fromBrowser = loadBrowserPack('dream-interpretation');
    const fromNode = loadPackNode('dream-interpretation');

    expect(buildSystemPrompt(fromBrowser)).toBe(buildSystemPromptNode(fromNode));
    expect(fromBrowser.body).toBe(fromNode.body);
  });
});

describe('判据 4：还原为内置 / 删除副本后回到内置', () => {
  it('restoreBuiltinPrompt 清掉副本，正文回到内置原文', async () => {
    const builtinBody = loadPackNode('dream-interpretation').body;
    await createCustomPrompt({
      basePackId: 'dream-interpretation',
      name: '我的解梦版',
      body: CUSTOM_BODY,
    });
    expect(loadBrowserPack('dream-interpretation').body).toBe(CUSTOM_BODY);

    const removed = await restoreBuiltinPrompt('dream-interpretation');
    expect(removed).toBe(1);
    expect(loadBrowserPack('dream-interpretation').body).toBe(builtinBody);
    expect(buildSystemPrompt(loadBrowserPack('dream-interpretation'))).toBe(
      buildSystemPromptNode(loadPackNode('dream-interpretation')),
    );
  });

  it('removeCustomPrompt 只影响它自己那个 pack', async () => {
    const dream = await createCustomPrompt({
      basePackId: 'dream-interpretation',
      name: '解梦版',
      body: CUSTOM_BODY,
    });
    await createCustomPrompt({ basePackId: 'story-expansion', name: '文案版', body: CUSTOM_BODY });

    await removeCustomPrompt(dream.id);

    expect(loadBrowserPack('dream-interpretation').body).toBe(loadPackNode('dream-interpretation').body);
    expect(loadBrowserPack('story-expansion').body).toBe(CUSTOM_BODY);
  });
});

describe('判据 5：创作页路径同样生效（loadBrowserPack）', () => {
  it('同一 packId 的副本在创作页取 pack 时被应用', async () => {
    const custom = await createCustomPrompt({
      basePackId: 'story-expansion',
      name: '我的文案版',
      body: CUSTOM_BODY,
    });

    const pack = loadBrowserPack('story-expansion');
    expect(pack.body).toBe(CUSTOM_BODY);
    expect(pack.validation.length).toBeGreaterThan(0);
    expect(buildSystemPrompt(pack)).toContain('机器校验清单');
    // 副本 id 一致（节点角标要用它）
    expect(cachedCustomPromptFor('story-expansion')?.id).toBe(custom.id);
  });
});

describe('保存前校验（正文非空、≥ 50 字；不合格不落库）', () => {
  it('太短 / 空正文 / 空名字都被拒，库里一条都没有', async () => {
    expect(validateCustomPromptDraft({ name: '名字', body: '' })).toContain('不能为空');
    expect(validateCustomPromptDraft({ name: '名字', body: '太短' })).toContain('至少 50 字');
    expect(validateCustomPromptDraft({ name: '   ', body: CUSTOM_BODY })).toContain('副本名');

    await expect(
      createCustomPrompt({ basePackId: 'dream-interpretation', name: '名字', body: '太短' }),
    ).rejects.toThrow(/至少 50 字/);
    expect(await listCustomPrompts()).toHaveLength(0);
  });

  it('saveCustomPromptForPack：第二次保存是更新同一条，不是再建一份', async () => {
    const first = await saveCustomPromptForPack('dream-interpretation', {
      name: '第一版',
      body: CUSTOM_BODY,
    });
    const second = await saveCustomPromptForPack('dream-interpretation', {
      name: '第二版',
      body: `${CUSTOM_BODY}（收尾更干净）`,
    });

    expect(second.id).toBe(first.id);
    expect(await listCustomPrompts()).toHaveLength(1);
    expect(loadBrowserPack('dream-interpretation').body).toBe(`${CUSTOM_BODY}（收尾更干净）`);
  });
});
