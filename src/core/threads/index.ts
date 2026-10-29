/**
 * 会话线程（threads）的数据层（M5a3）。
 *
 * 裁决（委托人原话）：**「多轮对话只在卡片里，工作流只做单次」**。
 * 所以只有 解梦 / 灵感与文案 有线程；生图 / 生视频 仍是单次生成。
 *
 * 三条纪律：
 * 1. **线程不塞进记录正文**：记录只有 text/tags，会话是独立表（换设备靠备份 zip 带走）；
 * 2. **失败轮留痕但不进上下文**：`contextTurns()` 会滤掉 `error` 轮与空内容 ——
 *    把一次报错当成模型说过的话发回去，是最容易让后续回答跑偏的做法；
 * 3. **一条记录可以有多条线程**：换记录 = 换线程集合；同一记录同 kind 开新会话时旧线程保留。
 */
import { getDatabase } from '../storage/db';
import type { ThreadRow, TurnRow } from '../storage/db';

export type ThreadKind = 'dream' | 'copy';

export type Turn = TurnRow;
export type Thread = ThreadRow;

/** kind → 打包进来的 pack 名（与 `ui/create/pack-runner.ts` 的 PACK_SOURCES 对齐） */
export const PACK_ID_BY_KIND: Record<ThreadKind, string> = {
  dream: 'dream-interpretation',
  copy: 'story-expansion',
};

export const THREAD_KIND_LABELS: Record<ThreadKind, string> = {
  dream: '解梦',
  copy: '灵感与文案',
};

function newThreadId(): string {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  const suffix =
    globalCrypto && typeof globalCrypto.randomUUID === 'function'
      ? globalCrypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return `thread:${suffix}`;
}

export interface CreateThreadInput {
  recordId: string;
  kind: ThreadKind;
  title?: string;
  /** 可注入时钟（测试断言顺序用） */
  now?: () => number;
}

/** 开一条空线程（**不写首轮**：首轮结果由调用方追加，失败也能留下痕迹） */
export async function createThread(input: CreateThreadInput): Promise<Thread> {
  const at = (input.now ?? Date.now)();
  const row: Thread = {
    id: newThreadId(),
    recordId: input.recordId,
    kind: input.kind,
    packId: PACK_ID_BY_KIND[input.kind],
    turns: [],
    createdAt: at,
    updatedAt: at,
  };
  if (input.title !== undefined && input.title !== '') row.title = input.title;
  await getDatabase().threads.put(row);
  return row;
}

export async function getThread(id: string): Promise<Thread | undefined> {
  return getDatabase().threads.get(id);
}

/** 一条记录的全部会话（最近更新在前 —— 与"上次聊到哪"一致） */
export async function listThreads(recordId: string): Promise<Thread[]> {
  const rows = await getDatabase().threads.where('recordId').equals(recordId).toArray();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listThreadsByKind(recordId: string, kind: ThreadKind): Promise<Thread[]> {
  const rows = await listThreads(recordId);
  return rows.filter((row) => row.kind === kind);
}

/** 这条记录当前 kind 的最近一条会话（没有 → undefined，UI 显示「开始解梦」） */
export async function latestThread(
  recordId: string,
  kind: ThreadKind,
): Promise<Thread | undefined> {
  const rows = await listThreadsByKind(recordId, kind);
  return rows[0];
}

/** 整条线程写回（turns 一起） */
export async function saveThread(thread: Thread, now: () => number = Date.now): Promise<Thread> {
  const next: Thread = { ...thread, updatedAt: now() };
  await getDatabase().threads.put(next);
  return next;
}

/**
 * 只替换 turns（其余字段原样）。线程不存在时返回 undefined 而不是造一条空线程 ——
 * 用户删掉会话后迟到的模型响应不该把会话"复活"。
 */
export async function setThreadTurns(
  id: string,
  turns: Turn[],
  now: () => number = Date.now,
): Promise<Thread | undefined> {
  const current = await getThread(id);
  if (!current) return undefined;
  return saveThread({ ...current, turns }, now);
}

export async function removeThread(id: string): Promise<void> {
  await getDatabase().threads.delete(id);
}

/** 删一条记录的全部会话（记录被删时由 UI 显式调用，与 artifacts 同一套取舍） */
export async function removeThreadsForRecord(recordId: string): Promise<number> {
  const rows = await listThreads(recordId);
  for (const row of rows) await removeThread(row.id);
  return rows.length;
}

/** 只保留"能被当成上下文发回去"的轮：非失败、非空内容 */
export function contextTurns(turns: readonly Turn[]): Turn[] {
  return turns.filter((turn) => turn.error === undefined && turn.content.trim() !== '');
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * turns → 发给模型的 messages。
 * - 失败轮直接跳过（不把报错当历史）；
 * - 首轮 assistant 的 `content` 已经是可读文本（由 `structuredToText` 渲染），
 *   `structured` 只用于界面画卡片，不发给模型。
 */
export function toChatMessages(turns: readonly Turn[]): ChatMessage[] {
  return contextTurns(turns).map((turn) => ({ role: turn.role, content: turn.content }));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 把 pack 的结构化输出摊成一段可读文本，作为首轮 turn 的 `content`。
 *
 * 为什么不把原始 JSON 直接当 content：追问时它会被原样发回模型，
 * 一坨 JSON 既费 token 又容易让模型接着吐 JSON（多轮里这是最常见的退化）。
 * 卡片仍由 `structured` 渲染，信息不丢。
 */
export function structuredToText(structured: unknown, kind: ThreadKind): string {
  const payload = asRecord(structured);
  const lines: string[] = [];

  if (kind === 'dream') {
    if (asString(payload.interpretation) !== '') lines.push(asString(payload.interpretation));
    const symbols = Array.isArray(payload.symbols) ? payload.symbols : [];
    if (symbols.length > 0) {
      lines.push('意象：');
      for (const raw of symbols) {
        const symbol = asRecord(raw);
        lines.push(`- ${asString(symbol.symbol)}：${asString(symbol.meaning)}`);
      }
    }
    if (asString(payload.disclaimer) !== '') lines.push(asString(payload.disclaimer));
    return lines.join('\n');
  }

  const directions = Array.isArray(payload.directions) ? payload.directions : [];
  for (const [index, raw] of directions.entries()) {
    const direction = asRecord(raw);
    const beats = Array.isArray(direction.beats) ? direction.beats.map(String) : [];
    lines.push(`方向 ${index + 1}：${asString(direction.title)}`);
    if (asString(direction.logline) !== '') lines.push(`一句话：${asString(direction.logline)}`);
    if (asString(direction.conflict) !== '') lines.push(`冲突：${asString(direction.conflict)}`);
    if (asString(direction.why_it_holds) !== '') {
      lines.push(`为什么成立：${asString(direction.why_it_holds)}`);
    }
    if (beats.length > 0) lines.push(`节拍：${beats.join(' / ')}`);
  }
  if (asString(payload.disclaimer) !== '') lines.push(asString(payload.disclaimer));
  return lines.join('\n');
}

/** 会话在切换器里的一行摘要（不把几十轮正文铺进下拉框） */
export function threadLabel(thread: Thread): string {
  if (thread.title !== undefined && thread.title !== '') return thread.title;
  const date = new Date(thread.createdAt);
  const pad = (value: number) => `${value}`.padStart(2, '0');
  const assistant = thread.turns.filter((turn) => turn.role === 'assistant').length;
  return `会话 ${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )} · ${assistant} 答`;
}
