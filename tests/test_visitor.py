"""Visitor workflows with isolated Chromium contexts and explicit network fixtures.

Run: python -m unittest discover -s tests -p test_visitor.py
All external requests are blocked except the local giscus client/frame fixtures.
The fixtures exercise integration behavior; no GitHub login or real comment is sent.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit
import json
import re
import unittest

from playwright.sync_api import sync_playwright, expect


GISCUS_CLIENT = """
(() => {
  const script = document.currentScript;
  const frame = document.createElement('iframe');
  frame.className = 'giscus-frame';
  frame.src = 'https://giscus.app/visitor-test-frame?theme=' + script.dataset.theme;
  script.parentElement.appendChild(frame);
})();
"""
GISCUS_FRAME = """<!doctype html><html><body><p>Local comment fixture</p><script>
window.receivedConfigs=[];
addEventListener('message',event=>{
  if(event.data?.giscus?.setConfig) receivedConfigs.push(event.data.giscus.setConfig);
});
</script></body></html>"""
POSTS = {"posts": [
    {"slug": "hello-world", "title": "网站上线啦！", "date": "2026-08-29", "tags": ["日常"], "summary": "欢迎来到测试小站。"},
    {"slug": "how-to-write-post", "title": "如何发布一篇新文章 / 新照片", "date": "2026-08-28", "tags": ["指南"], "summary": "发布与写作指南。"},
]}
GALLERY = {"photos": [
    {"src": "assets/gallery/" + name + "_2026-08." + extension, "caption": name, "when": "2026 · 08"}
    for name, extension in [("Hitori", "jpg"), ("Kita", "jpg"), ("Nijika", "jpg"), ("Ramen", "png"), ("Ryo", "jpg"), ("XiaRi", "jpg")]
]}
SAYS = {"says": [{"id": "visitor-fixture", "text": "一条用于访客流程验证的说说。", "images": [], "time": "2026-08-30 20:00"}]}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        try:
            super().do_GET()
        except ConnectionError:
            # A canceled PJAX fetch may close its socket during response delivery.
            pass


class VisitorTests(unittest.TestCase):
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
        self.context = self.browser.new_context(reduced_motion="reduce", service_workers="block", viewport={"width": 1280, "height": 900})
        self.overrides = {
            "/posts/posts.json": (200, POSTS),
            "/assets/gallery/gallery.json": (200, GALLERY),
            "/says/says.json": (200, SAYS),
        }
        self.requests = []
        self.comment_mode = "success"
        self.client_requests = 0
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.set_default_timeout(6000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def route(self, route):
        url = route.request.url
        parts = urlsplit(url)
        self.requests.append(url)
        if url.startswith(self.origin + "/"):
            override = self.overrides.get(parts.path)
            if override:
                status, body = override
                route.fulfill(status=status, content_type="application/json", body=body if isinstance(body, str) else json.dumps(body))
            else:
                route.continue_()
        elif url == "https://giscus.app/client.js":
            self.client_requests += 1
            if self.comment_mode == "fail":
                route.abort()
            else:
                route.fulfill(content_type="application/javascript", body=GISCUS_CLIENT, headers={"Access-Control-Allow-Origin": "*"})
        elif parts.netloc == "giscus.app" and parts.path == "/visitor-test-frame":
            route.fulfill(content_type="text/html", body=GISCUS_FRAME)
        else:
            route.abort()

    def go(self, path):
        self.page.goto(self.origin + path, wait_until="domcontentloaded")

    def nav(self, name):
        self.page.locator(f'.nav-link[href$="/{name}.html"]').click()
        self.page.wait_for_url(self.origin + f"/{name}.html")
        expect(self.page.locator("body")).to_have_attribute("data-page", "home" if name == "index" else name)

    def comments(self):
        slot = self.page.locator("main #giscus-slot")
        expect(slot).to_have_count(1)
        slot.scroll_into_view_if_needed()
        expect(slot.locator("iframe.giscus-frame")).to_have_count(1)
        expect(slot).to_have_attribute("aria-busy", "false")
        frame = self.page.frame(url=re.compile(r"https://giscus\.app/visitor-test-frame"))
        self.assertIsNotNone(frame)
        return slot, frame

    def test_home_combobox_enter_opens_selected_post_without_reload(self):
        self.go("/index.html")
        self.page.evaluate("window.visitorSentinel={value:42}")
        search = self.page.locator("#hs-input")
        expect(search).to_have_attribute("role", "combobox")
        search.fill("网站上线")
        expect(self.page.locator("#hs-drop [role=option]")).to_have_count(1)
        expect(search).to_have_attribute("aria-expanded", "true")
        search.press("ArrowDown")
        expect(search).to_have_attribute("aria-activedescendant", "hs-result-0")
        expect(self.page.locator("#hs-result-0")).to_have_attribute("aria-selected", "true")
        search.press("Enter")
        self.page.wait_for_url("**/posts/hello-world.html")
        expect(self.page.locator("body")).to_have_attribute("data-page", "post")
        self.assertEqual(self.page.evaluate("window.visitorSentinel.value"), 42)
        expect(self.page.locator(".article-title")).to_contain_text("网站上线")

    def test_archive_filter_view_and_back_restore_session(self):
        self.go("/blog.html")
        expect(self.page.locator("#post-timeline .tl-card")).to_have_count(2)
        self.page.evaluate("window.visitorSentinel=42")
        self.page.locator('[data-tag="指南"]').click()
        expect(self.page.locator('#tag-filter [data-tag="指南"]')).to_have_attribute("aria-pressed", "true")
        self.page.locator("#search-input").fill("发布")
        expect(self.page.locator("#post-timeline .tl-card")).to_have_count(1)
        self.page.locator('[data-view="grid"]').click()
        expect(self.page.locator("#post-timeline")).to_be_hidden()
        expect(self.page.locator("#post-grid")).to_be_visible()
        self.page.locator("#post-grid .post-item").click()
        self.page.wait_for_url("**/posts/how-to-write-post.html")
        self.page.go_back()
        self.page.wait_for_url("**/blog.html")
        expect(self.page.locator("#search-input")).to_have_value("发布")
        expect(self.page.locator('#tag-filter [data-tag="指南"]')).to_have_attribute("aria-pressed", "true")
        expect(self.page.locator('[data-view="grid"]')).to_have_attribute("aria-pressed", "true")
        expect(self.page.locator("#post-grid .post-item")).to_have_count(1)
        self.assertEqual(self.page.evaluate("window.visitorSentinel"), 42)
        self.page.locator('#tag-filter [data-tag=""]').click()
        self.page.locator("#search-input").fill("")
        expect(self.page.locator("#post-grid .post-item")).to_have_count(2)

    def test_newest_navigation_wins_even_when_old_fetch_ignores_abort(self):
        self.go("/index.html")
        self.page.evaluate("""() => {
          window.visitorSentinel=42;
          const nativeFetch=window.fetch;
          window.fetch=(url, options={}) => String(url).endsWith('/about.html')
            ? new Promise(resolve => {window.releaseOldPage=()=>nativeFetch(url,{...options,signal:undefined}).then(resolve);})
            : nativeFetch(url,options);
          pjaxGo(new URL('about.html',location.href),true);
          pjaxGo(new URL('photos.html',location.href),true);
        }""")
        self.page.wait_for_url("**/photos.html")
        expect(self.page.locator("#photo-grid figure")).to_have_count(6)
        self.page.evaluate("window.releaseOldPage()")
        expect(self.page.locator("body")).to_have_attribute("data-page", "photos")
        self.assertEqual(self.page.evaluate("window.visitorSentinel"), 42)
        self.assertTrue(self.page.url.endswith("/photos.html"))

    def test_json_failure_retry_recovers_without_document_reload(self):
        self.overrides["/posts/posts.json"] = (500, "unavailable")
        self.go("/blog.html")
        self.page.evaluate("window.visitorSentinel=42")
        retry = self.page.locator("#post-timeline [data-retry-content]")
        expect(retry).to_be_visible()
        expect(self.page.locator("#post-timeline")).to_contain_text("暂时未能加载")
        self.overrides["/posts/posts.json"] = (200, POSTS)
        retry.click()
        expect(self.page.locator("#post-timeline .tl-card")).to_have_count(2)
        expect(self.page.locator("#post-timeline [data-retry-content]")).to_have_count(0)
        self.assertEqual(self.page.evaluate("window.visitorSentinel"), 42)

    def test_malformed_indexes_show_actionable_error_in_each_page(self):
        cases = [
            ("/blog.html", "/posts/posts.json", {"posts": {}}, "#post-timeline"),
            ("/photos.html", "/assets/gallery/gallery.json", "invalid JSON", "#photo-grid"),
            ("/says.html", "/says/says.json", {"says": None}, "#says-list"),
        ]
        for page, path, body, target in cases:
            with self.subTest(page=page):
                original = self.overrides[path]
                self.overrides[path] = (200, body)
                self.go(page)
                expect(self.page.locator(target + " [data-retry-content]")).to_be_visible()
                expect(self.page.locator(target)).to_contain_text("暂时未能加载")
                self.overrides[path] = original

    def test_gallery_keyboard_navigation_focus_and_music_isolation(self):
        self.go("/photos.html")
        pictures = self.page.locator("#photo-grid .ph img")
        expect(pictures).to_have_count(6)
        self.page.evaluate("""() => {
          window.musicSeekCalls=0;window.musicToggleCalls=0;
          const original=MikuMusic.getState;
          MikuMusic.getState=()=>({...original(),hasQueue:true,time:10,duration:100});
          MikuMusic.seek=()=>window.musicSeekCalls++;
          MikuMusic.toggle=()=>window.musicToggleCalls++;
        }""")
        first = pictures.first
        first.focus()
        first.press("Enter")
        expect(self.page.locator(".lightbox")).to_have_class("lightbox open")
        expect(self.page.locator(".lightbox-close")).to_be_focused()
        expect(self.page.locator(".lightbox .cap")).to_contain_text("1 / 6")
        self.page.keyboard.press("ArrowRight")
        expect(self.page.locator(".lightbox .cap")).to_contain_text("2 / 6")
        self.page.keyboard.press("ArrowLeft")
        expect(self.page.locator(".lightbox .cap")).to_contain_text("1 / 6")
        self.page.keyboard.press("Tab")
        expect(self.page.locator(".lightbox-prev")).to_be_focused()
        self.page.keyboard.press("Escape")
        expect(self.page.locator(".lightbox")).to_have_class("lightbox")
        expect(first).to_be_focused()
        self.assertEqual(self.page.evaluate("[window.musicSeekCalls,window.musicToggleCalls]"), [0, 0])
        self.assertNotEqual(self.page.evaluate("document.body.style.overflow"), "hidden")

    def test_missing_thumbnail_uses_original_once(self):
        path = "/assets/gallery/thumbs/Hitori_2026-08.webp"
        self.overrides[path] = (404, "missing thumbnail")
        self.go("/photos.html")
        first = self.page.locator("#photo-grid .ph img").first
        first.scroll_into_view_if_needed()
        self.page.wait_for_function("""() => {
          const image=document.querySelector('#photo-grid .ph img');
          return image && image.src===image.dataset.full && image.complete && image.naturalWidth>0;
        }""")
        self.assertTrue(first.get_attribute("src").endswith("/assets/gallery/Hitori_2026-08.jpg"))
        self.assertEqual(sum(urlsplit(url).path == "/assets/gallery/Hitori_2026-08.jpg" for url in self.requests), 1)

    def test_likes_persist_and_comments_follow_says_main_lifecycle(self):
        self.go("/index.html")
        self.page.evaluate("window.visitorSentinel=42")
        self.nav("says")
        like = self.page.locator("#says-list .like-btn").first
        expect(like).to_have_attribute("aria-pressed", "false")
        like.click()
        expect(like).to_have_attribute("aria-pressed", "true")
        self.comments()
        self.nav("index")
        expect(self.page.locator("#giscus-slot")).to_have_count(0)
        expect(self.page.locator("iframe.giscus-frame")).to_have_count(0)
        self.nav("says")
        expect(self.page.locator("#says-list .like-btn").first).to_have_attribute("aria-pressed", "true")
        self.comments()
        self.assertEqual(self.page.evaluate("window.visitorSentinel"), 42)
        self.page.reload(wait_until="domcontentloaded")
        expect(self.page.locator("#says-list .like-btn").first).to_have_attribute("aria-pressed", "true")

    def test_comment_client_failure_retry_and_lazy_loading(self):
        self.comment_mode = "fail"
        self.go("/posts/how-to-write-post.html")
        slot = self.page.locator("#giscus-slot")
        expect(slot.locator(".comment-status")).to_be_attached()
        self.assertEqual(self.client_requests, 0, "offscreen comments must not request their client eagerly")
        slot.scroll_into_view_if_needed()
        expect(slot.locator(".comment-retry")).to_be_visible()
        expect(slot.locator(".comment-status")).to_contain_text("连接不上")
        self.comment_mode = "success"
        slot.locator(".comment-retry").click()
        self.comments()
        expect(slot.locator(".comment-retry")).to_be_hidden()
        self.assertEqual(self.client_requests, 2)

    def test_comment_message_origin_source_and_theme_are_checked(self):
        self.go("/says.html")
        slot, frame = self.comments()
        expect(slot.locator(".comment-retry")).to_be_hidden()
        self.page.evaluate("""() => {
          const data={giscus:{error:'Fixture service unavailable'}};
          window.dispatchEvent(new MessageEvent('message',{origin:'https://evil.example',source:window,data}));
          window.dispatchEvent(new MessageEvent('message',{origin:'https://giscus.app',source:window,data}));
        }""")
        expect(slot.locator(".comment-retry")).to_be_hidden()
        self.page.locator("#theme-toggle").click()
        frame.wait_for_function("window.receivedConfigs.some(config=>config.theme==='light')")
        frame.evaluate("target=>parent.postMessage({giscus:{error:'Fixture service unavailable'}},target)", self.origin)
        expect(slot.locator(".comment-retry")).to_be_visible()
        expect(slot.locator(".comment-status")).to_contain_text("暂时不可用")
        slot.locator(".comment-retry").click()
        self.comments()

    def test_storage_denied_keeps_navigation_like_and_theme_usable(self):
        self.context.add_init_script("""for(const name of ['localStorage','sessionStorage']) Object.defineProperty(window,name,{get(){throw new DOMException('Storage denied','SecurityError')}});""")
        self.go("/index.html")
        self.page.locator("#theme-toggle").click()
        self.assertTrue(self.page.evaluate("document.body.classList.contains('light')"))
        self.nav("blog")
        self.page.locator("#search-input").fill("发布")
        expect(self.page.locator("#post-timeline .tl-card")).to_have_count(1)
        self.nav("says")
        like = self.page.locator(".like-btn").first
        like.click()
        expect(like).to_have_attribute("aria-pressed", "true")
        slot = self.page.locator("#giscus-slot")
        slot.scroll_into_view_if_needed()
        expect(slot.locator(".comment-status")).to_contain_text("限制了登录存储")
        expect(slot.locator('a[href$="/discussions"]')).to_be_visible()
        self.assertEqual(self.client_requests, 0)


if __name__ == "__main__":
    unittest.main()
