/**
 * 视频生成的失败分类 → 人话（CHARTER §2 M4b 判据 4 / 任务书 §4.2.6）。
 *
 * 设计原则与 M3 的 `ai-models/errors.ts` 一致：**"发生了什么"和"下一步做什么"分开**，
 * UI 只展示 `message` + `nextStep`。
 *
 * ⚠️ 未验证：官方 `2.5_async_error` 章节的完整错误码表没有拿到。
 * 本文件里**只有两个错误码是文档确证过的**（`InvalidParameter.TaskTypeMismatch` /
 * `InvalidParameter.TaskTypeConstraint`，见 `ark-seedance-2.5.txt`「参数校验与报错机制」），
 * 其余分类全部靠**状态码 + 关键词**兜底，命中不了就归 `unknown` 并把原文抛给用户。
 * 宁可分类不准（用户仍能看到原文），也不要假装知道错误码。
 */
import { ARK_CONSOLE_URL } from './constants';
import {
  CORS_BLOCKED_SENTENCE,
  REJECTED_UNREADABLE_SENTENCE,
  decideCorsOrRejected,
  looksLikeCorsBlock,
} from '../shared/cors';

export type VideoErrorCategory =
  | 'insufficient_balance'
  | 'content_policy'
  | 'invalid_media'
  | 'duration_conflict'
  | 'network_timeout'
  | 'request_too_large'
  | 'media_needs_public_url'
  | 'auth'
  /** 浏览器直连被这家拒绝（CORS）——与「网络超时」的下一步动作完全不同（M3R10） */
  | 'cors_blocked'
  /**
   * M3R11 §1：**预检通过，但请求被拒且浏览器读不到详情**（方舟的 401 不带 ACAO）。
   * 与 `cors_blocked` 的处置相反：去核对 Key / 模型名，别换厂商。
   */
  | 'rejected_unreadable'
  /**
   * M4c 新增：免费通道的 429/1305「访问量过大」重试耗尽。
   * 它不是 `unknown` —— 用户能据此做一个明确决定（等一会儿 / 切付费通道），
   * 归到 `unknown` 只会让人以为代码有 bug。
   */
  | 'rate_limited'
  /**
   * M4c 新增：当前通道**根本没有**这个能力（参考视频 / 样片 / 音频参考）。
   * 与 `invalid_media`（能力有但素材不合格）区分开，文案才能给出"换通道"这个唯一正确动作。
   */
  | 'unsupported_capability'
  | 'unknown';

/** 每类错误的一句话人话 + 可执行动作（UI 直接展示，不要在这里写 markdown） */
export const CATEGORY_MESSAGES: Record<
  VideoErrorCategory,
  { title: string; nextStep: string }
> = {
  insufficient_balance: {
    title: '火山方舟账户余额不足',
    nextStep:
      '火山方舟账户余额需大于 ¥200，请到控制台充值（或购买资源包）后重试；已生成的 Draft 任务仍可在 7 天内用来出成片',
  },
  content_policy: {
    title: '内容审核未通过',
    nextStep:
      '换掉触发审核的素材或措辞后重试。注意：Seedance 2.5 / 2.0 不支持直接上传含真人人脸的参考图或视频，' +
      '改用官方预置虚拟人像或已授权真人素材（见下方「肖像素材方案」链接）',
  },
  invalid_media: {
    title: '素材格式不被接受',
    nextStep:
      '换 PNG / JPEG 图片（单张 < 30MB）、音频单个 < 15MB、视频仅支持公网 URL 且 < 200MB；' +
      '损坏或扩展名与实际格式不符的文件也会这样报错',
  },
  duration_conflict: {
    title: '时长或参数与任务类型冲突',
    nextStep:
      '时长只能是 4–30 秒或 -1（模型自选）；视频编辑/续写类任务需要 omni_reference_task_type=auto' +
      '（适配器已默认带上）。首尾帧模式与"参考图/参考视频"混用时容易触发此类异步报错，建议二选一',
  },
  network_timeout: {
    title: '网络超时或连接中断',
    nextStep:
      '检查网络与代理后重试。如果任务已经提交过，可能仍在服务端运行：用任务 ID 稍后再查，不要重复提交（会重复扣费）',
  },
  request_too_large: {
    title: '请求体超过 64MB 上限',
    nextStep:
      '减少内联素材（图片/音频各 < 5MB 才会走 base64），或把大文件放到对象存储/图床改传 URL；' +
      '也可以降级成"只用首尾帧"',
  },
  media_needs_public_url: {
    title: '这份素材需要公网 URL',
    nextStep:
      '三条出路：① 配 TOS 对象存储并把文件设为公共读；② 手动上传到图床，复制公网 URL 填进来；' +
      '③ 降级成只用首尾帧（图片 < 5MB 可走 base64）',
  },
  auth: {
    title: 'API Key 无效或没有权限',
    nextStep: `到火山方舟控制台确认 Key 有效、且已开通 Seedance 2.5（需余额 > ¥200）：${ARK_CONSOLE_URL}`,
  },
  /**
   * M3R10：**必须逐字**用 `CORS_BLOCKED_SENTENCE`，不许出现「检查网络与代理」
   * （判据 §5-2）。视频这两家（方舟 / 智谱）里方舟是 CORS 被拦的，
   * 但这条分类对两家通用 —— 判据看的是网络行为，不是厂商名字。
   */
  cors_blocked: {
    title: '这家不允许浏览器直连（服务器未开放跨域）',
    nextStep: CORS_BLOCKED_SENTENCE,
  },
  /** M3R11 §1：站是通的，问题在 Key / 模型名 / 分组权限（判据：OPTIONS 预检可读） */
  rejected_unreadable: {
    title: '服务器拒绝了这次请求（浏览器读不到详情）',
    nextStep: REJECTED_UNREADABLE_SENTENCE,
  },
  rate_limited: {
    title: '免费模型拥挤（排队超时）',
    nextStep:
      '免费池此刻访问量过大，重试配额已用完。两条路：① 过几分钟再点一次（免费额度不消耗，只是排队）；' +
      '② 切到 Seedance 2.5（付费 · 不用排队）',
  },
  unsupported_capability: {
    title: '当前通道不支持这个参数',
    nextStep:
      '免费通道（CogVideoX-Flash）没有这个能力。改成免费通道支持的写法（纯提示词 / 首尾帧），' +
      '或切换到 Seedance 2.5 再提交；适配器不会替你悄悄删参数',
  },
  unknown: {
    title: '未知错误（官方错误码表未拿到）',
    nextStep:
      '展开"技术细节"把原始返回发给承接方核对；不要把这条错误码当成文档结论写进任何设计',
  },
};

