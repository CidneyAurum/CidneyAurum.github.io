"""Browser regressions: python -m unittest discover -s tests -p test_navigation.py.

Requires an existing Playwright installation and Chromium browser. All external
requests are blocked; tests serve this checkout on an ephemeral loopback port.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import json
import re
import unittest

from playwright.sync_api import sync_playwright, expect


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        try:
            super().do_GET()
        except ConnectionError:
            # Canceled PJAX requests can close the socket while we send a page.
            pass


class NavigationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        cls.server = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(QuietHandler, directory=str(root))
        )
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
        # Keep request fixtures authoritative; native cache/offline behavior has
        # its own real Service Worker coverage in test_offline.py.
        self.context = self.browser.new_context(reduced_motion="reduce", service_workers="block")
        self.context.route(
            "**/*",
            lambda route: route.continue_()
            if route.request.url.startswith(self.origin + "/")
            else route.abort(),
        )
        self.page = self.context.new_page()
        self.page.set_default_timeout(7000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()

    def go(self, path):
        self.page.goto(self.origin + path)
        self.page.wait_for_function("document.readyState === 'complete'")

    def click_nav(self, page):
        self.page.locator(f'.nav-link[href$="/{page}.html"]').click()
        self.page.wait_for_url(self.origin + f"/{page}.html")
        expect(self.page.locator("body")).to_have_attribute("data-page", "home" if page == "index" else page)

    def test_cross_directory_links_preserve_document_and_metadata(self):
        self.go("/index.html")
        self.page.evaluate("window.navigationSentinel = 42")
        self.click_nav("blog")
        self.page.locator("#post-timeline .tl-card").first.click(position={"x": 20, "y": 20})
        self.page.wait_for_url("**/posts/*.html")
        expect(self.page.locator("body")).to_have_attribute("data-page", "post")
        self.assertEqual(self.page.evaluate("window.navigationSentinel"), 42)
        self.assertEqual(self.page.locator('meta[property="og:type"]').get_attribute("content"), "article")
        self.assertGreater(self.page.locator("head style[data-page-style]").count(), 0)
        self.page.locator("#giscus-slot").scroll_into_view_if_needed()
        self.page.wait_for_function("document.querySelector('#giscus-slot script[src*=\"giscus.app\"]') !== null")
        links = self.page.locator("#side-records .side-record")
        expect(links).to_have_count(2)
        for href in links.evaluate_all("links => links.map(a => a.href)"):
            self.assertNotIn("/posts/posts/", href)
        links.last.click()
        self.page.wait_for_url("**/posts/*.html")
        self.click_nav("index")
        self.assertEqual(self.page.evaluate("window.navigationSentinel"), 42)
        self.assertEqual(self.page.locator("head style[data-page-style]").count(), 0)
        self.assertEqual(self.page.locator('meta[property="og:type"]').get_attribute("content"), "website")
        self.click_nav("photos")
        expect(self.page.locator("#photo-grid figure")).to_have_count(6)
        self.assertEqual(self.errors, [])

    def test_direct_post_home_hotkey_and_search_shortcut(self):
        self.go("/posts/hello-world.html")
        self.page.evaluate("window.navigationSentinel = 42")
        self.page.keyboard.press("h")
        self.page.wait_for_url(self.origin + "/index.html")
        self.assertEqual(self.page.evaluate("window.navigationSentinel"), 42)
        self.page.keyboard.press("Control+k")
        self.page.wait_for_url(self.origin + "/blog.html")
        expect(self.page.locator("#search-input")).to_be_focused()
        self.page.locator("#search-input").fill("绝不会命中的关键词")
        expect(self.page.locator("#post-timeline")).to_contain_text("没有找到")
        self.page.locator("#search-input").fill("网站上线")
        expect(self.page.locator("#post-timeline .tl-card")).to_have_count(1)
        self.page.locator("#post-timeline .tl-card").click(position={"x": 20, "y": 20})
        self.page.wait_for_url("**/posts/hello-world.html")
        self.page.go_back()
        expect(self.page.locator("#search-input")).to_have_value("网站上线")
        self.assertEqual(self.errors, [])

    def test_empty_and_failed_archive_are_visible_in_default_view(self):
        self.page.route("**/posts/posts.json", lambda route: route.fulfill(status=503, body="unavailable"))
        self.go("/blog.html")
        expect(self.page.locator("#post-timeline")).to_be_visible()
        expect(self.page.locator("#post-timeline")).to_contain_text("暂时未能加载")
        self.page.unroute("**/posts/posts.json")
        self.page.route("**/posts/posts.json", lambda route: route.fulfill(content_type="application/json", body=json.dumps({"posts": []})))
        self.page.reload()
        expect(self.page.locator("#post-timeline")).to_contain_text("还没有文章")
        self.assertEqual(self.errors, [])

    def test_latest_navigation_and_popstate_win_over_pending_fetch(self):
        self.go("/index.html")
        self.click_nav("blog")
        self.page.evaluate("() => { pjaxGo('about.html', true); pjaxGo('photos.html', true); }")
        self.page.wait_for_url(self.origin + "/photos.html")
        expect(self.page.locator("body")).to_have_attribute("data-page", "photos")
        self.page.evaluate("() => { pjaxGo('about.html', true); history.back(); }")
        self.page.wait_for_url(self.origin + "/blog.html")
        expect(self.page.locator("body")).to_have_attribute("data-page", "blog")
        self.assertEqual(self.errors, [])

    def test_limbus_initializes_after_navigation(self):
        self.go("/index.html")
        self.click_nav("limbus")
        self.page.locator("#btn-next").click()
        expect(self.page.locator("#lyric-area .lyric-line")).to_have_count(1)
        self.assertEqual(self.errors, [])

    def test_mobile_menu_announces_state_and_escape_closes(self):
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.go("/index.html")
        menu = self.page.locator("#hamburger")
        menu.click()
        expect(menu).to_have_attribute("aria-expanded", "true")
        self.page.keyboard.press("Escape")
        expect(menu).to_have_attribute("aria-expanded", "false")
        expect(menu).to_be_focused()

    def test_home_search_keyboard_and_failure_message(self):
        self.go("/index.html")
        search = self.page.locator("#hs-input")
        search.fill("网站上线")
        expect(self.page.locator("#hs-drop a")).to_have_count(1)
        search.press("ArrowDown")
        expect(search).to_have_attribute("aria-activedescendant", "hs-result-0")
        search.press("Enter")
        self.page.wait_for_url("**/posts/hello-world.html")
        self.page.route("**/posts/posts.json", lambda route: route.fulfill(status=500, body="error"))
        self.click_nav("index")
        self.page.locator("#hs-input").fill("任意关键词")
        expect(self.page.locator("#hs-drop")).to_contain_text("暂时无法加载")
        self.assertEqual(self.errors, [])

    def test_view_transition_navigation_preserves_document(self):
        self.page.emulate_media(reduced_motion="no-preference")
        self.go("/index.html")
        self.page.evaluate("window.navigationSentinel = 42")
        self.page.evaluate("pjaxGo('blog.html', true)")
        expect(self.page.locator("body")).to_have_attribute("data-page", "blog")
        self.page.evaluate("pjaxGo('posts/hello-world.html', true)")
        expect(self.page.locator("body")).to_have_attribute("data-page", "post")
        self.assertEqual(self.page.evaluate("window.navigationSentinel"), 42)
        self.assertEqual(self.errors, [])

    def test_back_restores_scroll_after_archive_data_loads(self):
        posts = [{"slug": "hello-world", "title": f"Record {i}", "date": "2026-08-29", "tags": []} for i in range(30)]
        self.page.route("**/posts/posts.json", lambda route: route.fulfill(content_type="application/json", body=json.dumps({"posts": posts})))
        self.go("/blog.html")
        expect(self.page.locator("#post-timeline .tl-card")).to_have_count(30)
        self.page.evaluate("scrollTo(0, 1200)")
        self.page.wait_for_function("scrollY === 1200 && history.state?.scrollY === 1200")
        self.page.evaluate("pjaxGo('about.html', true)")
        expect(self.page.locator("body")).to_have_attribute("data-page", "about")
        self.page.go_back()
        expect(self.page.locator("#post-timeline .tl-card")).to_have_count(30)
        self.page.wait_for_function("scrollY === 1200")
        self.assertEqual(self.errors, [])

    def test_skipped_native_transition_still_navigates_and_switches_theme(self):
        self.page.emulate_media(reduced_motion="no-preference")
        self.go("/index.html")
        self.page.evaluate("""() => {
          window.navigationSentinel = 42;
          const start = document.startViewTransition.bind(document);
          document.startViewTransition = update => {
            const transition = start(update);
            transition.skipTransition();
            return transition;
          };
        }""")
        self.page.evaluate("pjaxGo('/blog.html', true)")
        expect(self.page.locator("body")).to_have_attribute("data-page", "blog")
        self.page.locator("#theme-toggle").click()
        expect(self.page.locator("body")).to_have_class(re.compile(r"\blight\b"))
        self.assertEqual(self.page.evaluate("window.navigationSentinel"), 42)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
