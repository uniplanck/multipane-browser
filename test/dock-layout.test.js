// node test/dock-layout.test.js — ドッキング型のペイン並べ替え. The pure parts (src/dock-layout.js): the rows with stacked cells (rows / stacks <->
// a grid of pane ids, older rows without stacks), the zone under the cursor (a pane's four sides by its diagonals, the edge bands, gaps, ties,
// the dragged pane itself), the limits (stacking with 1 / 2 / 3 rows, 2 / 3 panes in a cell, the rows' tallest cells, no edge row at 3 rows),
// the drops (left / right / top / bottom / edge), the preview's rectangle (the zone's half of the target pane / the edge band), the hole a pane leaves, drops that change nothing, every stack undone when the rows grow
// (fixed results), a new / reopened pane, the saved form (state-schema.js: kept, repaired, round trip, older files) and main's wiring.
// Not covered here: the real drag over the WebContentsViews, the stills, the preview on screen - that needs the manual check.
const fs = require('fs'), path = require('path');
const DL = require('../src/dock-layout');
const S = require('../src/state-schema');
const CP = require('../src/closed-panes');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const ids = n => Array.from({ length: n }, (_, i) => i + 1);
const G = (rows, stacks) => DL.toGrid(rows, stacks, ids(rows.reduce((a, b) => a + b, 0)));
const drop = (g, from, to, side) => J(DL.drop(g, from, to, side));
// the rectangles of a grid in an area (rows share the height, cells the width, a stacked cell its height; gap between them)
function rectsOf(grid, area, gap = 0) {
  const out = [], rh = area.h / grid.length;
  grid.forEach((row, r) => { const cw = area.w / row.length; row.forEach((cell, c) => cell.forEach((id, j) => {
    const h = rh / cell.length; out[id - 1] = { x: area.x + c * cw, y: area.y + r * rh + j * h, w: cw - gap, h: h - gap };
  })); });
  return out;
}
const AREA = { x: 0, y: 100, w: 1200, h: 800 };
const at = (g, from, x, y, gap = 0) => J(DL.zoneAt(g, ids(g.flat(2).length), rectsOf(g, AREA, gap), AREA, from, { x, y }));

// ---- rows / stacks <-> grid; older rows without stacks ----
t('older rows (no stacks): one pane per cell', J(G([3, 2])) === J([[[1], [2], [3]], [[4], [5]]]) && J(G([3, 2], null)) === J(G([3, 2], undefined)));
t('stacks: the cells hold their panes top to bottom (rows [3, 3] + stacks [[1, 2], [1, 1, 1]])', J(G([3, 3], [[1, 2], [1, 1, 1]])) === J([[[1], [2, 3]], [[4], [5], [6]]]));
t('unusable stacks are read as one pane per cell (not these rows / bad numbers / over a limit)', [[[1, 1]], [[1, 2], [3]], [[0, 3], [1, 1, 1]], [[1, 2.5]], 'x', [[3], [1, 1, 1]], [[4]]].every(st => J(G([3, 3], st)) === J(G([3, 3]))));
t('rows that do not add up to the panes: no grid', DL.toGrid([2, 2], null, ids(3)) === null && DL.toGrid([2, 0], null, ids(2)) === null && DL.toGrid(null, null, []) === null);
t('fromGrid: order / rows / stacks; null stacks when every cell holds one pane (nothing new written)', J(DL.fromGrid([[[1], [2, 3]], [[4]]])) === J({ order: [1, 2, 3, 4], rows: [3, 1], stacks: [[1, 2], [1]] })
  && J(DL.fromGrid(G([2, 2]))) === J({ order: [1, 2, 3, 4], rows: [2, 2], stacks: null }));
t('fromGrid: empty cells / rows go', J(DL.fromGrid([[[], [1]], [], [[2]]])) === J({ order: [1, 2], rows: [1, 1], stacks: null }));
t('read: a saved value -> a copy of numbers (checked later), anything else null', J(DL.read([[1, '2']])) === J([[1, 2]]) && DL.read(null) === null && DL.read([1, 2]) === null && DL.read('x') === null);

