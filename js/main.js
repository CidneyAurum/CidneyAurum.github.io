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

/* ---------- 页面就绪注册表：DOMContentLoaded 与 PJAX 换页都会重放 ---------- */
const PAGE_READY = [];
function onPageReady(fn) { PAGE_READY.push(fn); }
function runPageReady() {
  PAGE_READY.forEach((fn) => { try { fn(); } catch (e) { console.warn("[page-init]", e); } });
}
document.addEventListener("DOMContentLoaded", runPageReady);

/* ---------- PWA Service Worker（离线缓存 + 可安装） ---------- */
if ("serviceWorker" in navigator && location.protocol === "https:") {
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
let pjaxBusy = false;
function swapTarget(doc) { return doc.querySelector("main") || doc.querySelector(".wrap.article-layout"); }

async function pjaxGo(url, push) {
  if (pjaxBusy) return;
  pjaxBusy = true;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const newMain = swapTarget(doc);
    const curMain = swapTarget(document);
    if (!newMain || !curMain) throw new Error("swap target missing");
    const base = new URL(url, location.href);
    // 换入子树的相对路径按目标页 URL 转绝对，避免跨目录解析错位
    newMain.querySelectorAll("[src], [href]").forEach((el) => {
      const attr = el.hasAttribute("src") ? "src" : "href";
      const v = el.getAttribute(attr) || "";
      if (v && !/^(https?:|data:|#|javascript:)/i.test(v)) el.setAttribute(attr, new URL(v, base).href);
    });
    const applySwap = () => {
      document.title = doc.title;
      if (doc.body && doc.body.dataset.page) document.body.dataset.page = doc.body.dataset.page;
      curMain.replaceWith(document.adoptNode(newMain));
    };
    if (document.startViewTransition && !reduceMotion) document.startViewTransition(applySwap);
    else applySwap();
    if (push) history.pushState({ pjax: 1 }, "", base.href);
    window.scrollTo(0, 0);
    refreshNavActive();
    runPageReady();
  } catch (e) {
    location.href = url; // 兜底：整页跳转
  } finally {
    pjaxBusy = false;
  }
}

function refreshNavActive() {
  const here = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  document.querySelectorAll(".nav-link").forEach((a) => {
    const target = (a.getAttribute("href") || "").split("/").pop().toLowerCase();
    a.classList.toggle("active", target === here);
  });
}

document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest("a[href]");
  if (!a) return;
  const href = a.getAttribute("href") || "";
  if (a.target === "_blank" || a.hasAttribute("download")) return;
  if (/^(https?:)?\/\//i.test(href) || /^(mailto|javascript|tel):/i.test(href) || href.startsWith("#")) return;
  if (!/\.html(\?.*)?$/i.test(href.split("#")[0])) return; // 只接管站内页面
  if (/admin\.html/i.test(href)) return;                    // 写作台整页跳转
  e.preventDefault();
  pjaxGo(href, true);
});
window.addEventListener("popstate", () => pjaxGo(location.href, false));

/* ---------- 主题（默认夜间，可切日间）· 全局单例 ---------- */
(function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "light") document.body.classList.add("light");
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    const sync = () => {
      const light = document.body.classList.contains("light");
      btn.textContent = light ? "🌙" : "✨";
      btn.title = light ? "回到深空" : "点亮日光";
    };
    sync();
    btn.addEventListener("click", (e) => {
      const apply = () => {
        document.body.classList.toggle("light");
        localStorage.setItem("theme", document.body.classList.contains("light") ? "light" : "dark");
        sync();
      };
      // 主题切换圆形扩散（View Transitions API，不支持的浏览器自动降级）
      if (!document.startViewTransition || reduceMotion) { apply(); return; }
      const x = (e && e.clientX) || window.innerWidth - 60;
      const y = (e && e.clientY) || 40;
      const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
      const vt = document.startViewTransition(apply);
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
    burger.addEventListener("click", () => links.classList.toggle("open"));
    links.addEventListener("click", (e) => {
      if (e.target.classList.contains("nav-link")) links.classList.remove("open");
    });
  }
});

