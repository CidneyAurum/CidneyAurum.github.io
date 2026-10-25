"""Companion -> gateway regressions; no model provider, real key, or paid request.

The actual kanban.js and miku-ai.js run together. Only WebGL/model/voice and
network responses use fixtures. A cancellation race test also supplies a late
MikuAI.ask result so the caller cannot rely solely on fetch honoring AbortSignal.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit
import unittest

from playwright.sync_api import sync_playwright, expect


MODEL_FIXTURE = """
window.Live2DCubismCore={};window.__expressions=[];
window.PIXI={Application:class{constructor(){this.view=document.createElement('canvas');this.renderer={resize(){}};this.stage={addChild(){}};}destroy(){this.view.remove();}},
live2d:{Live2DModel:{from:async()=>({internalModel:{height:500,on(){},coreModel:{setParameterValueById(){}},motionManager:{expressionManager:{resetExpression(){}}}},scale:{set(){}},width:200,height:500,motion(){},expression(name){__expressions.push(name);return Promise.resolve(true);},destroy(){}})}}};
window.requestIdleCallback=callback=>setTimeout(callback,0);
window.__voiceEvents=[];window.__systemTTS=0;window.__hostIntents=[];
window.MikuVoice={react:(...args)=>__voiceEvents.push(args),play:async(...args)=>__voiceEvents.push(args),getState:()=>({mouth:0})};
window.SpeechSynthesisUtterance=function(){window.__systemTTS++;};
window.MikuHost={intent:async type=>__hostIntents.push(type)};
"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        try:
            super().do_GET()
        except ConnectionError:
            pass


class AICompanionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[1]
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(cls.root)))
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
        self.context = self.browser.new_context(service_workers="block", reduced_motion="reduce", viewport={"width": 1440, "height": 1000})
        self.context.add_init_script(MODEL_FIXTURE)
        self.configured = True
        self.gateway_requests = []
        self.personal_requests = []
        self.held_routes = []
        self.reply = {"reply": "站内回答", "emotion": "thinking", "citations": [], "actions": []}
        self.chat = lambda route: route.fulfill(json=self.reply, headers={"Access-Control-Allow-Origin": "*"})
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.set_default_timeout(6000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def tearDown(self):
        for route in self.held_routes:
            try:
                route.abort()
            except Exception:
                pass
        self.context.unroute_all(behavior="wait")
        self.context.close()
        self.assertEqual(self.errors, [])

    def route(self, route):
        request = route.request
        parts = urlsplit(request.url)
        cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS"}
        if parts.netloc in {"127.0.0.1:8787", "personal.example"}:
            if request.method == "OPTIONS":
                return route.fulfill(status=204, headers=cors)
            if parts.netloc == "personal.example":
                self.personal_requests.append({"url": request.url, "body": request.post_data_json, "headers": request.headers})
                return route.fulfill(json={"choices": [{"message": {"content": "个人接口的回答"}}]}, headers=cors)
            if parts.path == "/api/status":
                return route.fulfill(json={"configured": self.configured, "model": "fixture-model", "features": ["chat", "article"]}, headers=cors)
            if parts.path == "/api/chat":
                self.gateway_requests.append({"body": request.post_data_json, "headers": request.headers})
                return self.chat(route)
            return route.fulfill(status=404, json={"error": "unexpected test route"}, headers=cors)
        if request.url.startswith(self.origin + "/"):
            if parts.path == "/data/ai-config.json":
                return route.fulfill(json={"endpoint": ""})
            if parts.path == "/posts/hello-world.html":
                return route.fulfill(content_type="text/html; charset=utf-8", body='''<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/garden.css"><title>测试文章</title></head><body data-page="post"><main class="wrap article-layout"><article class="article-inner"><h1 class="article-title">一篇真实上下文的测试文章</h1><div class="prose"><p>本地 fixture 内容，不会发送到付费模型。</p></div></article></main></body></html>''')
            return route.continue_()
        route.abort()

    def boot(self):
        self.page.goto(self.origin + "/posts/hello-world.html", wait_until="domcontentloaded")
        self.page.add_script_tag(url=self.origin + "/js/miku-ai.js")
        self.page.evaluate("window.MikuAIModuleReady=MikuAI.ready")
        self.page.add_script_tag(url=self.origin + "/js/kanban.js")
        self.page.evaluate("async()=>{await MikuAI.ready;await MikuCompanion.ready;}")
        self.page.locator("#kb-chat-btn").click()
        expect(self.page.locator("#kb-input")).to_be_visible()

    def send(self, message):
        self.page.locator("#kb-input").fill(message)
        self.page.locator("#kb-send").click()
        expect(self.page.locator("#kb-send")).to_be_enabled()
        return self.page.locator("#kb-msgs .ai").last

    def test_keyless_gateway_receives_exact_post_context_and_completed_history(self):
        self.boot()
        self.assertIsNone(self.page.evaluate("localStorage.getItem('kb_key')"))
        expect(self.page.locator("#kb-ai-channel")).to_contain_text("站内内容问答")
        expect(self.send("这篇讲了什么？")).to_have_text("站内回答")
        first = self.gateway_requests[0]
        self.assertEqual(first["body"]["mode"], "article")
        self.assertEqual(first["body"]["context"], {"page": "post", "slug": "hello-world"})
        self.assertEqual(first["body"]["history"], [])
        self.assertNotIn("authorization", first["headers"])
        self.assertNotIn("key", first["body"])
        self.reply["reply"] = "第二次回答"
        expect(self.send("再说一点")).to_have_text("第二次回答")
        self.assertEqual(self.gateway_requests[1]["body"]["history"], [
            {"role": "user", "content": "这篇讲了什么？"}, {"role": "assistant", "content": "站内回答"}])
        self.assertEqual(self.page.evaluate("__voiceEvents"), [])
        self.assertEqual(self.page.evaluate("__systemTTS"), 0)
        self.page.evaluate("history.replaceState(null,'','/posts/%E4%B8%AD%E6%96%87.html')")
        self.send("中文路径也能聊这篇吗？")
        self.assertEqual(self.gateway_requests[-1]["body"]["context"]["slug"], "中文")

    def test_safe_structured_citations_and_actions_render_without_html_execution(self):
        self.reply = {"reply": '<img src=x onerror="window.pwned=1"> 文字', "emotion": "happy", "citations": [
            {"id": "hello", "title": "站内引用", "url": "/posts/hello-world.html", "excerpt": "<script>bad</script>"},
            {"id": "bad", "title": "坏链接", "url": "javascript:alert(1)"}], "actions": [
            {"type": "heart", "label": "给个心"}, {"type": "navigate", "target": "https://evil.example/", "label": "坏操作"},
            {"type": "listen", "label": "听一首"}]}
        self.boot()
        answer = self.send("请给出引用")
        expect(answer.locator(".mai-answer-text")).to_have_text(self.reply["reply"])
        expect(answer.locator(".mai-source")).to_have_count(1)
        self.assertEqual(answer.locator(".mai-source").get_attribute("href"), self.origin + "/posts/hello-world.html")
        self.assertEqual(answer.locator("img,script").count(), 0)
        self.assertEqual(answer.locator('[href^="javascript:"],a[href^="https://evil"]').count(), 0)
        self.assertIsNone(self.page.evaluate("window.pwned"))
        answer.get_by_role("button", name="给个心", exact=True).click()
        answer.get_by_role("button", name="听一首", exact=True).click()
        self.assertEqual(self.page.evaluate("__hostIntents"), ["heart", "listen"])
        self.assertEqual(self.page.evaluate("__voiceEvents"), [])

    def test_cancelled_gateway_turn_is_excluded_from_next_history(self):
        self.boot()
        self.chat = lambda route: self.held_routes.append(route)
        self.page.fill("#kb-input", "这次不算")
        self.page.click("#kb-send")
        expect(self.page.locator("#kb-cancel")).to_be_visible()
        self.page.click("#kb-cancel")
        expect(self.page.locator("#kb-send")).to_be_enabled()
        expect(self.page.locator("#kb-msgs .ai").last).to_contain_text("停在这里")
        self.chat = lambda route: route.fulfill(json=self.reply, headers={"Access-Control-Allow-Origin": "*"})
        self.send("重新开始")
        self.assertEqual(self.gateway_requests[-1]["body"]["history"], [])
        self.assertEqual(self.page.evaluate("__voiceEvents"), [])

    def test_late_result_after_cancel_cannot_be_rendered_or_enter_history(self):
        self.boot()
        self.page.evaluate("""()=>{window.__originalAsk=MikuAI.ask;MikuAI.ask=()=>new Promise(resolve=>{window.__releaseLate=()=>resolve({reply:'已取消的迟到回答',emotion:null,citations:[],actions:[]});});}""")
        self.page.fill("#kb-input", "取消后不能记住")
        self.page.click("#kb-send")
        self.page.wait_for_function("typeof __releaseLate==='function'")
        self.page.click("#kb-cancel")
        self.page.evaluate("__releaseLate()")
        expect(self.page.locator("#kb-send")).to_be_enabled()
        self.assertNotIn("已取消的迟到回答", self.page.locator("#kb-msgs").inner_text())
        self.page.evaluate("()=>{MikuAI.ask=window.__originalAsk;}")
        self.send("下一条")
        self.assertEqual(self.gateway_requests[-1]["body"]["history"], [])

    def test_overlapping_typed_message_is_preserved_while_gateway_is_pending(self):
        self.boot()
        self.chat = lambda route: self.held_routes.append(route)
        self.page.fill("#kb-input", "第一条")
        self.page.click("#kb-send")
        self.page.wait_for_function("document.querySelector('#kb-send').disabled")
        self.page.fill("#kb-input", "第二条还没正式发送")
        self.page.locator("#kb-input").press("Enter")
        self.assertEqual(len(self.gateway_requests), 1)
        expect(self.page.locator("#kb-input")).to_have_value("第二条还没正式发送")
        self.held_routes[0].fulfill(json=self.reply, headers={"Access-Control-Allow-Origin": "*"})
        expect(self.page.locator("#kb-send")).to_be_enabled()
        expect(self.page.locator("#kb-input")).to_have_value("第二条还没正式发送")
        self.chat = lambda route: route.fulfill(json=self.reply, headers={"Access-Control-Allow-Origin": "*"})
        self.page.click("#kb-send")
        expect(self.page.locator("#kb-send")).to_be_enabled()
        self.assertEqual(len(self.gateway_requests), 2)
        self.assertEqual(self.gateway_requests[-1]["body"]["message"], "第二条还没正式发送")

    def test_personal_key_overrides_gateway_and_channel_updates_immediately(self):
        self.boot()
        self.page.locator("#kb-set-btn").click()
        for field, value in [("kb-base", "https://personal.example/v1"), ("kb-model", "fixture-model"), ("kb-key", "fixture-personal-key")]:
            self.page.locator("#" + field).fill(value)
            self.page.locator("#" + field).dispatch_event("change")
        self.page.locator("#kb-set-close").click()
        self.page.locator("#kb-chat-btn").click()
        expect(self.send("个人接口问题")).to_have_text("个人接口的回答")
        self.assertEqual(self.gateway_requests, [])
        self.assertEqual(len(self.personal_requests), 1)
        self.assertEqual(self.personal_requests[0]["url"], "https://personal.example/v1/chat/completions")
        self.assertEqual(self.personal_requests[0]["headers"].get("authorization"), "Bearer fixture-personal-key")
        self.assertEqual(self.page.evaluate("__voiceEvents"), [])
        expect(self.page.locator("#kb-ai-channel")).to_have_text("个人 AI 接口")

    def test_unconfigured_gateway_is_honest_local_and_status_can_reconnect(self):
        self.configured = False
        self.boot()
        expect(self.page.locator("#kb-ai-channel")).to_contain_text("本地陪伴")
        expect(self.page.locator("#kb-ai-channel")).to_contain_text("暂未连接")
        expect(self.send("随意谈一谈吧")).to_contain_text("本地简短回复")
        self.assertEqual(self.gateway_requests, [])
        self.configured = True
        self.page.evaluate("async()=>await MikuAI.refresh()")
        expect(self.page.locator("#kb-ai-channel")).to_contain_text("站内内容问答")
        self.send("接通了吗？")
        self.assertEqual(len(self.gateway_requests), 1)

    def test_expand_dialog_uses_article_context_without_automatic_request(self):
        self.boot()
        self.page.locator("#kb-ai-open").click()
        expect(self.page.locator("#miku-ai-dialog")).to_be_visible()
        expect(self.page.locator("#miku-ai-title")).to_have_text("和 Miku 聊这篇")
        self.assertEqual(self.gateway_requests, [])
        self.page.fill("#miku-ai-input", "从大对话室问一个问题")
        self.page.locator(".mai-submit").click()
        expect(self.page.locator(".mai-answer-text").last).to_have_text(self.reply["reply"])
        self.assertEqual(self.gateway_requests[-1]["body"]["mode"], "article")
        self.assertEqual(self.gateway_requests[-1]["body"]["context"]["slug"], "hello-world")
        self.assertEqual(self.page.evaluate("__voiceEvents"), [])


if __name__ == "__main__":
    unittest.main()