// ---- the limits (stacksOk) ----
t('stacksOk: 1 row, a cell of 2 / 3 panes', DL.stacksOk([[2, 1]], [3]) && DL.stacksOk([[3]], [3]) && DL.stacksOk([[1, 3, 1]], [5]));
t('stacksOk: no cell of 4', !DL.stacksOk([[4]], [4]));
t('stacksOk: 2 rows, the tallest cells add up to 3 at most', DL.stacksOk([[2, 1], [1, 1]], [3, 2]) && DL.stacksOk([[1], [2, 2]], [1, 4]) && !DL.stacksOk([[2], [2]], [2, 2]) && !DL.stacksOk([[3], [1]], [3, 1]));
t('stacksOk: 3 rows, no stacked cell at all (one pane per cell is fine)', !DL.stacksOk([[2], [1], [1]], [2, 1, 1]) && DL.stacksOk([[1], [1], [1]], [1, 1, 1]));
t('stacksOk: must add up to the rows', !DL.stacksOk([[1, 2]], [2]) && !DL.stacksOk([[1, 1]], [2, 1]) && !DL.stacksOk([[]], [0]));
t('limits as fixed numbers', DL.MAX_STACK === 3 && DL.MAX_TALL === 3 && DL.STACK_ROWS === 2 && DL.MAX_ROWS === 3);

// ---- the zone under the cursor ----
{ const r = { x: 0, y: 100, w: 600, h: 400 };
  t('sideOf: the nearest side by the diagonals', DL.sideOf(r, { x: 300, y: 112 }) === 'top' && DL.sideOf(r, { x: 300, y: 480 }) === 'bottom' && DL.sideOf(r, { x: 30, y: 300 }) === 'left' && DL.sideOf(r, { x: 590, y: 300 }) === 'right');
  t('sideOf: on a diagonal / the centre (a tie): left / right first', DL.sideOf(r, { x: 150, y: 200 }) === 'left' && DL.sideOf(r, { x: 450, y: 200 }) === 'right' && DL.sideOf(r, { x: 300, y: 300 }) === 'left' && DL.sideOf(r, { x: 150, y: 400 }) === 'left');
  t('sideOf: a wide pane is cut by its own diagonals (not 45°)', DL.sideOf({ x: 0, y: 0, w: 1000, h: 100 }, { x: 200, y: 10 }) === 'top' && DL.sideOf({ x: 0, y: 0, w: 1000, h: 100 }, { x: 200, y: 30 }) === 'left'
    && DL.sideOf({ x: 0, y: 0, w: 1000, h: 100 }, { x: 500, y: 49 }) === 'top'); }
{ const g = G([2, 2]);                                       // 1 2 / 3 4 in 1200 x 800 from y 100: rows 100..500 / 500..900
  t('zoneAt: another pane: its side', at(g, 4, 300, 150) === J({ to: 1, side: 'top' }) && at(g, 4, 590, 300) === J({ to: 1, side: 'right' }) && at(g, 1, 900, 480) === J({ to: 2, side: 'bottom' }) && at(g, 3, 650, 300) === J({ to: 2, side: 'left' }));
  t('zoneAt: a side whose drop changes nothing (1 is already left of 2): nothing', at(g, 1, 650, 300) === 'null' && at(g, 2, 550, 300) === 'null');
  t('zoneAt: the dragged pane itself: nothing', at(g, 1, 300, 300) === 'null' && at(g, 3, 100, 700) === 'null');
  t('zoneAt: the top band (18 px above the rows .. 12 px into them) = a new row on top', at(g, 4, 300, 82) === J({ to: 0, side: 'edgeTop' }) && at(g, 4, 300, 111) === J({ to: 0, side: 'edgeTop' }) && at(g, 4, 300, 112) === J({ to: 1, side: 'top' }) && at(g, 4, 300, 81) === 'null');
  t('zoneAt: the bottom band (12 px into the last row ..) = a new row at the bottom', at(g, 1, 300, 888) === J({ to: 0, side: 'edgeBottom' }) && at(g, 1, 300, 905) === J({ to: 0, side: 'edgeBottom' }) && at(g, 1, 300, 887) === J({ to: 3, side: 'bottom' }));
  t('zoneAt: the bands only across the rows\' width', at(g, 4, -1, 90) === 'null' && at(g, 4, 1200, 90) === 'null' && at(g, 4, 0, 90) === J({ to: 0, side: 'edgeTop' }));
  t('zoneAt: a gap between panes / outside: nothing', at(g, 4, 597, 300, 6) === 'null' && at(g, 4, 300, 497, 6) === 'null' && at(g, 4, 300, 1000) === 'null');
  t('zoneAt: a pane\'s edge belongs to the pane right / below it', at(g, 4, 600, 300) === J({ to: 2, side: 'left' }) && at(g, 1, 900, 500) === J({ to: 4, side: 'top' }));
  t('zoneAt: bad input -> nothing', J(DL.zoneAt(g, ids(4), rectsOf(g, AREA), AREA, 4, { x: NaN, y: 1 })) === 'null' && J(DL.zoneAt(g, ids(4), rectsOf(g, AREA), null, 4, { x: 1, y: 1 })) === 'null'
    && J(DL.zoneAt(null, ids(4), [], AREA, 4, { x: 1, y: 1 })) === 'null' && J(DL.zoneAt(g, ids(4), [null, null, null, null], AREA, 4, { x: 300, y: 300 })) === 'null'); }
{ const g = G([1, 2]);                                       // 1 / 2 3: 1 is alone in the top row
  t('zoneAt: a band whose drop changes nothing falls through to the pane under it (here: itself)', at(g, 1, 300, 105) === 'null' && at(g, 2, 300, 105) === J({ to: 0, side: 'edgeTop' })); }
{ const g = G([2, 1, 1]);                                    // 3 rows: no stacking, no edge row
  t('zoneAt: 3 rows: top / bottom of any pane and the bands do not react (no preview), left / right do', at(g, 4, 300, 110) === 'null' && at(g, 4, 300, 130) === 'null' && at(g, 1, 300, 888) === 'null'
    && at(g, 3, 300, 250) === 'null' && at(g, 3, 30, 250) === J({ to: 1, side: 'left' }) && at(g, 1, 1190, 600) === J({ to: 3, side: 'right' })); }
{ const g = [[[1, 2], [3]], [[4], [5]]];                    // 2 rows, tall 3 already: 1 / 2 stacked, 3 | 4 5
  t('zoneAt: the rows already 3 tall (without the dragged pane): top / bottom never react (no preview); left / right do', at(g, 5, 300, 520) === 'null' && at(g, 3, 300, 880) === 'null'
    && at(g, 5, 900, 130) === 'null' && at(g, 5, 30, 700) === J({ to: 4, side: 'left' })); }
{ const g = [[[1, 2], [3]], [[4]]];                          // 2 rows, 1 / 2 stacked: dragging 2 out leaves tall 2 -> stacking elsewhere is fine
  t('zoneAt: tall counted without the dragged pane (out of its stack: 2) -> top / bottom react', at(g, 2, 900, 130) === J({ to: 3, side: 'top' })); }

