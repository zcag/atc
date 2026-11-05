#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["aiohttp", "numpy", "soxr"]
# ///
"""ttsd's remote engine against a fake server: what it asks, the rate it converts from, the guard on a line that never ends,
and a server that is down not taking ttsd with it."""
import json, os, socket, subprocess, sys, threading, time, unittest, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import ttsd

RATE = 22050
TONE = (np.sin(np.arange(RATE) * 2 * np.pi * 440 / RATE) * 12000).astype("<i2").tobytes()


class Fake(BaseHTTPRequestHandler):
    asked, auth, seconds = [], [], 1

    def log_message(self, *_):
        pass

    def do_GET(self):
        body = json.dumps({"voices": ["one", {"name": "two"}]}).encode() if self.path == "/v1/audio/voices" else b"{}"
        self.send_response(200 if self.path == "/v1/audio/voices" else 404)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        Fake.asked.append((self.path, json.loads(self.rfile.read(int(self.headers["content-length"])))))
        Fake.auth.append(self.headers.get("authorization"))
        self.send_response(200)
        self.end_headers()
        try:
            for _ in range(Fake.seconds):
                self.wfile.write(TONE)
        except ConnectionError:
            pass


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Remote(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Fake.asked, Fake.auth, Fake.seconds = [], [], 1
        for k in ("TTS_REMOTE_VOICE", "TTS_REMOTE_KEY", "TTS_REMOTE_MODEL"):
            os.environ.pop(k, None)
        os.environ.update(TTS_REMOTE_URL=self.url, TTS_REMOTE_RATE=str(RATE))

    def test_asks_like_openai_and_converts_the_rate(self):
        os.environ.update(TTS_REMOTE_KEY="secret", TTS_REMOTE_MODEL="kokoro")
        synth = ttsd.engine("remote", 1)
        pcm = b"".join(ttsd.pcm(synth, "a line long enough to pass the guard", "nova", 16000))
        path, body = Fake.asked[0]
        self.assertEqual(path, "/v1/audio/speech")
        self.assertEqual({k: body[k] for k in ("model", "voice", "response_format")}, {"model": "kokoro", "voice": "nova", "response_format": "pcm"})
        self.assertEqual(Fake.auth[0], "Bearer secret")
        self.assertAlmostEqual(len(pcm) / 2 / 16000, 1, delta=.05)

    def test_voice_defaults_to_the_setting_then_the_servers_first(self):
        self.assertEqual(ttsd.engine("remote", 1).voices(), ["one", "two"])
        next(ttsd.engine("remote", 1)("text", None))
        self.assertEqual(Fake.asked[-1][1]["voice"], "one")
        os.environ["TTS_REMOTE_VOICE"] = "mine"
        next(ttsd.engine("remote", 1)("text", None))
        self.assertEqual(Fake.asked[-1][1]["voice"], "mine")

    def test_url_may_be_the_whole_route(self):
        os.environ["TTS_REMOTE_URL"] = self.url + "/v1/audio/speech/"
        next(ttsd.engine("remote", 1)("text", "x"))
        self.assertEqual(Fake.asked[-1][0], "/v1/audio/speech")

    def test_a_line_that_never_ends_stops(self):
        Fake.seconds = 60
        got = sum(map(len, ttsd.engine("remote", 1)("short", "x")))
        self.assertLess(got / RATE, 3.5)

    def test_no_url_says_so(self):
        del os.environ["TTS_REMOTE_URL"]
        with self.assertRaises(SystemExit) as e:
            ttsd.engine("remote", 1)
        self.assertIn("TTS_REMOTE_URL", str(e.exception))

    def test_server_down_keeps_ttsd_up_and_it_comes_back(self):
        port, down = free_port(), f"http://127.0.0.1:{free_port()}"
        env = {**os.environ, "TTS_REMOTE_URL": down, "TTS_REMOTE_VOICE": "x"}
        p = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(HERE), "ttsd.py"), "--engine", "remote", "--port", str(port)], env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(100):
                try:
                    r = urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/voices", timeout=1)
                    break
                except OSError:
                    self.assertIsNone(p.poll(), "ttsd exited")
                    time.sleep(.1)
            self.assertEqual(json.load(r), {"remote": ["x"]})
            req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/audio/speech", json.dumps({"input": "hi"}).encode(), {"content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=5) as r:
                self.assertEqual(r.read(), b"")
        finally:
            p.kill()
            p.wait()


class ShippedVoices(unittest.TestCase):
    def on(self, *engines):
        ttsd.ENGINES = dict.fromkeys(engines)

    def test_a_voice_can_choose_its_engine_within_the_language(self):
        self.on("pocket", "ahenk")
        self.assertEqual(ttsd.as_engine("june", "pocket"), ("ahenk", "cep"))
        self.assertEqual(ttsd.as_engine("arthur", "pocket"), ("pocket", "male_1"))

    def test_with_its_engine_missing_it_is_the_languages_default(self):
        self.on("pocket")
        self.assertEqual(ttsd.as_engine("june", "pocket"), ("pocket", None))
        self.on("piper")
        self.assertEqual(ttsd.as_engine("june", "piper"), ("piper", None))

    def test_it_never_changes_language(self):
        self.on("pocket-en", "ahenk")
        self.assertEqual(ttsd.as_engine("june", "pocket-en"), ("pocket-en", "fantine"))

    def test_any_other_voice_is_left_as_it_is(self):
        self.on("higgs", "pocket")
        self.assertEqual(ttsd.as_engine("en_x", "higgs"), ("higgs", "en_x"))
        self.assertEqual(ttsd.as_engine("june", "higgs"), ("higgs", None))
        self.assertEqual(ttsd.as_engine(None, "pocket"), ("pocket", None))


unittest.main(verbosity=0)
