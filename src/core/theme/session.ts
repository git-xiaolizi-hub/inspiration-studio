/**
 * 主题的「状态与持久化」（M7 §2.3，P1.5 改为具名主题）。
 *
 * 三层，各管一件事，别混：
 *   1. `index.ts`      —— 纯逻辑（主题表 / 矩阵推导 / 应用属性），无副作用、无 IO；
 *   2. 本文件          —— 状态与持久化：settings 表（IndexedDB）+ localStorage 镜像；
 *   3. `index.html` 的内联脚本 —— 首屏防闪，只读 localStorage 设属性，不 import 任何模块。
 *
 * 为什么同时要 IndexedDB 和 localStorage：
 *   - IndexedDB 是**唯一真相**（进备份 zip，换设备能带走）；
 *   - 但它是异步的，首屏渲染前读不到 → localStorage 存同一份的镜像，供内联脚本同步读。
 *   两边都可能被手改，所以两处都要**校验**，脏值一律回落到默认（不崩）。
 *
 * P1.5 的变化（委托人：「跟随系统似乎没有必要了，不如直接展示主题名称」）：
 *   - 落库只存 `{ theme }`，不再存 scheme / mood；
 *   - **旧数据不丢**：M7 时代存的是 { theme, scheme, mood }，读出来时按
 *     "偏好是权威、theme 是派生值" 的老约定用 `resolveTheme()` 折算成一套主题；
 *   - 「跟随系统」不再是可选项 → `watchSystemScheme` 整块删除（没有 system 偏好可跟）。
 */
import { getSetting, putSetting } from '../storage';
import {
  DEFAULT_THEME,
  MOOD_STORAGE_KEY,
  SCHEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  applyTheme,
  isThemeName,
  resolveTheme,
} from './index';
import type { MoodName, SchemePreference, ThemeName } from './index';

/** settings 表里的键名。**只在 settings 里新增这一条，不改任何已有字段。** */
export const THEME_SETTING_KEY = 'theme';

export interface ThemeSetting {
  /** 当前生效的主题（用户在四个名字里挑的那个） */
  theme: ThemeName;
  updatedAt: number;
}

/** M7 时代落库的旧形状。**只读不写**，用于迁移。 */
interface LegacyThemeSetting {
  theme?: unknown;
  scheme?: unknown;
  mood?: unknown;
  updatedAt?: unknown;
}

export function isSchemePreference(value: unknown): value is SchemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function isMoodName(value: unknown): value is MoodName {
  return value === 'calm' || value === 'dream';
}

/**
 * 系统是否偏深色。**迁移旧数据时才需要**（旧偏好里有 'system'）。
 * jsdom 没有 matchMedia、老环境也可能没有 → 一律兜底成「浅色」。
 */
export function systemPrefersDark(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** 从未设置过时的默认：柔和奶油（clay）。**不跟随系统**，也不写库。 */
export function defaultThemeSetting(): ThemeSetting {
  return { theme: DEFAULT_THEME, updatedAt: 0 };
}

/**
 * 把存储里读到的任意值归一成合法设置。
 *
 * 三条路，按优先级：
 *   1. 旧数据（scheme + mood 都在）→ `resolveTheme()` 折算。
 *      为什么此时不用行里的 `theme`：M7 的约定是「偏好权威、theme 派生」，
 *      旧行里的 theme 只是写入那一刻的推导结果；系统深浅变过之后它可能已经过期
 *      （scheme==='system' 时尤其明显）。
 *   2. 只有 theme（P1.5 之后写入的形状）→ 直接用。
 *   3. 只有一个旧偏好 → 用默认值补齐另一半再折算。
 * 一个合法字段都没有 = 脏数据 → null，交回调用方回落到默认。
 */
export function normalizeThemeSetting(value: unknown): ThemeSetting | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as LegacyThemeSetting;
  const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0;

  const scheme = isSchemePreference(raw.scheme) ? raw.scheme : null;
  const mood = isMoodName(raw.mood) ? raw.mood : null;

  if (scheme && mood) {
    return { theme: resolveTheme(scheme, mood, systemPrefersDark()), updatedAt };
  }
  if (isThemeName(raw.theme)) return { theme: raw.theme, updatedAt };
  if (scheme || mood) {
    return {
      theme: resolveTheme(scheme ?? 'light', mood ?? 'calm', systemPrefersDark()),
      updatedAt,
    };
  }
  return null;
}

