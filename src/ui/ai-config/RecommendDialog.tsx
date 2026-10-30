/**
 * 「配置模型」弹窗（R7d：与原来的「自由配置」页合并成一个入口）。
 *
 * 打开时载入**全部已有配置**（按「厂商 + 地址」聚合成组），一条都没有时给一条空地址。
 * 顶部「推荐配置」按钮把三组常用搭配**插到最上面**（已有的组不会重复生成，只补齐缺的 Key）。
 * 结构是三层树：组（base_url）→ Key（协议 / 倍率）→ 模型；组可以拖拽排序。
 *
 * 三层增删的边界（任务书 §B.4，逐条实现）：
 * - 删组：至少保留一组；
 * - 删 Key：每组至少保留一把（协议是跟着 Key 走的，Key 全没了这组就没意义）；
 * - 删模型：每把 Key 至少保留一个模型。
 * 到边界时按钮 `disabled`（不是隐藏）—— 让用户看得见「这里可以加，但不能再减」。
 *
 * 保存是**合并**：往对应 `Provider.connections` 里追加连接，不动已有连接、不覆盖 Key。
 * Key 为空的行整行跳过，并在卡片上提示「N 把 Key 空着被跳过」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_OVERSEAS_RATE,
  defaultMultiplierFor,
  BUILTIN_PROVIDER_ORDER,
  DEFAULT_MULTIPLIER,
  VENDOR_META,
  addConnection,
  createCustomProvider,
  groupKeyOf,
  isLocalProvider,
  removeConnection,
  loadCatalog,
  makeId,
  parseMultiplier,
  presetTagsFor,
  presetTagById,
  protocolEndpointTitle,
  saveCatalog,
  updateConnection,
  urlToProvider,
} from '../../adapters/ai-models/catalog';
import type {
  BillingMode,
  AICatalog,
  BuiltinProviderId,
  Connection,
  ModelEntry,
  ProviderProtocol,
} from '../../adapters/ai-models/catalog';
import { GUIDE_VENDORS, LINGHUI_SIGNUP_URL } from '../../adapters/ai-models/model-guide';
import { Dialog } from '../components/Dialog';
import { RecMenu } from './RecMenu';
import type { RecMenuOption } from './RecMenu';
import { canSyncTest, listModels, runSelfTest } from '../../adapters/ai-models/client';
import { formatFxHint } from '../../core/fx';
import { DEFAULT_CONTEXT_WINDOW } from '../create/context-budget';
import { knownContextFor } from '../../core/model-meta';
import { useUsdCny } from './use-usd-cny';
import { describeError } from '../format';

/** 厂商下拉里「自定义」的取值（内置厂商 id 之外的那一格） */
const CUSTOM = 'custom';

/** 勾「1M」时写进 ModelEntry.contextLength 的值 */
const ONE_MILLION = 1_048_576;

/**
 * 一条模型默认的上下文窗口：
 * - **文本模型默认按 1M**（现在主流长文模型都至少 1M，先按它能用来估预算，
 *   用户觉得不对可以取消勾选 → 变成明确 128k）；
 * - 生图 / 视频 / 音频模型不涉及长上下文，不勾；
 * - 名录里本来就写了窗口的（如 kimi）用它自己那个。
 */
/** 按钮上的文字：1M / 512k / 200k / 128k */
function formatContext(size: number | undefined): string {
  const value = typeof size === 'number' && size > 0 ? size : DEFAULT_CONTEXT_WINDOW;
  if (value >= 1_000_000) return '1M';
  return `${Math.round(value / 1000)}k`;
}

interface ResolvedContext {
  length: number;
  /** catalog = 名录真实值；manual = 用户改的；guess = 名录没收录，按文本 1M 猜 */
  source: 'catalog' | 'manual' | 'guess';
}

/**
 * 这条模型的窗口从哪来（界面与保存都用它，避免「勾不勾凭感觉」）：
 * 用户手动设过 → manual；名录有 → catalog；都没有 → 文本模型猜 1M，其余按 128k。
 */
function resolveContext(model: DraftModel): ResolvedContext {
  if (typeof model.contextLength === 'number' && model.contextLength > 0) {
    return { length: model.contextLength, source: 'manual' };
  }
  const known = knownContextFor(model.modelId);
  if (known) return { length: known, source: 'catalog' };
  const tag = presetTagById(model.modelId);
  if (tag?.caps.includes('text')) return { length: ONE_MILLION, source: 'guess' };
  return { length: DEFAULT_CONTEXT_WINDOW, source: 'guess' };
}

/** 窗口下拉的选项：自动 + 常见档位（够用，不做自由输入） */
function contextOptions(resolved: ResolvedContext): RecMenuOption[] {
  const current = formatContext(resolved.length);
  const autoHint =
    resolved.source === 'catalog'
      ? '按名录（models.dev / LiteLLM）里的真实窗口'
      : resolved.source === 'manual'
        ? '现在是你手动设的值；选自动就回到按名录算'
        : '名录没收录这条模型，暂按文本 1M 估';
  return [
    { value: 'auto', label: `自动（${current}）`, short: current, hint: autoHint },
    { value: '131072', label: '128k', short: '128k', hint: '模型只有 128k 时选它' },
    { value: '200000', label: '200k', short: '200k', hint: '例如 glm-4.7-flash' },
    { value: '262144', label: '256k', short: '256k', hint: '例如 doubao-seed-2-1-pro' },
    { value: '524288', label: '512k', short: '512k', hint: '例如 MiniMax-M3' },
    { value: '1048576', label: '1M', short: '1M', hint: '长文模型' },
  ];
}

function contextTitle(resolved: ResolvedContext): string {
  const value = formatContext(resolved.length);
  if (resolved.source === 'catalog') return `上下文 ${value} · 来自名录（应用自己填的，不用你判断）`;
  if (resolved.source === 'manual') return `上下文 ${value} · 你手动设的`;
  return `上下文 ${value} · 名录没收录，按文本模型估的`;
}

/**
 * 落库用的窗口：手动值 > 名录真实值 > 模型自带的 > 文本模型按 1M 猜 > 128k。
 * 这是「自动」分支的唯一实现，界面与保存都走它。
 */
function resolveLength(
  modelId: string,
  tag: { caps: readonly string[]; contextLength?: number } | undefined,
  manual?: number,
): number {
  if (typeof manual === 'number' && manual > 0) return manual;
  const known = knownContextFor(modelId);
  if (known) return known;
  if (tag?.contextLength) return tag.contextLength;
  if (tag?.caps.includes('text')) return ONE_MILLION;
  return DEFAULT_CONTEXT_WINDOW;
}

type VendorChoice = BuiltinProviderId | typeof CUSTOM;

interface DraftModel {
  id: string;
  modelId: string;
  /** 只有开了「1M」才有值；没开就按应用的 128k 默认 */
  contextLength?: number;
}

interface DraftKey {
  id: string;
  apiKey: string;
  protocol: ProviderProtocol;
  /** 输入框里的原文；非法值按 1 处理（`parseMultiplier`） */
  multiplier: string;
  /** 计费方式（决定上面那个数字是什么意思） */
  billingMode: BillingMode;

  /** 每种计费方式各自记住用户填的原文：切走再切回不丢，且随备份导出 */
  modeMultipliers?: Partial<Record<BillingMode, string>>;

