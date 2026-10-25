"""Companion regressions: python -m unittest discover -s tests -p test_kanban.py.

Requires Playwright + Chromium. Tests use a fresh browser context, local fixtures,
fake API keys, and mocked model/API responses. No paid service is contacted.
Actual public CDN/WebGL loading is verified separately, not claimed by mocks.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import unittest

from playwright.sync_api import sync_playwright, expect


MODEL_STUB = """
window.Live2DCubismCore = {};
window.__modelLoads = 0;
window.__destroyedApps = 0;
window.__destroyedModels = 0;
window.__expressionCalls = [];
window.__neutralResets = 0;
window.__restoredExpressions = 0;
window.__modelEvents = {};
window.__paramValues = {};
window.__makeModel = () => {
  const names=['比心','圈圈','脸红','前倾','唱歌','葱','QQ人'];
  const manager={expressions:names.map(name=>({name})),currentExpression:null,reserveExpressionIndex:-1,
    getExpressionIndex:name=>names.indexOf(name),
    resetExpression(){window.__neutralResets++;},restoreExpression(){window.__restoredExpressions++;}};
  return {
    internalModel: {height:500,on(name,callback){window.__modelEvents[name]=callback;},
      motionManager:{expressionManager:manager},
      coreModel:{setParameterValueById(id,value){window.__paramValues[id]=value;},getParameterValueById(id){return window.__paramValues[id]||0;}}},
    scale:{set(){}},width:200,height:500,motion(){},
    expression(name){window.__expressionCalls.push(name);const expression=manager.expressions[names.indexOf(name)];if(expression===manager.currentExpression)return Promise.resolve(false);manager.currentExpression=expression;return Promise.resolve(true);},
    destroy(){window.__destroyedModels++;}
  };
};
window.PIXI = {
  Application: class {
    constructor() {
      if (window.__appFailures > 0) { window.__appFailures--; throw Error('WebGL fixture failure'); }
      this.view = document.createElement('canvas');
      this.renderer = { resize() {} };
      this.stage = { addChild() {} };
    }
    destroy() { window.__destroyedApps++; this.view.remove(); }
  },
  live2d: { Live2DModel: { from: async (url) => {
    window.__lastModelUrl = url;
    window.__modelLoads++;
    if (window.__modelFailures > 0) { window.__modelFailures--; throw Error('model fixture failure'); }
    if (window.__holdFirstModel && window.__modelLoads === 1)
      return new Promise(resolve => { window.__releaseOldModel = () => resolve(window.__makeModel()); });
    return window.__makeModel();
  } } }
};
"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class KanbanTests(unittest.TestCase):
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
        self.context = self.browser.new_context(service_workers="block")
        self.context.route("**/*", lambda route: route.continue_()
                           if route.request.url.startswith(self.origin + "/") else route.abort())
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def boot(self, init="", model_stub=True):
        # Run kanban alone so failures in other components cannot mask its state.
        self.page.route(self.origin + "/posts/__companion_fixture", lambda route: route.fulfill(
            content_type="text/html; charset=utf-8", body='<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/css/style.css"><body></body>'))
        self.page.add_init_script("window.requestIdleCallback = callback => setTimeout(callback, 0);")
        if model_stub:
            self.page.add_init_script(MODEL_STUB)
        if init:
            self.page.add_init_script(init)
        self.page.goto(self.origin + "/posts/__companion_fixture")
        self.page.add_script_tag(url=self.origin + "/js/kanban.js")
        expect(self.page.locator("#kb-chat-btn")).to_be_visible()

    def configure(self, protocol="openai", base="https://chat.example/v1", key="fixture-key", model="fixture-model"):
        self.page.locator("#kb-set-btn").click()
        self.page.locator("#kb-protocol").select_option(protocol)
        for field, value in (("base", base), ("key", key), ("model", model)):
            self.page.locator("#kb-" + field).fill(value)
            self.page.locator("#kb-" + field).dispatch_event("change")
        self.page.locator("#kb-tts").uncheck()
        self.page.locator("#kb-set-close").click()

    def send(self, message):
        if not self.page.locator("#kb-chat").evaluate("node => node.classList.contains('open')"):
            self.page.locator("#kb-chat-btn").click()
        self.page.locator("#kb-input").fill(message)
        self.page.locator("#kb-send").click()
        expect(self.page.locator("#kb-send")).to_be_enabled()
        return self.page.locator("#kb-msgs .ai").last

    def test_no_key_local_chat_and_storage_denial_remain_usable(self):
        self.boot("Object.defineProperty(window, 'localStorage', { get() { throw Error('storage disabled'); } });")
        expect(self.send("你好")).to_contain_text("你好呀")
        expect(self.send("你是谁")).to_contain_text("看板娘初音")
        self.configure()
        requests = []
        self.page.route("https://chat.example/**", lambda route: (
            requests.append(route.request.url), route.fulfill(json={"choices": [{"message": {"content": "session settings work"}}]})))
        expect(self.send("自定义接口测试")).to_have_text("session settings work")
        self.assertEqual(requests, ["https://chat.example/v1/chat/completions"])

    def test_composing_chinese_input_does_not_send_early(self):
        self.boot()
        self.page.locator("#kb-chat-btn").click()
        self.page.locator("#kb-input").fill("你好")
        self.page.locator("#kb-input").dispatch_event("keydown", {"key": "Enter", "isComposing": True})
        expect(self.page.locator("#kb-input")).to_have_value("你好")
        expect(self.page.locator("#kb-msgs .me")).to_have_count(0)
        self.page.locator("#kb-input").press("Enter")
        expect(self.page.locator("#kb-msgs .ai").last).to_contain_text("你好呀")

    def test_music_api_setting_saves_restores_clears_and_rejects_invalid_urls(self):
        self.boot()
        self.page.evaluate("""() => {
          window.musicQueue = [{id: 'keep-playing'}];
          window.MikuMusic = {getQueue: () => musicQueue, getState: () => ({playing: true}),
            stop() { throw Error('settings must not stop playback'); },
            reloadPlaylist() { throw Error('settings must not replace the queue'); }};
        }""")
        requests = []
        self.page.on("request", lambda request: requests.append(request.url)
                     if request.url.startswith("https://music.example/") else None)
        self.page.locator("#kb-set-btn").click()
        field = self.page.locator("#kb-musicapi")
        field.fill(" https://music.example/meting/ ")
        field.dispatch_event("change")
        self.assertEqual(self.page.evaluate("localStorage.getItem('kb_musicapi')"), "https://music.example/meting/")
        expect(self.page.locator("#kb-musicapi-hint")).to_contain_text("下次点播")
        self.assertTrue(self.page.evaluate("MikuMusic.getState().playing && MikuMusic.getQueue() === musicQueue"))
        for invalid in ("javascript:alert(1)", "ftp://music.example/", "not a URL"):
            field.fill(invalid)
            field.dispatch_event("change")
            expect(field).to_have_attribute("aria-invalid", "true")
            expect(self.page.locator("#kb-musicapi-hint")).to_contain_text("http:// 或 https://")
            self.assertEqual(self.page.evaluate("localStorage.getItem('kb_musicapi')"), "https://music.example/meting/")
        self.page.reload()
        self.page.add_script_tag(url=self.origin + "/js/kanban.js")
        self.page.locator("#kb-set-btn").click()
        field = self.page.locator("#kb-musicapi")
        expect(field).to_have_value("https://music.example/meting/")
        field.fill("")
        field.dispatch_event("change")
        self.assertEqual(self.page.evaluate("localStorage.getItem('kb_musicapi')"), "")
        expect(self.page.locator("#kb-musicapi-hint")).to_contain_text("公共音乐源")
        self.page.reload()
        self.page.add_script_tag(url=self.origin + "/js/kanban.js")
        self.page.locator("#kb-set-btn").click()
        expect(self.page.locator("#kb-musicapi")).to_have_value("")
        self.assertEqual(requests, [])

    def test_protocol_urls_and_text_blocks(self):
        self.boot()
        requests = []
        payload = {"choices": [{"message": {"content": [{"text": "第一段"}, {"text": "第二段"}]}}],
                   "candidates": [{"content": {"parts": [{"text": "第一段"}, {"text": "第二段"}]}}],
                   "content": [{"type": "text", "text": "第一段"}, {"type": "text", "text": "第二段"}]}
        self.page.route("https://chat.example/**", lambda route: (
            requests.append({"url": route.request.url, "body": route.request.post_data_json}), route.fulfill(json=payload)))
        cases = [("openai", "https://chat.example", "/v1/chat/completions"),
                 ("openai", "https://chat.example/v1/", "/v1/chat/completions"),
                 ("openai", "https://chat.example/gateway/v1/chat/completions", "/gateway/v1/chat/completions"),
                 ("tokenrhythm", "https://chat.example/v1", "/v1/chat/completions"),
                 ("gemini", "https://chat.example/v1beta/", "/v1beta/models/fixture-model:generateContent?key=fixture-key"),
                 ("claude", "https://chat.example/v1/", "/v1/messages")]
        for index, (protocol, base, endpoint) in enumerate(cases):
            with self.subTest(protocol=protocol, base=base):
                self.configure(protocol=protocol, base=base)
                expect(self.send(f"协议测试 {index}")).to_have_text("第一段第二段")
                self.assertEqual(requests[-1]["url"], "https://chat.example" + endpoint)
        self.assertIn("system", requests[-1]["body"])

    def test_overlapping_send_keeps_reply_order_and_unsent_input(self):
        self.boot()
        self.configure()
        pending = []
        self.page.route("https://chat.example/**", lambda route: pending.append(route))
        self.page.locator("#kb-chat-btn").click()
        self.page.locator("#kb-input").fill("第一条")
        self.page.locator("#kb-send").click()
        self.page.wait_for_function("document.querySelector('#kb-send').disabled")
        self.page.locator("#kb-input").fill("第二条")
        self.page.locator("#kb-input").press("Enter")
        self.page.wait_for_timeout(50)
        self.assertEqual(len(pending), 1)
        expect(self.page.locator("#kb-input")).to_have_value("第二条")
        pending[0].fulfill(json={"choices": [{"message": {"content": "第一答"}}]})
        expect(self.page.locator("#kb-send")).to_be_enabled()
        self.page.locator("#kb-send").click()
        self.page.wait_for_timeout(50)
        self.assertEqual(len(pending), 2)
        body = pending[1].request.post_data_json
        self.assertEqual([(m["role"], m["content"]) for m in body["messages"][1:]],
                         [("user", "第一条"), ("assistant", "第一答"), ("user", "第二条")])
        pending[1].fulfill(json={"choices": [{"message": {"content": "第二答"}}]})
        expect(self.page.locator("#kb-msgs .ai").last).to_have_text("第二答")

    def test_timeout_http_and_empty_reply_release_send(self):
        self.boot("const nativeTimer = window.setTimeout; window.setTimeout = (fn, ms, ...args) => nativeTimer(fn, ms === 25000 ? 40 : ms, ...args);")
        self.configure()
        self.page.evaluate("() => { window.__originalFetch = fetch; window.fetch = () => new Promise(() => {}); }")
        expect(self.send("请求超时测试")).to_contain_text("请求超时")
        self.page.evaluate("() => { window.fetch = window.__originalFetch; }")
        self.page.route("https://chat.example/**", lambda route: route.fulfill(status=401, body="fixture unauthorized"))
        expect(self.send("请求错误测试")).to_contain_text("401")
        self.page.unroute("https://chat.example/**")
        self.page.route("https://chat.example/**", lambda route: route.fulfill(json={"choices": []}))
        expect(self.send("空回复测试")).to_contain_text("没有返回文字")
        expect(self.page.locator("#kb-send")).to_be_enabled()

    def test_model_and_webgl_failure_allow_chat_and_retry(self):
        self.boot("window.__appFailures = 1; window.__modelFailures = 1;")
        expect(self.page.locator("#kb-loading")).to_contain_text("WebGL fixture failure")
        expect(self.send("你好")).to_contain_text("你好呀")
        self.page.locator("#kb-loading button").click()
        expect(self.page.locator("#kb-loading")).to_contain_text("model fixture failure")
        expect(self.page.locator("#kb-stage canvas")).to_have_count(0)
        self.page.locator("#kb-loading button").click()
        expect(self.page.locator("#kb-loading")).to_have_count(0)
        expect(self.page.locator("#kb-stage canvas")).to_have_count(1)
        self.assertEqual(self.page.evaluate("window.__modelLoads"), 2)
        self.assertEqual(self.page.evaluate("window.__lastModelUrl"), self.origin + "/assets/live2d/miku/miku.model3.json")

    def test_timed_out_model_is_cleaned_after_successful_retry(self):
        self.boot("window.__holdFirstModel = true; const nativeTimer = setTimeout; window.setTimeout = (fn, ms, ...args) => nativeTimer(fn, ms === 25000 ? 40 : ms, ...args);")
        expect(self.page.locator("#kb-loading")).to_contain_text("模型加载超时")
        self.page.locator("#kb-loading button").click()
        expect(self.page.locator("#kb-loading")).to_have_count(0)
        self.page.evaluate("window.__releaseOldModel()")
        self.page.wait_for_function("window.__destroyedModels === 1")
        expect(self.page.locator("#kb-stage canvas")).to_have_count(1)

    def test_script_failure_can_retry_without_reloading(self):
        attempts = []
        def core(route):
            attempts.append(route.request.url)
            if len(attempts) == 1:
                route.abort()
            else:
                route.fulfill(content_type="application/javascript", body="window.Live2DCubismCore = {};")
        self.page.route("https://cubism.live2d.com/**", core)
        self.page.route("https://cdn.jsdelivr.net/**", lambda route: route.fulfill(content_type="application/javascript", body=MODEL_STUB))
        self.boot(model_stub=False)
        expect(self.page.locator("#kb-loading")).to_contain_text("模型资源加载失败")
        self.page.locator("#kb-loading button").click()
        expect(self.page.locator("#kb-loading")).to_have_count(0)
        expect(self.page.locator("#kb-stage canvas")).to_have_count(1)
        self.assertEqual(len(attempts), 2)

    def test_music_commands_wait_for_result_and_handle_failures(self):
        self.boot()
        self.page.evaluate("""window.musicCalls = []; window.MikuMusic = {
          getState: () => ({ playing: true }), getQueue: () => [],
          loadPlaylist: async () => { musicCalls.push('load'); MikuMusic.getQueue = () => [{id:'1'}]; },
          playIndex: async i => musicCalls.push('random'),
          searchAndPlay: async name => { musicCalls.push(name); return {name}; },
          toggle: async () => musicCalls.push('pause'),
          next: async () => { throw Error('fixture playback unavailable'); }
        };""")
        expect(self.send("来一首 远方")).to_contain_text("《远方》")
        expect(self.send("随机播放")).to_contain_text("随机来一首")
        expect(self.send("暂停音乐")).to_contain_text("暂停")
        expect(self.send("下一首")).to_contain_text("fixture playback unavailable")
        self.assertEqual(self.page.evaluate("window.musicCalls"), ["远方", "load", "random", "pause"])

    def test_stale_model_list_does_not_override_changed_settings(self):
        self.boot()
        self.configure()
        pending = []
        self.page.route("https://chat.example/**", lambda route: pending.append(route))
        self.page.locator("#kb-set-btn").click()
        self.page.locator("#kb-models-btn").click()
        self.page.wait_for_timeout(50)
        self.page.locator("#kb-base").fill("https://chat.example/other/v1")
        self.page.locator("#kb-base").dispatch_event("change")
        pending[0].fulfill(json={"data": [{"id": "outdated-model"}]})
        expect(self.page.locator("#kb-hint")).to_contain_text("设置已变化")
        expect(self.page.locator("#kb-model")).to_have_value("fixture-model")
        self.page.locator("#kb-models-btn").click()
        self.page.wait_for_timeout(50)
        self.assertEqual(pending[1].request.url, "https://chat.example/other/v1/models")
        pending[1].fulfill(json={"data": [{"id": "current-model"}]})
        expect(self.page.locator("#kb-model")).to_have_value("current-model")
        expect(self.page.locator("#kb-models-btn")).to_be_enabled()

    def test_companion_bridge_is_ready_before_model_and_intents_do_not_chat(self):
        self.boot("""
          window.__holdFirstModel=true;window.__readyEvents=0;window.__visibility=[];window.__voiceCalls=[];
          document.addEventListener('miku:ready',()=>window.__readyEvents++);
          document.addEventListener('miku:visibility',event=>__visibility.push(event.detail.visible));
          window.MikuVoice={react:(...args)=>__voiceCalls.push(args),getState:()=>({mouth:0})};
        """)
        self.assertTrue(self.page.evaluate("async()=>await MikuCompanion.ready===MikuCompanion"))
        self.assertEqual(self.page.evaluate("window.__readyEvents"), 1)
        self.page.wait_for_function("typeof __releaseOldModel==='function'")
        self.page.evaluate("MikuCompanion.hide()")
        self.assertFalse(self.page.evaluate("MikuCompanion.isVisible()"))
        self.page.evaluate("document.dispatchEvent(new CustomEvent('miku:intent',{detail:{type:'heart',text:'比个心 <script>'}}))")
        self.assertTrue(self.page.evaluate("MikuCompanion.isVisible()"))
        expect(self.page.locator("#kb-bubble")).to_have_text("比个心 <script>")
        self.assertEqual(self.page.locator("#kb-bubble script").count(), 0)
        self.assertEqual(self.page.locator("#kb-msgs .me").count(), 0)
        self.assertEqual(self.page.evaluate("window.__voiceCalls"), [])
        self.page.evaluate("__releaseOldModel()")
        self.page.wait_for_function("__expressionCalls.includes('比心')")
        self.page.evaluate("MikuCompanion.react('脸红',20)")
        self.page.wait_for_timeout(80)
        self.assertGreater(self.page.evaluate("window.__neutralResets"), 0)
        self.page.evaluate("MikuCompanion.react('脸红',20)")
        self.page.wait_for_timeout(80)
        self.assertGreater(self.page.evaluate("window.__restoredExpressions"), 0)
        self.page.evaluate("MikuCompanion.openChat()")
        expect(self.page.locator("#kb-input")).to_be_focused()
        self.page.evaluate("MikuCompanion.openSettings()")
        expect(self.page.locator("#kb-protocol")).to_be_focused()
        self.assertEqual(self.page.evaluate("window.__visibility"), [False, True])

    def test_real_voice_bridge_drives_mouth_and_preview_with_settings_sync(self):
        self.boot("""
          window.__voiceCalls=[];window.__voiceMouth=.65;
          window.MikuVoice={react:(...args)=>__voiceCalls.push(['react',...args]),
            play:(...args)=>{__voiceCalls.push(['play',...args]);return Promise.resolve();},getState:()=>({mouth:__voiceMouth})};
        """)
        self.page.wait_for_function("typeof __modelEvents.afterModelUpdate==='function'")
        self.page.evaluate("__modelEvents.afterModelUpdate()")
        self.assertEqual(self.page.evaluate("__paramValues.ParamMouthOpenY"), .65)
        self.page.evaluate("window.__voiceMouth=2;__modelEvents.afterModelUpdate()")
        self.assertEqual(self.page.evaluate("__paramValues.ParamMouthOpenY"), 1)
        self.page.evaluate("window.__voiceMouth=0;window.__kbSinging=true;__modelEvents.afterModelUpdate()")
        self.assertEqual(self.page.evaluate("__paramValues.ParamMouthOpenY"), 0)
        self.page.evaluate("document.dispatchEvent(new CustomEvent('mikumusic',{detail:{playing:true}}))")
        self.page.wait_for_function("__expressionCalls.includes('唱歌')")
        self.page.evaluate("MikuCompanion.openSettings();document.dispatchEvent(new CustomEvent('miku:voice-setting',{detail:{enabled:false}}))")
        expect(self.page.locator("#kb-tts")).not_to_be_checked()
        self.assertEqual(self.page.evaluate("localStorage.getItem('kb_tts')"), "0")
        self.page.locator("#kb-voice-preview").click()
        self.assertEqual(self.page.evaluate("__voiceCalls.at(-1)"), ["play", "greet", {"force": True}])
        self.page.evaluate("MikuCompanion.hide();window.__voiceMouth=.8;__modelEvents.afterModelUpdate()")
        self.assertEqual(self.page.evaluate("__paramValues.ParamMouthOpenY"), 0)

    def test_local_and_music_reactions_use_character_voice_but_remote_ai_is_silent(self):
        self.boot("""
          window.__voiceCalls=[];window.__systemVoiceCalls=0;
          window.SpeechSynthesisUtterance=function(){window.__systemVoiceCalls++;};
          window.MikuVoice={react:(...args)=>__voiceCalls.push(args),getState:()=>({mouth:0})};
          window.MikuMusic={getState:()=>({playing:false}),playPlaylist:async()=>7};
        """)
        expect(self.send("你好")).to_contain_text("你好呀")
        self.assertEqual(self.page.evaluate("__voiceCalls.at(-1)[0]"), "reply")
        expect(self.send("播放歌单")).to_contain_text("7 首")
        self.assertEqual(self.page.evaluate("__voiceCalls.at(-1)[0]"), "music")
        self.configure()
        self.page.evaluate("document.dispatchEvent(new CustomEvent('miku:voice-setting',{detail:{enabled:true}}))")
        self.page.route("https://chat.example/**", lambda route: route.fulfill(json={"choices": [{"message": {"content": "一段真正来自 AI 的长回复，仅显示文字。"}}]}))
        expect(self.send("给我一段回复")).to_have_text("一段真正来自 AI 的长回复，仅显示文字。")
        self.assertEqual(self.page.evaluate("__voiceCalls.length"), 2)
        self.assertEqual(self.page.evaluate("__systemVoiceCalls"), 0)


if __name__ == "__main__":
    unittest.main()
