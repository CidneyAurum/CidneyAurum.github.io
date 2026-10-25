"""Public assistant index tests; no API calls, secrets or model dependencies."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from tools import build


class KnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cidney-knowledge-")
        self.root = Path(self.temp.name)
        for folder in ("_posts", "data", "says", "assets/gallery", "docs"):
            (self.root / folder).mkdir(parents=True)
        self.stack = contextlib.ExitStack()
        self.stack.enter_context(patch.object(build, "ROOT", self.root))
        self.stack.enter_context(patch.object(build, "pygments_highlight", return_value=None))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.write_post("真实手记", "开头正文。\n\n## 真实段落\n实际内容。", summary="真实摘要")
        self.write_json("data/playlist.json", {"playlist": [{"id": "1", "name": "真实歌曲", "artist": "真实歌手",
                                                           "private_token": "PLAYLIST_EXTRA_FIELD"}]})
        self.write_json("says/says.json", {"says": [{"id": "public-say", "text": "<b>生活碎片</b>",
                                                    "time": "2026-10-25 10:00", "private_token": "SAYS_EXTRA_FIELD"}]})
        self.photo = self.root / "assets/gallery/真实照片_2026-10.jpg"
        self.photo.touch()
        self.write_json("assets/gallery/gallery.json", {"photos": [{"caption": "真实照片", "src": "assets/gallery/真实照片_2026-10.jpg"}]})
        self.write("index.html", '<meta name="description" content="公开首页摘要"><title>站点首页</title><h1>真实站主</h1><script>PAGE_SCRIPT_SENTINEL</script>')
        self.write("about.html", '<meta name="description" content="公开的关于页面"><h1>关于</h1><div>这里的技能和经历不自动推断进索引。</div>')
        self.write("admin.html", "ADMIN_SETTINGS_SENTINEL")
        self.write(".env", "ENV_FILE_SENTINEL")
        self.write("docs/internal.md", "PRIVATE_DOC_SENTINEL")

    def tearDown(self):
        self.stack.close()
        self.temp.cleanup()

    def write(self, relative, text):
        target = self.root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    def write_json(self, relative, data):
        self.write(relative, json.dumps(data, ensure_ascii=False))

    def write_post(self, slug, body, *, date="2026-10-25", summary="", flags=""):
        self.write(f"_posts/{slug}.md", f"---\ntitle: {slug}\ndate: {date}\ntags: 真实, 手记\nsummary: {summary}\n{flags}---\n{body}")

    def read_index(self):
        return json.loads((self.root / "data/knowledge.json").read_text(encoding="utf-8"))

    def test_contract_uses_only_real_public_content_and_selected_fields(self):
        result = build.build_knowledge()
        self.assertEqual(set(result), {"version", "site", "pages", "articles", "says", "photos", "playlist"})
        self.assertEqual(result["version"], 1)
        self.assertEqual(result["site"], {"owner": build.SITE["owner"], "name": build.SITE["name"],
                                         "description": build.SITE["desc"]})
        self.assertEqual([row["id"] for row in result["pages"]], ["home", "about"])
        self.assertEqual(result["pages"][0], {"id": "home", "title": "真实站主", "url": "/", "summary": "公开首页摘要"})
        self.assertEqual(len(result["articles"]), 1)
        article = result["articles"][0]
        self.assertEqual(set(article), {"id", "slug", "title", "date", "tags", "summary", "url", "text", "sections"})
        self.assertEqual(article["title"], "真实手记")
        self.assertEqual(article["summary"], "真实摘要")
        self.assertIn("开头正文", article["text"])
        self.assertEqual(result["says"], [{"id": "public-say", "text": "生活碎片", "time": "2026-10-25 10:00", "url": "/says.html"}])
        self.assertEqual(result["playlist"], [{"id": "1", "name": "真实歌曲", "artist": "真实歌手"}])
        self.assertEqual(result["photos"][0]["src"], "/assets/gallery/%E7%9C%9F%E5%AE%9E%E7%85%A7%E7%89%87_2026-10.jpg")
        self.assertEqual(result["photos"][0]["url"], "/photos.html")
        serialized = json.dumps(result, ensure_ascii=False)
        for forbidden in ("PAGE_SCRIPT_SENTINEL", "ADMIN_SETTINGS_SENTINEL", "ENV_FILE_SENTINEL",
                          "PRIVATE_DOC_SENTINEL", "PLAYLIST_EXTRA_FIELD", "SAYS_EXTRA_FIELD", str(self.root)):
            self.assertNotIn(forbidden, serialized)

    def test_drafts_private_files_and_generated_preview_are_not_read_or_indexed(self):
        self.write_post("_draft", "UNDERSCORE_DRAFT_SENTINEL")
        self.write_post(".hidden", "DOT_DRAFT_SENTINEL")
        self.write_post("draft-flag", "FLAG_DRAFT_SENTINEL", flags="draft: true\n")
        self.write_post("private-flag", "PRIVATE_POST_SENTINEL", flags="private: yes\n")
        self.write_post("unpublished", "UNPUBLISHED_SENTINEL", flags="published: false\n")
        self.write("posts/posts.json", '{"posts":[{"slug":"_draft","title":"STALE_PREVIEW_INDEX"}]}')
        self.write("posts/_draft.html", "GENERATED_DRAFT_SENTINEL")
        original_read = Path.read_text
        forbidden = {self.root / relative for relative in ("admin.html", ".env", "docs/internal.md",
                     "_posts/_draft.md", "_posts/.hidden.md", "posts/posts.json", "posts/_draft.html")}
        def guarded_read(path, *args, **kwargs):
            self.assertNotIn(path, forbidden, f"Private/non-source path was read: {path}")
            return original_read(path, *args, **kwargs)
        with patch.object(Path, "read_text", guarded_read):
            result = build.build_knowledge()
        self.assertEqual([row["slug"] for row in result["articles"]], ["真实手记"])
        self.assertNotIn("SENTINEL", json.dumps(result))

    def test_section_links_match_generated_toc_anchors_and_exclude_html_payloads(self):
        body = """开头 **加粗** 与 [标签](https://example.com)。
<!--
## COMMENT_SENTINEL
-->
<script>
## SCRIPT_SENTINEL
alert('DO_NOT_INDEX_SCRIPT');
</script>
## A & B
第一段：<strong>可读词语</strong>。
```markdown
## fenced heading stays code
```
### 第二段
- 列表内容
![图片说明](assets/image.png)
"""
        self.write_post("真实手记", body)
        result = build.build_knowledge()["articles"][0]
        headings = []
        html = build.md_to_html(body, headings=headings)
        self.assertEqual([row["title"] for row in result["sections"]], ["A & B", "第二段"])
        self.assertEqual([row["id"] for row in result["sections"]], ["toc-3", "toc-4"])
        for section in result["sections"]:
            self.assertIn('id="' + section["id"] + '"', html)
            self.assertEqual(section["url"], result["url"] + "#" + section["id"])
        self.assertIn("第一段：可读词语", result["sections"][0]["text"])
        self.assertIn("图片说明", result["sections"][1]["text"])
        self.assertIn("fenced heading stays code", result["text"])
        for forbidden in ("COMMENT_SENTINEL", "SCRIPT_SENTINEL", "DO_NOT_INDEX_SCRIPT", "<strong>", "<script>"):
            self.assertNotIn(forbidden, result["text"])
        self.assertTrue(result["url"].startswith("/posts/%E7%9C%9F"))

    def test_unchanged_sources_produce_identical_bytes_without_clock_or_mtime(self):
        self.write_post("undated", "没有日期也不编造日期。", date="")
        build.build_knowledge()
        first = (self.root / "data/knowledge.json").read_bytes()
        for path in (self.root / "_posts/真实手记.md", self.photo, self.root / "index.html"):
            os.utime(path, (1, 1))
        self.write(".env", "CHANGED_PRIVATE_SENTINEL")
        build.build_knowledge()
        self.assertEqual(first, (self.root / "data/knowledge.json").read_bytes())
        undated = next(row for row in self.read_index()["articles"] if row["slug"] == "undated")
        self.assertEqual(undated["date"], "")

    def test_edit_delete_and_manifest_changes_replace_stale_context(self):
        before = build.build_knowledge()
        photo_id = before["photos"][0]["id"]
        self.write_post("真实手记", "## 新段落\n已经编辑的新内容。", summary="新摘要")
        self.write_json("says/says.json", {"says": []})
        self.write_json("data/playlist.json", {"playlist": [{"id": "2", "name": "新歌", "artist": "新歌手"}]})
        after = build.build_knowledge()
        self.assertIn("已经编辑的新内容", after["articles"][0]["text"])
        self.assertNotIn("实际内容", after["articles"][0]["text"])
        self.assertEqual(after["articles"][0]["summary"], "新摘要")
        self.assertEqual(after["says"], [])
        self.assertEqual(after["playlist"][0]["name"], "新歌")
        self.assertEqual(after["photos"][0]["id"], photo_id)
        (self.root / "_posts/真实手记.md").unlink()
        self.assertEqual(build.build_knowledge()["articles"], [])

    def test_real_cli_builds_index_in_all_photo_only_and_draft_preview_modes(self):
        source_tools = Path(build.__file__).parent
        tools = self.root / "tools"
        tools.mkdir()
        for name in ("build.py", "build_knowledge.py"):
            shutil.copy2(source_tools / name, tools / name)
        self.write_post("_preview", "CLI_DRAFT_SENTINEL")
        def run(*args):
            completed = subprocess.run([sys.executable, str(tools / "build.py"), *args], cwd=self.root,
                                       capture_output=True, text=True, encoding="utf-8", timeout=30)
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            return self.read_index()
        first = run()
        self.assertEqual([row["slug"] for row in first["articles"]], ["真实手记"])
        preview = run("posts", "--drafts")
        self.assertTrue((self.root / "posts/_preview.html").exists())
        self.assertEqual([row["slug"] for row in preview["articles"]], ["真实手记"])
        self.write_post("真实手记", "照片构建时也读取最新文章。")
        (self.root / "assets/gallery/第二张_2026-10.png").touch()
        photos_only = run("photos")
        self.assertEqual(len(photos_only["photos"]), 2)
        self.assertIn("照片构建时也读取最新文章", photos_only["articles"][0]["text"])
        self.assertNotIn("CLI_DRAFT_SENTINEL", json.dumps(photos_only))


if __name__ == "__main__":
    unittest.main()
