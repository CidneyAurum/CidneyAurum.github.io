/* ============================================
   Miku 看板娘 · AI 多协议对话 + 音乐点播
   AI 协议：OpenAI 兼容 / Google Gemini / Anthropic Claude（自选）
   ============================================ */
"use strict";

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

/* ---------- AI 多协议引擎 ---------- */
const AIChat = (function () {
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

  async function requestOpenAI(st, messages) {
    const res = await fetch(st.base + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + st.key },
      body: JSON.stringify({ model: st.model, messages, temperature: 0.9 }),
    });
    if (!res.ok) throw new Error("API " + res.status + ": " + (await res.text()).slice(0, 120));
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
    const res = await fetch(st.base + "/v1beta/models/" + st.model + ":generateContent?key=" + st.key, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("Gemini " + res.status);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "(空回复)";
  }

  async function requestClaude(st, messages) {
    const sys = messages.find((m) => m.role === "system");
    const msgs = messages.filter((m) => m.role !== "system");
    const res = await fetch(st.base + "/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "x-api-key": st.key,
        "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: st.model, max_tokens: 512, system: sys?.content, messages: msgs }),
    });
    if (!res.ok) throw new Error("Claude " + res.status);
    const data = await res.json();
    return data.content?.[0]?.text || "(空回复)";
  }

  async function askAI(messages) {
    const st = getSettings();
    if (!st.key) throw new Error("请先在设置里填 API Key");
    if (st.protocol === "gemini") return requestGemini(st, messages);
    if (st.protocol === "claude") return requestClaude(st, messages);
    return requestOpenAI(st, messages);
  }

  return { getSettings, askAI, SYSTEM_PROMPT };
})();

/* ---------- 看板娘组件 ---------- */
(function kanbanUI() {
  let model = null;
  let chatHistory = [];
  const EMOTES = ["比心", "圈圈", "脸红", "前倾", "唱歌", "葱", "QQ人"];

  function $(id) { return document.getElementById(id); }

  function setEmotion(name) {
    if (!model || !EMOTES.includes(name)) return;
    try { model.expression(name); } catch (e) {}
  }

  function parseEmote(text) {
    let emote = null;
    const out = text.replace(/[【\[]\s*表情\s*[:：]\s*([^\】\]]+)\s*[】\]]/g, (_, n) => {
      const clean = n.trim();
      if (EMOTES.includes(clean)) { emote = clean; return ""; }
      return "";
    });
    return { text: out.trim(), emote };
  }

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
    if (!localStorage.getItem("kb_tts") || !("speechSynthesis" in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN"; u.rate = 1.05; u.pitch = 1.3;
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  /* ---------- AI 对话发送 ---------- */
  async function sendChat(text) {
    chatHistory.push({ role: "user", content: text });
    if (chatHistory.length > 12) chatHistory = chatHistory.slice(-12);
    const settings = AIChat.getSettings();
    const thinking = addMsg("ai", "…");
    try {
      const reply = await AIChat.askAI(history);
      chatHistory.push({ role: "assistant", content: reply });
      const parsed = parseEmote(reply);
      if (parsed.emote) setEmotion(parsed.emote);
      thinking.textContent = parsed.text || "(^_^)";
      speak(parsed.text);
    } catch (err) {
      thinking.textContent = "呜…" + err.message;
    }
  }

  /* ---------- 初始化 ---------- */
  function init() {
    if (!document.getElementById("kb-stage")) return; // 页面没有看板娘容器
    try {
      initPixi();
    } catch (e) { console.warn("[kanban]", e.message); }
    bindChatInput();
  }

  async function initPixi() {
    // 加载 Cubism Core + PixiJS + Live2D 插件
    await loadScript("https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js");
    await loadScript("https://cdn.jsdelivr.net/npm/pixi.js@7.4.2/dist/pixi.min.js");
    await loadScript("https://cdn.jsdelivr.net/npm/pixi-live2d-display-lipsyncpatch@0.5.0-ls-8/dist/cubism4.min.js");

    const stage = $("kb-stage");
    const W = stage.clientWidth, H = stage.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const app = new PIXI.Application({ width: W, height: H, backgroundAlpha: 0, autoDensity: true, resolution: dpr, preserveDrawingBuffer: true });
    stage.insertBefore(app.view, stage.firstChild);
    model = await PIXI.live2d.Live2DModel.from("assets/live2d/miku/miku.model3.json", { autoInteract: false });
    const s = (H * 0.96) / model.internalModel.height;
    model.scale.set(s);
    model.x = (W - model.width) / 2;
    model.y = H - model.height;
    app.stage.addChild(model);
    model.interactive = true;
    model.on("pointerdown", () => {
      setEmotion("happy");
      try { model.expression("比心"); } catch (e) {}
      const bubble = document.querySelector(".kb-bubble");
      if (bubble) { bubble.textContent = "比心给你 ♡"; bubble.classList.add("show"); setTimeout(() => bubble.classList.remove("show"), 2500); }
    });

    // 关闭作者水印（模型说明允许关闭）
    model.internalModel.on("beforeModelUpdate", () => {
      try { model.internalModel.coreModel.setParameterValueById("Param137", 1); } catch (e) {}
    });

    // 窗口缩放
    window.addEventListener("resize", () => {
      const w2 = stage.clientWidth, h2 = stage.clientHeight;
      app.renderer.resize(w2, h2);
      const s2 = (h2 * 0.96) / model.internalModel.height;
      model.scale.set(s2);
      model.x = (w2 - model.width) / 2;
      model.y = h2 - model.height;
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("load fail: " + src));
      document.head.appendChild(s);
    });
  }

  function setEmotion(name) { /* Live2D 表情切换 */ }

  function bindChatInput() {
    const input = $("kb-input");
    const btn = $("kb-send");
    if (!input || !btn) return;
    const doSend = async () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      addMsg("me", text);
      react(text);
      const thinking = addMsg("ai", "…");
      try {
        const reply = await askAI(history.length > 0 ? [...history, { role: "user", content: text }] : [{ role: "user", content: text }]);
        chatHistory.push({ role: "user", content: text });
        chatHistory.push({ role: "assistant", content: reply });
        const parsed = parseEmote(reply);
        if (parsed.emote) setEmotion(parsed.emote);
        thinking.textContent = parsed.text || "(^_^)";
        speak(parsed.text);
      } catch (err) {
        thinking.textContent = "呜…" + err.message;
      }
    };
    btn.addEventListener("click", doSend);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSend(); });
  }

  const history = [];
  function speak(text) {
    if (!localStorage.getItem("kb_tts") || !("speechSynthesis" in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN"; u.rate = 1.05; u.pitch = 1.3;
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
