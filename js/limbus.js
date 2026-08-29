/* ============================================
   Limbus 风格 · 歌词演出模拟器（网页版）
   灵感致敬：Tempura3 / Limbus-Like-Lyric-Simulator
            YouRanCoder / LimbusLyricSimulator
   三种模式：手动（空格推进）/ 自动（定时）/ 音乐（本地音频 + LRC 同步）
   ============================================ */
"use strict";

(function () {
  const stage = document.getElementById("limbus-stage");
  if (!stage) return; // 非 Limbus 页面直接退出

  const area = document.getElementById("lyric-area");
  const input = document.getElementById("lyric-input");
  const btnNext = document.getElementById("btn-next");
  const btnReset = document.getElementById("btn-reset");
  const btnAuto = document.getElementById("btn-auto");
  const btnMusic = document.getElementById("btn-music");
  const audioFile = document.getElementById("audio-file");
  const audio = document.getElementById("limbus-audio");
  const speed = document.getElementById("speed-range");
  const audioState = document.getElementById("audio-state");
  const modeHint = document.getElementById("mode-hint");

  const SAMPLE = `在孤独的航路上 我们都是赶路的人
把昨天折成纸船 放进星海
风把故事吹散 又在梦里拼好
直面过去 创造未来
若黑夜足够长 就自己点火
纵身跃入 属于我们的黎明`;

  let lines = [];        // [{ time?: 秒, text }]
  let idx = -1;          // 当前句
  let mode = "manual";   // manual | auto | music
  let autoTimer = null;
  let parsedInput = null; // 已解析的歌词原文（避免重复解析重置进度）

  /* ---------- LRC / 纯文本解析 ---------- */
  function parseLyrics(raw) {
    const out = [];
    const tagRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      tagRe.lastIndex = 0;
      const times = [];
      let m;
      while ((m = tagRe.exec(line)) !== null) {
        const frac = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) / 1000 : 0;
        times.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac);
      }
      const text = line.replace(tagRe, "").trim();
      if (!text) continue;
      if (times.length) times.forEach((t) => out.push({ time: t, text }));
      else out.push({ text });
    }
    if (out.some((l) => l.time !== undefined)) {
      const timed = out.filter((l) => l.time !== undefined).sort((a, b) => a.time - b.time);
      return timed;
    }
    return out; // 纯文本：按行演出
  }

  /* ---------- 演出 ---------- */
  function renderLine(i) {
    const line = lines[i];
    if (!line) return;
    const idle = area.querySelector(".stage-idle");
    if (idle) idle.remove();
    // 旧句淡出
    const old = area.querySelector(".lyric-line:not(.prev)");
    if (old) {
      old.classList.add("prev");
      old.style.transition = "opacity .35s ease, transform .35s ease";
      old.style.opacity = "0";
      old.style.transform = "translateY(-26px)";
      setTimeout(() => old.remove(), 380);
    }
    // 红色斩击线
    const oldSlash = area.querySelector(".slash");
    if (oldSlash) oldSlash.remove();

    const el = document.createElement("div");
    el.className = "lyric-line";
    [...line.text].forEach((ch, k) => {
      const s = document.createElement("span");
      s.className = "char " + (k % 2 === 0 ? "in-left" : "in-right");
      s.style.animationDelay = (k % 2 === 0 ? 0 : 0.05) + k * 0.018 + "s";
      s.textContent = ch === " " ? "\u00A0" : ch;
      el.appendChild(s);
    });
    const everyThird = i % 3 === 2;
    if (everyThird) {
      el.classList.add("shake");
      const slash = document.createElement("div");
      slash.className = "slash go";
      area.appendChild(slash);
      stage.classList.remove("slam");
      void stage.offsetWidth; // 重启抖动动画
      stage.classList.add("slam");
    }
    area.appendChild(el);
    idx = i;
  }

  function next() {
    if (!lines.length) return;
    if (idx + 1 >= lines.length) {
      // 演出到结尾：谢幕
      renderEnd();
      return;
    }
    renderLine(idx + 1);
  }

  function renderEnd() {
    const end = document.createElement("div");
    end.className = "lyric-line";
    end.style.fontSize = "clamp(18px, 3vw, 30px)";
    end.style.letterSpacing = "0.5em";
    end.style.color = "#d9b96c";
    end.textContent = "— FIN —";
    area.appendChild(end);
    idx = -1;
  }

  function reset() {
    stopAuto();
    if (audio && !audio.paused) audio.pause();
    idx = -1;
    area.innerHTML = '<div class="stage-idle">— LYRIC SIMULATOR —</div>';
  }

  /* ---------- 模式 ---------- */
  function stopAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    btnAuto && btnAuto.classList.remove("on");
    if (btnAuto) btnAuto.textContent = "⏱ 自动演出";
  }

  // 解析歌词（仅在内容变化时重新解析并重置进度，避免重复点击回到第一句）
  function ensureParsed() {
    if (parsedInput !== input.value) {
      lines = parseLyrics(input.value);
      parsedInput = input.value;
      idx = -1;
    }
    return lines.length > 0;
  }

  btnNext && btnNext.addEventListener("click", () => { if (ensureParsed()) next(); });
  btnReset && btnReset.addEventListener("click", reset);

  btnAuto && btnAuto.addEventListener("click", () => {
    if (!ensureParsed()) return;
    if (autoTimer) { stopAuto(); return; }
    if (audio && !audio.paused) audio.pause();
    mode = "auto";
    btnAuto.classList.add("on");
    btnAuto.textContent = "⏸ 停止自动";
    const sec = Math.max(0.5, parseFloat(speed.value) || 2.2);
    renderLine(0);
    autoTimer = setInterval(() => {
      if (idx + 1 >= lines.length) { stopAuto(); return; }
      renderLine(idx + 1);
    }, sec * 1000);
  });

  speed && speed.addEventListener("input", () => {
    if (autoTimer) {
      clearInterval(autoTimer);
      const sec = Math.max(0.5, parseFloat(speed.value) || 2.2);
      autoTimer = setInterval(() => {
        if (idx + 1 >= lines.length) { stopAuto(); return; }
        renderLine(idx + 1);
      }, sec * 1000);
    }
  });

  // 音乐模式：本地音频 + LRC 同步
  btnMusic && btnMusic.addEventListener("click", () => {
    if (!ensureParsed()) return;
    if (lines.every((l) => l.time === undefined)) {
      audioState.textContent = "⚠️ 音乐同步需要带 [mm:ss.xx] 时间轴的 LRC 歌词";
      return;
    }
    if (!audio.src) {
      audioState.textContent = "⚠️ 请先在下方选择一个本地音乐文件";
      return;
    }
    stopAuto();
    mode = "music";
    audio.currentTime = 0;
    audio.play().catch(() => (audioState.textContent = "⚠️ 浏览器阻止了自动播放，请再点一次"));
    audioState.textContent = "▶ 演出中… 时间轴同步已启动";
  });

  audioFile && audioFile.addEventListener("change", () => {
    const f = audioFile.files && audioFile.files[0];
    if (!f) return;
    audio.src = URL.createObjectURL(f);
    audioState.textContent = "🎵 已加载：" + f.name;
  });

  audio && audio.addEventListener("timeupdate", () => {
    if (mode !== "music" || !lines.length) return;
    const t = audio.currentTime;
    let target = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time !== undefined && lines[i].time <= t) target = i;
      else break;
    }
    if (target !== -1 && target !== idx) renderLine(target);
    if (audio.ended) renderEnd();
  });

  // 空格 / 点击舞台推进（手动与音乐模式通用）
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || !stage) return;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "BUTTON") return;
    e.preventDefault();
    if (ensureParsed()) next();
  });
  stage.addEventListener("click", (e) => {
    if (e.target.closest("button, input, a, textarea")) return;
    if (ensureParsed()) next();
  });

  // 预填示例
  if (input && !input.value) input.value = SAMPLE;
})();
