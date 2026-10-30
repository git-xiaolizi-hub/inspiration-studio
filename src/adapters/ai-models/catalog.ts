/**
 * 厂商 / 连接 / 模型 三层数据模型（M3R §1 §2 §3 §7）。
 *
 * 为什么不是「一套 base_url + 一个 key + 一个模型名」（M3 的 AIConfig）：
 * 用户会同时用多家站、以及同一家的多个分组（不同 key / 不同倍率）。把 key 绑在
 * 「连接」上，界面上就不会出现「切了厂商但 key 还是上一家的」这种事故。
 *
 * M3R6 的修正：**模型表也挂在连接下**（不再是厂商级）。同一家站的不同分组能用的模型
 * 本来就不同（某中转的 claude 组只有 opus-5-5，gpt 组只有 gpt 系），所以一条连接 =
 * 一套（地址 + 凭证 + 倍率）+ 这套凭证能看到的那批模型；切连接，模型表整体跟着换。
 *
 * 三个不变量（都有测试）：
 * 1. **key 与 base_url 同生共死**：它们只存在于 `Connection` 里，切连接必然一起切；
 * 2. **模型表是唯一事实**：上层选模型只看 `ModelEntry.caps`，不再让用户声明"我用文本/图片"；
 * 3. **拉列表失败不影响保存**：本模块的保存路径完全不依赖网络结果。
 *
 * 存储位置：沿用 `settings` 表（IndexedDB），key = `ai-catalog`。
 */
import { getSetting, putSetting } from '../../core/storage';

export const AI_CATALOG_KEY = 'ai-catalog';

/**
 * 能力标签：上层「要文本/要生图/要视频」全部按它筛。
 *
 * `audio`（R7a）= **音频生成**（TTS / 配音 / 音乐），**不是语音识别**。
 * 语音识别仍然走设置页「语音识别」卡的独立通道（`local-whisper` / 云端 STT），
 * 与这里的模型表无关。顺序即 UI 勾选列的顺序，audio 追加在最后。
 */
export type ModelCap = 'text' | 'vision' | 'image' | 'video' | 'audio';

export const MODEL_CAPS: readonly ModelCap[] = ['text', 'vision', 'image', 'video', 'audio'];

export const CAP_LABELS: Record<ModelCap, string> = {
  text: '文本',
  vision: '视觉',
  image: '生图',
  video: '视频',
  audio: '音频',
};

/**
 * 协议三种（M3R4 §4.1）：`responses` 是 OpenAI 新一代的 `/responses` 端点，
 * 与 `/chat/completions` 的请求体不同（`input` / `max_output_tokens`）。
 * **未实测**：手上没有能跑 Responses 的 key，UI 上必须带「实验性·未验证」。
 */
export type ProviderProtocol = 'openai' | 'anthropic' | 'responses';

/**
 * 一条「连接」= 一套 base_url + key + 这套凭证能看到的那批模型。
 *
 * 同一家站的不同分组能用的模型不同（某中转 claude 组只有 opus-5-5，gpt 组只有 gpt 系），
 * 所以 `models` 放在这里而不是 `Provider` 上 —— 切连接时模型表整体跟着换。
 */
/**
 * 计费方式（2026-10-29 委托人提出）：比一个裸数字好懂。
 * 它**决定「multiplier 那个数字」是什么意思**，算式本身不变（官方价 × multiplier）。
 *
 * - relay        中转站：multiplier = 分组倍率（基础价按 ¥1=$1 折算）
 * - domestic     国内模型按量：multiplier = 1
 * - overseas     国外模型官方按量：multiplier = 汇率（默认 6.8）
 * - subscription 官方订阅（包月）：multiplier = 0，单次不记账
 */
export type BillingMode = 'relay' | 'domestic' | 'overseas' | 'subscription';

export const BILLING_MODES: readonly BillingMode[] = ['relay', 'domestic', 'overseas', 'subscription'];

/** 切到某种方式时用的默认 multiplier */
export const BILLING_DEFAULT_MULTIPLIER: Record<BillingMode, number> = {
  relay: 1,
  domestic: 1,
  overseas: 6.8,
  subscription: 0,
};

/** 海外官方按量的默认汇率（人民币 / 美元） */
export const DEFAULT_OVERSEAS_RATE = 6.66;

export const BILLING_MODE_LABELS: Record<BillingMode, string> = {
  relay: '中转站',
  domestic: '国内按量',
  subscription: '官方订阅',
  overseas: '国外按量',
};

/** 某计费方式的默认倍率；「国外按量」吃实时汇率（拿不到时用 DEFAULT_OVERSEAS_RATE） */
export function defaultMultiplierFor(mode: BillingMode, usdCny = DEFAULT_OVERSEAS_RATE): number {
  return mode === 'overseas' ? usdCny : BILLING_DEFAULT_MULTIPLIER[mode];
}

export interface Connection {
  id: string;
  /** 备注，用户自己写，如「智谱官方」「灵绘 gpt 组」 */
  label: string;
  baseUrl: string;
  /** 可空（未填）。本地部署通常没有 key */
  apiKey: string;
  protocol?: ProviderProtocol;
  /**
   * 计费倍率（M3R4 §4.2）：该 key 所在分组的倍率，默认 1。
   * 用途：官方单价 × 倍率 = 实付估算。缺省 / 非法值一律按 1 处理。
   */
  multiplier?: number;
  /**
   * 每种计费方式各自记住用户填过的倍率。
   * 切换方式不该冲掉别的方式的数字：中转站填 0.35、订阅填 0.05，来回切都还在。
   * 导出备份会一起带走（这就是「用户自己填的东西必须存下来」）。
   */
  modeMultipliers?: Partial<Record<BillingMode, number>>;
  /** 计费方式；缺省时按 multiplier 反推（0=订阅，其余=中转站） */
  billingMode?: BillingMode;
  /**
   * 这条连接自己的模型表（M3R6 §1）。
   * 新建连接时按厂商默认模型预填一条（见 `defaultModelsFor`），用户不用先面对空表。
   */
  models: ModelEntry[];
}

/** 倍率默认值：官方价、无中转加价 */
export const DEFAULT_MULTIPLIER = 1;

/**
 * 协议下拉的三项（顺序固定）。M3R6 §4：可见文字只留协议名，端点后缀进 `title`。
 *
 * 为什么缩短：协议列宽 120px，`OpenAI 兼容（/chat/completions）` 会被截成
 * 「OpenAI 兼容（/…」。端点写进 `title`，鼠标悬停仍能看到完整路径。
 * `responses` 的「实验性」不能省：本应用没有实测过它。
 */
export interface ProtocolOption {
  value: ProviderProtocol;
  /** 下拉里看得见的那几个字（必须短） */
  label: string;
  /** 悬停才展开的端点说明（`{base}` 由调用方替换成这一行的 base_url） */
  title: string;
}

export const PROTOCOL_OPTIONS: readonly ProtocolOption[] = [
  { value: 'openai', label: 'OpenAI 兼容', title: 'POST {base}/chat/completions' },
  { value: 'anthropic', label: 'Anthropic', title: 'POST {base}/messages' },
  { value: 'responses', label: 'Responses（实验性）', title: 'POST {base}/responses（未验证）' },
];

/** 协议下拉的悬停说明（把 `{base}` 换成这条连接自己的地址；空地址时保留占位） */
export function protocolEndpointTitle(protocol: ProviderProtocol, baseUrl?: string): string {
  const option = PROTOCOL_OPTIONS.find((item) => item.value === protocol) ?? PROTOCOL_OPTIONS[0];
  const base = (baseUrl ?? '').trim().replace(/\/+$/, '');
  return option.title.replace('{base}', base === '' ? '{base}' : base);
}

/** 倍率填错时的提示（本地拒绝，不写库） */
export const MULTIPLIER_INVALID_MESSAGE =
  '倍率要填一个 ≥ 0 的数字（例如 1、0.35、2.5）；这次输入没有保存';

