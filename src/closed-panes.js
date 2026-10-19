// "閉じたペインを開き直す" history (#23) (unit-tested in test/closed-panes.test.js). Pure: main.js owns the array (one per window, newest
// last, memory only: never written to panes.json, gone when the app quits), the views, the focus and every side effect; where the pane goes back
// in the rows is reopen-rules.js placeReopened().
// An entry is only what the pane is made again from: spec (main's paneSpec: url, name, color, muted, zoom, zoomIndiv, reloadMinutes, sleep) and
// where it sat (row, col, rowGone, cols; with the dock's stacked cells also cell, pos, size from dock-layout.js where). Never a draft, an
// attachment, page text, a snapshot, a token, the pane id or its view.
// Reopening reads the newest entry (peek) and takes it off only once the pane exists: a full window (MAX panes), a reopen already running or a
// pane that could not be made leave the history as it was.
const LIMIT = 10;                // the newest LIMIT closed panes
const SPEC_KEYS = ['url', 'name', 'color', 'muted', 'zoom', 'zoomIndiv', 'reloadMinutes', 'sleep'];
// how a reopen ended (diagnostics 'reopen'): reopened / nothing closed / MAX panes open / one already running / the pane could not be made
const CODES = ['OK', 'EMPTY', 'FULL', 'BUSY', 'FAIL'];

// rows = row lengths, i = the pane's index in the row-major panes[] -> { row, col, rowGone: it is its row's only pane, cols: widest row }
function where(rows, i) {
  const R = Array.isArray(rows) ? rows : [];
  let row = 0, st = 0; while (row < R.length - 1 && i >= st + R[row]) { st += R[row]; row++; }
  return { row, col: Math.max(0, i - st), rowGone: R[row] === 1, cols: Math.max(1, ...R) };
}
// a pane being closed: its spec + where() -> the entry, or null (no page / the new-tab page: nothing to reopen)
function entry(spec, w, newtab) {
  if (!spec || typeof spec !== 'object' || typeof spec.url !== 'string' || !spec.url || spec.url === newtab || !w) return null;
  const s = {}; for (const k of SPEC_KEYS) if (Object.hasOwn(spec, k)) s[k] = spec[k];
  const e = { spec: s, row: w.row, col: w.col, rowGone: !!w.rowGone, cols: w.cols };
  if (['cell', 'pos', 'size'].every(k => Number.isInteger(w[k]))) Object.assign(e, { cell: w.cell, pos: w.pos, size: w.size });   // (dock) its cell / place in it
  return e;
}
// remember an entry (null: nothing); the oldest go beyond `limit`
function push(stack, e, limit = LIMIT) {
  if (e) { stack.push(e); while (stack.length > limit) stack.shift(); }
  return stack;
}
const peek = stack => Array.isArray(stack) && stack.length ? stack[stack.length - 1] : null;
// take e off once its pane exists: only if it is still the newest (never another entry)
function take(stack, e) {
  if (!e || peek(stack) !== e) return false;
  stack.pop(); return true;
}
const canReopen = (stack, paneCount, max) => !!peek(stack) && paneCount < max;
// before reopening -> { code: '' (go) | 'BUSY' | 'EMPTY' | 'FULL', e: the entry to make (still in the history) }
function plan(stack, paneCount, max, busy) {
  if (busy) return { code: 'BUSY', e: null };
  const e = peek(stack);
  if (!e) return { code: 'EMPTY', e: null };
  if (!(paneCount < max)) return { code: 'FULL', e: null };
  return { code: '', e };
}
// a moment after the reopen: may main put the keyboard into the new pane? now: { focusedId: main's focused pane, overlay: the palette is open,
// fw: id of the webContents with the keyboard (0: none), revs: [[pane id, input revision]] }; at: the same right after the reopen + id: the
// reopened pane, fws: where the keyboard may still be without the user having moved it (where it was, the pane focused before, the new pane).
// Only when nothing moved meanwhile: still main's focused pane, no palette, the keyboard not taken elsewhere, no key typed into any pane.
function mayFocus(at, now) {
  if (!at || !now || typeof at !== 'object' || typeof now !== 'object') return false;
  if (now.focusedId !== at.id || now.overlay) return false;
  if (now.fw && !(Array.isArray(at.fws) && at.fws.includes(now.fw))) return false;
  const m = new Map(Array.isArray(at.revs) ? at.revs : []);
  return (Array.isArray(now.revs) ? now.revs : []).every(([id, rev]) => !m.has(id) || m.get(id) === rev);
}

module.exports = { LIMIT, SPEC_KEYS, CODES, where, entry, push, peek, take, canReopen, plan, mayFocus };
