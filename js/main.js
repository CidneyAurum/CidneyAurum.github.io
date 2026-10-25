/* ============================================
   CidneyAurum の 小窝 · 全站脚本
   PJAX 无刷新换页（音乐不断）/ 流萤 / 打字横幅 / 时钟 / 归档 / 说说 / 照片墙
   全局单例模块只绑一次；页面级模块注册进 PAGE_READY，换页后重放
   ============================================ */
"use strict";

/* ---------- 可调参数（✏️ 想改效果就动这里） ---------- */
const SITE_CONFIG = {
  fireflies: { enabled: true, count: 26 },   // 流萤粒子
  clickFx: true,                              // 点击彩蛋（蹦爱心星星）
  sloganLines: [                              // 首页横幅打字文案
    "直面过去，创造未来",
    "慢慢来，比较快",
    "今天也要元气满满哦 ♪",
    "仰望星空，脚踏实地 ✧",
  ],
  siteBirthday: "2026-08-29",                 // 网站生日（用于运行天数）
};

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// The script URL stays stable when the address changes from / to /posts/.
const SITE_ROOT = new URL("../", document.currentScript.src);
const SITE_ASSET_VERSION = new URL(document.currentScript.src).searchParams.get("v");
const siteURL = (path) => new URL(path, SITE_ROOT).href;
const postURL = (slug) => siteURL("posts/" + encodeURIComponent(slug) + ".html");
const session = {
  getItem(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } },
  setItem(key, value) { try { sessionStorage.setItem(key, value); } catch (e) {} },
  removeItem(key) { try { sessionStorage.removeItem(key); } catch (e) {} },
};

function rebaseURLs(root, base) {
  root.querySelectorAll("[href], [src], [poster], [action], [data-full]").forEach((el) => {
    ["href", "src", "poster", "action", "data-full"].forEach((attr) => {
      const value = el.getAttribute(attr);
      if (!value || value.startsWith("#")) return;
      try { el.setAttribute(attr, new URL(value, base).href); } catch (e) {}
    });
  });
}
// Header/footer and the player survive PJAX, so freeze their original URLs too.
rebaseURLs(document.body, location.href);
document.head.querySelectorAll("style").forEach((el) => el.dataset.pageStyle = "");

/* ---------- 页面就绪注册表：DOMContentLoaded 与 PJAX 换页都会重放 ---------- */
const PAGE_READY = [];
let pageController = null;
let pageCleanups = [];
function onPageReady(fn) { PAGE_READY.push(fn); }
function cleanupPage() {
  if (pageController) pageController.abort();
  pageCleanups.splice(0).forEach((fn) => { try { fn(); } catch (e) {} });
  if (typeof revealIO !== "undefined" && revealIO) document.querySelectorAll(".rv-done").forEach((el) => revealIO.unobserve(el));
}
function runPageReady() {
  cleanupPage();
  pageController = new AbortController();
  const context = {
    signal: pageController.signal,
    onCleanup(fn) { pageCleanups.push(fn); },
  };
  const pending = PAGE_READY.map((fn) => {
    try { return Promise.resolve(fn(context)).catch((e) => { if (e.name !== "AbortError") console.warn("[page-init]", e); }); }
    catch (e) { console.warn("[page-init]", e); }
  });
  refreshNavActive();
  ensureComments();
  return Promise.allSettled(pending);
}
document.addEventListener("DOMContentLoaded", runPageReady);

/* ---------- PWA Service Worker（离线缓存 + 可安装） ---------- */
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

/* 切走标签页时的标题彩蛋 */
document.addEventListener("visibilitychange", () => {
  const base = (document.title || "").split(" ||")[0];
  document.title = document.hidden ? base + " || (´･ω･`) 回来看看呀" : base;
});

/* 控制台彩蛋 */
try {
  console.log("%c✧ CidneyAurum の 小窝 ✧", "color:#8b7bff;font-size:22px;font-weight:bold;font-family:serif");
  console.log("%c嘿！扒控制台的同行你好呀 ♪ 源码开源在 github.com/CidneyAurum/CidneyAurum.github.io，点个 star 再走～", "color:#d9b96c");
} catch (e) {}

/* ============================================================
   PJAX：拦截站内 .html 链接，只换 <main> —— JS 状态常驻，音乐永不断
   ============================================================ */
let navigationController = null;
let navigationId = 0;
let displayedURL = location.href;
let interactionVersion = 0;
["wheel", "touchstart", "pointerdown", "keydown"].forEach((type) => {
  document.addEventListener(type, () => interactionVersion++, { passive: true });
});
function swapTarget(doc) { return doc.querySelector("main") || doc.querySelector(".wrap.article-layout"); }

const PAGE_HEAD = 'meta[name="description"], meta[property^="og:"], meta[name^="twitter:"], link[rel="canonical"], script[type="application/ld+json"], style[data-page-style]';
function syncPageHead(doc) {
  document.head.querySelectorAll(PAGE_HEAD).forEach((el) => el.remove());
  doc.head.querySelectorAll('meta[name="description"], meta[property^="og:"], meta[name^="twitter:"], link[rel="canonical"], script[type="application/ld+json"], style').forEach((el) => {
    const copy = document.importNode(el, true);
    if (copy.tagName === "STYLE") copy.dataset.pageStyle = "";
    document.head.appendChild(copy);
  });
}

function needsDocumentNavigation(url) {
  return document.body.dataset.page === "admin" || /\/admin\.html$/i.test(url.pathname);
}

function closeMobileMenu() {
  document.getElementById("nav-links")?.classList.remove("open");
  document.getElementById("hamburger")?.setAttribute("aria-expanded", "false");
}

function ensureComments() {
  if (!document.getElementById("giscus-slot")) return;
  if ([...document.scripts].some((script) => new URL(script.src || location.href).pathname.endsWith("/js/comments.js"))) return;
  const script = document.createElement("script");
  const source = new URL("js/comments.js", SITE_ROOT);
  if (SITE_ASSET_VERSION) source.searchParams.set("v", SITE_ASSET_VERSION);
  script.src = source.href;
  // Its observer is installed after DOMContentLoaded on a PJAX visit.
  script.addEventListener("load", () => {
    document.getElementById("giscus-slot")?.appendChild(document.createComment("comments ready"));
  }, { once: true });
  script.addEventListener("error", () => script.remove(), { once: true });
  document.body.appendChild(script);
}

