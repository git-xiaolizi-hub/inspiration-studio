// @vitest-environment node
/**
 * M3R8 回归（**不依赖 jsdom**）：IndexedDB 层的「保存 → 关库重开 → 读回」往返。
 *
 * 为什么单独一个文件、并且显式跑在 node 环境：
 * 这条链路上真正会丢数据的位置是「写进 IndexedDB / 从 IndexedDB 读出来」，
 * 与 DOM、React、jsdom 都无关。用 node + fake-indexeddb 测，就像在 Node 里
 * 单测一个纯函数一样干净 —— 一旦这里失败，说明是存储层的问题（而不是 UI 的）；
 * 反过来这里一直绿，UI 却显示空表，问题就只能出在「面板渲染的是哪条连接」。
 *
 * 复现的是 M3R8 实测的那条路径：
 *   填 base_url + Key（自动带出 1 条默认模型）→ 保存 → Page.reload → 模型表 0 行
 * 结论：**models 一直没丢**（见用例 1），0 行是面板落回了另一个厂商（见用例 2）。
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase } from '../../core/storage';
import {
  addConnection,
  createDefaultCatalog,
  loadCatalog,
  normalizeCatalog,
  resolveActiveProviderId,
  saveCatalog,
  setActiveConnection,
} from './catalog';

beforeEach(async () => {
  await destroyDatabase();
});

afterEach(async () => {
  await closeDatabase();
});

describe('M3R8 IDB 往返：models 在「保存 → 重开库 → 读回 → 归一化」之后仍非空', () => {
  it('DeepSeek 上填地址 + Key 保存 → 关库重开（= reload）→ 连接与模型表都还在', async () => {
    const { catalog, connection } = addConnection(createDefaultCatalog(), 'deepseek', {
      label: 'DeepSeek 官方',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-m3r8-roundtrip',
    });
    expect(connection.models).toHaveLength(1); // 预填的默认模型
    await saveCatalog(setActiveConnection(catalog, 'deepseek', connection.id));

    // 「真 reload」的存储层等价物：丢掉 Dexie 单例，下一次读必须重新打开 IndexedDB。
    // 只测 save 之后的内存对象是测不出 reload 行为的。
    await closeDatabase();

    const reloaded = await loadCatalog();
    const deepseek = reloaded.providers.find((provider) => provider.id === 'deepseek');
    expect(deepseek?.activeConnectionId).toBe(connection.id);
    expect(deepseek?.connections).toHaveLength(1);
    expect(deepseek?.connections[0].baseUrl).toBe('https://api.deepseek.com');
    expect(deepseek?.connections[0].apiKey).toBe('sk-m3r8-roundtrip');
    expect(deepseek?.connections[0].models).toHaveLength(1);
    expect(deepseek?.connections[0].models[0].modelId).toBe('deepseek-flash');
  });

  it('再归一化一次（UI 会反复 normalizeCatalog）也不会把 models 清空', async () => {
    const { catalog, connection } = addConnection(createDefaultCatalog(), 'deepseek', {
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-m3r8-idempotent',
    });
    await saveCatalog(setActiveConnection(catalog, 'deepseek', connection.id));
    await closeDatabase();

    const reloaded = await loadCatalog();
    const twice = normalizeCatalog(JSON.parse(JSON.stringify(reloaded)));
    const deepseek = twice.providers.find((provider) => provider.id === 'deepseek');
    expect(deepseek?.connections[0].models.map((model) => model.modelId)).toEqual(['deepseek-flash']);
  });

  it('reload 后该落在「已配置的那家」：resolveActiveProviderId 不退回智谱', async () => {
    const { catalog, connection } = addConnection(createDefaultCatalog(), 'deepseek', {
      baseUrl: 'https://api.deepseek.com',
    });
    await saveCatalog(setActiveConnection(catalog, 'deepseek', connection.id));
    await closeDatabase();

    const reloaded = await loadCatalog();
    // 没有存过「上次看的厂商」时，按「第一条有连接的」算 —— 智谱 0 条连接，故不是它
    expect(resolveActiveProviderId(reloaded, null)).toBe('deepseek');
    // providers 顺序仍然固定（智谱第一），顺序不再是「该看谁」的依据
    expect(reloaded.providers[0].id).toBe('zhipu');
  });
});
