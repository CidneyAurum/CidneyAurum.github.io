/* Transparent whole-page lyrics, independently adapted from desktop overlay behavior.
   The shared music engine owns audio, lyric retrieval, and the only playback clock. */
(() => {
  "use strict";
  if (window.LyricStage) return;
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const settings = { enabled: true, effects: true };
  try {
    settings.enabled = localStorage.getItem("lyric_background_enabled") !== "0";
    settings.effects = localStorage.getItem("lyric_background_effects") !== "0";
  } catch (_) {}
  const lifecycle = new AbortController(), ghosts = new Map();
  const memory = { track: "", revision: 0, seen: new Set() };
  let layer, lines, current = null, display = "", source = null, groups = [], sample = null;
  let frame = 0, unsubscribe = null, engine = null, loopPending = false, phase = "idle", destroyed = false;
  const effectsOn = () => settings.effects && !media.matches;
  const save = (name, value) => { settings[name] = !!value; try { localStorage.setItem("lyric_background_" + name, value ? "1" : "0"); } catch (_) {} };
  const setText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
  const identity = song => song ? String(song.id || song.stream || song.name + "|" + song.artist) : "";
  const cjk = value => /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(value);
  const hash = value => [...value].reduce((sum, char) => (sum * 31 + char.codePointAt(0)) >>> 0, 7);
  const randomFor = value => {
    let seed = hash(value);
    return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  };

  function ensureLayer() {
    if (destroyed) return false;
    if (!layer?.isConnected) layer = document.querySelector("[data-lyric-backdrop]") || document.getElementById("lyric-backdrop");
    if (!layer) {
      layer = document.createElement("div"); layer.id = "lyric-backdrop"; layer.className = "lyric-backdrop";
      layer.setAttribute("data-lyric-backdrop", "");
    }
    if (layer.parentNode !== document.body) document.body.appendChild(layer);
    layer.setAttribute("aria-hidden", "true");
    // This surface never owns input or changes the document's scroll/focus state.
    Object.assign(layer.style, { position: "fixed", inset: "0", pointerEvents: "none", background: "transparent", overflow: "hidden" });
    lines = layer.querySelector("[data-bg-lines]");
    if (!lines) { lines = document.createElement("div"); lines.className = "bg-lyric-lines"; lines.setAttribute("data-bg-lines", ""); layer.appendChild(lines); }
    return true;
  }
  function groupLyrics(value) {
    const byTime = new Map();
    for (const item of Array.isArray(value) ? value : []) {
      const t = Number(item?.t);
      if (!Number.isFinite(t) || t < 0 || typeof item.text !== "string") continue;
      const key = Math.round(t * 1000), content = item.text.trim();
      if (!byTime.has(key)) byTime.set(key, { key, time: key / 1000, texts: [] });
      const group = byTime.get(key);
      if (content && !group.texts.includes(content)) group.texts.push(content);
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }
  function dropGhost(node) { clearTimeout(ghosts.get(node)); ghosts.delete(node); node.remove(); }
  function clearGhosts() { [...ghosts.keys()].forEach(dropGhost); }
  function freezeCue(node) {
    node?.querySelectorAll(".bg-lyric-char").forEach(char => { char.style.animation = "none"; char.style.opacity = "1"; });
  }
  function clearWords() {
    clearGhosts(); if (lines?.childNodes.length) lines.replaceChildren(); current = null; display = "";
    if (layer) { layer.hidden = true; layer.removeAttribute("data-cue-time"); }
    document.body.classList.remove("has-background-lyrics");
  }
  function makeGhost(node) {
    if (!node) return;
    freezeCue(node); node.classList.remove("is-current"); node.classList.add("is-ghost");
    const timeout = setTimeout(() => dropGhost(node), 680);
    ghosts.set(node, timeout);
    while (ghosts.size > 3) dropGhost(ghosts.keys().next().value);
  }
  function paintedBounds(node) {
    const bounds = node.getBoundingClientRect();
    let left = bounds.left, top = bounds.top, right = bounds.right, bottom = bounds.bottom;
    // The row baseline rotates while each glyph counter-rotates. Measuring just
    // the outer cue misses the visible text that extends beyond that rectangle.
    node.querySelectorAll(".bg-lyric-char").forEach(glyph => {
      const rect = glyph.getBoundingClientRect();
      left = Math.min(left, rect.left); top = Math.min(top, rect.top);
      right = Math.max(right, rect.right); bottom = Math.max(bottom, rect.bottom);
    });
    return { left: left - 3, top: top - 3, right: right + 3, bottom: bottom + 3, width: right - left + 6, height: bottom - top + 6 };
  }
  function placeCue(node, group) {
    const w = innerWidth, h = innerHeight, small = w < 680;
    const seed = memory.track + "|" + group.key, random = randomFor(seed);
    const margin = small ? 18 : Math.max(30, Math.hypot(w, h) * .03);
    const availableW = Math.max(1, w - margin * 2), availableH = Math.max(1, h - margin * 2);
    const maxWidth = Math.min(small ? availableW : w * .68, availableW);
    let size = small ? Math.max(24, Math.min(32, w / 13)) : 37;
    node.dataset.position = seed;
    node.style.left = "0px"; node.style.top = "0px"; node.style.maxWidth = maxWidth + "px";
    node.style.setProperty("--lyric-angle", (random() * 20 - 10).toFixed(2) + "deg");
    node.style.setProperty("--lyric-size", size + "px");
    let bounds = paintedBounds(node);
    // Very long unbroken Latin tokens should wrap rather than spill outwards.
    if (bounds.width > availableW) {
      node.querySelectorAll(".bg-lyric-word").forEach(word => { word.style.maxWidth = "100%"; word.style.whiteSpace = "normal"; });
      bounds = paintedBounds(node);
    }
    for (let pass = 0; pass < 3; pass++) {
      const fit = Math.min(1, availableW / bounds.width, availableH * .72 / bounds.height);
      if (fit > .995 || size <= 12) break;
      size = Math.max(12, size * fit * .98);
      node.style.setProperty("--lyric-size", size + "px"); bounds = paintedBounds(node);
    }
    const occupied = [...ghosts.keys()].filter(ghost => ghost.isConnected).map(paintedBounds);
    let best = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const left = Math.max(margin, Math.min(w * (.05 + random() * .8), w - margin - bounds.width));
      const top = Math.max(margin, Math.min(h * (.05 + random() * .7), h - margin - bounds.height));
      const rect = { left, top, right: left + bounds.width, bottom: top + bounds.height };
      const overlap = occupied.reduce((sum, prior) => sum + Math.max(0, Math.min(rect.right + 16, prior.right) - Math.max(rect.left - 16, prior.left)) * Math.max(0, Math.min(rect.bottom + 16, prior.bottom) - Math.max(rect.top - 16, prior.top)), 0);
      if (!best || overlap < best.overlap) best = { left, top, overlap };
      if (!overlap) break;
    }
    node.style.left = best.left - bounds.left + "px";
    node.style.top = best.top - bounds.top + "px";
  }
  function createCue(group, index, animate) {
    const cue = document.createElement("div");
    cue.className = "bg-lyric-cue is-current " + (cjk(group.texts.join("")) ? "is-cjk" : "is-latin");
    cue.dataset.cueTime = String(group.time);
    const next = groups[index + 1], count = Math.max(1, [...group.texts.join("\n")].length);
    const interval = next ? Math.max(30, ((next.time - group.time > 16 ? 5000 : (next.time - group.time) * 1000 - 4000)) / count) : 50;
    cue.style.setProperty("--reveal-ms", interval + "ms");
    let charIndex = 0;
    group.texts.forEach((value, rowIndex) => {
      const row = document.createElement("p");
      row.className = "bg-lyric-row " + (cjk(value) ? "is-cjk" : "is-latin") + (rowIndex ? " bg-lyric-translation" : "");
      for (const chunk of cjk(value) ? [...value] : value.split(/(\s+)/)) {
        const word = document.createElement("span"); word.className = "bg-lyric-word";
        if (!cjk(value) && !/^\s+$/.test(chunk)) { word.style.display = "inline-block"; word.style.whiteSpace = "nowrap"; }
        for (const character of [...chunk]) {
          const glyph = document.createElement("span"); glyph.className = "bg-lyric-char"; glyph.textContent = character;
          glyph.style.setProperty("--char-index", String(charIndex));
          glyph.style.setProperty("--jitter-x", ((group.key + charIndex * 7) % 5 - 2) + "px");
          glyph.style.setProperty("--jitter-y", ((group.key + charIndex * 11) % 5 - 2) + "px");
          if (!animate) { glyph.style.animation = "none"; glyph.style.opacity = "1"; }
          word.appendChild(glyph); charIndex++;
        }
        row.appendChild(word);
      }
      cue.appendChild(row);
    });
    // A hidden overlay has no measurable bounds, so reveal its transparent
    // surface before measuring the first cue after loading, seeking, or toggling.
    layer.hidden = false;
    lines.appendChild(cue); placeCue(cue, group, index); return cue;
  }
  function describe(state, index) {
    if (!settings.enabled) return ["disabled", "背景歌词已关闭"];
    if (!state.current) return ["idle", "从歌单选择一首歌，背景歌词会自动同步"];
    if (state.lrcStatus === "loading") return ["loading", "同步歌词加载中"];
    if (state.lrcStatus === "unavailable") return ["unavailable", "暂无可用的同步歌词，可重试歌词"];
    if (state.lrcStatus !== "ready") return ["waiting", state.playing ? "正在准备同步歌词" : "音乐已暂停"];
    if (index < 0) return ["intro", state.playing ? "前奏 · 等待第一句" : "音乐已暂停 · 前奏"];
    if (!groups[index].texts.length) return [index === 0 ? "intro" : "interlude", state.playing ? "间奏" : "音乐已暂停 · 间奏"];
    return ["lyric", state.playing ? "背景歌词演出中" : "音乐已暂停 · 歌词已定格"];
  }
  function syncControls(state, message) {
    for (const selector of ["#home-lyrics-button", "#gp-background-btn"]) {
      const control = document.querySelector(selector);
      if (!control) continue;
      control.setAttribute("aria-pressed", String(settings.enabled));
      control.setAttribute("aria-label", settings.enabled ? "关闭背景歌词演出" : "开启背景歌词演出");
      control.title = (settings.enabled ? "关闭背景歌词 · " : "开启背景歌词 · ") + message;
    }
    setText(document.getElementById("lyric-backdrop-status"), message);
    const retry = document.getElementById("lyric-backdrop-retry");
    if (retry) retry.hidden = !settings.enabled || state.lrcStatus !== "unavailable" || typeof engine?.retryLyrics !== "function";
  }
  function render(state, quiet = false) {
    if (!ensureLayer()) return;
    const track = identity(state.current), revision = Number(state.selectionRevision) || 0;
    const t = Math.max(0, Number(state.time) || 0), now = performance.now();
    if (track !== memory.track || revision !== memory.revision) {
      loopPending = track === memory.track && revision !== memory.revision && state.lrcStatus === "ready" && t < .3;
      memory.track = track; memory.revision = revision; memory.seen.clear(); clearWords(); source = null; sample = null;
    }
    if (source !== state.lrc) { source = state.lrc; groups = groupLyrics(state.lrc); }
    let index = -1;
    for (let i = 0; i < groups.length && groups[i].time <= t; i++) index = i;
    const [nextPhase, message] = describe(state, index); phase = nextPhase;
    layer.dataset.lyricState = phase;
    layer.classList.toggle("effects-off", !effectsOn()); layer.classList.toggle("is-paused", !state.playing);
    syncControls(state, message);
    const jump = !!state.seeking || !!sample && (t < sample.time - .15 || Math.abs(t - sample.time) > Math.max(.8, (now - sample.wall) / 1000 + .4));
    const skipped = !!sample && sample.index >= 0 && index > sample.index + 1;
    if (!settings.enabled || phase !== "lyric" || document.hidden) clearWords();
    else {
      const group = groups[index], key = group.key + "|" + group.texts.join("\n");
      const waitingLoop = loopPending && (!state.playing || state.seeking), freshLoop = loopPending && !waitingLoop;
      if (jump || skipped) { clearGhosts(); freezeCue(current); }
      if (display !== key || freshLoop) {
        const animate = !!state.playing && effectsOn() && !quiet && (!jump || freshLoop) && !skipped && !memory.seen.has(group.key) && !waitingLoop;
        const prior = current;
        if (prior) {
          if (animate && Number(prior.dataset.cueTime) !== group.time) makeGhost(prior);
          else prior.remove();
        }
        current = createCue(group, index, animate); display = key;
      }
      if (!state.playing) { clearGhosts(); freezeCue(current); }
      if (!waitingLoop) { memory.seen.add(group.key); loopPending = false; }
      layer.hidden = false; layer.dataset.cueTime = String(group.time);
      document.body.classList.add("has-background-lyrics");
    }
    sample = { time: t, wall: now, index };
  }
  function update(quiet = false) {
    if (destroyed || !engine) return;
    const state = engine.getState(); render(state, quiet === true);
    if (state.playing && settings.enabled && !document.hidden && !frame) frame = requestAnimationFrame(tick);
    else if ((!state.playing || !settings.enabled || document.hidden) && frame) { cancelAnimationFrame(frame); frame = 0; }
  }
  function tick() { frame = 0; update(); }
  function mount() {
    if (!ensureLayer()) return;
    if (!engine && window.MikuMusic?.on) { engine = window.MikuMusic; unsubscribe = engine.on(() => update()); }
    update(true);
  }
  function setEnabled(enabled) { save("enabled", enabled); if (!enabled) clearWords(); update(true); }
  function setEffects(enabled) { save("effects", enabled); clearGhosts(); freezeCue(current); update(true); }
  async function retryLyrics() { try { return await engine?.retryLyrics?.(); } catch (_) { setText(document.getElementById("lyric-backdrop-status"), "歌词暂时没有找到，可稍后再试。"); return false; } }
  function destroy() {
    destroyed = true; cancelAnimationFrame(frame); frame = 0; unsubscribe?.(); unsubscribe = null;
    lifecycle.abort(); clearWords(); media.removeEventListener("change", motionChange);
  }
  const motionChange = () => { clearGhosts(); freezeCue(current); update(true); };
  media.addEventListener("change", motionChange);
  document.addEventListener("click", event => {
    if (event.target.closest?.("#home-lyrics-button,#gp-background-btn")) setEnabled(!settings.enabled);
    if (event.target.closest?.("#lyric-backdrop-retry")) retryLyrics();
  }, { signal: lifecycle.signal });
  document.addEventListener("visibilitychange", () => { clearGhosts(); freezeCue(current); update(true); }, { signal: lifecycle.signal });
  document.addEventListener("pjax:complete", () => update(), { signal: lifecycle.signal });
  window.addEventListener("resize", () => {
    if (current && sample && groups[sample.index]) placeCue(current, groups[sample.index], sample.index);
  }, { signal: lifecycle.signal });
  window.LyricStage = {
    mount, destroy, enable: () => setEnabled(true), disable: () => setEnabled(false), close: () => setEnabled(false), toggle: () => setEnabled(!settings.enabled),
    setEffects, retryLyrics,
    getState: () => ({ mounted: !!layer?.isConnected && !destroyed, enabled: settings.enabled, effects: effectsOn(), phase, track: memory.track, revision: memory.revision, ghosts: ghosts.size }),
  };
  if (typeof onPageReady === "function") { onPageReady(mount); if (document.readyState !== "loading") mount(); }
  else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true }); else mount();
})();
