/**
 * M5a 判据 6–9：备份统一（`npm run test:backup`）。
 *
 * 与 `backup.test.ts`（M2 的 14 条记录/音频断言）并存：
 * 那个文件锁「记录 + 音频」的老语义，这里锁「一份 zip 装下全部」的新语义。
 */
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase, getSetting } from '../storage';
import { createRecord, getRecordEntity, listRecords } from '../records';
import { saveVoiceSettings, getVoiceSettings } from '../settings';
import {
  CANVAS_MODE_KEY,
  CANVAS_POSITIONS_KEY,
  loadCanvasMode,
  loadCanvasPositions,
  saveCanvasMode,
  saveCanvasPositions,
} from '../canvas/positions';
import { addConnection, createDefaultCatalog, loadCatalog, saveCatalog } from '../../adapters/ai-models/catalog';
import { AI_PRICE_TABLE_KEY, loadPriceTable, savePriceTable } from '../../adapters/ai-models/config-store';
import { OFFICIAL_PRICE_TABLE, clonePriceTable } from '../../adapters/ai-models/pricing';
import { BACKUP_FORMAT, BACKUP_VERSION, exportBackupZip, importBackupZip } from './index';
import { bytesEqual, makeAudioBlob, readBlobBytes } from '../../test/blob-helpers';

const AUDIO_BYTES = [1, 2, 3, 4, 5, 6, 7, 8];
const SECRET_KEY = 'sk-m5a-secret-key-0001';

beforeEach(async () => {
  await destroyDatabase();
});

afterEach(async () => {
  await closeDatabase();
});

async function openZip(blob: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await readBlobBytes(blob));
}

async function readJson<T>(zip: JSZip, name: string): Promise<T> {
  const file = zip.file(name);
  expect(file, `zip 里应该有 ${name}`).not.toBeNull();
  return JSON.parse(await file!.async('string')) as T;
}

/** 造一份「本机已有配置」的库：一条带音频的记录 + 一条带 key 的连接 + 语音/画布设置 + 自定义价格表 */
async function seedLibrary(): Promise<{ recordId: string; connectionId: string }> {
  const record = await createRecord({
    text: '广告分镜：雨夜霓虹',
    tags: ['广告', '分镜'],
    audio: { blob: makeAudioBlob(AUDIO_BYTES), mimeType: 'audio/webm;codecs=opus', durationMs: 6200 },
  });

  const base = createDefaultCatalog();
  const added = addConnection(base, 'zhipu', {
    label: '智谱官方',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: SECRET_KEY,
  });
  await saveCatalog(added.catalog);

  await saveVoiceSettings({ mode: 'local-whisper' });
  await saveCanvasMode('waterfall');
  await saveCanvasPositions({ [record.id]: { x: 120, y: 64 } });
  await savePriceTable({
    ...clonePriceTable(OFFICIAL_PRICE_TABLE),
    source: 'M5a 测试价格表',
    verified: true,
    verifiedAt: '2026-10',
  });

  return { recordId: record.id, connectionId: added.connection.id };
}

describe('判据 6：完整备份 zip 的条目清单', () => {
  it('一份 zip 里有 manifest / records / ai-catalog / settings / price-table 五个 JSON，音频在 media/ 下', async () => {
    const { recordId } = await seedLibrary();
    const result = await exportBackupZip(new Date(2026, 9, 18, 9, 0));

    const zip = await openZip(result.blob);
    const names = Object.keys(zip.files);

    for (const required of [
      'manifest.json',
      'records.json',
      'ai-catalog.json',
      'settings.json',
      'price-table.json',
      `media/${recordId}.webm`,
    ]) {
      expect(names, `应包含 ${required}`).toContain(required);
    }

    // 五个 JSON 条目 + media 目录（判据里的「5 个条目」= 这 5 个文件，媒体是目录）
    const jsonEntries = names.filter((name) => name.endsWith('.json'));
    expect(jsonEntries.sort()).toEqual(
      ['ai-catalog.json', 'manifest.json', 'price-table.json', 'records.json', 'settings.json'].sort(),
    );
    expect(names).toContain('media/');
    expect(result.entries).toContain('ai-catalog.json');

    const manifest = await readJson<{
      format: string;
      version: number;
      app: string;
      containsKey: boolean;
      counts: { records: number; media: number };
    }>(zip, 'manifest.json');
    expect(manifest.format).toBe(BACKUP_FORMAT);
    expect(manifest.version).toBe(BACKUP_VERSION);
    expect(manifest.app).toBe('灵感工坊');
    expect(manifest.containsKey).toBe(false);
    expect(manifest.counts).toEqual({ records: 1, media: 1 });

    // 音频字节一致
    const mediaBytes = await zip.file(`media/${recordId}.webm`)!.async('uint8array');
    expect(bytesEqual(mediaBytes, AUDIO_BYTES)).toBe(true);
  });

  it('「仅记录」导出只有 manifest / records / media（设置页的高级入口）', async () => {
    const { recordId } = await seedLibrary();
    const result = await exportBackupZip(new Date(2026, 9, 18), {
      include: { records: true, aiCatalog: false, settings: false, priceTable: false },
    });
    const names = Object.keys((await openZip(result.blob)).files);
    expect(names.filter((name) => name.endsWith('.json')).sort()).toEqual(
      ['manifest.json', 'records.json'].sort(),
    );
    expect(names).toContain(`media/${recordId}.webm`);
    expect(names).not.toContain('settings.json');
  });
});

