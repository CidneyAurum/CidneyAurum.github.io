/* ============================================
   giscus 评论（GitHub Discussions · 零后端）
   - 懒加载：滚动到评论区才注入
   - 主题联动：跟随站内日/夜切换
   - PJAX 换页后自动重挂载
   ============================================ */
"use strict";

(function () {
  const REPO = "CidneyAurum/CidneyAurum.github.io";
  const REPO_ID = "R_kgDOUH5WEw";
  const CATEGORY = "General";
  const CATEGORY_ID = "DIC_kwDOUH5WE84DE6bz";

  const mounted = new WeakMap();
  const active = new Set();

  function currentTheme() {
    return document.body.classList.contains("light") ? "light" : "dark_dimmed";
  }

  function release(state) {
    clearTimeout(state.timer);
    state.observer?.disconnect();
    state.visibility?.disconnect();
    active.delete(state);
  }

  function scan() {
    for (const state of active) if (!state.slot.isConnected) release(state);
    document.querySelectorAll("#giscus-slot").forEach((slot) => {
      if (mounted.has(slot)) return;
      const state = { slot, timer: 0, frame: null };
      mounted.set(slot, state);
      active.add(state);
      slot.innerHTML = '<div class="comment-status" role="status">正在准备评论…</div><div class="comment-actions"><button type="button" class="comment-retry" hidden>重新加载评论</button><a href="https://github.com/' + REPO + '/discussions" target="_blank" rel="noopener noreferrer">前往 GitHub 讨论区 ↗</a></div><div class="giscus"></div>';
      const status = slot.querySelector(".comment-status");
      const retry = slot.querySelector(".comment-retry");
      const holder = slot.querySelector(".giscus");
      const failed = (message) => {
        state.hasFailure = true;
        clearTimeout(state.timer);
        slot.setAttribute("aria-busy", "false");
        status.textContent = message;
        retry.hidden = false;
      };
      state.failed = failed;
      retry.addEventListener("click", () => {
        release(state);
        mounted.delete(slot);
        slot.replaceChildren();
        scan();
      });
      const mount = () => {
      if (!slot.isConnected) { release(state); return; }
      state.visibility?.disconnect();
      // The official client stores its login session; explain restricted storage
      // instead of allowing its uncaught exception to leave an empty card.
      try { localStorage.getItem("giscus-session"); }
      catch (_) { failed("浏览器限制了登录存储。你仍可在 GitHub 讨论区留言。"); return; }
      status.textContent = "正在连接 GitHub 评论…";
      slot.setAttribute("aria-busy", "true");
      const s = document.createElement("script");
      s.src = "https://giscus.app/client.js";
      s.async = true;
      s.crossOrigin = "anonymous";
      const cfg = {
        "data-repo": REPO,
        "data-repo-id": REPO_ID,
        "data-category": CATEGORY,
        "data-category-id": CATEGORY_ID,
        "data-mapping": "pathname",
        "data-strict": "0",
        "data-reactions-enabled": "1",
        "data-emit-metadata": "0",
        "data-input-position": "top",
        "data-theme": currentTheme(),
        "data-lang": "zh-CN",
        "data-loading": "eager",
      };
      for (const k in cfg) s.setAttribute(k, cfg[k]);
      state.observer = new MutationObserver(() => {
        const frame = holder.querySelector("iframe.giscus-frame");
        if (!frame || frame === state.frame) return;
        state.frame = frame;
        frame.title = "GitHub 评论";
        frame.addEventListener("load", () => {
          clearTimeout(state.timer);
          slot.setAttribute("aria-busy", "false");
          if (state.hasFailure) return;
          status.textContent = "使用 GitHub 账号登录后即可留言。";
          retry.hidden = true;
        }, { once: true });
      });
      state.observer.observe(holder, { childList: true, subtree: true });
      s.addEventListener("error", () => failed("评论服务暂时连接不上，请重试或前往 GitHub 讨论区。"), { once: true });
      state.timer = setTimeout(() => failed("评论连接较慢，请重试或前往 GitHub 讨论区。"), 20000);
      holder.appendChild(s);
      };
      if ("IntersectionObserver" in window) {
        state.visibility = new IntersectionObserver((entries) => {
          if (entries.some(entry => entry.isIntersecting)) mount();
        }, { rootMargin: "250px" });
        state.visibility.observe(slot);
      } else mount();
    });
  }

  // 首次 + PJAX 换页（main 换掉后新 slot 出现）都触发
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan, { once: true });
  else scan();
  document.addEventListener("pjax:complete", scan);
  window.addEventListener("message", (event) => {
    if (event.origin !== "https://giscus.app" || !event.data?.giscus) return;
    for (const state of active) {
      if (!state.slot.isConnected || event.source !== state.frame?.contentWindow) continue;
      const error = event.data.giscus.error;
      if (typeof error === "string" && !/Discussion not found|Bad credentials|Invalid state value|State has expired/i.test(error)) {
        state.failed("评论服务暂时不可用，你可以重试或直接在 GitHub 讨论区留言。");
      }
    }
  });

  // 主题联动
  new MutationObserver(() => {
    const frame = document.querySelector("iframe.giscus-frame");
    if (!frame) return;
    frame.contentWindow.postMessage({ giscus: { setConfig: { theme: currentTheme() } } }, "https://giscus.app");
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
})();
