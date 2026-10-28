// Shared limits for chrome, the tooltip window and the main-process IPC gate.
(function (root) {
  const MAX_ROWS = 8, MAX_IMAGE = 16384, MAX_NAME = 120, MAX_KIND = 40;
  const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
  function image(value) {
    if (typeof value !== 'string' || value.length > MAX_IMAGE) return '';
    if (DATA_IMAGE.test(value)) return value;
    if (value.length > 2048 || /[\s\u0000-\u001f\u007f-\u009f]/.test(value)) return '';
    try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? value : ''; } catch { return ''; }
  }
  function validList(list) {
    return !!list && typeof list === 'object' && !Array.isArray(list) && Object.keys(list).length === 2 &&
      Array.isArray(list.rows) && list.rows.length <= MAX_ROWS && Number.isSafeInteger(list.more) && list.more >= 0 && list.more <= 10000 &&
      Array.from(list.rows).every(row => row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === 3 &&
        typeof row.name === 'string' && row.name.length <= MAX_NAME && typeof row.kind === 'string' && row.kind.length <= MAX_KIND &&
        typeof row.image === 'string' && (row.image === '' || image(row.image) === row.image));
  }
  function parse(value) {
    if (typeof value !== 'string' || value.length > MAX_ROWS * (MAX_IMAGE + 6 * (MAX_NAME + MAX_KIND) + 200) + 100) return undefined;
    try { const list = JSON.parse(value); return validList(list) ? list : undefined; } catch { return undefined; }
  }
  function fromState(state, bar) {
    const panes = Array.isArray(state.panes) ? state.panes : [], byId = new Map(panes.map(p => [p.id, p]));
    const icons = new Map();
    const paneBotId = p => /^https:\/\/grok\.com\/bot\/([A-Za-z0-9_-]+)(?:[/?#]|$)/.exec(p.url || '')?.[1];
    const wanted = new Set(panes.map(paneBotId).filter(Boolean));
    const bots = [...(bar?.pins || []), ...(bar?.sections || []).flatMap(s => s.items || [])];
    for (const b of bots) {
      if (!wanted.has(b.id) || icons.has(b.id)) continue;
      const icon = image(b.icon); if (icon && !icons.has(b.id)) icons.set(b.id, icon);
    }
    const paneImage = p => {
      return icons.get(paneBotId(p)) || image(p.favicon);
    };
    const row = (p, name, kind) => ({ name: String(name || 'ペイン').slice(0, MAX_NAME), kind: String(kind || '').slice(0, MAX_KIND), image: p ? paneImage(p) : '' });
    const bounded = rows => ({ rows: rows.slice(0, MAX_ROWS), more: Math.max(0, rows.length - MAX_ROWS) });
    const unread = (state.unreadOrder || []).map(id => byId.get(id)).filter(p => p && p.needsReply)   // the chip counts 未返信 only; listed in ⌘J order
      .map(p => row(p, p.name || p.sname || p.title, '要返信'));
    const queue = (state.queue || []).map(it => row(byId.get(it.id), it.name, it.kja));
    return { unread: bounded(unread), queue: bounded(queue) };
  }
  const api = { MAX_ROWS, MAX_IMAGE, MAX_NAME, MAX_KIND, image, validList, parse, fromState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TooltipList = api;
})(typeof window === 'undefined' ? globalThis : window);
