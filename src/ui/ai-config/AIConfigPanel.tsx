/**
 * AI 配置页主体（M3R4 信息架构重排；M3R6 改连接/模型两级控件）。
 *
 * ```
 * ① 厂商栏（横向 chip）
 * ② 连接表（一行 = 一条连接：当前 | 协议 | base_url | Key | 备注 | 倍率 | 删除）
 * ③ 操作行：[测试连通] [拉取模型列表]
 * ④ 预设模型标签（chip，可换行）
 * ⑤ 已选模型表（启用 | 菜单名 | 实际模型 | 上下文 | 能力 | 删除）+「复制模型表到…」
 * ⑥ 底部：[保存配置]（「导出/导入」已移除：M5a 起备份统一在「设置 → 数据与备份」，
 *    一份 zip 含记录 + 音频 + AI 配置 + 设置 + 价格表，配置页不再有第二套导出）
 * ```
 *
 * M3R6 的两处控件修正（承接方第四次评审）：
 * - **连接行**：「当前」单选原来塞在备注格里，现在独立成第一列（`name="active-conn"`）；
 * - **模型行**：删掉「当前模型」单选，改成「启用」复选框 —— 模型可以配多个、同时可用，
 *   这次用哪个在生成时选（或 `pickModel` 按能力自动挑）。所以页面也不再自己存
 *   `selectedModelId`，选中行由 catalog 的 `lastModelId` 记（自检用它）。
 *
 * 被删掉的三块（M3R4 §3，承接方明确要求）：
 * - 「生成前费用预估（估算）」→ 属于对话/生成时，不属于配置页（`pricing.ts` 保留，视频页照用）；
 * - 「当前可用能力」汇总 → 配置页不该做能力体检；
 * - 价格展示（单价 / 价格来源 / 算例）→ 属于 `model-guide` 页。
 *
 * 依赖注入与 M3 一致：`selfTest` / `listModels` 可注入，
 * 测试里换成假实现 → 断言真实 fetch 一次都没被调用（CHARTER §13.2）。
 * M5a 删掉了 `download` 注入：配置页不再导出文件。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listModels as listModelsApi, runSelfTest } from '../../adapters/ai-models/client';
import type { ListModelsResult, ProbeResult, ProviderInput } from '../../adapters/ai-models/client';
import { runConnectionSelfTest } from '../../adapters/ai-models/self-test';
import { activeConnectionOf, addBlankModel, addConnection, applyPresetTag, copyModelsToConnection, createCustomProvider, createDefaultCatalog, connectionLabel, CUSTOM_TEMPLATES, DEFAULT_MULTIPLIER, findProvider, isCustomProvider, isLocalProvider, loadCatalog, loadActiveProviderId, LOCAL_DEPLOY_NOTICE, modelsOf, MULTIPLIER_INVALID_MESSAGE, multiplierOf, parseMultiplier, presetTagsFor, PROTOCOL_OPTIONS, protocolEndpointTitle, PROVIDER_SLOTS, removeConnection, removeCustomProvider, removeModel, resolveActive, resolveActiveProviderId, saveActiveProviderId, saveCatalog, setActiveConnection, updateConnection, updateModel, VENDOR_META, WEB_CORS_BLOCKED_SUFFIX, BILLING_MODES, BILLING_MODE_LABELS, defaultMultiplierFor } from '../../adapters/ai-models/catalog';
import { useUsdCny } from './use-usd-cny';
import type { AICatalog, Connection, CustomTemplate, Provider, ProviderProtocol, BillingMode } from '../../adapters/ai-models/catalog';
import { AIErrorCode } from '../../adapters/ai-models/types';
import { CORS_BLOCKED_HINT } from '../../adapters/shared/cors';
import { DiagnosticsDetails } from './DiagnosticsDetails';
import { ModelTable } from './ModelTable';

export interface AIConfigPanelDeps {
  /** 连通性探针（测试注入 mock；不传 = 真发请求） */
  selfTest?: (input: ProviderInput) => Promise<ProbeResult>;
  /** 拉模型列表（测试注入 mock） */
  listModels?: (input: ProviderInput) => Promise<ListModelsResult>;
}

type BusyKind = 'probe' | 'models' | 'save' | null;

interface NewVendorDraft {
  name: string;
  baseUrl: string;
  apiKey: string;
  note: string;
  template: CustomTemplate;
}

const EMPTY_VENDOR_DRAFT: NewVendorDraft = {
  name: '',
  baseUrl: '',
  apiKey: '',
  note: '',
  template: 'relay',
};

/**
 * M3R7：连接**已经存在**、但模型表是空的 → 把厂商默认模型补进去。
 *
 * 为什么会有这种连接：模型表在 M3R6 才从「厂商级」挪到「连接级」，
 * `normalizeCatalog` 明确不迁移旧的 `provider.models`（见 catalog.ts:805-807），
 * 所以升级上来的存档里，连接带着 base_url / Key 但 `models: []`。
 * 而默认模型只在 `addConnection` 里生成，`updateConnection` 只合并被改的字段 ——
 * 于是用户填完地址与 Key 也永远看不到模型（就是「这个厂商还没有模型」那个现象）。
 *
 * 这里借用 `addConnection` 的同一套默认模型（它建在一份副本上，原 catalog 不受影响），
 * 把那份 `models` 原样写到已有连接上；不自己拼模型名、不动领域层。
 */
