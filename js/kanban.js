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
  /* ---------- AI 多协议引擎（本地命名，不污染全局） ---------- */
  const KB = (function () {
    function getSettings() {
      return {
        protocol: localStorage.getItem("kb_protocol") || "openai",
        base: (localStorage.getItem("kb_base") || "https://api.deepseek.com").replace(/\/+$/, ""),
        model: localStorage.getItem("kb_model") || "deepseek-chat",
        key: localStorage.getItem("kb_key") || "",
        proxy: (localStorage.getItem("kb_proxy") || "").replace(/\/+$/, ""),
        tts: localStorage.getItem("kb_tts") !== "0",
      };
    }

    /* 若配置了 CORS 代理，则把请求改道代理转发（代理负责加跨域头） */
    function u(st, path) {
      const raw = st.base + path;
      return st.proxy ? st.proxy + "/?url=" + encodeURIComponent(raw) : raw;
    }

    const SYSTEM_PROMPT =
      "你是看板娘「Miku」，住在 CidneyAurum 的个人网站小窝里。性格元气可爱、偶尔傲娇。" +
      "用中文回复，每次 1~3 句话，亲切自然。你可以在回复里插入一个表情标记来做动作，" +
      "可用表情：比心、圈圈、脸红、前倾、唱歌、葱、QQ人，格式如【表情:比心】，每次最多一个，不必每句都带。" +
      "主人叫 CidneyAurum。如果被问到你是谁，就说你是这个网站的看板娘初音。";

    async function requestOpenAI(st, messages) {
      const res = await fetch(u(st, "/chat/completions"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + st.key },
        body: JSON.stringify({ model: st.model, messages, temperature: 0.9 }),
      });
      if (!res.ok) throw new Error("API " + res.status + ": " + (await res.text()).slice(0, 140));
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "(空回复)";
    }

    async function requestGemini(st, messages) {
      const sys = messages.find((m) => m.role === "system");
      const contents = messages.filter((m) => m.role !== "system").map((m) => ({
        role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }],
      }));
      const body = { contents, generationConfig: { temperature: 0.9, maxOutputTokens: 512 } };
      if (sys) body.systemInstruction = { parts: [{ text: sys.content }] };
      const res = await fetch(u(st, "/v1beta/models/" + st.model + ":generateContent?key=" + st.key), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Gemini " + res.status + ": " + (await res.text()).slice(0, 140));
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "(空回复)";
    }

    async function requestClaude(st, messages) {
      const sys = messages.find((m) => m.role === "system");
      const msgs = messages.filter((m) => m.role !== "system");
      const res = await fetch(u(st, "/v1/messages"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json", "x-api-key": st.key,
          "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model: st.model || "claude-sonnet-4-20250514", max_tokens: 512, system: sys?.content, messages: msgs }),
      });
      if (!res.ok) throw new Error("Claude " + res.status + ": " + (await res.text()).slice(0, 140));
      const data = await res.json();
      return data.content?.[0]?.text || "(空回复)";
    }

    async function askAI(messages) {
      const st = getSettings();
      if (!st.key) throw new Error("还没填 API Key，点右下角 ⚙️ 配置");
      if (st.protocol === "gemini") return requestGemini(st, messages);
      if (st.protocol === "claude") return requestClaude(st, messages);
      return requestOpenAI(st, messages);
    }

    /* 读取可用模型列表（协议自选） */
    async function fetchModels(st) {
      if (st.protocol === "gemini") {
        const res = await fetch(u(st, "/v1beta/models?key=" + st.key));
        if (!res.ok) throw new Error("Gemini 模型列表 " + res.status + ": " + (await res.text()).slice(0, 100));
        const data = await res.json();
        return (data.models || []).map((m) => (m.name || "").replace(/^models\//, "")).filter(Boolean);
      }
      if (st.protocol === "claude") {
        const res = await fetch(u(st, "/v1/models"), {
          headers: { "x-api-key": st.key, "anthropic-version": "2023-06-01" },
        });
        if (!res.ok) throw new Error("Claude 模型列表 " + res.status);
        const data = await res.json();
        return (data.data || []).map((m) => m.id).filter(Boolean);
      }
      // OpenAI 兼容
      const res = await fetch(u(st, "/models"), {
        headers: { Authorization: "Bearer " + st.key },
      });
      if (!res.ok) throw new Error("模型列表 " + res.status + ": " + (await res.text()).slice(0, 100));
      const data = await res.json();
      return (data.data || []).map((m) => m.id).filter(Boolean);
    }

    return { getSettings, askAI, fetchModels, SYSTEM_PROMPT };
  })();

  /* ---------- 看板娘 UI ---------- */
  let model = null;
  let history = [];
  const EMOTES = ["比心", "圈圈", "脸红", "前倾", "唱歌", "葱", "QQ人"];

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
        <div class="kb-msgs" id="kb-msgs"></div>
        <div class="kb-input-row">
          <input id="kb-input" placeholder="说点什么，或「放 歌名」点歌…" autocomplete="off">
          <button id="kb-send">发送</button>
        </div>
      </div>
      <div class="kb-set" id="kb-set">
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
          <input id="kb-model" list="kb-model-list" placeholder="deepseek-chat" autocomplete="off">
          <datalist id="kb-model-list"></datalist>
          <button class="kb-btn" id="kb-models-btn" title="读取可用模型列表" style="flex:0 0 34px;">🔄</button>
        </div>
        <label for="kb-key">API Key</label>
        <input id="kb-key" type="password" placeholder="sk-…" autocomplete="off">
        <label for="kb-proxy">CORS 代理地址（可选，基元律动必填）</label>
        <input id="kb-proxy" placeholder="https://你的worker.workers.dev" autocomplete="off">
        <label class="kb-check"><input type="checkbox" id="kb-tts"> 语音朗读回复</label>
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
  function setEmotion(name) {
    if (!model || !EMOTES.includes(name)) return;
    try { model.expression(name); } catch (e) {}
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

  function speak(text) {
    if (!KB.getSettings().tts || !("speechSynthesis" in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN"; u.rate = 1.05; u.pitch = 1.3;
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  /* ---------- 音乐点播命令 ---------- */
  async function musicCommand(text) {
    const t = text.trim();
    if (!window.MikuMusic) return null;
    if (/^(播放|放)\s*(歌单|全部|列表)/.test(t)) {
      const n = await window.MikuMusic.playPlaylist();
      return { reply: "好嘞，从歌单开始放啦～ 一共 " + n + " 首 ♪", emote: "唱歌" };
    }
    if (/^(随便|随机|来一首|换一首|下一首)/.test(t)) {
      if (t.includes("下一")) { window.MikuMusic.next(); return { reply: "换下一首～", emote: "唱歌" }; }
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
  async function doSend() {
    const input = $("kb-input");
    const text = (input.value || "").trim();
    if (!text) return;
    input.value = "";
    addMsg("me", text);
    react(text);

    // 音乐点播优先
    const mm = await musicCommand(text).catch((e) => ({ reply: "呜…" + e.message }));
    if (mm) {
      addMsg("ai", mm.reply);
      if (mm.emote) setEmotion(mm.emote);
      speak(mm.reply);
      return;
    }

    history.push({ role: "user", content: text });
    if (history.length > 16) history = history.slice(-16);
    const thinking = addMsg("ai", "…");
    try {
      const reply = await KB.askAI([{ role: "system", content: KB.SYSTEM_PROMPT }, ...history]);
      history.push({ role: "assistant", content: reply });
      const parsed = parseEmote(reply);
      if (parsed.emote) setEmotion(parsed.emote);
      thinking.textContent = parsed.text || "(^_^)";
      speak(parsed.text);
    } catch (err) {
      thinking.textContent = "呜…" + err.message;
    }
  }

  /* ---------- Live2D 渲染 ---------- */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("load fail: " + src));
      document.head.appendChild(s);
    });
  }

  async function initPixi() {
    const stage = $("kb-stage");
    const loading = $("kb-loading");
    if (!stage) return;
    try {
      await loadScript("https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js");
      await loadScript("https://cdn.jsdelivr.net/npm/pixi.js@7.4.2/dist/pixi.min.js");
      await loadScript("https://cdn.jsdelivr.net/npm/pixi-live2d-display-lipsyncpatch@0.5.0-ls-8/dist/cubism4.min.js");
    } catch (e) {
      if (loading) { loading.innerHTML = "<span>◌</span><br>模型资源加载失败<br><span style='font-size:11px;opacity:.7'>检查网络后刷新试试</span>"; }
      return;
    }

    const W = stage.clientWidth, H = stage.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const app = new PIXI.Application({
      width: W, height: H, backgroundAlpha: 0,
      autoDensity: true, resolution: dpr, preserveDrawingBuffer: true,
    });
    stage.insertBefore(app.view, stage.firstChild);

    try {
      model = await PIXI.live2d.Live2DModel.from("assets/live2d/miku/miku.model3.json", { autoInteract: false });
    } catch (e) {
      if (loading) { loading.innerHTML = "<span>◌</span><br>模型加载失败<br><span style='font-size:11px;opacity:.7'>" + e.message + "</span>"; }
      return;
    }

    const fit = () => {
      const w = stage.clientWidth, h = stage.clientHeight;
      app.renderer.resize(w, h);
      const s = (h * 0.98) / model.internalModel.height;
      model.scale.set(s);
      model.x = (w - model.width) / 2;
      model.y = h - model.height;
    };
    fit();

    if (loading) loading.remove();
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

    // 口型：唱歌时强制开嘴参数（music.js 通过 window.__kbSinging 标记）
    try {
      model.internalModel.on("afterModelUpdate", () => {
        const sing = window.__kbSinging === true;
        try {
          const mouth = model.internalModel.coreModel.getParameterValueById("ParamMouthOpenY");
          if (mouth != null && sing) model.internalModel.coreModel.setParameterValueById("ParamMouthOpenY", 0.5 + 0.5 * Math.random());
        } catch (e) {}
      });
    } catch (e) {}

    window.addEventListener("resize", fit);
  }

  /* ---------- 设置面板 ---------- */
  function initSettings() {
    const el = {
      protocol: $("kb-protocol"), base: $("kb-base"), model: $("kb-model"),
      list: $("kb-model-list"), key: $("kb-key"), proxy: $("kb-proxy"), tts: $("kb-tts"),
      modelsBtn: $("kb-models-btn"), hint: $("kb-hint"),
    };
    const st = KB.getSettings();
    el.protocol.value = st.protocol;
    el.base.value = st.base;
    el.model.value = st.model;
    el.key.value = st.key;
    el.proxy.value = st.proxy;
    el.tts.checked = st.tts;

    const save = () => {
      localStorage.setItem("kb_protocol", el.protocol.value);
      localStorage.setItem("kb_base", el.base.value.replace(/\/+$/, ""));
      localStorage.setItem("kb_model", el.model.value.trim());
      localStorage.setItem("kb_key", el.key.value.trim());
      localStorage.setItem("kb_proxy", el.proxy.value.replace(/\/+$/, ""));
      localStorage.setItem("kb_tts", el.tts.checked ? "1" : "0");
    };
    ["change", "blur"].forEach((ev) => [el.protocol, el.base, el.model, el.key, el.proxy, el.tts].forEach((n) => n.addEventListener(ev, save)));

    // 协议切换时的默认占位提示
    const presets = {
      openai: { base: "https://api.deepseek.com", model: "deepseek-chat" },
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
      const cur = {
        protocol: el.protocol.value,
        base: el.base.value.replace(/\/+$/, ""),
        key: el.key.value.trim(),
        proxy: el.proxy.value.replace(/\/+$/, ""),
      };
      if (!cur.key) { el.hint.textContent = "先填 API Key 才能读取模型"; el.hint.style.color = "#ff7b7b"; return; }
      el.modelsBtn.textContent = "…";
      el.hint.textContent = "读取中…";
      el.hint.style.color = "inherit";
      try {
        const models = await KB.fetchModels(cur);
        el.list.innerHTML = models.map((m) => '<option value="' + esc(m) + '"></option>').join("");
        if (models.length) { el.model.value = models[0]; save(); }
        el.hint.textContent = "✅ 读取到 " + models.length + " 个模型，已填入下拉";
        el.hint.style.color = "#4ade80";
      } catch (e) {
        el.hint.textContent = "✗ " + e.message;
        el.hint.style.color = "#ff7b7b";
      } finally {
        el.modelsBtn.textContent = "🔄";
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
        setEmotion("比心");
        bubble("比心给你 ♡");
      } else {
        const r = root.getBoundingClientRect();
        try { localStorage.setItem("kb_pos", JSON.stringify({ left: r.left, top: r.top })); } catch (err) {}
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
      const p = JSON.parse(localStorage.getItem("kb_pos") || "null");
      if (p && typeof p.left === "number" && typeof p.top === "number") {
        root.style.left = Math.max(0, Math.min(window.innerWidth - 60, p.left)) + "px";
        root.style.top = Math.max(0, Math.min(window.innerHeight - 60, p.top)) + "px";
      }
    } catch (e) {}
  }

  /* ---------- 绑定交互 ---------- */
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
    });
    $("kb-chat-close").addEventListener("click", () => chat.classList.remove("open"));
    $("kb-set-close").addEventListener("click", () => set.classList.remove("open"));
    $("kb-send").addEventListener("click", doSend);
    $("kb-input").addEventListener("keydown", (e) => { if (e.key === "Enter") doSend(); });

    // 收起 / 展开 + 移动端最小化按钮
    const root = $("kanban"), min = $("kanban-min");
    $("kb-hide-btn").addEventListener("click", () => {
      root.classList.add("hidden");
      min.classList.add("show");
    });
    min.addEventListener("click", () => {
      root.classList.remove("hidden");
      min.classList.remove("show");
    });
    initDrag();
  }

  /* ---------- 启动 ---------- */
  function boot() {
    buildDOM();
    bindUI();
    initSettings();
    restorePos();
    addMsg("ai", "你好呀主人～ 我是 Miku ♪ 可以跟我聊天，也能跟我说「放 歌名」点歌哦。点 ⚙️ 配置 AI 接口。");
    bubble("欢迎来到小窝 ♪");
    // Live2D 资源较大（数 MB），等首屏渲染完、浏览器空闲时再加载，避免阻塞首屏
    const kick = () => { try { initPixi(); } catch (e) { console.warn("[kanban]", e); } };
    if ("requestIdleCallback" in window) requestIdleCallback(kick, { timeout: 5000 });
    else setTimeout(kick, 3000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
