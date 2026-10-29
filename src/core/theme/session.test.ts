/**
 * 主题的持久化与状态（M7 §2.3 → P1.5 具名主题）。
 *
 * 这里只测**本文件新增的逻辑**：settings 读写、localStorage 镜像、脏值回落、订阅广播、
 * 以及 P1.5 的关键一条：**旧 {scheme, mood} 数据要能折算成主题，不报错、不清空**。
 * 矩阵推导 / DOM 属性那部分在 ./index.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { closeDatabase, destroyDatabase, getSetting, putSetting } from '../storage';
import { exportBackupZip, importBackupZip } from '../backup';
import { readBlobBytes } from '../../test/blob-helpers';
import { MOOD_STORAGE_KEY, SCHEME_STORAGE_KEY, THEME_STORAGE_KEY } from './index';
import {
  THEME_SETTING_KEY,
  applyThemeSetting,
  defaultThemeSetting,
  isMoodName,
  isSchemePreference,
  loadThemeSetting,
  normalizeThemeSetting,
  readMirroredSetting,
  reloadThemeFromStorage,
  saveThemeSetting,
  subscribeTheme,
  systemPrefersDark,
} from './session';

/** 把系统深浅"装"成指定值（迁移 'system' 偏好时需要） */
function stubSystemDark(dark: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: dark,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

beforeEach(async () => {
  await destroyDatabase();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-scheme');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await closeDatabase();
});

describe('类型守卫（迁移旧数据时要用）', () => {
  it('认 scheme 三个值', () => {
    for (const v of ['light', 'dark', 'system']) expect(isSchemePreference(v)).toBe(true);
    for (const v of ['', 'Light', null, 0, {}]) expect(isSchemePreference(v)).toBe(false);
  });

  it('认 mood 两个值', () => {
    for (const v of ['calm', 'dream']) expect(isMoodName(v)).toBe(true);
    for (const v of ['Calm', '', undefined, 1]) expect(isMoodName(v)).toBe(false);
  });
});

describe('systemPrefersDark', () => {
  it('jsdom 没有 matchMedia 时兜底成浅色（不抛）', () => {
    expect(typeof window.matchMedia).not.toBe('function');
    expect(systemPrefersDark()).toBe(false);
  });

  it('有 matchMedia 时读得到（迁移用）', () => {
    stubSystemDark(true);
    expect(systemPrefersDark()).toBe(true);
  });
});

describe('默认值', () => {
  it('从未设置过 → 柔和奶油（clay），不再跟随系统', () => {
    const setting = defaultThemeSetting();
    expect(setting.theme).toBe('clay');
    expect(setting.updatedAt).toBe(0);
    // 旧形状的字段不该再出现（落库/备份里不该有 scheme / mood）
    expect(setting).not.toHaveProperty('scheme');
    expect(setting).not.toHaveProperty('mood');
  });

  it('系统是深色也照样默认 clay（P1.5 删掉了「跟随系统」）', () => {
    stubSystemDark(true);
    expect(defaultThemeSetting().theme).toBe('clay');
  });
});

describe('normalizeThemeSetting：存储里的脏值', () => {
  it('完全不是对象 → null', () => {
    for (const bad of [null, undefined, 'clay', 3, []]) expect(normalizeThemeSetting(bad)).toBeNull();
  });

  it('一个合法字段都没有 → null', () => {
    expect(normalizeThemeSetting({ theme: 'garbage', scheme: '??', mood: 9 })).toBeNull();
  });

  it('只存了 theme（P1.5 的形状）→ 直接用，不改写', () => {
    expect(normalizeThemeSetting({ theme: 'neon', updatedAt: 5 })).toEqual({
      theme: 'neon',
      updatedAt: 5,
    });
  });

  it('theme 存了脏值、也没有旧偏好 → null（不能崩，要给默认值）', () => {
    expect(normalizeThemeSetting({ theme: 'zzz' })).toBeNull();
    expect(normalizeThemeSetting({ theme: 'zzz', scheme: 'nope', mood: 'nope' })).toBeNull();
  });
});

describe('P1.5 迁移：旧 {scheme, mood} 数据折算成主题', () => {
  it('light + calm → clay', () => {
    expect(normalizeThemeSetting({ scheme: 'light', mood: 'calm' })?.theme).toBe('clay');
  });

  it('light + dream → violet', () => {
    expect(normalizeThemeSetting({ scheme: 'light', mood: 'dream' })?.theme).toBe('violet');
  });

  it('dark + calm → amber，dark + dream → neon', () => {
    expect(normalizeThemeSetting({ scheme: 'dark', mood: 'calm' })?.theme).toBe('amber');
    expect(normalizeThemeSetting({ scheme: 'dark', mood: 'dream' })?.theme).toBe('neon');
  });

  it('system 偏好按系统深浅折算（系统浅 = clay，系统深 = amber）', () => {
    expect(normalizeThemeSetting({ scheme: 'system', mood: 'calm' })?.theme).toBe('clay');
    stubSystemDark(true);
    expect(normalizeThemeSetting({ scheme: 'system', mood: 'calm' })?.theme).toBe('amber');
  });

  it('旧行里 theme 过期时按偏好重算（M7 约定：偏好权威、theme 派生）', () => {
    const setting = normalizeThemeSetting({
      theme: 'clay',
      scheme: 'dark',
      mood: 'dream',
      updatedAt: 7,
    });
    expect(setting).toEqual({ theme: 'neon', updatedAt: 7 });
  });

  it('只有一个旧偏好时用默认值补齐另一半', () => {
    expect(normalizeThemeSetting({ mood: 'dream' })?.theme).toBe('violet'); // 浅色默认
    expect(normalizeThemeSetting({ scheme: 'dark' })?.theme).toBe('amber'); // 克制默认
  });

  it('迁移不丢：四种旧组合都能读出四套不同的主题', () => {
    const combos = [
      ['light', 'calm'],
      ['light', 'dream'],
      ['dark', 'calm'],
      ['dark', 'dream'],
    ] as const;
    const themes = combos.map(([scheme, mood]) => normalizeThemeSetting({ scheme, mood })?.theme);
    expect(new Set(themes).size).toBe(4);
  });
});

describe('localStorage 镜像', () => {
  it('没有镜像 → null', () => {
    expect(readMirroredSetting()).toBeNull();
  });

  it('镜像被手改成脏值 → null（不崩）', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'clay-not-a-theme');
    expect(readMirroredSetting()).toBeNull();
  });

  it('applyThemeSetting 只写 ia-theme，并清掉 M7 的旧镜像键', () => {
    window.localStorage.setItem(SCHEME_STORAGE_KEY, 'system');
    window.localStorage.setItem(MOOD_STORAGE_KEY, 'calm');
    applyThemeSetting({ theme: 'amber', updatedAt: 1 });

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('amber');
    expect(window.localStorage.getItem(SCHEME_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(MOOD_STORAGE_KEY)).toBeNull();
    expect(readMirroredSetting()).toEqual({ theme: 'amber', updatedAt: 0 });
  });

  it('只有 M7 的旧镜像键（没有 ia-theme）时按偏好折算', () => {
    window.localStorage.setItem(SCHEME_STORAGE_KEY, 'dark');
    window.localStorage.setItem(MOOD_STORAGE_KEY, 'dream');
    expect(readMirroredSetting()?.theme).toBe('neon');
  });
});

