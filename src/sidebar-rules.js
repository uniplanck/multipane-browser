// 進捗サイドバー: pure rules (no electron), shared by main, the settings overlay (a plain <script>) and the state / IPC validators; plain Node
// tests: test/sidebar-*.test.js. The sidebar is one optional web page (settings.sidebarUrl) docked left of the panes in every window
// (settings.sidebarOpen / sidebarWidth: one shared setting). It is not a pane: nothing here knows panes beyond the names / URLs main hands over.
//   layout(): the window's pane area split into the sidebar, the drag strip over the gap and the narrowed pane area (closed: the area as it is)
//   normalizeUrl() / validUrl() / navOk(): https only (plain http on this Mac's loopback for a local dev server), no user name / password
//   findBot(): a name from the sidebar page -> the pane it means (NFKC, case, spaces / underscores folded; the user's own name first)
//   jump() / jumpOk(): window.xgBotsSidebar.jump({ name, agentId, open }) -> the pane (its grok.com/bot/<agentId> URL, then findBot) or the URL
//     of a new one (built from the UUID only), or why not; state() / paneNames(): what the page is told of the panes (agentId, a few names, active)
//   focusComposer / FOCUS_JS: the page side of a jump - the keyboard into a grok.com composer (main runs it in the pane's own world, WORLD)
const SidebarRules = (() => {
  const DEFAULT_WIDTH = 300, MIN_WIDTH = 220, MAX_WIDTH = 560;
  const PANES_MIN = 240;                     // the panes keep at least this much width: a narrow window gets a narrower sidebar...
  const HIDE_BELOW = 120;                    // ...or none, when even that would leave the sidebar narrower than this
  const URL_MAX = 2048, NAME_MAX = 80;       // the setting / a name from the page (= the IPC payload limit)
  const KEEP_MS = 5 * 60 * 1000;             // closed: the view stays (hidden) this long, then it is destroyed
  const PARTITION = 'persist:xg-sidebar';    // its own session: no login / storage shared with the panes
  const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
  const controls = /[\u0000-\u001f\u007f-\u009f]/;
  const AGENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;   // a Grok Bot's agentId: a lowercase UUID (= sidebar-preload.js)
  const BOT_RE = /^https:\/\/grok\.com\/bot\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/?(?:[?#].*)?$/;   // a pane on that Bot
  const RESULTS = ['focused', 'opened', 'none', 'blocked', 'nomatch'];   // jump()'s answers to the page (= sidebar-preload.js)
  const NAMES_PER_TIER = 3;                  // state(): names of a pane per tier (the user's / read / title), each cut to NAME_MAX
  const STATE_PANES = 100;                   // state(): panes at most (10 a window)
  const WORLD = 1008;                        // main.js: the isolated world of FOCUS_JS (1001-1007 are taken)
  const FOCUS_WAIT_MS = 5000;                // FOCUS_JS: how long the page waits for its composer to appear
  const JUMP_WAIT_MS = 20000;                // main: a jump's keyboard move waits this long at most for the pane's page (asleep / loading / new)

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

  // ---- jump (window.xgBotsSidebar.jump) / state (onState / getState) ----
  const agentOk = v => typeof v === 'string' && AGENT_RE.test(v);
  const agentOf = url => { const m = typeof url === 'string' ? url.match(BOT_RE) : null; return m ? m[1].toLowerCase() : ''; };   // '' = not a Bot's page
  const botUrl = id => agentOk(id) ? 'https://grok.com/bot/' + id : '';   // the only URL a jump opens: built here, never taken from the page
  const confirmOpen = s => !(s && s.sidebarConfirmOpen === false);      // settings.sidebarConfirmOpen: the page asks before opening (default on)
  // the IPC payload: { name, agentId?, open? } and nothing else (the preload sends only these; main checks again)
  const jumpOk = v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => k === 'name' || k === 'agentId' || k === 'open')
    && nameOk(v.name) && (v.agentId === undefined || agentOk(v.agentId)) && (v.open === undefined || typeof v.open === 'boolean');
  // req = the payload; panes: [{ key, url, tiers }] in order (the sender's window first) -> { result: 'focused', key } (the first pane on
  // grok.com/bot/<agentId>, else findBot's) | { result: 'opened', url } (none, open: true and an agentId: a new pane of that URL) |
  // { result: 'nomatch' } (none, an agentId: the page may ask the user, then send open: true) | { result: 'none' } (none, no agentId)
  function jump(req, panes) {
    const o = req && typeof req === 'object' ? req : {}, id = agentOk(o.agentId) ? o.agentId : '', list = Array.isArray(panes) ? panes : [];
    const byId = id ? list.find(p => p && agentOf(p.url) === id) : null;
    const key = byId ? byId.key : findBot(o.name, list);
    if (key !== null && key !== undefined) return { result: 'focused', key };
    if (!id) return { result: 'none' };
    return o.open === true ? { result: 'opened', url: botUrl(id) } : { result: 'nomatch' };
  }
  // a pane's names for the page: findBot's tiers in order, NAMES_PER_TIER of each (one line, cut to NAME_MAX = what nameOk takes back, never
  // halfway into a surrogate pair), the same name once. Never a part of its URL: a name that is a URL ('://') or the URL's host (the strip shows
  // the host when a page has no title) is left out
  const hostOf = url => { try { const u = new URL(String(url)); return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : ''; } catch { return ''; } };
  function clip(s) {
    if (typeof s !== 'string') return '';
    let out = '';
    for (const ch of s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()) { if (out.length + ch.length > NAME_MAX) break; out += ch; }
    return out.trim();
  }
  function paneNames(tiers, url) {
    const out = [], seen = new Set(), host = hostOf(url), hosts = host ? [host, host.replace(/^www\./, '')] : [];
    for (const tier of Array.isArray(tiers) ? tiers : []) {
      let n = 0;
      for (const raw of Array.isArray(tier) ? tier : []) {
        const s = clip(raw), k = normName(s);
        if (!k || seen.has(k) || n >= NAMES_PER_TIER || s.includes('://') || hosts.includes(s.toLowerCase())) continue;
        seen.add(k); out.push(s); n++;
      }
    }
    return out;
  }
  // rows: [{ url, tiers, active }] (the sidebar's window first) -> what the page gets: per pane only the agentId (a grok.com/bot/<uuid> URL;
  // nothing else of any URL), its names and whether it is the active pane of the sidebar's window; and the confirm setting
  const state = (rows, confirm) => ({ panes: (Array.isArray(rows) ? rows : []).slice(0, STATE_PANES).map(r => ({ agentId: agentOf(r && r.url) || null,
    names: paneNames(r && r.tiers, r && r.url), active: !!r && r.active === true })), confirmOpen: confirm !== false });
  // the page side (fixed code, run by main in the pane's page in its own world WORLD: the page's scripts cannot change what it uses), so it uses
  // the page's globals only. The composer = the last visible textarea / contenteditable (as the broadcast / draft restore pick it), focused with
  // the caret at its end (already focused: left as it is); waits up to ms for it to appear. Never types, reads nothing else -> 'focused' | 'none'
  function focusComposer(ms) {
    const pick = () => [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')]
      .filter(e => e.offsetParent !== null && !e.closest('[aria-hidden="true"]') && !(e.tagName === 'TEXTAREA' && (e.tabIndex < 0 || e.disabled || e.readOnly))).pop() || null;
    const go = el => {
      if (document.activeElement !== el) {
        el.focus();
        try {
          if (el.tagName === 'TEXTAREA') { const n = el.value.length; el.setSelectionRange(n, n); }
          else { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
        } catch {}
      }
      return document.activeElement === el ? 'focused' : 'none';
    };
    const now = pick(); if (now) return go(now);
    return new Promise(res => { const t0 = Date.now(); const tick = () => { const el = pick(); if (el) res(go(el)); else if (Date.now() - t0 >= ms) res('none'); else setTimeout(tick, 100); }; setTimeout(tick, 100); });
  }
  const FOCUS_JS = `(${focusComposer})(${FOCUS_WAIT_MS})`;
  const composerPage = url => typeof url === 'string' && /^https:\/\/grok\.com\//.test(url);   // FOCUS_JS runs on grok.com pages only

  return { DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH, PANES_MIN, HIDE_BELOW, URL_MAX, NAME_MAX, KEEP_MS, PARTITION, RESULTS, NAMES_PER_TIER, STATE_PANES, WORLD, FOCUS_WAIT_MS, JUMP_WAIT_MS,
    clampWidth, fit, layout, dragWidth, normalizeUrl, validUrl, originOf, navOk, httpUrl, view, normName, nameOk, findBot,
    agentOk, agentOf, botUrl, confirmOpen, jumpOk, jump, paneNames, state, focusComposer, FOCUS_JS, composerPage };
})();
if (typeof module !== 'undefined') module.exports = SidebarRules;
