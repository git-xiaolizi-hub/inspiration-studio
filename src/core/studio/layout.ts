/**
 * 写作工作台的栏宽 / 折叠状态（P4）。
 *
 * 委托人的原话：「展示区、写作区，也包括素材区与 AI 区应该要能支持大小调整甚至隐藏」。
 * 这里只负责**状态本身**：怎么洗、怎么存、怎么夹在最小宽度之间。拖拽的坐标换算在页面里做
 * （它要读真实 DOM 的 clientWidth，放进纯模块只会让测试更难写）。
 *
 * 存哪儿：`settings` 表的一个 key `studio-layout`（`{ key, value, updatedAt }`）。
 * **不建新表**：理由同 `draft` / `library` —— 建表要升 Dexie 版本、触发全库迁移，
 * 而这里就是五个标量。settings 本来就在备份 zip 内，换设备也跟着走。
 *
 * 形状（任务书 §2.1 / P4c §4.2 逐字一致）：
 *
 * ```ts
 * { leftWidth: number, rightWidth: number, displayHeight: number,
 *   displayCollapsed: boolean, leftCollapsed: boolean, rightCollapsed: boolean }
 * ```
 *
 * 三条边界：
 * 1. **最小宽度**：左 180 / 中 420 / 右 260（任务书 §2.1）。夹在 `resizeLeft/Right` 里，
 *    到限制就停住，不"反弹"、不跳格；
 * 2. **折叠 ≠ 消失**：折叠只把宽度压到 36px，内容仍挂在 DOM 里（见页面里的 `hidden`），
 *    否则搜索词、滚动位置、AI 对话会随一次折叠全部丢掉；
 * 3. **脏数据一律回默认**，且读到脏数据**不写回** —— 与 `draft` 同一策略：只是打开页面，
 *    不该把用户上次调好的宽度冲掉。
 *
 * P4c 新增 `displayHeight`：展示区与写作区之间那条**横向**分隔条拖出来的高度。
 * 它和栏宽一样是「标量 + 夹取」，所以放在同一个 settings key 里，不新建表也不改 Dexie schema。
 */
import { getSetting, putSetting } from '../storage';

export const STUDIO_LAYOUT_KEY = 'studio-layout';

/** 左栏最小宽度（素材列表：再窄就看不到勾选框 + 两行文字） */
export const MIN_LEFT_WIDTH = 180;
/** 中栏最小宽度（展示区 + 正文：再窄正文就没法写了） */
export const MIN_CENTER_WIDTH = 420;
/** 右栏最小宽度（AI 对话：气泡 + 三个落笔按钮要能一行放下） */
export const MIN_RIGHT_WIDTH = 260;

/** 折叠后的窄条宽度（任务书 §2.2：36px） */
export const COLLAPSED_WIDTH = 36;
/** 分隔条宽度（任务书 §2.1：7px）。两侧各一条，算最小中栏时要扣掉 */
export const SPLITTER_WIDTH = 7;

/** 横向分隔条厚度（P4c §4.2：7px，与竖向一致） */
export const H_SPLITTER_HEIGHT = 7;
/** 展示区默认高度（P4c §4.2：320） */
export const DEFAULT_DISPLAY_HEIGHT = 320;
/** 展示区最小高度：再矮就看不到一张卡的正文 */
export const MIN_DISPLAY_HEIGHT = 120;
/** 正文最小高度：再矮就写不了字 */
export const MIN_EDITOR_HEIGHT = 200;
/** 展示区上限（防手改库填 99999；真实交互上限由中栏高度算出来） */
const MAX_DISPLAY_HEIGHT = 2000;

/** 默认栏宽：与样张一致（左 252 / 右 336 取整到现有 P3 的值附近，避免首见跳变） */
export const DEFAULT_LEFT_WIDTH = 246;
export const DEFAULT_RIGHT_WIDTH = 330;

/** 上限只是防手改库填个 99999，不是交互限制 */
const MAX_PANE_WIDTH = 900;