// ---- the preview: where the cursor is (the zone on the target pane / the edge band), not the dragged pane's place after the drop ----
{ const r = { x: 606, y: 100, w: 594, h: 397 };
  t('previewRect: top / bottom / left / right = that half of the target pane (odd sizes: the halves add up to it)',
    J(DL.previewRect(r, 'top', AREA)) === J({ x: 606, y: 100, w: 594, h: 199 }) && J(DL.previewRect(r, 'bottom', AREA)) === J({ x: 606, y: 299, w: 594, h: 198 })
    && J(DL.previewRect(r, 'left', AREA)) === J({ x: 606, y: 100, w: 297, h: 397 }) && J(DL.previewRect(r, 'right', AREA)) === J({ x: 903, y: 100, w: 297, h: 397 }));
  t('previewRect: the pane sides do not need the area', J(DL.previewRect(r, 'top', null)) === J(DL.previewRect(r, 'top', AREA)));
  t('previewRect: edgeTop / edgeBottom = a band the rows\' full width at their top / bottom, a quarter of their height (800 -> 200), the pane unused',
    J(DL.previewRect(null, 'edgeTop', AREA)) === J({ x: 0, y: 100, w: 1200, h: 200 }) && J(DL.previewRect(r, 'edgeBottom', AREA)) === J({ x: 0, y: 700, w: 1200, h: 200 }));
  const band = h => DL.previewRect(null, 'edgeBottom', { x: 6, y: 50, w: 900, h }).h;
  t('previewRect: the band\'s height kept within 60..200 px (and the rows)', band(400) === 100 && band(1000) === 200 && band(200) === 60 && band(40) === 40 && DL.BAND.min === 60 && DL.BAND.max === 200);
  t('previewRect: bad input -> null (unknown side, no / empty pane rectangle, no area for an edge)', DL.previewRect(r, 'middle', AREA) === null && DL.previewRect(null, 'top', AREA) === null
    && DL.previewRect({ x: 0, y: 0, w: 0, h: 100 }, 'left', AREA) === null && DL.previewRect({ x: NaN, y: 0, w: 10, h: 10 }, 'right', AREA) === null
    && DL.previewRect({ x: 0, y: 0, w: 10, h: 1 }, 'bottom', AREA) === null && DL.previewRect(r, 'edgeTop', null) === null && DL.previewRect(r, 'edgeBottom', { x: 0, y: 0, w: 10, h: 0 }) === null); }
