#!/usr/bin/env node
/**
 * `npm run check:edges` —— 真浏览器断言：模板载入后画布上到底有没有连线。
 *
 * 为什么必须有这一条（M5b3）：jsdom 下 89 条 workflow 用例全绿，真机上却是
 * "4 个节点、0 条连线、控制台无报错"。边能不能画出来取决于 xyflow 有没有**量过节点**
 * （`getEdgePosition` → `isNodeInitialized` → `measured.width` + `handleBounds`），
 * 而测量只由 ResizeObserver 回调写入 —— 这个链路 jsdom 完全不参与，只有真浏览器能验。
 *
 * 本脚本做两遍：
 *   1) `ro-off`：页面加载前把 `ResizeObserver` 换成一个**永不回调**的桩。
 *      这模拟的就是"页面不出帧"的真机情形（窗口被遮挡/最小化、后台标签页、无帧调度的无头窗口）：
 *      xyflow 收不到回调 → 节点量不到 → 边全部静默不渲染。**M5b3 之前这一遍会 FAIL。**
 *   2) `ro-on`：正常 ResizeObserver，验证补测逻辑没有把正常路径搞坏。
 *
 * 每个模式都跑三个模板各一次（不是只验第一个）。点模板用 `element.click()`，
 * 不依赖鼠标事件（本机有头 Edge 的 CDP 鼠标事件会被丢弃）。
 *
 * 依赖：只需要 Node ≥ 20（用内置 fetch/WebSocket）+ 本机装了 Edge。
 * 用法：npm run check:edges            # 需要先 npm run build（脚本会检查 dist）
 *      EDGE_PATH="D:/Edge/msedge.exe" npm run check:edges
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const TEMPLATES = [
  { id: 'dream-to-image', title: '解梦 → 故事 → 生图', nodes: 4, edges: 3 },
  { id: 'copy-to-video', title: '文案 → 分镜 → 生视频', nodes: 4, edges: 3 },
  { id: 'idea-to-text', title: '灵感 → 扩写 → 输出', nodes: 3, edges: 2 },
  // M5b4：含「图片源」节点（imageSource → 生视频的首帧口）
  { id: 'image-to-video', title: '已有图片 → 生视频', nodes: 4, edges: 3 },
];
const MODES = [
  { key: 'ro-off', label: 'ResizeObserver 不回调（模拟页面不出帧）', stub: true },
  { key: 'ro-on', label: '正常 ResizeObserver', stub: false },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** 让 ResizeObserver 永远不回调：模拟"没有帧"时浏览器的行为 */
const RO_STUB = `(() => {
  window.__checkEdgesStubbedResizeObserver = true;
  class SilentResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = SilentResizeObserver;
})();`;

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function findEdge() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  fail('找不到 Edge/Chrome。用 EDGE_PATH=/path/to/msedge.exe 指定。');
}

