// node test/pane-navigation.test.js — #51 キーボードでのペイン移動. The pure parts (src/pane-navigation.js): the pane chosen for ←→↑↓ (same row only
// for ←→, nearest centre in the next row for ↑↓, a tie to the left, no wrap-around at the edges, 0 / 1 / 10 panes, uneven rows, the real
// layout's rounding, a maximized window), the key match (exact modifiers, IME composition / unknown, a modal overlay, a held key, never a plain
// arrow / Enter / Esc / editing key), the next 対応キュー item, the waiting move (mayFocus / holds), the key table against every other shortcut
// of the app, the diagnostics codes and the wiring in main.js.
// Not covered here: real focus of WebContentsViews, a real IME, the menu on screen, a real wake - that needs the manual check.
const fs = require('fs'), path = require('path');
const NAV = require('../src/pane-navigation');
const DG = require('../src/diagnostics');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const MAIN = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const RENDERER = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const P = (rows, from, dir, rects = null) => NAV.pick(rects, rows, from, dir);
const all = (rows, from) => ['left', 'right', 'up', 'down'].map(d => P(rows, from, d)).join();
// the rectangles cells() makes for a 1400×900 window with even columns (GAP 6, TOPBAR 76, BOTTOM_GAP 5): a shorter row shares the width evenly
function layout(lens, W = 1400, H = 900) {
  const GAP = 6, area = { x: GAP, y: 76 + GAP, w: W - 2 * GAP, h: H - 76 - GAP - 5 }, cols = Math.max(...lens), rows = lens.length;
  const tot = area.w - GAP * (cols - 1), base = Math.floor(tot / cols), rem = tot - base * cols, cE = [];
  for (let j = 0; j <= cols; j++) cE.push(area.x + j * (base + GAP) + Math.min(j, rem));
  const rE = []; for (let r = 0; r <= rows; r++) rE.push(area.y + (area.h + GAP) * r / rows);
  const out = [];
  lens.forEach((inRow, r) => { for (let c = 0; c < inRow; c++) {
    let x0, x1; if (inRow === cols) { x0 = cE[c]; x1 = cE[c + 1]; } else { const cw = (area.w + GAP) / inRow; x0 = area.x + c * cw; x1 = area.x + (c + 1) * cw; }
    const x = Math.round(x0), y = Math.round(rE[r]); out.push({ x, y, w: Math.round(x1 - GAP) - x, h: Math.round(rE[r + 1] - GAP) - y });
  } });
  return out;
}

// ---- 0 / 1 pane, bad input ----
t('0 panes: nothing in any direction', all([], 0) === '-1,-1,-1,-1' && P(undefined, 0, 'left') === -1 && P(null, 0, 'up') === -1);
t('1 pane: nothing in any direction (no wrap onto itself)', all([1], 0) === '-1,-1,-1,-1');
t('bad from / dir / rows: -1', P([2, 2], -1, 'right') === -1 && P([2, 2], 4, 'left') === -1 && P([2, 2], 1.5, 'left') === -1 && P([2, 2], '1', 'left') === -1
  && P([2, 2], 0, 'next') === -1 && P([2, 2], 0, '') === -1 && P([2, 0, 2], 0, 'down') === -1 && P([2, 'x'], 0, 'down') === -1);

// ---- 2x2: neighbours, edges never wrap ----
t('2x2 from 0 (top left): ← none, → 1, ↑ none, ↓ 2', all([2, 2], 0) === '-1,1,-1,2');
t('2x2 from 3 (bottom right): ← 2, → none, ↑ 1, ↓ none', all([2, 2], 3) === '2,-1,1,-1');
t('←→ never cross into another row (1 → is not 2, 2 ← is not 1)', P([2, 2], 1, 'right') === -1 && P([2, 2], 2, 'left') === -1);

// ---- uneven rows 3+2 (the default 5-pane grid) ----
t('3+2 ↑ from the bottom row: the nearest centre (3 → 0, 4 → 2)', P([3, 2], 3, 'up') === 0 && P([3, 2], 4, 'up') === 2);
t('3+2 ↓ from the outer top panes (0 → 3, 2 → 4)', P([3, 2], 0, 'down') === 3 && P([3, 2], 2, 'down') === 4);
t('3+2 ↓ from the middle: a tie, the left one (1 → 3)', P([3, 2], 1, 'down') === 3);
t('3+2 ←→ in the short row: 3 ↔ 4, edges stay', all([3, 2], 3) === '-1,4,0,-1' && all([3, 2], 4) === '3,-1,2,-1');
{ const R = layout([3, 2]);
  t('3+2 real layout rects (rounded: centres 1 px apart) still a tie to the left, the same picks', P([3, 2], 1, 'down', R) === 3 && P([3, 2], 3, 'up', R) === 0 && P([3, 2], 4, 'up', R) === 2 && P([3, 2], 0, 'down', R) === 3);
  t('a tie is the same for every window width (1000 .. 2600 px)', [1000, 1201, 1400, 1777, 2600].every(w => P([3, 2], 1, 'down', layout([3, 2], w)) === 3)); }
