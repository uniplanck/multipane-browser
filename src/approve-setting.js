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
  function grokPage(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'grok.com' && !url.port && !url.username && !url.password; }
    catch { return false; }
  }
  function validLabel(value) {
    return typeof value === 'string' && !controls.test(value) && Array.from(value.trim()).length <= LABEL_MAX;
  }
  const label = (value, fallback) => validLabel(value) && value.trim() ? value.trim() : fallback;
  const paneLabel = value => Array.from(String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()).slice(0, LABEL_MAX).join('').trim();
  function effective(settings, envUrl, defaultUrl, defaultLabel) {
    const s = settings || {};
    const choices = [[s.approveUrl, 'setting'], [envUrl, 'environment'], [defaultUrl, 'default']];
    for (const [value, source] of choices) {
      const url = normalizeUrl(value);
      if (url) return { url, source, label: label(s.approveLabel, defaultLabel) };
    }
    return { url: '', source: 'unset', label: label(s.approveLabel, defaultLabel) };
  }
  return { URL_MAX, LABEL_MAX, normalizeUrl, grokPage, validLabel, label, paneLabel, effective };
})();
if (typeof module !== 'undefined') module.exports = ApproveSetting;