async function pjaxGo(url, push) {
  const base = new URL(url, location.href);
  if (base.origin !== location.origin || needsDocumentNavigation(base)) {
    location.assign(base.href);
    return;
  }
  if (navigationController) navigationController.abort();
  const controller = navigationController = new AbortController();
  const id = ++navigationId;
  const restoreY = !push && Number(history.state?.scrollY) || 0;
  document.documentElement.setAttribute("aria-busy", "true");
  try {
    const res = await fetch(base.href, { signal: controller.signal });
    if (!res.ok) throw new Error(res.status);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const newMain = swapTarget(doc);
    const curMain = swapTarget(document);
    if (!newMain || !curMain) throw new Error("swap target missing");
    if (id !== navigationId) return;
    rebaseURLs(newMain, base);
    const applySwap = () => {
      if (id !== navigationId) return;
      cleanupPage();
      if (push) {
        history.replaceState({ ...history.state, scrollY: window.scrollY }, "", location.href);
        history.pushState({ pjax: 1, scrollY: 0 }, "", base.href);
      }
      document.title = doc.title;
      document.body.dataset.page = doc.body.dataset.page || "";
      displayedURL = base.href;
      syncPageHead(doc);
      curMain.replaceWith(document.adoptNode(newMain));
    };
    const afterSwap = () => {
      if (id !== navigationId) return;
      closeMobileMenu();
      document.querySelector(".nav")?.classList.remove("nav-hide");
      const interactions = interactionVersion;
      const ready = runPageReady(); // 必须在换入后跑，否则新页面不会被初始化
      const main = swapTarget(document);
      main.setAttribute("tabindex", "-1");
      main.focus({ preventScroll: true });
      window.scrollTo(0, restoreY);
      // Data lists may not be tall enough for the saved position until loaded.
      ready.then(() => {
        if (id === navigationId && !push && restoreY > 0 && interactions === interactionVersion) window.scrollTo(0, restoreY);
      });
      if (base.hash) {
        try { document.getElementById(decodeURIComponent(base.hash.slice(1)))?.scrollIntoView(); } catch (e) {}
      }
      document.dispatchEvent(new CustomEvent("pjax:complete", { detail: { url: base.href } }));
    };
    if (document.startViewTransition && !reduceMotion) {
      const transition = document.startViewTransition(applySwap);
      // A second navigation or a hidden tab may skip the visual transition;
      // the DOM update still succeeds and must not cause an unhandled rejection.
      transition.ready.catch(() => {});
      transition.finished.catch(() => {});
      await transition.updateCallbackDone;
      afterSwap();
    } else {
      applySwap();
      afterSwap();
    }
  } catch (e) {
    if (e.name !== "AbortError" && id === navigationId) location.assign(base.href);
  } finally {
    if (id === navigationId) document.documentElement.removeAttribute("aria-busy");
  }
}

function refreshNavActive() {
  const here = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  document.querySelectorAll(".nav-link").forEach((a) => {
    const target = new URL(a.href, location.href).pathname.split("/").pop().toLowerCase();
    const active = target === here || (document.body.dataset.page === "post" && target === "blog.html");
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest && e.target.closest("a[href]");
  if (!a) return;
  const href = a.getAttribute("href") || "";
  if ((a.target && a.target !== "_self") || a.hasAttribute("download") || href.startsWith("#")) return;
  const target = new URL(a.href, location.href);
  if (target.origin !== location.origin || !/^https?:$/.test(target.protocol)) return;
  if (!/\.html$/i.test(target.pathname) && !target.pathname.endsWith("/")) return;
  if (needsDocumentNavigation(target)) return;
  if (target.pathname === location.pathname && target.search === location.search && target.hash) return;
  e.preventDefault();
  pjaxGo(target.href, true);
});
window.addEventListener("popstate", () => pjaxGo(location.href, false));
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
let scrollSaveFrame = 0;
window.addEventListener("scroll", () => {
  if (scrollSaveFrame) return;
  scrollSaveFrame = requestAnimationFrame(() => {
    scrollSaveFrame = 0;
    if (location.href === displayedURL && !document.documentElement.hasAttribute("aria-busy")) {
      history.replaceState({ ...history.state, scrollY: window.scrollY }, "", location.href);
    }
  });
}, { passive: true });

/* ---------- 主题（默认夜间，可切日间）· 全局单例 ---------- */
(function initTheme() {
  let saved;
  try { saved = localStorage.getItem("theme"); } catch (e) {}
  if (saved === "light") document.body.classList.add("light");
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    const sync = () => {
      const light = document.body.classList.contains("light");
      btn.textContent = light ? "🌙" : "✨";
      btn.title = light ? "回到深空" : "点亮日光";
      btn.setAttribute("aria-label", btn.title);
      btn.setAttribute("aria-pressed", String(light));
    };
    sync();
    btn.addEventListener("click", (e) => {
      const apply = () => {
        document.body.classList.toggle("light");
        try { localStorage.setItem("theme", document.body.classList.contains("light") ? "light" : "dark"); } catch (e) {}
        sync();
      };
      // 主题切换圆形扩散（View Transitions API，不支持的浏览器自动降级）
      if (!document.startViewTransition || reduceMotion) { apply(); return; }
      const x = (e && e.clientX) || window.innerWidth - 60;
      const y = (e && e.clientY) || 40;
      const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
      const vt = document.startViewTransition(apply);
      vt.finished.catch(() => {});
      vt.ready.then(() => {
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
          { duration: 480, easing: "ease-in-out", pseudoElement: "::view-transition-new(root)" }
        );
      }).catch(() => {});
    });
  });
})();

