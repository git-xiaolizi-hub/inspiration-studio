/**
 * AI 错误的分类与人话映射（M3）。
 *
 * 设计原则：**把「发生了什么」和「该怎么改」分开**
 * - `AIError.message` 保留原始技术信息，只给人排查用（可折叠展示）；
 * - `AIError.userMessage` 是 UI 唯一直接展示的文字，必须是小白能照着做的动作。
 *
 * 分类顺序很关键（实测过中转站的几种混淆行为）：
 * 1. 超时 / 网络失败 → 没有 HTTP 状态码可依据；
 * 2. 厂商业务码（1210 / 1214）→ 有的站用 400，有的用 200+error，先看 body；
 * 3. 余额不足 → 常在 402 / 429 / 403 里用文案表达，不能只看状态码；
 * 4. 最后才按 HTTP 状态码兜底。
 */
import { AIErrorCode } from './types';
import type { AIError } from './types';
import {
  CORS_BLOCKED_SENTENCE,
  REJECTED_UNREADABLE_SENTENCE,
  decideCorsOrRejected,
  looksLikeCorsBlock,
} from '../shared/cors';

/** 每种错误的「人话提示」（CHARTER §3 的用户提示映射，补齐全部 11 类） */
export const USER_MESSAGES: Record<AIErrorCode, string> = {
  [AIErrorCode.TIMEOUT]:
    '连不上服务器（连接超时）：检查网络与代理，以及 base_url 是否漏写 https://',
  [AIErrorCode.UNAUTHORIZED]:
    'API Key 无效或无权限：请到该厂商控制台确认 Key 是否正确、是否复制完整、是否已启用',
  [AIErrorCode.FORBIDDEN]:
    'API Key 无效或无权限：这把 Key 没有访问权限（分组/套餐不匹配，或该模型未开通），请到该厂商控制台确认',
  [AIErrorCode.MODEL_NOT_FOUND]:
    '模型不存在或无权限，请检查模型名称是否正确；也可以点「拉取模型列表」从站上取真实名字',
  [AIErrorCode.MODELS_NOT_LISTED]:
    '这家没有模型列表接口（火山方舟就是这样），请用上面的预设标签选模型 —— 不影响保存和使用',
  [AIErrorCode.RATE_LIMIT]: '请求过多，请稍后重试（限流）：等几秒再试；持续出现请降低并发或换分组',
  [AIErrorCode.INSUFFICIENT_QUOTA]: '账户余额不足，请充值后重试',
  [AIErrorCode.INVALID_RESPONSE]:
    '服务返回的不是 JSON：地址可能指向了网页或错误页，确认 base_url 填的是 API 根地址',
  [AIErrorCode.IMAGE_NOT_SUPPORTED]:
    '此模型不支持图片输入，请换用支持视觉的模型（如 deepseek-flash / glm-5.3-flash / claude 全系）',
  [AIErrorCode.INVALID_IMAGE_FORMAT]:
    '图片格式不被接受：请换 PNG / JPEG，避免 webp、超大图或损坏的图片',
  [AIErrorCode.SYNC_NOT_SUPPORTED]:
    '这个模型不支持同步调用（生图/视频模型都这样）。换一个文本模型再测。',
  [AIErrorCode.MODEL_NOT_ALLOWED]:
    '这个 API Key 的分组没有权限用这个模型。点「拉取模型列表」，从列表里选一个可用的模型。',
  [AIErrorCode.NO_SYNC_MODEL]:
    '这个连接里只有生图/视频模型，它们不支持同步自检。请点下面的文本模型标签（如 glm-5.3-flash / deepseek-flash）再测，或直接到创作页实测。',
  /**
   * M3R10 §1：**必须逐字**（判据 §5-2）。文案由 `CORS_BLOCKED_SENTENCE` 提供，
   * 不在这里再写一遍 —— 两处各写一份必然走散。
   */
  [AIErrorCode.CORS_BLOCKED]: CORS_BLOCKED_SENTENCE,
  /** M3R11 §1：预检通过 → 站是通的，问题在 key / 模型名 / 分组权限。**逐字**。 */
  [AIErrorCode.REJECTED_UNREADABLE]: REJECTED_UNREADABLE_SENTENCE,
  /** M3R11 §3：方舟的族名 404（`InvalidEndpointOrModel.NotFound`）。 */
  [AIErrorCode.VERSIONED_MODEL_ID_REQUIRED]:
    '模型名不对：方舟只认版本化模型 ID（如 doubao-seedance-2-5-260628、doubao-seedream-5-0-pro-260628）或端点 ID（ep-xxxxxxxx），不能用族名（doubao-seedance-2.5 / doubao-seed-2.1-pro 会 404）。请到方舟控制台「在线推理」页复制模型 ID。',
  [AIErrorCode.NETWORK_ERROR]:
    '连不上服务器：检查网络与代理，以及 base_url 是否写错（漏写 https:// 也会这样）',
  [AIErrorCode.UNKNOWN]: '调用失败，原因未知：展开「技术细节」能看到服务端原始返回',
};