  /** 从已有配置回填来的行：它原本是哪条连接（保存时原地改，不新建） */
  connectionId?: string;
  models: DraftModel[];
}

interface DraftGroup {
  id: string;
  /** '' = 还没选厂商（空组的初始状态） */
  vendor: VendorChoice | '';
  /** vendor === 'custom' 时用户自己写的厂商名 */
  customName: string;
  baseUrl: string;
  /** 组标题（默认空：标题一律用厂商名，不再写「写作用 · xxx」这类小字） */
  title?: string;
  /** 从已有配置载入时记下 provider（自定义厂商保存时不能重复建厂商） */
  providerId?: string;
  /** 排序键：`groupKeyOf(providerId, baseUrl)`，保存时写进 catalog.groupOrder */
  orderKey?: string;
  /** 已经配过这条连接（进弹窗时从已有配置回填）：界面上标「已配置」 */
  existingConnectionId?: string;
  keys: DraftKey[];
}

/** 协议：收起显示简称，展开显示全名 + 什么时候该选它 */
const PROTOCOL_OPTIONS: readonly RecMenuOption[] = [
  {
    value: 'openai',
    label: 'OpenAI Chat Completions',
    short: 'OpenAI',
    hint: '最通用：官方直连与绝大多数中转站都走它',
  },
  {
    value: 'responses',
    label: 'OpenAI Responses（实验性·未验证）',
    short: 'Responses',
    hint: 'OpenAI 新接口，部分模型和中转站还不支持',
  },
  {
    value: 'anthropic',
    label: 'Anthropic Messages',
    short: 'Anthropic',
    hint: 'Claude 必须走它才有 prompt 缓存；换协议要单独配一把 Key',
  },
];

/** 厂商：内置厂商 + 自定义（原生 select 的弹层没法样式化，所以也走 RecMenu） */
const VENDOR_OPTIONS: readonly RecMenuOption[] = [
  { value: '', label: '选择厂商', hint: '先选厂商，地址与模型候选会跟着变；粘贴地址也会自动认出来' },
  ...BUILTIN_PROVIDER_ORDER.map((id) => ({
    value: id,
    label: shortVendorName(VENDOR_META[id].name),
  })),
  { value: CUSTOM, label: '自定义', hint: '自己填厂商名与地址' },
];
/** 计费方式：每项都写清「选它会怎样」，倍率数字才不是天书 */
function billingOptions(rate: number): RecMenuOption[] {
  return [
    {
      value: 'relay',
      label: '中转站',
      hint: '按中转站的分组倍率算（基础价按 ¥1=$1 折算），常见 0.1 ~ 1.1',
    },
    {
      value: 'domestic',
      label: '国内按量',
      hint: '国内厂商官方按量计费，官方价本来就是元，一般填 1',
    },
    {
      value: 'subscription',
      label: '官方订阅',
      hint: '包月/包年订阅，单次边际成本≈0，一般填 0',
    },
    {
      value: 'overseas',
      label: '国外按量',
      hint: `官方美元价 × 汇率；当前汇率 ${rate.toFixed(2)}，可自己改`,
    },
  ];
}


