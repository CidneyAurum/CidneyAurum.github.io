/* ============================================
   Miku 点播 · 网易云音乐搜索与播放
   - 歌单：Meting 协议拉取（播放地址直接用源返回的流链接）
   - 点播：多源搜索，失败时在已加载歌单里模糊匹配
   - 口型：播放电平写入 window.__kbMouth，看板娘渲染循环每帧读取驱动嘴巴
   - 可选自建 API（VIP 全曲）：设置里填 Meting 格式自建源即可优先使用
   ============================================ */
"use strict";

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

const MikuMusic = (function () {
  const CFG = {
    playlistId: "18205251703", // ✏️ 你的网易云歌单 ID
    publicApis: [
      "https://api.injahow.cn/meting/",
      "https://meting.qjqq.cn/api/",
      "https://api.wuenci.com/meting/api/",
    ],
  };

  let audio = null;
  const fmt = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    return String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0");
  };
  let queue = [];        // [{name, artist, id, stream}]
  let qi = -1;
  let playing = false;
  let currentLrc = [];   // [{t, text}]
  const listeners = new Set();
  let mouthRaf = 0;

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
        const data = await res.json();
        const ok = Array.isArray(data) ? data.length > 0 : !!data;
        if (ok) return data;
        errors.push("empty");
      } catch (e) {
        errors.push(e.name);
      }
    }
    throw new Error("音乐源全部失败");
  }

  /* Meting 条目 → 统一格式（数字 id 从流链接里抠出来） */
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
    audio.addEventListener("ended", () => next(true));
    audio.addEventListener("play", () => { playing = true; emit(); });
    audio.addEventListener("pause", () => { playing = false; emit(); });
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

  function startMouth() {
    stopMouth();
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const src = ctx.createMediaElementSource(audio);
      src.connect(analyser);
      analyser.connect(ctx.destination);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!playing) { window.__kbMouth = 0; mouthRaf = 0; return; }
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
        window.__kbMouth = Math.min(1, peak * 2.2);
        mouthRaf = requestAnimationFrame(tick);
      };
      mouthRaf = requestAnimationFrame(tick);
    } catch (e) {
      mouthRaf = 0; // 音频图失败时降级为无口型播放
    }
  }
  function stopMouth() {
    if (mouthRaf) cancelAnimationFrame(mouthRaf);
    mouthRaf = 0;
    window.__kbMouth = 0;
  }

  /* 取一个能播的地址：优先源返回的流链接，其次按 id 再取一次 */
  async function resolveStream(item) {
    if (item.stream) return item.stream;
    const data = await api("url", item.id);
    const url = (Array.isArray(data) ? data[0] : data).url;
    if (!url) throw new Error("拿不到播放地址（可能是 VIP 或版权限制）");
    return url;
  }

  async function play(item) {
    if (window.Ambient && window.Ambient.isRunning && window.Ambient.isRunning()) {
      window.Ambient.toggle(); // 电台让位
    }
    ensureAudio();
    playing = false;
    emit();
    const stream = await resolveStream(item);
    // 先尝试带 CORS（口型同步可用），失败降级直连（牺牲口型保出声）
    try {
      audio.crossOrigin = "anonymous";
      audio.src = stream;
      await audio.play();
    } catch (e) {
      audio.removeAttribute("crossorigin");
      audio.src = stream;
      await audio.play();
    }
    startMouth();
    loadLrc(item).then(() => emit());
    emit();
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
    if (!item.id) return;
    // lrc 接口有的源返回原始 LRC 文本、有的返回 JSON（{lrc:"..."}），都兼容
    for (const base of apiSources()) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(base + "?type=lrc&server=netease&id=" + encodeURIComponent(item.id), {
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) continue;
        const text = (await res.text()).trim();
        if (!text || text.startsWith("{\"error")) continue;
        if (text.startsWith("[") || text.includes("[00:")) {
          currentLrc = parseLrc(text);   // 原始 LRC
        } else {
          const data = JSON.parse(text);
          const lrc = (Array.isArray(data) ? data[0] : data).lrc || "";
          currentLrc = parseLrc(lrc);
        }
        if (currentLrc.length) { emit(); return; }
      } catch (e) { /* 试下一个源 */ }
    }
    // ② lrclib.net 兜底（开放 API，无需 Key，支持 CORS）
    try {
      const q = new URLSearchParams({ track_name: item.name || "", artist_name: item.artist || "" });
      const res = await fetch("https://lrclib.net/api/search?" + q.toString());
      if (res.ok) {
        const list = await res.json();
        const synced = list.find((d) => d.syncedLyrics) || list[0];
        if (synced && synced.syncedLyrics) currentLrc = parseLrc(synced.syncedLyrics);
      }
    } catch (e) { /* 无歌词照常播 */ }
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
    let songs = [];
    try {
      const list = await api("search", name);
      songs = normalize(list);
    } catch (e) { /* 源不支持搜索就靠歌单匹配 */ }
    if (!songs.length && queue.length) {
      const key = name.toLowerCase();
      songs = queue.filter((s) => (s.name + " " + s.artist).toLowerCase().includes(key));
    }
    if (!songs.length) throw new Error("没找到「" + name + "」，换个歌名或说「播放歌单」试试");
    queue = songs.concat(queue.filter((q) => !songs.some((s) => s.id === q.id)));
    qi = 0;
    await play(queue[0]);
    return queue[0];
  }

  async function loadPlaylist() {
    if (queue.length) return queue.length;
    const list = await api("playlist", CFG.playlistId);
    queue = normalize(list);
    if (!queue.length) throw new Error("歌单读取失败了");
    qi = -1;
    emit();
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
    if (!audio || !audio.src) return playPlaylist();
    if (audio.paused) { audio.play(); playing = true; } else { audio.pause(); playing = false; }
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
    try { loTick(); } catch (e) {}
    try { lyricBarTick(); } catch (e) {}
  }
  function on(fn) { listeners.add(fn); }

  /* ---------- 歌词横幅（参考站布局：音浪柱 + 逐字打字 + 音符） ---------- */
  let lastBarLine = -2, typingTimer = 0;

  function lyricBarTick(force) {
    const bar = document.getElementById("lyric-bar");
    if (!bar) return;
    const st = getState();
    const textEl = bar.querySelector(".lb-text");
    if (!textEl) return;
    bar.classList.toggle("playing", !!st.playing);

    // 没有队列：显示提示
    if (!st.hasQueue) {
      if (textEl.dataset.mode !== "hint") {
        textEl.dataset.mode = "hint";
        clearInterval(typingTimer);
        textEl.textContent = "点歌单里的歌，或跟 Miku 说「放 歌名」♪";
      }
      return;
    }
    // 播放中：当前歌词逐字打出
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
      // 同步弹出：界面上以边狱巴士风格弹出大字歌词
      if (st.playing) popLyric(line, st.lrcLine);
    }
  }

  /* 界面弹出歌词 —— 1:1 复刻原版 effect.py：
     暖白字+金色描边 / 整行随机斜排 / 逐字打字机(100ms) / 每字持续抖动 / 随机位置 / 旧句上飘淡出 */
  let popTimer = 0;
  function popLyric(text, lineIdx) {
    let host = document.getElementById("lyric-pop-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "lyric-pop-host";
      host.className = "lyric-pop-host";
      document.body.appendChild(host);
    }
    // 旧句：向上飘走并淡出（可多句共存）
    host.querySelectorAll(".lyric-pop:not(.fading)").forEach((p) => {
      p.classList.add("fading");
      setTimeout(() => p.remove(), 1000);
    });

    const pop = document.createElement("div");
    pop.className = "lyric-pop";
    const angle = (Math.random() * 16 - 8).toFixed(1);           // 整行 ±8° 斜排
    pop.style.left = (12 + Math.random() * 46) + "%";             // 随机位置（视口中带）
    pop.style.top = (20 + Math.random() * 48) + "%";
    pop.style.transform = "rotate(" + angle + "deg)";
    host.appendChild(pop);

    // 逐字打字机（原版 100ms/字），每字带独立抖动
    const chars = [...text];
    let ci = 0;
    const typeTimer = setInterval(() => {
      ci++;
      const sp = document.createElement("span");
      sp.className = "lch";
      sp.style.animationDuration = (0.12 + Math.random() * 0.08).toFixed(2) + "s";
      sp.style.animationDelay = (Math.random() * 0.1).toFixed(2) + "s";
      sp.textContent = chars[ci - 1] === " " ? "\u00A0" : chars[ci - 1];
      pop.appendChild(sp);
      if (ci >= chars.length) clearInterval(typeTimer);
    }, 100);
    clearTimeout(popTimer);
    popTimer = setTimeout(() => clearInterval(typeTimer), chars.length * 100 + 120);
  }  /* ---------- 边狱巴士风格 · 歌词演出浮层 ---------- */
  let overlayBuilt = false, overlayOpen = false, lastLoLine = -2;
  let sessionLyricOff = sessionStorage.getItem("mm_lyric_off") === "1";

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
    el.querySelector(".lo-close").addEventListener("click", () => {
      sessionLyricOff = true;
      sessionStorage.setItem("mm_lyric_off", "1");
      setOverlay(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setOverlay(false);
    });
  }

  function setOverlay(open) {
    buildOverlay();
    overlayOpen = open;
    document.getElementById("lyric-overlay").classList.toggle("open", open);
    if (open) { lastLoLine = -2; loTick(true); }
    try { dbarTick(true); } catch (e) {}
  }
  function loToggle() { setOverlay(!overlayOpen); if (overlayOpen) sessionLyricOff = false; }

  function loRender(idx, name) {
    const area = document.getElementById("lo-area");
    if (!area) return;
    area.innerHTML = "";
    const stage = document.getElementById("lo-stage");
    stage.classList.remove("slam");
    document.querySelectorAll("#lo-area .slash").forEach((x) => x.remove());
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
    popLyric,  // 调试/测试用：手动弹出一行歌词
    lyricOverlay: { toggle: loToggle, open: () => setOverlay(true), close: () => setOverlay(false) },

  };
})();

window.MikuMusic = MikuMusic;