export function isValidMultiplier(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 解析输入框的倍率：'' = 默认 1；NaN / 负数 → null（调用方拒绝并提示） */
export function parseMultiplier(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return DEFAULT_MULTIPLIER;
  const value = Number(text);
  return isValidMultiplier(value) ? value : null;
}

/** 读倍率（缺省 / 脏数据一律 1，不让旧配置因为少了这个字段失效） */
export function multiplierOf(connection?: { multiplier?: number } | null): number {
  return connection && isValidMultiplier(connection.multiplier)
    ? connection.multiplier
    : DEFAULT_MULTIPLIER;
}

/** 实付估算 = 官方单价 × 倍率（保留到分） */
export function applyMultiplier(officialPrice: number, multiplier?: number): number {
  const factor = multiplierOf({ multiplier });
  return Math.round(officialPrice * factor * 100) / 100;
}

/** 价格核验状态：未核实时 UI 必须显示「未核实」（不许把没核实的写成数字） */
export type PriceStatus = '已核实' | '未核实';

/** 模型表里的一行（挂在 `Connection.models` 上） */
export interface ModelEntry {
  id: string;
  /** 菜单显示名 */
  displayName: string;
  /** 实际请求模型 */
  modelId: string;
  contextLength?: number;
  /**
   * 这个窗口是谁定的：
   * - `catalog` —— 名录里的真实值（models.dev / LiteLLM 同步来的），应用自己填的；
   * - `manual`  —— 用户手动改过；
   * - `default` —— 名录里没有，按「文本 1M」猜的。
   * 界面靠它区分「应用知道」和「用户自己说的」，别再让人凭感觉勾。
   */
  contextSource?: 'catalog' | 'manual' | 'default';
  caps: ModelCap[];
  /** 如「免费测试」「本地部署推荐」 */
  note?: string;
  /**
   * 价格原文（如「输入 0.80 / 输出 2.80（元/百万 token）」）。
   * **null = 未核实**：承接方标「未核实 / 未整理」的一律 null，绝不折算、绝不编数字。
   */
  price?: string | null;
  priceStatus?: PriceStatus;
  /**
   * 是否出现在可选列表里（M3R6 §3）：缺省 = 启用。
   *
   * 语义是「这条模型要不要参与选择」，**不是**「当前用哪个」：模型表可以多行同时启用，
   * 这次用哪个由生成时选（或 `pickModel` 按能力自动挑）。取消勾选 = 临时停用，不必删行。
   */
  enabled?: boolean;
}

export interface Provider {
  /** zhipu | deepseek | ark | openai | anthropic | custom:<uuid> */
  id: string;
  name: string;
  /** 内置厂商 vs 用户自建 */
  builtin: boolean;
  /** 每条连接各自带一套模型表（M3R6：`models` 从厂商挪到连接） */
  connections: Connection[];
  activeConnectionId?: string;
  /**
   * 该厂商上次用的模型（**行 id**，在 `activeConnection.models` 里）——切回该厂商时自动带出。
   * 不属于当前连接的 id 会被忽略（见 `defaultModelIdFor`）。
   */
  lastModelId?: string;
}

export interface AICatalog {
  providers: Provider[];
  updatedAt: number;
  /**
   * 配置组（= 厂商 + base_url）的显示顺序，由「配置模型」弹窗拖拽后写入。
   *
   * 为什么存在 catalog 里而不是 settings：它描述的是这份配置本身怎么排，
   * 跟着导出/导入一起走才合理（换台机器导入别人的配置，顺序也该一起来）。
   * 存的是 `groupKeyOf()` 的键；表里没有的组按出现顺序排在最后。
   */
  groupOrder?: string[];
}

/** 配置组 = 厂商 + 地址（不是连接：同一地址的多把 Key 属于同一组） */
export function groupKeyOf(providerId: string, baseUrl: string): string {
  return `${providerId}|${baseUrl.trim().replace(/\/+$/, '').toLowerCase()}`;
}

/* ------------------------------------------------------------------ */
/* 厂商元数据（顺序固定：智谱 → DeepSeek → 火山方舟 → Kimi → 阿里百炼 →  */
/* MiniMax → Anthropic → OpenAI → Gemini → 本地部署 → 灵绘 → 自定义）      */
/* ------------------------------------------------------------------ */

export type BuiltinProviderId =
  | 'zhipu'
  | 'deepseek'
  | 'ark'
  | 'moonshot'
  | 'dashscope'
  | 'minimax'
  | 'openai'
  | 'gemini'
  | 'anthropic'
  | 'linghui'
  | 'local';

export type VendorKind = 'official' | 'relay' | 'local';

/**
 * 纯 Web 版能不能直连这家（M3R10 §2；M3R11 §0 更正）。
 *
 * 依据是**真浏览器里的实测**（2026-10-18/19，见 `docs/reference/cors-matrix.md`）：
 * - `'blocked'` → `OPTIONS` 预检就被拒（灵绘：nginx **403**，零个 `access-control-*` 头），
 *   浏览器里必抛 `TypeError`；UI 要在厂商 chip 上标「· 浏览器版不可用」；
 * - `'ok'`      → 预检放行 + 响应可读（401/404 都算通，因为 JS 拿到了响应对象）；
 * - `'unknown'` → 没测过（含所有自定义厂商：用户多半填中转站，但地址未知，
 *   不能凭"是自定义"就断定被拦，那样会误伤一个本来能用的站）。
 *
 * ⚠️ **M3R11 更正**：火山方舟（豆包）是 `'ok'` —— 上一轮把它记成 `blocked` 是因为只
 * 看了未带 key 的 401（**方舟的 401 恰好不带 ACAO**）。真 key 实测：`OPTIONS` → 204、
 * 业务响应（404 `InvalidEndpointOrModel.NotFound`）完全可读。**别再用「401 读不到」
 * 推断 CORS**。
 *
 * UI 只读这个字段，**不得**在 JSX 里写厂商名字符串做判断。
 */
export type WebCorsStatus = 'blocked' | 'ok' | 'unknown';

export interface VendorMeta {
  id: BuiltinProviderId;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  /** 切到该厂商时默认选中的模型（空串 = 文档没给这家的模型，模型表默认空） */
  defaultModelId: string;
  /** 一句说明（显示在厂商名下面） */
  note: string;
  /** 国内直连不了，需要走中转 */
  needsRelay?: boolean;
  /** 厂商类别：官方 / 中转 / 本地（本地 = 需 ComfyUI / 自托管） */
  kind: VendorKind;
  /** 文档没给这家的预设模型时，标签行下方显示的说明 */
  tagHint?: string;
  /** 纯 Web 版（浏览器直连）能不能用；见 `WebCorsStatus` */
  webCors: WebCorsStatus;
}

/** chip 上「这家浏览器版用不了」的后缀（§2 要求逐字） */
export const WEB_CORS_BLOCKED_SUFFIX = '· 浏览器版不可用';

/**
 * 「本地部署」类厂商点选模型后的说明（M3R2 §3）。
 *
 * 只做占位：本应用这一版**不会**去调用它（`pickModel` 直接跳过 local 类厂商），
 * 真正接入留给画板/节点功能。
 */
export const LOCAL_DEPLOY_NOTICE =
  '本地部署模型需要在 ComfyUI 里跑；本应用后续支持用节点方式接入（画板/节点功能），现在可以先记下来。';

export const VENDOR_META: Record<BuiltinProviderId, VendorMeta> = {
  zhipu: {
    id: 'zhipu',
    name: '智谱 / glm / cog',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModelId: 'glm-5.3-flash',
    note: '版本段是 /v4（不是 /v1）；有免费模型，最适合先跑通。',
    kind: 'official',
    webCors: 'ok',
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    defaultModelId: 'deepseek-flash',
    note: '兼容 OpenAI 协议；地址不带 /v1，客户端会先试 /v1 再试原地址；便宜、上下文长。',
    kind: 'official',
    webCors: 'ok',
  },
  ark: {
    id: 'ark',
    name: '火山方舟 / doubao-seed',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModelId: 'doubao-seed-2-1-pro-260628',
    note: '版本段是 /v3；这家没有 /models 接口，模型请用预设标签选（不影响保存）。只认版本化模型 ID（形如 doubao-seed-2-1-pro-260628）或端点 ID（ep-xxxxxxxx），族名会 404。',
    kind: 'official',
    /** M3R11 §0：真 key 实测 OPTIONS 204 + 业务响应可读（旧判定错在只看未带 key 的 401） */
    webCors: 'ok',
  },
  moonshot: {
    id: 'moonshot',
    name: '月之暗面 / kimi',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModelId: 'kimi-k3.1-pro',
    note: '地址自带 /v1；国内已实测直连（返回 401 = 服务可达，只是没带 key）。',
    kind: 'official',
    webCors: 'ok',
  },
  dashscope: {
    id: 'dashscope',
    name: '阿里百炼 / qwen / wan',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModelId: 'qwen3.8-flash',
    note: '地址自带 /v1（compatible-mode）；国内已实测直连（401 = 可达，只是没带 key）。',
    kind: 'official',
    tagHint:
      '文档里没有给这家的云端模型标签（qwen-image-2.1 是本地部署形态，见「本地部署」厂商）：模型名请手填，或从站上拉取后加入模型表。',
    webCors: 'ok',
  },
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    protocol: 'openai',
    baseUrl: 'https://api.minimax.io/v1',
    defaultModelId: 'MiniMax-M3',
    note: '地址自带 /v1；国内已实测直连（401 = 可达，只是没带 key）。',
    kind: 'official',
    tagHint:
      '文档里没有给这家的云端模型标签（minimax-h3 是本地部署形态，见「本地部署」厂商）：模型名请手填，或从站上拉取后加入模型表。',
    webCors: 'ok',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI / gpt',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModelId: 'gpt-6.1-sol',
    note: '官方地址自带 /v1；国内需中转，把连接地址换成一家中转站即可。',
    needsRelay: true,
    kind: 'official',
    webCors: 'unknown',
  },
  gemini: {
    id: 'gemini',
    name: 'Google / gemini',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModelId: 'gemini-4-argon',
    note: '国内已实测 HTTP 000 超时（连不上），必须标「国内需中转」。',
    needsRelay: true,
    kind: 'official',
    webCors: 'unknown',
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic / claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModelId: 'claude-opus-5-5',
    note: '官方 Claude 走 /v1/messages 协议（不是 OpenAI 的 /chat/completions）；国内需中转。',
    needsRelay: true,
    kind: 'official',
    webCors: 'unknown',
  },
  linghui: {
    id: 'linghui',
    name: '灵绘 · 中转站',
    protocol: 'openai',
    baseUrl: 'https://xn--ai-xg4e312c.com',
    defaultModelId: 'claude-opus-5-5',
    note: '开发者推荐的中转站；地址不带 /v1 也通（已实测 401）。',
    kind: 'relay',
    webCors: 'blocked',
  },
  local: {
    id: 'local',
    name: '本地部署',
    protocol: 'openai',
    baseUrl: '',
    defaultModelId: 'qwen-image-2.1',
    note: '需 ComfyUI / 自托管：地址由你自己填，本应用这一版不会去调用它。',
    kind: 'local',
    /**
     * **不猜**：ComfyUI 默认**不**返回 `access-control-*` 头（要显式带
     * `--enable-cors-header` 才有），所以"本地 = 同源 = 一定放行"是错的推断；
     * 而且地址由用户填、本版压根不调用它 —— 无从实测，如实记 unknown。
     */
    webCors: 'unknown',
  },
};

/**
 * 内置厂商的固定顺序（不含「自定义」槽位）
 *
 * M3R4 §2：与「灵绘」互换位置 —— 本地部署不属于中转，往前挪；custom 大概率也是中转，
 * 与灵绘相邻。UI 用的是这个数组，不是 VENDOR_META 对象字面量的顺序。
 */