function mirror(setting: ThemeSetting): void {
  try {
    // localStorage 在隐私模式 / 禁用 storage 时会抛，主题不该因此失败
    window.localStorage.setItem(THEME_STORAGE_KEY, setting.theme);
    // ia-scheme / ia-mood 是 M7 的镜像键，P1.5 不再写。留着旧的会让「哪个是真相」变模糊。
    window.localStorage.removeItem(SCHEME_STORAGE_KEY);
    window.localStorage.removeItem(MOOD_STORAGE_KEY);
  } catch {
    /* 只影响首屏防闪，不影响当前会话 */
  }
}

/** 从 localStorage 镜像里读（内联脚本写的那一份），用于 IDB 还没读到 / 读不到时 */
export function readMirroredSetting(): ThemeSetting | null {
  try {
    const theme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeName(theme)) return { theme, updatedAt: 0 };
    // 升级路径：只有 M7 的旧镜像键（没有 ia-theme）时按偏好折算
    const legacy: LegacyThemeSetting = {
      scheme: window.localStorage.getItem(SCHEME_STORAGE_KEY),
      mood: window.localStorage.getItem(MOOD_STORAGE_KEY),
      updatedAt: 0,
    };
    return normalizeThemeSetting(legacy);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 订阅：DOM 之外的东西（设置页的选中态）要跟着变                        */
/* ------------------------------------------------------------------ */

type ThemeListener = (setting: ThemeSetting) => void;
const listeners = new Set<ThemeListener>();
/** 最近一次应用的设置（备份导入 / 外部广播时可以对照） */
let currentSetting: ThemeSetting | null = null;

export function subscribeTheme(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(setting: ThemeSetting): void {
  for (const listener of listeners) listener(setting);
}

/** 应用到一个设置上：改 `<html>` 属性 + 写 localStorage 镜像 + 通知订阅者 */
export function applyThemeSetting(setting: ThemeSetting): ThemeSetting {
  currentSetting = setting;
  applyTheme(setting.theme);
  mirror(setting);
  emit(setting);
  return setting;
}

/** 最近一次生效的主题（没有则 null） */
export function currentThemeSetting(): ThemeSetting | null {
  return currentSetting;
}

/* ------------------------------------------------------------------ */
/* 持久化                                                              */
/* ------------------------------------------------------------------ */

/** 读 settings 表里的主题设置；null = 从未设置过（或读出来是脏数据） */
export async function loadThemeSetting(): Promise<ThemeSetting | null> {
  const row = await getSetting(THEME_SETTING_KEY);
  return normalizeThemeSetting(row?.value);
}

/** 保存一套主题（P1.5：只存主题名，不再存 scheme / mood） */
export async function saveThemeSetting(theme: ThemeName): Promise<ThemeSetting> {
  const setting: ThemeSetting = { theme, updatedAt: Date.now() };
  await putSetting({
    key: THEME_SETTING_KEY,
    value: setting,
    updatedAt: setting.updatedAt,
  });
  return applyThemeSetting(setting);
}

/**
 * 启动时调用（main.tsx 一次）。
 *
 * 顺序有意如此：**先应用、后落库**。用户没设置过时不应该因为「打开了一次应用」
 * 就凭空多出一条设置记录 —— 那样备份里会出现一条用户没做过的选择。
 */
export async function initTheme(): Promise<ThemeSetting> {
  let stored: ThemeSetting | null = null;
  try {
    stored = await loadThemeSetting();
  } catch {
    // IndexedDB 打不开（隐私模式 / 配额异常）也要能用：回落到镜像值
    stored = null;
  }

  const setting = stored ?? readMirroredSetting() ?? defaultThemeSetting();
  applyThemeSetting(setting);
  return setting;
}

/** 备份导入后调用：重读 settings 并立刻生效（不能等刷新） */
export async function reloadThemeFromStorage(): Promise<ThemeSetting> {
  const setting = (await loadThemeSetting()) ?? defaultThemeSetting();
  return applyThemeSetting(setting);
}
