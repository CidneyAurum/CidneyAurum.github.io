"""AI frontend integration against mocked gateways. No provider/key/paid request."""
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import unittest
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        try:
            super().do_GET()
        except ConnectionError:
            pass


class MikuAITests(unittest.TestCase):
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
        self.context = self.browser.new_context(service_workers="block", reduced_motion="reduce", viewport={"width": 1280, "height": 900})
        self.configured = True
        self.requests = []
        self.held_routes = []
        self.reply = {"reply": "这是来自测试夹具的回复。", "emotion": "thinking", "citations": [], "actions": []}
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
        if parts.netloc == "127.0.0.1:8787":
            if request.method == "OPTIONS":
                return route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS"})
            if parts.path == "/api/status":
                return route.fulfill(json={"configured": self.configured, "model": "mock-model", "features": ["chat", "article", "discover", "write"]}, headers={"Access-Control-Allow-Origin": "*"})
            if parts.path == "/api/chat":
                self.requests.append({"body": request.post_data_json, "headers": request.headers})
                return self.chat(route)
            return route.fulfill(status=404, json={"error": "unexpected route"})
        if request.url.startswith(self.origin + "/"):
            if parts.path == "/data/ai-config.json":
                return route.fulfill(json={"endpoint": ""})
            return route.continue_()
        return route.abort()

    def boot(self, path="/posts/hello-world.html"):
        self.page.goto(self.origin + path, wait_until="domcontentloaded")
        if not self.page.evaluate("Boolean(window.MikuAI)"):
            self.page.add_script_tag(url=self.origin + "/js/miku-ai.js")
        self.page.evaluate("async()=>await MikuAI.ready")

    def test_article_controls_are_explicit_and_send_only_real_context(self):
        self.boot()
        expect(self.page.locator("#miku-article-tools")).to_have_count(1)
        self.assertEqual(self.requests, [])
        self.page.get_by_role("button", name="问问这篇", exact=True).click()
        expect(self.page.locator("#miku-ai-dialog")).to_be_visible()
        self.assertEqual(self.requests, [])
        self.page.locator(".mai-close").click()
        self.page.get_by_role("button", name="一句话读懂", exact=True).click()
        expect(self.page.locator(".mai-answer-text").last).to_have_text(self.reply["reply"])
        payload = self.requests[-1]["body"]
        self.assertEqual(payload["mode"], "article")
        self.assertEqual(payload["context"], {"page": "post", "slug": "hello-world"})
        self.assertNotIn("authorization", self.requests[-1]["headers"])
        self.assertNotIn("key", payload)

    def test_selected_article_text_is_sent_only_after_explain_click(self):
        self.boot()
        self.page.evaluate("""()=>{const p=document.querySelector('.prose p');const r=document.createRange();r.selectNodeContents(p);const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event('selectionchange'));}""")
        selected = self.page.evaluate("getSelection().toString().trim()")
        self.assertTrue(selected)
        self.assertEqual(self.requests, [])
        self.page.get_by_role("button", name="解释选中内容", exact=True).click()
        expect(self.page.locator(".mai-answer-text").last).to_have_text(self.reply["reply"])
        self.assertEqual(self.requests[-1]["body"]["context"]["selection"], selected)
        expect(self.page.locator(".mai-selection")).to_contain_text(selected)

    def test_structured_results_escape_text_and_allow_only_valid_local_links(self):
        self.boot()
        self.reply = {"reply": '<img src=x onerror="window.pwned=1"> **safe text**', "emotion": "happy", "citations": [
            {"id": "valid", "title": "真实手记", "url": "/posts/hello-world.html", "excerpt": "<script>bad</script>"},
            {"id": "evil", "title": "坏链接", "url": "javascript:alert(1)"},
            {"id": "external", "title": "站外", "url": "https://evil.example/"},
        ], "actions": [{"type": "navigate", "target": "/blog.html", "label": "去归档"}, {"type": "navigate", "target": "/admin.html", "label": "不该打开"}, {"type": "heart", "label": "比心"}]}
        result = self.page.evaluate("async()=>{const r=await MikuAI.ask({message:'问题',history:[{role:'system',content:'not allowed'},{role:'user',content:'previous'}]});MikuAI.open();MikuAI.renderMessage(document.querySelector('.mai-messages'),r);return r;}")
        self.assertEqual(result["emotion"], "比心")
        self.assertEqual(len(result["citations"]), 1)
        self.assertEqual(len(result["actions"]), 2)
        self.assertEqual(self.page.locator(".mai-answer img,.mai-answer script").count(), 0)
        self.assertIsNone(self.page.evaluate("window.pwned"))
        self.assertEqual(self.requests[-1]["body"]["history"], [{"role": "user", "content": "previous"}])
        self.page.get_by_role("link", name="去归档", exact=True).click()
        self.page.wait_for_url("**/blog.html")
        self.assertFalse(self.page.locator("#miku-ai-dialog").evaluate("e=>e.open"))

    def test_unconfigured_status_never_claims_ai_or_sends_paid_requests(self):
        self.configured = False
        self.boot()
        self.page.evaluate("MikuAI.open({question:'你好'})")
        expect(self.page.locator(".mai-service")).to_contain_text("尚未配置")
        expect(self.page.locator(".mai-submit")).to_be_disabled()
        error = self.page.evaluate("async()=>{try{await MikuAI.ask({message:'不能发送'});}catch(e){return e.message;}}")
        self.assertIn("尚未配置", error)
        self.assertEqual(self.requests, [])
        self.assertEqual(self.page.locator('#miku-ai-dialog input[type="password"]').count(), 0)
        self.configured = True
        self.page.locator(".mai-reconnect").click()
        expect(self.page.locator(".mai-submit")).to_be_enabled()

    def test_cancel_and_retry_keep_one_user_message_and_restore_focus(self):
        self.boot()
        self.chat = lambda route: self.held_routes.append(route)
        self.page.get_by_role("button", name="问问这篇", exact=True).click()
        self.page.fill("#miku-ai-input", "请解释一下")
        self.page.locator(".mai-submit").click()
        expect(self.page.locator(".mai-cancel")).to_be_visible()
        self.page.locator(".mai-cancel").click()
        expect(self.page.locator(".mai-error")).to_contain_text("停在这里")
        self.chat = lambda route: route.fulfill(json=self.reply, headers={"Access-Control-Allow-Origin": "*"})
        self.page.locator(".mai-retry").click()
        expect(self.page.locator(".mai-answer-text").last).to_have_text(self.reply["reply"])
        expect(self.page.locator(".mai-user")).to_have_count(1)
        self.page.keyboard.press("Escape")
        expect(self.page.get_by_role("button", name="问问这篇", exact=True)).to_be_focused()
        self.assertEqual(len(self.requests), 2)

    def test_http_failure_retry_and_pjax_reentry_do_not_duplicate_controls(self):
        self.boot()
        self.chat = lambda route: route.fulfill(status=503, json={"error": "测试服务暂时不可用"}, headers={"Access-Control-Allow-Origin": "*"})
        self.page.get_by_role("button", name="一句话读懂", exact=True).click()
        expect(self.page.locator(".mai-error")).to_have_text("测试服务暂时不可用")
        self.chat = lambda route: route.fulfill(json=self.reply, headers={"Access-Control-Allow-Origin": "*"})
        self.page.locator(".mai-retry").click()
        expect(self.page.locator(".mai-answer-text").last).to_have_text(self.reply["reply"])
        self.page.keyboard.press("Escape")
        self.page.evaluate("runPageReady();runPageReady()")
        expect(self.page.locator("#miku-article-tools")).to_have_count(1)
        self.page.get_by_role("button", name="问问这篇", exact=True).click()
        expect(self.page.locator("#miku-ai-dialog")).to_be_visible()
        expect(self.page.locator("#miku-ai-dialog")).to_have_count(1)

    def test_writer_suggestions_require_apply_and_can_undo_without_publishing(self):
        self.boot("/admin.html")
        self.page.fill("#p-title", "原来的标题")
        self.page.fill("#p-body", "## 原稿\n这是一篇需要保留的草稿。")
        self.reply = {"reply": "新的建议标题", "emotion": "thinking", "citations": [], "actions": []}
        self.page.get_by_role("button", name="拟标题", exact=True).click()
        expect(self.page.locator(".mai-proposal-text")).to_have_value("新的建议标题")
        expect(self.page.locator("#p-title")).to_have_value("原来的标题")
        self.assertEqual(self.requests[-1]["body"]["mode"], "write")
        self.assertEqual(self.requests[-1]["body"]["task"], "title")
        self.page.get_by_role("button", name="应用到标题", exact=True).click()
        expect(self.page.locator("#p-title")).to_have_value("新的建议标题")
        self.assertEqual(self.page.evaluate("JSON.parse(localStorage.getItem('admin_draft_v1')).post['p-title']"), "新的建议标题")
        self.page.get_by_role("button", name="撤销这次修改", exact=True).click()
        expect(self.page.locator("#p-title")).to_have_value("原来的标题")
        self.assertIsNone(self.page.evaluate("localStorage.getItem('gh_token')"))

    def test_writer_polishes_only_selection_and_refuses_to_overwrite_new_edits(self):
        self.boot("/admin.html")
        original = "首行\n选中的段落\n尾行"
        self.page.fill("#p-body", original)
        self.page.locator("#p-body").evaluate("e=>e.setSelectionRange(3,9)")
        self.reply = {"reply": "  润色后的段落\n", "emotion": "neutral", "citations": [], "actions": []}
        self.page.get_by_role("button", name="润色选段", exact=True).click()
        expect(self.page.locator(".mai-proposal-text")).to_have_value("  润色后的段落\n")
        self.assertEqual(self.requests[-1]["body"]["context"]["selection"], original[3:9])
        self.page.fill("#p-body", original + "\n新写的一句")
        self.page.get_by_role("button", name="替换选中段落", exact=True).click()
        expect(self.page.locator(".mai-workshop-status")).to_contain_text("已经有新修改")
        expect(self.page.locator("#p-body")).to_have_value(original + "\n新写的一句")
        self.page.locator("#p-body").evaluate("e=>e.setSelectionRange(3,9)")
        self.page.get_by_role("button", name="润色选段", exact=True).click()
        expect(self.page.locator(".mai-workshop-status")).to_contain_text("建议已准备好")
        self.page.get_by_role("button", name="替换选中段落", exact=True).click()
        changed = original[:3] + "  润色后的段落\n" + original[9:] + "\n新写的一句"
        expect(self.page.locator("#p-body")).to_have_value(changed)
        self.page.get_by_role("button", name="撤销这次修改", exact=True).click()
        expect(self.page.locator("#p-body")).to_have_value(original + "\n新写的一句")

    def test_mobile_dialog_is_bounded_and_closing_pending_request_is_honest(self):
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.boot()
        self.chat = lambda route: self.held_routes.append(route)
        self.page.get_by_role("button", name="问问这篇", exact=True).click()
        self.page.fill("#miku-ai-input", "先等等")
        self.page.locator(".mai-submit").click()
        expect(self.page.locator(".mai-pending")).to_be_visible()
        bounds = self.page.locator("#miku-ai-dialog").bounding_box()
        self.assertLessEqual(bounds["x"] + bounds["width"], 391)
        self.assertLessEqual(bounds["height"], 844)
        self.page.keyboard.press("Escape")
        self.page.get_by_role("button", name="问问这篇", exact=True).click()
        expect(self.page.locator(".mai-error")).to_contain_text("已取消")
        expect(self.page.locator(".mai-pending")).to_have_count(0)

    def test_targeted_listen_loads_empty_queue_and_matches_canonical_song_id(self):
        self.boot()
        self.page.evaluate("""()=>{
          window.musicActions=[];window.songQueue=[];window.musicPlaying=false;
          window.MikuMusic={getQueue:()=>songQueue,getState:()=>({playing:musicPlaying}),
            loadPlaylist:async()=>{musicActions.push('load');songQueue=[{id:'first'},{id:42}];},
            playIndex:async index=>{musicActions.push(['play',index]);musicPlaying=true;return true;},
            toggle:async()=>musicActions.push('toggle')};
          window.MikuHost={intent:async type=>musicActions.push(['host',type])};
          MikuAI.open();MikuAI.renderMessage(document.querySelector('.mai-messages'),{
            reply:'试试这首',citations:[],actions:[{type:'listen',target:'42',label:'播放推荐歌曲'}]});
        }""")
        self.assertEqual(self.page.evaluate("musicActions"), [])
        self.page.get_by_role("button", name="播放推荐歌曲", exact=True).click()
        self.page.wait_for_function("musicActions.some(item=>Array.isArray(item)&&item[0]==='host')")
        self.assertEqual(self.page.evaluate("musicActions"), ["load", ["play", 1], ["host", "listen"]])
        self.assertEqual(self.requests, [])

    def test_unknown_listen_target_shows_feedback_without_default_song(self):
        self.boot()
        self.page.evaluate("""()=>{
          window.musicActions=[];window.songQueue=[];
          window.MikuMusic={getQueue:()=>songQueue,loadPlaylist:async()=>{musicActions.push('load');songQueue=[{id:'known'}];},
            playIndex:async index=>musicActions.push(['play',index]),toggle:async()=>musicActions.push('toggle')};
          window.MikuHost={intent:async type=>musicActions.push(['host',type])};
          MikuAI.open();MikuAI.renderMessage(document.querySelector('.mai-messages'),{
            reply:'未知目标',citations:[],actions:[{type:'listen',target:'missing',label:'播放这首'}]});
        }""")
        self.page.get_by_role("button", name="播放这首", exact=True).click()
        expect(self.page.locator(".mai-action-status")).to_contain_text("不在当前歌单")
        expect(self.page.locator(".mai-action-status")).to_be_visible()
        self.assertTrue(self.page.locator("#miku-ai-dialog").evaluate("e=>e.open"))
        self.assertEqual(self.page.evaluate("musicActions"), ["load"])
        self.assertEqual(self.requests, [])

    def test_article_selection_limit_rejects_without_truncating_and_accepts_8000(self):
        self.boot()
        error = self.page.evaluate("async()=>{try{await MikuAI.ask({message:'解释',mode:'article',context:{page:'post',slug:'hello-world',selection:'字'.repeat(8001)}});}catch(e){return e.message;}}")
        self.assertIn("8000", error)
        self.assertEqual(self.requests, [])
        select = """length=>{const p=document.querySelector('.prose p');p.textContent='字'.repeat(length);const range=document.createRange();range.selectNodeContents(p);const selected=getSelection();selected.removeAllRanges();selected.addRange(range);document.dispatchEvent(new Event('selectionchange'));}"""
        self.page.evaluate(select, 8001)
        self.page.get_by_role("button", name="解释选中内容", exact=True).click()
        expect(self.page.locator(".mai-error").last).to_contain_text("没有截断选段")
        self.assertEqual(self.requests, [])
        self.page.locator(".mai-close").click()
        self.page.evaluate(select, 8000)
        self.page.get_by_role("button", name="解释选中内容", exact=True).click()
        expect(self.page.locator(".mai-answer-text").last).to_have_text(self.reply["reply"])
        self.assertEqual(self.requests[-1]["body"]["context"]["selection"], "字" * 8000)

    def test_writer_selection_limit_rejects_without_modifying_original(self):
        self.boot("/admin.html")
        self.page.fill("#p-body", "字" * 8001)
        self.page.get_by_role("button", name="提炼摘要", exact=True).click()
        expect(self.page.locator(".mai-workshop-status")).to_contain_text("8000")
        self.assertEqual(self.requests, [])
        expect(self.page.locator("#p-body")).to_have_value("字" * 8001)
        self.page.fill("#p-body", "字" * 8000)
        self.page.get_by_role("button", name="提炼摘要", exact=True).click()
        expect(self.page.locator(".mai-proposal-text")).to_have_value(self.reply["reply"])
        self.assertEqual(self.requests[-1]["body"]["context"]["selection"], "字" * 8000)
        expect(self.page.locator("#p-body")).to_have_value("字" * 8000)

    def test_history_matches_item_total_and_turn_limits_while_retaining_newest(self):
        self.boot()
        self.page.evaluate("""async()=>{
          const history=[{role:'system',content:'not forwarded'},{role:'user',content:'   '},
            ...Array.from({length:14},(_,index)=>({role:index%2?'assistant':'user',content:String(index).padStart(2,'0')+'x'.repeat(5000)}))];
          await MikuAI.ask({message:'继续',history});
        }""")
        history = self.requests[-1]["body"]["history"]
        self.assertEqual(len(history), 4)
        self.assertEqual(sum(len(turn["content"]) for turn in history), 16000)
        self.assertEqual([turn["content"][:2] for turn in history], ["10", "11", "12", "13"])
        self.assertTrue(all(len(turn["content"]) == 4000 for turn in history))
        self.page.evaluate("async()=>await MikuAI.ask({message:'短历史',history:Array.from({length:14},(_,index)=>({role:index%2?'assistant':'user',content:String(index)}))})")
        history = self.requests[-1]["body"]["history"]
        self.assertEqual(len(history), 12)
        self.assertEqual(history[0]["content"], "2")
        self.assertEqual(history[-1]["content"], "13")

    def test_utf8_request_budget_drops_old_history_without_cutting_selection(self):
        self.boot()
        self.page.evaluate("""async()=>await MikuAI.ask({message:'请解释完整选段',mode:'article',
          context:{page:'post',slug:'hello-world',selection:'字'.repeat(8000)},
          history:Array.from({length:4},(_,index)=>({role:index%2?'assistant':'user',content:String(index)+'史'.repeat(1500)}))})""")
        payload = self.requests[-1]["body"]
        wire = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.assertLessEqual(len(wire), 32768)
        self.assertEqual(payload["context"]["selection"], "字" * 8000)
        self.assertEqual(payload["message"], "请解释完整选段")
        self.assertEqual(len(payload["history"]), 1)
        self.assertTrue(payload["history"][0]["content"].startswith("3"))

    def test_oversize_question_and_selection_are_rejected_instead_of_truncated(self):
        self.boot()
        error = self.page.evaluate("""async()=>{
          window.originalQuestion={message:'问'.repeat(3000),mode:'article',context:{page:'post',slug:'hello-world',selection:'字'.repeat(8000)},history:[{role:'user',content:'old'}]};
          try{await MikuAI.ask(originalQuestion);}catch(error){return error.message;}
        }""")
        self.assertIn("缩短问题或选段", error)
        self.assertIn("没有截断", error)
        self.assertEqual(self.requests, [])
        self.assertEqual(self.page.evaluate("originalQuestion.message.length"), 3000)
        self.assertEqual(self.page.evaluate("originalQuestion.context.selection.length"), 8000)

    def test_refresh_recovers_failed_config_and_coalesces_concurrent_checks(self):
        self.configured = False
        config_reads, recovered_status = [], []
        def config(route):
            config_reads.append(route.request.url)
            if len(config_reads) == 1:
                route.fulfill(status=503, json={"error": "temporary config failure"})
            else:
                route.fulfill(json={"endpoint": "https://recovered.example"})
        def status(route):
            recovered_status.append(route.request.url)
            route.fulfill(json={"configured": True, "model": "recovered-fixture", "features": ["chat"]}, headers={"Access-Control-Allow-Origin": "*"})
        self.page.route(self.origin + "/data/ai-config.json", config)
        self.page.route("https://recovered.example/api/status", status)
        self.boot()
        self.assertFalse(self.page.evaluate("MikuAI.status().configured"))
        self.assertEqual(len(config_reads), 1)
        self.page.evaluate("MikuAI.open()")
        expect(self.page.locator(".mai-submit")).to_be_disabled()
        self.page.evaluate("async()=>await Promise.all([MikuAI.refresh(),MikuAI.refresh(),MikuAI.refresh()])")
        self.assertEqual(len(config_reads), 2)
        self.assertEqual(len(recovered_status), 1)
        self.assertEqual(self.page.evaluate("MikuAI.status().endpoint"), "https://recovered.example")
        self.assertTrue(self.page.evaluate("MikuAI.status().configured"))
        expect(self.page.locator(".mai-submit")).to_be_enabled()
        self.assertEqual(self.requests, [])


if __name__ == "__main__":
    unittest.main()