export const BUILTIN_PROVIDER_ORDER: readonly BuiltinProviderId[] = [
  'zhipu',
  'deepseek',
  'ark',
  'moonshot',
  'dashscope',
  'minimax',
  'anthropic',
  'openai',
  'gemini',
  'local',
  'linghui',
];

/** 固定显示顺序；`custom` 是所有非内置厂商的落点（排在最后） */
export const PROVIDER_SLOTS: readonly (BuiltinProviderId | 'custom')[] = [
  ...BUILTIN_PROVIDER_ORDER,
  'custom',
];

export const CUSTOM_SLOT_LABEL = '自定义';

export function isCustomProvider(provider: Pick<Provider, 'id' | 'builtin'>): boolean {
  return !provider.builtin || provider.id.startsWith('custom:');
}

/** 按 §3 固定顺序排序（自定义厂商插在「自定义」槽位，按创建顺序） */
export function sortProviders(providers: Provider[]): Provider[] {
  const rank = (provider: Provider): number => {
    if (provider.builtin && provider.id !== 'custom') {
      const index = PROVIDER_SLOTS.indexOf(provider.id as BuiltinProviderId);
      return index === -1 ? PROVIDER_SLOTS.length : index;
    }
    return PROVIDER_SLOTS.indexOf('custom');
  };
  return providers
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => rank(a.provider) - rank(b.provider) || a.index - b.index)
    .map((item) => item.provider);
}

/* ------------------------------------------------------------------ */
/* 按地址认厂商（R7a §C）                                                */
/* ------------------------------------------------------------------ */

/**
 * 内置厂商的 canonical hostname：**从 `VENDOR_META.baseUrl` 现算**，不手抄 ——
 * 地址改了这里自动跟着变，不会出现「catalog 里是 A、匹配表里是 B」的分叉。
 * `local` 没有固定地址（baseUrl 为空），因此不在表里（共 10 家）。
 */
export const PROVIDER_HOSTS: readonly { id: BuiltinProviderId; host: string }[] =
  BUILTIN_PROVIDER_ORDER.map((id) => {
    const base = VENDOR_META[id].baseUrl.trim();
    let host = '';
    if (base !== '') {
      try {
        host = new URL(base).hostname.toLowerCase();
      } catch {
        host = '';
      }
    }
    return { id, host };
  }).filter((item) => item.host !== '');

/**
 * 历史 / 地区别名（R7a 修正）：厂商换了域名，但老配置里还存着旧地址，
 * 认厂商时必须一并命中，否则用户粘贴旧地址会被判成「自定义」。
 */
const PROVIDER_HOST_ALIASES: readonly { id: BuiltinProviderId; host: string }[] = [
  // MiniMax 官方现用 api.minimax.io；下面是历史域名
  { id: 'minimax', host: 'api.minimax.chat' },
  { id: 'minimax', host: 'api.minimaxi.com' },
];

