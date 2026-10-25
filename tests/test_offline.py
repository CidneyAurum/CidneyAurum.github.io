"""Native service-worker regressions with Chromium and an ephemeral local server.

Run: python -m unittest discover -s tests -p test_offline.py -v
The actual sw.js is registered by main.js. No worker or CacheStorage API is
mocked; Chromium's offline switch disables the real network. External requests
are blocked, and the only dynamic server fixture adds a revision to posts JSON.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit
import json
import unittest

from playwright.sync_api import Error, expect, sync_playwright


class OfflineHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        pathname = urlsplit(self.path).path
        if pathname == "/__offline_fixture":
            self.send_fixture("<!doctype html><meta charset=utf-8><title>Cache setup</title>", "text/html; charset=utf-8")
            return
        if pathname == "/posts/posts.json":
            # Preserve real site data; the revision lets a reconnect prove that
            # the worker refreshed its saved JSON rather than returning stale data.
            data = json.loads((Path(self.directory) / "posts" / "posts.json").read_text(encoding="utf-8"))
            data["_offline_revision"] = self.server.index_revision
            self.send_fixture(json.dumps(data, ensure_ascii=False), "application/json; charset=utf-8")
            return
        try:
            super().do_GET()
        except ConnectionError:
            pass

    def send_fixture(self, text, content_type):
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except ConnectionError:
            pass


class OfflineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(OfflineHandler, directory=str(root)))
        cls.server.index_revision = 1
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
        self.server.index_revision = 1
        self.context = self.browser.new_context(service_workers="allow", reduced_motion="reduce")
        # Cross-origin media/fonts/comments are irrelevant to site-owned offline
        # resources. Local requests and the real worker script reach the server.
        self.context.route("**/*", lambda route: route.continue_()
                           if route.request.url.startswith(self.origin + "/") else route.abort())
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def controlled_home(self):
        self.page.goto(self.origin + "/index.html", wait_until="load")
        self.page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=15000)
        state = self.page.evaluate("""async () => {
          const registration = await navigator.serviceWorker.ready;
          return {secure: isSecureContext, active: registration.active.state,
                  script: navigator.serviceWorker.controller.scriptURL};
        }""")
        self.assertTrue(state["secure"])
        self.assertEqual(state["active"], "activated")
        self.assertEqual(state["script"], self.origin + "/sw.js")
        response = self.page.reload(wait_until="load")
        self.assertTrue(response.from_service_worker)
        self.wait_saved_paths("/index.html", "/posts/posts.json", "/css/style.css", "/css/garden.css", "/js/main.js")

    def wait_saved_paths(self, *paths):
        self.page.wait_for_function("""async required => {
          const saved = [];
          for (const name of await caches.keys()) {
            for (const request of await (await caches.open(name)).keys())
              saved.push(new URL(request.url).pathname);
          }
          return required.every(path => saved.includes(path));
        }""", arg=list(paths))

    def fetch_index(self):
        return self.page.evaluate("""async () => {
          const response = await fetch('/posts/posts.json', {cache: 'no-cache'});
          return {status: response.status, data: await response.json()};
        }""")

    def test_home_styles_and_content_load_after_real_offline_reload(self):
        self.controlled_home()
        offline_responses = []
        self.page.on("response", lambda response: offline_responses.append({
            "path": urlsplit(response.url).path, "status": response.status,
            "worker": response.from_service_worker}))
        self.context.set_offline(True)
        response = self.page.reload(wait_until="load")
        self.assertEqual(response.status, 200)
        self.assertTrue(response.from_service_worker)
        expect(self.page.locator("#profile-heading")).to_have_text("CidneyAurum")
        expect(self.page.locator("body")).to_have_attribute("data-page", "home")
        index = self.fetch_index()
        self.assertEqual(index["status"], 200)
        self.assertGreaterEqual(len(index["data"]["posts"]), 2)
        for path in ("/css/style.css", "/css/garden.css", "/posts/posts.json"):
            self.assertTrue(any(r["path"] == path and r["status"] == 200 and r["worker"]
                                for r in offline_responses), offline_responses)
        style_rules = self.page.evaluate("""[...document.styleSheets]
          .filter(sheet => sheet.href && new URL(sheet.href).origin === location.origin)
          .map(sheet => ({path: new URL(sheet.href).pathname, rules: sheet.cssRules.length}))""")
        self.assertTrue(all(sheet["rules"] > 0 for sheet in style_rules), style_rules)

    def test_visited_article_reads_offline_and_uncached_page_explains_failure(self):
        self.controlled_home()
        self.page.goto(self.origin + "/posts/hello-world.html", wait_until="load")
        self.wait_saved_paths("/posts/hello-world.html")
        self.context.set_offline(True)
        response = self.page.reload(wait_until="load")
        self.assertEqual(response.status, 200)
        self.assertTrue(response.from_service_worker)
        expect(self.page.locator("h1")).to_contain_text("网站上线啦")
        missing = self.page.goto(self.origin + "/posts/not-visited-offline.html", wait_until="domcontentloaded")
        self.assertEqual(missing.status, 503)
        self.assertTrue(missing.from_service_worker)
        expect(self.page.locator("h1")).to_have_text("暂时无法连接")
        expect(self.page.locator("body")).to_contain_text("联网后刷新")
        expect(self.page.locator("a")).to_have_attribute("href", "/index.html")

    def test_reconnecting_refreshes_json_and_new_version_remains_offline(self):
        self.controlled_home()
        self.assertEqual(self.fetch_index()["data"]["_offline_revision"], 1)
        self.context.set_offline(True)
        self.assertEqual(self.fetch_index()["data"]["_offline_revision"], 1)
        self.server.index_revision = 2
        self.context.set_offline(False)
        self.assertEqual(self.fetch_index()["data"]["_offline_revision"], 2)
        self.page.wait_for_function("""async () => {
          const response = await caches.match('/posts/posts.json');
          return response && (await response.json())._offline_revision === 2;
        }""")
        self.context.set_offline(True)
        self.assertEqual(self.fetch_index()["data"]["_offline_revision"], 2)

    def test_writing_page_is_never_served_from_runtime_cache(self):
        self.controlled_home()
        response = self.page.goto(self.origin + "/admin.html", wait_until="load")
        self.assertEqual(response.status, 200)
        self.assertFalse(response.from_service_worker)
        saved = self.page.evaluate("""async () => {
          const paths = [];
          for (const name of await caches.keys())
            for (const request of await (await caches.open(name)).keys())
              paths.push(new URL(request.url).pathname);
          return paths;
        }""")
        self.assertNotIn("/admin.html", saved)
        self.context.set_offline(True)
        result = self.page.evaluate("""async () => {
          try { const response = await fetch('/admin.html', {cache: 'reload'}); return {status: response.status}; }
          catch (error) { return {failed: true}; }
        }""")
        self.assertEqual(result, {"failed": True})
        with self.assertRaises(Error):
            self.page.reload(wait_until="domcontentloaded")

    def test_activation_removes_old_site_caches_and_keeps_unrelated_data(self):
        self.page.goto(self.origin + "/__offline_fixture")
        self.page.evaluate("""async () => {
          for (const name of ['unrelated-app', 'cidney-site-v0', 'site-runtime-v2']) {
            const cache = await caches.open(name);
            await cache.put('/__old_' + name, new Response('saved-' + name));
          }
        }""")
        self.controlled_home()
        names = self.page.evaluate("caches.keys()")
        self.assertIn("unrelated-app", names)
        self.assertNotIn("cidney-site-v0", names)
        self.assertNotIn("site-runtime-v2", names)
        value = self.page.evaluate("""async () => {
          const response = await (await caches.open('unrelated-app')).match('/__old_unrelated-app');
          return response.text();
        }""")
        self.assertEqual(value, "saved-unrelated-app")


if __name__ == "__main__":
    unittest.main()
