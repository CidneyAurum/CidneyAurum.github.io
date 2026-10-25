"""Limbus browser regressions using a generated local WAV and native audio.

Run: python -m unittest discover -s tests -p test_limbus.py -v
Requires Playwright + Chromium. No audio methods/timers are mocked; external
requests are blocked and test audio stays in a temporary local directory.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from tempfile import TemporaryDirectory
import math
import struct
import unittest
import wave

from playwright.sync_api import expect, sync_playwright


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        try:
            super().do_GET()
        except ConnectionError:
            pass


class LimbusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(root)))
        Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"
        cls.audio_directory = TemporaryDirectory(prefix="cidney-limbus-")
        cls.audio_path = Path(cls.audio_directory.name) / "fixture-tone.wav"
        sample_rate = 8000
        with wave.open(str(cls.audio_path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            # Native PCM decoding and progression are exercised without fetching
            # copyrighted music or depending on a platform-specific codec.
            output.writeframes(b"".join(struct.pack("<h", int(300 * math.sin(2 * math.pi * 440 * i / sample_rate)))
                                        for i in range(sample_rate * 5)))
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.audio_directory.cleanup()

    def setUp(self):
        self.context = self.browser.new_context(service_workers="block", reduced_motion="reduce")
        self.context.route("**/*", lambda route: route.continue_()
                           if route.request.url.startswith(self.origin + "/") else route.abort())
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(self.origin + "/limbus.html", wait_until="load")
        self.page.evaluate("document.getElementById('limbus-audio').muted = true")

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def current_line(self):
        return self.page.locator("#lyric-area .lyric-line:not(.prev)")

    def load_audio(self):
        self.page.locator("#audio-file").set_input_files(str(self.audio_path))
        self.page.wait_for_function("document.getElementById('limbus-audio').readyState >= 1")
        state = self.page.locator("#limbus-audio").evaluate("audio => ({duration: audio.duration, src: audio.src})")
        self.assertAlmostEqual(state["duration"], 5, places=2)
        self.assertTrue(state["src"].startswith("blob:"), state)
        expect(self.page.locator("#audio-state")).to_contain_text("fixture-tone.wav")

    def seek(self, seconds):
        self.page.locator("#limbus-audio").evaluate("(audio, time) => { audio.currentTime = time; }", seconds)
        self.page.wait_for_function("time => Math.abs(document.getElementById('limbus-audio').currentTime - time) < .1", arg=seconds)

    def test_manual_three_lines_slash_finale_restart_and_reset(self):
        self.page.locator("#lyric-input").fill("第一句\n第二句\n第三句")
        self.page.locator("#btn-next").click()
        expect(self.current_line()).to_have_text("第一句")
        # Space typed inside the editor must not advance the performance.
        self.page.locator("#lyric-input").focus()
        self.page.keyboard.press("Space")
        expect(self.current_line()).to_have_text("第一句")
        self.page.locator("#lyric-input").fill("第一句\n第二句\n第三句")
        self.page.locator("#lyric-input").evaluate("node => node.blur()")
        self.page.keyboard.press("Space")
        expect(self.current_line()).to_have_text("第二句")
        self.page.locator("#limbus-stage").click()
        expect(self.current_line()).to_have_text("第三句")
        expect(self.page.locator("#lyric-area .slash")).to_have_count(1)
        self.page.locator("#btn-next").click()
        expect(self.page.locator("#lyric-area")).to_have_text("— FIN —")
        expect(self.page.locator("#lyric-area .slash")).to_have_count(0)
        self.page.wait_for_timeout(450)
        expect(self.page.locator("#lyric-area .lyric-line")).to_have_count(1)
        self.page.locator("#btn-next").click()
        expect(self.current_line()).to_have_text("第一句")
        expect(self.page.locator("#lyric-area .lyric-finale")).to_have_count(0)
        self.page.locator("#btn-reset").click()
        expect(self.page.locator("#lyric-area")).to_have_text("— LYRIC SIMULATOR —")

    def test_auto_speed_change_stop_restart_and_natural_finish(self):
        self.page.locator("#lyric-input").fill("自动一\n自动二\n自动三")
        self.page.locator("#speed-range").fill("6")
        self.page.locator("#btn-auto").click()
        expect(self.current_line()).to_have_text("自动一")
        self.page.locator("#speed-range").fill("0.5")
        expect(self.current_line()).to_have_text("自动二", timeout=1500)
        self.page.locator("#btn-auto").click()
        expect(self.page.locator("#btn-auto")).to_have_text("⏱ 自动演出")
        self.page.wait_for_timeout(650)
        expect(self.current_line()).to_have_text("自动二")
        self.page.locator("#btn-auto").click()
        expect(self.current_line()).to_have_text("自动一")
        expect(self.page.locator("#lyric-area")).to_have_text("— FIN —", timeout=2500)
        expect(self.page.locator("#btn-auto")).to_have_text("⏱ 自动演出")
        self.page.wait_for_timeout(650)
        expect(self.page.locator("#lyric-area .lyric-finale")).to_have_count(1)
        self.page.locator("#btn-auto").click()
        self.page.locator("#btn-reset").click()
        self.page.wait_for_timeout(650)
        expect(self.page.locator("#lyric-area")).to_have_text("— LYRIC SIMULATOR —")

    def test_music_sync_requires_timestamps_and_local_audio(self):
        self.page.locator("#lyric-input").fill("没有时间轴的歌词")
        self.page.locator("#btn-music").click()
        expect(self.page.locator("#audio-state")).to_contain_text("需要带 [mm:ss.xx] 时间轴")
        self.page.locator("#lyric-input").fill("[00:00.20]有时间轴")
        self.page.locator("#btn-music").click()
        expect(self.page.locator("#audio-state")).to_contain_text("选择一个本地音乐文件")
        self.assertTrue(self.page.locator("#limbus-audio").evaluate("audio => audio.paused"))

    def test_native_local_audio_progresses_and_seek_uses_lrc_timestamps(self):
        self.load_audio()
        self.page.locator("#lyric-input").fill("[ar:本地测试]\n[00:00.20]开场\n[00:01.40][00:02.40]重复\n[00:03.40]终章")
        self.page.locator("#btn-music").click()
        self.page.wait_for_function("document.getElementById('limbus-audio').currentTime > .5")
        self.assertFalse(self.page.locator("#limbus-audio").evaluate("audio => audio.paused"))
        expect(self.current_line()).to_have_text("开场")
        self.page.locator("#limbus-audio").evaluate("audio => audio.pause()")
        self.seek(1.8)
        expect(self.current_line()).to_have_text("重复")
        self.seek(2.7)
        expect(self.current_line()).to_have_text("重复")
        expect(self.page.locator("#lyric-area .slash")).to_have_count(1)
        self.seek(3.6)
        expect(self.current_line()).to_have_text("终章")
        expect(self.page.locator("#lyric-area .slash")).to_have_count(0)
        self.seek(.5)
        expect(self.current_line()).to_have_text("开场")
        self.seek(0)
        # Seeking back into the intro must not leave a future lyric visible.
        expect(self.page.locator("#lyric-area .lyric-line:not(.prev)")).to_have_count(0)
        expect(self.page.locator("#lyric-area .slash")).to_have_count(0)
        expect(self.page.locator("#lyric-area")).to_have_text("— LYRIC SIMULATOR —")

    def test_native_audio_end_restart_and_reset_stay_stopped(self):
        self.load_audio()
        self.page.locator("#lyric-input").fill("[00:00.00]同步一\n[00:00.60]同步二\n[00:01.10]同步三")
        self.page.locator("#btn-music").click()
        expect(self.current_line()).to_have_text("同步一")
        self.seek(4.8)
        self.page.wait_for_function("document.getElementById('limbus-audio').ended")
        expect(self.page.locator("#lyric-area")).to_have_text("— FIN —")
        self.page.wait_for_timeout(450)
        expect(self.page.locator("#lyric-area .lyric-finale")).to_have_count(1)
        self.page.locator("#btn-music").click()
        self.page.wait_for_function("document.getElementById('limbus-audio').currentTime > .1 && !document.getElementById('limbus-audio').paused")
        expect(self.current_line()).to_have_text("同步一")
        self.page.locator("#btn-reset").click()
        self.assertTrue(self.page.locator("#limbus-audio").evaluate("audio => audio.paused"))
        self.page.wait_for_timeout(450)
        expect(self.page.locator("#lyric-area")).to_have_text("— LYRIC SIMULATOR —")


if __name__ == "__main__":
    unittest.main()