/** 完全相等，或一方是另一方的子域（`api.deepseek.com` ↔ `deepseek.com`） */
export function sameOrSubdomain(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  if (a === b) return true;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * 按地址认厂商（R7a §C）。
 *
 * 动机：推荐配置的弹窗只让用户填 base_url，没有「选厂商」这一步；而 `Provider` 是连接的
 * 父级，必须知道归属才能把连接挂对地方。认不出就返回 null，调用方落到「自定义」。
 *
 * 规则：
 * 1. `new URL()` 解析不出来 → null；**没写协议的**先补 `https://` 再解析
 *    （用户常常直接粘 `api.deepseek.com`，这是唯一一处比任务书宽松的地方）；
 * 2. 只看 `hostname`：忽略协议、端口、路径、末尾斜杠、大小写；
 * 3. 与内置 hostname **完全相等或互为子域**；
 * 4. 匹配不到 / 空串 / 乱码 → null（不抛错）。
 */
export function urlToProvider(raw: string): BuiltinProviderId | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let hostname = '';
  try {
    hostname = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (hostname === '') return null;
  const hit = [...PROVIDER_HOSTS, ...PROVIDER_HOST_ALIASES].find((item) =>
    sameOrSubdomain(hostname, item.host),
  );
  return hit?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* 预设标签（§2 的表格，原样）                                          */
/* ------------------------------------------------------------------ */

export type PresetGroup =
  | 'zhipu'
  | 'deepseek'
  | 'ark'
  | 'moonshot'
  | 'dashscope'
  | 'minimax'
  | 'relay'
  | 'local';

export interface PresetTag {
  /** 按钮上的文字（原样来自文档的「标签」列） */
  label: string;
  modelId: string;
  caps: ModelCap[];
  note?: string;
  /**
   * 上下文窗口（token）。只有官方文档给了数字才填（R7a 补：kimi 1,048,576 / qwen 1M / MiniMax 1M）。
   * 不给 = 不填，模型行上留空让用户自己填。
   */
  contextLength?: number;
  /**
   * 价格原文（照抄文档，如「输入 0.80 / 输出 2.80」）。
   * **null = 未核实**：文档写「未核实 / 未整理」或干脆没写的一律 null。
   */
  price: string | null;
  priceStatus: PriceStatus;
}

export const PRESET_TAGS: Record<PresetGroup, readonly PresetTag[]> = {
  zhipu: [
    {
      label: 'glm-5.3-flash（文本+视觉，推荐）',
      modelId: 'glm-5.3-flash',
      caps: ['text', 'vision'],
      note: '推荐',
      price: '输入 0.80 / 输出 2.80（元/百万 token）',
      priceStatus: '已核实',
    },
    {
      label: 'glm-4.7-flash（文本，免费测试）',
      modelId: 'glm-4.7-flash',
      caps: ['text'],
      note: '免费测试',
      price: '0（元/百万 token）',
      priceStatus: '已核实',
    },
    {
      label: 'glm-4v-flash（文本+视觉，免费测试）',
      modelId: 'glm-4v-flash',
      caps: ['text', 'vision'],
      note: '免费测试',
      price: '0（元/百万 token）',
      priceStatus: '已核实',
    },
    {
      label: 'cogview-3-flash（生图，免费测试）',
      modelId: 'cogview-3-flash',
      caps: ['image'],
      note: '免费测试',
      price: '0（元/张）',
      priceStatus: '已核实',
    },
    {
      label: 'cogvideox-flash（视频，免费测试，拥堵）',
      modelId: 'cogvideox-flash',
      caps: ['video'],
      note: '免费测试·常 429',
      price: '0（元/百万 token）',
      priceStatus: '已核实',
    },
    // ↓ 文档里标注「未整理 / 未核实」的三条：价格一律 null，只抄备注
    {
      label: 'glm-image（旗舰生图，推荐英文提示词）',
      modelId: 'glm-image',
      caps: ['image'],
      note: '旗舰生图，推荐英文提示词',
      price: null,
      priceStatus: '未核实',
    },
    {
      label: 'cogview-4（生图，中文支持更好）',
      modelId: 'cogview-4',
      caps: ['image'],
      note: '生图，中文支持更好',
      price: null,
      priceStatus: '未核实',
    },
    {
      label: 'cogvideox-3（旗舰视频）',
      modelId: 'cogvideox-3',
      caps: ['video'],
      note: '旗舰视频',
      price: null,
      priceStatus: '未核实',
    },
  ],
  deepseek: [
    {
      label: 'deepseek-flash（文本+视觉，推荐）',
      modelId: 'deepseek-flash',
      caps: ['text', 'vision'],
      note: '推荐',
      price: '输入 2.00 / 输出 8.00（元/百万 token；高峰价，空闲半价）',
      priceStatus: '已核实',
    },
    {
      label: 'deepseek-v4-pro（文本）',
      modelId: 'deepseek-v4-pro',
      caps: ['text'],
      note: '不支持图像',
      price: '输入 9.00 / 输出 27.00（元/百万 token）',
      priceStatus: '已核实',
    },
  ],
  ark: [
    {
      label: 'doubao-seedance-2-5-260628（视频，推荐）',
      modelId: 'doubao-seedance-2-5-260628',
      caps: ['video'],
      note: '推荐',
      price: '见视频计价表（元/百万 token）',
      priceStatus: '已核实',
    },
    {
      label: 'doubao-seedream-5-0-pro-260628（生图，推荐）',
      modelId: 'doubao-seedream-5-0-pro-260628',
      caps: ['image'],
      note: '推荐',
      price: '0.30 元/张（>261 万像素 0.60 元/张）',
      priceStatus: '已核实',
    },
    {
      label: 'doubao-seed-2-1-pro-260628（文本+视觉）',
      modelId: 'doubao-seed-2-1-pro-260628',
      caps: ['text', 'vision'],
      price: '输入 6.00 / 输出 30.00（元/百万 token）',
      priceStatus: '已核实',
    },
  ],
  moonshot: [
    /**
     * R7a：kimi-k3 下线（官方已由 K3.1 接替）。
     * 依据 platform.kimi.ai/docs/models：`kimi-k3.1-pro` = "3T-class model with **native visual
     * understanding** and a **1M-token context**"；官方定位 coding / agent，**写作不推荐**。
     * 价格：委托人给的口径 + 2026-10-24 发布会稿（输入 ¥13 / 输出 ¥68，命中缓存输入 ¥1.3）。
     */
    {
      label: 'kimi-k3.1-pro（文本+视觉，1M 上下文）',
      modelId: 'kimi-k3.1-pro',
      caps: ['text', 'vision'],
      contextLength: 1048576,
      note: '原生视觉理解；官方定位 coding / agent，写作场景不建议用',
      price: '输入 13 / 输出 68（元/百万 token；命中缓存输入 1.3）',
      priceStatus: '已核实',
    },
    {
      label: 'kimi-k3.1-pro-highspeed（同智能，输出更快）',
      modelId: 'kimi-k3.1-pro-highspeed',
      caps: ['text', 'vision'],
      contextLength: 1048576,
      note: '同 K3.1 Pro 智能，输出快 2–3×；官方定位 coding / agent，写作不推荐；单价未在官方价目页核实',
      price: null,
      priceStatus: '未核实',
    },
  ],
  /**
   * R7a：原来这里是空数组（文档只给了厂商介绍）。现在按委托人指定的 7 条补上；
   * caps 依据阿里云百炼的模型能力表，价格依据百炼价格页（单位：元/张、元/秒 各自标在价格里）。
   */
  dashscope: [
    {
      label: 'qwen3.8-max（旗舰，1M 上下文）',
      modelId: 'qwen3.8-max',
      caps: ['text', 'vision'],
      contextLength: 1000000,
      note: '推理 + 视觉理解 + Agent 自动化；夜间错峰有折扣',
      price: '输入 12 / 输出 36（元/百万 token）',
      priceStatus: '已核实',
    },
    {
      label: 'qwen3.8-flash（1M 上下文，便宜）',
      modelId: 'qwen3.8-flash',
      caps: ['text', 'vision'],
      contextLength: 1000000,
      note: '推理 + 视觉理解，最大输出 131.1K；性价比档',
      price: '输入 0.8 / 输出 2.7（元/百万 token）',
      priceStatus: '已核实',
    },
    {
      label: 'qwen-image-3.0-pro（生图，主打文字排版）',
      modelId: 'qwen-image-3.0-pro',
      caps: ['image'],
      note: '复杂版面 / 小字渲染（10px、12 语言、20+ 字体），含图片编辑',
      price: '0.25 元/张（1K）/ 0.50 元/张（2K）',
      priceStatus: '已核实',
    },
    {
      label: 'qwen-image-3.0（生图，批量便宜）',
      modelId: 'qwen-image-3.0',
      caps: ['image'],
      note: '文生图 + 图片编辑；复杂图文指令一次生成',
      price: '0.18 元/张（1K / 2K）',
      priceStatus: '已核实',
    },
    {
      label: 'wan2.7-image-pro（生图，4K 高清）',
      modelId: 'wan2.7-image-pro',
      caps: ['image'],
      note: '万相系列，4K 高清',
      price: '0.50 元/张',
      priceStatus: '已核实',
    },
    {
      label: 'wan2.7-image（生图，批量出一致风格）',
      modelId: 'wan2.7-image',
      caps: ['image'],
      note: '万相系列，批量出一致风格',
      price: '0.20 元/张',
      priceStatus: '已核实',
    },
    {
      label: 'wan3.0-video（视频）',
      modelId: 'wan3.0-video',
      caps: ['video'],
      note: '单次最长 30 秒；输入可含文 / 图 / 音',
      price: '0.45–1.80 元/秒',
      priceStatus: '已核实',
    },
  ],
  /**
   * R7a：同样从空数组补上 4 条。caps 依据 platform.minimax.io 的模型介绍
   * （M3 = "Frontier **multimodal** coding model with 1M context"；H3 = 视频按秒计费；
   * speech-2.8-hd = 同步/异步语音合成）。
   */
  minimax: [
    {
      label: 'MiniMax-M3.1-Flash-Preview（1M，多模态）',
      modelId: 'MiniMax-M3.1-Flash-Preview',
      caps: ['text', 'vision'],
      contextLength: 1000000,
      note: '三模态输入（文 / 图 / 视频）；仅 MiniMax Code / Token Plan 渠道开放；官方未公布单价',
      price: null,
      priceStatus: '未核实',
    },
    {
      label: 'MiniMax-M3（1M 上下文，原生多模态）',
      modelId: 'MiniMax-M3',
      caps: ['text', 'vision'],
      contextLength: 1000000,
      note: '原生多模态（文 / 图 / 视频输入）；官方价目页未见这一档单价',
      price: null,
      priceStatus: '未核实',
    },
    {
      label: 'MiniMax-H3（视频）',
      modelId: 'MiniMax-H3',
      caps: ['video'],
      note: '海螺视频模型，按秒计费（768P）',
      price: '0.08 美元/秒（768P）',
      priceStatus: '已核实',
    },
    {
      label: 'speech-2.8-hd（音频，语音合成）',
      modelId: 'speech-2.8-hd',
      caps: ['audio'],
      note: '语音合成（TTS），不是语音识别；异步单次最长 100 万字符',
      price: '3.50 元/万字符（中国站官方价）',
      priceStatus: '已核实',
    },
  ],
  relay: [
    {
      label: 'claude-opus-5-5（文本+视觉，推荐）',
      modelId: 'claude-opus-5-5',
      caps: ['text', 'vision'],
      // §2：Claude 的四档价格按文档原文写进备注，不折算成输入/输出两栏
      note: '需中转 · fable-5-1 $50 / opus-5-5 $20 / sonnet-5-5 $10 / haiku-5-5 $0.5',
      price: null,
      priceStatus: '未核实',
    },
    {
      label: 'gpt-6.1-sol（文本+视觉，推荐）',
      modelId: 'gpt-6.1-sol',
      caps: ['text', 'vision'],
      note: '需中转',
      price: null,
      priceStatus: '未核实',
    },
    /**
     * R7a：`gpt-image-2.5` 这个 id 不存在（历史笔误）→ 拆成官方实际的两条。
     * 依据 developers.openai.com/api/docs/models/gpt-image-2.5-flare 与 `-sunburst`：
     * "Input modalities: text, image / Output modalities: image"，
     * 官方计费（每百万 token）文本输入 $5、图片输入 $8、图片输出 $30；两者同价。
     * 中转站按分组倍率另算，所以价格字段仍然 null（与其余 relay 条目同一口径）。
     */
    {
      label: 'gpt-image-2.5-flare（生图，快）',
      modelId: 'gpt-image-2.5-flare',
      caps: ['image'],
      note: '需中转 · 小模型，快；官方 $5 文 / $8 图输入 / $30 出图（每百万 token）',
      price: null,
      priceStatus: '未核实',
    },
    {
      label: 'gpt-image-2.5-sunburst（生图，编辑精度最高）',
      modelId: 'gpt-image-2.5-sunburst',
      caps: ['image'],
      note: '需中转 · 编辑精度与画质最高；与 flare 同价（每百万 token $5 文 / $8 图 / $30 出图）',
      price: null,
      priceStatus: '未核实',
    },
    {
      label: 'gemini-4-argon（文本+视觉，推荐，擅长写作）',
      modelId: 'gemini-4-argon',
      caps: ['text', 'vision'],
      note: '需中转 · 擅长写作',
      price: null,
      priceStatus: '未核实',
    },
    {
      label: 'gemini-4-carbon（文本+视觉，刚发布，写作更强）',
      modelId: 'gemini-4-carbon',
      contextLength: 1048576,
      caps: ['text', 'vision'],
      note: '需中转 · **尚未正式发布**，现阶段用户还用不了；等开放后可直接用',
      price: null,
      priceStatus: '未核实',
    },
  ],
  local: [
    {
      label: 'qwen-image-2.1（生图，本地部署推荐）',
      modelId: 'qwen-image-2.1',
      caps: ['image'],
      note: '本地部署',
      price: null,
      priceStatus: '未核实',
    },
    {
      label: 'minimax-h3（视频，本地部署推荐）',
      modelId: 'minimax-h3',
      caps: ['video'],
      note: '本地部署',
      price: null,
      priceStatus: '未核实',
    },
  ],
};

/**
 * 官方厂商各自能用的「中转组」子集：同一批模型定义只写一份（`PRESET_TAGS.relay`），
 * 这里只决定哪家显示哪几条。
 */
const VENDOR_RELAY_FILTER: Partial<Record<BuiltinProviderId, readonly string[]>> = {
  openai: ['gpt-6.1-sol', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'],
  anthropic: ['claude-opus-5-5'],
  gemini: ['gemini-4-argon', 'gemini-4-carbon'],
};

/** 自定义厂商拿到「中转 + 本地」两组标签；内置厂商各拿自己那组 */
export function presetTagsFor(provider: Pick<Provider, 'id' | 'builtin'>): readonly PresetTag[] {
  if (isCustomProvider(provider)) return [...PRESET_TAGS.relay, ...PRESET_TAGS.local];
  const id = provider.id as BuiltinProviderId;
  const filter = VENDOR_RELAY_FILTER[id];
  if (filter) return PRESET_TAGS.relay.filter((tag) => filter.includes(tag.modelId));
  const group: PresetGroup | undefined = id === 'linghui' ? 'relay' : (id as PresetGroup);
  return (group && PRESET_TAGS[group]) || [];
}

/** 按 modelId 在**全部**预设里找一条（重名时以先出现的为准，够用） */
export function presetTagById(modelId: string): PresetTag | undefined {
  const id = modelId.trim();
  if (id === '') return undefined;
  for (const group of Object.values(PRESET_TAGS)) {
    const hit = group.find((tag) => tag.modelId === id);
    if (hit) return hit;
  }
  return undefined;
}

/** 新建自定义厂商时的两个模板：中转站 / 本地部署 */
export type CustomTemplate = 'relay' | 'local';

export const CUSTOM_TEMPLATES: Record<CustomTemplate, { label: string; defaultModelId: string; note: string }> = {
  relay: { label: '中转 / 自定义站', defaultModelId: 'claude-opus-5-5', note: 'OpenAI 兼容中转站，base_url 有的带 /v1 有的不带' },
  local: { label: '本地部署', defaultModelId: 'qwen-image-2.1', note: '本机或局域网服务（如 ComfyUI / 自建推理），通常不需要 key' },
};

/* ------------------------------------------------------------------ */
/* 初始值                                                             */
/* ------------------------------------------------------------------ */

let idCounter = 0;

/** 稳定但不需可读的 id（crypto.randomUUID 在 http:// 非 localhost 下不可用，留兜底） */
export function makeId(prefix: string): string {
  idCounter += 1;
  const cryptoRef = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
  const random =
    cryptoRef && typeof cryptoRef.randomUUID === 'function'
      ? cryptoRef.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}-${random}${idCounter}`;
}

/**
 * 厂商的默认模型行（M3R6 §1.4）：新建连接时预填一条，用户不用先面对空表。
 * 行 id 用 `makeId`：同一家厂商的两条连接各有一份预填行，行 id 不能撞（否则跨连接改错行）。
 */
function defaultModelEntry(vendor: VendorMeta, tag: PresetTag | undefined): ModelEntry {
  return {
    id: makeId('model'),
    displayName: tag?.label ?? vendor.defaultModelId,
    modelId: tag?.modelId ?? vendor.defaultModelId,
    contextLength: tag?.contextLength,
    caps: tag ? [...tag.caps] : ['text', 'vision'],
    note: tag?.note,
    price: tag?.price ?? null,
    priceStatus: tag?.priceStatus ?? '未核实',
    enabled: true,
  };
}

function findTag(modelId: string): PresetTag | undefined {
  for (const group of Object.keys(PRESET_TAGS) as PresetGroup[]) {
    const tag = PRESET_TAGS[group].find((item) => item.modelId === modelId);
    if (tag) return tag;
  }
  return undefined;
}

/**
 * 新连接的默认模型表：内置厂商按文档默认模型预填一条；
 * 文档没给模型的那两家（阿里百炼 / MiniMax）→ 空表，不编模型名。
 * 自定义厂商由 `createCustomProvider` 自己给（模板不同）。
 */
function defaultModelsFor(provider: Provider): ModelEntry[] {
  if (!provider.builtin) return [];
  const meta = VENDOR_META[provider.id as BuiltinProviderId];
  if (!meta || meta.defaultModelId === '') return [];
  return [defaultModelEntry(meta, findTag(meta.defaultModelId))];
}

/** 模型行的深拷贝：`caps` 另给一份数组，行 id 换新（复制模型表 / 预填都用它） */
function cloneModelEntry(model: ModelEntry): ModelEntry {
  return { ...model, id: makeId('model'), caps: [...model.caps] };
}

/** 深拷贝一整张模型表（每条都有新 id） */
export function cloneModelList(models: readonly ModelEntry[]): ModelEntry[] {
  return models.map(cloneModelEntry);
}

/**
 * 空的（未配置 key 的）目录：内置厂商都在，连接 0 条。
 *
 * M3R6：模型表挂在连接下，所以「没有连接 = 没有模型表」。第一条连接建出来的时候
 * （点「＋ 新建连接」/ 直接填第一行 / 点预设标签 / 手动添加）才按厂商默认模型预填一条。
 */
export function createDefaultCatalog(): AICatalog {
  return {
    providers: BUILTIN_PROVIDER_ORDER.map((id) => {
      const meta = VENDOR_META[id];
      return {
        id: meta.id,
        name: meta.name,
        builtin: true,
        connections: [],
        activeConnectionId: undefined,
        lastModelId: undefined,
      };
    }),
    updatedAt: 0,
  };
}

/* 归一化（库里的脏数据 / 手改过的导出文件）                              */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** 未知协议一律回落到 openai（旧配置没有这个字段） */
function asProtocol(value: unknown): ProviderProtocol {
  return value === 'anthropic' || value === 'responses' ? value : 'openai';
}

/** 倍率：缺字段 = 1；负数 / NaN / 字符串 = 1（脏数据不该让整条连接失效） */
/** 只留下四种方式里「解析得出来」的那些；旧存档的 relayMultiplier 迁到 relay 位 */
function asModeMultipliers(
  value: unknown,
  legacyRelay?: unknown,
): Partial<Record<BillingMode, number>> | undefined {
  const out: Partial<Record<BillingMode, number>> = {};
  if (value && typeof value === 'object') {
    for (const mode of BILLING_MODES) {
      const raw = (value as Record<string, unknown>)[mode];
      if (isValidMultiplier(raw)) out[mode] = raw;
    }
  }
  if (out.relay === undefined && isValidMultiplier(legacyRelay)) out.relay = legacyRelay;
  return Object.keys(out).length > 0 ? out : undefined;
}
function asMultiplier(value: unknown): number {
  return isValidMultiplier(value) ? value : DEFAULT_MULTIPLIER;
}

function asCaps(value: unknown): ModelCap[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ModelCap>();
  for (const item of value) {
    if (typeof item === 'string' && (MODEL_CAPS as readonly string[]).includes(item)) {
      seen.add(item as ModelCap);
    }
  }
  return MODEL_CAPS.filter((cap) => seen.has(cap));
}

/** 显式值优先；老数据没有这个字段时按 multiplier 反推（0 = 订阅，其余按中转站） */
function asBillingMode(value: unknown, multiplier: number | undefined): BillingMode {
  const raw = asString(value).trim();
  if (raw === 'relay' || raw === 'domestic' || raw === 'subscription' || raw === 'overseas') return raw;
  return multiplier === 0 ? 'subscription' : 'relay';
}

function normalizeConnection(value: unknown): Connection | null {
  const row = asRecord(value);
  if (!row) return null;
  const baseUrl = asString(row.baseUrl).trim();
  const id = asString(row.id).trim();
  if (!id) return null;
  // 模型表在连接里（M3R6）。缺字段 = 空表（老数据 / 手写的导入文件都不该让整条连接失效）
  const models = Array.isArray(row.models)
    ? row.models.map(normalizeModelEntry).filter((item): item is ModelEntry => item !== null)
    : [];
  return {
    id,
    label: asString(row.label).trim(),
    baseUrl,
    apiKey: asString(row.apiKey),
    protocol: asProtocol(row.protocol),
    multiplier: asMultiplier(row.multiplier),
    billingMode: asBillingMode(row.billingMode, asMultiplier(row.multiplier)),

    modeMultipliers: asModeMultipliers(
      (row as { modeMultipliers?: unknown }).modeMultipliers,
      (row as { relayMultiplier?: unknown }).relayMultiplier,
    ),
    models,
  };
}

function asPriceStatus(value: unknown): PriceStatus | undefined {
  return value === '已核实' || value === '未核实' ? value : undefined;
}

/** 价格：字符串 = 原文；null = 明确「未核实」；缺字段 = 用户手填行（不算未核实） */
function asPrice(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  return undefined;
}

function normalizeModelEntry(value: unknown): ModelEntry | null {
  const row = asRecord(value);
  if (!row) return null;
  const modelId = asString(row.modelId).trim();
  const id = asString(row.id).trim();
  // 空 modelId 允许存在：用户刚点「＋ 手动添加」还没来得及填，保存后不该被静默丢掉
  if (!id) return null;
  const contextRaw = row.contextLength;
  const contextLength =
    typeof contextRaw === 'number' && Number.isFinite(contextRaw) && contextRaw > 0
      ? Math.trunc(contextRaw)
      : undefined;
  const sourceRaw = asString(row.contextSource);
  const contextSource =
    sourceRaw === 'catalog' || sourceRaw === 'manual' || sourceRaw === 'default'
      ? (sourceRaw as 'catalog' | 'manual' | 'default')
      : undefined;
  return {
    id,
    displayName: asString(row.displayName).trim() || modelId || '未命名模型',
    modelId,
    contextLength,
    contextSource,
    caps: asCaps(row.caps),
    note: asString(row.note).trim() || undefined,
    price: asPrice(row.price),
    priceStatus: asPriceStatus(row.priceStatus),
    // 缺字段 = 启用（旧配置 / 手填行默认参与选择）
    enabled: row.enabled === false ? false : true,
  };
}

function normalizeProvider(value: unknown): Provider | null {
  const row = asRecord(value);
  if (!row) return null;
  const id = asString(row.id).trim();
  const name = asString(row.name).trim();
  if (!id || !name) return null;
  const connections = Array.isArray(row.connections)
    ? row.connections.map(normalizeConnection).filter((item): item is Connection => item !== null)
    : [];
  const activeRaw = asString(row.activeConnectionId).trim();
  const activeConnectionId = connections.some((item) => item.id === activeRaw)
    ? activeRaw
    : connections[0]?.id;
  // M3R6：模型表在连接里。厂商级的 row.models **不迁移**（未发布，直接丢弃）——
  // 免得出现「同一批模型既在厂商下又在连接里」的两份事实。
  const allModels = connections.flatMap((connection) => connection.models);
  const lastRaw = asString(row.lastModelId).trim();
  const lastModelId = allModels.some((item) => item.id === lastRaw) ? lastRaw : undefined;
  const builtin = id.startsWith('custom:') ? false : row.builtin !== false;
  return {
    id,
    name,
    builtin,
    connections,
    activeConnectionId,
    lastModelId,
  };
}

/** 保证六个槽位都在：库里的数据缺少某个内置厂商时补齐，内置厂商不能被删没 */
export function normalizeCatalog(value: unknown): AICatalog {
  const row = asRecord(value);
  const fallback = createDefaultCatalog();
  if (!row || !Array.isArray(row.providers)) return fallback;

  const parsed = row.providers.map(normalizeProvider).filter((item): item is Provider => item !== null);
  const byId = new Map(parsed.map((provider) => [provider.id, provider]));
  const merged = fallback.providers.map((provider) => byId.get(provider.id) ?? provider);
  const customs = parsed.filter((provider) => isCustomProvider(provider));
  const others = parsed.filter(
    (provider) => !isCustomProvider(provider) && !fallback.providers.some((item) => item.id === provider.id),
  );
  const groupOrder = Array.isArray(row.groupOrder)
    ? row.groupOrder.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : undefined;
  return {
    providers: sortProviders([...merged, ...customs, ...others]),
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
    ...(groupOrder && groupOrder.length > 0 ? { groupOrder } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 读写                                                               */
/* ------------------------------------------------------------------ */

/**
 * 「上次看的是哪个厂商」——**UI 视图状态，不属于 catalog 本体**（M3R8）。
 *
 * 为什么不塞进 `AICatalog`：厂商顺序是固定的（智谱永远第一），`providers[0]` 与
 * 「用户在看谁」无关；把它写进配置文档还会污染导出/导入文件（换台机器导入别人的
 * 配置时，不该连「上次点开的页签」也一起继承）。所以单独一条 settings 记录。
 */
export const AI_ACTIVE_PROVIDER_KEY = 'ai-config-active-provider';

export async function loadActiveProviderId(): Promise<string | null> {
  try {
    const row = await getSetting(AI_ACTIVE_PROVIDER_KEY);
    const id = asString(asRecord(row?.value)?.providerId).trim();
    return id === '' ? null : id;
  } catch {
    // 视图状态读不出来不算错误：调用方会退回「第一条已配置的厂商」
    return null;
  }
}

/** 记住当前厂商（best-effort：写失败不影响配置保存，调用方 fire-and-forget） */
export async function saveActiveProviderId(providerId: string): Promise<void> {
  const id = providerId.trim();
  if (id === '') return;
  await putSetting({
    key: AI_ACTIVE_PROVIDER_KEY,
    value: { providerId: id },
    updatedAt: Date.now(),
  });
}

/**
 * 面板该落在哪个厂商（M3R8 的根因修复）。
 *
 * 顺序：**上次看的**（存在且仍存在）→ **第一条有连接的**（＝真正配置过的那家）→ 第一条。
 *
 * 为什么不能再用 `providers[0]`：厂商顺序固定，智谱恒排第一。用户在 DeepSeek 上
 * 填好连接与模型表之后刷新页面，面板会落回「智谱（0 条连接）」，于是模型表看起来
 * 变成了空表 —— 数据其实一直在库里（见 `catalog-persistence.test.ts` 与 M3R8 报告）。
 */
export function resolveActiveProviderId(catalog: AICatalog, preferred?: string | null): string {
  const wanted = (preferred ?? '').trim();
  if (wanted !== '') {
    const hit = catalog.providers.find((provider) => provider.id === wanted);
    if (hit) return hit.id;
  }
  const configured = catalog.providers.find((provider) => provider.connections.length > 0);
  const fallback = configured ?? catalog.providers[0];
  return fallback?.id ?? PROVIDER_SLOTS[0];
}

export async function loadCatalog(): Promise<AICatalog> {
  const row = await getSetting(AI_CATALOG_KEY);
  if (!row || row.value === undefined) return createDefaultCatalog();
  return normalizeCatalog(row.value);
}

export async function saveCatalog(catalog: AICatalog): Promise<AICatalog> {
  const next: AICatalog = {
    providers: sortProviders(catalog.providers),
    updatedAt: Date.now(),
    // 组的显示顺序也是配置的一部分，别在保存时丢掉
    ...(catalog.groupOrder && catalog.groupOrder.length > 0 ? { groupOrder: catalog.groupOrder } : {}),
  };
  await putSetting({ key: AI_CATALOG_KEY, value: next, updatedAt: next.updatedAt });
  return next;
}

/* ------------------------------------------------------------------ */
/* 纯函数 CRUD（全部返回新对象，UI 只做 setState）                        */
/* ------------------------------------------------------------------ */

export function findProvider(catalog: AICatalog, providerId: string): Provider | undefined {
  return catalog.providers.find((provider) => provider.id === providerId);
}

/** 该厂商当前生效的连接（没有就是 undefined） */
export function activeConnectionFor(catalog: AICatalog, providerId: string): Connection | undefined {
  const provider = findProvider(catalog, providerId);
  if (!provider) return undefined;
  return provider.connections.find((item) => item.id === provider.activeConnectionId);
}

function replaceProvider(catalog: AICatalog, provider: Provider): AICatalog {
  return {
    ...catalog,
    providers: catalog.providers.map((item) => (item.id === provider.id ? provider : item)),
  };
}

export function updateProvider(
  catalog: AICatalog,
  providerId: string,
  patch: Partial<Omit<Provider, 'id'>>,
): AICatalog {
  const provider = findProvider(catalog, providerId);
  if (!provider) return catalog;
  return replaceProvider(catalog, { ...provider, ...patch });
}

export function addConnection(
  catalog: AICatalog,
  providerId: string,
  init: {
    label?: string;
    baseUrl?: string;
    apiKey?: string;
    protocol?: ProviderProtocol;
    multiplier?: number;
    billingMode?: BillingMode;
    modeMultipliers?: Partial<Record<BillingMode, number>>;
    /** 直接指定模型表（内部用：复制模型表时给一份拷贝）；不传 = 厂商默认模型 */
    models?: ModelEntry[];
  } = {},
): { catalog: AICatalog; connection: Connection } {
  const provider = findProvider(catalog, providerId);
  const connection: Connection = {
    id: makeId('conn'),
    label: init.label ?? '新连接',
    baseUrl: init.baseUrl ?? '',
    apiKey: init.apiKey ?? '',
    protocol: init.protocol ?? 'openai',
    multiplier: isValidMultiplier(init.multiplier) ? init.multiplier : DEFAULT_MULTIPLIER,
    billingMode:
      init.billingMode ?? (init.multiplier === 0 ? 'subscription' : 'relay'),
    modeMultipliers: init.modeMultipliers,
    // 新建连接就带一条厂商默认模型（M3R6 §1.4）：不给用户一张空表
    models: init.models ? cloneModelList(init.models) : provider ? defaultModelsFor(provider) : [],
  };
  if (!provider) return { catalog, connection };
  const next = replaceProvider(catalog, {
    ...provider,
    connections: [...provider.connections, connection],
    activeConnectionId: provider.activeConnectionId ?? connection.id,
  });
  return { catalog: next, connection };
}

export function updateConnection(
  catalog: AICatalog,
  providerId: string,
  connectionId: string,
  patch: Partial<Omit<Connection, 'id'>>,
): AICatalog {
  const provider = findProvider(catalog, providerId);
  if (!provider) return catalog;
  // 倍率非法值时直接忽略这个字段（不让 UI 的一时手误写坏配置）
  const { multiplier, ...rest } = patch;
  const safePatch =
    multiplier !== undefined && !isValidMultiplier(multiplier) ? rest : patch;
  return replaceProvider(catalog, {
    ...provider,
    connections: provider.connections.map((item) =>
      item.id === connectionId ? { ...item, ...safePatch } : item,
    ),
  });
}

/** 删连接：删到 0 条是允许的（用户可以先清空再重建） */
export function removeConnection(
  catalog: AICatalog,
  providerId: string,
  connectionId: string,
): AICatalog {
  const provider = findProvider(catalog, providerId);
  if (!provider) return catalog;
  const connections = provider.connections.filter((item) => item.id !== connectionId);
  const activeConnectionId =
    provider.activeConnectionId === connectionId
      ? connections[0]?.id
      : provider.activeConnectionId;
  return replaceProvider(catalog, { ...provider, connections, activeConnectionId });
}

export function setActiveConnection(
  catalog: AICatalog,
  providerId: string,
  connectionId: string,
): AICatalog {
  const provider = findProvider(catalog, providerId);
  if (!provider) return catalog;
  if (!provider.connections.some((item) => item.id === connectionId)) return catalog;
  return replaceProvider(catalog, { ...provider, activeConnectionId: connectionId });
}

/**
 * 「当前连接」现在只剩一个作用：**新加的模型默认存到哪条**（以及配置页里编辑哪张表）。
 * 它**不再**决定哪些模型能用 —— 同一厂商的所有连接里的模型都能被选中、都能生成。
 */
export function activeConnectionOf(provider: Provider): Connection | undefined {
  return provider.connections.find((item) => item.id === provider.activeConnectionId);
}

/** 当前连接的模型表；没有连接 = 空表 */
export function modelsOf(provider: Provider): ModelEntry[] {
  return activeConnectionOf(provider)?.models ?? [];
}

/**
 * 取「当前连接」，没有就顺手建出第 1 条（M3R6）。
 *
 * 用户第一次点预设标签 / 点「＋ 手动添加」时可能还一条连接都没有：这时按
 * 「点＋新建连接」的同一套规则建一条（地址用厂商默认值、模型表用默认模型预填），
 * 否则模型行没有地方可挂。
 */
function ensureActiveConnection(
  catalog: AICatalog,
  providerId: string,
): { catalog: AICatalog; provider: Provider; connection: Connection } | null {
  const provider = findProvider(catalog, providerId);
  if (!provider) return null;
  const existing = activeConnectionOf(provider);
  if (existing) return { catalog, provider, connection: existing };
  const meta = provider.builtin ? VENDOR_META[provider.id as BuiltinProviderId] : undefined;
  const created = addConnection(catalog, providerId, {
    label: provider.builtin ? '默认连接' : provider.name,
    baseUrl: meta?.baseUrl ?? '',
    apiKey: '',
    protocol: meta?.protocol ?? 'openai',
    multiplier: DEFAULT_MULTIPLIER,
  });
  const next = setActiveConnection(created.catalog, providerId, created.connection.id);
  const nextProvider = findProvider(next, providerId);
  if (!nextProvider) return null;
  return { catalog: next, provider: nextProvider, connection: created.connection };
}

/** 这一行属于哪条连接：先看当前连接，再扫其余（导入的旧文件里可能有重号） */
function ownerConnectionOf(provider: Provider, modelRowId: string): Connection | undefined {
  const active = activeConnectionOf(provider);
  if (active && active.models.some((model) => model.id === modelRowId)) return active;
  return provider.connections.find((item) => item.models.some((model) => model.id === modelRowId));
}

/** 点预设标签：补 modelId + caps + 备注；**base_url 已有内容时不覆盖** */
export function applyPresetTag(catalog: AICatalog, providerId: string, tag: PresetTag): AICatalog {
  const ensured = ensureActiveConnection(catalog, providerId);
  if (!ensured) return catalog;
  const { connection } = ensured;
  // 已有同 modelId 的行就不重复添加（点了两次不该出现两行）
  const existing = connection.models.find((model) => model.modelId === tag.modelId);
  if (existing) return updateProvider(ensured.catalog, providerId, { lastModelId: existing.id });

  const entry: ModelEntry = {
    id: makeId('model'),
    displayName: tag.label,
    modelId: tag.modelId,
    contextLength: tag.contextLength,
    caps: [...tag.caps],
    note: tag.note,
    price: tag.price,
    priceStatus: tag.priceStatus,
    enabled: true,
  };
  const next = updateConnection(ensured.catalog, providerId, connection.id, {
    models: [...connection.models, entry],
  });
  return updateProvider(next, providerId, { lastModelId: entry.id });
}

export function addBlankModel(catalog: AICatalog, providerId: string): AICatalog {
  const ensured = ensureActiveConnection(catalog, providerId);
  if (!ensured) return catalog;
  const entry: ModelEntry = {
    id: makeId('model'),
    displayName: '',
    modelId: '',
    caps: ['text'],
    enabled: true,
  };
  const next = updateConnection(ensured.catalog, providerId, ensured.connection.id, {
    models: [...ensured.connection.models, entry],
  });
  return updateProvider(next, providerId, { lastModelId: entry.id });
}

export function updateModel(
  catalog: AICatalog,
  providerId: string,
  modelRowId: string,
  patch: Partial<Omit<ModelEntry, 'id'>>,
): AICatalog {
  const provider = findProvider(catalog, providerId);
  if (!provider) return catalog;
  const owner = ownerConnectionOf(provider, modelRowId);
  if (!owner) return catalog;
  const models = owner.models.map((model) =>
    model.id === modelRowId ? { ...model, ...patch } : model,
  );
  return updateConnection(catalog, providerId, owner.id, { models });
}

/** 删模型行：删到 0 行是允许的（页面不能崩） */
export function removeModel(catalog: AICatalog, providerId: string, modelRowId: string): AICatalog {
  const provider = findProvider(catalog, providerId);
  if (!provider) return catalog;
  const owner = ownerConnectionOf(provider, modelRowId);
  if (!owner) return catalog;
  const models = owner.models.filter((model) => model.id !== modelRowId);
  const next = updateConnection(catalog, providerId, owner.id, { models });
  if (provider.lastModelId !== modelRowId) return next;
  return updateProvider(next, providerId, { lastModelId: models[0]?.id });
}

/**
 * 把**当前连接**的模型表复制到同厂商的另一条连接（M3R6 §1.3）。
 *
 * 解决「同一家站加第二个 key 要把模型表重配一遍」的痛点。**深拷贝**：行 id 全部换新、
 * `caps` 另给一份数组 —— 复制完改一边不会牵动另一边（有测试）。
 * 目标连接原有的模型表会被整体覆盖（`copied` = 写过去几行）。
 */
export function copyModelsToConnection(
  catalog: AICatalog,
  providerId: string,
  targetConnectionId: string,
): { catalog: AICatalog; copied: number } {
  const provider = findProvider(catalog, providerId);
  if (!provider) return { catalog, copied: 0 };
  const source = activeConnectionOf(provider);
  if (!source) return { catalog, copied: 0 };
  const target = provider.connections.find((item) => item.id === targetConnectionId);
  if (!target || target.id === source.id) return { catalog, copied: 0 };
  const models = cloneModelList(source.models);
  return {
    catalog: updateConnection(catalog, providerId, target.id, { models }),
    copied: models.length,
  };
}

/**
 * 当前连接里该用哪一个模型：上次用的 → §2 的默认值 → 表里第一行 → ''。
 *
 * M3R6：只看 `activeConnection.models`。`lastModelId` 属于另一条连接的模型表时会被忽略
 * （切连接 = 换了一整套模型，旧行 id 在这张表里不存在）。
 */
export function defaultModelIdFor(provider: Provider): string {
  const models = modelsOf(provider);
  if (provider.lastModelId && models.some((model) => model.id === provider.lastModelId)) {
    return provider.lastModelId;
  }
  if (provider.builtin) {
    const meta = VENDOR_META[provider.id as BuiltinProviderId];
    const hit = models.find((model) => model.modelId === meta?.defaultModelId);
    if (hit) return hit.id;
  }
  return models[0]?.id ?? '';
}

export interface ActiveSelection {
  provider: Provider | undefined;
  connection: Connection | undefined;
  model: ModelEntry | undefined;
}

/**
 * 切厂商时的「自动带出」：选中的连接 = activeConnectionId（无则 undefined），
 * 选中的模型 = 上次用的（无则默认），**都取自当前连接的那张模型表**。
 */
export function resolveActive(catalog: AICatalog, providerId: string): ActiveSelection {
  const provider = findProvider(catalog, providerId);
  if (!provider) return { provider: undefined, connection: undefined, model: undefined };
  const connection = activeConnectionOf(provider);
  const modelRowId = defaultModelIdFor(provider);
  const model = modelsOf(provider).find((item) => item.id === modelRowId);
  return { provider, connection, model };
}

/* 面向上层：按能力选模型（§7）                                          */
/* ------------------------------------------------------------------ */

export interface PickModelResult {
  ok: boolean;
  provider?: Provider;
  connection?: Connection;
  model?: ModelEntry;
  /** 无可用模型时的可执行提示（告诉用户点哪个预设标签） */
  hint?: string;
}

/**
 * 每个能力的「一句话建议」（提示里必须能照着点）。
 *
 * R7a §G：`text` 的推荐从 glm 换成 deepseek-flash —— glm 是编程特化模型（官方定位长程编程），
 * 不该出现在写作台/文本生成的推荐里；deepseek-flash 便宜且能看图，是文本默认档。
 */
const CAP_SUGGESTION: Record<ModelCap, { short: string; vendor: string }> = {
  text: { short: 'deepseek-flash（文本+视觉，推荐）', vendor: 'DeepSeek' },
  vision: { short: 'deepseek-flash（文本+视觉，推荐）', vendor: 'DeepSeek' },
  image: { short: 'cogview-3-flash（免费测试）', vendor: '智谱' },
  video: { short: 'doubao-seedance-2-5-260628（视频，推荐）', vendor: '火山方舟' },
  audio: { short: 'speech-2.8-hd（音频，语音合成）', vendor: 'MiniMax' },
};

export function capHint(cap: ModelCap): string {
  const suggestion = CAP_SUGGESTION[cap];
  return (
    `你还没有配置${CAP_LABELS[cap]}模型 —— 去 AI 配置里点「${suggestion.short}」（${suggestion.vendor}），` +
    '或手动加一行带该能力标签的模型'
  );
}

/**
 * 配置页自己用的一句话：不能自指「去 AI 配置里点」（用户就在这一页）。
 * 上层（视频页 / 生成流程）仍用 `capHint`。
 */
export function capHintInline(cap: ModelCap): string {
  const suggestion = CAP_SUGGESTION[cap];
  return `没有可用的${CAP_LABELS[cap]}模型：点上面「${suggestion.short}」预设标签，或直接在上面填好服务地址与 API Key（填完即生效）`;
}

function isUsable(connection: Connection | undefined): boolean {
  // 「可用」= 有 activeConnection 且地址非空。key 不强制：本地部署本来就没有 key
  return Boolean(connection && connection.baseUrl.trim() !== '');
}

/** 「本地部署」类厂商：只做占位，本应用这一版不调用它（M3R2 §3） */
export function isLocalProvider(provider: Pick<Provider, 'id' | 'builtin'>): boolean {
  return provider.builtin && VENDOR_META[provider.id as BuiltinProviderId]?.kind === 'local';
}

/**
 * 五个「角色」= 生成时默认用哪个模型（R7a §E）。
 *
 * 为什么要单独一个 `agent`：写作和 Agent 都只要文本能力，靠一个顺序只能排出一个第一。
 * 写作要挑便宜的、Agent 要挑最强的，所以必须两个独立指针。
 */
export type ModelRole = 'writing' | 'image' | 'video' | 'audio' | 'agent';

/** 角色顺序（UI 里的排列顺序由它决定） */
export const MODEL_ROLES: readonly ModelRole[] = ['writing', 'image', 'video', 'audio', 'agent'];

/** 角色 → 必需的 cap（读角色指针时用它校验；agent 只要文本） */
export const ROLE_CAP: Record<ModelRole, ModelCap> = {
  writing: 'text',
  image: 'image',
  video: 'video',
  audio: 'audio',
  agent: 'text',
};

export const ROLE_LABELS: Record<ModelRole, string> = {
  writing: '写作',
  image: '生图',
  video: '视频',
  audio: '音频',
  agent: '工作流设计',
};

/** 角色 → 模型 key（值同 `modelOrder` 的 key 格式；缺省 = 没配） */
export type ModelRoles = Partial<Record<ModelRole, string>>;

/** cap → 默认角色（`pickModel` 先查它；`vision` 没有专属角色，走旧逻辑） */
export const CAP_ROLE: Partial<Record<ModelCap, ModelRole>> = {
  text: 'writing',
  image: 'image',
  video: 'video',
  audio: 'audio',
};

/**
 * 模型 key：`providerId:connectionId:modelId`（行 id 会在复制模型表时换新，modelId 不会）。
 * 自定义厂商的 providerId 自带一个冒号（`custom:p-xxx`），所以**只能从右往左拆**。
 */
export function modelKeyOf(providerId: string, connectionId: string, modelId: string): string {
  return `${providerId}:${connectionId}:${modelId}`;
}

/** 目录里所有合法 key（清理悬空指针时用） */
export function modelKeysOf(catalog: AICatalog): Set<string> {
  const keys = new Set<string>();
  for (const provider of catalog.providers) {
    for (const connection of provider.connections) {
      for (const model of connection.models) {
        if (model.modelId.trim() === '') continue;
        keys.add(modelKeyOf(provider.id, connection.id, model.modelId));
      }
    }
  }
  return keys;
}

export interface RoleModelHit {
  provider: Provider;
  connection: Connection;
  model: ModelEntry;
}

/**
 * 把角色指针解析成一条可用的模型（**校验不过就返回 null，不抛错**）。
 *
 * 校验四件事：模型还在 / `enabled !== false` / caps 含该角色的能力 / 连接有地址且不是本地部署占位。
 * 任何一条不过 = 当没配（调用方退回「第一个可用」）。
 */
export function resolveRoleModel(
  catalog: AICatalog,
  roles: ModelRoles | undefined | null,
  role: ModelRole,
): RoleModelHit | null {
  const key = typeof roles?.[role] === 'string' ? (roles?.[role] ?? '').trim() : '';
  if (key === '') return null;
  const need = ROLE_CAP[role];
  for (const provider of catalog.providers) {
    const prefix = `${provider.id}:`;
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    for (const connection of provider.connections) {
      const connectionPrefix = `${connection.id}:`;
      if (!rest.startsWith(connectionPrefix)) continue;
      const modelId = rest.slice(connectionPrefix.length);
      const model = connection.models.find((item) => item.modelId === modelId);
      if (!model) continue;
      if (model.enabled === false) return null;
      if (!model.caps.includes(need)) return null;
      if (isLocalProvider(provider) || !isUsable(connection)) return null;
      return { provider, connection, model };
    }
  }
  return null;
}

/** 旧行为（也仍是「角色没配 / 配了但失效」时的兜底）：厂商顺序 → 当前连接 → 表内顺序 */
function pickFirstAvailable(catalog: AICatalog, cap: ModelCap): PickModelResult {
  for (const provider of catalog.providers) {
    if (isLocalProvider(provider)) continue;
    // 同一个厂商的所有连接都参与兜底：多把 Key 各自挂着不同模型时，不该只认一条
    for (const connection of provider.connections) {
      if (!isUsable(connection)) continue;
      const model = connection.models.find(
        (item) =>
          item.enabled !== false && item.modelId.trim() !== '' && item.caps.includes(cap),
      );
      if (model) return { ok: true, provider, connection, model };
    }
  }
  return { ok: false, hint: capHint(cap) };
}

/**
 * 按能力选模型（R7a §F 改造）：**先查角色，查不到再退回旧行为**。
 *
 * 角色从哪来：不在这里读库（本函数保持同步、纯函数）。调用方把 `settings.modelRoles`
 * 读出来作为第三个参数传进来；不传 = 没配角色 = 完全等于旧行为（`pickModel(catalog, cap)`）。
 * 需要「顺手读库」的调用方用 `model-prefs.ts` 的 `pickModelWithRoles`。
 *
 * 三条硬语义（M3R6，未变）：只认 `activeConnection` 那一份模型表 /
 * `enabled === false` 不参与 / 本地部署类厂商跳过。
 */
export function pickModel(
  catalog: AICatalog,
  cap: ModelCap,
  roles?: ModelRoles | null,
): PickModelResult {
  const role = CAP_ROLE[cap];
  if (role) {
    const hit = resolveRoleModel(catalog, roles, role);
    if (hit) return { ok: true, ...hit };
  }
  return pickFirstAvailable(catalog, cap);
}

/** 按角色挑（`agent` 只能用这个入口 —— 它没有对应的 cap） */
export function pickModelForRole(
  catalog: AICatalog,
  role: ModelRole,
  roles?: ModelRoles | null,
): PickModelResult {
  const hit = resolveRoleModel(catalog, roles, role);
  if (hit) return { ok: true, ...hit };
  return pickFirstAvailable(catalog, ROLE_CAP[role]);
}

/** 视频页用：当前连接的模型表里所有 caps 含 video 的模型（按厂商顺序） */
export interface VideoModelRef {
  providerId: string;
  providerName: string;
  /** 这条模型属于哪条连接（同一厂商多把 Key 时，key/地址必须取这条的） */
  connectionId: string;
  modelId: string;
  /** 用户声明的上下文窗口（token）；没声明就是 undefined（界面按 128k 处理） */
  contextLength?: number;
  displayName: string;
  usable: boolean;
}

export function listModelsByCap(catalog: AICatalog, cap: ModelCap): VideoModelRef[] {
  const result: VideoModelRef[] = [];
  const seen = new Set<string>();
  for (const provider of catalog.providers) {
    // 本地部署类只做占位：列出来只会让人以为选中就能跑（真正接入在画板/节点）
    if (isLocalProvider(provider)) continue;
    // **遍历所有连接**：同一家站的两把 Key（比如一把生图、一把 claude）都应该能用，
    // 不该有「生效连接」这种只让一把 Key 生效的隐藏规则。
    for (const connection of provider.connections) {
      if (!isUsable(connection)) continue;
      for (const model of connection.models) {
        if (model.enabled === false) continue;
        if (!model.caps.includes(cap)) continue;
        const modelId = model.modelId.trim();
        if (modelId === '') continue;
        const dedupeKey = `${provider.id}:${modelId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        result.push({
          providerId: provider.id,
          providerName: provider.name,
          connectionId: connection.id,
          modelId,
          ...(typeof model.contextLength === 'number' && model.contextLength > 0
            ? { contextLength: model.contextLength }
            : {}),
          displayName: model.displayName || modelId,
          usable: true,
        });
      }
    }
  }
  return result;
}

