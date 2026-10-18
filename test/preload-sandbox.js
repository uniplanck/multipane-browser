// Test helper: runs a built pane preload (default src/pane-preload.js) as a plain script in its own context, like a sandboxed preload:
// no Node globals, `require` only for 'electron' (stubbed; anything else throws), stub window / document / location.
// Returns the shared-rule functions the preload has built in (plus the context, so a test can swap `document`).
const fs = require('fs'), path = require('path'), vm = require('vm');
function loadPreload(file = path.join(__dirname, '..', 'src', 'pane-preload.js')) {
  const noop = () => {}, required = [];
  const electron = { ipcRenderer: { send: noop, on: noop }, webFrame: { insertCSS: noop, removeInsertedCSS: noop, setZoomFactor: noop } };
  const ctx = vm.createContext({
    require: m => { required.push(m); if (m !== 'electron') throw new Error(`preload requires '${m}' (only 'electron' works in a sandboxed preload)`); return electron; },
    window: { addEventListener: noop }, document: { documentElement: null, querySelector: () => null, querySelectorAll: () => [] },
    location: { hostname: 'example.invalid', pathname: '/' }, MutationObserver: class { observe() {} },
    setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: path.basename(file) });
  const api = vm.runInContext('({ QUOTE_MAX, markerOf, clipQuote, requestQuote, requestQuoteSrc, looksAsking, composerDraft, SNAP, snapOk, snapUsable, snapIssue, readConversation, msgKey })', ctx);
  return { ...api, ctx, required };
}
module.exports = { loadPreload };
