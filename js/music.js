/* ============================================
   Miku 点播 · 网易云音乐搜索与播放
   - 搜索/取链：Meting 协议公共源，多源轮询自动换源
   - 播放：自建 <audio>，暂停/下一首/队列可控
   - 口型：播放时把音量电平写到 window.__kbMouth，看板娘渲染循环每帧读取驱动嘴巴
   - 可选自建 API（VIP 全曲）：设置里填 Meting 格式自建源即可优先使用
   ============================================ */
"use strict";

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
  let queue = [];        // [{name, artist, id}]
  let qi = -1;           // 当前播放索引
  let playing = false;
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
        if (!res.ok) { errors.push(base + " -> " + res.status); continue; }
        const data = await res.json();
        const ok = Array.isArray(data) ? data.length > 0 : !!data;
        if (ok) return data;
        errors.push(base + " -> 空结果");
      } catch (e) {
        errors.push(base + " -> " + e.message);
      }
    }
    throw new Error("音乐源全部失败（" + errors.length + " 个源都试过了）");
  }

  /* ---------- 播放核心 ---------- */
  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.addEventListener("ended", () => next(true));
    audio.addEventListener("play", () => { playing = true; emit(); });
    audio.addEventListener("pause", () => { playing = false; emit(); });
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
      // 音频图创建失败（比如 CORS）就只播放不同步口型
      mouthRaf = 0;
    }
  }
  function stopMouth() {
    if (mouthRaf) cancelAnimationFrame(mouthRaf);
    mouthRaf = 0;
    window.__kbMouth = 0;
  }

  async function play(item) {
    if (window.Ambient && window.Ambient.isRunning && window.Ambient.isRunning()) {
      window.Ambient.toggle(); // 电台让位
    }
    ensureAudio();
    playing = false;
    emit();
    const data = await api("url", item.id);
    const url = (Array.isArray(data) ? data[0] : data).url;
    if (!url) throw new Error("这首歌暂时拿不到播放地址（可能是 VIP 或版权限制）");
    audio.src = url;
    await audio.play();
    startMouth();
    emit();
  }

  /* ---------- 对外能力 ---------- */
  async function searchAndPlay(name) {
    const list = await api("search", name);
    const songs = list
      .map((s) => ({ name: s.name || s.title || "未知", artist: s.artist || s.artists || "", id: String(s.url || s.id) }))
      .filter((s) => s.id && s.id !== "[object Object]");
    if (!songs.length) throw new Error("没搜到「" + name + "」这首歌");
    queue = songs.slice(0, 15);
    qi = 0;
    await play(queue[0]);
    return queue[0];
  }

  async function playPlaylist() {
    const list = await api("playlist", CFG.playlistId);
    queue = list
      .map((s) => ({ name: s.name || s.title || "未知", artist: s.artist || s.artists || "", id: String(s.url || s.id) }))
      .filter((s) => s.id);
    if (!queue.length) throw new Error("歌单读取失败了");
    qi = 0;
    await play(queue[0]);
    return queue.length;
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
    };
  }
  function emit() {
    const st = getState();
    listeners.forEach((fn) => { try { fn(st); } catch (e) {} });
    document.dispatchEvent(new CustomEvent("mikumusic", { detail: st }));
  }
  function on(fn) { listeners.add(fn); }

  return { searchAndPlay, playPlaylist, next, toggle, getState, on, playlistId: CFG.playlistId };
})();

window.MikuMusic = MikuMusic;
