"""Build a deterministic, public-only text index for the site's assistant.

Only published Markdown, public page headers, and the existing public
content manifests are read. Generated article HTML, admin settings, docs,
environment files, repository history and arbitrary linked files are not inputs.
"""
from datetime import date
from hashlib import sha256
from html import unescape
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import quote, unquote, urlsplit


PUBLIC_PAGES = (("home", "index.html", "/"), ("blog", "blog.html", "/blog.html"),
                ("says", "says.html", "/says.html"), ("photos", "photos.html", "/photos.html"),
                ("about", "about.html", "/about.html"))
BLOCKS = {"p", "div", "section", "article", "blockquote", "ul", "ol", "li", "pre",
          "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr", "table", "tr"}
HIDDEN = {"script", "style", "template", "noscript", "iframe", "object"}


def _public_file(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return path.is_file() and not path.is_symlink()
    except (OSError, ValueError):
        return False


def _read(path: Path, root: Path) -> str | None:
    return path.read_text(encoding="utf-8") if _public_file(path, root) else None


def _normalize(parts) -> str:
    lines = [re.sub(r"[^\S\n]+", " ", line).strip() for line in "".join(parts).splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _strip_noncontent(text: str) -> str:
    text = re.sub(r"<!--.*?(?:-->|$)", "", text, flags=re.S)
    return re.sub(r"<(script|style|template|noscript|iframe|object)\b[^>]*>.*?(?:</\1\s*>|$)",
                  "", text, flags=re.I | re.S)


class PlainArticle(HTMLParser):
    """Extract readable text and the same section boundaries as the renderer."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.sections = []
        self.heading = None
        self.hidden = 0

    def append(self, text):
        self.parts.append(text)
        if self.sections and not self.heading:
            self.sections[-1]["parts"].append(text)

    def handle_starttag(self, tag, attrs):
        if tag in HIDDEN:
            self.hidden += 1
        if self.hidden:
            return
        attrs = dict(attrs)
        if tag in {"h2", "h3"} and re.fullmatch(r"toc-\d+", attrs.get("id", "")):
            self.sections.append({"id": attrs["id"], "title": "", "parts": []})
            self.heading = tag
        if tag in BLOCKS:
            self.append("\n")
        if tag == "img" and attrs.get("alt"):
            self.append(attrs["alt"])

    def handle_endtag(self, tag):
        if tag in HIDDEN:
            self.hidden = max(0, self.hidden - 1)
            return
        if self.hidden:
            return
        if tag == self.heading:
            self.heading = None
        if tag in BLOCKS:
            self.append("\n")

    def handle_data(self, data):
        if self.hidden:
            return
        # Raw HTML inside Markdown is escaped by the renderer. Strip its tag
        # syntax as well, while retaining its visible words and code text.
        text = re.sub(r"</?[A-Za-z][^>]*>", "", data)
        self.append(text)
        if self.heading:
            self.sections[-1]["title"] += text

    def text(self):
        return _normalize(self.parts)


class PageHeader(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.description = ""
        self.title = []
        self.h1 = []
        self.in_title = False
        self.in_h1 = False
        self.found_h1 = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta" and attrs.get("name", "").lower() == "description":
            self.description = attrs.get("content", "")
        if tag == "title":
            self.in_title = True
        if tag == "h1" and not self.found_h1:
            self.in_h1 = True
            self.found_h1 = True

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag == "h1":
            self.in_h1 = False

    def handle_data(self, data):
        if self.in_title:
            self.title.append(data)
        if self.in_h1:
            self.h1.append(data)


def plain_text(value) -> str:
    parser = PlainArticle()
    parser.feed(_strip_noncontent(str(value or "")))
    parser.close()
    return parser.text()


def _manifest(root: Path, relative: str, key: str) -> list:
    raw = _read(root / relative, root)
    if raw is None:
        return []
    data = json.loads(raw)
    rows = data.get(key, []) if isinstance(data, dict) else []
    if not isinstance(rows, list):
        raise ValueError(f"{relative}: {key} must be an array")
    return [row for row in rows if isinstance(row, dict)]


def _stable_id(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()[:16]


def _is_draft(path: Path, meta: dict) -> bool:
    return (path.stem.startswith(("_", ".")) or
            str(meta.get("draft", "")).lower() in {"true", "yes", "1"} or
            str(meta.get("private", "")).lower() in {"true", "yes", "1"} or
            str(meta.get("published", "")).lower() in {"false", "no", "0"})


def build_knowledge(root: Path, site: dict, *, parse_front_matter, md_to_html) -> dict:
    root = Path(root)
    result = {"version": 1,
              "site": {"owner": plain_text(site.get("owner")), "name": plain_text(site.get("name")),
                       "description": plain_text(site.get("desc", site.get("description", "")))},
              "pages": [], "articles": [], "says": [], "photos": [], "playlist": []}

    for page_id, filename, url in PUBLIC_PAGES:
        raw = _read(root / filename, root)
        if raw is None:
            continue
        header = PageHeader()
        header.feed(_strip_noncontent(raw))
        result["pages"].append({"id": page_id, "title": plain_text("".join(header.h1 or header.title)),
                                "url": url, "summary": plain_text(header.description)})

    for source in sorted((root / "_posts").glob("*.md")):
        # Never open underscore/dot drafts, including in --drafts previews.
        if source.stem.startswith(("_", ".")):
            continue
        raw = _read(source, root)
        if raw is None:
            continue
        meta, body = parse_front_matter(raw)
        if _is_draft(source, meta):
            continue
        headings = []
        parsed = PlainArticle()
        # Decode escaped source HTML only inside this non-executing parser. Its
        # script/comment suppression preserves the renderer's original toc IDs,
        # including IDs after a comment containing something like `## hidden`.
        parsed.feed(unescape(md_to_html(body, headings=headings)))
        parsed.close()
        url = "/posts/" + quote(source.stem, safe="") + ".html"
        dated = meta.get("date", "")
        if not dated:
            match = re.search(r"\d{4}-\d{2}-\d{2}", body[:400])
            dated = match.group(0) if match else ""
        if dated:
            try:
                dated = date.fromisoformat(dated).isoformat()
            except ValueError as error:
                raise ValueError(f"_posts/{source.name}: invalid date {dated!r}") from error
        summary = plain_text(meta.get("summary")) or parsed.text().split("\n\n")[0][:160]
        sections = [{"id": section["id"], "title": plain_text(section["title"]),
                     "text": _normalize(section["parts"]), "url": url + "#" + section["id"]}
                    for section in parsed.sections]
        result["articles"].append({"id": source.stem, "slug": source.stem,
                                   "title": plain_text(meta.get("title") or source.stem),
                                   "date": dated, "tags": [plain_text(tag.strip()) for tag in meta.get("tags", "").split(",") if tag.strip()],
                                   "summary": summary, "url": url, "text": parsed.text(), "sections": sections})
    result["articles"].sort(key=lambda article: article["date"], reverse=True)

    for row in _manifest(root, "says/says.json", "says"):
        text, timestamp = plain_text(row.get("text")), str(row.get("time") or "")
        result["says"].append({"id": str(row.get("id") or _stable_id(timestamp + "\n" + text)),
                               "text": text, "time": timestamp, "url": "/says.html"})

    for row in _manifest(root, "assets/gallery/gallery.json", "photos"):
        value = str(row.get("src") or "")
        parts = urlsplit(value)
        path = unquote(parts.path).lstrip("/")
        # Only site-owned gallery files can become public image citations.
        if parts.scheme or parts.netloc or not path.startswith("assets/gallery/") or ".." in Path(path).parts or not _public_file(root / path, root):
            continue
        src = quote("/" + path, safe="/")
        result["photos"].append({"id": _stable_id(src), "caption": plain_text(row.get("caption")),
                                 "url": "/photos.html", "src": src})

    for row in _manifest(root, "data/playlist.json", "playlist"):
        result["playlist"].append({"id": str(row.get("id") or ""), "name": plain_text(row.get("name")),
                                   "artist": plain_text(row.get("artist"))})

    destination = root / "data" / "knowledge.json"
    if destination.is_symlink() or not destination.resolve().is_relative_to(root.resolve()):
        raise ValueError("Public knowledge output must stay inside the project")
    destination.parent.mkdir(parents=True, exist_ok=True)
    output = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if not destination.exists() or destination.read_text(encoding="utf-8") != output:
        destination.write_text(output, encoding="utf-8")
    print(f"  知识  data/knowledge.json（{len(result['articles'])} 篇文章，{len(result['photos'])} 张照片）")
    return result
