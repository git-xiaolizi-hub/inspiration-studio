/**
 * `/model-guide` 页面的内容源（M3R §5 / M3R2 §4 §5）。
 *
 * 内容来自 `docs/reference/vendor-model-guide.draft.md`（**承接方亲自填写**），
 * 这里只做「结构化搬运」：厂商介绍整段照搬，价格只照抄原文。
 *
 * 三条纪律：
 * 1. 文档写「未核实 / 未整理」的 → 价格留 null / 显示「未核实」，绝不补数字；
 * 2. 灵绘那条带邀请码的注册链接是**开发者推荐**，页面必须显式标注「含邀请码」；
 *    它只出现在本文件（guide 页），**不进** AI 配置页的厂商列表；
 * 3. **时效性靠开发者手动维护**：页面顶部显示「最后更新：YYYY-MM」，
 *    并写明重要决定前到官方价格页复核。
 *
 * 为什么不直接渲染 markdown：产品零依赖、零网络请求（CHARTER §2），
 * 带一个 markdown 解析器只为渲一页不划算；数据在这里、排版在组件里。
 */
import type { ModelCap } from './catalog';

/** 页面顶部的「最后更新」；改内容时必须一起改这个值 */
export const MODEL_GUIDE_UPDATED = '2026-10';

export const MODEL_GUIDE_STALENESS_NOTE =
  '本页内容时效性由开发者手动维护（最后更新见上方）：价格与模型名会变，重要决定前请到厂商官方价格页复核。';

/**
 * 灵绘的注册链接：带邀请码（aff=），属于**开发者推荐**。
 * 只在 guide 页出现，且必须显式标注，不伪装成中立的「官方地址」。
 */
export const LINGHUI_SIGNUP_URL = 'https://xn--ai-xg4e312c.com/register?aff=HSXNT7WHZ62T';
export const LINGHUI_SIGNUP_LABEL = '开发者推荐 · 含邀请码';

export interface GuideVendor {
  name: string;
  baseUrl: string;
  /** 国内能否直连：'可以' / '需中转' / '本地' */
  direct: '可以' | '需中转' | '本地';
  keyUrl: string;
  note?: string;
  /** 带邀请码的注册链接（只有灵绘有）；页面上必须同时显示 label */
  signup?: { url: string; label: string };
}

export const GUIDE_VENDORS: readonly GuideVendor[] = [
  {
    name: '智谱 BigModel',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    direct: '可以',
    keyUrl: 'open.bigmodel.cn',
    note: '有免费模型，最适合先跑通；版本段是 /v4。',
  },
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    direct: '可以',
    keyUrl: 'platform.deepseek.com',
    note: '兼容 OpenAI 协议；便宜、上下文长。',
  },
  {
    name: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    direct: '可以',
    keyUrl: 'console.volcengine.com/ark',
    note: '视频能力强；聊天模型可能需要 ep-xxxx 接入点；没有 /models 接口。',
  },
  {
    name: '月之暗面 / Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    direct: '可以',
    keyUrl: '—（文档未给）',
    note: '已实测直连（401 = 可达，只是没带 key）。',
  },
  {
    name: '阿里百炼 / 千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    direct: '可以',
    keyUrl: '—（文档未给）',
    note: '已实测直连（401 = 可达，只是没带 key）；compatible-mode 自带 /v1。',
  },
  {
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    direct: '可以',
    keyUrl: '—（文档未给）',
    note: '已实测直连（401 = 可达，只是没带 key）。',
  },
  {
    name: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    direct: '需中转',
    keyUrl: 'platform.openai.com',
    note: '国内基本不可用，通常走中转。',
  },
  {
    name: 'Google / Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    direct: '需中转',
    keyUrl: '—（文档未给）',
    note: '国内已实测 HTTP 000 超时（连不上），必须走中转。',
  },
  {
    name: 'Anthropic 官方',
    baseUrl: 'https://api.anthropic.com',
    direct: '需中转',
    keyUrl: 'console.anthropic.com',
    note: '走 /v1/messages 协议（不是 OpenAI 的 /chat/completions）。',
  },
  {
    name: '灵绘（中转）',
    baseUrl: 'https://xn--ai-xg4e312c.com',
    direct: '可以',
    keyUrl: 'https://灵绘ai.com',
    note: '开发者推荐的中转站；地址不加 /v1 也通（已实测 401）。',
    signup: { url: LINGHUI_SIGNUP_URL, label: LINGHUI_SIGNUP_LABEL },
  },
  {
    name: '本地部署',
    baseUrl: '（无固定地址，由你填）',
    direct: '本地',
    keyUrl: '—（本地通常不需要 key）',
    note: '需 ComfyUI / 自托管；本应用这一版只做占位，不发起调用。',
  },
];

