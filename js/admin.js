/* ============================================
   写作台 · 站主专用发文发图工具（admin.html）
   - 发文：表单 + Markdown 实时预览 → 下载 .md 或一键发布（GitHub Contents API）
   - 发图：拖拽多图 → 自动命名（标题_年-月）→ 上传到 assets/gallery/
   - 令牌只保存在你自己浏览器的 localStorage，页面本身没有账号体系
   ============================================ */
"use strict";

const ADMIN = {
  repo: "CidneyAurum/CidneyAurum.github.io",
};

/* ---------- Markdown 渲染（与 tools/build.py 同一套子集） ---------- */
function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function mdInline(s) {
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  return s;
}

function mdToHtml(md) {
  const out = [];
  let inCode = false, codeBuf = [], listOpen = false;
  const closeList = () => { if (listOpen) { out.push("</ul>"); listOpen = false; } };
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim().startsWith("```")) {
      if (inCode) { out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>"); codeBuf = []; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!listOpen) { out.push("<ul>"); listOpen = true; }
      out.push(`<li>${mdInline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (line.trim().startsWith(">")) { closeList(); out.push(`<blockquote>${mdInline(line.trim().replace(/^>\s?/, ""))}</blockquote>`); continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { closeList(); out.push("<hr>"); continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${mdInline(line.trim())}</p>`);
  }
  if (inCode && codeBuf.length) out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>");
  closeList();
  return out.join("\n");
}

/* ---------- 小工具 ---------- */
const $ = (id) => document.getElementById(id);
const status = (msg, ok) => {
  document.querySelectorAll(".js-status").forEach((el) => {
    el.textContent = msg;
    el.style.color = ok === true ? "#4ade80" : ok === false ? "#ff7b7b" : "inherit";
  });
};
function today() { return new Date().toISOString().slice(0, 10); }
function ym() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function compact(d) { return d.replaceAll("-", ""); }

function autoSlug(title, d) {
  const ascii = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return ascii || `post-${compact(d)}`;
}

function buildMarkdown() {
  const title = $("p-title").value.trim() || "无题";
  const d = $("p-date").value || today();
  const tags = $("p-tags").value.trim();
  const emoji = $("p-emoji").value.trim();
  const summary = $("p-summary").value.trim();
  const lines = ["---", `title: ${title}`, `date: ${d}`];
  if (tags) lines.push(`tags: ${tags}`);
  if (emoji) lines.push(`emoji: ${emoji}`);
  if (summary) lines.push(`summary: ${summary}`);
  lines.push("---", "");
  const body = $("p-body").value;
  return { text: lines.join("\n") + "\n" + body, slug: $("p-slug").value.trim() || autoSlug(title, d), title };
}

/* ---------- GitHub API ---------- */
function getToken() { return (localStorage.getItem("gh_token") || "").trim(); }

async function ghApi(path, opts = {}) {
  const token = getToken();
  if (!token) throw new Error("还没有配置 GitHub 令牌，请先到「设置」页粘贴");
  const res = await fetch(`https://api.github.com/repos/${ADMIN.repo}/contents/${encodeURI(path)}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(opts.headers || {}),
    },
  });
  return res;
}

async function ghPutFile(path, bytes, message) {
  // 先查 sha（文件已存在时更新需要带上）
  let sha;
  const got = await ghApi(path);
  if (got.status === 200) sha = (await got.json()).sha;
  const body = JSON.stringify({ message, content: bytesToB64(bytes), ...(sha ? { sha } : {}) });
  const res = await ghApi(path, { method: "PUT", body });
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}：${(await res.text()).slice(0, 200)}`);
}

