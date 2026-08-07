// Offline Reader — single place for deployment-specific configuration.
// Loaded before every other script. See docs/ARCHITECTURE.md §6.

window.OR_CONFIG = {
  // Deployed Cloudflare Worker base URL, no trailing slash.
  // Empty string = gateway disabled: the app still browses the bundled
  // catalogue and reads local files, but "add by link" and hotlink-protected
  // images will not work. See worker/README.md to deploy your own.
  workerBase: '',

  // Where bundled chapter files live, relative to the app root.
  chapterBase: './chapters/',

  // Catalogue file to load on boot.
  catalogUrl: './catalog.json',
};

// Convenience: build a gateway URL, or null when the gateway is not configured.
window.gatewayUrl = function (path, params) {
  const base = (window.OR_CONFIG.workerBase || '').replace(/\/+$/, '');
  if (!base) return null;
  const qs = new URLSearchParams(params || {}).toString();
  return base + path + (qs ? '?' + qs : '');
};
