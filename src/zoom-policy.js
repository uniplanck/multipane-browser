// Pane zoom (#53): pure rules, no electron (test/zoom-policy.test.js). main.js owns every WebContents and does what these say.
// A pane either follows the GLOBAL zoom (settings.globalZoom) or is "individual" (its own zoom, untouched by global changes); the saved form is
// unchanged (spec.zoom / spec.zoomIndiv; an old save without zoomIndiv is individual when its zoom is not 100%).
// Two ways to show a pane's zoom, one per page, never both:
//  native - wc.setZoomMode('isolated') once per view, then wc.setZoomFactor: per-WebContents zoom that keeps across navigations (Electron 44+).
//           Chosen at run time from the WebContents itself (the functions exist, setting the mode does not throw, the mode reads back isolated).
//  legacy - (unchanged) main sends 'mpb:zoom' and the page's preload calls webFrame.setZoomFactor; the shared per-site level (host zoom map)
//           stays at 100% (main's normalizeHostZoom). Used when native is missing / fails / is turned off (MPB_NO_NATIVE_ZOOM).
// The 承認Bot popup and the hidden background check keep the default mode at the site's 100% as before (nothing here applies to them).
const MIN = 0.3, MAX = 3, STEP = 0.1, DEF = 1;               // range, menu / key step, reset
const EPS = 0.005;                                           // a factor read back this close is the same zoom (level <-> factor rounding)
const NATIVE_API = ['setZoomMode', 'setZoomFactor', 'getZoomFactor'];
// diagnostics (= diagnostics.js ZOOM_CODES; checked by the test): which backend a view got and why, a page that lost the mode, a fallback
const CODES = ['NATIVE', 'NO_API', 'FORCED', 'INIT_FAIL', 'MODE_FAIL', 'MODE_RESET', 'FALLBACK'];

// a zoom factor from anywhere (menu step, saved file, settings): not a finite positive number -> 100%; else within MIN..MAX, 2 decimals
function clamp(z) {
  const n = Number(z);
  if (!Number.isFinite(n) || n <= 0) return DEF;
  return Math.round(Math.min(MAX, Math.max(MIN, n)) * 100) / 100;
}
// a global change applies to every pane that follows the global zoom (asleep too: its page shows it on wake); a pane's own change only to itself
const followers = list => (Array.isArray(list) ? list : []).filter(p => p && !p.zoomIndiv);
// a saved / reopened pane spec -> its zoom state
function restore(spec, globalZoom) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const zoomIndiv = s.zoomIndiv === undefined ? clamp(s.zoom) !== DEF : !!s.zoomIndiv;   // older saves had per-pane zoom only: keep those panes individual
  return { zoomIndiv, zoom: zoomIndiv ? clamp(s.zoom) : clamp(globalZoom) };
}
const hasNative = wc => !!wc && NATIVE_API.every(f => typeof wc[f] === 'function');
// the backend of one view, from what main saw when it set the mode: api = hasNative, forced = turned off, threw = setZoomMode threw,
// mode = getZoomMode() right after (undefined when this Electron has no getZoomMode: the call not throwing is all there is)
function backend({ api, forced, threw, mode } = {}) {
  if (forced) return { backend: 'legacy', code: 'FORCED' };
  if (!api) return { backend: 'legacy', code: 'NO_API' };
  if (threw) return { backend: 'legacy', code: 'INIT_FAIL' };
  if (mode !== undefined && mode !== 'isolated') return { backend: 'legacy', code: 'MODE_FAIL' };
  return { backend: 'native', code: 'NATIVE' };
}
// what to do to show zoom on the page now. native: set the mode again only if the page has lost it (always before the factor: a factor set
// in the default mode would zoom every pane of the site), the factor only when it differs; legacy: tell the page's preload. Never both.
function plan({ backend: b, mode, factor, zoom } = {}) {
  const z = clamp(zoom);
  if (b !== 'native') return { ops: ['send'], zoom: z };
  const ops = [];
  if (mode !== undefined && mode !== 'isolated') ops.push('mode');
  if (ops.length || !(Math.abs(Number(factor) - z) < EPS)) ops.push('factor');
  return { ops, zoom: z };
}
module.exports = { MIN, MAX, STEP, DEF, EPS, NATIVE_API, CODES, clamp, followers, restore, hasNative, backend, plan };
