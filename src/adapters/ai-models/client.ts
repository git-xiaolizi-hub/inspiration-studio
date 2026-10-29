/**
 * AI 调用的 HTTP 客户端（M3 交付物 3 / 5）。
 *
 * 三条硬要求落在这里：
 * 1. **探针可注入**：所有函数都接受 `fetchImpl`，生产用全局 fetch，测试换成 mock server /
 *    纯函数探针。测试可以断言"真实 fetch 一次都没被调用"。
 * 2. **地址容错**：不是所有站的 OpenAI 协议根都带 /v1。`endpointCandidates` 给出候选顺序，
 *    请求层按顺序试（404 / 连不上时换下一个），全部失败才把最后一个错误抛出来。
 * 3. **错误一律转成人话**：网络层异常、非 JSON、业务码 1210/1214、余额不足……统一走
 *    `classifyFailure`，UI 只展示 `userMessage`。
 *
 * 本文件不做任何自动重试（除"换地址重试"这一种），避免把 429 打成更严重的限流。
 */
import { AIErrorCode } from './types';
import type { AIError, AIRequest, AIResponse, TokenUsage } from './types';
import {
  bodyMentionsModelNotAllowed,
  classifyFailure,
  extractVendorCode,
  fromThrown,
  makeError,
  modelNotAllowedMessage,
  parseJsonSafely,
  syncNotSupportedMessage,
} from './errors';

import { rewriteForDevProxy } from '../shared/dev-proxy';
/** M3R11 §1：TypeError 的第二段判定 —— 探一次 OPTIONS 才分得开「被拦」与「被拒但读不到」 */
import { PREFLIGHT_TIMEOUT_MS, preflightOk } from '../shared/cors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 客户端认的三种协议（M3R4 §4.1）。`responses` = OpenAI 的 `/responses` 端点，
 * 请求体是 `{model, input, max_output_tokens}`（不是 messages/max_tokens）。
 */
export type ClientProtocol = 'openai' | 'anthropic' | 'responses';

export interface ClientDeps {
  /** 注入探针；不传则用全局 fetch */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface ProviderInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol?: ClientProtocol;
  timeoutMs?: number;
  /**
   * 这条连接模型表里的候选（M3R9 §1）：自检要从**这个 key 实际能用的模型**里挑，
   * 而不是拿厂商默认模型硬试。`caps` 只用来判断「能不能发同步 chat」，
   * 客户端不认识 `ModelCap` 类型，所以收 `string[]`（'text' / 'vision' / 'image' / 'video'）。
   */
  syncCandidates?: readonly SyncCandidate[];
}

