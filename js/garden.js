/* Small enhancements for the midnight notebook; no build step required. */
(() => {
  "use strict";
  const scriptURL = new URL(document.currentScript.src);
  const root = new URL("../", scriptURL);
  const assetVersion = scriptURL.searchParams.get("v") || "garden1";
  const paths = {
    "arrow-up-right": '<path d="M7 17 17 7M7 7h10v10"/>',
    "arrow-right": '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    github: '<path d="M9 19c-4.3 1.3-4.3-2-6-2.5M15 22v-3.4c0-1 .1-1.5-.5-2.1 3.3-.4 6.5-1.6 6.5-7A5.4 5.4 0 0 0 19.5 6c.1-.5.7-2.2-.1-4 0 0-1.3-.4-4.2 1.5a14 14 0 0 0-7.5 0C4.8 1.6 3.5 2 3.5 2c-.8 1.8-.2 3.5-.1 4A5.4 5.4 0 0 0 2 9.5c0 5.4 3.2 6.6 6.5 7-.5.5-.6 1.2-.5 2.1V22"/>',
    rss: '<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/>',
    headphones: '<path d="M3 14v-3a9 9 0 0 1 18 0v3M3 13h4v8H5a2 2 0 0 1-2-2zm18 0h-4v8h2a2 2 0 0 0 2-2z"/>',
    "skip-forward": '<path d="m5 5 10 7-10 7zM19 5v14"/>',
    sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4m-2-2h4"/>',
    "message-circle": '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/><path d="M8 11h8M8 14h5"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    orbit: '<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="11" ry="5" transform="rotate(-35 12 12)"/><path d="M6.7 5.6c-2 3.5-.8 9.8 2.3 13.2M15 4.5c2.8 3.4 4.3 9.7 2.1 13.3"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
    moon: '<path d="M20.8 13a9 9 0 1 1-9.8-9.8A7 7 0 0 0 20.8 13z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    cat: '<path d="M4 11V4l5 3a12 12 0 0 1 6 0l5-3v7a8 8 0 1 1-16 0zM8 13h.1M16 13h.1m-5 3h2M2 14l4 1m12 0 4-1"/>',
  };
  const svg = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + (paths[name] || paths.sparkles) + '</svg>';

  function icons(scope = document) {
    scope.querySelectorAll("[data-icon]:not([data-icon-ready])").forEach((el) => {
      el.innerHTML = svg(el.dataset.icon);
      el.dataset.iconReady = "";
    });
  }

  function themeIcon() {
    const button = document.getElementById("theme-toggle");
    if (!button) return;
    const light = document.body.classList.contains("light");
    button.innerHTML = svg(light ? "moon" : "sun");
    button.title = light ? "切换到月光模式" : "切换到日光模式";
    button.setAttribute("aria-label", button.title);
    const mode = document.getElementById("mode-card");
    if (mode) {
      mode.querySelector("h2").textContent = light ? "日间模式" : "夜间模式";
      mode.querySelector("p").textContent = light ? "让每一点喜欢，都明亮。" : "在微光里，慢慢漫游。";
      mode.setAttribute("aria-label", light ? "切换到夜间模式" : "切换到日间模式");
      mode.setAttribute("aria-pressed", String(light));
    }
  }

  async function pageReady({ signal, onCleanup } = {}) {
    icons();
    themeIcon();
    if (!document.querySelector(".ambient-scene")) {
      const scene = document.createElement("div");
      scene.className = "ambient-scene";
      scene.setAttribute("aria-hidden", "true");
      scene.innerHTML = '<div class="ambient-scene-image"></div><div class="ambient-scene-tint"></div>';
      document.body.prepend(scene);
    }
    if (document.body.dataset.page !== "home") return;
    const tracks = document.getElementById("track-list");
    if (tracks) {
      const improveTracks = () => {
        tracks.querySelectorAll(".track-item").forEach(row => {
          row.tabIndex = 0;
          row.setAttribute("role", "button");
          row.setAttribute("aria-label", "播放 " + (row.querySelector(".n")?.textContent || "这首歌") + " · " + (row.querySelector(".a")?.textContent || ""));
        });
        tracks.querySelectorAll("img").forEach(img => { img.loading = "lazy"; img.decoding = "async"; });
      };
      improveTracks();
      const trackObserver = new MutationObserver(improveTracks);
      trackObserver.observe(tracks, { childList: true });
      onCleanup?.(() => trackObserver.disconnect());
    }
    await Promise.allSettled([
      loadJSON("assets/gallery/gallery.json", "photos", signal).then(photos => {
        if (signal?.aborted) return;
        const count = document.getElementById("home-photo-count");
        if (count) count.textContent = photos.length;
      }),
      loadJSON("says/says.json", "says", signal).then(says => {
        if (signal?.aborted) return;
        const latest = [...says].sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")))[0];
        const text = document.getElementById("home-fragment");
        const link = document.getElementById("home-fragment-link");
        if (latest && text && link) {
          text.textContent = latest.text;
          link.textContent = (latest.time || "最近的日常") + " · 去看看 ↗";
        }
      }),
    ]);
  }

  if (typeof onPageReady === "function") onPageReady(pageReady);
  else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => pageReady(), { once: true });
  else pageReady();
  document.addEventListener("DOMContentLoaded", themeIcon, { once: true });
  new MutationObserver(themeIcon).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  // The persistent bar is needed after choosing a track, and stays available
  // while navigating. It remains tucked away during an idle first visit.
  const showPlayer = () => document.body.classList.add("music-engaged");
  document.addEventListener("click", (event) => {
    if (event.target.closest(".track-item, .js-mm-toggle, .js-mm-next, #home-lyrics-button")) showPlayer();
    if (event.target.closest("#mode-card")) document.getElementById("theme-toggle")?.click();
  });
  document.addEventListener("mikumusic", (event) => {
    if (event.detail?.playing) showPlayer();
  });
  document.addEventListener("keydown", (event) => {
    const track = event.target.closest(".track-item");
    if (track && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      track.click();
    }
  }, true);

  // Heavy Live2D assets load only when the visitor opens the companion.
  const companion = document.createElement("button");
  companion.className = "companion-toggle";
  companion.type = "button";
  companion.innerHTML = svg("cat");
  companion.title = "请 Miku 来坐坐";
  companion.setAttribute("aria-label", "加载 Miku 看板娘");
  document.body.appendChild(companion);
  function notice(text) {
    const toast = document.createElement("div");
    toast.className = "garden-toast";
    toast.setAttribute("role", "status");
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }
  function assetURL(path) {
    const url = new URL(path, root);
    url.searchParams.set("v", assetVersion);
    return url.href;
  }
  function loadScript(path) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = assetURL(path);
      script.onload = resolve;
      script.onerror = () => { script.remove(); reject(new Error("互动模块暂时没有连接上，请刷新重试。")); };
      document.body.appendChild(script);
    });
  }
  if (![...document.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href === assetURL("css/lyric-stage.css").href)) {
    const lyricStyle = document.createElement("link");
    lyricStyle.rel = "stylesheet";
    lyricStyle.href = assetURL("css/lyric-stage.css");
    document.head.appendChild(lyricStyle);
  }
  loadScript("js/lyric-stage.js").catch(() => {
    const status = document.getElementById("lyric-backdrop-status");
    if (status) status.textContent = "背景演出暂未加载，刷新后重试；音乐仍可正常播放。";
  });
  let companionLoad = null;
  window.MikuLoader = {
    load() {
      if (window.MikuCompanion) return Promise.resolve(window.MikuCompanion.ready).then(() => window.MikuCompanion);
      if (companionLoad) return companionLoad;
      companion.disabled = true;
      companion.setAttribute("aria-label", "正在加载 Miku");
      companionLoad = loadScript("js/kanban.js").then(async () => {
        if (!window.MikuCompanion) throw new Error("Miku 暂时没能赶来，请重试。");
        await window.MikuCompanion.ready;
        companion.hidden = true;
        return window.MikuCompanion;
      }).catch(error => {
        companionLoad = null;
        companion.disabled = false;
        companion.setAttribute("aria-label", "重试加载 Miku 看板娘");
        notice(error.message);
        throw error;
      });
      return companionLoad;
    },
  };
  companion.addEventListener("click", () => {
    if (window.MikuHost) { window.MikuHost.intent("greet"); return; }
    window.MikuVoice?.unlock();
    window.MikuLoader.load().then(api => {
      api.show();
      window.MikuVoice?.play("greet");
    }).catch(() => {});
  });
  if (![...document.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href === assetURL("css/miku-host.css"))) {
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = assetURL("css/miku-host.css");
    document.head.appendChild(style);
  }
  const hostModules = loadScript("js/miku-voice.js").then(() => loadScript("js/miku-host.js"));
  const aiStyle = document.createElement("link");
  aiStyle.rel = "stylesheet";
  aiStyle.href = assetURL("css/miku-ai.css");
  document.head.appendChild(aiStyle);
  window.MikuAIModuleReady = loadScript("js/miku-ai.js")
    .then(() => window.MikuAI?.ready)
    .catch(() => null);
  document.addEventListener("click", event => {
    if (!event.target.closest?.("#miku-ai-entry")) return;
    window.MikuAIModuleReady.then(() => window.MikuAI?.open({ mode: "chat" }));
  });
  hostModules.catch(error => {
    const status = document.getElementById("miku-host-status");
    if (status) status.textContent = "互动频道暂时没有连接上，可以刷新重试。";
  });
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-miku-action]");
    if (button && !window.MikuHost) {
      hostModules.then(() => window.MikuHost?.intent(button.dataset.mikuAction)).catch(error => notice(error.message));
    }
  });
})();
