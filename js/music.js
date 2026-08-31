/* ============================================
   Miku 点播 · 网易云音乐搜索与播放（干净重写版）
   播放地址优先级：
     ① 网易云官方直链（免费歌官方直出，不依赖第三方）
     ② Meting 源返回的流链接（兜底）
   歌单：接口成功后缓存到 localStorage，接口全挂也能用缓存列表
   歌词：Meting lrc → lrclib.net 兜底
   口型：window.__kbSinging 标志驱动（跨域音频也能动嘴）
   ============================================ */
"use strict";

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

const MikuMusic = (function () {
  const CFG = {
    playlistId: "18205251703", // ✏️ 你的网易云歌单 ID
    publicApis: [
      "https://api.injahow.cn/meting/",
      "https://met.liiiu.cn/",
      "https://meting.qjqq.cn/api/",
      "https://api.wuenci.com/meting/api/",
    ],
  };

  let audio = null;
  let queue = [];        // [{name, artist, id, stream, pic}]
  let qi = -1;
  let playing = false;
  let currentLrc = [];   // [{t, text}]
  const listeners = new Set();

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0");
  }

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
        const res = await fetch(base + "?type=" + type + "&server=netease&id=" + encodeURIComponent(id), {
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) { errors.push(res.status); continue; }
        const text = await res.text();
        if (!text.trim()) { errors.push("empty"); continue; }
        const data = JSON.parse(text);
        const ok = Array.isArray(data) ? data.length > 0 : !!data;
        if (ok) return data;
        errors.push("empty");
      } catch (e) {
        errors.push(e.name);
      }
    }
    throw new Error("音乐接口全部失败（已尝试 " + apiSources().length + " 个源）");
  }

  /* Meting 条目 → 统一格式 */
  function normalize(list) {
    return (list || [])
      .map((s) => {
        const raw = String(s.url || "");
        const m = raw.match(/[?&]id=(\d+)/);
        return {
          name: s.name || s.title || "未知",
          artist: s.artist || s.artists || "",
          id: m ? m[1] : String(s.id || ""),
          stream: /^https?:\/\//.test(raw) ? raw : "",
          pic: s.pic || "",
        };
      })
      .filter((s) => s.id || s.stream);
  }

  /* ---------- 播放核心 ---------- */
  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.addEventListener("ended", () => { window.__kbSinging = false; next(true); });
    audio.addEventListener("play", () => { playing = true; window.__kbSinging = true; emit(); });
    audio.addEventListener("pause", () => { playing = false; window.__kbSinging = false; emit(); });
    let lastLine = -2;
    audio.addEventListener("loadedmetadata", () => {
      const tot = document.querySelector(".js-mm-total");
      if (tot && audio.duration) tot.textContent = fmt(audio.duration);
    });
    audio.addEventListener("timeupdate", () => {
      const line = lrcIndexAt(audio.currentTime || 0);
      if (line !== lastLine) { lastLine = line; emit(); }
      const fill = document.querySelector(".js-mm-fill");
      if (fill && audio.duration) fill.style.width = (audio.currentTime / audio.duration) * 100 + "%";
      const cur = document.querySelector(".js-mm-cur");
      if (cur) cur.textContent = fmt(audio.currentTime);
    });
    return audio;
  }

  /* 播放地址候选：官方直链优先，Meting 流链接兜底 */
  function streamCandidates(item) {
    const list = [];
    if (item.id) list.push("https://music.163.com/song/media/outer/url?id=" + item.id + ".mp3");
    if (item.stream) list.push(item.stream);
    return list;
  }

  async function play(item) {
    if (window.Ambient && window.Ambient.isRunning && window.Ambient.isRunning()) {
      window.Ambient.toggle(); // 电台让位
    }
    ensureAudio();
    playing = false;
    emit();
    const candidates = streamCandidates(item);
    if (!candidates.length) throw new Error("拿不到播放地址（可能是 VIP 或版权限制）");
    let lastErr = null;
    for (const url of candidates) {
      try {
        audio.removeAttribute("crossorigin"); // 直连最稳；口型由唱歌标志驱动，不依赖音频分析
        audio.src = url;
        await audio.play();
        window.__kbSinging = true;
        window.__lrcTrace && window.__lrcTrace.push("play ok, 调用 loadLrc");
        loadLrc(item).then(() => emit()).catch((e) => { window.__lrcTrace && window.__lrcTrace.push("loadLrc threw: " + e.message); });
        emit();
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    window.__kbSinging = false;
    const hint = lastErr && lastErr.name === "NotSupportedError" ? "（歌曲可能是 VIP 或已下架）" : "";
    throw new Error("播放失败" + hint + "：" + (lastErr ? lastErr.message : "所有地址都不可用"));
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
    window.__lrcTrace = ["called with: " + (item ? item.name + " id=" + item.id : "null-item")];
    currentLrc = [];
    // ① lrclib.net 优先（稳定、开放、无需 Key）
    const artistFirst = (item.artist || "").split("/")[0].trim();
    const tries = [
      { track_name: item.name || "", artist_name: artistFirst },
      { track_name: item.name || "" },
    ];
    for (const q of tries) {
      try {
        const res = await fetch("https://lrclib.net/api/search?" + new URLSearchParams(q).toString());
        if (res.ok) {
          const list = await res.json();
          const synced = list.find((d) => d.syncedLyrics) || list[0];
          if (synced && synced.syncedLyrics) {
          currentLrc = parseLrc(synced.syncedLyrics);
          window.__lrcTrace.push("lrclib parsed " + currentLrc.length + " 行");
          return;
        }
        }
      } catch (e) { /* 下一种组合 */ }
    }
    // ② Meting 源 lrc（有的返回原始 LRC 文本，有的返回 JSON）
    for (const base of apiSources()) {
      try {
        if (!item.id) break;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(base + "?type=lrc&server=netease&id=" + encodeURIComponent(item.id), {
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) continue;
        const text = (await res.text()).trim();
        if (!text || text.startsWith("{\"error")) continue;
        if (text.startsWith("[") || text.includes("[00:")) {
          currentLrc = parseLrc(text);
        } else {
          const data = JSON.parse(text);
          currentLrc = parseLrc((Array.isArray(data) ? data[0] : data).lrc || "");
        }
        if (currentLrc.length) {
          window.__lrcTrace.push("meting lrc " + currentLrc.length + " 行");
          return;
        }
      } catch (e) { /* 试下一个源 */ }
    }
  }

  function lrcIndexAt(time) {
    let idx = -1;
    for (let i = 0; i < currentLrc.length; i++) {
      if (currentLrc[i].t <= time) idx = i;
      else break;
    }
    return idx;
  }

  /* ---------- 对外能力 ---------- */
  async function searchAndPlay(name) {
    // ① 先确保歌单已加载（本地 107 首）
    if (!queue.length) {
      try { await loadPlaylist(); } catch (e) { /* 歌单加载失败继续尝试在线搜索 */ }
    }
    // ② 在已加载歌单里模糊匹配
    if (queue.length) {
      const key = name.toLowerCase();
      const matched = queue.filter((s) => (s.name + " " + s.artist).toLowerCase().includes(key));
      if (matched.length) {
        queue = matched.concat(queue.filter((q) => !matched.some((m) => m.id === q.id)));
        qi = 0;
        await play(queue[0]);
        return queue[0];
      }
    }
    // ③ 在线搜索（部分源支持）
    let songs = [];
    try { songs = normalize(await api("search", name)); } catch (e) {}
    if (songs.length) {
      queue = songs.concat(queue.filter((q) => !songs.some((m) => m.id === q.id)));
      qi = 0;
      await play(queue[0]);
      return queue[0];
    }
    throw new Error("歌单里没找到「" + name + "」♪ 你可以在网易云 APP 里把这首歌加到歌单，或跟我说「播放歌单」听已有的");
  }

  async function loadPlaylist() {
    if (queue.length) return queue.length;
    // ① 仓库内置歌单快照（data/playlist.json，构建时快照，永不失败）
    try {
      const res = await fetch("data/playlist.json", { cache: "no-cache" });
      if (res.ok) {
        const data = await res.json();
        queue = (data.playlist || []).filter((s) => s.id);
      }
    } catch (e) { /* 落到接口 */ }
    // ② 仓库快照不存在时：Meting 接口 / 本地缓存
    if (!queue.length) {
      try {
        queue = normalize(await api("playlist", CFG.playlistId));
      } catch (e) {
        let cached = null;
        try { cached = localStorage.getItem("mm_playlist_cache"); } catch (err) {}
        if (!cached) throw new Error("歌单加载失败且无缓存");
        queue = JSON.parse(cached);
      }
    }
    if (!queue.length) throw new Error("歌单读取失败了");
    qi = -1;
    emit();
    // ③ 后台静默刷新（接口可用时更新缓存，失败不影响当前列表）
    api("playlist", CFG.playlistId).then((list) => {
      const fresh = normalize(list);
      if (fresh.length) {
        queue = fresh;
        try { localStorage.setItem("mm_playlist_cache", JSON.stringify(queue)); } catch (e) {}
        emit();
      }
    }).catch(() => {});
    return queue.length;
  }

  function reloadPlaylist() { queue = []; qi = -1; }

  async function playPlaylist() {
    const n = await loadPlaylist();
    await playIndex(0);
    return n;
  }

  async function playIndex(i) {
    if (!queue[i]) return;
    qi = i;
    await play(queue[i]);
  }

  function next(auto) {
    if (!queue.length) return false;
    qi = (qi + 1) % queue.length;
    play(queue[qi]).catch(() => { if (auto) next(true); });
    return true;
  }

  function toggle() {
    if (!audio || !audio.src) return playPlaylist().catch((e) => { window.__kbPlayErr = e.message; });
    try {
      if (audio.paused) { audio.play(); playing = true; } else { audio.pause(); playing = false; }
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
      lrc: currentLrc,
      lrcLine: audio ? lrcIndexAt(audio.currentTime || 0) : -1,
      time: audio ? audio.currentTime || 0 : 0,
    };
  }

  function emit() {
    const st = getState();
    listeners.forEach((fn) => { try { fn(st); } catch (e) {} });
    document.dispatchEvent(new CustomEvent("mikumusic", { detail: st }));
    try { lyricBarTick(); } catch (e) {}
    try { loTick(); } catch (e) {}
  }
  function on(fn) { listeners.add(fn); }

  /* ---------- 歌词横幅（音浪柱 + 逐字打字 + 弹出大字） ---------- */
  let lastBarLine = -2, typingTimer = 0, popTimer = 0;

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

  /* 界面弹出歌词 —— 1:1 复刻原版 effect.py：
     暖白字+金色描边 / 整行随机斜排 / 逐字打字机 / 每字持续抖动 / 随机位置 / 旧句上飘淡出 */
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

  /* ---------- 边狱巴士风格 · 全屏歌词演出浮层 ---------- */
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

  return {
    searchAndPlay, playPlaylist, loadPlaylist, reloadPlaylist, playIndex, next, toggle,
    getState, getQueue: () => queue.slice(), on, playlistId: CFG.playlistId,
    popLyric,
    lyricOverlay: { toggle: loToggle, open: () => setOverlay(true), close: () => setOverlay(false) },
  };
})();

window.MikuMusic = MikuMusic;
