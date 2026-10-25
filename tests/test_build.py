"""Regression coverage for content that previously broke publishing or escaped HTML."""
import contextlib
import io
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import xml.etree.ElementTree as ET

from tools import build
from tools.prepare_site import prepare_site


class MarkdownTests(unittest.TestCase):
    def test_editor_json_metadata_preserves_quotes_escapes_and_field_boundaries(self):
        title = '\"引号\"与冒号: \\ path'
        summary = '第一行\n---\n第二行: 不应成为新字段'
        source = '\n'.join(['---', 'title: ' + json.dumps(title, ensure_ascii=False),
                            'summary: ' + json.dumps(summary, ensure_ascii=False),
                            'date: 2026-10-25', '---', '正文'])
        meta, body = build.parse_front_matter(source)
        self.assertEqual(meta['title'], title)
        self.assertEqual(meta['summary'], summary)
        self.assertEqual(meta['date'], '2026-10-25')
        self.assertEqual(body, '正文')

    def test_front_matter_removes_only_matching_outer_quotes(self):
        for value, expected in [("'\"inside\"'", '\"inside\"'), ('\"\'inside\'\"', "'inside'"),
                                ('an unmatched \"', 'an unmatched \"'), ("'single'", 'single')]:
            with self.subTest(value=value):
                metadata, _ = build.parse_front_matter('---\ntitle: ' + value + '\n---\nbody')
                self.assertEqual(metadata['title'], expected)

    def test_fence_at_start_preserves_language_and_code(self):
        with patch.object(build, "pygments_highlight", return_value=None) as highlight:
            result = build.md_to_html('```python\nprint("<tag>")\n```')
        highlight.assert_called_once_with('print("<tag>")', "python")
        self.assertIn('data-lang="python"', result)
        self.assertIn('&lt;tag&gt;', result)

    def test_long_and_unterminated_fences_keep_content(self):
        with patch.object(build, "pygments_highlight", return_value=None):
            result = build.md_to_html("````markdown\n```python\nx\n```\n````")
            unclosed = build.md_to_html("~~~js\nconst x = 1;")
            empty = build.md_to_html("```text")
        self.assertIn("```python\nx\n```", result)
        self.assertIn('data-lang="js"', unclosed)
        self.assertIn("const x = 1;", unclosed)
        self.assertIn("<code></code>", empty)

    def test_inline_code_is_not_parsed_as_links_or_emphasis(self):
        result = build.inline('`[link](https://example.com) **literal**` and **bold**')
        self.assertIn('<code>[link](https://example.com) **literal**</code>', result)
        self.assertEqual(result.count("<a "), 0)
        self.assertIn("<strong>bold</strong>", result)

    def test_untrusted_urls_and_attributes_cannot_create_handlers(self):
        for value in ("javascript:alert(1)", "java&#x73;cript:alert(1)", "data:text/html,test", "java\tscript:alert(1)"):
            with self.subTest(value=value):
                result = build.inline(f"[go]({value}) ![image]({value})")
                self.assertNotIn("<a ", result)
                self.assertNotIn("<img ", result)
        result = build.inline('![a"b](https://example.com/a"b.png)')
        self.assertIn('alt="a&quot;b"', result)
        self.assertIn('src="https://example.com/a&quot;b.png"', result)

    def test_article_links_resolve_from_generated_posts_directory(self):
        result = build.inline('[写作台](admin.html) ![图](assets/pic.png) [同篇](hello.md#part) [章节](#part)')
        self.assertIn('href="../admin.html"', result)
        self.assertIn('src="../assets/pic.png"', result)
        self.assertIn('href="hello.html#part"', result)
        self.assertIn('href="#part"', result)
        self.assertNotIn('target="_blank"', result)

    def test_bom_front_matter_and_heading_entities(self):
        metadata, body = build.parse_front_matter('\ufeff---\r\ntitle: 测试\r\n---\r\n## A & B')
        headings = []
        build.md_to_html(body, headings)
        self.assertEqual(metadata["title"], "测试")
        self.assertEqual(headings[0]["text"], "A & B")


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cidney-build-test-")
        self.root = Path(self.temp.name)
        self.source = self.root / "_posts"
        self.output = self.root / "posts"
        self.source.mkdir()
        self.stack = contextlib.ExitStack()
        self.stack.enter_context(patch.multiple(build, ROOT=self.root, POSTS_SRC=self.source, POSTS_OUT=self.output))
        self.stack.enter_context(patch.object(build, "pygments_css", return_value=""))
        self.stack.enter_context(patch.object(build, "pygments_highlight", return_value=None))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def tearDown(self):
        self.stack.close()
        self.temp.cleanup()

    def write_post(self, slug="post", date="2026-08-29", title='A "quote" & </script><script>alert(1)</script>'):
        (self.source / f"{slug}.md").write_text(
            f'---\ntitle: {title}\ndate: {date}\ntags: <tag>, code\nsummary: A "summary" & detail\n---\n## One\nBody.\n## Two\nMore.', encoding="utf-8"
        )

    def test_generated_json_ld_is_valid_and_cannot_close_script(self):
        self.write_post()
        entries = build.build_posts()
        document = (self.output / "post.html").read_text(encoding="utf-8")
        script = re.search(r'<script type="application/ld\+json">(.*?)</script>', document, re.S).group(1)
        data = json.loads(script)
        self.assertEqual(data["headline"], entries[0]["title"])
        self.assertNotIn("</script>", script)
        self.assertIn("&lt;tag&gt;", document)
        self.assertIn('rel="canonical"', document)
        self.assertIn('<main class="wrap article-layout" id="main-content"', document)
        self.assertNotIn('<script>alert(1)</script>', document)

    def test_production_build_removes_previously_previewed_draft(self):
        self.write_post("_draft")
        build.build_posts(include_drafts=True)
        self.assertTrue((self.output / "_draft.html").exists())
        entries = build.build_posts()
        self.assertFalse((self.output / "_draft.html").exists())
        self.assertEqual(entries, [])

    def test_invalid_date_fails_with_source_file(self):
        self.write_post(date="2026-02-30")
        with self.assertRaisesRegex(ValueError, "_posts/post.md"):
            build.build_posts()

    def test_feed_and_sitemap_preserve_each_post_date_and_valid_xml(self):
        self.write_post("newer", "2026-09-01")
        self.write_post("older", "2026-08-01")
        entries = build.build_posts()
        with patch.dict(build.os.environ, {}, clear=True):
            build.build_meta_files(entries)
            first_feed = (self.root / "feed.xml").read_bytes()
            build.build_meta_files(entries)
        self.assertEqual(first_feed, (self.root / "feed.xml").read_bytes())
        feed = ET.fromstring(first_feed)
        self.assertEqual(len(feed.findall("./channel/item")), 2)
        namespace = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        sitemap = ET.parse(self.root / "sitemap.xml")
        dates = {node.find("s:loc", namespace).text.rsplit("/", 1)[-1]: node.find("s:lastmod", namespace).text
                 for node in sitemap.findall("s:url", namespace) if node.find("s:lastmod", namespace) is not None}
        self.assertEqual(dates, {"newer.html": "2026-09-01", "older.html": "2026-08-01"})

    def test_gallery_dates_use_image_history(self):
        gallery = self.root / "assets" / "gallery"
        gallery.mkdir(parents=True)
        (gallery / "old.jpg").touch()
        (gallery / "trip_2026-8.jpg").touch()
        (gallery / "not-an-image.jpg").mkdir()
        with patch.object(build, "GALLERY_DIR", gallery), patch.object(build, "photo_created_month", return_value="2026-07"):
            photos = build.build_photos()
        self.assertEqual([photo["when"] for photo in photos], ["2026-07", "2026 · 08"])

    def test_artifact_contains_public_files_and_excludes_sources(self):
        self.write_post()
        build.build_posts()
        (self.root / "index.html").write_text("public", encoding="utf-8")
        (self.root / "README.md").write_text("internal", encoding="utf-8")
        (self.root / ".env").write_text("private", encoding="utf-8")
        destination = prepare_site(self.root)
        self.assertTrue((destination / "posts" / "post.html").exists())
        self.assertTrue((destination / ".nojekyll").exists())
        self.assertFalse((destination / "_posts").exists())
        self.assertFalse((destination / "README.md").exists())
        self.assertFalse((destination / ".env").exists())
        with self.assertRaisesRegex(ValueError, "empty"):
            prepare_site(self.root)
        with self.assertRaises(ValueError):
            prepare_site(self.root, self.root)

    def test_collision_safe_upload_names_keep_readable_gallery_captions(self):
        gallery = self.root / "assets" / "gallery"
        gallery.mkdir(parents=True)
        (gallery / "夏日__upload-a1b2c3d4e5_2026-10.jpg").touch()
        (gallery / "legitimate_1234567890_2026-10.jpg").touch()
        with patch.object(build, "GALLERY_DIR", gallery):
            photos = build.build_photos()
        captions = {photo['caption'] for photo in photos}
        self.assertEqual(captions, {'夏日', 'legitimate_1234567890'})
        self.assertTrue(all(photo['when'] == '2026 · 10' for photo in photos))

    def test_same_named_image_replacement_updates_existing_derivatives(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow is optional locally; installed in CI")
        from tools import optimize_assets
        gallery = self.root / "assets" / "gallery"
        gallery.mkdir(parents=True)
        source = gallery / "photo.png"
        derivative = self.root / "assets" / "avatar.webp"
        with patch.object(optimize_assets, "ROOT", self.root):
            Image.new("RGB", (20, 20), "blue").save(source)
            optimize_assets.make_webp(source, derivative)
            optimize_assets.make_thumbs(gallery)
            Image.new("RGB", (20, 20), "red").save(source)
            optimize_assets.make_webp(source, derivative)
            optimize_assets.make_thumbs(gallery)
        for image_path in (derivative, gallery / "thumbs" / "photo.webp"):
            with Image.open(image_path) as image:
                red, green, blue = image.getpixel((10, 10))
            self.assertGreater(red, 200)
            self.assertLess(blue, 50)


if __name__ == "__main__":
    unittest.main()
