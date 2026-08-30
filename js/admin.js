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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(ghErr(res.status, text));
  }
  return await res.json();
}

/* 图片压缩：长边 ≤1920、JPEG、目标 ≤1MB */
async function compressImage(file, maxSide = 1920, quality = 0.75) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("图片读取失败")); img.src = url; });
  let w = img.naturalWidth, h = img.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(url);
  let q = quality;
  let blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", q));
  while (blob && blob.size > 1024 * 1024 && q > 0.35) {
    q -= 0.15;
    blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", q));
  }
  if (!blob) throw new Error("图片压缩失败");
  return new Uint8Array(await blob.arrayBuffer());
}

/* GitHub 错误 → 中文原因 */
function ghErr(status, text) {
  const map = {
    401: "令牌无效或已过期 → 到「设置」重新粘贴一个新令牌",
    403: "权限不足 → 令牌需要 Contents: Read and write 权限",
    404: "仓库不存在或令牌无权访问该仓库",
    422: "内容校验失败：" + (text || "").slice(0, 140),
  };
  return map[status] || ("GitHub " + status + "：" + (text || "").slice(0, 140));
}

/* 令牌完整体检：有效性 → 仓库 → 写权限 */
async function tokenCheckupSteps() {
  const out = { ok: false, steps: [] };
  const H = { Authorization: "Bearer " + getToken(), Accept: "application/vnd.github+json" };
  try {
    const me = await fetch("https://api.github.com/user", { headers: H });
    if (me.status === 401) { out.steps.push(["✗", "令牌无效或已过期"]); return out; }
    if (!me.ok) { out.steps.push(["✗", "GitHub 返回 " + me.status]); return out; }
    out.steps.push(["✓", "令牌有效，账号 " + (await me.json()).login]);
    const repo = await fetch("https://api.github.com/repos/" + ADMIN.repo, { headers: H });
    if (!repo.ok) { out.steps.push(["✗", "无法访问仓库（" + repo.status + "）"]); return out; }
    const perm = (await repo.json()).permissions || {};
    out.steps.push(perm.push ? ["✓", "仓库访问正常，有写入权限"] : ["✗", "缺少写入权限：请给令牌加 Contents: Read and write"]);
    out.ok = !!perm.push;
    return out;
  } catch (e) {
    out.steps.push(["✗", "网络错误：" + e.message]);
    return out;
  }
}

