const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "music.js"), "utf8");
const songs = [0, 1, 2].map((id) => ({ id: String(id + 1), name: `Track ${id + 1}`, artist: "Artist", pic: "cover.jpg" }));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
const lyrics = (name, content, artist = "Artist", duration = 120) => new Response(JSON.stringify({ trackName: name, artistName: artist, duration, syncedLyrics: content }));

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
    setTimeout(fn, delay) { const timer = setTimeout(fn, options.fastLyrics && delay === 20000 ? 20 : options.fastTimeout && delay === 10000 ? 15 : delay); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    fetch: async (url, config) => {
      requests.push(String(url));
      if (options.fetch) { const answer = await options.fetch(String(url), config); if (answer) return answer; }
      if (String(url).includes("playlist.json")) return new Response(JSON.stringify({ playlist: options.playlist || songs }));
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
    if (url.includes("track_name=Track+2")) return new Response(JSON.stringify([{ trackName: "Track 2", artistName: "Artist", duration: 120, syncedLyrics: "[00:01]Current lyrics" }]));
  } });
  await site.music.loadPlaylist();
  await site.music.playIndex(0);
  await site.music.playIndex(1);
  await flush();
  oldLyrics.resolve(new Response(JSON.stringify([{ trackName: "Track 1", artistName: "Artist", duration: 120, syncedLyrics: "[00:01]Stale lyrics" }])));
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

test("lyrics expose real idle/loading/ready states and seek notifications", async t => {
  const pending = deferred();
  const site = harness(t, { fetch: url => url.includes("lrclib") ? pending.promise : undefined });
  assert.equal(site.music.getState().lrcStatus, "idle");
  await site.music.loadPlaylist();
  await site.music.playIndex(0);
  assert.equal(site.music.getState().lrcStatus, "loading");
  assert.equal(site.music.getState().lrc.length, 0);
  pending.resolve(lyrics("Track 1", "[ar:Metadata is not a lyric]\n[00:05]First cue\n[00:20]Second cue\n[00:25]"));
  await flush();
  assert.equal(site.music.getState().lrcStatus, "ready");
  assert.equal(site.music.getState().lrc.length, 3);
  assert.equal(site.music.getState().lrcLine, -1);
  const observed = [];
  const unsubscribe = site.music.on(state => observed.push({ time: state.time, line: state.lrcLine }));
  site.music.seek(.2);
  assert.deepEqual(observed.at(-1), { time: 24, line: 1 });
  site.music.seek(0);
  assert.deepEqual(observed.at(-1), { time: 0, line: -1 });
  site.audios[0].currentTime = 26;
  site.audios[0].dispatch("seeked");
  assert.deepEqual(observed.at(-1), { time: 26, line: 2 });
  assert.equal(site.music.getState().lrc[2].text, "", "a timed interlude clears the old line");
  unsubscribe(); const count = observed.length;
  site.music.seek(.1);
  assert.equal(observed.length, count);
  site.music.stop();
  assert.equal(site.music.getState().lrcStatus, "ready", "pausing keeps verified current lyrics");
});

test("unavailable lyrics only retry after an explicit retry action", async t => {
  let available = false;
  const site = harness(t, { fetch: url => url.includes("lrclib") && available ? lyrics("Track 1", "[00:01]Recovered") : undefined });
  assert.equal(await site.music.retryLyrics(), false);
  await site.music.loadPlaylist(); await site.music.playIndex(0); await flush();
  assert.equal(site.music.getState().lrcStatus, "unavailable");
  const calls = site.requests.length;
  site.music.stop(); await site.music.toggle(); await flush();
  assert.equal(site.requests.length, calls, "pause/resume does not repeatedly poll unavailable lyrics");
  available = true;
  assert.equal(await site.music.retryLyrics(), true);
  assert.equal(site.music.getState().lrcStatus, "ready");
  assert.equal(site.music.getState().lrc[0].text, "Recovered");
});

test("canceling an in-flight lyric load clears loading and ignores its late result", async t => {
  const pending = deferred();
  const site = harness(t, { fetch: url => url.includes("lrclib") ? pending.promise : undefined });
  await site.music.loadPlaylist(); await site.music.playIndex(0);
  site.music.stop();
  assert.equal(site.music.getState().lrcStatus, "idle");
  pending.resolve(lyrics("Track 1", "[00:01]Canceled line")); await flush();
  assert.equal(site.music.getState().lrcStatus, "idle");
  assert.equal(site.music.getState().lrc.length, 0);
});

