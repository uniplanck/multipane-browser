// node test/wake-focus.test.js — pure wake focus policy + real queue order, with main's native-focus adapter under mocked WebContents.
// No Electron / page loads: native OS focus delivery still needs a manual app check.
const assert = require('assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const { mayKeepPaneFocus } = require('../src/sleep-rules');
const LQ = require('../src/load-queue');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
function source(name) {
  const a = main.indexOf(`function ${name}(`);
  assert(a >= 0, name);
  let i = main.indexOf('{', main.indexOf(')', a)), depth = 0;
  for (; i < main.length; i++) {
    if (main[i] === '{') depth++;
    else if (main[i] === '}' && --depth === 0) return main.slice(a, i + 1);
  }
  throw new Error(`unclosed ${name}`);
}

// Waking / showing / fixing a pane never grants permission to select it or to replace chrome's keyboard focus.
assert(!mayKeepPaneFocus());
assert(!mayKeepPaneFocus({ paneId: 3, focusedId: 3 })); // no accepted owner is not permission
for (const sleeping of [true, false]) {
  for (const paneId of [1, 2, 3, 4, 5]) {
    assert.strictEqual(mayKeepPaneFocus({ paneId, focusedId: 3, sleeping, ownsKeyboard: true }), !sleeping && paneId === 3);
    assert(!mayKeepPaneFocus({ paneId, focusedId: 3, sleeping, ownsKeyboard: false }));
  }
}

let actual, active = true;
const calls = [];
const contents = name => ({
  isDestroyed: () => false, isFocused: () => actual === name, send() {}, sendInputEvent: ev => calls.push(`key:${name}:${ev.type}`),
  focus: () => { actual = name; calls.push(`focus:${name}`); },
  blur: () => { throw new Error("WebContents has no blur()"); }
});
const panes = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, sleeping: true, view: { webContents: contents(`p${i + 1}`) } }));
const chrome = contents('chrome'), overlay = contents('overlay');
const ctx = vm.createContext({ mayKeepPaneFocus, panes, focused: 6, keyboardFocus: chrome, maximizedId: null, win: { isDestroyed: () => false, webContents: chrome },
  windowActive: () => active, clearUnread() {}, relayout() {},
  setFocused: i => { ctx.focused = i; } });
vm.runInContext(`${source('paneGotFocus')}\n${source('focusPane')}`, ctx);
const nativeFocus = p => { actual = `p${p.id}`; ctx.paneGotFocus(p); };

// A BULK wake burst starts the selected pane first, runs four at once, and keeps the exact chrome keyboard owner.
const starts = [], q = LQ.createLoadQueue({ rank: t => t.ent === panes[ctx.focused].id ? 0 : 1 });
actual = 'chrome';
q.batch(() => panes.forEach(p => q.request({ ent: p.id, purpose: 'WAKE', cls: 'BULK', onStart() {
  starts.push(p.id); p.sleeping = false; nativeFocus(p); // delayed native focus as a view becomes visible
} })));
assert.deepStrictEqual(starts, [7, 1, 2, 3]);
assert.strictEqual(q.stats().used, 4);
assert.strictEqual(ctx.focused, 6);
assert.strictEqual(actual, 'chrome');
assert(!calls.some(c => c.startsWith('focus:p')));

// A click into a particular pane is authorized before its native focus. Later queue starts / finish-load / fix events cannot undo it.
ctx.focusPane(1);
assert.strictEqual(ctx.focused, 1);
assert.strictEqual(actual, 'p2');
calls.length = 0;
while (q.list().length) {
  const t = q.find(t => t.state === 'run');
  nativeFocus(panes[t.ent - 1]); // a late page / bot-fix focus request
  q.finish(t.id);
  assert.strictEqual(ctx.focused, 1);
  assert.strictEqual(actual, 'p2');
}
assert(calls.filter(c => c.startsWith('focus:')).every(c => c === 'focus:p2'));

// Even the logically selected pane must leave an overlay's keyboard alone; background windows never get fronted for restoration.
ctx.keyboardFocus = overlay; actual = 'overlay'; nativeFocus(panes[1]);
assert.strictEqual(actual, 'overlay');
active = false; calls.length = 0; nativeFocus(panes[2]);
assert(!calls.some(c => c.startsWith('focus:')));
active = true;

// Workspace replacement may destroy the former owner: neither an absent nor a destroyed owner authorizes a new selected view.
for (const owner of [null, { isDestroyed: () => true }]) {
  ctx.keyboardFocus = owner; calls.length = 0; nativeFocus(panes[ctx.focused]);
  assert.strictEqual(actual, "chrome");   // no owner: the keyboard goes to the app UI, never stays in the woken pane
  assert(!calls.some(c => c.startsWith('focus:p')));
}
ctx.keyboardFocus = overlay;
panes[1].sleeping = true; actual = 'overlay'; nativeFocus(panes[1]);
assert.strictEqual(actual, 'overlay');
assert.strictEqual(panes[1].sleeping, true);