/* 发布后追踪 Actions 构建：成功返回 true */
async function trackBuild(sha) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 6000));
    try {
      const res = await fetch("https://api.github.com/repos/" + ADMIN.repo + "/actions/runs?head_sha=" + sha + "&per_page=1", {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) continue;
      const run = ((await res.json()).workflow_runs || [])[0];
      if (!run) continue;
      if (run.status === "completed") {
        if (run.conclusion === "success") return { ok: true, url: run.html_url };
        return { ok: false, msg: "构建失败（" + run.conclusion + "）" };
      }
    } catch (e) { /* 网络抖动继续轮询 */ }
  }
  return { ok: false, msg: "构建超时（超过 4 分钟），可到 Actions 页查看进度" };
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

  // 一键发布（状态机：校验→上传→构建追踪）
  $("btn-publish").addEventListener("click", async () => {
    const md = buildMarkdown();
    if (!md.title || md.title === "无题") { status("先起个标题吧", false); return; }
    if (!$("p-body").value.trim()) { status("正文还是空的哦", false); return; }
    if (!getToken()) { status("还没有配置令牌，请到「设置」页粘贴一次", false); return; }
    const btn = $("btn-publish");
    btn.disabled = true;
    try {
      status("① 校验令牌与权限…");
      const chk = await tokenCheckupSteps();
      const bad = chk.steps.find((x) => x[0] === "✗");
      if (bad) { status("✗ " + bad[1], false); return; }
      status("② 上传文章 _posts/" + md.slug + ".md …");
      const put = await ghPutFile(`_posts/${md.slug}.md`, new TextEncoder().encode(md.text), `发布文章：${md.title}`);
      const sha = put && put.commit && put.commit.sha ? put.commit.sha : "";
      status("③ 文章已提交，等待构建上线…");
      if (sha) {
        const track = await trackBuild(sha);
        if (track.ok) status("✅ 已上线！访问 cidneyaurum.github.io 查看", true);
        else status("⚠️ 提交成功但构建未确认：" + track.msg, false);
      } else {
        status("✅ 已提交，约 1~2 分钟后上线", true);
      }
    } catch (err) {
      status("✗ 发布失败：" + err.message, false);
    } finally {
      btn.disabled = false;
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
    status("体检中：令牌 → 仓库 → 写权限…");
    const r = await tokenCheckupSteps();
    r.steps.forEach((s) => console.log(s.join(" ")));
    status(r.steps.map((x) => x[1]).join(" → "), r.ok);
  });

  /* ---------- 说说：选图压缩预览 + 一键发布 ---------- */
  const sText = $("s-text");
  const sImgs = $("s-imgs");
  const sPreviews = $("s-previews");
  const sCount = $("s-count");
  const sQueue = []; // {bytes, url}

  if (sText) {
    sText.addEventListener("input", () => {
      const n = sText.value.length;
      sCount.textContent = n + " / 500";
      sCount.style.color = n > 500 ? "#ff7b7b" : "var(--text-light)";
    });
  }

  function addSayImages(files) {
    for (const f of files) {
      if (!/^image\//.test(f.type)) continue;
      compressImage(f)
        .then((bytes) => {
          sQueue.push({ bytes, name: f.name });
          renderSayPreviews();
        })
        .catch((e) => status("图片处理失败：" + e.message, false));
    }
  }

  function renderSayPreviews() {
    sPreviews.innerHTML = sQueue
      .map(
        (q, i) => `
      <div style="position:relative;">
        <img src="${q.url}" style="width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid var(--border);">
        <button class="ds-close" data-i="${i}" style="position:absolute;top:-6px;right:-6px;background:var(--card-deep);border-radius:50%;width:20px;height:20px;">✕</button>
      </div>`
      )
      .join("");
    sPreviews.querySelectorAll("[data-i]").forEach((b) =>
      b.addEventListener("click", () => { sQueue.splice(+b.dataset.i, 1); renderSayPreviews(); }));
  }

  if (sImgs) {
    sImgs.addEventListener("change", () => { addSayImages(sImgs.files); sImgs.value = ""; });
    const dz = $("s-drop");
    if (dz) {
      dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
      dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
      dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("drag"); addSayImages(e.dataTransfer.files); });
    }
  }

  const btnSay = $("btn-say");
  if (btnSay) {
    btnSay.addEventListener("click", async () => {
      const text = sText.value.trim();
      if (!text && !sQueue.length) { status("写点什么或选张图吧", false); return; }
      if (text.length > 500) { status("文字超过 500 字了", false); return; }
      if (!getToken()) { status("还没有配置令牌，请到「设置」页粘贴一次", false); return; }
      btnSay.disabled = true;
      try {
        const now = new Date();
        const pad = (x) => String(x).padStart(2, "0");
        const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const images = [];
        for (let i = 0; i < sQueue.length; i++) {
          status(`上传图片（${i + 1}/${sQueue.length}）…`);
          const name = `say_${now.getTime()}_${i}.jpg`;
          await ghPutFile(`assets/says/${name}`, sQueue[i].bytes, "发布说说配图");
          images.push("assets/says/" + name);
        }
        status("更新说说列表…");
        let oldSays = [];
        try {
          const r = await ghApi("says/says.json");
          if (r.ok) {
            const b64 = (await r.json()).content.replace(/\s/g, "");
            oldSays = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).says || [];
          }
        } catch (e) { /* 文件不存在则新建 */ }
        const say = { id: now.getTime().toString(36), text, images, time };
        const payload = JSON.stringify({ says: [say, ...oldSays] }, null, 2);
        await ghPutFile("says/says.json", new TextEncoder().encode(payload), "发布说说：" + (text.slice(0, 20) || "[图片]"));
        sText.value = "";
        sQueue.length = 0;
        renderSayPreviews();
        status("✅ 说说已发布！构建完成后在「说说」页面可见", true);
      } catch (err) {
        status("✗ 发布失败：" + err.message, false);
      } finally {
        btnSay.disabled = false;
      }
    });
  }

  /* ---------- 标签页切换 ---------- */
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("on", b === btn));
      document.querySelectorAll(".tab-pane").forEach((p) => (p.style.display = p.id === "tab-" + btn.dataset.tab ? "" : "none"));
    });
  });
});