test("late results from an earlier explicit retry cannot overwrite the latest retry", async t => {
  const oldRetry = deferred(); let requests = 0;
  const site = harness(t, { fetch: url => {
    if (!url.includes("lrclib")) return;
    requests++;
    if (requests === 2) return oldRetry.promise;
    return lyrics("Track 1", requests === 1 ? "[00:01]Initial" : "[00:01]Latest retry");
  } });
  await site.music.loadPlaylist(); await site.music.playIndex(0); await flush();
  const first = site.music.retryLyrics();
  await flush();
  assert.equal(await site.music.retryLyrics(), true);
  oldRetry.resolve(lyrics("Track 1", "[00:01]Stale retry"));
  assert.equal(await first, false);
  assert.equal(site.music.getState().lrcStatus, "ready");
  assert.equal(site.music.getState().lrc[0].text, "Latest retry");
});

test("reselecting or failing a new song cannot retain the previous lyrics", async t => {
  let fail = false;
  const site = harness(t, { play: () => fail ? Promise.reject(Error("bad stream")) : Promise.resolve(),
    fetch: url => url.includes("lrclib") ? lyrics("Track 1", "[00:01]Old song line") : undefined });
  await site.music.loadPlaylist(); await site.music.playIndex(0); await flush();
  assert.equal(site.music.getState().lrcStatus, "ready");
  fail = true;
  await assert.rejects(site.music.playIndex(1));
  assert.equal(site.music.getState().index, 1);
  assert.equal(site.music.getState().lrcStatus, "unavailable");
  assert.equal(site.music.getState().lrc.length, 0);
});

test("restore loads the selected song's lyrics and reports its actual metadata seek", async t => {
  const site = harness(t, { storage: { mm_state: JSON.stringify({ queue: songs, qi: 0, time: 37 }) },
    fetch: url => url.includes("lrclib") ? lyrics("Track 1", "[00:05]Before\n[00:30]After") : undefined });
  site.music.restore();
  assert.equal(site.music.getState().lrcStatus, "loading"); await flush();
  site.audios[0].dispatch("loadedmetadata");
  assert.equal(site.music.getState().playing, false);
  assert.equal(site.music.getState().lrcStatus, "ready");
  assert.equal(site.music.getState().time, 37);
  assert.equal(site.events.at(-1).time, 37);
  assert.equal(site.events.at(-1).lrcLine, 1);
});

test("exact-signature lyrics take priority over a broad search", async t => {
  const site = harness(t, { fetch: url => url.includes("lrclib.net/api/get?") ? lyrics("Track 1", "[00:01]Exact match") : undefined });
  await site.music.loadPlaylist(); await site.music.playIndex(0); await flush();
  assert.equal(site.music.getState().lrcStatus, "ready");
  assert.equal(site.requests.some(url => url.includes("/api/get?") && url.includes("duration=120")), true);
  assert.equal(site.requests.some(url => url.includes("/api/search?")), false);
});

test("search rejects the wrong first result, wrong singer and mismatched full duration", async t => {
  const site = harness(t, { fetch: url => {
    if (url.includes("lrclib.net/api/get?")) return new Response("missing", { status: 404 });
    if (url.includes("lrclib.net/api/search?")) return new Response(JSON.stringify([
      { trackName: "Track 1 (Live)", artistName: "Artist", duration: 120, syncedLyrics: "[00:01]Wrong version" },
      { trackName: "Track 1", artistName: "Another artist", duration: 120, syncedLyrics: "[00:01]Wrong singer" },
      { trackName: "Track 1", artistName: "Artist", duration: 240, syncedLyrics: "[00:01]Wrong full duration" },
      { trackName: "Track 1", artistName: "Artist", duration: 120, syncedLyrics: "[00:01]Correct match" },
    ]));
  } });
  await site.music.loadPlaylist(); await site.music.playIndex(0); await flush();
  assert.equal(site.music.getState().lrc[0].text, "Correct match");
});

