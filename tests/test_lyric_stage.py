"""Whole-page background lyric regressions using native HTMLAudio + generated WAV/LRC fixtures.

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
        self.lyric_override = None
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
        lyrics = LRC_TWO if name == "Stage Two" else LRC_ONE
        if self.zero_start:
            lyrics = lyrics.replace("[00:01.00]", "[00:00.00]")
        if self.lyric_override is not None:
            lyrics = self.lyric_override
        return {"trackName": name, "artistName": "Stage test", "duration": 20,
                "syncedLyrics": lyrics}

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
        expect(self.page.locator("body > #lyric-backdrop")).to_have_count(1)
        expect(self.page.locator("#home-lyric-stage,[data-lyric-stage]")).to_have_count(0)

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

    def current_rows(self):
        return self.page.locator(".bg-lyric-cue.is-current .bg-lyric-row")

    def test_idle_and_intro_have_an_empty_transparent_click_through_layer(self):
        self.boot()
        expect(self.page.locator("#lyric-backdrop")).to_be_hidden()
        expect(self.page.locator("[data-bg-lines]")).to_be_empty()
        self.assertTrue(self.page.evaluate("""()=>{const layer=document.querySelector('#lyric-backdrop'),style=getComputedStyle(layer);return layer.parentNode===document.body&&layer.getAttribute('aria-hidden')==='true'&&style.pointerEvents==='none'&&style.backgroundColor==='rgba(0, 0, 0, 0)'&&!document.querySelector('[inert]')&&!layer.querySelector('[role=dialog]');}"""))
        self.page.locator("#track-list .track-item").first.click()
        self.page.wait_for_function("MikuMusic.getState().lrcStatus==='ready'&&MikuMusic.getState().time>.05")
        expect(self.page.locator("#lyric-backdrop")).to_have_attribute("data-lyric-state", "intro")
        expect(self.page.locator("[data-bg-lines]")).to_be_empty()

    def test_native_time_groups_translation_moves_cues_and_expires_ghost_in_place(self):
        self.start()
        expect(self.current_rows()).to_have_text(["原句一", "Translation one"])
        first = self.page.locator(".bg-lyric-cue.is-current").evaluate("el=>({left:el.style.left,top:el.style.top,position:el.dataset.position})")
        self.page.wait_for_timeout(120)
        self.assertEqual(first, self.page.locator(".bg-lyric-cue.is-current").evaluate("el=>({left:el.style.left,top:el.style.top,position:el.dataset.position})"))
        expect(self.current_rows()).to_have_text(["原句二", "Translation two"])
        ghost = self.page.locator(".bg-lyric-cue.is-ghost")
        expect(ghost).to_have_count(1)
        self.assertEqual(first, ghost.evaluate("el=>({left:el.style.left,top:el.style.top,position:el.dataset.position})"))
        self.assertNotEqual(first["position"], self.page.locator(".bg-lyric-cue.is-current").get_attribute("data-position"))
        self.assertTrue(self.page.locator(".is-current .bg-lyric-char").first.evaluate("el=>getComputedStyle(el).animationName.includes('bg-lyric-reveal')&&getComputedStyle(el).animationName.includes('bg-lyric-shiver')"))
        expect(ghost).to_have_count(0, timeout=900)
        self.assertLessEqual(self.page.evaluate("LyricStage.getState().ghosts"), 3)

    def test_fractional_reveal_delay_leaves_every_glyph_visible_after_natural_playback(self):
        # A 5.75s gap and 17 glyphs reproduce the public-song fractional delay
        # that left finished steps(1,end) animations just short of opacity 1.
        lyric = "原生播放 小数逐字延迟结束后全可见"
        self.assertEqual(len(lyric), 17)
        self.lyric_override = f"[00:00.10]{lyric}\n[00:05.85]下一句"
        self.start()
        expect(self.current_rows()).to_have_text([lyric])
        glyphs = self.page.locator(".is-current .bg-lyric-char")
        expect(glyphs).to_have_count(17)
        interval = self.page.locator(".bg-lyric-cue.is-current").evaluate("el=>parseFloat(el.style.getPropertyValue('--reveal-ms'))")
        self.assertAlmostEqual(interval, 1750 / 17)
        self.assertTrue(glyphs.first.evaluate("el=>getComputedStyle(el).animationName.includes('bg-lyric-reveal')"))
        self.assertEqual(glyphs.last.evaluate("el=>getComputedStyle(el).opacity"), "0")
        # Let the native audio clock advance; seeking would skip the animation
        # and conceal the rendering defect this regression needs to catch.
        self.page.wait_for_function("nativeStageAudio.currentTime>=2.05")
        self.assertLess(self.page.evaluate("nativeStageAudio.currentTime"), 3)
        self.assertFalse(self.page.evaluate("nativeStageAudio.paused"))
        self.assertEqual(glyphs.last.evaluate("el=>getComputedStyle(el).opacity"), "1")
        self.assertTrue(glyphs.evaluate_all("els=>els.every(el=>getComputedStyle(el).opacity==='1')"))

    def test_pause_freezes_readable_current_and_resumes_without_replaying(self):
        self.start()
        expect(self.current_rows()).to_have_text(["原句二", "Translation two"])
        self.page.evaluate("window.savedBackgroundCue=document.querySelector('.bg-lyric-cue.is-current')")
        self.page.locator("#gp-toggle").click()
        self.page.wait_for_function("nativeStageAudio.paused")
        expect(self.page.locator("#lyric-backdrop")).to_have_class(re.compile(r"is-paused"))
        expect(self.page.locator(".is-ghost")).to_have_count(0)
        self.assertTrue(self.page.evaluate("[...document.querySelectorAll('.is-current .bg-lyric-char')].every(el=>getComputedStyle(el).opacity==='1'&&getComputedStyle(el).animationName==='none')"))
        frozen_time = self.page.evaluate("nativeStageAudio.currentTime")
        self.page.wait_for_timeout(150)
        self.assertEqual(frozen_time, self.page.evaluate("nativeStageAudio.currentTime"))
        self.page.locator("#gp-toggle").click()
        self.page.wait_for_function("!nativeStageAudio.paused")
        self.assertTrue(self.page.evaluate("savedBackgroundCue===document.querySelector('.bg-lyric-cue.is-current')"))
        self.assertTrue(self.page.evaluate("[...document.querySelectorAll('.is-current .bg-lyric-char')].every(el=>getComputedStyle(el).animationName==='none')"))

    def test_mobile_long_bilingual_cue_and_resize_keep_rotated_glyphs_in_view(self):
        self.lyric_override = "[00:00.00]" + "较长的原文歌词也需要保持倾斜排列而且不超出屏幕边界" * 2 + "\n[00:00.00]" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ" * 4 + "\n[00:10.00]下一句"
        self.page.set_viewport_size({"width": 390, "height": 700})
        self.start()
        self.page.evaluate("MikuMusic.toggle()")
        self.page.wait_for_function("nativeStageAudio.paused")
        expect(self.current_rows()).to_have_count(2)
        def assert_glyphs_inside():
            self.assertTrue(self.page.evaluate("[...document.querySelectorAll('.is-current .bg-lyric-char')].every(el=>{const rect=el.getBoundingClientRect();return rect.left>=2&&rect.top>=2&&rect.right<=innerWidth-2&&rect.bottom<=innerHeight-2})"))
        assert_glyphs_inside()
        self.page.set_viewport_size({"width": 844, "height": 390})
        self.page.wait_for_timeout(80)
        assert_glyphs_inside()

    def test_real_seek_clears_ghosts_and_blank_interlude_and_intro_clear_all_words(self):
        self.start()
        self.seek(3.2)
        expect(self.current_rows()).to_have_text(["原句三", "Translation three"])
        self.assertTrue(self.page.evaluate("[...document.querySelectorAll('.is-current .bg-lyric-char')].every(el=>getComputedStyle(el).animationName==='none')"))
        self.seek(1.2)
        expect(self.current_rows()).to_have_text(["原句一", "Translation one"])
        expect(self.page.locator(".is-ghost")).to_have_count(0)
        self.seek(4.2)
        expect(self.page.locator("#lyric-backdrop")).to_have_attribute("data-lyric-state", "interlude")
        expect(self.page.locator("[data-bg-lines]")).to_be_empty()
        expect(self.page.locator("#lyric-backdrop")).to_be_hidden()
        self.seek(.1)
        expect(self.page.locator("#lyric-backdrop")).to_have_attribute("data-lyric-state", "intro")
        expect(self.page.locator("[data-bg-lines]")).to_be_empty()

    def test_track_change_clears_old_words_during_actual_lyrics_request(self):
        self.start()
        self.seek(1.2)
        expect(self.current_rows()).to_have_text(["原句一", "Translation one"])
        self.hold_for.add("Stage Two")
        self.page.locator("#track-list .track-item").nth(1).click()
        expect(self.page.locator("#lyric-backdrop")).to_have_attribute("data-lyric-state", "loading")
        expect(self.page.locator("[data-bg-lines]")).to_be_empty()
        self.page.wait_for_function("MikuMusic.getState().current.id==='2'&&MikuMusic.getState().time>.25")
        self.assertTrue(self.held)
        route, name = self.held.pop(0)
        self.hold_for.clear()
        route.fulfill(json=[self.lyric_record(name)], headers={"Access-Control-Allow-Origin": "*"})
        expect(self.current_rows()).to_have_text(["第二首第一句", "Second track translation"])
        self.assertNotIn("原句", self.page.locator("[data-bg-lines]").inner_text())

    def test_unavailable_leaves_background_empty_and_player_retry_finds_lyrics(self):
        self.start(2, ready=False)
        self.page.wait_for_function("MikuMusic.getState().lrcStatus==='unavailable'")
        expect(self.page.locator("#lyric-backdrop")).to_have_attribute("data-lyric-state", "unavailable")
        expect(self.page.locator("[data-bg-lines]")).to_be_empty()
        self.assertNotIn("纯音乐", self.page.locator("#lyric-backdrop-status").inner_text())
        expect(self.page.locator("#lyric-backdrop-retry")).to_be_visible()
        self.missing_available = True
        self.page.locator("#lyric-backdrop-retry").click()
        self.page.wait_for_function("MikuMusic.getState().lrcStatus==='ready'")
        self.seek(1.2)
        expect(self.current_rows()).to_have_text(["原句一", "Translation one"])
        expect(self.page.locator("#lyric-backdrop-retry")).to_be_hidden()

    def test_pjax_keeps_one_body_layer_subscription_and_native_audio_with_foreground_usable(self):
        self.start()
        self.seek(5.2)
        self.page.evaluate("window.savedNativeStageAudio=nativeStageAudio;window.savedBackgroundLayer=document.querySelector('#lyric-backdrop');LyricStage.mount();LyricStage.mount()")
        self.page.locator('.nav-link[href$="blog.html"]').click()
        self.page.wait_for_url("**/blog.html")
        self.assertTrue(self.page.evaluate("savedBackgroundLayer===document.querySelector('body > #lyric-backdrop')&&savedNativeStageAudio===nativeStageAudio&&!nativeStageAudio.paused&&LyricStage.getState().mounted"))
        self.assertEqual(self.page.evaluate("stageSubscriptions"), {"active": 1, "created": 1})
        expect(self.current_rows()).to_have_text(["第四句"])
        self.assertTrue(self.page.evaluate("!document.querySelector('[inert]')&&getComputedStyle(document.body).overflowY!=='hidden'&&getComputedStyle(document.documentElement).overflowY!=='hidden'"))
        self.page.locator('.nav-link[href$="index.html"]').click()
        self.page.wait_for_url("**/index.html")
        expect(self.page.locator("body > #lyric-backdrop")).to_have_count(1)
        self.assertEqual(self.page.evaluate("stageSubscriptions"), {"active": 1, "created": 1})
        self.assertEqual(self.page.evaluate("stageAudios.filter(audio=>audio.currentSrc.includes('type=url')).length"), 1)
        self.page.evaluate("window.scrollTo(0,document.documentElement.scrollHeight)")
        self.page.wait_for_function("scrollY>0")

    def test_keyboard_and_global_toggles_do_not_pause_music_or_take_focus(self):
        self.start()
        self.seek(5.2)
        self.page.locator("#home-lyrics-button").focus()
        self.page.keyboard.press("Enter")
        expect(self.page.locator("#home-lyrics-button")).to_have_attribute("aria-pressed", "false")
        expect(self.page.locator("#home-lyrics-button")).to_be_focused()
        expect(self.page.locator("#lyric-backdrop")).to_be_hidden()
        expect(self.page.locator("[data-bg-lines]")).to_be_empty()
        self.assertTrue(self.page.evaluate("!nativeStageAudio.paused&&!document.querySelector('[inert]')"))
        self.assertEqual(self.page.evaluate("localStorage.getItem('lyric_background_enabled')"), "0")
        self.page.locator("#gp-background-btn").click()
        expect(self.page.locator("#gp-background-btn")).to_have_attribute("aria-pressed", "true")
        expect(self.current_rows()).to_have_text(["第四句"])
        self.assertTrue(self.page.evaluate("!nativeStageAudio.paused"))

    def test_reduced_motion_and_effects_setting_keep_native_playback_static(self):
        self.page.emulate_media(reduced_motion="reduce")
        self.start()
        self.seek(3.2)
        expect(self.current_rows()).to_have_text(["原句三", "Translation three"])
        expect(self.page.locator("#lyric-backdrop")).to_have_class(re.compile(r"effects-off"))
        self.assertTrue(self.page.evaluate("[...document.querySelectorAll('.bg-lyric-char')].every(el=>getComputedStyle(el).animationName==='none')"))
        self.page.emulate_media(reduced_motion="no-preference")
        self.page.evaluate("LyricStage.setEffects(false)")
        self.assertEqual(self.page.evaluate("localStorage.getItem('lyric_background_effects')"), "0")
        expect(self.page.locator("#lyric-backdrop")).to_have_class(re.compile(r"effects-off"))
        self.assertTrue(self.page.evaluate("!nativeStageAudio.paused&&nativeStageAudio.currentTime>0"))

    def test_storage_denial_keeps_background_controls_and_native_playback_usable(self):
        self.context.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw Error('storage blocked');}})")
        self.start()
        self.page.locator("#home-lyrics-button").click()
        expect(self.page.locator("#home-lyrics-button")).to_have_attribute("aria-pressed", "false")
        self.page.locator("#home-lyrics-button").click()
        self.seek(1.2)
        expect(self.current_rows()).to_have_text(["原句一", "Translation one"])
        self.assertTrue(self.page.evaluate("nativeStageAudio instanceof HTMLAudioElement&&!nativeStageAudio.paused&&nativeStageAudio.currentTime>0"))

    def test_retired_panel_effects_preference_does_not_disable_new_background(self):
        self.context.add_init_script("localStorage.setItem('lyric_stage_effects','0')")
        self.start()
        expect(self.current_rows()).to_have_text(["原句一", "Translation one"])
        self.assertTrue(self.page.evaluate("LyricStage.getState().effects"))
        expect(self.page.locator("#lyric-backdrop")).not_to_have_class(re.compile(r"effects-off"))
        self.assertTrue(self.page.locator(".is-current .bg-lyric-char").first.evaluate("el=>getComputedStyle(el).animationName.includes('bg-lyric-shiver')"))

    def test_replaying_same_track_reveals_first_cue_for_a_new_revision(self):
        self.start()
        self.seek(3.2)
        revision = self.page.evaluate("MikuMusic.getState().selectionRevision")
        self.page.locator("#track-list .track-item").first.click()
        self.page.wait_for_function("revision=>MikuMusic.getState().selectionRevision>revision&&MikuMusic.getState().lrcStatus==='ready'", arg=revision)
        expect(self.current_rows()).to_have_text(["原句一", "Translation one"])
        self.assertTrue(self.page.locator(".is-current .bg-lyric-char").first.evaluate("el=>getComputedStyle(el).animationName.includes('bg-lyric-reveal')"))
        expect(self.page.locator(".is-ghost")).to_have_count(0)

    def test_native_single_track_loop_reveals_zero_timestamp_cue_again(self):
        self.zero_start = True
        self.start()
        expect(self.current_rows()).to_have_text(["原句一", "Translation one"])
        self.page.evaluate("MikuMusic.cycleMode()")
        self.assertEqual(self.page.evaluate("MikuMusic.getState().mode"), "one")
        revision = self.page.evaluate("MikuMusic.getState().selectionRevision")
        self.page.evaluate("()=>{window.stageEnded=0;nativeStageAudio.addEventListener('ended',()=>stageEnded++,{once:true});MikuMusic.seek(.975);}")
        self.page.wait_for_function("revision=>stageEnded===1&&MikuMusic.getState().selectionRevision>revision&&nativeStageAudio.currentTime<1&&!nativeStageAudio.paused", arg=revision)
        expect(self.current_rows()).to_have_text(["原句一", "Translation one"])
        self.page.wait_for_function("!MikuMusic.getState().seeking")
        self.assertTrue(self.page.locator(".is-current .bg-lyric-char").first.evaluate("el=>getComputedStyle(el).animationName.includes('bg-lyric-reveal')"))


if __name__ == "__main__":
    unittest.main()
