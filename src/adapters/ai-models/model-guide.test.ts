/**
 * `/model-guide` 页面的内容源（M3R §5）。
 *
 * 两条纪律各锁一条断言：
 * 1. 页面内容必须来自承接方那份 draft（厂商、模型、视频计价、三个算例都在）；
 * 2. 顶部必须写「最后更新」并说明时效性靠开发者手动更新。
 *
 * 另外把「文档页写的金额」与 `pricing.ts` 算出来的金额对齐 ——
 * 否则文档和费用预估会各说一套，用户按文档预期、按预估扣费。
 */
import { describe, expect, it } from 'vitest';
import {
  GUIDE_CAP_ORDER,
  GUIDE_CUSTOM_RELAY_NOTE,
  GUIDE_EXAMPLES,
  GUIDE_LOCAL_DEPLOY_NOTE,
  GUIDE_MODELS,
  GUIDE_PICKING_ADVICE,
  GUIDE_VENDOR_INTROS,
  GUIDE_VENDORS,
  GUIDE_VIDEO_RATES,
  GUIDE_VIDEO_TOKEN_FORMULA,
  LINGHUI_SIGNUP_LABEL,
  LINGHUI_SIGNUP_URL,
  MODEL_GUIDE_STALENESS_NOTE,
  MODEL_GUIDE_UPDATED,
  modelsByCap,
} from './model-guide';
import { estimateVideo, formatYuan } from './pricing';

