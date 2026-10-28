(() => {
  const SHOW_DELAY = 300, SWITCH_DELAY = 40, SWITCH_WINDOW = 350;
  const measure = TooltipCard.create(); measure.id = 'tip-measure'; document.body.appendChild(measure);
  let target = null, timer = null, shown = false, lastShown = 0;
  const find = el => el && el.closest ? el.closest('[data-tip]') : null;
  function visible(el, fading = false) { // fading: hover-revealed controls (pane header tools) are still at opacity 0 on mouseover
    if (!el || !el.isConnected || !el.dataset.tip) return false;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const css = getComputedStyle(n);
      if (n.hidden || css.display === 'none' || css.visibility === 'hidden' || (!fading && Number(css.opacity) === 0)) return false;
    }
    return true;
  }
  function hide() {
    clearTimeout(timer); timer = null; target = null;
    if (shown) { shown = false; lastShown = Date.now(); }
    mpb.tipHide();
  }
  function render() {
    if (!visible(target)) { hide(); return; }
    const d = target.dataset, r = target.getBoundingClientRect();
    const tip = { name: d.tip.slice(0, 500), description: (d.tipDesc || '').slice(0, 500), key: (d.tipKey || '').slice(0, 40),
      detail: (d.tipDetail || '').slice(0, 2048), dark: !document.body.classList.contains('light') };
    const list = TooltipList.parse(d.tipList); if (list) tip.list = list;
    TooltipCard.render(measure, tip);
    const size = measure.getBoundingClientRect();
    mpb.tipShow({ tip, rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      size: { width: size.width, height: size.height }, preferSide: !!target.closest('.usage') });
    shown = true;
  }
  function start(el) {
    if (!visible(el, true) || el === target) return;
    const fast = shown || Date.now() - lastShown < SWITCH_WINDOW;
    clearTimeout(timer); target = el;
    mpb.tipPrepare(); // Load the hidden window during the 300 ms dwell, not afterwards.
    timer = setTimeout(() => { timer = null; render(); }, fast ? SWITCH_DELAY : SHOW_DELAY);
  }
  document.addEventListener('mouseover', e => { const el = find(e.target); if (el) start(el); });
  document.addEventListener('mouseout', e => {
    if (!target || !target.contains(e.target)) return;
    const next = find(e.relatedTarget);
    if (next && next !== target) start(next);
    else if (!next && !target.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('focusin', e => { const el = find(e.target); if (el && e.target.matches(':focus-visible')) start(el); });
  document.addEventListener('focusout', e => { if (target && target.contains(e.target)) hide(); });
  for (const event of ['mousedown', 'click', 'scroll', 'wheel', 'dragstart']) document.addEventListener(event, hide, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); }, true);
  mpb.onTipDismiss(hide); // Escape can reach a pane WebContentsView instead of this document.
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  // Re-read live state while visible, and discard targets removed or hidden by a render.
  new MutationObserver(records => { if (records.every(r => measure.contains(r.target))) return;
    if (target) { if (!visible(target)) hide(); else if (shown) render(); } })
    .observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
})();
