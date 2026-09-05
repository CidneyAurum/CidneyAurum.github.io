#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小窝内容构建器（纯标准库，无需安装任何依赖）

用法（在仓库根目录执行，或任意位置自动定位仓库根）：
    python tools/build.py            # 全部：文章 + 照片墙
    python tools/build.py posts      # 只构建文章
    python tools/build.py photos     # 只构建照片墙

发文：往 _posts/ 里放一个 Markdown 文件（如 my-first-note.md），
     头部用 --- 包一段信息（front-matter），构建后自动生成 posts/<文件名>.html
     并重建 posts/posts.json —— 手写 HTML 和手动登记都不需要了。

发图：把图片丢进 assets/gallery/ 即可（支持 jpg/png/webp/gif），
     构建时自动扫描生成 gallery.json，照片墙自动更新。
     文件名规则：`标题_2026-08.jpg` → 标题「泡面」、日期 2026-08；
                没有日期就用 MEMORY。
"""
import json
import os
import re
import sys
from datetime import date, datetime, timezone
from email.utils import format_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POSTS_SRC = ROOT / "_posts"
POSTS_OUT = ROOT / "posts"
GALLERY_DIR = ROOT / "assets" / "gallery"
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
BASE_URL = "https://cidneyaurum.github.io"  # ✏️ 换域名时改这里

SITE = {
    "name": "CidneyAurum の 小窝",
    "owner": "CidneyAurum",
    "motto": "直面过去，创造未来",
    "desc": "CidneyAurum 的数字小窝：博客、照片墙，还有 Limbus 风格歌词演出模拟器。",
}

# ---------------- Markdown → HTML（覆盖博客常用子集） ----------------

def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def inline(md: str) -> str:
    s = esc(md)
    s = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", r'<img src="\2" alt="\1" loading="lazy">', s)
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2" target="_blank" rel="noopener">\1</a>', s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    return s


def md_to_html(md: str, headings=None):
    """headings 传列表时，h2/h3 会带自增 id 并收集为 [{level,text,id}]"""
    out, lines = [], md.replace("\r\n", "\n").split("\n")
    i, in_code, code_buf, list_stack = 0, False, [], []
    while i < len(lines):
        line = lines[i]
        if line.strip().startswith("```"):
            if in_code:
                out.append("<pre><code>" + esc("\n".join(code_buf)) + "</code></pre>")
                code_buf, in_code = [], False
            else:
                close_lists()
                in_code = True
            i += 1
            continue
        if in_code:
            code_buf.append(line)
            i += 1
            continue

        def close_lists():
            while list_stack:
                out.append(f"</{'ol' if list_stack.pop() else 'ul'}>")

        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            close_lists()
            level = len(m.group(1))
            text = inline(m.group(2))
            if headings is not None and level in (2, 3):
                hid = f"toc-{len(headings) + 1}"
                headings.append({"level": level, "text": re.sub(r"<[^>]+>", "", text), "id": hid})
                out.append(f'<h{level} id="{hid}">{text}</h{level}>')
            else:
                out.append(f"<h{level}>{text}</h{level}>")
        elif re.match(r"^\s*[-*]\s+", line):
            if not list_stack or list_stack[-1]:
                close_lists()
                list_stack.append(False)
                out.append("<ul>")
            li_text = inline(re.sub(r"^\s*[-*]\s+", "", line))
            out.append(f"<li>{li_text}</li>")
        elif re.match(r"^\s*\d+[.)]\s+", line):
            if not list_stack or not list_stack[-1]:
                close_lists()
                list_stack.append(True)
                out.append("<ol>")
            li_text = inline(re.sub(r"^\s*\d+[.)]\s+", "", line))
            out.append(f"<li>{li_text}</li>")
        elif line.strip().startswith(">"):
            close_lists()
            out.append(f"<blockquote>{inline(line.strip().lstrip('> ').strip())}</blockquote>")
        elif re.match(r"^\s*(---+|\*\*\*+)\s*$", line):
            close_lists()
            out.append("<hr>")
        elif not line.strip():
            close_lists()
        else:
            close_lists()
            out.append(f"<p>{inline(line.strip())}</p>")
        i += 1
    if in_code and code_buf:
        out.append("<pre><code>" + esc("\n".join(code_buf)) + "</code></pre>")
    while list_stack:
        out.append(f"</{'ol' if list_stack.pop() else 'ul'}>")
    return "\n".join(out)


# ---------------- front-matter 解析 ----------------

def parse_front_matter(text: str):
    """返回 (meta dict, 正文)；没有 front-matter 时 meta 为空。"""
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            block, body = text[3:end].strip(), text[end + 4:].lstrip("\n")
            meta = {}
            for raw in block.split("\n"):
                if ":" not in raw:
                    continue
                k, v = raw.split(":", 1)
                meta[k.strip().lower()] = v.strip().strip('"').strip("'")
            return meta, body
    return {}, text


# ---------------- 文章构建 ----------------

POST_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title} · {site_name}</title>
  <meta name="description" content="{summary}">
  <link rel="icon" type="image/svg+xml" href="../assets/favicon.svg">
  <link rel="alternate" type="application/rss+xml" title="RSS 订阅" href="../feed.xml">
  <script defer src="https://events.vercount.one/js"></script>
  <link rel="preconnect" href="https://fonts.loli.net" crossorigin>
  <link href="https://fonts.loli.net/css2?family=Noto+Serif+SC:wght@400;700;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../css/style.css?v=23">
</head>
<body class="page-enter" data-page="post">
  <div class="read-progress" id="read-progress"></div>
  <div class="scene" aria-hidden="true">
    <img class="scene-bg" src="../assets/background-blur.webp" alt="">
    <div class="scene-overlay"></div>
    <div class="scene-grass"></div>
  </div>
  <canvas id="firefly-canvas" aria-hidden="true"></canvas>
  <button id="to-top" class="to-top" aria-label="返回顶部">✦</button>

  <nav class="nav">
    <a class="logo" href="../index.html">{owner}<span class="no">の</span>小窝</a>
    <div class="nav-links" id="nav-links">
      <a class="nav-link" href="../index.html">首页</a>
      <a class="nav-link active" href="../blog.html">归档</a>
      <a class="nav-link" href="../says.html">说说</a>
      <a class="nav-link" href="../photos.html">照片墙</a>
      <a class="nav-link" href="../limbus.html">歌词模拟器</a>
      <a class="nav-link" href="../about.html">关于</a>
      <a class="nav-link nav-post" href="../admin.html">✍️</a>
    </div>
    <div style="display:flex;align-items:center;gap:8px;">
      <button id="theme-toggle" class="icon-btn" aria-label="切换主题">✨</button>
      <button id="hamburger" class="icon-btn" aria-label="菜单">☰</button>
    </div>
  </nav>

  <div class="wrap article-layout">
    <article class="card article-card">
      <div class="article-cover">{cover}</div>
      <div class="article-inner">
        <a class="back-pill" href="../blog.html">« 返回上一级</a>
        <h1 class="article-title">《{title}》</h1>
        <div class="article-meta">
          <span>🗓 {date}</span>
          <span>{wordinfo}</span>
          <span>👁 <span class="vercount-page-pv">…</span> 次围观</span>
          {tags}
        </div>

        <div class="prose">
{content}
        </div>

        {postnav}
        <p class="article-end">— 谢谢你看到这里 ✧ —</p>
      </div>
    </article>

    <aside>
      {toc_html}
      <div class="card side-card side-profile">
        <div class="avatar-ring"><img src="../assets/avatar.webp" alt="头像"></div>
        <div class="side-name">{owner}</div>
        <p class="side-desc">一只喜欢写代码也喜欢看番的普通人类（大概）。</p>
        <div class="side-social">
          <a class="social-btn" href="https://github.com/CidneyAurum" target="_blank" rel="noopener" title="GitHub">🐙</a>
          <a class="social-btn" href="../feed.xml" title="RSS 订阅">📡</a>
        </div>
      </div>

      <div class="card side-card">
        <div class="side-label">NOW PLAYING</div>
        <div class="np-row">
          <img class="np-cover" src="../assets/background-blur.webp" alt="">
          <div class="np-info">
            <div class="np-title js-player-title">环境电台 · Ambient</div>
            <div class="np-sub">{motto}</div>
          </div>
          <button class="np-btn js-play-toggle js-state" aria-label="播放/暂停">▶</button>
        </div>
        <div class="np-bar"><div class="fill js-progress-fill"></div></div>
      </div>

      <div class="card side-card">
        <div class="side-label">RECORDS</div>
        <div id="side-records"><div class="side-record"><div class="d">加载中…</div></div></div>
      </div>
    </aside>
  </div>

  <footer>
    Made with <span class="heart">♡</span> &amp; 星光 · © 2026 {owner} · Powered by GitHub Pages
  </footer>

  <div class="mini-player">
    <img class="mini-cover" src="../assets/background-blur.webp" alt="">
    <div>
      <div class="mini-title js-player-title">环境电台 · Ambient</div>
      <div class="mini-sub">{motto}</div>
    </div>
    <button class="mini-btn js-play-toggle js-state" aria-label="播放/暂停">▶</button>
  </div>

  <script src="../js/main.js?v=23"></script>
  <script src="../js/player.js?v=23"></script>
  <script src="../js/music.js?v=23" defer></script>
  <script src="../js/kanban.js?v=23" defer></script>
</body>
</html>
"""


