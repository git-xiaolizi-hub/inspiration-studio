/**
 * 「推荐配置」弹窗（R7b §B）。
 *
 * 三组最常见的搭配已经填好地址与模型名，用户只需要补 Key。
 * 结构是三层树：组（base_url）→ Key（协议 / 倍率）→ 模型。
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
  loadCatalog,
  makeId,
  parseMultiplier,
  presetTagsFor,
  protocolEndpointTitle,
  saveCatalog,
  updateConnection,
  urlToProvider,
} from '../../adapters/ai-models/catalog';
import type {
  BillingMode,
  AICatalog,
  BuiltinProviderId,
  ModelEntry,
  ProviderProtocol,
} from '../../adapters/ai-models/catalog';
import { GUIDE_VENDORS, LINGHUI_SIGNUP_URL } from '../../adapters/ai-models/model-guide';
import { Dialog } from '../components/Dialog';
import { RecMenu } from './RecMenu';
import type { RecMenuOption } from './RecMenu';
import { canSyncTest, listModels, runSelfTest } from '../../adapters/ai-models/client';
import { formatFxHint } from '../../core/fx';
import { useUsdCny } from './use-usd-cny';
import { describeError } from '../format';

/** 厂商下拉里「自定义」的取值（内置厂商 id 之外的那一格） */
const CUSTOM = 'custom';

type VendorChoice = BuiltinProviderId | typeof CUSTOM;

interface DraftModel {
  id: string;
  modelId: string;
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
  models: DraftModel[];
}

