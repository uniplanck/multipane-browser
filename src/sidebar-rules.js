// 進捗サイドバー: pure rules (no electron), shared by main, the settings overlay (a plain <script>) and the state / IPC validators; plain Node
// tests: test/sidebar-*.test.js. The sidebar is one optional web page (settings.sidebarUrl) docked left of the panes in every window
// (settings.sidebarOpen / sidebarWidth: one shared setting). It is not a pane: nothing here knows panes beyond the names main hands over.
//   layout(): the window's pane area split into the sidebar, the drag strip over the gap and the narrowed pane area (closed: the area as it is)
//   normalizeUrl() / validUrl() / navOk(): https only (plain http on this Mac's loopback for a local dev server), no user name / password
//   findBot(): a name from the sidebar page -> the pane it means (NFKC, case, spaces / underscores folded; the user's own name first)
const SidebarRules = (() => {
  const DEFAULT_WIDTH = 300, MIN_WIDTH = 220, MAX_WIDTH = 560;
  const PANES_MIN = 240;                     // the panes keep at least this much width: a narrow window gets a narrower sidebar...
  const HIDE_BELOW = 120;                    // ...or none, when even that would leave the sidebar narrower than this
  const URL_MAX = 2048, NAME_MAX = 80;       // the setting / a name from the page (= the IPC payload limit)
  const KEEP_MS = 5 * 60 * 1000;             // closed: the view stays (hidden) this long, then it is destroyed
  const PARTITION = 'persist:xg-sidebar';    // its own session: no login / storage shared with the panes
  const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
  const controls = /[\u0000-\u001f\u007f-\u009f]/;

  const clampWidth = v => typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(v))) : DEFAULT_WIDTH;
  // the width the sidebar really gets in a pane area of areaW (the stored width is the user's; a narrow window only narrows it for now)
  function fit(width, areaW, gap) {
    if (!(typeof width === 'number' && width > 0) || !Number.isFinite(areaW)) return 0;
    const w = Math.min(Math.round(width), Math.floor(areaW - gap - PANES_MIN));
    return w >= HIDE_BELOW ? w : 0;
  }
  // base = the pane area as the window has it ({ x, y, w, h }); width = 0 when closed -> { side: view bounds | null, handle: the drag strip over
  // the gap | null, panes: the area every layout (grid / splits / maximize / half / dock) uses }
  function layout(base, width, gap) {
    const w = fit(width, base.w, gap);
    if (!w) return { side: null, handle: null, panes: { x: base.x, y: base.y, w: base.w, h: base.h } };
    return { side: { x: base.x, y: base.y, width: w, height: Math.max(0, base.h) }, handle: { x: base.x + w, y: base.y, w: gap, h: Math.max(0, base.h) },
      panes: { x: base.x + w + gap, y: base.y, w: base.w - w - gap, h: base.h } };
  }
  // a drag of the strip: the pointer's x in the window -> the new width (the limits, and never past the panes' minimum)
  function dragWidth(x, base, gap) {
    const want = Math.round(x - base.x - gap / 2), room = Math.floor(base.w - gap - PANES_MIN);
    return Math.max(Math.min(MIN_WIDTH, room), Math.min(MAX_WIDTH, room, Math.max(MIN_WIDTH, want)));
  }

  function parse(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s || s.length > URL_MAX || controls.test(s) || /\s/.test(s)) return null;
    let u; try { u = new URL(s); } catch { return null; }
    if (u.username || u.password || !u.hostname) return null;
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.includes(u.hostname)) ? u : null;
  }
  const normalizeUrl = value => { const u = parse(value); return u ? u.href : ''; };
  const validUrl = value => typeof value === 'string' && value.length <= URL_MAX && (!value.trim() || !!normalizeUrl(value));   // '' = no sidebar
  const originOf = value => { const u = parse(value); return u ? u.origin : ''; };
  // the sidebar may move inside its URL's origin only (routes / hash as usual); anything else is not loaded there
  const navOk = (url, base) => { const o = originOf(base); return !!o && originOf(url) === o; };
  const httpUrl = value => { try { const u = new URL(String(value)); return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password; } catch { return false; } };

  // settings -> what the windows show (no URL: never open, the button guides to the setting)
  const view = s => { const o = s || {}, url = normalizeUrl(o.sidebarUrl); return { url, configured: !!url, open: o.sidebarOpen === true && !!url, width: clampWidth(o.sidebarWidth) }; };

  // names: NFKC (full-width -> half-width), trimmed, case-folded, runs of spaces / underscores = one space ("Grok_Bot" = "grok bot")
  const normName = s => typeof s === 'string' ? s.normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/[\s_]+/g, ' ').trim().toLowerCase() : '';
  const nameOk = v => typeof v === 'string' && v.length <= NAME_MAX && !controls.test(v) && !!normName(v);
  // panes: [{ key, tiers: [[the user's name], [Bot names the app read], [the title the strip shows]] }] in order (the sender's window first) ->
  // the key of the first pane matching in the earliest tier (a name the user gave beats a page title anywhere), or null
  function findBot(name, panes) {
    if (!nameOk(name) || !Array.isArray(panes)) return null;
    const want = normName(name), depth = Math.max(0, ...panes.map(p => Array.isArray(p && p.tiers) ? p.tiers.length : 0));
    for (let t = 0; t < depth; t++) for (const p of panes) {
      const names = p && Array.isArray(p.tiers) && Array.isArray(p.tiers[t]) ? p.tiers[t] : [];
      if (names.some(n => normName(n) === want)) return p.key;
    }
    return null;
  }
  return { DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH, PANES_MIN, HIDE_BELOW, URL_MAX, NAME_MAX, KEEP_MS, PARTITION,
    clampWidth, fit, layout, dragWidth, normalizeUrl, validUrl, originOf, navOk, httpUrl, view, normName, nameOk, findBot };
})();
if (typeof module !== 'undefined') module.exports = SidebarRules;
