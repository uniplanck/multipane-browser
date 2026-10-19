// キーボードでのペイン移動 (#51) (unit-tested in test/pane-navigation.test.js). Pure: main.js passes the window's pane rectangles / rows, the
// key event (before-input-event Input) and the 対応キュー it just built, and does the focus itself (makeWindow: navKey / moveFocus / queueNext).
//   ⌘⌥← / ⌘⌥→   the cell before / after this pane's cell in the same row (never into another row); a stacked cell: its pane nearest in height
//   ⌘⌥↑ / ⌘⌥↓   in a stacked cell (dock-layout.js) the pane above / below in it first; from its end the pane of the row above / below whose centre X
//               is nearest to this pane's centre (a tie: the left one; one stacked cell: its pane nearest in height)
//   ⌘⇧J         the next item of the 対応キュー (after this pane's own item; not listed: the first; the last: back to the first)
// Nothing that way (an edge, one pane, only this pane listed): nothing happens - no wrap-around between the edges of the grid.
// The keys need ⌘ (Ctrl elsewhere) plus exactly ⌥ / ⇧: an arrow, Enter, Esc or a page's editing key (⌘A ⌘C ⌘V ⌘Z ...) is never taken. They
// do nothing while an IME composes (or it is not known whether one does), while a prompt / the palette / another overlay is open, or when held
// down (a repeat): one press, one move.
const DIRS = ['left', 'right', 'up', 'down'];
const TIE_PX = 2;                 // two centres this close (rounding of the layout) are a tie
const WAIT_MS = 60000;            // a pane not on screen yet (asleep / its load queued) gets the keyboard once it is shown, within this time
// the keys (= the ペイン menu: label / accelerator; registerAccelerator: false, main's handleKey does the work)
const KEYS = [
  { id: 'left', accel: 'CmdOrCtrl+Alt+Left', ja: '左のペインへ' },
  { id: 'right', accel: 'CmdOrCtrl+Alt+Right', ja: '右のペインへ' },
  { id: 'up', accel: 'CmdOrCtrl+Alt+Up', ja: '上のペインへ' },
  { id: 'down', accel: 'CmdOrCtrl+Alt+Down', ja: '下のペインへ' },
  { id: 'next', accel: 'CmdOrCtrl+Shift+J', ja: '次の要対応へ' },
];
// every other shortcut of the app (the test compares it with main.js): a new key must not be one of these
const TAKEN = [
  // menu / handleKey (main.js)
  'CmdOrCtrl+T', 'CmdOrCtrl+Shift+T', 'CmdOrCtrl+N', 'CmdOrCtrl+W', 'CmdOrCtrl+L', 'CmdOrCtrl+K', 'CmdOrCtrl+Shift+W',
  'CmdOrCtrl+R', 'CmdOrCtrl+Shift+R', 'CmdOrCtrl+\\', 'CmdOrCtrl+¥', 'CmdOrCtrl+Shift+P', 'CmdOrCtrl+Shift+B', 'CmdOrCtrl+J',
  'CmdOrCtrl+[', 'CmdOrCtrl+]', 'CmdOrCtrl+=', 'CmdOrCtrl+Shift+=', 'CmdOrCtrl+Shift+;', 'CmdOrCtrl+-', 'CmdOrCtrl+0',
  'CmdOrCtrl+Alt+=', 'CmdOrCtrl+Alt+-', 'CmdOrCtrl+Alt+0',
  'CmdOrCtrl+1', 'CmdOrCtrl+2', 'CmdOrCtrl+3', 'CmdOrCtrl+4', 'CmdOrCtrl+5', 'CmdOrCtrl+6', 'CmdOrCtrl+7', 'CmdOrCtrl+8', 'CmdOrCtrl+9',   // レイアウト
  'Esc',
  // the bar (renderer.js: 使用量) / the overlay (overlay.js: ⌘↵ 一斉送信・パレット)
  'CmdOrCtrl+Shift+C', 'CmdOrCtrl+Enter',
  // the standard menus (appMenu / editMenu / windowMenu / togglefullscreen)
  'Cmd+H', 'Cmd+Alt+H', 'Cmd+Q', 'Cmd+,', 'CmdOrCtrl+Z', 'CmdOrCtrl+Shift+Z', 'CmdOrCtrl+X', 'CmdOrCtrl+C', 'CmdOrCtrl+V', 'CmdOrCtrl+Alt+Shift+V',
  'CmdOrCtrl+A', 'Cmd+M', 'Ctrl+Cmd+F',
];
const CODES = ['MOVE', 'EDGE', 'QUEUE', 'NONE', 'WAIT', 'FOCUS', 'DROP', 'HELD'];   // diagnostics 'nav' (pane numbers only)

