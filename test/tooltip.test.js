// node test/tooltip.test.js — chrome coverage, placement, IPC and controller behaviour.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const html = read('index.html'), renderer = read('renderer.js'), css = read('tooltip.css');
const controller = read('tooltip-controller.js'), main = read('main.js');
const { placeTooltip } = require('../src/tooltip-layout');
const IPC = require('../src/ipc-policy');

// Document title and the pane's .title text/class are not tooltip attributes.
for (const [file, text] of [['index.html', html], ['renderer.js', renderer], ['tooltip-controller.js', controller]]) {
  assert(!/(?:\s|<)title\s*=\s*["'`]/i.test(text), `${file}: native title attribute`);
  assert(!/\.title\s*=/.test(text), `${file}: native title property`);
  assert(!/setAttribute\(\s*["']title["']/.test(text), `${file}: native title setter`);
}
for (const id of ['mem', 'cpu', 'queue-sum', 'unread-sum', 'save-warn', 'ws-btn', 'sync-cols', 'reload-all', 'reopen', 'add', 'cmdk', 'approve-btn', 'fav-star']) {
  const tag = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`));
  assert(tag && /data-tip=/.test(tag[0]) && /aria-label=/.test(tag[0]), `${id} needs a tip and accessible name`);
}
for (const action of ['back', 'forward', 'reload', 'maximize', 'paneMenu', 'sleepToggle']) {
  assert(new RegExp(`data-a="${action}"[^>]*tipAttrs\\(`).test(renderer), `pane control ${action}`);
}
for (const [name, pattern] of Object.entries({
  presets: /setTip\(b, `レイアウト/, otherWindows: /class="owin"[^\n]*tipAttrs/, otherPanes: /class="ochip[^\n]*tipAttrs/,
  badge: /class="badge"[^>]*data-tip="閉じる"/, placeholderCancel: /class="lqx" \$\{tipAttrs/,
  placeholderLogin: /class="pbx pbl" \$\{tipAttrs/, placeholderResume: /class="pbx pbr" \$\{tipAttrs/,
  placeholderReload: /class="pbx gpr" \$\{tipAttrs/, paneChip: /setTip\(c, p\.name/, copyChip: /class="cicon[^\n]*tipAttrs/,
  sleepChip: /class="zz" \$\{tipAttrs/, statusChip: /class="wdot[^\n]*tipAttrs/, splitter: /setTip\(e, 'ペインの幅を調整'/,
  paneAddress: /setTip\(d\.querySelector\('\.title'\)/, paneMeta: /class="rfail" \$\{tipAttrs/,
  bot: /setTip\(el, b\.name/, favorite: /setTip\(b, name \|\| 'お気に入り'/,
  group: /setTip\(h, s\.name/, nextPage: /setTip\(gNext, '次のページ'/,
  compact: /setTip\(b,'コンパクト表示'/, usage: /setTip\(btn, NAME\[kind\]/,
})) assert(pattern.test(renderer), `missing tooltip target: ${name}`);
assert(/pointer-events\s*:\s*none/.test(css));
assert(/prefers-reduced-motion/.test(css) && /\.tip-card\.light/.test(css));
assert(/focusable: false/.test(main) && /setIgnoreMouseEvents\(true\)/.test(main) && /showInactive\(\)/.test(main));
assert(/if \(!win.*overlayOpen\) return/.test(main) && /function openOverlay[\s\S]*?dismissTip\(\)/.test(main));
assert(/const MOD = mac \? '⌘' : 'Ctrl\+'/.test(renderer));
assert(/default-src 'self'; style-src 'self'/.test(read('tooltip.html')));
assert(!/ipcRenderer\.(send|invoke|sendSync)/.test(read('tooltip-preload.js')));

// Placement always stays inside the chrome content bounds, including oversize content.
const viewport = { width: 600, height: 400 };
let p = placeTooltip({ x: 100, y: 30, width: 20, height: 20 }, { width: 180, height: 70 }, viewport);
assert.strictEqual(p.y, 56); // below
p = placeTooltip({ x: 550, y: 370, width: 30, height: 20 }, { width: 200, height: 90 }, viewport);
assert.strictEqual(p.y, 274); // flips above at the bottom edge
p = placeTooltip({ x: 300, y: 100, width: 20, height: 20 }, { width: 100, height: 60 }, viewport, true);
assert.strictEqual(p.x, 326); // usage popover remains alongside the gauge
{
  const pop = { x: 276, y: 45, width: 320, height: 350 };
  p = placeTooltip({ x: 555, y: 10, width: 32, height: 28 }, { width: 376, height: 70 }, viewport, true, pop);
  assert(p.x + p.width <= pop.x && p.width < 376, 'usage popover must remain unobscured');
  assert(p.x >= 4 && p.y >= 4 && p.x + p.width <= 596 && p.y + p.height <= 396);
  for (let x = 4; x <= 276; x += 8) {
    const obstacle = { ...pop, x };
    const result = placeTooltip({ x: 300, y: 10, width: 32, height: 28 }, { width: 376, height: 70 }, viewport, true, obstacle);
    assert(result.x + result.width <= obstacle.x || result.x >= obstacle.x + obstacle.width || result.y + result.height <= obstacle.y || result.y >= obstacle.y + obstacle.height);
  }
}
for (let i = 0; i < 5000; i++) {
  const rect = { x: Math.random() * 700 - 50, y: Math.random() * 500 - 50, width: Math.random() * 80, height: Math.random() * 80 };
  const size = { width: 1 + Math.random() * 1000, height: 1 + Math.random() * 700 };
  const r = placeTooltip(rect, size, viewport, i % 2 === 0);
  assert(r.x >= 4 && r.y >= 4 && r.x + r.width <= 596 && r.y + r.height <= 396);
}

// Fragment updates keep a hovered target alive as counts and markers change.
{
  const { sync } = require('../src/tooltip-dom');
  class Node {
    constructor(tag, attrs = {}, children = []) {
      this.nodeType = tag === '#text' ? 3 : 1; this.tagName = tag.toUpperCase(); this.nodeValue = this.nodeType === 3 ? attrs.text : null;
      this.attrs = this.nodeType === 1 ? { ...attrs } : {}; this.childNodes = []; this.parentNode = null;
      children.forEach(child => this.insertBefore(child, null));
    }
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
    getAttributeNames() { return Object.keys(this.attrs); }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    setAttribute(name, value) { this.attrs[name] = value; }
    removeAttribute(name) { delete this.attrs[name]; }
    insertBefore(node, before) {
      if (node.parentNode) node.parentNode.removeChild(node);
      const at = before ? this.childNodes.indexOf(before) : this.childNodes.length;
      this.childNodes.splice(at, 0, node); node.parentNode = this; return node;
    }
    removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
    cloneNode(deep) { return new Node(this.nodeType === 3 ? '#text' : this.tagName, this.nodeType === 3 ? { text: this.nodeValue } : this.attrs, deep ? this.childNodes.map(x => x.cloneNode(true)) : []); }
  }
  const text = value => new Node('#text', { text: value });
  const icon = new Node('span', { class: 'cicon', 'data-tip': 'リンクをコピー', 'data-tip-detail': '新着 1件' }, [text('1')]);
  const label = new Node('span', { class: 'clabel' }, [text('Bot')]);
  const marker = new Node('span', { class: 'wdot', 'data-tip': '待機中' });
  const parent = new Node('div', {}, [icon, label, marker]);
  const next = new Node('div', {}, [new Node('span', { class: 'cicon ccount', 'data-tip': 'リンクをコピー', 'data-tip-detail': '新着 2件' }, [text('2')]),
    new Node('span', { class: 'clabel' }, [text('Bot')]), new Node('span', { class: 'wdot work', 'data-tip': '作業中' })]);
  sync(parent, next);
  assert.strictEqual(parent.childNodes[0], icon); assert.strictEqual(icon.childNodes[0].nodeValue, '2');
  assert.strictEqual(icon.getAttribute('data-tip-detail'), '新着 2件'); assert.strictEqual(parent.childNodes[2], marker);
  assert.strictEqual(marker.getAttribute('data-tip'), '作業中');
  sync(parent, new Node('div', {}, [new Node('span', { class: 'cicon' }, [text('3')]), new Node('span', { class: 'clabel' }, [text('Bot')])]));
  assert.strictEqual(parent.childNodes[0], icon); assert.strictEqual(marker.parentNode, null);
  const first = new Node('button', { class: 'ochip', 'data-w': '1', 'data-p': '1' });
  const second = new Node('button', { class: 'ochip', 'data-w': '1', 'data-p': '2' });
  const others = new Node('div', {}, [first, second]);
  sync(others, new Node('div', {}, [new Node('button', { class: 'ochip working', 'data-w': '1', 'data-p': '2' }), new Node('button', { class: 'ochip', 'data-w': '1', 'data-p': '1' })]));
  assert.strictEqual(others.childNodes[0], second); assert.strictEqual(others.childNodes[1], first);
}

// IPC is chrome-only and validates bounds/text before the child window is touched.
const payload = { tip: { name: '戻る', description: '前に戻ります。', key: '⌘[', detail: '', dark: true },
  rect: { x: 10, y: 20, width: 30, height: 20 }, size: { width: 160, height: 70 }, preferSide: false };
const sender = role => ({ role, frame: { top: true, detached: false, url: `file://${IPC.DOCS[role] || '/tmp/other'}`, origin: 'file://' } });
const check = (role, arg) => IPC.check('tip-show', sender(role), [arg], { owned: true });
assert.strictEqual(check('chrome', payload), null);
for (const role of ['overlay', 'pane', 'probe', 'approve']) assert.strictEqual(check(role, payload), 'E_ROLE');
assert.strictEqual(check('chrome', { ...payload, rect: { ...payload.rect, x: Infinity } }), 'E_PAYLOAD');
assert.strictEqual(check('chrome', { ...payload, tip: { ...payload.tip, detail: 'x'.repeat(2049) } }), 'E_PAYLOAD');
assert.strictEqual(check('chrome', { ...payload, size: { width: 0, height: 20 } }), 'E_PAYLOAD');

// Exercise the real event controller with a deterministic clock and a small DOM.
function fixture() {
  let time = 10000, next = 1, observer, shown = [], hides = 0, prepared = 0;
  const timers = new Map(), dl = {}, wl = {};
  const body = { nodeType: 1, parentElement: null, hidden: false, classList: { contains: () => false } };
  const measure = { id: '', contains: el => el === measure, getBoundingClientRect: () => ({ width: 200, height: 70 }) };
  body.appendChild = () => {};
  const doc = { body, addEventListener: (type, cb) => (dl[type] ||= []).push(cb) };
  const win = { addEventListener: (type, cb) => (wl[type] ||= []).push(cb) };
  function el(name, x = 20) {
    const node = { nodeType: 1, parentElement: body, hidden: false, isConnected: true,
      dataset: { tip: name, tipDesc: '説明', tipKey: '⌘K', tipDetail: 'ON' },
      getBoundingClientRect: () => ({ left: x, top: 20, right: x + 20, bottom: 40, width: 20, height: 20 }),
      closest: sel => sel === '[data-tip]' ? node : null, contains: x => x === node,
      matches: sel => sel === ':focus-visible' };
    return node;
  }
  const ctx = vm.createContext({ document: doc, window: win, innerWidth: 600, innerHeight: 400,
    getComputedStyle: n => ({ display: n.display || 'block', visibility: n.visibility || 'visible', opacity: n.opacity ?? '1' }),
    TooltipCard: { create: () => measure, render: (_, tip) => { measure.tip = tip; } },
    mpb: { tipShow: tip => shown.push(tip), tipPrepare: () => { prepared++; }, tipHide: () => { hides++; }, onTipDismiss: cb => { wl['tip-dismiss'] = [cb]; } },
    Date: { now: () => time },
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, at: time + ms }); return id; }, clearTimeout: id => timers.delete(id),
    MutationObserver: class { constructor(cb) { observer = cb; } observe() {} } });
  vm.runInContext(controller, ctx);
  const fire = (type, event, listeners = dl) => (listeners[type] || []).forEach(cb => cb(event || {}));
  const advance = ms => { const end = time + ms; for (;;) { const due = [...timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; time = due[1].at; timers.delete(due[0]); due[1].fn(); } time = end; };
  return { el, fire, advance, observer: records => observer(records), win: wl, get shown() { return shown; }, get hides() { return hides; }, get prepared() { return prepared; } };
}
{
  const f = fixture(), a = f.el('最初'), b = f.el('次', 70);
  f.fire('mouseover', { target: a }); assert.strictEqual(f.prepared, 1); f.advance(299); assert.strictEqual(f.shown.length, 0);
  f.advance(1); assert.strictEqual(f.shown[0].tip.name, '最初');
  a.dataset.tipDetail = 'OFF'; f.observer([{ target: a }]); assert.strictEqual(f.shown.at(-1).tip.detail, 'OFF');
  f.fire('mouseout', { target: a, relatedTarget: b }); f.advance(39); assert.strictEqual(f.shown.at(-1).tip.name, '最初');
  f.advance(1); assert.strictEqual(f.shown.at(-1).tip.name, '次');
  f.fire('mouseout', { target: b, relatedTarget: null }); assert(f.hides > 0);
  f.advance(400); f.fire('focusin', { target: a }); f.advance(299); const n = f.shown.length; f.advance(1); assert.strictEqual(f.shown.length, n + 1);
  f.fire('focusout', { target: a });
  for (const trigger of ['mousedown', 'click', 'scroll', 'wheel', 'dragstart', 'keydown', 'blur', 'resize']) {
    f.advance(400); f.fire('mouseover', { target: a }); f.advance(300); const before = f.hides;
    f.fire(trigger, trigger === 'keydown' ? { key: 'Escape' } : {}, trigger === 'blur' || trigger === 'resize' ? f.win : undefined);
    assert(f.hides > before, `${trigger} must hide the tooltip`);
  }
  f.advance(400); f.fire('mouseover', { target: a }); f.advance(300); let before = f.hides;
  a.isConnected = false; f.observer([{ target: a }]); assert(f.hides > before, 'removal hides');
  a.isConnected = true; f.advance(400); f.fire('mouseover', { target: a }); f.advance(300); before = f.hides;
  a.hidden = true; f.observer([{ target: a }]); assert(f.hides > before, 'hidden target hides');
  a.hidden = false; f.advance(400); f.fire('mouseover', { target: a }); f.advance(200); before = f.shown.length;
  f.fire('mouseout', { target: a, relatedTarget: null }); f.advance(200); assert.strictEqual(f.shown.length, before, 'leaving cancels pending show');
}
// Exercise the real main-process window code without starting Electron or
// touching the application's profile. The fake child records input/focus and
// lets us resolve its page load after a hide or overlay transition.
async function mainWindowTests() {
  const section = main.slice(main.indexOf('let tipWindow = null'), main.indexOf('let queueNote ='));
  let child, resolveLoad, rejectLoad, guarded;
  class Child {
    constructor(options) { child = this; this.options = options; this.visible = false; this.dead = false; this.messages = [];
      this.webContents = { send: (...args) => this.messages.push(args) }; }
    setIgnoreMouseEvents(v) { this.ignoresMouse = v; }
    loadFile(file) { this.file = file; return new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; }); }
    isDestroyed() { return this.dead; }
    isVisible() { return this.visible; }
    setBounds(bounds) { this.bounds = bounds; }
    showInactive() { this.visible = true; this.shownInactive = true; }
    hide() { this.visible = false; }
    destroy() { this.dead = true; }
  }
  const sent = [];
  const win = { focused: true, visible: true, isDestroyed: () => false, isVisible() { return this.visible; }, isFocused() { return this.focused; },
    getContentBounds: () => ({ x: 100, y: 70, width: 600, height: 400 }), webContents: { isDestroyed: () => false, send: (...args) => sent.push(args) } };
  const make = new Function('win', 'BrowserWindow', 'path', 'guardUi', 'placeTooltip', '__dirname',
    `let overlayOpen = false, popOpen = false, overlay = null; ${section}; return { showTip, prepareTip, hideTip, dismissTip,
      setOverlay: value => { overlayOpen = value; }, setPopover: bounds => { popOpen = !!bounds; overlay = bounds ? { getBounds: () => bounds } : null; } };`);
  const tip = make(win, Child, path, wc => { guarded = wc; }, placeTooltip, '/app/src');
  tip.prepareTip(); // page loading starts during the hover dwell
  assert.strictEqual(child.options.parent, win); assert.strictEqual(child.options.focusable, false);
  assert.strictEqual(child.options.webPreferences.sandbox, true); assert.strictEqual(child.options.webPreferences.nodeIntegration, false);
  assert.strictEqual(child.ignoresMouse, true); assert.strictEqual(guarded, child.webContents); assert(child.file.endsWith('/tooltip.html'));
  tip.showTip(payload); tip.hideTip(); resolveLoad(); await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(child.visible, false, 'hide cancels an in-flight page load');
  tip.showTip(payload); await Promise.resolve(); await Promise.resolve();
  assert(child.visible && child.shownInactive); assert.strictEqual(child.messages.at(-1)[1].name, '戻る');
  assert.strictEqual(child.messages.at(-1)[1].entering, true); assert(win.focused);
  assert(child.bounds.x >= 104 && child.bounds.y >= 74 && child.bounds.x + child.bounds.width <= 696 && child.bounds.y + child.bounds.height <= 466);
  tip.showTip({ ...payload, tip: { ...payload.tip, detail: '更新' } }); await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(child.messages.at(-1)[1].detail, '更新'); assert.strictEqual(child.messages.at(-1)[1].entering, false);
  tip.setPopover({ x: 276, y: 45, width: 320, height: 350 });
  tip.showTip({ ...payload, preferSide: true, rect: { x: 555, y: 10, width: 32, height: 28 }, size: { width: 376, height: 70 } }); await Promise.resolve(); await Promise.resolve();
  assert(child.bounds.x + child.bounds.width <= 100 + 276, 'main places usage tips outside the existing popover');
  tip.setPopover(null);
  tip.dismissTip(); assert(!child.visible && sent.some(x => x[0] === 'tip-dismiss'));
  tip.setOverlay(true); tip.showTip(payload); await Promise.resolve(); assert(!child.visible, 'overlay suppresses the tooltip');
  tip.setOverlay(false); win.focused = false; tip.showTip(payload); await Promise.resolve(); assert(!child.visible, 'blur suppresses the tooltip');
  win.focused = true; child.destroy(); tip.showTip(payload); tip.setOverlay(true); resolveLoad(); await Promise.resolve(); await Promise.resolve();
  assert(!child.visible, 'overlay opened during loading suppresses a pending tooltip');
  tip.setOverlay(false); child.destroy(); tip.showTip(payload); rejectLoad(new Error('load failed')); await Promise.resolve(); await Promise.resolve();
  assert(child.dead && !child.visible, 'failed tooltip page is not shown');
}
{ // pane header tools fade in on hover (opacity 0 at mouseover): a hover must still start the tooltip; render re-checks real visibility
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/tooltip-controller.js'), 'utf8');
  assert(/if \(!visible\(el, true\) \|\| el === target\) return;/.test(src) && /\(!fading && Number\(css\.opacity\) === 0\)/.test(src) && /function render\(\) \{\s*if \(!visible\(target\)\)/.test(src), 'hover-revealed controls (opacity 0 at mouseover) still get a tooltip');
}
mainWindowTests().then(() => console.log('ok  tooltip coverage, placement, IPC, events and window lifecycle')).catch(err => { console.error(err); process.exitCode = 1; });
