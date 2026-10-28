// Popup sleep setting, IPC, pointer gestures and lifecycle without launching Electron.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { pathToFileURL } = require('url');
const SC = require('../src/state-schema'), IPC = require('../src/ipc-policy');
const Hold = require('../src/gbar-long-press'), Sleep = require('../src/sleep-rules');
const root = path.join(__dirname, '..'), read = f => fs.readFileSync(path.join(root, f), 'utf8');
const main = read('src/main.js'), renderer = read('src/renderer.js');
const segment = (text, from, to) => { const a = text.indexOf(from), b = text.indexOf(to, a + from.length); assert(a >= 0 && b > a, from); return text.slice(a, b); };

// Old settings remain absent; booleans round-trip and other values are dropped.
assert(!Object.hasOwn(SC.migrate({}).doc.settings, 'approveKeepAwake'));
for (const value of [true, false]) {
  const r = SC.migrate({ settings: { approveKeepAwake: value } });
  assert(r.ok); assert.strictEqual(r.doc.settings.approveKeepAwake, value);
  assert.deepStrictEqual(SC.validate(r.doc), []);
  assert.strictEqual(SC.parse(SC.serialize(r.doc)).doc.settings.approveKeepAwake, value);
}
for (const value of [null, 0, 1, 'true', '', [], {}]) {
  const r = SC.migrate({ settings: { approveKeepAwake: value } });
  assert(r.ok); assert(!Object.hasOwn(r.doc.settings, 'approveKeepAwake'));
  assert(r.fixes.some(f => f.includes('settings.approveKeepAwake')));
  assert(SC.validate({ ...SC.emptyDoc(), settings: { approveKeepAwake: value } }).some(e => e.includes('settings.approveKeepAwake')));
}

// Only owned chrome can send this fixed, argument-less toggle.
const sender = role => ({ role, frame: { top: true, detached: false,
  url: pathToFileURL(path.join(root, role === 'overlay' ? 'src/overlay.html' : 'src/index.html')).href, origin: 'file://' } });
const channel = 'approve-keep-awake-toggle';
assert.strictEqual(IPC.check(channel, sender('chrome'), [], { owned: true }), null);
for (const value of [true, false, null, {}, 'x']) assert.strictEqual(IPC.check(channel, sender('chrome'), [value], { owned: true }), 'E_PAYLOAD');
for (const role of ['overlay', 'pane', 'probe', 'approve']) assert.strictEqual(IPC.check(channel, sender(role), [], { owned: true }), 'E_ROLE');
assert.strictEqual(IPC.check(channel, sender('chrome'), [], { owned: false }), 'E_OWNER');
assert.strictEqual(IPC.check(channel, { ...sender('chrome'), frame: { ...sender('chrome').frame, top: false } }, [], { owned: true }), 'E_FRAME');
let api; const sends = [];
vm.runInNewContext(read('src/preload.js'), { process: { platform: 'darwin' }, require: () => ({
  contextBridge: { exposeInMainWorld: (_, value) => { api = value; } }, ipcRenderer: { send: (...args) => sends.push(args) }
}) });
api.approveKeepAwakeToggle(true);
assert.deepStrictEqual(sends, [[channel]]);
assert(main.includes("on('approve-keep-awake-toggle', () => toggleApproveKeepAwake())"));
assert(main.includes('keepAwake: settings.approveKeepAwake === true'));