function fillDefaultModels(
  catalog: AICatalog,
  providerId: string,
  connectionId: string,
): AICatalog {
  const target = findProvider(catalog, providerId)?.connections.find((item) => item.id === connectionId);
  if (!target || target.models.length > 0) return catalog;
  const probe = addConnection(catalog, providerId, { label: target.label });
  if (probe.connection.models.length === 0) return catalog;
  return updateConnection(catalog, providerId, connectionId, { models: probe.connection.models });
}

/** 连接行里可编辑的字段（倍率走单独入口：要本地校验） */
type ConnectionPatch = Partial<
  Pick<Connection, 'label' | 'baseUrl' | 'apiKey' | 'protocol' | 'multiplier' | 'billingMode' | 'modeMultipliers'>
>;

export function AIConfigPanel({ deps = {} }: { deps?: AIConfigPanelDeps }) {
  const [catalog, setCatalog] = useState<AICatalog>(createDefaultCatalog);
  const [activeProviderId, setActiveProviderId] = useState<string>(PROVIDER_SLOTS[0]);
  const [selfTest, setSelfTest] = useState<ProbeResult | null>(null);
  const [listResult, setListResult] = useState<ListModelsResult | null>(null);
  const [busy, setBusy] = useState<BusyKind>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const needsFx = catalog.providers.some((provider) =>
    provider.connections.some((item) => item.billingMode === 'overseas'),
  );
  const fx = useUsdCny(needsFx);
  const [vendorDraft, setVendorDraft] = useState<NewVendorDraft>(EMPTY_VENDOR_DRAFT);
  const [creatingVendor, setCreatingVendor] = useState(false);
  /** 「本地部署」类厂商点选模型后的 ComfyUI 说明（§3：只做占位，不假装能调用） */
  const [comfyNotice, setComfyNotice] = useState<string | null>(null);
  /** 倍率输入框里的原始文字（非法输入要留在框里给用户看，但不写进配置） */
  const [multiplierDraft, setMultiplierDraft] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  const probe = deps.selfTest ?? ((input: ProviderInput) => runSelfTest(input));
  const listModelsFn = deps.listModels ?? ((input: ProviderInput) => listModelsApi(input));
  /**
   * M3R9：自检的编排（拉列表 → 挑文本模型 → 发同步请求）统一走 `runConnectionSelfTest`，
   * 组件只负责把注入的两个探针传下去。这样「只有生图/视频模型 → 零请求」这类判据
   * 能在适配器层直接测，不依赖 DOM。
   */
  const runSelfTestForConnection = (input: Parameters<typeof runConnectionSelfTest>[0]) =>
    runConnectionSelfTest(input, { selfTest: probe, listModels: listModelsFn });
  useEffect(() => {
    let cancelled = false;
    // M3R8：除了 catalog，还要取回「上次看的是哪个厂商」——
    // 少了这一步，刷新后永远落回 providers[0]（智谱），已配置的模型表就"看起来变空了"。
    Promise.all([loadCatalog(), loadActiveProviderId()])
      .then(([saved, lastProviderId]) => {
        if (cancelled) return;
        setCatalog(saved);
        setActiveProviderId(resolveActiveProviderId(saved, lastProviderId));
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * ① 当前页签解析（M3R8）：`activeProviderId` 是「上次点的那个」，可能已经不存在
   * （删了自定义厂商）或还没被 load 覆盖 —— 统一过一遍 `resolveActiveProviderId`，
   * 绝不无声退回 `providers[0]`（那会把「已配置的厂商」换成「智谱」）。
   */
  const activeProviderKey = resolveActiveProviderId(catalog, activeProviderId);
  const provider: Provider | undefined =
    findProvider(catalog, activeProviderKey) ?? catalog.providers[0];
  /**
   * M3R6：模型表挂在连接下 —— 页面上这张模型表就是**当前连接**的模型表，
   * 切连接它整体跟着换（不再有「厂商级模型表」这层）。
   */
  const connection = provider ? activeConnectionOf(provider) : undefined;
  const connectionModels = provider ? modelsOf(provider) : [];
  /**
   * 连通性自检用哪个模型：`resolveActive` 的「上次用的 → 厂商默认 → 第一行」，
   * 且只在当前连接的模型表里找。模型行不再有单选按钮（可以多行同时启用）。
   *
   * M3R9 起它只是**候选**：真正去测哪个由 `runConnectionSelfTest` 决定
   * （先拉列表，列表里挑第一个文本模型；拉不到才用这一行）。
   */
  const selectedModel = provider ? resolveActive(catalog, provider.id).model : undefined;

  /** 模型表 → 自检候选（带能力标签，用来挡掉生图/视频模型） */
  const syncCandidates = useMemo(
    () => connectionModels.map((model) => ({ modelId: model.modelId, caps: model.caps })),
    [connectionModels],
  );

  const vendorMeta = provider && provider.builtin
    ? VENDOR_META[provider.id as keyof typeof VENDOR_META]
    : undefined;

  const providerInput: ProviderInput = useMemo(
    () => ({
      baseUrl: connection?.baseUrl ?? '',
      apiKey: connection?.apiKey ?? '',
      model: selectedModel?.modelId ?? '',
      protocol: (connection?.protocol ?? vendorMeta?.protocol ?? 'openai') as ProviderProtocol,
      syncCandidates,
    }),
    [
      connection?.baseUrl,
      connection?.apiKey,
      connection?.protocol,
      selectedModel?.modelId,
      vendorMeta?.protocol,
      syncCandidates,
    ],
  );

  /**
   * §1.3：切厂商 → 自动带出 activeConnection（连接是派生的）+ 上次用的模型。
   *
   * M3R9 §5：**点厂商 chip 就把连接建出来**（原来是点模型标签才填地址）。
   * 用户看到的第一屏已经是「地址就位、只差填 Key」，不必先点「＋ 新建连接」或点标签。
   * 已经有一条连接时不重复建（也不覆盖用户改过的地址）。
   */
  const selectProvider = useCallback((providerId: string) => {
    setCatalog((current) => {
      const target = findProvider(current, providerId);
      // 0 条连接 → 立刻建一条，并按 VENDOR_META 填空（M3R9 §5）
      if (!target || target.connections.length > 0) return current;
      const meta = target.builtin
        ? VENDOR_META[target.id as keyof typeof VENDOR_META]
        : undefined;
      const created = addConnection(current, providerId, {
        label: target.name,
        baseUrl: meta?.baseUrl ?? '',
        protocol: meta?.protocol ?? 'openai',
        multiplier: DEFAULT_MULTIPLIER,
      });
      return setActiveConnection(created.catalog, providerId, created.connection.id);
    });
    setActiveProviderId(providerId);
    // M3R8：记住这次选择（best-effort，写失败不影响任何配置保存）
    void saveActiveProviderId(providerId).catch(() => undefined);
    setSelfTest(null);
    setListResult(null);
    setNotice(null);
    setFormError(null);
    setComfyNotice(null);
    setMultiplierDraft({});
  }, []);

  /**
   * 「表单即连接」（M3R3 §1，M3R4 保留）：连接表现在是逐行的，
   * - 有连接时：改哪一行就改那一行，并把它设为当前连接（自检/生成都用它）；
   * - 0 条连接时：把这一行的第一次编辑直接当成第 1 条连接，不必先点「＋ 新建连接」。
   */
  const handleEditRow = useCallback(
    (connectionId: string | null, patch: ConnectionPatch) => {
      if (!provider) return;
      const providerId = provider.id;
      setCatalog((current) => {
        const target = findProvider(current, providerId);
        if (!target) return current;
        if (connectionId && target.connections.some((item) => item.id === connectionId)) {
          const updated = updateConnection(current, providerId, connectionId, patch);
          // M3R7：填地址 / Key 时，若这条连接的模型表还是空的（升级上来的老存档），把默认模型补上
          const identityEdited = patch.baseUrl !== undefined || patch.apiKey !== undefined;
          const filled = identityEdited
            ? fillDefaultModels(updated, providerId, connectionId)
            : updated;
          return setActiveConnection(filled, providerId, connectionId);
        }
        // 0 条连接：把这次编辑直接当成第 1 条连接
        const meta = target.builtin
          ? VENDOR_META[target.id as keyof typeof VENDOR_META]
          : undefined;
        const created = addConnection(current, providerId, {
          label: target.name,
          baseUrl: meta?.baseUrl ?? '',
          apiKey: '',
          protocol: meta?.protocol ?? 'openai',
          multiplier: DEFAULT_MULTIPLIER,
          ...patch,
        });
        return setActiveConnection(created.catalog, providerId, created.connection.id);
      });
      setSelfTest(null);
      setListResult(null);
    },
    [provider],
  );

  const handleAddConnection = useCallback(() => {
    if (!provider) return;
    const fallbackBaseUrl = provider.builtin
      ? VENDOR_META[provider.id as keyof typeof VENDOR_META]?.baseUrl ?? ''
      : '';
    const connectionCount = provider.connections.length + 1;
    const result = addConnection(catalog, provider.id, {
      label: `连接 ${connectionCount}`,
      baseUrl: fallbackBaseUrl,
      apiKey: '',
      protocol: vendorMeta?.protocol ?? 'openai',
      multiplier: DEFAULT_MULTIPLIER,
    });
    // 新建后直接切到这条连接：base_url 与 key 一定是同一条上的
    setCatalog(setActiveConnection(result.catalog, provider.id, result.connection.id));
    setSelfTest(null);
    setListResult(null);
  }, [catalog, provider, vendorMeta?.protocol]);

  const handleRemoveRow = useCallback(
    (connectionId: string) => {
      if (!provider) return;
      setCatalog((current) => removeConnection(current, provider.id, connectionId));
      setSelfTest(null);
      setListResult(null);
    },
    [provider],
  );

  const handleSetActive = useCallback(
    (connectionId: string) => {
      if (!provider) return;
      setCatalog((current) => setActiveConnection(current, provider.id, connectionId));
      setSelfTest(null);
      setListResult(null);
    },
    [provider],
  );

  /**
   * 倍率（§4.2）：非法值（`NaN`、负数）**本地拒绝** —— 输入框保留用户敲的字，
   * 但配置里不写，并给一句人话提示。空串按默认 1 处理。
   */
  const handleMultiplierChange = useCallback(
    (connectionId: string | null, raw: string) => {
      const key = connectionId ?? 'draft';
      setMultiplierDraft((current) => ({ ...current, [key]: raw }));
      const parsed = parseMultiplier(raw);
      if (parsed === null) {
        setFormError(MULTIPLIER_INVALID_MESSAGE);
        return;
      }
      setFormError(null);
      handleEditRow(connectionId, { multiplier: parsed });
    },
    [handleEditRow, fx.rate],
  );

  /**
 * 切计费方式。
 * - 离开一种方式时，把它当时的倍率写进 `modeMultipliers[旧方式]`（用户改过的数字必须留住）；
 * - 切到新方式时，`modeMultipliers[新方式]` 有记录就还原，没有才填该方式的默认值。
 */
  const handleBillingModeChange = useCallback(
    (connectionId: string | null, mode: string, currentText: string, current?: Connection | null) => {
      const next = BILLING_MODES.find((candidate): candidate is BillingMode => candidate === mode);
      if (!next) return;
      const previous = current?.billingMode ?? 'relay';
      // 选了同一个：不动（否则会把用户刚填的数按默认值重置）
      if (previous === next) return;
      setFormError(null);

      const parsed = parseMultiplier(currentText);
      const modeMultipliers: Partial<Record<BillingMode, number>> = {
        ...(current?.modeMultipliers ?? {}),
        ...(parsed !== null ? { [previous]: parsed } : {}),
      };
      const multiplier = modeMultipliers[next] ?? defaultMultiplierFor(next, fx.rate);
      const patch: ConnectionPatch = { billingMode: next, multiplier, modeMultipliers };

      setMultiplierDraft((drafts) => ({ ...drafts, [connectionId ?? 'draft']: String(multiplier) }));
      handleEditRow(connectionId, patch);
    },
    [handleEditRow, fx.rate],
  );
  /** 失焦后回到「配置里真正存着的值」，避免框里一直留着被拒的输入 */
  const resetMultiplierDraft = useCallback((connectionId: string | null) => {
    const key = connectionId ?? 'draft';
    setMultiplierDraft((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const handleApplyTag = useCallback(
    (tagIndex: number) => {
      if (!provider) return;
      const tags = presetTagsFor(provider);
      const tag = tags[tagIndex];
      if (!tag) return;
      const next = applyPresetTag(catalog, provider.id, tag);
      // 选中哪一行由 catalog 自己记（preset 会把 lastModelId 指到刚加/刚点的那行）
      setCatalog(next);
      setSelfTest(null);
      setListResult(null);
      setNotice(null);
      setComfyNotice(isLocalProvider(provider) ? LOCAL_DEPLOY_NOTICE : null);
    },
    [catalog, provider],
  );

  /**
   * 「测试连通」= 按这把 key 的真实能力自检（M3R9 §1）：
   * 先拉一次模型列表挑出文本模型，再按【协议 + 模型】发一次同步请求。
   * 这条连接里只有生图/视频模型时**一个请求都不发**（§2）——由 `runConnectionSelfTest` 保证。
   */
  const handleSelfTest = useCallback(async () => {
    setBusy('probe');
    setFormError(null);
    setNotice(null);
    try {
      const outcome = await runSelfTestForConnection(
        {
          baseUrl: providerInput.baseUrl,
          apiKey: providerInput.apiKey,
          protocol: providerInput.protocol,
          selectedModel: selectedModel
            ? { modelId: selectedModel.modelId, caps: selectedModel.caps }
            : undefined,
          connectionModels: syncCandidates,
        },
      );
      setSelfTest(outcome.probe);
      // 自检顺手拉到的列表也留着：用户不必再点一次「拉取模型列表」才知道站上有啥
      if (outcome.listing?.ok) setListResult(outcome.listing);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '自检失败');
    } finally {
      setBusy(null);
    }
  }, [deps, providerInput, selectedModel, syncCandidates]);

  const handleListModels = useCallback(async () => {
    setBusy('models');
    setFormError(null);
    setNotice(null);
    try {
      setListResult(await listModelsFn(providerInput));
    } catch (error) {
      setListResult({
        ok: false,
        models: [],
        url: '',
        error: {
          code: AIErrorCode.UNKNOWN,
          message: error instanceof Error ? error.message : '拉取模型列表失败',
          userMessage: '拉取模型列表失败：可以先手填模型名，不影响保存配置',
          retryable: false,
        },
      });
    } finally {
      setBusy(null);
    }
  }, [listModelsFn, providerInput]);

  const handleAddListedModel = useCallback(
    (modelId: string) => {
      if (!provider || !modelId) return;
      const next = addBlankModel(catalog, provider.id);
      const updated = findProvider(next, provider.id);
      const added = updated ? modelsOf(updated).slice(-1)[0] : undefined;
      if (!added) return;
      setCatalog(
        updateModel(next, provider.id, added.id, {
          displayName: modelId,
          modelId,
          caps: ['text'],
          note: '从站上拉取',
        }),
      );
    },
    [catalog, provider],
  );

  const handleSave = useCallback(async () => {
    setBusy('save');
    setFormError(null);
    try {
      const saved = await saveCatalog(catalog);
      setCatalog(saved);
      setNotice('配置已保存到本机浏览器（IndexedDB）。');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(null);
    }
  }, [catalog]);

  const handleCreateVendor = useCallback(() => {
    if (!vendorDraft.name.trim()) {
      setFormError('给这个自定义厂商起个名字（例如「灵绘 gpt 组」）');
      return;
    }
    const result = createCustomProvider(catalog, vendorDraft);
    setCatalog(result.catalog);
    setActiveProviderId(result.provider.id);
    void saveActiveProviderId(result.provider.id).catch(() => undefined);
    setVendorDraft(EMPTY_VENDOR_DRAFT);
    setCreatingVendor(false);
    setFormError(null);
    setNotice('已新建自定义厂商：记得点「保存配置」写进本机。');
  }, [catalog, vendorDraft]);

  const handleRemoveVendor = useCallback(() => {
    if (!provider || !isCustomProvider(provider)) return;
    const next = removeCustomProvider(catalog, provider.id);
    setCatalog(next);
    // 记住的是被删掉的厂商时，落到「第一条已配置的」而不是无脑 providers[0]
    const fallbackId = resolveActiveProviderId(next, null);
    setActiveProviderId(fallbackId);
    void saveActiveProviderId(fallbackId).catch(() => undefined);
    setNotice('已删除这个自定义厂商（保存后生效）。');
  }, [catalog, provider]);

  const tabs = useMemo(() => {
    const items: Array<{
      key: string;
      label: string;
      providerId?: string;
      needsRelay?: boolean;
      /** M3R10 §2：只从 VENDOR_META 读，不在 JSX 里按厂商名判断 */
      webCorsBlocked?: boolean;
    }> = [];
    for (const slot of PROVIDER_SLOTS) {
      if (slot === 'custom') {
        for (const item of catalog.providers.filter((candidate) => isCustomProvider(candidate))) {
          items.push({ key: item.id, label: item.name, providerId: item.id });
        }
        /**
         * M3R11 §2：**「＋ 自定义」不再标**「浏览器版不可用」—— 用户可能填的是
         * CORS 放行的站（自建 / 官方 API），一律标会被误伤。只有厂商标里
         * `webCors === 'blocked'` 的（现在只剩灵绘）才标。
         */
        items.push({ key: 'custom-new', label: '＋ 自定义' });
        continue;
      }
      const meta = VENDOR_META[slot];
      const exists = catalog.providers.some((candidate) => candidate.id === slot);
      if (meta && exists) {
        items.push({
          key: slot,
          label: meta.name,
          providerId: slot,
          needsRelay: meta.needsRelay,
          webCorsBlocked: meta.webCors === 'blocked',
        });
      }
    }
    return items;
  }, [catalog.providers]);

  const tags = provider ? presetTagsFor(provider) : [];
  const listIsInfo = listResult?.ok === false && listResult.error?.code === AIErrorCode.MODELS_NOT_LISTED;

  /** 连接表的数据源：0 条连接时给一条「新建行」，填哪个字段都会建出第 1 条 */
  const connectionRows: Array<{ id: string | null; connection?: Connection; index: number }> = provider
    ? provider.connections.length === 0
      ? [{ id: null, index: 0 }]
      : provider.connections.map((item, index) => ({ id: item.id, connection: item, index }))
    : [];

  return (
    <section className="page ai-config-page" data-testid="ai-config-page">
      <h2>AI 配置</h2>
      <p className="muted small">
        Key 默认明文保存在本机浏览器（IndexedDB），不上传任何服务器；导出文件默认不含 Key。
        {' '}
        <a className="muted guide-link" href="#/model-guide">
          了解如何选择厂商与模型？
        </a>
      </p>

      {/* ① 厂商栏 */}
      <section className="card" data-testid="vendor-rail" data-block="vendor">
        <div className="chip-row vendor-tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={tab.providerId !== undefined && tab.providerId === provider?.id}
              className={`button chip ${tab.providerId !== undefined && tab.providerId === provider?.id ? 'primary' : 'ghost'}`}
              onClick={() => {
                if (tab.providerId !== undefined) {
                  selectProvider(tab.providerId);
                } else {
                  setCreatingVendor((current) => !current);
                }
              }}
            >
              {tab.label}
              {tab.webCorsBlocked ? (
                <span className="tab-hint" data-testid="web-cors-hint">
                  {' '}
                  {WEB_CORS_BLOCKED_SUFFIX}
                </span>
              ) : null}
              {tab.needsRelay ? <span className="tab-hint">（国内需中转）</span> : null}
            </button>
          ))}
        </div>

        {provider && (
          <p className="muted small vendor-note">
            {provider.name}：{vendorMeta?.note ?? '自定义厂商（地址与 key 都存在连接里）'}
            {isCustomProvider(provider) && (
              <button type="button" className="button ghost link-button" onClick={handleRemoveVendor}>
                删除这个自定义厂商
              </button>
            )}
          </p>
        )}

        {creatingVendor && (
          <div className="new-vendor">
            <p className="muted small">
              新建一个自定义厂商：地址与 key 只填一次，以后切厂商就能直接复用，不必反复填 base_url。
            </p>
            <div className="stt-form">
              <label className="field">
                <span>厂商名称</span>
                <input
                  type="text"
                  aria-label="新厂商名称"
                  value={vendorDraft.name}
                  placeholder="例如：灵绘 gpt 组"
                  onChange={(event) => setVendorDraft({ ...vendorDraft, name: event.target.value })}
                />
              </label>
              <label className="field">
                <span>base_url（可空，之后再填）</span>
                <input
                  type="text"
                  aria-label="新厂商地址"
                  value={vendorDraft.baseUrl}
                  placeholder="https://relay.example.com（带不带 /v1 都行）"
                  onChange={(event) => setVendorDraft({ ...vendorDraft, baseUrl: event.target.value })}
                />
              </label>
              <label className="field">
                <span>API Key（可空）</span>
                <input
                  type="password"
                  aria-label="新厂商 API Key"
                  autoComplete="off"
                  value={vendorDraft.apiKey}
                  placeholder="sk-..."
                  onChange={(event) => setVendorDraft({ ...vendorDraft, apiKey: event.target.value })}
                />
              </label>
              <label className="field">
                <span>备注</span>
                <input
                  type="text"
                  aria-label="新厂商备注"
                  value={vendorDraft.note}
                  placeholder="这条连接叫什么（会显示在连接行里）"
                  onChange={(event) => setVendorDraft({ ...vendorDraft, note: event.target.value })}
                />
              </label>
              <label className="field">
                <span>模板</span>
                <select
                  aria-label="新厂商模板"
                  value={vendorDraft.template}
                  onChange={(event) =>
                    setVendorDraft({ ...vendorDraft, template: event.target.value as CustomTemplate })
                  }
                >
                  <option value="relay">{CUSTOM_TEMPLATES.relay.label}（默认模型 claude-opus-5-5）</option>
                  <option value="local">{CUSTOM_TEMPLATES.local.label}（默认模型 qwen-image-2.1）</option>
                </select>
              </label>
            </div>
            <div className="button-row">
              <button type="button" className="button primary" onClick={handleCreateVendor}>
                保存新厂商
              </button>
              <button type="button" className="button ghost" onClick={() => setCreatingVendor(false)}>
                取消
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ② 连接表 + ③ 操作行（同一屏） */}
      <section className="card" data-block="connections">
        <div className="model-table-head">
          <h3>连接（base_url 与 API Key 绑在一起）</h3>
          <button type="button" className="button ghost" onClick={handleAddConnection}>
            ＋ 新建连接
          </button>
        </div>
        {/* M3R5 §2-1：两段说明压成一行，长句移进 title（hover 才展开，不占高度） */}
        <p
          className="muted small conn-help"
          title="一行 = 一条连接：多一条就多一行，不做嵌套。同一家站的不同分组（不同 key、不同倍率）各建一行；改哪一行，那一行就成为当前连接。不需要先点「＋ 新建连接」，直接在空行里填字段就会建出第 1 条。"
        >
          一行 = 一条连接，改哪行哪行就是当前连接
          {provider && provider.connections.length === 0 ? (
            <span data-testid="first-connection-hint">
              {' · '}这里填的就是这家厂商的第一条连接，填完即生效
            </span>
          ) : (
            '。'
          )}
        </p>
        {/**
         * M3R10 §2：**配置前就告诉用户**这家浏览器版用不了，别等填完 key 再被拦。
         * 判据只读 `vendorMeta.webCors`（自定义厂商 / 本地部署没有厂商元数据，
         * 它们不在这里标 —— chip 上已经标了「＋ 自定义」）。
         */}
        {vendorMeta?.webCors === 'blocked' ? (
          <p className="notice-info small" role="status" data-testid="web-cors-notice">
            {CORS_BLOCKED_HINT}
          </p>
        ) : null}

        <table className="model-table connection-table" data-conn-grid>
          <thead>
            <tr>
              <th data-col="active">当前</th>
              <th data-col="protocol">协议</th>
              <th data-col="base_url">base_url</th>
              <th data-col="key">API Key</th>
              <th data-col="note">备注</th>
              <th data-col="multiplier" title="先选计费方式；中转站再填分组倍率（基础价按 ¥1=$1 折算）">计费方式</th>
              <th data-col="remove">删除</th>
            </tr>
          </thead>
          <tbody>
            {connectionRows.map((row) => {
              const index = row.index + 1;
              const item = row.connection;
              const active = item
                ? item.id === provider?.activeConnectionId
                : (provider?.connections.length ?? 0) === 0;
              const multiplierKey = row.id ?? 'draft';
              const multiplierText = multiplierDraft[multiplierKey] ?? String(multiplierOf(item));
              const protocolValue = item?.protocol ?? vendorMeta?.protocol ?? 'openai';
              return (
                <tr
                  key={index}
                  data-connection-row={row.id ?? 'draft'}
                  data-active={active ? 'yes' : 'no'}
                >
                  {/* M3R6 §2：「当前」单选不再塞进备注格，独立成第一列（同一厂商内互斥） */}
                  <td data-col="active">
                    <input
                      type="radio"
                      name="active-conn"
                      aria-label={`当前连接 ${index}`}
                      checked={active}
                      disabled={!item}
                      onChange={() => item && handleSetActive(item.id)}
                    />
                  </td>
                  <td data-col="protocol">
                    <select
                      aria-label={`协议 ${index}`}
                      title={protocolEndpointTitle(protocolValue, item?.baseUrl)}
                      value={protocolValue}
                      onChange={(event) =>
                        handleEditRow(row.id, { protocol: event.target.value as ProviderProtocol })
                      }
                    >
                      {PROTOCOL_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td data-col="base_url">
                    <input
                      type="text"
                      aria-label={`服务地址 ${index}`}
                      value={item?.baseUrl ?? ''}
                      placeholder={
                        vendorMeta?.baseUrl ||
                        (provider && isLocalProvider(provider)
                          ? '例如 http://127.0.0.1:8188（ComfyUI）'
                          : 'https://relay.example.com')
                      }
                      onChange={(event) => handleEditRow(row.id, { baseUrl: event.target.value })}
                    />
                  </td>
                  <td data-col="key">
                    <input
                      type="password"
                      aria-label={`API Key ${index}`}
                      autoComplete="off"
                      value={item?.apiKey ?? ''}
                      placeholder="sk-..."
                      onChange={(event) => handleEditRow(row.id, { apiKey: event.target.value })}
                    />
                  </td>
                  <td data-col="note">
                    <input
                      type="text"
                      aria-label={`连接备注 ${index}`}
                      value={item?.label ?? ''}
                      placeholder={provider?.name ?? '备注'}
                      onChange={(event) => handleEditRow(row.id, { label: event.target.value })}
                    />
                  </td>
                  <td data-col="multiplier">
                    <select
                      className="connection-billing"
                      aria-label={`计费方式 ${index}`}
                      value={item?.billingMode ?? 'relay'}
                      title="计费方式决定估算口径：中转站按分组倍率；国内按量默认 1；官方订阅默认 0；国外按量默认 6.8"
                      onChange={(event) => handleBillingModeChange(row.id, event.target.value, multiplierText, item)}
                    >
                      {BILLING_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {BILLING_MODE_LABELS[mode]}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      aria-label={`倍率 ${index}`}
                      min={0}
                      step={0.01}
                      value={multiplierText}
                      title={
                        (item?.billingMode ?? 'relay') === 'overseas'
                          ? `汇率：1 美元 ≈ ${fx.rate.toFixed(2)} 人民币`
                          : (item?.billingMode ?? 'relay') === 'domestic'
                            ? '国内模型官方价本来就是元，倍率固定 1'
                            : (item?.billingMode ?? 'relay') === 'subscription'
                              ? '包月订阅，单次不记账，倍率固定 0'
                              : '分组倍率：官方价 × 倍率 = 实付估算'
                      }
                      onChange={(event) => handleMultiplierChange(row.id, event.target.value)}
                      onBlur={() => resetMultiplierDraft(row.id)}
                    />
                  </td>
                  <td data-col="remove">
                    <button
                      type="button"
                      className="button danger"
                      aria-label={`删除连接 ${index}`}
                      disabled={!item}
                      onClick={() => item && handleRemoveRow(item.id)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* ③ 操作行：与连接表同屏 */}
        <div className="button-row action-row" data-block="actions">
          <button
            type="button"
            className="button"
            onClick={() => void handleSelfTest()}
            disabled={busy !== null}
            title={`会用当前连接（${connection?.label || '未命名连接'}）里的 ${
              selectedModel?.modelId || '（还没选模型）'
            } 做连通性自检`}
          >
            {busy === 'probe' ? '正在自检…' : '测试连通'}
          </button>
          <button type="button" className="button" onClick={() => void handleListModels()} disabled={busy !== null}>
            {busy === 'models' ? '拉取中…' : '拉取模型列表'}
          </button>
        </div>

        {selfTest?.ok && (
          <p className="success small" data-testid="self-test-ok">
            连通正常{selfTest.testedModel ? `（用 ${selfTest.testedModel} 测试）` : ''}：
            {selfTest.url}（HTTP {selfTest.status}，{selfTest.elapsedMs}ms
            {selfTest.usage ? `，usage ${selfTest.usage.total_tokens} token` : ''}）
          </p>
        )}
        {selfTest && !selfTest.ok && selfTest.error && (
          <div
            className={
              selfTest.error.code === AIErrorCode.NO_SYNC_MODEL ||
              selfTest.error.code === AIErrorCode.CORS_BLOCKED
                ? 'notice-info small'
                : 'error small'
            }
            role="status"
            data-kind={
              selfTest.error.code === AIErrorCode.NO_SYNC_MODEL ||
              selfTest.error.code === AIErrorCode.CORS_BLOCKED
                ? 'info'
                : 'error'
            }
          >
            <p>{selfTest.error.userMessage}</p>
            {/**
             * M3R10 §2：自检失败处的那行小字（判据要求逐字）。
             * CORS 不是用户配错了什么东西 —— 归到 `info` 而不是红色 error，
             * 但小字仍要写清「用桌面版可正常调用」，否则用户以为这个厂商不能用了。
             */}
            {selfTest.error.code === AIErrorCode.CORS_BLOCKED ? (
              <p className="muted small" data-testid="self-test-cors-hint">
                {CORS_BLOCKED_HINT}
              </p>
            ) : null}
            <DiagnosticsDetails
              action="连通性自检"
              diagnostics={selfTest.diagnostics}
              rawMessage={selfTest.error.message}
              testId="self-test-diagnostics"
            />
          </div>
        )}

        {listResult?.ok && (
          <div className="success small" data-testid="list-ok">
            <p>
              已从 {listResult.url} 拉到 {listResult.models.length} 个模型。选一个即可加入下面的模型表。
            </p>
            <label className="field">
              <span>站上拉到的模型（选择即加入模型表）</span>
              <select
                aria-label="站上拉到的模型"
                value=""
                onChange={(event) => handleAddListedModel(event.target.value)}
              >
                <option value="">共 {listResult.models.length} 个，点这里选</option>
                {listResult.models.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <DiagnosticsDetails
              action="拉取模型列表"
              diagnostics={listResult.diagnostics}
              testId="list-diagnostics"
            />
          </div>
        )}
        {listResult && !listResult.ok && listResult.error && (
          <div
            className={listIsInfo ? 'notice-info small' : 'error small'}
            role="status"
            data-kind={listIsInfo ? 'info' : 'error'}
          >
            <p>{listResult.error.userMessage}</p>
            <DiagnosticsDetails
              action="拉取模型列表"
              diagnostics={listResult.diagnostics}
              rawMessage={listResult.error.message}
              testId="list-diagnostics"
            />
          </div>
        )}

        {formError && (
          <p className="error small" role="status">
            {formError}
          </p>
        )}
        {notice && <p className="success small">{notice}</p>}
      </section>

      {/* ④ 预设标签 + ⑤ 已选模型表 */}
      <section className="card">
        <h3>模型</h3>
        <div className="chip-row tag-row" data-block="tags">
          {tags.map((tag, index) => (
            <button key={tag.modelId} type="button" className="button ghost chip tag-button" onClick={() => handleApplyTag(index)}>
              {tag.label}
            </button>
          ))}
        </div>
        <p className="muted small" data-testid="model-hint">
          模型可以配多个、全部可用，这次用哪个在生成时选（或按能力自动挑）；点标签只补模型与能力，不动你填的 base_url。
        </p>
        {tags.length === 0 && vendorMeta?.tagHint ? (
          <p className="muted small" data-testid="tag-hint">
            {vendorMeta.tagHint}
          </p>
        ) : null}
        {comfyNotice ? (
          <p className="notice-info small" role="status" data-testid="local-deploy-notice">
            {comfyNotice}
          </p>
        ) : null}
        {provider && (
          <ModelTable
            models={connectionModels}
            copyTargets={provider.connections
              .filter((item) => item.id !== provider.activeConnectionId)
              .map((item) => ({ id: item.id, label: connectionLabel(item) }))}
            onCopy={(targetConnectionId) => {
              const result = copyModelsToConnection(catalog, provider.id, targetConnectionId);
              setCatalog(result.catalog);
              setNotice(
                result.copied === 0
                  ? '当前连接的模型表是空的，没有可复制的行。'
                  : `已把当前连接的 ${result.copied} 行模型复制到所选连接（覆盖它原来的模型表）。`,
              );
            }}
            onUpdate={(modelRowId, patch) =>
              setCatalog((current) => updateModel(current, provider.id, modelRowId, patch))
            }
            onRemove={(modelRowId) =>
              setCatalog((current) => removeModel(current, provider.id, modelRowId))
            }
            onAdd={() => setCatalog(addBlankModel(catalog, provider.id))}
          />
        )}
      </section>

      {/* ⑥ 底部：保存（导出/导入折进「更多」，不占一块） */}
      <div className="button-row config-footer" data-block="save">
        <button
          type="button"
          className="button primary"
          onClick={() => void handleSave()}
          disabled={busy !== null || !loaded}
        >
          {busy === 'save' ? '保存中…' : '保存配置'}
        </button>
      </div>
    </section>
  );
}
