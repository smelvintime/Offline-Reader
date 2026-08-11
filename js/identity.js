// Offline Reader — identity seam. See docs/ARCHITECTURE.md §2.13.
//
// This module exists so that accounts can arrive later WITHOUT the reader,
// the catalogue, the store or the settings screen learning anything about
// auth. Today it ships exactly one provider — `local` — which is not an
// account at all: it mints a random id for this install, keeps it in prefs,
// and never sends it anywhere. There is no server, no sign-in, no network
// call in this file, and nothing here can produce one.
//
// The point is the SHAPE. A future backend implements the provider contract
// below and calls `Identity.register(provider)`; everything that reads
// identity today already reads it through `Identity.state()`, so the day an
// account exists the UI does not need rewriting to notice.
//
// Provider contract (all optional except `id` and `label`):
//   {
//     id:      'local' | 'whatever',      // stable machine name
//     label:   'This device',             // human, shown in UI
//     canSignIn: false,                   // does signIn() do anything?
//     async state()   -> { signedIn, accountLabel|null }
//     async signIn()  -> resolves when signed in, rejects otherwise
//     async signOut() -> resolves when signed out
//   }
//
// Honesty rule (binding, §2.13): this module never claims to be signed in,
// never shows a sign-in control that does nothing, and never implies data
// leaves the device. `canSignIn` is false until something real backs it, and
// the onboarding copy is written against that flag rather than against a hope.
//
// Delete this file and the app runs exactly as before: settings.js guards
// every call behind `window.Identity`, and the onboarding block simply does
// not render (§0.5).

(function () {
  'use strict';

  const VERSION = '1.0.0';

  // Where the local install id lives. A plain pref: it is not a secret, it is
  // not a credential, and it identifies an installation rather than a person.
  const DEVICE_KEY = 'identity.deviceId';

  const listeners = [];

  function prefGet(key, fallback) {
    try {
      if (!window.Store || !window.Store.prefs) return fallback;
      return window.Store.prefs.get(key, fallback);
    } catch (e) { return fallback; }
  }
  function prefSet(key, value) {
    try {
      if (window.Store && window.Store.prefs) window.Store.prefs.set(key, value);
    } catch (e) { /* prefs are not worth throwing over */ }
  }

  /**
   * A random, opaque installation id.
   *
   * crypto.randomUUID is not universal (older WebViews), so fall back to
   * getRandomValues and finally to Math.random — this is a cache key for
   * "which install am I", not a security token, and a weak one is better
   * than a thrown error during boot.
   */
  function mintId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        const b = new Uint8Array(16);
        window.crypto.getRandomValues(b);
        return Array.from(b, function (n) { return n.toString(16).padStart(2, '0'); }).join('');
      }
    } catch (e) { /* fall through */ }
    return 'x' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function deviceId() {
    let id = prefGet(DEVICE_KEY, null);
    if (typeof id === 'string' && id.length >= 8) return id;
    id = mintId();
    prefSet(DEVICE_KEY, id);
    return id;
  }

  // ── The shipped provider ──────────────────────────────────────────────────
  // Deliberately not an account. It answers "who is this install" and nothing
  // else, so the rest of the app can be written against a real contract while
  // the honest answer is still "nobody, and everything is local".

  const localProvider = {
    id: 'local',
    label: 'This device',
    canSignIn: false,
    async state() {
      return { signedIn: false, accountLabel: null };
    },
    async signIn() {
      throw new Error('Identity: no account provider is registered');
    },
    async signOut() {
      /* nothing to sign out of */
    },
  };

  let provider = localProvider;
  let cached = { signedIn: false, accountLabel: null };

  function emit() {
    const snapshot = state();
    listeners.forEach(function (fn) {
      try { fn(snapshot); } catch (e) { /* a bad listener is not our problem */ }
    });
    try {
      window.dispatchEvent(new CustomEvent('or:identity-changed', { detail: snapshot }));
    } catch (e) { /* CustomEvent unavailable — the direct listeners still ran */ }
  }

  /**
   * The synchronous view every caller uses.
   *
   * Synchronous on purpose: UI renders against it during a paint, and an
   * async identity check would mean every consumer handling a loading state
   * for something that is, today, a constant. `refresh()` is what re-reads
   * the provider; this returns the last known answer.
   */
  function state() {
    return {
      provider: provider.id,
      label: provider.label,
      canSignIn: !!provider.canSignIn,
      signedIn: !!cached.signedIn,
      accountLabel: cached.accountLabel || null,
      local: provider.id === 'local',
    };
  }

  /** Re-ask the provider and notify if anything moved. */
  async function refresh() {
    let next = { signedIn: false, accountLabel: null };
    try {
      if (typeof provider.state === 'function') next = (await provider.state()) || next;
    } catch (e) { /* a provider that throws reads as signed out */ }
    const changed = next.signedIn !== cached.signedIn || next.accountLabel !== cached.accountLabel;
    cached = { signedIn: !!next.signedIn, accountLabel: next.accountLabel || null };
    if (changed) emit();
    return state();
  }

  /**
   * Install a real provider. This is the seam: a backend module loads after
   * this file, calls register(), and every existing reader of Identity.state()
   * starts reporting the truth without being touched.
   */
  function register(next) {
    if (!next || typeof next.id !== 'string' || typeof next.label !== 'string') {
      throw new Error('Identity.register: a provider needs an id and a label');
    }
    provider = next;
    cached = { signedIn: false, accountLabel: null };
    emit();
    refresh();
    return state();
  }

  function on(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function off() {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    };
  }

  async function signIn() {
    if (!provider.canSignIn) throw new Error('Identity: accounts are not available yet');
    await provider.signIn();
    return refresh();
  }

  async function signOut() {
    if (typeof provider.signOut === 'function') await provider.signOut();
    return refresh();
  }

  window.Identity = {
    VERSION: VERSION,
    state: state,
    refresh: refresh,
    register: register,
    on: on,
    signIn: signIn,
    signOut: signOut,
    deviceId: deviceId,
    // Exposed for tests and for a provider that wants to fall back.
    _localProvider: localProvider,
  };
}());