/* 自定义厂商                                                          */
/* ------------------------------------------------------------------ */

export function createCustomProvider(
  catalog: AICatalog,
  input: { name: string; baseUrl?: string; apiKey?: string; note?: string; template?: CustomTemplate },
): { catalog: AICatalog; provider: Provider } {
  const template = input.template ?? 'relay';
  const meta = CUSTOM_TEMPLATES[template];
  const tag = findTag(meta.defaultModelId);
  // M3R6：模板的默认模型挂在新建的这条连接上（不是厂商下）
  const model: ModelEntry = {
    id: makeId('model'),
    displayName: tag?.label ?? meta.defaultModelId,
    modelId: meta.defaultModelId,
    contextLength: tag?.contextLength,
    caps: tag ? [...tag.caps] : ['text'],
    note: tag?.note,
    price: tag?.price ?? null,
    priceStatus: tag?.priceStatus ?? '未核实',
    enabled: true,
  };
  const connection: Connection = {
    id: makeId('conn'),
    label: input.note?.trim() || input.name.trim() || '默认连接',
    baseUrl: (input.baseUrl ?? '').trim(),
    apiKey: (input.apiKey ?? '').trim(),
    protocol: 'openai',
    multiplier: DEFAULT_MULTIPLIER,
    models: [model],
  };
  const provider: Provider = {
    id: `custom:${makeId('p')}`,
    name: input.name.trim() || '自定义厂商',
    builtin: false,
    connections: [connection],
    activeConnectionId: connection.id,
    lastModelId: model.id,
  };
  return {
    catalog: { ...catalog, providers: sortProviders([...catalog.providers, provider]) },
    provider,
  };
}

