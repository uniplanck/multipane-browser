// Coordinates are relative to the chrome document's content area, in DIP.
function placeTooltip(rect, size, viewport, preferSide = false, avoid = null) {
  const margin = 4, gap = 6;
  let width = Math.max(1, Math.min(Math.ceil(size.width), viewport.width - 2 * margin));
  let height = Math.max(1, Math.min(Math.ceil(size.height), viewport.height - 2 * margin));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const centeredX = rect.x + (rect.width - width) / 2;
  const centeredY = rect.y + (rect.height - height) / 2;
  const sides = [
    { ok: rect.y + rect.height + gap + height <= viewport.height - margin, x: centeredX, y: rect.y + rect.height + gap },
    { ok: rect.y - gap - height >= margin, x: centeredX, y: rect.y - gap - height },
    { ok: rect.x + rect.width + gap + width <= viewport.width - margin, x: rect.x + rect.width + gap, y: centeredY },
    { ok: rect.x - gap - width >= margin, x: rect.x - gap - width, y: centeredY },
  ];
  const choices = preferSide ? [...sides.slice(2), ...sides.slice(0, 2)] : sides;
  const bounds = p => ({ x: Math.round(clamp(p.x, margin, viewport.width - margin - width)),
    y: Math.round(clamp(p.y, margin, viewport.height - margin - height)), width, height });
  const separate = r => !avoid || r.x + r.width <= avoid.x || r.x >= avoid.x + avoid.width || r.y + r.height <= avoid.y || r.y >= avoid.y + avoid.height;
  const p = choices.filter(c => c.ok).map(bounds).find(separate);
  if (p) return p;
  if (avoid) {
    // A usage popover may occupy the space under its button. Fit beside it,
    // shrinking the card if necessary so the existing popover stays readable.
    const left = Math.max(0, avoid.x - gap - margin), right = Math.max(0, viewport.width - margin - avoid.x - avoid.width - gap);
    const onLeft = left >= right, available = onLeft ? left : right;
    if (available >= 1) {
      const narrowed = available < width;
      width = Math.min(width, Math.floor(available));
      if (narrowed) height = Math.min(viewport.height - 2 * margin, height + 20);
      return bounds({ x: onLeft ? avoid.x - gap - width : avoid.x + avoid.width + gap, y: rect.y + (rect.height - height) / 2 });
    }
  }
  return bounds(sides[0]);
}
module.exports = { placeTooltip };