for (const [name, g, from] of [['2 x 2', G([2, 2]), 4], ['a stacked cell', [[[1, 2], [3]], [[4]]], 4], ['1 row', G([3]), 2]]) {
  const rs = rectsOf(g, AREA, 6), all = ids(g.flat(2).length); let n = 0, ok = true;
  for (let x = 3; x < 1200; x += 37) for (let y = 85; y < 915; y += 29) {
    const z = DL.zoneAt(g, all, rs, AREA, from, { x, y }); if (!z) continue;
    const tr = z.to ? rs[z.to - 1] : AREA, p = DL.previewRect(tr, z.side, AREA); n++;
    if (!p) { ok = false; continue; }
    const inside = p.x >= tr.x && p.y >= tr.y && p.x + p.w <= tr.x + tr.w && p.y + p.h <= tr.y + tr.h;
    const hit = x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h;
    if (!inside || (z.to ? !hit : y >= AREA.y && y < AREA.y + AREA.h && !hit)) ok = false;
  }
  t(`previewRect with zoneAt (${name}): within the target pane / the rows, under the cursor (a band: whenever the cursor is inside the rows)`, ok && n > 50);
}

// ---- drops: left / right ----
{ const g = G([3, 2]);                                       // 1 2 3 / 4 5
  t('left / right: between the target and its neighbour in the same row', drop(g, 5, 2, 'left') === J([[[1], [5], [2], [3]], [[4]]]) && drop(g, 5, 2, 'right') === J([[[1], [2], [5], [3]], [[4]]]));
  t('left / right: within the row the pane just moves', drop(g, 1, 3, 'right') === J([[[2], [3], [1]], [[4], [5]]]) && drop(g, 3, 1, 'left') === J([[[3], [1], [2]], [[4], [5]]]));
  t('left / right: a row left empty goes', drop(G([3, 1]), 4, 1, 'left') === J([[[4], [1], [2], [3]]])); }
{ const g = [[[1], [2, 3]], [[4]]];
  t('left / right of a stacked pane: a cell of its own beside the stack', drop(g, 4, 3, 'left') === J([[[1], [4], [2, 3]]]) && drop(g, 4, 2, 'right') === J([[[1], [2, 3], [4]]]));
  t('out of a stack to the side: the stack shrinks (one left: an ordinary cell)', drop(g, 3, 1, 'left') === J([[[3], [1], [2]], [[4]]]) && drop(g, 3, 4, 'right') === J([[[1], [2]], [[4], [3]]])); }

// ---- drops: top / bottom (stacking) ----
t('1 row: top / bottom stack the target\'s cell, the other panes keep their height', drop(G([3]), 3, 1, 'top') === J([[[3, 1], [2]]]) && drop(G([3]), 3, 1, 'bottom') === J([[[1, 3], [2]]]));
t('1 row: a cell of 3', drop([[[1, 2], [3]]], 3, 2, 'bottom') === J([[[1, 2, 3]]]) && drop([[[1, 2], [3]]], 3, 1, 'bottom') === J([[[1, 3, 2]]]));
t('a cell of 3: no 4th (no reaction)', DL.drop([[[1, 2, 3], [4]]], 4, 1, 'top') === null && DL.drop([[[1, 2, 3], [4]]], 4, 3, 'bottom') === null);
t('2 rows: a stack of 2 in one row (tall 2 + 1 = 3)', drop(G([2, 2]), 4, 1, 'bottom') === J([[[1, 4], [2]], [[3]]]) && drop(G([2, 2]), 1, 3, 'top') === J([[[2]], [[1, 3], [4]]]));
t('2 rows, already 3 tall: no second stack, even in the same row (no reaction)', DL.drop([[[1, 4], [2]], [[3], [5]]], 5, 2, 'top') === null);
t('2 rows: a stack in the other row too (tall 4) / a cell of 3 (tall 4): no reaction', DL.drop([[[1, 4], [2]], [[3], [5]]], 2, 3, 'top') === null && DL.drop([[[1, 4], [2]], [[3], [5]]], 5, 4, 'bottom') === null);
t('2 rows -> 1 row by the drop: up to a cell of 3', drop([[[1, 2]], [[3]]], 3, 2, 'bottom') === J([[[1, 2, 3]]]));
t('3 rows: top / bottom never (counted before the drop, even when the dragged pane is alone in its row)', DL.drop(G([2, 1, 1]), 4, 1, 'top') === null && DL.drop(G([2, 1, 1]), 1, 3, 'bottom') === null && DL.drop(G([1, 1, 1]), 3, 1, 'top') === null);
t('onto itself / unknown pane / unknown side: not allowed', DL.drop(G([2, 2]), 1, 1, 'top') === null && DL.drop(G([2, 2]), 9, 1, 'top') === null && DL.drop(G([2, 2]), 1, 9, 'top') === null && DL.drop(G([2, 2]), 1, 2, 'middle') === null && DL.drop(null, 1, 2, 'top') === null);

