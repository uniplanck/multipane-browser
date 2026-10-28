// node test/half-layout.test.js — layout math and real main-process adapters, without Electron.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { halfRects } = require('../src/half-layout');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const main = read('src/main.js'), renderer = read('src/renderer.js');
const gap = 6, area = { x: 10, y: 80, w: 1000, h: 600 };
const edges = (a, cols) => {
  const total = a.w - gap * (cols - 1), base = Math.floor(total / cols), rem = total - base * cols;
  return Array.from({ length: cols + 1 }, (_, j) => a.x + j * (base + gap) + Math.min(j, rem));
};
function checkRects(rects, a) {
  for (const r of rects) {
    assert(r && [r.x, r.y, r.w, r.h].every(Number.isInteger));
    assert(r.w > 0 && r.h > 0 && r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h);
  }
  rects.forEach((r, i) => rects.slice(i + 1).forEach(s => {
    assert(r.x + r.w + gap <= s.x || s.x + s.w + gap <= r.x || r.y + r.h + gap <= s.y || s.y + s.h + gap <= r.y,
      `rectangles must be separated by ${gap}px: ${JSON.stringify([r, s])}`);
  }));
}
const four = edges(area, 4);
for (const side of ['left', 'right']) {
  const bigIndex = 3, rects = halfRects(area, four, 4, side, bigIndex, 8, gap);
  assert.strictEqual(rects.length, 8); checkRects(rects, area);
  assert.deepStrictEqual(rects[bigIndex], side === 'left'
    ? { x: area.x, y: area.y, w: four[2] - gap - area.x, h: area.h }
    : { x: four[2], y: area.y, w: area.x + area.w - four[2], h: area.h });
  for (const [i, r] of rects.entries()) if (i !== bigIndex) assert(side === 'left' ? r.x >= four[2] : r.x + r.w <= four[2] - gap);
}
// For an odd number of weighted columns, the enlarged side gets two of the three original columns.
const three = [area.x, 200, 580, area.x + area.w + gap];
assert.deepStrictEqual(halfRects(area, three, 3, 'left', 0, 4, gap)[0], { x: area.x, y: area.y, w: 580 - gap - area.x, h: area.h });
assert.deepStrictEqual(halfRects(area, three, 3, 'right', 0, 4, gap)[0], { x: 200, y: area.y, w: area.x + area.w - 200, h: area.h });
for (const side of ['left', 'right']) for (const edgeCase of [null, edges(area, 1)]) {
  const rects = halfRects(area, edgeCase, 1, side, 1, 4, gap);
  checkRects(rects, area);
  assert.strictEqual(rects[1].w, area.w / 2);
  assert.strictEqual(rects[1].x, side === 'left' ? area.x : area.x + area.w / 2);
}
assert.deepStrictEqual(halfRects(area, four, 4, 'left', 0, 1, gap), [area]);
assert.deepStrictEqual(halfRects(area, null, 0, 'right', 0, 0, gap), []);

// Exercise even and odd m, every big index, both sides, and short final rows.
for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10]) for (let big = 0; big < n; big++) for (const side of ['left', 'right']) {
  const rects = halfRects(area, four, 4, side, big, n, gap); checkRects(rects, area);
  const small = rects.filter((_, i) => i !== big);
  for (let i = 1; i < small.length; i++) assert(small[i].y > small[i - 1].y || (small[i].y === small[i - 1].y && small[i].x > small[i - 1].x));
  const last = small.filter(r => r.y === small.at(-1).y);
  assert(Math.max(...last.map(r => r.w)) - Math.min(...last.map(r => r.w)) <= 1, 'short final row shares its width evenly');
}
// Missing geometry falls back to half even when a previous column count existed.
assert.strictEqual(halfRects(area, null, 3, 'left', 0, 3, gap)[0].w, area.w / 2);

function source(name) {
  const start = main.indexOf(`function ${name}(`); assert(start >= 0, name);
  let i = main.indexOf('{', main.indexOf(')', start)), depth = 0;
  for (; i < main.length; i++) {
    if (main[i] === '{') depth++;
    else if (main[i] === '}' && --depth === 0) return main.slice(start, i + 1);
  }
  throw new Error(`unclosed ${name}`);
}
// Integrate the actual cells()/geom() adapter with weighted columns, resizing and full-mode visibility.
{
  const gridPanes = Array.from({ length: 8 }, (_, i) => ({ id: i + 1 }));
  let currentArea = { ...area };
  const ctx = vm.createContext({ panes: gridPanes, GAP: gap, maximizedId: 4, maxMode: 'left', lastGeom: null,
    settings: { splits: { '4x2': { c: [1, 2, 3, 4] } } }, halfRects, areaNow: () => currentArea,
    getStacks: () => [[1, 1, 1, 1], [1, 1, 1, 1]], byId: id => gridPanes.find(p => p.id === id), sumArr: a => a.reduce((x, y) => x + y, 0) });
  vm.runInContext([source('geom'), source('cells'), source('splitters')].join('\n'), ctx);
  let rects = ctx.cells(), edge = ctx.lastGeom.cE[2];
  checkRects(rects, currentArea);
  assert.strictEqual(rects[3].w, Math.round(edge - gap) - area.x);
  assert.strictEqual(ctx.splitters().length, 0);
  assert(ctx.cells(true).every(Boolean), 'navigation receives normal grid geometry');
  currentArea = { ...area, w: 1200 };
  rects = ctx.cells(); edge = ctx.lastGeom.cE[2];
  assert.strictEqual(rects[3].w, Math.round(edge - gap) - area.x);
  assert.strictEqual(rects[3].h, area.h);
  ctx.maxMode = 'full'; rects = ctx.cells();
  assert.strictEqual(rects.filter(Boolean).length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rects[3])), currentArea);
  ctx.maximizedId = null; ctx.maxMode = null;
  assert.strictEqual(ctx.cells().filter(Boolean).length, 8);
  assert(ctx.splitters().length > 0);
}
const pane = id => ({ id, sleeping: false, view: { webContents: { isDestroyed: () => false, isFocused: () => true, focus() {}, send() {} } } });
const panes = [pane(1), pane(2), pane(3)];
const context = vm.createContext({ panes, focused: 0, maximizedId: null, maxMode: null, keyboardFocus: null,
  byId: id => panes.find(p => p.id === id), setFocused: i => { context.focused = i; }, relayout() {}, clearUnread() {}, dlog() {},
  windowActive: () => true, PN: { match: () => ({}) }, dismissTip() {}, dock: null, overlayOpen: false, isMac: true });
