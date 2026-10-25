"""Authoring integration tests. All GitHub calls are mocked; no real publication."""
import base64
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread
import unittest
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class AdminTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(root)))
        Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.context = self.browser.new_context(reduced_motion="reduce", accept_downloads=True)
        self.context.add_init_script("localStorage.setItem('gh_token','github_pat_mock_only');")
        self.requests = []
        self.api = lambda path, method, body: (404, {"message": "Not Found"})
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.set_default_timeout(6000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(self.origin + "/admin.html", wait_until="domcontentloaded")
        self.page.evaluate("ADMIN.maxPolls=1;ADMIN.pollDelay=0;ADMIN.requestTimeout=1000")

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def route(self, route):
        request = route.request
        if request.url.startswith(self.origin + "/"):
            return route.continue_()
        if urlsplit(request.url).netloc == "api.github.com":
            if request.method == "OPTIONS":
                return route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,PUT,OPTIONS"})
            path = urlsplit(request.url).path
            body = request.post_data_json if request.method == "PUT" else None
            self.requests.append((path, request.method, body))
            code, data = self.api(path, request.method, body)
            return route.fulfill(status=code, content_type="application/json", body=json.dumps(data), headers={"Access-Control-Allow-Origin": "*"})
        route.abort()

    @staticmethod
    def file(sha, value):
        text = value if isinstance(value, str) else json.dumps(value)
        return {"type": "file", "sha": sha, "encoding": "base64", "content": base64.b64encode(text.encode()).decode()}

    def post(self):
        for selector, value in {"#p-title": '“引号”与 "quoted"', "#p-slug": "mock-post", "#p-date": "2026-10-25", "#p-body": "## 正文\n1. 第一项\n2. 第二项"}.items():
            self.page.fill(selector, value)

    def finish(self, button):
        expect(self.page.locator(button)).to_be_enabled(timeout=6000)

    def test_draft_preview_validation_download_and_copy(self):
        self.post()
        self.page.fill("#p-body", '[坏链接](javascript:alert(1))\n![a" onerror="evil](https://example.com/a.png)\n~~~js\n**literal**\n~~~\n1. 一\n2. 二')
        self.assertEqual(self.page.locator('#preview a[href^="javascript:"]').count(), 0)
        self.assertEqual(self.page.locator('#preview [onerror]').count(), 0)
        expect(self.page.locator("#preview ol li")).to_have_count(2)
        expect(self.page.locator("#preview pre code")).to_have_text("**literal**")
        self.page.reload(wait_until="domcontentloaded")
        expect(self.page.locator("#p-title")).to_have_value('“引号”与 "quoted"')
        self.page.evaluate("Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copied=text},configurable:true})")
        self.page.click("#btn-copy")
        self.page.wait_for_function("typeof window.copied==='string'")
        copied = self.page.evaluate("window.copied")
        self.assertIn('title: "“引号”与 \\"quoted\\""'.replace('\\\\','\\'), copied)
        with self.page.expect_download() as download:
            self.page.click("#btn-download")
        self.assertEqual(download.value.suggested_filename, "mock-post.md")
        self.assertEqual(Path(download.value.path()).read_text(encoding="utf-8"), copied)
        self.page.fill("#p-slug", "../bad")
        self.page.click("#btn-publish")
        expect(self.page.locator(".js-status").first).to_contain_text("文件名")
        self.assertEqual(self.requests, [])

    def test_token_replacement_never_places_secret_or_fake_mask_in_value(self):
        self.page.click('[data-tab="setup"]')
        expect(self.page.locator("#token-input")).to_have_value("")
        self.page.fill("#token-input", "github_pat_replacement_mock")
        self.page.click("#btn-save-token")
        expect(self.page.locator("#token-input")).to_have_value("")
        self.assertEqual(self.page.evaluate("localStorage.getItem('gh_token')"), "github_pat_replacement_mock")
        self.page.click("#btn-clear-token")
        self.assertIsNone(self.page.evaluate("localStorage.getItem('gh_token')"))

    def test_publish_only_claims_online_on_deployment_success(self):
        self.post()
        def api(path, method, body):
            if method == "PUT":
                self.assertEqual(body["branch"], "main")
                return 201, {"commit": {"sha": "exact"}}
            if "/contents/" in path:
                return 404, {}
            if path.endswith("/deployments"):
                return 200, [{"id": 9, "sha": "exact", "environment": "github-pages"}]
            if path.endswith("/statuses"):
                return 200, [{"state": "success"}]
            return 200, {"workflow_runs": []}
        self.api = api
        self.page.click("#btn-publish")
        self.finish("#btn-publish")
        expect(self.page.locator(".js-status").first).to_contain_text("已部署")
        puts = [r for r in self.requests if r[1] == "PUT"]
        self.assertEqual(len(puts), 1)
        self.assertEqual(json.loads(base64.b64decode(puts[0][2]["content"]).decode().splitlines()[1][7:]), '“引号”与 "quoted"')

    def test_collision_read_failure_and_successful_build_do_not_claim_online(self):
        self.post()
        self.api = lambda path, method, body: (200, self.file("old", "existing"))
        self.page.click("#btn-publish")
        self.finish("#btn-publish")
        expect(self.page.locator(".js-status").first).to_contain_text("同名")
        self.assertFalse(any(r[1] == "PUT" for r in self.requests))
        self.api = lambda path, method, body: (500, {"message": "broken"})
        self.page.click("#btn-publish")
        self.finish("#btn-publish")
        self.assertFalse(any(r[1] == "PUT" for r in self.requests))
        def api(path, method, body):
            if method == "PUT": return 201, {"commit": {"sha": "exact"}}
            if "/contents/" in path: return 404, {}
            if path.endswith("/deployments"): return 200, []
            return 200, {"workflow_runs": [{"head_sha": "exact", "path": ".github/workflows/build.yml", "event": "push", "status": "completed", "conclusion": "success"}]}
        self.api = api
        self.page.click("#btn-publish")
        self.finish("#btn-publish")
        expect(self.page.locator(".js-status").first).to_contain_text("部署尚未确认")
        self.assertNotIn("已部署", self.page.locator(".js-status").first.inner_text())

    def test_says_previews_and_conflict_merge_preserve_concurrent_entries(self):
        self.page.click('[data-tab="say"]')
        self.page.fill("#s-text", "新的说说")
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=")
        self.page.set_input_files("#s-imgs", {"name": "tiny.png", "mimeType": "image/png", "buffer": png})
        expect(self.page.locator("#s-previews img")).to_have_count(1)
        self.page.wait_for_function("document.querySelector('#s-previews img').naturalWidth>0")
        writes, reads = [], 0
        def api(path, method, body):
            nonlocal reads
            if "/contents/assets/says/" in path:
                return (201, {"commit": {"sha": "image"}}) if method == "PUT" else (404, {})
            if path.endswith("/contents/says/says.json"):
                if method == "GET":
                    reads += 1
                    return 200, self.file("first" if reads == 1 else "second", {"says": [{"id": "old" if reads == 1 else "concurrent", "text": "keep"}]})
                writes.append(body)
                return (409, {"message": "conflict"}) if len(writes) == 1 else (201, {"commit": {"sha": "says"}})
            return (200, []) if path.endswith("/deployments") else (200, {"workflow_runs": []})
        self.api = api
        self.page.click("#btn-say")
        self.finish("#btn-say")
        self.assertEqual(len(writes), 2)
        value = json.loads(base64.b64decode(writes[1]["content"]).decode())
        self.assertEqual(writes[1]["sha"], "second")
        self.assertEqual(value["says"][0]["text"], "新的说说")
        self.assertEqual(value["says"][1]["id"], "concurrent")
        self.assertTrue(value["says"][0]["images"][0].endswith(".jpg"))
        expect(self.page.locator("#s-previews img")).to_have_count(0)
        expect(self.page.locator("#s-text")).to_have_value("")

    def test_same_title_images_have_unique_paths_and_partial_queue_is_preserved(self):
        self.page.click('[data-tab="photo"]')
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=")
        self.page.set_input_files("#img-input", [{"name": "same.png", "mimeType": "image/png", "buffer": png}] * 2)
        paths = []
        def api(path, method, body):
            if method == "PUT":
                paths.append(path)
                return (201, {"commit": {"sha": "image"}}) if len(paths) == 1 else (500, {"message": "temporary"})
            return 404, {}
        self.api = api
        self.page.click("#btn-upload")
        self.finish("#btn-upload")
        self.assertEqual(len(paths), 2)
        self.assertNotEqual(paths[0], paths[1])
        expect(self.page.locator("#img-queue .img-item")).to_have_count(1)
        # Do not let teardown's page close open an unsaved-image dialog.
        self.page.on("dialog", lambda dialog: dialog.accept())

    def test_leaving_with_selected_images_can_be_canceled_and_text_draft_survives(self):
        self.post()
        self.page.click('[data-tab="photo"]')
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=")
        self.page.set_input_files("#img-input", {"name": "draft.png", "mimeType": "image/png", "buffer": png})
        dialogs = []
        def cancel(dialog):
            dialogs.append(dialog.type)
            dialog.dismiss()
        self.page.on("dialog", cancel)
        self.page.locator('.nav-link[href$="about.html"]').click()
        self.assertEqual(dialogs, ["beforeunload"])
        expect(self.page.locator("body")).to_have_attribute("data-page", "admin")
        expect(self.page.locator("#img-queue .img-item")).to_have_count(1)
        self.page.remove_listener("dialog", cancel)
        self.page.on("dialog", lambda dialog: dialog.accept())
        self.page.locator('.nav-link[href$="about.html"]').click()
        expect(self.page.locator("body")).to_have_attribute("data-page", "about")
        self.page.goto(self.origin + "/admin.html", wait_until="domcontentloaded")
        expect(self.page.locator("#p-title")).to_have_value('“引号”与 "quoted"')
        expect(self.page.locator("#img-queue .img-item")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
