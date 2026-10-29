#!/usr/bin/env node
/**
 * M5b4 的真浏览器证据（截图 + 文案）。
 *
 * 为什么要单独一个脚本：这三条需求都是"人看着才算数"的东西 ——
 * 「每步确认」停没停、「图片源」能不能选已有产物、「参考视频被拒」到底写了什么话。
 * jsdom 只能证明状态机对，证明不了页面上真的出现了那个面板、那句提示。
 *
 * 成本：**零**。AI 请求全部打到本脚本内置的 mock 服务（127.0.0.1），
 * 模型表里也只有一个假 key —— 不碰任何真实厂商，不花一分钱（CHARTER §13.2）。
 *
 * 依赖：Node ≥ 20 + 本机 Edge（与 check-edges.mjs 相同）。
 * 用法：npm run build && node scripts/check-m5b4-evidence.mjs
 *      EDGE_PATH="D:/Edge/msedge.exe" node scripts/check-m5b4-evidence.mjs
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const SHOTS = join(ROOT, 'docs', 'evidence');

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

/** mock 服务记下的每一次文本请求（用来证明"选了 A 就跑 A"） */
const chatModels = [];

const STORY_JSON = {
  directions: [
    {
      title: '四点闹钟',
      logline: '她只想让那个闹钟停下来，可它每天四点准时响。',
      conflict: '人与物',
      why_it_holds: '记录里那句「雨夜营业的修表铺」就是裂缝',
      beats: ['她把闹钟塞进抽屉', '抽屉里还是响，声音更闷', '她拔掉电池，屋里安静了一整晚'],
      borrowed: ['闹钟', '抽屉'],
    },
    {
      title: '没洗的茶渍',
      logline: '他想留住一个人，留下的只有杯子上没洗掉的那圈印子。',
      conflict: '人与人',
      why_it_holds: '记录写的是「修好别人的时间」，他自己的表却修不好',
      beats: ['他把杯子放进水池又拿出来', '他拿布擦那圈茶渍，擦不掉', '他把杯子摆回原来的位置'],
      borrowed: ['杯子', '茶渍'],
    },
    {
      title: '说一半的话',
      logline: '他要说完一句被自己打断的话，可每次说到一半就停住。',
      conflict: '人与自己',
      why_it_holds: '「修不好自己的表」这句是整段里唯一的空白',
      beats: ['他对着镜子把那句说完整', '第二次他换了个开头', '第三次他终于说完，然后关灯'],
      borrowed: ['镜子', '那句停住的话'],
    },
  ],
  disclaimer: '示例输出（本地 mock）：虚构加工，人物与事件均来自记录中的具体物。',
};

function json(res, body) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    // mock 也要带 CORS：浏览器版是纯前端直连，缺这个头 → 前端只能看到 TypeError
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

/** mock 的 AI 服务：只实现 /chat/completions（文本），视频接口一律 501 */
function startMockAi() {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0];
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': '*',
        });
        res.end();
        return;
      }
      if (url.endsWith('/chat/completions')) {
        let model = '';
        try {
          model = JSON.parse(Buffer.concat(chunks).toString('utf8')).model ?? '';
        } catch {
          /* ignore */
        }
        chatModels.push(model);
        json(res, {
          id: 'mock',
          object: 'chat.completion',
          model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify(STORY_JSON) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        });
        return;
      }
      res.writeHead(501, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
      });
      res.end(JSON.stringify({ error: { message: 'mock 没有实现这个接口' } }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

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

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === undefined) return;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
      else entry.resolve(msg.result);
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
      throw new Error(
        `页面里执行失败：${result.exceptionDetails.text} ${String(
          result.exceptionDetails.exception?.description ?? '',
        ).slice(0, 300)}`,
      );
    }
    return result.result?.value;
  }

  async waitFor(expression, timeoutMs = 15000, intervalMs = 120) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.eval(expression)) return true;
      } catch {
        /* 页面还在换文档 */
      }
      await delay(intervalMs);
    }
    return false;
  }

  async screenshot(name) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    mkdirSync(SHOTS, { recursive: true });
    const path = join(SHOTS, `${name}.png`);
    writeFileSync(path, Buffer.from(shot.data, 'base64'));
    return path;
  }
}

function findEdge() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    process.env.CHROME_PATH,
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error('找不到 Edge/Chrome。用 EDGE_PATH=/path/to/msedge.exe 指定。');
}

