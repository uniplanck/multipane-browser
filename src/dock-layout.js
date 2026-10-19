// ドッキング型のペイン並べ替え (unit-tested in test/dock-layout.test.js). Pure: main.js passes its rows, the pane ids in panes[] order, the
// panes' rectangles and the cursor, and does everything else itself (the drag, hiding / showing the views, panes[], saving; makeWindow: dock*).
// The rows (backward compatible): rows[r] = the panes of row r, stacked ones included (as before: panes[] is row-major and adds up to them);
// stacks[r][c] = the panes stacked top to bottom in cell c of row r (adds up to rows[r]). No stacks (every older file, an older app reading a
// newer one) = one pane per cell. Here the rows are a grid of pane ids: grid[r][c] = [id, ...] top to bottom.
// A drop of pane `from` onto pane `to`: top / bottom = into to's cell above / below it (the row keeps its height, the cell's panes share it
// evenly), left / right = a cell of its own beside to's cell; edgeTop / edgeBottom (the band at the top / bottom edge of the rows) = a row of
// its own, the full width. Where it came from closes like a closed pane: its cell shrinks (one left: an ordinary cell), an empty cell / row goes.
// Limits: a cell holds at most MAX_STACK panes; top / bottom only while there are at most STACK_ROWS rows (counted before the drop) and the
// rows' tallest cells add up to at most MAX_TALL after it; no edge drop once there are MAX_ROWS rows. Any change that leaves more rows or a
// taller layout (an edge drop, a new / reopened pane in a new row) undoes every stack (dissolve). A drop onto itself, one that changes nothing
// and one over a limit do nothing (no zone, no preview).
const { placeReopened } = require('./reopen-rules');

const MAX_STACK = 3;              // panes in one cell
const MAX_TALL = 3;               // the rows' tallest cells added up
const STACK_ROWS = 2;             // cells stack only while there are at most this many rows
const MAX_ROWS = 3;               // an edge drop (a new row) only while there are fewer rows
const EDGE = { out: 18, in: 12 }; // px: the edge bands reach this far beyond / into the top and the bottom of the rows
const BAND = { part: 4, min: 60, max: 200 };   // px: the preview of an edge drop is this part of the rows' height, kept within min..max (and the rows)
const SIDES = ['top', 'bottom', 'left', 'right', 'edgeTop', 'edgeBottom'];
const HIT = ['left', 'right', 'top', 'bottom'];   // a point as near to two sides (on a diagonal): the first of these
const DRAG_MS = 30000;            // main ends a drag that lasts longer (views shown again)
const READY_MS = 600;             // main hides the views this long after the stills went out even when the window did not answer

