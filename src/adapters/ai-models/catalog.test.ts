/**
 * 厂商 / 连接 / 模型 三层数据模型（M3R §1 §2 §3 §7）。
 *
 * 这里锁的是「数据与交互规则」：纯函数层能测的都在这里测，
 * 界面上的输入框联动放在 `src/ui/ai-config/ai-config-ui.test.tsx`。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, destroyDatabase } from '../../core/storage';
import {
  addBlankModel,
  addConnection,
  applyMultiplier,
  applyPresetTag,
  BUILTIN_PROVIDER_ORDER,
  capHint,
  connectionLabel,
  copyModelsToConnection,
  createCustomProvider,
  createDefaultCatalog,
  BILLING_DEFAULT_MULTIPLIER,
  DEFAULT_MULTIPLIER,
  findProvider,
  isValidMultiplier,
  isLocalProvider,
  listModelsByCap,
  loadActiveProviderId,
  loadCatalog,
  LOCAL_DEPLOY_NOTICE,
  makeId,
  modelsOf,
  multiplierOf,
  MULTIPLIER_INVALID_MESSAGE,
  normalizeCatalog,
  parseCatalogFile,
  parseMultiplier,
  pickModel,
  PRESET_TAGS,
  presetTagsFor,
  PROTOCOL_OPTIONS,
  protocolEndpointTitle,
  PROVIDER_SLOTS,
  removeConnection,
  removeCustomProvider,
  removeModel,
  resolveActive,
  resolveActiveProviderId,
  saveActiveProviderId,
  saveCatalog,
  serializeCatalogFile,
  setActiveConnection,
  sortProviders,
  updateConnection,
  updateModel,
  VENDOR_META,
  WEB_CORS_BLOCKED_SUFFIX,
} from './catalog';
import type { AICatalog, PresetTag } from './catalog';
import { FREE_TRIAL_PRICE_TABLE } from './pricing';

beforeEach(async () => {
  await destroyDatabase();
});

afterEach(async () => {
  await closeDatabase();
});

/** 给某厂商建一条填好的连接 */
function withConnection(
  catalog: AICatalog,
  providerId: string,
  init: { label: string; baseUrl: string; apiKey: string },
): AICatalog {
  const { catalog: added, connection } = addConnection(catalog, providerId, init);
  return setActiveConnection(added, providerId, connection.id);
}

/** 当前连接的模型表（M3R6：模型表在连接里，不在厂商上） */
function modelsOfProvider(catalog: AICatalog, providerId: string) {
  const provider = findProvider(catalog, providerId);
  return provider ? modelsOf(provider) : [];
}

/** 按 modelId 取预设标签（找不到就报错，别静默跳过） */
function findPreset(modelId: string): PresetTag {
  const tag = Object.values(PRESET_TAGS)
    .flat()
    .find((item) => item.modelId === modelId);
  if (!tag) throw new Error(`缺少预设标签：${modelId}`);
  return tag;
}

