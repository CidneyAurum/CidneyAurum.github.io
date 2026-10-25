/* One homepage performance, driven by the shared native-audio clock. */
(() => {
  "use strict";
  if (window.LyricStage) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const settings = { effects: true, expanded: false };
  try {
    settings.effects = localStorage.getItem("lyric_stage_effects") !== "0";
    settings.expanded = localStorage.getItem("lyric_stage_expanded") === "1";
  } catch (_) {}
  const save = (name, value) => { settings[name] = value; try { localStorage.setItem("lyric_stage_" + name, value ? "1" : "0"); } catch (_) {} };
  const memory = { track: "", revision: 0, seen: new Set() };
  let view = null, frame = 0, unsubscribe = null;
  const text = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
  const activeEffects = () => settings.effects && !reduced.matches;
  const clock = value => { const seconds = Math.max(0, Math.floor(Number(value) || 0)); return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0"); };
  const trackID = current => current ? String(current.id || current.stream || current.name + "|" + current.artist) : "";

  function groupLyrics(lines) {
    const groups = [];
    for (const line of Array.isArray(lines) ? lines : []) {
      const time = Number(line?.t);
      if (!Number.isFinite(time) || time < 0 || typeof line.text !== "string") continue;
      const key = Math.round(time * 1000), content = line.text.trim();
      let group = groups.find(item => item.key === key);
      if (!group) { group = { key, time: key / 1000, texts: [] }; groups.push(group); }
      if (content && !group.texts.includes(content)) group.texts.push(content);
    }
    groups.sort((a, b) => a.time - b.time);
    let ordinal = -1;
    for (const group of groups) { if (group.texts.length) ordinal++; group.ordinal = ordinal; }
    return groups;
  }
  function clearImpact() {
    if (!view) return;
    view.root.classList.remove("is-impact");
    view.slash?.classList.remove("is-active");
  }
  function freezeCurrentLine() {
    if (!view) return;
    clearImpact();
    view.lines.querySelectorAll(".ls-previous").forEach(node => node.remove());
    view.lines.querySelectorAll(".ls-char").forEach(node => { node.style.animation = "none"; node.style.transform = "none"; node.style.opacity = "1"; node.style.filter = "none"; });
  }
  function syncEffects() {
    if (!view) return;
    const enabled = activeEffects();
    view.root.classList.toggle("effects-off", !enabled);
    if (view.effects) {
      view.effects.setAttribute("aria-pressed", String(enabled));
      view.effects.disabled = reduced.matches;
      text(view.effects, reduced.matches ? "静态演出" : enabled ? "动效 开" : "动效 关");
      view.effects.title = reduced.matches ? "已遵循系统减少动态效果设置" : "切换歌词入场与斩击效果";
    }
    if (!enabled) freezeCurrentLine();
  }
  function syncAnimations(playing) {
    if (!view || view.animationPlaying === playing) return;
    view.animationPlaying = playing;
    if (playing) {
      view.pausedAnimations.forEach(animation => { try { if (animation.playState === "paused") animation.play(); } catch (_) {} });
      view.pausedAnimations.clear();
    } else {
      // Pause on a readable frame instead of leaving late-arriving glyphs invisible.
      freezeCurrentLine();
      for (const animation of view.root.getAnimations?.({ subtree: true }) || []) {
        if (animation.playState === "running") { try { animation.pause(); view.pausedAnimations.add(animation); } catch (_) {} }
      }
    }
  }
  function showMessage(kind, message, status) {
    if (!view) return;
    view.root.dataset.stageState = kind;
    text(view.status, status);
    const key = "message|" + kind;
    if (view.display !== key) {
      view.display = key;
      clearImpact();
      const line = document.createElement("p"); line.className = "ls-idle"; line.textContent = message;
      view.lines.replaceChildren(line);
      view.root.removeAttribute("data-stage-cue");
      text(view.live, status);
    }
  }
  function showCue(group, animate) {
    const key = "cue|" + group.key + "|" + group.texts.join("\n");
    view.root.dataset.stageState = "lyric";
    view.root.dataset.stageCue = String(group.time);
    if (view.display === key) return;
    const prior = animate ? view.lines.querySelector(".ls-line:not(.ls-previous)") : null;
    view.display = key;
    clearImpact();
    const primary = document.createElement("p"); primary.className = "ls-line";
    if ([...group.texts[0]].length > 36) primary.classList.add("is-long");
    [...group.texts[0]].forEach((character, index) => {
      const glyph = document.createElement("span"); glyph.className = "ls-char"; glyph.textContent = character;
      glyph.style.setProperty("--char-index", String(index));
      if (!animate) glyph.style.animation = "none";
      primary.appendChild(glyph);
    });
    view.lines.replaceChildren(primary);
    if (group.texts.length > 1) {
      const translation = document.createElement("p"); translation.className = "ls-translation"; translation.textContent = group.texts.slice(1).join("\n");
      view.lines.appendChild(translation);
    }
    if (prior) { prior.classList.add("ls-previous"); view.lines.appendChild(prior); }
    if (animate && group.ordinal % 3 === 2) {
      // Each timestamp is performed at most once per selected track, including seeks.
      view.root.classList.add("is-impact");
      if (view.slash) { void view.slash.offsetWidth; view.slash.classList.add("is-active"); }
    }
    text(view.live, group.texts.join(" / "));
  }
  function render(state, quiet = false) {
    if (!view || !view.root.isConnected) return;
    const current = state.current, track = trackID(current), playing = !!state.playing;
    const time = Math.max(0, Number(state.time) || 0), duration = Math.max(0, Number(state.duration) || 0), wall = performance.now();
    const revision = Number(state.selectionRevision) || 0;
    if (memory.track !== track || memory.revision !== revision) {
      view.loopStartPending = memory.track === track && memory.revision !== revision && state.lrcStatus === "ready" && time < .3;
      memory.track = track; memory.revision = revision; memory.seen.clear(); view.source = null; view.groups = []; view.display = ""; view.sample = null; clearImpact(); view.lines.replaceChildren();
    }
    view.root.classList.toggle("has-track", !!current);
    view.root.classList.toggle("is-playing", !!current && playing);
    view.root.classList.toggle("is-paused", !!current && !playing);
    const status = state.lrcStatus || (state.lrc?.length ? "ready" : "idle");
    view.root.dataset.lyricStatus = status;
    text(view.title, current?.name || view.defaultTitle);
    text(view.artist, current?.artist || (current ? "" : "随歌声入场，跟随每一刻。"));
    text(view.time, clock(time) + " / " + clock(duration));
    if (view.progress) view.progress.style.width = (duration > 0 ? Math.min(100, time / duration * 100) : 0) + "%";
    if (view.toggle) { view.toggle.disabled = typeof window.MikuMusic?.toggle !== "function"; text(view.toggle, playing ? "暂停" : current ? "继续播放" : "开始播放"); view.toggle.setAttribute("aria-label", playing ? "暂停音乐与歌词演出" : "播放音乐与歌词演出"); }
    if (view.next) view.next.disabled = !state.hasQueue || typeof window.MikuMusic?.next !== "function";
    if (view.seek) {
      view.seek.disabled = !(duration > 0);
      if (!view.seeking) view.seek.value = String(duration > 0 ? Math.round(Math.min(1, time / duration) * 1000) : 0);
      view.seek.setAttribute("aria-valuetext", clock(time) + " / " + clock(duration));
    }
    if (view.retry) view.retry.hidden = !current || status !== "unavailable" || typeof window.MikuMusic?.retryLyrics !== "function";
    if (view.source !== state.lrc) { view.source = state.lrc; view.groups = groupLyrics(state.lrc); }
    const previous = view.sample;
    const jump = !!state.seeking || !!previous && (time < previous.time - .15 || Math.abs(time - previous.time) > Math.max(.8, (wall - previous.wall) / 1000 + .4));
    let index = -1;
    for (let i = 0; i < view.groups.length && view.groups[i].time <= time; i++) index = i;
    if (!current) showMessage("idle", "点一首歌，让歌词入场。", "播放歌单后自动同步，无需手动推进。");
    else if (status === "loading") showMessage("loading", "正在寻找这首歌的同步歌词…", playing ? "歌词加载中 · 音乐继续播放" : "歌词加载中");
    else if (status === "unavailable") showMessage("unavailable", "这首暂时没有可用的同步歌词。", "仍可继续听歌，也可以点「重试歌词」。");
    else if (status !== "ready") showMessage("waiting", "继续播放后，歌词会跟着歌声入场。", playing ? "正在准备歌词" : "音乐已暂停");
    else if (index < 0) showMessage("intro", "第一句还没到，先听听前奏。", playing ? "前奏 · 等待第一句" : "已暂停 · 前奏");
    else {
      const group = view.groups[index];
      if (!group.texts.length) {
        if (group.ordinal < 0) showMessage("intro", "第一句还没到，先听听前奏。", playing ? "前奏 · 等待第一句" : "已暂停 · 前奏");
        else showMessage("interlude", "此刻是音乐的间隙。", playing ? "间奏" : "已暂停 · 间奏");
      }
      else {
        const seen = memory.seen.has(group.key);
        const skipped = previous && previous.index >= 0 && index > previous.index + 1;
        const waitingForLoop = view.loopStartPending && (!playing || state.seeking);
        const freshLoop = view.loopStartPending && !waitingForLoop;
        if (freshLoop) view.display = "";
        showCue(group, playing && activeEffects() && !quiet && (!jump || freshLoop) && !skipped && !seen && !waitingForLoop);
        if (!waitingForLoop) { memory.seen.add(group.key); view.loopStartPending = false; }
        text(view.status, playing ? "随歌声同步演出" : "已暂停 · 继续播放后同步");
      }
    }
    view.sample = { time, wall, index };
    syncAnimations(playing);
  }
  function readState(quiet = false) {
    if (!view) return;
    try { render(window.MikuMusic?.getState?.() || {}, quiet); } catch (error) { console.warn("[lyric-stage]", error); }
  }
  function tick() {
    frame = 0;
    if (!view || !view.root.isConnected) { unmount(); return; }
    readState();
    if (window.MikuMusic?.getState?.().playing && !document.hidden) frame = requestAnimationFrame(tick);
  }
  function update() {
    readState();
    if (view && !frame && window.MikuMusic?.getState?.().playing && !document.hidden) frame = requestAnimationFrame(tick);
    else if (frame && !window.MikuMusic?.getState?.().playing) { cancelAnimationFrame(frame); frame = 0; }
  }
  function expand() {
    if (!view || view.expanded) return;
    view.focus = document.activeElement; view.overflow = document.body.style.overflow; view.expanded = true;
    view.anchor = document.createComment("homepage lyric stage"); view.root.before(view.anchor); document.body.appendChild(view.root);
    view.inert = [...document.body.children].filter(node => node !== view.root).map(node => ({ node, previous: node.inert }));
    view.inert.forEach(({ node }) => { node.inert = true; });
    view.root.classList.add("is-expanded"); view.root.setAttribute("role", "dialog"); view.root.setAttribute("aria-modal", "true");
    document.body.style.overflow = "hidden";
    view.expand?.setAttribute("aria-expanded", "true"); if (view.expand) view.expand.hidden = true; if (view.close) view.close.hidden = false;
    save("expanded", true); view.close?.focus({ preventScroll: true });
  }
  function collapse({ remember = true, focus = true } = {}) {
    if (!view || !view.expanded) return;
    view.expanded = false; view.root.classList.remove("is-expanded"); view.root.removeAttribute("role"); view.root.removeAttribute("aria-modal");
    view.inert?.forEach(({ node, previous }) => { node.inert = previous; }); view.inert = [];
    if (view.anchor?.parentNode) view.anchor.replaceWith(view.root); view.anchor = null;
    if (document.body.style.overflow === "hidden") document.body.style.overflow = view.overflow;
    view.expand?.setAttribute("aria-expanded", "false"); if (view.expand) view.expand.hidden = false; if (view.close) view.close.hidden = true;
    if (remember) save("expanded", false); if (focus && view.focus?.isConnected) view.focus.focus({ preventScroll: true });
  }
  function unmount() {
    if (!view) return;
    collapse({ remember: false, focus: false });
    cancelAnimationFrame(frame); frame = 0;
    unsubscribe?.(); unsubscribe = null;
    view.controller.abort();
    for (const animation of view.root.getAnimations?.({ subtree: true }) || []) { try { animation.cancel(); } catch (_) {} }
    view.pausedAnimations.clear(); view = null;
  }
  function mount({ signal, onCleanup } = {}) {
    const root = document.querySelector('[data-lyric-stage]');
    if (!root || document.body.dataset.page !== "home") { unmount(); return; }
    if (view?.root === root && !view.controller.signal.aborted) {
      const current = view; const dispose = () => { if (view === current) unmount(); }; signal?.addEventListener("abort", dispose, { once: true }); onCleanup?.(dispose); return;
    }
    unmount();
    const controller = new AbortController(), find = name => root.querySelector('[data-stage-' + name + ']');
    view = { root, controller, title: find("title"), artist: find("artist"), status: find("status"), lines: find("lines"), slash: find("slash"), live: find("live"), time: find("time"), progress: find("progress"), effects: find("effects"), expand: find("expand"), close: find("close"), retry: find("retry"), toggle: find("toggle"), next: find("next"), seek: find("seek"), seeking: false, display: "", source: null, groups: [], sample: null, pausedAnimations: new Set(), expanded: false, animationPlaying: null };
    if (!view.lines) { view = null; return; }
    view.defaultTitle = view.title?.textContent || "边狱风格歌词演出";
    const instance = view, dispose = () => { if (view === instance) unmount(); };
    signal?.addEventListener("abort", dispose, { once: true }); onCleanup?.(dispose);
    const options = { signal: controller.signal };
    view.effects?.addEventListener("click", () => { save("effects", !settings.effects); syncEffects(); }, options);
    view.expand?.addEventListener("click", expand, options); view.close?.addEventListener("click", () => collapse(), options);
    view.toggle?.addEventListener("click", async () => { try { await window.MikuMusic?.toggle?.(); } catch (_) { if (view === instance) text(view.status, "这首歌暂时没能播放，可以重试或换一首。"); } }, options);
    view.next?.addEventListener("click", async () => { try { await window.MikuMusic?.next?.(); } catch (_) { if (view === instance) text(view.status, "暂时没能切换歌曲，请稍后重试。"); } }, options);
    view.seek?.addEventListener("pointerdown", () => { if (view) view.seeking = true; }, options);
    view.seek?.addEventListener("keydown", () => { if (view) view.seeking = true; }, options);
    view.seek?.addEventListener("input", () => { if (view?.seek) window.MikuMusic?.seek?.(Number(view.seek.value) / 1000); }, options);
    const releaseSeek = () => { if (view === instance) { view.seeking = false; update(); } };
    view.seek?.addEventListener("change", releaseSeek, options); view.seek?.addEventListener("keyup", releaseSeek, options);
    window.addEventListener("pointerup", releaseSeek, options); window.addEventListener("pointercancel", releaseSeek, options);
    document.getElementById("home-lyrics-button")?.addEventListener("click", expand, options);
    view.retry?.addEventListener("click", async () => { const current = view; if (!current || current.retry.disabled) return; current.retry.disabled = true; try { await window.MikuMusic?.retryLyrics?.(); } catch (_) { if (view === current) text(current.status, "歌词暂时没找到，可以稍后再试。"); } finally { if (view === current) current.retry.disabled = false; } }, options);
    root.addEventListener("animationend", event => {
      if (event.target.classList?.contains("ls-previous")) event.target.remove();
      if (event.target === view?.slash) view.slash.classList.remove("is-active");
      if (event.target === view?.lines) view.root.classList.remove("is-impact");
    }, options);
    document.addEventListener("keydown", event => {
      if (!view?.expanded) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); collapse(); }
      else if (event.key === "Tab") {
        const controls = [...root.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]')].filter(node => !node.hidden && node.getClientRects().length);
        if (!controls.length) return;
        const index = controls.indexOf(document.activeElement);
        event.preventDefault(); controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
      }
    }, { signal: controller.signal, capture: true });
    document.addEventListener("visibilitychange", () => { if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else { readState(true); update(); } }, options);
    syncEffects(); readState(true);
    const off = window.MikuMusic?.on?.(update); unsubscribe = typeof off === "function" ? off : null;
    if (settings.expanded) expand(); update();
  }
  reduced.addEventListener("change", syncEffects);
  window.LyricStage = { mount, unmount, expand, collapse: () => collapse(), setEffects(enabled) { save("effects", !!enabled); syncEffects(); }, getState: () => ({ mounted: !!view, expanded: !!view?.expanded, effects: activeEffects(), track: memory.track }) };
  if (typeof onPageReady === "function") { onPageReady(mount); if (document.readyState !== "loading") mount(); }
  else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => mount(), { once: true }); else mount();
})();