export class VideoError extends Error {
  readonly category: VideoErrorCategory;

  /** 服务端原始错误码（有就带，没有留空 —— 不猜） */
  readonly code?: string;

  /** 该错误重试有没有意义 */
  readonly retryable: boolean;

  /** 技术细节：原始响应片段，只给人排查用 */
  readonly detail?: string;

  /**
   * M4c 新增（可选）：站方专属的"下一步"文案。
   * 起因：`CATEGORY_MESSAGES` 的 auth/余额文案写死了**火山方舟**控制台链接，
   * 智谱通道复用分类时会指向错误的地方（第二家被迫改第一家的文案，正说明这一层抽象不完整）。
   * 只在不给时用默认文案 → Ark 的对外行为一个字节都没变。
   */
  readonly nextStepOverride?: string;

  constructor(
    category: VideoErrorCategory,
    message: string,
    options: { code?: string; retryable?: boolean; detail?: string; nextStepOverride?: string } = {},
  ) {
    super(message);
    this.name = 'VideoError';
    this.category = category;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
    this.nextStepOverride = options.nextStepOverride;
  }

  get title(): string {
    return CATEGORY_MESSAGES[this.category].title;
  }

  get nextStep(): string {
    return this.nextStepOverride ?? CATEGORY_MESSAGES[this.category].nextStep;
  }
}

export function isVideoError(value: unknown): value is VideoError {
  return value instanceof VideoError;
}

/* ------------------------------------------------------------------ */
/* 分类                                                               */
/* ------------------------------------------------------------------ */

const BALANCE = /insufficient|balance|欠费|余额|额度不足|resource_?pack|资源包|AccountOverdue/i;
const POLICY = /sensitive|risk|违规|审核|敏感|content_policy|Moderation|inappropriate/i;
const MEDIA =
  /image[_\s-]?format|invalid[_\s-]?image|audio[_\s-]?format|video[_\s-]?format|素材|格式|decode|ffmpeg|mime|分辨率|resolution|unsupported[_\s-]?(image|audio|video)/i;
const DURATION = /duration|时长|秒数|ratio|参数冲突|invalidparameter\.tasktype/i;
const AUTH = /unauthor|authenticat|api[_\s-]?key|invalid[_\s-]?token|forbidden/i;

/** 文档确证的两个异步错误码（`ark-seedance-2.5.txt`）：参数与任务类型不兼容 */
const DOC_CONFIRMED_TASK_TYPE_CODES = [
  'InvalidParameter.TaskTypeMismatch',
  'InvalidParameter.TaskTypeConstraint',
];

export interface VideoFailureInput {
  /** HTTP 状态码；提交被拒时有，网络失败时没有 */
  status?: number;
  /** 响应体原文 */
  bodyText?: string;
  /** 服务端给的 code（异步失败时来自 `error.code`） */
  code?: string;
  /** 服务端给的 message */
  message?: string;
  timedOut?: boolean;
  networkFailed?: boolean;
  /** M3R10 §1：判「CORS 还是网络不通」只看这两样（见 `shared/cors.ts`） */
  errorName?: string;
  elapsedMs?: number;
  /** M3R11 §1：`OPTIONS` 预检结论（`true` 通过 / `false` 没过 / `undefined` 没探） */
  corsPreflightPassed?: boolean;
}

