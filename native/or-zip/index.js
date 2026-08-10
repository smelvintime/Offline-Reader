'use strict';

// or-zip — JS entry point.
//
// The app is a no-bundler static site, so nothing ever imports this file: on
// native, Capacitor registers the plugin from the native sources and js/platform.js
// reaches it as window.Capacitor.Plugins.OrZip. This file exists so the package
// is a well-formed npm module (`main` resolves) and so tooling that does import
// it gets the same two methods with the same degrade-to-null behavior the app
// uses on the plain web.

function nativePlugin() {
  var cap = typeof window !== 'undefined' ? window.Capacitor : undefined;
  return (cap && cap.Plugins && cap.Plugins.OrZip) || null;
}

var OrZip = {
  // { path } → Promise<{ entries: [{ name, size }] }> — central directory only.
  list: function (options) {
    var plugin = nativePlugin();
    return plugin ? plugin.list(options) : Promise.resolve(null);
  },
  // { path, entryNames, destDir } → Promise<{ paths: [...] }> — streamed native
  // extraction, absolute result paths in entryNames order.
  extract: function (options) {
    var plugin = nativePlugin();
    return plugin ? plugin.extract(options) : Promise.resolve(null);
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OrZip: OrZip };
}
