/**
 * 判据 6：自定义副本必须进备份（用户手写的内容，丢了就是数据丢失）。
 *
 * 这里断言的是**包里的字节**：zip 条目名 + 格式常量 + 正文逐字相等，
 * 而不是"函数返回了 1" —— 后者在导出漏写文件时也会绿。
 */
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase } from '../storage';
import {
  createCustomPrompt,
  getCustomPromptForPack,
  listCustomPrompts,
  resetCustomPromptCache,
} from '../custom-prompts';
import { CUSTOM_PROMPTS_FILE_FORMAT, exportBackupZip, importBackupZip } from './index';
import { readBlobBytes } from '../../test/blob-helpers';

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

async function openZip(blob: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await readBlobBytes(blob));
}

describe('判据 6：备份带走自定义副本', () => {
  it('导出 zip 含 custom-prompts.json，导入后条数与正文都恢复', async () => {
    const created = await createCustomPrompt(
      { basePackId: 'dream-interpretation', name: '我的解梦版', body: CUSTOM_BODY },
      1_700_000_000_000,
    );

    const exported = await exportBackupZip(new Date(2026, 9, 19));
    const names = Object.keys((await openZip(exported.blob)).files);
    expect(names).toContain('custom-prompts.json');
    expect(exported.entries).toContain('custom-prompts.json');

    const zip = await openZip(exported.blob);
    const raw = JSON.parse(await zip.file('custom-prompts.json')!.async('string')) as {
      format: string;
      prompts: Array<Record<string, unknown>>;
    };
    expect(raw.format).toBe(CUSTOM_PROMPTS_FILE_FORMAT);
    expect(raw.prompts).toHaveLength(1);
    expect(raw.prompts[0].id).toBe(created.id);
    expect(raw.prompts[0].body).toBe(CUSTOM_BODY);

    // 换一台设备：库清空 → 导入 → 副本回来
    await destroyDatabase();
    resetCustomPromptCache();

    const result = await importBackupZip(exported.blob, { mode: 'replace' });
    expect(result.customPrompts).toBe(1);

    const restored = await getCustomPromptForPack('dream-interpretation');
    expect(restored?.name).toBe('我的解梦版');
    expect(restored?.body).toBe(CUSTOM_BODY);
    expect(restored?.createdAt).toBe(1_700_000_000_000);

    // 导入后内存快照也要跟着更新（否则画板还要等刷新才生效）
    expect((await listCustomPrompts()).length).toBe(1);
  });

  it('没有副本时不写空文件（既有备份条目清单不受影响）', async () => {
    const exported = await exportBackupZip(new Date(2026, 9, 19));
    const names = Object.keys((await openZip(exported.blob)).files);
    expect(names).not.toContain('custom-prompts.json');
  });

  it('只导出记录时不带走副本（高级入口的边界仍然成立）', async () => {
    await createCustomPrompt({
      basePackId: 'dream-interpretation',
      name: '我的解梦版',
      body: CUSTOM_BODY,
    });
    const exported = await exportBackupZip(new Date(2026, 9, 19), {
      include: { records: true, aiCatalog: false, settings: false, priceTable: false, customPrompts: false },
    });
    const names = Object.keys((await openZip(exported.blob)).files);
    expect(names).not.toContain('custom-prompts.json');
  });

  it('custom-prompts.json 里正文为空 → 整包拒绝，库不写入', async () => {
    const zip = new JSZip();
    zip.file(
      'manifest.json',
      JSON.stringify({
        format: 'ia-v2-backup',
        version: 2,
        exportedAt: new Date().toISOString(),
        app: 'Inspiration Assistant',
        containsKey: false,
        counts: { records: 0, media: 0 },
      }),
    );
    zip.file('records.json', JSON.stringify({ format: 'ia-v2-backup', version: 2, records: [] }));
    zip.file(
      'custom-prompts.json',
      JSON.stringify({
        format: CUSTOM_PROMPTS_FILE_FORMAT,
        version: 1,
        prompts: [{ id: 'cp_1', basePackId: 'dream-interpretation', name: '坏包', body: '' }],
      }),
    );
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });

    await expect(importBackupZip(new Blob([buffer]))).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    expect(await listCustomPrompts()).toHaveLength(0);
  });
});