describe('判据 7：containsKey=false 时 ai-catalog.json 不含任何 key', () => {
  it('默认导出：ai-catalog.json / settings.json 里都找不到 key 字符串', async () => {
    await seedLibrary();
    const result = await exportBackupZip();

    const zip = await openZip(result.blob);
    const catalogText = await zip.file('ai-catalog.json')!.async('string');
    const settingsText = await zip.file('settings.json')!.async('string');
    const recordsText = await zip.file('records.json')!.async('string');

    expect(catalogText).not.toContain(SECRET_KEY);
    expect(settingsText).not.toContain(SECRET_KEY);
    expect(recordsText).not.toContain(SECRET_KEY);

    const catalogFile = JSON.parse(catalogText) as {
      containsKey: boolean;
      catalog: { providers: Array<{ connections: Array<{ apiKey: string }> }> };
    };
    expect(catalogFile.containsKey).toBe(false);
    const keys = catalogFile.catalog.providers.flatMap((provider) =>
      provider.connections.map((connection) => connection.apiKey),
    );
    expect(keys.every((apiKey) => apiKey === '')).toBe(true);

    // settings.json 不重复装 AI 配置与价格表（各自有专门文件）
    const settingsFile = JSON.parse(settingsText) as {
      settings: Array<{ key: string }>;
    };
    const settingKeys = settingsFile.settings.map((item) => item.key);
    expect(settingKeys).toContain(CANVAS_MODE_KEY);
    expect(settingKeys).toContain(CANVAS_POSITIONS_KEY);
    expect(settingKeys).toContain('voice');
    expect(settingKeys).not.toContain('ai-catalog');
    expect(settingKeys).not.toContain('ai-price-table');
  });

  it('勾选「包含 API Key」后 ai-catalog.json 才带上 key，manifest.containsKey=true', async () => {
    await seedLibrary();
    const result = await exportBackupZip(new Date(2026, 9, 18), { includeKey: true });
    const zip = await openZip(result.blob);
    const catalogText = await zip.file('ai-catalog.json')!.async('string');

    expect(catalogText).toContain(SECRET_KEY);
    expect(result.manifest.containsKey).toBe(true);
  });
});

