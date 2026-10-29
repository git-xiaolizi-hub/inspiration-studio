/**
 * 记录的两个 P5 新字段：`role` 与 `sourceIds`（成品主次）。
 *
 * **为什么不升 Dexie 版本**：Dexie 存的是完整对象，加一个「不在 schema 里」的普通属性
 * 不需要升版本、不需要迁移、不需要 upgrade 回调 —— 升版本只在**要建索引**才必要。
 * 这一轮按 role 筛选只有「左侧素材区三段筛选」一个用处，几千条记录走内存过滤完全够；
 * 一旦建索引，就要新增 `version(5)`，那会重放 v1–v4 全部 upgrade 逻辑，而收益只是一个
 * 用不上的查询快路径。**所以：零索引、零迁移、读时归一**（`db.ts` 的 records schema 一字未改）。
 *
 * 归一化的两条边界：
 * 1. 旧记录**根本没有这两个字段** → `role` 当 `'note'`、`sourceIds` 当 `[]`，不报错；
 * 2. 手改库 / 导入脏数据塞了非法值（数字、字符串、对象）→ 同样回到默认值，
 *    绝不让一个坏字段把整条记录读崩（列表页一次要渲染几十条）。
 */
import type { RecordRole } from './types';

/** 三种角色：笔记（默认）/ 写作成品 / AI 产出素材 */
export const RECORD_ROLES: readonly RecordRole[] = ['note', 'draft', 'asset'];

/** 没有字段 = 笔记。这是旧数据的默认值，也是唯一不会让 UI 隐藏任何东西的默认 */
export const DEFAULT_RECORD_ROLE: RecordRole = 'note';

/** 任意值 → 合法角色；非法一律回落 `'note'`（不抛异常） */
export function normalizeRole(value: unknown): RecordRole {
  return value === 'draft' || value === 'asset' || value === 'note' ? value : DEFAULT_RECORD_ROLE;
}

/**
 * 任意值 → 记录 id 数组。
 *
 * 只保留非空字符串（trim 后非空），**保序去重**（`sourceIds` 的顺序 = 来源列表的显示顺序），
 * 非数组一律 `[]`。不做长度上限：一条成品最多引用 4 条素材（`MAX_MATERIALS`），
 * 但 AI 产出 / 未来的工作流引用可能更多，这里不设栅栏。
 */
export function normalizeSourceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** 这条是不是「写作成品」（列表角标 / 来源素材区块都看它） */
export function isDraftRole(value: unknown): boolean {
  return normalizeRole(value) === 'draft';
}

/** 这条是不是 AI 产出（左侧筛选「AI 产出」= 只看这一类） */
export function isAssetRole(value: unknown): boolean {
  return normalizeRole(value) === 'asset';
}

/**
 * 「副本」的判据：**笔记 + 有来源**。
 *
 * 本轮唯一能造出这个组合的入口是左栏的「复制」（`duplicateRecord`：role 保持 `'note'`、
 * `sourceIds` 指向原记录）。没有为此新增第四个角色 —— 任务书 §2.1 只授权两个字段，
 * 多一个 `'copy'` 会让「我写的」筛选和备份口径都多一个分支。
 */
export function isCopyLike(role: unknown, sourceIds: unknown): boolean {
  return normalizeRole(role) === 'note' && normalizeSourceIds(sourceIds).length > 0;
}
