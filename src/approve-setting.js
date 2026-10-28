// Shared by main, the settings overlay and the state / IPC validators.
const ApproveSetting = (() => {
  const URL_MAX = 65536, LABEL_MAX = 20;
  const controls = /[\u0000-\u001f\u007f-\u009f]/;
  const bot = /^https:\/\/grok\.com\/bot\/([A-Za-z0-9_-]+)\/?(?:[?#][^\s\u0000-\u001f\u007f-\u009f]*)?$/;
  function normalizeUrl(value) {
    if (typeof value !== 'string' || value.length > URL_MAX || controls.test(value)) return '';
    const m = value.trim().match(bot);
    return m ? `https://grok.com/bot/${m[1]}` : '';
  }
  function validUrl(value) {
    return typeof value === 'string' && value.length <= URL_MAX && !controls.test(value) && (!value.trim() || !!normalizeUrl(value));
  }
  function grokPage(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'grok.com' && !url.port && !url.username && !url.password; }
    catch { return false; }
  }
  function validLabel(value) {
    return typeof value === 'string' && !controls.test(value) && Array.from(value.trim()).length <= LABEL_MAX;
  }
  const label = (value, fallback) => validLabel(value) ? value.trim() : fallback;
  const paneLabel = value => Array.from(String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()).slice(0, LABEL_MAX).join('').trim();
  function httpsImage(value) {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f\u007f-\u009f]/.test(value)) return '';
    try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? value : ''; } catch { return ''; }
  }
  // Bar order first, then ordinary favorites and panes. The displayed name is
  // kept within the existing approveLabel limit so a pick can be saved as-is.
  function knownBots(bar, favorites, panes) {
    const byId = new Map();
    for (const item of [...bar, ...favorites, ...panes]) {
      if (!item) continue;
      const url = normalizeUrl(item.url); if (!url) continue;
      const id = url.slice('https://grok.com/bot/'.length), icon = httpsImage(item.icon || item.favicon);
      const existing = byId.get(id);
      if (existing) { if (!existing.icon && icon) existing.icon = icon; continue; }
      byId.set(id, { id, url, name: paneLabel(item.name || item.label || item.title || id) || paneLabel(id), icon });
    }
    return [...byId.values()];
  }
  function effective(settings, envUrl, defaultUrl, defaultLabel) {
    const s = settings || {};
    const name = label(s.approveLabel, defaultLabel);
    if (s.approveUrl !== undefined && validUrl(s.approveUrl)) return { url: normalizeUrl(s.approveUrl), source: 'setting', label: name };
    const choices = [[envUrl, 'environment'], [defaultUrl, 'default']];
    for (const [value, source] of choices) {
      const url = normalizeUrl(value);
      if (url) return { url, source, label: name };
    }
    return { url: '', source: 'unset', label: name };
  }
  function inlinePosition(anchor, size, viewport) {
    const margin = 8, gap = 6;
    const clamp = (n, max) => Math.max(margin, Math.min(n, max));
    return { x: clamp(anchor.x + anchor.width - size.width, viewport.width - size.width - margin),
      y: clamp(anchor.y + anchor.height + gap, viewport.height - size.height - margin) };
  }
  return { URL_MAX, LABEL_MAX, normalizeUrl, validUrl, grokPage, validLabel, label, paneLabel, httpsImage, knownBots, effective, inlinePosition };
})();
if (typeof module !== 'undefined') module.exports = ApproveSetting;
