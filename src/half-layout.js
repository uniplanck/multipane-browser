// Pure pane rectangles for a half-maximized layout, in the original pane order.
const HalfLayout = (() => {
  function halfRects(area, gridColEdges, cols, side, bigIndex, n, gap) {
    if (n <= 0) return [];
    // With only one pane, a half gesture uses the full area (the gesture's mode is still tracked by main).
    if (n === 1) return [{ ...area }];

    const count = Math.ceil(cols / 2);
    const validEdges = cols > 1 && Array.isArray(gridColEdges) && gridColEdges.length === cols + 1
      && gridColEdges.every(Number.isFinite);
    // Odd grids give the enlarged side ceil(cols/2) whole columns, using geom's weighted edges;
    // a single column or missing grid instead uses exactly half the area width.
    const right = area.x + area.w;
    const boundary = validEdges ? Math.round(gridColEdges[side === 'left' ? count : cols - count])
      : side === 'left' ? area.x + Math.round(area.w / 2) + gap : right - Math.round(area.w / 2);
    const big = side === 'left'
      ? { x: area.x, y: area.y, w: boundary - gap - area.x, h: area.h }
      : { x: boundary, y: area.y, w: right - boundary, h: area.h };
    const rest = side === 'left'
      ? { x: boundary, y: area.y, w: right - boundary, h: area.h }
      : { x: area.x, y: area.y, w: boundary - gap - area.x, h: area.h };
    const m = n - 1;
    let bestCols = 1, bestScore = Infinity;
    for (let c = 1; c <= m; c++) {
      const rows = Math.ceil(m / c);
      const score = Math.abs(Math.log((rest.w / c) / (rest.h / rows)));
      if (score < bestScore) { bestScore = score; bestCols = c; }
    }
    const rows = Math.ceil(m / bestCols), small = [];
    for (let r = 0; r < rows; r++) {
      const inRow = Math.min(bestCols, m - r * bestCols);
      const y = Math.round(rest.y + (rest.h + gap) * r / rows);
      const y1 = Math.round(rest.y + (rest.h + gap) * (r + 1) / rows - gap);
      for (let c = 0; c < inRow; c++) {
        const x = Math.round(rest.x + (rest.w + gap) * c / inRow);
        const x1 = Math.round(rest.x + (rest.w + gap) * (c + 1) / inRow - gap);
        small.push({ x, y, w: x1 - x, h: y1 - y });
      }
    }
    let j = 0;
    return Array.from({ length: n }, (_, i) => i === bigIndex ? big : small[j++]);
  }
  return { halfRects };
})();
if (typeof module === 'object' && module.exports) module.exports = HalfLayout;
