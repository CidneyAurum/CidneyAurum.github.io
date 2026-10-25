/* Finite Japanese character lines. Long chat responses are text only. */
(() => {
  "use strict";
  if (window.MikuVoice) return;
  const script = new URL(document.currentScript.src);
  const base = new URL("../assets/voice/miku/", script);
  const version = script.searchParams.get("v");
  let manifest = null, pendingManifest = null;
  let audio = null, context = null, analyser = null, samples = null;
  let generation = 0, finishCurrent = null, raf = 0, lastFrame = 0;
  let lastEvent = "", lastAt = 0, forced = false, memoryEnabled = null;
  const state = { playing: false, event: "", subtitle: "", text: "", ja: "", mouth: 0, error: "", clip: null };

  function isEnabled() {
    if (memoryEnabled !== null) return memoryEnabled;
    try { return localStorage.getItem("kb_tts") !== "0"; } catch (_) { return true; }
  }
  function getState() { return { ...state, enabled: isEnabled() }; }
  function emit() { document.dispatchEvent(new CustomEvent("mikuvoice", { detail: getState() })); }
  function setEnabled(enabled) {
    memoryEnabled = !!enabled;
    try { localStorage.setItem("kb_tts", enabled ? "1" : "0"); } catch (_) {}
    if (!enabled) stop();
    document.dispatchEvent(new CustomEvent("miku:voice-setting", { detail: { enabled: !!enabled } }));
    emit();
  }
  async function loadManifest() {
    if (manifest) return manifest;
    if (pendingManifest) return pendingManifest;
    pendingManifest = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      const url = new URL("manifest.json", base);
      if (version) url.searchParams.set("v", version);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("语音资料暂时没有加载成功，请重试。");
        const data = await response.json();
        if (!data.clips || typeof data.clips !== "object") throw new Error("语音资料不完整。");
        for (const clip of Object.values(data.clips)) {
          if (!/^[a-z0-9-]+\.wav$/i.test(clip.file || "")) throw new Error("语音文件地址无效。");
        }
        manifest = data;
        return data;
      } finally { clearTimeout(timer); }
    })().catch(error => {
      state.error = error.name === "AbortError" ? "语音资料加载超时，请重试。" : error.message;
      emit();
      return null;
    }).finally(() => { pendingManifest = null; });
    return pendingManifest;
  }
  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = "metadata";
    audio.volume = .85;
    return audio;
  }
  function unlock() {
    ensureAudio();
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!context && AudioContext) {
      let source = null;
      try {
        context = new AudioContext();
        analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = .6;
        samples = new Float32Array(analyser.fftSize);
        source = context.createMediaElementSource(audio);
        source.connect(analyser);
        analyser.connect(context.destination);
      } catch (_) {
        try { source?.disconnect(); source?.connect(context.destination); } catch (_) {}
        analyser = null;
      }
    }
    if (context?.state === "suspended") return context.resume().catch(() => {});
    return Promise.resolve();
  }
  function meter(now) {
    if (!state.playing) return;
    if (analyser && samples) {
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const value of samples) energy += value * value;
      const level = Math.min(1, Math.max(0, (Math.sqrt(energy / samples.length) - .008) * 8));
      state.mouth += (level - state.mouth) * (level > state.mouth ? .65 : .22);
    }
    if (now - lastFrame > 70) { lastFrame = now; emit(); }
    raf = requestAnimationFrame(meter);
  }
  function stop() {
    generation++;
    finishCurrent?.(false);
    finishCurrent = null;
    if (audio) audio.pause();
    cancelAnimationFrame(raf);
    state.playing = false;
    state.mouth = 0;
    emit();
  }
  async function play(event, options = {}) {
    if (!isEnabled()) return false;
    if (!options.force && window.MikuMusic?.getState().playing) return false;
    if (!options.force && event === lastEvent && Date.now() - lastAt < 5000) return false;
    stop();
    const id = generation;
    forced = !!options.force;
    await unlock();
    const data = await loadManifest();
    if (id !== generation || !isEnabled()) return false;
    const clip = data?.clips[event];
    if (!clip) { state.error = state.error || "这段角色语音暂时不可用。"; emit(); return false; }
    state.event = event;
    state.subtitle = clip.ja + " · " + clip.text;
    state.text = clip.text;
    state.ja = clip.ja;
    state.clip = { id: event, ...clip };
    state.error = "";
    lastEvent = event;
    lastAt = Date.now();
    const url = new URL(clip.file, base);
    if (version) url.searchParams.set("v", version);
    audio.src = url.href;
    return new Promise(resolve => {
      let done = false;
      const settle = (ok, message = "") => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        audio.removeEventListener("ended", ended);
        audio.removeEventListener("error", failed);
        if (id === generation) {
          finishCurrent = null;
          if (!ok) audio.pause();
          cancelAnimationFrame(raf);
          state.playing = false;
          state.mouth = 0;
          state.error = message;
          emit();
        }
        resolve(ok);
      };
      const ended = () => settle(true);
      const failed = () => settle(false, "这段语音没有播放成功，点试听可以重试。");
      const timeout = setTimeout(() => settle(false, "语音连接较慢，点试听可以重试。"), Math.max(10000, clip.duration * 1000 + 7000));
      finishCurrent = settle;
      audio.addEventListener("ended", ended, { once: true });
      audio.addEventListener("error", failed, { once: true });
      Promise.resolve().then(() => audio.play()).then(() => {
        if (id !== generation) return;
        state.playing = true;
        emit();
        raf = requestAnimationFrame(meter);
      }).catch(error => {
        if (id !== generation) return settle(false);
        settle(false, error.name === "NotAllowedError" ? "请点一下「听听声音」，允许角色语音播放。" : "语音暂时没能播放，请重试。");
      });
    });
  }
  function react(event, { text = "" } = {}) {
    if (!isEnabled() || window.MikuMusic?.getState().playing || String(text).length > 65) return Promise.resolve(false);
    if (event === "music") return play("music");
    if (/(你是谁|初音ミクです)/.test(text)) return play("identity");
    if (/(感谢|谢谢)/.test(text)) return play("thanks");
    if (/(喜欢|比心|抱抱|可爱)/.test(text)) return play("heart");
    if (/(你好|欢迎)/.test(text)) return play("greet");
    return Promise.resolve(false);
  }

  window.MikuVoice = { unlock, play, react, stop, setEnabled, isEnabled, getState,
    getClips: () => Object.entries(manifest?.clips || {}).map(([id, clip]) => ({ id, ...clip })),
    get ready() { return loadManifest(); },
  };
  document.addEventListener("miku:visibility", event => { if (!event.detail?.visible) stop(); });
  document.addEventListener("change", event => { if (event.target.id === "kb-tts") setEnabled(event.target.checked); });
  document.addEventListener("mikumusic", event => { if (event.detail?.playing && state.playing && !forced) stop(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  loadManifest();
})();