describe('applyThemeSetting：DOM + 广播', () => {
  it('写 <html> 的 data-theme / data-scheme（深浅来自主题表，不来自偏好）', () => {
    applyThemeSetting({ theme: 'neon', updatedAt: 0 });
    expect(document.documentElement.getAttribute('data-theme')).toBe('neon');
    expect(document.documentElement.getAttribute('data-scheme')).toBe('dark');

    applyThemeSetting({ theme: 'clay', updatedAt: 0 });
    expect(document.documentElement.getAttribute('data-scheme')).toBe('light');
  });

  it('通知订阅者，退订后不再收到', () => {
    const seen: string[] = [];
    const off = subscribeTheme((setting) => seen.push(setting.theme));
    applyThemeSetting({ theme: 'clay', updatedAt: 0 });
    off();
    applyThemeSetting({ theme: 'amber', updatedAt: 0 });
    expect(seen).toEqual(['clay']);
  });
});

describe('saveThemeSetting / loadThemeSetting（settings 表）', () => {
  it('从未保存过 → null', async () => {
    await expect(loadThemeSetting()).resolves.toBeNull();
  });

  it('保存后：settings 表里只有 theme 一个主题字段，DOM 与镜像同步生效', async () => {
    const saved = await saveThemeSetting('neon');
    expect(saved.theme).toBe('neon');
    expect(saved.updatedAt).toBeGreaterThan(0);

    const row = await getSetting(THEME_SETTING_KEY);
    expect(row?.value).toMatchObject({ theme: 'neon' });
    expect(row?.value).not.toHaveProperty('scheme');
    expect(row?.value).not.toHaveProperty('mood');

    expect(document.documentElement.getAttribute('data-theme')).toBe('neon');
    expect(document.documentElement.getAttribute('data-scheme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('neon');
  });

  it('只新增 theme 这一条键，不碰别的设置', async () => {
    await putSetting({ key: 'voice', value: { mode: 'record-only' }, updatedAt: 1 });
    await saveThemeSetting('clay');
    const voice = await getSetting('voice');
    expect(voice?.value).toEqual({ mode: 'record-only' });
    expect(THEME_SETTING_KEY).toBe('theme');
  });

  it('四套主题都能存能读', async () => {
    for (const theme of ['clay', 'violet', 'neon', 'amber'] as const) {
      const saved = await saveThemeSetting(theme);
      expect(saved.theme).toBe(theme);
      await expect(loadThemeSetting()).resolves.toMatchObject({ theme });
    }
  });

  it('库里是 M7 的旧形状时，loadThemeSetting 直接折算（升级不清空）', async () => {
    await putSetting({
      key: THEME_SETTING_KEY,
      value: { theme: 'clay', scheme: 'dark', mood: 'dream', updatedAt: 3 },
      updatedAt: 3,
    });
    await expect(loadThemeSetting()).resolves.toMatchObject({ theme: 'neon' });
  });
});

describe('reloadThemeFromStorage：备份导入后立刻生效', () => {
  it('库里换成 amber 后，调用一次就把 DOM 改成 amber（模拟导入备份）', async () => {
    await saveThemeSetting('clay');
    expect(document.documentElement.getAttribute('data-theme')).toBe('clay');

    await putSetting({
      key: THEME_SETTING_KEY,
      value: { theme: 'amber', updatedAt: 2 },
      updatedAt: 2,
    });

    const applied = await reloadThemeFromStorage();
    expect(applied.theme).toBe('amber');
    expect(document.documentElement.getAttribute('data-theme')).toBe('amber');
    expect(document.documentElement.getAttribute('data-scheme')).toBe('dark');
  });

  it('库里没有 theme 时回落到默认（clay），不抛', async () => {
    await expect(reloadThemeFromStorage()).resolves.toMatchObject({ theme: 'clay' });
  });
});

describe('备份：主题随 zip 进出（任务书 §2.3 要求）', () => {
  it('导出的 settings.json 里只有 {theme}；导入后主题立刻应用到 DOM', async () => {
    await saveThemeSetting('neon');

    const exported = await exportBackupZip(new Date(), {});
    const zip = await JSZip.loadAsync(await readBlobBytes(exported.blob));
    const settingsFile = zip.file('settings.json');
    expect(settingsFile, 'zip 里应该有 settings.json').not.toBeNull();
    const parsed = JSON.parse(await settingsFile!.async('string')) as {
      settings: { key: string; value?: unknown }[];
    };
    const themeRow = parsed.settings.find((item) => item.key === 'theme');
    expect(themeRow?.value).toMatchObject({ theme: 'neon' });

    // 换一台「设备」：清库 → 导入 → 主题要立刻生效（不等刷新）
    await destroyDatabase();
    document.documentElement.removeAttribute('data-theme');
    window.localStorage.clear();

    await importBackupZip(exported.blob, { mode: 'replace' });
    await reloadThemeFromStorage();

    expect(document.documentElement.getAttribute('data-theme')).toBe('neon');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('neon');
  });
});
