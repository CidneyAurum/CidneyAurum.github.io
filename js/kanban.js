/* ============================================
   Miku 看板娘 · 自包含组件（不依赖页面静态 DOM）
   - 动态创建看板娘界面
   - Live2D 渲染（去水印、表情、口型）
   - AI 多协议对话（OpenAI 兼容 / Gemini / Claude）+ 读取模型列表
   - 音乐点播联动（MikuMusic）
   全部包在 IIFE 内，避免与 music.js 的全局 AIChat 冲突
   ============================================ */
"use strict";

(function () {
  if (window.MikuCompanion) return;
  // Capture the script location before idle callbacks or PJAX change the page URL.
  const componentRoot = new URL("../", document.currentScript?.src || new URL("js/kanban.js", document.baseURI));

  // Keep this visit usable when private browsing or a full quota blocks storage.
  const sessionSettings = new Map();
  function readSetting(key) {
    if (sessionSettings.has(key)) return sessionSettings.get(key);
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeSetting(key, value) {
    sessionSettings.set(key, value);
    try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  /* ---------- AI 多协议引擎（本地命名，不污染全局） ---------- */
  const KB = (function () {
    function getSettings() {
      return {
        protocol: readSetting("kb_protocol") || "openai",
        base: (readSetting("kb_base") || "https://api.deepseek.com").trim().replace(/\/+$/, ""),
        model: readSetting("kb_model") || "deepseek-flash",
        key: (readSetting("kb_key") || "").trim(),
        proxy: (readSetting("kb_proxy") || "").trim().replace(/\/+$/, ""),
        tts: readSetting("kb_tts") !== "0",
      };
    }

    /* 若配置了 CORS 代理，则把请求改道代理转发（代理负责加跨域头） */
    function u(st, path) {
      const base = new URL(st.base.trim());
      if (!/^https?:$/.test(base.protocol)) throw new Error("接口地址需要以 https:// 或 http:// 开头");
      let prefix = base.pathname.replace(/\/+$/, "");
      if (st.protocol === "gemini") prefix = prefix.replace(/\/v1(?:beta)?$/, "");
      else if (st.protocol === "claude") prefix = prefix.replace(/\/v1(?:\/(?:messages|models))?$/, "");
      else {
        prefix = prefix.replace(/\/(?:chat\/completions|models)$/, "");
        if (!prefix) prefix = "/v1";
      }
      const raw = base.origin + prefix + path;
      if (!st.proxy) return raw;
      const proxy = new URL(st.proxy.trim());
      if (!/^https?:$/.test(proxy.protocol)) throw new Error("代理地址需要以 https:// 或 http:// 开头");
      proxy.searchParams.set("url", raw);
      return proxy.href;
    }

    async function requestJSON(url, options = {}) {
      const ctrl = new AbortController();
      const callerSignal = options.signal;
      let cancelRequest;
      const canceled = new Promise((_, reject) => { cancelRequest = reject; });
      const abort = () => { ctrl.abort(); cancelRequest(new DOMException("这次回复已停止", "AbortError")); };
      if (callerSignal?.aborted) abort();
      else callerSignal?.addEventListener("abort", abort, { once: true });
      let timedOut = false;
      let timer;
      try {
        return await Promise.race([
          canceled,
          (async () => {
            const res = await fetch(url, { ...options, signal: ctrl.signal });
            if (!res.ok) throw new Error("接口 " + res.status + ": " + (await res.text()).slice(0, 140));
            return res.json();
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              ctrl.abort();
              reject(new Error("请求超时，请检查接口地址或稍后重试"));
            }, 25000);
          }),
        ]);
      } catch (e) {
        if (timedOut) throw new Error("请求超时，请检查接口地址或稍后重试");
        throw e;
      } finally { clearTimeout(timer); callerSignal?.removeEventListener("abort", abort); }
    }

    function responseText(value) {
      const text = typeof value === "string" ? value : Array.isArray(value)
        ? value.map((part) => part.text || "").join("") : "";
      if (!text.trim()) throw new Error("接口没有返回文字，请检查模型设置");
      return text;
    }

    function localReply(messages) {
      const text = messages.filter((m) => m.role === "user").at(-1)?.content || "";
      if (/(你好|早安|晚上好|嗨|hello)/i.test(text)) return "你好呀，欢迎来小窝坐坐～ 想听歌的话可以跟我说「放 歌名」。【表情:比心】";
      if (/(你是谁|叫什么|介绍自己)/.test(text)) return "我是住在这个网站里的看板娘初音 Miku，陪你逛逛，也能帮你点歌 ♪";
      if (/(难过|伤心|累|烦|压力)/.test(text)) return "辛苦啦，先歇一会儿吧。我在这里陪你，也可以放一首喜欢的歌缓缓心情。【表情:前倾】";
      if (/(喜欢|可爱|谢谢)/.test(text)) return "收到这份心意啦，给你比个心 ♡【表情:比心】";
      if (/(文章|博客|照片|相册|网站)/.test(text)) return "导航里有文章归档、照片和碎碎念，可以慢慢逛～ 首页的搜索也能帮你找到文章。";
      if (/(怎么|帮助|功能|能做)/.test(text)) return "我可以陪你聊几句，也能听懂「播放歌单」「下一首」「暂停音乐」和「放 歌名」。在设置中配置 AI 接口后，就能进行自由对话了。";
      return "我在这里陪你呀 ♪ 现在使用的是本地简短回复；你可以让我点歌，或在设置里配置 AI 接口后和我自由聊天。";
    }

    const SYSTEM_PROMPT =
      "你是看板娘「Miku」，住在 CidneyAurum 的个人网站小窝里。性格元气可爱、偶尔傲娇。" +
      "用中文回复，每次 1~3 句话，亲切自然。你可以在回复里插入一个表情标记来做动作，" +
      "可用表情：比心、圈圈、脸红、前倾、唱歌、葱、QQ人，格式如【表情:比心】，每次最多一个，不必每句都带。" +
      "主人叫 CidneyAurum。如果被问到你是谁，就说你是这个网站的看板娘初音。";

    async function requestOpenAI(st, messages, signal) {
      const data = await requestJSON(u(st, "/chat/completions"), {
        method: "POST", signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + st.key },
        body: JSON.stringify({ model: st.model, messages, temperature: 0.9 }),
      });
      return responseText(data.choices?.[0]?.message?.content);
    }

    async function requestGemini(st, messages, signal) {
      const sys = messages.find((m) => m.role === "system");
      const contents = messages.filter((m) => m.role !== "system").map((m) => ({
        role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }],
      }));
      const body = { contents, generationConfig: { temperature: 0.9, maxOutputTokens: 512 } };
      if (sys) body.systemInstruction = { parts: [{ text: sys.content }] };
      const data = await requestJSON(u(st, "/v1beta/models/" + encodeURIComponent(st.model.replace(/^models\//, "")) + ":generateContent?key=" + encodeURIComponent(st.key)), {
        method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      return responseText(data.candidates?.[0]?.content?.parts);
    }

    async function requestClaude(st, messages, signal) {
      const sys = messages.find((m) => m.role === "system");
      const msgs = messages.filter((m) => m.role !== "system");
      const data = await requestJSON(u(st, "/v1/messages"), {
        method: "POST", signal,
        headers: {
          "Content-Type": "application/json", "x-api-key": st.key,
          "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model: st.model || "claude-sonnet-4-20250514", max_tokens: 512, system: sys?.content, messages: msgs }),
      });
      return responseText(data.content);
    }

    async function askAI(messages, signal) {
      const st = getSettings();
      if (!st.key) return localReply(messages);
      if (st.protocol === "gemini") return requestGemini(st, messages, signal);
      if (st.protocol === "claude") return requestClaude(st, messages, signal);
      return requestOpenAI(st, messages, signal);
    }

    /* 读取可用模型列表（协议自选） */
    async function fetchModels(st) {
      if (st.protocol === "gemini") {
        const data = await requestJSON(u(st, "/v1beta/models?key=" + encodeURIComponent(st.key)));
        return (data.models || []).map((m) => (m.name || "").replace(/^models\//, "")).filter(Boolean);
      }
      if (st.protocol === "claude") {
        const data = await requestJSON(u(st, "/v1/models"), {
          headers: { "x-api-key": st.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        });
        return (data.data || []).map((m) => m.id).filter(Boolean);
      }
      // OpenAI 兼容
      const data = await requestJSON(u(st, "/models"), {
        headers: { Authorization: "Bearer " + st.key },
      });
      return (data.data || []).map((m) => m.id).filter(Boolean);
    }

    return { getSettings, askAI, fetchModels, SYSTEM_PROMPT };
  })();

  /* ---------- 看板娘 UI ---------- */
  let model = null;
  let history = [];
  const EMOTES = ["比心", "圈圈", "脸红", "前倾", "唱歌", "葱", "QQ人"];
  const EMOTE_PARAMS = ["Param125", "Param130", "Param131", "Param132", "Param133", "Param134", "Param135", "Param136"];
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  let reaction = null, reactionTimer = null, reactionVersion = 0;
  let listening = !!window.MikuMusic?.getState?.().playing;

  // A previous version may have left the browser's generic narrator running.
  try { window.speechSynthesis?.cancel(); } catch (e) {}

  function $(id) { return document.getElementById(id); }

  /* ---------- 动态创建 DOM ---------- */
  function buildDOM() {
    const root = document.createElement("div");
    root.className = "kanban";
    root.id = "kanban";
    root.innerHTML = `
      <div class="kb-bubble" id="kb-bubble"></div>
      <div class="kb-stage" id="kb-stage">
        <div class="kb-loading" id="kb-loading"><span class="spin">◌</span><br>Miku 加载中…</div>
      </div>
      <div class="kb-bar">
        <button class="kb-btn" id="kb-chat-btn" title="和 Miku 聊天">💬</button>
        <button class="kb-btn" id="kb-set-btn" title="设置">⚙️</button>
        <button class="kb-btn" id="kb-hide-btn" title="收起 / 展开">▾</button>
      </div>
      <div class="kb-chat" id="kb-chat">
        <div class="kb-chat-head"><span>和 Miku 聊天</span><button class="kb-btn" id="kb-chat-close" style="width:26px;height:26px;font-size:11px;">✕</button></div>
        <div class="kb-ai-channel"><span id="kb-ai-channel">本地陪伴</span><button id="kb-ai-open" type="button">展开对话室 ↗</button></div>
        <div class="kb-msgs" id="kb-msgs"></div>
        <div class="kb-input-row">
          <input id="kb-input" placeholder="说点什么，或「放 歌名」点歌…" autocomplete="off">
          <button id="kb-send">发送</button>
          <button id="kb-cancel" type="button" hidden>停止</button>
        </div>
      </div>
      <div class="kb-set" id="kb-set" style="max-height:min(680px,calc(100vh - 96px));overflow-y:auto;overscroll-behavior:contain;">
        <div class="kb-chat-head"><span>Miku 设置</span><button class="kb-btn" id="kb-set-close" style="width:26px;height:26px;font-size:11px;">✕</button></div>
        <label for="kb-protocol">接口协议</label>
        <select id="kb-protocol">
          <option value="openai">OpenAI 兼容（DeepSeek / 通义 / 智谱 / Kimi…）</option>
          <option value="tokenrhythm">基元律动（TokenRhythm）</option>
          <option value="gemini">Google Gemini</option>
          <option value="claude">Anthropic Claude</option>
        </select>
        <label for="kb-base">接口地址 Base URL</label>
        <input id="kb-base" placeholder="https://api.deepseek.com">
        <label for="kb-model">模型</label>
        <div class="kb-model-row">
          <input id="kb-model" list="kb-model-list" placeholder="deepseek-flash" autocomplete="off">
          <datalist id="kb-model-list"></datalist>
          <button class="kb-btn" id="kb-models-btn" title="读取可用模型列表" style="flex:0 0 34px;">🔄</button>
        </div>
        <label for="kb-key">API Key</label>
        <input id="kb-key" type="password" placeholder="sk-…" autocomplete="off">
        <label for="kb-proxy">CORS 代理地址（可选，基元律动必填）</label>
        <input id="kb-proxy" placeholder="https://你的worker.workers.dev" autocomplete="off">
        <label for="kb-musicapi">音乐接口地址（可选，留空使用公共源）</label>
        <input id="kb-musicapi" type="url" placeholder="https://你的音乐接口/meting/" autocomplete="off" aria-describedby="kb-musicapi-hint">
        <div class="hint" id="kb-musicapi-hint"></div>
        <label class="kb-check"><input type="checkbox" id="kb-tts"> 初音互动语音</label>
        <div class="hint">日语短语音；AI 长回复仅显示文字</div>
        <button class="kb-btn" id="kb-voice-preview" type="button" style="width:auto;">试听初音的声音 ♪</button>
        <div class="hint" id="kb-hint"></div>
      </div>
    `;
    document.body.appendChild(root);

    const min = document.createElement("button");
    min.className = "kanban-min";
    min.id = "kanban-min";
    min.title = "展开看板娘";
    min.textContent = "🎀";
    document.body.appendChild(min);
  }

  /* ---------- 表情 / 情绪 ---------- */
  function playExpression(name) {
    if (!model) return Promise.resolve(false);
    const target = model;
    return Promise.resolve(target.expression(name)).then((applied) => {
      const manager = target.internalModel?.motionManager?.expressionManager;
      // resetExpression() keeps currentExpression. Reusing the same preset then
      // returns false, so explicitly restore that cached preset for a new gesture.
      const index = manager?.getExpressionIndex?.(name);
      if (applied === false && index >= 0 && manager?.expressions?.indexOf(manager.currentExpression) === index) manager.restoreExpression?.();
      return applied;
    });
  }

  function restoreEmotion() {
    if (!model) return;
    try {
      const manager = model.internalModel?.motionManager?.expressionManager;
      if (typeof manager?.resetExpression === "function") {
        manager.reserveExpressionIndex = -1;
        manager.resetExpression();
      }
      else {
        const core = model.internalModel?.coreModel;
        if (typeof core?.setParameterValueById === "function") EMOTE_PARAMS.forEach((id) => core.setParameterValueById(id, 0));
      }
      if (listening && isVisible()) playExpression("唱歌").catch(() => {});
    } catch (e) {}
  }

  function applyReaction() {
    if (!model || !reaction || !isVisible()) return;
    const current = reaction, version = reactionVersion;
    Promise.resolve().then(() => playExpression(current.name)).catch(() => {}).then(() => {
      if (version !== reactionVersion || reaction !== current) return;
      clearTimeout(reactionTimer);
      reactionTimer = setTimeout(() => {
        if (version !== reactionVersion) return;
        reaction = null;
        restoreEmotion();
      }, current.duration);
    });
  }

  function setEmotion(name, duration = 2600) {
    if (!EMOTES.includes(name)) return false;
    clearTimeout(reactionTimer);
    reactionVersion++;
    reaction = { name, duration: Number.isFinite(duration) ? Math.max(0, Math.min(15000, duration)) : 2600 };
    applyReaction();
    return true;
  }

  function react(text) {
    const map = [
      [/(喜欢|爱|比心|心动|可爱)/, "比心"],
      [/(害羞|脸红|讨厌啦)/, "脸红"],
      [/(难过|伤心|哭|抱抱)/, "前倾"],
      [/(生气|哼|可恶|笨蛋)/, "QQ人"],
      [/(哇|什么|惊|！|\?|真的假的)/, "圈圈"],
      [/(唱歌|歌|音乐|♪|点歌|放歌)/, "唱歌"],
    ];
    for (const [re, emo] of map) {
      try { if (re.test(text)) { setEmotion(emo); return; } } catch (e) {}
    }
  }

  function parseEmote(text) {
    let emote = null;
    const out = String(text).replace(/[【\[]\s*表情\s*[:：]\s*([^\】\]]+)\s*[】\]]/g, (_, name) => {
      const n = name.trim();
      if (EMOTES.includes(n)) { emote = n; return ""; }
      return "";
    });
    return { text: out.trim(), emote };
  }

  /* ---------- 气泡提示 ---------- */
  let bubbleTimer = null;
  function bubble(msg, ms) {
    const b = $("kb-bubble");
    if (!b) return;
    b.textContent = msg;
    b.classList.add("show");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => b.classList.remove("show"), ms || 2600);
  }

  function isVisible() {
    const root = $("kanban");
    return !!root && !root.classList.contains("hidden");
  }

  function show() {
    const root = $("kanban");
    if (!root) return;
    const changed = !isVisible();
    root.classList.remove("hidden");
    $("kanban-min")?.classList.remove("show");
    if (reaction) applyReaction();
    else restoreEmotion();
    if (changed) document.dispatchEvent(new CustomEvent("miku:visibility", { detail: { visible: true } }));
  }

  function hide() {
    const root = $("kanban");
    if (!root) return;
    const changed = isVisible();
    root.classList.add("hidden");
    $("kanban-min")?.classList.add("show");
    $("kb-chat")?.classList.remove("open");
    $("kb-set")?.classList.remove("open");
    $("kb-bubble")?.classList.remove("show");
    clearTimeout(bubbleTimer);
    clearTimeout(reactionTimer);
    reaction = null;
    reactionVersion++;
    restoreEmotion();
    if (changed) document.dispatchEvent(new CustomEvent("miku:visibility", { detail: { visible: false } }));
  }

  function openChat() {
    show();
    $("kb-set")?.classList.remove("open");
    $("kb-chat")?.classList.add("open");
    $("kb-input")?.focus();
  }

  function openSettings() {
    show();
    $("kb-chat")?.classList.remove("open");
    $("kb-set")?.classList.add("open");
    fitSettings();
    $("kb-protocol")?.focus();
  }

  function fitSettings() {
    const root = $("kanban"), panel = $("kb-set");
    if (!root || !panel) return;
    const bottom = root.getBoundingClientRect().bottom;
    const offset = Math.max(40, bottom - (window.innerHeight - 12));
    panel.style.bottom = offset + "px";
    panel.style.maxHeight = Math.max(180, Math.min(680, bottom - offset - 12)) + "px";
  }

  window.MikuCompanion = {
    ready, show, hide, say: (text) => bubble(String(text)),
    react: setEmotion, openChat, openSettings, isVisible,
  };

  document.addEventListener("miku:intent", (event) => {
    const detail = event.detail || {};
    const presets = { greet: "比心", heart: "比心", listen: "唱歌", guide: "前倾", goodbye: "比心" };
    if (!Object.hasOwn(presets, detail.type)) return;
    show();
    if (typeof detail.text === "string" && detail.text.trim()) bubble(detail.text, 3600);
    setEmotion(EMOTES.includes(detail.emote) ? detail.emote : presets[detail.type]);
  });

  document.addEventListener("mikumusic", (event) => {
    const next = !!event.detail?.playing;
    if (next === listening) return;
    listening = next;
    if (!reaction) restoreEmotion();
  });

  document.addEventListener("miku:voice-setting", (event) => {
    if (typeof event.detail?.enabled !== "boolean") return;
    writeSetting("kb_tts", event.detail.enabled ? "1" : "0");
    if ($("kb-tts")) $("kb-tts").checked = event.detail.enabled;
  });

  /* ---------- 消息 ---------- */
  function addMsg(role, text) {
    const box = $("kb-msgs");
    if (!box) return null;
    const div = document.createElement("div");
    div.className = "kb-msg " + (role === "me" ? "me" : "ai");
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  function speak(text, kind = "reply") {
    if (!KB.getSettings().tts || typeof window.MikuVoice?.react !== "function") return;
    Promise.resolve().then(() => window.MikuVoice.react(kind, { text })).catch(() => {
      bubble("这次语音没能播放，文字消息还在这里。", 3200);
    });
  }

  /* ---------- 音乐点播命令 ---------- */
  async function musicCommand(text) {
    const t = text.trim();
    if (!window.MikuMusic) return null;
    if (/^(播放|放)\s*(歌单|全部|列表)/.test(t)) {
      const n = await window.MikuMusic.playPlaylist();
      return { reply: "好嘞，从歌单开始放啦～ 一共 " + n + " 首 ♪", emote: "唱歌" };
    }
    if (/^(暂停(?:音乐|播放)?|停止(?:音乐|播放)?|停一下)[。！!\s]*$/.test(t)) {
      if (/^停止/.test(t) && window.MikuMusic.stop) window.MikuMusic.stop();
      else if (window.MikuMusic.getState().playing) await window.MikuMusic.toggle();
      return { reply: "音乐暂停啦，想听时再叫我 ♪" };
    }
    if (/^(继续(?:音乐|播放)?|恢复播放)[。！!\s]*$/.test(t)) {
      if (!window.MikuMusic.getState().playing) await window.MikuMusic.toggle();
      return { reply: "继续播放 ♪", emote: "唱歌" };
    }
    if (/^上一首[。！!\s]*$/.test(t)) {
      await window.MikuMusic.prev();
      return { reply: "换上一首～", emote: "唱歌" };
    }
    if (/^(随便(?:放一首)?|随机(?:播放)?|来一首|换一首|下一首)[。！!\s]*$/.test(t)) {
      if (/^(下一首|换一首)[。！!\s]*$/.test(t)) { await window.MikuMusic.next(); return { reply: "换下一首～", emote: "唱歌" }; }
      if (!window.MikuMusic.getQueue().length) await window.MikuMusic.loadPlaylist();
      const q = window.MikuMusic.getQueue();
      if (q.length) {
        await window.MikuMusic.playIndex(Math.floor(Math.random() * q.length));
        return { reply: "随机来一首 ♪", emote: "唱歌" };
      }
    }
    const m = t.match(/^(?:放|播放|点歌|来一首|唱|播)\s*[:：]?\s*(.+)/);
    if (!m) return null;
    const name = m[1].trim();
    const song = await window.MikuMusic.searchAndPlay(name);
    return { reply: "找到啦～《" + song.name + "》开始播放 ♪", emote: "唱歌" };
  }

  /* ---------- 聊天发送 ---------- */
  let sending = false, sendController = null;
  async function doSend() {
    const input = $("kb-input");
    if (!input || sending) return;
    const text = (input.value || "").trim();
    if (!text) return;
    sending = true;
    $("kb-send").disabled = true;
    $("kb-msgs").setAttribute("aria-busy", "true");
    input.value = "";
    addMsg("me", text);
    react(text);

    try {
      // A single send owns its reply, including asynchronous music commands.
      const mm = await musicCommand(text).catch((e) => ({ reply: "呜…" + e.message }));
      if (mm) {
        addMsg("ai", mm.reply);
        if (mm.emote) setEmotion(mm.emote);
        speak(mm.reply, "music");
        return;
      }
      const thinking = addMsg("ai", "…");
      sendController = new AbortController();
      $("kb-cancel").hidden = false;
      try {
        await window.MikuAIModuleReady;
        if (sendController.signal.aborted) throw new DOMException("这次回复已停止", "AbortError");
        const usingGateway = !KB.getSettings().key && !!window.MikuAI?.status().configured;
        const usingLocalReply = !KB.getSettings().key && !usingGateway;
        let result = null;
        let reply;
        if (usingGateway) {
          const page = document.body.dataset.page || "home";
          const slug = page === "post" ? decodeURIComponent(location.pathname.split("/").pop().replace(/\.html$/, "")) : "";
          result = await window.MikuAI.ask({ message: text, history: history.slice(-10), mode: page === "post" ? "article" : "chat", context: { page, slug }, signal: sendController.signal });
          reply = result.reply;
        } else reply = await KB.askAI([{ role: "system", content: KB.SYSTEM_PROMPT }, ...history, { role: "user", content: text }], sendController.signal);
        if (sendController.signal.aborted) throw new DOMException("这次回复已停止", "AbortError");
        history.push({ role: "user", content: text }, { role: "assistant", content: reply });
        if (history.length > 16) history = history.slice(-16);
        const parsed = parseEmote(reply);
        if (parsed.emote) setEmotion(parsed.emote);
        if (result && window.MikuAI?.renderMessage) {
          thinking?.remove();
          const node = window.MikuAI.renderMessage($("kb-msgs"), result);
          node?.classList.add("kb-msg", "ai");
          const emotion = ({ happy: "比心", thinking: "前倾", shy: "脸红", sad: "前倾", singing: "唱歌" })[result.emotion] || result.emotion;
          if (EMOTES.includes(emotion)) window.MikuCompanion.react(emotion);
          $("kb-msgs").scrollTop = $("kb-msgs").scrollHeight;
        } else if (thinking) thinking.textContent = parsed.text || "(^_^)";
        // Fixed character reactions accompany local chat. Arbitrary AI output is text only.
        if (usingLocalReply) speak(parsed.text);
      } catch (err) {
        if (thinking) thinking.textContent = err.name === "AbortError" ? "这次先停在这里，想接着聊再叫我。" : "呜…" + err.message;
      }
    } finally {
      sending = false;
      sendController = null;
      $("kb-cancel").hidden = true;
      $("kb-send").disabled = false;
      $("kb-msgs").removeAttribute("aria-busy");
    }
  }

  /* ---------- Live2D 渲染 ---------- */
  const scriptLoads = new Map();
  function loadScript(src) {
    if (scriptLoads.has(src)) return scriptLoads.get(src);
    const pending = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      const finish = (error) => {
        clearTimeout(timer);
        s.onload = s.onerror = null;
        if (error) { s.remove(); reject(error); }
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error("模型资源加载超时")), 15000);
      s.src = src; s.onload = () => finish(); s.onerror = () => finish(new Error("模型资源加载失败"));
      document.head.appendChild(s);
    });
    scriptLoads.set(src, pending);
    pending.catch(() => scriptLoads.delete(src));
    return pending;
  }

  let pixiInit = null;
  function initPixi() {
    if (model) return Promise.resolve();
    if (pixiInit) return pixiInit;
    pixiInit = loadPixi().finally(() => { pixiInit = null; });
    return pixiInit;
  }

  async function loadPixi() {
    const stage = $("kb-stage");
    const loading = $("kb-loading");
    if (!stage) return;
    let app = null;
    let loadedModel = null;
    try {
      if (loading) loading.textContent = "Miku 加载中…";
      if (!window.Live2DCubismCore) await loadScript("https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js");
      if (!window.PIXI?.Application) await loadScript("https://cdn.jsdelivr.net/npm/pixi.js@7.4.2/dist/pixi.min.js");
      if (!window.PIXI?.live2d?.Live2DModel) await loadScript("https://cdn.jsdelivr.net/npm/pixi-live2d-display-lipsyncpatch@0.5.0-ls-8/dist/cubism4.min.js");

      const W = Math.max(1, stage.clientWidth), H = Math.max(1, stage.clientHeight);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      app = new PIXI.Application({
        width: W, height: H, backgroundAlpha: 0,
        autoDensity: true, resolution: dpr, preserveDrawingBuffer: true,
      });
      stage.insertBefore(app.view, stage.firstChild);

      let accepting = true;
      let timer;
      const pending = PIXI.live2d.Live2DModel.from(new URL("assets/live2d/miku/miku.model3.json", componentRoot).href, { autoInteract: false });
      try {
        loadedModel = await Promise.race([
          Promise.resolve(pending).then((value) => {
            if (!accepting) { try { value.destroy(); } catch (e) {} return null; }
            return value;
          }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("模型加载超时")), 25000); }),
        ]);
      } finally { clearTimeout(timer); accepting = false; }
      if (!loadedModel?.internalModel?.height) throw new Error("模型数据不完整");
      model = loadedModel;

      const fit = () => {
        const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
        app.renderer.resize(w, h);
        const s = (h * 0.98) / model.internalModel.height;
        model.scale.set(s);
        model.x = (w - model.width) / 2;
        model.y = h - model.height;
      };
      fit();

      app.stage.addChild(model);
      model.interactive = true;

      // 显式播放 Idle 动画（呼吸/眨眼/晃动），模型才会"活"起来
      try { model.motion("Idle"); } catch (e) {}

      // 关闭作者水印（模型说明允许关闭）
      try {
        model.internalModel.on("beforeModelUpdate", () => {
          try { model.internalModel.coreModel.setParameterValueById("Param137", 1); } catch (e) {}
        });
      } catch (e) {}

      // Only the real character-voice envelope drives the mouth. Music is a pose,
      // because cross-origin streams cannot reliably supply an analyser signal.
      try {
        model.internalModel.on("afterModelUpdate", () => {
          try {
            const amount = Number(window.MikuVoice?.getState?.().mouth) || 0;
            model.internalModel.coreModel.setParameterValueById("ParamMouthOpenY", isVisible() ? Math.max(0, Math.min(1, amount)) : 0);
          } catch (e) {}
        });
      } catch (e) {}

      window.addEventListener("resize", fit);
      if (reaction) applyReaction();
      else restoreEmotion();
      if (loading) loading.remove();
    } catch (e) {
      model = null;
      try { loadedModel?.destroy(); } catch (err) {}
      try { app?.destroy(true, { children: true }); } catch (err) {}
      // Leave chat/settings usable and offer recovery without reloading the page.
      if (loading) {
        loading.replaceChildren();
        const message = document.createElement("div");
        message.textContent = "Miku 模型加载失败：" + (e.message || "请检查网络");
        const retry = document.createElement("button");
        retry.className = "kb-btn";
        retry.type = "button";
        retry.style.width = "auto";
        retry.textContent = "重试加载";
        retry.addEventListener("click", () => initPixi());
        loading.append(message, retry);
      }
    }
  }

  /* ---------- 设置面板 ---------- */
  function initSettings() {
    const el = {
      protocol: $("kb-protocol"), base: $("kb-base"), model: $("kb-model"),
      list: $("kb-model-list"), key: $("kb-key"), proxy: $("kb-proxy"), tts: $("kb-tts"),
      musicApi: $("kb-musicapi"), musicHint: $("kb-musicapi-hint"),
      modelsBtn: $("kb-models-btn"), hint: $("kb-hint"),
    };
    const st = KB.getSettings();
    el.protocol.value = st.protocol;
    el.base.value = st.base;
    el.model.value = st.model;
    el.key.value = st.key;
    el.proxy.value = st.proxy;
    el.tts.checked = st.tts;
    el.musicApi.value = readSetting("kb_musicapi") || "";

    $("kb-voice-preview").addEventListener("click", async () => {
      const button = $("kb-voice-preview");
      if (button.disabled) return;
      button.disabled = true;
      try {
        if (typeof window.MikuVoice?.play !== "function") throw new Error("角色语音还没准备好");
        await window.MikuVoice.play("greet", { force: true });
      } catch (e) {
        bubble("初音的声音暂时没能播放，请稍后再试。", 3600);
      } finally { button.disabled = false; }
    });

    const saveMusicApi = () => {
      let value = el.musicApi.value.trim();
      try {
        if (value) {
          const url = new URL(value);
          if (!/^https?:\/\//i.test(value) || !/^https?:$/.test(url.protocol)) throw new Error("invalid URL");
          value = url.href;
        }
      } catch (e) {
        el.musicApi.setAttribute("aria-invalid", "true");
        el.musicHint.textContent = "请输入完整的 http:// 或 https:// 音乐接口网址；留空使用公共源。";
        el.musicHint.style.color = "#ff7b7b";
        return;
      }
      el.musicApi.removeAttribute("aria-invalid");
      if (!writeSetting("kb_musicapi", value)) {
        sessionSettings.delete("kb_musicapi");
        el.musicHint.textContent = "浏览器暂时无法保存音乐接口，请允许本站存储后重试。";
        el.musicHint.style.color = "#ff7b7b";
        return;
      }
      el.musicApi.value = value;
      el.musicHint.textContent = value ? "已保存，下次点播时使用这个音乐接口。" : "已恢复使用公共音乐源。";
      el.musicHint.style.color = "inherit";
    };
    ["change", "blur"].forEach((event) => el.musicApi.addEventListener(event, saveMusicApi));

    const save = () => {
      writeSetting("kb_protocol", el.protocol.value);
      writeSetting("kb_base", el.base.value.trim().replace(/\/+$/, ""));
      writeSetting("kb_model", el.model.value.trim());
      writeSetting("kb_key", el.key.value.trim());
      writeSetting("kb_proxy", el.proxy.value.trim().replace(/\/+$/, ""));
      writeSetting("kb_tts", el.tts.checked ? "1" : "0");
      syncAIChannel();
    };
    ["change", "blur"].forEach((ev) => [el.protocol, el.base, el.model, el.key, el.proxy, el.tts].forEach((n) => n.addEventListener(ev, save)));

    // 协议切换时的默认占位提示
    const presets = {
      openai: { base: "https://api.deepseek.com", model: "deepseek-flash" },
      tokenrhythm: { base: "https://tokenrhythm.studio/v1", model: "glm-5" },
      gemini: { base: "https://generativelanguage.googleapis.com", model: "gemini-2.0-flash" },
      claude: { base: "https://api.anthropic.com", model: "claude-sonnet-4-20250514" },
    };
    el.protocol.addEventListener("change", () => {
      const p = presets[el.protocol.value];
      if (p) {
        if (p.base) el.base.value = p.base;
        if (p.model) el.model.value = p.model;
      }
      save();
    });

    // 读取模型列表
    el.modelsBtn.addEventListener("click", async () => {
      if (el.modelsBtn.disabled) return;
      const cur = {
        protocol: el.protocol.value,
        base: el.base.value.trim().replace(/\/+$/, ""),
        key: el.key.value.trim(),
        proxy: el.proxy.value.trim().replace(/\/+$/, ""),
      };
      if (!cur.key) { el.hint.textContent = "先填 API Key 才能读取模型"; el.hint.style.color = "#ff7b7b"; return; }
      el.modelsBtn.disabled = true;
      el.modelsBtn.textContent = "…";
      el.hint.textContent = "读取中…";
      el.hint.style.color = "inherit";
      try {
        const models = await KB.fetchModels(cur);
        if (el.protocol.value !== cur.protocol || el.base.value.trim().replace(/\/+$/, "") !== cur.base || el.key.value.trim() !== cur.key || el.proxy.value.trim().replace(/\/+$/, "") !== cur.proxy) {
          el.hint.textContent = "设置已变化，请重新读取模型";
          return;
        }
        el.list.innerHTML = models.map((m) => '<option value="' + esc(m) + '"></option>').join("");
        if (models.length) { el.model.value = models[0]; save(); }
        el.hint.textContent = "✅ 读取到 " + models.length + " 个模型，已填入下拉";
        el.hint.style.color = "#4ade80";
      } catch (e) {
        el.hint.textContent = "✗ " + e.message;
        el.hint.style.color = "#ff7b7b";
      } finally {
        el.modelsBtn.textContent = "🔄";
        el.modelsBtn.disabled = false;
      }
    });
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  /* ---------- 拖拽移动看板娘（按住 Miku 拖动到任意位置） ---------- */
  function initDrag() {
    const root = $("kanban"), stage = $("kb-stage");
    if (!root || !stage) return;
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    stage.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, input, select, textarea, a")) return;
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      const r = root.getBoundingClientRect();
      ox = r.left; oy = r.top;
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    });
    stage.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (moved) {
        root.style.left = Math.max(0, Math.min(window.innerWidth - 60, ox + dx)) + "px";
        root.style.top = Math.max(0, Math.min(window.innerHeight - 60, oy + dy)) + "px";
      }
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      if (!moved) {
        window.MikuCompanion.react("比心");
        bubble("比心给你 ♡");
        window.MikuVoice?.play?.("heart");
      } else {
        const r = root.getBoundingClientRect();
        writeSetting("kb_pos", JSON.stringify({ left: r.left, top: r.top }));
      }
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
  }

  /* 恢复上次拖拽的位置 */
  function restorePos() {
    const root = $("kanban");
    if (!root) return;
    try {
      const p = JSON.parse(readSetting("kb_pos") || "null");
      if (p && typeof p.left === "number" && typeof p.top === "number") {
        root.style.left = Math.max(0, Math.min(window.innerWidth - 60, p.left)) + "px";
        root.style.top = Math.max(0, Math.min(window.innerHeight - 60, p.top)) + "px";
      }
    } catch (e) {}
  }

  /* ---------- 绑定交互 ---------- */
  function syncAIChannel() {
    const label = $("kb-ai-channel");
    if (!label) return;
    const status = window.MikuAI?.status();
    label.textContent = KB.getSettings().key ? "个人 AI 接口" : status?.configured ? "DeepSeek · 站内内容问答" : status?.checking ? "正在接通 AI…" : "本地陪伴 · AI 暂未连接";
  }
  document.addEventListener("miku:ai-status", syncAIChannel);
  function bindUI() {
    const chat = $("kb-chat"), set = $("kb-set");
    $("kb-chat-btn").addEventListener("click", () => {
      chat.classList.toggle("open");
      set.classList.remove("open");
      if (chat.classList.contains("open")) $("kb-input").focus();
    });
    $("kb-set-btn").addEventListener("click", () => {
      set.classList.toggle("open");
      chat.classList.remove("open");
      if (set.classList.contains("open")) fitSettings();
    });
    $("kb-chat-close").addEventListener("click", () => chat.classList.remove("open"));
    $("kb-set-close").addEventListener("click", () => set.classList.remove("open"));
    $("kb-send").addEventListener("click", doSend);
    $("kb-cancel").addEventListener("click", () => sendController?.abort());
    $("kb-ai-open").addEventListener("click", async () => {
      await window.MikuAIModuleReady;
      if (window.MikuAI) window.MikuAI.open({ mode: document.body.dataset.page === "post" ? "article" : "chat" });
      else bubble("对话室暂时没有连接上，刷新后可以再试一次。", 3200);
    });
    syncAIChannel();
    window.MikuAIModuleReady?.then(syncAIChannel);
    $("kb-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); doSend(); }
    });

    // 收起 / 展开 + 移动端最小化按钮
    const root = $("kanban"), min = $("kanban-min");
    $("kb-hide-btn").addEventListener("click", hide);
    min.addEventListener("click", show);
    window.addEventListener("resize", fitSettings);
    initDrag();
  }

  /* ---------- 启动 ---------- */
  function boot() {
    if ($("kanban")) return;
    buildDOM();
    bindUI();
    initSettings();
    restorePos();
    const h = new Date().getHours();
    const greet = h < 5 ? "这么晚还不睡呀主人？Miku 陪你 ♪"
      : h < 11 ? "早安主人！今天也元气满满哦 ♪"
      : h < 14 ? "中午好呀～ 记得好好吃饭 ♪"
      : h < 18 ? "下午好～ 要听点歌放松一下吗 ♪"
      : h < 23 ? "晚上好呀主人，Miku 等你很久啦 ♪"
      : "夜深了主人，早点休息哦 ♪";
    addMsg("ai", greet + " 可以跟我聊几句，也能跟我说「放 歌名」点歌。点 ⚙️ 配置 AI 接口后可自由对话。");
    bubble("欢迎来到小窝 ♪");
    resolveReady(window.MikuCompanion);
    document.dispatchEvent(new CustomEvent("miku:ready", { detail: { companion: window.MikuCompanion } }));
    // Live2D 资源较大（数 MB），等首屏渲染完、浏览器空闲时再加载，避免阻塞首屏
    const kick = () => { initPixi().catch((e) => console.warn("[kanban]", e)); };
    if ("requestIdleCallback" in window) requestIdleCallback(kick, { timeout: 5000 });
    else setTimeout(kick, 3000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
