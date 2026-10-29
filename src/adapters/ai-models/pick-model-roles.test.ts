// @vitest-environment node
/**
 * R7a §F：`pickModel` 改走「角色」。四条行为契约逐条锁死。
 *
 * 背景：老逻辑是「厂商顺序 → 当前连接 → 表里第一个符合能力的」，谁排前面挑谁。
 * 智谱恒排第一，所以「想用 DeepSeek 写作」只能靠手改厂商顺序 —— 这就是要修的。
 * 现在：配了 `settings.modelRoles.writing` 就听它的，没配/指向失效 = 完全等于旧行为。
 */
import { describe, expect, it } from 'vitest';
import {
  PRESET_TAGS,
  VENDOR_META,
  addConnection,
  applyPresetTag,
  capHint,
  createDefaultCatalog,
  findProvider,
  modelKeyOf,
  pickModel,
  pickModelForRole,
  updateModel,
} from './catalog';
import type { AICatalog, ModelRoles, PresetTag } from './catalog';

function preset(modelId: string): PresetTag {
  const tag = Object.values(PRESET_TAGS)
    .flat()
    .find((item) => item.modelId === modelId);
  if (!tag) throw new Error(`缺少预设标签：${modelId}`);
  return tag;
}

/**
 * 两家的目录：智谱（厂商顺序第一，预填 glm-5.3-flash）+ DeepSeek（预填 deepseek-flash）。
 * 这就是任务书 §F 举例的那一幕。
 */
function twoVendorCatalog(): {
  catalog: AICatalog;
  zhipuConnectionId: string;
  deepseekConnectionId: string;
} {
  let catalog = createDefaultCatalog();
  const zhipu = addConnection(catalog, 'zhipu', {
    label: '智谱官方',
    baseUrl: VENDOR_META.zhipu.baseUrl,
  });
  catalog = zhipu.catalog;
  const deepseek = addConnection(catalog, 'deepseek', {
    label: 'DeepSeek 官方',
    baseUrl: VENDOR_META.deepseek.baseUrl,
  });
  catalog = deepseek.catalog;
  return {
    catalog,
    zhipuConnectionId: zhipu.connection.id,
    deepseekConnectionId: deepseek.connection.id,
  };
}

describe('行为契约 3（先验旧行为）：角色没配 → 完全等于旧行为，第一个可用的胜出', () => {
  it('不传 roles / 传 undefined / 传空对象，三者结果一样，都是智谱的 glm-5.3-flash', () => {
    const { catalog } = twoVendorCatalog();
    const old = pickModel(catalog, 'text');
    expect(old.ok).toBe(true);
    expect(old.model?.modelId).toBe('glm-5.3-flash');
    expect(old.provider?.id).toBe('zhipu');

    expect(pickModel(catalog, 'text', undefined).model?.modelId).toBe('glm-5.3-flash');
    expect(pickModel(catalog, 'text', null).model?.modelId).toBe('glm-5.3-flash');
    expect(pickModel(catalog, 'text', {}).model?.modelId).toBe('glm-5.3-flash');
  });
});

describe('行为契约 1：角色配了且模型可用 → 挑它，别的模型排第一也不影响', () => {
  it('writing = DeepSeek 的 deepseek-flash：智谱排第一也照样挑 DeepSeek', () => {
    const { catalog, deepseekConnectionId } = twoVendorCatalog();
    const roles: ModelRoles = {
      writing: modelKeyOf('deepseek', deepseekConnectionId, 'deepseek-flash'),
    };
    const picked = pickModel(catalog, 'text', roles);
    expect(picked.ok).toBe(true);
    expect(picked.provider?.id).toBe('deepseek');
    expect(picked.model?.modelId).toBe('deepseek-flash');
    expect(picked.connection?.id).toBe(deepseekConnectionId);
  });

  it('agent 与 writing 是两个独立指针：写作挑便宜的、工作流设计挑最强的', () => {
    const { catalog, zhipuConnectionId, deepseekConnectionId } = twoVendorCatalog();
    const roles: ModelRoles = {
      writing: modelKeyOf('deepseek', deepseekConnectionId, 'deepseek-flash'),
      agent: modelKeyOf('zhipu', zhipuConnectionId, 'glm-5.3-flash'),
    };
    expect(pickModelForRole(catalog, 'writing', roles).model?.modelId).toBe('deepseek-flash');
    expect(pickModelForRole(catalog, 'agent', roles).model?.modelId).toBe('glm-5.3-flash');
    // 只配 agent 时，text 能力（→ writing 角色）不受影响，仍走旧行为
    expect(pickModel(catalog, 'text', { agent: roles.agent }).model?.modelId).toBe('glm-5.3-flash');
  });

  it('audio 角色：配了 speech-2.8-hd 才挑得到音频模型（audio 能力只能靠 caps 认）', () => {
    let { catalog } = twoVendorCatalog();
    const minimax = addConnection(catalog, 'minimax', {
      label: 'MiniMax 官方',
      baseUrl: VENDOR_META.minimax.baseUrl,
    });
    catalog = minimax.catalog;
    catalog = applyPresetTag(catalog, 'minimax', preset('speech-2.8-hd'));
    const roles: ModelRoles = {
      audio: modelKeyOf('minimax', minimax.connection.id, 'speech-2.8-hd'),
    };
    const picked = pickModel(catalog, 'audio', roles);
    expect(picked.ok).toBe(true);
    expect(picked.model?.modelId).toBe('speech-2.8-hd');
    expect(picked.model?.caps).toContain('audio');
  });
});