const MODS = { cmdorctrl: 'CmdOrCtrl', commandorcontrol: 'CmdOrCtrl', cmd: 'Cmd', command: 'Cmd', meta: 'Cmd', super: 'Cmd', ctrl: 'Ctrl', control: 'Ctrl',
  alt: 'Alt', option: 'Alt', altgr: 'Alt', shift: 'Shift' };
const NAMES = { esc: 'Esc', escape: 'Esc', enter: 'Enter', return: 'Enter', left: 'Left', right: 'Right', up: 'Up', down: 'Down' };
// an accelerator -> one comparable form ('Alt+Cmd+Shift+J'); CmdOrCtrl is ⌘ on the Mac, Ctrl elsewhere. '' = not a key (Cmd+Click ...)
function norm(accel, mac = true) {
  const parts = String(accel || '').split('+'), key = parts.pop(), mods = new Set();
  for (const m of parts) {
    const v = MODS[m.toLowerCase()]; if (!v) return '';
    mods.add(v === 'CmdOrCtrl' ? (mac ? 'Cmd' : 'Ctrl') : v);
  }
  if (!key || /^click$/i.test(key)) return '';
  return [...[...mods].sort(), NAMES[key.toLowerCase()] || (key.length === 1 ? key.toUpperCase() : key)].join('+');
}
// keys of `keys` that are another shortcut too (or twice in `keys`) on the Mac / elsewhere -> [accel]
function conflicts(keys, taken, mac = true) {
  const seen = new Set((Array.isArray(taken) ? taken : []).map(a => norm(a, mac)).filter(Boolean)), out = [];
  for (const k of Array.isArray(keys) ? keys : []) { const n = norm(k && k.accel, mac); if (!n || seen.has(n)) out.push(k && k.accel); else seen.add(n); }
  return out;
}

const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
// a before-input-event Input -> { id: a KEYS id | '' (not one of these keys), act: 'go' (move) | 'hold' (a repeat: taken, nothing done) |
// 'pass' (not now - an IME composition / unknown / a modal overlay: left to the page / field as it is) }
// mac: ⌘ is the modifier (Ctrl elsewhere); modal: an overlay other than the 対応キュー is open; ime: the pane reported a composition
function match(input, { mac = true, modal = false, ime = false } = {}) {
  const none = { id: '', act: '' };
  if (!input || typeof input !== 'object' || input.type !== 'keyDown') return none;
  const key = String(input.key || ''), k = key.toLowerCase(), code = String(input.code || '');
  const mod = mac ? input.meta === true && input.control !== true : input.control === true && input.meta !== true;
  if (!mod) return none;
  let id = '';
  if (input.alt === true && input.shift !== true) id = ARROWS[key] || ARROWS[code] || '';
  else if (input.shift === true && input.alt !== true && (k === 'j' || (!/^[a-z]$/.test(k) && code === 'KeyJ'))) id = 'next';   // a kana / other layout: the J key
  if (!id) return none;
  const composing = input.isComposing !== false || key === 'Process' || input.keyCode === 229 || ime === true;   // not reported = not known
  if (composing || modal) return { id, act: 'pass' };
  if (input.isAutoRepeat === true) return { id, act: 'hold' };
  return { id, act: 'go' };
}

const isRows = rows => Array.isArray(rows) && rows.length > 0 && rows.every(k => Number.isInteger(k) && k > 0);
const isRect = r => !!r && typeof r === 'object' && [r.x, r.y, r.w, r.h].every(Number.isFinite);
// stacks[r][c] = panes stacked in cell c of row r (dock-layout.js); missing / not these rows: one pane per cell
const cellsOf = (rows, stacks) => Array.isArray(stacks) && stacks.length === rows.length && stacks.every((s, r) => Array.isArray(s) && s.length > 0
  && s.every(k => Number.isInteger(k) && k > 0) && s.reduce((a, b) => a + b, 0) === rows[r]) ? stacks : rows.map(k => Array(k).fill(1));
