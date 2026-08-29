/* ============================================
   星轨小窝 · 全站脚本
   流萤粒子 / 打字横幅 / 时钟运行条 / 博客渲染与搜索 / 主题
   ============================================ */
"use strict";

/* ---------- 可调参数（✏️ 想改效果就动这里） ---------- */
const SITE_CONFIG = {
  fireflies: { enabled: true, count: 26 },          // 流萤粒子
  sloganLines: [                                     // 首页横幅打字文案
    "直面过去，创造未来",
    "慢慢来，比较快",
    "今天也要元气满满哦 ♪",
    "仰望星空，脚踏实地 ✧",
  ],
  siteBirthday: "2026-08-29",                        // 网站生日（用于运行天数）
};

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- 主题（默认夜间，可切日间） ---------- */
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
    btn.addEventListener("click", () => {
      document.body.classList.toggle("light");
      localStorage.setItem("theme", document.body.classList.contains("light") ? "light" : "dark");
      sync();
    });
  });
})();

/* ---------- 移动端汉堡菜单 ---------- */
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

/* ---------- 流萤粒子 ---------- */
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
    const huePick = Math.random();
    const color = huePick < 0.55 ? "173, 216, 255" : huePick < 0.85 ? "196, 181, 255" : "255, 214, 236";
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

/* ---------- 横幅打字机（一言接口的句子会加入轮播） ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("slogan-text");
  if (!el) return;
  const caret = el.parentElement.querySelector(".caret");
  const lines = [...SITE_CONFIG.sloganLines];
  let li = 0, ci = 0, deleting = false;

  // 一言：加载成功后把那句话也加入轮播
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  fetch("https://v1.hitokoto.cn/?c=i&c=k&c=a", { signal: controller.signal })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((data) => {
      clearTimeout(timer);
      if (data.hitokoto) lines.push(data.hitokoto);
    })
    .catch(() => clearTimeout(timer));

  if (reduceMotion) { el.textContent = lines[0]; if (caret) caret.style.display = "none"; return; }

  (function loop() {
    const line = lines[li];
    el.textContent = line.slice(0, ci);
    let delay = deleting ? 34 : 120;
    if (!deleting && ci === line.length) { delay = 2600; deleting = true; }
    else if (deleting && ci === 0) { deleting = false; li = (li + 1) % lines.length; delay = 500; }
    ci += deleting ? -1 : 1;
    setTimeout(loop, delay);
  })();
});

/* ---------- 时钟 + 网站运行天数 ---------- */
document.addEventListener("DOMContentLoaded", () => {
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
    if (upEl) {
      const days = Math.max(0, Math.floor((now - birthday) / 86400000));
      const hours = Math.max(0, Math.floor(((now - birthday) % 86400000) / 3600000));
      upEl.textContent = days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
    }
  }
  render();
  setInterval(render, 1000);
});

/* ---------- 文章数据加载（首页摘要区 + 博客列表共用） ---------- */
async function loadPosts() {
  const base = document.body.dataset.page === "post" ? "../" : "";
  const res = await fetch(base + "posts/posts.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(res.status);
  const data = await res.json();
  return (data.posts || []).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
function coverEmoji(post, i) {
  if (post.emoji) return post.emoji;
  const pool = ["🌌", "🪐", "🛸", "🌙", "⭐", "💫", "☄️", "🔭"];
  return pool[(i + (post.slug || "").length) % pool.length];
}

/* ---------- 首页：最新文章摘要区 ---------- */
document.addEventListener("DOMContentLoaded", async () => {
  const featuredLink = document.getElementById("featured-link");
  const recordsBox = document.getElementById("records-list");
  if (!featuredLink && !recordsBox) return;
  let posts;
  try { posts = await loadPosts(); } catch { return; }
  if (!posts.length) return;

  // 统计数字
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
    featuredLink.href = "posts/" + encodeURIComponent(f.slug) + ".html";
    const t = document.getElementById("featured-title");
    const s = document.getElementById("featured-summary");
    const d = document.getElementById("featured-date");
    const e = document.getElementById("featured-emoji");
    if (t) t.textContent = f.title;
    if (s) s.textContent = f.summary || "";
    if (d) d.textContent = f.date;
    if (e) e.textContent = coverEmoji(f, 0);
  }
  if (recordsBox) {
    recordsBox.innerHTML = posts
      .slice(1, 5)
      .map(
        (p, i) => `
      <a class="record-item" href="posts/${encodeURIComponent(p.slug)}.html">
        <div class="record-meta">RECORD · ${p.date} ${(p.tags || []).map((t) => "· " + t).join(" ")}</div>
        <div class="record-title">${p.title}</div>
        <div class="record-summary">${p.summary || ""}</div>
      </a>`
      )
      .join("");
  }
});

/* ---------- 博客页：列表 + 搜索 + 标签筛选 ---------- */
document.addEventListener("DOMContentLoaded", async () => {
  const listEl = document.getElementById("post-list");
  if (!listEl) return;
  const searchInput = document.getElementById("search-input");
  const filterBar = document.getElementById("tag-filter");
  let posts = [];
  try {
    posts = await loadPosts();
  } catch {
    listEl.innerHTML = '<p class="empty-tip">(´･ω･`) 文章列表加载失败了…<br>本地预览请用本地服务器（见 README），线上不受影响。</p>';
    return;
  }
  if (!posts.length) {
    listEl.innerHTML = '<p class="empty-tip">还没有文章，快去写第一篇吧 ✧</p>';
    return;
  }

  const allTags = [...new Set(posts.flatMap((p) => p.tags || []))];
  let keyword = "";
  let activeTag = null;

  function render() {
    const kw = keyword.trim().toLowerCase();
    const shown = posts.filter((p) => {
      const tagOk = !activeTag || (p.tags || []).includes(activeTag);
      const hay = (p.title + " " + (p.summary || "") + " " + (p.tags || []).join(" ")).toLowerCase();
      return tagOk && (!kw || hay.includes(kw));
    });
    listEl.innerHTML = shown.length
      ? shown
          .map(
            (p, i) => `
      <a class="post-item card" href="posts/${encodeURIComponent(p.slug)}.html">
        <div class="post-cover">${coverEmoji(p, i)}</div>
        <div class="post-main">
          <div class="post-meta">
            <span class="post-date">🗓 ${p.date}</span>
            ${(p.tags || []).map((t) => `<span class="tag-mini"># ${t}</span>`).join("")}
          </div>
          <h2 class="post-title">${p.title}</h2>
          <p class="post-summary">${p.summary || ""}</p>
        </div>
        <span class="post-arrow">→</span>
      </a>`
          )
          .join("")
      : '<p class="empty-tip">没有找到匹配的文章…换个关键词试试吧 (´･ω･`)</p>';
  }

  if (searchInput) {
    searchInput.addEventListener("input", () => { keyword = searchInput.value; render(); });
  }
  if (filterBar && allTags.length) {
    filterBar.innerHTML =
      '<span class="chip on" data-tag="">全部</span>' +
      allTags.map((t) => `<span class="chip" data-tag="${t}"># ${t}</span>`).join("");
    filterBar.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      activeTag = chip.dataset.tag || null;
      filterBar.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === chip));
      render();
    });
  }
  render();
});
