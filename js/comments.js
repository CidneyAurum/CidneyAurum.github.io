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

  const mounted = new WeakSet();

  function currentTheme() {
    return document.body.classList.contains("light") ? "light" : "dark_dimmed";
  }

  function mount(slot) {
    if (!slot || mounted.has(slot)) return;
    mounted.add(slot);
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
      "data-loading": "lazy",
    };
    for (const k in cfg) s.setAttribute(k, cfg[k]);
    slot.appendChild(s);
  }

  function scan() {
    document.querySelectorAll("#giscus-slot").forEach((slot) => {
      if (mounted.has(slot)) return;
      // 懒加载：进入视口再挂
      if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver((es) => {
          es.forEach((en) => {
            if (en.isIntersecting) { mount(en.target); io.unobserve(en.target); }
          });
        }, { rootMargin: "200px" });
        io.observe(slot);
      } else mount(slot);
    });
  }

  // 首次 + PJAX 换页（main 换掉后新 slot 出现）都触发
  document.addEventListener("DOMContentLoaded", scan);
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });

  // 主题联动
  new MutationObserver(() => {
    const frame = document.querySelector("iframe.giscus-frame");
    if (!frame) return;
    frame.contentWindow.postMessage({ giscus: { setConfig: { theme: currentTheme() } } }, "https://giscus.app");
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
})();