/** 重试有没有意义：限流/超时/网络抖动值得重试，key 错、模型名错重试 100 次也没用 */
const RETRYABLE: Record<AIErrorCode, boolean> = {
  [AIErrorCode.TIMEOUT]: true,
  [AIErrorCode.UNAUTHORIZED]: false,
  [AIErrorCode.FORBIDDEN]: false,
  [AIErrorCode.MODEL_NOT_FOUND]: false,
  [AIErrorCode.MODELS_NOT_LISTED]: false,
  [AIErrorCode.RATE_LIMIT]: true,
  [AIErrorCode.INSUFFICIENT_QUOTA]: false,
  [AIErrorCode.INVALID_RESPONSE]: false,
  [AIErrorCode.IMAGE_NOT_SUPPORTED]: false,
  [AIErrorCode.INVALID_IMAGE_FORMAT]: false,
  [AIErrorCode.SYNC_NOT_SUPPORTED]: false,
  [AIErrorCode.MODEL_NOT_ALLOWED]: false,
  [AIErrorCode.NO_SYNC_MODEL]: false,
  /** CORS 是服务端配置问题，重试一万次也是同一个 TypeError */
  [AIErrorCode.CORS_BLOCKED]: false,
  /** 同上：读不到详情的拒绝，重试没用，要改 key / 模型名 */
  [AIErrorCode.REJECTED_UNREADABLE]: false,
  [AIErrorCode.VERSIONED_MODEL_ID_REQUIRED]: false,
  [AIErrorCode.NETWORK_ERROR]: true,
  [AIErrorCode.UNKNOWN]: false,
};

export function makeError(
  code: AIErrorCode,
  message: string,
  overrides: { userMessage?: string; retryable?: boolean } = {},
): AIError {
  return {
    code,
    message,
    userMessage: overrides.userMessage ?? USER_MESSAGES[code],
    retryable: overrides.retryable ?? RETRYABLE[code],
  };
}

/** 把任意异常翻译成 AIError（网络层异常没有状态码） */
export function fromThrown(error: unknown): AIError {
  const name = error instanceof Error ? error.name : '';
  const text = error instanceof Error ? error.message : String(error);
  if (name === 'AbortError' || /abort/i.test(text)) {
    return makeError(AIErrorCode.TIMEOUT, `请求被中止（超时或用户取消）：${text}`);
  }
  return makeError(AIErrorCode.NETWORK_ERROR, `请求没有发出去或连接被断开：${text}`);
}