/* ---------- 背景图加载失败时回退极光渐变 · 全局单例 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const bg = document.querySelector(".scene-bg");
  const scene = document.querySelector(".scene");
  if (bg && scene) {
    bg.addEventListener("error", () => scene.classList.add("no-bg"));
    if (bg.complete && bg.naturalWidth === 0) scene.classList.add("no-bg");
  }
});

/* ---------- 返回顶部 · 全局单例 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("to-top");
  if (!btn) return;
  window.addEventListener("scroll", () => {
    btn.classList.toggle("show", window.scrollY > 480);
  }, { passive: true });
  btn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
});

/* ---------- 移动端汉堡菜单 · 全局单例 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const burger = document.getElementById("hamburger");
  const links = document.getElementById("nav-links");
  if (burger && links) {
    burger.setAttribute("aria-controls", "nav-links");
    burger.setAttribute("aria-expanded", "false");
    burger.addEventListener("click", () => {
      const open = links.classList.toggle("open");
      burger.setAttribute("aria-expanded", String(open));
    });
    links.addEventListener("click", (e) => {
      if (e.target.closest(".nav-link")) closeMobileMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && links.classList.contains("open")) { closeMobileMenu(); burger.focus(); }
    });
    document.addEventListener("click", (e) => { if (!e.target.closest(".nav")) closeMobileMenu(); });
  }
});

/* ---------- 流萤粒子 · 全局单例 ---------- */
(function fireflies() {
  if (!SITE_CONFIG.fireflies.enabled || reduceMotion) return;
  const canvas = document.getElementById("firefly-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  let W, H, dots = [];
  const COUNT = window.innerWidth < 680
    ? Math.round(SITE_CONFIG.fireflies.count / 2)
    : SITE_CONFIG.fireflies.count;

  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }

  function spawn(initial) {
    const pick = Math.random();
    const color = pick < 0.55 ? "173, 216, 255" : pick < 0.85 ? "196, 181, 255" : "255, 214, 236";
    return {
      x: Math.random() * W,
      y: initial ? Math.random() * H : H + 10,
      r: 0.8 + Math.random() * 1.8,
      alpha: 0,
      maxAlpha: 0.25 + Math.random() * 0.45,
      vy: -(0.12 + Math.random() * 0.3),
      drift: 0.3 + Math.random() * 0.7,
      phase: Math.random() * Math.PI * 2,
      twinkle: 0.008 + Math.random() * 0.02,
      t: Math.random() * 500,
      color,
    };
  }

  function tick() {
    ctx.clearRect(0, 0, W, H);
    for (const d of dots) {
      d.t += 1;
      d.y += d.vy;
      d.x += Math.sin(d.t * 0.01 + d.phase) * d.drift * 0.4;
      d.alpha = d.maxAlpha * (0.5 + 0.5 * Math.sin(d.t * d.twinkle * 10));
      if (d.y < -12 || d.x < -20 || d.x > W + 20) Object.assign(d, spawn(false));
      const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.r * 4);
      g.addColorStop(0, `rgba(${d.color}, ${d.alpha})`);
      g.addColorStop(1, `rgba(${d.color}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r * 4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!document.hidden) requestAnimationFrame(tick);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) requestAnimationFrame(tick); });
  window.addEventListener("resize", () => { resize(); dots = Array.from({ length: COUNT }, () => spawn(true)); });

  resize();
  dots = Array.from({ length: COUNT }, () => spawn(true));
  requestAnimationFrame(tick);
})();

/* ---------- 打字横幅（一言加入轮播）· 页面级，可重入 ---------- */
let sloganTimer = 0;
onPageReady(({ onCleanup }) => {
  clearTimeout(sloganTimer);
  const el = document.getElementById("slogan-text");
  if (!el) return;
  const caret = el.parentElement.querySelector(".caret");
  const lines = [...SITE_CONFIG.sloganLines];
  let li = 0, ci = 0, deleting = false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  onCleanup(() => { clearTimeout(sloganTimer); clearTimeout(timer); controller.abort(); });
  const hito = (host) => fetch(host + "/?c=i&c=k&c=a", { signal: controller.signal })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
  hito("https://v1.hitokoto.cn")
    .catch(() => hito("https://international.v1.hitokoto.cn"))
    .then((data) => { clearTimeout(timer); if (data && data.hitokoto) lines.push(data.hitokoto); })
    .catch(() => clearTimeout(timer));

  if (reduceMotion) { el.textContent = lines[0]; if (caret) caret.style.display = "none"; return; }

  (function loop() {
    const line = lines[li];
    el.textContent = line.slice(0, ci);
    let delay = deleting ? 34 : 120;
    if (!deleting && ci === line.length) { delay = 2600; deleting = true; }
    else if (deleting && ci === 0) { deleting = false; li = (li + 1) % lines.length; delay = 500; }
    ci += deleting ? -1 : 1;
    sloganTimer = setTimeout(loop, delay);
  })();
});

/* ---------- 时钟 + 网站运行天数 · 页面级，可重入 ---------- */
let clockTimer = 0;
onPageReady(({ onCleanup }) => {
  clearInterval(clockTimer);
  const timeEl = document.getElementById("clock-time");
  const upEl = document.getElementById("uptime");
  if (!timeEl && !upEl) return;
  const birthday = new Date(SITE_CONFIG.siteBirthday + "T00:00:00");
  function render() {
    const now = new Date();
    if (timeEl) {
      const p = (n) => String(n).padStart(2, "0");
      timeEl.textContent = `${p(now.getHours())} : ${p(now.getMinutes())} : ${p(now.getSeconds())}`;
    }
    const dateEl = document.getElementById("clock-date");
    if (dateEl) {
      const wd = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
      const p = (n) => String(n).padStart(2, "0");
      dateEl.textContent = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} 周${wd}`;
    }
    if (upEl) {
      const days = Math.max(0, Math.floor((now - birthday) / 86400000));
      const hours = Math.max(0, Math.floor(((now - birthday) % 86400000) / 3600000));
      upEl.textContent = days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
    }
  }
  render();
  clockTimer = setInterval(render, 1000);
  onCleanup(() => clearInterval(clockTimer));
});