// A stale owner (the user changed the selection while a task waited) is never focused again.
ctx.keyboardFocus = panes[0].view.webContents; calls.length = 0; nativeFocus(panes[2]);
assert(!calls.some(c => c.startsWith('focus:p')));   // the stale pane is not focused again (the app UI takes the keyboard)

// Page navigation / viewer cleanup can undo their maximize without selecting or focusing their pane.
panes[1].sleeping = false; ctx.keyboardFocus = panes[1].view.webContents; actual = 'p2';
Object.assign(ctx, { byId: id => panes.find(p => p.id === id), dlog() {} });
vm.runInContext(`${source('toggleMaximize')}\n${source('setPcMax')}\n${source('setImgMax')}`, ctx);
const bg = panes[2];
ctx.maximizedId = bg.id; bg.pcMax = true; bg.pcMaxedPane = true; calls.length = 0;
ctx.setPcMax(bg, false);
assert.strictEqual(ctx.maximizedId, null);
assert.strictEqual(ctx.focused, 1);
assert.strictEqual(actual, 'p2');
assert(!calls.some(c => c.startsWith('focus:')));
ctx.maximizedId = bg.id; bg.imgMax = true; bg.imgMaxedPane = true;
ctx.setImgMax(bg, false);
assert.strictEqual(ctx.maximizedId, null);
assert.strictEqual(ctx.focused, 1);
assert(!calls.some(c => c.startsWith('focus:')));

// Source contracts for the real adapters: wake is selection-free, explicit renderer clicks select separately, native mouse input selects.
const wake = main.match(/^on\('wake-pane'.*$/m)[0];
assert(wake.includes('reloadPane(p)') && !/setFocused|focusPane|\.focus\(/.test(wake));
assert(renderer.includes('const openSleeping = () => { mpb.focusPane(id); mpb.wakePane(id); }'));
assert(renderer.includes("d.querySelector('.sleepph').onclick = openSleeping;"));
assert(main.includes("wc.on('before-mouse-event', (e, m) => { if (m.type === 'mouseDown' && !p.sleeping) focusPane(panes.indexOf(p)); });"));
assert(!/setFocused|focusPane|\.focus\(/.test(main.match(/^paneOn\('pane:interact'.*$/m)[0]));
for (const name of ['reloadPane', 'startView', 'showViews', 'grokFix', 'onGrokLoad', 'fixLoad', 'reloadAll']) {
  assert(!/setFocused\(|focusPane\(|focusPaneById\(|\.focus\(/.test(source(name)), `${name} must not select / focus`);
}
const finishLoad = main.match(/wc\.on\('did-finish-load', \(\) => \{[\s\S]*?\n  \}\);/)[0];
assert(!/setFocused\(|focusPane\(|\.focus\(/.test(finishLoad));
assert(source('loadWorkspace').includes('const wasFocused = focused;'));
assert(source('loadWorkspace').includes('setFocused(Math.min(wasFocused, panes.length - 1));'));
assert(!source('loadWorkspace').includes('setFocused(0)'));
assert(source('disposePane').includes('if (keyboardFocus === wc) keyboardFocus = null;'));
const send = main.slice(main.indexOf('  async send(p, h) {'), main.indexOf('async function bcPreview'));
assert(send.includes("if (panes[focused] !== p || !wc.isFocused() || !windowActive() || overlayOpen) return 'nobutton';"));
assert(!/\.focus\(/.test(send));
for (const channel of ['pc', 'img']) {
  const opened = main.match(new RegExp(`paneOn\\('pane:${channel}-opened'[\\s\\S]*?\\n\\}\\);`))[0];
  assert(opened.includes('if (!inView(p) || !p.view.webContents.isFocused()) return;'));
}
assert(source('guardOnce').includes('fw === keyboardFocus'));

(async () => {
  // Run the real Enter adapter with mocked page JS: a background / overlay target is left unsent, and no native focus is requested.
  Object.assign(ctx, { BC_DRY: false, bcJs: async () => ({ r: 'enter' }), BC_SEND_JS: () => '', overlayOpen: false });
  vm.runInContext(`const bcPage = { ${send} globalThis.page = bcPage;`, ctx);
  actual = 'p2'; calls.length = 0;
  assert.strictEqual(await ctx.page.send(bg, ''), 'nobutton');
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(await ctx.page.send(panes[1], ''), 'enter');
  assert.deepStrictEqual(calls, ['key:p2:keyDown', 'key:p2:char', 'key:p2:keyUp']);
  ctx.overlayOpen = true; calls.length = 0;
  assert.strictEqual(await ctx.page.send(panes[1], ''), 'nobutton');
  assert.strictEqual(calls.length, 0);
  console.log('all passed: wake order / focus policy / native adapter / cleanup / broadcast / wake wiring');
})().catch(e => { console.error(e); process.exitCode = 1; });
