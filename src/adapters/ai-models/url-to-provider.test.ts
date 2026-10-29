// @vitest-environment node
/**
 * R7a §C：`urlToProvider(url)` —— 按地址认厂商。
 *
 * 为什么需要它：推荐配置的弹窗只让用户填 base_url，没有「选厂商」这一步，而 `Provider`
 * 是连接的父级（key 与 base_url 同生共死），所以必须能从地址反推归属；认不出 → null →
 * 调用方落到「自定义」，绝不猜到某家头上。
 *
 * 这里锁三件事：
 * 1. 对照表与 `VENDOR_META.baseUrl` 现算的结果完全一致（地址改了测试立刻炸，不会悄悄分叉）；
 * 2. 逐家命中 + 各种变形 URL 仍命中；
 * 3. 认不出的一律 null（未知域名 / 乱码 / 空串 / 越界后缀），**不抛错**。
 */
import { describe, expect, it } from 'vitest';
import { PROVIDER_HOSTS, VENDOR_META, sameOrSubdomain, urlToProvider } from './catalog';

/**
 * 任务书 §C 的对照表（10 家有固定地址的内置厂商）。
 *
 * 注意两处口径：
 * - 任务书写的 `bailian` 在代码里叫 `dashscope`（同一个厂商，只是 id 名不同）；
 * - 任务书说「内置 11 家」，但表里是 10 行 —— 第 11 家是 `local`（本地部署），
 *   `baseUrl` 是空串、没有 canonical hostname，所以它**不进**匹配表，匹配结果是 null。
 */
const EXPECTED_HOSTS: ReadonlyArray<[string, string]> = [
  ['zhipu', 'open.bigmodel.cn'],
  ['deepseek', 'api.deepseek.com'],
  ['ark', 'ark.cn-beijing.volces.com'],
  ['moonshot', 'api.moonshot.cn'],
  ['dashscope', 'dashscope.aliyuncs.com'],
  ['minimax', 'api.minimax.io'],
  ['anthropic', 'api.anthropic.com'],
  ['openai', 'api.openai.com'],
  ['gemini', 'generativelanguage.googleapis.com'],
  ['linghui', 'xn--ai-xg4e312c.com'],
];

describe('urlToProvider 的对照表（从 VENDOR_META 现算，不手抄）', () => {
  it('10 家有固定地址的内置厂商，hostname 与任务书逐条一致', () => {
    expect(PROVIDER_HOSTS.map((item) => [item.id, item.host])).toEqual(
      EXPECTED_HOSTS.map(([id, host]) => [id, host]),
    );
  });

  it('本地部署没有固定地址 → 不进匹配表', () => {
    expect(VENDOR_META.local.baseUrl).toBe('');
    expect(PROVIDER_HOSTS.some((item) => item.id === 'local')).toBe(false);
    expect(urlToProvider(VENDOR_META.local.baseUrl)).toBeNull();
  });
});

describe('urlToProvider 逐家命中（每家一条，用 VENDOR_META 的真实 baseUrl）', () => {
  for (const [id, host] of EXPECTED_HOSTS) {
    it(`${id} ← https://${host}`, () => {
      const meta = VENDOR_META[id as keyof typeof VENDOR_META];
      expect(urlToProvider(meta.baseUrl)).toBe(id);
      expect(urlToProvider(`https://${host}`)).toBe(id);
    });
  }
});

