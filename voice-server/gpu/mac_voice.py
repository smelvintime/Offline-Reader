#!/usr/bin/env python3
"""Kokoro on a Mac's graphics chip, for voice-server's --gpu.

voice-server's engine is one function, text in and samples out, and --gpu
points it at a small service that does that somewhere faster. This is that
service for Apple Silicon, using MLX (Apple's own array library, which runs
on the GPU in unified memory) through the mlx-audio package.

    cd voice-server/gpu
    python3.12 -m venv .venv && . .venv/bin/activate
    pip install -r requirements-mac.txt
    python mac_voice.py --check        # renders a few sentences, says how fast
    python mac_voice.py                # then serves on 127.0.0.1:8899

and in another window:

    npm start -- --gpu http://127.0.0.1:8899

The contract (the same as the CUDA service's, so voice-server cannot tell
them apart):

    POST /render   {"text": "...", "voice": "af_heart"}
                   -> 200, raw little-endian float32 samples, mono,
                      header x-rate: 24000
    GET  /status   -> JSON

Everything that touches the model runs on ONE thread, the one that loaded it.
MLX streams belong to the thread that made them, so an HTTP handler thread
evaluating arrays on the loader's stream fails with "no stream in current
thread". A queue in front of that thread is also all the locking the GPU
needs: it renders one sentence at a time, and voice-server keeps a few
requests waiting so it is never idle between them.

Only the standard library is needed to serve; numpy and mlx-audio are imported
only by the real backend. `--fake` serves a tone instead of speech, to check
the wiring without a model. Written to run on the Python 3.9 a Mac has.
"""

import argparse
import glob
import json
import os
import queue
import re
import sys
import threading
import time
from array import array
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8899
DEFAULT_REPO = "mlx-community/Kokoro-82M-bf16"
RATE = 24000
MAX_TEXT = 4000
VOICE_RE = re.compile(r"^[a-z]{2}_[a-z]+$")

# The voices the app offers (js/novel-voice.js NEURAL_VOICES). Rendered once at
# start so their files are downloaded then, not in the middle of someone's book.
APP_VOICES = ["af_heart", "af_bella", "af_nicole", "bf_emma",
              "am_michael", "am_fenrir", "am_puck", "bm_george"]

CHECK_SENTENCES = [
    "The lantern guttered as the wind came through the broken shutter.",
    "She counted her breaths slowly, the way her mother had taught her.",
    "Nobody in the lower city asked the ledger why, and the ledger never once volunteered.",
    '"You are late," he said, without looking up from the page.',
]
# A name that is in no dictionary. Spoken aloud it proves the fallback works;
# skipped, the sentence is shorter than it should be.
INVENTED_NAME = "Klein Moretti met Audrey Hall and Zaratul at the Tingen docks."


# ── Backends ────────────────────────────────────────────────────────────────

