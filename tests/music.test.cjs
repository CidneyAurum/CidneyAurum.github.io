const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "music.js"), "utf8");
const songs = [0, 1, 2].map((id) => ({ id: String(id + 1), name: `Track ${id + 1}`, artist: "Artist", pic: "cover.jpg" }));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };

function harness(t, options = {}) {
  const timers = new Set(), events = [], nodes = new Map(), storage = new Map(Object.entries(options.storage || {}));
  const audios = [], requests = [];
  const node = () => ({ textContent: "", classList: { add() {}, remove() {}, toggle() {} } });
  class Audio {
    constructor() { this.events = new Map(); this.paused = true; this.currentTime = 0; this.duration = 120; this.readyState = 0; this.volume = 1; this.playCalls = []; audios.push(this); }
    addEventListener(type, fn, config) { const set = this.events.get(type) || new Set(); set.add({ fn, once: config?.once }); this.events.set(type, set); }
    removeEventListener(type, fn) { for (const record of this.events.get(type) || []) if (record.fn === fn) this.events.get(type).delete(record); }
    dispatch(type) { for (const record of [...(this.events.get(type) || [])]) { record.fn(); if (record.once) this.events.get(type).delete(record); } }
    set src(value) { this._src = value; this.currentTime = 0; this.readyState = 0; }
    get src() { return this._src || ""; }
    removeAttribute() {}
    play() {
      this.playCalls.push(this.src);
      const outcome = options.play ? options.play(this, this.playCalls.length) : Promise.resolve();
      return Promise.resolve(outcome).then(() => { this.paused = false; this.dispatch("play"); });
    }
    pause() { const changed = !this.paused; this.paused = true; if (changed) this.dispatch("pause"); }
  }
  const document = {
    body: { appendChild(el) { nodes.set(el.id, el); }, dataset: {}, classList: { toggle() {} } },
    getElementById(id) { return nodes.get(id) || null; }, createElement: node,
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, dispatchEvent(event) { events.push(event.detail); },
  };
  const context = {
    Audio, document, navigator: {}, window: {}, URLSearchParams, AbortController,
    CustomEvent: class { constructor(type, detail) { this.type = type; this.detail = detail.detail; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout(fn, delay) { const timer = setTimeout(fn, options.fastTimeout && delay === 10000 ? 15 : delay); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    fetch: async (url, config) => {
      requests.push(String(url));
      if (options.fetch) { const answer = await options.fetch(String(url), config); if (answer) return answer; }
      if (String(url).includes("playlist.json")) return new Response(JSON.stringify({ playlist: songs }));
      return new Response(String(url).includes("lrclib") ? "[]" : "");
    },
  };
  vm.runInNewContext(source, context);
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  return { music: context.window.MikuMusic, context, audios, requests, storage, events };
}

test("a newer song owns playback when an older play promise rejects", async (t) => {
  const first = deferred();
  const site = harness(t, { play: (_, n) => n === 1 ? first.promise : Promise.resolve() });
  await site.music.loadPlaylist();
  const old = site.music.playIndex(0);
  await flush();
  assert.equal(await site.music.playIndex(1), true);
  first.reject(new Error("old request aborted"));
  assert.equal(await old, false, "callers must not continue a canceled listening action");
  assert.equal(site.music.getState().index, 1);
  assert.equal(site.music.getState().playing, true);
  assert.equal(site.audios[0].playCalls.length, 2, "canceled song must not try another URL");
  assert.match(site.audios[0].src, /id=2$/);
});

test("pause cancels pending playback without trying another candidate", async (t) => {
  const pending = deferred();
  const site = harness(t, { play: () => pending.promise });
  await site.music.loadPlaylist();
  const start = site.music.playIndex(0);
  await flush();
  await site.music.toggle();
  pending.reject(new Error("canceled"));
  assert.equal(await start, false);
  assert.equal(site.music.getState().playing, false);
  assert.equal(site.audios[0].playCalls.length, 1);
});

test("failed resume resolves safely and does not advertise playback", async (t) => {
  let rejectResume = false;
  const site = harness(t, { play: () => rejectResume ? Promise.reject(new Error("unavailable")) : Promise.resolve() });
  await site.music.loadPlaylist();
  await site.music.playIndex(0);
  site.music.stop();
  rejectResume = true;
  assert.equal(await site.music.toggle(), false);
  assert.equal(site.music.getState().playing, false);
  assert.equal(site.context.window.__kbSinging, false);
});

test("unplayable automatic queue stops after a bounded number of songs", async (t) => {
  const site = harness(t, { play: () => Promise.reject(new Error("bad audio")) });
  await site.music.loadPlaylist();
  site.music.next(true);
  await flush();
  assert.equal(site.music.getState().playing, false);
  assert.equal(site.audios[0].playCalls.length, 15, "3 songs × 5 candidate URLs, without an infinite cycle");
});

test("a stalled audio candidate times out and permits fallback", async (t) => {
  const site = harness(t, { fastTimeout: true, play: (_, n) => n === 1 ? new Promise(() => {}) : Promise.resolve() });
  await site.music.loadPlaylist();
  await site.music.playIndex(0);
  assert.equal(site.music.getState().playing, true);
  assert.equal(site.audios[0].playCalls.length, 2);
});

test("late lyrics for a previous selection cannot replace current lyrics", async (t) => {
  const oldLyrics = deferred();
  const site = harness(t, { fetch: (url) => {
    if (url.includes("track_name=Track+1")) return oldLyrics.promise;
    if (url.includes("track_name=Track+2")) return new Response(JSON.stringify([{ syncedLyrics: "[00:01]Current lyrics" }]));
  } });
  await site.music.loadPlaylist();
  await site.music.playIndex(0);
  await site.music.playIndex(1);
  await flush();
  oldLyrics.resolve(new Response(JSON.stringify([{ syncedLyrics: "[00:01]Stale lyrics" }])));
  await flush();
  assert.equal(site.music.getState().lrc[0].text, "Current lyrics");
});

test("old restore seek cannot move a subsequently selected song", async (t) => {
  const site = harness(t, { storage: { mm_state: JSON.stringify({ queue: songs, qi: 0, time: 89 }) } });
  site.music.restore();
  await site.music.playIndex(1);
  site.audios[0].dispatch("loadedmetadata");
  assert.equal(site.audios[0].currentTime, 0);
  assert.equal(site.music.getState().index, 1);
});

test("saved play mode, repeat and finite volume stay consistent", async (t) => {
  const site = harness(t, { storage: { mm_mode: "one" } });
  assert.equal(site.music.getState().mode, "one");
  await site.music.loadPlaylist();
  await site.music.playIndex(0);
  site.audios[0].currentTime = 120;
  site.audios[0].dispatch("ended");
  await flush();
  assert.equal(site.music.getState().index, 0);
  assert.equal(site.music.getState().playing, true);
  assert.equal(site.audios[0].currentTime, 0);
  site.music.setVolume(NaN);
  assert.equal(site.music.getState().volume, .9);
  site.music.setVolume(5);
  assert.equal(site.music.getState().volume, 1);
  site.music.setVolume(-2);
  assert.equal(site.music.getState().volume, 0);
});

test("simultaneous playlist consumers share one snapshot request", async (t) => {
  const site = harness(t);
  await Promise.all([site.music.loadPlaylist(), site.music.loadPlaylist(), site.music.loadPlaylist()]);
  assert.equal(site.requests.filter(url => url.includes("playlist.json")).length, 1);
});
