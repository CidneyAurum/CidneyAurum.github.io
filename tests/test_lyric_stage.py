"""Homepage stage regressions using native HTMLAudio + generated WAV/LRC fixtures.

No simulated music events drive the stage. Public music/lyrics HTTP responses are
fixtures; the real music engine, audio clock, seek, pause, and PJAX lifecycle run.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
import re
from threading import Thread
from urllib.parse import parse_qs, urlsplit
import unittest
import wave

from playwright.sync_api import sync_playwright, expect


CAPTURE = """
window.stageAudios=[];const NativeAudio=window.Audio;
window.Audio=function(...args){const audio=new NativeAudio(...args);stageAudios.push(audio);return audio;};window.Audio.prototype=NativeAudio.prototype;
window.stageSubscriptions={active:0,created:0};let musicAPI;
Object.defineProperty(window,'MikuMusic',{configurable:true,get:()=>musicAPI,set(api){
 const subscribe=api.on;api.on=function(callback){stageSubscriptions.active++;stageSubscriptions.created++;
  const off=subscribe.call(api,callback);let active=true;
  return()=>{if(active){active=false;stageSubscriptions.active--;if(typeof off==='function')off();}};};musicAPI=api;
}});
"""
LRC_ONE = """[ar:Stage test]
[ti:Stage One]
[00:01.00]原句一
[00:01.00]Translation one
[00:02.00]原句二
[00:02.00]Translation two
[00:03.00]原句三
[00:03.00]Translation three
[00:04.00]
[00:05.00]第四句
[00:08.00]第五句
"""
LRC_TWO = "[00:00.20]第二首第一句\n[00:00.20]Second track translation\n[00:03.00]第二首下一句"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        try:
            super().do_GET()
        except ConnectionError:
            pass


class LyricStageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[1]
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(cls.root)))
        Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"
        data = BytesIO()
        with wave.open(data, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(b"\0\0" * 8000 * 20)
        cls.wav = data.getvalue()
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 1000}, reduced_motion="no-preference", service_workers="block")
        self.context.add_init_script(CAPTURE)
        self.hold_for = set()
        self.held = []
        self.missing_available = False
        self.zero_start = False
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.set_default_timeout(7000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def tearDown(self):
        for route, _name in self.held:
            try:
                route.abort()
            except Exception:
                pass
        self.context.unroute_all(behavior="wait")
        self.context.close()
        self.assertEqual(self.errors, [])

    def lyric_record(self, name):
        return {"trackName": name, "artistName": "Stage test", "duration": 20,
                "syncedLyrics": LRC_TWO if name == "Stage Two" else LRC_ONE.replace("[00:01.00]", "[00:00.00]") if self.zero_start else LRC_ONE}

    def route(self, route):
        request = route.request
        url = request.url
        parts = urlsplit(url)
        query = parse_qs(parts.query)
        if parts.path.endswith("/data/playlist.json"):
            return route.fulfill(json={"playlist": [{"id": str(index + 1), "name": name, "artist": "Stage test", "pic": ""} for index, name in enumerate(["Stage One", "Stage Two", "No Lyrics"])]})
        if "type=url" in url or "/song/media/outer/" in url:
            requested = re.match(r"bytes=(\d+)-(\d*)", request.headers.get("range", ""))
            start = int(requested[1]) if requested else 0
            end = int(requested[2]) if requested and requested[2] else len(self.wav) - 1
            headers = {"Accept-Ranges": "bytes"}
            if requested:
                headers["Content-Range"] = f"bytes {start}-{end}/{len(self.wav)}"
            return route.fulfill(status=206 if requested else 200, content_type="audio/wav", headers=headers, body=self.wav[start:end + 1])
        if parts.netloc == "lrclib.net":
            name = query.get("track_name", [""])[0]
            if name in self.hold_for:
                self.held.append((route, name))
                return
            data = [] if name == "No Lyrics" and not self.missing_available else [self.lyric_record(name)]
            return route.fulfill(json=data, headers={"Access-Control-Allow-Origin": "*"})
        if query.get("type") == ["lrc"]:
            return route.fulfill(content_type="text/plain", body="", headers={"Access-Control-Allow-Origin": "*"})
        if query.get("type") == ["pic"]:
            return route.fulfill(content_type="text/plain", body="", headers={"Access-Control-Allow-Origin": "*"})
        if url.startswith(self.origin + "/"):
            return route.continue_()
        route.abort()

    def boot(self):
        self.page.goto(self.origin + "/index.html", wait_until="domcontentloaded")
        expect(self.page.locator("#track-list .track-item")).to_have_count(3)
        self.page.wait_for_function("Boolean(window.LyricStage)")
        expect(self.page.locator("#home-lyric-stage")).to_have_count(1)

    def start(self, index=0, ready=True):
        self.boot()
        self.page.locator("#track-list .track-item").nth(index).click()
        self.page.wait_for_function("MikuMusic.getState().playing && MikuMusic.getState().time>.05 && stageAudios.some(audio=>!audio.paused&&audio.currentTime>.05)")
        if ready:
            self.page.wait_for_function("MikuMusic.getState().lrcStatus==='ready'")
        self.page.evaluate("window.nativeStageAudio=stageAudios.find(audio=>audio.currentSrc.includes('type=url')||audio.currentSrc.includes('/outer/'))")

    def seek(self, time):
        self.page.evaluate("time=>MikuMusic.seek(time/MikuMusic.getState().duration)", time)
        self.page.wait_for_function("time=>Math.abs(nativeStageAudio.currentTime-time)<.35", arg=time)

    def test_native_time_groups_translation_and_pause_does_not_replay_effects(self):
        self.start()
        expect(self.page.locator("#home-lyric-stage")).to_have_attribute("data-stage-state", "intro")
        self.page.wait_for_function("MikuMusic.getState().time>=1.05")
        expect(self.page.locator(".ls-line:not(.ls-previous)")).to_have_text("原句一")
        expect(self.page.locator(".ls-translation")).to_have_text("Translation one")
        self.page.evaluate("""()=>{window.stageFX=0;const slash=document.querySelector('[data-stage-slash]');let previous=slash.classList.contains('is-active');new MutationObserver(()=>{const active=slash.classList.contains('is-active');if(active&&!previous)stageFX++;previous=active;}).observe(slash,{attributes:true,attributeFilter:['class']});}""")
        self.page.wait_for_function("MikuMusic.getState().time>=3.05")
        expect(self.page.locator(".ls-line:not(.ls-previous)")).to_have_text("原句三")
        self.assertEqual(self.page.evaluate("stageFX"), 1)
        self.page.evaluate("window.savedStageLine=document.querySelector('.ls-line:not(.ls-previous)')")
        self.page.locator("[data-stage-toggle]").click()
        self.page.wait_for_function("nativeStageAudio.paused")
        expect(self.page.locator("#home-lyric-stage")).to_have_class(re.compile(r"is-paused"))
        self.assertTrue(self.page.evaluate("[...document.querySelectorAll('.ls-line:not(.ls-previous) .ls-char')].every(el=>getComputedStyle(el).opacity==='1')"))
        self.page.wait_for_timeout(150)
        self.page.locator("[data-stage-toggle]").click()
        self.page.wait_for_function("!nativeStageAudio.paused")
        self.assertTrue(self.page.evaluate("savedStageLine===document.querySelector('.ls-line:not(.ls-previous)')"))
        self.assertEqual(self.page.evaluate("stageFX"), 1)

    def test_seek_uses_real_audio_time_and_clears_interlude_without_old_effects(self):
        self.start()
        self.seek(3.2)
        expect(self.page.locator(".ls-line:not(.ls-previous)")).to_have_text("原句三")
        expect(self.page.locator("[data-stage-slash]")).not_to_have_class(re.compile(r"is-active"))
        self.assertTrue(self.page.evaluate("[...document.querySelectorAll('.ls-line:not(.ls-previous) .ls-char')].every(el=>getComputedStyle(el).animationName==='none')"))
        self.seek(1.2)
        expect(self.page.locator(".ls-line:not(.ls-previous)")).to_have_text("原句一")
        expect(self.page.locator(".ls-previous")).to_have_count(0)
        self.seek(4.2)
        expect(self.page.locator("#home-lyric-stage")).to_have_attribute("data-stage-state", "interlude")
        expect(self.page.locator(".ls-line")).to_have_count(0)
        self.seek(.1)
        expect(self.page.locator("#home-lyric-stage")).to_have_attribute("data-stage-state", "intro")

    def test_track_change_clears_old_words_while_new_lyrics_are_loading(self):
        self.start()
        self.seek(1.2)
        expect(self.page.locator(".ls-line:not(.ls-previous)")).to_have_text("原句一")
        self.hold_for.add("Stage Two")
        self.page.locator("#track-list .track-item").nth(1).click()
        expect(self.page.locator("[data-stage-title]")).to_have_text("Stage Two")
        expect(self.page.locator("#home-lyric-stage")).to_have_attribute("data-stage-state", "loading")
        expect(self.page.locator(".ls-line")).to_have_count(0)
        self.page.wait_for_function("MikuMusic.getState().current.id==='2'&&MikuMusic.getState().time>.25")
        self.assertTrue(self.held)
        route, name = self.held.pop(0)
        self.hold_for.clear()
        route.fulfill(json=[self.lyric_record(name)], headers={"Access-Control-Allow-Origin": "*"})
        expect(self.page.locator(".ls-line:not(.ls-previous)")).to_have_text("第二首第一句")
        self.assertNotIn("原句", self.page.locator("[data-stage-lines]").inner_text())

    def test_unavailable_state_is_honest_and_explicit_retry_can_find_lyrics(self):
        self.start(2, ready=False)
        self.page.wait_for_function("MikuMusic.getState().lrcStatus==='unavailable'")
        expect(self.page.locator("#home-lyric-stage")).to_have_attribute("data-stage-state", "unavailable")
        expect(self.page.locator("[data-stage-lines]")).to_contain_text("没有可用")
        self.assertNotIn("纯音乐", self.page.locator("[data-stage-status]").inner_text())
        expect(self.page.locator("[data-stage-retry]")).to_be_visible()
        self.missing_available = True
        self.page.locator("[data-stage-retry]").click()
        self.page.wait_for_function("MikuMusic.getState().lrcStatus==='ready'")
        self.assertNotEqual(self.page.locator("#home-lyric-stage").get_attribute("data-stage-state"), "unavailable")

    def test_pjax_mounts_once_and_keeps_the_native_audio_element(self):
        self.start()
        self.seek(1.2)
        self.page.evaluate("window.savedNativeStageAudio=nativeStageAudio;LyricStage.mount();LyricStage.mount()")
        self.assertEqual(self.page.evaluate("stageSubscriptions.active"), 1)
        self.page.locator('.nav-link[href$="/blog.html"]').click()
        self.page.wait_for_url("**/blog.html")
        self.assertEqual(self.page.evaluate("stageSubscriptions.active"), 0)
        self.assertFalse(self.page.evaluate("LyricStage.getState().mounted"))
        self.page.locator('.nav-link[href$="/index.html"]').click()
        self.page.wait_for_url("**/index.html")
        expect(self.page.locator("#home-lyric-stage")).to_have_count(1)
        self.assertEqual(self.page.evaluate("stageSubscriptions.active"), 1)
        self.assertTrue(self.page.evaluate("savedNativeStageAudio===nativeStageAudio&&!nativeStageAudio.paused"))
        self.assertEqual(self.page.evaluate("stageAudios.filter(audio=>audio.currentSrc.includes('type=url')).length"), 1)
        self.assertIn(self.page.locator(".ls-line:not(.ls-previous)").inner_text(), ["原句一", "原句二", "原句三"])

    def test_keyboard_expansion_transport_and_seek_restore_focus_and_inert(self):
        self.start()
        self.page.locator("#home-lyrics-button").focus()
        self.page.keyboard.press("Enter")
        expect(self.page.locator("#home-lyric-stage")).to_have_class(re.compile(r"is-expanded"))
        self.assertTrue(self.page.evaluate("document.querySelector('[data-lyric-stage]').parentNode===document.body&&!document.querySelector('[data-lyric-stage]').inert&&document.querySelector('main').inert"))
        expect(self.page.locator("[data-stage-close]")).to_be_focused()
        self.page.locator("[data-stage-seek]").fill("160")
        self.page.wait_for_function("nativeStageAudio.currentTime>3&&nativeStageAudio.currentTime<3.6")
        expect(self.page.locator(".ls-line:not(.ls-previous)")).to_have_text("原句三")
        self.page.locator("[data-stage-toggle]").click()
        self.page.wait_for_function("nativeStageAudio.paused")
        self.page.keyboard.press("Escape")
        expect(self.page.locator("#home-lyric-stage")).not_to_have_class(re.compile(r"is-expanded"))
        self.assertFalse(self.page.evaluate("document.querySelector('main').inert"))
        expect(self.page.locator("#home-lyrics-button")).to_be_focused()
        self.assertTrue(self.page.evaluate("document.querySelector('main').contains(document.querySelector('[data-lyric-stage]'))"))
        self.page.locator("[data-stage-next]").click()
        self.page.wait_for_function("MikuMusic.getState().current.id==='2'&&MikuMusic.getState().lrcStatus==='ready'&&nativeStageAudio.currentTime>.25")
        expect(self.page.locator(".ls-line:not(.ls-previous)")).to_have_text("第二首第一句")

    def test_motion_setting_and_reduced_motion_do_not_fake_playback(self):
        self.page.emulate_media(reduced_motion="reduce")
        self.start()
        expect(self.page.locator("[data-stage-effects]")).to_have_attribute("aria-pressed", "false")
        expect(self.page.locator("[data-stage-effects]")).to_be_disabled()
        self.seek(3.2)
        expect(self.page.locator(".ls-line:not(.ls-previous)")).to_have_text("原句三")
        self.assertTrue(self.page.evaluate("[...document.querySelectorAll('.ls-char')].every(el=>getComputedStyle(el).animationName==='none')"))
        self.page.emulate_media(reduced_motion="no-preference")
        expect(self.page.locator("[data-stage-effects]")).to_be_enabled()
        self.page.locator("[data-stage-effects]").click()
        self.assertEqual(self.page.evaluate("localStorage.getItem('lyric_stage_effects')"), "0")
        expect(self.page.locator("#home-lyric-stage")).to_have_class(re.compile(r"effects-off"))
        self.assertTrue(self.page.evaluate("!nativeStageAudio.paused&&nativeStageAudio.currentTime>0"))

    def test_storage_denial_keeps_stage_controls_and_native_playback_usable(self):
        self.context.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw Error('storage blocked');}})")
        self.start()
        self.page.locator("[data-stage-effects]").click()
        expect(self.page.locator("[data-stage-effects]")).to_have_attribute("aria-pressed", "false")
        self.seek(1.2)
        expect(self.page.locator(".ls-line:not(.ls-previous)")).to_have_text("原句一")
        self.assertTrue(self.page.evaluate("nativeStageAudio instanceof HTMLAudioElement&&nativeStageAudio.currentTime>0"))

    def test_replaying_same_track_starts_a_new_performance_revision(self):
        self.start()
        self.seek(3.2)
        revision = self.page.evaluate("MikuMusic.getState().selectionRevision")
        self.page.locator("#track-list .track-item").first.click()
        self.page.wait_for_function("revision=>MikuMusic.getState().selectionRevision>revision&&MikuMusic.getState().lrcStatus==='ready'", arg=revision)
        self.page.wait_for_function("MikuMusic.getState().time>=3.05")
        expect(self.page.locator(".ls-line:not(.ls-previous)")).to_have_text("原句三")
        expect(self.page.locator("[data-stage-slash]")).to_have_class(re.compile(r"is-active"))

    def test_native_single_track_loop_performs_its_zero_timestamp_cue_again(self):
        self.zero_start = True
        self.start()
        expect(self.page.locator(".ls-line:not(.ls-previous)")).to_have_text("原句一")
        self.page.evaluate("MikuMusic.cycleMode()")
        self.assertEqual(self.page.evaluate("MikuMusic.getState().mode"), "one")
        revision = self.page.evaluate("MikuMusic.getState().selectionRevision")
        self.page.evaluate("()=>{window.stageEnded=0;nativeStageAudio.addEventListener('ended',()=>stageEnded++,{once:true});MikuMusic.seek(.975);}")
        self.page.wait_for_function("revision=>stageEnded===1&&MikuMusic.getState().selectionRevision>revision&&nativeStageAudio.currentTime<1&&!nativeStageAudio.paused", arg=revision)
        expect(self.page.locator(".ls-line:not(.ls-previous)")).to_have_text("原句一")
        self.page.wait_for_function("!MikuMusic.getState().seeking")
        self.assertTrue(self.page.evaluate("[...document.querySelectorAll('.ls-line:not(.ls-previous) .ls-char')].some(el=>getComputedStyle(el).animationName==='ls-char-arrive')"))


if __name__ == "__main__":
    unittest.main()