/** 静态文件服务（hash 路由，所有非文件路径都回 index.html） */
async function serveDist() {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0]);
    let filePath = normalize(join(DIST, urlPath === '/' ? 'index.html' : urlPath));
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(DIST, 'index.html');
    }
    try {
      const body = readFileSync(filePath);
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

/** 极简 CDP 客户端（Node 内置 WebSocket） */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.exceptions = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
          else entry.resolve(msg.result);
        }
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const text = msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text;
        this.exceptions.push(String(text).slice(0, 200));
      }
    });
  }

  send(method, params = {}) {
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面里执行失败：${result.exceptionDetails.text} ${JSON.stringify(result.exceptionDetails.exception?.description ?? '').slice(0, 200)}`);
    }
    return result.result?.value;
  }

  async waitFor(expression, timeoutMs = 10000, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.eval(expression)) return true;
      } catch {
        /* 页面还没起来：继续等 */
      }
      await delay(intervalMs);
    }
    return false;
  }
}

async function launchBrowser() {
  const exe = findEdge();
  const profile = mkdtempSync(join(tmpdir(), 'ia-check-edges-'));
  const child = spawn(
    exe,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1500,1000',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  const portFile = join(profile, 'DevToolsActivePort');
  let port = 0;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const [first] = readFileSync(portFile, 'utf8').split('\n');
      port = Number(first);
      if (port > 0) break;
    }
    await delay(100);
  }
  if (!port) {
    child.kill();
    fail('Edge 没起来（拿不到 DevToolsActivePort）。');
  }

  // 等 /json/list 出现可用的 page target
  let target = null;
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      target = list.find((item) => item.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch {
      /* 继续等 */
    }
    await delay(100);
  }
  if (!target) {
    child.kill();
    fail('Edge 起来了但没有 page target。');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', () => j(new Error('连不上页面 WebSocket')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { child, profile, cdp, ws };
}

const STATE_JS = `JSON.stringify({
  nodes: document.querySelectorAll('.react-flow__node').length,
  edges: document.querySelectorAll('[data-testid^="rf__edge"]').length,
  edgeGroups: document.querySelectorAll('.react-flow__edge').length,
  paths: document.querySelectorAll('.react-flow__edge-path').length,
  edgeContainerChildren: (document.querySelector('.react-flow__edges') || { children: [] }).children.length,
  handles: document.querySelectorAll('.react-flow__handle').length,
})`;

async function checkOne(cdp, baseUrl, template, run) {
  // 同一个 URL + 同一个 hash 的 Page.navigate 不会真的重载（同文档导航），
  // 会让上一轮载入的模板残留在画布上、模板卡出不来 —— 加个 query 强制换成新文档。
  await cdp.send('Page.navigate', { url: `${baseUrl}/?run=${run}#/workflow` });
  const ready = await cdp.waitFor("!!document.querySelector('[data-template]')", 15000);
  if (!ready) return { ok: false, reason: '工作流页没挂载（找不到模板卡）' };

  const clicked = await cdp.eval(
    `(() => { const card = document.querySelector('[data-template="${template.id}"]'); if (!card) return 'no-card'; card.click(); return 'clicked'; })()`,
  );
  if (clicked !== 'clicked') return { ok: false, reason: `点不到模板卡（${clicked}）` };

  const want = `document.querySelectorAll('[data-testid^="rf__edge"]').length === ${template.edges}`;
  await cdp.waitFor(want, 4000);

  const state = JSON.parse(await cdp.eval(STATE_JS));
  const ok =
    state.nodes === template.nodes &&
    state.edges === template.edges &&
    state.edgeGroups === template.edges &&
    state.paths === template.edges &&
    state.edgeContainerChildren > 0;

  return {
    ok,
    state,
    reason: ok
      ? ''
      : `期望 ${template.nodes} 节点 / ${template.edges} 条边，实际 ${state.nodes} 节点 / ${state.edges} 条边` +
        `（.react-flow__edge=${state.edgeGroups}，path=${state.paths}，edges 容器的子元素=${state.edgeContainerChildren}，handle=${state.handles}）`,
  };
}

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    fail('没有 dist/index.html。先跑 `npm run build`（check:edges 验的是真正会被发布的产物）。');
  }
  if (typeof WebSocket === 'undefined') {
    fail('当前 Node 没有内置 WebSocket，请用 Node ≥ 20 跑这个脚本。');
  }

  const { server, port } = await serveDist();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`静态服务：${baseUrl}（产物目录 dist/）`);

  const { child, profile, cdp, ws } = await launchBrowser();
  const results = [];
  let failed = 0;
  let run = 0;

  try {
    let scriptId = null;
    for (const mode of MODES) {
      if (mode.stub) {
        const res = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: RO_STUB });
        scriptId = res.identifier;
      } else if (scriptId) {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
        scriptId = null;
      }

      for (const template of TEMPLATES) {
        run += 1;
        const outcome = await checkOne(cdp, baseUrl, template, run);
        results.push({ mode, template, outcome });
        if (!outcome.ok) failed += 1;
      }
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      child.kill();
    }
    server.close();
    await delay(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log('\n模板 → 画布连线（真浏览器 DOM 断言）');
  for (const { mode, template, outcome } of results) {
    const mark = outcome.ok ? 'PASS' : 'FAIL';
    const detail = outcome.ok
      ? `${outcome.state.nodes} 节点 / ${outcome.state.edges} 条边 / ${outcome.state.paths} 条 path / ${outcome.state.handles} 个 handle`
      : outcome.reason;
    console.log(`  [${mark}] ${mode.key.padEnd(6)} ${template.title.padEnd(12, '　')} ${detail}`);
  }

  const total = results.length;
  console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'}：${total - failed}/${total} 个断言通过`);

  if (failed > 0) {
    console.log(
      '\n排查提示：edges 容器有、`.react-flow__edge` 为 0 通常意味着 xyflow 没量到节点' +
        '（getEdgePosition 返回 null → EdgeWrapper 返回 null，控制台不报错）。' +
        '看 nodeLookup 里 measured 是否为空、handleBounds 是否为 null。',
    );
    process.exit(1);
  }
}

await main();