interface DraftGroup {
  id: string;
  vendor: VendorChoice;
  /** vendor === 'custom' 时用户自己写的厂商名 */
  customName: string;
  baseUrl: string;
  /** 组标题（只有三组初始搭配有；新增组显示「新的一组」） */
  title?: string;
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
function newModel(modelId: string): DraftModel {
  return { id: makeId('dm'), modelId };
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

/**
 * 已经配过的用户不该再填一遍：同一厂商 + 同一 base_url 的连接直接回填进草稿。
 * 一条连接 = 一把 Key（中转站里 claude 与生图可能各一把），匹配到的都映射进来。
 */
function seedGroup(base: DraftGroup, catalog: AICatalog | null): DraftGroup {
  if (!catalog) return base;
  const provider = catalog.providers.find((item) => item.id === base.vendor);
  if (!provider) return base;
  const want = normalizeUrl(base.baseUrl);
  const matched = provider.connections.filter(
    (item) => normalizeUrl(item.baseUrl) === want && item.apiKey.trim() !== '',
  );
  if (matched.length === 0) return base;
  return {
    ...base,
    existingConnectionId: matched[0].id,
    keys: matched.map((item) => ({
      id: makeId('dk'),
      apiKey: item.apiKey,
      protocol: item.protocol ?? 'openai',
      multiplier: String(item.multiplier ?? 1),
      billingMode: item.billingMode ?? 'relay',
      modeMultipliers: item.modeMultipliers
        ? Object.fromEntries(
            Object.entries(item.modeMultipliers).map(([mode, value]) => [mode, String(value)]),
          )
        : undefined,
      models: (item.models.length > 0 ? item.models : [{ modelId: '' }]).map((model) => ({
        id: makeId('dm'),
        modelId: model.modelId,
      })),
    })),
  };
}

export function initialDraft(catalog: AICatalog | null = null): DraftGroup[] {
  return [
    {
      id: 'grp-writing',
      vendor: 'deepseek',
      customName: '',
      baseUrl: 'https://api.deepseek.com',
      title: '写作用 · DeepSeek 官方',
      keys: [newKey(['deepseek-flash'], 'openai', '1', 'domestic')],
    },
    {
      id: 'grp-video',
      vendor: 'ark',
      customName: '',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      title: '生视频用 · 火山方舟（豆包）',
      keys: [newKey(['doubao-seedance-2-5-260628'], 'openai', '1', 'domestic')],
    },
    {
      id: 'grp-image',
      vendor: 'linghui',
      customName: '',
      baseUrl: 'https://xn--ai-xg4e312c.com',
      title: '生图 + 备用写作 · 灵绘中转站',
      keys: [
        newKey(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'], 'openai', '0.1', 'relay'),
        newKey(['claude-opus-5-5'], 'anthropic', '1.1', 'relay'),
      ],
    },
  ].map((group) => seedGroup(group as DraftGroup, catalog));
}

/** 下拉里放短名：124px 的格子塞不下「火山方舟（豆包）」，括号里的补充信息放到 title */
function shortVendorName(name: string): string {
  return name.replace(/（[^）]*）|\([^)]*\)/g, '').trim() || name;
}

function vendorNameOf(group: DraftGroup): string {
  if (group.vendor === CUSTOM) return group.customName.trim() || '自定义厂商';
  return VENDOR_META[group.vendor].name;
}

function providerLike(group: DraftGroup, providerId?: string) {
  return group.vendor === CUSTOM
    ? { id: providerId ?? 'custom:new', builtin: false }
    : { id: group.vendor, builtin: true };
}

/** 某个模型 id 在厂商预设里的定义（名字 / 能力 / 价格都照抄名录，不编） */
function entryFor(group: DraftGroup, modelId: string): ModelEntry {
  const id = modelId.trim();
  const tag = presetTagsFor(providerLike(group)).find((item) => item.modelId === id);
  if (tag) {
    return {
      id: makeId('model'),
      displayName: tag.label,
      modelId: id,
      contextLength: tag.contextLength,
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
    setDraft(initialDraft());
    void loadCatalog().then((catalog) => {
      // 用户已经在填了就别覆盖（会把他刚输入的 Key 冲掉）
      if (alive && !dirtyRef.current) setDraft(initialDraft(catalog));
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
  const skippedKeys = useMemo(
    () => draft.reduce((sum, group) => sum + group.keys.filter((key) => key.apiKey.trim() === '').length, 0),
    [draft],
  );

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

  function setModel(groupId: string, keyId: string, modelRowId: string, modelId: string): void {
    updateKey(groupId, keyId, (key) => ({
      ...key,
      models: key.models.map((model) => (model.id === modelRowId ? { ...model, modelId } : model)),
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
    if (filledKeys === 0) return;
    setSaving(true);
    setError(null);
    try {
      let catalog: AICatalog = await loadCatalog();
      let savedGroups = 0;

      for (const group of draft) {
        const filled = group.keys.filter((key) => key.apiKey.trim() !== '');
        const baseUrl = group.baseUrl.trim();
        if (filled.length === 0 || baseUrl === '') continue;

        let providerId: string = group.vendor;
        if (group.vendor === CUSTOM) {
          const name = vendorNameOf(group);
          const created = createCustomProvider(catalog, {
            name,
            baseUrl,
            apiKey: filled[0].apiKey,
            template: 'relay',
          });
          catalog = created.catalog;
          providerId = created.provider.id;
          // 模板连接先按第一把 Key 改写（协议 / 倍率 / 模型都取自用户填的）
          catalog = updateConnection(catalog, providerId, created.provider.connections[0].id, {
            label: name,
            baseUrl,
            apiKey: filled[0].apiKey.trim(),
            protocol: filled[0].protocol,
            multiplier: multiplierOfText(filled[0].multiplier),
            models: filled[0].models.map((model) => entryFor(group, model.modelId)).filter(isRealModel),
          });
          for (const key of filled.slice(1)) {
            catalog = appendKey(catalog, providerId, group, key);
          }
        } else {
          for (const key of filled) {
            catalog = appendKey(catalog, providerId, group, key);
          }
        }
        savedGroups += 1;
      }

      if (savedGroups === 0) {
        setError('没有可保存的连接：每组都需要填一个 Key');
        setSaving(false);
        return;
      }

      await saveCatalog(catalog);
      const message =
        skippedKeys > 0
          ? `已保存 ${savedGroups} 组连接（${skippedKeys} 把 Key 空着被跳过）`
          : `已保存 ${savedGroups} 组连接`;
      await onSaved(message);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSaving(false);
    }
  }

  const deepseekGuide = GUIDE_VENDORS.find((vendor) => vendor.name === 'DeepSeek');
  const arkGuide = GUIDE_VENDORS.find((vendor) => vendor.baseUrl.startsWith('https://ark.'));
  const links = [
    { label: '去注册 DeepSeek API ↗', url: registrationUrl(deepseekGuide?.keyUrl) },
    { label: '去注册火山引擎（豆包）↗', url: registrationUrl(arkGuide?.keyUrl) },
    { label: '灵绘中转站（含邀请码）↗', url: LINGHUI_SIGNUP_URL },
  ].filter((item): item is { label: string; url: string } => item.url !== null);

  return (
    <Dialog
      open={open}
      title="推荐配置"
      maxWidth={860}
      scrollBody
      bodyClassName="ai-rec-body"
      onDismiss={onClose}
      actions={[
        { label: '取消', onClick: onClose },
        {
          label: `保存这 ${draft.length} 组连接`,
          kind: 'primary',
          onClick: () => void handleSave(),
          disabled: filledKeys === 0 || saving,
          testId: 'ai-recommend-save',
        },
      ]}
    >
      <p className="modal-sub">
        下面三组是最常见的搭配，已经替你填好地址与模型名——<b>只有 Key 需要你自己填</b>
        。填完点保存，写作、生图、生视频就都能用了。
      </p>
      <div className="ai-regs">
        {links.map((link) => (
          <a key={link.label} href={link.url} target="_blank" rel="noreferrer">
            {link.label}
          </a>
        ))}
      </div>

      {error && <p className="error small">{error}</p>}

      {draft.map((group, groupIndex) => {
        const lastGroup = draft.length <= 1;
        const candidates = Array.from(
          new Set([
            ...presetTagsFor(providerLike(group)).map((tag) => tag.modelId),
            ...(pulledModels[group.id] ?? []),
          ]),
        );
        return (
          <div className="ai-rec-group" key={group.id} data-group-index={groupIndex}>
            <div className="ai-rec-group-head">
              <span className="ai-rec-dot" aria-hidden="true" />
              {group.title ?? `新的一组 · ${vendorNameOf(group)}`}
              {group.existingConnectionId ? <span className="ai-rec-tag">已配置</span> : null}
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
                        placeholder={`填入 ${shortVendorName(vendorNameOf(group))} 的 Key`}
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
      })}

      <div className="ai-rec-legend">
        <h4>＋ 和 × 各管多大范围</h4>
        <table>
          <tbody>
            <tr>
              <td>＋ 在 base_url 上</td>
              <td>整组再来一套：新地址 + 一条 Key + 一条模型</td>
            </tr>
            <tr>
              <td>＋ 在 api_key 上</td>
              <td>同一个地址再加一把 Key（含它名下一条模型）</td>
            </tr>
            <tr>
              <td>＋ 在 model 上</td>
              <td>这把 Key 下再加一个模型，共用上面的地址与 Key</td>
            </tr>
            <tr>
              <td>× 在 base_url 上</td>
              <td>删掉整组（含名下所有 Key 与模型）；至少保留一组</td>
            </tr>
            <tr>
              <td>× 在 api_key 上</td>
              <td>删掉这把 Key 与它名下的模型；每组至少保留一把</td>
            </tr>
            <tr>
              <td>× 在 model 上</td>
              <td>只删这一行；每把 Key 至少保留一个模型</td>
            </tr>
          </tbody>
        </table>
      </div>

      {filledKeys === 0 && <p className="ai-rec-warn">至少要填一把 Key</p>}
      {filledKeys > 0 && skippedKeys > 0 && (
        <p className="ai-rec-warn">Key 空着的 {skippedKeys} 行保存时会跳过</p>
      )}
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

/** 追加一把 Key 到既有厂商（合并语义：不动已有连接） */
/**
 * 写入一条连接。**先找再写**：同一厂商 + 同一 base_url + 同一协议已经存在时，
 * 只把缺的模型补进去 —— 反复点保存不会长出重复连接（委托人问的「冗余」）。
 */
function appendKey(
  catalog: AICatalog,
  providerId: string,
  group: DraftGroup,
  key: DraftKey,
): AICatalog {
  const wanted = key.models.map((model) => entryFor(group, model.modelId)).filter(isRealModel);
  const provider = catalog.providers.find((item) => item.id === providerId);
  const sameUrl = normalizeUrl(group.baseUrl);
  const existing = provider?.connections.find(
    (item) => normalizeUrl(item.baseUrl) === sameUrl && (item.protocol ?? 'openai') === key.protocol,
  );

  if (existing) {
    const known = new Set(existing.models.map((model) => model.modelId));
    const added = wanted.filter((model) => !known.has(model.modelId));
    const patch: Parameters<typeof updateConnection>[3] = {
      modeMultipliers: collectModeMultipliers(key),
    };
    if (added.length > 0) patch.models = [...existing.models, ...added];
    // 之前没填过 Key（空着）才补，别覆盖用户已有的
    if (existing.apiKey.trim() === '') patch.apiKey = key.apiKey.trim();
    return updateConnection(catalog, providerId, existing.id, patch);
  }

  return addConnection(catalog, providerId, {
    label: vendorNameOf(group),
    baseUrl: group.baseUrl.trim(),
    apiKey: key.apiKey.trim(),
    protocol: key.protocol,
    multiplier: multiplierOfText(key.multiplier),
    billingMode: key.billingMode,
    modeMultipliers: collectModeMultipliers(key),
    models: wanted,
  }).catalog;
}
