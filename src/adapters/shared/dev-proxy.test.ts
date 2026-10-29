/**
 * M3R10 §5-4 / §5-6；**M3R11 §4 收窄**：DEV 代理改写。
 *
 * M3R11 的更正：**方舟不再走代理**。它实测支持 CORS（`OPTIONS` → 204，业务响应可读），
 * 走 dev 代理等于在本地同源上"自欺" —— 永远通，也就永远测不出真实 CORS 行为。
 * 现在代理只服务 `VENDOR_META[id].webCors === 'blocked'` 的厂商（目前只有灵绘），
 * 判定既不按 host 硬编码、也不看厂商名字符串。
 *
 * ⚠️ 关键实测坑（M3R10 踩到，仍然有效）：**vitest 里 `import.meta.env.DEV` 也是 `true`**
 * （vitest 不设 `NODE_ENV=production`）。两个后果，本文件都要覆盖：
 * ① 单测必须能把 dev 代理**关掉**，否则生图适配器（base_url 默认就是方舟域名）
 *    在测试里会被改写成相对路径（M3R10 时方舟也在表里），mock fetch 的 `new URL()`
 *    抛异常，结果被误判成 `cors_blocked` —— 实测就是这样让两条生图用例变红的。
 *    所以 `rewriteForDevProxy` 排掉 `MODE === 'test'`。
 * ② 真要验证映射本身，得用 `vi.stubEnv('MODE', 'development')` 把"不是单测"这件事
 *    伪装出来，否则测的是一个恒等函数。
 *
 * 生产侧「不改写」不靠跑 build 来测（要几秒还要读 dist），而靠判据 §5-6 的
 * 产物扫描：`npm run check:no-dev-proxy`（见 M3R10-REPORT.md §3）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VENDOR_META } from '../ai-models/catalog';
import { rewriteForDevProxy } from './dev-proxy';

const VITE_CONFIG = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
const SOURCE = readFileSync(resolve(process.cwd(), 'src/adapters/shared/dev-proxy.ts'), 'utf8');

/** 厂商标里被标成 blocked 的那些（本文件所有断言都从这张表推，不写死厂商名） */
const BLOCKED = Object.values(VENDOR_META).filter((meta) => meta.webCors === 'blocked');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('M3R11 §5-6：只改写 webCors === blocked 的厂商', () => {
  it('灵绘（punycode 域）→ /__px/linghui/...（版本段与 query 都保留）', () => {
    vi.stubEnv('MODE', 'development');
    expect(rewriteForDevProxy('https://xn--ai-xg4e312c.com/v1/models')).toBe(
      '/__px/linghui/v1/models',
    );
    expect(rewriteForDevProxy('https://xn--ai-xg4e312c.com/models')).toBe('/__px/linghui/models');
    expect(rewriteForDevProxy('https://xn--ai-xg4e312c.com/v1/chat/completions?x=1')).toBe(
      '/__px/linghui/v1/chat/completions?x=1',
    );
  });

  it('**方舟的地址一个字符都不动**（M3R11 §4：它能直连，走代理就测不到真 CORS）', () => {
    vi.stubEnv('MODE', 'development');
    for (const url of [
      'https://ark.cn-beijing.volces.com/api/v3/models',
      'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      'https://ark.cn-beijing.volces.com/api/v3/images/generations',
      'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
    ]) {
      expect(rewriteForDevProxy(url)).toBe(url);
    }
  });

  it('CORS 放行的官方厂商同样原样（改写只服务于被拦的那一家）', () => {
    vi.stubEnv('MODE', 'development');
    for (const url of [
      'https://api.deepseek.com/v1/models',
      'https://open.bigmodel.cn/api/paas/v4/models',
      'https://api.moonshot.cn/v1/models',
      'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
      'https://api.minimax.chat/v1/models',
    ]) {
      expect(rewriteForDevProxy(url)).toBe(url);
    }
  });

  it('其它地址原样：自定义中转站 / localhost / 别家 CDN', () => {
    vi.stubEnv('MODE', 'development');
    for (const url of [
      'https://relay.example.com/v1/models',
      'http://127.0.0.1:8188/prompt',
      'https://cdn.example.com/img.png',
    ]) {
      expect(rewriteForDevProxy(url)).toBe(url);
    }
  });

  it('不是合法 URL → 原样返回（交给下游报「地址不合法」，不在这里抛）', () => {
    vi.stubEnv('MODE', 'development');
    expect(rewriteForDevProxy('')).toBe('');
    expect(rewriteForDevProxy('ark.cn-beijing.volces.com')).toBe('ark.cn-beijing.volces.com');
    expect(rewriteForDevProxy('not a url')).toBe('not a url');
  });

  it('只按 host 匹配，不按"字符串里含这个域名"匹配（防子域/路径伪造）', () => {
    vi.stubEnv('MODE', 'development');
    // 相似的 host 不能被当成灵绘（否则会被悄悄代理到别处）
    expect(
      rewriteForDevProxy('https://evil-xn--ai-xg4e312c.com.attacker.test/v1/models'),
    ).toBe('https://evil-xn--ai-xg4e312c.com.attacker.test/v1/models');
    // 域名出现在**路径**里也不改写
    expect(
      rewriteForDevProxy('https://relay.example.com/xn--ai-xg4e312c.com/v1/models'),
    ).toBe('https://relay.example.com/xn--ai-xg4e312c.com/v1/models');
    expect(
      rewriteForDevProxy('https://relay.example.com/ark.cn-beijing.volces.com/api/v3/models'),
    ).toBe('https://relay.example.com/ark.cn-beijing.volces.com/api/v3/models');
  });
});