t('2+3 (short row on top): ↓ from 0 / 1 to the nearest of three, ↑ from the middle of three: a tie, the left one', P([2, 3], 0, 'down') === 2 && P([2, 3], 1, 'down') === 4 && P([2, 3], 3, 'up') === 0);
t('3 rows 3+1+2: the single pane goes ↑ to the middle, ↓ a tie to the left; ←→ none', P([3, 1, 2], 3, 'up') === 1 && P([3, 1, 2], 3, 'down') === 4 && P([3, 1, 2], 3, 'left') === -1 && P([3, 1, 2], 3, 'right') === -1);
t('↑↓ only to the adjacent row (row 2 ↑ goes to row 1, not row 0)', P([3, 1, 2], 5, 'up') === 3 && P([3, 1, 2], 0, 'down') === 3);
{ // custom column weights: the real centres decide, not the column number
  const R = [{ x: 0, y: 0, w: 900, h: 100 }, { x: 900, y: 0, w: 300, h: 100 }, { x: 0, y: 100, w: 400, h: 100 }, { x: 400, y: 100, w: 400, h: 100 }, { x: 800, y: 100, w: 400, h: 100 }];
  t('uneven widths: ↓ from the narrow right pane goes to the right one below (by position)', P([2, 3], 1, 'down', R) === 4 && P([2, 3], 0, 'down', R) === 3);
  t('uneven widths: ↑ from the left pane below goes to the wide pane', P([2, 3], 2, 'up', R) === 0 && P([2, 3], 4, 'up', R) === 1); }

// ---- 10 panes (5x2) ----
t('10 panes 5x2: ↑↓ straight, ←→ in the row, edges stay', P([5, 5], 7, 'up') === 2 && P([5, 5], 2, 'down') === 7 && P([5, 5], 4, 'down') === 9
  && P([5, 5], 9, 'right') === -1 && P([5, 5], 5, 'left') === -1 && P([5, 5], 4, 'right') === -1 && P([5, 5], 0, 'up') === -1 && P([5, 5], 9, 'down') === -1);
t('10 panes 4+3+3: ↓ from the 4-row to the nearest of 3', P([4, 3, 3], 0, 'down') === 4 && P([4, 3, 3], 3, 'down') === 6 && P([4, 3, 3], 8, 'down') === -1 && P([4, 3, 3], 9, 'up') === 6);

// ---- maximized / incomplete rects: the rows' own geometry ----
t('maximized (other rects null): moves by the grid as if not maximized', P([3, 2], 3, 'up', [null, null, null, { x: 6, y: 82, w: 1388, h: 800 }, null]) === 0
  && P([3, 2], 1, 'down', [null, { x: 6, y: 82, w: 1388, h: 800 }, null, null, null]) === 3);
t('rects of another length are ignored (rows decide)', P([3, 2], 4, 'up', [{ x: 0, y: 0, w: 1, h: 1 }]) === 2);
t('gridRects: one rect per pane, rows share the width', NAV.gridRects([3, 2]).length === 5 && NAV.gridRects([3, 2])[3].w === 600 && J(NAV.gridRects([])) === '[]' && J(NAV.gridRects(null)) === '[]');