/* ---------- 文章数据 ---------- */
async function loadJSON(path, key, signal) {
  const request = new AbortController();
  let timedOut = false;
  const cancel = () => request.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; request.abort(); }, 10000);
  try {
    const res = await fetch(siteURL(path), { cache: "no-cache", signal: request.signal });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    if (!Array.isArray(data[key])) throw new Error("Invalid " + key + " data");
    return data[key];
  } catch (error) {
    if (timedOut && !signal?.aborted) throw new Error("内容加载超时，请重试。");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
function contentFailure(name) {
  return '<div class="empty-tip content-failure" role="status"><p>' + esc(name) + '暂时未能加载。</p><button type="button" class="comment-retry" data-retry-content>重新加载</button></div>';
}
document.addEventListener("click", (event) => {
  if (event.target.closest?.("[data-retry-content]")) pjaxGo(location.href, false);
});
async function loadPosts(signal) {
  const posts = await loadJSON("posts/posts.json", "posts", signal);
  return posts.filter((p) => p && typeof p.slug === "string" && typeof p.title === "string")
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
function coverHTML(post, i) {
  if (post.cover) return `<img src="${esc(siteURL(post.cover))}" alt="" loading="lazy">`;
  const pool = ["🌌", "🪐", "🛸", "🌙", "⭐", "💫", "☄️", "🔭"];
  return pool[(i + (post.slug || "").length) % pool.length];
}
function tagsHTML(post) { return (post.tags || []).map((t) => `<span class="tag-mini"># ${esc(t)}</span>`).join(""); }

/* ---------- 首页：最新文章摘要区 · 页面级 ---------- */
onPageReady(async ({ signal }) => {
  const featuredLink = document.getElementById("featured-link");
  const recordsBox = document.getElementById("records-list");
  if (!featuredLink && !recordsBox) return;
  let posts;
  try { posts = await loadPosts(signal); } catch (e) {
    if (e.name === "AbortError") return;
    if (recordsBox) recordsBox.innerHTML = contentFailure("文章");
    if (featuredLink) { featuredLink.href = siteURL("blog.html"); const title = document.getElementById("featured-title"); if (title) title.textContent = "浏览文章归档"; }
    return;
  }
  if (signal.aborted) return;

  const statPosts = document.getElementById("stat-posts");
  const statTags = document.getElementById("stat-tags");
  const statDays = document.getElementById("stat-days");
  if (statPosts) statPosts.textContent = posts.length;
  if (statTags) statTags.textContent = new Set(posts.flatMap((p) => p.tags || [])).size;
  if (statDays) {
    const days = Math.max(1, Math.ceil((Date.now() - new Date(SITE_CONFIG.siteBirthday + "T00:00:00")) / 86400000));
    statDays.textContent = days;
  }
  if (!posts.length) {
    if (recordsBox) recordsBox.innerHTML = '<p class="empty-tip">还没有文章，新的记录正在路上。</p>';
    if (featuredLink) { featuredLink.href = siteURL("blog.html"); const title = document.getElementById("featured-title"); if (title) title.textContent = "还没有文章"; }
    return;
  }

  if (featuredLink) {
    const f = posts[0];
    featuredLink.href = postURL(f.slug);
    const t = document.getElementById("featured-title");
    const s = document.getElementById("featured-summary");
    const d = document.getElementById("featured-date");
    const e = document.getElementById("featured-cover");
    if (t) t.textContent = f.title;
    if (s) s.textContent = f.summary || "";
    if (d) d.textContent = f.date;
    if (e) e.innerHTML = coverHTML(f, 0);
  }
  if (recordsBox) {
    recordsBox.innerHTML = posts.slice(1, 5).map((p) => `
      <a class="record-item" href="${postURL(p.slug)}">
        <div class="record-meta">RECORD · ${esc(p.date)} ${(p.tags || []).map((t) => "· " + esc(t)).join(" ")}</div>
        <div class="record-title">${esc(p.title)}</div>
        <div class="record-summary">${esc(p.summary || "")}</div>
      </a>`).join("");
  }
});

/* ---------- 文章右侧栏 RECORDS · 页面级 ---------- */
onPageReady(async ({ signal }) => {
  const sideRecords = document.getElementById("side-records");
  if (!sideRecords) return;
  let posts;
  try { posts = await loadPosts(signal); } catch (e) { if (e.name !== "AbortError") sideRecords.innerHTML = '<p class="empty-tip">文章列表暂时无法加载。</p>'; return; }
  if (signal.aborted) return;
  sideRecords.innerHTML = posts.slice(0, 4).map((p) => `
    <a class="side-record" href="${postURL(p.slug)}">
      <div class="d">${esc(p.date)}</div>
      <div class="t">${esc(p.title)}</div>
    </a>`).join("");
});

/* ---------- 照片墙渲染（缩略图 + 灯箱原图）· 页面级 ---------- */
const photoThumb = (src) => src.replace(/\/(gallery|says)\//, "/$1/thumbs/").replace(/\.(jpe?g|png)$/i, ".webp");
onPageReady(async ({ signal }) => {
  const grid = document.getElementById("photo-grid");
  if (!grid) return;
  let photos = [];
  try {
    photos = await loadJSON("assets/gallery/gallery.json", "photos", signal);
  } catch (e) {
    if (e.name !== "AbortError") grid.innerHTML = contentFailure("照片");
    return;
  }
  if (signal.aborted) return;
  if (!photos.length) {
    grid.innerHTML = '<p class="empty-tip">相册还空着，新的照片正在路上。</p>';
    return;
  }
  grid.innerHTML = photos
    .map(
      (p) => `
    <figure class="polaroid">
      <span class="tape"></span>
      <div class="ph"><img src="${esc(siteURL(photoThumb(p.src)))}" data-full="${esc(siteURL(p.src))}" alt="${esc(p.caption || "照片")}" role="button" tabindex="0" aria-label="查看原图：${esc(p.caption || "照片")}" loading="lazy" decoding="async"></div>
      <figcaption class="cap">${esc(p.caption || "")} <small>${esc(p.when || "")}</small></figcaption>
    </figure>`
    )
    .join("");
});

/* ---------- 悬浮音乐钮 · 全局单例 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const fab = document.getElementById("fab-music");
  if (!fab || !window.MikuMusic) return;
  const sync = (st) => { fab.textContent = st.playing ? "❚❚" : "♪"; };
  document.addEventListener("mikumusic", (e) => sync(e.detail || {}));
  fab.addEventListener("click", () => window.MikuMusic.toggle());
  sync(window.MikuMusic.getState());
});

/* ---------- 点击彩蛋：光标处爆出小爱心 · 全局单例 ---------- */
(function clickFx() {
  if (!SITE_CONFIG.clickFx || reduceMotion) return;
  if (window.matchMedia("(hover: none)").matches) return;
  const glyphs = ["♡", "✦", "💗", "✧"];
  const colors = ["#ff9dc0", "#c4a8ff", "#8ecbff", "#ffb7d5"];
  document.addEventListener("click", (e) => {
    if (e.target.closest("input, textarea, button, a")) return;
    for (let i = 0; i < 6; i++) {
      const s = document.createElement("span");
      s.className = "mouse-particle";
      s.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
      s.style.left = e.clientX - 4 + "px";
      s.style.top = e.clientY - 4 + "px";
      s.style.color = colors[Math.floor(Math.random() * colors.length)];
      s.style.fontSize = 9 + Math.random() * 8 + "px";
      s.style.setProperty("--dx", (Math.random() * 90 - 45).toFixed(0) + "px");
      s.style.setProperty("--rot", (Math.random() * 120 - 60).toFixed(0) + "deg");
      s.style.animationDuration = 0.7 + Math.random() * 0.5 + "s";
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 1300);
    }
  });
})();

/* ---------- 文章代码块一键复制 · 页面级（可重入，自动去旧按钮） ---------- */
onPageReady(() => {
  document.querySelectorAll(".prose pre").forEach((pre) => {
    pre.querySelectorAll(".copy-btn").forEach((b) => b.remove());
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.type = "button";
    btn.textContent = "复制";
    btn.addEventListener("click", async () => {
      const code = pre.querySelector("code");
      const text = (code || pre).innerText;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      btn.textContent = "✓ 已复制";
      setTimeout(() => (btn.textContent = "复制"), 1600);
    });
    pre.appendChild(btn);
  });
});

/* ---------- 图片灯箱 · 全局单例（事件委托，pjax 后天然生效） ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const box = document.createElement("div");
  box.className = "lightbox";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "图片预览，按 Escape 关闭");
  box.setAttribute("tabindex", "-1");
  box.innerHTML = '<button type="button" class="lightbox-close" aria-label="关闭图片预览">×</button><button type="button" class="lightbox-prev" aria-label="上一张图片">‹</button><img alt=""><button type="button" class="lightbox-next" aria-label="下一张图片">›</button><div class="lightbox-status" role="status"></div><div class="cap"></div>';
  document.body.appendChild(box);
  const img = box.querySelector("img");
  const cap = box.querySelector(".cap");
  const closeButton = box.querySelector(".lightbox-close");
  const previous = box.querySelector(".lightbox-prev");
  const next = box.querySelector(".lightbox-next");
  const message = box.querySelector(".lightbox-status");
  let group = [], index = 0, previousOverflow = "";
  let lastFocus = null;
  const show = (position) => {
    index = (position + group.length) % group.length;
    const source = group[index];
    img.alt = source.alt || "图片预览";
    message.textContent = "正在载入原图…";
    message.hidden = false;
    img.src = source.dataset.full || source.src;
    cap.textContent = (source.alt || "图片") + (group.length > 1 ? ` · ${index + 1} / ${group.length}` : "");
    previous.hidden = next.hidden = group.length < 2;
  };
  img.addEventListener("load", () => { message.hidden = true; });
  img.addEventListener("error", () => { message.textContent = "原图暂时无法载入。你可以切换图片，或关闭后重试。"; });
  const close = () => {
    if (!box.classList.contains("open")) return;
    box.classList.remove("open"); img.removeAttribute("src");
    document.body.style.overflow = previousOverflow;
    if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
  };
  closeButton.addEventListener("click", close);
  previous.addEventListener("click", () => show(index - 1));
  next.addEventListener("click", () => show(index + 1));
  box.addEventListener("click", (event) => { if (event.target === box) close(); });
  document.addEventListener("keydown", (e) => {
    if (!box.classList.contains("open")) return;
    if (["Escape", "ArrowLeft", "ArrowRight", "Tab"].includes(e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft" && group.length > 1) show(index - 1);
      else if (e.key === "ArrowRight" && group.length > 1) show(index + 1);
      else if (e.key === "Tab") {
        const controls = [closeButton, previous, next].filter(button => !button.hidden);
        const current = controls.indexOf(document.activeElement);
        controls[(current + (e.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
      }
    }
  }, true);
  document.addEventListener("click", (e) => {
    const t = e.target;
    const isPhoto = t.matches?.(".prose img, .photo-grid .ph img, .kb-msg img, .says-grid img");
    if (!isPhoto || !t.src || t.src.startsWith("blob:")) return;
    e.preventDefault();
    e.stopPropagation();
    const parent = t.closest(".photo-grid, .says-card, .prose, .kb-msg") || t.parentElement;
    group = [...parent.querySelectorAll("img")].filter(image => image.matches(".prose img, .photo-grid .ph img, .kb-msg img, .says-grid img"));
    if (!group.length) group = [t];
    lastFocus = document.activeElement;
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    box.classList.add("open");
    show(Math.max(0, group.indexOf(t)));
    closeButton.focus({ preventScroll: true });
  });
  document.addEventListener("pjax:complete", close);
  document.addEventListener("error", (e) => {
    const target = e.target;
    if (target.matches?.("img[data-full]") && target.src !== target.dataset.full) target.src = target.dataset.full;
  }, true);
  document.addEventListener("keydown", (event) => {
    if (box.classList.contains("open")) return;
    if (event.target.matches?.('.prose img[role="button"], .photo-grid img[role="button"], .says-grid img[role="button"]') && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.target.click();
    }
  }, true);
});

onPageReady(() => {
  document.querySelectorAll(".prose img").forEach(image => {
    image.tabIndex = 0;
    image.setAttribute("role", "button");
    image.setAttribute("aria-label", "查看原图：" + (image.alt || "文章图片"));
  });
});

/* ---------- 文章目录滚动高亮 · 页面级 ---------- */
onPageReady(({ onCleanup }) => {
  const tocLinks = document.querySelectorAll(".toc-list a");
  if (!tocLinks.length || !("IntersectionObserver" in window)) return;
  const map = new Map();
  tocLinks.forEach((a) => {
    const id = a.getAttribute("href").slice(1);
    const h = document.getElementById(id);
    if (h) map.set(h, a);
  });
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        tocLinks.forEach((a) => a.classList.remove("on"));
        const link = map.get(en.target);
        if (link) link.classList.add("on");
      }
    });
  }, { rootMargin: "-80px 0px -70% 0px" });
  map.forEach((_, h) => io.observe(h));
  onCleanup(() => io.disconnect());
});