/* ---------- 流萤粒子 · 全局单例 ---------- */
(function fireflies() {
  if (!SITE_CONFIG.fireflies.enabled || reduceMotion) return;
  const canvas = document.getElementById("firefly-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
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
onPageReady(() => {
  const el = document.getElementById("slogan-text");
  if (!el) return;
  clearTimeout(sloganTimer);
  const caret = el.parentElement.querySelector(".caret");
  const lines = [...SITE_CONFIG.sloganLines];
  let li = 0, ci = 0, deleting = false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
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
onPageReady(() => {
  const timeEl = document.getElementById("clock-time");
  const upEl = document.getElementById("uptime");
  if (!timeEl && !upEl) return;
  clearInterval(clockTimer);
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
});

/* ---------- 文章数据 ---------- */
async function loadPosts() {
  const base = document.body.dataset.page === "post" ? "../" : "";
  const res = await fetch(base + "posts/posts.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(res.status);
  const data = await res.json();
  return (data.posts || []).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
function coverHTML(post, i) {
  if (post.cover) return `<img src="${post.cover}" alt="">`;
  const pool = ["🌌", "🪐", "🛸", "🌙", "⭐", "💫", "☄️", "🔭"];
  return pool[(i + (post.slug || "").length) % pool.length];
}
function tagsHTML(post) { return (post.tags || []).map((t) => `<span class="tag-mini"># ${t}</span>`).join(""); }

/* ---------- 首页：最新文章摘要区 · 页面级 ---------- */
onPageReady(async () => {
  const featuredLink = document.getElementById("featured-link");
  const recordsBox = document.getElementById("records-list");
  if (!featuredLink && !recordsBox) return;
  let posts;
  try { posts = await loadPosts(); } catch { return; }
  if (!posts.length) return;

  const statPosts = document.getElementById("stat-posts");
  const statTags = document.getElementById("stat-tags");
  const statDays = document.getElementById("stat-days");
  if (statPosts) statPosts.textContent = posts.length;
  if (statTags) statTags.textContent = new Set(posts.flatMap((p) => p.tags || [])).size;
  if (statDays) {
    const days = Math.max(1, Math.ceil((Date.now() - new Date(SITE_CONFIG.siteBirthday + "T00:00:00")) / 86400000));
    statDays.textContent = days;
  }

  if (featuredLink) {
    const f = posts[0];
    featuredLink.href = new URL("posts/" + encodeURIComponent(f.slug) + ".html", location.href).href;
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
      <a class="record-item" href="${new URL("posts/" + encodeURIComponent(p.slug) + ".html", location.href).href}">
        <div class="record-meta">RECORD · ${p.date} ${(p.tags || []).map((t) => "· " + t).join(" ")}</div>
        <div class="record-title">${p.title}</div>
        <div class="record-summary">${p.summary || ""}</div>
      </a>`).join("");
  }
});

/* ---------- 文章右侧栏 RECORDS · 页面级 ---------- */
onPageReady(async () => {
  const sideRecords = document.getElementById("side-records");
  if (!sideRecords) return;
  let posts;
  try { posts = await loadPosts(); } catch { return; }
  sideRecords.innerHTML = posts.slice(0, 4).map((p) => `
    <a class="side-record" href="${new URL("posts/" + encodeURIComponent(p.slug) + ".html", location.href).href}">
      <div class="d">${p.date}</div>
      <div class="t">${p.title}</div>
    </a>`).join("");
});

/* ---------- 照片墙渲染（缩略图 + 灯箱原图）· 页面级 ---------- */
const photoThumb = (src) => src.replace(/\/(gallery|says)\//, "/$1/thumbs/").replace(/\.(jpe?g|png)$/i, ".webp");
onPageReady(async () => {
  const grid = document.getElementById("photo-grid");
  if (!grid) return;
  let photos = [];
  try {
    const res = await fetch("assets/gallery/gallery.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status);
    photos = (await res.json()).photos || [];
  } catch {
    grid.innerHTML = '<p class="empty-tip">(´･ω･`) 照片列表加载失败了…<br>本地预览请用本地服务器（见 README）。</p>';
    return;
  }
  if (!photos.length) {
    grid.innerHTML = '<p class="empty-tip">画廊还空着，往 assets/gallery/ 丢几张图试试吧 ♧</p>';
    return;
  }
  grid.innerHTML = photos
    .map(
      (p) => `
    <figure class="polaroid">
      <span class="tape"></span>
      <div class="ph"><img src="${photoThumb(p.src)}" data-full="${p.src}" alt="${p.caption}" loading="lazy" decoding="async"></div>
      <figcaption class="cap">${p.caption} <small>${p.when}</small></figcaption>
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
  box.innerHTML = '<img alt=""><div class="cap"></div>';
  document.body.appendChild(box);
  const img = box.querySelector("img");
  const cap = box.querySelector(".cap");
  const close = () => { box.classList.remove("open"); img.src = ""; };
  box.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  document.addEventListener("click", (e) => {
    const t = e.target;
    const isPhoto = t.matches(".prose img, .photo-grid .ph img, .kb-msg img, .says-grid img");
    if (!isPhoto || !t.src || t.src.startsWith("blob:")) return;
    e.preventDefault();
    e.stopPropagation();
    img.src = t.dataset.full || t.src;
    cap.textContent = t.alt || "";
    box.classList.add("open");
  });
});

/* ---------- 文章目录滚动高亮 · 页面级 ---------- */
onPageReady(() => {
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
});

/* ---------- Ctrl+K / / 唤起归档搜索 · 全局单例 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("keydown", (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (document.getElementById("search-input")) {
        document.getElementById("search-input").focus();
        document.getElementById("search-input").scrollIntoView({ block: "center" });
      } else {
        const base = document.body.dataset.page === "post" ? "../" : "";
        pjaxGo(base + "blog.html", true);
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
onPageReady(async () => {
  const input = document.getElementById("hs-input");
  const drop = document.getElementById("hs-drop");
  if (!input || !drop || document.body.dataset.page !== "home") return;
  let posts = [];
  try {
    const res = await fetch("posts/posts.json", { cache: "no-cache" });
    posts = (await res.json()).posts || [];
  } catch (e) { return; }

  function renderDrop(kw) {
    const k = kw.trim().toLowerCase();
    if (!k) { drop.hidden = true; drop.innerHTML = ""; return; }
    const hits = posts.filter((p) => (p.title + " " + (p.summary || "") + " " + (p.tags || []).join(" ")).toLowerCase().includes(k)).slice(0, 6);
    drop.innerHTML = hits.length
      ? hits.map((p) => `<a class="hs-item" href="${new URL("posts/" + encodeURIComponent(p.slug) + ".html", location.href).href}"><b>${esc(p.title)}</b><span>${(p.summary || "").slice(0, 30)}</span></a>`).join("")
      : '<div class="hs-item hs-none">没找到相关文章 (´･ω･`)</div>';
    drop.hidden = false;
  }

  input.addEventListener("input", () => renderDrop(input.value));
  input.addEventListener("focus", () => renderDrop(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = drop.querySelector("a.hs-item");
      if (first) first.click();
    }
    if (e.key === "Escape") { drop.hidden = true; input.blur(); }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#home-search")) drop.hidden = true;
  });
});

/* ---------- 说说渲染 · 页面级 ---------- */
onPageReady(async () => {
  const list = document.getElementById("says-list");
  if (!list) return;
  let says = [];
  try {
    const res = await fetch("says/says.json", { cache: "no-cache" });
    says = (await res.json()).says || [];
  } catch (e) {
    list.innerHTML = '<p class="empty-tip">说说加载失败…</p>';
    return;
  }
  const liked = (id) => { try { return (localStorage.getItem("mm_liked") || "").split(",").filter(Boolean).includes(String(id)); } catch (e) { return false; } };
  const countEl = document.getElementById("says-count");
  if (countEl) countEl.textContent = says.length;
  if (!says.length) {
    list.innerHTML = '<p class="empty-tip">还没有说说，去写作台发第一条吧 ♢</p>';
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
        <img class="says-avatar" src="assets/avatar.webp" alt="">
        <div class="says-main">
          <div class="says-meta"><b>CidneyAurum</b><span class="says-time">${rel(s.time)}</span></div>
          ${s.text ? `<div class="says-text">${esc(s.text)}</div>` : ""}
          <div class="says-actions"><button class="like-btn${liked(s.id) ? " on" : ""}" data-like="${s.id || rel(s.time)}">${liked(s.id) ? "❤" : "♡"} <span>喜欢</span></button></div>
          ${imgs.length ? `<div class="says-grid${gridCls}">${imgs.map((src) => `<img src="${photoThumb(src)}" data-full="${src}" alt="" loading="lazy" decoding="async">`).join("")}</div>` : ""}
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
      btn.firstChild.textContent = !on ? "❤" : "♡";
      if (!on) {
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
onPageReady(async () => {
  const listEl = document.getElementById("post-grid");
  const tlEl = document.getElementById("post-timeline");
  if (!listEl || !tlEl) return;
  const searchInput = document.getElementById("search-input");
  const filterBar = document.getElementById("tag-filter");
  let posts = [];
  try {
    posts = await loadPosts();
  } catch (e) {
    listEl.innerHTML = '<p class="empty-tip">(´･ω･`) 档案加载失败了…<br>本地预览请用本地服务器（见 README）。</p>';
    return;
  }
  const countEl = document.getElementById("archive-count");
  if (countEl) countEl.textContent = posts.length;
  if (!posts.length) {
    listEl.innerHTML = '<p class="empty-tip">还没有档案，快去写第一篇吧 ✧</p>';
    return;
  }

  const allTags = [...new Set(posts.flatMap((p) => p.tags || []))];
  // 恢复上次的状态（点进文章再返回时不丢筛选）
  let keyword = "", activeTag = null, view = "timeline";
  try {
    const saved = JSON.parse(sessionStorage.getItem("blog_state") || "null");
    if (saved) {
      keyword = saved.keyword || "";
      activeTag = saved.activeTag || null;
      view = saved.view || "timeline";
      if (saved.scrollY) sessionStorage.setItem("blog_restore_scroll", String(saved.scrollY));
    }
  } catch (e) {}

  function coverHTML2(p, i) { return coverHTML(p, i); }
  function tagsHTML2(p) { return tagsHTML(p); }

  function itemHTML(p) {
    return `
      <div class="post-meta">
        <span class="post-date">🗓 ${p.date}</span>
        ${tagsHTML2(p)}
      </div>
      <h2 class="post-title">${p.title}</h2>
      <p class="post-summary">${p.summary || ""}</p>`;
  }

  function postURL(slug) { return new URL("posts/" + encodeURIComponent(slug) + ".html", location.href).href; }

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
        tl += `<header class="tl-year">${year}</header>`;
        lastYear = year;
      }
      tl += `
        <div class="tl-item">
          <a class="tl-card card" href="${postURL(p.slug)}">
            <div class="tl-meta">${p.date}</div>
            <div class="tl-title">${p.title}</div>
            <div class="tl-summary">${p.summary || ""}</div>
            <div class="tl-tags">${tagsHTML2(p)}</div>
          </a>
        </div>`;
    });
    tlEl.innerHTML = shown.length ? tl : empty;
    // 恢复筛选/视图的视觉状态
    if (filterBar) {
      filterBar.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", (c.dataset.tag || null) === activeTag));
    }
    document.querySelectorAll(".view-btn").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    listEl.classList.toggle("on", view === "grid");
    tlEl.classList.toggle("on", view === "timeline");
    // 恢复滚动位置
    const rs = sessionStorage.getItem("blog_restore_scroll");
    if (rs) {
      sessionStorage.removeItem("blog_restore_scroll");
      setTimeout(() => window.scrollTo({ top: +rs, behavior: "instant" }), 150);
    }
  }

  function saveState() {
    sessionStorage.setItem("blog_state", JSON.stringify({ keyword, activeTag, view, scrollY: window.scrollY }));
  }

  if (searchInput) {
    searchInput.value = keyword;
    searchInput.addEventListener("input", () => { keyword = searchInput.value; render(); saveState(); });
  }
  if (filterBar && allTags.length) {
    filterBar.innerHTML =
      '<span class="chip on" data-tag="">全部档案</span>' +
      allTags.map((t) => `<span class="chip" data-tag="${t}"># ${t}</span>`).join("");
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
      document.querySelectorAll(".view-btn").forEach((b) => b.classList.toggle("on", b === btn));
      listEl.classList.toggle("on", view === "grid");
      tlEl.classList.toggle("on", view === "timeline");
      saveState();
    });
  });
  // 点进文章前记录滚动位置
  listEl.addEventListener("click", () => saveState());
  render();
  // Ctrl+K 从别的页面跳过来时自动聚焦搜索框
  if (sessionStorage.getItem("focus-search") === "1") {
    sessionStorage.removeItem("focus-search");
    if (searchInput) setTimeout(() => searchInput.focus(), 250);
  }
});

/* ============================================================
   首页音乐卡（自 index.html 内联脚本收编，PJAX 换页后可重放）
   ============================================================ */
function renderHomeTracks() {
  const list = document.getElementById("track-list");
  if (!list || !window.MikuMusic) return;
  const st = window.MikuMusic.getState();
  const q = window.MikuMusic.getQueue();
  list.innerHTML = q.map((t, i) => `
    <div class="track-item${st.index === i && (st.playing || st.hasQueue) ? " on" : ""}" data-i="${i}">
      ${t.pic ? `<img class="tk-pic" src="${t.pic}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'tk-pic tk-no',textContent:'♪'}))">` : '<span class="tk-pic tk-no">♪</span>'}
      <span class="n">${t.name}</span><span class="a">${t.artist}</span>
      ${st.index === i && st.playing ? '<span class="teq"><i></i><i></i><i></i></span>' : ""}
    </div>`).join("");
  list.querySelectorAll(".track-item").forEach((el) =>
    el.addEventListener("click", () => window.MikuMusic.playIndex(+el.dataset.i)));
}

/* mikumusic 全局桥：只绑一次，任何页面监听首页控件与队列高亮 */
document.addEventListener("mikumusic", (e) => {
  const d = e.detail || {};
  const list = document.getElementById("track-list");
  if (list && window.MikuMusic && window.MikuMusic.getQueue().length) {
    renderHomeTracks();
    const cur = list.querySelector(".track-item.on");
    if (cur && d.playing) cur.scrollIntoView({ block: "nearest" });
  }
  const mmBtn = document.querySelector(".js-mm-toggle");
  if (mmBtn) mmBtn.textContent = d.playing ? "❚❚" : "▶";
  if (d.current) {
    const textEl = document.querySelector(".js-mm-text");
    if (textEl) textEl.textContent = "♪ 正在播放：《" + d.current.name + "》";
    const song = document.querySelector(".js-mm-song");
    if (song) song.textContent = d.current.name + (d.current.artist ? " - " + d.current.artist : "");
  }
});

onPageReady(async () => {
  const list = document.getElementById("track-list");
  const fallback = document.getElementById("music-fallback");
  if (!list || !fallback || !window.MikuMusic) return;

  const load = async () => {
    list.style.display = "";
    list.innerHTML = '<p class="empty-tip" style="padding:16px 0;">歌单加载中… 🎵</p>';
    fallback.style.display = "none";
    try {
      await window.MikuMusic.loadPlaylist();
      renderHomeTracks();
    } catch (e) {
      list.style.display = "none";
      fallback.style.display = "";
    }
  };
  await load();

  const retry = document.getElementById("music-retry");
  if (retry) retry.addEventListener("click", async () => {
    window.MikuMusic.reloadPlaylist();
    await load();
  });
  const lyricBtn = document.querySelector(".js-lyric");
  if (lyricBtn) lyricBtn.addEventListener("click", () => window.MikuMusic.lyricOverlay.open());
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
    return t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
  };
  document.addEventListener("keydown", (e) => {
    if (typing()) return;
    if (e.shiftKey && !e.repeat && e.key !== "Shift") show(); // 只出提示，不拦截
    if (e.key === "D" || e.key === "d") {
      const b = document.getElementById("theme-toggle");
      if (b) b.click();
    } else if (e.key === "S" || e.key === "s") {
      const si = document.getElementById("search-input");
      if (si) { si.focus(); si.scrollIntoView({ block: "center" }); }
      else { sessionStorage.setItem("focus-search", "1"); pjaxGo((document.body.dataset.page === "post" ? "../" : "") + "blog.html", true); }
    } else if (e.key === "R" || e.key === "r") {
      loadPosts().then((posts) => {
        if (!posts.length) return;
        const pg = posts[Math.floor(Math.random() * posts.length)];
        pjaxGo((document.body.dataset.page === "post" ? "../posts/" : "posts/") + encodeURIComponent(pg.slug) + ".html", true);
        if (window.MikuMusic) MikuMusic.toast("随机逛到：《" + pg.title + "》");
      }).catch(() => {});
    } else if (e.key === "H" || e.key === "h") {
      pjaxGo("index.html", true);
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
      pr.catch(() => {}).finally(() => { if (window.MikuMusic) MikuMusic.toast("页面链接已复制 ♪"); });
    } else if (act === "random") {
      loadPosts().then((posts) => {
        if (!posts.length) return;
        const pg = posts[Math.floor(Math.random() * posts.length)];
        pjaxGo((document.body.dataset.page === "post" ? "../posts/" : "posts/") + encodeURIComponent(pg.slug) + ".html", true);
      }).catch(() => {});
    } else if (act === "admin") {
      location.href = (document.body.dataset.page === "post" ? "../" : "") + "admin.html";
    }
  });
})();