// ---- stacked cells (dock-layout.js stacks): up / down within the cell first, left / right by cell ----
{ const PS = (rows, stacks, from, dir) => NAV.pick(null, rows, from, dir, stacks);
  // rows [3] + stacks [[1, 2]]: 0 | 1 over 2
  t('stack: ↑↓ inside the cell first, its ends go to the next row (none here)', PS([3], [[1, 2]], 1, 'down') === 2 && PS([3], [[1, 2]], 2, 'up') === 1 && PS([3], [[1, 2]], 1, 'up') === -1 && PS([3], [[1, 2]], 2, 'down') === -1);
  t('stack: ← → go cell by cell (never inside the stack), into a stack: the pane nearest in height (a tie: the upper one)', PS([3], [[1, 2]], 1, 'left') === 0 && PS([3], [[1, 2]], 2, 'left') === 0 && PS([3], [[1, 2]], 0, 'right') === 1
    && PS([3], [[1, 2]], 1, 'right') === -1 && PS([4], [[1, 3]], 0, 'right') === 2);
  // rows [3, 2] + stacks [[1, 2], [1, 1]]: 0 | 1 over 2 / 3 | 4
  t('stack: from its bottom ↓ to the row below (nearest centre X), from below ↑ into the stack\'s bottom pane', PS([3, 2], [[1, 2], [1, 1]], 2, 'down') === 4 && PS([3, 2], [[1, 2], [1, 1]], 4, 'up') === 2
    && PS([3, 2], [[1, 2], [1, 1]], 3, 'up') === 0 && PS([3, 2], [[1, 2], [1, 1]], 1, 'down') === 2);
  // rows [1, 3] + stacks [[1], [2, 1]]: 0 / 1 over 2 | 3
  t('stack in the lower row: ↓ from above into its top pane', PS([1, 3], [[1], [2, 1]], 0, 'down') === 1 && PS([1, 3], [[1], [2, 1]], 1, 'up') === 0 && PS([1, 3], [[1], [2, 1]], 3, 'left') === 1);
  t('stacks not fitting the rows / none: one pane per cell (as before)', PS([3, 2], [[1, 1]], 1, 'right') === 2 && PS([3, 2], null, 1, 'down') === 3 && PS([3, 2], [[1, 1], [1, 1]], 0, 'right') === 1);
  t('gridRects with stacks: the stacked panes share the row height', J(NAV.gridRects([3], [[1, 2]]).map(r => [r.x, r.y, r.w, r.h])) === J([[0, 0, 600, 100], [600, 0, 600, 50], [600, 50, 600, 50]])); }

// ---- the key match ----
const K = (o, opt) => NAV.match({ type: 'keyDown', key: '', code: '', isAutoRepeat: false, isComposing: false, shift: false, control: false, alt: false, meta: false, ...o }, opt);
const arrow = (key, o = {}) => K({ key, code: key, meta: true, alt: true, ...o });
const r = m => `${m.id}:${m.act}`;
t('⌘⌥←→↑↓: the four directions', ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map(k => r(arrow(k))).join() === 'left:go,right:go,up:go,down:go');
t('⌘⇧J: the next 対応キュー item (key j / J / a kana key on the J key)', r(K({ key: 'J', code: 'KeyJ', meta: true, shift: true })) === 'next:go'
  && r(K({ key: 'j', code: 'KeyJ', meta: true, shift: true })) === 'next:go' && r(K({ key: 'ま', code: 'KeyJ', meta: true, shift: true })) === 'next:go');
t('⌘J (no ⇧) is not ours: the existing 次の未読 keeps it', K({ key: 'j', code: 'KeyJ', meta: true }).id === '');
t('another latin layout: its own J, not the physical J key', K({ key: 'h', code: 'KeyJ', meta: true, shift: true }).id === '' && r(K({ key: 'J', code: 'KeyC', meta: true, shift: true })) === 'next:go');
t('exact modifiers: ⌘⌥⇧← / ⌃⌘⌥← / ⌥← / ⌘← / ⌘⇧⌥J / ⌃⇧J are not ours', arrow('ArrowLeft', { shift: true }).id === '' && arrow('ArrowLeft', { control: true }).id === ''
  && arrow('ArrowLeft', { meta: false }).id === '' && arrow('ArrowLeft', { alt: false }).id === '' && K({ key: 'J', code: 'KeyJ', meta: true, shift: true, alt: true }).id === ''
  && K({ key: 'J', code: 'KeyJ', control: true, shift: true }).id === '');
t('plain arrows / Enter / Esc / ⌘A ⌘C ⌘V ⌘Z / ⌘↵ are never taken', ['ArrowLeft', 'ArrowDown', 'Enter', 'Escape', 'Tab'].every(k => K({ key: k, code: k }).id === '')
  && ['a', 'c', 'v', 'z', 'x'].every(k => K({ key: k, code: 'Key' + k.toUpperCase(), meta: true }).id === '' && K({ key: k, code: 'Key' + k.toUpperCase(), meta: true, shift: true }).id === '')
  && K({ key: 'Enter', code: 'Enter', meta: true }).id === '' && K({ key: 'ArrowLeft', code: 'ArrowLeft', shift: true }).id === '');