/** 把草稿里四种方式的倍率转成数字；当前方式的值也一定要带上（用户可能没切过就直接保存） */
function collectModeMultipliers(
  key: DraftKey,
): Partial<Record<BillingMode, number>> | undefined {
  const merged: Partial<Record<BillingMode, string>> = {
    ...key.modeMultipliers,
    [key.billingMode]: key.multiplier,
  };
  const out: Partial<Record<BillingMode, number>> = {};
  for (const [mode, text] of Object.entries(merged)) {
    if (text === undefined) continue;
    out[mode as BillingMode] = multiplierOfText(text);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
function newModel(modelId: string, contextLength?: number): DraftModel {
  // 不预设 contextLength：留空 = 自动（按名录现算），预设了就变成"用户手动改的"
  return { id: makeId('dm'), modelId, ...(contextLength ? { contextLength } : {}) };
}

function newKey(
  modelIds: readonly string[],
  protocol: ProviderProtocol = 'openai',
  multiplier = '1',
  billingMode: BillingMode = 'relay',
): DraftKey {
  return {
    id: makeId('dk'),
    apiKey: '',
    protocol,
    multiplier,
    billingMode,
    models: modelIds.map((modelId) => newModel(modelId)),
  };
}

/** 三组初始值（任务书 §B.2 的表；地址取 `VENDOR_META` 的官方值） */
/** 比较 base_url：忽略首尾空格、末尾斜杠、大小写 */
function normalizeUrl(raw: string): string {
  return raw.trim().toLowerCase().replace(/\/+$/, '');
}

/** 一条连接 → 草稿里的一把 Key（含协议 / 计费方式 / 每种方式的倍率） */
function keyFromConnection(connection: Connection): DraftKey {
  return {
    id: makeId('dk'),
    connectionId: connection.id,
    apiKey: connection.apiKey,
    protocol: connection.protocol ?? 'openai',
    multiplier: String(connection.multiplier ?? 1),
    billingMode: connection.billingMode ?? 'relay',
    modeMultipliers: connection.modeMultipliers
      ? Object.fromEntries(
          Object.entries(connection.modeMultipliers).map(([mode, value]) => [mode, String(value)]),
        )
      : undefined,
    models: (connection.models.length > 0 ? connection.models : [{ modelId: '' }]).map((model) => ({
      id: makeId('dm'),
      modelId: model.modelId,
      // 只把「用户手动改过的」带回来；名录值每次按最新名录现算，不冻结在草稿里
      ...('contextLength' in model &&
      typeof model.contextLength === 'number' &&
      (model.contextSource ?? 'manual') === 'manual'
        ? { contextLength: model.contextLength }
        : {}),
    })),
  };
}

/** 一条配置都没有时给的空组：一个空地址、一把空 Key、一个空模型 */
function blankGroup(): DraftGroup {
  return {
    id: makeId('grp'),
    vendor: '',
    customName: '',
    baseUrl: '',
    keys: [newKey([''], 'openai', String(DEFAULT_MULTIPLIER), 'relay')],
  };
}

/**
 * 打开弹窗时的草稿 = **现有配置的全部内容**。
 * 按「厂商 + 地址」聚合成组：同一地址的多把 Key 就在同一组里（中转站常见）。
 * 顺序按 `catalog.groupOrder`（用户上次拖出来的顺序），表里没有的排在后面。
 */
export function initialDraft(catalog: AICatalog | null = null): DraftGroup[] {
  if (!catalog) return [blankGroup()];
  const rows: DraftGroup[] = [];
  for (const provider of catalog.providers) {
    if (isLocalProvider(provider)) continue;
    const byUrl = new Map<string, Connection[]>();
    for (const connection of provider.connections) {
      if (connection.baseUrl.trim() === '') continue;
      const url = normalizeUrl(connection.baseUrl);
      byUrl.set(url, [...(byUrl.get(url) ?? []), connection]);
    }
    for (const [url, connections] of byUrl) {
      rows.push({
        id: makeId('grp'),
        vendor: (provider.builtin ? provider.id : CUSTOM) as VendorChoice,
        providerId: provider.id,
        customName: provider.builtin ? '' : provider.name,
        baseUrl: connections[0].baseUrl,
        existingConnectionId: connections[0].id,
        orderKey: groupKeyOf(provider.id, url),
        keys: connections.map(keyFromConnection),
      });
    }
  }
  if (rows.length === 0) return [blankGroup()];
  const order = catalog.groupOrder ?? [];
  return rows
    .map((group, index) => ({ group, index }))
    .sort((a, b) => {
      const ra = order.indexOf(a.group.orderKey ?? '');
      const rb = order.indexOf(b.group.orderKey ?? '');
      const na = ra < 0 ? Number.MAX_SAFE_INTEGER : ra;
      const nb = rb < 0 ? Number.MAX_SAFE_INTEGER : rb;
      return na === nb ? a.index - b.index : na - nb;
    })
    .map((row) => row.group);
}

/**
 * 三组推荐搭配（「推荐配置」按钮的内容）。
 *
 * 灵绘一组三把 Key：生图（OpenAI）/ gemini（OpenAI，另一个分组倍率）/ opus（Anthropic）。
 * 同一把 Key 里能挂多厂商模型是存在的，但这里按**分组倍率不同**分开写，用户改倍率时不会互相影响。
 */
export function recommendedGroups(): DraftGroup[] {
  return [
    {
      id: makeId('grp'),
      vendor: 'deepseek',
      customName: '',
      baseUrl: 'https://api.deepseek.com',
      keys: [newKey(['deepseek-flash'], 'openai', '1', 'domestic')],
    },
    {
      id: makeId('grp'),
      vendor: 'ark',
      customName: '',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      keys: [newKey(['doubao-seedance-2-5-260628'], 'openai', '1', 'domestic')],
    },
    {
      id: makeId('grp'),
      vendor: 'linghui',
      customName: '',
      baseUrl: 'https://xn--ai-xg4e312c.com',
      keys: [
        newKey(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'], 'openai', '0.1', 'relay'),
        newKey(['gemini-4-argon'], 'openai', '0.3', 'relay'),
        newKey(['claude-opus-5-5'], 'anthropic', '1.1', 'relay'),
      ],
    },
  ];
}

/** 拖拽排序的纯函数：把 from 挪到 to 的位置（不存在时原样返回） */
export function reorderGroups(draft: DraftGroup[], fromId: string, toId: string): DraftGroup[] {
  const from = draft.findIndex((group) => group.id === fromId);
  const to = draft.findIndex((group) => group.id === toId);
  if (from < 0 || to < 0 || from === to) return draft;
  const next = [...draft];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function isBlankGroup(group: DraftGroup): boolean {
  return (
    group.baseUrl.trim() === '' && group.keys.every((key) => key.apiKey.trim() === '')
  );
}

/** 同一个组？= 同一厂商 + 同一地址（地址归一化后比较） */
function sameGroup(a: DraftGroup, b: DraftGroup): boolean {
  if (normalizeUrl(a.baseUrl) !== normalizeUrl(b.baseUrl)) return false;
  const left = a.providerId ?? a.vendor;
  const right = b.providerId ?? b.vendor;
  return left === '' || right === '' || left === right;
}

/**
 * 把模板合进已有的一组：缺的 Key 追加（留空让用户填），已有的 Key 补上模板里多出来的模型。
 * 用户填过的 Key / 倍率一律不动。
 */
function mergeTemplate(group: DraftGroup, template: DraftGroup): DraftGroup {
  const keys = [...group.keys];
  for (const templateKey of template.keys) {
    const wantedIds = templateKey.models.map((model) => model.modelId);
    const hit = keys.find((key) => key.models.some((model) => wantedIds.includes(model.modelId)));
    if (!hit) {
      keys.push({
        ...templateKey,
        id: makeId('dk'),
        apiKey: '',
        models: templateKey.models.map((model) => ({ ...model, id: makeId('dm') })),
      });
      continue;
    }
    const known = new Set(hit.models.map((model) => model.modelId));
    const extra = templateKey.models.filter((model) => !known.has(model.modelId));
    if (extra.length > 0) {
      const at = keys.indexOf(hit);
      keys[at] = {
        ...hit,
        models: [...hit.models, ...extra.map((model) => ({ ...model, id: makeId('dm') }))],
      };
    }
  }
  return { ...group, keys };
}

/**
 * 「推荐配置」按钮：三组推荐**插到最上面**（deepseek → 火山 → 灵绘），
 * 已经配过的组不重复生成，只补齐缺的 Key/模型。
 */
export function withRecommended(draft: DraftGroup[]): DraftGroup[] {
  const rest = draft.filter((group) => !isBlankGroup(group));
  const head: DraftGroup[] = [];
  for (const template of recommendedGroups()) {
    const at = rest.findIndex((group) => sameGroup(group, template));
    if (at < 0) {
      head.push(template);
      continue;
    }
    const [hit] = rest.splice(at, 1);
    head.push(mergeTemplate(hit, template));
  }
  return [...head, ...rest];
}

/** 下拉里放短名：124px 的格子塞不下「火山方舟（豆包）」，括号里的补充信息放到 title */
function shortVendorName(name: string): string {
  return name.replace(/（[^）]*）|\([^)]*\)/g, '').trim() || name;
}

function vendorNameOf(group: DraftGroup): string {
  if (group.providerId && group.vendor === CUSTOM) return group.customName.trim() || '自定义厂商';
  if (group.vendor === '') return group.customName.trim() || '新的配置';
  if (group.vendor === CUSTOM) return group.customName.trim() || '自定义厂商';
  return VENDOR_META[group.vendor].name;
}

function providerLike(group: DraftGroup, providerId?: string) {
  const id = providerId ?? group.providerId;
  if (group.vendor === CUSTOM || group.vendor === '') {
    return { id: id ?? 'custom:new', builtin: false };
  }
  return { id: group.vendor, builtin: true };
}

/** 某个模型 id 在厂商预设里的定义（名字 / 能力 / 价格都照抄名录，不编） */
function entryFor(group: DraftGroup, modelId: string, contextLength?: number): ModelEntry {
  const id = modelId.trim();
  const tag = presetTagsFor(providerLike(group)).find((item) => item.modelId === id);
  if (tag) {
    return {
      id: makeId('model'),
      displayName: tag.label,
      modelId: id,
      // 窗口与来源一起落库：界面才能显示「名录 / 手动 / 猜测」
      contextLength: resolveLength(id, tag, contextLength),
      contextSource: contextLength ? 'manual' : knownContextFor(id) ? 'catalog' : 'default',
      caps: [...tag.caps],
      note: tag.note,
      price: tag.price,
      priceStatus: tag.priceStatus,
      enabled: true,
    };
  }
  // 名录里没有的（用户自己填的名字）：不猜能力，先按文本收下，能力到 AI 配置页勾
  return {
    id: makeId('model'),
    displayName: id,
    modelId: id,
    contextLength: resolveLength(id, undefined, contextLength),
    contextSource: contextLength ? 'manual' : knownContextFor(id) ? 'catalog' : 'default',
    caps: ['text'],
    note: '手填的模型名：能力请到 AI 配置页勾选',
    price: null,
    priceStatus: '未核实',
    enabled: true,
  };
}

function multiplierOfText(raw: string): number {
  const parsed = parseMultiplier(raw);
  return parsed === null ? DEFAULT_MULTIPLIER : parsed;
}

/** `keyUrl` 在 guide 里是裸域名（`platform.deepseek.com`），补协议后才是可点的链接 */
function registrationUrl(keyUrl: string | undefined): string | null {
  const raw = (keyUrl ?? '').trim();
  if (raw === '' || raw.startsWith('—')) return null;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
}

export function RecommendDialog({ open, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<DraftGroup[]>(initialDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 每个模型的测试结果（按 model.id 存）：只有点过才显示 */
  const [modelProbes, setModelProbes] = useState<
    Record<string, { status: 'running' | 'ok' | 'fail'; text: string }>
  >({});
  /** 哪一把 Key 正在拉模型列表（只为了按钮显示「拉取中」） */
  const [pullingKeyId, setPullingKeyId] = useState<string | null>(null);
  /** Key 明文显示（按 key.id 记） */
  const [keyVisible, setKeyVisible] = useState<Record<string, boolean>>({});
  /** 拉取结果的浮层提示（Element Plus 那种 ElMessage） */
  const [toast, setToast] = useState<{ kind: 'ok' | 'fail'; text: string } | null>(null);
  /** 鼠标停在提示上时暂停自动消失 */
  const [toastHovered, setToastHovered] = useState(false);
  const needsFx = draft.some((group) => group.keys.some((key) => key.billingMode === 'overseas'));
  const fx = useUsdCny(needsFx);
  /** 「拉取模型」从站上取回来的 id，只用于补下拉候选，不回写模型 */
  const [pulledModels, setPulledModels] = useState<Record<string, string[]>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  /** 用户是否已经动过草稿（决定异步回填能不能落地） */
  const dirtyRef = useRef(false);
  /** 已有配置读完之前不渲染表单：否则回填会把用户刚展开的菜单刷掉 */
  const [seeded, setSeeded] = useState(false);
  /** 打开时库里有哪些连接：保存时用来判断「草稿里没了的」要删掉 */
  const loadedIds = useRef<Set<string>>(new Set());
  /** 正在拖的组（拖拽排序） */
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  /**
   * 汇率是异步到的：用户点「国外按量」时可能还是兜底的 6.8。
   * 等真汇率回来，把「还停在 6.8 这个默认值」的行改成真汇率；用户自己改过的数字一律不动。
   */
  useEffect(() => {
    if (fx.source === 'fallback') return;
    const next = String(Math.round(fx.rate * 100) / 100);
    setDraft((current) => {
      let changed = false;
      const updated = current.map((group) => ({
        ...group,
        keys: group.keys.map((key) => {
          if (key.billingMode !== 'overseas') return key;
          if (multiplierOfText(key.multiplier) !== DEFAULT_OVERSEAS_RATE) return key;
          changed = true;
          return { ...key, multiplier: next };
        }),
      }));
      return changed ? updated : current;
    });
  }, [fx.rate, fx.source]);

  /**
   * 浮层提示 4s 自动消失；鼠标停上去就不走了（用户可能想抄报错原文），
   * 也可以直接点 × 关掉。
   */
  useEffect(() => {
    if (!toast || toastHovered) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast, toastHovered]);

  /**
   * 每次打开都会重新生成草稿（上一次没保存的半截 Key 不带进来），
   * 但会先去读一次已有配置：配过的组直接回填，用户不用再填一遍。
   */
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    setSaving(false);
    dirtyRef.current = false;
    setSeeded(false);
    setDraft(initialDraft());
    void loadCatalog().then((catalog) => {
      if (!alive) return;
      // 读完再放行：用户在读之前不可能开始填，也就不存在「回填冲掉输入」
      loadedIds.current = new Set(
        catalog.providers.flatMap((provider) => provider.connections.map((item) => item.id)),
      );
      setDraft(initialDraft(catalog));
      setSeeded(true);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  useEffect(
    () => () => {
      for (const timer of Object.values(timers.current)) clearTimeout(timer);
    },
    [],
  );

  const filledKeys = useMemo(
    () => draft.reduce((sum, group) => sum + group.keys.filter((key) => key.apiKey.trim() !== '').length, 0),
    [draft],
  );
  /** 草稿里已经删掉、保存时要从库里移除的连接数（决定「保存」能不能点） */
  const pendingRemovals = useMemo(() => {
    const present = new Set(
      draft.flatMap((group) =>
        group.keys
          .map((key) => key.connectionId)
          .filter((id): id is string => typeof id === 'string' && id !== ''),
      ),
    );
    return [...loadedIds.current].filter((id) => !present.has(id)).length;
  }, [draft]);

  const skippedKeys = useMemo(
    () => draft.reduce((sum, group) => sum + group.keys.filter((key) => key.apiKey.trim() === '').length, 0),
    [draft],
  );

  /** 「推荐配置」：把三组常用搭配插到最上面（已有的组只补齐缺的 Key/模型） */
  const applyRecommended = useCallback(() => {
    dirtyRef.current = true;
    setDraft((current) => withRecommended(current));
    setSeeded(true);
  }, []);

  /** 拖拽排序：把 from 组挪到 to 组的位置 */
  const moveGroup = useCallback((fromId: string, toId: string) => {
    if (fromId === toId) return;
    dirtyRef.current = true;
    setDraft((current) => reorderGroups(current, fromId, toId));
  }, []);

  const patchGroup = useCallback((groupId: string, patch: (group: DraftGroup) => DraftGroup) => {
    // 用户只要动过草稿，后面异步读回来的「已有配置」就不能再覆盖它
    dirtyRef.current = true;
    setDraft((prev) => prev.map((group) => (group.id === groupId ? patch(group) : group)));
  }, []);

  /** url 命中内置厂商 → 自动选中厂商格（500ms 防抖；失焦时立刻判定一次） */
  const detectVendor = useCallback(
    (groupId: string, url: string) => {
      const hit = urlToProvider(url);
      if (!hit) return;
      patchGroup(groupId, (group) => ({ ...group, vendor: hit }));
    },
    [patchGroup],
  );

  const scheduleDetect = useCallback(
    (groupId: string, url: string) => {
      const existing = timers.current[groupId];
      if (existing) clearTimeout(existing);
      timers.current[groupId] = setTimeout(() => detectVendor(groupId, url), 500);
    },
    [detectVendor],
  );

  function updateKey(groupId: string, keyId: string, patch: (key: DraftKey) => DraftKey): void {
    patchGroup(groupId, (group) => ({
      ...group,
      keys: group.keys.map((key) => (key.id === keyId ? patch(key) : key)),
    }));
  }

  function addGroup(): void {
    setDraft((prev) => [
      ...prev,
      {
        id: makeId('grp'),
        vendor: CUSTOM,
        customName: '',
        baseUrl: '',
        keys: [newKey([''])],
      },
    ]);
  }

  function removeGroup(groupId: string): void {
    setDraft((prev) => (prev.length <= 1 ? prev : prev.filter((group) => group.id !== groupId)));
  }

  function addKey(groupId: string): void {
    patchGroup(groupId, (group) => ({
      ...group,
      keys: [
        ...group.keys,
        newKey(
          [''],
          group.keys[0]?.protocol ?? 'openai',
          group.keys[0]?.multiplier ?? '1',
          group.keys[0]?.billingMode ?? 'relay',
        ),
      ],
    }));
  }

  function removeKey(groupId: string, keyId: string): void {
    patchGroup(groupId, (group) =>
      group.keys.length <= 1 ? group : { ...group, keys: group.keys.filter((key) => key.id !== keyId) },
    );
  }

  function addModel(groupId: string, keyId: string): void {
    updateKey(groupId, keyId, (key) => ({ ...key, models: [...key.models, newModel('')] }));
  }

  function removeModel(groupId: string, keyId: string, modelId: string): void {
    updateKey(groupId, keyId, (key) =>
      key.models.length <= 1 ? key : { ...key, models: key.models.filter((model) => model.id !== modelId) },
    );
  }

  /** 改窗口：'auto' = 回到自动（按名录现算），否则记成手动值 */
  function setModelContext(groupId: string, keyId: string, modelRowId: string, value: string): void {
    updateKey(groupId, keyId, (key) => ({
      ...key,
      models: key.models.map((model) =>
        model.id === modelRowId
          ? {
              ...model,
              contextLength: value === 'auto' ? undefined : Number(value) || undefined,
            }
          : model,
      ),
    }));
  }

  function setModel(groupId: string, keyId: string, modelRowId: string, modelId: string): void {
    updateKey(groupId, keyId, (key) => ({
      ...key,
      models: key.models.map((model) =>
        model.id === modelRowId
          ? { ...model, modelId, contextLength: undefined }
          : model,
      ),
    }));
  }

  /**
   * 逐个模型测：用**这一行指定的模型**发一次最小请求。
   *
   * 为什么不复用 `runConnectionSelfTest`：它会自己挑一个「看着像文本」的模型去试，
   * 于是 Key 下的第二个模型写错了也测不出来——那正是委托人指出的问题。
   */
  async function testModel(group: DraftGroup, key: DraftKey, model: DraftModel): Promise<void> {
    const modelId = model.modelId.trim();
    if (modelId === '') return;
    if (!canSyncTest(modelId)) {
      setModelProbes((current) => ({
        ...current,
        [model.id]: { status: 'fail', text: `${modelId} 是生图/视频模型，不能发同步 chat 自检` },
      }));
      return;
    }
    if (key.apiKey.trim() === '') {
      setModelProbes((current) => ({ ...current, [model.id]: { status: 'fail', text: '先填 Key 再测' } }));
      return;
    }
    setModelProbes((current) => ({ ...current, [model.id]: { status: 'running', text: '测试中…' } }));
    const probe = await runSelfTest({
      baseUrl: group.baseUrl,
      apiKey: key.apiKey.trim(),
      model: modelId,
      protocol: key.protocol,
    });
    setModelProbes((current) => ({
      ...current,
      [model.id]: {
        status: probe.ok ? 'ok' : 'fail',
        text: probe.ok ? `连通（${modelId}）` : probe.error?.userMessage ?? '连不上',
      },
    }));
  }

  /** 拉取这把 Key 能看到的模型：只补下拉候选，不动已经填好的模型行；结果用浮层提示 */
  async function pullModelsForKey(group: DraftGroup, key: DraftKey): Promise<void> {
    if (key.apiKey.trim() === '') {
      setToast({ kind: 'fail', text: '先填 Key 再拉取' });
      return;
    }
    setPullingKeyId(key.id);
    try {
      const result = await listModels({
        baseUrl: group.baseUrl,
        apiKey: key.apiKey.trim(),
        model: key.models[0]?.modelId ?? '',
        protocol: key.protocol,
      });
      if (!result.ok || result.models.length === 0) {
        setToast({ kind: 'fail', text: result.error?.userMessage ?? '没取到模型' });
        return;
      }
      setPulledModels((current) => ({ ...current, [group.id]: result.models }));
      setToast({ kind: 'ok', text: `取到 ${result.models.length} 个模型，可在下拉里选` });
    } finally {
      setPullingKeyId(null);
    }
  }

  async function handleSave(): Promise<void> {
    if (filledKeys === 0 && pendingRemovals === 0) return;
    setSaving(true);
    setError(null);
    try {
      let catalog: AICatalog = await loadCatalog();
      let savedGroups = 0;
      const kept = new Set<string>();
      const order: string[] = [];

      for (const group of draft) {
        const baseUrl = group.baseUrl.trim();
        // 空着的 Key 只要本来就在库里，就当「保留」（用户可能只想改模型/倍率）
        for (const key of group.keys) {
          if (key.apiKey.trim() !== '' || !key.connectionId) continue;
          // Key 空着 = 用户只想改模型 / 倍率 / 协议：保留原 Key，其余照草稿写回
          kept.add(key.connectionId);
          const owner = catalog.providers.find((provider) =>
            provider.connections.some((connection) => connection.id === key.connectionId),
          );
          const connection = owner?.connections.find((item) => item.id === key.connectionId);
          if (!owner || !connection) continue;
          const wantedHere = key.models
            .map((model) => entryFor(group, model.modelId, model.contextLength))
            .filter(isRealModel);
          const merged = connection.models.map(
            (model) => wantedHere.find((item) => item.modelId === model.modelId) ?? model,
          );
          const known = new Set(connection.models.map((model) => model.modelId));
          catalog = updateConnection(catalog, owner.id, connection.id, {
            baseUrl: baseUrl,
            protocol: key.protocol,
            multiplier: multiplierOfText(key.multiplier),
            billingMode: key.billingMode,
            modeMultipliers: collectModeMultipliers(key),
            models: [...merged, ...wantedHere.filter((item) => !known.has(item.modelId))],
          });
        }
        if (baseUrl === '') continue;
        const filled = group.keys.filter((key) => key.apiKey.trim() !== '');
        if (filled.length === 0) {
          if (group.providerId) order.push(groupKeyOf(group.providerId, baseUrl));
          continue;
        }

        let providerId = group.providerId ?? (group.vendor === CUSTOM || group.vendor === '' ? '' : group.vendor);
        let pending = filled;

        // 自定义厂商还不存在：先建厂商 + 第一条连接，再补其余的 Key
        if (providerId === '') {
          const name = vendorNameOf(group);
          const created = createCustomProvider(catalog, {
            name,
            baseUrl,
            apiKey: filled[0].apiKey.trim(),
            template: 'relay',
          });
          catalog = created.catalog;
          providerId = created.provider.id;
          const first = created.provider.connections[0];
          catalog = updateConnection(catalog, providerId, first.id, {
            label: name,
            baseUrl,
            apiKey: filled[0].apiKey.trim(),
            protocol: filled[0].protocol,
            multiplier: multiplierOfText(filled[0].multiplier),
            billingMode: filled[0].billingMode,
            modeMultipliers: collectModeMultipliers(filled[0]),
            models: filled[0].models.map((model) => entryFor(group, model.modelId, model.contextLength)).filter(isRealModel),
          });
          kept.add(first.id);
          pending = filled.slice(1);
        }

        if (providerId === '') continue;
        for (const key of pending) {
          const result = appendKey(catalog, providerId, group, key);
          catalog = result.catalog;
          kept.add(result.connectionId);
        }
        order.push(groupKeyOf(providerId, baseUrl));
        savedGroups += 1;
      }

      // 用户点了 ×：草稿里已经没有的连接，从配置里删掉
      const stale = [...loadedIds.current].filter((id) => !kept.has(id));
      if (stale.length > 0) {
        for (const provider of catalog.providers) {
          for (const connection of [...provider.connections]) {
            if (stale.includes(connection.id)) {
              catalog = removeConnection(catalog, provider.id, connection.id);
            }
          }
        }
      }
      // 顺序按草稿（拖出来的）来，**所有填了地址的组**都记，不管 Key 填没填
      const orderAll: string[] = [];
      for (const group of draft) {
        const baseUrl = group.baseUrl.trim();
        if (baseUrl === '') continue;
        const providerId =
          group.providerId ??
          (group.vendor !== '' && group.vendor !== CUSTOM
            ? group.vendor
            : catalog.providers.find((provider) =>
                provider.connections.some(
                  (connection) => normalizeUrl(connection.baseUrl) === normalizeUrl(baseUrl),
                ),
              )?.id ?? '');
        if (providerId !== '') orderAll.push(groupKeyOf(providerId, baseUrl));
      }
      catalog = { ...catalog, groupOrder: orderAll };

      if (savedGroups === 0 && stale.length === 0 && pendingRemovals === 0) {
        setError('没有可保存的连接：至少填一把 Key');
        setSaving(false);
        return;
      }

      await saveCatalog(catalog);
      const parts = [`已保存 ${savedGroups} 组连接`];
      if (stale.length > 0) parts.push(`删掉 ${stale.length} 条`);
      if (skippedKeys > 0) parts.push(`${skippedKeys} 把 Key 空着被跳过`);
      await onSaved(parts.join('，'));
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSaving(false);
    }
  }

  const linksForGroup = useCallback((group: DraftGroup): Array<{ label: string; url: string; title: string }> => {
    const out: Array<{ label: string; url: string; title: string }> = [];
    const push = (label: string, raw: string | undefined, title: string) => {
      const url = registrationUrl(raw);
      if (url) out.push({ label, url, title });
    };
    const vendor = group.vendor === '' ? '' : group.vendor;
    if (vendor === 'linghui') {
      out.push({ label: '灵绘中转站（含邀请码）↗', url: LINGHUI_SIGNUP_URL, title: '去灵绘中转站注册，含邀请码' });
    }
    const guide = vendor === 'linghui' ? undefined : GUIDE_VENDORS.find((item) => {
      if (vendor === '') return item.baseUrl.startsWith(normalizeUrl(group.baseUrl));
      return item.baseUrl.startsWith(VENDOR_META[vendor as BuiltinProviderId]?.baseUrl ?? '#');
    });
    if (guide) push(`去注册 ${guide.name} ↗`, guide.keyUrl, `${guide.name} 的 API Key 注册页`);
    return out;
  }, []);

  return (
    <Dialog
      open={open}
      title="配置模型"
      maxWidth={860}
      scrollBody
      bodyClassName="ai-rec-body"
      onDismiss={onClose}
      actions={[
        { label: '取消', onClick: onClose },
        {
          label: '保存',
          kind: 'primary',
          onClick: () => void handleSave(),
          disabled: (filledKeys === 0 && pendingRemovals === 0) || saving,
          testId: 'ai-recommend-save',
        },
      ]}
    >
      <div className="ai-rec-head">
        <p className="modal-sub">
          同一个 url 可以配置多把 key ，同一把 key 可以配置多个模型。留空的配置保存时跳过。
        </p>
        <button type="button" className="ai-rec-recommend" onClick={applyRecommended}>
          推荐配置
        </button>
      </div>
      <ul className="ai-rec-why">
        <li><b>deepseek</b>：性价比高、易用、快速的文本模型，适合日常使用</li>
        <li><b>seedance</b>：当前业界领先的视频生成模型，写实画面刚需</li>
        <li><b>gpt-image</b>：当前最好的生图模型，flare 生图，sunburst 改图</li>
        <li><b>gemini</b>：更好的智力，更强的写作</li>
        <li><b>opus</b>：更好的智力，提示词设计、代码做视频</li>
      </ul>

      {error && <p className="error small">{error}</p>}

      {seeded ? draft.map((group, groupIndex) => {
        const lastGroup = draft.length <= 1;
        const candidates = Array.from(
          new Set([
            ...presetTagsFor(providerLike(group)).map((tag) => tag.modelId),
            ...(pulledModels[group.id] ?? []),
          ]),
        );
        return (
          <div
            className={`ai-rec-group${draggingGroupId === group.id ? ' is-dragging' : ''}`}
            key={group.id}
            data-group-index={groupIndex}
            onDragOver={(event) => {
              if (draggingGroupId && draggingGroupId !== group.id) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (draggingGroupId) moveGroup(draggingGroupId, group.id);
              setDraggingGroupId(null);
            }}
          >
            <div className="ai-rec-group-head">
              <button
                type="button"
                className="ai-rec-grip"
                title="拖动调整顺序（用不到的往下拖）"
                aria-label={`拖动第 ${groupIndex + 1} 组`}
                draggable
                onDragStart={(event) => {
                  setDraggingGroupId(group.id);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', group.id);
                }}
                onDragEnd={() => setDraggingGroupId(null)}
              >
                ⋮⋮
              </button>
              <span className="ai-rec-dot" aria-hidden="true" />
              {group.title ?? vendorNameOf(group)}
              {group.existingConnectionId ? <span className="ai-rec-tag">已配置</span> : null}
              {linksForGroup(group).length > 0 ? (
                <span className="ai-rec-group-links">
                  {linksForGroup(group).map((link) => (
                    <a
                      key={link.url}
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ai-rec-signup"
                      title={link.title}
                    >
                      {link.label}
                    </a>
                  ))}
                </span>
              ) : null}
            </div>

            {/* 第一层：base_url + 厂商 */}
            <div className="ai-rec-line">
              <span className="ai-rec-k">base_url</span>
              <input
                type="text"
                className="ai-rec-url"
                aria-label={`服务地址 ${groupIndex + 1}`}
                value={group.baseUrl}
                placeholder="https://relay.example.com"
                onChange={(event) => {
                  const next = event.target.value;
                  patchGroup(group.id, (item) => ({ ...item, baseUrl: next }));
                  scheduleDetect(group.id, next);
                }}
                onBlur={(event) => {
                  const timer = timers.current[group.id];
                  if (timer) clearTimeout(timer);
                  detectVendor(group.id, event.target.value);
                }}
              />
              <RecMenu
                ariaLabel={`厂商 ${groupIndex + 1}`}
                buttonClassName="ai-rec-vendor"
                value={group.vendor}
                options={VENDOR_OPTIONS}
                onChange={(value) => {
                  const next = value as VendorChoice;
                  patchGroup(group.id, (item) => ({
                    ...item,
                    vendor: next,
                    // 换成内置厂商且地址还空着 → 带出官方地址（不覆盖用户已经写的）
                    baseUrl:
                      item.baseUrl.trim() === '' && next !== CUSTOM
                        ? VENDOR_META[next].baseUrl
                        : item.baseUrl,
                  }));
                }}
              />
              {/* 选「自定义」时才出现：名称自己填，地址用上面的 base_url */}
              {group.vendor === CUSTOM ? (
                <input
                  type="text"
                  className="ai-rec-vendor-input"
                  aria-label={`厂商名 ${groupIndex + 1}`}
                  value={group.customName}
                  placeholder="自己填厂商名"
                  onChange={(event) =>
                    patchGroup(group.id, (item) => ({ ...item, customName: event.target.value }))
                  }
                />
              ) : null}
              <button type="button" className="ai-mini" title="再加一组连接" aria-label="再加一组" onClick={addGroup}>
                +
              </button>
              <button
                type="button"
                className="ai-mini ai-mini-del"
                title={lastGroup ? '至少要保留一组' : '删除整组（含名下所有 Key 与模型）'}
                aria-label="删除整组"
                disabled={lastGroup}
                onClick={() => removeGroup(group.id)}
              >
                ×
              </button>
            </div>

            {/* 第二层：Key（协议 / 计费方式跟着 Key 走）+ 第三层：模型 */}
            {group.keys.map((key, keyIndex) => {
              const lastKey = group.keys.length <= 1;
              const keyShown = keyVisible[key.id] === true;
              return (
                <div className="ai-rec-keyblock" key={key.id}>
                  <div className={`ai-rec-line ai-rec-key-line${keyIndex > 0 ? ' ai-rec-key-split' : ''}`}>
                    <span className="ai-rec-k">api_key</span>
                    <span className="ai-rec-key-field">
                      <input
                        type={keyShown ? 'text' : 'password'}
                        className="ai-rec-key"
                        aria-label={`API Key ${groupIndex + 1}-${keyIndex + 1}`}
                        autoComplete="off"
                        spellCheck={false}
                        value={key.apiKey}
                        placeholder={group.vendor === '' ? '填入 API Key' : `填入 ${shortVendorName(vendorNameOf(group))} 的 Key`}
                        onChange={(event) =>
                          updateKey(group.id, key.id, (item) => ({ ...item, apiKey: event.target.value }))
                        }
                      />
                      <button
                        type="button"
                        className="ai-rec-eye"
                        aria-label={`${keyShown ? '隐藏' : '显示'} API Key ${groupIndex + 1}-${keyIndex + 1}`}
                        aria-pressed={keyShown}
                        title={keyShown ? '隐藏 Key' : '显示 Key（核对粘贴有没有少字符）'}
                        onClick={() =>
                          setKeyVisible((current) => ({ ...current, [key.id]: !keyShown }))
                        }
                      >
                        {keyShown ? '隐藏' : '显示'}
                      </button>
                    </span>
                    {/* 协议：收起时只写简称，展开的列表写全名（省空间，也不丢信息） */}
                    <RecMenu
                      ariaLabel={`协议 ${groupIndex + 1}-${keyIndex + 1}`}
                      buttonClassName="ai-rec-proto"
                      title={protocolEndpointTitle(key.protocol, group.baseUrl)}
                      value={key.protocol}
                      options={PROTOCOL_OPTIONS}
                      onChange={(protocol) =>
                        updateKey(group.id, key.id, (item) => ({
                          ...item,
                          protocol: protocol as ProviderProtocol,
                        }))
                      }
                    />
                    <RecMenu
                      ariaLabel={`计费方式 ${groupIndex + 1}-${keyIndex + 1}`}
                      buttonClassName="ai-rec-billing"
                      title="计费方式决定估算口径；悬停看每一项的说明"
                      value={key.billingMode}
                      options={billingOptions(fx.rate)}
                      onChange={(next) => {
                        const mode = next as BillingMode;

                        updateKey(group.id, key.id, (item) => {
                          // 选了同一个：不动（不能把用户刚填的数重置）
                          if (item.billingMode === mode) return item;
                          const parsed = multiplierOfText(item.multiplier);
                          // 离开这一种方式：把它当时的数字记到自己那一格
                          const modeMultipliers: Partial<Record<BillingMode, string>> = {
                            ...item.modeMultipliers,
                            [item.billingMode]: String(parsed),
                          };
                          return {
                            ...item,
                            billingMode: mode,
                            modeMultipliers,
                            // 切到新方式：有记录还原记录，没有才用默认值（绝不沿用上一种的数）
                            multiplier:
                              modeMultipliers[mode] ?? String(defaultMultiplierFor(mode, fx.rate)),
                          };
                        });
                      }}
                    />
                    {/* 数字一直显示：1 / 0 / 汇率都要让人看得见，才知道刚才那个选项做了什么 */}
                    <input
                      type="text"
                      inputMode="decimal"
                      className="ai-rec-mult"
                      aria-label={`倍率 ${groupIndex + 1}-${keyIndex + 1}`}
                      title={
                        key.billingMode === 'overseas'
                          ? `汇率：1 美元 ≈ ${fx.rate.toFixed(2)} 人民币（${formatFxHint(fx)}）`
                          : key.billingMode === 'domestic'
                            ? '国内模型官方价本来就是元，倍率固定 1'
                            : key.billingMode === 'subscription'
                              ? '包月订阅，单次不记账，倍率固定 0'
                              : '分组倍率：官方价 × 倍率 = 实付估算（基础价按中转站 ¥1=$1 折算）'
                      }
                      value={key.multiplier}
                      onChange={(event) =>
                        updateKey(group.id, key.id, (item) => ({ ...item, multiplier: event.target.value }))
                      }
                      onBlur={(event) =>
                        updateKey(group.id, key.id, (item) => ({
                          ...item,
                          multiplier: String(multiplierOfText(event.target.value)),
                        }))
                      }
                    />
                    <button
                      type="button"
                      className="ai-mini ai-mini-text"
                      title="从站上拉模型列表，补进下面的模型下拉（不改已填好的行）"
                      aria-label="拉取模型"
                      disabled={pullingKeyId === key.id}
                      onClick={() => void pullModelsForKey(group, key)}
                    >
                      {pullingKeyId === key.id ? '拉取中' : '拉取'}
                    </button>
                    <button
                      type="button"
                      className="ai-mini"
                      title="同一地址再加一把 Key（换协议或另一把额度不同的 Key 时才需要）"
                      aria-label="再加一把 Key"
                      onClick={() => addKey(group.id)}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="ai-mini ai-mini-del"
                      title={lastKey ? '每组至少要保留一把 Key' : '删除这把 Key 与它名下的模型'}
                      aria-label="删除这把 Key"
                      disabled={lastKey}
                      onClick={() => removeKey(group.id, key.id)}
                    >
                      ×
                    </button>
                  </div>

                  {key.models.map((model) => {
                    const lastModel = key.models.length <= 1;
                    const known = candidates.includes(model.modelId);
                    const probe = modelProbes[model.id];
                    const resolved = resolveContext(model);
                    return (
                      <div className="ai-rec-line ai-rec-model-line" key={model.id}>
                        {group.vendor === CUSTOM ? (
                          <input
                            type="text"
                            className="ai-rec-model"
                            list={`ai-model-options-${group.id}`}
                            aria-label={`模型 ${groupIndex + 1}-${keyIndex + 1}`}
                            value={model.modelId}
                            placeholder="填模型 id，也可以从下拉里挑"
                            onChange={(event) => setModel(group.id, key.id, model.id, event.target.value)}
                          />
                        ) : (
                          <select
                            className="ai-rec-model"
                            aria-label={`模型 ${groupIndex + 1}-${keyIndex + 1}`}
                            value={model.modelId}
                            onChange={(event) => setModel(group.id, key.id, model.id, event.target.value)}
                          >
                            {!known && <option value={model.modelId}>{model.modelId || '（未选）'}</option>}
                            {candidates.map((modelId) => (
                              <option key={modelId} value={modelId}>
                                {modelId}
                              </option>
                            ))}
                          </select>
                        )}
                        <datalist id={`ai-model-options-${group.id}`}>
                          {candidates.map((modelId) => (
                            <option key={modelId} value={modelId} />
                          ))}
                        </datalist>
                        {/*
                          1M：模型本身支持，但大多数 OpenAI 兼容接口默认只按 128k 算。
                          勾上 = 在配置里声明这条模型的上下文窗口是 1M，生成页的长文会话才不会被过早判定「太长」。
                        */}
                        <RecMenu
                          ariaLabel={`上下文窗口 ${groupIndex + 1}-${keyIndex + 1}`}
                          buttonClassName="ai-rec-ctx"
                          value={model.contextLength ? String(model.contextLength) : 'auto'}
                          options={contextOptions(resolved)}
                          title={contextTitle(resolved)}
                          onChange={(value) => setModelContext(group.id, key.id, model.id, value)}
                        />
                        {/* 逐个模型测：一个 Key 下有几个模型时，只测第一个测不出后面写错的那个 */}
                        <span
                          className={`ai-rec-model-flag is-${probe?.status ?? 'idle'}`}
                          role="status"
                          title={probe?.text ?? ''}
                        >
                          {probe?.status === 'ok'
                            ? '✓'
                            : probe?.status === 'fail'
                              ? '✗'
                              : probe?.status === 'running'
                                ? '…'
                                : ''}
                        </span>
                        <button
                          type="button"
                          className="ai-mini ai-mini-text"
                          title="用这个模型发一次最小请求，单独确认它能不能调通"
                          aria-label={`测试模型 ${model.modelId || '（未选）'}`}
                          disabled={probe?.status === 'running' || model.modelId.trim() === ''}
                          onClick={() => void testModel(group, key, model)}
                        >
                          测试
                        </button>
                        <button
                          type="button"
                          className="ai-mini"
                          title="这把 Key 下再加一个模型"
                          aria-label="再加一个模型"
                          onClick={() => addModel(group.id, key.id)}
                        >
                          +
                        </button>
                        <button
                          type="button"
                          className="ai-mini ai-mini-del"
                          title={lastModel ? '每把 Key 至少要保留一个模型' : '只删这一行'}
                          aria-label="删除这个模型"
                          disabled={lastModel}
                          onClick={() => removeModel(group.id, key.id, model.id)}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}


          </div>
        );
      }) : (
        <p className="ai-rec-loading">正在读取已有配置…</p>
      )}

      {filledKeys === 0 && pendingRemovals === 0 ? (
        <p className="ai-rec-hint">填一把 Key 就能保存；也可以点右上角「推荐配置」自动填好常用的三组。</p>
      ) : null}
      {/*
      {filledKeys > 0 && skippedKeys > 0 && (
        <p className="ai-rec-warn">Key 空着的 {skippedKeys} 行保存时会跳过</p>
      )}
      */}
      {toast ? (
        <div
          className={`ai-rec-toast is-${toast.kind}`}
          role="status"
          aria-live="polite"
          onMouseEnter={() => setToastHovered(true)}
          onMouseLeave={() => setToastHovered(false)}
        >
          <span className="ai-rec-toast-icon" aria-hidden="true">
            {toast.kind === 'ok' ? '✓' : '✗'}
          </span>
          <span className="ai-rec-toast-text">{toast.text}</span>
          <button
            type="button"
            className="ai-rec-toast-close"
            aria-label="关闭提示"
            title="关闭"
            onClick={() => setToast(null)}
          >
            ×
          </button>
        </div>
      ) : null}
    </Dialog>
  );
}

/** 空模型 id 不允许落库（会变成一条看不见的模型行） */
function isRealModel(entry: ModelEntry): boolean {
  return entry.modelId.trim() !== '';
}

/**
 * 写入一条连接。三种情况分开处理：
 *
 * 1. 这一行是从已有配置回填的（有 connectionId）→ 原地更新那条连接；
 * 2. 新加的一行，且**同 URL + 同协议 + 同一把 Key** 已经存在 → 只补模型（重复保存不产生冗余）；
 * 3. 其余（包括同 URL 同协议但 Key 不同的）→ 新建一条。
 *
 * 第 3 条是必须的：中转站允许同一地址挂多把 Key（一把跑 gpt-image、另一把跑 gemini）。
 * 只按 URL + 协议判重，会把第二把的模型并进第一把。
 */
function appendKey(
  catalog: AICatalog,
  providerId: string,
  group: DraftGroup,
  key: DraftKey,
): { catalog: AICatalog; connectionId: string } {
  const wanted = key.models.map((model) => entryFor(group, model.modelId, model.contextLength)).filter(isRealModel);
  const provider = catalog.providers.find((item) => item.id === providerId);
  const sameUrl = normalizeUrl(group.baseUrl);
  const apiKey = key.apiKey.trim();

  /**
   * 合并模型表：**同 modelId 以草稿为准**（否则改「1M」/改名都不会落库），
   * 库里多出来的模型原样保留（不清空用户以前配的）。
   */
  const mergedModels = (base: ModelEntry[]): ModelEntry[] => {
    const merged = base.map(
      (model) => wanted.find((item) => item.modelId === model.modelId) ?? model,
    );
    const known = new Set(base.map((model) => model.modelId));
    return [...merged, ...wanted.filter((model) => !known.has(model.modelId))];
  };

  // ① 回填行：改它自己那条（Key 被用户改过也照样改这条，而不是新建）
  const origin = key.connectionId
    ? provider?.connections.find((item) => item.id === key.connectionId)
    : undefined;
  if (origin) {
    const next = updateConnection(catalog, providerId, origin.id, {
      baseUrl: group.baseUrl.trim(),
      apiKey,
      protocol: key.protocol,
      multiplier: multiplierOfText(key.multiplier),
      billingMode: key.billingMode,
      modeMultipliers: collectModeMultipliers(key),
      models: mergedModels(origin.models),
    });
    return { catalog: next, connectionId: origin.id };
  }

  // ② 同一把 Key 又存了一次：只补缺的模型
  const sameKey = apiKey
    ? provider?.connections.find(
        (item) =>
          normalizeUrl(item.baseUrl) === sameUrl &&
          (item.protocol ?? 'openai') === key.protocol &&
          item.apiKey.trim() === apiKey,
      )
    : undefined;
  if (sameKey) {
    const next = updateConnection(catalog, providerId, sameKey.id, {
      modeMultipliers: collectModeMultipliers(key),
      models: mergedModels(sameKey.models),
    });
    return { catalog: next, connectionId: sameKey.id };
  }

  // ③ 新的一把 Key（同地址、同协议也可能有多把）
  const created = addConnection(catalog, providerId, {
    label: vendorNameOf(group),
    baseUrl: group.baseUrl.trim(),
    apiKey,
    protocol: key.protocol,
    multiplier: multiplierOfText(key.multiplier),
    billingMode: key.billingMode,
    modeMultipliers: collectModeMultipliers(key),
    models: wanted,
  });
  return { catalog: created.catalog, connectionId: created.connection.id };
}
