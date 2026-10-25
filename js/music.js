/* ============================================
   MikuMusic 音乐中枢（全站常驻播放引擎 + 播放条）
   - 数据源：仓内歌单快照（data/playlist.json）为主，Meting 在线搜索/补漏
   - 全站玻璃播放条：seek / 音量 / 播放模式 / 上下曲 / 队列抽屉 / 歌词面板
   - Media Session（系统媒体键 / 锁屏）、状态持久化（刷新/换页恢复现场）
   - 歌词：lrclib 优先 + Meting 兜底；Limbus 弹出大字与全屏演出保留
   ============================================ */
"use strict";

const MikuMusic = (function () {
  const CFG = {
    playlistId: "18205251703",
    snapshot: "/data/playlist.json",
    publicApis: [
      "https://api.injahow.cn/meting/",
      "https://met.liiiu.cn/",
      "https://meting.qjqq.cn/api/",
      "https://api.wuenci.com/meting/api/",
    ],
  };
  const MODES = [
    { id: "list", icon: "🔁", tip: "列表循环" },
    { id: "one", icon: "🔂", tip: "单曲循环" },
    { id: "random", icon: "🔀", tip: "随机播放" },
  ];

  let audio = null;
  let queue = [];
  let qi = -1;
  let playing = false;
  let currentLrc = [];
  let lrcStatus = "idle";
  let selectionRevision = 0;
  let mode = "list";
  let expectPlay = false;  // 处于“应当正在播放”状态（用于断流自愈判定）
  let failStreak = 0;      // 连续断流次数（防切歌死循环）
  let playbackId = 0, pendingPlay = false, playlistPromise = null;
  let lyricController = null, restoreSeekCleanup = () => {};
  try { const savedMode = localStorage.getItem("mm_mode"); if (MODES.some((m) => m.id === savedMode)) mode = savedMode; } catch (e) {}
  const listeners = new Set();

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0");
  }

  /* ---------- 数据源 ---------- */
  function apiSources() {
    let custom = "";
    try { custom = (localStorage.getItem("kb_musicapi") || "").trim(); } catch (e) {}
    return custom ? [custom, ...CFG.publicApis] : [...CFG.publicApis];
  }

  async function fetchText(url, signal, timeout = 7000) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      const res = await fetch(url, { signal: controller.signal, cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.text();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async function api(type, id) {
    const errors = [];
    for (const base of apiSources()) {
      try {
        const text = await fetchText(base + "?type=" + type + "&server=netease&id=" + encodeURIComponent(id));
        if (!text.trim()) { errors.push("empty"); continue; }
        const data = JSON.parse(text);
        const ok = Array.isArray(data) ? data.length > 0 : !!data;
        if (ok) return data;
        errors.push("empty");
      } catch (e) { errors.push(e.name); }
    }
    throw new Error("音乐接口全部失败");
  }

  function normalize(list) {
    return (Array.isArray(list) ? list : []).filter((s) => s && typeof s === "object").map((s) => {
      const raw = String(s.stream || s.url || "");
      const m = raw.match(/[?&]id=(\d+)/);
      return {
        name: s.name || s.title || "未知",
        artist: s.artist || s.artists || "",
        id: m ? m[1] : String(s.id || ""),
        stream: /^https?:\/\//.test(raw) ? raw : "",
        pic: s.pic || "",
      };
    }).filter((s) => s.id || s.stream);
  }

  /* 歌单快照（仓内 107 首，秒开零依赖） */
  async function loadSnapshot() {
    const data = JSON.parse(await fetchText(CFG.snapshot));
    const list = normalize((data.playlist || []).map((s) => ({ ...s, url: "" })));
    if (!list.length) throw new Error("快照为空");
    return list;
  }

  /* 封面兜底：只查当前播放的歌（快照已自带封面，此路径极少触发）。
     成功缓存 30 天，失败也记负缓存 7 天——绝不反复打公共接口。 */
  async function fetchPic(id) {
    if (!id) return "";
    const key = "mm_pic_" + id;
    const missKey = "mm_picmiss_" + id;
    try { const c = localStorage.getItem(key); if (c) return c; } catch (e) {}
    try { if (localStorage.getItem(missKey)) return ""; } catch (e) {}
    for (const base of apiSources()) {
      try {
        const text = (await fetchText(base + "?type=pic&server=netease&id=" + encodeURIComponent(id))).trim();
        if (/^https?:\/\//.test(text)) {
          try { localStorage.setItem(key, text); } catch (e) {}
          return text;
        }
      } catch (e) {}
    }
    try { localStorage.setItem(missKey, String(Date.now())); } catch (e) {}
    return "";
  }
  function fillPics() {
    // 只兜底当前歌；快照没封面时播放到哪补到哪，不再全队列并发探测
    const s = queue[qi];
    if (!s || s.pic || !s.id) return;
    fetchPic(s.id).then((pic) => {
      if (pic && queue[qi] === s) {
        s.pic = pic;
        syncAll();
        renderQueue();
      }
    });
  }

  /* ---------- 音频元素 ---------- */
  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = "metadata";
    try { audio.volume = Math.min(1, Math.max(0, parseFloat(localStorage.getItem("mm_volume") || "0.9"))); } catch (e) {}
    audio.addEventListener("ended", () => { playing = false; window.__kbSinging = false; expectPlay = false; onEnded(); });
    audio.addEventListener("error", () => {
      if (!expectPlay) {
        if (!pendingPlay) { resetLyrics("unavailable"); syncAll(); }
        return; // 恢复现场的装载失败不算播放中断
      }
      resetLyrics("unavailable");
      expectPlay = false;
      playing = false;
      window.__kbSinging = false;
      if (++failStreak >= Math.min(3, queue.length)) { stop(); toast("连续播放失败，请稍后重试或使用本地音频"); return; }
      toast("播放中断了，自动换下一首 ♪");
      next(true);
    });
    audio.addEventListener("play", () => { if (expectPlay || pendingPlay) { playing = true; window.__kbSinging = true; syncAll(); updateMediaSession(); } });
    audio.addEventListener("pause", () => { playing = false; window.__kbSinging = false; syncAll(); persist(); updateMediaSession(); });
    let lastLine = -2;
    audio.addEventListener("loadedmetadata", () => syncAll());
    audio.addEventListener("seeking", syncAll);
    audio.addEventListener("seeked", syncAll);
    audio.addEventListener("timeupdate", () => {
      const line = lrcIndexAt(audio.currentTime || 0);
      if (line !== lastLine) { lastLine = line; emit(); }
      syncProgress();
      if (audio.currentTime > 2 && playing) failStreak = 0;
      if (Math.floor(audio.currentTime || 0) % 3 === 0) persist();
    });
    return audio;
  }

  function streamCandidates(item) {
    // 网易外链接口已返回 404 HTML（废弃），Meting type=url 才是真音频——它排前面
    const list = [];
    if (item.stream) list.push(item.stream);
    if (item.id) {
      for (const base of apiSources()) {
        list.push(base + "?server=netease&type=url&id=" + item.id);
      }
      list.push("https://music.163.com/song/media/outer/url?id=" + item.id + ".mp3");
    }
    return list;
  }

  /* 只装载不播放（用于恢复现场） */
  function prepare(item, seekTo) {
    ensureAudio();
    selectionRevision++;
    const id = ++playbackId;
    restoreSeekCleanup();
    resetLyrics("loading");
    expectPlay = false;
    pendingPlay = false;
    audio.pause();
    playing = false;
    const url = streamCandidates(item)[0];
    if (!url) { resetLyrics("unavailable"); syncAll(); return; }
    audio.src = url;
    if (seekTo > 0) {
      const jump = () => { if (id === playbackId && queue[qi] === item) { try { audio.currentTime = seekTo; syncAll(); } catch (e) {} } };
      if (audio.readyState >= 1) jump();
      else {
        audio.addEventListener("loadedmetadata", jump, { once: true });
        restoreSeekCleanup = () => audio.removeEventListener("loadedmetadata", jump);
      }
    }
    loadLrc(item).then(() => emit());
    syncAll();
  }

  function stop() {
    ++playbackId;
    pendingPlay = false;
    expectPlay = false;
    playing = false;
    window.__kbSinging = false;
    restoreSeekCleanup();
    if (lrcStatus === "loading") resetLyrics("idle");
    else lyricController?.abort();
    if (audio) audio.pause();
    syncAll();
    persist();
    updateMediaSession();
  }

  function playWithTimeout() {
    let timer;
    return Promise.race([
      Promise.resolve().then(() => audio.play()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("音频加载超时")), 10000); }),
    ]).finally(() => clearTimeout(timer));
  }

  async function play(item, automatic = false) {
    if (window.Ambient?.isRunning()) window.Ambient.stop();
    ensureAudio();
    selectionRevision++;
    const id = ++playbackId;
    restoreSeekCleanup();
    resetLyrics("loading");
    expectPlay = false;
    pendingPlay = true;
    audio.pause();
    playing = false;
    if (!automatic) failStreak = 0;
    emit();
    const candidates = streamCandidates(item);
    if (!candidates.length) { pendingPlay = false; resetLyrics("unavailable"); syncAll(); throw new Error("拿不到播放地址"); }
    let lastErr = null;
    expectPlay = false; // 候选切换期间产生的 error 不算"播放中断"
    for (const url of candidates) {
      try {
        audio.removeAttribute("crossorigin");
        audio.src = url;
        await playWithTimeout();
        if (id !== playbackId) return false;
        window.__kbSinging = true;
        playing = true;
        expectPlay = true;
        pendingPlay = false;
        loadLrc(item).then(() => emit());
        emit();
        persist();
        updateMediaSession();
        return true;
      } catch (e) {
        if (id !== playbackId) return false;
        lastErr = e;
        audio.pause();
        if (e.name === "NotAllowedError") break;
      }
    }
    pendingPlay = false;
    playing = false;
    expectPlay = false;
    window.__kbSinging = false;
    resetLyrics("unavailable");
    syncAll();
    toast("《" + item.name + "》播放失败：" + (lastErr ? lastErr.message : "地址不可用"));
    throw new Error("播放失败：" + (lastErr ? lastErr.message : "所有地址都不可用"));
  }

  /* ---------- 歌词 ---------- */
  function resetLyrics(status = "idle") {
    lyricController?.abort();
    lyricController = null;
    currentLrc = [];
    lrcStatus = status;
  }

  function parseLrc(text) {
    const out = [];
    const tagRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    for (const raw of text.replace(/\r/g, "").split("\n")) {
      if (!/^\s*\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(raw)) continue;
      tagRe.lastIndex = 0;
      const times = [];
      let m;
      while ((m = tagRe.exec(raw)) !== null) {
        if (Number(m[2]) >= 60) continue;
        const frac = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) / 1000 : 0;
        times.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac);
      }
      const content = raw.replace(tagRe, "").trim();
      // Untimed metadata/plain text is not a synchronized lyric. Empty timed
      // cues are retained so the stage can clear a line during an interlude.
      times.forEach((t) => out.push({ t, text: content }));
    }
    return out.sort((a, b) => a.t - b.t);
  }

  const nameKey = (value) => String(value || "").normalize("NFKC").toLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, "");
  function titleKey(value) {
    return nameKey(String(value || "")
      .replace(/[（(\[]\s*(?:featuring\s+|feat\.?\s+|ft\.?\s+|feat\.|ft\.)\s*[^)）\]]+[)）\]]/gi, "")
      .replace(/\s+(?:featuring\s+|feat\.?\s+|ft\.?\s+|feat\.|ft\.)\s*.+$/i, ""));
  }
  function artistKeys(value) {
    return String(value || "").replace(/\b(?:featuring\s+|feat\.\s*|ft\.\s*|feat\s+|ft\s+)/gi, "/")
      .split(/\s*(?:\/|,|;|&|、)\s*/)
      .map(artist => nameKey(artist.replace(/\s*official\s*$/i, "")))
      .map(artist => /^(?:初音ミク|初音未来|hatsunemiku|miku)$/.test(artist) ? "hatsunemiku" : artist).filter(Boolean);
  }

  function metingLyrics(value) {
    let data;
    try { data = JSON.parse(value); }
    catch (_) { return parseLrc(value); }
    if (Array.isArray(data)) data = data[0];
    if (typeof data === "string") return parseLrc(data);
    if (!data || typeof data !== "object") return [];
    const read = part => typeof part === "string" ? part : typeof part?.lyric === "string" ? part.lyric : "";
    const parts = [...new Set([read(data.lrc), read(data.tlyric), read(data.lyric)].filter(Boolean))];
    return parts.flatMap(parseLrc).sort((a, b) => a.t - b.t);
  }
  function lyricMatch(record, item, duration) {
    if (!record || titleKey(record.trackName || record.name) !== titleKey(item.name)) return -1;
    const expected = artistKeys(item.artist), actual = artistKeys(record.artistName);
    const overlap = expected.filter(artist => actual.includes(artist)).length;
    if (!overlap) return -1;
    const length = Number(record.duration);
    let score = 100 + overlap * 5;
    if (Number.isFinite(duration) && duration > 0 && Number.isFinite(length) && length > 0) {
      const preview = duration <= 45 && length > duration + 10;
      if (!preview && Math.abs(length - duration) > 3) return -1;
      if (!preview) score += 10 - Math.min(3, Math.abs(length - duration));
    }
    return score;
  }

  async function loadLrc(item) {
    lyricController?.abort();
    const controller = lyricController = new AbortController();
    const id = playbackId;
    const selected = () => id === playbackId && queue[qi] === item && lyricController === controller;
    const current = () => !controller.signal.aborted && selected();
    currentLrc = [];
    lrcStatus = "loading";
    emit();
    const artistFirst = String(item.artist || "").split("/")[0].trim();
    const duration = Number.isFinite(audio?.duration) ? audio.duration : 0;
    const signature = { track_name: item.name || "", artist_name: artistFirst };
    // A 30-second preview should still use the full track's verified lyrics.
    if (duration > 45 && duration <= 3600) signature.duration = String(Math.round(duration));
    const requests = [
      ...(artistFirst ? [["get", signature]] : []),
      ["search", { track_name: item.name || "", artist_name: artistFirst }],
      ["search", { track_name: item.name || "" }],
    ];
    const find = async () => {
      for (const [endpoint, query] of requests) {
        try {
          const data = JSON.parse(await fetchText("https://lrclib.net/api/" + endpoint + "?" + new URLSearchParams(query).toString(), controller.signal, 4000));
          if (!current()) return null;
          const candidates = (Array.isArray(data) ? data : [data])
            .map(record => ({ record, score: lyricMatch(record, item, duration) }))
            .filter(candidate => candidate.score >= 0).sort((a, b) => b.score - a.score);
          for (const { record } of candidates) {
            if (typeof record.syncedLyrics !== "string") continue;
            const lines = parseLrc(record.syncedLyrics);
            if (lines.some(line => line.text)) return lines;
          }
        } catch (e) { if (!current()) return null; }
      }
      for (const base of apiSources()) {
        try {
          if (!item.id) break;
          const text = (await fetchText(base + "?type=lrc&server=netease&id=" + encodeURIComponent(item.id), controller.signal, 4000)).trim();
          if (!current()) return null;
          if (!text || text.startsWith('{"error')) continue;
          const lines = metingLyrics(text);
          if (lines.some(line => line.text)) return lines;
        } catch (e) { if (!current()) return null; }
      }
      return null;
    };
    let timer;
    try {
      const lines = await Promise.race([find(), new Promise(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, 20000);
      })]);
      if (!selected()) return false;
      currentLrc = lines || [];
      lrcStatus = lines ? "ready" : "unavailable";
      renderLyricPanel(true); emit();
      return !!lines;
    } finally { clearTimeout(timer); }
  }

  function retryLyrics() { return queue[qi] ? loadLrc(queue[qi]) : Promise.resolve(false); }

  function lrcIndexAt(time) {
    let idx = -1;
    for (let i = 0; i < currentLrc.length; i++) {
      if (currentLrc[i].t <= time) idx = i;
      else break;
    }
    return idx;
  }

  /* ---------- 队列 / 播放控制 ---------- */
  async function loadPlaylistData() {
    if (queue.length) return queue.length;
    // 主源：仓内快照（零依赖秒开）；兜底：Meting 在线 → 本机缓存。
    // 注意：await 期间 restore() 可能已恢复现场，每步回来都要复查，别把现场覆盖掉。
    let list = null;
    try {
      list = await loadSnapshot();
    } catch (e) {
      try {
        list = normalize(await api("playlist", CFG.playlistId));
        try { localStorage.setItem("mm_playlist_cache", JSON.stringify(list)); } catch (err) {}
      } catch (err2) {
        let cached = null;
        try { cached = localStorage.getItem("mm_playlist_cache"); } catch (err3) {}
        if (!cached) throw new Error("歌单快照与在线接口都失败了");
        try { list = normalize(JSON.parse(cached)); } catch (err4) { throw new Error("本地歌单缓存损坏"); }
      }
    }
    if (queue.length) return queue.length; // restore() 已抢先把现场装好，保留它
    queue = list;
    if (!queue.length) throw new Error("歌单读取失败了");
    qi = -1;
    fillPics();
    emit();
    return queue.length;
  }

  async function loadPlaylist() {
    if (queue.length) return queue.length;
    if (!playlistPromise) playlistPromise = loadPlaylistData().finally(() => { playlistPromise = null; });
    return playlistPromise;
  }

  function reloadPlaylist() { stop(); queue = []; qi = -1; resetLyrics(); syncAll(); }

  async function playPlaylist() {
    const n = await loadPlaylist();
    await playIndex(0);
    return n;
  }

  async function playIndex(i, opts) {
    if (!queue[i]) return false;
    qi = i;
    if (opts && opts.seekTo !== undefined && opts.autoplay === false) {
      prepare(queue[i], opts.seekTo);
      return;
    }
    return play(queue[i]);
  }

  function pickRandom() {
    if (queue.length <= 1) return 0;
    let r;
    do { r = Math.floor(Math.random() * queue.length); } while (r === qi);
    return r;
  }

  function next(auto) {
    if (!queue.length) return false;
    if (mode === "random") qi = pickRandom();
    else qi = (qi + 1) % queue.length;
    play(queue[qi], !!auto).catch(() => {
      if (!auto) return;
      if (++failStreak < Math.min(3, queue.length)) next(true);
      else { stop(); toast("连续播放失败，请稍后重试或使用本地音频"); }
    });
    return true;
  }

  function prev() {
    if (!queue.length) return false;
    if (mode === "random") qi = pickRandom();
    else qi = qi <= 0 ? queue.length - 1 : qi - 1;
    play(queue[qi]).catch(() => {});
    return true;
  }

  function onEnded() {
    failStreak = 0;
    if (mode === "one") { selectionRevision++; audio.currentTime = 0; resume(); return; }
    next(true);
  }

  function cycleMode() {
    mode = MODES[(MODES.findIndex((m) => m.id === mode) + 1) % MODES.length].id;
    try { localStorage.setItem("mm_mode", mode); } catch (e) {}
    toast("播放模式：" + MODES.find((m) => m.id === mode).tip);
    syncAll();
    persist();
  }

  function seek(frac) {
    if (!audio || !Number.isFinite(audio.duration) || !audio.duration || !Number.isFinite(frac)) return;
    audio.currentTime = Math.min(Math.max(0, audio.duration - 0.2), Math.max(0, frac * audio.duration));
    syncAll();
  }

  function setVolume(v) {
    ensureAudio();
    audio.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.9;
    try { localStorage.setItem("mm_volume", String(audio.volume)); } catch (e) {}
    const bar = document.querySelector(".gp-vol input");
    if (bar) bar.value = audio.volume;
  }

  async function resume() {
    if (window.Ambient?.isRunning()) window.Ambient.stop();
    if (!audio || !audio.src || audio.error) {
      try { if (queue[qi]) return await play(queue[qi]); return await playPlaylist(); }
      catch (e) { return false; }
    }
    const id = ++playbackId;
    pendingPlay = true;
    try {
      await playWithTimeout();
      if (id !== playbackId) return false;
      pendingPlay = false;
      playing = true;
      expectPlay = true;
      window.__kbSinging = true;
      if (lrcStatus === "idle" && queue[qi]) loadLrc(queue[qi]).then(() => emit());
      syncAll(); updateMediaSession(); persist();
      return true;
    } catch (e) {
      if (id !== playbackId) return false;
      stop();
      toast("播放失败，请重试或使用本地音频：" + e.message);
      return false;
    }
  }

  function toggle() {
    if (pendingPlay || (audio && !audio.paused)) { stop(); return Promise.resolve(false); }
    return resume();
  }

  function getState() {
    return {
      playing,
      seeking: !!audio?.seeking,
      selectionRevision,
      current: queue[qi] || null,
      index: qi,
      total: queue.length,
      hasQueue: queue.length > 0,
      mode,
      volume: audio ? audio.volume : 0.9,
      duration: audio ? audio.duration || 0 : 0,
      time: audio ? audio.currentTime || 0 : 0,
      lrc: currentLrc,
      lrcStatus,
      lrcLine: audio ? lrcIndexAt(audio.currentTime || 0) : -1,
    };
  }

  /* ---------- 事件总线 + 同步 ---------- */
  function emit() {
    const st = getState();
    listeners.forEach((fn) => { try { fn(st); } catch (e) {} });
    document.dispatchEvent(new CustomEvent("mikumusic", { detail: st }));
    try { lyricBarTick(); } catch (e) {}
    try { loTick(); } catch (e) {}
    syncPlayerBar(st);
    syncProgress();
  }
  function syncAll() { emit(); }
  function on(fn) { if (typeof fn !== "function") return () => {}; listeners.add(fn); return () => listeners.delete(fn); }

  /* ---------- 状态持久化（刷新/换页恢复现场） ---------- */
  let persistTimer = 0;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        if (!queue.length) return;
        localStorage.setItem("mm_state", JSON.stringify({
          queue, qi, mode,
          time: audio ? audio.currentTime || 0 : 0,
          updated: Date.now(),
        }));
      } catch (e) {}
    }, 400);
  }

  function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem("mm_state") || "null"); } catch (e) {}
    if (!saved || !Array.isArray(saved.queue) || !saved.queue.length) return;
    queue = normalize(saved.queue);
    if (!queue.length) return;
    qi = Math.min(Math.max(0, saved.qi | 0), queue.length - 1);
    mode = MODES.some((m) => m.id === saved.mode) ? saved.mode : "list";
    prepare(queue[qi], saved.time || 0);
    fillPics();
    toast("已恢复上次播放：《" + queue[qi].name + "》，点播放键继续 ♪");
  }

  /* ---------- Media Session（系统媒体键 / 锁屏） ---------- */
  function updateMediaSession() {
    if (!("mediaSession" in navigator) || !queue[qi]) return;
    const cur = queue[qi];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: cur.name,
        artist: cur.artist || "未知歌手",
        album: "CidneyAurum の 小窝",
        artwork: cur.pic ? [{ src: cur.pic, sizes: "512x512", type: "image/jpeg" }] : [],
      });
      navigator.mediaSession.setActionHandler("play", () => { if (!playing && !pendingPlay) resume(); });
      navigator.mediaSession.setActionHandler("pause", stop);
      navigator.mediaSession.setActionHandler("previoustrack", () => prev());
      navigator.mediaSession.setActionHandler("nexttrack", () => next());
      navigator.mediaSession.setActionHandler("seekto", (d) => { if (audio && d.seekTime != null) { audio.currentTime = d.seekTime; } });
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    } catch (e) {}
  }

  /* ---------- toast 轻提示 ---------- */
  let toastTimer = 0;
  function toast(msg) {
    let box = document.getElementById("gp-toast");
    if (!box) {
      box = document.createElement("div");
      box.id = "gp-toast";
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove("show"), 3200);
  }

  /* ============================================================
     全站播放条（body 级，任何页面常驻）
     ============================================================ */
  let barBuilt = false;
  let lyricOpen = false, drawerOpen = false, lastLrcIdx = -2, dragging = false;

  function buildPlayerBar() {
    if (barBuilt || !document.body) return;
    barBuilt = true;
    const el = document.createElement("div");
    el.className = "gplayer";
    el.id = "gplayer";
    el.innerHTML = `
      <div class="gp-lyric" id="gp-lyric" hidden><div class="gp-lrc-list" id="gp-lrc-list"></div></div>
      <div class="gp-drawer" id="gp-drawer" hidden>
        <div class="gp-drawer-head">
          <b>播放队列</b><span id="gp-qcount"></span>
          <button class="gp-drawer-close" id="gp-drawer-close" title="收起">✕</button>
        </div>
        <div class="gp-search"><input id="gp-qsearch" placeholder="搜本地队列，回车在线搜…"></div>
        <div class="gp-qlist" id="gp-qlist"></div>
      </div>
      <div class="gp-bar">
        <div class="gp-left">
          <div class="gp-cover-wrap"><span class="gp-cover-note">♪</span><img class="gp-cover" id="gp-cover" alt=""></div>
          <div class="gp-info">
            <div class="gp-name" id="gp-name">没有在放歌</div>
            <div class="gp-artist" id="gp-artist">点歌单开始，或跟 Miku 说「放 歌名」</div>
          </div>
        </div>
        <div class="gp-center">
          <div class="gp-btns">
            <button class="gp-btn" id="gp-mode" title="播放模式">🔁</button>
            <button class="gp-btn gp-big" id="gp-prev" title="上一首">⏮</button>
            <button class="gp-btn gp-play" id="gp-toggle" title="播放/暂停（空格）">▶</button>
            <button class="gp-btn gp-big" id="gp-next" title="下一首">⏭</button>
            <button class="gp-btn" id="gp-lyric-btn" title="歌词面板">词</button>
          </div>
          <div class="gp-progress-row">
            <span class="gp-time" id="gp-cur">00:00</span>
            <div class="gp-progress" id="gp-progress" role="slider" tabindex="0" aria-label="播放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="gp-fill" id="gp-fill"></div><div class="gp-knob" id="gp-knob"></div></div>
            <span class="gp-time" id="gp-total">00:00</span>
          </div>
        </div>
        <div class="gp-right">
          <div class="gp-vol" id="gp-vol"><span class="gp-vol-ico">🔊</span><input type="range" min="0" max="1" step="0.01" value="0.9" aria-label="音量"></div>
          <button class="gp-btn" id="gp-queue-btn" title="播放队列">☰</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelectorAll("button[title]").forEach((button) => button.setAttribute("aria-label", button.title));
    $("gp-qsearch").setAttribute("aria-label", "搜索播放队列或在线歌曲");

    $("gp-toggle").addEventListener("click", toggle);
    $("gp-next").addEventListener("click", () => next());
    $("gp-prev").addEventListener("click", prev);
    $("gp-mode").addEventListener("click", cycleMode);
    $("gp-lyric-btn").addEventListener("click", () => setLyricPanel(!lyricOpen));
    $("gp-queue-btn").addEventListener("click", () => setDrawer(!drawerOpen));
    $("gp-drawer-close").addEventListener("click", () => setDrawer(false));
    $("gp-qsearch").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const kw = e.target.value.trim();
        if (kw) searchAndPlay(kw).then((s) => toast("《" + s.name + "》开始播放 ♪")).catch((err) => toast(err.message));
      }
    });
    $("gp-qsearch").addEventListener("input", () => renderQueue());

    // 音量
    const vol = el.querySelector(".gp-vol input");
    try { vol.value = parseFloat(localStorage.getItem("mm_volume") || "0.9"); } catch (e) {}
    vol.addEventListener("input", () => setVolume(parseFloat(vol.value)));

    // 进度条：点击 + 拖拽 seek
    const prog = $("gp-progress");
    const fracAt = (ev) => {
      const r = prog.getBoundingClientRect();
      return Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    };
    prog.addEventListener("pointerdown", (e) => {
      if (!audio || !audio.duration) return;
      dragging = true;
      prog.setPointerCapture(e.pointerId);
      const f = fracAt(e);
      $("gp-fill").style.width = f * 100 + "%";
      $("gp-knob").style.left = f * 100 + "%";
      $("gp-cur").textContent = fmt(f * audio.duration);
    });
    prog.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const f = fracAt(e);
      $("gp-fill").style.width = f * 100 + "%";
      $("gp-knob").style.left = f * 100 + "%";
      $("gp-cur").textContent = fmt(f * (audio.duration || 0));
    });
    prog.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      dragging = false;
      seek(fracAt(e));
    });
    const cancelDrag = () => { dragging = false; syncProgress(); };
    prog.addEventListener("pointercancel", cancelDrag);
    prog.addEventListener("lostpointercapture", cancelDrag);
    prog.addEventListener("keydown", (e) => {
      if (!audio || !Number.isFinite(audio.duration) || !audio.duration) return;
      const current = audio.currentTime / audio.duration;
      const changes = { ArrowLeft: current - 5 / audio.duration, ArrowRight: current + 5 / audio.duration, Home: 0, End: 1 };
      if (!(e.key in changes)) return;
      e.preventDefault();
      e.stopPropagation();
      seek(changes[e.key]);
    });

    // 歌词行点击 seek（事件委托）
    $("gp-lrc-list").addEventListener("click", (e) => {
      const line = e.target.closest(".gp-lrc-line");
      if (!line || !audio) return;
      const idx = +line.dataset.i;
      if (currentLrc[idx]) { audio.currentTime = currentLrc[idx].t; if (audio.paused) toggle(); }
    });
    // 队列行点击 / 删除（事件委托）
    $("gp-qlist").addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        const i = +del.dataset.del;
        if (i === qi) { toast("先切到别的歌再删这首吧"); return; }
        queue.splice(i, 1);
        if (i < qi) qi--;
        syncAll();
        persist();
        return;
      }
      const row = e.target.closest("[data-i]");
      if (row) playIndex(+row.dataset.i).catch((err) => toast(err.message));
    });
    ["gp-qlist", "gp-lrc-list"].forEach((id) => $(id).addEventListener("keydown", (e) => {
      const row = e.target.closest(".gp-qrow, .gp-lrc-line");
      if (row && e.target === row && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault(); e.stopPropagation(); row.click();
      }
    }));
  }

  function $(id) { return document.getElementById(id); }

  function setLyricPanel(open) {
    buildPlayerBar();
    lyricOpen = open;
    const panel = $("gp-lyric");
    if (panel) panel.hidden = !open;
    $("gp-lyric-btn").classList.toggle("on", open);
    if (open) renderLyricPanel(true);
  }

  function setDrawer(open) {
    buildPlayerBar();
    drawerOpen = open;
    const d = $("gp-drawer");
    if (d) d.hidden = !open;
    $("gp-queue-btn").classList.toggle("on", open);
    if (open) { const s = $("gp-qsearch"); if (s) s.value = ""; renderQueue(); }
  }

  function renderLyricPanel(force) {
    if (!lyricOpen || !barBuilt) return;
    const list = $("gp-lrc-list");
    const st = getState();
    if (!list) return;
    if (!currentLrc.length) {
      list.innerHTML = '<div class="gp-lrc-empty">' + (lrcStatus === "loading" ? "歌词正在加载…" : lrcStatus === "unavailable" ? "这首暂时没有可用的同步歌词" : "选择一首歌，等待歌词开始 ♪") + '</div>';
      lastLrcIdx = -2;
      return;
    }
    if (!list.children.length || force || list.dataset.song !== (st.current ? st.current.id : "")) {
      list.dataset.song = st.current ? st.current.id : "";
      list.innerHTML = currentLrc.map((l, i) =>
        `<div class="gp-lrc-line" role="button" tabindex="0" aria-label="跳转到 ${esc(fmt(l.t))} ${esc(l.text)}" data-i="${i}">${esc(l.text)}</div>`).join("");
      lastLrcIdx = -2;
    }
    if (st.lrcLine !== lastLrcIdx) {
      lastLrcIdx = st.lrcLine;
      list.querySelectorAll(".gp-lrc-line.on").forEach((n) => n.classList.remove("on"));
      const cur = list.children[st.lrcLine];
      if (cur) {
        cur.classList.add("on");
        const row = cur.getBoundingClientRect(), box = list.getBoundingClientRect();
        list.scrollTop += row.top - box.top - (list.clientHeight - row.height) / 2;
      }
    }
  }

  function renderQueue() {
    if (!barBuilt || !drawerOpen) return;
    const list = $("gp-qlist");
    const st = getState();
    const kw = ($("gp-qsearch").value || "").trim().toLowerCase();
    const shown = queue.map((s, i) => ({ s, i })).filter(({ s }) =>
      !kw || (s.name + " " + s.artist).toLowerCase().includes(kw));
    const signature = JSON.stringify([st.index, st.playing, kw, queue.map((s) => [s.id, s.name, s.artist])]);
    if (list.dataset.queueSignature === signature) return;
    list.dataset.queueSignature = signature;
    $("gp-qcount").textContent = queue.length + " 首";
    list.innerHTML = shown.length ? shown.map(({ s, i }) => `
      <div class="gp-qrow${i === st.index ? " on" : ""}" role="button" tabindex="0" aria-label="播放 ${esc(s.name)}" data-i="${i}">
        <span class="gp-q-idx">${i === st.index && st.playing ? "♪" : i + 1}</span>
        <span class="gp-q-main"><b>${esc(s.name)}</b><small>${esc(s.artist)}</small></span>
        <button class="gp-q-del" data-del="${i}" title="移出队列">✕</button>
      </div>`).join("")
      : (kw ? '<div class="gp-lrc-empty">队列里没有匹配的歌，回车在线搜</div>' : '<div class="gp-lrc-empty">队列空空如也</div>');
  }

  function syncProgress() {
    if (!barBuilt || dragging || !audio) return;
    const st = getState();
    const pct = st.duration ? (st.time / st.duration) * 100 : 0;
    const fill = $("gp-fill"), knob = $("gp-knob"), cur = $("gp-cur"), total = $("gp-total");
    if (fill) fill.style.width = pct + "%";
    if (knob) knob.style.left = pct + "%";
    if (cur) cur.textContent = fmt(st.time);
    if (total) total.textContent = st.duration ? fmt(st.duration) : "00:00";
    const progress = $("gp-progress");
    if (progress) {
      progress.setAttribute("aria-valuenow", String(Math.round(pct)));
      progress.setAttribute("aria-valuetext", fmt(st.time) + " / " + fmt(st.duration));
    }
  }

  function syncPlayerBar(st) {
    if (!barBuilt) return;
    const btn = $("gp-toggle");
    if (btn) { btn.textContent = st.playing ? "❚❚" : "▶"; btn.setAttribute("aria-label", st.playing ? "暂停音乐" : "播放音乐"); }
    const modeBtn = $("gp-mode");
    if (modeBtn) {
      const m = MODES.find((x) => x.id === st.mode) || MODES[0];
      modeBtn.textContent = m.icon;
      modeBtn.title = m.tip;
    }
    if (st.current) {
      $("gp-name").textContent = st.current.name;
      $("gp-artist").textContent = st.current.artist || "未知歌手";
      const cover = $("gp-cover");
      if (cover && cover.dataset.id !== st.current.id) {
        cover.dataset.id = st.current.id;
        cover.src = st.current.pic || "";
        cover.classList.toggle("no", !st.current.pic);
        if (!st.current.pic) fetchPic(st.current.id).then((p) => {
          if (p && queue[qi] === st.current) { st.current.pic = p; cover.src = p; cover.classList.remove("no"); }
        });
      }
    }
    document.getElementById("gplayer").classList.toggle("playing", !!st.playing);
    renderLyricPanel();
    renderQueue();
  }

  /* ---------- 歌词横幅 + 弹出大字（首页 Limbus 演出，保留） ---------- */
  let typingTimer = 0, popTimer = 0;

  function lyricBarTick(force) {
    const bar = document.getElementById("lyric-bar");
    if (!bar) return;
    const st = getState();
    const textEl = bar.querySelector(".lb-text");
    if (!textEl) return;
    bar.classList.toggle("playing", !!st.playing);
    if (!st.hasQueue) {
      if (textEl.dataset.mode !== "hint") {
        textEl.dataset.mode = "hint";
        clearInterval(typingTimer);
        textEl.textContent = "点歌单里的歌，或跟 Miku 说「放 歌名」♪";
      }
      return;
    }
    const line = st.lrcLine >= 0 && st.lrc[st.lrcLine] ? st.lrc[st.lrcLine].text : "♪ " + (st.current ? st.current.name : "");
    const key = st.lrcLine + "|" + line;
    if (textEl.dataset.key !== key || force) {
      textEl.dataset.key = key;
      textEl.dataset.mode = "lyric";
      clearInterval(typingTimer);
      let i = 0;
      textEl.textContent = "";
      typingTimer = setInterval(() => {
        i++;
        textEl.textContent = line.slice(0, i);
        if (i >= line.length) clearInterval(typingTimer);
      }, 65);
      if (st.playing) popLyric(line, st.lrcLine);
    }
  }

  function popLyric(text, lineIdx) {
    let host = document.getElementById("lyric-pop-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "lyric-pop-host";
      host.className = "lyric-pop-host";
      document.body.appendChild(host);
    }
    host.querySelectorAll(".lyric-pop:not(.fading)").forEach((p) => {
      p.classList.add("fading");
      setTimeout(() => p.remove(), 1000);
    });
    const pop = document.createElement("div");
    pop.className = "lyric-pop";
    pop.style.left = (12 + Math.random() * 46) + "%";
    pop.style.top = (20 + Math.random() * 48) + "%";
    pop.style.transform = "rotate(" + (Math.random() * 16 - 8).toFixed(1) + "deg)";
    host.appendChild(pop);
    const chars = [...text];
    let ci = 0;
    const typeTimer = setInterval(() => {
      if (ci >= chars.length) { clearInterval(typeTimer); return; }
      const sp = document.createElement("span");
      sp.className = "lch";
      sp.style.animationDuration = (0.12 + Math.random() * 0.08).toFixed(2) + "s";
      sp.textContent = chars[ci] === " " ? "\u00A0" : chars[ci];
      pop.appendChild(sp);
      ci++;
    }, 100);
    clearTimeout(popTimer);
    popTimer = setTimeout(() => clearInterval(typeTimer), chars.length * 100 + 120);
  }

  /* ---------- 全屏歌词演出浮层 ---------- */
  let overlayBuilt = false, overlayOpen = false, lastLoLine = -2;

  function buildOverlay() {
    if (overlayBuilt) return;
    overlayBuilt = true;
    const el = document.createElement("div");
    el.className = "lyric-overlay";
    el.id = "lyric-overlay";
    el.innerHTML = `
      <div class="lo-head"><span>LIMBUS · LIKE · LYRIC</span><span id="lo-song">♪</span></div>
      <div class="lo-stage" id="lo-stage">
        <div class="stage-line"></div>
        <div class="lyric-area" id="lo-area">
          <div class="stage-idle">— LYRIC SHOW —</div>
        </div>
      </div>
      <button class="lo-close" title="关闭演出（Esc）">✕ 关闭演出</button>`;
    document.body.appendChild(el);
    el.querySelector(".lo-close").addEventListener("click", () => setOverlay(false));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOverlay(false); });
  }

  function setOverlay(open) {
    buildOverlay();
    overlayOpen = open;
    document.getElementById("lyric-overlay").classList.toggle("open", open);
    if (open) { lastLoLine = -2; loTick(true); }
  }
  function loToggle() { setOverlay(!overlayOpen); }

  function loRender(idx, name) {
    const area = document.getElementById("lo-area");
    if (!area) return;
    area.innerHTML = "";
    const stage = document.getElementById("lo-stage");
    stage.classList.remove("slam");
    const headSong = document.getElementById("lo-song");
    if (headSong) headSong.textContent = "♪ " + (name || "MUSIC");
    if (idx < 0 || !currentLrc[idx]) {
      area.innerHTML = '<div class="stage-idle">— ' + esc(name || "MUSIC") + ' —</div>';
      return;
    }
    const line = currentLrc[idx];
    const el = document.createElement("div");
    el.className = "lyric-line";
    if (idx % 3 === 2) el.classList.add("shake");
    let k = 0;
    for (const ch of line.text) {
      const sp = document.createElement("span");
      sp.className = "char " + (k % 2 === 0 ? "in-left" : "in-right");
      sp.style.animationDelay = (k % 2 === 0 ? 0 : 0.05) + k * 0.016 + "s";
      sp.textContent = ch === " " ? "\u00A0" : ch;
      el.appendChild(sp);
      k++;
    }
    area.appendChild(el);
    if (idx % 3 === 2) {
      const slash = document.createElement("div");
      slash.className = "slash go";
      area.appendChild(slash);
      void stage.offsetWidth;
      stage.classList.add("slam");
    }
  }

  function loTick(force) {
    if (!overlayOpen) return;
    const st = getState();
    if (st.lrcLine !== lastLoLine || force) {
      lastLoLine = st.lrcLine;
      loRender(st.lrcLine, st.current ? st.current.name : "");
    }
  }

  /* ---------- 点播（Miku 对话 & 队列搜索共用） ---------- */
  async function searchAndPlay(name) {
    if (!queue.length) { try { await loadPlaylist(); } catch (e) {} }
    if (queue.length) {
      const key = name.toLowerCase();
      const matched = queue.filter((s) => (s.name + " " + s.artist).toLowerCase().includes(key));
      if (matched.length) { queue = matched.concat(queue.filter((q) => !matched.some((m) => m.id === q.id))); qi = 0; await play(queue[0]); return queue[0]; }
    }
    let songs = [];
    try { songs = normalize(await api("search", name)); } catch (e) {}
    if (!songs.length) throw new Error("歌单里和在线都没找到「" + name + "」♪ 你可以在网易云 APP 里把这首歌加到歌单，或跟我说「播放歌单」听已有的");
    queue = songs.concat(queue.filter((q) => !songs.some((s) => s.id === q.id)));
    qi = 0;
    await play(queue[0]);
    return queue[0];
  }

  /* ---------- 对外 API ---------- */
  return {
    searchAndPlay, playPlaylist, loadPlaylist, reloadPlaylist, playIndex, next, prev, toggle, stop,
    seek, setVolume, cycleMode, toast, retryLyrics,
    getState, getQueue: () => queue.slice(), on, playlistId: CFG.playlistId,
    closePanels: () => {
      const active = document.activeElement;
      const focusQueue = drawerOpen && $("gp-drawer")?.contains(active);
      const focusLyrics = lyricOpen && $("gp-lyric")?.contains(active);
      setDrawer(false); setLyricPanel(false);
      if (focusQueue) $("gp-queue-btn")?.focus();
      else if (focusLyrics) $("gp-lyric-btn")?.focus();
    },
    popLyric,
    lyricOverlay: { toggle: loToggle, open: () => setOverlay(true), close: () => setOverlay(false) },
    buildPlayerBar, restore,
  };
})();

window.MikuMusic = MikuMusic;

/* ---------- 启动：建播放条 + 恢复现场 + 键盘控制 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  try { MikuMusic.buildPlayerBar(); } catch (e) {}
  try { MikuMusic.restore(); } catch (e) {}

  // 空格播放/暂停（输入框聚焦时除外）；←/→ 快退快进 5s；Esc 收起抽屉
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      MikuMusic.closePanels();
      return;
    }
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || document.body.dataset.page === "limbus") return;
    if (document.activeElement?.closest("input, textarea, select, button, a, [role=button], [role=slider], [contenteditable=true]")) return;
    if (e.code === "Space") { e.preventDefault(); MikuMusic.toggle(); }
    else if (e.key === "ArrowLeft" && window.MikuMusic.getState().hasQueue) { e.preventDefault(); MikuMusic.seek(Math.max(0, (MikuMusic.getState().time - 5) / Math.max(1, MikuMusic.getState().duration))); }
    else if (e.key === "ArrowRight" && window.MikuMusic.getState().hasQueue) { e.preventDefault(); MikuMusic.seek(Math.min(1, (MikuMusic.getState().time + 5) / Math.max(1, MikuMusic.getState().duration))); }
  });
});
