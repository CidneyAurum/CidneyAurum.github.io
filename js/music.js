/* ============================================
   Miku 看板娘 + AI 多协议对话 + 音乐点播引擎
   AI 协议：OpenAI 兼容 / Google Gemini / Anthropic Claude（自选）
   播放：网易云官方直链优先 + Meting 兜底 + 歌单缓存
   ============================================ */
"use strict";

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

const MikuMusic = (function () {
  const CFG = {
    playlistId: "18205251703",
    publicApis: [
      "https://api.injahow.cn/meting/",
      "https://met.liiiu.cn/",
      "https://meting.qjqq.cn/api/",
      "https://api.wuenci.com/meting/api/",
    ],
  };

  let audio = null;
  let queue = [];
  let qi = -1;
  let playing = false;
  let currentLrc = [];
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

  function streamCandidates(item) {
    const list = [];
    if (item.id) list.push("https://music.163.com/song/media/outer/url?id=" + item.id + ".mp3");
    if (item.stream) list.push(item.stream);
    return list;
  }

  async function play(item) {
    if (window.Ambient && window.Ambient.isRunning && window.Ambient.isRunning()) window.Ambient.toggle();
    ensureAudio();
    playing = false;
    emit();
    const candidates = streamCandidates(item);
    if (!candidates.length) throw new Error("拿不到播放地址");
    let lastErr = null;
    for (const url of candidates) {
      try {
        audio.removeAttribute("crossorigin");
        audio.src = url;
        await audio.play();
        window.__kbSinging = true;
        loadLrc(item).then(() => emit());
        emit();
        return;
      } catch (e) { lastErr = e; }
    }
    window.__kbSinging = false;
    throw new Error("播放失败：" + (lastErr ? lastErr.message : "所有地址都不可用"));
  }

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
        if (synced && synced.syncedLyrics) { currentLrc = parseLrc(synced.syncedLyrics); return; }
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
        if (currentLrc.length) return;
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

  async function loadPlaylist() {
    if (queue.length) return queue.length;
    let fromCache = false;
    try {
      queue = normalize(await api("playlist", CFG.playlistId));
      try { localStorage.setItem("mm_playlist_cache", JSON.stringify(queue)); } catch (e) {}
    } catch (e) {
      let cached = null;
      try { cached = localStorage.getItem("mm_playlist_cache"); } catch (err) {}
      if (!cached) throw new Error("音乐接口全部失败，且本机没有历史歌单缓存");
      try { queue = JSON.parse(cached); } catch (err2) { throw new Error("本地歌单缓存损坏"); }
      fromCache = true;
    }
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

  /* ---------- 歌词横幅 + 弹出大字 ---------- */
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

  return {
    searchAndPlay, playPlaylist, loadPlaylist, reloadPlaylist, playIndex, next, toggle,
    getState, getQueue: () => queue.slice(), on, playlistId: CFG.playlistId,
    popLyric,
    lyricOverlay: { toggle: loToggle, open: () => setOverlay(true), close: () => setOverlay(false) },
  };
})();

window.MikuMusic = MikuMusic;

/* ---------- 悬浮音乐钮 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const fab = document.getElementById("fab-music");
  if (!fab || !window.MikuMusic) return;
  const sync = (st) => { fab.textContent = st.playing ? "❚❚" : "♪"; };
  document.addEventListener("mikumusic", (e) => sync(e.detail || {}));
  fab.addEventListener("click", () => window.MikuMusic.toggle());
  sync(window.MikuMusic.getState());
});

/* ---------- AI 多协议对话引擎 ---------- */
const AIChat = (function () {
  let history = [];

  function getSettings() {
    return {
      protocol: localStorage.getItem("kb_protocol") || "openai",
      base: (localStorage.getItem("kb_base") || "https://api.deepseek.com").replace(/\/+$/, ""),
      model: localStorage.getItem("kb_model") || "deepseek-chat",
      key: localStorage.getItem("kb_key") || "",
    };
  }

  const SYSTEM_PROMPT =
    "你是看板娘「Miku」，住在 CidneyAurum 的个人网站小窝里。性格元气可爱、偶尔傲娇。" +
    "用中文回复，每次 1~3 句话，亲切自然。你可以在回复里插入一个表情标记来做动作，" +
    "可用表情：比心、圈圈、脸红、前倾、唱歌、葱、QQ人，格式如【表情:比心】，每次最多一个，不必每句都带。" +
    "主人叫 CidneyAurum。如果被问到你是谁，就说你是这个网站的看板娘初音。";

  async function requestOpenAI(settings, messages) {
    const res = await fetch(settings.base + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.key },
      body: JSON.stringify({ model: settings.model, messages, temperature: 0.9 }),
    });
    if (!res.ok) throw new Error("API " + res.status + ": " + (await res.text()).slice(0, 120));
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "(空回复)";
  }

  async function requestGemini(settings, messages) {
    const system = messages.find((m) => m.role === "system");
    const contents = messages.filter((m) => m.role !== "system").map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const body = { contents, generationConfig: { temperature: 0.9, maxOutputTokens: 512 } };
    if (system) body.systemInstruction = { parts: [{ text: system.content }] };
    const res = await fetch(
      settings.base + "/v1beta/models/" + settings.model + ":generateContent?key=" + settings.key,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (!res.ok) throw new Error("Gemini " + res.status + ": " + (await res.text()).slice(0, 120));
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "(空回复)";
  }

  async function requestClaude(settings, messages) {
    const system = messages.find((m) => m.role === "system");
    const msgs = messages.filter((m) => m.role !== "system");
    const res = await fetch(settings.base + "/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": settings.key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: settings.model || "claude-sonnet-4-20250514",
        max_tokens: 512,
        system: system ? system.content : undefined,
        messages: msgs,
      }),
    });
    if (!res.ok) throw new Error("Claude " + res.status + ": " + (await res.text()).slice(0, 120));
    const data = await res.json();
    return data.content?.[0]?.text || "(空回复)";
  }

  async function askAI(messages) {
    const settings = getSettings();
    if (!settings.key) throw new Error("请先在设置里填 API Key");
    if (settings.protocol === "gemini") return requestGemini(settings, messages);
    if (settings.protocol === "claude") return requestClaude(settings, messages);
    return requestOpenAI(settings, messages);
  }

  return { getSettings, askAI, SYSTEM_PROMPT };
})();