/** 文档里的「自定义中转站」一行：不占一个厂商标签，单独作为一句说明 */
export const GUIDE_CUSTOM_RELAY_NOTE =
  '自定义中转站：支持你自填 base_url（AI 配置页 →「＋ 自定义」）；有的带 /v1 有的不带，两种都会自动试。';

/**
 * 厂商介绍：**文档原文整段照搬**（不改措辞，只做排版）。
 * 文档里有几段就渲染几段 —— 现在 9 段。
 */
export interface GuideVendorIntro {
  vendor: string;
  text: string;
}

export const GUIDE_VENDOR_INTROS: readonly GuideVendorIntro[] = [
  {
    vendor: '智谱 / GLM',
    text:
      '唯一提供免费 api 的厂商，适合测试，但一般拥堵且不要奢求质量。最新一代文本模型 glm-5.3，flash 版比 deepseek-flash 还便宜，并且提供更加优惠的资源包与 Coding Plan 订阅，glm-5.3 本体比 flash 版贵10倍，可能大材小用。缺点能力更侧重长程编程任务，并且回复较慢。小优点多模态齐全生态丰富。',
  },
  {
    vendor: 'DeepSeek',
    text: '国内综合质量、价格、回复速度最优的文本模型厂商，能力与国外顶尖模型有差距。',
  },
  {
    vendor: '火山方舟 / 豆包',
    text: '视频生成模型doubao-seedance-2-5-260628业内顶尖。',
  },
  {
    vendor: '月之暗面 / Kimi',
    text: '国内最贵的大模型（￥100 / M tokens），当然了智力也是最好的，就是太贵了。',
  },
  {
    vendor: '阿里百炼 / 千问',
    text:
      '大模型价格与能力平庸所以一般没有选择的理由，但是刚注册会送一些免费额度。小模型业内顶尖，本地部署离不开它，qwen-image-2.1就是很适合本地部署的生图模型。多模态丰富且自家app产品化较多。',
  },
  {
    vendor: 'MiniMax',
    text: '经典产品为海螺AI与星野(虚拟角色聊天软件)，最近推出适合本地部署的视频模型minmax-h3。',
  },
  {
    vendor: 'OpenAI / ChatGPT',
    text:
      '生图模型gpt-image-2.5业内顶尖，支持图片编辑、手绘参考图出图等。gpt-6-astra被认为防御性编程、漏洞测试、debug极强。最新模型是gpt-6.1-sol。开发者社区对其印象为擅长执行具体任务的AI。有便宜模型gpt-6-luna，虽然便宜但是不是非常简单的任务不要用。',
  },
  {
    vendor: 'Anthropic / Claude',
    text:
      '最新旗舰 claude-opus-5-5 被认为是当下最聪明的模型，虽然是文本模型但甚至能让它用代码制作视频，开发者社区普遍认为它是最能理解用户需求也最能编程的AI，尤其是前端页面写的漂亮，多agent协作时是与用户直接交流并指挥其他AI的最佳选择。最大缺点是封号严重国内没有任何办法正常使用，感兴趣建议用中转站但价格会比gpt高且能力可能受限。家里四个模型价格从高到低分别为fable-5-1($50，全世界最贵),opus-5-5($20),sonnet-5-5($10),haiku-5-5($0.5)。',
  },
  {
    vendor: 'Google / Gemini',
    text:
      '最新旗舰 gemini-4-argon 深受网文写作者喜爱，多模态理解、世界知识。UI审美方面的能力也不错，但是开发者社区认为其编程能力较差。',
  },
];

/** 本地部署：承接方明确要求「只做占位与说明」 */
export const GUIDE_LOCAL_DEPLOY_NOTE =
  '本地部署（需 ComfyUI / 自托管）：这一版只在厂商列表里占位，不发起任何请求。要在本机跑生图/视频，请先在 ComfyUI 里把工作流跑通；接入留给画板/节点功能。';

export type GuideBadge = '推荐' | '免费测试' | '备选' | '本地' | '未整理';

export interface GuideModel {
  modelId: string;
  vendor: string;
  caps: ModelCap[];
  /** 价格一行：文本写「输入 x / 输出 y（元/百万 token）」；没核实就写「未核实」 */
  price: string;
  badge: GuideBadge;
  /** 已核实 / 待核实 */
  status: '已核实' | '待核实';
  note?: string;
}

