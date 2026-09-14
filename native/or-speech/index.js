'use strict';

// or-speech — JS entry point.
//
// The app is a no-bundler static site, so nothing ever imports this file: on
// native, Capacitor registers the plugin from the native sources and
// js/platform.js reaches it as window.Capacitor.Plugins.OrSpeech. This file
// exists so the package is a well-formed npm module (`main` resolves) and so
// tooling that does import it gets the same methods with the same
// degrade-to-null behavior the app uses on the plain web.

function nativePlugin() {
  var cap = typeof window !== 'undefined' ? window.Capacitor : undefined;
  return (cap && cap.Plugins && cap.Plugins.OrSpeech) || null;
}

var OrSpeech = {
  // → Promise<{ available: true }|null>
  available: function () {
    var p = nativePlugin();
    return p ? p.available() : Promise.resolve(null);
  },
  // { lang } → Promise<{ voices: [{ id, name, lang, quality, personal }] }|null>
  voices: function (options) {
    var p = nativePlugin();
    return p ? p.voices(options || {}) : Promise.resolve(null);
  },
  // { text, voiceId, lang, rate, pitch, gap } → Promise<{ spoken: boolean }|null>
  // Resolves when the utterance FINISHES; interruption resolves spoken:false.
  speak: function (options) {
    var p = nativePlugin();
    return p ? p.speak(options || {}) : Promise.resolve(null);
  },
  stop: function () {
    var p = nativePlugin();
    return p ? p.stop() : Promise.resolve(null);
  },
  pause: function () {
    var p = nativePlugin();
    return p ? p.pause() : Promise.resolve(null);
  },
  resume: function () {
    var p = nativePlugin();
    return p ? p.resume() : Promise.resolve(null);
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OrSpeech: OrSpeech };
}