/* ---------- Ctrl+K / / 唤起归档搜索 · 全局单例 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("keydown", (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (document.getElementById("search-input")) {
        document.getElementById("search-input").focus();
        document.getElementById("search-input").scrollIntoView({ block: "center" });
      } else {
        session.setItem("focus-search", "1");
        pjaxGo(siteURL("blog.html"), true);
      }
    } else if (e.key === "/" && document.getElementById("search-input")) {
      e.preventDefault();
      document.getElementById("search-input").focus();
    }
  });
});

/* ---------- 滚动渐入 · 全局单例（MutationObserver 自动覆盖 PJAX 换入节点） ---------- */
const revealIO = ("IntersectionObserver" in window) && !reduceMotion
  ? new IntersectionObserver((es) => {
      es.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add("in"); revealIO.unobserve(en.target); }
      });
    }, { threshold: 0.06 })
  : null;
function revealScan() {
  document.querySelectorAll(".rv:not(.in):not(.rv-done)").forEach((el) => {
    el.classList.add("rv-done");
    if (revealIO) revealIO.observe(el);
    else el.classList.add("in");
  });
}
onPageReady(() => {
  document.querySelectorAll(".hero .card, .home-grid .card, .post-item, .tl-card, .says-card, .featured-card").forEach((el) => el.classList.add("rv"));
  revealScan();
});
const revealMO = new MutationObserver((muts) => {
  for (const m of muts) {
    if (m.type !== "childList") continue;
    m.addedNodes.forEach((n) => {
      if (n.nodeType !== 1) return;
      if (n.classList && (n.classList.contains("card") || n.classList.contains("says-card") || n.classList.contains("post-item"))) {
        n.classList.add("rv");
        revealScan();
      }
      if (n.querySelectorAll) revealScan();
    });
  }
});
if (!reduceMotion) document.addEventListener("DOMContentLoaded", () => revealMO.observe(document.body, { childList: true, subtree: true }));

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

/* ---------- 首页搜索胶囊（实时下拉）· 页面级 ---------- */
onPageReady(async ({ signal }) => {
  const input = document.getElementById("hs-input");
  const drop = document.getElementById("hs-drop");
  if (!input || !drop || document.body.dataset.page !== "home") return;
  let posts = [];
  let loading = true, failed = false, selected = -1;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-controls", drop.id);
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");
  if (!input.getAttribute("aria-label")) input.setAttribute("aria-label", "搜索文章");
  drop.setAttribute("role", "listbox");
  const close = () => { drop.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); };

  function renderDrop(kw) {
    const k = kw.trim().toLowerCase();
    selected = -1;
    input.removeAttribute("aria-activedescendant");
    if (!k) { close(); drop.innerHTML = ""; return; }
    const hits = posts.filter((p) => (p.title + " " + (p.summary || "") + " " + (p.tags || []).join(" ")).toLowerCase().includes(k)).slice(0, 6);
    drop.innerHTML = loading ? '<div class="hs-item hs-none" role="status">正在搜索…</div>'
      : failed ? '<div class="hs-item hs-none" role="status">搜索暂时无法加载，请稍后刷新重试。</div>'
      : hits.length
      ? hits.map((p, i) => `<a class="hs-item" id="hs-result-${i}" role="option" aria-selected="false" href="${postURL(p.slug)}"><b>${esc(p.title)}</b><span>${esc((p.summary || "").slice(0, 30))}</span></a>`).join("")
      : '<div class="hs-item hs-none" role="status">没有找到相关文章，换个关键词试试。</div>';
    drop.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  input.addEventListener("input", () => renderDrop(input.value));
  input.addEventListener("focus", () => renderDrop(input.value));
  input.addEventListener("keydown", (e) => {
    const hits = [...drop.querySelectorAll("a.hs-item")];
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && hits.length) {
      e.preventDefault();
      selected = (selected + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
      hits.forEach((link, i) => link.setAttribute("aria-selected", String(i === selected)));
      input.setAttribute("aria-activedescendant", hits[selected].id);
    }
    if (e.key === "Enter") {
      const first = hits[selected < 0 ? 0 : selected];
      if (first && !drop.hidden) { e.preventDefault(); first.click(); }
    }
    if (e.key === "Escape") close();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#home-search")) close();
  }, { signal });
  try { posts = await loadPosts(signal); } catch (e) { if (e.name === "AbortError") return; failed = true; }
  if (signal.aborted) return;
  loading = false;
  if (input.value.trim()) renderDrop(input.value);
});

