const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function harness(network, options = {}) {
  const listeners = {};
  const cached = new Map();
  const removed = [];
  const calls = [];
  const storage = {
    async match(request) { return cached.get(request.url)?.clone(); },
    async put(request, response) {
      if (options.quotaError) throw Error("Quota exceeded");
      cached.set(request.url, response.clone());
    },
    async keys() { return Array.from(cached.keys(), (url) => new Request(url)); },
    async delete(request) { return cached.delete(request.url); }
  };
  const context = {
    self: {
      location: { origin: "https://blog.example" },
      addEventListener(type, listener) { listeners[type] = listener; },
      async skipWaiting() {},
      clients: { async claim() {} }
    },
    caches: {
      async keys() { return ["unrelated-app", "site-runtime-v2", "cidney-site-v1", "cidney-site-v4"]; },
      async delete(name) { removed.push(name); },
      async open() { return storage; }
    },
    fetch: async (request) => { calls.push(request.url); return network(request); },
    Request, Response, URL, Promise
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8"), context);
  return {
    cached, removed, calls,
    async activate() {
      let completion;
      listeners.activate({ waitUntil(task) { completion = task; } });
      await completion;
    },
    async request(name, init = {}) {
      const request = new Request(`https://blog.example${name}`, init);
      const tasks = [];
      let result;
      listeners.fetch({ request, waitUntil(task) { tasks.push(task); }, respondWith(task) { result = task; } });
      const response = result ? await result : undefined;
      await Promise.all(tasks);
      return response;
    }
  };
}

test("activation deletes only caches owned by this site", async () => {
  const site = harness(() => new Response("ok"));
  await site.activate();
  assert.deepEqual(site.removed.sort(), ["cidney-site-v1", "site-runtime-v2"]);
});

test("JSON indexes refresh before returning cached content", async () => {
  const site = harness(() => new Response('{"posts":["new"]}'));
  site.cached.set("https://blog.example/posts/posts.json", new Response('{"posts":[]}'));
  const response = await site.request("/posts/posts.json");
  assert.equal(await response.text(), '{"posts":["new"]}');
  assert.equal(await site.cached.get("https://blog.example/posts/posts.json").text(), '{"posts":["new"]}');
});

test("offline HTML returns its saved page and uncached HTML explains offline status", async () => {
  const site = harness(() => { throw Error("Offline"); });
  site.cached.set("https://blog.example/blog.html", new Response("saved page"));
  assert.equal(await (await site.request("/blog.html")).text(), "saved page");
  const missing = await site.request("/posts/new.html");
  assert.equal(missing.status, 503);
  assert.match(await missing.text(), /暂时无法连接/);
});

test("failed HTTP responses cannot replace a good page in cache", async () => {
  const site = harness(() => new Response("missing", { status: 404 }));
  site.cached.set("https://blog.example/blog.html", new Response("saved page"));
  assert.equal((await site.request("/blog.html")).status, 404);
  assert.equal(await site.cached.get("https://blog.example/blog.html").text(), "saved page");
});

test("cached CSS returns immediately and revalidates within event lifetime", async () => {
  const site = harness(() => new Response("new css"));
  site.cached.set("https://blog.example/css/style.css", new Response("old css"));
  assert.equal(await (await site.request("/css/style.css")).text(), "old css");
  assert.equal(await site.cached.get("https://blog.example/css/style.css").text(), "new css");
});

test("cache quota failure preserves successful network content", async () => {
  const site = harness(() => new Response("online"), { quotaError: true });
  assert.equal(await (await site.request("/index.html")).text(), "online");
});

test("writing tools, media, no-store and partial requests bypass runtime caching", async () => {
  const site = harness(() => { throw Error("Should not intercept"); });
  for (const name of ["/admin.html", "/sw.js", "/assets/live2d/miku/model.json", "/audio/song.mp3"]) {
    assert.equal(await site.request(name), undefined);
  }
  assert.equal(await site.request("/index.html", { cache: "no-store" }), undefined);
  assert.equal(await site.request("/assets/photo.jpg", { headers: { Range: "bytes=0-9" } }), undefined);
  assert.equal(site.calls.length, 0);
});