class FakeBackend(object):
    """A tone, as long as the sentence would take to say. For checking wiring."""

    name = "fake"

    def __init__(self, ms=0):
        self.rate = RATE
        self.ms = ms

    def render(self, text, voice):
        if text.strip() == "BOOM":
            raise RuntimeError("the fake voice was asked to fail")
        if self.ms:
            time.sleep(self.ms / 1000.0)
        n = int(self.rate * max(0.3, len(text) * 0.06))
        out = array("f", [0.0] * n)
        for i in range(int(n * 0.1), int(n * 0.9)):
            out[i] = 0.4 if (i // 40) % 2 else -0.4
        if sys.byteorder != "little":
            out.byteswap()
        return out.tobytes(), self.rate

    def describe(self):
        return {"backend": "fake", "model": None}

    def fallback_ok(self):
        return True


def find_espeak():
    """Where Homebrew put espeak-ng's library, handed to the phonemizer.

    misaki, which turns text into sounds, looks for it at one hard-coded
    Homebrew path including a version number, and when it is not there it
    carries on without a fallback: every word its dictionary does not know is
    then dropped from the sentence without a word said. A novel is full of
    invented names, so this looks for it properly.
    """
    if os.environ.get("PHONEMIZER_ESPEAK_LIBRARY"):
        return os.environ["PHONEMIZER_ESPEAK_LIBRARY"]
    patterns = [
        "/opt/homebrew/opt/espeak-ng/lib/libespeak-ng*.dylib",
        "/opt/homebrew/lib/libespeak-ng*.dylib",
        "/usr/local/opt/espeak-ng/lib/libespeak-ng*.dylib",
        "/usr/local/lib/libespeak-ng*.dylib",
        "/usr/lib/x86_64-linux-gnu/libespeak-ng.so*",
        "/usr/lib/aarch64-linux-gnu/libespeak-ng.so*",
    ]
    for pattern in patterns:
        hits = sorted(glob.glob(pattern))
        if hits:
            os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = hits[0]
            return hits[0]
    return None


class MlxBackend(object):
    """Kokoro through mlx-audio on the GPU. Built and used on one thread."""

    name = "mlx"

    def __init__(self, repo):
        self.espeak = find_espeak()
        import mlx.core as mx
        from mlx_audio.tts.utils import load
        self.mx = mx
        self.repo = repo
        self.model = load(repo)
        self.rate = int(self.model.sample_rate or RATE)

    def render(self, text, voice):
        import numpy as np
        lang = "b" if voice[:1] == "b" else "a"    # bf_ and bm_ are British
        parts = []
        # `generate` yields one result per stretch it had to split the text
        # into; a sentence is nearly always one.
        for result in self.model.generate(text, voice=voice, speed=1.0, lang_code=lang):
            if result.audio is None:
                continue
            parts.append(np.array(result.audio.astype(self.mx.float32)).reshape(-1))
        if not parts:
            raise RuntimeError("the voice produced no audio for that text")
        pcm = parts[0] if len(parts) == 1 else np.concatenate(parts)
        return np.ascontiguousarray(pcm, dtype="<f4").tobytes(), self.rate

    def fallback_ok(self):
        """Whether words the dictionary lacks are spoken by espeak, not dropped."""
        try:
            g2p = self.model._get_pipeline("a").g2p
            return getattr(g2p, "fallback", None) is not None
        except Exception:
            return False

    def describe(self):
        return {"backend": "mlx", "model": self.repo, "espeak": self.espeak}


# ── One thread owns the model ───────────────────────────────────────────────

class Engine(object):
    """Runs every render on the thread that loaded the model."""

    def __init__(self, factory, log):
        self.log = log
        self.jobs = queue.Queue()
        self.backend = None
        self.error = None
        self.ready = threading.Event()
        self.started = time.time()
        self.rendered = 0
        self.seconds = 0.0
        self.busy_s = 0.0
        self.waiting = 0
        self.working = False
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._run, args=(factory,), name="voice", daemon=True)
        self._thread.start()

    def _run(self, factory):
        try:
            self.backend = factory()
        except BaseException as e:      # noqa: BLE001 - reported, then the thread ends
            self.error = "%s: %s" % (type(e).__name__, e)
            self.log("the voice could not load: " + self.error)
            self.ready.set()
            return
        self.ready.set()
        while True:
            job = self.jobs.get()
            if job is None:
                return
            text, voice, box = job
            with self._lock:
                self.waiting -= 1
                self.working = True
            t0 = time.time()
            try:
                pcm, rate = self.backend.render(text, voice)
                box["ok"] = (pcm, rate)
                with self._lock:
                    self.rendered += 1
                    self.seconds += (len(pcm) / 4.0) / rate
            except BaseException as e:  # noqa: BLE001 - handed to the request
                box["error"] = "%s: %s" % (type(e).__name__, e)
            finally:
                with self._lock:
                    self.busy_s += time.time() - t0
                    self.working = False
                box["done"].set()

    def render(self, text, voice, timeout=600):
        """→ (float32 bytes, rate). Raises RuntimeError with the reason."""
        if self.error:
            raise RuntimeError("the voice failed to load: " + self.error)
        box = {"done": threading.Event()}
        with self._lock:
            self.waiting += 1
        self.jobs.put((text, voice, box))
        if not box["done"].wait(timeout):
            raise RuntimeError("timed out waiting for the voice")
        if "error" in box:
            raise RuntimeError(box["error"])
        return box["ok"]

    def status(self):
        with self._lock:
            up = max(0.001, time.time() - self.started)
            s = {
                "ok": True, "version": 1,
                "ready": self.ready.is_set() and not self.error,
                "error": self.error,
                "rendered": self.rendered,
                "audioSeconds": round(self.seconds, 1),
                "working": self.working, "waiting": self.waiting,
                "busy": round(self.busy_s / up, 3),     # share of the time it was rendering
            }
        if self.backend is not None:
            s.update(self.backend.describe())
            s["rate"] = self.backend.rate
        return s

    def stop(self):
        self.jobs.put(None)


# ── HTTP ────────────────────────────────────────────────────────────────────

def make_handler(engine, log):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):      # the terminal is for what matters
            pass

        def _send(self, status, body, ctype, extra=None):
            self.send_response(status)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status, obj):
            self._send(status, json.dumps(obj).encode("utf-8"), "application/json")

        def do_GET(self):
            if self.path.split("?")[0] == "/status":
                self._json(200, engine.status())
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self):
            if self.path.split("?")[0] != "/render":
                self._json(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("content-length") or 0)
                if length <= 0 or length > 64 * 1024:
                    raise ValueError("body must be JSON, under 64 KB")
                job = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(job, dict):
                    raise ValueError("body must be a JSON object")
            except (ValueError, UnicodeDecodeError) as e:
                self._json(400, {"error": str(e) or "body must be JSON"})
                return
            text = job.get("text")
            voice = str(job.get("voice") or "")
            if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
                self._json(400, {"error": "text must be 1 to %d characters" % MAX_TEXT})
                return
            if not VOICE_RE.match(voice):
                self._json(400, {"error": "unknown voice"})
                return
            try:
                pcm, rate = engine.render(text, voice)
            except RuntimeError as e:
                log("render failed: %s" % e)
                self._json(500, {"error": str(e)})
                return
            self._send(200, pcm, "application/octet-stream", {"x-rate": str(rate)})

    return Handler