/* ---------- 说说渲染 · 页面级 ---------- */
onPageReady(async ({ signal }) => {
  const list = document.getElementById("says-list");
  if (!list) return;
  let says = [];
  try {
    says = await loadJSON("says/says.json", "says", signal);
  } catch (e) {
    if (e.name !== "AbortError") list.innerHTML = contentFailure("说说");
    return;
  }
  if (signal.aborted) return;
  const liked = (id) => { try { return (localStorage.getItem("mm_liked") || "").split(",").filter(Boolean).includes(String(id)); } catch (e) { return false; } };
  const countEl = document.getElementById("says-count");
  if (countEl) countEl.textContent = says.length;
  if (!says.length) {
    list.innerHTML = '<p class="empty-tip">还没有说说，新的想法正在路上。</p>';
    return;
  }
  const rel = (t) => {
    const d = new Date(String(t).replace(" ", "T"));
    if (isNaN(d)) return t;
    const diff = (Date.now() - d.getTime()) / 60000;
    if (diff < 1) return "刚刚";
    if (diff < 60) return Math.floor(diff) + " 分钟前";
    if (diff < 1440) return Math.floor(diff / 60) + " 小时前";
    if (diff < 2880) return "昨天";
    return String(t).slice(0, 10);
  };
  list.innerHTML = says
    .map((s) => {
      const imgs = s.images || [];
      const gridCls = imgs.length === 1 ? " one" : imgs.length === 2 || imgs.length === 4 ? " two" : " grid3";
      return `
      <div class="says-card card rv">
         <img class="says-avatar" src="${siteURL("assets/avatar.webp")}" alt="">
        <div class="says-main">
          <div class="says-meta"><b>CidneyAurum</b><span class="says-time">${esc(rel(s.time))}</span></div>
          ${s.text ? `<div class="says-text">${esc(s.text)}</div>` : ""}
          <div class="says-actions"><button type="button" aria-pressed="${liked(s.id || s.time)}" class="like-btn${liked(s.id || s.time) ? " on" : ""}" data-like="${esc(s.id || s.time)}">${liked(s.id || s.time) ? "❤" : "♡"} <span>喜欢</span></button></div>
          ${imgs.length ? `<div class="says-grid${gridCls}">${imgs.map((src) => `<img src="${esc(siteURL(photoThumb(src)))}" data-full="${esc(siteURL(src))}" alt="说说配图" role="button" tabindex="0" aria-label="查看说说原图" loading="lazy" decoding="async">`).join("")}</div>` : ""}
        </div>
      </div>`;
    })
    .join("");
  // 点赞（本机记忆 + 爱心爆裂）
  list.querySelectorAll("[data-like]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.like;
      let likedList = [];
      try { likedList = (localStorage.getItem("mm_liked") || "").split(",").filter(Boolean); } catch (e) {}
      const on = likedList.includes(id);
      if (on) { likedList = likedList.filter((x) => x !== id); } else { likedList.push(id); }
      try { localStorage.setItem("mm_liked", likedList.join(",")); } catch (e) {}
      btn.classList.toggle("on", !on);
      btn.setAttribute("aria-pressed", String(!on));
      btn.firstChild.textContent = !on ? "❤" : "♡";
      if (!on && !reduceMotion) {
        const r = btn.getBoundingClientRect();
        for (let i = 0; i < 6; i++) {
          const s = document.createElement("span");
          s.className = "mouse-particle";
          s.textContent = ["❤", "💗", "✧"][i % 3];
          s.style.left = r.left + r.width / 2 - 6 + "px";
          s.style.top = r.top + "px";
          s.style.color = "#ff8fb7";
          s.style.fontSize = 9 + Math.random() * 9 + "px";
          s.style.setProperty("--dx", (Math.random() * 80 - 40).toFixed(0) + "px");
          s.style.setProperty("--rot", (Math.random() * 120 - 60).toFixed(0) + "deg");
          s.style.animationDuration = 0.7 + Math.random() * 0.5 + "s";
          document.body.appendChild(s);
          setTimeout(() => s.remove(), 1300);
        }
      }
    });
  });
  revealScan();
});

/* ---------- 归档页：双视图 + 搜索 + 标签 + 状态记忆 · 页面级 ---------- */
onPageReady(async ({ signal, onCleanup }) => {
  const listEl = document.getElementById("post-grid");
  const tlEl = document.getElementById("post-timeline");
  if (!listEl || !tlEl) return;
  const searchInput = document.getElementById("search-input");
  const filterBar = document.getElementById("tag-filter");
  let posts = [];
  try {
    posts = await loadPosts(signal);
  } catch (e) {
    if (e.name !== "AbortError") listEl.innerHTML = tlEl.innerHTML = contentFailure("文章");
    return;
  }
  if (signal.aborted) return;
  const countEl = document.getElementById("archive-count");
  if (countEl) countEl.textContent = posts.length;
  if (!posts.length) {
    listEl.innerHTML = tlEl.innerHTML = '<p class="empty-tip" role="status">还没有文章，新的记录正在路上。</p>';
    return;
  }

  const allTags = [...new Set(posts.flatMap((p) => p.tags || []))];
  // 恢复上次的状态（点进文章再返回时不丢筛选）
  let keyword = "", activeTag = null, view = "timeline";
  try {
    const saved = JSON.parse(session.getItem("blog_state") || "null");
    if (saved) {
      keyword = typeof saved.keyword === "string" ? saved.keyword : "";
      activeTag = allTags.includes(saved.activeTag) ? saved.activeTag : null;
      view = saved.view === "grid" ? "grid" : "timeline";
    }
  } catch (e) {}

  function coverHTML2(p, i) { return coverHTML(p, i); }
  function tagsHTML2(p) { return tagsHTML(p); }

  function itemHTML(p) {
    return `
      <div class="post-meta">
        <span class="post-date">🗓 ${esc(p.date)}</span>
        ${tagsHTML2(p)}
      </div>
      <h2 class="post-title">${esc(p.title)}</h2>
      <p class="post-summary">${esc(p.summary || "")}</p>`;
  }

  function render() {
    const kw = keyword.trim().toLowerCase();
    const shown = posts.filter((p) => {
      const tagOk = !activeTag || (p.tags || []).includes(activeTag);
      const hay = (p.title + " " + (p.summary || "") + " " + (p.tags || []).join(" ")).toLowerCase();
      return tagOk && (!kw || hay.includes(kw));
    });
    const empty = '<p class="empty-tip">没有找到匹配的档案…换个关键词试试吧 (´･ω･`)</p>';
    listEl.innerHTML = shown.length
      ? shown.map((p, i) => `
          <a class="post-item card" href="${postURL(p.slug)}">
            <div class="post-cover">${coverHTML2(p, i)}</div>
            <div class="post-main">${itemHTML(p)}</div>
            <span class="post-arrow">→</span>
          </a>`).join("")
      : empty;
    // 时间轴：按年份插入分隔徽章
    let tl = "", lastYear = "";
    shown.forEach((p) => {
      const year = (p.date || "").slice(0, 4);
      if (year && year !== lastYear) {
        tl += `<header class="tl-year">${esc(year)}</header>`;
        lastYear = year;
      }
      tl += `
        <div class="tl-item">
          <a class="tl-card card" href="${postURL(p.slug)}">
            <div class="tl-meta">${esc(p.date)}</div>
            <div class="tl-title">${esc(p.title)}</div>
            <div class="tl-summary">${esc(p.summary || "")}</div>
            <div class="tl-tags">${tagsHTML2(p)}</div>
          </a>
        </div>`;
    });
    tlEl.innerHTML = shown.length ? tl : empty;
    // 恢复筛选/视图的视觉状态
    if (filterBar) {
      filterBar.querySelectorAll(".chip").forEach((c) => {
        const on = (c.dataset.tag || null) === activeTag;
        c.classList.toggle("on", on); c.setAttribute("aria-pressed", String(on));
      });
    }
    document.querySelectorAll(".view-btn").forEach((b) => {
      b.classList.toggle("on", b.dataset.view === view); b.setAttribute("aria-pressed", String(b.dataset.view === view));
    });
    listEl.classList.toggle("on", view === "grid");
    tlEl.classList.toggle("on", view === "timeline");
  }

  function saveState() {
    session.setItem("blog_state", JSON.stringify({ keyword, activeTag, view }));
  }

  if (searchInput) {
    searchInput.value = keyword;
    searchInput.addEventListener("input", () => { keyword = searchInput.value; render(); saveState(); });
  }
  if (filterBar && allTags.length) {
    filterBar.innerHTML =
      '<button type="button" class="chip on" data-tag="">全部文章</button>' +
      allTags.map((t) => `<button type="button" class="chip" data-tag="${esc(t)}"># ${esc(t)}</button>`).join("");
    filterBar.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      activeTag = chip.dataset.tag || null;
      render();
      saveState();
    });
  }
  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      view = btn.dataset.view;
      render();
      saveState();
    });
  });
  // 点进文章前记录滚动位置
  listEl.addEventListener("click", () => saveState());
  tlEl.addEventListener("click", () => saveState());
  onCleanup(saveState);
  render();
  // Ctrl+K 从别的页面跳过来时自动聚焦搜索框
  if (session.getItem("focus-search") === "1") {
    session.removeItem("focus-search");
    if (searchInput) searchInput.focus();
  }
});

