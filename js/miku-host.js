/* Miku is the host of this little world: real pages, real music, short voices. */
(() => {
  "use strict";
  if (window.MikuHost) return;
  const siteRoot = new URL("../", document.currentScript.src);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clips = [
    ["greet", "会場のみんな、こんにちはー！", "在场的大家，你们好！"],
    ["identity", "初音ミクです！", "我是初音未来！"],
    ["thanks", "今日は来てくれてありがとう！", "谢谢你今天来看我！"],
    ["heart", "ふふ。わたしもだよ", "嘿嘿，我也是哦。"],
    ["music", "それじゃあ……。ミュージックスタート！", "那么……音乐开始！"],
  ];
  let activated = false, hostVisible = true, companion = null, actionId = 0;
  let caption = "我是 Miku。手记、收藏，还是一首歌？今天想和我一起逛哪里？";
  let guide = null, hostObserver = null, modal = null, modalId = 0, roomCommand = 0, modalFocus = null;
  let modalInert = [], previousOverflow = "", modelHome = null;
  const dock = document.createElement("aside");
  dock.className = "miku-dock";
  dock.setAttribute("aria-label", "Miku 的陪伴卡片");
  dock.hidden = true;
  dock.innerHTML = '<div class="miku-dock-heading"><span>MIKU · 陪你逛逛</span><button type="button" data-miku-action="dismiss" aria-label="收起陪伴卡片">×</button></div><p class="miku-dock-text" aria-live="polite"></p><div class="miku-dock-actions"></div>';
  document.body.appendChild(dock);

  function tell(text) {
    caption = String(text);
    document.getElementById("miku-host-text")?.replaceChildren(document.createTextNode(caption));
    dock.querySelector(".miku-dock-text").textContent = caption;
    companion?.say(caption);
  }
  function status(text) {
    const target = document.getElementById("miku-host-status");
    if (target) target.textContent = text;
  }
  function musicState() { return window.MikuMusic?.getState?.() || {}; }
  async function voice(event, force = false) {
    const engine = window.MikuVoice;
    if (!engine || (!force && musicState().playing)) return false;
    try { await engine.ready; return await engine.play(event, { force }); }
    catch (_) { status("这次没听清也没关系，我还在这里。可以打开声音卡片再试一次。"); return false; }
  }
  async function appear(id) {
    activated = true;
    refreshDock();
    if (companion) { if (id === actionId) companion.show(); return companion; }
    status("我来啦，正在把耳机戴好……");
    try {
      const loaded = window.MikuCompanion || await window.MikuLoader?.load();
      if (!loaded) throw Error("Miku loader unavailable");
      companion = loaded;
      if (id === actionId) { loaded.show(); status("Miku 已来到你身边。声音可在「听听我的声音」中关闭。"); }
      return loaded;
    } catch (_) {
      status("Miku 的模型暂时没赶上，仍然可以一起逛逛、听歌；再点一次可以重试。");
      return null;
    }
  }
  function clearHighlight() {
    document.querySelectorAll(".miku-guide-target").forEach(node => node.classList.remove("miku-guide-target"));
  }
  function endGuide() { clearHighlight(); guide = null; refreshDock(); }
  function refreshDock() {
    dock.hidden = !!modal || !activated || (!guide && document.body.dataset.page === "home" && hostVisible);
    dock.querySelector(".miku-dock-text").textContent = caption;
    const actions = dock.querySelector(".miku-dock-actions");
    actions.replaceChildren();
    const button = (label, action) => {
      const item = document.createElement("button"); item.type = "button"; item.textContent = label;
      item.dataset.mikuAction = action; actions.appendChild(item); return item;
    };
    if (guide) {
      const step = guide.steps[guide.index];
      if (step.url) {
        const visit = document.createElement("a"); visit.href = step.url; visit.textContent = step.visit || "一起看看 ↗"; actions.appendChild(visit);
      } else if (step.target) button(step.visit || "打开看看", "visit");
      if (guide.index + 1 < guide.steps.length) button("下一站 →", "next-guide");
      button("结束漫游", "end-guide");
    } else {
      button("一起逛逛", "guide"); button("陪我听歌", "listen"); button("我的声音", "voice");
    }
  }
  function showStep() {
    clearHighlight();
    const step = guide?.steps[guide.index];
    if (!step) { endGuide(); return; }
    tell(step.text);
    const node = step.target;
    if (node?.isConnected) {
      node.classList.add("miku-guide-target");
      node.scrollIntoView({ block: "center", behavior: reduced ? "instant" : "smooth" });
    }
    companion?.react("前倾", 2400);
    refreshDock();
  }
  async function startGuide(id = ++actionId) {
    const firstVisit = !activated;
    endGuide();
    await appear(id);
    if (id !== actionId) return;
    const featured = document.getElementById("featured-link");
    const collection = document.querySelector(".collection-card");
    const fragment = document.getElementById("home-fragment-link");
    let steps = [];
    if (featured && collection && fragment) {
      steps = [
        { target: featured, url: featured.href, text: "先翻开这篇手记吧——「" + (document.getElementById("featured-title")?.textContent || "最近的记录") + "」。写下来的小事，会变成以后回头看的路标。", visit: "翻开这篇手记" },
        { target: collection, url: collection.href, text: "这一站，收藏喜欢的画面。光影收藏里放着那些想再看一眼的瞬间。", visit: "打开光影收藏" },
        { target: fragment, url: fragment.href, text: "最后听一句最近的碎碎念：「" + (document.getElementById("home-fragment")?.textContent || "日常的小小心情").trim().slice(0, 80) + "」", visit: "看看这条日常" },
      ];
    } else {
      const photos = [...document.querySelectorAll("#photo-grid .ph img")];
      if (photos.length) {
        const photo = photos[Math.floor(Math.random() * photos.length)];
        steps = [{ target: photo, text: "我选中了这张「" + (photo.alt || "照片") + "」。要不要一起放大看看？", visit: "放大这张收藏" }];
      } else {
        tell("等我翻一下手记本，给你挑一篇……");
        try {
          const response = await fetch(new URL("posts/posts.json", siteRoot), { cache: "no-cache", signal: AbortSignal.timeout(7000) });
          if (!response.ok) throw Error(response.status);
          const data = await response.json();
          const posts = (Array.isArray(data.posts) ? data.posts : []).filter(post => typeof post?.slug === "string" && typeof post.title === "string");
          const post = posts[Math.floor(Math.random() * posts.length)];
          if (post) steps = [{ url: new URL("posts/" + encodeURIComponent(post.slug) + ".html", siteRoot).href, text: "这次想和你读「" + post.title + "」。" + (post.summary || "不赶时间，慢慢读就好。"), visit: "读一篇手记 ↗" }];
        } catch (_) { if (id === actionId) tell("手记本暂时没翻开。这里的导航仍然能带你去相册和日常，我陪你慢慢看。 "); }
      }
    }
    if (id !== actionId) return;
    if (!steps.length) { refreshDock(); return; }
    guide = { steps, index: 0 }; showStep();
    if (firstVisit) voice("greet");
  }
  function restoreModel() {
    const model = modal?.querySelector("#kanban");
    if (model && modelHome?.parent.isConnected) {
      const next = modelHome.next?.parentNode === modelHome.parent ? modelHome.next : null;
      modelHome.parent.insertBefore(model, next);
      window.dispatchEvent(new Event("resize"));
    }
    modelHome = null;
  }
  function closeModal() {
    if (!modal) return;
    ++modalId; ++actionId; ++roomCommand;
    window.MikuVoice?.stop();
    restoreModel();
    modal.remove(); modal = null;
    document.body.classList.remove("miku-room-open");
    document.body.style.overflow = previousOverflow;
    modalInert.forEach(([node, inert]) => { if (node.isConnected) node.inert = inert; });
    modalInert = [];
    if (modalFocus?.isConnected) modalFocus.focus({ preventScroll: true });
    refreshDock();
  }
  function createModal(kind, title) {
    if (modal) closeModal();
    modalFocus = document.activeElement;
    previousOverflow = document.body.style.overflow;
    modal = document.createElement("div");
    modal.className = "miku-modal-backdrop";
    modal.innerHTML = '<section class="miku-modal ' + kind + '" role="dialog" aria-modal="true" aria-labelledby="miku-dialog-title" tabindex="-1"><header><div><span class="miku-eyebrow">MIKU · A LITTLE COMPANY</span><h2 id="miku-dialog-title"></h2></div><button type="button" class="miku-modal-close" data-miku-action="close" aria-label="关闭并返回页面">×</button></header><div class="miku-modal-body"></div></section>';
    modal.querySelector("h2").textContent = title;
    document.body.appendChild(modal);
    modalInert = [...document.querySelectorAll("body > nav, body > main, body > footer, #miku-host, .miku-dock")].map(node => [node, node.inert]);
    modalInert.forEach(([node]) => { node.inert = true; });
    document.body.style.overflow = "hidden";
    modal.addEventListener("click", event => { if (event.target === modal) closeModal(); });
    modal.querySelector(".miku-modal-close").focus();
    refreshDock();
    return modal.querySelector(".miku-modal-body");
  }
  function moveModelIntoRoom() {
    const model = document.getElementById("kanban");
    const stage = modal?.querySelector(".miku-room-character");
    if (!model || !stage || stage.contains(model)) return;
    modelHome = { parent: model.parentNode, next: model.nextSibling };
    stage.querySelector(".miku-room-wait")?.remove();
    stage.appendChild(model);
    companion?.show();
    window.dispatchEvent(new Event("resize"));
  }
  function roomTick(state = musicState()) {
    if (!modal?.querySelector(".miku-room")) return;
    const current = state.current;
    modal.querySelector(".miku-room-title").textContent = current?.name || "把喜欢的歌，留在这一刻。";
    modal.querySelector(".miku-room-artist").textContent = current?.artist || "从小窝歌单开始，和 Miku 一起听。";
    const cover = modal.querySelector(".miku-room-cover");
    if (current?.pic) { if (cover.getAttribute("src") !== current.pic) cover.src = current.pic; cover.hidden = false; }
    else { cover.removeAttribute("src"); cover.hidden = true; }
    const line = state.lrc?.[state.lrcLine];
    modal.querySelector(".miku-room-lyric").textContent = line?.text || (state.playing ? "没有歌词的间隙，也有音乐在流动。" : "按下播放，我就在这里陪你。 ");
    const play = modal.querySelector('[data-miku-action="room-play"]');
    play.textContent = state.playing ? "暂停" : "播放";
    play.setAttribute("aria-label", state.playing ? "暂停当前音乐" : "播放当前音乐");
    modal.querySelector(".miku-room").classList.toggle("is-playing", !!state.playing);
  }
  async function openRoom() {
    endGuide();
    const body = createModal("miku-room", "耳机分你一半");
    const id = ++modalId, request = ++actionId, command = ++roomCommand;
    document.body.classList.add("miku-room-open");
    body.innerHTML = '<div class="miku-room-character"><p class="miku-room-wait">正在等 Miku 过来坐坐……</p></div><div class="miku-room-music"><div class="miku-room-album"><span aria-hidden="true">♪</span><img class="miku-room-cover" alt="当前歌曲封面" hidden></div><p class="miku-room-artist"></p><h3 class="miku-room-title"></h3><p class="miku-room-lyric" aria-live="polite"></p><div class="miku-room-controls"><button type="button" data-miku-action="room-prev" aria-label="上一首">←</button><button type="button" data-miku-action="room-play">播放</button><button type="button" data-miku-action="room-next" aria-label="下一首">→</button></div><p class="miku-room-note" role="status">关上这个房间，音乐也会继续陪你。</p></div>';
    roomTick();
    appear(request).then(() => { if (modal && modalId === id) moveModelIntoRoom(); });
    if (!musicState().playing) {
      await voice("music");
      if (!modal || modalId !== id || command !== roomCommand || musicState().playing) return;
      await playRoom();
    }
  }
  async function playRoom() {
    const id = modalId;
    const note = modal?.querySelector(".miku-room-note");
    if (!window.MikuMusic) { if (note) note.textContent = "歌单还没准备好，稍后再点一次播放。"; return; }
    const wasPlaying = !!musicState().playing;
    if (note) note.textContent = wasPlaying ? "先暂停一下，我陪你待一会儿。" : "正在打开这首歌的声音……";
    try {
      await window.MikuMusic.toggle();
      if (modal && modalId === id) {
        roomTick();
        if (note) note.textContent = musicState().playing ? "关上这个房间，音乐也会继续陪你。"
          : wasPlaying ? "音乐暂停了。想听的时候，再按一下播放就好。"
          : "暂时没能放出音乐。可以再试一次，或回到首页的环境电台。";
      }
    } catch (_) { if (note?.isConnected) note.textContent = "这首暂时没放出来，我们换一首试试吧。"; }
  }
  async function openVoices() {
    const body = createModal("miku-voices", "是我，初音ミク");
    body.innerHTML = '<p class="miku-voice-intro">五句日语小心情，留给相遇的瞬间。长长的聊天，我们用文字慢慢说。</p><div class="miku-voice-options"></div><div class="miku-voice-caption" aria-live="polite">选一句，听听看。</div><button class="miku-voice-mute" type="button" data-miku-action="mute"></button><p class="miku-voice-source">角色短句来源：Project SEKAI · 初音ミク · <a href="https://sekai.best/" target="_blank" rel="noopener noreferrer">Sekai Viewer 资料</a><br>© SEGA / © Colorful Palette / © Crypton Future Media, INC.</p>';
    const id = modalId, request = ++actionId;
    appear(request);
    try {
      await window.MikuVoice?.ready;
      if (!modal || id !== modalId) return;
      const metadata = window.MikuVoice?.getClips?.();
      if (Array.isArray(metadata) && metadata.length) {
        clips.splice(0, clips.length, ...metadata.map(clip => [clip.id, clip.ja, clip.text, clip.label]));
      }
    } catch (_) {}
    if (!modal || id !== modalId) return;
    for (const [event, japanese, chinese, label] of clips) {
      const button = document.createElement("button"); button.type = "button";
      button.dataset.mikuAction = "audition"; button.dataset.voiceEvent = event;
      button.setAttribute("aria-label", (label || chinese) + "：" + japanese);
      const jp = document.createElement("span"), cn = document.createElement("small");
      jp.lang = "ja"; jp.textContent = japanese; cn.textContent = chinese;
      button.append(jp, cn); body.querySelector(".miku-voice-options").appendChild(button);
    }
    syncVoice();
  }
  function syncVoice(state = window.MikuVoice?.getState?.() || {}) {
    if (modal?.querySelector(".miku-room")) {
      if (state.playing) modal.querySelector(".miku-room-lyric").textContent = state.subtitle || state.ja || "";
      else roomTick();
    }
    const mute = modal?.querySelector(".miku-voice-mute");
    if (mute) {
      const enabled = window.MikuVoice?.isEnabled?.() !== false;
      mute.textContent = enabled ? "关闭角色声音" : "开启角色声音";
      mute.setAttribute("aria-pressed", String(!enabled));
    }
    const label = modal?.querySelector(".miku-voice-caption");
    if (label && state.playing) {
      const clip = clips.find(item => item[0] === state.event);
      label.textContent = clip ? clip[1] + " · " + clip[2] : String(state.subtitle || "");
    } else if (label && state.error) label.textContent = "声音暂时没能播放，再点一次试试看。";
    modal?.querySelectorAll("[data-voice-event]").forEach(button => button.setAttribute("aria-pressed", String(!!state.playing && button.dataset.voiceEvent === state.event)));
  }
  function heartEffect(button) {
    if (reduced) return;
    const point = button.getBoundingClientRect();
    for (let i = 0; i < 4; i++) {
      const heart = document.createElement("span"); heart.className = "miku-heart"; heart.textContent = "♡"; heart.setAttribute("aria-hidden", "true");
      heart.style.left = point.left + point.width / 2 + "px"; heart.style.top = point.top + "px";
      heart.style.setProperty("--heart-x", (i - 1.5) * 22 + "px"); document.body.appendChild(heart);
      setTimeout(() => heart.remove(), 1200);
    }
  }
  async function handleAction(button) {
    const action = button.dataset.mikuAction;
    if (action === "close") { closeModal(); return; }
    if (action === "end-guide") { endGuide(); return; }
    if (action === "dismiss") { endGuide(); activated = false; refreshDock(); companion?.hide(); return; }
    if (action === "next-guide" && guide) { guide.index++; showStep(); return; }
    if (action === "visit" && guide) { guide.steps[guide.index].target?.click(); return; }
    if (action === "room-play") { ++roomCommand; window.MikuVoice?.stop(); await playRoom(); return; }
    if (action === "room-prev" || action === "room-next") { ++roomCommand; window.MikuVoice?.stop(); window.MikuMusic?.[action === "room-prev" ? "prev" : "next"](); roomTick(); return; }
    if (action === "mute") { const engine = window.MikuVoice; engine?.setEnabled(!engine.isEnabled()); syncVoice(); return; }
    if (action === "audition") {
      window.MikuVoice?.setEnabled(true);
      const clip = clips.find(item => item[0] === button.dataset.voiceEvent);
      if (clip) {
        modal.querySelector(".miku-voice-caption").textContent = clip[1] + " · " + clip[2];
        await voice(clip[0], true);
      }
      syncVoice(); return;
    }
    window.MikuVoice?.unlock();
    if (action === "listen") { await openRoom(); return; }
    if (action === "voice") { await openVoices(); return; }
    if (action === "guide") { await startGuide(); return; }
    const id = ++actionId;
    await appear(id);
    if (id !== actionId) return;
    if (action === "heart") {
      tell("收到你的心意啦。把今天的一点点开心，也分你一半。♡");
      companion?.react("比心", 4000); heartEffect(button); await voice("heart");
    } else {
      tell("你好呀，我是 Miku。今天的手记、光影收藏和耳机里的歌，想先陪你看哪一个？");
      companion?.react("比心", 3200); await voice("greet");
    }
    refreshDock();
  }
  function hydrate() {
    if (document.body.dataset.page === "home" && !document.getElementById("miku-host")) {
      const host = document.createElement("section"); host.id = "miku-host"; host.className = "miku-host";
      host.setAttribute("aria-label", "小窝的向导 Miku");
      host.innerHTML = '<div class="miku-host-heading"><span class="miku-host-mark" aria-hidden="true">♪</span><span>MIKU · 小窝里的同伴</span></div><p id="miku-host-text"></p><div class="miku-host-actions"><button type="button" data-miku-action="greet">和 Miku 打个招呼</button><button type="button" data-miku-action="guide">带我逛逛</button><button type="button" data-miku-action="listen">陪我听一首</button><button type="button" data-miku-action="heart">♡ 给你比心</button><button type="button" data-miku-action="voice">听听我的声音</button></div><p id="miku-host-status" role="status"></p>';
      const main = document.querySelector("main");
      const hero = main?.querySelector(".reference-hero");
      if (hero) hero.after(host); else main?.prepend(host);
    }
    hostObserver?.disconnect();
    const host = document.getElementById("miku-host");
    hostVisible = !!host;
    if (host) {
      host.classList.add("miku-host");
      const text = document.getElementById("miku-host-text"); if (text) text.textContent = caption;
      if ("IntersectionObserver" in window) {
        hostObserver = new IntersectionObserver(entries => { hostVisible = entries[0].isIntersecting; refreshDock(); });
        hostObserver.observe(host);
      }
    }
    refreshDock();
  }
  document.addEventListener("click", event => {
    const button = event.target.closest?.("[data-miku-action]");
    if (!button) return;
    handleAction(button).catch(() => status("这一小步没走通，再点一次吧，我还在。"));
  });
  document.addEventListener("keydown", event => {
    if (!modal) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeModal(); }
    if (event.key === "Tab") {
      const controls = [...modal.querySelectorAll('button:not([disabled]), a[href], input, [tabindex="0"]')].filter(node => !node.hidden && node.getClientRects().length);
      if (!controls.length) return;
      const current = controls.indexOf(document.activeElement);
      const next = (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      event.preventDefault(); event.stopImmediatePropagation(); controls[next].focus();
    }
  }, true);
  document.addEventListener("mikumusic", event => roomTick(event.detail));
  document.addEventListener("mikuvoice", event => syncVoice(event.detail));
  document.addEventListener("miku:ready", event => {
    companion = event.detail?.companion || window.MikuCompanion;
    if (activated && !modal) companion?.say(caption);
    if (modal?.querySelector(".miku-room")) moveModelIntoRoom();
  });
  document.addEventListener("pjax:complete", () => { ++actionId; closeModal(); endGuide(); hydrate(); });
  document.addEventListener("miku:visibility", event => { if (!event.detail?.visible && !modal) { activated = false; refreshDock(); } });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hydrate, { once: true }); else hydrate();
  window.MikuHost = {
    openRoom, close: closeModal, guide: startGuide, stopGuide: endGuide,
    intent(type) {
      if (!["greet", "guide", "listen", "heart", "voice"].includes(type)) return Promise.resolve(false);
      const trigger = document.querySelector('[data-miku-action="' + type + '"]');
      const active = document.activeElement;
      return handleAction(trigger || {
        dataset: { mikuAction: type },
        getBoundingClientRect: () => active?.getBoundingClientRect?.() || { left: 0, top: 0, width: 0 },
      });
    },
  };
})();