// ---- drops that change nothing (no zone, no preview, nothing done) ----
t('no-op: left of the right neighbour / right of the left neighbour', !DL.canDrop(G([3]), 1, 2, 'left') && !DL.canDrop(G([3]), 2, 1, 'right') && DL.canDrop(G([3]), 1, 2, 'right'));
t('no-op: above the pane it is already above in its cell', !DL.canDrop([[[1, 2]]], 1, 2, 'top') && !DL.canDrop([[[1, 2]]], 2, 1, 'bottom') && DL.canDrop([[[1, 2]]], 2, 1, 'top'));
t('no-op: an edge row for the only pane of the top / bottom row', !DL.canDrop(G([1, 2]), 1, 0, 'edgeTop') && !DL.canDrop(G([2, 1]), 3, 0, 'edgeBottom') && DL.canDrop(G([1, 2]), 1, 0, 'edgeBottom'));
t('canDrop: onto itself / over a limit: no', !DL.canDrop(G([2, 2]), 2, 2, 'left') && !DL.canDrop(G([2, 1, 1]), 4, 1, 'top'));

// ---- the hole a pane leaves (= closing it) ----
t('hole: a pane of a row: the row re-divides', J(DL.without(G([3, 2]), 2)) === J([[[1], [3]], [[4], [5]]]));
t('hole: the only pane of a row: the row goes', J(DL.without(G([2, 1, 2]), 3)) === J([[[1], [2]], [[4], [5]]]));
t('hole: a stacked pane: its cell shrinks (2 -> an ordinary cell, 3 -> 2), the rest stays', J(DL.without([[[1, 2], [3]]], 1)) === J([[[2], [3]]]) && J(DL.without([[[1, 2, 3], [4]]], 2)) === J([[[1, 3], [4]]]));
t('hole: unknown pane -> null', DL.without(G([2]), 7) === null);
t('where: row / col among the row\'s panes / rowGone / widest row in cells / cell / pos / size', J(DL.where([[[1], [2, 3]], [[4]]], 3)) === J({ row: 0, col: 2, rowGone: false, cols: 2, cell: 1, pos: 1, size: 2 })
  && J(DL.where([[[1], [2, 3]], [[4]]], 4)) === J({ row: 1, col: 0, rowGone: true, cols: 2, cell: 0, pos: 0, size: 1 }) && DL.where(G([1]), 5) === null);
t('where without stacks = closed-panes where (the entry is as before)', [[3, 2], [2, 1, 2], [4]].every(rows => ids(rows.reduce((a, b) => a + b, 0)).every(id => {
  const w = DL.where(G(rows), id), c = CP.where(rows, id - 1); return w.row === c.row && w.col === c.col && w.rowGone === c.rowGone && w.cols === c.cols; })));
t('closed-panes entry keeps cell / pos / size when given (and nothing else new)', J(Object.keys(CP.entry({ url: 'https://x.test/' }, DL.where([[[1, 2]]], 2), 'nt')).sort()) === J(['cell', 'col', 'cols', 'pos', 'row', 'rowGone', 'size', 'spec']));

// ---- edge drops and every stack undone (fixed results) ----
t('edge: a new row on top / at the bottom, the full width', drop(G([2, 2]), 4, 0, 'edgeTop') === J([[[4]], [[1], [2]], [[3]]]) && drop(G([2, 2]), 1, 0, 'edgeBottom') === J([[[2]], [[3], [4]], [[1]]]));
t('edge: not with 3 rows (no reaction)', DL.drop(G([1, 1, 1]), 1, 0, 'edgeBottom') === null && DL.drop(G([2, 2, 1]), 5, 0, 'edgeTop') === null);
t('edge: 1 row with stacks -> 2 rows within the limit: the stacks stay', drop([[[1, 2], [3, 4]], [[5]]], 5, 0, 'edgeTop') === J([[[5]], [[1, 2], [3, 4]]]));
t('edge -> 3 rows: the stack undone, its lower pane to the row with fewest panes (a tie: nearer, then the upper one), nearest column (a tie: right)',
  drop([[[1], [2, 3]], [[4], [5]]], 5, 0, 'edgeTop') === J([[[5], [3]], [[1], [2]], [[4]]]));