/* ============================================================
   首页音乐卡（自 index.html 内联脚本收编，PJAX 换页后可重放）
   ============================================================ */
function renderHomeTracks() {
  const list = document.getElementById("track-list");
  if (!list || !window.MikuMusic) return false;
  const st = window.MikuMusic.getState();
  const q = window.MikuMusic.getQueue();
  const signature = JSON.stringify([st.index, st.playing, st.hasQueue,
    q.map((t) => [t.id, t.name, t.artist, t.pic])]);
  if (list.dataset.trackSignature === signature) return false;
  const queueSignature = JSON.stringify(q.map((t) => [t.id, t.name, t.artist, t.pic]));
  if (list.dataset.queueSignature !== queueSignature) {
    list.coverObserver?.disconnect();
    list.innerHTML = q.map((t, i) => `
    <div class="track-item" data-i="${i}">
      ${t.pic ? `<img class="tk-pic" loading="lazy" decoding="async" width="31" height="31" data-cover-src="${esc(t.pic)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'tk-pic tk-no',textContent:'♪'}))">` : '<span class="tk-pic tk-no">♪</span>'}
      <span class="n">${esc(t.name)}</span><span class="a">${esc(t.artist)}</span>
    </div>`).join("");
    list.querySelectorAll(".track-item").forEach((el) =>
      el.addEventListener("click", () => window.MikuMusic.playIndex(+el.dataset.i).catch(() => {})));
    const loadCover = image => { if (image.dataset.coverSrc) { image.src = image.dataset.coverSrc; delete image.dataset.coverSrc; } };
    if ("IntersectionObserver" in window) {
      list.coverObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => { if (entry.isIntersecting) { loadCover(entry.target); list.coverObserver?.unobserve(entry.target); } });
      }, { root: list, rootMargin: "60px 0px" });
      list.querySelectorAll("img[data-cover-src]").forEach(image => list.coverObserver.observe(image));
    } else {
      list.querySelectorAll("img[data-cover-src]").forEach(loadCover);
    }
    list.dataset.queueSignature = queueSignature;
  }
  list.querySelectorAll(".track-item").forEach((row) => {
    const active = st.index === Number(row.dataset.i);
    row.classList.toggle("on", active);
    const eq = row.querySelector(".teq");
    if (active && st.playing && !eq) {
      const bars = document.createElement("span"); bars.className = "teq"; bars.innerHTML = "<i></i><i></i><i></i>"; row.appendChild(bars);
    } else if ((!active || !st.playing) && eq) eq.remove();
  });
  list.dataset.trackSignature = signature;
  return true;
}

/* mikumusic 全局桥：只绑一次，任何页面监听首页控件与队列高亮 */
document.addEventListener("mikumusic", (e) => {
  const d = e.detail || {};
  const list = document.getElementById("track-list");
  if (list && window.MikuMusic && window.MikuMusic.getQueue().length) {
    const changed = renderHomeTracks();
    const cur = list.querySelector(".track-item.on");
    if (changed && cur && d.playing) {
      const row = cur.getBoundingClientRect();
      const viewportTop = list.getBoundingClientRect().top + list.clientTop;
      const viewportBottom = viewportTop + list.clientHeight;
      if (row.top < viewportTop) list.scrollTop += row.top - viewportTop;
      else if (row.bottom > viewportBottom) list.scrollTop += row.bottom - viewportBottom;
    }
  }
  const mmBtn = document.querySelector(".js-mm-toggle");
  if (mmBtn) { mmBtn.textContent = d.playing ? "❚❚" : "▶"; mmBtn.setAttribute("aria-label", d.playing ? "暂停歌单" : "播放歌单"); }
  if (d.current) {
    const textEl = document.querySelector(".js-mm-text");
    if (textEl) textEl.textContent = "♪ " + (d.playing ? "正在播放" : "已选择") + "：《" + d.current.name + "》";
    const song = document.querySelector(".js-mm-song");
    if (song) song.textContent = d.current.name + (d.current.artist ? " - " + d.current.artist : "");
  }
});