describe('行为契约 2：角色配了但模型被删 / 被禁用 / caps 不匹配 → 当没配，退回第一个可用，不报错', () => {
  it('模型被删（key 指向不存在的 modelId）→ 退回智谱 glm-5.3-flash', () => {
    const { catalog, deepseekConnectionId } = twoVendorCatalog();
    const roles: ModelRoles = {
      writing: modelKeyOf('deepseek', deepseekConnectionId, 'deepseek-flash-已下线'),
    };
    const picked = pickModel(catalog, 'text', roles);
    expect(picked.ok).toBe(true);
    expect(picked.model?.modelId).toBe('glm-5.3-flash');
  });

  it('连接被删（key 里的 connectionId 不存在）→ 同样退回', () => {
    const { catalog } = twoVendorCatalog();
    const roles: ModelRoles = { writing: modelKeyOf('deepseek', 'conn-不存在', 'deepseek-flash') };
    expect(pickModel(catalog, 'text', roles).model?.modelId).toBe('glm-5.3-flash');
  });

  it('模型被禁用（enabled === false）→ 退回第一个可用的', () => {
    const built = twoVendorCatalog();
    let catalog = built.catalog;
    const deepseekConnectionId = built.deepseekConnectionId;
    const provider = findProvider(catalog, 'deepseek');
    const row = provider?.connections
      .find((item) => item.id === deepseekConnectionId)
      ?.models.find((item) => item.modelId === 'deepseek-flash');
    if (!row) throw new Error('缺少 deepseek-flash 行');
    catalog = updateModel(catalog, 'deepseek', row.id, { enabled: false });

    const roles: ModelRoles = {
      writing: modelKeyOf('deepseek', deepseekConnectionId, 'deepseek-flash'),
    };
    const picked = pickModel(catalog, 'text', roles);
    expect(picked.ok).toBe(true);
    expect(picked.model?.modelId).toBe('glm-5.3-flash');
  });

  it('caps 不匹配该角色 → 当没配（image 角色指到一个纯文本模型）', () => {
    const { catalog, deepseekConnectionId } = twoVendorCatalog();
    const roles: ModelRoles = {
      image: modelKeyOf('deepseek', deepseekConnectionId, 'deepseek-flash'),
    };
    // deepseek-flash 只有 text+vision → image 角色视为未配置；目录里也没有生图模型
    const picked = pickModel(catalog, 'image', roles);
    expect(picked.ok).toBe(false);
    expect(picked.hint).toContain('生图');
  });

  it('角色指到「本地部署」厂商的模型 → 不采用（选出来只会让人以为能直接调）', () => {
    const { catalog } = twoVendorCatalog();
    const local = addConnection(catalog, 'local', {
      label: '本机 ComfyUI',
      baseUrl: 'http://127.0.0.1:8188',
    });
    const withLocal = applyPresetTag(local.catalog, 'local', preset('qwen-image-2.1'));
    const roles: ModelRoles = {
      image: modelKeyOf('local', local.connection.id, 'qwen-image-2.1'),
    };
    expect(pickModel(withLocal, 'image', roles).ok).toBe(false);
  });
});

describe('行为契约 4：什么可用模型都没有 → { ok:false, hint:capHint(cap) }，hint 里不许出现 glm 推荐', () => {
  it('空目录（0 条连接）', () => {
    const catalog = createDefaultCatalog();
    const picked = pickModel(catalog, 'text');
    expect(picked.ok).toBe(false);
    expect(picked.hint).toBe(capHint('text'));
  });

  it('capHint("text") 推荐 DeepSeek deepseek-flash，不再推荐 glm（R7a §G）', () => {
    const hint = capHint('text');
    expect(hint).toContain('deepseek-flash');
    expect(hint).toContain('DeepSeek');
    expect(hint).not.toContain('glm');
    expect(hint).not.toContain('智谱');
  });

  it('角色配了但目录整个是空的 → 也是 hint，不抛错', () => {
    const picked = pickModel(createDefaultCatalog(), 'image', {
      image: 'zhipu:conn-x:cogview-3-flash',
    });
    expect(picked.ok).toBe(false);
    expect(picked.hint).toContain('生图');
  });

  it('每个能力都有能照着点的建议（含音频）', () => {
    expect(capHint('audio')).toContain('speech-2.8-hd');
    expect(capHint('audio')).toContain('MiniMax');
    expect(capHint('video')).toContain('seedance');
  });
});