function excerpt(text: string | undefined, limit = 300): string {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 单一入口：把一次失败（提交被拒 / 异步 failed / 网络异常）翻译成可展示的 VideoError。
 * 顺序：超时/网络 → 文档确证的 code → 余额 → 内容 → 参数冲突 → 素材 → 鉴权 → 状态码兜底。
 */
export function classifyVideoFailure(input: VideoFailureInput): VideoError {
  const { status, bodyText = '', code, message } = input;
  const haystack = `${code ?? ''} ${message ?? ''} ${bodyText}`;

  if (input.timedOut) {
    return new VideoError('network_timeout', '请求超时（本地计时器触发中止）', {
      retryable: true,
      detail: excerpt(bodyText),
    });
  }
  if (input.networkFailed) {
    /**
     * M3R10 §1 + **M3R11 §1（两段判定）**：先摘 CORS，再谈网络。方舟的 401 不带
     * ACAO，所以「key 写错」与「被拦」在 JS 侧一样；只有预检通过才说明是前者。
     */
    if (looksLikeCorsBlock({ status, errorName: input.errorName, elapsedMs: input.elapsedMs })) {
      if (decideCorsOrRejected(input.corsPreflightPassed) === 'rejected_unreadable') {
        return new VideoError(
          'rejected_unreadable',
          `站支持跨域（OPTIONS 预检可读），但这次请求被拒且浏览器读不到详情：${excerpt(message)}`,
          { retryable: false },
        );
      }
      return new VideoError('cors_blocked', `浏览器拦下了跨域响应：${excerpt(message)}`, {
        retryable: false,
      });
    }
    return new VideoError('network_timeout', `请求没有发出去或连接被断开：${excerpt(message)}`, {
      retryable: true,
    });
  }

  if (code === 'PollTimeout') {
    return new VideoError('network_timeout', '本地轮询超时（任务可能仍在服务端运行，别重复提交）', {
      code,
      retryable: true,
      detail: excerpt(bodyText),
    });
  }

  if (code && DOC_CONFIRMED_TASK_TYPE_CODES.includes(code)) {
    return new VideoError('duration_conflict', `参数与任务类型不兼容（${code}）`, {
      code,
      detail: excerpt(bodyText),
    });
  }

  if (BALANCE.test(haystack)) {
    return new VideoError('insufficient_balance', `余额/额度问题：${excerpt(message ?? bodyText)}`, {
      code,
      detail: excerpt(bodyText),
    });
  }
  if (POLICY.test(haystack)) {
    return new VideoError('content_policy', `内容审核拦截：${excerpt(message ?? bodyText)}`, {
      code,
      detail: excerpt(bodyText),
    });
  }
  if (DURATION.test(haystack)) {
    return new VideoError('duration_conflict', `时长或参数冲突：${excerpt(message ?? bodyText)}`, {
      code,
      detail: excerpt(bodyText),
    });
  }
  if (MEDIA.test(haystack)) {
    return new VideoError('invalid_media', `素材不被接受：${excerpt(message ?? bodyText)}`, {
      code,
      detail: excerpt(bodyText),
    });
  }
  if (status === 401 || status === 403 || AUTH.test(haystack)) {
    return new VideoError('auth', `没有权限或 Key 无效（HTTP ${String(status ?? '无')}）`, {
      code,
      detail: excerpt(bodyText),
    });
  }
  if (status === 429) {
    return new VideoError('unknown', '被限流（HTTP 429），稍后重试', {
      code,
      retryable: true,
      detail: excerpt(bodyText),
    });
  }
  if (typeof status === 'number' && status >= 500) {
    return new VideoError('unknown', `服务端错误（HTTP ${status}），可稍后重试`, {
      code,
      retryable: true,
      detail: excerpt(bodyText),
    });
  }

  return new VideoError('unknown', `未识别的失败：${excerpt(message ?? bodyText) || '响应为空'}`, {
    code,
    detail: excerpt(bodyText),
  });
}

/** 任务失败（异步 failed）时从 `error` 字段取分类；字段名未验证，取不到就归 unknown */
export function classifyTaskError(error: { code?: string; message?: string } | undefined): VideoError {
  return classifyVideoFailure({
    code: error?.code,
    message: error?.message,
    bodyText: error ? JSON.stringify(error) : '',
  });
}

/** UI 直接展示所需的三段文案（状态机 / 失败面板共用） */
export interface TaskFailureView {
  category: VideoErrorCategory;
  title: string;
  nextStep: string;
  code?: string;
  message: string;
}

/**
 * 把一个 `failed` 的 VideoTask 翻成"人话 + 下一步"。
 * 非 failed 任务返回 null（成功/进行中的状态不需要错误文案）。
 */
export function describeTask(task: {
  status: string;
  error?: { code?: string; message?: string };
}): TaskFailureView | null {
  if (task.status !== 'failed') return null;
  const error = classifyTaskError(task.error);
  return {
    category: error.category,
    title: error.title,
    nextStep: error.nextStep,
    code: task.error?.code || undefined,
    message: task.error?.message ?? error.message,
  };
}