onPageReady(async ({ signal, onCleanup }) => {
  const list = document.getElementById("track-list");
  const fallback = document.getElementById("music-fallback");
  if (!list || !fallback || !window.MikuMusic) return;
  onCleanup(() => list.coverObserver?.disconnect());

  const load = async () => {
    list.style.display = "";
    delete list.dataset.trackSignature;
    delete list.dataset.queueSignature;
    list.coverObserver?.disconnect();
    list.innerHTML = '<p class="empty-tip" style="padding:16px 0;">歌单加载中… 🎵</p>';
    fallback.style.display = "none";
    try {
      await window.MikuMusic.loadPlaylist();
      if (signal.aborted) return;
      renderHomeTracks();
      document.dispatchEvent(new CustomEvent("mikumusic", { detail: window.MikuMusic.getState() }));
    } catch (e) {
      if (signal.aborted) return;
      list.style.display = "none";
      fallback.style.display = "";
    }
  };
  const retry = document.getElementById("music-retry");
  if (retry) retry.addEventListener("click", async () => {
    window.MikuMusic.reloadPlaylist();
    await load();
  });
  const mmToggle = document.querySelector(".js-mm-toggle");
  if (mmToggle) mmToggle.addEventListener("click", () => window.MikuMusic.toggle());
  const mmNext = document.querySelector(".js-mm-next");
  if (mmNext) mmNext.addEventListener("click", () => window.MikuMusic.next());
  // 音乐卡标签切换（歌单 / 电台）
  document.querySelectorAll(".ctab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".ctab").forEach((b) => b.classList.toggle("on", b === btn));
      document.querySelectorAll(".cpane").forEach((p) => (p.style.display = p.id === "cpane-" + btn.dataset.pane ? "" : "none"));
    });
  });
  await load();
});

/* ============================================================
   阶段四 · 视觉与交互（进站遮罩 / 导航自动隐藏 / 卡片 tilt / 快捷键 / 右键菜单）
   ============================================================ */

/* --- 进站加载遮罩（每次整页加载一次，PJAX 不触发） --- */
(function bootVeil() {
  if (reduceMotion) return;
  const veil = document.createElement("div");
  veil.className = "boot-veil";
  veil.innerHTML = '<div class="bv-mark">✧</div><div class="bv-name">CidneyAurum の 小窝</div>';
  document.body.appendChild(veil);
  const off = () => veil.classList.add("off");
  if (document.readyState === "complete") setTimeout(off, 300);
  else window.addEventListener("load", () => setTimeout(off, 300), { once: true });
  veil.addEventListener("transitionend", () => veil.remove());
  setTimeout(() => veil.remove(), 3200); // 兜底，绝不让它挡住页面
})();

/* --- 导航：下滑隐藏、上滑显现 --- */
(function navAutoHide() {
  let lastY = 0;
  document.addEventListener("DOMContentLoaded", () => {
    const nav = document.querySelector(".nav");
    if (!nav) return;
    window.addEventListener("scroll", () => {
      const y = window.scrollY;
      if (y > 320 && y > lastY + 4) nav.classList.add("nav-hide");
      else if (y < lastY - 4 || y <= 320) nav.classList.remove("nav-hide");
      lastY = y;
    }, { passive: true });
  });
})();

/* --- 卡片 3D 倾斜 + 光晕跟随（桌面指针设备） --- */
(function cardTilt() {
  if (reduceMotion || window.matchMedia("(hover: none)").matches) return;
  document.addEventListener("pointermove", (e) => {
    const card = e.target.closest && e.target.closest(".card");
    if (!card) return;
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    card.style.setProperty("--mx", (px * 100).toFixed(1) + "%");
    card.style.setProperty("--my", (py * 100).toFixed(1) + "%");
    const rx = ((py - 0.5) * -4).toFixed(2);
    const ry = ((px - 0.5) * 4).toFixed(2);
    card.style.transform = "perspective(900px) rotateX(" + rx + "deg) rotateY(" + ry + "deg) translateY(-1px)";
    if (!card._tiltReset) {
      card._tiltReset = true;
      card.addEventListener("pointerleave", () => { card.style.transform = ""; });
    }
  }, { passive: true });
})();

/* --- 全局快捷键（按住 Shift 出提示条） --- */
(function hotkeys() {
  const MAP = [
    ["D", "切换主题"], ["S", "搜索档案"], ["R", "随便逛逛"],
    ["H", "回首页"], ["T", "回到顶部"], ["空格", "播放/暂停"],
  ];
  let bar = null, barTimer = 0;
  const show = () => {
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "hotkey-bar";
      bar.innerHTML = MAP.map(([k, d]) => "<span><kbd>" + k + "</kbd>" + d + "</span>").join("");
      document.body.appendChild(bar);
    }
    bar.classList.add("show");
    clearTimeout(barTimer);
    barTimer = setTimeout(() => bar.classList.remove("show"), 2400);
  };
  const typing = () => {
    const t = (document.activeElement && document.activeElement.tagName) || "";
    return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || document.activeElement?.isContentEditable;
  };
  document.addEventListener("keydown", (e) => {
    if (typing() || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.shiftKey && !e.repeat && e.key !== "Shift") show(); // 只出提示，不拦截
    if (e.key === "D" || e.key === "d") {
      const b = document.getElementById("theme-toggle");
      if (b) b.click();
    } else if (e.key === "S" || e.key === "s") {
      const si = document.getElementById("search-input");
      if (si) { si.focus(); si.scrollIntoView({ block: "center" }); }
      else { session.setItem("focus-search", "1"); pjaxGo(siteURL("blog.html"), true); }
    } else if (e.key === "R" || e.key === "r") {
      loadPosts().then((posts) => {
        if (!posts.length) return;
        const pg = posts[Math.floor(Math.random() * posts.length)];
        pjaxGo(postURL(pg.slug), true);
        if (window.MikuMusic) MikuMusic.toast("随机逛到：《" + pg.title + "》");
      }).catch(() => {});
    } else if (e.key === "H" || e.key === "h") {
      pjaxGo(siteURL("index.html"), true);
    } else if (e.key === "T" || e.key === "t") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });
})();

/* --- 自定义右键菜单（输入框与链接保留原生菜单） --- */
(function ctxMenu() {
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.innerHTML = [
    '<button data-act="random">🎲 随便逛逛</button>',
    '<button data-act="copy">🔗 复制页面链接</button>',
    '<button data-act="theme">✨ 切换日夜</button>',
    '<button data-act="top">✦ 回到顶部</button>',
    '<button data-act="admin">✍️ 写作台</button>',
  ].join("");
  document.body.appendChild(menu);
  const close = () => menu.classList.remove("open");
  document.addEventListener("contextmenu", (e) => {
    if (e.target.closest("input, textarea, select, a, button")) return;
    e.preventDefault();
    menu.style.left = Math.min(e.clientX, window.innerWidth - 190) + "px";
    menu.style.top = Math.min(e.clientY, window.innerHeight - 230) + "px";
    menu.classList.add("open");
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".ctx-menu")) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    close();
    const act = b.dataset.act;
    if (act === "theme") {
      const t = document.getElementById("theme-toggle");
      if (t) t.click();
    } else if (act === "top") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (act === "copy") {
      const url = location.href;
      const pr = navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject();
      pr.then(() => { if (window.MikuMusic) MikuMusic.toast("页面链接已复制 ♪"); })
        .catch(() => { if (window.MikuMusic) MikuMusic.toast("复制失败，请从地址栏复制链接"); });
    } else if (act === "random") {
      loadPosts().then((posts) => {
        if (!posts.length) return;
        const pg = posts[Math.floor(Math.random() * posts.length)];
        pjaxGo(postURL(pg.slug), true);
      }).catch(() => {});
    } else if (act === "admin") {
      location.href = siteURL("admin.html");
    }
  });
})();