t('keyUp / no input: nothing', arrow('ArrowLeft', { type: 'keyUp' }).id === '' && NAV.match(null).id === '' && NAV.match(undefined).id === '' && NAV.match('x').id === '');
t('IME composing: left to the page (pass)', r(arrow('ArrowRight', { isComposing: true })) === 'right:pass' && r(K({ key: 'J', code: 'KeyJ', meta: true, shift: true, isComposing: true })) === 'next:pass');
t('composition unknown (not reported) / Process / keyCode 229 / the pane reported one: pass', r(arrow('ArrowRight', { isComposing: undefined })) === 'right:pass'
  && r(arrow('ArrowRight', { key: 'Process', code: 'ArrowRight' })) === 'right:pass' && r(arrow('ArrowRight', { keyCode: 229 })) === 'right:pass'
  && r(arrow('ArrowRight')) === 'right:go' && r(K({ key: 'ArrowRight', code: 'ArrowRight', meta: true, alt: true }, { ime: true })) === 'right:pass');
t('a modal overlay (prompt / palette / broadcast ...): pass', r(K({ key: 'ArrowUp', code: 'ArrowUp', meta: true, alt: true }, { modal: true })) === 'up:pass'
  && r(K({ key: 'j', code: 'KeyJ', meta: true, shift: true }, { modal: true })) === 'next:pass');
t('a held key (auto-repeat): taken, nothing done (one press, one move)', r(arrow('ArrowDown', { isAutoRepeat: true })) === 'down:hold' && r(K({ key: 'J', code: 'KeyJ', meta: true, shift: true, isAutoRepeat: true })) === 'next:hold');
t('composing beats repeat (a held key during IME: pass)', r(arrow('ArrowDown', { isAutoRepeat: true, isComposing: true })) === 'down:pass');
t('not the Mac: Ctrl is the modifier, ⌘ (meta) is not', r(K({ key: 'ArrowLeft', code: 'ArrowLeft', control: true, alt: true }, { mac: false })) === 'left:go'
  && K({ key: 'ArrowLeft', code: 'ArrowLeft', meta: true, alt: true }, { mac: false }).id === '' && K({ key: 'ArrowLeft', code: 'ArrowLeft', control: true, alt: true }).id === '');

// ---- the next item of the 対応キュー ----
const Q = (...ids) => ids.map(id => ({ id, kind: 'REPLY' }));
t('empty / no list: nothing', NAV.nextInQueue([], 1) === 0 && NAV.nextInQueue(undefined, 1) === 0 && NAV.nextInQueue(null, 0) === 0);
t('this pane not listed: the first item', NAV.nextInQueue(Q(4, 2, 9), 7) === 4 && NAV.nextInQueue(Q(4, 2, 9), undefined) === 4);
t('this pane listed: the item after it, the last goes back to the first', NAV.nextInQueue(Q(4, 2, 9), 4) === 2 && NAV.nextInQueue(Q(4, 2, 9), 2) === 9 && NAV.nextInQueue(Q(4, 2, 9), 9) === 4);
t('only this pane listed: nothing', NAV.nextInQueue(Q(3), 3) === 0 && NAV.nextInQueue(Q(3), 5) === 3);
t('bad items are skipped', NAV.nextInQueue([null, { id: 0 }, { id: -2 }, { id: 'x' }, { id: 6 }], 1) === 6);

// ---- a move waiting for its pane (asleep / queued) ----
const W = { seq: 3, id: 5, tw: 50, fw: 40, from: 4, until: 1000 };
const N = o => ({ focusedId: 5, overlay: false, active: true, fw: 40, t: 900, ...o });
t('mayFocus: still focused, no overlay, in front, the keyboard where the move left it (or on the pane / nowhere), in time', NAV.mayFocus(W, N()) && NAV.mayFocus(W, N({ fw: 50 })) && NAV.mayFocus(W, N({ fw: 0 })));
t('mayFocus: not when the user moved on (another pane focused / overlay / window behind / the keyboard elsewhere / too late)', !NAV.mayFocus(W, N({ focusedId: 4 })) && !NAV.mayFocus(W, N({ overlay: true }))
  && !NAV.mayFocus(W, N({ active: false })) && !NAV.mayFocus(W, N({ fw: 77 })) && !NAV.mayFocus(W, N({ t: 1001 })) && !NAV.mayFocus(null, N()) && !NAV.mayFocus(W, null) && !NAV.mayFocus(W, N({ t: NaN })));