describe('判据 8：清库 → 导入完整备份 → 记录 / AI 配置 / 设置 / 模式全部复原', () => {
  it('记录、音频、AI 连接与 key、语音方式、画布模式与位置、价格表都回来', async () => {
    const { recordId, connectionId } = await seedLibrary();
    // 「全部复原」含 key：完整备份要连配置一起回得来（默认不含 key，得显式勾）
    const exported = await exportBackupZip(new Date(2026, 9, 18), { includeKey: true });
    expect(exported.manifest.containsKey).toBe(true);

    await destroyDatabase();
    expect((await listRecords()).total).toBe(0);
    expect(await getSetting(CANVAS_MODE_KEY)).toBeUndefined();
    expect(await getSetting(AI_PRICE_TABLE_KEY)).toBeUndefined();

    const result = await importBackupZip(exported.blob, { mode: 'merge' });
    expect(result.imported).toBe(1);
    expect(result.media).toBe(1);
    expect(result.missingMedia).toBe(0);
    expect(result.aiCatalog).toBe(true);
    expect(result.priceTable).toBe(true);
    expect(result.settings).toBeGreaterThan(0);

    // 记录 + 音频
    const entity = await getRecordEntity(recordId);
    expect(entity?.text).toBe('广告分镜：雨夜霓虹');
    expect(entity?.tags).toEqual(['广告', '分镜']);
    expect(bytesEqual(await readBlobBytes(entity!.audio!.blob), AUDIO_BYTES)).toBe(true);

    // AI 配置（包含 key：这是完整备份，containsKey 与包内容一致）
    const restoredCatalog = await loadCatalog();
    const provider = restoredCatalog.providers.find((item) => item.id === 'zhipu');
    const connection = provider?.connections.find((item) => item.id === connectionId);
    expect(connection?.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(connection?.apiKey).toBe(SECRET_KEY);

    // 设置与画布模式 / 位置
    expect((await getVoiceSettings())?.mode).toBe('local-whisper');
    expect(await loadCanvasMode()).toBe('waterfall');
    expect(await loadCanvasPositions()).toEqual({ [recordId]: { x: 120, y: 64 } });
    // 价格表
    const restoredPrice = await loadPriceTable();
    expect(restoredPrice.source).toBe('M5a 测试价格表');
  });

  it('包内不含 key 时导入 merge：本机同 id 连接的 key 不被清空', async () => {
    const { connectionId } = await seedLibrary();
    const exported = await exportBackupZip(new Date(2026, 9, 18), { includeKey: false });

    await importBackupZip(exported.blob, { mode: 'merge' });

    const restored = await loadCatalog();
    const connection = restored.providers
      .find((item) => item.id === 'zhipu')
      ?.connections.find((item) => item.id === connectionId);
    expect(connection?.apiKey).toBe(SECRET_KEY);
  });

  it('覆盖模式：设置也按包内重建（不会留下半套数据）', async () => {
    const { recordId } = await seedLibrary();
    const exported = await exportBackupZip(new Date(2026, 9, 18));

    // 导出后改动本机：换成卡片墙、删掉画布位置
    await saveCanvasMode('wall');
    await saveCanvasPositions({});
    await saveVoiceSettings({ mode: 'record-only' });

    await importBackupZip(exported.blob, { mode: 'replace' });

    expect((await listRecords()).total).toBe(1);
    expect(await loadCanvasMode()).toBe('waterfall');
    expect(await loadCanvasPositions()).toEqual({ [recordId]: { x: 120, y: 64 } });
    expect((await getVoiceSettings())?.mode).toBe('local-whisper');
  });
});

describe('判据 9：版本不匹配 → 可读错误，且不写入', () => {
  async function buildZip(files: Record<string, string>): Promise<Blob> {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) zip.file(name, content);
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });
    return new Blob([buffer], { type: 'application/zip' });
  }

  it('备份版本比应用新：抛 INVALID_PAYLOAD + 人话提示，库里什么都没变', async () => {
    const record = await createRecord({ text: '导入前后都在' });
    await saveCanvasMode('waterfall');

    const futureZip = await buildZip({
      'manifest.json': JSON.stringify({
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION + 1,
        exportedAt: new Date().toISOString(),
        app: '灵感工坊',
        containsKey: false,
        counts: { records: 1, media: 0 },
      }),
      'records.json': JSON.stringify({
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION + 1,
        records: [{ id: 'from-future', text: '未来版本的记录', tags: [], createdAt: 1, updatedAt: 1 }],
      }),
      'settings.json': JSON.stringify({
        format: 'ia-v2-settings',
        version: 1,
        settings: [{ key: CANVAS_MODE_KEY, value: 'wall' }],
      }),
    });

    await expect(importBackupZip(futureZip, { mode: 'replace' })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });

    // 错误文案要能照着做：说明版本与"没有写入"
    let message = '';
    try {
      await importBackupZip(futureZip, { mode: 'replace' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`v${BACKUP_VERSION + 1}`);
    expect(message).toContain('升级');
    expect(message).toContain('没有写入');

    // 库没被碰过
    expect((await listRecords()).total).toBe(1);
    expect((await listRecords()).items[0].id).toBe(record.id);
    expect(await getRecordEntity('from-future')).toBeUndefined();
    expect(await loadCanvasMode()).toBe('waterfall');
  });

  it('format 不对（不是本应用的包）同样是可读错误', async () => {
    const zip = await buildZip({
      'manifest.json': JSON.stringify({ format: 'some-other-tool', version: 1 }),
      'records.json': JSON.stringify({ records: [] }),
    });
    await expect(importBackupZip(zip)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });
});
