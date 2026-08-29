/* ============================================
   环境电台 · Web Audio 合成氛围音乐 + 全站迷你播放器
   无需任何音频文件、无版权问题：
   - 低音 pad：锯齿波和弦 + 低通滤波 + 慢 LFO，每 9 秒换和弦
   - 高音闪烁：随机正弦泛音 + 回声延迟
   也支持选择本地音频文件替代合成音源
   ============================================ */
"use strict";

const Ambient = (function () {
  const CHORDS = [
    [110.0, 164.81, 261.63, 329.63],   // Am
    [87.31, 130.81, 220.0, 349.23],    // F
    [130.81, 196.0, 261.63, 392.0],    // C
    [98.0, 146.83, 220.0, 293.66],     // G
  ];
  const CHORD_SEC = 9;
  const SHIMMER_FREQS = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];

  let ctx = null, master = null, padBus = null, filter = null;
  let running = false, mode = "synth";
  let padVoices = [], chordIdx = 0, chordTimer = null, shimmerTimer = null, tickTimer = null;
  let elapsed = 0;
  let audioEl = null, fileTitle = "";

  function note(freq, when, dur, peak) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    osc.detune.value = (Math.random() - 0.5) * 9;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + dur * 0.4);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    osc.connect(g).connect(padBus);
    osc.start(when);
    osc.stop(when + dur + 0.2);
    padVoices.push(osc);
  }

  function playChord(i) {
    const t = ctx.currentTime;
    // 每个音用轻微错开的包络，更柔和
    CHORDS[i].forEach((f, k) => {
      note(f, t + k * 0.35, CHORD_SEC + 2.5, 0.05);
      note(f * 2, t + k * 0.35 + 0.15, CHORD_SEC + 2, 0.014); // 高八度薄薄一层
    });
  }

  function shimmer() {
    if (!ctx || mode !== "synth") return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = SHIMMER_FREQS[Math.floor(Math.random() * SHIMMER_FREQS.length)];
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.035, t + 1.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 4);
  }

  function buildGraph() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.0001;
    // 主输出加一点整体混响感（简单的反馈延迟）
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.42;
    const fb = ctx.createGain();
    fb.gain.value = 0.3;
    const wet = ctx.createGain();
    wet.gain.value = 0.25;
    master.connect(ctx.destination);
    master.connect(delay);
    delay.connect(fb).connect(delay);
    delay.connect(wet).connect(ctx.destination);

    filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 720;
    filter.Q.value = 0.6;
    padBus = ctx.createGain();
    padBus.gain.value = 1;
    padBus.connect(filter).connect(master);

    // 滤波器慢 LFO，让音色会"呼吸"
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.055;
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
  }

  function start() {
    if (mode === "file" && audioEl) {
      audioEl.play().catch(() => {});
      running = true;
      startTicker();
      sync();
      return;
    }
    if (!ctx) buildGraph();
    ctx.resume();
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 2.2);
    chordIdx = 0;
    playChord(chordIdx);
    chordTimer = setInterval(() => {
      chordIdx = (chordIdx + 1) % CHORDS.length;
      playChord(chordIdx);
    }, CHORD_SEC * 1000);
    shimmerTimer = setInterval(shimmer, 4200);
    running = true;
    startTicker();
    sync();
  }

  function stop() {
    if (mode === "file" && audioEl) audioEl.pause();
    if (ctx && master) {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 1.2);
    }
    clearInterval(chordTimer); chordTimer = null;
    clearInterval(shimmerTimer); shimmerTimer = null;
    running = false;
    stopTicker();
    sync();
  }

  function toggle() { running ? stop() : start(); }

  function setFile(file) {
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.addEventListener("ended", () => { running = false; stopTicker(); sync(); });
      audioEl.addEventListener("timeupdate", () => {
        if (mode === "file" && running) updateProgress(audioEl.currentTime, audioEl.duration || 0);
      });
    }
    mode = "file";
    fileTitle = file.name.replace(/\.[^.]+$/, "");
    if (running) stop();
    audioEl.src = URL.createObjectURL(file);
    start();
  }

  /* ---------- 进度与 UI 同步 ---------- */
  function startTicker() {
    stopTicker();
    tickTimer = setInterval(() => {
      elapsed += 1;
      if (mode === "synth") updateProgress(elapsed % (CHORDS.length * CHORD_SEC), CHORDS.length * CHORD_SEC);
    }, 1000);
  }
  function stopTicker() { clearInterval(tickTimer); tickTimer = null; }

  function fmt(s) {
    s = Math.max(0, Math.floor(s));
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }

  function updateProgress(cur, total) {
    const pct = total > 0 ? (cur / total) * 100 : 0;
    document.querySelectorAll(".js-progress-fill").forEach((el) => (el.style.width = pct + "%"));
    document.querySelectorAll(".js-time").forEach((el) => (el.textContent = fmt(cur)));
  }

  function sync() {
    document.body.classList.toggle("playing", running);
    document.querySelectorAll(".js-state").forEach((el) => (el.textContent = running ? "⏸" : "▶"));
    document.querySelectorAll(".js-label").forEach((el) => (el.textContent = running ? "暂停电台" : "播放电台"));
    const mini = document.querySelector(".mini-player");
    if (mini) mini.classList.toggle("show", running);
    if (mode === "file") {
      document.querySelectorAll(".js-player-title").forEach((el) => (el.textContent = fileTitle || "本地音乐"));
    } else {
      document.querySelectorAll(".js-player-title").forEach((el) => (el.textContent = "环境电台 · Ambient"));
    }
  }

  return { toggle, setFile, isRunning: () => running };
})();

/* ---------- 绑定页面上所有播放控件 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".js-play-toggle").forEach((btn) => {
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); Ambient.toggle(); });
  });
  const file = document.getElementById("player-file-input");
  if (file) {
    file.addEventListener("change", () => {
      if (file.files && file.files[0]) Ambient.setFile(file.files[0]);
    });
  }
});
