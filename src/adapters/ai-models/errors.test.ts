import { describe, expect, it } from 'vitest';
import { AIErrorCode } from './types';
import {
  bodyMentionsInvalidEndpoint,
  bodyMentionsQuota,
  classifyFailure,
  extractVendorCode,
  makeError,
  USER_MESSAGES,
} from './errors';

describe('人话提示覆盖全部错误码', () => {
  const codes = Object.values(AIErrorCode);

  it('每个 AIErrorCode 都有对应的 userMessage，且不是状态码原文', () => {
    for (const code of codes) {
      const message = USER_MESSAGES[code];
      expect(typeof message, `${code} 缺少 userMessage`).toBe('string');
      expect(message.length, `${code} 的人话太短`).toBeGreaterThan(8);
      expect(message, `${code} 不应该只是 HTTP 状态码`).not.toMatch(/^HTTP \d+$/);
    }
  });

  it('makeError 带上 retryable 与 code（可重试的只有超时/限流/网络）', () => {
    expect(makeError(AIErrorCode.TIMEOUT, 'x').retryable).toBe(true);
    expect(makeError(AIErrorCode.RATE_LIMIT, 'x').retryable).toBe(true);
    expect(makeError(AIErrorCode.NETWORK_ERROR, 'x').retryable).toBe(true);
    expect(makeError(AIErrorCode.UNAUTHORIZED, 'x').retryable).toBe(false);
    expect(makeError(AIErrorCode.IMAGE_NOT_SUPPORTED, 'x').retryable).toBe(false);
  });
});

describe('业务码与 HTTP 状态的映射', () => {
  it('1210 → 不支持图片（数字或字符串都认）', () => {
    expect(classifyFailure({ status: 400, payload: { error: { code: 1210 } }, bodyText: '{}' }).code).toBe(
      AIErrorCode.IMAGE_NOT_SUPPORTED,
    );
    expect(
      classifyFailure({ status: 200, payload: { code: '1210' }, bodyText: '{}' }).code,
    ).toBe(AIErrorCode.IMAGE_NOT_SUPPORTED);
  });

  it('1214 → 图片格式错', () => {
    expect(classifyFailure({ status: 400, payload: { error: { code: 1214 } }, bodyText: '{}' }).code).toBe(
      AIErrorCode.INVALID_IMAGE_FORMAT,
    );
  });

  it('两种错误的人话不一样（不能混成一句"请求失败"）', () => {
    expect(USER_MESSAGES[AIErrorCode.IMAGE_NOT_SUPPORTED]).toContain('不支持图片输入');
    expect(USER_MESSAGES[AIErrorCode.INVALID_IMAGE_FORMAT]).toContain('图片格式');
  });

  it('extractVendorCode 兼容 {code} / {error:{code}} / {error:{type}}', () => {
    expect(extractVendorCode({ code: 1210 })).toBe('1210');
    expect(extractVendorCode({ error: { code: 1214 } })).toBe('1214');
    expect(extractVendorCode({ error: { type: 'insufficient_quota' } })).toBe('insufficient_quota');
    expect(extractVendorCode({ nothing: true })).toBeNull();
  });
});

