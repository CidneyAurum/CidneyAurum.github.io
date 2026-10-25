"""Host workflows with mocked companion/voice/music contracts, never external AI.

Run: python -m unittest discover -s tests -p test_miku_host.py
Native audio and Live2D/CDN loading are verified separately from these UI tests.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import unittest

from playwright.sync_api import sync_playwright, expect


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        try:
            super().do_GET()
        except ConnectionError:
            pass


CONTRACTS = """() => {
  window.hostCalls={load:0,show:0,voice:[],toggle:0,react:[]};
  const model=document.createElement('div');model.id='kanban';model.className='kanban';
  model.innerHTML='<div class="kb-stage">Companion fixture</div>';document.body.appendChild(model);
  const api={ready:Promise.resolve(),show(){hostCalls.show++},hide(){},say(text){window.lastMikuCaption=text},react(...args){hostCalls.react.push(args)},isVisible(){return true}};
  window.MikuCompanion=null;
  window.MikuLoader={load:async()=>{hostCalls.load++;window.MikuCompanion=api;return api}};
  let enabled=true;
  window.MikuVoice={ready:Promise.resolve(),unlock(){},stop(){window.resolveHostVoice?.();window.resolveHostVoice=null},
    isEnabled:()=>enabled,setEnabled:value=>{enabled=value},getState:()=>({playing:false}),
    getClips:()=>['greet','identity','thanks','heart','music'].map(id=>({id,label:id,ja:'日本語 '+id,text:'中文字幕 '+id})),
    play(event,options){hostCalls.voice.push({event,...options});return window.holdHostVoice?new Promise(resolve=>window.resolveHostVoice=resolve):Promise.resolve(true)}};
  const state={playing:false,index:0,hasQueue:true,current:{id:'fixture',name:'A real track title',artist:'Fixture artist'},lrc:[{t:0,text:'A timed lyric line'}],lrcLine:0,time:1,duration:120};
  const emit=()=>document.dispatchEvent(new CustomEvent('mikumusic',{detail:{...state}}));
  window.hostMusicState=state;
  window.MikuMusic={getState:()=>({...state}),getQueue:()=>[state.current],
    async toggle(){hostCalls.toggle++;state.playing=!state.playing;emit();return state.playing},
    next(){state.current={id:'next',name:'Next actual title',artist:'Next artist'};state.playing=true;emit()},
    prev(){state.current={id:'previous',name:'Previous actual title',artist:'Previous artist'};state.playing=true;emit()}};
} """


class MikuHostTests(unittest.TestCase):
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
        cls.browser.close(); cls.playwright.stop(); cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        self.context = self.browser.new_context(service_workers="block", reduced_motion="reduce", viewport={"width":1280,"height":900})
        self.context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(self.origin+"/") else route.abort())
        self.page = self.context.new_page()
        self.page.set_default_timeout(6000)
        self.errors=[]
        self.page.on("pageerror",lambda error:self.errors.append(str(error)))
        self.page.goto(self.origin+"/index.html",wait_until="networkidle")
        self.page.evaluate(CONTRACTS)
        self.page.add_script_tag(path=str(self.root/"js/miku-host.js"))
        self.page.add_style_tag(path=str(self.root/"css/miku-host.css"))

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors,[])

    def test_companion_intent_greets_without_ai_and_heart_reacts(self):
        self.page.evaluate("MikuHost.intent('greet')")
        expect(self.page.locator("#miku-host-text")).to_contain_text("你好呀")
        self.assertEqual(self.page.evaluate("hostCalls.load"),1)
        self.assertEqual(self.page.evaluate("hostCalls.voice[0].event"),"greet")
        self.page.locator('[data-miku-action="heart"]').first.click()
        self.page.wait_for_function("hostCalls.voice.some(clip=>clip.event==='heart')")
        self.assertTrue(self.page.evaluate("hostCalls.react.some(args=>args[0]==='比心')"))
        self.assertEqual(self.page.locator(".miku-heart").count(),0,"reduced motion suppresses confetti")

    def test_guide_visits_real_home_sections_then_actual_post(self):
        self.page.locator('[data-miku-action="guide"]').first.click()
        expect(self.page.locator("#featured-link")).to_have_class("note-feature card miku-guide-target")
        expect(self.page.locator(".miku-dock")).to_be_visible()
        self.page.locator('[data-miku-action="next-guide"]').click()
        expect(self.page.locator(".collection-card")).to_have_class("card collection-card miku-guide-target")
        self.page.locator('[data-miku-action="next-guide"]').click()
        expect(self.page.locator("#home-fragment-link")).to_have_class("fragment-date miku-guide-target")
        self.page.locator('[data-miku-action="end-guide"]').click()
        expect(self.page.locator(".miku-guide-target")).to_have_count(0)
        self.page.evaluate("window.hostSentinel=42;MikuHost.guide()")
        self.page.locator(".miku-dock-actions a").click()
        self.page.wait_for_url("**/posts/*.html")
        self.assertEqual(self.page.evaluate("window.hostSentinel"),42)
        expect(self.page.locator(".miku-dock")).to_be_visible()

    def test_closing_during_announcement_cannot_start_music_later(self):
        opener=self.page.locator('[data-miku-action="listen"]').first
        self.page.evaluate("window.holdHostVoice=true")
        opener.click()
        expect(self.page.locator(".miku-room")).to_be_visible()
        self.page.wait_for_function("typeof window.resolveHostVoice==='function'")
        self.assertTrue(self.page.evaluate("document.querySelector('main').inert"))
        self.page.keyboard.press("Escape")
        expect(self.page.locator(".miku-room")).to_have_count(0)
        expect(opener).to_be_focused()
        self.assertFalse(self.page.evaluate("document.querySelector('main').inert"))
        self.assertEqual(self.page.evaluate("hostCalls.toggle"),0)
        self.assertEqual(self.page.evaluate("document.querySelector('#kanban').parentElement.tagName"),"BODY")

    def test_room_uses_actual_music_lyrics_controls_and_keeps_playing_on_close(self):
        self.page.locator('[data-miku-action="listen"]').first.click()
        self.page.wait_for_function("hostMusicState.playing")
        expect(self.page.locator(".miku-room-title")).to_have_text("A real track title")
        expect(self.page.locator(".miku-room-lyric")).to_have_text("A timed lyric line")
        self.page.locator('[data-miku-action="room-play"]').click()
        expect(self.page.locator(".miku-room-note")).to_contain_text("音乐暂停了")
        self.page.locator('[data-miku-action="room-play"]').click()
        self.page.locator('[data-miku-action="room-next"]').click()
        expect(self.page.locator(".miku-room-title")).to_have_text("Next actual title")
        self.page.locator('[data-miku-action="room-prev"]').click()
        expect(self.page.locator(".miku-room-title")).to_have_text("Previous actual title")
        self.page.keyboard.press("Escape")
        self.assertTrue(self.page.evaluate("hostMusicState.playing"))

    def test_manual_play_during_announcement_is_not_toggled_off_later(self):
        self.page.evaluate("window.holdHostVoice=true")
        self.page.locator('[data-miku-action="listen"]').first.click()
        self.page.wait_for_function("typeof window.resolveHostVoice==='function'")
        self.page.locator('[data-miku-action="room-play"]').click()
        self.page.wait_for_function("hostMusicState.playing")
        self.assertEqual(self.page.evaluate("hostCalls.toggle"),1)
        expect(self.page.locator('[data-miku-action="room-play"]')).to_have_text("暂停")

    def test_voice_picker_uses_manifest_subtitles_and_mute(self):
        self.page.locator('[data-miku-action="voice"]').first.click()
        expect(self.page.locator(".miku-voice-options button")).to_have_count(5)
        self.page.locator('[data-voice-event="thanks"]').click()
        expect(self.page.locator(".miku-voice-caption")).to_contain_text("日本語 thanks · 中文字幕 thanks")
        self.assertEqual(self.page.evaluate("hostCalls.voice.at(-1)"),{"event":"thanks","force":True})
        self.page.locator('[data-miku-action="mute"]').click()
        self.assertFalse(self.page.evaluate("MikuVoice.isEnabled()"))
        expect(self.page.locator('[data-miku-action="mute"]')).to_have_attribute("aria-pressed","true")
        expect(self.page.locator(".miku-voice-source")).to_contain_text("Project SEKAI")

    def test_mobile_dialog_fits_and_tab_stays_inside(self):
        self.page.set_viewport_size({"width":390,"height":844})
        self.page.locator('[data-miku-action="voice"]').first.click()
        expect(self.page.locator(".miku-voices")).to_be_visible()
        self.page.keyboard.press("Shift+Tab")
        self.assertTrue(self.page.evaluate("!!document.activeElement.closest('.miku-modal')"))
        box=self.page.locator(".miku-voices").bounding_box()
        self.assertGreaterEqual(box["x"],0)
        self.assertLessEqual(box["x"]+box["width"],390)


if __name__=="__main__":
    unittest.main()
