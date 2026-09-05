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
  let mode = "list";
  let expectPlay = false;  // 处于“应当正在播放”状态（用于断流自愈判定）
  let failStreak = 0;      // 连续断流次数（防切歌死循环）
  const listeners = new Set();

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0");
  }

  /* ---------- 数据源 ---------- */
  function apiSources() {
    const custom = (localStorage.getItem("kb_musicapi") || "").trim();
    return custom ? [custom, ...CFG.publicApis] : [...CFG.publicApis];
  }

  async function api(type, id) {
    const errors = [];
    for (const base of apiSources()) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(base + "?type=" + type + "&server=netease&id=" + encodeURIComponent(id), { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) { errors.push(res.status); continue; }
        const text = await res.text();
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
    return (list || []).map((s) => {
      const raw = String(s.url || "");
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
    const res = await fetch(CFG.snapshot, { cache: "no-cache" });
    if (!res.ok) throw new Error("快照 " + res.status);
    const data = await res.json();
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
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(base + "?type=pic&server=netease&id=" + id, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) continue;
        const text = (await res.text()).trim();
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
    audio.addEventListener("ended", () => { window.__kbSinging = false; expectPlay = false; onEnded(); });
    audio.addEventListener("error", () => {
      if (!expectPlay) return; // 恢复现场的装载失败不算播放中断
      failStreak++;
      if (failStreak >= 3) {
        expectPlay = false; failStreak = 0;
        toast("连续播放失败，先停一停～ 点播放键重试");
        return;
      }
      toast("播放中断了，自动换下一首 ♪");
      next(true);
    });
    audio.addEventListener("play", () => { playing = true; window.__kbSinging = true; syncAll(); updateMediaSession(); });
    audio.addEventListener("pause", () => { playing = false; window.__kbSinging = false; syncAll(); persist(); });
    let lastLine = -2;
    audio.addEventListener("loadedmetadata", () => syncAll());
    audio.addEventListener("timeupdate", () => {
      const line = lrcIndexAt(audio.currentTime || 0);
      if (line !== lastLine) { lastLine = line; emit(); }
      syncProgress();
      if (Math.floor(audio.currentTime || 0) % 3 === 0) persist();
    });
    return audio;
  }

  function streamCandidates(item) {
    // 网易外链接口已返回 404 HTML（废弃），Meting type=url 才是真音频——它排前面
    const list = [];
    if (item.stream) list.push(item.stream);
    if (item.id) {
      for (const base of apiSources().slice(0, 3)) {
        list.push(base + "?server=netease&type=url&id=" + item.id);
      }
      list.push("https://music.163.com/song/media/outer/url?id=" + item.id + ".mp3");
    }
    return list;
  }

  /* 只装载不播放（用于恢复现场） */
  function prepare(item, seekTo) {
    ensureAudio();
    playing = false;
    const url = streamCandidates(item)[0];
    if (!url) return;
    audio.src = url;
    if (seekTo > 0) {
      const jump = () => { try { audio.currentTime = seekTo; } catch (e) {} };
      if (audio.readyState >= 1) jump();
      else audio.addEventListener("loadedmetadata", jump, { once: true });
    }
    loadLrc(item).then(() => emit());
    syncAll();
  }

  async function play(item) {
    if (window.Ambient && window.Ambient.isRunning && window.Ambient.isRunning()) window.Ambient.toggle();
    ensureAudio();
    playing = false;
    emit();
    const candidates = streamCandidates(item);
    if (!candidates.length) throw new Error("拿不到播放地址");
    let lastErr = null;
    expectPlay = false; // 候选切换期间产生的 error 不算"播放中断"
    for (const url of candidates) {
      try {
        audio.removeAttribute("crossorigin");
        audio.src = url;
        await audio.play();
        window.__kbSinging = true;
        expectPlay = true; failStreak = 0;
        loadLrc(item).then(() => emit());
        emit();
        persist();
        updateMediaSession();
        return;
      } catch (e) { lastErr = e; }
    }
    window.__kbSinging = false;
    toast("《" + item.name + "》播放失败：" + (lastErr ? lastErr.message : "地址不可用"));
    throw new Error("播放失败：" + (lastErr ? lastErr.message : "所有地址都不可用"));
  }

  /* ---------- 歌词 ---------- */
  function parseLrc(text) {
    const out = [];
    const tagRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    for (const raw of text.replace(/\r/g, "").split("\n")) {
      tagRe.lastIndex = 0;
      const times = [];
      let m;
      while ((m = tagRe.exec(raw)) !== null) {
        const frac = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) / 1000 : 0;
        times.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac);
      }
      const content = raw.replace(tagRe, "").trim();
      if (!content) continue;
      (times.length ? times : [0]).forEach((t) => out.push({ t, text: content }));
    }
    return out.sort((a, b) => a.t - b.t);
  }

  async function loadLrc(item) {
    currentLrc = [];
    const artistFirst = (item.artist || "").split("/")[0].trim();
    const tries = [
      { track_name: item.name || "", artist_name: artistFirst },
      { track_name: item.name || "" },
    ];
    for (const qp of tries) {
      try {
        const res = await fetch("https://lrclib.net/api/search?" + new URLSearchParams(qp).toString());
        if (!res.ok) continue;
        const list = await res.json();
        const synced = list.find((d) => d.syncedLyrics) || list[0];
        if (synced && synced.syncedLyrics) { currentLrc = parseLrc(synced.syncedLyrics); renderLyricPanel(true); return; }
      } catch (e) { /* 下一种组合 */ }
    }
    for (const base of apiSources()) {
      try {
        if (!item.id) break;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(base + "?type=lrc&server=netease&id=" + encodeURIComponent(item.id), { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) continue;
        const text = (await res.text()).trim();
        if (!text || text.startsWith('{"error')) continue;
        if (text.startsWith("[") || text.includes("[00:")) { currentLrc = parseLrc(text); }
        else { const data = JSON.parse(text); currentLrc = parseLrc((Array.isArray(data) ? data[0] : data).lrc || ""); }
        if (currentLrc.length) { renderLyricPanel(true); return; }
      } catch (e) { /* 试下一个源 */ }
    }
    renderLyricPanel(true);
  }

  function lrcIndexAt(time) {
    let idx = -1;
    for (let i = 0; i < currentLrc.length; i++) {
      if (currentLrc[i].t <= time) idx = i;
      else break;
    }
    return idx;
  }

  /* ---------- 队列 / 播放控制 ---------- */
  async function loadPlaylist() {
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
        try { list = JSON.parse(cached); } catch (err4) { throw new Error("本地歌单缓存损坏"); }
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

  function reloadPlaylist() { queue = []; qi = -1; }

  async function playPlaylist() {
    const n = await loadPlaylist();
    await playIndex(0);
    return n;
  }

  async function playIndex(i, opts) {
    if (!queue[i]) return;
    qi = i;
    if (opts && opts.seekTo !== undefined && opts.autoplay === false) {
      prepare(queue[i], opts.seekTo);
      return;
    }
    await play(queue[i]);
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
    play(queue[qi]).catch(() => { if (auto) next(true); });
    return true;
  }

  function prev() {
    if (!queue.length) return false;
    if (mode === "random") qi = pickRandom();
    else qi = (qi - 1 + queue.length) % queue.length;
    play(queue[qi]).catch(() => {});
    return true;
  }

  function onEnded() {
    if (mode === "one") { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    next(true);
  }

  function cycleMode() {
    mode = MODES[(MODES.findIndex((m) => m.id === mode) + 1) % MODES.length].id;
    try { localStorage.setItem("mm_mode", mode); } catch (e) {}
    toast("播放模式：" + MODES.find((m) => m.id === mode).tip);
    syncAll();
  }

  function seek(frac) {
    if (!audio || !audio.duration) return;
    audio.currentTime = Math.min(audio.duration - 0.2, Math.max(0, frac * audio.duration));
    syncProgress();
  }

  function setVolume(v) {
    ensureAudio();
    audio.volume = Math.min(1, Math.max(0, v));
    try { localStorage.setItem("mm_volume", String(audio.volume)); } catch (e) {}
    const bar = document.querySelector(".gp-vol input");
    if (bar) bar.value = audio.volume;
  }

  function toggle() {
    if (!audio || !audio.src) return playPlaylist().catch(() => {});
    try {
      if (audio.paused) { audio.play(); playing = true; expectPlay = true; } else { audio.pause(); playing = false; expectPlay = false; }
    } catch (e) { /* ignore */ }
    emit();
  }

  function getState() {
    return {
      playing,
      current: queue[qi] || null,
      index: qi,
      total: queue.length,
      hasQueue: queue.length > 0,
      mode,
      volume: audio ? audio.volume : 0.9,
      duration: audio ? audio.duration || 0 : 0,
      time: audio ? audio.currentTime || 0 : 0,
      lrc: currentLrc,
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
  function on(fn) { listeners.add(fn); }

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
    queue = saved.queue;
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
      navigator.mediaSession.setActionHandler("play", () => toggle());
      navigator.mediaSession.setActionHandler("pause", () => toggle());
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
            <div class="gp-progress" id="gp-progress"><div class="gp-fill" id="gp-fill"></div><div class="gp-knob" id="gp-knob"></div></div>
            <span class="gp-time" id="gp-total">00:00</span>
          </div>
        </div>
        <div class="gp-right">
          <div class="gp-vol" id="gp-vol"><span class="gp-vol-ico">🔊</span><input type="range" min="0" max="1" step="0.01" value="0.9" aria-label="音量"></div>
          <button class="gp-btn" id="gp-queue-btn" title="播放队列">☰</button>
        </div>
      </div>`;
    document.body.appendChild(el);

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
        renderQueue();
        persist();
        return;
      }
      const row = e.target.closest("[data-i]");
      if (row) playIndex(+row.dataset.i).catch((err) => toast(err.message));
    });
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
    if (open) { renderQueue(); const s = $("gp-qsearch"); if (s) s.value = ""; }
  }

  function renderLyricPanel(force) {
    if (!lyricOpen || !barBuilt) return;
    const list = $("gp-lrc-list");
    const st = getState();
    if (!list) return;
    if (!currentLrc.length) {
      list.innerHTML = '<div class="gp-lrc-empty">这首暂时没有歌词（或还在加载）♪</div>';
      lastLrcIdx = -2;
      return;
    }
    if (!list.children.length || force || list.dataset.song !== (st.current ? st.current.id : "")) {
      list.dataset.song = st.current ? st.current.id : "";
      list.innerHTML = currentLrc.map((l, i) =>
        `<div class="gp-lrc-line" data-i="${i}">${esc(l.text)}</div>`).join("");
      lastLrcIdx = -2;
    }
    if (st.lrcLine !== lastLrcIdx) {
      lastLrcIdx = st.lrcLine;
      list.querySelectorAll(".gp-lrc-line.on").forEach((n) => n.classList.remove("on"));
      const cur = list.children[st.lrcLine];
      if (cur) {
        cur.classList.add("on");
        cur.scrollIntoView({ block: "center", behavior: "smooth" });
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
    $("gp-qcount").textContent = queue.length + " 首";
    list.innerHTML = shown.length ? shown.map(({ s, i }) => `
      <div class="gp-qrow${i === st.index ? " on" : ""}" data-i="${i}">
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
  }

  function syncPlayerBar(st) {
    if (!barBuilt) return;
    const btn = $("gp-toggle");
    if (btn) btn.textContent = st.playing ? "❚❚" : "▶";
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
    searchAndPlay, playPlaylist, loadPlaylist, reloadPlaylist, playIndex, next, prev, toggle,
    seek, setVolume, cycleMode, toast,
    getState, getQueue: () => queue.slice(), on, playlistId: CFG.playlistId,
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
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      if (e.key === "Escape") {
        const d = document.getElementById("gp-drawer");
        if (d && !d.hidden) { d.hidden = true; if (document.getElementById("gp-queue-btn")) document.getElementById("gp-queue-btn").classList.remove("on"); }
        document.activeElement.blur();
      }
      return;
    }
    if (e.key === "Escape") {
      const d = document.getElementById("gp-drawer");
      if (d && !d.hidden) { d.hidden = true; if (document.getElementById("gp-queue-btn")) document.getElementById("gp-queue-btn").classList.remove("on"); }
    }
    if (e.code === "Space") { e.preventDefault(); MikuMusic.toggle(); }
    else if (e.key === "ArrowLeft" && window.MikuMusic.getState().hasQueue) { e.preventDefault(); MikuMusic.seek(Math.max(0, (MikuMusic.getState().time - 5) / Math.max(1, MikuMusic.getState().duration))); }
    else if (e.key === "ArrowRight" && window.MikuMusic.getState().hasQueue) { e.preventDefault(); MikuMusic.seek(Math.min(1, (MikuMusic.getState().time + 5) / Math.max(1, MikuMusic.getState().duration))); }
  });
});

/* ---------- 悬浮音乐钮 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const fab = document.getElementById("fab-music");
  if (!fab || !window.MikuMusic) return;
  const sync = (st) => { fab.textContent = st.playing ? "❚❚" : "♪"; };
  document.addEventListener("mikumusic", (e) => sync(e.detail || {}));
  fab.addEventListener("click", () => window.MikuMusic.toggle());
  sync(window.MikuMusic.getState());
});
