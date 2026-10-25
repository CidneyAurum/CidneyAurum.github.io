"""Real short character WAV playback; no system TTS or paid API is used."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import unittest

from playwright.sync_api import sync_playwright, expect


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        try:
            super().do_GET()
        except ConnectionError:
            pass


class MikuVoiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(root)))
        Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.origin = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.context = self.browser.new_context(service_workers='block')
        self.context.route('**/*', lambda r: r.continue_() if r.request.url.startswith(self.origin + '/') else r.abort())
        self.page = self.context.new_page()
        self.page.set_default_timeout(6000)
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route(self.origin + '/__voice_fixture', lambda r: r.fulfill(content_type='text/html; charset=utf-8', body='''
          <meta charset="utf-8"><button id="greet" onclick="window.result=MikuVoice.play('greet',{force:true})">问候</button>
          <button id="identity" onclick="window.result=MikuVoice.play('identity',{force:true})">介绍</button>
          <script src="/js/miku-voice.js?v=voice-fixture"></script>'''))
        self.page.add_init_script('''
          window.__audioCount=0; window.__systemSpeech=0;
          const NativeAudio=window.Audio;
          window.Audio=function(...args){window.__audioCount++; return window.__voiceAudio=new NativeAudio(...args)};
          window.Audio.prototype=NativeAudio.prototype;
          window.SpeechSynthesisUtterance=function(){window.__systemSpeech++;throw Error('System TTS forbidden')};
        ''')

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def boot(self):
        self.page.goto(self.origin + '/__voice_fixture', wait_until='domcontentloaded')
        self.page.evaluate('MikuVoice.ready')

    def test_native_miku_clip_and_audio_driven_mouth_without_system_tts(self):
        self.boot()
        self.page.click('#greet')
        self.page.wait_for_function('MikuVoice.getState().playing && window.__voiceAudio.currentTime > .15')
        self.page.wait_for_function('MikuVoice.getState().mouth > .02')
        state = self.page.evaluate('({voice:MikuVoice.getState(),time:__voiceAudio.currentTime,duration:__voiceAudio.duration,src:__voiceAudio.src,speech:__systemSpeech})')
        self.assertGreater(state['duration'], 2)
        self.assertIn('greet.wav?v=voice-fixture', state['src'])
        self.assertEqual(state['voice']['ja'], '会場のみんな、こんにちはー！')
        self.assertEqual(state['speech'], 0)
        self.page.evaluate('MikuVoice.stop()')
        self.assertFalse(self.page.evaluate('MikuVoice.getState().playing'))
        self.assertEqual(self.page.evaluate('MikuVoice.getState().mouth'), 0)

    def test_finish_and_newer_clip_cancel_previous_playback(self):
        self.boot()
        self.page.click('#greet')
        self.page.wait_for_function('MikuVoice.getState().playing')
        self.page.evaluate('() => { window.firstResult=window.result; }')
        self.page.click('#identity')
        self.assertFalse(self.page.evaluate('window.firstResult'))
        self.assertTrue(self.page.evaluate('window.result'))
        self.assertEqual(self.page.evaluate('MikuVoice.getState().event'), 'identity')
        self.assertFalse(self.page.evaluate('MikuVoice.getState().playing'))
        self.assertEqual(self.page.evaluate('MikuVoice.getState().mouth'), 0)

    def test_muted_voice_stays_muted_and_long_chat_text_does_not_make_audio(self):
        self.boot()
        self.page.evaluate("MikuVoice.setEnabled(false)")
        self.page.click('#greet')
        self.assertFalse(self.page.evaluate('window.result'))
        self.assertEqual(self.page.evaluate('window.__audioCount'), 0)
        self.page.evaluate("MikuVoice.setEnabled(true)")
        self.assertFalse(self.page.evaluate("MikuVoice.react('reply',{text:'长回复'.repeat(50)})"))
        self.assertEqual(self.page.evaluate('window.__audioCount'), 0)
        self.page.reload()
        self.assertTrue(self.page.evaluate('MikuVoice.isEnabled()'))

    def test_failed_audio_is_recoverable_and_does_not_fall_back_to_system_speech(self):
        self.page.route('**/assets/voice/miku/greet.wav*', lambda r: r.fulfill(status=404, body='missing'))
        self.boot()
        self.page.click('#greet')
        self.assertFalse(self.page.evaluate('window.result'))
        self.assertIn('重试', self.page.evaluate('MikuVoice.getState().error'))
        self.assertEqual(self.page.evaluate('__systemSpeech'), 0)
        self.page.unroute('**/assets/voice/miku/greet.wav*')
        self.page.click('#greet')
        self.page.wait_for_function('MikuVoice.getState().playing && __voiceAudio.currentTime > .1')

    def test_hide_stops_voice_and_playing_music_suppresses_unrequested_reactions(self):
        self.boot()
        self.page.evaluate('window.MikuMusic={getState:()=>({playing:true})}')
        self.assertFalse(self.page.evaluate("MikuVoice.react('reply',{text:'谢谢你'})"))
        self.assertEqual(self.page.evaluate('__audioCount'), 0)
        self.page.click('#greet')
        self.page.wait_for_function('MikuVoice.getState().playing')
        self.page.evaluate("document.dispatchEvent(new CustomEvent('miku:visibility',{detail:{visible:false}}))")
        self.assertFalse(self.page.evaluate('window.result'))
        self.assertTrue(self.page.evaluate('__voiceAudio.paused'))


if __name__ == '__main__':
    unittest.main()