export function parseJsonSafely(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** 从各种站的错误体里挖出业务码：{error:{code}}, {code}, {error:{type}} */
export function extractVendorCode(payload: unknown): string | null {
  const root = asRecord(payload);
  if (!root) return null;
  const candidates: unknown[] = [root.code, asRecord(root.error)?.code, asRecord(root.error)?.type];
  for (const candidate of candidates) {
    if (typeof candidate === 'number') return String(candidate);
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return null;
}

/** 余额/额度类文案（火山方舟、中转站、官方 OpenAI 的说法都不一样） */
const QUOTA_PATTERN = /insufficient[_ ]?quota|quota[_ ]?exceeded|余额|欠费|额度不足|余额不足|balance/i;

export function bodyMentionsQuota(text: string): boolean {
  return QUOTA_PATTERN.test(text);
}

/** 1212：智谱一类厂商对生图/视频模型发同步 chat 时的业务码 */
const SYNC_PATTERN = /不支持\s*SYNC|不支持同步|not\s+support\s+sync|sync\s+call/i;

/** 404 里「key 的分组没这个模型的权限」——与「这家没有 /models 接口」不是一回事 */
const NOT_ALLOWED_PATTERN = /model_not_allowed|分组不允许|不允许调用|not allowed to (?:use|call)/i;

export function bodyMentionsSync(text: string): boolean {
  return SYNC_PATTERN.test(text);
}

export function bodyMentionsModelNotAllowed(text: string): boolean {
  return NOT_ALLOWED_PATTERN.test(text);
}

/**
 * M3R11 §3：火山方舟的 `InvalidEndpointOrModel.NotFound`。
 *
 * 与「模型不存在」不是一回事：**地址、key、分组都对**，只是这个名字方舟不认 ——
 * 它只接受版本化模型 ID（`doubao-seedance-2-5-260628`）或端点 ID（`ep-xxxxxxxx`），
 * 族名（`doubao-seedance-2.5` / `doubao-seed-2.1-pro`）一律 404（实测）。
 * 所以不能落到通用的 MODEL_NOT_FOUND 文案（那句会让人去「拉模型列表」，
 * 而方舟根本没有 /models 接口）。
 */
const INVALID_ENDPOINT_PATTERN = /InvalidEndpointOrModel/i;

export function bodyMentionsInvalidEndpoint(text: string): boolean {
  return INVALID_ENDPOINT_PATTERN.test(text);
}

/**
 * 「不支持同步调用」的人话（M3R9 §3）：知道是哪个模型时把它写进提示 ——
 * 用户要能看出「刚才是拿哪个模型测的」，否则只会以为整条连接坏了。
 */
export function syncNotSupportedMessage(model?: string): string {
  const name = (model ?? '').trim();
  if (!name) return USER_MESSAGES[AIErrorCode.SYNC_NOT_SUPPORTED];
  return `模型 ${name} 不支持同步调用（生图/视频模型都这样）。换一个文本模型再测。`;
}

/**
 * 「这把 key 的分组没这个模型的权限」的人话（M3R9 §3）：**与「这家没有列表接口」
 * 都是 404，必须区分**——一个要点「拉取模型列表」换模型，一个只是提示用预设标签。
 */
export function modelNotAllowedMessage(model?: string): string {
  const name = (model ?? '').trim();
  if (!name) return USER_MESSAGES[AIErrorCode.MODEL_NOT_ALLOWED];
  return `这个 API Key 的分组没有权限用 ${name}。点「拉取模型列表」，从列表里选一个可用的模型。`;
}

export interface FailureInput {
  /** HTTP 状态码；网络层失败时没有 */
  status?: number;
  /** 原始响应文本（可能是 JSON，也可能是 HTML 错误页） */
  bodyText?: string;
  /** 解析后的 JSON（能解析才有） */
  payload?: unknown;
  timedOut?: boolean;
  networkFailed?: boolean;
  /** 2xx 但 body 不是 JSON */
  contentType?: string | null;
  /**
   * fetch 抛出的异常名（`TypeError` = 浏览器 CORS 拦截的典型形态）与耗时。
   * M3R10 §1 起用来把「浏览器直连被拦」与「网络真不通」分开（见 `shared/cors.ts`）。
   */
  errorName?: string;
  elapsedMs?: number;
  /**
   * M3R11 §1：第二段判定的结论 —— 对该地址发 `OPTIONS` 能不能读到状态码。
   *
   * `true` = 预检通过 ⇒ 这站放行跨域，TypeError 只能是「被拒且读不到详情」
   * （方舟 401 不带 ACAO 就是这个形态）；`false` = 预检也没过 ⇒ 真被 CORS 拦；
   * `undefined` = 没探（非浏览器环境 / 探针不可用），保守按 CORS_BLOCKED 走。
   */
  corsPreflightPassed?: boolean;
}

/**
 * 单一入口：给定一次失败的响应，输出可展示的 AIError。
 * 测试里对所有分支都有断言（见 errors.test.ts）。
 */
export function classifyFailure(input: FailureInput): AIError {
  const { status, bodyText = '', payload, timedOut, networkFailed } = input;

  if (timedOut) {
    return makeError(AIErrorCode.TIMEOUT, '请求超时（AbortController 触发）');
  }
  if (networkFailed) {
    /**
     * M3R10 §1 + **M3R11 §1（两段判定）**：先认出「像 CORS 的失败」，再探预检定案。
     *
     * 火山方舟与灵绘在浏览器里都抛 `TypeError: Failed to fetch`（约 60ms），
     * 但成因完全不同：灵绘是真被拦（`OPTIONS` → 403），方舟是**支持 CORS 的站**
     * （`OPTIONS` → 204，业务响应可读），只有**401 鉴权失败**那条路径不带 ACAO。
     * 一口咬定 CORS 会让「key 写错」的用户去换厂商 —— 那是 M3R10 犯的错。
     *
     * 所以：形态像 CORS 之后，还要看请求层探到的 `corsPreflightPassed`：
     * - 预检通过 → `REJECTED_UNREADABLE`（核对 key / 模型名，别换厂商）；
     * - 预检没过 / 没探 → `CORS_BLOCKED`（老行为，不回归）。
     *
     * 顺序有意放在超时之后：AbortController 触发的失败也是「没有状态码 + 抛异常」，
     * 但 `timedOut` 已经在上一步被摘走，不会走到这里被误判成 CORS。
     */
    if (
      looksLikeCorsBlock({
        status,
        errorName: input.errorName,
        elapsedMs: input.elapsedMs,
      })
    ) {
      const verdict = decideCorsOrRejected(input.corsPreflightPassed);
      const evidence = `fetch 抛 TypeError 且无 HTTP 状态码（耗时 ${input.elapsedMs}ms，OPTIONS 预检${input.corsPreflightPassed === true ? '通过' : input.corsPreflightPassed === false ? '未通过' : '未探测'}）`;
      if (verdict === 'rejected_unreadable') {
        return makeError(
          AIErrorCode.REJECTED_UNREADABLE,
          `${evidence}：站支持跨域（预检可读），但这次请求被拒且浏览器读不到详情 —— 多半是 Key 无效、模型名不对或该 Key 没有这个模型的权限`,
        );
      }
      return makeError(
        AIErrorCode.CORS_BLOCKED,
        `${evidence}——浏览器按同源策略拦下了响应：${bodyText || 'Failed to fetch'}`,
      );
    }
    return makeError(AIErrorCode.NETWORK_ERROR, `fetch 抛异常：${bodyText || '网络不可达'}`);
  }

  const vendorCode = extractVendorCode(payload);
  if (vendorCode === '1210') {
    return makeError(AIErrorCode.IMAGE_NOT_SUPPORTED, `服务端业务码 1210：${bodyText.slice(0, 400)}`);
  }
  if (vendorCode === '1214') {
    return makeError(AIErrorCode.INVALID_IMAGE_FORMAT, `服务端业务码 1214：${bodyText.slice(0, 400)}`);
  }
  /**
   * M3R9 §3：业务码 1212（智谱一类厂商对生图/视频模型发同步 chat 的回复），
   * 以及只有文案没有数字码的同义说法。必须在 400 兜底**之前**看 body ——
   * 否则用户看到的是一句「请求参数被拒」，完全不知道要换模型。
   */
  if (vendorCode === '1212' || bodyMentionsSync(bodyText)) {
    return makeError(AIErrorCode.SYNC_NOT_SUPPORTED, `服务端业务码 1212（不支持同步调用）：${bodyText.slice(0, 400)}`);
  }
  /**
   * M3R11 §3：方舟的族名 404 必须单独映射。它常在 `{error:{code}}` 里带着
   * `InvalidEndpointOrModel.NotFound`，也可能只出现在 message 文案里 —— 两处都看。
   * 位置放在通用 404 兜底之前，否则用户看到的是一句「接口或模型不存在」，
   * 完全不知道要填版本化 ID。
   */
  if (bodyMentionsInvalidEndpoint(vendorCode ?? '') || bodyMentionsInvalidEndpoint(bodyText)) {
    return makeError(
      AIErrorCode.VERSIONED_MODEL_ID_REQUIRED,
      `方舟 InvalidEndpointOrModel.NotFound（族名 / 端点不存在）：${bodyText.slice(0, 400)}`,
    );
  }
  /**
   * M3R9 §3：**404 里的 model_not_allowed 与「这家没有 /models 接口」含义完全不同**
   * （前者是地址与 key 都对、只是这把 key 的分组没有该模型的权限），必须看响应体里的
   * code 区分，不能只看状态码。这里只处理「带明显权限文案」的 404；
   * 拉列表时那种「光秃秃的 404」由 listModels 归到 MODELS_NOT_LISTED。
   */
  if (status === 404 && (bodyMentionsModelNotAllowed(bodyText) || bodyMentionsModelNotAllowed(vendorCode ?? ''))) {
    return makeError(
      AIErrorCode.MODEL_NOT_ALLOWED,
      `HTTP 404 + 业务码 ${vendorCode ?? 'model_not_allowed'}（key 的分组没有该模型权限）：${bodyText.slice(0, 400)}`,
    );
  }

  // 余额不足：402 一定是；400/403/429 里若文案提到 quota/余额，也归到这里——
  // 否则用户会按「限流」去等，永远等不来。401 除外（那是 key 本身的问题）。
  if (status === 402) {
    return makeError(AIErrorCode.INSUFFICIENT_QUOTA, `HTTP 402（Payment Required）：${bodyText.slice(0, 400)}`);
  }
  if (status !== undefined && status !== 401 && bodyMentionsQuota(bodyText)) {
    return makeError(
      AIErrorCode.INSUFFICIENT_QUOTA,
      `HTTP ${status} 但响应体表示余额/额度问题：${bodyText.slice(0, 400)}`,
    );
  }

  switch (status) {
    case 400:
      return makeError(AIErrorCode.UNKNOWN, `HTTP 400（请求参数被拒）：${bodyText.slice(0, 400)}`);
    case 401:
      return makeError(AIErrorCode.UNAUTHORIZED, `HTTP 401：${bodyText.slice(0, 400)}`);
    case 403:
      return makeError(AIErrorCode.FORBIDDEN, `HTTP 403：${bodyText.slice(0, 400)}`);
    case 404:
      return makeError(
        AIErrorCode.MODEL_NOT_FOUND,
        `HTTP 404（接口或模型不存在）：${bodyText.slice(0, 400)}`,
      );
    case 429:
      return makeError(AIErrorCode.RATE_LIMIT, `HTTP 429：${bodyText.slice(0, 400)}`);
    default:
      break;
  }

  if (typeof status === 'number' && status >= 500) {
    return makeError(
      AIErrorCode.UNKNOWN,
      `HTTP ${status}（服务端错误，稍后重试）：${bodyText.slice(0, 400)}`,
      { retryable: true },
    );
  }
  if (typeof status === 'number' && status >= 200 && status < 300) {
    return makeError(
      AIErrorCode.INVALID_RESPONSE,
      `HTTP ${status} 但响应不是合法 JSON（content-type=${input.contentType ?? '未知'}）：${bodyText.slice(0, 200)}`,
    );
  }
  return makeError(
    AIErrorCode.UNKNOWN,
    `未识别的失败：status=${String(status)} body=${bodyText.slice(0, 200)}`,
  );
}