export interface StudioLayout {
  leftWidth: number;
  rightWidth: number;
  /** 展示区（素材卡那一片）的高度：横向分隔条拖出来的值（P4c） */
  displayHeight: number;
  /** 展示区（素材卡那一片）收成一条 */
  displayCollapsed: boolean;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export const DEFAULT_STUDIO_LAYOUT: StudioLayout = {
  leftWidth: DEFAULT_LEFT_WIDTH,
  rightWidth: DEFAULT_RIGHT_WIDTH,
  displayHeight: DEFAULT_DISPLAY_HEIGHT,
  displayCollapsed: false,
  leftCollapsed: false,
  rightCollapsed: false,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/** 把任意来源的值洗成 `StudioLayout`。永不抛异常：脏数据不该让工作台白屏 */
export function normalizeLayout(raw: unknown): StudioLayout {
  if (!isPlainObject(raw)) return { ...DEFAULT_STUDIO_LAYOUT };
  return {
    leftWidth: clampNumber(raw.leftWidth, DEFAULT_LEFT_WIDTH, MIN_LEFT_WIDTH, MAX_PANE_WIDTH),
    rightWidth: clampNumber(raw.rightWidth, DEFAULT_RIGHT_WIDTH, MIN_RIGHT_WIDTH, MAX_PANE_WIDTH),
    displayHeight: clampNumber(
      raw.displayHeight,
      DEFAULT_DISPLAY_HEIGHT,
      MIN_DISPLAY_HEIGHT,
      MAX_DISPLAY_HEIGHT,
    ),
    // 只认字面 true：字符串 'true' / 1 都不算（旧数据可能来自别的写成）
    displayCollapsed: raw.displayCollapsed === true,
    leftCollapsed: raw.leftCollapsed === true,
    rightCollapsed: raw.rightCollapsed === true,
  };
}

/** 读布局；无数据 / 脏数据都回默认（不写回） */
export async function loadLayout(): Promise<StudioLayout> {
  const row = await getSetting(STUDIO_LAYOUT_KEY);
  if (!row) return { ...DEFAULT_STUDIO_LAYOUT };
  return normalizeLayout(row.value);
}

/** 写布局（返回清洗后的值，调用方据此更新内存） */
export async function saveLayout(
  layout: StudioLayout,
  now = Date.now(),
): Promise<StudioLayout> {
  const value = normalizeLayout(layout);
  await putSetting({ key: STUDIO_LAYOUT_KEY, value, updatedAt: now });
  return value;
}

/** 一栏当前实际占多少（折叠时就是 36px） */
export function paneWidth(layout: StudioLayout, side: 'left' | 'right'): number {
  if (side === 'left') return layout.leftCollapsed ? COLLAPSED_WIDTH : layout.leftWidth;
  return layout.rightCollapsed ? COLLAPSED_WIDTH : layout.rightWidth;
}

/** 左栏最多能拉到多宽：要给两条分隔条、右栏、和一个 420 的中栏留位置 */
export function maxLeftWidth(total: number, layout: StudioLayout): number {
  const right = paneWidth(layout, 'right');
  return total - SPLITTER_WIDTH * 2 - right - MIN_CENTER_WIDTH;
}

/** 右栏最多能拉到多宽：同上，扣掉左栏 */
export function maxRightWidth(total: number, layout: StudioLayout): number {
  const left = paneWidth(layout, 'left');
  return total - SPLITTER_WIDTH * 2 - left - MIN_CENTER_WIDTH;
}

/**
 * 拖左分隔条：`requested` 是「从起点算出来的左栏宽度」，夹到 [180, 剩余空间 - 420]。
 * `total` 拿不到（jsdom 里 clientWidth = 0）时**原样返回**，不猜。
 */
export function resizeLeft(
  layout: StudioLayout,
  requested: number,
  total: number,
): StudioLayout {
  if (!Number.isFinite(total) || total <= 0) return layout;
  const ceiling = Math.max(MIN_LEFT_WIDTH, maxLeftWidth(total, layout));
  const leftWidth = clampNumber(requested, layout.leftWidth, MIN_LEFT_WIDTH, ceiling);
  return leftWidth === layout.leftWidth ? layout : { ...layout, leftWidth };
}

/** 拖右分隔条：方向相反（往左拖 = 右栏变宽） */
export function resizeRight(
  layout: StudioLayout,
  requested: number,
  total: number,
): StudioLayout {
  if (!Number.isFinite(total) || total <= 0) return layout;
  const ceiling = Math.max(MIN_RIGHT_WIDTH, maxRightWidth(total, layout));
  const rightWidth = clampNumber(requested, layout.rightWidth, MIN_RIGHT_WIDTH, ceiling);
  return rightWidth === layout.rightWidth ? layout : { ...layout, rightWidth };
}

/**
 * 中栏高度里，展示区最多能占多少：要给 7px 横向分隔条和一个 200 的正文留位置。
 * `centerHeight` 拿不到（jsdom 里 clientHeight = 0）时返回 `MIN_DISPLAY_HEIGHT`，不猜。
 */
export function maxDisplayHeight(centerHeight: number): number {
  if (!Number.isFinite(centerHeight) || centerHeight <= 0) return MIN_DISPLAY_HEIGHT;
  return Math.max(
    MIN_DISPLAY_HEIGHT,
    centerHeight - H_SPLITTER_HEIGHT - MIN_EDITOR_HEIGHT,
  );
}

/**
 * 拖横向分隔条：`requested` 是「从起点算出来的展示区高度」，夹到 [120, 中栏高 - 7 - 200]。
 * 到限制就停住（不反弹、不跳格）。
 */
export function resizeDisplayHeight(
  layout: StudioLayout,
  requested: number,
  centerHeight: number,
): StudioLayout {
  if (!Number.isFinite(centerHeight) || centerHeight <= 0) return layout;
  const displayHeight = clampNumber(
    requested,
    layout.displayHeight,
    MIN_DISPLAY_HEIGHT,
    maxDisplayHeight(centerHeight),
  );
  return displayHeight === layout.displayHeight ? layout : { ...layout, displayHeight };
}

/**
 * 窗口变矮之后的兜底：**只夹渲染值，不写回存储**（同 `clampLayout` 的取舍 ——
 * 在小窗口打开一次工作台，不该把用户拖出来的高度永久压扁）。
 */
export function fitDisplayHeight(height: number, centerHeight: number): number {
  if (!Number.isFinite(centerHeight) || centerHeight <= 0) return height;
  return Math.min(height, maxDisplayHeight(centerHeight));
}

/**
 * 窗口变小之后的兜底：把两栏一起夹回最小值之上，保证中栏仍有 420。
 * 先夹左再夹右 —— 顺序固定，否则同一个窗口宽度能压出两种结果。
 */
export function clampLayout(layout: StudioLayout, total: number): StudioLayout {
  if (!Number.isFinite(total) || total <= 0) return layout;
  const leftWidth = Math.min(
    layout.leftWidth,
    Math.max(MIN_LEFT_WIDTH, maxLeftWidth(total, layout)),
  );
  const withLeft: StudioLayout = leftWidth === layout.leftWidth ? layout : { ...layout, leftWidth };
  const rightWidth = Math.min(
    withLeft.rightWidth,
    Math.max(MIN_RIGHT_WIDTH, maxRightWidth(total, withLeft)),
  );
  if (leftWidth === layout.leftWidth && rightWidth === layout.rightWidth) return layout;
  return { ...withLeft, rightWidth };
}

/** 三块是不是都收起来了（顶栏按钮据此换成「展开全部」） */
export function isAllCollapsed(layout: StudioLayout): boolean {
  return layout.leftCollapsed && layout.rightCollapsed && layout.displayCollapsed;
}

/** 一键回到「只有正文」 */
export function collapseAll(layout: StudioLayout): StudioLayout {
  return { ...layout, leftCollapsed: true, rightCollapsed: true, displayCollapsed: true };
}

/** 一键展开三块 */
export function expandAll(layout: StudioLayout): StudioLayout {
  return { ...layout, leftCollapsed: false, rightCollapsed: false, displayCollapsed: false };
}
