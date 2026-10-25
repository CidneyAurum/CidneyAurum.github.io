import { test } from "node:test";
import assert from "node:assert/strict";
import { createKnowledgeCache, validatePublicKnowledge, PUBLIC_KNOWLEDGE_URL } from "../server/public-knowledge.mjs";

const bundled = {
  version: 1, site: { owner: "Fixture owner", name: "Fixture site", description: "Public index" },
  pages: [{ id: "home", title: "Home", url: "/", summary: "Public homepage" }],
  articles: [{ id: "hello", slug: "hello", title: "Bundled article", url: "/posts/hello.html", text: "Original public text", sections: [{ id: "toc-1", title: "Opening", text: "Original section", url: "/posts/hello.html#toc-1" }] }],
  says: [{ id: "thought", text: "Public thought", time: "2026-10-25", url: "/says.html" }],
  photos: [{ id: "photo", caption: "Public photo", url: "/photos.html", src: "/assets/gallery/photo.webp" }],
  playlist: [{ id: "123", name: "Public song", artist: "Public artist" }],
};
function updated(title = "Newly published article") {
  const data = structuredClone(bundled); data.articles[0].title = title; return data;
}

test("first Pages 404 uses the bundled index without blocking the visitor", async () => {
  let count = 0;
  const cache = createKnowledgeCache({ fallback: bundled, fetchImpl: async () => { count++; return new Response("not deployed", { status: 404 }); } });
  assert.equal((await cache.get()).articles[0].title, "Bundled article");
  await cache.get();
  assert.equal(count, 1, "failed refreshes are also held for a short TTL");
});

test("new public article content replaces bundled content and refreshes after TTL", async () => {
  let now = 0, count = 0;
  const cache = createKnowledgeCache({ fallback: bundled, now: () => now, ttlMs: 100,
    fetchImpl: async () => { count++; return Response.json(updated("Published revision " + count)); } });
  assert.equal((await cache.get()).articles[0].title, "Published revision 1");
  now = 99;
  assert.equal((await cache.get()).articles[0].title, "Published revision 1");
  assert.equal(count, 1);
  now = 101;
  assert.equal((await cache.get()).articles[0].title, "Published revision 2");
  assert.equal(count, 2);
});

test("concurrent visitors share exactly one public-index request", async () => {
  let count = 0, complete;
  const cache = createKnowledgeCache({ fallback: bundled, fetchImpl: () => { count++; return new Promise(resolve => { complete = resolve; }); } });
  const visitors = Array.from({ length: 12 }, () => cache.get());
  assert.equal(count, 1);
  complete(Response.json(updated()));
  const results = await Promise.all(visitors);
  assert.equal(results.every(result => result.articles[0].title === "Newly published article"), true);
  assert.equal(count, 1);
});

test("a failed later refresh preserves the last valid remote index", async () => {
  let now = 0, count = 0;
  const cache = createKnowledgeCache({ fallback: bundled, ttlMs: 10, now: () => now,
    fetchImpl: async () => ++count === 1 ? Response.json(updated()) : new Response("unavailable", { status: 500 }) });
  await cache.get(); now = 11;
  assert.equal((await cache.get()).articles[0].title, "Newly published article");
});

test("ETag revalidation keeps valid content on 304", async () => {
  let now = 0, count = 0;
  const cache = createKnowledgeCache({ fallback: bundled, ttlMs: 10, now: () => now, fetchImpl: async (_url, init) => {
    if (++count === 1) return Response.json(updated(), { headers: { ETag: '"published-v1"' } });
    assert.equal(init.headers["If-None-Match"], '"published-v1"');
    return new Response(null, { status: 304 });
  } });
  await cache.get(); now = 11;
  assert.equal((await cache.get()).articles[0].title, "Newly published article");
});

test("the fetch URL and headers cannot carry a chat message or credential", async () => {
  const calls = [];
  const cache = createKnowledgeCache({ fallback: bundled, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(updated()); } });
  await cache.get({ message: "PRIVATE-DRAFT-CANARY", apiKey: "PRIVATE-KEY-CANARY", url: "https://hostile.example" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PUBLIC_KNOWLEDGE_URL);
  assert.deepEqual(calls[0].init.headers, { Accept: "application/json" });
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(JSON.stringify(calls).includes("PRIVATE-"), false);
});

test("stalled fetch is aborted and late content cannot poison a newer cache", async () => {
  let finish, aborted = false;
  const cache = createKnowledgeCache({ fallback: bundled, timeoutMs: 15, fetchImpl: (_url, { signal }) => {
    signal.addEventListener("abort", () => { aborted = true; });
    return new Promise(resolve => { finish = resolve; });
  } });
  assert.equal((await cache.get()).articles[0].title, "Bundled article");
  assert.equal(aborted, true);
  finish(Response.json(updated("Late stale data")));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await cache.get()).articles[0].title, "Bundled article");
});

test("streamed response timeout and size limits keep the valid fallback", async () => {
  let canceled = false;
  const stalled = createKnowledgeCache({ fallback: bundled, timeoutMs: 15, fetchImpl: async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "Content-Type": "application/json" } }) });
  assert.equal((await stalled.get()).articles[0].title, "Bundled article");
  assert.equal(canceled, true);
  const oversized = createKnowledgeCache({ fallback: bundled, maxBytes: 100, fetchImpl: async () => Response.json(updated()) });
  assert.equal((await oversized.get()).articles[0].title, "Bundled article");
});

test("malformed, credential-bearing and private/foreign URL indexes are rejected", async () => {
  const malicious = [];
  const wrongVersion = updated(); wrongVersion.version = 99; malicious.push(wrongVersion);
  const wrongRows = updated(); wrongRows.articles = {}; malicious.push(wrongRows);
  const embeddedCredential = updated(); embeddedCredential.secrets = { key: "KEY-CANARY" }; malicious.push(embeddedCredential);
  const external = updated(); external.articles[0].url = "https://hostile.example/steal"; malicious.push(external);
  const admin = updated(); admin.pages[0].url = "/admin.html"; malicious.push(admin);
  const privateArticle = updated(); privateArticle.articles[0].slug = "_secret"; privateArticle.articles[0].url = "/posts/_secret.html"; malicious.push(privateArticle);
  const foreignSection = updated(); foreignSection.articles[0].sections[0].url = "/about.html"; malicious.push(foreignSection);
  const sourceFile = updated(); sourceFile.photos[0].src = "/server/private.key"; malicious.push(sourceFile);
  const duplicate = updated(); duplicate.articles.push(structuredClone(duplicate.articles[0])); malicious.push(duplicate);
  for (const input of malicious) {
    assert.throws(() => validatePublicKnowledge(input));
    const cache = createKnowledgeCache({ fallback: bundled, fetchImpl: async () => Response.json(input) });
    assert.equal((await cache.get()).articles[0].title, "Bundled article");
  }
});

test("HTML/redirect responses are not accepted as a public index", async () => {
  for (const response of [new Response("<html>failure</html>", { headers: { "Content-Type": "text/html" } }), new Response(null, { status: 302, headers: { Location: "https://hostile.example" } })]) {
    const cache = createKnowledgeCache({ fallback: bundled, fetchImpl: async () => response });
    assert.equal((await cache.get()).articles[0].title, "Bundled article");
  }
});
