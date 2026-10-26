// Grok bar presence: bots and groups both open at /bot/<id> (grok-bots.js).
// Pure; shared by the renderer's plain script and the Node tests. Pane URLs come
// from main's state (paneUrl also keeps the intended URL of sleeping/queued panes).
const GbarPresence = (() => {
  function botId(url) {
    if (typeof url !== 'string') return '';
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.hostname !== 'grok.com' || u.port || u.username || u.password) return '';
      const m = u.pathname.match(/^\/bot\/([A-Za-z0-9_-]{1,64})(?:\/|$)/);
      return m && m[1] !== '__proto__' ? m[1] : '';
    } catch { return ''; }
  }
  function match(panes = [], focusedPaneId) {
    const openIds = new Set();
    let focusedId = '';
    for (const p of panes) {
      const id = botId(p && p.url);
      if (!id) continue;
      openIds.add(id);
      if (focusedPaneId != null && p.id === focusedPaneId) focusedId = id;
    }
    return { openIds, focusedId };
  }
  return { botId, match };
})();
if (typeof module === 'object' && module.exports) module.exports = GbarPresence;
