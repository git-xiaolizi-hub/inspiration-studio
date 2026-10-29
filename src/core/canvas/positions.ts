/**
 * 卡片墙的「模式 + 位置」持久化（M5a）。
 *
 * 存哪里：沿用 settings 表，两个键
 * - `canvas-mode`      : 'wall' | 'waterfall'
 * - `canvas-positions` : { [recordId]: { x, y } }
 *
 * 坐标基准：**卡片墙容器（stage）左上角**，单位 px，指向卡片左上角。
 * 不用百分比 / 网格序号的理由：窗口宽度变化时百分比会让卡片整体漂移，
 * 而序号把「用户摆的位置」降级成「排序」。本应用是单用户桌面工具，
 * M5a 只保证「拖动过的卡片下次还在原地」。
 *
 * 位置的用途仅限卡片墙模式；瀑布流模式忽略它（但**不清库**，切回来还在）。
 */
import { getSetting, putSetting } from '../storage';

export const CANVAS_MODE_KEY = 'canvas-mode';
export const CANVAS_POSITIONS_KEY = 'canvas-positions';

export type CanvasMode = 'wall' | 'waterfall';

export const CANVAS_MODE_LABELS: Record<CanvasMode, string> = {
  wall: '卡片墙 ▣',
  waterfall: '瀑布流 ▤',
};

export interface CanvasPoint {
  x: number;
  y: number;
}

export type CanvasPositions = Record<string, CanvasPoint>;

/** 卡片尺寸与默认网格（默认位只用于「没拖动过」的卡片） */
export const CARD_WIDTH = 236;
export const CARD_HEIGHT = 172;
export const CARD_GAP = 16;
export const CARD_COLUMNS = 3;

/** 拖动阈值：小于它的位移算「点击」，避免手抖把卡片挪走 */
export const DRAG_THRESHOLD = 4;

/** 触摸屏需要长按才进入拖动（否则手指一按就拖，页面没法滚） */
export const TOUCH_LONG_PRESS_MS = 220;

export function isCanvasMode(value: unknown): value is CanvasMode {
  return value === 'wall' || value === 'waterfall';
}

/** 第 index 张卡片的默认位置（3 列固定网格；拖动过的卡片不看它） */
export function defaultCanvasPoint(index: number): CanvasPoint {
  const safeIndex = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  return {
    x: (safeIndex % CARD_COLUMNS) * (CARD_WIDTH + CARD_GAP),
    y: Math.floor(safeIndex / CARD_COLUMNS) * (CARD_HEIGHT + CARD_GAP),
  };
}

/** 卡片该画在哪：有记录过的位置就用它，否则落在默认网格 */
export function resolveCanvasPoint(
  positions: CanvasPositions,
  recordId: string,
  index: number,
): CanvasPoint {
  const saved = positions[recordId];
  return saved ?? defaultCanvasPoint(index);
}

/**
 * 拖动边界：不让卡片拖出 stage（stage 尺寸未知时——jsdom / 首帧——不夹取）。
 * 卡片整体必须留在容器内，否则用户会把卡片拖到看不见的地方。
 */
export function clampCanvasPoint(
  point: CanvasPoint,
  stage: { width?: number; height?: number } | null = null,
): CanvasPoint {
  const x = Number.isFinite(point.x) ? point.x : 0;
  const y = Number.isFinite(point.y) ? point.y : 0;
  const maxX = stage && typeof stage.width === 'number' && stage.width > 0
    ? Math.max(0, stage.width - CARD_WIDTH)
    : Number.POSITIVE_INFINITY;
  const maxY = stage && typeof stage.height === 'number' && stage.height > 0
    ? Math.max(0, stage.height - CARD_HEIGHT)
    : Number.POSITIVE_INFINITY;
  return {
    x: Math.min(Math.max(0, Math.round(x)), maxX),
    y: Math.min(Math.max(0, Math.round(y)), maxY),
  };
}

/** 把库里读到的（可能是手改 / 旧版本的）对象收敛成合法位置表 */
export function normalizeCanvasPositions(value: unknown): CanvasPositions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: CanvasPositions = {};
  for (const [recordId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!recordId || !raw || typeof raw !== 'object') continue;
    const candidate = raw as { x?: unknown; y?: unknown };
    if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number') continue;
    if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) continue;
    result[recordId] = { x: candidate.x, y: candidate.y };
  }
  return result;
}

/** 丢掉已删除记录的位置（避免 positions 无限膨胀） */
export function pruneCanvasPositions(
  positions: CanvasPositions,
  keepIds: readonly string[],
): CanvasPositions {
  const keep = new Set(keepIds);
  const result: CanvasPositions = {};
  for (const [recordId, point] of Object.entries(positions)) {
    if (keep.has(recordId)) result[recordId] = point;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 读写                                                               */
/* ------------------------------------------------------------------ */

/** 读模式；从未设置过 → 卡片墙（默认视图，符合「一条记录一张卡」的产品定位） */
export async function loadCanvasMode(): Promise<CanvasMode> {
  const row = await getSetting(CANVAS_MODE_KEY);
  return isCanvasMode(row?.value) ? row.value : 'wall';
}

export async function saveCanvasMode(mode: CanvasMode): Promise<CanvasMode> {
  const next: CanvasMode = isCanvasMode(mode) ? mode : 'wall';
  await putSetting({ key: CANVAS_MODE_KEY, value: next, updatedAt: Date.now() });
  return next;
}

export async function loadCanvasPositions(): Promise<CanvasPositions> {
  const row = await getSetting(CANVAS_POSITIONS_KEY);
  return normalizeCanvasPositions(row?.value);
}

export async function saveCanvasPositions(positions: CanvasPositions): Promise<CanvasPositions> {
  const next = normalizeCanvasPositions(positions);
  await putSetting({ key: CANVAS_POSITIONS_KEY, value: next, updatedAt: Date.now() });
  return next;
}

/** 只改一张卡片（拖动结束时调用；读 → 合并 → 写，避免覆盖别处的改动） */
export async function saveCardPosition(recordId: string, point: CanvasPoint): Promise<CanvasPositions> {
  const current = await loadCanvasPositions();
  const next: CanvasPositions = { ...current, [recordId]: clampCanvasPoint(point) };
  await putSetting({ key: CANVAS_POSITIONS_KEY, value: next, updatedAt: Date.now() });
  return next;
}