describe('状态码兜底', () => {
  it('401/403/404/429 各归各类', () => {
    expect(classifyFailure({ status: 401 }).code).toBe(AIErrorCode.UNAUTHORIZED);
    expect(classifyFailure({ status: 403 }).code).toBe(AIErrorCode.FORBIDDEN);
    expect(classifyFailure({ status: 404 }).code).toBe(AIErrorCode.MODEL_NOT_FOUND);
    expect(classifyFailure({ status: 429 }).code).toBe(AIErrorCode.RATE_LIMIT);
  });

  it('402 直接归余额不足', () => {
    expect(classifyFailure({ status: 402, bodyText: 'payment required' }).code).toBe(
      AIErrorCode.INSUFFICIENT_QUOTA,
    );
  });

  it('429 但 body 说余额 → 余额不足（不是限流）', () => {
    const error = classifyFailure({
      status: 429,
      bodyText: JSON.stringify({ error: { message: 'quota exceeded for this billing period' } }),
    });
    expect(error.code).toBe(AIErrorCode.INSUFFICIENT_QUOTA);
  });

  it('401 不会被余额文案抢走（key 错就是 key 错）', () => {
    const error = classifyFailure({ status: 401, bodyText: '余额查询失败，请检查 key' });
    expect(error.code).toBe(AIErrorCode.UNAUTHORIZED);
  });

  it('5xx → unknown 但可重试', () => {
    const error = classifyFailure({ status: 503, bodyText: 'upstream unavailable' });
    expect(error.code).toBe(AIErrorCode.UNKNOWN);
    expect(error.retryable).toBe(true);
  });

  it('2xx 但非 JSON → invalid_response', () => {
    expect(
      classifyFailure({ status: 200, bodyText: '<html></html>', contentType: 'text/html' }).code,
    ).toBe(AIErrorCode.INVALID_RESPONSE);
  });

  it('超时 / 网络失败优先于状态码', () => {
    expect(classifyFailure({ timedOut: true }).code).toBe(AIErrorCode.TIMEOUT);
    expect(classifyFailure({ networkFailed: true, bodyText: 'ECONNREFUSED' }).code).toBe(
      AIErrorCode.NETWORK_ERROR,
    );
  });

  /**
   * M3R10 §1 / §5-1：**同样是"没有状态码 + 抛异常"，但原因完全不同**。
   * `networkFailed` 只说明 fetch 抛了；要判是不是 CORS，还得看 error.name 与耗时
   * （判据三件套见 `shared/cors.ts`）。这两条必须落在不同分类上。
   */
  it('TypeError + 无状态码 + 60ms → CORS_BLOCKED（不是 network_error）', () => {
    const error = classifyFailure({
      networkFailed: true,
      errorName: 'TypeError',
      elapsedMs: 61,
      bodyText: 'Failed to fetch',
    });
    expect(error.code).toBe(AIErrorCode.CORS_BLOCKED);
    expect(error.code).not.toBe(AIErrorCode.NETWORK_ERROR);
  });

  it('同样 Type 但耗时长（真网络问题）→ 仍是 network_error（不漏报也不谎报）', () => {
    const error = classifyFailure({
      networkFailed: true,
      errorName: 'TypeError',
      elapsedMs: 9000,
      bodyText: 'Failed to fetch',
    });
    expect(error.code).toBe(AIErrorCode.NETWORK_ERROR);
  });

  it('CORS 的 userMessage 含「不允许浏览器直连」，且**不含**「检查网络与代理」', () => {
    const error = classifyFailure({
      networkFailed: true,
      errorName: 'TypeError',
      elapsedMs: 57,
    });
    expect(error.userMessage).toContain('不允许浏览器直连');
    expect(error.userMessage).not.toContain('检查网络与代理');
    // CORS 是服务端配置问题，重试没有意义
    expect(error.retryable).toBe(false);
  });

  it('AbortController 触发的失败不会被误判成 CORS（timedOut 先被摘走）', () => {
    // AbortError 也是「无状态码 + 抛异常」，但它一定是超时那条分支
    const error = classifyFailure({
      timedOut: true,
      networkFailed: true,
      errorName: 'AbortError',
      elapsedMs: 40,
    });
    expect(error.code).toBe(AIErrorCode.TIMEOUT);
  });

  it('§5-3：401 / 403 / 404 / 429 即使带着 TypeError 也走原分类，不能被误判成 CORS', () => {
    const corsish = { networkFailed: false, errorName: 'TypeError', elapsedMs: 30 } as const;
    expect(classifyFailure({ status: 401, bodyText: '{}', ...corsish }).code).toBe(
      AIErrorCode.UNAUTHORIZED,
    );
    expect(classifyFailure({ status: 403, bodyText: '{}', ...corsish }).code).toBe(
      AIErrorCode.FORBIDDEN,
    );
    expect(classifyFailure({ status: 404, bodyText: '{}', ...corsish }).code).toBe(
      AIErrorCode.MODEL_NOT_FOUND,
    );
    expect(classifyFailure({ status: 429, bodyText: '{}', ...corsish }).code).toBe(
      AIErrorCode.RATE_LIMIT,
    );
  });

  it('bodyMentionsQuota 认中文与英文两种说法', () => {
    expect(bodyMentionsQuota('账户余额不足')).toBe(true);
    expect(bodyMentionsQuota('insufficient_quota')).toBe(true);
    expect(bodyMentionsQuota('all good')).toBe(false);
  });
});