describe('三层模型：厂商 → 连接 → 模型', () => {
  it('默认目录：11 家内置厂商、连接 0 条 —— 模型表随连接走，所以还没有模型表', () => {
    const catalog = createDefaultCatalog();
    expect(catalog.providers.map((provider) => provider.id)).toEqual([...BUILTIN_PROVIDER_ORDER]);
    for (const provider of catalog.providers) {
      expect(provider.builtin).toBe(true);
      expect(provider.connections).toHaveLength(0);
      // M3R6：厂商级 models 字段已删除（运行时也不该再冒出来）
      expect('models' in provider).toBe(false);
      expect(modelsOf(provider)).toHaveLength(0);
    }
  });

  it('新建连接时用厂商默认模型预填一条（阿里百炼 / MiniMax 文档没给模型 → 空表）', () => {
    for (const id of BUILTIN_PROVIDER_ORDER) {
      const meta = VENDOR_META[id];
      const created = addConnection(createDefaultCatalog(), id, { baseUrl: 'https://x.example.com' });
      const models = created.connection.models;
      if (meta.defaultModelId === '') {
        // 文档里这两家只有介绍、没有云端模型标签：不编一个模型名出来
        expect(models).toHaveLength(0);
        continue;
      }
      expect(models).toHaveLength(1);
      expect(models[0].modelId).toBe(meta.defaultModelId);
      // 预填的行默认参与选择
      expect(models[0].enabled).toBe(true);
    }
    // 文档指定的默认选中
    const zhipu = addConnection(createDefaultCatalog(), 'zhipu', {}).connection;
    const deepseek = addConnection(createDefaultCatalog(), 'deepseek', {}).connection;
    const ark = addConnection(createDefaultCatalog(), 'ark', {}).connection;
    expect(zhipu.models[0].modelId).toBe('glm-5.3-flash');
    expect(deepseek.models[0].modelId).toBe('deepseek-flash');
    expect(ark.models[0].modelId).toBe('doubao-seed-2-1-pro-260628');
    // 两条连接各自的预填行 id 不能撞（否则会跨连接改错行）
    const first = addConnection(createDefaultCatalog(), 'zhipu', {}).connection;
    const twoConnections = addConnection(
      addConnection(createDefaultCatalog(), 'zhipu', {}).catalog,
      'zhipu',
      {},
    ).catalog;
    const second = findProvider(twoConnections, 'zhipu')?.connections[1];
    expect(first.models[0].id).not.toBe(second?.models[0].id);
  });

  it('厂商顺序严格按承接方指定（M3R4 §2：本地部署前移到灵绘之前）', () => {
    expect(BUILTIN_PROVIDER_ORDER).toEqual([
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
    ]);
    // 页面上看到的名字与顺序
    expect(BUILTIN_PROVIDER_ORDER.map((id) => VENDOR_META[id].name)).toEqual([
      '智谱',
      'DeepSeek',
      '火山方舟（豆包）',
      '月之暗面 / Kimi',
      '阿里百炼 / 千问',
      'MiniMax',
      'Anthropic',
      'OpenAI',
      'Google / Gemini',
      '本地部署',
      '灵绘（中转）',
    ]);
    // 自定义厂商不插队，永远排在最后
    expect(PROVIDER_SLOTS).toEqual([...BUILTIN_PROVIDER_ORDER, 'custom']);

    const created = createCustomProvider(createDefaultCatalog(), {
      name: '我的中转',
      baseUrl: 'https://a.example.com',
    });
    expect(sortProviders(created.catalog.providers).map((provider) => provider.id)).toEqual([
      ...BUILTIN_PROVIDER_ORDER,
      created.provider.id,
    ]);
    expect(sortProviders(created.catalog.providers)[BUILTIN_PROVIDER_ORDER.length].name).toBe('我的中转');
  });

  it('国内直连标记：OpenAI / Anthropic / Gemini 需要中转（Gemini 依据是实测 000 超时）', () => {
    expect(VENDOR_META.openai.needsRelay).toBe(true);
    expect(VENDOR_META.anthropic.needsRelay).toBe(true);
    expect(VENDOR_META.gemini.needsRelay).toBe(true);
    expect(VENDOR_META.gemini.note).toContain('000');
    expect(VENDOR_META.gemini.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
    // 国内可直连的那几家不要乱标
    for (const id of ['zhipu', 'deepseek', 'ark', 'moonshot', 'dashscope', 'minimax', 'linghui'] as const) {
      expect(VENDOR_META[id].needsRelay ?? false).toBe(false);
    }
    // base_url 按承接方给的原文（DeepSeek 不带 /v1，灵绘也不带）
    expect(VENDOR_META.deepseek.baseUrl).toBe('https://api.deepseek.com');
    expect(VENDOR_META.moonshot.baseUrl).toBe('https://api.moonshot.cn/v1');
    expect(VENDOR_META.dashscope.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(VENDOR_META.minimax.baseUrl).toBe('https://api.minimax.io/v1');
    expect(VENDOR_META.linghui.baseUrl).toBe('https://xn--ai-xg4e312c.com');
  });

  /**
   * M3R10 §5-5 + **M3R11 §2（更正）**：`webCors` 是**实测**结论，不是推断。
   * 依据：2026-10-18/19 在真浏览器里测（原始记录见 `docs/reference/cors-matrix.md`）：
   * - 方舟 / 智谱 / DeepSeek / Kimi / 阿里：预检放行 + 响应可读（401/404 都算通）；
   * - 灵绘：`OPTIONS` → **403**（nginx 拒预检，零个 `access-control-*` 头）= 拦死。
   *
   * ⚠️ 上一轮把方舟记成 `blocked` 是**错的**：当时只看未带 key 的 401，而方舟的
   * 401 **恰好不带 ACAO**。真 key 实测 `OPTIONS` → 204、业务响应（404）可读。
   */
  describe('M3R10 §5-5 + M3R11 §2：webCors 按实测填，UI 只读这个字段', () => {
    it('M3R11 §5-4：方舟是 ok（可直连），灵绘仍是 blocked', () => {
      expect(VENDOR_META.ark.webCors).toBe('ok');
      expect(VENDOR_META.linghui.webCors).toBe('blocked');
    });

    it('实测放行的四家是 ok（智谱 / DeepSeek / Kimi / 阿里百炼）', () => {
      expect(VENDOR_META.zhipu.webCors).toBe('ok');
      expect(VENDOR_META.deepseek.webCors).toBe('ok');
      expect(VENDOR_META.moonshot.webCors).toBe('ok');
      expect(VENDOR_META.dashscope.webCors).toBe('ok');
    });

    it('没测过的写 unknown，**不**凭猜测写成 ok 或 blocked', () => {
      // OpenAI / Gemini / Anthropic 国内本来就连不上（需中转），测不出 CORS 结论；
      // 「本地部署」地址由用户填、且 ComfyUI 默认不返回 CORS 头（要显式开）——
      // 三者都无从实测，如实记 unknown，不能拿"看起来应该行"填 ok。
      for (const id of ['openai', 'gemini', 'anthropic', 'local'] as const) {
        expect(VENDOR_META[id].webCors).toBe('unknown');
      }
    });

    it('只有实测被拦的那一家是 blocked —— 别把"中转站多半不开 CORS"推广成结论', () => {
      const blocked = BUILTIN_PROVIDER_ORDER.filter((id) => VENDOR_META[id].webCors === 'blocked');
      expect(blocked).toEqual(['linghui']);
    });

    it('每个内置厂商都必须有 webCors（漏填会被 TS 挡住，这里再兜一层）', () => {
      for (const id of BUILTIN_PROVIDER_ORDER) {
        expect(['blocked', 'ok', 'unknown'], `${id} 的 webCors 不合法`).toContain(
          VENDOR_META[id].webCors,
        );
      }
    });

    it('角标文案逐字（§2 要求），且它是常量不是散落的字符串', () => {
      expect(WEB_CORS_BLOCKED_SUFFIX).toBe('· 浏览器版不可用');
    });
  });

  it('两条连接：切 activeConnectionId 时 baseUrl 与 apiKey 一起换（不可能只换一半）', () => {
    let catalog = createDefaultCatalog();
    catalog = withConnection(catalog, 'zhipu', {
      label: '官方',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'key-official',
    });
    const second = addConnection(catalog, 'zhipu', {
      label: '分组二',
      baseUrl: 'https://relay.example.com/v4',
      apiKey: 'key-group-2',
    });
    catalog = second.catalog;
    const provider = findProvider(catalog, 'zhipu');
    expect(provider?.connections).toHaveLength(2);

    const firstId = provider?.connections[0].id ?? '';
    const secondId = second.connection.id;

    const asFirst = resolveActive(setActiveConnection(catalog, 'zhipu', firstId), 'zhipu');
    expect(asFirst.connection?.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(asFirst.connection?.apiKey).toBe('key-official');

    const asSecond = resolveActive(setActiveConnection(catalog, 'zhipu', secondId), 'zhipu');
    expect(asSecond.connection?.baseUrl).toBe('https://relay.example.com/v4');
    expect(asSecond.connection?.apiKey).toBe('key-group-2');
  });

  it('连接可以删到 0 条（activeConnectionId 随之清空，不报错）', () => {
    let catalog = withConnection(createDefaultCatalog(), 'deepseek', {
      label: '唯一一条',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'k',
    });
    const connectionId = findProvider(catalog, 'deepseek')?.connections[0].id ?? '';
    catalog = removeConnection(catalog, 'deepseek', connectionId);
    const provider = findProvider(catalog, 'deepseek');
    expect(provider?.connections).toHaveLength(0);
    expect(provider?.activeConnectionId).toBeUndefined();
    expect(resolveActive(catalog, 'deepseek').connection).toBeUndefined();
  });

  it('切厂商自动带出 activeConnection 与上次用的模型（无则用 §2 的默认值）', () => {
    let catalog = createDefaultCatalog();
    catalog = withConnection(catalog, 'deepseek', {
      label: 'deepseek 官方',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-deepseek',
    });
    const deepseek = resolveActive(catalog, 'deepseek');
    expect(deepseek.connection?.label).toBe('deepseek 官方');
    expect(deepseek.model?.modelId).toBe('deepseek-flash');

    // 换过模型之后，下次切回来应该带出「上次用的」
    const added = addBlankModel(catalog, 'deepseek');
    const rowId = modelsOfProvider(added, 'deepseek').slice(-1)[0]?.id ?? '';
    catalog = updateModel(added, 'deepseek', rowId, {
      displayName: 'deepseek-v4-pro',
      modelId: 'deepseek-v4-pro',
      caps: ['text'],
    });
    expect(resolveActive(catalog, 'deepseek').model?.modelId).toBe('deepseek-v4-pro');
  });
});

describe('预设标签（§2 表格，原样）', () => {
  it('智谱 8 / DeepSeek 2 / 方舟 3 / Kimi 2 / 中转 5 / 百炼 7 / MiniMax 4 / 本地 2 条，modelId 与 caps 逐条对得上', () => {
    expect(PRESET_TAGS.zhipu.map((tag) => [tag.modelId, tag.caps.join('+')])).toEqual([
      ['glm-5.3-flash', 'text+vision'],
      ['glm-4.7-flash', 'text'],
      ['glm-4v-flash', 'text+vision'],
      ['cogview-3-flash', 'image'],
      ['cogvideox-flash', 'video'],
      // 承接方本轮补的三条（价格未核实）
      ['glm-image', 'image'],
      ['cogview-4', 'image'],
      ['cogvideox-3', 'video'],
    ]);
    expect(PRESET_TAGS.zhipu.map((tag) => tag.note)).toEqual([
      '推荐',
      '免费测试',
      '免费测试',
      '免费测试',
      '免费测试·常 429',
      '旗舰生图，推荐英文提示词',
      '生图，中文支持更好',
      '旗舰视频',
    ]);
    expect(PRESET_TAGS.zhipu[4].label).toBe('cogvideox-flash（视频，免费测试，拥堵）');

    expect(PRESET_TAGS.deepseek.map((tag) => tag.modelId)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(PRESET_TAGS.deepseek[1].note).toBe('不支持图像');

    /**
     * M3R11 §3：方舟只认版本化模型 ID。预设里**不许再出现族名** —— 族名实测 404
     * （`doubao-seed-2.1-pro` 的报错就是 `InvalidEndpointOrModel.NotFound`）。
     */
    expect(PRESET_TAGS.ark.map((tag) => tag.modelId)).toEqual([
      'doubao-seedance-2-5-260628',
      'doubao-seed-2-1-pro-260628',
      'doubao-seedream-5-0-pro-260628',
    ]);
    expect(PRESET_TAGS.moonshot.map((tag) => tag.modelId)).toEqual([
      'kimi-k3.1-pro',
      'kimi-k3.1-pro-highspeed',
    ]);
    expect(PRESET_TAGS.relay.map((tag) => tag.modelId)).toEqual([
      'claude-opus-5-5',
      'gpt-6.1-sol',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
      'gemini-4-argon',
    ]);
    // R7a：这两家从「没有云端模型标签」变成有标签了（委托人指定的 7 + 4 条）
    expect(PRESET_TAGS.dashscope.map((tag) => tag.modelId)).toEqual([
      'qwen3.8-max',
      'qwen3.8-flash',
      'qwen-image-3.0-pro',
      'qwen-image-3.0',
      'wan2.7-image-pro',
      'wan2.7-image',
      'wan3.0-video',
    ]);
    expect(PRESET_TAGS.minimax.map((tag) => tag.modelId)).toEqual([
      'MiniMax-M3.1-Flash-Preview',
      'MiniMax-M3',
      'MiniMax-H3',
      'speech-2.8-hd',
    ]);
    expect(PRESET_TAGS.local.map((tag) => tag.modelId)).toEqual(['qwen-image-2.1', 'minimax-h3']);
    expect(PRESET_TAGS.local[0].note).toBe('本地部署');
  });

  it('价格未核实的 11 个标签：价格一律 null + 「未核实」，备注照抄文档', () => {
    const expected: Array<Pick<PresetTag, 'modelId' | 'caps' | 'note'>> = [
      { modelId: 'glm-image', caps: ['image'], note: '旗舰生图，推荐英文提示词' },
      { modelId: 'cogview-4', caps: ['image'], note: '生图，中文支持更好' },
      { modelId: 'cogvideox-3', caps: ['video'], note: '旗舰视频' },
      { modelId: 'kimi-k3.1-pro-highspeed', caps: ['text', 'vision'], note: expect.stringContaining('输出快 2–3×') },
      { modelId: 'claude-opus-5-5', caps: ['text', 'vision'], note: expect.stringContaining('fable-5-1 $50') },
      { modelId: 'gpt-6.1-sol', caps: ['text', 'vision'], note: expect.stringContaining('需中转') },
      { modelId: 'gpt-image-2.5-flare', caps: ['image'], note: expect.stringContaining('需中转') },
      { modelId: 'gpt-image-2.5-sunburst', caps: ['image'], note: expect.stringContaining('需中转') },
      { modelId: 'gemini-4-argon', caps: ['text', 'vision'], note: expect.stringContaining('需中转') },
      { modelId: 'MiniMax-M3', caps: ['text', 'vision'], note: expect.stringContaining('原生多模态') },
      { modelId: 'MiniMax-M3.1-Flash-Preview', caps: ['text', 'vision'], note: expect.stringContaining('三模态') },
    ];
    expect(expected).toHaveLength(11);

    const allTags = Object.values(PRESET_TAGS).flat();
    for (const item of expected) {
      const tag = allTags.find((candidate) => candidate.modelId === item.modelId);
      expect(tag, `缺少预设标签 ${item.modelId}`).toBeDefined();
      if (!tag) continue;
      expect(tag.caps).toEqual(item.caps);
      // 价格字段必须是 null（不许编数字、不许把 $ 价折算成输入/输出）
      expect(tag.price).toBeNull();
      expect(tag.priceStatus).toBe('未核实');
      if (typeof item.note === 'string') expect(tag.note).toBe(item.note);
      else expect(tag.note).toEqual(item.note);
    }

    // 已经核实过的价格仍然照抄原文，没被这轮改动抹掉
    const glm = PRESET_TAGS.zhipu.find((tag) => tag.modelId === 'glm-5.3-flash');
    expect(glm?.price).toBe('输入 0.80 / 输出 2.80（元/百万 token）');
    expect(glm?.priceStatus).toBe('已核实');
  });

  it('Claude 四档价格进备注（不折算成输入/输出两栏），价格字段仍然是 null', () => {
    const claude = PRESET_TAGS.relay.find((tag) => tag.modelId === 'claude-opus-5-5');
    expect(claude?.price).toBeNull();
    expect(claude?.note).toContain('fable-5-1 $50');
    expect(claude?.note).toContain('opus-5-5 $20');
    expect(claude?.note).toContain('sonnet-5-5 $10');
    expect(claude?.note).toContain('haiku-5-5 $0.5');
  });

  it('自定义厂商同时拿到「中转 + 本地」标签，内置厂商只拿自己那组', () => {
    const custom = { id: 'custom:abc', builtin: false };
    expect(presetTagsFor(custom)).toHaveLength(7);
    expect(presetTagsFor({ id: 'ark', builtin: true })).toHaveLength(3);
    // 官方外国厂商只拿自己的那条（同一份定义，按 modelId 过滤）
    expect(presetTagsFor({ id: 'openai', builtin: true }).map((tag) => tag.modelId)).toEqual([
      'gpt-6.1-sol',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
    ]);
    expect(presetTagsFor({ id: 'anthropic', builtin: true }).map((tag) => tag.modelId)).toEqual([
      'claude-opus-5-5',
    ]);
    expect(presetTagsFor({ id: 'gemini', builtin: true }).map((tag) => tag.modelId)).toEqual([
      'gemini-4-argon',
    ]);
    // 灵绘是中转站，拿到整组 5 条
    expect(presetTagsFor({ id: 'linghui', builtin: true }).map((tag) => tag.modelId)).toEqual([
      'claude-opus-5-5',
      'gpt-6.1-sol',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
      'gemini-4-argon',
    ]);
    // R7a：这两家有云端模型标签了（7 + 4 条），不再是空标签 + tagHint
    expect(presetTagsFor({ id: 'dashscope', builtin: true })).toHaveLength(7);
    expect(presetTagsFor({ id: 'minimax', builtin: true })).toHaveLength(4);
  });

  it('点预设标签：补 modelId + caps + 备注，且不覆盖用户已填的 base_url', () => {
    let catalog = withConnection(createDefaultCatalog(), 'zhipu', {
      label: '我的中转',
      baseUrl: 'https://my-relay.example.com/v4',
      apiKey: 'sk-mine',
    });
    const tag = PRESET_TAGS.zhipu.find((item) => item.modelId === 'cogview-3-flash');
    if (!tag) throw new Error('缺少 cogview-3-flash 预设');
    catalog = applyPresetTag(catalog, 'zhipu', tag);

    const provider = findProvider(catalog, 'zhipu');
    const added = provider ? modelsOf(provider).find((model) => model.modelId === 'cogview-3-flash') : undefined;
    expect(added?.caps).toEqual(['image']);
    expect(added?.note).toBe('免费测试');
    expect(added?.displayName).toBe('cogview-3-flash（生图，免费测试）');
    // base_url 一个字都没动
    expect(provider?.connections[0].baseUrl).toBe('https://my-relay.example.com/v4');
    expect(provider?.connections[0].apiKey).toBe('sk-mine');
    // 选中项自动落到刚加的这行
    expect(resolveActive(catalog, 'zhipu').model?.modelId).toBe('cogview-3-flash');
  });

  it('厂商还没有连接时点标签：顺手建一条连接并填厂商默认地址', () => {
    let catalog = createDefaultCatalog();
    const tag = PRESET_TAGS.ark.find((item) => item.modelId === 'doubao-seedance-2-5-260628');
    if (!tag) throw new Error('缺少 seedance 预设');
    catalog = applyPresetTag(catalog, 'ark', tag);
    const provider = findProvider(catalog, 'ark');
    expect(provider?.connections).toHaveLength(1);
    expect(provider?.connections[0].baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(provider?.activeConnectionId).toBe(provider?.connections[0].id);
  });

  it('同一个标签点两次不会加出两行（幂等）', () => {
    let catalog = createDefaultCatalog();
    const tag = PRESET_TAGS.deepseek.find((item) => item.modelId === 'deepseek-flash');
    if (!tag) throw new Error('缺少 deepseek-flash 预设');
    catalog = applyPresetTag(catalog, 'deepseek', tag);
    const before = modelsOfProvider(catalog, 'deepseek').length;
    catalog = applyPresetTag(catalog, 'deepseek', tag);
    expect(modelsOfProvider(catalog, 'deepseek')).toHaveLength(before);
  });
});

describe('模型表增删（含删到 0 行）', () => {
  it('增一行 → 删到 0 行，纯函数不抛错', () => {
    let catalog = addBlankModel(createDefaultCatalog(), 'zhipu');
    const provider = findProvider(catalog, 'zhipu');
    if (!provider) throw new Error('缺少 zhipu');
    // 0 条连接时点「手动添加」：先把第 1 条连接建出来（预填厂商默认模型），再加一行空白
    expect(provider.connections).toHaveLength(1);
    expect(modelsOf(provider)).toHaveLength(2);
    expect(modelsOf(provider)[1].modelId).toBe('');

    for (const model of modelsOf(provider)) {
      catalog = removeModel(catalog, 'zhipu', model.id);
    }
    expect(modelsOfProvider(catalog, 'zhipu')).toHaveLength(0);
    // 0 行时默认模型解析成空串而不是抛错
    expect(resolveActive(catalog, 'zhipu').model).toBeUndefined();
  });
});

describe('按能力选模型（§7：caps 是唯一依据）', () => {
  it('没有任何可用连接时 pickModel 返回可执行提示，不是抛错', () => {
    const result = pickModel(createDefaultCatalog(), 'image');
    expect(result.ok).toBe(false);
    expect(result.hint).toContain('你还没有配置生图模型');
    expect(result.hint).toContain('cogview-3-flash');
    expect(result.hint).toContain('去 AI 配置');
  });

  it('配了生图模型后 pickModel("image") 返回它；只有 base_url 没填的连接不算可用', () => {
    let catalog = createDefaultCatalog();
    catalog = withConnection(catalog, 'zhipu', { label: '空地址', baseUrl: '', apiKey: 'sk' });
    expect(pickModel(catalog, 'image').ok).toBe(false);

    catalog = withConnection(catalog, 'zhipu', {
      label: '官方',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk',
    });
    const tag = PRESET_TAGS.zhipu.find((item) => item.modelId === 'cogview-3-flash');
    if (!tag) throw new Error('缺少 cogview 预设');
    catalog = applyPresetTag(catalog, 'zhipu', tag);

    const result = pickModel(catalog, 'image');
    expect(result.ok).toBe(true);
    expect(result.model?.modelId).toBe('cogview-3-flash');
    expect(result.connection?.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
  });

  it('text 能力不会把空 modelId 的行当成可用模型', () => {
    let catalog = createDefaultCatalog();
    catalog = withConnection(catalog, 'zhipu', {
      label: '官方',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk',
    });
    const provider = findProvider(catalog, 'zhipu');
    if (!provider) throw new Error('缺少 zhipu');
    for (const model of modelsOf(provider)) catalog = removeModel(catalog, 'zhipu', model.id);
    catalog = addBlankModel(catalog, 'zhipu');
    expect(pickModel(catalog, 'text').ok).toBe(false);
  });

  it('capHint 每个能力都有自己的说法（不是一句通用的失败）', () => {
    expect(capHint('image')).toContain('生图');
    expect(capHint('video')).toContain('seedance');
    // R7a §G：文本的推荐换成 deepseek-flash（glm 是编程特化，不该出现在写作推荐里）
    expect(capHint('text')).toContain('deepseek-flash');
    expect(capHint('text')).not.toContain('glm');
    expect(capHint('audio')).toContain('speech-2.8-hd');
  });

  it('listModelsByCap("video") 只返回带视频能力的模型', () => {
    const catalog = applyPresetTag(
      createDefaultCatalog(),
      'ark',
      PRESET_TAGS.ark.find((tag) => tag.modelId === 'doubao-seedance-2-5-260628') ?? PRESET_TAGS.ark[0],
    );
    const videos = listModelsByCap(catalog, 'video');
    expect(videos.map((model) => model.modelId)).toEqual(['doubao-seedance-2-5-260628']);
    expect(listModelsByCap(catalog, 'image')).toHaveLength(0);
  });
});

describe('自定义厂商：新建 → 复用', () => {
  it('中转模板默认 claude-opus-5-5，本地模板默认 qwen-image-2.1', () => {
    const relay = createCustomProvider(createDefaultCatalog(), {
      name: '灵绘',
      baseUrl: 'https://linghui.example.com',
      apiKey: 'sk-linghui',
      note: 'gpt 组',
    });
    expect(relay.provider.builtin).toBe(false);
    expect(relay.provider.id.startsWith('custom:')).toBe(true);
    expect(relay.provider.connections[0].models[0].modelId).toBe('claude-opus-5-5');
    expect(relay.provider.connections[0].label).toBe('gpt 组');
    expect(relay.provider.connections[0].baseUrl).toBe('https://linghui.example.com');

    const local = createCustomProvider(createDefaultCatalog(), { name: '本机', template: 'local' });
    expect(local.provider.connections[0].models[0].modelId).toBe('qwen-image-2.1');
    expect(local.provider.connections[0].models[0].caps).toEqual(['image']);
  });

  it('保存后读回来还能直接用（base_url 不必重填）', async () => {
    const created = createCustomProvider(createDefaultCatalog(), {
      name: '灵绘',
      baseUrl: 'https://linghui.example.com',
      apiKey: 'sk-linghui',
    });
    await saveCatalog(created.catalog);

    const reloaded = await loadCatalog();
    const hit = reloaded.providers.find((provider) => provider.name === '灵绘');
    expect(hit).toBeDefined();
    expect(hit?.connections[0].baseUrl).toBe('https://linghui.example.com');
    expect(hit?.activeConnectionId).toBe(hit?.connections[0].id);
    expect(resolveActive(reloaded, hit?.id ?? '').model?.modelId).toBe('claude-opus-5-5');
  });

  it('内置厂商不能删：removeCustomProvider 对 zhipu 无效', () => {
    const catalog = createDefaultCatalog();
    expect(removeCustomProvider(catalog, 'zhipu').providers).toHaveLength(catalog.providers.length);
  });
});

describe('持久化与归一化', () => {
  it('保存后读回来一致（连接、模型表、当前选择）', async () => {
    let catalog = withConnection(createDefaultCatalog(), 'zhipu', {
      label: '官方',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-zhipu',
    });
    catalog = applyPresetTag(catalog, 'zhipu', PRESET_TAGS.zhipu[3]);
    await saveCatalog(catalog);

    const reloaded = await loadCatalog();
    const provider = reloaded.providers.find((item) => item.id === 'zhipu');
    expect(provider?.connections[0].apiKey).toBe('sk-zhipu');
    expect(modelsOfProvider(reloaded, 'zhipu').some((model) => model.modelId === 'cogview-3-flash')).toBe(
      true,
    );
  });

  it('库里缺了整个厂商 → 用默认值补齐（不让页面少一家）', async () => {
    await saveCatalog({
      providers: [createDefaultCatalog().providers[0]],
      updatedAt: 1,
    });
    const reloaded = await loadCatalog();
    expect(reloaded.providers.map((provider) => provider.id)).toEqual([...BUILTIN_PROVIDER_ORDER]);
  });

  it('activeConnectionId 指向不存在的连接 → 回落到第一条', async () => {
    const catalog = withConnection(createDefaultCatalog(), 'zhipu', {
      label: '官方',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'k',
    });
    const broken: AICatalog = {
      ...catalog,
      providers: catalog.providers.map((provider) =>
        provider.id === 'zhipu' ? { ...provider, activeConnectionId: 'conn-ghost' } : provider,
      ),
    };
    await saveCatalog(broken);
    const reloaded = await loadCatalog();
    const provider = reloaded.providers.find((item) => item.id === 'zhipu');
    expect(provider?.activeConnectionId).toBe(provider?.connections[0].id);
  });
});

describe('免费模型：独立分组删了，价格数据仍在（pricing.ts 一个字段都没动）', () => {
  it('FREE_TRIAL_PRICE_TABLE 仍是 0 元，来源与验证标记齐全', () => {
    expect(FREE_TRIAL_PRICE_TABLE.source).toBe('智谱官方（免费模型）');
    expect(FREE_TRIAL_PRICE_TABLE.verified).toBe(true);
    expect(FREE_TRIAL_PRICE_TABLE.verifiedAt).toBe('2026-10');
    expect(FREE_TRIAL_PRICE_TABLE.text['glm-4.7-flash'].inputPerMTokens).toBe(0);
    expect(FREE_TRIAL_PRICE_TABLE.text['glm-4.7-flash'].outputPerMTokens).toBe(0);
    expect(FREE_TRIAL_PRICE_TABLE.text['glm-4v-flash'].outputPerMTokens).toBe(0);
    expect(FREE_TRIAL_PRICE_TABLE.image['cogview-3-flash'].perImage).toBe(0);
    expect(FREE_TRIAL_PRICE_TABLE.models['cogvideox-flash'].rate.sd).toEqual({
      withoutInputVideo: 0,
      withInputVideo: 0,
    });
  });

  it('免费模型的 4 个模型名与智谱预设标签一一对应（不再有独立分组）', () => {
    const zhipuIds = PRESET_TAGS.zhipu.map((tag) => tag.modelId);
    for (const modelId of ['glm-4.7-flash', 'glm-4v-flash', 'cogview-3-flash', 'cogvideox-flash']) {
      expect(zhipuIds).toContain(modelId);
    }
    expect(PRESET_TAGS.zhipu.some((tag) => tag.modelId === 'glm-4.6v-flash')).toBe(false);
  });
});

describe('导出 / 导入（走文件，默认不含 key）', () => {
  const sample = (): AICatalog =>
    withConnection(createDefaultCatalog(), 'deepseek', {
      label: 'deepseek 官方',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-secret-value',
    });

  it('默认导出不含 key；勾选后包含并标记 containsKey', () => {
    const withoutKey = serializeCatalogFile(sample(), { now: new Date(2026, 9, 18) });
    expect(withoutKey.containsKey).toBe(false);
    expect(withoutKey.json).not.toContain('sk-secret-value');
    expect(withoutKey.filename).toBe('ai-catalog_20261018.json');

    const withKey = serializeCatalogFile(sample(), { includeKey: true });
    expect(withKey.containsKey).toBe(true);
    expect(withKey.json).toContain('sk-secret-value');
  });

  it('导出 → 清库 → 导入 → 配置复原', async () => {
    const exported = serializeCatalogFile(sample(), { includeKey: true });
    await destroyDatabase();
    expect((await loadCatalog()).providers.find((item) => item.id === 'deepseek')?.connections).toHaveLength(0);

    const parsed = parseCatalogFile(exported.json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.containsKey).toBe(true);
    await saveCatalog(parsed.catalog);

    const restored = await loadCatalog();
    const provider = restored.providers.find((item) => item.id === 'deepseek');
    expect(provider?.connections[0].apiKey).toBe('sk-secret-value');
  });

  it('坏文件一律返回人话错误（不抛异常）', () => {
    expect(parseCatalogFile('不是 json').ok).toBe(false);
    const wrong = parseCatalogFile(JSON.stringify({ format: 'other', version: 1 }));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toContain('不是本应用');
    const tooNew = parseCatalogFile(
      JSON.stringify({ format: 'inspiration-assistant-ai-catalog', version: 99, catalog: {} }),
    );
    expect(tooNew.ok).toBe(false);
    if (!tooNew.ok) expect(tooNew.error).toContain('太新');
  });

  it('连接下拉的显示名是「备注 · baseUrl」，过长截断', () => {
    const label = connectionLabel({
      id: makeId('conn'),
      label: '灵绘 gpt 组',
      baseUrl: 'https://linghui.example.com/v1',
      apiKey: 'sk-test',
      models: [],
    });
    expect(label).toBe('灵绘 gpt 组 · linghui.example.com/v1');

    const long = connectionLabel({
      id: 'c',
      label: '很长的备注',
      baseUrl: `https://${'a'.repeat(80)}.com`,
      apiKey: '',
      models: [],
    });
    expect(long.length).toBeLessThanOrEqual(42);
    expect(long.endsWith('…')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* M3R2 §3 本地部署：只做占位，不假装能调用                              */
/* ------------------------------------------------------------------ */

describe('§3 本地部署（占位，不假装能调用）', () => {
  it('本地部署排在内置厂商倒数第二（M3R4 §2 前移到灵绘之前），预置 qwen-image-2.1 / minimax-h3，属于 local 类别', () => {
    const catalog = createDefaultCatalog();
    // 最后一家是「灵绘（中转）」；本地部署紧在它前面
    const local = catalog.providers[catalog.providers.length - 2];
    expect(local.id).toBe('local');
    expect(local.name).toBe('本地部署');
    expect(VENDOR_META.local.kind).toBe('local');
    // 没有固定地址：由用户自己填
    expect(VENDOR_META.local.baseUrl).toBe('');
    expect(VENDOR_META.local.note).toContain('ComfyUI');
    expect(isLocalProvider(local)).toBe(true);
    expect(PRESET_TAGS.local.map((tag) => tag.modelId)).toEqual(['qwen-image-2.1', 'minimax-h3']);
    expect(PRESET_TAGS.local.map((tag) => tag.caps.join('+'))).toEqual(['image', 'video']);
    // 模型表随连接走：建一条连接就把本地模板的默认模型带上
    const prefilled = addConnection(catalog, 'local', {});
    expect(prefilled.connection.models.map((model) => model.modelId)).toEqual(['qwen-image-2.1']);
  });

  it('点本地标签：只登记模型，不产生可调用连接（地址留空）', () => {
    let catalog = createDefaultCatalog();
    const tag = PRESET_TAGS.local.find((item) => item.modelId === 'minimax-h3');
    if (!tag) throw new Error('缺少 minimax-h3');
    catalog = applyPresetTag(catalog, 'local', tag);
    const provider = findProvider(catalog, 'local');
    expect(provider ? modelsOf(provider).map((model) => model.modelId) : []).toEqual([
      'qwen-image-2.1',
      'minimax-h3',
    ]);
    expect(provider?.connections[0].baseUrl).toBe('');
    // 本地部署不进「按能力选模型」：选出来也调不通
    expect(pickModel(catalog, 'video').ok).toBe(false);
    expect(listModelsByCap(catalog, 'video').some((ref) => ref.providerId === 'local')).toBe(false);
  });

  it('ComfyUI 说明文案：提到 ComfyUI，且不出现内部里程碑代号', () => {
    expect(LOCAL_DEPLOY_NOTICE).toContain('ComfyUI');
    expect(LOCAL_DEPLOY_NOTICE).toContain('现在可以先记下来');
    expect(LOCAL_DEPLOY_NOTICE).not.toMatch(/\bM\d/);
  });
});

/* ------------------------------------------------------------------ */
/* 价格：null 要能存回来（未核实不会被洗成「已核实」）                     */
/* ------------------------------------------------------------------ */

describe('价格字段持久化', () => {
  it('price=null + 未核实 存回来仍然是 null；已核实的原文不被改动', async () => {
    let catalog = createDefaultCatalog();
    const tag = PRESET_TAGS.zhipu.find((item) => item.modelId === 'glm-image');
    if (!tag) throw new Error('缺少 glm-image');
    catalog = applyPresetTag(catalog, 'zhipu', tag);
    await saveCatalog(catalog);

    const reloaded = await loadCatalog();
    const model = modelsOfProvider(reloaded, 'zhipu').find((item) => item.modelId === 'glm-image');
    expect(model?.price).toBeNull();
    expect(model?.priceStatus).toBe('未核实');

    const glm = modelsOfProvider(reloaded, 'zhipu').find((item) => item.modelId === 'glm-5.3-flash');
    expect(glm?.price).toBe('输入 0.80 / 输出 2.80（元/百万 token）');
    expect(glm?.priceStatus).toBe('已核实');
  });
});

/* ------------------------------------------------------------------ */
/* M3R4 §2 §4：12 个槽位的顺序 / 三种协议 / 倍率                          */
/* ------------------------------------------------------------------ */

describe('M3R4 §2 厂商顺序：12 个槽位，custom 在最后', () => {
  it('PROVIDER_SLOTS 严格等于 §2 的顺序（本地部署在灵绘之前，custom 最后）', () => {
    expect(PROVIDER_SLOTS).toEqual([
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
      'custom',
    ]);
    expect(PROVIDER_SLOTS).toHaveLength(12);
  });

  it('默认目录按这个顺序生成：本地部署排在灵绘前（本地不属于中转）', () => {
    const ids = createDefaultCatalog().providers.map((provider) => provider.id);
    expect(ids).toEqual([...BUILTIN_PROVIDER_ORDER]);
    expect(ids.indexOf('local')).toBeLessThan(ids.indexOf('linghui'));
    expect(ids.indexOf('linghui')).toBe(ids.length - 1);
  });
});

describe('M3R4 §4.1 protocol = responses（实验性·未验证）', () => {
  it('协议下拉三项；可见文字不含端点后缀（后缀进 title，M3R6 §4）', () => {
    expect(PROTOCOL_OPTIONS.map((option) => option.value)).toEqual(['openai', 'anthropic', 'responses']);
    expect(PROTOCOL_OPTIONS.map((option) => option.label)).toEqual([
      'OpenAI 兼容',
      'Anthropic',
      'Responses（实验性）',
    ]);
    for (const option of PROTOCOL_OPTIONS) {
      // 120px 的列宽放不下「（/chat/completions）」，会被截成「OpenAI 兼容（/…」
      expect(option.label).not.toContain('（/chat');
      expect(option.label).not.toContain('（/messages');
      expect(option.label).not.toContain('（/responses');
    }
    expect(PROTOCOL_OPTIONS[0].title).toBe('POST {base}/chat/completions');
    expect(PROTOCOL_OPTIONS[1].title).toBe('POST {base}/messages');
    const responses = PROTOCOL_OPTIONS.find((option) => option.value === 'responses');
    expect(responses?.title).toContain('/responses');
    expect(responses?.title).toContain('未验证');
    expect(PROTOCOL_OPTIONS[0].label).not.toContain('未验证');
    expect(PROTOCOL_OPTIONS[1].label).not.toContain('未验证');
    // hover 时把 {base} 换成这条连接自己的地址（末尾斜杠去掉，不拼出 //）
    expect(protocolEndpointTitle('openai', 'https://relay.example.com/v1/')).toBe(
      'POST https://relay.example.com/v1/chat/completions',
    );
    expect(protocolEndpointTitle('anthropic', '')).toContain('{base}');
  });

  it('三条不同协议的连接并存，互不覆盖', () => {
    let catalog = createDefaultCatalog();
    const first = addConnection(catalog, 'openai', {
      label: 'openai 组',
      baseUrl: 'https://a.example.com',
      protocol: 'openai',
    });
    catalog = first.catalog;
    const second = addConnection(catalog, 'openai', {
      label: 'claude 组',
      baseUrl: 'https://b.example.com',
      protocol: 'anthropic',
    });
    catalog = second.catalog;
    const third = addConnection(catalog, 'openai', {
      label: 'responses 组',
      baseUrl: 'https://c.example.com',
      protocol: 'responses',
    });
    catalog = third.catalog;

    const provider = findProvider(catalog, 'openai');
    expect(provider?.connections.map((item) => item.protocol)).toEqual([
      'openai',
      'anthropic',
      'responses',
    ]);
    expect(provider?.connections.map((item) => item.baseUrl)).toEqual([
      'https://a.example.com',
      'https://b.example.com',
      'https://c.example.com',
    ]);
  });

  it('存盘再读回：responses 不被洗成 openai；未知协议回落 openai', async () => {
    let catalog = createDefaultCatalog();
    catalog = addConnection(catalog, 'openai', {
      label: 'responses 组',
      baseUrl: 'https://c.example.com',
      protocol: 'responses',
    }).catalog;
    await saveCatalog(catalog);
    const reloaded = await loadCatalog();
    expect(findProvider(reloaded, 'openai')?.connections[0].protocol).toBe('responses');

    const dirty = normalizeCatalog({
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          builtin: true,
          connections: [
            { id: 'conn-1', label: 'x', baseUrl: 'https://x.example.com', apiKey: '', protocol: 'chat-completions' },
          ],
          models: [],
        },
      ],
    });
    expect(findProvider(dirty, 'openai')?.connections[0].protocol).toBe('openai');
  });
});

describe('M3R4 §4.2 倍率 multiplier', () => {
  it('新连接默认倍率 1；可以填 0.35 / 2.5 这类小数', () => {
    let catalog = createDefaultCatalog();
    const created = addConnection(catalog, 'linghui', { baseUrl: 'https://xn--ai-xg4e312c.com' });
    catalog = created.catalog;
    expect(created.connection.multiplier).toBe(DEFAULT_MULTIPLIER);

    catalog = updateConnection(catalog, 'linghui', created.connection.id, { multiplier: 0.35 });
    expect(findProvider(catalog, 'linghui')?.connections[0].multiplier).toBe(0.35);

    catalog = updateConnection(catalog, 'linghui', created.connection.id, { multiplier: 2.5 });
    expect(findProvider(catalog, 'linghui')?.connections[0].multiplier).toBe(2.5);
  });

  it('0.35 存盘读回还是 0.35（不被归一化成 1）', async () => {
    const created = addConnection(createDefaultCatalog(), 'linghui', {
      baseUrl: 'https://xn--ai-xg4e312c.com',
      multiplier: 0.35,
    });
    const catalog = setActiveConnection(created.catalog, 'linghui', created.connection.id);
    await saveCatalog(catalog);

    const reloaded = await loadCatalog();
    const connection = findProvider(reloaded, 'linghui')?.connections[0];
    expect(connection?.multiplier).toBe(0.35);
    expect(multiplierOf(connection)).toBe(0.35);
  });

  it('负数 / NaN 被本地拒绝：库里保持原值；脏数据读回按 1', () => {
    let catalog = createDefaultCatalog();
    const created = addConnection(catalog, 'linghui', {
      baseUrl: 'https://xn--ai-xg4e312c.com',
      multiplier: 0.35,
    });
    catalog = created.catalog;

    catalog = updateConnection(catalog, 'linghui', created.connection.id, { multiplier: -1 });
    expect(findProvider(catalog, 'linghui')?.connections[0].multiplier).toBe(0.35);

    catalog = updateConnection(catalog, 'linghui', created.connection.id, { multiplier: Number.NaN });
    expect(findProvider(catalog, 'linghui')?.connections[0].multiplier).toBe(0.35);

    // addConnection 也不吃非法值
    const bad = addConnection(createDefaultCatalog(), 'linghui', {
      baseUrl: 'https://x.example.com',
      multiplier: -2,
    });
    expect(bad.connection.multiplier).toBe(DEFAULT_MULTIPLIER);

    // 库里被手改成负数 / 字符串 → 一律按 1
    const dirty = normalizeCatalog({
      providers: [
        {
          id: 'linghui',
          name: '灵绘',
          builtin: true,
          connections: [
            { id: 'conn-1', label: 'x', baseUrl: 'https://x.example.com', apiKey: '', multiplier: -3 },
            { id: 'conn-2', label: 'y', baseUrl: 'https://y.example.com', apiKey: '', multiplier: '0.35' },
          ],
          models: [],
        },
      ],
    });
    expect(findProvider(dirty, 'linghui')?.connections.map((item) => item.multiplier)).toEqual([1, 1]);
  });

  it('输入解析：空串 = 1，0.35 通过，-1 / abc 返回 null 并给固定提示', () => {
    expect(parseMultiplier('')).toBe(1);
    expect(parseMultiplier(' 0.35 ')).toBe(0.35);
    expect(parseMultiplier('2.5')).toBe(2.5);
    expect(parseMultiplier('-1')).toBeNull();
    expect(parseMultiplier('abc')).toBeNull();
    expect(isValidMultiplier(0)).toBe(true);
    expect(isValidMultiplier(Number.NaN)).toBe(false);
    expect(MULTIPLIER_INVALID_MESSAGE).toContain('倍率');
    expect(MULTIPLIER_INVALID_MESSAGE).toContain('没有保存');
  });

  it('实付估算 = 官方价 × 倍率（保留到分；不传 = 官方价）', () => {
    expect(applyMultiplier(45.36, 1)).toBe(45.36);
    expect(applyMultiplier(45.36, 0.35)).toBe(15.88);
    expect(applyMultiplier(20.18, 0.35)).toBe(7.06);
    expect(applyMultiplier(45.36)).toBe(45.36);
    expect(applyMultiplier(10, Number.NaN)).toBe(10);
  });
});

/* ------------------------------------------------------------------ */
/* M3R6 判据：模型表随连接走                                              */
/* ------------------------------------------------------------------ */

describe('M3R6 §5-1 同一厂商两条连接，各有各的模型表', () => {
  it('每条连接一套模型表；切 activeConnectionId，模型表内容整体跟着换', () => {
    let catalog = createDefaultCatalog();
    const first = addConnection(catalog, 'linghui', {
      label: 'gpt 组',
      baseUrl: 'https://relay-a.example.com',
    });
    catalog = setActiveConnection(first.catalog, 'linghui', first.connection.id);
    // 预填的是 linghui 的默认模型（opus-5-5）：先删掉，让两条连接的表明显不同
    catalog = removeModel(catalog, 'linghui', modelsOfProvider(catalog, 'linghui')[0].id);
    catalog = applyPresetTag(catalog, 'linghui', findPreset('gpt-6.1-sol'));

    const second = addConnection(catalog, 'linghui', {
      label: 'claude 组',
      baseUrl: 'https://relay-b.example.com',
    });
    catalog = setActiveConnection(second.catalog, 'linghui', second.connection.id);
    catalog = applyPresetTag(catalog, 'linghui', findPreset('gpt-image-2.5-flare'));

    const provider = findProvider(catalog, 'linghui');
    if (!provider) throw new Error('缺少 linghui');
    expect(provider.connections).toHaveLength(2);
    const [gpt, claude] = provider.connections;
    expect(gpt.models.map((model) => model.modelId)).toEqual(['gpt-6.1-sol']);
    expect(claude.models.map((model) => model.modelId)).toEqual([
      'claude-opus-5-5',
      'gpt-image-2.5-flare',
    ]);

    // 切回第一条：模型表换成 gpt 组那张
    const asFirst = setActiveConnection(catalog, 'linghui', gpt.id);
    expect(modelsOfProvider(asFirst, 'linghui').map((model) => model.modelId)).toEqual([
      'gpt-6.1-sol',
    ]);
    expect(resolveActive(asFirst, 'linghui').connection?.baseUrl).toBe(
      'https://relay-a.example.com',
    );
    expect(resolveActive(asFirst, 'linghui').model?.modelId).toBe('gpt-6.1-sol');

    // 切到第二条：地址、key、模型表一起换（不可能只换一半）
    const asSecond = setActiveConnection(catalog, 'linghui', claude.id);
    expect(modelsOfProvider(asSecond, 'linghui')).toHaveLength(2);
    expect(resolveActive(asSecond, 'linghui').connection?.baseUrl).toBe(
      'https://relay-b.example.com',
    );
    // lastModelId 属于第二条连接的行 → 带出 gpt-image-2.5-flare
    expect(resolveActive(asSecond, 'linghui').model?.modelId).toBe('gpt-image-2.5-flare');
  });
});

describe('M3R6 §5-2 复制模型表到其他连接（深拷贝）', () => {
  it('复制后内容一致；改一边不影响另一边；行 id 全换新', () => {
    let catalog = createDefaultCatalog();
    const first = addConnection(catalog, 'zhipu', { label: '官方 key', baseUrl: 'https://a.example.com' });
    catalog = setActiveConnection(first.catalog, 'zhipu', first.connection.id);
    catalog = applyPresetTag(catalog, 'zhipu', findPreset('cogview-3-flash'));

    const second = addConnection(catalog, 'zhipu', { label: '备用 key', baseUrl: 'https://b.example.com' });
    catalog = second.catalog;
    const provider = findProvider(catalog, 'zhipu');
    if (!provider) throw new Error('缺少 zhipu');
    const [source, target] = provider.connections;

    const result = copyModelsToConnection(catalog, 'zhipu', target.id);
    catalog = result.catalog;
    expect(result.copied).toBe(source.models.length);

    const afterCopy = findProvider(catalog, 'zhipu');
    if (!afterCopy) throw new Error('缺少 zhipu');
    const copiedSource = afterCopy.connections[0];
    const copiedTarget = afterCopy.connections[1];
    expect(copiedTarget.models).toHaveLength(copiedSource.models.length);
    expect(copiedTarget.models.map((model) => [model.modelId, model.displayName, model.caps.join('+')])).toEqual(
      copiedSource.models.map((model) => [model.modelId, model.displayName, model.caps.join('+')]),
    );
    // 深拷贝：行 id 全换新，caps 不是同一个数组
    expect(copiedTarget.models.map((model) => model.id)).not.toEqual(
      copiedSource.models.map((model) => model.id),
    );
    expect(copiedTarget.models[0].caps).not.toBe(copiedSource.models[0].caps);
    expect(copiedTarget.models[0].caps).toEqual(copiedSource.models[0].caps);

    // 改目标连接的这一行 → 源连接一个字都没动
    const targetRowId = copiedTarget.models[0].id;
    const updated = updateModel(catalog, 'zhipu', targetRowId, {
      displayName: '只在备用 key 上改过',
      caps: ['video'],
    });
    const after = findProvider(updated, 'zhipu');
    if (!after) throw new Error('缺少 zhipu');
    expect(after.connections[1].models[0].displayName).toBe('只在备用 key 上改过');
    expect(after.connections[1].models[0].caps).toEqual(['video']);
    expect(after.connections[0].models[0].displayName).toBe(copiedSource.models[0].displayName);
    expect(after.connections[0].models[0].caps).toEqual(copiedSource.models[0].caps);
  });

  it('目标是当前连接 / 不存在的连接 → 什么都不做（copied = 0）', () => {
    let catalog = createDefaultCatalog();
    const created = addConnection(catalog, 'zhipu', { baseUrl: 'https://a.example.com' });
    catalog = setActiveConnection(created.catalog, 'zhipu', created.connection.id);
    expect(copyModelsToConnection(catalog, 'zhipu', created.connection.id).copied).toBe(0);
    expect(copyModelsToConnection(catalog, 'zhipu', 'conn-ghost').copied).toBe(0);
  });
});

describe('M3R6 §5-4 / §5-5 启用标记与多连接', () => {
  it('取消启用后 pickModel / listModelsByCap 都不再返回它；重新勾上就回来', () => {
    let catalog = addConnection(createDefaultCatalog(), 'zhipu', { baseUrl: 'https://a.example.com' }).catalog;
    const connectionId = findProvider(catalog, 'zhipu')?.connections[0].id ?? '';
    catalog = setActiveConnection(catalog, 'zhipu', connectionId);
    catalog = applyPresetTag(catalog, 'zhipu', findPreset('cogview-3-flash'));

    expect(pickModel(catalog, 'image').ok).toBe(true);
    const row = modelsOfProvider(catalog, 'zhipu').find((model) => model.modelId === 'cogview-3-flash');
    if (!row) throw new Error('缺少 cogview-3-flash 行');

    catalog = updateModel(catalog, 'zhipu', row.id, { enabled: false });
    expect(pickModel(catalog, 'image').ok).toBe(false);
    expect(pickModel(catalog, 'image').hint).toContain('你还没有配置生图模型');
    expect(pickModel(catalog, 'text').model?.modelId).toBe('glm-5.3-flash');

    catalog = updateModel(catalog, 'zhipu', row.id, { enabled: true });
    expect(pickModel(catalog, 'image').model?.modelId).toBe('cogview-3-flash');
  });

  it('第二条连接里的模型同样可用：pickModel 带出的是它自己那条连接', () => {
    let catalog = createDefaultCatalog();
    // A：只有预填的文本模型
    const a = addConnection(catalog, 'zhipu', { label: 'A', baseUrl: 'https://a.example.com' });
    catalog = setActiveConnection(a.catalog, 'zhipu', a.connection.id);
    // B：加一条生图模型
    const b = addConnection(catalog, 'zhipu', { label: 'B', baseUrl: 'https://b.example.com' });
    catalog = setActiveConnection(b.catalog, 'zhipu', b.connection.id);
    catalog = applyPresetTag(catalog, 'zhipu', findPreset('cogview-3-flash'));

    expect(pickModel(catalog, 'image').connection?.id).toBe(b.connection.id);

    // 「当前连接」切回 A —— B 里那把 Key 的生图模型依然可用，
    // 而且带出来的是 B 的连接（base_url / key 都对得上）
    catalog = setActiveConnection(catalog, 'zhipu', a.connection.id);
    const result = pickModel(catalog, 'image');
    expect(result.ok).toBe(true);
    expect(result.model?.modelId).toBe('cogview-3-flash');
    expect(result.connection?.id).toBe(b.connection.id);
  });

  it('enabled 存盘读回：没写的按启用，显式 false 的保持停用', async () => {
    let catalog = addConnection(createDefaultCatalog(), 'zhipu', { baseUrl: 'https://a.example.com' }).catalog;
    const connectionId = findProvider(catalog, 'zhipu')?.connections[0].id ?? '';
    catalog = setActiveConnection(catalog, 'zhipu', connectionId);
    const row = modelsOfProvider(catalog, 'zhipu')[0];
    catalog = updateModel(catalog, 'zhipu', row.id, { enabled: false });
    await saveCatalog(catalog);

    const reloaded = await loadCatalog();
    const models = modelsOfProvider(reloaded, 'zhipu');
    expect(models[0].enabled).toBe(false);
    // 没有 enabled 字段的旧数据 → 视为启用
    const dirty = normalizeCatalog({
      providers: [
        {
          id: 'zhipu',
          name: '智谱',
          builtin: true,
          connections: [
            {
              id: 'conn-1',
              label: 'x',
              baseUrl: 'https://x.example.com',
              apiKey: '',
              models: [{ id: 'm-1', displayName: 'x', modelId: 'glm-5.3-flash', caps: ['text'] }],
            },
          ],
        },
      ],
    });
    expect(modelsOfProvider(dirty, 'zhipu')[0].enabled).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* M3R8 「上次看的是哪个厂商」：决定面板初始落在谁身上                    */
/* ------------------------------------------------------------------ */

describe('M3R8 resolveActiveProviderId / 偏好持久化', () => {
  it('偏好存在且仍存在 → 用它（哪怕它一条连接都没有）', () => {
    const catalog = createDefaultCatalog();
    expect(resolveActiveProviderId(catalog, 'moonshot')).toBe('moonshot');
  });

  it('没偏好 → 第一条有连接的厂商；只有全空时才退回 providers[0]（智谱）', () => {
    const { catalog } = addConnection(createDefaultCatalog(), 'deepseek', {
      baseUrl: 'https://api.deepseek.com',
    });
    expect(catalog.providers[0].id).toBe('zhipu'); // 顺序固定，不代表「该看谁」
    expect(resolveActiveProviderId(catalog, null)).toBe('deepseek');
    expect(resolveActiveProviderId(createDefaultCatalog(), null)).toBe('zhipu');
  });

  it('偏好指向已删掉的厂商 → 落到第一条有连接的，不抛错', () => {
    const { catalog } = addConnection(createDefaultCatalog(), 'minimax', {
      baseUrl: 'https://api.minimax.chat/v1',
    });
    expect(resolveActiveProviderId(catalog, 'custom:gone')).toBe('minimax');
  });

  it('偏好存得住：saveActiveProviderId → 关库重开后 loadActiveProviderId 读回同一个 id', async () => {
    expect(await loadActiveProviderId()).toBeNull();
    await saveActiveProviderId('deepseek');
    await closeDatabase();
    expect(await loadActiveProviderId()).toBe('deepseek');
  });
});

describe('计费方式 billingMode（2026-10-29 委托人提出）', () => {
  it('新连接默认「中转站」，倍率仍是 1', () => {
    const { connection } = addConnection(createDefaultCatalog(), 'linghui', {
      baseUrl: 'https://xn--ai-xg4e312c.com',
    });
    expect(connection.billingMode).toBe('relay');
    expect(connection.multiplier).toBe(1);
  });

  it('addConnection 可以指定计费方式；订阅制的倍率落成 0', () => {
    const { connection } = addConnection(createDefaultCatalog(), 'openai', {
      baseUrl: 'https://api.openai.com/v1',
      billingMode: 'subscription',
      multiplier: 0,
    });
    expect(connection.billingMode).toBe('subscription');
    expect(connection.multiplier).toBe(0);
  });

  it('四种方式各自的默认倍率：中转 1 / 国内 1 / 订阅 0 / 国外 6.8', () => {
    expect(BILLING_DEFAULT_MULTIPLIER).toEqual({
      relay: 1,
      domestic: 1,
      subscription: 0,
      overseas: 6.8,
    });
  });

  it('老数据没有 billingMode → 按倍率反推（0 = 订阅，其余 = 中转站）', () => {
    const dirty = normalizeCatalog({
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          builtin: true,
          connections: [
            { id: 'c-zero', label: '订阅', baseUrl: 'https://a.example.com', multiplier: 0 },
            { id: 'c-one', label: '中转', baseUrl: 'https://b.example.com', multiplier: 1 },
            { id: 'c-half', label: '中转2', baseUrl: 'https://c.example.com', multiplier: 0.8 },
          ],
          models: [],
        },
      ],
    });
    const conns = findProvider(dirty, 'openai')?.connections ?? [];
    expect(conns.map((c) => c.billingMode)).toEqual(['subscription', 'relay', 'relay']);
  });

  it('每种方式的倍率各自存：导出/重载后四个数都还在，旧存档的 relayMultiplier 迁到 relay 位', () => {
    const reloaded = normalizeCatalog({
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          builtin: true,
          connections: [
            {
              id: 'c-all',
              label: '四种都填过',
              baseUrl: 'https://api.example.com',
              multiplier: 0.05,
              billingMode: 'subscription',
              modeMultipliers: { relay: 0.35, domestic: 1, subscription: 0.05, overseas: 6.66 },
            },
            { id: 'c-legacy', label: '旧存档', baseUrl: 'https://b.example.com', relayMultiplier: 0.8 },
          ],
          models: [],
        },
      ],
    });
    const conns = findProvider(reloaded, 'openai')?.connections ?? [];
    expect(conns[0].modeMultipliers).toEqual({
      relay: 0.35,
      domestic: 1,
      subscription: 0.05,
      overseas: 6.66,
    });
    // 旧字段迁移过来，不丢
    expect(conns[1].modeMultipliers).toEqual({ relay: 0.8 });
    // 非法值被丢掉（NaN / 负数不进表）
    const bad = normalizeCatalog({
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          builtin: true,
          connections: [
            {
              id: 'c-bad',
              label: 'x',
              baseUrl: 'https://x.example.com',
              modeMultipliers: { relay: -1, domestic: 'abc' },
            },
          ],
          models: [],
        },
      ],
    });
    expect(findProvider(bad, 'openai')?.connections[0].modeMultipliers).toBeUndefined();
  });

  it('显式写的 billingMode 优先于反推（overseas + 6.8 存得住）', () => {
    const dirty = normalizeCatalog({
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          builtin: true,
          connections: [
            {
              id: 'c-o',
              label: '官方按量',
              baseUrl: 'https://api.openai.com/v1',
              multiplier: 6.8,
              billingMode: 'overseas',
            },
            { id: 'c-bad', label: '乱填', baseUrl: 'https://x.example.com', billingMode: 'nope' },
          ],
          models: [],
        },
      ],
    });
    const conns = findProvider(dirty, 'openai')?.connections ?? [];
    expect(conns[0].billingMode).toBe('overseas');
    expect(conns[0].multiplier).toBe(6.8);
    expect(conns[1].billingMode).toBe('relay'); // 非法值退回默认
  });
});