def serve(engine, host, port, log):
    server = ThreadingHTTPServer((host, port), make_handler(engine, log))
    server.daemon_threads = True
    return server


# ── Checking it ─────────────────────────────────────────────────────────────

def run_check(engine, voices, log):
    """Renders a few sentences and says how fast, and whether names are spoken."""
    ok = True
    print("")
    print("  Backend: %s" % engine.backend.describe())
    print("")

    print("  Getting each of the app's voices ready (the first run downloads them)…")
    for v in voices:
        t0 = time.time()
        engine.render("Hello there.", v)
        print("    %-12s ready in %.1f s" % (v, time.time() - t0))

    print("")
    secs = 0.0
    t0 = time.time()
    for s in CHECK_SENTENCES * 2:
        pcm, rate = engine.render(s, voices[0])
        secs += (len(pcm) / 4.0) / rate
    took = time.time() - t0
    print("  One sentence at a time: %.1f s of audio in %.1f s = %.1fx as fast as listening"
          % (secs, took, secs / took))
    print("  (voice-server keeps several requests waiting, so this is close to what it gets)")

    # Spoken length is the plainest proof that a word was said rather than
    # dropped: the sentence with invented names must be clearly longer than
    # the same sentence without them.
    names, _ = engine.render(INVENTED_NAME, voices[0])
    bare, _ = engine.render("met and at the docks.", voices[0])
    n_len, b_len = len(names) / 4.0 / RATE, len(bare) / 4.0 / RATE
    spoken = n_len > b_len * 1.6
    print("")
    print("  Words no dictionary knows: %s (%.1f s with the names, %.1f s without)"
          % ("spoken" if spoken else "DROPPED", n_len, b_len))
    if not spoken or not engine.backend.fallback_ok():
        ok = False
        print("")
        print("  ! Invented names are being skipped, which would leave holes in a novel.")
        print("    Install espeak-ng and run this again:   brew install espeak-ng")
        if getattr(engine.backend, "espeak", None):
            print("    (found a library at %s)" % engine.backend.espeak)
    print("")
    print("  This is %s" % ("ready." if ok else "NOT ready."))
    print("")
    return ok


def main(argv=None):
    ap = argparse.ArgumentParser(description="Kokoro on a Mac's graphics chip, for voice-server --gpu")
    ap.add_argument("--host", default="127.0.0.1",
                    help="address to listen on; the default keeps it to this computer, which is all voice-server needs")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="default %d; 0 picks a free one" % DEFAULT_PORT)
    ap.add_argument("--model", default=DEFAULT_REPO, help="MLX weights on Hugging Face (default %(default)s)")
    ap.add_argument("--check", action="store_true", help="render a few sentences, say how fast, and exit")
    ap.add_argument("--fake", action="store_true", help="serve a tone instead of speech, to check the wiring without a model")
    ap.add_argument("--fake-ms", type=int, default=0, help="with --fake: how long each sentence takes")
    ap.add_argument("--voices", default=",".join(APP_VOICES), help="voices to get ready at start (default: the app's eight)")
    args = ap.parse_args(argv)

    def log(m):
        print("mac-voice: " + m, flush=True)

    voices = [v for v in args.voices.split(",") if VOICE_RE.match(v.strip())] or APP_VOICES[:1]
    voices = [v.strip() for v in voices]
    if args.fake:
        engine = Engine(lambda: FakeBackend(args.fake_ms), log)
    else:
        engine = Engine(lambda: MlxBackend(args.model), log)
    engine.ready.wait()
    if engine.error:
        if "No module named" in engine.error:
            log("a package is missing. Inside the folder's virtual environment run:  pip install -r requirements-mac.txt")
        return 1

    if args.check:
        ok = run_check(engine, voices, log)
        engine.stop()
        return 0 if ok else 2

    if not args.fake:
        log("getting the app's voices ready (the first run downloads them)…")
        for v in voices:
            try:
                engine.render("Hello there.", v)
            except RuntimeError as e:
                log("could not prepare %s: %s" % (v, e))
        if not engine.backend.fallback_ok():
            log("WARNING: espeak-ng was not found, so names the dictionary lacks will be skipped. brew install espeak-ng")

    server = serve(engine, args.host, args.port, log)
    # Printed in this exact form: the tests read the port from it.
    print("mac-voice: listening on http://%s:%d" % (args.host, server.server_address[1]), flush=True)
    if not args.fake:
        print("mac-voice: now start the server with   npm start -- --gpu http://%s:%d" % (args.host, server.server_address[1]), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        engine.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