/**
 * M3R11 §1 / §3：两条**新**的分类分支。它们的价值全在「别把用户送错方向」：
 * - 预检通过却读不到详情 → 去核对 Key / 模型名（不是换厂商，也不是查网络）；
 * - 方舟族名 404 → 去填版本化模型 ID（不是「拉模型列表」，方舟没这个接口）。
 */
describe('M3R11 §1：TypeError 的第二段判定（预检通过与否决定文案）', () => {
  const typeErrorSignal = {
    networkFailed: true,
    errorName: 'TypeError',
    elapsedMs: 61,
    bodyText: 'Failed to fetch',
  } as const;

  it('预检通过 → REJECTED_UNREADABLE，文案含「Key 无效」且不含「不允许浏览器直连」', () => {
    const error = classifyFailure({ ...typeErrorSignal, corsPreflightPassed: true });
    expect(error.code).toBe(AIErrorCode.REJECTED_UNREADABLE);
    expect(error.userMessage).toContain('Key 无效');
    expect(error.userMessage).not.toContain('不允许浏览器直连');
    // 判据 §1：禁止说成网络问题
    expect(error.userMessage).not.toContain('检查网络与代理');
    expect(error.retryable).toBe(false);
  });

  it('预检失败 → CORS_BLOCKED，文案含「不允许浏览器直连」', () => {
    const error = classifyFailure({ ...typeErrorSignal, corsPreflightPassed: false });
    expect(error.code).toBe(AIErrorCode.CORS_BLOCKED);
    expect(error.userMessage).toContain('不允许浏览器直连');
    expect(error.userMessage).not.toContain('检查网络与代理');
  });

  it('没探（非浏览器 / 探针不可用）→ 保守走 CORS_BLOCKED（老行为不回归）', () => {
    const error = classifyFailure(typeErrorSignal);
    expect(error.code).toBe(AIErrorCode.CORS_BLOCKED);
  });

  it('技术细节里写明预检结论，便于排查', () => {
    const passed = classifyFailure({ ...typeErrorSignal, corsPreflightPassed: true });
    const failed = classifyFailure({ ...typeErrorSignal, corsPreflightPassed: false });
    expect(passed.message).toContain('OPTIONS 预检通过');
    expect(failed.message).toContain('OPTIONS 预检未通过');
  });
});

describe('M3R11 §3：方舟 InvalidEndpointOrModel.NotFound 单独映射', () => {
  const arkBody = JSON.stringify({
    error: {
      code: 'InvalidEndpointOrModel.NotFound',
      message: 'The model or endpoint doubao-seed-2.1-pro does not exist',
    },
  });

  it('族名 404 → VERSIONED_MODEL_ID_REQUIRED，文案含「版本化模型 ID」与「端点 ID」', () => {
    const error = classifyFailure({
      status: 404,
      bodyText: arkBody,
      payload: JSON.parse(arkBody),
    });
    expect(error.code).toBe(AIErrorCode.VERSIONED_MODEL_ID_REQUIRED);
    expect(error.userMessage).toContain('版本化模型 ID');
    expect(error.userMessage).toContain('端点 ID');
    expect(error.retryable).toBe(false);
  });

  it('不带 error.code、只有文案里提到也能认出来', () => {
    expect(bodyMentionsInvalidEndpoint('InvalidEndpointOrModel.NotFound')).toBe(true);
    expect(bodyMentionsInvalidEndpoint('model_not_allowed')).toBe(false);
    const error = classifyFailure({
      status: 404,
      bodyText: 'InvalidEndpointOrModel.NotFound: doubao-seedance-2.5 does not exist',
    });
    expect(error.code).toBe(AIErrorCode.VERSIONED_MODEL_ID_REQUIRED);
  });

  it('别把普通 404（没有这个 code）也吞进来', () => {
    const error = classifyFailure({ status: 404, bodyText: '{"error":{"message":"not found"}}' });
    expect(error.code).toBe(AIErrorCode.MODEL_NOT_FOUND);
  });
});
