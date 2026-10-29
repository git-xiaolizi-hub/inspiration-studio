/**
 * 生图失败分类 → 人话 + 下一步（同 `video/errors.ts` 的思路，但**不复用**它：
 * 视频那份的余额/控制台文案写死了火山方舟，图片这里三家混用会把用户指错地方）。
 *
 * 分类只做四类"用户能据此做决定"的事（判据 3）：
 *   401/403 → auth；429 → rate_limited；内容审核 → content_policy；参数错 → invalid_params。
 * 其余归 unknown 并把原文抛出来 —— 宁可分类不准，也不要假装知道错误码。
 */
import { ARK_CONSOLE_URL, ZHIPU_CONSOLE_URL } from './constants';
import {
  CORS_BLOCKED_SENTENCE,
  REJECTED_UNREADABLE_SENTENCE,
  decideCorsOrRejected,
  looksLikeCorsBlock,
} from '../shared/cors';

export type ImageErrorCategory =
  | 'auth'
  | 'rate_limited'
  | 'content_policy'
  | 'invalid_params'
  | 'unsupported_capability'
  | 'network_timeout'
  /** 浏览器直连被这家拒绝（CORS）——与「网络超时」的下一步动作完全不同（M3R10） */
  | 'cors_blocked'
  /**
   * M3R11 §1：**预检通过，但请求被拒且浏览器读不到详情**（方舟的 401 不带 ACAO）。
   * 与 `cors_blocked` 的处置相反：去核对 Key / 模型名，不要换厂商。
   */
  | 'rejected_unreadable'
  | 'unknown';

export interface CategoryMessage {
  title: string;
  nextStep: string;
}

export const IMAGE_CATEGORY_MESSAGES: Record<ImageErrorCategory, CategoryMessage> = {
  auth: {
    title: 'API Key 无效或没有权限',
    nextStep: `到厂商控制台确认 Key 有效、且已开通这个生图模型：智谱 ${ZHIPU_CONSOLE_URL} ／ 方舟 ${ARK_CONSOLE_URL}`,
  },
  rate_limited: {
    title: '被限流（免费池常排队）',
    nextStep:
      '等几十秒再点一次；免费档（cogview-3-flash）在高峰期会 429 / 1305。急着出图就切付费模型（如 cogview-4）',
  },
  content_policy: {
    title: '内容审核未通过',
    nextStep:
      '换掉提示词里触发审核的措辞（真人人名、暴力、色情、政治人物）后重试；审核是模型侧判定，重试同样的词一定还失败',
  },
  invalid_params: {
    title: '参数不被接受',
    nextStep:
      '检查尺寸是否是该模型的枚举值（glm-image 与 cogview 的尺寸表不一样）、提示词是否为空；报告里贴了各家的合法取值',
  },
  unsupported_capability: {
    title: '当前接口没有这个能力',
    nextStep:
      '智谱 / 方舟的图像接口文档里都没有「负向提示词」字段，适配器不会把它悄悄丢掉。把它写进正向提示词的否定句式，或换一家支持该字段的服务',
  },
  network_timeout: {
    title: '网络超时或连接中断',
    nextStep:
      '检查网络与代理后重试。生图是**同步接口**：超时那一刻图可能已经出好了并扣过费，先看一眼账单再决定是否重发',
  },
  /**
   * M3R10：**必须逐字**用 `CORS_BLOCKED_SENTENCE`，不许出现「检查网络与代理」
   * （判据 §5-2）—— 用户会照着去改一个本来完全正确的 base_url。
   */
  cors_blocked: {
    title: '这家不允许浏览器直连（服务器未开放跨域）',
    nextStep: CORS_BLOCKED_SENTENCE,
  },
  /**
   * M3R11 §1：与 CORS 完全不同的结论 —— **站是通的**，问题在 Key / 模型名 / 分组权限。
   * 判据是「OPTIONS 预检能读到状态码」（见 `shared/cors.ts` 的 `preflightOk`）。
   */
  rejected_unreadable: {
    title: '服务器拒绝了这次请求（浏览器读不到详情）',
    nextStep: REJECTED_UNREADABLE_SENTENCE,
  },
  unknown: {
    title: '未知错误',
    nextStep: '展开「技术细节」把原始返回发给承接方核对；不要把这条错误码当成文档结论写进任何设计',
  },
};

export class ImageError extends Error {
  readonly category: ImageErrorCategory;

  /** 服务端原始错误码（有就带，没有留空 —— 不猜） */
  readonly code?: string;

  readonly retryable: boolean;

  /** 原始响应片段，只给人排查用 */
  readonly detail?: string;