t('holds: a key into the pane that kept the keyboard while the header shows the woken one', NAV.holds(W, { pane: 4, focusedId: 5, t: 900 }));
t('holds: not the pane itself / another pane / after the user moved / too late / no holder', !NAV.holds(W, { pane: 5, focusedId: 5, t: 900 }) && !NAV.holds(W, { pane: 6, focusedId: 5, t: 900 })
  && !NAV.holds(W, { pane: 4, focusedId: 4, t: 900 }) && !NAV.holds(W, { pane: 4, focusedId: 5, t: 1001 }) && !NAV.holds({ ...W, from: 0 }, { pane: 4, focusedId: 5, t: 900 }) && !NAV.holds(null, { pane: 4 }));

// ---- the keys against every other shortcut ----
t('keys: the four directions + next, each once, Japanese labels', J(NAV.KEYS.map(k => k.id)) === J([...NAV.DIRS, 'next']) && NAV.KEYS.every(k => k.ja && k.accel) && new Set(NAV.KEYS.map(k => NAV.norm(k.accel))).size === NAV.KEYS.length);
t('norm: one form for the same key', NAV.norm('CmdOrCtrl+Shift+J') === NAV.norm('Command+Shift+j') && NAV.norm('CmdOrCtrl+Alt+Left') === 'Alt+Cmd+Left' && NAV.norm('CmdOrCtrl+Alt+Left', false) === 'Alt+Ctrl+Left'
  && NAV.norm('Cmd+Click') === '' && NAV.norm('Shift+Click') === '' && NAV.norm('Hyper+J') === '' && NAV.norm('Esc') === NAV.norm('Escape'));
t('no new key is another shortcut (Mac and elsewhere)', J(NAV.conflicts(NAV.KEYS, NAV.TAKEN, true)) === '[]' && J(NAV.conflicts(NAV.KEYS, NAV.TAKEN, false)) === '[]');
t('the check finds a clash (⌘J, ⌘⇧T, a key twice)', J(NAV.conflicts([{ accel: 'CmdOrCtrl+J' }, { accel: 'Cmd+Shift+T' }], NAV.TAKEN)) === J(['CmdOrCtrl+J', 'Cmd+Shift+T'])
  && J(NAV.conflicts([{ accel: 'CmdOrCtrl+Alt+K' }, { accel: 'Cmd+Alt+K' }], [])) === J(['Cmd+Alt+K']));
{ // every accelerator written in main.js is in the tables (a new menu key must be added to TAKEN, which the clash check then covers)
  const accs = [...MAIN.matchAll(/accelerator:\s*'([^']+)'/g), ...MAIN.matchAll(/acc\('([^']+)'/g)].map(m => m[1].replace(/\\\\/g, '\\')).filter(a => NAV.norm(a));
  const known = new Set([...NAV.TAKEN, ...NAV.KEYS.map(k => k.accel)].map(a => NAV.norm(a)));
  const missing = accs.filter(a => !known.has(NAV.norm(a)));
  t(`main.js accelerators are all in the tables (${accs.length} found${missing.length ? '; missing ' + missing.join(' ') : ''})`, accs.length >= 15 && !missing.length); }
{ const hk = (MAIN.match(/function handleKey\(input, pane\) \{[\s\S]*?\n\}/) || [''])[0];
  const letters = [...new Set([...hk.matchAll(/k === '([a-z\[\]\-=0;\\])'/g)].map(m => m[1]))];
  const known = new Set(NAV.TAKEN.map(a => NAV.norm(a)));
  const miss = letters.filter(c => !known.has(NAV.norm('CmdOrCtrl+' + c)) && !known.has(NAV.norm('CmdOrCtrl+Shift+' + c)));
  t(`handleKey's own keys are in TAKEN (${letters.join(' ')}${miss.length ? '; missing ' + miss.join(' ') : ''})`, letters.length >= 10 && !miss.length);
  t('handleKey: the #51 match first (⌘⇧J before ⌘J), the old ⌘⌥arrow line gone, a pass is not handled', hk.indexOf('PN.match(input') > 0 && hk.indexOf('PN.match(input') < hk.indexOf("k === 'j'")
    && !/arrowleft/.test(hk) && /if \(nk\.id\) \{ if \(nk\.act === 'go'\) navKey\(nk\.id\); return nk\.act !== 'pass'; \}/.test(hk)
    && /modal: overlayOpen && overlayMode !== 'queue', ime: !!pane\?\.ime/.test(hk)); }
