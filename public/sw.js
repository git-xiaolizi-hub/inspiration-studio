/*
 * 离线外壳（M2）。手写、无依赖。
 *
 * 关键教训：只在 install 里缓存 '/' 与 'index.html' 不够 ——
 * 首访时 SW 还没接管页面，带 hash 的 JS/CSS 是在 SW 激活之前加载的，
 * 于是"断网刷新"能拿到 HTML 却拿不到 JS，页面白屏。
 * 因此 install 阶段要**解析 index.html，把里面引用的脚本/样式一并预缓存**。
 *
 * 之后走「网络优先、失败回缓存」：发版后能拿到新资源（hash 变了就是新 URL），
 * 断网时回落到上一次成功缓存的副本。
 */
const CACHE_NAME = 'ia-v2-shell-v3';

/** 解析 index.html 里的本地资源（script/link），返回绝对路径列表 */
function collectAssetUrls(html) {
  const urls = new Set();
  const pattern = /(?:src|href)="([^"]+)"/g;
  let match = pattern.exec(html);
  while (match) {
    const url = match[1];
    if (url && !/^(https?:|data:|#|mailto:)/i.test(url) && !url.endsWith('sw.js')) {
      urls.add(url);
    }
    match = pattern.exec(html);
  }
  return [...urls];
}

async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  const response = await fetch('./index.html', { cache: 'no-cache' });
  if (!response.ok) throw new Error('index.html 不可用');

  const html = await response.clone().text();
  await cache.put('./index.html', response.clone());
  await cache.put('./', response);

  const assets = collectAssetUrls(html);
  if (assets.length > 0) {
    // addAll 里任何一个失败会整体失败，所以逐个加、单个失败不影响其余
    await Promise.all(
      assets.map((url) =>
        cache.add(url).catch(() => {
          /* 单个资源失败不影响其它资源；下次在线请求时会被补上 */
        }),
      ),
    );
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    precacheShell()
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response && response.ok) await cache.put(request, response.clone());
        return response;
      } catch (error) {
        // 先按 Request 匹配，再退回按 URL 字符串、忽略 Vary：
        // 静态服务器常给资源加 `Vary: Origin`，而 SW 里的请求与当初缓存时的请求头不同，
        // 严格按 Vary 比对会"明明在缓存里却匹配不到"（实测就是这么白屏的）。
        const cached =
          (await cache.match(request, { ignoreSearch: true, ignoreVary: true })) ||
          (await caches.match(request.url, { ignoreSearch: true, ignoreVary: true }));
        if (cached) return cached;

        // 刷新页面（导航请求）时兜底返回应用外壳，避免浏览器错误页
        if (request.mode === 'navigate') {
          const shell = (await cache.match('./index.html')) || (await cache.match('./'));
          if (shell) return shell;
        }
        return new Response('当前离线，且这个文件没有缓存。', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })(),
  );
});