test("the actual playlist's first three Vocaloid metadata formats can match", async t => {
  const actual = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "playlist.json"), "utf8")).playlist.slice(0, 3);
  const recordArtists = ["n-buna feat. Hatsune Miku", "須田景凪", "洛天依 / ilem"];
  for (let i = 0; i < actual.length; i++) {
    const item = actual[i];
    const site = harness(t, { playlist: [item], play: audio => { audio.duration = i === 2 ? 30 : 120; return Promise.resolve(); },
      fetch: url => url.includes("lrclib") ? lyrics(item.name + (i === 0 ? " (feat.初音ミク)" : ""), "[00:01]Verified Vocaloid metadata", recordArtists[i], i === 2 ? 184 : 120) : undefined });
    await site.music.loadPlaylist(); await site.music.playIndex(0); await flush();
    assert.equal(site.music.getState().lrcStatus, "ready", item.name);
    assert.equal(site.music.getState().lrc[0].text, "Verified Vocaloid metadata");
  }
});

test("Meting JSON lrc/tlyric and raw LRC retain real timestamps without JSON garbage", async t => {
  const responses = [
    JSON.stringify({ lrc: "[00:01]Original", tlyric: "[00:01]Translation" }),
    "  " + JSON.stringify([{ lrc: { lyric: "[00:01]Original" }, tlyric: { lyric: "[00:01]Translation" } }]),
    "[ar:Metadata]\n[00:01]Original\n[00:03]",
  ];
  for (const response of responses) {
    const site = harness(t, { fetch: url => url.includes("lrclib") ? new Response("missing", { status: 404 }) : url.includes("type=lrc") ? new Response(response) : undefined });
    await site.music.loadPlaylist(); await site.music.playIndex(0); await flush();
    assert.equal(site.music.getState().lrcStatus, "ready");
    assert.equal(site.music.getState().lrc[0].t, 1);
    assert.equal(site.music.getState().lrc[0].text, "Original");
    assert.equal(site.music.getState().lrc.some(line => /[{}]|Metadata/.test(line.text)), false);
  }
});

test("metadata-only or malformed JSON lyrics are unavailable rather than fake time-zero cues", async t => {
  for (const value of ["[ar:Artist]\n[ti:Title]\nplain text without timing", '{not JSON: "[00:01]Do not render JSON"}', JSON.stringify({ lrc: "Plain unsynchronized text" })]) {
    const site = harness(t, { fetch: url => url.includes("lrclib") ? new Response("missing", { status: 404 }) : url.includes("type=lrc") ? new Response(value) : undefined });
    await site.music.loadPlaylist(); await site.music.playIndex(0); await flush();
    assert.equal(site.music.getState().lrcStatus, "unavailable");
    assert.equal(site.music.getState().lrc.length, 0);
  }
});

test("an overall lyric deadline settles unavailable even when a transport ignores abort", async t => {
  const site = harness(t, { fastLyrics: true, fetch: url => url.includes("lrclib") ? new Promise(() => {}) : undefined });
  await site.music.loadPlaylist(); await site.music.playIndex(0);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(site.music.getState().lrcStatus, "unavailable");
  assert.equal(site.music.getState().lrc.length, 0);
});

test("selection revision marks real replays and natural loops but not pause or seeking", async t => {
  const site = harness(t, { storage: { mm_mode: "one" }, fetch: url => url.includes("lrclib") ? lyrics("Track 1", "[00:00]First cue") : undefined });
  assert.equal(site.music.getState().selectionRevision, 0);
  await site.music.loadPlaylist(); await site.music.playIndex(0); await flush();
  assert.equal(site.music.getState().selectionRevision, 1);
  site.music.stop(); await site.music.toggle(); site.music.seek(0);
  assert.equal(site.music.getState().selectionRevision, 1);
  await site.music.playIndex(0); await flush();
  assert.equal(site.music.getState().selectionRevision, 2);
  site.audios[0].dispatch("ended"); await flush();
  assert.equal(site.music.getState().selectionRevision, 3);
  assert.equal(site.music.getState().lrcStatus, "ready");
  site.audios[0].seeking = true; site.audios[0].dispatch("seeking");
  assert.equal(site.events.at(-1).seeking, true);
  site.audios[0].seeking = false; site.audios[0].dispatch("seeked");
  assert.equal(site.events.at(-1).seeking, false);
  assert.equal(site.music.getState().selectionRevision, 3);
});
