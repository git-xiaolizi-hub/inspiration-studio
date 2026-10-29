/**
 * P5 · 两个新字段的读时归一（任务书 §2.1 要求「写一个纯函数 + 测试」）。
 *
 * 这里盯的是**旧数据与脏数据**：老库里的记录没有 `role` / `sourceIds`，
 * 手改库或导入异常可能塞进数字、字符串、对象 —— 一条坏字段不许把整页读崩。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECORD_ROLE,
  isAssetRole,
  isCopyLike,
  isDraftRole,
  normalizeRole,
  normalizeSourceIds,
  RECORD_ROLES,
} from './meta';

describe('normalizeRole：非法值一律回默认', () => {
  it('三个合法值原样返回', () => {
    expect(normalizeRole('note')).toBe('note');
    expect(normalizeRole('draft')).toBe('draft');
    expect(normalizeRole('asset')).toBe('asset');
    expect(RECORD_ROLES).toEqual(['note', 'draft', 'asset']);
  });

  it('旧记录没有字段（undefined / null）→ note', () => {
    expect(normalizeRole(undefined)).toBe(DEFAULT_RECORD_ROLE);
    expect(normalizeRole(null)).toBe(DEFAULT_RECORD_ROLE);
    expect(DEFAULT_RECORD_ROLE).toBe('note');
  });

  it('大小写 / 空格 / 近似词都不认（不要"猜"用户的意思）', () => {
    expect(normalizeRole('Draft')).toBe('note');
    expect(normalizeRole(' draft')).toBe('note');
    expect(normalizeRole('drafts')).toBe('note');
    expect(normalizeRole('成品')).toBe('note');
  });

  it('非字符串（数字 / 布尔 / 对象 / 数组）→ note，不抛异常', () => {
    for (const value of [0, 1, true, false, {}, [], { role: 'draft' }]) {
      expect(normalizeRole(value)).toBe('note');
    }
  });
});

describe('normalizeSourceIds：保序去重、只留非空字符串', () => {
  it('正常数组原样保留（顺序 = 显示顺序）', () => {
    expect(normalizeSourceIds(['b', 'a'])).toEqual(['b', 'a']);
  });

  it('非数组一律空数组', () => {
    for (const value of [undefined, null, 'a', 42, {}, true]) {
      expect(normalizeSourceIds(value)).toEqual([]);
    }
  });

  it('去掉空串 / 纯空白 / 非字符串，并 trim', () => {
    expect(normalizeSourceIds([' a ', '', '   ', 3, null, 'b'])).toEqual(['a', 'b']);
  });

  it('重复 id 只留第一次出现的位置', () => {
    expect(normalizeSourceIds(['a', 'b', 'a', ' c ', 'b'])).toEqual(['a', 'b', 'c']);
  });
});

describe('角色判据（列表角标 / 筛选 / 副本都用它）', () => {
  it('isDraftRole / isAssetRole 只看归一后的角色', () => {
    expect(isDraftRole('draft')).toBe(true);
    expect(isDraftRole(undefined)).toBe(false);
    expect(isAssetRole('asset')).toBe(true);
    expect(isAssetRole('draft')).toBe(false);
  });

  it('isCopyLike = 笔记 + 有来源（本轮唯一造出这个组合的是「复制」）', () => {
    expect(isCopyLike('note', ['a'])).toBe(true);
    expect(isCopyLike(undefined, ['a'])).toBe(true);
    expect(isCopyLike('note', [])).toBe(false);
    expect(isCopyLike('draft', ['a'])).toBe(false);
    expect(isCopyLike('asset', ['a'])).toBe(false);
  });
});
