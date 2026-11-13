"""The service's HTTP side and its one-thread engine, with the fake backend.

No MLX and no model: what is checked here is everything around the model, which
is what a mistake in would be found on a Mac with nothing to say what broke.

    python3 -m unittest discover -s gpu
"""

import json
import os
import struct
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import mac_voice  # noqa: E402


def quiet(_m):
    pass


class Recording(mac_voice.FakeBackend):
    """Notes which thread rendered, and whether two renders ever overlapped."""

    def __init__(self, ms=0):
        mac_voice.FakeBackend.__init__(self, ms)
        self.threads = set()
        self.now = 0
        self.peak = 0
        self.guard = threading.Lock()
        self.loaded_on = threading.current_thread().name

    def render(self, text, voice):
        with self.guard:
            self.now += 1
            self.peak = max(self.peak, self.now)
            self.threads.add(threading.current_thread().name)
        try:
            return mac_voice.FakeBackend.render(self, text, voice)
        finally:
            with self.guard:
                self.now -= 1


def start(backend):
    engine = mac_voice.Engine(lambda: backend, quiet)
    engine.ready.wait()
    server = mac_voice.serve(engine, "127.0.0.1", 0, quiet)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return engine, server, "http://127.0.0.1:%d" % server.server_address[1]


def post(base, body, raw=False):
    data = body if raw else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(base + "/render", data=data, method="POST",
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.backend = Recording()
        self.engine, self.server, self.base = start(self.backend)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.engine.stop()

    def test_a_render_is_raw_float32_with_its_rate(self):
        status, headers, body = post(self.base, {"text": "Hello there, friend.", "voice": "af_heart"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["x-rate"], "24000")
        self.assertEqual(headers["content-type"], "application/octet-stream")
        self.assertEqual(len(body) % 4, 0, "whole samples")
        samples = struct.unpack("<%df" % (len(body) // 4), body)
        self.assertGreater(len(samples), 24000 * 0.3, "at least the shortest clip")
        self.assertTrue(all(-1.0 <= s <= 1.0 for s in samples))
        self.assertTrue(any(abs(s) > 0.1 for s in samples), "and it is not silence")

    def test_bad_requests_are_refused_with_a_reason(self):
        cases = [
            ({"text": "", "voice": "af_heart"}, 400),
            ({"text": "   ", "voice": "af_heart"}, 400),
            ({"text": "x" * 4001, "voice": "af_heart"}, 400),
            ({"text": 7, "voice": "af_heart"}, 400),
            ({"text": "Hello.", "voice": "../../etc"}, 400),
            ({"text": "Hello.", "voice": ""}, 400),
        ]
        for body, want in cases:
            status, _, out = post(self.base, body)
            self.assertEqual(status, want, body)
            self.assertIn("error", json.loads(out))
        self.assertEqual(post(self.base, b"not json", raw=True)[0], 400)
        self.assertEqual(post(self.base, b"[1, 2]", raw=True)[0], 400)

    def test_a_failing_voice_is_a_500_that_says_why_and_the_next_render_works(self):
        status, _, out = post(self.base, {"text": "BOOM", "voice": "af_heart"})
        self.assertEqual(status, 500)
        self.assertIn("asked to fail", json.loads(out)["error"])
        self.assertEqual(post(self.base, {"text": "Fine.", "voice": "af_heart"})[0], 200)

    def test_unknown_paths_are_404(self):
        req = urllib.request.Request(self.base + "/nope")
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(cm.exception.code, 404)

    def test_status_counts_what_it_has_made(self):
        for _ in range(3):
            post(self.base, {"text": "Hello there.", "voice": "af_heart"})
        with urllib.request.urlopen(self.base + "/status", timeout=5) as r:
            s = json.loads(r.read())
        self.assertTrue(s["ready"])
        self.assertEqual(s["rendered"], 3)
        self.assertGreater(s["audioSeconds"], 0.8)
        self.assertEqual(s["backend"], "fake")
        self.assertEqual(s["rate"], 24000)


class OneThreadTest(unittest.TestCase):
    def test_every_render_runs_on_the_thread_that_loaded_the_model(self):
        """MLX streams belong to the thread that made them, so this is the rule."""
        loaded = []

        def factory():
            loaded.append(threading.current_thread().name)
            return Recording(ms=15)

        engine = mac_voice.Engine(factory, quiet)
        engine.ready.wait()
        server = mac_voice.serve(engine, "127.0.0.1", 0, quiet)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = "http://127.0.0.1:%d" % server.server_address[1]
        try:
            results = []

            def go(i):
                results.append(post(base, {"text": "Sentence number %d." % i, "voice": "af_heart"})[0])

            threads = [threading.Thread(target=go, args=(i,)) for i in range(8)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(30)
            self.assertEqual(results, [200] * 8)
            self.assertEqual(loaded, ["voice"])
            self.assertEqual(engine.backend.threads, {"voice"}, "never on a request's own thread")
            self.assertEqual(engine.backend.peak, 1, "and one at a time")
            self.assertEqual(engine.rendered, 8)
        finally:
            server.shutdown()
            server.server_close()
            engine.stop()

    def test_a_voice_that_cannot_load_says_so_and_refuses_work(self):
        def factory():
            raise ImportError("No module named 'mlx'")

        engine = mac_voice.Engine(factory, quiet)
        engine.ready.wait()
        self.assertIn("No module named", engine.error)
        with self.assertRaises(RuntimeError) as cm:
            engine.render("Hello.", "af_heart")
        self.assertIn("failed to load", str(cm.exception))
        self.assertFalse(engine.status()["ready"])


class CheckTest(unittest.TestCase):
    def test_the_check_runs_against_the_fake_and_passes(self):
        engine = mac_voice.Engine(lambda: mac_voice.FakeBackend(), quiet)
        engine.ready.wait()
        try:
            self.assertTrue(mac_voice.run_check(engine, ["af_heart", "am_michael"], quiet))
        finally:
            engine.stop()

    def test_the_voices_list_is_what_the_app_offers(self):
        """js/novel-voice.js NEURAL_VOICES, so a new narrator is not forgotten here."""
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "..", "..", "js", "novel-voice.js"), encoding="utf-8") as f:
            source = f.read()
        block = source[source.index("const NEURAL_VOICES = ["):]
        block = block[:block.index("];")]
        import re
        offered = re.findall(r"id: '([a-z]{2}_[a-z]+)'", block)
        self.assertEqual(sorted(mac_voice.APP_VOICES), sorted(offered))


if __name__ == "__main__":
    unittest.main()