export function removeCustomProvider(catalog: AICatalog, providerId: string): AICatalog {
  const provider = findProvider(catalog, providerId);
  if (!provider || !isCustomProvider(provider)) return catalog;
  return { ...catalog, providers: catalog.providers.filter((item) => item.id !== providerId) };
}

/* ------------------------------------------------------------------ */
/* 导出 / 导入（走文件；默认不含 key）                                   */
/* ------------------------------------------------------------------ */

export const CATALOG_FILE_FORMAT = 'inspiration-assistant-ai-catalog';
export const CATALOG_FILE_VERSION = 1;

export interface CatalogFile {
  format: typeof CATALOG_FILE_FORMAT;
  version: number;
  exportedAt: string;
  containsKey: boolean;
  catalog: AICatalog;
}

export function buildCatalogFile(
  catalog: AICatalog,
  options: { includeKey?: boolean; now?: Date } = {},
): CatalogFile {
  const includeKey = options.includeKey === true;
  const providers = catalog.providers.map((provider) => ({
    ...provider,
    connections: provider.connections.map((connection) => ({
      ...connection,
      apiKey: includeKey ? connection.apiKey : '',
    })),
  }));
  const containsKey =
    includeKey && catalog.providers.some((provider) => provider.connections.some((c) => c.apiKey !== ''));
  return {
    format: CATALOG_FILE_FORMAT,
    version: CATALOG_FILE_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    containsKey,
    catalog: { ...catalog, providers },
  };
}