vm.runInContext([source('toggleMaximize'), source('focusPane'), source('setPcMax'), source('setImgMax'), source('handleKey'),
  main.match(/^const inView = .*$/m)[0]].join('\n') + '\nglobalThis.testInView = inView;', context);
const state = (id, mode) => { assert.strictEqual(context.maximizedId, id); assert.strictEqual(context.maxMode, mode); };
context.toggleMaximize(1, true, 'left'); state(1, 'left');
context.focusPane(1); state(1, 'left'); assert(context.testInView(panes[1]));
context.toggleMaximize(1, true, 'right'); state(1, 'right');
context.toggleMaximize(1, true, 'right'); state(null, null);
context.toggleMaximize(1, true, 'left'); context.toggleMaximize(1); state(1, 'full');
context.toggleMaximize(1); state(null, null);
context.toggleMaximize(1, true, 'left'); context.toggleMaximize(2, true, 'left'); state(2, 'left');
assert(context.handleKey({ type: 'keyDown', key: 'Escape' })); state(null, null);
context.toggleMaximize(1); context.focusPane(1); state(2, 'full');
context.toggleMaximize(2, true, 'left'); context.setPcMax(panes[1], true); state(2, 'full');
assert(panes[1].pcMaxedPane); context.setPcMax(panes[1], false); state(null, null);
context.toggleMaximize(1, true, 'right'); context.setImgMax(panes[0], true); state(1, 'full');
assert(panes[0].imgMaxedPane); context.setImgMax(panes[0], false, true); state(null, null);
context.toggleMaximize(1); context.setImgMax(panes[0], true); assert(!panes[0].imgMaxedPane);
context.setImgMax(panes[0], false, true); state(1, 'full');
context.toggleMaximize(1); context.toggleMaximize(1, true, 'left'); context.setImgMax(panes[0], true);
context.toggleMaximize(1, true, 'right'); context.setImgMax(panes[0], false, true); state(1, 'right');

// Source contracts for controls and all direct resets (the conditional toggle resets both together).
const ctxMenu = renderer.match(/maxBtn\.oncontextmenu = e => \{[^\n]+/)[0];
assert(ctxMenu.includes('e.preventDefault()') && ctxMenu.includes('e.stopPropagation()') && ctxMenu.includes("mpb.maximizeHalf(id, 'right')"));
for (const method of ['idle', 'begin', 'move', 'cancel', 'release', 'click']) assert(renderer.includes(`GbarLongPress.${method}(`));
assert(/if \(result\.suppress[^\n]*e\.preventDefault\(\); e\.stopPropagation\(\); return;/.test(renderer));
assert(/duration: GbarLongPress\.HOLD_MS/.test(renderer));
for (const line of main.split('\n').filter(line => /maximizedId = null/.test(line))) assert(/maxMode = null/.test(line), line);
assert(/maximizedId = restore \? null : p\.id;\s*maxMode = restore \? null : mode;/.test(source('toggleMaximize')));
assert(!/maximizedId|maxMode/.test(source('snapshot')), 'maximize state is not saved');
assert(/s\.maximizedId != null && s\.maxMode === 'full'/.test(renderer));
for (const name of ['paneMenu', 'chipMenu']) {
  const menu = source(name);
  assert(/label: maximizedId === id \? '元のサイズに戻す' : '最大化'/.test(menu));
  assert(/toggleMaximize\(id, true, maximizedId === id \? maxMode : 'full'\)/.test(menu));
}
{
  const start = renderer.indexOf("    const maxBtn = d.querySelector('[data-a=maximize]'), mode =");
  const end = renderer.indexOf('\n  }\n};', start);
  assert(start >= 0 && end > start);
  const button = { dataset: { tip: '拡大・元に戻す', tipDesc: '説明' }, setAttribute(k, v) { this[k] = v; } };
  const ctx = vm.createContext({ d: { querySelector: () => button }, p: { id: 1 }, s: {}, MOD: '⌘' });
  for (const [mode, icon, detail] of [[null, '⤢', 'ヘッダーのダブルクリック・⌘\\ は全体表示の切り替えです。'], ['left', '◧', '現在: 左半分に拡大中'], ['right', '◨', '現在: 右半分に拡大中'], ['full', '⤡', '現在: 最大化中']]) {
    ctx.s = { maximizedId: mode ? 1 : null, maxMode: mode };
    vm.runInContext(`{ ${renderer.slice(start, end)} }`, ctx);
    assert.strictEqual(button.textContent, icon); assert.strictEqual(button.dataset.tipDetail, detail);
    assert(button['aria-label'].includes(detail));
  }
}
console.log('ok  half-layout, maximize state and controls');