async function launchBrowser() {
  const exe = findEdge();
  const profile = mkdtempSync(join(tmpdir(), 'ia-m5b4-'));
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
      '--window-size=1440,960',
      'about:blank',
    ],
    { stdio: 'ignore' },
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
  if (!port) throw new Error('Edge 没起来（拿不到 DevToolsActivePort）');

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
  if (!target) throw new Error('Edge 起来了但没有 page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', () => j(new Error('连不上页面 WebSocket')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return { child, profile, cdp, ws };
}

/** 往 IndexedDB 里灌：AI 配置（指向 mock）+ 一个图片产物 + 一个视频素材 + 一个工作流 */
function injectScript(aiBase, workflow) {
  const catalog = {
    providers: [
      {
        id: 'zhipu',
        name: '智谱（本地 mock）',
        builtin: true,
        activeConnectionId: 'conn-mock',
        connections: [
          {
            id: 'conn-mock',
            label: '本地 mock',
            baseUrl: `${aiBase}/api/paas/v4`,
            apiKey: 'mock-key',
            models: [
              {
                id: 'm-text-1',
                displayName: 'glm-4.7-flash（免费）',
                modelId: 'glm-4.7-flash',
                caps: ['text'],
              },
              {
                id: 'm-text-2',
                displayName: 'deepseek-flash（第二选择）',
                modelId: 'deepseek-flash',
                caps: ['text'],
              },
              {
                id: 'm-video-1',
                displayName: 'cogvideox-flash（免费视频）',
                modelId: 'cogvideox-flash',
                caps: ['video'],
              },
            ],
          },
        ],
      },
    ],
    updatedAt: Date.now(),
  };

  return `(async () => {
  const open = (name) => new Promise((res, rej) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const put = (db, store, value) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });

  const now = Date.now();
  const main = await open('inspiration-assistant');
  await put(main, 'settings', { key: 'ai-catalog', value: ${JSON.stringify(catalog)}, updatedAt: now });
  await put(main, 'media', {
    id: 'image-blob:demo1',
    recordId: 'artifact:image:demo1',
    blob: new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }),
    mimeType: 'image/png',
    durationMs: 0,
    createdAt: now,
  });
  await put(main, 'artifacts', {
    id: 'image:demo1',
    recordId: 'workflow:wf-m5b4-demo',
    kind: 'image',
    payload: {
      prompt: '一片没有边的冰海（示例产物）',
      blobId: 'image-blob:demo1',
      mimeType: 'image/png',
      size: 8,
      remoteUrl: 'https://example.com/demo.png',
    },
    modelId: 'cogview-3-flash',
    cost: 0,
    createdAt: now,
  });
  await put(main, 'media', {
    id: 'workflow-source:demo-video',
    recordId: 'workflow-source:demo-video',
    blob: new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: 'video/mp4' }),
    mimeType: 'video/mp4',
    durationMs: 0,
    createdAt: now,
  });
  main.close();

  const wf = await open('inspiration-assistant-workflows');
  await put(wf, 'workflows', ${JSON.stringify(workflow)});
  wf.close();

  localStorage.setItem('ia-v2.wf.execMode', 'step');
  return true;
})()`;
}

const WORKFLOW = {
  id: 'wf-m5b4-demo',
  name: 'M5b4 证据（参考视频 / 图片源）',
  createdAt: Date.now(),
  updatedAt: Date.now() + 1000,
  nodes: [
    { id: 'node_s', type: 'source', position: { x: 40, y: 40 }, data: { text: '镜头缓慢推近，冰面发出细碎的裂声' } },
    {
      id: 'node_is',
      type: 'imageSource',
      position: { x: 40, y: 260 },
      data: { sourceArtifactId: 'image:demo1', fileName: '一片没有边的冰海（示例产物）', fileSize: 8 },
    },
    {
      id: 'node_vs',
      type: 'videoSource',
      position: { x: 40, y: 520 },
      data: {
        sourceMediaId: 'workflow-source:demo-video',
        fileName: 'demo.mp4',
        fileSize: 8,
      },
    },
    {
      id: 'node_v',
      type: 'video',
      position: { x: 400, y: 300 },
      data: {
        modelId: 'cogvideox-flash',
        vendorId: 'zhipu',
        promptFromUpstream: true,
        resolution: '480p',
        durationSec: 5,
      },
    },
    { id: 'node_o', type: 'output', position: { x: 740, y: 300 }, data: {} },
  ],
  edges: [
    { id: 'e1', source: 'node_s', target: 'node_v', sourceHandle: 'text', targetHandle: 'prompt' },
    { id: 'e2', source: 'node_vs', target: 'node_v', sourceHandle: 'video', targetHandle: 'referenceVideo' },
    { id: 'e3', source: 'node_v', target: 'node_o', sourceHandle: 'video', targetHandle: 'video' },
  ],
};

/* 页面里的小工具（都用 click()，不依赖鼠标事件：有头/无头 Edge 的合成鼠标都不可靠） */
const CLICK_RUN = `(() => {
  const btn = Array.from(document.querySelectorAll('.wf-toolbar button')).find((b) => (b.textContent || '').trim() === '运行');
  if (!btn) return 'no-run-button';
  btn.click();
  return 'clicked';
})()`;

const CLICK_STEP_CONTINUE = `(() => {
  const btn = document.querySelector('[data-testid="wf-step-continue"]');
  if (!btn) return 'no-step';
  btn.click();
  return 'clicked';
})()`;

const CLICK_COST_CONFIRM = `(() => {
  const dialog = document.querySelector('[aria-label="费用确认"]');
  if (!dialog) return 'no-dialog';
  const btn = Array.from(dialog.querySelectorAll('button')).find((b) => (b.textContent || '').includes('确认并继续'));
  if (!btn) return 'no-confirm-button';
  btn.click();
  return 'clicked';
})()`;

/** 一边跑一边回答：有「每步确认」就继续，有费用确认就确认，直到出现目标或超时 */
async function driveUntil(cdp, isDone, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let steps = 0;
  let confirms = 0;
  while (Date.now() < deadline) {
    if (await isDone().catch(() => false)) return { ok: true, steps, confirms };
    const stepClicked = await cdp.eval(CLICK_STEP_CONTINUE).catch(() => 'error');
    if (stepClicked === 'clicked') {
      steps += 1;
      await delay(150);
      continue;
    }
    const costClicked = await cdp.eval(CLICK_COST_CONFIRM).catch(() => 'error');
    if (costClicked === 'clicked') {
      confirms += 1;
      await delay(150);
      continue;
    }
    await delay(200);
  }
  return { ok: false, steps, confirms };
}

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('没有 dist/index.html：先跑 `npm run build`（证据要来自真实产物）');
  }
  if (typeof WebSocket === 'undefined') throw new Error('需要 Node ≥ 20（内置 WebSocket）');

  const { server: aiServer, port: aiPort } = await startMockAi();
  const aiBase = `http://127.0.0.1:${aiPort}`;
  const { server, port } = await serveDist();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`静态服务：${baseUrl}  ·  mock AI：${aiBase}（零费用）`);

  const { child, profile, cdp, ws } = await launchBrowser();
  const evidence = {};
  let failed = 0;

  try {
    /* 0. 先让应用把库建出来，再灌数据 */
    await cdp.send('Page.navigate', { url: `${baseUrl}/?boot=1#/workflow` });
    if (!(await cdp.waitFor("!!document.querySelector('[data-template]')", 20000))) {
      throw new Error('工作流页没挂载（找不到模板卡）');
    }
    await cdp.eval(injectScript(aiBase, WORKFLOW));
    console.log('已灌入：AI 配置（指向 mock）+ 1 张图片产物 + 1 个视频素材 + 1 个工作流');

    /* 1. 图片源节点：已有产物可选中 */
    await cdp.send('Page.navigate', { url: `${baseUrl}/?run=2#/workflow` });
    if (!(await cdp.waitFor("!!document.querySelector('[data-node-id=\\\"node_is\\\"]')", 20000))) {
      throw new Error('注入的工作流没被自动载入');
    }
    evidence.imageSource = await cdp.eval(`(() => {
      const node = document.querySelector('[data-node-id="node_is"]');
      const select = node.querySelector('[data-testid="wf-source-select"]');
      const meta = node.querySelector('[data-testid="wf-source-meta"]');
      return {
        title: (node.querySelector('.wf-node-title') || {}).textContent,
        options: Array.from(select.options).map((o) => o.textContent),
        selected: select.value,
        meta: meta ? meta.textContent : '',
        hasUpload: !!node.querySelector('[data-testid="wf-source-upload"]'),
      };
    })()`);
    evidence.imageSourceShot = await cdp.screenshot('m5b4-1-image-source');

    /* 2. 参考视频 + 智谱 → 执行时显式拒绝 */
    await cdp.eval(CLICK_RUN);
    const rejectDrive = await driveUntil(cdp, async () =>
      cdp.eval(`(() => {
        const node = document.querySelector('.wf-node[data-node-id="node_v"]');
        if (!node) return false;
        return (node.innerText || '').includes('不支持参考视频');
      })()`),
    );
    evidence.referenceVideo = await cdp.eval(`(() => {
      const node = document.querySelector('.wf-node[data-node-id="node_v"]');
      const error = node.querySelector('.wf-node-error');
      return {
        status: node.getAttribute('data-status'),
        error: error ? error.textContent : '',
        innerText: (node.innerText || '').slice(0, 320),
        runlog: Array.from(document.querySelectorAll('[data-testid="wf-runlog-item"]')).map((b) => b.textContent),
      };
    })()`);
    evidence.referenceVideoShot = await cdp.screenshot('m5b4-2-reference-video-rejected');
    evidence.rejectDrive = rejectDrive;

    /* 3. 每步确认 + 指定模型：换成"灵感 → 扩写 → 输出"模板，pack 节点改选第二个文本模型 */
    await cdp.eval(`(() => {
      const btn = Array.from(document.querySelectorAll('.wf-toolbar button')).find((b) => (b.textContent || '').includes('模板'));
      if (btn) btn.click();
      return !!btn;
    })()`);
    await cdp.waitFor("!!document.querySelector('[data-template=\\\"idea-to-text\\\"]')", 8000);
    await cdp.eval(`(() => {
      const card = document.querySelector('[data-template="idea-to-text"]');
      if (!card) return 'no-card';
      card.click();
      return 'clicked';
    })()`);
    await delay(300);

    evidence.packModel = await cdp.eval(`(() => {
      const select = document.querySelector('[data-testid="wf-pack-model"]');
      if (!select) return { error: '没找到模型下拉' };
      select.value = 'deepseek-flash';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const label = document.querySelector('[data-testid="wf-pack-model-label"]');
      return {
        options: Array.from(select.options).map((o) => o.textContent),
        value: select.value,
        label: label ? label.textContent : '',
      };
    })()`);

    await delay(200);
    const before = chatModels.length;

    /* 「每步确认」：一步一步地走，**暂停那一刻**把面板内容抓下来 */
    const waitStepTitle = (label) =>
      cdp.waitFor(
        `(() => {
          const panel = document.querySelector('[data-testid="wf-step"]');
          if (!panel) return false;
          const title = panel.querySelector('.wf-step-title');
          return !!(title && (title.textContent || '').includes('${label}'));
        })()`,
        20000,
      );
    const readStep = () =>
      cdp.eval(`(() => {
        const panel = document.querySelector('[data-testid="wf-step"]');
        if (!panel) return null;
        return {
          title: panel.querySelector('.wf-step-title')?.textContent ?? '',
          text: (panel.querySelector('[data-testid="wf-step-text"]')?.textContent ?? '').slice(0, 200),
          buttons: Array.from(panel.querySelectorAll('.wf-step-actions button')).map((b) => b.textContent.trim()),
        };
      })()`);

    await cdp.eval(CLICK_RUN);

    const step1Ready = await waitStepTitle('文本源');
    const step1 = step1Ready ? await readStep() : null;
    if (step1Ready) await cdp.eval(CLICK_STEP_CONTINUE);

    const step2Ready = await waitStepTitle('提示词包');
    const step2 = step2Ready ? await readStep() : null;
    evidence.stepShot = await cdp.screenshot('m5b4-3-step-confirm');
    if (step2Ready) await cdp.eval(CLICK_STEP_CONTINUE);

    const step3Ready = await waitStepTitle('输出');
    const step3 = step3Ready ? await readStep() : null;
    if (step3Ready) await cdp.eval(CLICK_STEP_CONTINUE);

    const finished = await cdp.waitFor(
      `(() => {
        const status = document.querySelector('.wf-banner[role="status"]');
        return !!(status && (status.textContent || '').includes('运行完成'));
      })()`,
      30000,
    );

    evidence.stepFlow = {
      step1: step1?.title ?? '(没出现)',
      step2,
      step3: step3?.title ?? '(没出现)',
      finished,
    };
    evidence.runlogAfter = await cdp.eval(
      "Array.from(document.querySelectorAll('[data-testid=\"wf-runlog-item\"]')).map((b) => b.textContent)",
    );
    evidence.runStatus = await cdp.eval(
      "(document.querySelector('.wf-banner[role=\"status\"]') || {}).textContent || ''",
    );
    evidence.nodePreviews = await cdp.eval(
      "Array.from(document.querySelectorAll('[data-testid=\"wf-node-output\"]')).map((n) => (n.textContent || '').slice(0, 60))",
    );
    evidence.packNode = await cdp.eval(`(() => {
      const nodes = Array.from(document.querySelectorAll('.wf-node-pack'));
      return nodes.map((n) => ({
        status: n.getAttribute('data-status'),
        tail: (n.innerText || '').slice(-260),
      }));
    })()`);
    evidence.failAlert = await cdp.eval(
      "(document.querySelector('.wf-banner-error') || {}).textContent || ''",
    );
    evidence.allRequestedModels = [...chatModels];
    evidence.modelsRequested = chatModels.slice(before);

    /* 4. 结论 */
    const checks = [
      ['图片源节点列出已有产物且带文件名/体积', evidence.imageSource.options.length > 1 && evidence.imageSource.meta.includes('示例产物')],
      ['参考视频：智谱显式拒绝（节点红字可读）', evidence.referenceVideo.error.includes('不支持参考视频')],
      ['每步确认：三个节点各停一次、逐个继续到最后', evidence.stepFlow.finished && evidence.stepFlow.step2 !== null],
      ['pack 节点改选模型后请求用的就是它', evidence.modelsRequested.includes('deepseek-flash')],
      ['节点上挂着每一步的结果摘要', evidence.nodePreviews.length > 0],
    ];
    for (const [label, ok] of checks) {
      if (!ok) failed += 1;
      console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`);
    }

    console.log('\n图片源节点：');
    console.log(`  标题=${evidence.imageSource.title}  选中=${evidence.imageSource.selected}`);
    console.log(`  下拉=${JSON.stringify(evidence.imageSource.options)}`);
    console.log(`  文件名/体积=${evidence.imageSource.meta}  上传口=${evidence.imageSource.hasUpload}`);
    console.log('\n参考视频（智谱模型）：');
    console.log(`  节点状态=${evidence.referenceVideo.status}`);
    console.log(`  节点红字=${evidence.referenceVideo.error}`);
    console.log(`  执行日志=${JSON.stringify(evidence.referenceVideo.runlog)}`);
    console.log('\n每步确认：');
    console.log(`  ① ${evidence.stepFlow.step1}`);
    console.log(`  ② ${evidence.stepFlow.step2 ? evidence.stepFlow.step2.title : '(没出现)'}`);
    console.log(`     面板正文=${evidence.stepFlow.step2 ? evidence.stepFlow.step2.text : ''}`);
    console.log(`     三个按钮=${evidence.stepFlow.step2 ? JSON.stringify(evidence.stepFlow.step2.buttons) : ''}`);
    console.log(`  ③ ${evidence.stepFlow.step3}`);
    console.log(`  跑完=${evidence.stepFlow.finished}`);
    console.log(`  结束语=${evidence.runStatus}`);
    console.log(`  执行日志=${JSON.stringify(evidence.runlogAfter)}`);
    console.log(`  节点摘要=${JSON.stringify(evidence.nodePreviews)}`);
    console.log(`  pack 节点下拉=${JSON.stringify(evidence.packModel.options)}`);
    console.log(`  选中后小字=${evidence.packModel.label}`);
    console.log(`  pack 节点=${JSON.stringify(evidence.packNode)}`);
    console.log(`  失败横幅=${evidence.failAlert}`);
    console.log(`  本次请求的模型=${JSON.stringify(evidence.modelsRequested)}`);
    console.log('\n截图：');
    console.log(`  ${evidence.imageSourceShot}`);
    console.log(`  ${evidence.referenceVideoShot}`);
    console.log(`  ${evidence.stepShot}`);
    console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'}：${checks.length - failed}/${checks.length} 条证据成立`);
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
    aiServer.close();
    await delay(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  if (failed > 0) process.exit(1);
}

await main();