// Exercise the real button handlers and tooltip with the same helper as the bar.
{
  const calls = [], classes = {}, label = {}, listeners = {}, animations = [];
  const rect = { x: 5, y: 6, width: 28, height: 28 };
  const button = { dataset: {}, getBoundingClientRect: () => rect,
    setAttribute: (k, v) => { button[k] = v; }, classList: { toggle: (k, v) => { classes[k] = v; } },
    addEventListener: (k, fn) => { listeners[k] = fn; }, animate: (frames, options) => {
      const a = { frames, options, cancelled: false, cancel() { this.cancelled = true; } }; animations.push(a); return a;
    } };
  const ctx = { $: s => s === '#approve-btn' ? button : label, GbarLongPress: Hold,
    mpb: { approveOpen: r => calls.push(['open', r]), approveInline: r => calls.push(['inline', r]),
      approveKeepAwakeToggle: () => calls.push(['toggle']), approveInlineAnchor() {}, onApproveAnchorRequest() {} } };
  vm.runInNewContext(segment(renderer, 'function setTip(', 'function tipAttrs(')
    + segment(renderer, 'function approveButtonRect() {', 'let approveSavedTimer;'), ctx);
  const event = (timeStamp, extra = {}) => ({ button: 0, pointerId: 1, isPrimary: true, clientX: 20, clientY: 30, timeStamp, detail: 1,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });
  const click = (t, extra) => { const e = event(t, extra); button.onclick(e); return e; };
  const hold = (elapsed, extra = {}) => { button.onpointerdown(event(1000, extra)); button.onpointerup(event(1000 + elapsed, extra)); return click(1000 + elapsed, extra); };

  const short = hold(Hold.HOLD_MS - 1);
  assert(!short.prevented && calls.length === 1 && calls[0][0] === 'open' && JSON.stringify(calls[0][1]) === JSON.stringify(rect));
  assert.strictEqual(animations[0].frames[0].backgroundColor, 'var(--ctl-hi)');
  assert.strictEqual(animations[0].frames[1].backgroundColor, 'var(--accent)');
  assert.strictEqual(animations[0].options.duration, Hold.HOLD_MS);
  assert.strictEqual(animations[0].options.easing, 'linear'); assert.strictEqual(animations[0].options.fill, 'forwards');
  assert(animations[0].cancelled);
  calls.length = 0;
  const long = hold(Hold.HOLD_MS);
  assert(long.prevented && long.stopped); assert.deepStrictEqual(calls, [['toggle']]);
  assert(animations.at(-1).cancelled);
  click(1600); assert.strictEqual(calls[1][0], 'open', 'only the following click is suppressed');
  calls.length = 0;
  button.onpointerdown(event(2000)); button.onpointerup(event(2600));
  click(2601, { detail: 0 }); assert.deepStrictEqual(calls.map(c => c[0]), ['toggle', 'open'], 'keyboard activation still opens');
  calls.length = 0;
  button.onpointerdown(event(3000)); button.onpointermove(event(3100, { clientX: 27 })); button.onpointerup(event(3600));
  assert(click(3601).prevented); assert.deepStrictEqual(calls, []); assert(animations.at(-1).cancelled);
  button.onpointerdown(event(4000)); button.onpointerleave(event(4100));
  click(4200, { detail: 0 }); assert.deepStrictEqual(calls.map(c => c[0]), ['open']);
  calls.length = 0;
  button.onpointerdown(event(5000, { button: 2 })); button.onpointerup(event(5600, { button: 2 }));
  const right = event(5600, { button: 2 }); button.oncontextmenu(right);
  assert(right.prevented && calls.length === 1 && calls[0][0] === 'inline' && JSON.stringify(calls[0][1]) === JSON.stringify(rect));
  assert.strictEqual(typeof listeners.dragstart, 'function');
  ctx.renderApproveButton({ configured: true, label: '', keepAwake: false });
  assert(classes['icon-only'] && !classes['keep-awake'] && button.dataset.tipDetail.includes('自動スリープ'));
  ctx.renderApproveButton({ configured: true, label: '', keepAwake: true });
  assert(classes['icon-only'] && classes['keep-awake'] && button.dataset.tipDetail.includes('常時起動'));
  ctx.renderApproveButton({ configured: true, label: 'Bot', keepAwake: true });
  assert(!classes['icon-only'] && classes['keep-awake'] && button.dataset.tipDetail.includes('常時起動'));
  assert(button.dataset.tipDetail.includes('長押し'));
  const css = read('src/style.css');
  assert(/#approve-btn\.keep-awake\s*\{[^}]*box-shadow:\s*inset\s+0\s+0\s+0\s+1\.5px\s+var\(--accent\)/.test(css));
}

// A controllable clock drives the actual popup functions across two windows.
function clock() {
  let now = 0, next = 0; const tasks = new Map();
  return { setTimeout(fn, delay) { const id = ++next; tasks.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { tasks.delete(id); }, count() { return tasks.size; },
    advance(ms) { const end = now + ms; for (;;) {
      const due = [...tasks].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break; now = due[1].at; tasks.delete(due[0]); due[1].fn();
    } now = end; } };
}
const durationCode = main.match(/const APPROVE_KEEP_MS = [^\n]+/)[0];
const delay = vm.runInNewContext(`${durationCode}\nAPPROVE_KEEP_MS`, { require: name => { assert.strictEqual(name, './sleep-rules'); return Sleep; } });
assert.strictEqual(delay, Sleep.SLEEP_WAIT_MS); assert.strictEqual(delay, 30 * 60 * 1000);
const popupCode = segment(main, 'function ensureApprove(url) {', 'function openApproveSettings() {')
  + segment(main, 'function syncApproveSleep() {', 'function openOverlay(mode, extra = {}) {');
const toggleCode = segment(main, 'function toggleApproveKeepAwake() {', '// ---- links opened from page content');
{
  const time = clock(), settings = {}, events = [], windows = [];
  function makeWindow() {
    let loads = 0, closes = 0;
    class FakeView {
      constructor() {
        let destroyed = false;
        this.webContents = { isDestroyed: () => destroyed, isCrashed: () => false, close: () => { destroyed = true; closes++; },
          setWindowOpenHandler() {}, on() {}, focus() {} };
      }
      setBorderRadius() {} setBackgroundColor() {} setVisible() {} setBounds() {}
    }
    const ctx = { settings, APPROVE_KEEP_MS: delay, approve: null, approveOpen: false, approveTimer: null, approvePane: null,
      setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, WebContentsView: FakeView,
      AS: { normalizeUrl: v => v }, nativeTheme: { shouldUseDarkColors: false }, ctx: {}, dlog() {},
      rememberKeyboard() {}, regWc() {}, unregWc() {}, guardNavigation() {}, linkOpen() {},
      loadInto: () => { loads++; }, approveEffective: () => ({ url: 'fixture' }), approveRect: () => ({}),
      GROK_BOT_RE: /^$/, closeOverlay() {}, openOverlay() {}, openApproveInline() {}, overlayOpen: false,
      win: { contentView: { addChildView() {}, removeChildView() {} } } };
    vm.runInNewContext(popupCode, ctx);
    const w = { ctx, syncApproveSleep: () => ctx.syncApproveSleep(), loads: () => loads, closes: () => closes };
    windows.push(w); return w;
  }
  const a = makeWindow(), b = makeWindow();
  const global = { settings, ctxs: windows, save: () => events.push('save'), broadcast: () => events.push('broadcast') };
  vm.runInNewContext(toggleCode, global);
  a.ctx.openApprove(); b.ctx.openApprove();
  assert.strictEqual(a.loads(), 1); assert.strictEqual(b.loads(), 1);
  a.ctx.hideApprove(); b.ctx.hideApprove(); assert.strictEqual(time.count(), 2);
  time.advance(delay - 1); assert.strictEqual(a.closes() + b.closes(), 0);
  global.toggleApproveKeepAwake();
  assert.strictEqual(settings.approveKeepAwake, true); assert.strictEqual(time.count(), 0);
  assert.deepStrictEqual(events, ['save', 'broadcast']);
  time.advance(delay * 3); assert.strictEqual(a.closes() + b.closes(), 0);
  a.ctx.hideApprove(); assert.strictEqual(time.count(), 0, 'hiding while always-on never schedules sleep');
  global.toggleApproveKeepAwake();
  assert.strictEqual(settings.approveKeepAwake, false); assert.strictEqual(time.count(), 2);
  time.advance(delay - 1); assert.strictEqual(a.closes() + b.closes(), 0);
  global.toggleApproveKeepAwake(); assert.strictEqual(time.count(), 0, 'always-on cancels both pending timers');
  global.toggleApproveKeepAwake(); assert.strictEqual(time.count(), 2, 'auto-sleep restarts both hidden timers');
  time.advance(delay); assert.strictEqual(a.closes(), 1); assert.strictEqual(b.closes(), 1);
  assert.strictEqual(a.ctx.approve, null); assert.strictEqual(b.ctx.approve, null);
  a.ctx.openApprove(); assert.strictEqual(a.loads(), 2, 'the next open loads a new view');
  a.ctx.hideApprove(); assert.strictEqual(time.count(), 1);
  a.ctx.openApprove(); assert.strictEqual(time.count(), 0, 'reopening cancels the pending timer');
  time.advance(delay * 2); assert.strictEqual(a.closes(), 1, 'an open popup is not destroyed');
  global.toggleApproveKeepAwake(); global.toggleApproveKeepAwake();
  assert.strictEqual(time.count(), 0, 'open or unloaded views do not get idle timers');
}

console.log('ok  approve-keep-awake');
