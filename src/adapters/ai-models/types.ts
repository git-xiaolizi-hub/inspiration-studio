/**
 * AI 调用适配器的接口契约（对应 CHARTER §3）。
 * M1 只定接口，不实现网络请求；真正的实现放在 M3。
 */

export type AIRole = 'system' | 'user' | 'assistant';

export interface MultipartContent {
  type: 'text' | 'image_url';
  text?: string;
  /** data: URI 或 http(s) 链接 */
  image_url?: { url: string };
}

export interface AIMessage {
  role: AIRole;
  content: string | MultipartContent[];
}

export interface AIRequest {
  model: string;
  messages: AIMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export enum AIErrorCode {
  TIMEOUT = 'timeout',
  UNAUTHORIZED = 'unauthorized', // 401
  FORBIDDEN = 'forbidden', // 403，站端限制
  MODEL_NOT_FOUND = 'model_not_found', // 404
  /** 404 发生在「拉模型列表」时：这家根本没有 /models 接口（火山方舟就是这样），不是错误 */
  MODELS_NOT_LISTED = 'models_not_listed',
  RATE_LIMIT = 'rate_limit', // 429
  INSUFFICIENT_QUOTA = 'insufficient_quota', // 余额不足，从响应 body 判断
  INVALID_RESPONSE = 'invalid_response', // 非 JSON
  IMAGE_NOT_SUPPORTED = 'image_not_supported', // code 1210
  INVALID_IMAGE_FORMAT = 'invalid_image_format', // code 1214
  /** 业务码 1212：这个模型不支持 SYNC（同步）调用 —— 生图/视频模型基本都这样 */
  SYNC_NOT_SUPPORTED = 'sync_not_supported',
  /**
   * `404 + code: model_not_allowed`：**地址、key 都是对的**，只是这把 key 的分组
   * 没有那个模型的权限。与「这家没有 /models 接口」（也是 404）含义完全不同，
   * 必须看响应体里的 code 区分（M3R9 §3）。
   */
  MODEL_NOT_ALLOWED = 'model_not_allowed',
  /** 这条连接里只有生图/视频模型：同步自检无从下手，**不发请求**（M3R9 §2） */
  NO_SYNC_MODEL = 'no_sync_model',
  /**
   * 浏览器直连被 CORS 拦死（M3R10）：服务器不返回 `access-control-allow-origin`，
   * fetch 抛 `TypeError: Failed to fetch`。**与「网络不可达」不是一回事** ——
   * 地址与 key 可能完全正确，用户去改它们是白费功夫。
   */
  CORS_BLOCKED = 'cors_blocked',
  /**
   * M3R11 §1：**预检通过，但这次请求仍被拒且浏览器读不到详情**（fetch 抛 TypeError）。
   * 方舟的 401 不带 `access-control-allow-origin`，所以「key 无效」在浏览器里的
   * 表现与「被 CORS 拦」一模一样 —— 必须先探 OPTIONS 才分得开（见 `shared/cors.ts`）。
   * 与 `CORS_BLOCKED` 的处置完全不同：**去核对 key / 模型名，不要换厂商**。
   */
  REJECTED_UNREADABLE = 'rejected_unreadable',
  /**
   * M3R11 §3：`InvalidEndpointOrModel.NotFound`。火山方舟只认**版本化模型 ID**
   * （`doubao-seedance-2-5-260628`）或端点 ID（`ep-xxxxxxxx`），写族名
   * （`doubao-seed-2.1-pro` / `doubao-seedance-2.5`）一律 404。
   */
  VERSIONED_MODEL_ID_REQUIRED = 'versioned_model_id_required',
  NETWORK_ERROR = 'network_error',
  UNKNOWN = 'unknown',
}

export interface AIError {
  code: AIErrorCode;
  /** 给开发者的原始错误 */
  message: string;
  /** 给小白用户的人话提示（UI 直接展示这一条） */
  userMessage: string;
  retryable: boolean;
}

export type AIResponse =
  { success: true; content: string; usage?: TokenUsage } | { success: false; error: AIError };

/** 单个服务商的适配器；UI 只依赖这个接口，不感知具体厂商 */
export interface AIProvider {
  readonly providerId: string;
  chat(request: AIRequest): Promise<AIResponse>;
  /** 拉取模型列表（M3 用于填充下拉框） */
  listModels(): Promise<string[]>;
}

export interface ProviderConfig {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}