def count_words(md_text: str) -> int:
    """粗略字数：中文字符逐个算，英文单词算一个。"""
    text = re.sub(r"```.*?```", "", md_text, flags=re.S)
    text = re.sub(r"[*`>#\-\[\]()!]", "", text)
    cjk = len(re.findall(r"[\u4e00-\u9fff\u3040-\u30ff]", text))
    latin = len(re.findall(r"[A-Za-z0-9]+", text))
    return cjk + latin


def build_posts(include_drafts: bool = False) -> list:
    if not POSTS_SRC.exists():
        POSTS_SRC.mkdir(parents=True)
    POSTS_OUT.mkdir(parents=True, exist_ok=True)

    # 第一遍：解析所有 md
    parsed, skipped = [], []
    for md_file in sorted(POSTS_SRC.glob("*.md")):
        if md_file.stem.startswith("_"):
            (parsed if include_drafts else skipped).append(md_file)
            continue
        parsed.append(md_file)
    for f in skipped:
        print(f"  草稿  _posts/{f.name} 跳过（--drafts 可本地预览）")

    items = []
    for md_file in parsed:
        meta, body = parse_front_matter(md_file.read_text(encoding="utf-8"))
        slug = md_file.stem
        title = meta.get("title") or slug
        # 日期：front-matter 优先，否则取文件里第一个 2026-09-01 样式的日期，再否则用今天
        d = meta.get("date") or ""
        if not d:
            m = re.search(r"\d{4}-\d{2}-\d{2}", body[:400])
            d = m.group(0) if m else date.today().isoformat()
        tags = [t.strip() for t in (meta.get("tags") or "").split(",") if t.strip()]
        emoji = meta.get("emoji", "")
        summary = meta.get("summary", "")
        if not summary:
            # 摘要自动截取：正文第一段非标题文本的前 60 字
            for line in body.split("\n"):
                line = line.strip()
                if line and not line.startswith(("#", ">", "-", "*", "!", "```", "---")):
                    summary = re.sub(r"[*`!\[]\(.*?\)", "", line)[:60]
                    break
        cover = meta.get("cover", "")
        headings = []
        content = md_to_html(body, headings=headings)
        words = count_words(body)
        minutes = max(1, round(words / 400))
        items.append({
            "slug": slug, "title": title, "date": d, "tags": tags,
            "emoji": emoji, "cover": cover, "summary": summary,
            "content": content, "headings": headings,
            "wordinfo": f"📝 约 {words} 字 · {minutes} 分钟",
        })

    # 按日期降序，计算上一篇（更早）/下一篇（更新）
    items.sort(key=lambda e: e["date"], reverse=True)

    def nav_link(target, label):
        if not target:
            return '<span class="pn-cell pn-empty"><span class="pn-label">没有更多了</span></span>'
        href = target["slug"] + ".html"
        return (f'<a class="pn-cell" href="{href}"><span class="pn-label">{label}</span>'
                f'<span class="pn-title">{esc(target["title"])}</span></a>')

    entries, generated = [], []
    for i, it in enumerate(items):
        older = items[i + 1] if i + 1 < len(items) else None
        newer = items[i - 1] if i > 0 else None
        it["prev"], it["next"] = older, newer

        if cover := it["cover"]:
            src = cover if cover.startswith("http") else ("../" + cover.lstrip("./"))
            cover_html = f'<img class="coverall" src="{src}" alt="">'
        else:
            cover_html = f"<span>{it['emoji'] or '🪐'}</span>"
        tags_html = "".join(f'<span class="tag-mini"># {t}</span>' for t in it["tags"])

        # 目录卡片：标题 ≥ 2 个才生成
        toc_html = ""
        if len(it["headings"]) >= 2:
            toc_items = "".join(
                f'<a class="toc-l{h["level"]}" href="#{h["id"]}">{esc(h["text"])}</a>'
                for h in it["headings"]
            )
            toc_html = f'<div class="card side-card toc-card"><div class="side-label">CONTENTS</div><nav class="toc-list">{toc_items}</nav></div>'

        postnav = '<nav class="post-nav">' + nav_link(older, "← 上一篇") + nav_link(newer, "下一篇 →") + "</nav>"

        html = POST_TEMPLATE.format(
            title=esc(it["title"]), site_name=SITE["name"], owner=SITE["owner"],
            motto=SITE["motto"], summary=esc(it["summary"]), date=it["date"],
            tags=tags_html, cover=cover_html, content=it["content"],
            wordinfo=it["wordinfo"], toc_html=toc_html, postnav=postnav,
        )
        out_file = POSTS_OUT / f"{it['slug']}.html"
        out_file.write_text(html, encoding="utf-8")
        entries.append({k: it[k] for k in ("slug", "title", "date", "tags", "emoji", "cover", "summary")})
        generated.append(out_file.name)
        print(f"  文章  _posts/{it['slug']}.md  →  posts/{out_file.name}（{it['wordinfo'][2:]}）")

    # 清理：删掉已没有对应 _posts/*.md 的旧生成页
    keep = {"posts.json"} | set(generated)
    for old in POSTS_OUT.glob("*.html"):
        if old.name not in keep and not (POSTS_SRC / (old.stem + ".md")).exists():
            old.unlink()
            print(f"  清理  posts/{old.name}（没有对应的 _posts/{old.stem}.md）")

    (POSTS_OUT / "posts.json").write_text(
        json.dumps({"posts": entries}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"  目录  posts/posts.json（共 {len(entries)} 篇）")
    return entries


# ---------------- RSS / sitemap / robots ----------------

def build_meta_files(entries: list):
    now = format_datetime(datetime.now(timezone.utc))
    site = BASE_URL

    rss_items = []
    for e in entries[:20]:
        desc = esc(e.get("summary") or e["title"])
        rss_items.append(
            f"<item><title>{esc(e['title'])}</title>"
            f"<link>{site}/posts/{e['slug']}.html</link>"
            f"<guid>{site}/posts/{e['slug']}.html</guid>"
            f"<pubDate>{format_datetime(datetime.fromisoformat(e['date'] + 'T12:00:00+08:00'))}</pubDate>"
            f"<description>{desc}</description></item>")
    rss = ('<?xml version="1.0" encoding="UTF-8"?>'
           '<rss version="2.0"><channel>'
           f"<title>{esc(SITE['name'])}</title><link>{site}/</link>"
           f"<description>{esc(SITE['desc'])}</description><language>zh-CN</language>"
           f"<lastBuildDate>{now}</lastBuildDate>"
           + "".join(rss_items) + "</channel></rss>")
    (ROOT / "feed.xml").write_text(rss, encoding="utf-8")
    print("  RSS   feed.xml")

    urls = ["", "blog.html", "says.html", "photos.html", "about.html", "limbus.html"] + [
        f"posts/{e['slug']}.html" for e in entries
    ]
    sm_items = "".join(
        f"<url><loc>{site}/{u}</loc>"
        + (f"<lastmod>{entries[0]['date']}</lastmod>" if u.startswith("posts/") and entries else "")
        + "</url>"
        for u in urls
    )
    sm = ('<?xml version="1.0" encoding="UTF-8"?>'
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + sm_items + "</urlset>")
    (ROOT / "sitemap.xml").write_text(sm, encoding="utf-8")
    print("  SEO   sitemap.xml")

    robots = f"User-agent: *\nAllow: /\nSitemap: {site}/sitemap.xml\n"
    (ROOT / "robots.txt").write_text(robots, encoding="utf-8")
    print("  SEO   robots.txt")


# ---------------- 照片墙构建 ----------------

def build_photos() -> list:
    if not GALLERY_DIR.exists():
        GALLERY_DIR.mkdir(parents=True)
    # 没写日期的图片：优先用环境变量 PHOTO_DATE（CI 里=提交年月），本地则 MEMORY
    fallback_when = os.environ.get("PHOTO_DATE", "").strip() or "MEMORY"
    items = []
    for f in sorted(GALLERY_DIR.iterdir()):
        if f.suffix.lower() not in IMG_EXT:
            continue
        stem = f.stem
        m = re.search(r"_(\d{4})-(\d{1,2})", stem)
        when = f"{m.group(1)} · {int(m.group(2)):02d}" if m else fallback_when
        caption = re.sub(r"_?\d{4}-\d{1,2}$", "", stem) or "无题"
        items.append({"src": f"assets/gallery/{f.name}", "caption": caption, "when": when})
        print(f"  照片  {f.name}  →  「{caption}」 {when}")
    (GALLERY_DIR / "gallery.json").write_text(
        json.dumps({"photos": items}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"  目录  assets/gallery/gallery.json（共 {len(items)} 张）")
    return items


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a]
    include_drafts = "--drafts" in args
    target = next((a for a in args if not a.startswith("--")), "all")
    print(f"构建开始（{target}{'，含草稿' if include_drafts else ''}）")
    entries = []
    if target in ("all", "posts"):
        entries = build_posts(include_drafts=include_drafts)
    if target in ("all", "photos"):
        build_photos()
    if target in ("all", "posts") and not include_drafts:
        build_meta_files(entries)
    print("构建完成 ✧")
