/**
 * 主题：4 套**具名**外观（P1.5）。
 *
 * 委托人原话：「主题中的『跟随系统』似乎没有必要了，影响美观，不如直接给用户展示主题名称」。
 * 所以用户层只剩一个维度：从四个名字里挑一套（radio，互斥的「当前值」）。
 *
 * 但 `scheme` / `mood` **没有删**，它们退到幕后，仍是每套主题的固有属性：
 *   1. `scheme` 用来算 `<html data-scheme>` —— `color-scheme` 靠它控制滚动条与
 *      表单原生控件（select / date picker / 右键菜单）的配色，删了深色主题会露白；
 *   2. `resolveTheme(scheme, mood, …)` 是**旧数据迁移**的唯一路径：
 *      M7 存的用户偏好是 {scheme, mood} 而不是主题名，读出来要靠矩阵折算。
 *
 * 也就是说：矩阵推导保留（纯逻辑、无副作用），但不再由用户操作。
 */

export type ThemeName = 'clay' | 'violet' | 'neon' | 'amber';
/** 旧的「深浅」偏好。**只用于迁移旧数据**，设置页不再提供。 */
export type SchemePreference = 'light' | 'dark' | 'system';
/** 旧的「气质」偏好。**只用于迁移旧数据**，设置页不再提供。 */
export type MoodName = 'calm' | 'dream';

export interface ThemeMeta {
  name: ThemeName;
  /** 给用户看的名字（委托人在 P1.5 指定的四个叫法，不要改回旧名） */
  label: string;
  /** 深浅：既用于算 data-scheme，也是旧数据迁移时矩阵的一半 */
  scheme: 'light' | 'dark';
  /** 气质：矩阵的另一半，只用于迁移 */
  mood: MoodName;
  /** 一句话描述（设置页显示在名字下面） */
  description: string;
  /** 主题在按钮/预览里显示的代表色（不跟随当前主题，用于识别） */
  swatch: string;
}

/** 顺序即设置页里的显示顺序：柔和奶油 → 罗兰梦境 → 霓虹深空 → 暖夜琥珀 */
/**
 * 顺序 = 界面上从左到右、从上到下的顺序。
 * 2026-10-28 委托人指定：奶油 → 琥珀 → 紫色 → 蓝色（前两个是主推）。
 */
export const THEMES: readonly ThemeMeta[] = [
  {
    name: 'clay',
    label: '柔和奶油',
    scheme: 'light',
    mood: 'calm',
    description: '暖白纸感、大圆角，像一本手写手账',
    swatch: '#eee9df',
  },
  {
    name: 'amber',
    label: '暖夜琥珀',
    scheme: 'dark',
    mood: 'calm',
    description: '深棕暖光，适合夜里不刺眼地记梦',
    swatch: '#fcd34d',
  },
  {
    name: 'violet',
    label: '罗兰梦境',
    scheme: 'light',
    mood: 'dream',
    description: '香芋紫与柔光，适合记录与想象',
    swatch: '#8b5cf6',
  },
  {
    name: 'neon',
    label: '霓虹深空',
    scheme: 'dark',
    mood: 'dream',
    description: '深空底与青色辉光，像专业影像工具',
    swatch: '#22d3ee',
  },
] as const;

/** 2×2 矩阵：深浅 × 气质 → 主题。**只给旧数据迁移用**，UI 不再暴露这两个维度。 */
export const THEME_MATRIX: Record<'light' | 'dark', Record<MoodName, ThemeName>> = {
  light: { calm: 'clay', dream: 'violet' },
  dark: { calm: 'amber', dream: 'neon' },
};

/** 首次打开（没有任何存储）用柔和奶油，不跟系统深浅走 */
export const DEFAULT_THEME: ThemeName = 'clay';

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && THEMES.some((t) => t.name === value);
}

export function themeMeta(name: ThemeName): ThemeMeta {
  const found = THEMES.find((t) => t.name === name);
  if (!found) throw new Error(`未知主题：${name}`);
  return found;
}

/**
 * 由「深浅偏好 + 气质」推出具体主题（旧数据迁移用）。
 * system 需要传入系统当前是否为深色。
 */
export function resolveTheme(
  scheme: SchemePreference,
  mood: MoodName,
  systemPrefersDark: boolean,
): ThemeName {
  const effective = scheme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : scheme;
  return THEME_MATRIX[effective][mood];
}

/** 主题对应的深浅（用于算 data-scheme / 校验） */
export function schemeOf(name: ThemeName): 'light' | 'dark' {
  return themeMeta(name).scheme;
}

export function moodOf(name: ThemeName): MoodName {
  return themeMeta(name).mood;
}

/**
 * 应用到 DOM。
 *
 * 为什么写 <html>（documentElement）而不是 body：
 *   1. 首屏渲染前就能生效（避免闪白）；
 *   2. `color-scheme` 只对根元素有效，它决定滚动条、表单控件的原生配色。
 *
 * `data-scheme` 来自**主题表本身**（`schemeOf`），不是来自用户偏好 ——
 * 用户已经不选深浅了，深浅是每套主题自带的属性。
 */
export function applyTheme(name: ThemeName, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', name);
  root.setAttribute('data-scheme', schemeOf(name));
}

/** 读取当前生效的主题 */
export function currentTheme(root: HTMLElement = document.documentElement): ThemeName {
  const value = root.getAttribute('data-theme');
  return isThemeName(value) ? value : DEFAULT_THEME;
}

/**
 * 首屏防闪：在 React 挂载前，从 localStorage 直接读并设置。
 * 这段会被 index.html 的内联脚本复用（不能依赖模块加载顺序）。
 *
 * ia-scheme / ia-mood 是 M7 时代的镜像键，保留只为读旧镜像；
 * 新代码只以 ia-theme 为准。
 */
export const THEME_STORAGE_KEY = 'ia-theme';
export const SCHEME_STORAGE_KEY = 'ia-scheme';
export const MOOD_STORAGE_KEY = 'ia-mood';