const sum = a => a.reduce((x, y) => x + y, 0);
const isRows = rows => Array.isArray(rows) && rows.every(k => Number.isInteger(k) && k > 0);
const isRect = r => !!r && typeof r === 'object' && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0;
const flat = rows => isRows(rows) ? rows.map(k => Array(k).fill(1)) : [];
const isFlat = stacks => Array.isArray(stacks) && stacks.every(s => Array.isArray(s) && s.every(k => k === 1));
const tallOf = stacks => sum(stacks.map(s => Math.max(1, ...s)));
const shape = grid => grid.map(row => row.map(c => c.length));
const clone = grid => grid.map(row => row.map(c => [...c]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const limitsOk = st => st.every(s => s.every(k => k <= MAX_STACK)) && (isFlat(st) || (st.length <= STACK_ROWS && tallOf(st) <= MAX_TALL));
// stacks that fit these rows and the limits (the only ones main uses / the schema keeps)
function stacksOk(stacks, rows) {
  if (!isRows(rows) || !Array.isArray(stacks) || stacks.length !== rows.length) return false;
  if (!stacks.every((s, r) => Array.isArray(s) && s.length > 0 && s.every(k => Number.isInteger(k) && k >= 1 && k <= MAX_STACK) && sum(s) === rows[r])) return false;
  return limitsOk(stacks);
}
// a saved value -> a copy to check later (stacksOk), or null
const read = v => Array.isArray(v) && v.every(Array.isArray) ? v.map(s => s.map(Number)) : null;

// rows / stacks (unusable or null: one pane per cell) + the pane ids in panes[] order -> grid, or null when the rows do not add up to the ids
function toGrid(rows, stacks, ids) {
  if (!isRows(rows) || !Array.isArray(ids) || sum(rows) !== ids.length) return null;
  const st = stacksOk(stacks, rows) ? stacks : flat(rows);
  let i = 0;
  return st.map(s => s.map(k => ids.slice(i, i += k)));
}
// grid -> { order: the ids in panes[] order, rows, stacks: null when every cell holds one pane (nothing new is written then) }
function fromGrid(grid) {
  const g = grid.map(row => row.filter(c => c.length)).filter(row => row.length);
  const st = shape(g);
  return { order: g.flat(2), rows: st.map(sum), stacks: isFlat(st) ? null : st };
}
function find(grid, id) {
  for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid[r].length; c++) { const k = grid[r][c].indexOf(id); if (k >= 0) return { r, c, k }; }
  return null;
}
// where pane `id` sits (for closed-panes.js entry): row, col (its place among the row's panes, as before), rowGone (its row's only pane), cols
// (the widest row, in cells), cell / pos (its cell, its place in it from the top), size (the panes of that cell) -> null when it is not there
function where(grid, id) {
  const at = find(grid, id); if (!at) return null;
  const row = grid[at.r];
  return { row: at.r, col: sum(row.slice(0, at.c).map(c => c.length)) + at.k, rowGone: sum(row.map(c => c.length)) === 1,
    cols: Math.max(1, ...grid.map(x => x.length)), cell: at.c, pos: at.k, size: row[at.c].length };
}
// the pane taken out (closed / dragged away): its cell shrinks, an empty cell / row goes -> a new grid (null: not there)
function without(grid, id) {
  const at = find(grid, id); if (!at) return null;
  const g = clone(grid);
  g[at.r][at.c].splice(at.k, 1);
  if (!g[at.r][at.c].length) g[at.r].splice(at.c, 1);
  if (!g[at.r].length) g.splice(at.r, 1);
  return g;
}

// every stack undone: the top pane of a stack stays in its cell; the others leave one by one from the top (row by row; in a row by their height
// in the stack, then left to right), each to the row with the fewest panes at that moment (any row: the one right below / above its stack's
// row, the others, its own; the new edge row too) - a tie: the row nearest to its stack's row (its own first), then the upper one. There it is a
// cell of its own at the place whose centre is nearest to the centre its cell had (as a fraction of the row's width; a tie: the right one)
function dissolve(grid) {
  const g = clone(grid), leave = [];
  g.forEach((row, r) => {
    const tall = Math.max(1, ...row.map(c => c.length));
    for (let k = 1; k < tall; k++) row.forEach((c, ci) => { if (c.length > k) leave.push({ id: c[k], r, num: 2 * ci + 1, den: 2 * row.length }); });
  });
  const count = g.map(row => sum(row.map(c => c.length)));
  for (const x of leave) {
    const at = find(g, x.id); g[at.r][at.c].splice(at.k, 1); count[x.r]--;
    const near = g.map((_, i) => i).sort((a, b) => Math.abs(a - x.r) - Math.abs(b - x.r) || a - b);
    let t = -1; for (const i of near) if (t < 0 || count[i] < count[t]) t = i;
    const m = g[t].length;                                      // slot s of m + 1 cells: centre (2s + 1) / (2 (m + 1)) against num / den
    let s = 0, best = Infinity;
    for (let j = 0; j <= m; j++) { const d = Math.abs((2 * j + 1) * x.den - 2 * x.num * (m + 1)); if (d <= best) { best = d; s = j; } }
    g[t].splice(s, 0, [x.id]); count[t]++;
  }
  return g;
}
// the limits kept after a change of the rows: within them as it is, else every stack undone
const fit = grid => limitsOk(shape(grid)) ? grid : dissolve(grid);

// the drop of pane `from` on `side` of pane `to` (edgeTop / edgeBottom: `to` unused) -> the new grid, or null when it is not allowed (unknown
// pane / side, onto itself, a limit). A drop that changes nothing is a grid equal to the old one (canDrop: no)
function drop(grid, from, to, side) {
  if (!Array.isArray(grid) || !SIDES.includes(side) || !find(grid, from)) return null;
  const edge = side === 'edgeTop' || side === 'edgeBottom';
  if (edge) {
    if (grid.length >= MAX_ROWS) return null;
    const g = without(grid, from);
    if (side === 'edgeTop') g.unshift([[from]]); else g.push([[from]]);
    return fit(g);
  }
  if (to === from || !find(grid, to)) return null;
  if ((side === 'top' || side === 'bottom') && grid.length > STACK_ROWS) return null;
  const g = without(grid, from), at = find(g, to);
  if (side === 'left' || side === 'right') { g[at.r].splice(at.c + (side === 'right' ? 1 : 0), 0, [from]); return fit(g); }
  if (tallOf(shape(g)) >= MAX_TALL) return null;            // the rows (without the dragged pane) are already 3 tall: no top / bottom at all
  if (g[at.r][at.c].length >= MAX_STACK) return null;
  g[at.r][at.c].splice(at.k + (side === 'bottom' ? 1 : 0), 0, from);
  return limitsOk(shape(g)) ? g : null;
}
const canDrop = (grid, from, to, side) => { const g = drop(grid, from, to, side); return !!g && !same(g, grid); };

// the side of rectangle r the point is nearest to, by its diagonals (exact for whole pixels: the distances compared as products)
function sideOf(r, pt) {
  const d = { left: (pt.x - r.x) * r.h, right: (r.x + r.w - pt.x) * r.h, top: (pt.y - r.y) * r.w, bottom: (r.y + r.h - pt.y) * r.w };
  let best = HIT[0]; for (const s of HIT) if (d[s] < d[best]) best = s;
  return best;
}
// the drop under the cursor -> { to, side } (to: 0 for an edge) | null. rects: the panes' rectangles { x, y, w, h } (header included; null = not
// shown) in the order of ids (= panes[]); area: the rows' rectangle. The edge bands first, but only while an edge drop is possible there (else
// the pane under the cursor answers); a gap, the dragged pane itself, a limit or a drop that changes nothing: null
function zoneAt(grid, ids, rects, area, from, pt, edge = EDGE) {
  if (!Array.isArray(grid) || !Array.isArray(ids) || !Array.isArray(rects) || !isRect(area) || !pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
  const inX = pt.x >= area.x && pt.x < area.x + area.w, bottom = area.y + area.h;
  if (inX && pt.y >= area.y - edge.out && pt.y < area.y + edge.in && canDrop(grid, from, 0, 'edgeTop')) return { to: 0, side: 'edgeTop' };
  if (inX && pt.y >= bottom - edge.in && pt.y < bottom + edge.out && canDrop(grid, from, 0, 'edgeBottom')) return { to: 0, side: 'edgeBottom' };
  const i = rects.findIndex(r => isRect(r) && pt.x >= r.x && pt.x < r.x + r.w && pt.y >= r.y && pt.y < r.y + r.h);
  if (i < 0 || ids[i] === from) return null;
  const side = sideOf(rects[i], pt);
  return canDrop(grid, from, ids[i], side) ? { to: ids[i], side } : null;
}
// the preview of a zone, where the cursor is (not where the dragged pane ends up): top / bottom / left / right = that half of the target pane's
// rectangle r (as zoneAt got it); edgeTop / edgeBottom = a band the full width of the rows' rectangle `area` at its top / bottom (r unused),
// BAND high -> { x, y, w, h } | null (unknown side, no usable rectangle)
function previewRect(r, side, area) {
  if (side === 'edgeTop' || side === 'edgeBottom') {
    if (!isRect(area)) return null;
    const h = Math.min(area.h, Math.max(BAND.min, Math.min(BAND.max, Math.round(area.h / BAND.part))));
    return { x: area.x, y: side === 'edgeTop' ? area.y : area.y + area.h - h, w: area.w, h };
  }
  if (!HIT.includes(side) || !isRect(r)) return null;
  const hh = Math.round(r.h / 2), hw = Math.round(r.w / 2);
  const out = side === 'top' ? { x: r.x, y: r.y, w: r.w, h: hh } : side === 'bottom' ? { x: r.x, y: r.y + hh, w: r.w, h: r.h - hh }
    : side === 'left' ? { x: r.x, y: r.y, w: hw, h: r.h } : { x: r.x + hw, y: r.y, w: r.w - hw, h: r.h };
  return isRect(out) ? out : null;
}

// a new pane once the rows are no longer the default grid (main's insertPane): a cell of its own at the end of the first row with fewer than
// maxCols cells, else a new row while there are fewer than maxRows -> the grid (fit), or null (no room: main goes back to the default grid)
function add(grid, id, maxCols, maxRows) {
  const g = clone(grid);
  let r = g.findIndex(row => row.length < maxCols);
  if (r < 0 && g.length < maxRows) { g.push([]); r = g.length - 1; }
  if (r < 0) return null;
  g[r].push([id]);
  return fit(g);
}
// a reopened pane (#23) e = its closed-panes entry: back into its stack when that cell is still the one it left (same row / cell, one pane
// fewer) and the limits allow it, else a cell of its own where reopen-rules placeReopened puts it (on the rows' cells) -> the grid (fit)
function reopen(grid, id, e) {
  const x = e && typeof e === 'object' ? e : {};
  if (!x.rowGone && Number.isInteger(x.size) && x.size > 1 && Number.isInteger(x.cell) && Number.isInteger(x.pos)) {
    const cell = grid[x.row] && grid[x.row][x.cell];
    if (cell && cell.length === x.size - 1) {
      const g = clone(grid); g[x.row][x.cell].splice(Math.min(Math.max(0, x.pos), cell.length), 0, id);
      if (limitsOk(shape(g))) return g;
    }
  }
  const before = grid.map(row => row.length);
  const pl = placeReopened(before, { row: x.row, col: Number.isInteger(x.cell) ? x.cell : x.col, rowGone: x.rowGone, cols: x.cols });
  let r = 0, c = pl.index; while (r < pl.rows.length - 1 && c >= pl.rows[r]) { c -= pl.rows[r]; r++; }
  const g = clone(grid);
  if (pl.rows.length > before.length) g.splice(r, 0, [[id]]); else g[r].splice(c, 0, [id]);
  return fit(g);
}

module.exports = { MAX_STACK, MAX_TALL, STACK_ROWS, MAX_ROWS, EDGE, BAND, SIDES, DRAG_MS, READY_MS,
  flat, isFlat, stacksOk, read, toGrid, fromGrid, where, without, dissolve, fit, drop, canDrop, sideOf, zoneAt, previewRect, add, reopen };