describe('单测模式下必须关闭 dev 代理（否则适配器用例被误判成 cors_blocked）', () => {
  it('MODE=test 时灵绘地址原样返回 —— 这是 M3R10 实测踩到的坑', () => {
    vi.stubEnv('MODE', 'test');
    expect(rewriteForDevProxy('https://xn--ai-xg4e312c.com/v1/models')).toBe(
      'https://xn--ai-xg4e312c.com/v1/models',
    );
    expect(rewriteForDevProxy('https://ark.cn-beijing.volces.com/api/v3/images/generations')).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    );
  });

  it('当前测试进程默认就是 test 模式，不 stub 也是恒等（用例不会互相污染）', () => {
    expect(import.meta.env.MODE).toBe('test');
    expect(rewriteForDevProxy('https://xn--ai-xg4e312c.com/v1/models')).toBe(
      'https://xn--ai-xg4e312c.com/v1/models',
    );
  });
});

describe('§5-6 机制保证：DEV 守卫在函数内部，地址表才会被常量折叠摇掉', () => {
  it('守卫在函数体首行、且在挂载前缀之前；映射逻辑**内联**在函数里（不能抽出去）', () => {
    const fnStart = SOURCE.indexOf('export function rewriteForDevProxy');
    expect(fnStart).toBeGreaterThan(-1);
    const body = SOURCE.slice(fnStart);
    const guard = body.indexOf('if (!import.meta.env.DEV');
    expect(guard).toBeGreaterThan(-1);
    // 守卫必须在挂载前缀之前 —— 否则压缩器看不到"不可达"，`__px` 会漏进生产产物
    const firstMount = body.indexOf('/__px');
    expect(firstMount).toBeGreaterThan(guard);
    // 前缀必须在**这个函数体**里：抽成另一个仍被引用的函数/常量 = 活代码，
    // `__px` 会照原样留在产物里（§3 的 grep 就会命中）
    const fnEnd = body.indexOf('\n}');
    expect(fnEnd).toBeGreaterThan(firstMount);
    expect(body.slice(firstMount, fnEnd)).toContain('/__px/${id}');
  });

  it('guard 同时排掉 test 模式（写法变了这条会红，防止有人"顺手简化"掉）', () => {
    expect(SOURCE).toContain("import.meta.env.MODE === 'test'");
  });
});

describe('§5-6 低级错误防线：挂载名与 vite.config.ts 必须逐字一致', () => {
  it('每个 blocked 厂商的 /__px/<id> 都在 vite.config.ts 的 proxy 里', () => {
    // 不一致的现场表现是「DEV 下代理 404」——比漏进生产更常见，先在这里挡住
    expect(BLOCKED.length).toBeGreaterThan(0);
    for (const meta of BLOCKED) {
      expect(VITE_CONFIG).toContain(`'/__px/${meta.id}'`);
    }
  });

  it('vite.config.ts 的 target 与厂商标的 baseUrl 指向同一家', () => {
    for (const meta of BLOCKED) {
      expect(VITE_CONFIG).toContain(meta.baseUrl);
    }
  });

  it('M3R11 §4：方舟**不在** dev 代理表里（它可直连，代理会掩盖真实 CORS）', () => {
    expect(VITE_CONFIG).not.toContain('__px/ark');
    expect(VITE_CONFIG).not.toContain('ark.cn-beijing.volces.com');
  });

  it('rewrite 规则把挂载前缀去掉（否则代理过去会多一层路径，全 404）', () => {
    for (const meta of BLOCKED) {
      expect(VITE_CONFIG).toContain(`/^\\/__px\\/${meta.id}/`);
    }
  });
});