describe('厂商与模型选型文档（§5）', () => {
  it('最后更新写成 YYYY-MM，并注明时效性由开发者手动维护', () => {
    expect(MODEL_GUIDE_UPDATED).toMatch(/^\d{4}-\d{2}$/);
    expect(MODEL_GUIDE_UPDATED).toBe('2026-10');
    expect(MODEL_GUIDE_STALENESS_NOTE).toContain('手动维护');
    expect(MODEL_GUIDE_STALENESS_NOTE).toContain('官方价格页');
  });

  it('厂商表覆盖 11 家，顺序按承接方指定，每家都有 base_url / 是否直连 / key 获取地址', () => {
    expect(GUIDE_VENDORS.map((vendor) => vendor.name)).toEqual([
      '智谱 BigModel',
      'DeepSeek',
      '火山方舟（豆包）',
      '月之暗面 / Kimi',
      '阿里百炼 / 千问',
      'MiniMax',
      'OpenAI 官方',
      'Google / Gemini',
      'Anthropic 官方',
      '灵绘（中转）',
      '本地部署',
    ]);
    for (const vendor of GUIDE_VENDORS) {
      expect(['可以', '需中转', '本地'], `直连标记 ${vendor.name}`).toContain(vendor.direct);
      expect(vendor.keyUrl.length, `key 获取 ${vendor.name}`).toBeGreaterThan(3);
      if (vendor.direct === '本地') {
        // 本地部署没有固定地址，由用户自己填
        expect(vendor.baseUrl).toContain('由你填');
      } else {
        expect(vendor.baseUrl.trim().length).toBeGreaterThanOrEqual(4);
      }
    }
    expect(GUIDE_VENDORS.find((vendor) => vendor.name === '智谱 BigModel')?.baseUrl).toBe(
      'https://open.bigmodel.cn/api/paas/v4',
    );
    expect(GUIDE_VENDORS.find((vendor) => vendor.name === '火山方舟（豆包）')?.direct).toBe('可以');
    expect(GUIDE_VENDORS.find((vendor) => vendor.name === 'OpenAI 官方')?.direct).toBe('需中转');
    // 文档里那行「自定义中转站」没丢，只是变成一句说明
    expect(GUIDE_CUSTOM_RELAY_NOTE).toContain('base_url');
    expect(GUIDE_LOCAL_DEPLOY_NOTE).toContain('ComfyUI');
  });

  it('OpenAI / Anthropic / Gemini 都标「需中转」，Gemini 的依据是实测 000', () => {
    const byName = (name: string) => GUIDE_VENDORS.find((vendor) => vendor.name === name);
    expect(byName('OpenAI 官方')?.direct).toBe('需中转');
    expect(byName('Anthropic 官方')?.direct).toBe('需中转');
    expect(byName('Google / Gemini')?.direct).toBe('需中转');
    expect(byName('Google / Gemini')?.note).toContain('000');
    // 国内能直连的那几家不标中转
    for (const name of ['智谱 BigModel', 'DeepSeek', '火山方舟（豆包）', '月之暗面 / Kimi', '阿里百炼 / 千问', 'MiniMax', '灵绘（中转）']) {
      expect(byName(name)?.direct, name).toBe('可以');
    }
  });

  it('灵绘那条注册链接带邀请码，必须显式标「开发者推荐 · 含邀请码」', () => {
    const linghui = GUIDE_VENDORS.find((vendor) => vendor.name === '灵绘（中转）');
    expect(linghui?.signup).toBeDefined();
    expect(linghui?.signup?.url).toBe(LINGHUI_SIGNUP_URL);
    expect(LINGHUI_SIGNUP_URL).toContain('?aff=');
    expect(LINGHUI_SIGNUP_LABEL).toBe('开发者推荐 · 含邀请码');
    expect(linghui?.signup?.label).toBe(LINGHUI_SIGNUP_LABEL);
    // 只有灵绘有推广链接，别家不能挂
    expect(GUIDE_VENDORS.filter((vendor) => vendor.signup).map((vendor) => vendor.name)).toEqual([
      '灵绘（中转）',
    ]);
  });

  it('厂商介绍整段照搬文档：9 段（文档里有几段就渲染几段），措辞不改', () => {
    expect(GUIDE_VENDOR_INTROS).toHaveLength(9);
    expect(GUIDE_VENDOR_INTROS.map((intro) => intro.vendor)).toEqual([
      '智谱 / GLM',
      'DeepSeek',
      '火山方舟 / 豆包',
      '月之暗面 / Kimi',
      '阿里百炼 / 千问',
      'MiniMax',
      'OpenAI / ChatGPT',
      'Anthropic / Claude',
      'Google / Gemini',
    ]);
    const joined = GUIDE_VENDOR_INTROS.map((intro) => intro.text).join('\n');
    // 原文里的关键句逐句抽查（改措辞就会对不上）
    expect(joined).toContain('唯一提供免费 api 的厂商');
    expect(joined).toContain('glm-5.3 本体比 flash 版贵10倍');
    expect(joined).toContain('视频生成模型doubao-seedance-2-5-260628业内顶尖。');
    expect(joined).toContain('国内最贵的大模型（￥100 / M tokens）');
    expect(joined).toContain('qwen-image-2.1就是很适合本地部署的生图模型');
    expect(joined).toContain('海螺AI与星野(虚拟角色聊天软件)');
    expect(joined).toContain('最新模型是gpt-6.1-sol');
    expect(joined).toContain('家里四个模型价格从高到低分别为fable-5-1($50，全世界最贵)');
    expect(joined).toContain('深受网文写作者喜爱');
    for (const intro of GUIDE_VENDOR_INTROS) {
      expect(intro.text.length).toBeGreaterThan(10);
    }
  });

  it('模型清单按能力分组（含音频一节），且 §2 的 15 个模型全部出现', () => {
    expect(GUIDE_CAP_ORDER).toEqual(['text', 'vision', 'image', 'video', 'audio']);
    const ids = GUIDE_MODELS.map((model) => model.modelId);
    for (const modelId of [
      'glm-5.3-flash',
      'glm-4.7-flash',
      'glm-4v-flash',
      'cogview-3-flash',
      'cogvideox-flash',
      'deepseek-flash',
      'deepseek-v4-pro',
      'doubao-seedance-2-5-260628',
      'doubao-seed-2-1-pro-260628',
      'doubao-seedream-5-0-pro-260628',
      'claude-opus-5-5',
      'gpt-6.1-sol',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
      'qwen-image-2.1',
      'minimax-h3',
    ]) {
      expect(ids, `文档缺少 ${modelId}`).toContain(modelId);
    }

    // 每个能力组都有内容，且组内模型真的带这个能力
    for (const cap of GUIDE_CAP_ORDER) {
      const group = modelsByCap(cap);
      expect(group.length).toBeGreaterThan(0);
      for (const model of group) expect(model.caps).toContain(cap);
    }
    // 免费/推荐/本地三种标注都出现过
    const badges = new Set(GUIDE_MODELS.map((model) => model.badge));
    expect(badges.has('免费测试')).toBe(true);
    expect(badges.has('推荐')).toBe(true);
    expect(badges.has('本地')).toBe(true);
    // 未核实的必须标出来（不把待核实写成已核实）
    expect(GUIDE_MODELS.filter((model) => model.status === '待核实').length).toBeGreaterThan(0);
  });

  it('价格未核实的 11 个模型都在文档页，价格写「未核实」而不是编一个数', () => {
    const ids = [
      'glm-image',
      'cogview-4',
      'cogvideox-3',
      'kimi-k3.1-pro-highspeed',
      'claude-opus-5-5',
      'gpt-6.1-sol',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
      'gemini-4-argon',
      'qwen-image-2.1',
      'minimax-h3',
    ];
    expect(ids).toHaveLength(11);
    for (const id of ids) {
      const model = GUIDE_MODELS.find((item) => item.modelId === id);
      expect(model, `文档缺少 ${id}`).toBeDefined();
      if (id === 'qwen-image-2.1' || id === 'minimax-h3') {
        // 文档明确写 0（自托管），不是「未核实」
        expect(model?.price).toBe('0（自托管）');
        continue;
      }
      expect(model?.price, `${id} 的价格`).toBe('未核实');
    }
    // Claude 的四档价格只在备注里，没有折算成输入/输出两栏
    const claude = GUIDE_MODELS.find((item) => item.modelId === 'claude-opus-5-5');
    expect(claude?.note).toContain('fable-5-1 $50');
    expect(claude?.note).toContain('haiku-5-5 $0.5');

    // R7a：音频一节有内容（否则页面会渲染一个空表），且写明「不是语音识别」
    const audio = modelsByCap('audio');
    expect(audio.map((model) => model.modelId)).toEqual(['speech-2.8-hd']);
    expect(audio[0].price).toContain('元/万字符');
    expect(audio[0].note).toContain('不是语音识别');

    // 官方核实过的两条（kimi K3.1 Pro / speech）不能写成「未核实」
    for (const id of ['kimi-k3.1-pro', 'speech-2.8-hd']) {
      expect(GUIDE_MODELS.find((item) => item.modelId === id)?.price, id).not.toBe('未核实');
    }
  });

  it('视频计价表与 token 公式与 draft 一致', () => {
    expect(GUIDE_VIDEO_TOKEN_FORMULA).toContain('÷ 1024');
    expect(GUIDE_VIDEO_RATES.map((row) => `${row.model} ${row.resolution}`)).toEqual([
      'doubao-seedance-2.5 480p / 720p',
      'doubao-seedance-2.5 1080p',
      'doubao-seedance-2.0 480p / 720p',
      'doubao-seedance-2.0 1080p',
      'doubao-seedance-2.0 4k',
    ]);
    expect(GUIDE_VIDEO_RATES[0]).toEqual({
      model: 'doubao-seedance-2.5',
      resolution: '480p / 720p',
      withoutInputVideo: 70,
      withInputVideo: 42,
    });
    expect(GUIDE_VIDEO_RATES[2].withoutInputVideo).toBe(46);
    expect(GUIDE_VIDEO_RATES[4].withInputVideo).toBe(16);
  });

  it('三个算例与 pricing.ts 算出来的金额一字不差（45.36 / 20.18 / 40.24）', () => {
    const hd = estimateVideo({ model: 'doubao-seedance-2.5', res: '720p', outSec: 30 });
    const sd = estimateVideo({ model: 'doubao-seedance-2.5', res: '480p', outSec: 30 });
    const withInput = estimateVideo({
      model: 'doubao-seedance-2.5',
      res: '1080p',
      outSec: 12,
      inVideoSec: 6,
    });

    expect(GUIDE_EXAMPLES[0].amount).toBe(formatYuan(hd.total));
    expect(GUIDE_EXAMPLES[1].amount).toBe(formatYuan(sd.total));
    expect(GUIDE_EXAMPLES[2].amount).toBe(formatYuan(withInput.total));

    expect(GUIDE_EXAMPLES.map((example) => example.amount)).toEqual(['¥45.36', '¥20.18', '¥40.24']);
    // 480p 那条特别容易算成 20.16（先按秒取整的错法）
    expect(GUIDE_EXAMPLES[1].amount).not.toBe('¥20.16');
  });

  it('选择建议四条都在（试跑 / 日常 / 出片 / 走中转）', () => {
    expect(GUIDE_PICKING_ADVICE).toHaveLength(4);
    expect(GUIDE_PICKING_ADVICE.join('\n')).toContain('先试试');
    expect(GUIDE_PICKING_ADVICE.join('\n')).toContain('480p 样片');
    expect(GUIDE_PICKING_ADVICE.join('\n')).toContain('中转');
  });
});
