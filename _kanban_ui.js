/* ---------- 看板娘 UI 组件 ---------- */
(function kanbanUI() {
  let model = null;
  let history = [];
  let sessionLyricOff = sessionStorage.getItem("mm_lyric_off") === "1";

  const pin = { left: 14, top: window.innerWidth < 680 ? Math.round(window.innerHeight * 0.5) : 140 };

  function $(id) { return document.getElementById(id); }
  function status(msg, ok) {
    document.querySelectorAll(".js-status").forEach((el) => {
      el.textContent = msg;
      el.style.color = ok === true ? "#4ade80" : ok === false ? "#ff7b7b" : "inherit";
    });
  }

  /* ---------- buildDOM ---------- */
  function buildDOM() {
    // 这个函数由 HTML 中的静态结构替代，不需要动态创建
  }

  /* ---------- 表情与情绪 ---------- */
  const EMOTES = ["比心", "圈圈", "脸红", "前倾", "唱歌", "葱", "QQ人"];
  function setEmotion(name) {
    if (!model || !EMOTES.includes(name)) return;
    try { model.expression(name); } catch (e) {}
  }
  function react(text) {
    const map = [
      [/(喜欢|爱|比心|心动)/, "比心"],
      [/(害羞|脸红|讨厌啦)/, "脸红"],
      [/(难过|伤心|哭)/, "前倾"],
      [/(生气|哼|可恶)/, "QQ人"],
      [/(哇|什么|惊|！|\?)/, "圈圈"],
      [/(唱歌|歌|音乐|♪)/, "唱歌"],
    ];
    for (const [re, emo] of map) {
      try { if (re.test(text)) { setEmotion(emo); return; } } catch (err) {}
    }
  }

  /* ---------- 聊天消息 ---------- */
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
    if (!localStorage.getItem("kb_tts") || !("speechSynthesis" in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN";
      u.rate = 1.05;
      u.pitch = 1.3;
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  /* ---------- AI 请求 ---------- */
  async function askAI(messages) {
    const settings = AIChat.getSettings();
    if (!settings.key) throw new Error("请先在设置里填 API Key");
    if (settings.protocol === "gemini") return AIChat.requestGemini(settings, messages);
    if (settings.protocol === "claude") return AIChat.requestClaude(settings, messages);
    return AIChat.requestOpenAI(settings, messages);
  }

  /* ---------- 绑定 UI 事件 ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    bindChatButtons();
    bindSettings();
    bindTabSwitch();
  });

  function bindChatButtons() {
    const btn = $("btn-say");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const text = $("s-text").value.trim();
      if (!text && !sQueue.length) { status("写点什么或选张图吧", false); return; }
      if (text.length > 500) { status("文字超过 500 字了", false); return; }
      if (!AIChat.getToken()) { status("还没有配置令牌，请到「设置」页粘贴一次", false); return; }
      btn.disabled = true;
      try {
        const now = new Date();
        const pad = (x) => String(x).padStart(2, "0");
        const time = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) + " " + pad(now.getHours()) + ":" + pad(now.getMinutes());
        const images = [];
        for (let i = 0; i < sQueue.length; i++) {
          status("上传图片（" + (i + 1) + "/" + sQueue.length + "）…");
          const name = "say_" + now.getTime() + "_" + i + ".jpg";
          await AIChat.ghPutFile("assets/says/" + name, sQueue[i].bytes, "发布说说配图");
          images.push("assets/says/" + name);
        }
        status("更新说说列表…");
        let oldSays = [];
        try {
          const r = await AIChat.ghApi("says/says.json");
          if (r.ok) {
            const b64 = (await r.json()).content.replace(/\s/g, "");
            oldSays = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).says || [];
          }
        } catch (e) { /* 新文件 */ }
        const say = { id: Date.now().toString(36), text, images, time };
        const payload = JSON.stringify({ says: [say, ...oldSays] }, null, 2);
        await AIChat.ghPutFile("says/says.json", new TextEncoder().encode(payload), "发布说说：" + (text.slice(0, 20) || "[图片]"));
        sQueue.length = 0;
        renderSayPreviews();
        status("✅ 说说已发布！构建完成后在「说说」页面可见", true);
      } catch (err) {
        status("✗ 发布失败：" + err.message, false);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function renderSayPreviews() {
    const box = $("s-previews");
    if (!box) return;
    box.innerHTML = sQueue
      .map((q, i) => `
        <div style="position:relative;">
          <img src="${q.url}" style="width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid var(--border);">
          <button class="ds-close" data-i="${i}" style="position:absolute;top:-6px;right:-6px;background:var(--card-deep);border-radius:50%;width:20px;height:20px;">✕</button>
        </div>`)
      .join("");
    box.querySelectorAll("[data-i]").forEach((b) =>
      b.addEventListener("click", () => { sQueue.splice(+b.dataset.i, 1); renderSayPreviews(); }));
  }
})();
