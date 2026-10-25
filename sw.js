/* Cache only public site resources; content indexes always refresh online. */
const CACHE_PREFIX = "cidney-site-";
const CACHE = `${CACHE_PREFIX}v4`;
const MAX_ENTRIES = 120;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key !== CACHE && (key.startsWith(CACHE_PREFIX) || /^site-runtime-v[123]$/.test(key)))
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function storeResponse(request, response) {
  if (response.status !== 200 || response.redirected ||
      !["basic", "default"].includes(response.type) ||
      /(?:no-store|private)/i.test(response.headers.get("cache-control") || "") ||
      Number(response.headers.get("content-length") || 0) > 4 * 1024 * 1024) return;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response);
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES)).map((key) => cache.delete(key)));
  } catch (_) {
    // Cache errors must never turn a successful network request into an error.
  }
}

function offlineNavigation() {
  return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>暂时离线</title><body><h1>暂时无法连接</h1><p>这页还没有离线副本。联网后刷新即可继续阅读。</p><p><a href="/index.html">返回首页</a></p></body></html>', {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin ||
      request.cache === "no-store" || request.headers.has("range") ||
      /\/(?:admin\.html|sw\.js)$/.test(url.pathname) ||
      url.pathname.includes("/assets/live2d/") ||
      /\.(?:mp3|m4a|ogg|wav|flac|mp4|webm)$/i.test(url.pathname)) return;

  const isHTML = request.mode === "navigate" || (request.headers.get("accept") || "").includes("text/html") ||
    /\.html$/i.test(url.pathname) || url.pathname.endsWith("/");
  const freshContent = isHTML || /\.(?:json|xml|webmanifest)$/.test(url.pathname);
  const staticAsset = /\.(?:css|js|png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(url.pathname);
  if (!freshContent && !staticAsset) return;

  // Keep revalidation/cache writes alive after a cached asset is returned.
  const network = fetch(request).then((response) => ({ response, copy: response.clone() }));
  event.waitUntil(network.then(({ copy }) => storeResponse(request, copy)).catch(() => {}));
  event.respondWith((async () => {
    let cached;
    try {
      cached = await (await caches.open(CACHE)).match(request);
    } catch (_) { /* Browsing still works when storage is disabled. */ }
    if (!freshContent && cached) return cached;
    try {
      const { response } = await network;
      if (response.status >= 500 && cached) return cached;
      return response;
    } catch (_) {
      return cached || (isHTML ? offlineNavigation() : Response.error());
    }
  })());
});
