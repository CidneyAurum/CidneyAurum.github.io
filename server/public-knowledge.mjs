/* Public content refresh only. This module has no access to AI keys or chat. */
export const PUBLIC_KNOWLEDGE_URL = "https://cidneyaurum.github.io/data/knowledge.json";
const SITE = "https://cidneyaurum.github.io";
const PAGE_URLS = new Set(["/", "/index.html", "/blog.html", "/says.html", "/photos.html", "/about.html"]);
const COLLECTIONS = ["pages", "articles", "says", "photos", "playlist"];
function record(value) { return value && typeof value === "object" && !Array.isArray(value); }
function field(value, max, optional = false) {
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw Error("Invalid public text");
  return value;
}
function array(value, max) { if (!Array.isArray(value) || value.length > max) throw Error("Invalid public collection"); return value; }
function row(value) { if (!record(value)) throw Error("Invalid public record"); return value; }
function url(value) {
  field(value, 700);
  if (!value.startsWith("/") || /[\u0000-\u0020\\]/.test(value)) throw Error("Invalid public URL");
  const parsed = new URL(value, SITE);
  if (parsed.origin !== SITE || parsed.username || parsed.password || parsed.search) throw Error("Invalid public URL");
  return parsed.pathname + parsed.hash;
}
function unique(items) {
  const ids = new Set();
  for (const item of items) { if (!item.id || ids.has(item.id)) throw Error("Invalid public ID"); ids.add(item.id); }
  return items;
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export function validatePublicKnowledge(value) {
  if (!record(value) || value.version !== 1 || !record(value.site)
      || Object.keys(value).some(key => !["version", "site", ...COLLECTIONS].includes(key))) throw Error("Unsupported public index");
  const result = { version: 1, site: { owner: field(value.site.owner, 120), name: field(value.site.name, 160), description: field(value.site.description, 1200) } };
  result.pages = unique(array(value.pages, 12).map(item => {
    row(item); const path = url(item.url);
    if (!PAGE_URLS.has(path)) throw Error("Nonpublic page");
    return { id: field(item.id, 160), title: field(item.title, 240), url: path, summary: field(item.summary, 2000, true) };
  }));
  result.articles = unique(array(value.articles, 1000).map(item => {
    row(item); const slug = field(item.slug, 160), path = url(item.url);
    const match = /^\/posts\/([^/]+)\.html$/.exec(path);
    if (!slug || /^[._]/.test(slug) || /[/\\?#\u0000-\u0020]/.test(slug) || !match || decodeURIComponent(match[1]) !== slug) throw Error("Nonpublic article");
    return { id: field(item.id, 160), slug, title: field(item.title, 240), date: field(item.date, 40, true),
      tags: array(item.tags || [], 30).map(tag => field(tag, 80)), summary: field(item.summary, 2000, true),
      url: path, text: field(item.text, 60000), sections: unique(array(item.sections || [], 120).map(section => {
        row(section); const id = field(section.id, 80), target = url(section.url);
        if (!/^toc-\d+$/.test(id) || target !== path + "#" + id) throw Error("Invalid article section");
        return { id, title: field(section.title, 240), text: field(section.text, 40000), url: target };
      })) };
  }));
  result.says = unique(array(value.says, 2000).map(item => {
    row(item); if (url(item.url) !== "/says.html") throw Error("Nonpublic thought");
    return { id: field(item.id, 160), text: field(item.text, 12000), time: field(item.time, 80), url: "/says.html" };
  }));
  result.photos = unique(array(value.photos, 3000).map(item => {
    row(item); const src = url(item.src);
    if (url(item.url) !== "/photos.html" || !/^\/assets\/gallery\/.+\.(?:jpe?g|png|webp|gif)$/i.test(src)) throw Error("Nonpublic photo");
    return { id: field(item.id, 160), caption: field(item.caption, 1000), url: "/photos.html", src };
  }));
  result.playlist = unique(array(value.playlist, 2000).map(item => {
    row(item); return { id: field(item.id, 160), name: field(item.name, 240), artist: field(item.artist, 240) };
  }));
  return freeze(result);
}

async function readIndex(response, signal, maxBytes) {
  if (!/\bapplication\/json\b/i.test(response.headers.get("content-type") || "")) throw Error("Not JSON");
  if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw Error("Public index too large"); }
  if (!response.body) throw Error("Missing public index");
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  const abort = () => reader.cancel().catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw Error("Public index timed out");
      const { done, value } = await reader.read();
      if (signal.aborted) throw Error("Public index timed out");
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw Error("Public index too large"); }
      chunks.push(value);
    }
    const data = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

export function createKnowledgeCache({ fallback, fetchImpl = (...args) => fetch(...args), now = Date.now, ttlMs = 60000, timeoutMs = 2500, maxBytes = 524288 } = {}) {
  let current = validatePublicKnowledge(fallback), pending = null, nextCheck = 0, etag = "", remoteValid = false;
  async function refresh() {
    const controller = new AbortController();
    let timer;
    const operation = (async () => {
      const response = await fetchImpl(PUBLIC_KNOWLEDGE_URL, { method: "GET", redirect: "error", credentials: "omit", cache: "no-cache",
        headers: { Accept: "application/json", ...(etag ? { "If-None-Match": etag } : {}) }, signal: controller.signal });
      if (response.status === 304 && remoteValid) return;
      if (response.status !== 200 || response.redirected) { await response.body?.cancel(); throw Error("Public index unavailable"); }
      const candidate = validatePublicKnowledge(await readIndex(response, controller.signal, Math.min(524288, maxBytes)));
      if (controller.signal.aborted) return;
      current = candidate; remoteValid = true;
      const suppliedTag = response.headers.get("etag") || "";
      etag = suppliedTag.length <= 180 && !/[\r\n]/.test(suppliedTag) ? suppliedTag : "";
    })();
    try {
      await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(Error("Public index timed out")); }, Math.max(1, Math.min(2500, timeoutMs)));
      })]);
    } catch { /* Last valid public snapshot, or the bundled public-only index. */ }
    finally { clearTimeout(timer); controller.abort(); nextCheck = now() + Math.max(1, Math.min(60000, ttlMs)); }
    return current;
  }
  return {
    async get() {
      if (now() < nextCheck) return current;
      if (!pending) pending = refresh().finally(() => { pending = null; });
      return pending;
    },
  };
}
