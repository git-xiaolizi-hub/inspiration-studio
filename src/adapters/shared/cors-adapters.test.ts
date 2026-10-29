/**
 * M3R10 §1 / §5-1..3：生图 / 视频两个适配器家族的 CORS 分类。
 *
 * 为什么要单独一份：这两个家族各有自己的错误分类器（`image/errors.ts`、
 * `video/errors.ts`），本轮的改动同时落在三处；**若只测 ai-models 那一份，
 * 另外两处写错了也不会红**。判据是同一套（`shared/cors.ts`），落点必须一致。
 */
import { describe, expect, it } from 'vitest';
import { classifyImageFailure } from '../image/errors';
import { classifyVideoFailure } from '../video/errors';
import { CORS_BLOCKED_SENTENCE, REJECTED_UNREADABLE_SENTENCE } from './cors';

describe('生图：TypeError + 无状态码 + 快 → cors_blocked（不是 network_timeout）', () => {
  it('实测形态 → cors_blocked', () => {
    const error = classifyImageFailure({
      networkFailed: true,
      message: 'Failed to fetch',
      errorName: 'TypeError',
      elapsedMs: 61,
    });
    expect(error.category).toBe('cors_blocked');
    expect(error.category).not.toBe('network_timeout');
  });

  it('文案逐字，且不含「检查网络与代理」', () => {
    const error = classifyImageFailure({
      networkFailed: true,
      errorName: 'TypeError',
      elapsedMs: 50,
    });
    expect(error.title).toContain('不允许浏览器直连');
    expect(error.nextStep).toBe(CORS_BLOCKED_SENTENCE);
    expect(error.nextStep).not.toContain('检查网络与代理');
    // 生图是同步接口，这个分类绝不能顺带说「超时可能已扣费」
    expect(error.nextStep).not.toContain('扣费');
    expect(error.retryable).toBe(false);
  });

  it('§5-3：401/403/429 即使带 TypeError 也走原分类', () => {
    expect(
      classifyImageFailure({ status: 401, networkFailed: false, errorName: 'TypeError', elapsedMs: 20 })
        .category,
    ).toBe('auth');
    expect(
      classifyImageFailure({ status: 429, networkFailed: false, errorName: 'TypeError', elapsedMs: 20 })
        .category,
    ).toBe('rate_limited');
  });

  it('真网络问题（Error 而非 TypeError）仍是 network_timeout', () => {
    const error = classifyImageFailure({
      networkFailed: true,
      message: 'ECONNREFUSED',
      errorName: 'Error',
      elapsedMs: 30,
    });
    expect(error.category).toBe('network_timeout');
  });
});

describe('视频：同一判据，落点一致', () => {
  it('实测形态 → cors_blocked', () => {
    const error = classifyVideoFailure({
      networkFailed: true,
      message: 'Failed to fetch',
      errorName: 'TypeError',
      elapsedMs: 65,
    });
    expect(error.category).toBe('cors_blocked');
  });

  it('文案逐字，且不含「检查网络与代理」／不误导去重复提交', () => {
    const error = classifyVideoFailure({
      networkFailed: true,
      errorName: 'TypeError',
      elapsedMs: 65,
    });
    expect(error.title).toContain('不允许浏览器直连');
    expect(error.nextStep).toBe(CORS_BLOCKED_SENTENCE);
    expect(error.nextStep).not.toContain('检查网络与代理');
    expect(error.retryable).toBe(false);
  });

  it('§5-3：401/403/429 仍走原分类', () => {
    expect(
      classifyVideoFailure({ status: 401, networkFailed: false, errorName: 'TypeError', elapsedMs: 20 })
        .category,
    ).toBe('auth');
    expect(
      classifyVideoFailure({ status: 429, networkFailed: false, errorName: 'TypeError', elapsedMs: 20 })
        .category,
    ).toBe('unknown');
  });

  it('真网络问题仍是 network_timeout（旧用例的 ECONNREFUSED 语义没被改）', () => {
    const error = classifyVideoFailure({
      networkFailed: true,
      message: 'ECONNREFUSED',
      errorName: 'Error',
      elapsedMs: 30,
    });
    expect(error.category).toBe('network_timeout');
    expect(error.nextStep).toContain('不要重复提交');
  });
});

/**
 * M3R11 §1：生图 / 视频也必须过第二段判定 —— 方舟的 seedream / seedance 都在
 * `webCors: 'ok'` 的站上，key 写错时浏览器同样只看到 TypeError。
 */
describe('M3R11 §1：生图 / 视频的两段判定（预检结论决定分类）', () => {
  it('生图：预检通过 → rejected_unreadable，文案指向 Key / 模型名', () => {
    const error = classifyImageFailure({
      networkFailed: true,
      errorName: 'TypeError',
      elapsedMs: 61,
      corsPreflightPassed: true,
    });
    expect(error.category).toBe('rejected_unreadable');
    expect(error.category).not.toBe('cors_blocked');
    expect(error.nextStep).toBe(REJECTED_UNREADABLE_SENTENCE);
    expect(error.title).not.toContain('不允许浏览器直连');
    expect(error.retryable).toBe(false);
  });

  it('生图：预检失败 / 没探 → 仍是 cors_blocked（老行为不回归）', () => {
    for (const flag of [false, undefined]) {
      const error = classifyImageFailure({
        networkFailed: true,
        errorName: 'TypeError',
        elapsedMs: 61,
        corsPreflightPassed: flag,
      });
      expect(error.category).toBe('cors_blocked');
      expect(error.nextStep).toBe(CORS_BLOCKED_SENTENCE);
    }
  });

  it('视频：预检通过 → rejected_unreadable（不说「别重复提交」，因为压根没提交成功）', () => {
    const error = classifyVideoFailure({
      networkFailed: true,
      errorName: 'TypeError',
      elapsedMs: 65,
      corsPreflightPassed: true,
    });
    expect(error.category).toBe('rejected_unreadable');
    expect(error.nextStep).toBe(REJECTED_UNREADABLE_SENTENCE);
    expect(error.title).not.toContain('不允许浏览器直连');
  });

  it('视频：预检失败 / 没探 → 仍是 cors_blocked', () => {
    for (const flag of [false, undefined]) {
      const error = classifyVideoFailure({
        networkFailed: true,
        errorName: 'TypeError',
        elapsedMs: 65,
        corsPreflightPassed: flag,
      });
      expect(error.category).toBe('cors_blocked');
    }
  });
});