t('renderer ⌘⇧C (compact mode) is in TAKEN', /e\.shiftKey&&e\.code==='KeyC'/.test(RENDERER) && NAV.TAKEN.includes('CmdOrCtrl+Shift+C'));

// ---- diagnostics ----
t('nav codes = diagnostics PANE_NAV_CODES, all accepted by the event', J([...DG.PANE_NAV_CODES].sort()) === J([...NAV.CODES].sort()) && NAV.CODES.every(c => DG.EVENTS.nav.r.includes(c)));
t('a nav entry keeps the pane number only', J(DG.sanitize('nav', 'MOVE', { p: 3, url: 'https://grok.com/bot/x', name: 'n' }, 1)) === J({ t: 1, ev: 'nav', r: 'MOVE', p: 3 }));

// ---- wiring in main.js ----
t('the ペイン menu lists the keys from the table (registerAccelerator false via acc), 次の未読 kept', /\.\.\.PN\.KEYS\.map\(k => acc\(k\.accel, \(\) => cur\(\)\?\.navKey\(k\.id\), k\.ja\)\)/.test(MAIN)
  && /acc\('CmdOrCtrl\+J', \(\) => cur\(\)\?\.nextUnread\(\), '次の未読ペインへ'\)/.test(MAIN) && /const acc = \(a, click, label, extra = \{\}\) => \(\{ label, accelerator: a, registerAccelerator: false/.test(MAIN));
t('navKey: nothing under another overlay; moveFocus by the grid rects (cells(true)) and rows; no index wrap left', /function navKey\(id\) \{\n  if \(overlayOpen && overlayMode !== 'queue'\) return;/.test(MAIN)
  && /PN\.pick\(cells\(true\), getRows\(\), focused, dir, getStacks\(\)\)/.test(MAIN) && /if \(!grid && maximizedId != null/.test(MAIN) && !/i = i - 1; else if \(dir === 'right'\)/.test(MAIN));
t('queueNext: the queue just built, the pane by its id, focusPane without read, read only in view', /sendState\(\);[^\n]*\n  const cur = panes\[focused\], p = byId\(PN\.nextInQueue\(queueNow, cur && cur\.id\)\);/.test(MAIN)
  && /navGo\(panes\.indexOf\(p\), 'QUEUE'\);\n  if \(inView\(p\)\) clearUnread\(p\);/.test(MAIN) && /state\.queue = queueBuild\(state\.panes\);[^\n]*\n  queueNow = state\.queue;/.test(MAIN));
t('navGo: the older move dropped first, the queue overlay closed, focusPane(i, { clear: false }), a wait only for a pane not shown with a load coming',
  /navEnd\(\);[^\n]*\n  if \(overlayOpen\) closeOverlay\(\);[^\n]*\n  const from = panes\[focused\];\n  focusPane\(i, \{ clear: false \}\);/.test(MAIN) && /if \(navShown\(p\) \|\| !\(p\.sleeping \|\| lqView\(p\)\)\) return;/.test(MAIN));
t('the wait: dropped when another pane is focused, settled on relayout / showViews, a click in the holding pane ends it (listener removed)',
  /if \(navWait && navWait\.id !== panes\[i\]\.id\) navEnd\('DROP'\);/.test(MAIN) && (MAIN.match(/navSettle\(\);/g) || []).length === 2
  && /wc\.on\('before-mouse-event', onMouse\); w\.off = \(\) => \{ try \{ wc\.off\('before-mouse-event', onMouse\); \} catch \{\} \};/.test(MAIN));
t('a pane\'s keys: held back before the input revision / read mark (#11), shortcuts still work', /if \(navHolds\(p, input\)\) \{ if \(!handleKey\(input, p\)\) diag\.rec\('nav', 'HELD', \{ p: p\.id \}, 60000\); e\.preventDefault\(\); return; \}[^\n]*\n    if \(input\.type === 'keyDown' && !input\.meta && !input\.control\) \{ clearUnread\(p\); p\.inputRev\+\+; \}/.test(MAIN));
t('the keys come only through handleKey (window UI / overlay / panes), no new IPC', (MAIN.match(/handleKey\(input\)\) e\.preventDefault\(\)/g) || []).length === 2 && !/navKey|queueNext/.test(fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8')));

console.log(bad ? `\n${bad} failed` : '\nall passed');
process.exit(bad ? 1 : 0);