function bytesToB64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/* ---------- 发文页绑定 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  if (!$("p-body")) return; // 非写作台页面直接退出

  const dp = $("p-date");
  if (dp && !dp.value) dp.value = today();

  // 实时预览
  const refresh = () => { $("preview").innerHTML = mdToHtml($("p-body").value || "*（左边开始写，这里会实时预览）*"); };
  $("p-body").addEventListener("input", refresh);
  refresh();

  // 去 GitHub 发布（免令牌）：打开已预填内容的新建文件页
  $("btn-gh").addEventListener("click", () => {
    const md = buildMarkdown();
    if (!md.title || md.title === "无题") { status("先起个标题吧", false); return; }
    const url = "https://github.com/CidneyAurum/CidneyAurum.github.io/new/main"
      + "?filename=" + encodeURIComponent("_posts/" + md.slug + ".md")
      + "&value=" + encodeURIComponent(md.text);
    if (url.length > 60000) {
      status("正文太长，预填链接放不下，请用「下载 .md」后手动上传", false);
      return;
    }
    window.open(url, "_blank");
    status("已在 GitHub 打开预填页面 —— 拉到底点绿色 Commit changes 即完成发文 ✅", true);
  });

  // 复制 Markdown 全文
  $("btn-copy").addEventListener("click", async () => {
    const md = buildMarkdown();
    try {
      await navigator.clipboard.writeText(md.text);
      status("已复制全文，可粘贴到 GitHub 的 _posts/ 新建文件里", true);
    } catch (e) {
      status("复制失败：" + e.message, false);
    }
  });

  // 下载 .md
  $("btn-download").addEventListener("click", () => {
    const md = buildMarkdown();
    const blob = new Blob([md.text], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = md.slug + ".md";
    a.click();
    URL.revokeObjectURL(a.href);
    status(`已下载 ${md.slug}.md —— 把它上传到仓库的 _posts/ 文件夹即可发文`, true);
  });

  // 一键发布
  $("btn-publish").addEventListener("click", async () => {
    const md = buildMarkdown();
    if (!md.title || md.title === "无题") { status("先起个标题吧", false); return; }
    if (!$("p-body").value.trim()) { status("正文还是空的哦", false); return; }
    if (!getToken()) { status("还没有配置令牌，请到「设置」页粘贴一次", false); return; }
    status("发布中…");
    try {
      await ghPutFile(`_posts/${md.slug}.md`, new TextEncoder().encode(md.text), `发布文章：${md.title}`);
      status(`✅ 已发布 _posts/${md.slug}.md ！Actions 正在构建，约 1~2 分钟后线上可见`, true);
    } catch (err) {
      status("发布失败：" + err.message, false);
    }
  });

  /* ---------- 发图 ---------- */
  const drop = $("drop-zone");
  const input = $("img-input");
  const queue = []; // { file, caption }

  function addFiles(files) {
    for (const f of files) {
      if (!/^image\//.test(f.type)) continue;
      queue.push({ file: f, caption: f.name.replace(/\.[^.]+$/, "") });
    }
    renderQueue();
  }

  function renderQueue() {
    const box = $("img-queue");
    if (!queue.length) { box.innerHTML = '<p class="audio-state">还没有选择图片</p>'; return; }
    box.innerHTML = queue
      .map(
        (q, i) => `
      <div class="img-item">
        <img src="${URL.createObjectURL(q.file)}" alt="">
        <input type="text" value="${esc(q.caption)}" placeholder="图片标题" data-i="${i}">
        <span class="img-name">${esc(q.file.name)} → ${esc((q.caption || "img").replace(/[\\/:*?"<>|\s]/g, ""))}_${ym()}${q.file.type === "image/png" ? ".png" : ".jpg"}</span>
        <button class="ctrl-btn ghost" data-del="${i}">移除</button>
      </div>`
      )
      .join("");
    box.querySelectorAll("input").forEach((inp) =>
      inp.addEventListener("input", () => (queue[+inp.dataset.i].caption = inp.value)));
    box.querySelectorAll("[data-del]").forEach((btn) =>
      btn.addEventListener("click", () => { queue.splice(+btn.dataset.del, 1); renderQueue(); }));
  }

  drop.addEventListener("click", () => input.click());
  input.addEventListener("change", () => { addFiles(input.files); input.value = ""; });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    addFiles(e.dataTransfer.files);
  });

  $("btn-uploadpage").addEventListener("click", () => {
    window.open("https://github.com/CidneyAurum/CidneyAurum.github.io/upload/main/assets/gallery", "_blank");
    status("已打开 GitHub 上传页：把图片拖进去 → Commit，照片墙自动更新 ✅", true);
  });

  $("btn-upload").addEventListener("click", async () => {
    if (!queue.length) { status("先拖几张图进来吧", false); return; }
    if (!getToken()) { status("还没有配置令牌，请到「设置」页粘贴一次", false); return; }
    $("btn-upload").disabled = true;
    try {
      for (let i = 0; i < queue.length; i++) {
        const q = queue[i];
        status(`上传中（${i + 1}/${queue.length}）…`);
        const clean = (q.caption || q.file.name.replace(/\.[^.]+$/, "")).replace(/[\\/:*?"<>|\s]/g, "") || "img";
        const ext = q.file.type === "image/png" ? ".png" : q.file.type === "image/webp" ? ".webp" : q.file.type === "image/gif" ? ".gif" : ".jpg";
        const bytes = new Uint8Array(await q.file.arrayBuffer());
        await ghPutFile(`assets/gallery/${clean}_${ym()}${ext}`, bytes, `上传照片：${clean}`);
      }
      queue.length = 0;
      renderQueue();
      status("✅ 全部上传完成！Actions 正在重建照片墙，约 1~2 分钟后生效", true);
    } catch (err) {
      status("上传失败：" + err.message, false);
    } finally {
      $("btn-upload").disabled = false;
    }
  });

  /* ---------- 设置（令牌） ---------- */
  const tokenInput = $("token-input");
  tokenInput.value = getToken() ? "••••••••（已保存）" : "";
  $("btn-save-token").addEventListener("click", () => {
    const v = tokenInput.value.trim();
    if (!v || v === "••••••••（已保存）") { status("令牌没有变化", false); return; }
    localStorage.setItem("gh_token", v);
    tokenInput.value = "••••••••（已保存）";
    status("令牌已保存到本机浏览器", true);
  });
  $("btn-clear-token").addEventListener("click", () => {
    localStorage.removeItem("gh_token");
    tokenInput.value = "";
    status("令牌已清除", true);
  });
  $("btn-verify").addEventListener("click", async () => {
    if (!getToken()) { status("还没有令牌可验证", false); return; }
    status("验证中…");
    try {
      const res = await ghApi("");
      status(res.ok ? "✅ 令牌有效，可以发布内容" : `令牌无效或权限不足（${res.status}）`, res.ok);
    } catch (err) {
      status("验证失败：" + err.message, false);
    }
  });

  /* ---------- 标签页切换 ---------- */
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("on", b === btn));
      document.querySelectorAll(".tab-pane").forEach((p) => (p.style.display = p.id === "tab-" + btn.dataset.tab ? "" : "none"));
    });
  });
});