export const GUIDE_MODELS: readonly GuideModel[] = [
  // 智谱
  {
    modelId: 'glm-5.3-flash',
    vendor: '智谱',
    caps: ['text', 'vision'],
    price: '输入 ¥0.80 / 输出 ¥2.80（元/百万 token）',
    badge: '推荐',
    status: '已核实',
  },
  {
    modelId: 'glm-image',
    vendor: '智谱',
    caps: ['image'],
    price: '未核实',
    badge: '未整理',
    status: '待核实',
    note: '旗舰生图，推荐英文提示词',
  },
  {
    modelId: 'cogview-4',
    vendor: '智谱',
    caps: ['image'],
    price: '未核实',
    badge: '未整理',
    status: '待核实',
    note: '生图，中文支持更好',
  },
  {
    modelId: 'cogvideox-3',
    vendor: '智谱',
    caps: ['video'],
    price: '未核实',
    badge: '未整理',
    status: '待核实',
    note: '旗舰视频',
  },
  {
    modelId: 'glm-4.7-flash',
    vendor: '智谱',
    caps: ['text'],
    price: '0（免费）',
    badge: '免费测试',
    status: '已核实',
    note: '200K 上下文 / 128K 输出',
  },
  {
    modelId: 'glm-4v-flash',
    vendor: '智谱',
    caps: ['text', 'vision'],
    price: '0（免费）',
    badge: '免费测试',
    status: '已核实',
    note: '16K 上下文 / 1K 输出，只够验看图链路',
  },
  {
    modelId: 'cogview-3-flash',
    vendor: '智谱',
    caps: ['image'],
    price: '0（免费）· 元/张',
    badge: '免费测试',
    status: '已核实',
    note: '一次一张，别叠张数',
  },
  {
    modelId: 'cogvideox-flash',
    vendor: '智谱',
    caps: ['video'],
    price: '0（免费）',
    badge: '免费测试',
    status: '已核实',
    note: '异步接口；画质有限、高峰常 429',
  },
  // DeepSeek
  {
    modelId: 'deepseek-flash',
    vendor: 'DeepSeek',
    caps: ['text', 'vision'],
    price: '输入 ¥2.00 / 输出 ¥8.00（元/百万 token；空闲时段半价）',
    badge: '推荐',
    status: '已核实',
  },
  {
    modelId: 'deepseek-v4-pro',
    vendor: 'DeepSeek',
    caps: ['text'],
    price: '输入 ¥9.00 / 输出 ¥27.00（元/百万 token）',
    badge: '备选',
    status: '已核实',
    note: '不支持图像',
  },
  // 火山方舟
  {
    modelId: 'doubao-seedance-2-5-260628',
    vendor: '火山方舟',
    caps: ['video'],
    price: '见下方视频计价表',
    badge: '推荐',
    status: '已核实',
    note: 'API 形状部分未验证',
  },
  {
    modelId: 'doubao-seed-2-1-pro-260628',
    vendor: '火山方舟',
    caps: ['text', 'vision'],
    price: '输入 ¥6.00 / 输出 ¥30.00（元/百万 token）',
    badge: '备选',
    status: '已核实',
    note: '必须用版本化 ID（族名 doubao-seed-2.1-pro 会 404）',
  },
  {
    modelId: 'doubao-seedream-5-0-pro-260628',
    vendor: '火山方舟',
    caps: ['image'],
    price: '¥0.30/张（>261 万像素 ¥0.60/张）',
    badge: '推荐',
    status: '已核实',
  },
  // 月之暗面 / Kimi
  {
    modelId: 'kimi-k3.1-pro',
    vendor: 'Kimi',
    caps: ['text', 'vision'],
    price: '输入 ¥13 / 输出 ¥68（元/百万 token；命中缓存输入 ¥1.3）',
    badge: '备选',
    status: '已核实',
    note: '原生视觉理解、1M 上下文；官方定位 coding / agent，**写作不推荐**',
  },
  {
    modelId: 'kimi-k3.1-pro-highspeed',
    vendor: 'Kimi',
    caps: ['text', 'vision'],
    price: '未核实',
    badge: '备选',
    status: '待核实',
    note: '同 K3.1 Pro 智能，输出快 2–3×；单价未在官方价目页核实',
  },
  // 中转 / 外国
  {
    modelId: 'claude-opus-5-5',
    vendor: '中转',
    caps: ['text', 'vision'],
    price: '未核实',
    badge: '推荐',
    status: '待核实',
    note: '需中转 · fable-5-1 $50 / opus-5-5 $20 / sonnet-5-5 $10 / haiku-5-5 $0.5',
  },
  {
    modelId: 'gpt-6.1-sol',
    vendor: '中转',
    caps: ['text', 'vision'],
    price: '未核实',
    badge: '推荐',
    status: '待核实',
    note: '需中转',
  },
  {
    modelId: 'gpt-image-2.5-flare',
    vendor: '中转',
    caps: ['image'],
    price: '未核实',
    badge: '推荐',
    status: '待核实',
    note: '需中转 · 小模型、快（官方 $5 文 / $8 图输入 / $30 出图，每百万 token）',
  },
  {
    modelId: 'gpt-image-2.5-sunburst',
    vendor: '中转',
    caps: ['image'],
    price: '未核实',
    badge: '推荐',
    status: '待核实',
    note: '需中转 · 编辑精度与画质最高（与 flare 同价）',
  },
  {
    modelId: 'gemini-4-argon',
    vendor: 'Google',
    caps: ['text', 'vision'],
    price: '未核实',
    badge: '推荐',
    status: '待核实',
    note: '擅长写作；国内需中转',
  },
  // 音频（R7a 新增：音频生成 = TTS / 配音 / 音乐，**不是语音识别**）
  {
    modelId: 'speech-2.8-hd',
    vendor: 'MiniMax',
    caps: ['audio'],
    price: '3.50 元/万字符（中国站官方价）',
    badge: '推荐',
    status: '已核实',
    note: '语音合成（TTS），不是语音识别；异步单次最长 100 万字符',
  },
  // 本地
  {
    modelId: 'qwen-image-2.1',
    vendor: '本地部署',
    caps: ['image'],
    price: '0（自托管）',
    badge: '本地',
    status: '待核实',
  },
  {
    modelId: 'minimax-h3',
    vendor: '本地部署',
    caps: ['video'],
    price: '0（自托管）',
    badge: '本地',
    status: '待核实',
  },
];