/** 自检候选：一条模型行 + 它的能力标签（缺 caps = 判断不了，按文本处理） */
export interface SyncCandidate {
  modelId: string;
  caps?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** 连通性自检只发 1 个 token，15 秒还没回就是真的连不上 */
const SELF_TEST_TIMEOUT_MS = 15_000;

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function isValidBaseUrl(raw: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(raw.trim());
}

/** 已带版本段的地址：/v1、/v2、/v4、/api/paas/v4、/api/v3 ... */
const VERSION_SEGMENT = /\/v\d+(?:\.\d+)?$/i;

export type EndpointKind = 'chat' | 'models' | 'messages' | 'responses';

const PATHS: Record<EndpointKind, string> = {
  chat: '/chat/completions',
  models: '/models',
  messages: '/messages',
  responses: '/responses',
};

/** 协议 → 端点（`responses` 与 `chat` 是两种不同的请求体，不能混用） */
export function endpointKindFor(protocol: ClientProtocol): EndpointKind {
  if (protocol === 'anthropic') return 'messages';
  if (protocol === 'responses') return 'responses';
  return 'chat';
}

/**
 * 候选地址（按尝试顺序）。
 * - 地址已带版本段（/v1、/v4、/api/v3…）→ 直接拼路径，**不再补 /v1**；
 * - 否则 → **先试 `{base}/...`（用户填的原样），再试 `{base}/v1/...`**。
 *
 * M3R9 §4 把顺序反过来了（原来是先 /v1）：实测灵绘的 `/v1/models` 与 `/models` 都 200，
 * 说明用户填什么就是什么；先打原样地址，能命中就少打一次请求。**任一成功就停**
 * （见 `runSelfTest` / `chat` / `listModels` 的循环），并把实际命中的地址回传给 UI。
 */
export function endpointCandidates(baseUrl: string, kind: EndpointKind): string[] {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return [];
  if (VERSION_SEGMENT.test(base)) return [base + PATHS[kind]];
  return [base + PATHS[kind], base + '/v1' + PATHS[kind]];
}

interface RawResult {
  method: string;
  url: string;
  status: number;
  ok: boolean;
  bodyText: string;
  contentType: string | null;
  timedOut: boolean;
  networkFailed: boolean;
  networkMessage: string;
  /** fetch 抛出的异常名（AbortError / TypeError / …）；拿到响应时为 '' */
  errorName: string;
  elapsedMs: number;
  /**
   * M3R11 §1：TypeError 之后补探一次 `OPTIONS` 的结论（`true/false`；没探为 undefined）。
   * 见 `shared/cors.ts` 的 `preflightOk` —— 它决定 TypeError 最终归到
   * `REJECTED_UNREADABLE`（站支持 CORS，key/模型名有问题）还是 `CORS_BLOCKED`。
   */
  corsPreflightPassed?: boolean;
}

/** 给用户排查用的技术细节（M3R §6）：只展开给人看，不参与任何判定 */
export interface HttpDiagnostics {
  method: string;
  url: string;
  /** 0 = 压根没拿到响应（网络层失败 / 超时） */
  status: number;
  elapsedMs: number;
  /** fetch 抛出的异常名；没抛就是 '-' */
  errorName: string;
  /** 响应体前 200 字（HTML 错误页也能看出是哪个站） */
  bodyPreview: string;
  /** 这条动作一共试过哪些地址（按顺序） */
  attemptedUrls: string[];
}

export const BODY_PREVIEW_CHARS = 200;

function emptyDiagnostics(method: string, url: string): HttpDiagnostics {
  return {
    method,
    url,
    status: 0,
    elapsedMs: 0,
    errorName: '-',
    bodyPreview: '',
    attemptedUrls: url ? [url] : [],
  };
}

function toDiagnostics(result: RawResult | null, attemptedUrls: string[]): HttpDiagnostics {
  if (!result) return { ...emptyDiagnostics('', ''), attemptedUrls };
  return {
    method: result.method,
    url: result.url,
    status: result.status,
    elapsedMs: result.elapsedMs,
    errorName: result.errorName || '-',
    bodyPreview: result.bodyText.slice(0, BODY_PREVIEW_CHARS),
    attemptedUrls,
  };
}

async function send(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<RawResult> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const started = Date.now();
  const method = (init.method ?? 'GET').toUpperCase();
  /**
   * M3R10 §3：这是**唯一**真正发请求的地方（自检 / chat / 拉列表都走它），
   * 所以代理改写挂在这里就一次覆盖全部调用点。DEV 下把方舟/灵绘的地址换成
   * dev server 的 `/__px/...`；生产环境它是恒等函数（判据 §5-6：产物无 `__px`）。
   *
   * `result.url` 记的是**实际打出去的地址**：用户在「技术细节」里看到的应当是真
   * 请求，而不是用户填的原始地址（否则排查时会以为写错了）。
   */
  const target = rewriteForDevProxy(url);
  let timedOut = false;
  const timer = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;

  try {
    const response = await fetchImpl(target, { ...init, signal: controller?.signal });
    const bodyText = await response.text();
    return {
      method,
      url: target,
      status: response.status,
      ok: response.ok,
      bodyText,
      contentType: response.headers?.get?.('content-type') ?? null,
      timedOut: false,
      networkFailed: false,
      networkMessage: '',
      errorName: '',
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'Error';
    /**
     * M3R11 §1（两段判定）：浏览器里 TypeError 既可能是「被 CORS 拦」，也可能是
     * 「请求被拒但读不到详情」（方舟的 401 不带 ACAO）。**只有探一次预检才分得开**：
     * 探的是用户填的原始地址（不是 DEV 代理路径 —— 代理是本地同源，探它没有意义）。
     *
     * 探针失败/超时一律返回 false，绝不抛 —— 分类器不该因为诊断动作而崩。
     */
    const corsPreflightPassed =
      !timedOut && errorName === 'TypeError'
        ? await preflightOk(url, {
            fetchImpl: (target, init) => fetchImpl(target, init as RequestInit),
            timeoutMs: Math.min(PREFLIGHT_TIMEOUT_MS, timeoutMs),
          })
        : undefined;
    return {
      method,
      url,
      status: 0,
      ok: false,
      bodyText: '',
      contentType: null,
      timedOut,
      networkFailed: !timedOut,
      networkMessage: error instanceof Error ? error.message : String(error),
      errorName,
      elapsedMs: Date.now() - started,
      corsPreflightPassed,
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function resolveFetch(deps: ClientDeps): FetchLike | null {
  if (deps.fetchImpl) return deps.fetchImpl;
  return typeof fetch === 'function' ? (fetch as FetchLike) : null;
}

function toError(result: RawResult): AIError {
  const error = classifyFailure({
    status: result.status || undefined,
    bodyText: result.bodyText,
    payload: parseJsonSafely(result.bodyText),
    timedOut: result.timedOut,
    networkFailed: result.networkFailed,
    contentType: result.contentType,
    // M3R10 §1：这两个字段是「CORS 还是网络不通」的唯一区分依据
    errorName: result.errorName || undefined,
    elapsedMs: result.elapsedMs,
    // M3R11 §1：第二段判定结论（只有 TypeError 时才探过）
    corsPreflightPassed: result.corsPreflightPassed,
  });
  return withModelContext(error, result.bodyText);
}

/**
 * M3R9 §1-④ / §3：错误文案里补上「是哪个模型出的问题」。
 *
 * 只在能确定模型名时补，且只补这两类——它们**天生跟模型绑定**：
 * - `SYNC_NOT_SUPPORTED`（1212）：生图/视频模型被拿去发同步 chat；
 * - `MODEL_NOT_ALLOWED`（404 + 分组不允许）：这把 key 的分组没有该模型权限。
 *
 * 不在这里拼模型名的地方（`runSelfTest` 内）会用自己的 `input.model` 兜底 —— 因为
 * `RawResult` 不带请求体，看不出刚才用的是哪个模型。
 */
function withModelContext(error: AIError, bodyText: string, model?: string): AIError {
  if (error.code === AIErrorCode.SYNC_NOT_SUPPORTED) {
    const name = model ?? extractModelFromBody(bodyText);
    return { ...error, userMessage: syncNotSupportedMessage(name) };
  }
  if (error.code === AIErrorCode.MODEL_NOT_ALLOWED) {
    const name = model ?? extractModelFromBody(bodyText);
    return { ...error, userMessage: modelNotAllowedMessage(name) };
  }
  return error;
}

/**
 * 有些站会把模型名写进错误体的 `model` / 文案里（灵绘的 model_not_allowed 就带）；
 * 挖得到就用它，让提示能指名道姓。
 */
export function extractModelFromBody(bodyText: string): string | undefined {
  const payload = parseJsonSafely(bodyText);
  if (payload && typeof payload === 'object') {
    const root = payload as Record<string, unknown>;
    const direct = root.model ?? (root.error as Record<string, unknown> | undefined)?.model;
    if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();
  }
  return undefined;
}

/**
 * 从三种响应体里取文本：
 * - `openai`：`choices[0].message.content`（字符串或 parts 数组）
 * - `anthropic`：`content[].text`
 * - `responses`：`output_text`，或 `output[].content[].text`（两种形状都见过）
 *
 * **取不到就返回 ''，不抛错**：连通性自检只看 status（M3R4 §4.1 要求「防御式」）。
 */
export function extractContent(payload: unknown, protocol: ClientProtocol): string {
  const root = payload as
    | {
        choices?: Array<{ message?: { content?: unknown } }>;
        content?: Array<{ type?: string; text?: string }>;
        output_text?: unknown;
        output?: unknown;
      }
    | undefined;
  if (protocol === 'anthropic') {
    const blocks = root?.content;
    if (Array.isArray(blocks)) {
      return blocks
        .map((block) => (typeof block?.text === 'string' ? block.text : ''))
        .join('')
        .trim();
    }
    return '';
  }
  if (protocol === 'responses') {
    if (typeof root?.output_text === 'string') return root.output_text.trim();
    const output = root?.output;
    if (Array.isArray(output)) {
      return output
        .map((item) => {
          const content = (item as { content?: unknown } | null)?.content;
          if (typeof content === 'string') return content;
          if (!Array.isArray(content)) return '';
          return content
            .map((part) =>
              part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
                ? (part as { text: string }).text
                : '',
            )
            .join('');
        })
        .join('')
        .trim();
    }
    return '';
  }
  const content = root?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
      .trim();
  }
  return '';
}

function extractUsage(payload: unknown): TokenUsage | undefined {
  const usage = (payload as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!usage) return undefined;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return undefined;
  const total = Number(usage.total_tokens ?? prompt + completion);
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    total_tokens: Number.isFinite(total) ? total : 0,
  };
}

function buildHeaders(input: ProviderInput, protocol: ClientProtocol): Record<string, string> {
  if (protocol === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': input.apiKey,
      'anthropic-version': '2023-06-01',
      // 浏览器直连需要显式允许（官方会检查这个头）；有后端代理时无害
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${input.apiKey}`,
  };
}

export interface ProbeResult {
  ok: boolean;
  /** 实际命中的地址（用户据此确认 /v1 有没有拼对） */
  url: string;
  status: number;
  elapsedMs: number;
  content?: string;
  usage?: TokenUsage;
  error?: AIError;
  /**
   * 这次自检**实际用的是哪个模型**（M3R9 §1-④）。UI 要把它显示出来
   * （`连通正常（用 gemini-3.8-flash 测试 @ /v1）`）——否则用户看到
   * 「model_not_allowed」也不知道是哪个模型被拒了。
   */
  testedModel?: string;
  /** 模型是从哪来的：列表拉到的 / 用户模型表里的（UI 可据此措辞） */
  modelSource?: 'listed' | 'connection';
  /** 技术细节（METHOD / URL / 状态 / 耗时 / error.name / 响应前 200 字） */
  diagnostics?: HttpDiagnostics;
}

/**
 * 生图/视频/音频模型的标记词（M3R9 §1-②，R7a 补 audio）：**按「包含」判断，不锚定开头** ——
 * 真名几乎都带厂商前缀（`doubao-seedance-2-5-260628` / `qwen-image-2.1` / `gpt-image-2.5-flare`
 * / `speech-2.8-hd`），按任务书写的「不以…开头」会把这些全放过去，然后拿视频模型去发同步 chat ——
 * 那正是要修的故障本身。所以这里放宽成包含匹配，宁可多挡（挡错了用户还能手填模型名）。
 *
 * R7a：`speech` / `tts` / `audio` 一并挡住 —— 音频模型（TTS）没有 `/chat/completions`，
 * 拿它发同步自检只会收一句用户看不懂的 404。
 */
const NON_SYNC_MODEL_PATTERN =
  /image|video|vidu|seedance|cogview|cogvideox|seedream|minimax-h3|speech|tts|audio/i;

/**
 * 能力标签里哪些能发同步 chat。
 *
 * `audio` **不在**这里：音频生成（TTS）走的是另一条端点，不属于同步对话。
 * 只有 `caps` 为空（判断不了能力）时才按名字兜底，见 `canSyncTest`。
 */
const SYNC_CAPS: readonly string[] = ['text', 'vision'];

/** 这个模型能不能用来做同步自检：有 caps 就按 caps，没有就按名字猜（猜不出 = 可以） */
export function canSyncTest(modelId: string, caps?: readonly string[]): boolean {
  const name = modelId.trim();
  if (!name) return false;
  if (caps && caps.length > 0) return caps.some((cap) => SYNC_CAPS.includes(cap));
  // 判断不了能力 → 挑名字看着像文本的；认不出是生图/视频就当文本（宁可试一次）
  return !NON_SYNC_MODEL_PATTERN.test(name);
}

/** 从站上拉到的列表里挑第一个「像文本」的模型（M3R9 §1-②） */
export function pickListedTextModel(models: readonly string[]): string | undefined {
  // 有明确生图/视频前缀的先排除；剩下按站上给的顺序取第一个
  return models.find((name) => canSyncTest(name)) ?? models.find((name) => name.trim() !== '');
}

/**
 * 连通性自检（M3R9 §1 改造）——**按这把 key 的真实能力**来测，不再硬编码厂商默认模型。
 *
 * ```
 * ① model 已由调用方选定（见 AIConfigPanel 的决策树）——
 *    优先用「站上拉到的第一个文本模型」，没有才退回模型表里的文本模型
 * ② 候选模型都过不了能力过滤（只有生图/视频）→ 直接 NO_SYNC_MODEL，**不发请求**（§2）
 * ③ 按【协议 + 模型】发请求，max_tokens/max_output_tokens = 1，body 只有一句 "ping"
 * ④ 结果里带上实际用的模型（testedModel）与实际命中的地址（url）
 * ```
 *
 * 请求体形态由协议决定（M3R4 §4.1 起没变）：anthropic → /messages、responses → /responses、
 * 其余 → /chat/completions；地址候选见 `endpointCandidates`。
 */
export async function runSelfTest(input: ProviderInput, deps: ClientDeps = {}): Promise<ProbeResult> {
  const protocol = input.protocol ?? 'openai';
  const fetchImpl = resolveFetch(deps);
  const timeoutMs = deps.timeoutMs ?? input.timeoutMs ?? SELF_TEST_TIMEOUT_MS;

  if (!fetchImpl) {
    return {
      ok: false,
      url: '',
      status: 0,
      elapsedMs: 0,
      error: makeError(AIErrorCode.NETWORK_ERROR, '当前环境没有 fetch（不是浏览器？）'),
      diagnostics: emptyDiagnostics('', ''),
    };
  }
  if (!isValidBaseUrl(input.baseUrl)) {
    return {
      ok: false,
      url: '',
      status: 0,
      elapsedMs: 0,
      error: makeError(AIErrorCode.UNKNOWN, `base_url 不合法：${input.baseUrl}`, {
        userMessage: '服务地址要以 http:// 或 https:// 开头，例如 https://api.deepseek.com/v1',
        retryable: false,
      }),
      diagnostics: emptyDiagnostics('', input.baseUrl),
    };
  }

  /**
   * M3R9 §2：候选模型全都不能做同步自检（这条连接里只有生图/视频模型）→
   * **一个字节都不发**，直接给可执行的提示。这是本次改动的核心之一：
   * 以前会拿生图模型去 POST 同步 chat，收回来的 1212/400 用户完全看不懂。
   */
  const candidates = input.syncCandidates;
  const syncable = candidates?.filter((item) => canSyncTest(item.modelId, item.caps)) ?? [];
  if (candidates && candidates.length > 0 && syncable.length === 0) {
    return {
      ok: false,
      url: '',
      status: 0,
      elapsedMs: 0,
      error: makeError(
        AIErrorCode.NO_SYNC_MODEL,
        `这条连接里的 ${candidates.length} 个模型都是生图/视频（它们不支持同步 chat）：${candidates
          .map((item) => item.modelId)
          .join(', ')}`,
      ),
      diagnostics: emptyDiagnostics('', ''),
    };
  }

  /**
   * 用哪个模型测：调用方（UI）已经把「站上拉到的第一个文本模型」放进 `input.model`；
   * 客户端只做最后一道兜底 —— 万一传进来的是生图/视频，退回候选里可用的那个。
   */
  const requested = input.model.trim();
  const fallback = syncable.find((item) => item.modelId.trim() !== '')?.modelId ?? '';
  const model = requested !== '' && canSyncTest(requested) ? requested : fallback || requested;

  if (model === '') {
    return {
      ok: false,
      url: '',
      status: 0,
      elapsedMs: 0,
      error: makeError(AIErrorCode.MODEL_NOT_FOUND, '模型名为空', {
        userMessage: '先填一个模型名（或点「拉取模型列表」从站上取）',
      }),
      diagnostics: emptyDiagnostics('', ''),
    };
  }

  const kind: EndpointKind = endpointKindFor(protocol);
  const body =
    protocol === 'anthropic'
      ? {
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }
      : protocol === 'responses'
        ? {
            // OpenAI 的 /responses：入参叫 input、上限叫 max_output_tokens（没有 messages/max_tokens）
            model,
            input: 'ping',
            max_output_tokens: 1,
          }
        : {
            model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false,
          };

  let last: { result: RawResult; error: AIError } | null = null;
  const tried: string[] = [];
  const probeMethod = 'POST';

  for (const url of endpointCandidates(input.baseUrl, kind)) {
    tried.push(url);
    const result = await send(
      url,
      { method: 'POST', headers: buildHeaders(input, protocol), body: JSON.stringify(body) },
      timeoutMs,
      fetchImpl,
    );

    if (result.ok) {
      const payload = parseJsonSafely(result.bodyText);
      if (payload === undefined) {
        // 200 但不是 JSON（例如中转站返回了 HTML 首页）——不是可用的 API 地址
        return {
          ok: false,
          url,
          status: result.status,
          elapsedMs: result.elapsedMs,
          error: withModelContext(toError(result), result.bodyText, model),
          testedModel: model,
          diagnostics: toDiagnostics(result, tried),
        };
      }
      return {
        ok: true,
        url,
        status: result.status,
        elapsedMs: result.elapsedMs,
        content: extractContent(payload, protocol),
        usage: extractUsage(payload),
        testedModel: model,
        diagnostics: toDiagnostics(result, tried),
      };
    }

    const error = withModelContext(toError(result), result.bodyText, model);
    last = { result, error };
    // 只有"地址可能不对"这类错误值得换下一个候选；key/余额/限流换地址也没用。
    // M3R9：model_not_allowed 是**权限**问题（地址与 key 都对），换地址也没用，别浪费一次请求。
    const worthAnotherUrl =
      result.status !== 404
        ? result.networkFailed || result.timedOut
        : error.code === AIErrorCode.MODEL_NOT_FOUND;
    if (!worthAnotherUrl) {
      return {
        ok: false,
        url,
        status: result.status,
        elapsedMs: result.elapsedMs,
        error,
        testedModel: model,
        diagnostics: toDiagnostics(result, tried),
      };
    }
  }

  return {
    ok: false,
    url: last?.result.url ?? '',
    status: last?.result.status ?? 0,
    elapsedMs: last?.result.elapsedMs ?? 0,
    error: last?.error ?? makeError(AIErrorCode.NETWORK_ERROR, '没有任何可用地址'),
    testedModel: model,
    diagnostics: { ...toDiagnostics(last?.result ?? null, tried), method: last ? probeMethod : '-' },
  };
}

/** 正式对话（M3 里只给 M4 用；M3 只用 runSelfTest，绝不发真实请求） */
export async function chat(
  input: ProviderInput,
  request: AIRequest,
  deps: ClientDeps = {},
): Promise<AIResponse> {
  const protocol = input.protocol ?? 'openai';
  const fetchImpl = resolveFetch(deps);
  const timeoutMs = deps.timeoutMs ?? input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!fetchImpl) {
    return {
      success: false,
      error: makeError(AIErrorCode.NETWORK_ERROR, '当前环境没有 fetch（不是浏览器？）'),
    };
  }

  const kind: EndpointKind = endpointKindFor(protocol);
  const body =
    protocol === 'anthropic'
      ? {
          model: request.model || input.model,
          messages: request.messages,
          max_tokens: request.max_tokens,
          temperature: request.temperature,
        }
      : protocol === 'responses'
        ? {
            // responses 只认 input / max_output_tokens；把多轮拼成一段输入，保持可用
            model: request.model || input.model,
            input: request.messages
              .map((message) => `${message.role}: ${message.content}`)
              .join('\n\n'),
            max_output_tokens: request.max_tokens,
            temperature: request.temperature,
          }
        : {
            model: request.model || input.model,
            messages: request.messages,
            max_tokens: request.max_tokens,
            temperature: request.temperature,
          };

  let lastError: AIError | null = null;
  for (const url of endpointCandidates(input.baseUrl, kind)) {
    const result = await send(
      url,
      { method: 'POST', headers: buildHeaders(input, protocol), body: JSON.stringify(body) },
      timeoutMs,
      fetchImpl,
    );
    if (result.ok) {
      const payload = parseJsonSafely(result.bodyText);
      if (payload === undefined) return { success: false, error: toError(result) };
      return {
        success: true,
        content: extractContent(payload, protocol),
        usage: extractUsage(payload),
      };
    }
    lastError = toError(result);
    const worthAnotherUrl = result.networkFailed || result.status === 404 || result.timedOut;
    if (!worthAnotherUrl) return { success: false, error: lastError };
  }
  return { success: false, error: lastError ?? fromThrown(new Error('没有可用地址')) };
}

export interface ListModelsResult {
  ok: boolean;
  models: string[];
  url: string;
  error?: AIError;
  /** 技术细节（与连通性自检各给一份，不混用） */
  diagnostics?: HttpDiagnostics;
}

/** 200 但解析不出 `data[]`：说明这不是 OpenAI 格式的模型列表接口 */
export const NON_OPENAI_LIST_MESSAGE =
  '接口返回的不是 OpenAI 格式，无法自动列出，请用预设标签或手填';

/** 从 `{data:[{id}]}` / `{models:[{name}]}` / `["a","b"]` 三种常见形状里取模型名 */
export function extractModelNames(payload: unknown): string[] {
  const seen = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim() !== '') seen.add(value.trim());
  };

  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (typeof item === 'string') push(item);
      else if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        push(rec.id ?? rec.name ?? rec.model);
      }
    }
    return [...seen];
  }

  const root = payload as { data?: unknown; models?: unknown } | undefined;
  const list = root?.data ?? root?.models;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === 'string') push(item);
      else if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        push(rec.id ?? rec.name ?? rec.model);
      }
    }
  } else if (typeof list === 'string') {
    push(list);
  }
  return [...seen];
}

/**
 * 拉取模型列表：`GET {base_url}/v1/models`；**失败时自动试不带 /v1 的地址**，
 * 都失败才报错（UI 据此降级为手填，不影响保存配置）。
 *
 * 协议无关（M3R4 §4.1）：`responses` 协议同样走 `/models`；这家没有这个接口时
 * 走 404 → `MODELS_NOT_LISTED` 的 info 分支（不是网络错误）。
 */
export async function listModels(input: ProviderInput, deps: ClientDeps = {}): Promise<ListModelsResult> {
  const fetchImpl = resolveFetch(deps);
  const timeoutMs = deps.timeoutMs ?? input.timeoutMs ?? SELF_TEST_TIMEOUT_MS;
  if (!fetchImpl) {
    return {
      ok: false,
      models: [],
      url: '',
      error: makeError(AIErrorCode.NETWORK_ERROR, '当前环境没有 fetch（不是浏览器？）'),
      diagnostics: emptyDiagnostics('GET', ''),
    };
  }
  if (!isValidBaseUrl(input.baseUrl)) {
    return {
      ok: false,
      models: [],
      url: '',
      error: makeError(AIErrorCode.UNKNOWN, `base_url 不合法：${input.baseUrl}`, {
        userMessage: '服务地址要以 http:// 或 https:// 开头',
      }),
      diagnostics: emptyDiagnostics('GET', input.baseUrl),
    };
  }

  let lastError: AIError | null = null;
  let lastResult: RawResult | null = null;
  let lastName = '';
  const tried: string[] = [];

  for (const url of endpointCandidates(input.baseUrl, 'models')) {
    tried.push(url);
    const result = await send(
      url,
      { method: 'GET', headers: buildHeaders(input, 'openai') },
      timeoutMs,
      fetchImpl,
    );

    if (result.ok) {
      const payload = parseJsonSafely(result.bodyText);
      if (payload === undefined) {
        lastError = toError(result);
        lastResult = result;
        lastName = url;
        continue;
      }
      const names = extractModelNames(payload);
      if (names.length === 0) {
        // 200 但结构不对：不是 OpenAI 格式（不是网络问题，也不该报「连不上」）
        lastError = makeError(
          AIErrorCode.INVALID_RESPONSE,
          `响应里没有模型列表：${result.bodyText.slice(0, 200)}`,
          { userMessage: NON_OPENAI_LIST_MESSAGE },
        );
        lastResult = result;
        lastName = url;
        continue;
      }
      return { ok: true, models: names, url, diagnostics: toDiagnostics(result, tried) };
    }

    if (result.status === 404) {
      /**
       * M3R9 §3：**同样是 404，含义可能完全相反**，必须看响应体里的 code：
       * - `model_not_allowed` / 「分组不允许」→ key 的分组没有权限（这是权限问题，
       *   要点「拉取模型列表」换模型，绝不能糊成「这家没有列表接口」）；
       * - 光秃秃的 404（火山方舟）→ 这家压根没有 /models 接口，用预设标签即可。
       */
      const permissionDenied =
        bodyMentionsModelNotAllowed(result.bodyText) ||
        bodyMentionsModelNotAllowed(extractVendorCode(parseJsonSafely(result.bodyText)) ?? '');
      if (permissionDenied) {
        // 权限问题与地址无关：换下一个候选只会拿别的 404 把这句话覆盖掉，就地停
        lastError = makeError(
          AIErrorCode.MODEL_NOT_ALLOWED,
          `HTTP 404 + 权限业务码（${url}）：${result.bodyText.slice(0, 200)}`,
        );
        lastResult = result;
        lastName = url;
        break;
      }
      lastError = makeError(
        AIErrorCode.MODELS_NOT_LISTED,
        `HTTP 404（${url} 没有模型列表接口）：${result.bodyText.slice(0, 200)}`,
      );
    } else {
      lastError = toError(result);
    }
    lastResult = result;
    lastName = url;
    const worthAnotherUrl = result.networkFailed || result.status === 404 || result.timedOut;
    if (!worthAnotherUrl) break;
  }

  const baseMessage =
    lastError?.userMessage ?? '拉取模型列表失败：可以先手填模型名，不影响保存配置';
  return {
    ok: false,
    models: [],
    url: lastName,
    error: lastError
      ? {
          ...lastError,
          message: `${lastError.message}（已尝试：${tried.join(' → ')}）`,
          userMessage:
            lastError.code === AIErrorCode.MODELS_NOT_LISTED
              ? `${baseMessage}。拉取失败也可以手填模型名`
              : `${baseMessage}。拉取失败可以先手填模型名，不影响保存配置`,
        }
      : makeError(AIErrorCode.NETWORK_ERROR, `没有可用地址（已尝试：${tried.join(' → ')}）`),
    diagnostics: toDiagnostics(lastResult, tried),
  };
}
