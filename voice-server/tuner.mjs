// Finds how many copies of the voice this computer renders fastest with.
//
// Guessing from the core count is wrong in both directions: a laptop's cores
// are not all the same speed, memory runs out before cores do, and something
// else may be using the machine. So it is measured, on the real work, while
// the work goes on:
//
//   measure the speed with n copies
//   add one, measure again
//   faster by enough to matter?  keep it and try one more
//   not?                         take it away again, and stay at n
//
// Speed is seconds of audio made per second of clock, so long sentences and
// short ones count alike. A window only counts if the copies were busy for
// nearly all of it: with too little work to go round, more copies cannot
// look faster, and that says nothing about the computer.
//
// After settling it rests, then tries again, because the answer changes when
// another program stops or starts.

const WINDOW_MS = 30000;       // how long a measurement runs
const GAIN = 1.05;             // one more copy has to buy at least this
const BUSY = 0.85;             // the copies must have been this busy to judge
const REST_MS = 20 * 60000;    // settled this long, then look again
const TICK_MS = 2000;

/**
 * createTuner({ farm, max, log, onSettle, now, windowMs, gain, restMs })
 * → { start(), stop(), step(), status() }
 *
 * `step()` is the whole of it, called on a timer by start() and directly by
 * the tests, which pass their own clock.
 */
export function createTuner(options) {
  const o = options || {};
  const farm = o.farm;
  const log = o.log || function () {};
  const now = o.now || Date.now;
  const windowMs = o.windowMs || WINDOW_MS;
  const gain = o.gain || GAIN;
  const restMs = o.restMs === undefined ? REST_MS : o.restMs;
  const max = Math.max(1, Math.floor(o.max || 1));

  let n = farm.target();        // the size being kept
  let phase = 'measuring';      // measuring → trying → settled → measuring …
  let base = 0;                 // speed at n
  let speed = 0;                // the latest speed measured, whatever the phase
  let since = now();            // when the current window, or rest, began
  let timer = null;

  function restart() { farm.window(); since = now(); }

  function settle() {
    phase = 'settled';
    since = now();
    if (o.onSettle) { try { o.onSettle(n, base); } catch (e) {} }
  }

  function step() {
    const t = now();

    if (phase === 'settled') {
      // Keep the speed on show fresh while resting.
      if (t - since >= restMs) { phase = 'measuring'; restart(); return; }
      const p = farm.peek();
      if (p.ms >= windowMs) {
        const w = farm.window();
        if (w.ms > 0 && w.busyMs / (w.ms * Math.max(1, w.copies)) >= BUSY) speed = w.seconds / (w.ms / 1000);
      }
      return;
    }

    // The farm may have found it cannot hold as many as it was asked for.
    if (phase === 'measuring' && farm.target() < n) n = farm.target();
    const expected = phase === 'trying' ? n + 1 : n;
    // A copy still loading, or one that would not start.
    if (farm.size() !== expected) {
      if (phase === 'trying' && farm.target() < expected) {
        log('this computer has no room for ' + expected + ' copies of the voice; staying at ' + n);
        settle();
        return;
      }
      restart();
      return;
    }

    const p = farm.peek();
    // Long enough, and enough sentences that one long one does not decide it.
    if (t - since < windowMs || p.done < 2 * expected) return;
    const w = farm.window();
    since = t;
    if (w.ms <= 0 || w.busyMs / (w.ms * expected) < BUSY) return;     // not enough work to judge by
    speed = w.seconds / (w.ms / 1000);

    if (phase === 'measuring') {
      base = speed;
      if (n >= max) { settle(); return; }
      phase = 'trying';
      farm.resize(n + 1);
      restart();
      return;
    }

    // trying n + 1
    if (speed >= base * gain) {
      n = n + 1;
      base = speed;
      log('voice: ' + n + ' at once is faster (' + speed.toFixed(1) + '× as fast as listening)');
      if (n >= max) { settle(); return; }
      farm.resize(n + 1);
      restart();
      return;
    }
    farm.resize(n);
    log('voice: settled on ' + n + ' at once (' + base.toFixed(1) + '× as fast as listening); '
        + (n + 1) + ' was no faster');
    speed = base;
    settle();
  }

  return {
    step: step,
    start: function () {
      if (timer) return;
      restart();
      timer = setInterval(step, o.tickMs || TICK_MS);
      timer.unref();
    },
    stop: function () { if (timer) { clearInterval(timer); timer = null; } },
    /** For /status and the monitor page. */
    status: function () {
      return { copies: n, max: max, phase: phase, speed: Math.round(speed * 10) / 10 };
    },
  };
}
