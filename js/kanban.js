/* ============================================
   看板娘 · Miku（Live2D Cubism4）
   - 渲染：pixi.js@7 + pixi-live2d-display（与桌面助手同栈，CDN 引入）
   - 互动：拖拽 / 滚轮缩放 / 点击比心 / 情绪表情
   - AI 对话：OpenAI 兼容接口（BaseURL/模型/Key 三项自填，存本机浏览器）
   - 语音：浏览器自带 speechSynthesis 朗读（可开关）
   - 本文件不依赖、不修改 D:\Assistant
   ============================================ */
"use strict";

(function () {
  if (document.body.dataset.page === "admin") return; // 写作台不放
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 配置（✏️ 想改就动这里） ---------- */
  const CFG = {
    enabled: true,
    modelUrl: "/assets/live2d/miku/miku.model3.json", // 部署在域名根目录（用户站点），用根路径保证子目录页面也能加载
    core: "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js",
    pixi: "https://cdn.jsdelivr.net/npm/pixi.js@7.4.2/dist/pixi.min.js",
    plugins: [
      "https://cdn.jsdelivr.net/npm/pixi-live2d-display-lipsyncpatch@0.5.0-ls-8/dist/cubism4.min.js",
      "https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js", // 兜底
    ],
    idleLines: [
      "今天也要元气满满哦 ♪",
      "主人在忙什么呀？",
      "戳戳我会有好事发生 ♡",
      "要听我唱歌吗？",
      "网站里的樱花…是流萤才对啦！",
    ],
    tapLines: [
      "哇！被抓到了 (⁄ ⁄•⁄ω⁄•⁄ ⁄)",
      "比心给你 ♡",
      "嘿嘿，最喜欢主人啦！",
      "再戳就要生气了哦——才怪！",
      "♪♪♪",
    ],
    fallbackReplies: [
      "（API 还没配置，我先用备忘录跟你聊啦）主人今天过得好吗？",
      "唔…我的大脑还在「设置」里等一个 API Key 呢。",
      "哼哼，等你把 Key 填好，我就能对答如流了！",
    ],
    // 情绪 → 表情（沿用桌面助手的映射）
    emotionMap: { happy: "比心", shy: "脸红", sad: "前倾", angry: "QQ人", surprise: "圈圈", sing: "唱歌", neutral: null },
    keywords: [
      [/(喜欢|爱|比心|心动)/, "happy"],
      [/(害羞|脸红|讨厌啦)/, "shy"],
      [/(难过|伤心|哭|呜)/, "sad"],
      [/(生气|哼|可恶)/, "angry"],
      [/(哇|什么|惊|！|\?|？)/, "surprise"],
      [/(唱歌|歌|音乐|♪)/, "sing"],
    ],
  };

  const EMOTES = ["比心", "圈圈", "脸红", "前倾", "唱歌", "葱", "QQ人"];
  let model = null, app = null, booted = false, bubbleTimer = null;
  let history = []; // [{role, content}]
  const store = {
    get base() { return localStorage.getItem("kb_base") || "https://api.deepseek.com"; },
    get model() { return localStorage.getItem("kb_model") || "deepseek-chat"; },
    get key() { return localStorage.getItem("kb_key") || ""; },
    get tts() { return localStorage.getItem("kb_tts") === "1"; },
  };

  /* ---------- DOM 骨架 ---------- */
  function buildDOM() {
    const el = document.createElement("div");
    el.className = "kanban";
    el.id = "kanban";
    el.innerHTML = `
      <div class="kb-bubble" id="kb-bubble"></div>
      <div class="kb-stage" id="kb-stage">
        <div class="kb-loading" id="kb-loading"><span class="spin">✦</span><br>Miku 加载中…<br>首次约 35MB 请稍等</div>
      </div>
      <div class="kb-bar">
        <button class="kb-btn" data-act="chat" title="聊天">💬</button>
        <button class="kb-btn" data-act="set" title="AI 设置">⚙️</button>
        <button class="kb-btn" data-act="hide" title="躲起来">🙈</button>
      </div>
      <div class="kb-chat" id="kb-chat">
        <div class="kb-chat-head"><span>Miku ♪</span><button class="kb-btn" data-close="1" style="width:26px;height:26px;font-size:11px;">✕</button></div>
        <div class="kb-msgs" id="kb-msgs"></div>
        <div class="kb-input-row">
          <input id="kb-input" type="text" placeholder="跟 Miku 说点什么…" autocomplete="off">
          <button id="kb-send">发送</button>
        </div>
      </div>
      <div class="kb-set" id="kb-set">
        <div class="side-label">AI / 音乐设置（存本机浏览器）</div>
        <div class="field"><label>接口地址 BaseURL</label><input id="kb-base" placeholder="https://api.deepseek.com"></div>
        <div class="field"><label>模型名</label><input id="kb-model" placeholder="deepseek-chat"></div>
        <div class="field"><label>API Key</label><input id="kb-key" type="password" placeholder="sk-…"></div>
        <div class="field"><label>音乐 API（可选，Meting 格式自建源，VIP 全曲）</label><input id="kb-musicapi" placeholder="https://你的-meting-源/"></div>
        <label style="font-size:12.5px;color:var(--text-light);display:flex;gap:8px;align-items:center;">
          <input type="checkbox" id="kb-tts" style="width:auto;"> 语音朗读回复
        </label>
        <div class="actions" style="margin:0;">
          <button class="ctrl-btn" id="kb-save">💾 保存</button>
          <button class="ctrl-btn ghost" id="kb-cls">🧹 清除 Key</button>
        </div>
      </div>`;
    document.body.appendChild(el);

    const min = document.createElement("button");
    min.className = "kanban-min";
    min.id = "kanban-min";
    min.textContent = "🎵";
    min.title = "把看板娘叫回来";
    min.addEventListener("click", () => {
      el.classList.remove("hidden");
      min.classList.remove("show");
    });
    document.body.appendChild(min);

    // 恢复上次拖拽的位置
    try {
      const pos = JSON.parse(localStorage.getItem("kb_pos") || "null");
      if (pos && window.innerWidth > 900) {
        el.style.left = Math.max(4, Math.min(window.innerWidth - 120, pos.left)) + "px";
        el.style.bottom = Math.max(0, Math.min(window.innerHeight - 100, pos.bottom)) + "px";
      }
    } catch (e) {}

    el.querySelector('[data-act="hide"]').addEventListener("click", () => {
      el.classList.add("hidden");
      min.classList.add("show");
    });
    el.querySelector('[data-act="chat"]').addEventListener("click", () => {
      $("kb-chat").classList.toggle("open");
      $("kb-set").classList.remove("open");
      if ($("kb-chat").classList.contains("open")) $("kb-input").focus();
    });
    el.querySelector('[data-act="set"]').addEventListener("click", () => {
      $("kb-set").classList.toggle("open");
      $("kb-chat").classList.remove("open");
      $("kb-base").value = store.base;
      $("kb-model").value = store.model;
      $("kb-key").value = store.key;
      $("kb-musicapi").value = localStorage.getItem("kb_musicapi") || "";
      $("kb-tts").checked = store.tts;
    });
    el.querySelector("[data-close]").addEventListener("click", () => $("kb-chat").classList.remove("open"));
    $("kb-save").addEventListener("click", () => {
      localStorage.setItem("kb_base", $("kb-base").value.trim() || "https://api.deepseek.com");
      localStorage.setItem("kb_model", $("kb-model").value.trim() || "deepseek-chat");
      localStorage.setItem("kb_key", $("kb-key").value.trim());
      localStorage.setItem("kb_musicapi", $("kb-musicapi").value.trim());
      localStorage.setItem("kb_tts", $("kb-tts").checked ? "1" : "0");
      bubble("设置好啦！现在可以跟我聊天、点歌了 ♪", true);
    });
    $("kb-cls").addEventListener("click", () => {
      localStorage.removeItem("kb_key");
      $("kb-key").value = "";
      bubble("Key 已清除～");
    });
    $("kb-send").addEventListener("click", send);
    $("kb-input").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
  }
  const $ = (id) => document.getElementById(id);

  /* ---------- 气泡 ---------- */
  function bubble(text, hold) {
    const b = $("kb-bubble");
    if (!b) return;
    b.textContent = text;
    b.classList.add("show");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => b.classList.remove("show"), hold ? 6000 : 3800);
  }

  /* ---------- 表情与情绪 ---------- */
  function setEmotion(name) {
    if (!model) return;
    const ex = CFG.emotionMap[name];
    try {
      if (ex) model.expression(ex);
      else model.internalModel.motionManager.stopAllExpressions?.();
    } catch (e) { /* 部分版本接口不同，静默 */ }
  }
  function react(text) {
    for (const [re, emo] of CFG.keywords) {
      try { if (re.test(text)) { setEmotion(emo); return emo; } } catch (e) {}
    }
    return null;
  }

  /* ---------- 对话 ---------- */
  function addMsg(role, text) {
    const box = $("kb-msgs");
    const div = document.createElement("div");
    div.className = "kb-msg " + (role === "me" ? "me" : "ai");
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  function parseEmote(text) {
    let emote = null;
    const out = text.replace(/[【\[]\s*表情\s*[:：]\s*([^\】\]]+)\s*[】\]]/g, (_, name) => {
      const n = name.trim();
      if (EMOTES.includes(n)) { emote = n; return ""; }
      return "";
    });
    return { text: out.trim(), emote };
  }

  function speak(text) {
    if (!store.tts || !("speechSynthesis" in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN";
      u.rate = 1.05;
      u.pitch = 1.3;
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  function localReply() {
    return CFG.fallbackReplies[Math.floor(Math.random() * CFG.fallbackReplies.length)];
  }

  async function send() {
    const input = $("kb-input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    addMsg("me", text);

    // 音乐点播指令优先（本地处理）
    try {
      const musicReply = await tryMusicCommand(text);
      if (musicReply) {
        addMsg("ai", musicReply);
        bubble(musicReply.slice(0, 50));
        speak(musicReply);
        return;
      }
    } catch (err) {
      const msg = "呜…放歌失败了：" + err.message;
      addMsg("ai", msg);
      bubble(msg.slice(0, 50));
      return;
    }

    react(text);
    const thinking = addMsg("ai", "…");

    if (!store.key) {
      const r = localReply();
      setTimeout(() => { thinking.textContent = r; bubble(r); speak(r); }, 500);
      return;
    }
    history.push({ role: "user", content: text });
    if (history.length > 12) history = history.slice(-12);
    try {
      const base = store.base.replace(/\/+$/, "");
      const res = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${store.key}` },
        body: JSON.stringify({
          model: store.model,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
          temperature: 0.9,
        }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      let reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "（我走神了…再说一次？）";
      history.push({ role: "assistant", content: reply });
      const parsed = parseEmote(reply);
      if (parsed.emote) model && model.expression(parsed.emote);
      thinking.textContent = parsed.text || "（^_^）";
      bubble(parsed.text.slice(0, 60));
      speak(parsed.text);
    } catch (err) {
      thinking.textContent = "呜…连线失败了（" + err.message + "）。检查一下「AI 设置」里的地址、模型和 Key？";
    }
  }

  const SYSTEM_PROMPT =
    "你是看板娘「Miku」，住在 CidneyAurum 的个人网站小窝里。性格元气可爱、偶尔傲娇。" +
    "用中文回复，每次 1~3 句话，亲切自然。你可以在回复里插入一个表情标记来做动作，" +
    "可用表情：比心、圈圈、脸红、前倾、唱歌、葱、QQ人，格式如【表情:比心】，每次最多一个，不必每句都带。" +
    "主人叫 CidneyAurum。如果被问到你是谁，就说你是这个网站 Austrian 的看板娘初音。";

  /* ---------- Live2D 加载 ---------- */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("load fail: " + src));
      document.head.appendChild(s);
    });
  }
  function idle(fn) {
    if ("requestIdleCallback" in window) requestIdleCallback(fn, { timeout: 4000 });
    else setTimeout(fn, 1500);
  }

  async function boot() {
    if (booted || !CFG.enabled) return;
    booted = true;
    buildDOM();
    const start = () => idle(initStage);
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start);
  }

  async function initStage() {
    const stage = $("kb-stage");
    try {
      await loadScript(CFG.core);
      await loadScript(CFG.pixi);
      let ok = false;
      for (const url of CFG.plugins) {
        try { await loadScript(url); ok = true; break; } catch (e) { /* 试下一个 */ }
      }
      if (!ok) throw new Error("live2d 插件加载失败");
      if (!window.PIXI || !PIXI.live2d) throw new Error("live2d 命名空间缺失");

      const W = stage.clientWidth, H = stage.clientHeight;
      app = new PIXI.Application({
        width: W, height: H,
        backgroundAlpha: 0,
        autoDensity: true,
        resolution: Math.min(2, window.devicePixelRatio || 1),
        preserveDrawingBuffer: true, // 允许截图/录屏捕捉到模型画面
      });
      stage.insertBefore(app.view, stage.firstChild);
      $("kb-loading").remove();

      model = await PIXI.live2d.Live2DModel.from(CFG.modelUrl, { autoInteract: false });
      const s = (H * 0.96) / model.internalModel.height; // 留 4% 头顶空隙，完整显示全身
      model.scale.set(s);
      model.x = (W - model.width) / 2;
      model.y = H - model.height;
      app.stage.addChild(model);
      window.__kb = { model, app }; // 调试出口

      // 关闭作者水印 + 驱动唱歌口型：在动作更新后每帧覆写
      const internalModel = model.internalModel;
      const originalMotionUpdate = internalModel.motionManager.update.bind(internalModel.motionManager);
      internalModel.motionManager.update = (m, now) => {
        const result = originalMotionUpdate(m, now);
        try {
          internalModel.coreModel.setParameterValueById("Param137", 1);
          core_setMouth(internalModel.coreModel);
        } catch (e) { /* ignore */ }
        return result;
      };

      // 点击模型 → 比心 + 卖萌语
      model.interactive = true;
      model.on("pointerdown", () => {
        setEmotion("happy");
        try { model.expression("比心"); } catch (e) {}
        bubble(CFG.tapLines[Math.floor(Math.random() * CFG.tapLines.length)]);
      });

      // 拖拽整个挂件
      let dragging = null;
      const host = document.getElementById("kanban");
      stage.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        const rect = host.getBoundingClientRect();
        dragging = { x: e.clientX, y: e.clientY, left: rect.left, bottom: window.innerHeight - rect.bottom };
        stage.setPointerCapture(e.pointerId);
      });
      stage.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const nx = dragging.left + e.clientX - dragging.x;
        const nb = dragging.bottom + (e.clientY - dragging.y);
        host.style.left = Math.max(4, Math.min(window.innerWidth - 120, nx)) + "px";
        host.style.bottom = Math.max(0, Math.min(window.innerHeight - 100, nb)) + "px";
      });
      stage.addEventListener("pointerup", () => {
        if (dragging) {
          // 记住拖拽后的位置
          const rect = host.getBoundingClientRect();
          localStorage.setItem("kb_pos", JSON.stringify({ left: rect.left, bottom: window.innerHeight - rect.bottom }));
        }
        dragging = null;
      });
      stage.addEventListener("wheel", (e) => {
        e.preventDefault();
        const cur = model.scale.x;
        const next = Math.min(2.2, Math.max(0.5, cur * (e.deltaY > 0 ? 0.92 : 1.08)));
        model.scale.set(next);
      }, { passive: false });

      // 定时卖萌
      if (!reduceMotion) {
        setInterval(() => {
          if (document.hidden || Math.random() < 0.4) return;
          bubble(CFG.idleLines[Math.floor(Math.random() * CFG.idleLines.length)]);
        }, 26000);
      }
      setTimeout(() => bubble("嗨～我是 Miku，点我聊天、点歌哦 ♪"), 1800);

      // 滚动/切页时补一帧渲染（保险）
      let scrollRaf = 0;
      window.addEventListener("scroll", () => {
        if (scrollRaf) return;
        scrollRaf = requestAnimationFrame(() => { app.render(); scrollRaf = 0; });
      }, { passive: true });
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) app.render();
      });

      // 窗口尺寸变化：重设渲染器与模型位置
      window.addEventListener("resize", () => {
        const w = stage.clientWidth, h = stage.clientHeight;
        app.renderer.resize(w, h);
        const sc = (h * 0.96) / model.internalModel.height;
        model.scale.set(sc);
        model.x = (w - model.width) / 2;
        model.y = h - model.height;
      });

            // 放歌时切换到「唱歌」表情
      document.addEventListener("mikumusic", (e) => {
        if (e.detail && e.detail.playing) {
          try { model.expression("唱歌"); } catch (err) {}
        }
      });
    } catch (err) {
      window.__kbErr = String((err && err.message) || err);
      const l = $("kb-loading");
      if (l) {
        l.innerHTML = '看板娘开小差了<br><span style="font-size:11px;opacity:.7">' + esc2(window.__kbErr) + "</span>";
      } else {
        bubble("呜…我的模型加载失败了（" + window.__kbErr.slice(0, 40) + "）");
      }
      console.warn("[kanban]", err);
    }
  }
  function esc2(s) { return String(s).replace(/[<>&]/g, ""); }
  function core_setMouth(core) {
    const v = Number(window.__kbMouth || 0);
    if (v > 0.02) core.setParameterValueById("ParamMouthOpenY", Math.min(1, v));
  }

  /* ---------- 音乐点播指令（本地处理，不进 AI） ---------- */
  async function tryMusicCommand(text) {
    if (!window.MikuMusic) return null;
    const t = text.trim();
    const M = window.MikuMusic;
    if (/^(下一首|换一首|切歌)/.test(t)) {
      return M.next() ? "换歌啦，继续听 ♪" : "还没在播歌哦，先说「放 歌名」吧";
    }
    if (/^暂停/.test(t)) {
      if (M.getState().playing) { M.toggle(); return "好，先停一下"; }
      return "本来就没在放呀";
    }
    if (/^(继续|恢复)/.test(t)) {
      if (!M.getState().playing && M.getState().hasQueue) { M.toggle(); return "继续播放 ♪"; }
      return null;
    }
    if (/(播放|来点|放|打开)歌单/.test(t)) {
      const n = await M.playPlaylist();
      return "打开你的歌单啦，一共 " + n + " 首 ♪";
    }
    const m = t.match(/^(?:放|来一首|来首|播放|点播|唱)\s*[一]?[首个]?\s*[「『“"]?([^「『”"』」]{1,30})[」』”"]?$/);
    if (m) {
      const name = m[1].replace(/这首歌|这首|吧|呀|哦$/g, "").trim();
      if (name && !name.includes("歌单")) {
        const s = await M.searchAndPlay(name);
        return "正在为你播放《" + s.name + "》- " + s.artist + " ♪";
      }
    }
    return null;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
