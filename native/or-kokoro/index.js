'use strict';

// or-kokoro — JS entry point.
//
// The app is a no-bundler static site, so nothing ever imports this file: on
// native, Capacitor registers the plugin from the native sources and
// js/platform.js reaches it as window.Capacitor.Plugins.OrKokoro. This file
// exists so the package is a well-formed npm module (`main` resolves) and so
// tooling that does import it gets the same methods with the same
// degrade-to-null behavior the app uses on the plain web.

function nativePlugin() {
  var cap = typeof window !== 'undefined' ? window.Capacitor : undefined;
  return (cap && cap.Plugins && cap.Plugins.OrKokoro) || null;
}

var OrKokoro = {
  // → Promise<{ available, provider, loaded }|null>. `available` is false when
  // the plugin is present but the build shipped no weights, which is a
  // different problem from the plugin missing and gets a different answer.
  available: function () {
    var p = nativePlugin();
    return p ? p.available() : Promise.resolve(null);
  },
  // { ids, style, speed } → Promise<{ pcm, sampleRate, provider, ms }|null>
  // pcm is base64 little-endian Int16 at 24 kHz.
  infer: function (options) {
    var p = nativePlugin();
    return p ? p.infer(options || {}) : Promise.resolve(null);
  },
  release: function () {
    var p = nativePlugin();
    return p ? p.release() : Promise.resolve(null);
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OrKokoro: OrKokoro };
}