  constructor(
    category: ImageErrorCategory,
    message: string,
    options: { code?: string; retryable?: boolean; detail?: string } = {},
  ) {
    super(message);
    this.name = 'ImageError';
    this.category = category;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
  }

  get title(): string {
    return IMAGE_CATEGORY_MESSAGES[this.category].title;
  }

  get nextStep(): string {
    return IMAGE_CATEGORY_MESSAGES[this.category].nextStep;
  }
}

export function isImageError(value: unknown): value is ImageError {
  return value instanceof ImageError;
}

/* ------------------------------------------------------------------ */
/* 分类                                                               */
/* ------------------------------------------------------------------ */

const POLICY =
  /sensitive|risk|违规|审核|敏感|不安全|content[_ ]?policy|moderation|inappropriate|1301/i;
const PARAM =
  /invalid[_ ]?param|参数|prompt|size|image[_ ]?size|尺寸|unsupported[_ ]?(size|param)|BadRequest/i;

export interface ImageFailureInput {
  status?: number;
  bodyText?: string;
  code?: string;
  message?: string;
  timedOut?: boolean;
  networkFailed?: boolean;
  /** M3R10 §1：判「CORS 还是网络不通」只看这两样（见 `shared/cors.ts`） */
  errorName?: string;
  elapsedMs?: number;
  /**
   * M3R11 §1：`OPTIONS` 预检的结论（`true` 通过 / `false` 没过 / `undefined` 没探）。
   * 请求层（`image/http.ts`）在 TypeError 时探过一次才传进来。
   */
  corsPreflightPassed?: boolean;
}

function excerpt(text: string | undefined, limit = 300): string {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 单一入口：把一次失败翻成可展示的 ImageError。
 * 顺序：超时/网络 → 内容审核 → 参数 → 401/403 → 429 → 5xx → unknown。
 *
 * 内容审核排在参数之前是有意的：两家都可能用 400 报"内容审核未通过"，
 * 而它的下一步动作（改措辞）与"尺寸填错"完全不同。
 */
export function classifyImageFailure(input: ImageFailureInput): ImageError {
  const { status, bodyText = '', code, message } = input;
  const haystack = `${code ?? ''} ${message ?? ''} ${bodyText}`;

  if (input.timedOut) {
    return new ImageError('network_timeout', '请求超时（本地计时器触发中止）', {
      retryable: true,
      detail: excerpt(bodyText),
    });
  }
  if (input.networkFailed) {
    /**
     * M3R10 §1 + **M3R11 §1（两段判定）**：先摘 CORS，再谈网络；但「像 CORS」
     * 还要过第二段 —— 预检能读到状态码就说明这站放行跨域，TypeError 只能是
     * 「被拒且读不到详情」（方舟的 401 不带 ACAO，就是这个形态）。
     */
    if (
      looksLikeCorsBlock({ status, errorName: input.errorName, elapsedMs: input.elapsedMs })
    ) {
      if (decideCorsOrRejected(input.corsPreflightPassed) === 'rejected_unreadable') {
        return new ImageError(
          'rejected_unreadable',
          `站支持跨域（OPTIONS 预检可读），但这次请求被拒且浏览器读不到详情：${excerpt(message)}`,
          { retryable: false },
        );
      }
      return new ImageError('cors_blocked', `浏览器拦下了跨域响应：${excerpt(message)}`, {
        retryable: false,
      });
    }
    return new ImageError('network_timeout', `请求没有发出去或连接被断开：${excerpt(message)}`, {
      retryable: true,
    });
  }

  if (status === 401 || status === 403) {
    return new ImageError('auth', `没有权限或 Key 无效（HTTP ${status}）`, {
      code,
      detail: excerpt(bodyText),
    });
  }

  if (POLICY.test(haystack)) {
    return new ImageError('content_policy', `内容审核拦截：${excerpt(message ?? bodyText)}`, {
      code,
      detail: excerpt(bodyText),
    });
  }

  if (status === 429) {
    return new ImageError('rate_limited', '被限流（HTTP 429），稍后重试', {
      code,
      retryable: true,
      detail: excerpt(bodyText),
    });
  }

  if (status === 400 || status === 422 || PARAM.test(haystack)) {
    return new ImageError('invalid_params', `参数不被接受：${excerpt(message ?? bodyText)}`, {
      code,
      detail: excerpt(bodyText),
    });
  }

  if (typeof status === 'number' && status >= 500) {
    return new ImageError('unknown', `服务端错误（HTTP ${status}），可稍后重试`, {
      code,
      retryable: true,
      detail: excerpt(bodyText),
    });
  }

  return new ImageError('unknown', `未识别的失败：${excerpt(message ?? bodyText) || '响应为空'}`, {
    code,
    detail: excerpt(bodyText),
  });
}
