// node test/pane-bg-guard.test.js — document-start CSS, removal timing and view theme updates without launching Electron.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { paneBackgroundCss, paneBackgroundShouldRemove } = require('../src/pane-rules');
const root = path.join(__dirname, '..'), read = f => fs.readFileSync(path.join(root, f), 'utf8');
const template = read('src/pane-preload.template.js'), built = read('src/pane-preload.js'), main = read('src/main.js');

assert.strictEqual(paneBackgroundCss(true), ':root{background-color:#1c1c1e;color-scheme:dark}');
assert.strictEqual(paneBackgroundCss(false), ':root{background-color:#ffffff;color-scheme:light}');
assert(!/!important/i.test(paneBackgroundCss(true) + paneBackgroundCss(false)), 'author styles retain priority');
for (const loaded of [false, true]) for (const frames of [0, 1, 2, 3]) for (const timedOut of [false, true]) {
  assert.strictEqual(paneBackgroundShouldRemove(loaded, frames, timedOut), timedOut || (loaded && frames >= 2));
}
for (const src of [template, built]) {
  assert(/webFrame\.insertCSS\(paneBackgroundCss\([^\n]+\),\s*\{\s*cssOrigin:\s*'user'\s*\}\)/.test(src));
  assert(/webFrame\.removeInsertedCSS\(bgKey\)/.test(src));
  assert(src.indexOf('webFrame.insertCSS(paneBackgroundCss') < src.indexOf('let lastLen'), 'guard runs first');
}

// Run the complete generated preload with a controllable load event, frame queue and clock.
function preload({ url = 'https://grok.com/bot/test', dark = true, mainFrame = true, ready = 'loading', fail = '' } = {}) {
  let now = 0, next = 0; const timers = new Map(), frames = [], listeners = {}, inserted = [], removed = [], events = [];
  const document = { readyState: ready, documentElement: null, querySelector: () => null, querySelectorAll: () => [] };
  const window = { matchMedia: query => { assert.strictEqual(query, '(prefers-color-scheme: dark)'); return { matches: dark }; },
    addEventListener: (name, fn, options) => { events.push('listen:' + name); (listeners[name] ||= []).push({ fn, options }); } };
  const webFrame = { insertCSS: (css, options) => { events.push('insert'); if (fail === 'insert') throw Error('insert');
      inserted.push({ css, origin: options?.cssOrigin }); return 'background-key'; },
    removeInsertedCSS: key => { removed.push(key); if (fail === 'remove') throw Error('remove'); }, setZoomFactor() {} };
  const ctx = vm.createContext({ window, document, location: new URL(url), process: { isMainFrame: mainFrame },
    require: name => { assert.strictEqual(name, 'electron'); return { webFrame, ipcRenderer: { send() {}, on() {} } }; },
    MutationObserver: class { observe() {} },
    setTimeout: (fn, ms) => { if (fail === 'timer') throw Error('timer'); const id = ++next; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: fn => { if (fail === 'frame') throw Error('frame'); frames.push(fn); } });
  window.top = mainFrame ? window : {};                     // a sub frame: the guard is skipped by window.top too
  vm.runInContext(built, ctx);
  return { inserted, removed, events, frames, timers,
    load() { document.readyState = 'complete'; for (const { fn } of listeners.load || []) fn(); },
    frame() { for (const fn of frames.splice(0)) fn(); },
    advance(ms) { const end = now + ms; for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break; now = due[1].at; timers.delete(due[0]); due[1].fn();
    } now = end; } };
}
for (const [url, dark] of [['https://grok.com/bot/test', true], ['http://example.com/', false], ['about:blank', true], ['about:blank#sleep', false]]) {
  const p = preload({ url, dark });
  assert.deepStrictEqual(p.inserted, [{ css: paneBackgroundCss(dark), origin: 'user' }]);
  assert.strictEqual(p.events[0], 'insert', 'CSS is inserted synchronously before event listeners');
  assert.strictEqual(p.frames.length, 0); assert.deepStrictEqual(p.removed, []);
  p.load(); assert.strictEqual(p.frames.length, 1); assert.deepStrictEqual(p.removed, []);
  p.frame(); assert.strictEqual(p.frames.length, 1); assert.deepStrictEqual(p.removed, []);
  p.frame(); assert.deepStrictEqual(p.removed, ['background-key']); assert.strictEqual(p.timers.size, 0);
  p.advance(16000); assert.deepStrictEqual(p.removed, ['background-key']);
}
for (const args of [{ url: 'file:///tmp/page.html' }, { url: 'about:srcdoc' }, { url: 'data:text/html,hello' }, { mainFrame: false }]) {
  const p = preload(args); assert.deepStrictEqual(p.inserted, []); assert.strictEqual(p.timers.size, 0);
}
{
  const p = preload(); p.advance(14999); assert.deepStrictEqual(p.removed, []);
  p.advance(1); assert.deepStrictEqual(p.removed, ['background-key']);
  p.load(); p.frame(); p.frame(); assert.deepStrictEqual(p.removed, ['background-key']);
}
{
  const p = preload(); p.load(); p.frame(); p.advance(15000); p.frame();
  assert.deepStrictEqual(p.removed, ['background-key'], 'timeout also wins between the two frames');
}
{
  const p = preload({ ready: 'complete' }); assert.strictEqual(p.frames.length, 1);
  p.frame(); p.frame(); assert.deepStrictEqual(p.removed, ['background-key']);
}
{
  assert.deepStrictEqual(preload({ fail: 'insert' }).removed, []);
  assert.deepStrictEqual(preload({ fail: 'timer' }).removed, ['background-key']);
  const p = preload({ fail: 'frame' }); p.load(); p.advance(15000); assert.deepStrictEqual(p.removed, ['background-key']);
  const q = preload({ fail: 'remove' }); q.load(); q.frame(); q.frame(); q.advance(15000);
  assert.deepStrictEqual(q.removed, ['background-key']);
}

// Exercise the main-process update function and its nativeTheme listener across multiple windows.
const a = main.indexOf('function updateViewBackgrounds() {'), b = main.indexOf('\nlet keyboardFocus', a);
assert(a >= 0 && b > a); const update = main.slice(a, b);
const listener = main.match(/nativeTheme\.on\('updated', [^\n]+/); assert(listener);
assert(/paneIpc, updateViewBackgrounds,/.test(main));
const nativeTheme = { shouldUseDarkColors: false, on(name, fn) { assert.strictEqual(name, 'updated'); this.updated = fn; } };
function view(destroyed = false, fail = false) {
  return { colors: [], webContents: { isDestroyed: () => destroyed }, setBackgroundColor(color) { if (fail) throw Error('closed'); this.colors.push(color); } };
}
function windowContext(panes, approve) {
  const ctx = { nativeTheme, panes: panes.map(view => ({ view })), approve }; vm.runInNewContext(update, ctx); return ctx;
}
const pane1 = view(), pane2 = view(), dead = view(true), broken = view(false, true), approval = view();
const windows = [windowContext([pane1, dead, broken], approval), windowContext([pane2], null)];
let broadcasts = 0;
vm.runInNewContext(listener[0], { nativeTheme, ctxs: windows, broadcast: () => broadcasts++ });
nativeTheme.updated(); nativeTheme.shouldUseDarkColors = true; nativeTheme.updated();
for (const v of [pane1, pane2, approval]) assert.deepStrictEqual(v.colors, ['#ffffff', '#1c1c1e']);
assert.deepStrictEqual(dead.colors, []); assert.strictEqual(broadcasts, 2);

console.log('pane background guard: all passed');
