import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase } from '../../core/storage';
import {
  buildConfigFile,
  AI_CONFIG_FILE_FORMAT,
  loadAIConfig,
  loadPriceTable,
  loadSpend,
  parseConfigFile,
  recordSpend,
  resetSpend,
  saveAIConfig,
  savePriceTable,
  serializeConfigFile,
} from './config-store';
import type { AIConfig } from './config-store';
import { clonePriceTable } from './pricing';

const SAMPLE: AIConfig = {
  providerId: 'deepseek',
  protocol: 'openai',
  baseUrl: 'https://relay.example.com',
  apiKey: 'sk-very-secret-key',
  model: 'deepseek-chat',
  models: ['deepseek-chat', 'deepseek-reasoner'],
  budgetLimit: 100,
  updatedAt: 1,
};

beforeEach(async () => {
  await destroyDatabase();
});

afterEach(async () => {
  await closeDatabase();
});

describe('配置读写（IndexedDB，失败可降级）', () => {
  it('从未保存过 → 返回默认值（baseUrl/key 都为空）', async () => {
    const config = await loadAIConfig();
    expect(config.baseUrl).toBe('');
    expect(config.apiKey).toBe('');
    expect(config.protocol).toBe('openai');
  });

  it('保存后读回来一致（含模型列表与预算）', async () => {
    await saveAIConfig(SAMPLE);
    const config = await loadAIConfig();
    expect(config.baseUrl).toBe('https://relay.example.com');
    expect(config.model).toBe('deepseek-chat');
    expect(config.models).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(config.budgetLimit).toBe(100);
  });

  it('库里的脏数据会被收敛成合法配置（不炸 UI）', async () => {
    await saveAIConfig({ ...SAMPLE, models: ['a', 3] as unknown as string[], budgetLimit: -5 });
    const config = await loadAIConfig();
    expect(config.models).toEqual(['a']);
    expect(config.budgetLimit).toBeNull();
  });
});

describe('导出 / 导入（走文件内容，不走剪贴板）', () => {
  it('默认导出不含 key，且 containsKey=false', () => {
    const file = serializeConfigFile(SAMPLE, { now: new Date('2026-10-17T10:00:00Z') });
    expect(file.containsKey).toBe(false);
    expect(file.json).not.toContain('sk-very-secret-key');
    expect(file.filename).toBe('ai-config_20261017.json');
    const parsed = JSON.parse(file.json) as Record<string, unknown>;
    expect(parsed.format).toBe(AI_CONFIG_FILE_FORMAT);
    expect(parsed.version).toBe(1);
  });

  it('勾选「包含 key」才写进文件，并标记 containsKey=true', () => {
    const file = serializeConfigFile(SAMPLE, { includeKey: true });
    expect(file.containsKey).toBe(true);
    expect(file.json).toContain('sk-very-secret-key');
  });

  it('导出 → 清库 → 导入 → 配置复原', async () => {
    await saveAIConfig(SAMPLE);
    const exported = serializeConfigFile(SAMPLE, { includeKey: true });

    // 模拟"换设备"：整个库都清掉（本项目持久化在 IndexedDB，不是 localStorage）
    await destroyDatabase();
    expect((await loadAIConfig()).baseUrl).toBe('');

    const parsed = parseConfigFile(exported.json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.containsKey).toBe(true);
    await saveAIConfig(parsed.config);

    const restored = await loadAIConfig();
    expect(restored.baseUrl).toBe(SAMPLE.baseUrl);
    expect(restored.apiKey).toBe(SAMPLE.apiKey);
    expect(restored.model).toBe(SAMPLE.model);
    expect(restored.models).toEqual(SAMPLE.models);
    expect(restored.budgetLimit).toBe(100);
  });

  it('不含 key 的导入：config.apiKey 为空，UI 据此沿用本机已有的 key', () => {
    const file = serializeConfigFile(SAMPLE, { includeKey: false });
    const parsed = parseConfigFile(file.json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.containsKey).toBe(false);
    expect(parsed.config.apiKey).toBe('');
  });

  it('坏输入一律返回人话错误（不抛异常）', () => {
    expect(parseConfigFile('不是 json').ok).toBe(false);
    const wrongFormat = parseConfigFile(JSON.stringify({ format: 'something-else', version: 1 }));
    expect(wrongFormat.ok).toBe(false);
    if (!wrongFormat.ok) expect(wrongFormat.error).toContain('不是本应用');

    const tooNew = parseConfigFile(
      JSON.stringify({ format: AI_CONFIG_FILE_FORMAT, version: 99, config: {} }),
    );
    expect(tooNew.ok).toBe(false);
    if (!tooNew.ok) expect(tooNew.error).toContain('太新');
  });

  it('导出可携带价格表，导入时一并还原（价格表也可迁移）', () => {
    const table = clonePriceTable();
    table.source = '自填的中转站价格';
    table.verified = false;
    const built = buildConfigFile(SAMPLE, { priceTable: table });
    expect(built.priceTable?.source).toBe('自填的中转站价格');

    const parsed = parseConfigFile(JSON.stringify(built));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.priceTable?.source).toBe('自填的中转站价格');
  });
});

describe('价格表与花费', () => {
  it('价格表默认是官方表，保存后可覆盖', async () => {
    const initial = await loadPriceTable();
    expect(initial.verified).toBe(true);

    const custom = clonePriceTable();
    custom.source = '我的自定义表';
    custom.verified = false;
    await savePriceTable(custom);

    const loaded = await loadPriceTable();
    expect(loaded.source).toBe('我的自定义表');
    expect(loaded.verified).toBe(false);
  });

  it('累计花费可加可清（本地记账，不代表账单）', async () => {
    expect((await loadSpend()).spent).toBe(0);
    await recordSpend(45.36);
    await recordSpend(20.18);
    expect((await loadSpend()).spent).toBeCloseTo(65.54, 2);

    await resetSpend();
    expect((await loadSpend()).spent).toBe(0);
  });

  it('负数/非法金额不会把累计花费弄成负数', async () => {
    await recordSpend(-100);
    await recordSpend(Number.NaN);
    expect((await loadSpend()).spent).toBe(0);
  });
});