t('edge -> 3 rows: the fewest panes may be its own row (it stays beside its top pane, on the right)', drop([[[1, 2]], [[3], [4]]], 4, 0, 'edgeTop') === J([[[4]], [[1], [2]], [[3]]]));
t('edge -> 3 rows: two stacks undone left to right, each to the row with fewest panes at that moment',
  drop([[[1, 2], [3, 4]], [[5], [6]]], 6, 0, 'edgeBottom') === J([[[1], [3]], [[2], [5]], [[6], [4]]]));
t('edge -> 2 rows but taller than 3 (a cell of 3): undone the same way', drop([[[1, 2, 3], [4]]], 4, 0, 'edgeTop') === J([[[4], [2]], [[1], [3]]]));
t('the new edge row is a candidate like any other (balance first); its column: the left one, as its cell was left', J(DL.dissolve([[[9]], [[1, 2], [3]], [[4], [5]]])) === J([[[2], [9]], [[1], [3]], [[4], [5]]]));
t('dissolve: a cell of 3 in one row, panes leave from the top (the 2nd to the row below, the 3rd stays in its row: fewest, nearest)', J(DL.dissolve([[[1, 2, 3]], [[4]], [[5]]])) === J([[[1], [3]], [[4], [2]], [[5]]]));
t('dissolve: a tie between the rows right below and right above: the upper one', J(DL.dissolve([[[7]], [[1, 2], [3]], [[4]]])) === J([[[2], [7]], [[1], [3]], [[4]]]));
t('dissolve: its own row as few panes as the others: it stays there (nearest), at the place nearest its cell\'s column (here left of 1)', J(DL.dissolve([[[7], [8]], [[1, 2], [3]], [[4], [5]]])) === J([[[7], [8]], [[2], [1], [3]], [[4], [5]]]));
t('dissolve: deterministic and the same panes', (() => { const g = [[[1, 2], [3, 4], [5]], [[6]], [[7], [8]]], a = DL.dissolve(g), b = DL.dissolve(g); return J(a) === J(b) && J(a.flat(2).sort()) === J(ids(8)) && a.every(r => r.every(c => c.length === 1)); })());
t('fit: within the limits unchanged, else undone', J(DL.fit([[[1, 2]], [[3]]])) === J([[[1, 2]], [[3]]]) && J(DL.fit([[[1, 2]], [[3]], [[4]]])) === J([[[1], [2]], [[3]], [[4]]]));

// ---- a new pane / a reopened pane ----
t('add: a cell at the end of the first row with fewer cells than the preset\'s columns', J(DL.add([[[1, 2]], [[3]]], 5, 2, 2)) === J([[[1, 2], [5]], [[3]]]));
t('add: no room -> null (main goes back to the default grid)', DL.add(G([2, 2]), 5, 2, 2) === null);
t('add: a new row that makes 3 rows undoes the stacks', J(DL.add([[[1, 2], [3]], [[4], [6]]], 7, 2, 3)) === J([[[1], [3]], [[4], [6]], [[2], [7]]]));
{ const g0 = [[[1], [2, 3]], [[4]]], e = CP.entry({ url: 'https://x.test/3' }, DL.where(g0, 3), 'nt'), g1 = DL.without(g0, 3);
  t('reopen: back into its stack (same cell, one pane fewer)', J(DL.reopen(g1, 3, e)) === J(g0));
  t('reopen: its cell changed meanwhile -> a cell of its own by placeReopened (here the last row with room)', J(DL.reopen([[[1], [2, 5]], [[4]]], 3, e)) === J([[[1], [2, 5]], [[4], [3]]]));
  t('reopen: stacking it back would break a limit (tall 4) -> a cell of its own (its row is full: the last row with room)', J(DL.reopen([[[1], [2]], [[4, 6]]], 3, e)) === J([[[1], [2]], [[4, 6], [3]]])); }
t('reopen: an ordinary pane as before (its row / column)', J(DL.reopen(G([3, 1]), 9, { row: 1, col: 1, rowGone: false, cols: 3, cell: 1, pos: 0, size: 1 })) === J([[[1], [2], [3]], [[4], [9]]]));
t('reopen: its row had gone -> the row comes back; 3 rows undo the stacks', J(DL.reopen([[[1, 2]], [[4]]], 3, { row: 1, col: 0, rowGone: true, cols: 1, cell: 0, pos: 0, size: 1 })) === J([[[1], [2]], [[3]], [[4]]]));
t('reopen: an older entry (no cell) / junk is safe', J(DL.reopen(G([2]), 5, { row: 0, col: 1, rowGone: false, cols: 2 })) === J([[[1], [2]], [[5]]]) && DL.reopen(G([1]), 5, null).flat(2).includes(5));