// the rows' default geometry (each row shares the width evenly, a stacked cell its height) - used when the rectangles are missing / incomplete
function gridRects(rows, stacks = null) {
  const out = [];
  if (!isRows(rows)) return out;
  cellsOf(rows, stacks).forEach((s, r) => s.forEach((k, c) => { for (let j = 0; j < k; j++) out.push({ x: c * 1200 / s.length, y: r * 100 + j * 100 / k, w: 1200 / s.length, h: 100 / k }); }));
  return out;
}
// rects: the panes' rectangles { x, y, w, h } in pane order (row-major, as cells() lays them out); rows: panes per row; from: the focused index;
// dir: left / right / up / down; stacks: the rows' cells (none: one pane per cell) -> the index to focus, or -1 (nothing that way / bad input)
function pick(rects, rows, from, dir, stacks = null) {
  if (!DIRS.includes(dir) || !isRows(rows)) return -1;
  const n = rows.reduce((a, b) => a + b, 0);
  if (!Number.isInteger(from) || from < 0 || from >= n) return -1;
  const st = cellsOf(rows, stacks);
  const R = Array.isArray(rects) && rects.length === n && rects.every(isRect) ? rects : gridRects(rows, st);
  const at = []; st.forEach((s, r) => s.forEach((k, c) => { for (let j = 0; j < k; j++) at.push({ r, c, j, k }); }));
  const f = at[from];
  const cx = i => R[i].x + R[i].w / 2, cy = i => R[i].y + R[i].h / 2, fx = cx(from), fy = cy(from);
  // the candidate nearest in X (a tie: the left one), then nearest in Y (the panes of one stacked cell share their X), then the first
  const best = ok => {
    let b = -1;
    for (let i = 0; i < n; i++) {
      if (!ok(at[i])) continue;
      if (b < 0) { b = i; continue; }
      const d = Math.abs(cx(i) - fx), bd = Math.abs(cx(b) - fx);
      if (d < bd - TIE_PX) { b = i; continue; }
      if (Math.abs(d - bd) > TIE_PX) continue;
      if (cx(i) < cx(b) - TIE_PX || (Math.abs(cx(i) - cx(b)) <= TIE_PX && Math.abs(cy(i) - fy) < Math.abs(cy(b) - fy) - TIE_PX)) b = i;
    }
    return b;
  };
  if (dir === 'left' || dir === 'right') {                      // the neighbouring cell in the same row (cells keep their order left to right)
    const tc = f.c + (dir === 'left' ? -1 : 1);
    return best(a => a.r === f.r && a.c === tc);
  }
  const step = dir === 'up' ? -1 : 1;
  if (f.j + step >= 0 && f.j + step < f.k) return from + step;   // within its stacked cell first
  const tr = f.r + step;
  if (tr < 0 || tr >= rows.length) return -1;
  return best(a => a.r === tr);
}

const isId = v => Number.isSafeInteger(v) && v > 0;
// the 対応キュー as main just built it (items in order) and the focused pane's id -> the pane id to go to, 0 = nothing to do
function nextInQueue(items, cur) {
  const ids = (Array.isArray(items) ? items : []).map(it => it && it.id).filter(isId);
  if (!ids.length) return 0;
  const i = ids.indexOf(cur);
  if (i < 0) return ids[0];
  return ids.length > 1 ? ids[(i + 1) % ids.length] : 0;
}

// A move to a pane that is not on screen yet (asleep: woken through the load queue; its load waiting): w = { seq, id: that pane, tw: its
// WebContents, fw: the WebContents that had the keyboard right after the move, from: the pane that kept the keyboard (0 = none), until }.
// now = { focusedId, overlay, active: the window is in front, fw: the focused WebContents now (0 = none), t }.
// mayFocus: once it is shown, the keyboard goes to it only if nothing moved meanwhile - still the focused pane, no overlay, the window in front,
// the keyboard where the move left it, in time.
function mayFocus(w, now) {
  if (!w || !now || typeof w !== 'object' || typeof now !== 'object') return false;
  if (now.focusedId !== w.id || now.overlay || now.active !== true || !(now.t <= w.until)) return false;
  return !now.fw || now.fw === w.fw || now.fw === w.tw;
}
// holds: a key typed into the pane that kept the keyboard while the header already shows the other one is not passed to that page
// (now.pane = the pane the key reached)
function holds(w, now) {
  if (!w || !now || typeof w !== 'object' || typeof now !== 'object') return false;
  return isId(w.from) && now.pane === w.from && now.focusedId === w.id && now.t <= w.until;
}

module.exports = { DIRS, TIE_PX, WAIT_MS, KEYS, TAKEN, CODES, norm, conflicts, match, gridRects, pick, nextInQueue, mayFocus, holds };
