"""Native browser playback with generated WAV fixtures, independent of public APIs.

Run: python -m unittest discover -s tests -p test_music.py
These tests verify transport/control logic; they do not certify public services.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from threading import Thread
import json
import re
import unittest
import wave
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright, expect


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class MusicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(root)))
        Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"
        stream = BytesIO()
        with wave.open(stream, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(b"\0\0" * 8000 * 30)
        cls.wav = stream.getvalue()
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.context = self.browser.new_context(reduced_motion="reduce", viewport={"width": 1440, "height": 1000})
        self.context.add_init_script("window.testAudios=[];const NativeAudio=window.Audio;window.Audio=function(...args){const a=new NativeAudio(...args);testAudios.push(a);return a;};")
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.set_default_timeout(7000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.bad_stream = False

    def tearDown(self):
        self.context.close()

    def route(self, route):
        url = route.request.url
        if url.endswith("/data/playlist.json"):
            route.fulfill(content_type="application/json", body=json.dumps({"playlist": [
                {"id": str(i + 1), "name": f"Fixture {i + 1}", "artist": "Local test", "pic": ""} for i in range(3)
            ]}))
        elif "type=url" in url or "/song/media/outer/" in url:
            if self.bad_stream:
                route.fulfill(content_type="text/html", body=b"not audio")
            else:
                requested = re.match(r"bytes=(\d+)-(\d*)", route.request.headers.get("range", ""))
                start = int(requested[1]) if requested else 0
                end = int(requested[2]) if requested and requested[2] else len(self.wav) - 1
                headers = {"Accept-Ranges": "bytes"}
                if requested:
                    headers["Content-Range"] = f"bytes {start}-{end}/{len(self.wav)}"
                route.fulfill(status=206 if requested else 200, content_type="audio/wav", headers=headers, body=self.wav[start:end + 1])
        elif "lrclib.net/api/search" in url:
            query = parse_qs(urlsplit(url).query)
            route.fulfill(content_type="application/json", body=json.dumps([{"trackName": query.get("track_name", [""])[0], "artistName": "Local test", "duration": 30, "syncedLyrics": "[00:00]First line\n[00:05]Second line"}]))
        elif url.startswith(self.origin + "/"):
            route.continue_()
        else:
            route.abort()

    def start(self):
        self.page.goto(self.origin + "/index.html")
        expect(self.page.locator("#track-list .track-item")).to_have_count(3)
        self.page.locator("#track-list .track-item").first.click()
        self.page.wait_for_function("MikuMusic.getState().playing && MikuMusic.getState().time > .1")

    def test_controls_delete_queue_and_pjax_keep_native_audio(self):
        self.start()
        self.page.locator("#gp-toggle").focus()
        self.page.keyboard.press("Space")
        self.page.wait_for_function("!MikuMusic.getState().playing && testAudios[0].paused")
        self.page.keyboard.press("Space")
        self.page.wait_for_function("MikuMusic.getState().playing && !testAudios[0].paused")
        self.page.locator("#gp-progress").focus()
        before = self.page.evaluate("MikuMusic.getState().time")
        self.page.keyboard.press("ArrowRight")
        self.assertGreaterEqual(self.page.evaluate("MikuMusic.getState().time"), before + 4.8)
        self.page.locator("#gp-queue-btn").click()
        self.page.locator('[data-del="1"]').click()
        expect(self.page.locator("#track-list .track-item")).to_have_count(2)
        self.page.locator("#gp-qsearch").fill("Fixture 1")
        expect(self.page.locator(".gp-qrow")).to_have_count(1)
        self.page.keyboard.press("Escape")
        expect(self.page.locator("#gp-queue-btn")).to_be_focused()
        self.page.locator("#gp-queue-btn").click()
        expect(self.page.locator(".gp-qrow")).to_have_count(2)
        self.page.keyboard.press("Escape")
        self.page.evaluate("window.savedTestAudio=testAudios[0]")
        before = self.page.evaluate("MikuMusic.getState().time")
        self.page.locator('.nav-link[href$="/blog.html"]').click()
        self.page.wait_for_url("**/blog.html")
        self.page.wait_for_function("MikuMusic.getState().time > " + str(before))
        self.assertTrue(self.page.evaluate("testAudios[0] === window.savedTestAudio && MikuMusic.getState().playing"))
        self.page.locator('.nav-link[href$="/index.html"]').click()
        self.page.wait_for_url("**/index.html")
        expect(self.page.locator(".js-mm-toggle")).to_have_attribute("aria-label", "暂停歌单")
        self.assertEqual(self.errors, [])

    def test_local_file_and_playlist_yield_to_each_other(self):
        self.start()
        self.page.locator('[data-pane="ambient"]').click()
        self.page.locator("#player-file-input").set_input_files({"name": "local-fixture.wav", "mimeType": "audio/wav", "buffer": self.wav})
        self.page.wait_for_function("Ambient.isRunning() && !MikuMusic.getState().playing")
        expect(self.page.locator(".js-player-title").first).to_have_text("local-fixture")
        self.page.locator('[data-pane="netease"]').click()
        self.page.locator(".js-mm-toggle").click()
        self.page.wait_for_function("MikuMusic.getState().playing && !Ambient.isRunning()")
        self.page.locator('[data-pane="ambient"]').click()
        self.page.locator(".js-play-toggle").first.click()
        self.page.wait_for_function("Ambient.isRunning() && !MikuMusic.getState().playing")
        self.assertEqual(self.errors, [])

    def test_visible_covers_do_not_flood_music_host_or_restart_on_pause(self):
        cover_requests = []
        tracks = [{"id": str(i + 1), "name": f"Fixture {i + 1}", "artist": "Local test", "pic": f"https://covers.example/{i + 1}.svg"} for i in range(107)]
        self.page.route("**/data/playlist.json", lambda route: route.fulfill(json={"playlist": tracks}))

        def cover(route):
            cover_requests.append(route.request.url)
            route.fulfill(content_type="image/svg+xml", body='<svg xmlns="http://www.w3.org/2000/svg" width="31" height="31"><rect width="31" height="31" fill="#333"/></svg>')

        self.page.route("https://covers.example/**", cover)
        self.page.goto(self.origin + "/index.html")
        expect(self.page.locator("#track-list .track-item")).to_have_count(107)
        self.page.wait_for_function("document.querySelector('#track-list img[src]')")
        self.assertLessEqual(len(cover_requests), 12, "Offscreen covers must not occupy the audio host's connections")
        self.page.evaluate("window.firstTrackCover=document.querySelector('#track-list img')")
        self.page.locator("#track-list .track-item").first.click()
        self.page.wait_for_function("MikuMusic.getState().playing && MikuMusic.getState().time>.1")
        self.page.locator("#gp-toggle").click()
        self.page.wait_for_function("!MikuMusic.getState().playing")
        self.assertTrue(self.page.evaluate("firstTrackCover===document.querySelector('#track-list img')"))
        self.page.locator("#track-list").evaluate("node=>node.scrollTop=node.scrollHeight")
        self.page.wait_for_function("document.querySelector('#track-list .track-item:last-child img')?.getAttribute('src')?.endsWith('/107.svg')")
        self.assertLess(len(cover_requests), 24)
        self.assertEqual(self.errors, [])

    def test_invalid_file_stops_cleanly_and_explains_failure(self):
        self.page.goto(self.origin + "/index.html")
        self.page.locator('[data-pane="ambient"]').click()
        self.page.locator("#player-file-input").set_input_files({"name": "broken.mp3", "mimeType": "audio/mpeg", "buffer": b"invalid audio"})
        expect(self.page.locator("#gp-toast")).to_contain_text("本地音频无法播放")
        self.assertFalse(self.page.evaluate("Ambient.isRunning()"))
        self.assertEqual(self.errors, [])

    def test_lyrics_keyboard_and_canceled_seek_drag_remain_usable(self):
        self.start()
        progress = self.page.locator("#gp-progress")
        progress.dispatch_event("pointerdown", {"pointerId": 1, "clientX": progress.bounding_box()["x"] + 20})
        progress.dispatch_event("pointercancel", {"pointerId": 1})
        progress.focus()
        self.page.keyboard.press("ArrowRight")
        self.assertGreater(int(progress.get_attribute("aria-valuenow")), 10)
        self.page.locator("#gp-lyric-btn").click()
        expect(self.page.locator(".gp-lrc-line")).to_have_count(2)
        self.page.locator(".gp-lrc-line").last.focus()
        self.page.keyboard.press("Enter")
        self.assertGreaterEqual(self.page.evaluate("MikuMusic.getState().time"), 5)
        self.page.keyboard.press("Escape")
        expect(self.page.locator("#gp-lyric")).to_be_hidden()
        expect(self.page.locator("#gp-lyric-btn")).to_be_focused()
        self.assertEqual(self.errors, [])

    def test_failed_stream_click_does_not_leave_unhandled_rejection(self):
        self.bad_stream = True
        self.page.goto(self.origin + "/index.html")
        expect(self.page.locator("#track-list .track-item")).to_have_count(3)
        self.page.locator("#track-list .track-item").first.click()
        expect(self.page.locator("#gp-toast")).to_contain_text("播放失败")
        self.assertFalse(self.page.evaluate("MikuMusic.getState().playing"))
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