// ---- saved form (state-schema.js): optional `stacks` next to `rows`, no new schema ----
{ const win = (n, extra = {}) => ({ layout: '2x2', focused: 0, panes: ids(n).map(i => ({ url: `https://x.test/${i}` })), window: { bounds: null, maximized: false }, ...extra });
  const doc = o => ({ schema: 1, favorites: [], settings: {}, workspaces: {}, ...o });
  const good = S.migrate(doc({ windows: [win(6, { rows: [3, 3], stacks: [[1, 2], [1, 1, 1]] })], workspaces: { w: { layout: '2x2', panes: [{ url: 'a' }, { url: 'b' }, { url: 'c' }], rows: [3], stacks: [[3]] } } }));
  t('schema: stacks that fit are kept (window and workspace), no repair, still schema 1', good.ok && !good.fixes.length && J(good.doc.windows[0].stacks) === J([[1, 2], [1, 1, 1]]) && J(good.doc.workspaces.w.stacks) === J([[3]]) && S.SCHEMA_VERSION === 1);
  const rt = S.parse(S.serialize(good.doc));
  t('schema: round trip (serialize -> parse) keeps rows and stacks', rt.ok && !rt.fixes.length && J(rt.doc.windows[0].rows) === J([3, 3]) && J(rt.doc.windows[0].stacks) === J([[1, 2], [1, 1, 1]]) && J(rt.doc.workspaces.w.stacks) === J([[3]]));
  t('schema: an older file (rows only) reads as before', (r => r.ok && !r.fixes.length && r.doc.windows[0].stacks === undefined && J(G(r.doc.windows[0].rows, r.doc.windows[0].stacks)) === J(G([3, 3])))(S.migrate(doc({ windows: [win(6, { rows: [3, 3] })] }))));
  for (const [name, st] of [['not the rows', [[1, 2], [1, 1]]], ['a cell of 4', [[4, 1], [1]]], ['3 rows with a stack', [[1, 1], [2], [1]]], ['taller than 3', [[2], [2]]], ['not a list', 'x'], ['zero', [[0, 3], [3]]]]) {
    const rows = name === '3 rows with a stack' ? [2, 2, 1] : name === 'taller than 3' ? [2, 2] : name === 'a cell of 4' ? [5, 1] : [3, 3];
    const r = S.migrate(doc({ windows: [win(rows.reduce((a, b) => a + b, 0), { rows, stacks: st })], workspaces: { w: { layout: '2x2', panes: ids(rows.reduce((a, b) => a + b, 0)).map(() => ({ url: '' })), rows, stacks: st } } }));
    t(`schema: stacks ${name} -> dropped (the rows alone are read), a repair noted for window and workspace`, r.ok && r.doc.windows[0].stacks === undefined && r.doc.workspaces.w.stacks === undefined && J(r.doc.windows[0].rows) === J(rows)
      && r.fixes.filter(f => /\.stacks: does not match the rows, dropped/.test(f)).length === 2 && r.fixes.every(f => !/x\.test/.test(f)));
  }
  const r2 = S.migrate(doc({ windows: [win(4, { rows: [3, 3], stacks: [[1, 2], [1, 1, 1]] })] }));
  t('schema: rows that do not match the panes are dropped, and their stacks with them', r2.ok && r2.doc.windows[0].rows === undefined && r2.doc.windows[0].stacks === undefined);
  t('schema: validate() refuses stacks that do not fit (as rows that do not match)', S.validate({ ...good.doc, windows: [win(6, { rows: [3, 3], stacks: [[3], [3]] })] }).some(e => /stacks/.test(e))
    && S.validate({ ...good.doc, windows: [win(6, { stacks: [[1, 2], [1, 1, 1]] })] }).some(e => /stacks/.test(e)) && !S.validate(good.doc).length);
  t('schema: an older app ignores stacks and still finds rows that add up (stacked panes side by side)', (w => w.rows.reduce((a, b) => a + b, 0) === w.panes.length)(JSON.parse(S.serialize(good.doc)).windows[0])
    && (({ stacks, ...w }) => S.migrate(doc({ windows: [w] })).ok)(good.doc.windows[0])); }