export function serializeCatalogFile(
  catalog: AICatalog,
  options: { includeKey?: boolean; now?: Date } = {},
): { json: string; filename: string; containsKey: boolean } {
  const now = options.now ?? new Date();
  const file = buildCatalogFile(catalog, { ...options, now });
  const pad = (value: number) => `${value}`.padStart(2, '0');
  const filename = `ai-catalog_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
  return { json: JSON.stringify(file, null, 2), filename, containsKey: file.containsKey };
}

export type ParseCatalogResult =
  | { ok: true; catalog: AICatalog; containsKey: boolean }
  | { ok: false; error: string };

/** 永不抛异常：任何输入都返回人话原因 */
export function parseCatalogFile(text: string): ParseCatalogResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '这不是合法的 JSON 文件，请选择由本应用导出的 .json 配置' };
  }
  const row = asRecord(raw);
  if (!row) return { ok: false, error: '配置文件内容不是对象，无法识别' };
  if (row.format !== CATALOG_FILE_FORMAT) {
    return { ok: false, error: `不是本应用的 AI 配置模型文件（format=${String(row.format)}）` };
  }
  if (typeof row.version !== 'number' || row.version > CATALOG_FILE_VERSION) {
    return {
      ok: false,
      error: `配置版本 ${String(row.version)} 太新，当前应用只认到 v${CATALOG_FILE_VERSION}，请升级后再导入`,
    };
  }
  const catalogRow = asRecord(row.catalog);
  if (!catalogRow) return { ok: false, error: '配置文件缺少 catalog 字段' };
  const catalog = normalizeCatalog(catalogRow);
  const containsKey = catalog.providers.some((provider) =>
    provider.connections.some((connection) => connection.apiKey !== ''),
  );
  return { ok: true, catalog, containsKey };
}

/** 连接下拉的显示名：`备注 · baseUrl`（过长截断） */
export function connectionLabel(connection: Connection, maxLength = 42): string {
  const base = connection.baseUrl.replace(/^https?:\/\//, '');
  const text = `${connection.label || '未命名连接'} · ${base || '未填 base_url'}`;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