describe('urlToProvider 的变形 URL（忽略协议 / 端口 / 路径 / 末尾斜杠 / 大小写）', () => {
  it('大写 + 端口 + 路径 + 查询串', () => {
    expect(urlToProvider('HTTP://API.DeepSeek.COM:8443/v1/chat/completions?x=1')).toBe('deepseek');
  });

  it('末尾斜杠 / 只有主机名（没写协议也能认）', () => {
    expect(urlToProvider('https://api.deepseek.com/')).toBe('deepseek');
    expect(urlToProvider('api.deepseek.com')).toBe('deepseek');
    expect(urlToProvider('  open.bigmodel.cn  ')).toBe('zhipu');
  });

  it('子域可以匹配到父域（三级子域也算）', () => {
    expect(urlToProvider('https://foo.bar.api.deepseek.com/v1')).toBe('deepseek');
    expect(urlToProvider('https://cn.dashscope.aliyuncs.com/api/v1')).toBe('dashscope');
  });

  it('父域也能匹配到子域（用户只写了 deepseek.com）', () => {
    expect(urlToProvider('https://deepseek.com')).toBe('deepseek');
    expect(urlToProvider('https://anthropic.com/v1')).toBe('anthropic');
  });

  it('灵绘的 punycode 域名命中；写成中文域名也命中（浏览器会把 灵绘ai.com 转成同一个 punycode）', () => {
    expect(urlToProvider('https://xn--ai-xg4e312c.com')).toBe('linghui');
    expect(urlToProvider('https://xn--ai-xg4e312c.com/v1/chat/completions')).toBe('linghui');
    expect(urlToProvider('https://灵绘ai.com')).toBe('linghui');
  });
});

describe('urlToProvider 认不出的一律 null（不抛错）', () => {
  it('未知域名 / 中转站地址', () => {
    expect(urlToProvider('https://api.relaycore.cn')).toBeNull();
    expect(urlToProvider('https://example.com/v1')).toBeNull();
    expect(urlToProvider('https://api.some-unknown-relay.com/v1')).toBeNull();
  });

  it('看起来像但不是：越界后缀不能被当成子域', () => {
    expect(urlToProvider('https://api.deepseek.com.cn')).toBeNull();
    expect(urlToProvider('https://notdeepseek.com')).toBeNull();
    expect(urlToProvider('https://my-openai.com')).toBeNull();
  });

  it('空串 / 纯空白 / 解析不出 / 乱码 → null', () => {
    expect(urlToProvider('')).toBeNull();
    expect(urlToProvider('   ')).toBeNull();
    expect(urlToProvider('http://')).toBeNull();
    expect(urlToProvider('https://')).toBeNull();
    expect(urlToProvider('::::')).toBeNull();
    expect(urlToProvider('这不是网址')).toBeNull();
  });

  it('非字符串（脏数据）也不炸', () => {
    expect(urlToProvider(undefined as unknown as string)).toBeNull();
    expect(urlToProvider(12 as unknown as string)).toBeNull();
  });
});

describe('sameOrSubdomain 的判定', () => {
  it('相等 / 互为子域为真；相似但越界为假', () => {
    expect(sameOrSubdomain('api.deepseek.com', 'api.deepseek.com')).toBe(true);
    expect(sameOrSubdomain('foo.api.deepseek.com', 'api.deepseek.com')).toBe(true);
    expect(sameOrSubdomain('api.deepseek.com', 'deepseek.com')).toBe(true);
    expect(sameOrSubdomain('deepseek.com', 'api.deepseek.com')).toBe(true);
    expect(sameOrSubdomain('api.deepseek.com.cn', 'api.deepseek.com')).toBe(false);
    expect(sameOrSubdomain('notdeepseek.com', 'deepseek.com')).toBe(false);
    expect(sameOrSubdomain('', 'deepseek.com')).toBe(false);
    expect(sameOrSubdomain('deepseek.com', '')).toBe(false);
  });
});


describe('历史域名别名（R7a 修正 MiniMax 地址后补）', () => {
  it('miniMax 换过域名，老地址仍认得出是 minimax，不会被判成自定义', () => {
    expect(urlToProvider('https://api.minimax.io/v1')).toBe('minimax');
    expect(urlToProvider('https://api.minimax.chat/v1')).toBe('minimax');
    expect(urlToProvider('api.minimaxi.com/v1')).toBe('minimax');
  });

  it('别名不会把别的厂商误认成 minimax', () => {
    expect(urlToProvider('https://api.minimaxxxx.com/v1')).toBeNull();
  });
});