export interface GuideVideoRate {
  model: string;
  resolution: string;
  withoutInputVideo: number;
  withInputVideo: number;
}

/** 火山方舟视频计价（元/百万 token）；`token = (输入秒+输出秒) × 宽 × 高 × 帧率 ÷ 1024` */
export const GUIDE_VIDEO_TOKEN_FORMULA =
  'token = (输入视频秒 + 输出视频秒) × 宽 × 高 × 帧率 ÷ 1024';

export const GUIDE_VIDEO_RATES: readonly GuideVideoRate[] = [
  { model: 'doubao-seedance-2.5', resolution: '480p / 720p', withoutInputVideo: 70, withInputVideo: 42 },
  { model: 'doubao-seedance-2.5', resolution: '1080p', withoutInputVideo: 77, withInputVideo: 46 },
  { model: 'doubao-seedance-2.0', resolution: '480p / 720p', withoutInputVideo: 46, withInputVideo: 28 },
  { model: 'doubao-seedance-2.0', resolution: '1080p', withoutInputVideo: 51, withInputVideo: 31 },
  { model: 'doubao-seedance-2.0', resolution: '4k', withoutInputVideo: 26, withInputVideo: 16 },
];

export interface GuideExample {
  label: string;
  detail: string;
  amount: string;
}

/** 三个算例与 `pricing.test.ts` 锁死的 45.36 / 20.18 / 40.24 完全一致 */
export const GUIDE_EXAMPLES: readonly GuideExample[] = [
  { label: '720p · 30 秒', detail: 'seedance-2.5 · 不含输入视频 · 24fps', amount: '¥45.36' },
  { label: '480p · 30 秒', detail: 'seedance-2.5 · 不含输入视频 · 24fps', amount: '¥20.18' },
  { label: '1080p · 12 秒 + 6 秒输入视频', detail: 'seedance-2.5 · 含输入视频', amount: '¥40.24' },
];

export const GUIDE_PICKING_ADVICE: readonly string[] = [
  '只想先试试：智谱的免费模型（glm-4.7-flash 文本 / cogview-3-flash 生图 / cogvideox-flash 视频）——不花钱，能力有上限。',
  '日常写东西：DeepSeek deepseek-flash，便宜且能看图。',
  '要出片：火山方舟 doubao-seedance-2-5-260628，按秒计费，先出 480p 样片再出成片更省。',
  '不想折腾官方 key：用中转站，把 base_url 填成中转地址即可（自定义厂商里建一条连接）。',
];

/** 按能力分组（页面分节渲染用）；顺序固定为 文本 → 视觉 → 生图 → 视频 → 音频 */
export const GUIDE_CAP_ORDER: readonly ModelCap[] = ['text', 'vision', 'image', 'video', 'audio'];

export function modelsByCap(cap: ModelCap): GuideModel[] {
  return GUIDE_MODELS.filter((model) => model.caps.includes(cap));
}
