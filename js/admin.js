/* 写作台：本地草稿、安全预览及串行 GitHub Contents 发布。 */
"use strict";

const ADMIN = {
  repo: "CidneyAurum/CidneyAurum.github.io", branch: "main",
  requestTimeout: 15000, pollDelay: 3000, maxPolls: 20,
};
const $ = (id) => document.getElementById(id);
const POST_FIELDS = ["p-title", "p-date", "p-slug", "p-tags", "p-emoji", "p-summary", "p-body"];
const DRAFT_KEY = "admin_draft_v1";
const escAdmin = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/* Match the build.py Markdown subset; render links from their eventual posts/ base. */
function decodeEntities(value) {
  if (typeof document !== "undefined" && document.createElement) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = value;
    return textarea.value;
  }
  return value.replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, n) => String.fromCodePoint(Math.min(0x10ffff, n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n))))
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}
function adminContentURL(raw, image = false) {
  const value = decodeEntities(String(raw)).trim();
  if (!value || /[\x00-\x20\x7f\\]/.test(value)) return null;
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && !(image ? ["http", "https"] : ["http", "https", "mailto"]).includes(scheme[1].toLowerCase())) return null;
  let path = value;
  if (!scheme && !value.startsWith("//")) {
    const split = value.search(/[?#]/);
    let pathname = split < 0 ? value : value.slice(0, split);
    const tail = split < 0 ? "" : value.slice(split);
    if (/^(assets|data|says)\//.test(pathname) || /^(index|blog|says|photos|limbus|about|admin)\.html$|^feed\.xml$/.test(pathname)) pathname = "../" + pathname;
    else if (pathname.startsWith("_posts/") && pathname.endsWith(".md")) pathname = pathname.slice(7, -3) + ".html";
    else if (pathname.endsWith(".md") && !pathname.startsWith("/") && !pathname.startsWith("../")) pathname = pathname.slice(0, -3) + ".html";
    path = pathname + tail;
  }
  try { return new URL(path, new URL("posts/", typeof location === "undefined" ? "https://cidneyaurum.github.io/" : location.href)).href; }
  catch (_) { return null; }
}
function mdInline(md) {
  const pattern = /(`+)([\s\S]*?)\1(?!`)|(!)?\[([^\]]*)\]\(((?:[^()]|\([^()]*\))*)\)|\*\*(.+?)\*\*|\*([^*]+)\*/g;
  let output = "", position = 0, match;
  while ((match = pattern.exec(md))) {
    output += escAdmin(md.slice(position, match.index));
    if (match[2] !== undefined) output += "<code>" + escAdmin(match[2].replace(/^ +| +$/g, "")) + "</code>";
    else if (match[4] !== undefined) {
      const url = adminContentURL(match[5], !!match[3]);
      output += !url ? escAdmin(match[4]) : match[3]
        ? `<img src="${escAdmin(url)}" alt="${escAdmin(match[4])}" loading="lazy" decoding="async">`
        : `<a href="${escAdmin(url)}" target="_blank" rel="noopener noreferrer">${mdInline(match[4])}</a>`;
    } else {
      const kind = match[6] !== undefined ? "strong" : "em";
      output += `<${kind}>${mdInline(match[6] !== undefined ? match[6] : match[7])}</${kind}>`;
    }
    position = pattern.lastIndex;
  }
  return output + escAdmin(md.slice(position));
}
function mdToHtml(md) {
  const out = [];
  let inCode = false, codeBuf = [], codeFence = "", codeLang = "", list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushCode = () => out.push(`<pre data-lang="${escAdmin(codeLang)}"><code>${escAdmin(codeBuf.join("\n"))}</code></pre>`);
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (inCode && fence[1][0] === codeFence[0] && fence[1].length >= codeFence.length && !fence[2].trim()) { flushCode(); codeBuf = []; inCode = false; }
      else if (!inCode) { closeList(); inCode = true; codeFence = fence[1]; codeLang = fence[2].trim().split(/\s+/)[0] || ""; }
      else codeBuf.push(line);
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`); }
    else if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (list !== kind) { closeList(); list = kind; out.push(`<${kind}>`); }
      out.push(`<li>${mdInline((ul || ol)[1])}</li>`);
    } else {
      closeList();
      if (line.trim().startsWith(">")) out.push(`<blockquote>${mdInline(line.trim().replace(/^[> ]+/, "").trim())}</blockquote>`);
      else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) out.push("<hr>");
      else if (line.trim()) out.push(`<p>${mdInline(line.trim())}</p>`);
    }
  }
  if (inCode) flushCode();
  closeList();
  return out.join("\n");
}

function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function ym() { return today().slice(0, 7); }
function autoSlug(title, date) { return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 100) || `post-${date.replaceAll("-", "")}`; }
function validatePost(post) {
  if (!post.title.trim()) throw new Error("请先填写文章标题");
  if (!post.body.trim()) throw new Error("正文不能为空");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(post.date) || !Number.isFinite(Date.parse(post.date)) || new Date(post.date).toISOString().slice(0, 10) !== post.date || post.date.startsWith("0000")) throw new Error("日期必须是有效的 YYYY-MM-DD 日期");
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,99}$/u.test(post.slug)) throw new Error("文件名请用 1–100 个字母、数字、中文、短横线或下划线，并以文字或数字开头；不用填写 .md");
  return post;
}
function buildMarkdown() {
  const post = Object.fromEntries(POST_FIELDS.map((id) => [id.slice(2), $(id).value]));
  post.title = post.title.trim(); post.date = post.date.trim(); post.slug = post.slug.trim() || autoSlug(post.title, post.date);
  validatePost(post);
  const lines = ["---", `title: ${JSON.stringify(post.title)}`, `date: ${post.date}`];
  for (const key of ["tags", "emoji", "summary"]) if (post[key].trim()) lines.push(`${key}: ${JSON.stringify(post[key].trim())}`);
  lines.push("---", "", post.body);
  return { ...post, text: lines.join("\n") };
}
function status(message, ok) {
  document.querySelectorAll(".js-status").forEach((el) => { el.textContent = message; el.style.color = ok === true ? "#4ade80" : ok === false ? "#ff7b7b" : "inherit"; });
}
function getToken() { try { return (localStorage.getItem("gh_token") || "").trim(); } catch (_) { return ""; } }
function bytesToB64(bytes) { let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); }
function decodeFile(file) {
  if (!file || file.type !== "file" || !file.sha || file.encoding !== "base64" || typeof file.content !== "string") throw new Error("GitHub 文件响应不完整，已停止写入");
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(file.content.replace(/\s/g, "")), c => c.charCodeAt(0)));
}
function ghErr(code, text) {
  let detail = "";
  try { detail = JSON.parse(text).message || ""; } catch (_) { detail = String(text || "").slice(0, 140); }
  return ({401:"令牌无效或已过期，请到设置更新",403:"访问被拒绝或请求受限，请检查令牌权限和 GitHub 配额",404:"文件或仓库不存在，或令牌没有访问权限",409:"文件已被其他操作修改，请重新读取后再试",422:"GitHub 未通过内容校验"}[code] || `GitHub 返回 ${code}`) + (detail ? "：" + detail.slice(0, 160) : "");
}
async function apiRequest(endpoint, opts = {}) {
  const { auth = true, ...fetchOpts } = opts;
  const token = auth ? getToken() : "";
  if (auth && !token) throw new Error("尚未配置 GitHub 令牌，请先到设置保存");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADMIN.requestTimeout);
  try {
    const response = await fetch(`https://api.github.com${endpoint}`, { ...fetchOpts, signal: controller.signal, cache: "no-store", redirect: "error", headers: { Accept:"application/vnd.github+json", "X-GitHub-Api-Version":"2022-11-28", ...(token ? {Authorization:`Bearer ${token}`} : {}), ...(fetchOpts.body ? {"Content-Type":"application/json"} : {}) } });
    const body = await response.text();
    return new Response([204,205,304].includes(response.status) ? null : body, {status:response.status,statusText:response.statusText,headers:response.headers});
  } catch (error) {
    throw new Error(controller.signal.aborted ? "GitHub 请求超时；若正在提交，请先检查仓库再重试，避免重复提交" : "无法连接 GitHub，请检查网络后重试");
  } finally { clearTimeout(timer); }
}
async function checkedJSON(response) {
  if (!response.ok) { const error = new Error(ghErr(response.status, await response.text())); error.status = response.status; throw error; }
  try { return await response.json(); } catch (_) { throw new Error("GitHub 返回了无法解析的响应，请检查仓库状态后再试"); }
}
const contentsPath = (path) => `/repos/${ADMIN.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
async function ghReadFile(path) {
  const response = await apiRequest(contentsPath(path) + "?ref=" + encodeURIComponent(ADMIN.branch));
  if (response.status === 404) return null;
  const file = await checkedJSON(response);
  if (Array.isArray(file) || file.type !== "file" || !file.sha) throw new Error("目标不是可更新的普通文件");
  return file;
}
async function ghPutFile(path, bytes, message, options = {}) {
  let sha = options.expectedSha;
  if (sha === undefined) {
    const existing = await ghReadFile(path);
    if (existing && options.createOnly) throw new Error(`同名文件 ${path} 已存在；请更换文件名，原文件未被覆盖`);
    sha = existing?.sha || null;
  }
  return checkedJSON(await apiRequest(contentsPath(path), { method:"PUT", body:JSON.stringify({ message, content:bytesToB64(bytes), branch:ADMIN.branch, ...(sha ? {sha} : {}) }) }));
}
async function tokenCheckupSteps() {
  const result = {ok:false,steps:[]};
  try {
    const me = await checkedJSON(await apiRequest("/user"));
    result.steps.push(["✓", "令牌可用，账号 " + me.login]);
    const repo = await checkedJSON(await apiRequest("/repos/" + ADMIN.repo));
    if (repo.permissions?.push === false) throw new Error("当前账号没有仓库写入权限");
    result.steps.push(["✓", "仓库可访问；令牌 Contents 写权限将在实际提交时验证"]);
    result.ok = true;
  } catch (error) { result.steps.push(["✗", error.message]); }
  return result;
}
async function trackBuild(sha) {
  if (!sha) return {ok:false,msg:"已提交，但提交编号缺失，部署状态未确认"};
  const base = "/repos/" + ADMIN.repo;
  for (let i = 0; i < ADMIN.maxPolls; i++) {
    if (i) await new Promise(resolve => setTimeout(resolve, ADMIN.pollDelay));
    try {
      const deployments = await checkedJSON(await apiRequest(`${base}/deployments?sha=${encodeURIComponent(sha)}&environment=github-pages&per_page=10`, {auth:false}));
      for (const deployment of deployments) {
        if (deployment.sha !== sha || deployment.environment !== "github-pages") continue;
        const states = await checkedJSON(await apiRequest(`${base}/deployments/${encodeURIComponent(deployment.id)}/statuses?per_page=1`, {auth:false}));
        if (states[0]?.state === "success") return {ok:true};
        if (["failure","error"].includes(states[0]?.state)) return {ok:false,msg:"Pages 部署失败，请到 Actions 查看日志"};
      }
      const runs = await checkedJSON(await apiRequest(`${base}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`, {auth:false}));
      const run = (runs.workflow_runs || []).find(r => r.head_sha === sha && r.path === ".github/workflows/build.yml" && r.event === "push");
      if (run?.status === "completed" && run.conclusion !== "success") return {ok:false,msg:`站点工作流结束：${run.conclusion}，尚未确认部署`};
    } catch (_) { /* Public deployment visibility may be unavailable. Never infer success. */ }
  }
  return {ok:false,msg:"部署尚未确认，可到 Actions 查看进度；请勿仅为重试部署而重复提交内容"};
}
async function announceCommit(put, label) {
  status(`${label}已提交，正在确认 Pages 部署…`);
  const result = await trackBuild(put?.commit?.sha);
  status(result.ok ? `✅ ${label}已部署到 GitHub Pages` : `${label}已提交；${result.msg}`, result.ok ? true : undefined);
}
function uniqueId() { return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID().replaceAll("-", "") : Date.now().toString(16) + Math.random().toString(16).slice(2, 12); }
function galleryFilename(caption, extension) {
  const clean = String(caption).normalize("NFC").replace(/[\\/:*?"<>|\s\x00-\x1f\x7f]/g, "").replace(/^\.+/, "").slice(0, 70) || "img";
  return `${clean}__upload-${uniqueId().slice(-10)}_${ym()}${extension}`;
}
async function compressImage(file, maxSide = 1920, quality = 0.75) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve,reject) => { img.onload=resolve; img.onerror=()=>reject(new Error("图片读取失败")); img.src=url; });
    const scale = Math.min(1,maxSide/Math.max(img.naturalWidth,img.naturalHeight));
    const canvas=document.createElement("canvas"); canvas.width=Math.max(1,Math.round(img.naturalWidth*scale)); canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
    canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);
    let blob;
    for (let q=quality; q>=0.29; q-=0.15) { blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",q)); if (blob && blob.size<=1024*1024) break; }
    if (!blob || blob.size>1024*1024) throw new Error("图片压缩后仍超过 1MB，请缩小后重试");
    return new Uint8Array(await blob.arrayBuffer());
  } finally { URL.revokeObjectURL(url); }
}
async function mergeSay(say) {
  const path="says/says.json";
  for (let attempt=0; attempt<3; attempt++) {
    const file=await ghReadFile(path);
    let current={says:[]};
    if (file) { try { current=JSON.parse(decodeFile(file)); } catch (error) { throw new Error("原说说列表无法解析，已停止写入以保护已有内容"); } }
    if (!current || !Array.isArray(current.says)) throw new Error("原说说列表格式不正确，已停止写入");
    if (current.says.some(item=>item.id===say.id)) return null;
    try { return await ghPutFile(path,new TextEncoder().encode(JSON.stringify({...current,says:[say,...current.says]},null,2)),"发布说说："+(say.text.slice(0,20)||"[图片]"),{expectedSha:file?.sha||null}); }
    catch (error) { if (error.status!==409 || attempt===2) throw error; }
  }
}

if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", () => {
  if (!$("p-body")) return;
  const queue=[], sQueue=[];
  let busy=false, pendingImages=0, draftFailed=false, pendingSay=null;
  const draftStatus=$("draft-status");
  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY,JSON.stringify({post:Object.fromEntries(POST_FIELDS.map(id=>[id,$(id).value])),say:$("s-text").value,pendingSay}));
      draftFailed=false;
      draftStatus.textContent="文字草稿已自动保存在此浏览器；图片需保持页面打开。";
    } catch (_) { draftFailed=true; draftStatus.textContent="浏览器未能保存草稿，请先下载或复制；离开页面会丢失修改。"; }
  }
  try {
    const saved=JSON.parse(localStorage.getItem(DRAFT_KEY)||"null");
    if (saved?.post) for (const id of POST_FIELDS) if (typeof saved.post[id]==="string") $(id).value=saved.post[id];
    if (typeof saved?.say==="string") $("s-text").value=saved.say;
    if (typeof saved?.pendingSay?.id==="string" && typeof saved.pendingSay.key==="string") pendingSay=saved.pendingSay;
  } catch (_) { draftStatus.textContent="本机草稿读取失败，请保留重要内容的副本。"; }
  if (!$("p-date").value) $("p-date").value=today();
  const refresh=()=>{$("preview").innerHTML=mdToHtml($("p-body").value||"*（左边开始写，这里会实时预览）*");};
  for (const id of POST_FIELDS) $(id).addEventListener("input",()=>{refresh();saveDraft();});
  $("s-text").addEventListener("input",()=>{updateSayCount();saveDraft();});
  refresh();
  window.addEventListener("beforeunload",event=>{ if (busy||pendingImages||queue.length||sQueue.length||draftFailed) {event.preventDefault();event.returnValue="";} });
  $("btn-clear-draft").addEventListener("click",()=>{
    if (!confirm("清空这台浏览器中的文章和说说文字草稿？")) return;
    for (const id of POST_FIELDS) $(id).value=id==="p-date"?today():"";
    $("s-text").value="";pendingSay=null; refresh();updateSayCount();saveDraft();status("文字草稿已清空；已选图片保持不变");
  });
  const jobButtons=["btn-publish","btn-upload","btn-say","btn-verify","btn-save-token","btn-clear-token","btn-clear-draft"];
  async function runJob(fn) {
    if (busy) return;
    busy=true; jobButtons.forEach(id=>$(id).disabled=true);
    try { await fn(); } catch(error) {status(error.message,false);}
    finally {busy=false;jobButtons.forEach(id=>$(id).disabled=false);$("btn-say").disabled=pendingImages>0;}
  }
  function postAction(fn) {return ()=>{try {fn(buildMarkdown());} catch(error) {status(error.message,false);}};}
  $("btn-gh").addEventListener("click",postAction(md=>{
    const url=`https://github.com/${ADMIN.repo}/new/${ADMIN.branch}?filename=${encodeURIComponent("_posts/"+md.slug+".md")}&value=${encodeURIComponent(md.text)}`;
    if (url.length>12000) throw new Error("正文较长，请下载 .md 后上传到 GitHub");
    window.open(url,"_blank","noopener,noreferrer");
    status("已请求打开 GitHub 预填页面；提交后仍需等待并确认 Pages 部署。");
  }));
  $("btn-copy").addEventListener("click",async()=>{try {const md=buildMarkdown();await navigator.clipboard.writeText(md.text);status("Markdown 全文已复制",true);} catch(error) {status("复制失败："+error.message,false);}});
  $("btn-download").addEventListener("click",postAction(md=>{
    const url=URL.createObjectURL(new Blob([md.text],{type:"text/markdown;charset=utf-8"}));
    const a=document.createElement("a");a.href=url;a.download=md.slug+".md";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    status(`已下载 ${md.slug}.md；上传到 _posts/ 后还需等待 Pages 部署`,true);
  }));
  $("btn-publish").addEventListener("click",()=>runJob(async()=>{
    const md=buildMarkdown();
    if (!getToken()) throw new Error("请先在设置保存 GitHub 令牌");
    status("正在提交文章；同名文件将停止写入…");
    const put=await ghPutFile(`_posts/${md.slug}.md`,new TextEncoder().encode(md.text),`发布文章：${md.title}`,{createOnly:true});
    saveDraft();await announceCommit(put,"文章");
  }));
  const extensions={"image/jpeg":".jpg","image/png":".png","image/webp":".webp","image/gif":".gif"};
  function acceptImage(file) {
    if (!extensions[file.type]) throw new Error("仅支持 JPG、PNG、WebP 和 GIF 图片");
    if (file.size>20*1024*1024) throw new Error("单张图片不能超过 20MB");
  }
  function renderQueue() {
    const box=$("img-queue");box.replaceChildren();
    if (!queue.length) {const p=document.createElement("p");p.className="audio-state";p.textContent="还没有选择图片";box.appendChild(p);return;}
    queue.forEach((q,i)=>{
      const item=document.createElement("div");item.className="img-item";
      const img=document.createElement("img");img.src=q.url;img.alt=q.file.name;
      const field=document.createElement("input");field.value=q.caption;field.placeholder="图片标题";field.setAttribute("aria-label","图片标题 "+(i+1));
      field.addEventListener("input",()=>{q.caption=field.value;});
      const name=document.createElement("span");name.className="img-name";name.textContent=q.file.name;
      const remove=document.createElement("button");remove.className="ctrl-btn ghost";remove.textContent="移除";remove.addEventListener("click",()=>{if(busy)return;URL.revokeObjectURL(q.url);queue.splice(queue.indexOf(q),1);renderQueue();});
      item.append(img,field,name,remove);box.appendChild(item);
    });
  }
  function addFiles(files) {if(busy)return;for(const file of files){try {acceptImage(file);queue.push({file,caption:file.name.replace(/\.[^.]+$/,""),url:URL.createObjectURL(file)});}catch(error){status(error.message,false);}}renderQueue();}
  $("drop-zone").addEventListener("click",()=>$("img-input").click());
  $("drop-zone").addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();$("img-input").click();}});
  $("img-input").addEventListener("change",()=>{addFiles($("img-input").files);$("img-input").value="";});
  const drop=$("drop-zone");
  drop.addEventListener("dragover",event=>{event.preventDefault();drop.classList.add("drag");});drop.addEventListener("dragleave",()=>drop.classList.remove("drag"));
  drop.addEventListener("drop",event=>{event.preventDefault();drop.classList.remove("drag");addFiles(event.dataTransfer.files);});
  $("btn-uploadpage").addEventListener("click",()=>{window.open(`https://github.com/${ADMIN.repo}/upload/${ADMIN.branch}/assets/gallery`,"_blank","noopener,noreferrer");status("已请求打开 GitHub 上传页；完成提交后请确认 Pages 部署。");});
  $("btn-upload").addEventListener("click",()=>runJob(async()=>{
    if(!queue.length)throw new Error("请先选择图片");
    let put, uploaded=0;
    while(queue.length){const q=queue[0];status(`正在上传照片 ${++uploaded}…`);q.path ||= "assets/gallery/"+galleryFilename(q.caption,extensions[q.file.type]);put=await ghPutFile(q.path,new Uint8Array(await q.file.arrayBuffer()),"上传照片："+q.caption,{createOnly:true});URL.revokeObjectURL(q.url);queue.shift();renderQueue();}
    await announceCommit(put,"照片");
  }));
  const tokenInput=$("token-input");
  const maskToken=()=>{tokenInput.value="";tokenInput.placeholder=getToken()?"已保存令牌；输入新令牌可替换":"github_pat_… 或 ghp_…";};
  maskToken();
  $("btn-save-token").addEventListener("click",()=>{try {const value=tokenInput.value.trim();if(!value||/\s/.test(value))throw new Error("请输入完整令牌，不包含空格或换行");localStorage.setItem("gh_token",value);maskToken();status("令牌已保存到本机浏览器",true);}catch(error){status("保存失败："+error.message,false);}});
  $("btn-clear-token").addEventListener("click",()=>{try {localStorage.removeItem("gh_token");maskToken();status("令牌已清除",true);}catch(error){status("清除失败："+error.message,false);}});
  $("btn-verify").addEventListener("click",()=>runJob(async()=>{status("正在验证令牌与仓库访问…");const result=await tokenCheckupSteps();status(result.steps.map(step=>step[1]).join(" → "),result.ok);}));
  function updateSayCount() {const n=Array.from($("s-text").value).length;$("s-count").textContent=n+" / 500";$("s-count").style.color=n>500?"#ff7b7b":"var(--text-light)";}
  updateSayCount();
  function renderSayPreviews() {
    const box=$("s-previews");box.replaceChildren();
    sQueue.filter(q=>q.url).forEach((q,i)=>{const item=document.createElement("div");item.className="say-preview";const img=document.createElement("img");img.src=q.url;img.alt=q.name;const remove=document.createElement("button");remove.className="ds-close";remove.textContent="✕";remove.setAttribute("aria-label","移除说说图片 "+(i+1));remove.addEventListener("click",()=>{if(busy)return;URL.revokeObjectURL(q.url);sQueue.splice(sQueue.indexOf(q),1);renderSayPreviews();});item.append(img,remove);box.appendChild(item);});
  }
  async function addSayImages(files) {
    if(busy)return;
    for(const file of files){
      if(sQueue.length>=9){status("说说最多选择 9 张图片",false);break;}
      try {acceptImage(file);}catch(error){status(error.message,false);continue;}
      pendingImages++;$("btn-say").disabled=true;
      const entry={name:file.name};sQueue.push(entry);
      compressImage(file).then(bytes=>{Object.assign(entry,{bytes,url:URL.createObjectURL(new Blob([bytes],{type:"image/jpeg"}))});renderSayPreviews();}).catch(error=>{sQueue.splice(sQueue.indexOf(entry),1);status("图片处理失败："+error.message,false);}).finally(()=>{pendingImages--;$("btn-say").disabled=busy||pendingImages>0;});
    }
  }
  $("s-imgs").addEventListener("change",()=>{addSayImages($("s-imgs").files);$("s-imgs").value="";});
  $("btn-say").addEventListener("click",()=>runJob(async()=>{
    const text=$("s-text").value.trim();
    if(pendingImages)throw new Error("图片仍在处理中，请稍候");
    if(!text&&!sQueue.length)throw new Error("请填写说说文字或选择图片");
    if(Array.from(text).length>500)throw new Error("说说文字不能超过 500 字");
    if(!getToken())throw new Error("请先在设置保存 GitHub 令牌");
    const now=new Date(), images=[];
    for(let i=0;i<sQueue.length;i++){const q=sQueue[i];if(!q.remote){q.path ||= `assets/says/say_${uniqueId()}.jpg`;status(`正在上传说说配图 ${i+1}/${sQueue.length}…`);await ghPutFile(q.path,q.bytes,"上传说说配图",{createOnly:true});q.remote=q.path;}images.push(q.remote);}
    const key=JSON.stringify({text,images});
    if(pendingSay?.key!==key)pendingSay={id:uniqueId(),key};
    saveDraft();
    const say={id:pendingSay.id,text,images,time:today()+" "+String(now.getHours()).padStart(2,"0")+":"+String(now.getMinutes()).padStart(2,"0")};
    status("正在合并并提交说说列表…");
    const put=await mergeSay(say);
    if($("s-text").value.trim()===text)$("s-text").value="";
    pendingSay=null;sQueue.forEach(q=>URL.revokeObjectURL(q.url));sQueue.length=0;renderSayPreviews();updateSayCount();saveDraft();
    await announceCommit(put,"说说");
  }));
  function activateTab(name){if(!["post","say","photo","setup"].includes(name))return;document.querySelectorAll(".tab-btn").forEach(button=>button.classList.toggle("on",button.dataset.tab===name));document.querySelectorAll(".tab-pane").forEach(pane=>pane.style.display=pane.id==="tab-"+name?"":"none");}
  document.querySelectorAll(".tab-btn").forEach(button=>button.addEventListener("click",()=>activateTab(button.dataset.tab)));
  activateTab(new URLSearchParams(location.search).get("tab")||"post");
});

if (typeof module !== "undefined" && module.exports) module.exports={ADMIN,escAdmin,mdInline,mdToHtml,adminContentURL,validatePost,autoSlug,buildMarkdown,ghErr,apiRequest,checkedJSON,ghReadFile,ghPutFile,mergeSay,trackBuild,bytesToB64,galleryFilename,decodeFile};