// ---- main's wiring (contract with src/main.js / renderer.js / preload.js) ----
{ const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8'), ren = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const fn = name => { const i = main.indexOf(`function ${name}(`); return i < 0 ? '' : main.slice(i, main.indexOf('\n}\n', i)); };
  t('main: every view hidden only while the drag hides them (relayout / showViews), back by showViews at its end',
    /!viewHeld\(p\) && !dockHide\(\)\);/.test(fn('relayout')) && /!viewHeld\(p\) && !dockHide\(\)\)\);/.test(fn('showViews')) && /if \(d\.hide\) showViews\(\);/.test(fn('dockEnd'))
    && (main.match(/\.setVisible\(true\)/g) || []).every(() => true) && !/view\.setVisible\(false\)/.test(fn('dockBegin') + fn('dockReady') + fn('dockEnd')));
  t('main: the drag ends on Esc, the window losing focus, an overlay, its page gone, the window closing, a time limit; one at a time',
    /if \(dock\) \{ dockEnd\('ESC'\); return true; \}/.test(fn('handleKey')) && /win\.on\('blur', \(\) => dockEnd\('BLUR'\)\)/.test(main) && /dockEnd\('OVERLAY'\)/.test(fn('openOverlay'))
    && /win\.webContents\.on\('render-process-gone', \(\) => dockEnd\('GONE'\)\)/.test(main) && /win\.on\('close', \(\) => \{\n  dockEnd\('WINDOW'\);/.test(main)
    && /setTimeout\(\(\) => dockEnd\('TIME'\), DL\.DRAG_MS\)/.test(fn('dockBegin')) && /^  dockEnd\('NEW'\);/m.test(fn('dockBegin')));
  t('main: stills first, the views hidden once the window shows them (or DL.READY_MS); nothing hidden when the drag ended meanwhile',
    /capturePage\(\)/.test(fn('dockBegin')) && /if \(dock !== d\) return;/.test(fn('dockBegin')) && /DL\.READY_MS/.test(fn('dockBegin')) && /d\.hide = true; showViews\(\);/.test(fn('dockReady')));
  t('main: no drag while maximized / an overlay is open / one pane', /panes\.length < 2 \|\| maximizedId != null \|\| overlayOpen\) return;/.test(fn('dockBegin')));
  t('main: zone and drop from the rows as they are now; the views back before the panes move; refused grids change nothing',
    /cs = cells\(\), z = DL\.zoneAt\(g, panes\.map\(p => p\.id\), cs, area, d\.id, \{ x, y \}\)/.test(fn('dockZone')) && fn('dockDrop').indexOf("dockEnd('DROP')") < fn('dockDrop').indexOf('applyGrid(') && /if \(!z \|\| !applyGrid\(z\.grid\)\) return;/.test(fn('dockDrop'))
    && /new Set\(next\)\.size !== next\.length/.test(fn('applyGrid')));
  t('main: the preview is the zone on the target pane as it is now (the same cells as the zone) / the edge band, not the dragged pane after the drop',
    /DL\.previewRect\(cs\[panes\.findIndex\(p => p\.id === z\.to\)\], z\.side, area\)/.test(fn('dockZone')) && !/geom\(/.test(fn('dockZone')) && /hover: z \? z\.rect : null/.test(fn('dockHover')));
  t('main: saved with the rows (window / workspace), read back validated, a preset clears them',
    /\.\.\.rowsSave\(\)/.test(fn('snapshot')) && /\.\.\.rowsSave\(\)/.test(fn('saveWorkspace')) && /stackLens = DL\.read\(ws\.stacks\);/.test(fn('loadWorkspace')) && /stackLens = DL\.read\(spec\.stacks\);/.test(main)
    && /rowLens = null; stackLens = null;/.test(fn('applyPreset')) && /DL\.stacksOk\(stackLens, l\)/.test(fn('getStacks')));
  t('main: close / new pane / reopen go through the grid; geometry by cells with stacked panes sharing the row height', /DL\.add\(paneGrid\(\), p\.id, pr\[0\], pr\[1\]\)/.test(fn('insertPane')) && /geom\(getStacks\(\), area\)/.test(fn('cells'))
    && /rh \* j \/ k/.test(fn('geom')) && /splitKey = \(\) => \{ const l = getStacks\(\);/.test(main));
  t('renderer: a header drag docks (never swaps); a tab still swaps; the cursor only goes to main', /dockStart\(id\);/.test(ren) && /d\.ondrop = e => \{ if \(drag\) return;/.test(ren) && /mpb\.swap\(from, p\.id\)/.test(ren)
    && /mpb\.dockHover\(x, y\)/.test(ren) && /mpb\.dockDrop\(Math\.round\(e\.clientX\), Math\.round\(e\.clientY\)\)/.test(ren) && /mpb\.dockReady\(m\.seq\)/.test(ren)); }

console.log(bad ? `\n${bad} failed` : '\nall passed');
process.exit(bad ? 1 : 0);
