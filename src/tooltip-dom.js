// Reconcile the small, delegated chrome fragments so a hovered status/count
// keeps its DOM identity when state changes. Removed items really are removed.
(function (root) {
  function key(node) {
    if (node.nodeType !== 1) return null;
    const get = name => node.getAttribute(name);
    if (get('data-w') && get('data-p')) return `pane:${get('data-w')}:${get('data-p')}`;
    if (get('data-tip-window')) return `window:${get('data-tip-window')}`;
    const cls = (get('class') || '').trim().split(/\s+/)[0];
    return cls ? `class:${cls}` : get('data-tip') ? `tip:${get('data-tip')}` : null;
  }
  function sync(parent, desired) {
    const used = new Set();
    for (const [i, next] of Array.from(desired.childNodes).entries()) {
      const k = key(next), children = Array.from(parent.childNodes);
      let node = k === null ? children[i] : children.find(x => !used.has(x) && x.nodeType === next.nodeType && key(x) === k);
      if (node && (used.has(node) || node.nodeType !== next.nodeType || (next.nodeType === 1 && node.tagName !== next.tagName) || (k === null && key(node) !== null))) node = null;
      if (!node) node = next.cloneNode(true);
      if (parent.childNodes[i] !== node) parent.insertBefore(node, parent.childNodes[i] || null);
      used.add(node);
      if (next.nodeType === 1) {
        for (const name of node.getAttributeNames()) if (!next.hasAttribute(name)) node.removeAttribute(name);
        for (const name of next.getAttributeNames()) if (node.getAttribute(name) !== next.getAttribute(name)) node.setAttribute(name, next.getAttribute(name));
        sync(node, next);
      } else if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
    }
    for (const node of Array.from(parent.childNodes)) if (!used.has(node)) parent.removeChild(node);
  }
  function reconcileMarkup(parent, html) {
    const template = document.createElement('template'); template.innerHTML = html;
    sync(parent, template.content);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { sync };
  else root.reconcileTooltipMarkup = reconcileMarkup;
})(typeof window === 'undefined' ? globalThis : window);
