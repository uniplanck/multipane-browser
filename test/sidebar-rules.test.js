// node test/sidebar-rules.test.js — 進捗サイドバー (src/sidebar-rules.js): the pane area with / without the sidebar, the width limits and the
// drag, the URL rules (https / loopback http, no user name, its origin only), the settings defaults and the Bot-name matching; the jump
// (agentId -> pane / new pane URL), the state the page is told (agentId / names / active only) and the composer focus script (on a fake DOM).
const SR = require('../src/sidebar-rules');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const GAP = 6, base = { x: 6, y: 82, w: 1388, h: 807 };   // = main.js areaFull() of a 1400 x 900 window

// ---- layout ----
{ const l = SR.layout(base, 0, GAP);
  t('closed: the panes get the whole area, exactly as before; no view, no edge', J(l.panes) === J(base) && l.side === null && l.handle === null); }
{ const l = SR.layout(base, 300, GAP);
  t('open: the view at the left of the area, full height', J(l.side) === J({ x: 6, y: 82, width: 300, height: 807 }));
  t('open: the edge is the gap right of it', J(l.handle) === J({ x: 306, y: 82, w: GAP, h: 807 }));
  t('open: the panes narrowed by width + gap, same top / height', J(l.panes) === J({ x: 312, y: 82, w: 1082, h: 807 }));
  t('open: nothing overlaps and the right edge is unchanged', l.side.x + l.side.width <= l.handle.x && l.handle.x + l.handle.w <= l.panes.x && l.panes.x + l.panes.w === base.x + base.w); }
t('layout does not change its input', (() => { const b = { ...base }; SR.layout(b, 300, GAP); return J(b) === J(base); })());
{ const narrow = { x: 6, y: 82, w: 588, h: 300 };          // the window's minimum width (600)
  const l = SR.layout(narrow, 560, GAP);
  t('a narrow window: the sidebar is narrowed so the panes keep PANES_MIN', l.side.width === 588 - GAP - SR.PANES_MIN && l.panes.w === SR.PANES_MIN);
  t('too narrow even for HIDE_BELOW: no sidebar (the panes get everything)', SR.layout({ ...narrow, w: SR.PANES_MIN + GAP + SR.HIDE_BELOW - 1 }, 300, GAP).side === null
    && SR.layout({ ...narrow, w: SR.PANES_MIN + GAP + SR.HIDE_BELOW }, 300, GAP).side.width === SR.HIDE_BELOW); }
t('fit: no / bad width -> 0', [0, -5, NaN, undefined, null, '300'].every(w => SR.fit(w, 1000, GAP) === 0));

// ---- width ----
t('clampWidth: default 300, limits 220..560, rounded', SR.DEFAULT_WIDTH === 300 && SR.MIN_WIDTH === 220 && SR.MAX_WIDTH === 560
  && SR.clampWidth(undefined) === 300 && SR.clampWidth('400') === 300 && SR.clampWidth(NaN) === 300 && SR.clampWidth(Infinity) === 300
  && SR.clampWidth(100) === 220 && SR.clampWidth(9999) === 560 && SR.clampWidth(333.6) === 334 && SR.clampWidth(220) === 220 && SR.clampWidth(560) === 560);
t('dragWidth: the pointer on the middle of the edge keeps the width', SR.dragWidth(base.x + 300 + GAP / 2, base, GAP) === 300);
t('dragWidth: held within 220..560', SR.dragWidth(0, base, GAP) === 220 && SR.dragWidth(5000, base, GAP) === 560 && SR.dragWidth(-1e5, base, GAP) === 220);
t('dragWidth: never past the panes\' minimum in a narrow window', SR.dragWidth(5000, { ...base, w: 700 }, GAP) === 700 - GAP - SR.PANES_MIN);

// ---- URL ----
t('normalizeUrl: https (any host / port / path / hash), trimmed', SR.normalizeUrl(' https://example.com/#/p/sidebar ') === 'https://example.com/#/p/sidebar'
  && SR.normalizeUrl('https://example.com') === 'https://example.com/' && SR.normalizeUrl('https://example.com:8443/a?b=1') === 'https://example.com:8443/a?b=1');
t('normalizeUrl: plain http only on this Mac\'s loopback (dev server)', ['http://localhost:5173/', 'http://127.0.0.1:3000/x', 'http://[::1]:8080/'].every(u => SR.normalizeUrl(u) === u)
  && ['http://example.com/', 'http://localhost.example.com/', 'http://192.168.1.2/'].every(u => SR.normalizeUrl(u) === ''));
t('normalizeUrl: other schemes, user names, spaces, control characters, too long -> none',
  ['javascript:alert(1)', 'file:///etc/hosts', 'data:text/html,x', 'about:blank', 'chrome://settings', 'ftp://example.com/', 'mpb:newtab',
    'https://user:pass@example.com/', 'https://user@example.com/', 'https://exa mple.com/', 'https://example.com/a b', 'https://example.com/a\nb', 'https://example.com/a\tb',
    'https://example.com/' + 'a'.repeat(SR.URL_MAX), 'example.com', '//example.com', '', '   ', null, undefined, 5, {}].every(u => SR.normalizeUrl(u) === ''));
t('validUrl: empty = no sidebar (allowed); a usable URL; nothing else', SR.validUrl('') && SR.validUrl('   ') && SR.validUrl('https://example.com/#/p/sidebar')
  && !SR.validUrl('http://example.com/') && !SR.validUrl('javascript:x') && !SR.validUrl(null) && !SR.validUrl(5) && !SR.validUrl('x'.repeat(SR.URL_MAX + 1)));
t('originOf: the URL\'s origin, or none', SR.originOf('https://example.com/#/p/sidebar') === 'https://example.com' && SR.originOf('http://localhost:5173/') === 'http://localhost:5173' && SR.originOf('http://example.com/') === '');
{ const home = 'https://example.com/#/p/sidebar';
  t('navOk: routes / queries / hashes on the same origin', ['https://example.com/#/p/other', 'https://example.com/board?x=1', 'https://example.com/'].every(u => SR.navOk(u, home)));
  t('navOk: another host / sub-domain / port / scheme / user name -> no', ['https://evil.example/', 'https://sub.example.com/', 'https://example.com:444/', 'http://example.com/',
    'https://example.com.evil.example/', 'https://u@example.com/', 'javascript:alert(1)', 'about:blank', '', null].every(u => !SR.navOk(u, home)));
  t('navOk: no configured URL -> nothing', !SR.navOk('https://example.com/', '') && !SR.navOk('https://example.com/', 'http://example.com/')); }
t('httpUrl: http(s) without a user name only (what may go to the default browser)', SR.httpUrl('https://a.example/') && SR.httpUrl('http://a.example/')
  && !SR.httpUrl('mailto:a@example.com') && !SR.httpUrl('file:///x') && !SR.httpUrl('https://u:p@a.example/') && !SR.httpUrl(''));

// ---- settings -> what the windows show ----
t('view: defaults = closed, 300 px, no URL (the button dimmed)', J(SR.view({})) === J({ url: '', configured: false, open: false, width: 300 }) && J(SR.view(undefined)) === J(SR.view({})));
t('view: open only with a usable URL', SR.view({ sidebarOpen: true }).open === false && SR.view({ sidebarOpen: true, sidebarUrl: 'http://example.com/' }).open === false
  && SR.view({ sidebarOpen: true, sidebarUrl: 'https://example.com/' }).open === true && SR.view({ sidebarOpen: 'yes', sidebarUrl: 'https://example.com/' }).open === false);
t('view: the width clamped', SR.view({ sidebarWidth: 1000 }).width === 560 && SR.view({ sidebarWidth: 'x' }).width === 300);
t('partition: its own persistent session, never the panes\'', SR.PARTITION === 'persist:xg-sidebar' && SR.KEEP_MS === 300000);

// ---- Bot names ----
const FW = s => [...s].map(c => c === ' ' ? String.fromCodePoint(0x3000) : String.fromCodePoint(c.codePointAt(0) + 0xfee0)).join('');   // full-width form
t('normName: NFKC, case, spaces / underscores folded, zero-width dropped', SR.normName('  Grok_Bot ') === 'grok bot' && SR.normName('grok   bot') === 'grok bot'
  && SR.normName(FW('Grok_Bot')) === 'grok bot' && SR.normName(FW('Grok Bot')) === 'grok bot' && SR.normName('Grok' + String.fromCodePoint(0x200b) + 'Bot') === 'grokbot'
  && SR.normName('Ｇｒｏｋ＿Ｂｏｔ') === 'grok bot' && SR.normName(5) === '');
t('nameOk: a non-empty string up to 80 characters without control characters', SR.nameOk('Grok Bot') && SR.nameOk('x'.repeat(80)) && !SR.nameOk('x'.repeat(81))
  && !SR.nameOk('') && !SR.nameOk('  _ ') && !SR.nameOk('a\nb') && !SR.nameOk(null) && !SR.nameOk(['a']) && !SR.nameOk({ toString: () => 'a' }));
{ const P = [
    { key: 1, tiers: [[''], ['Research Bot', 'research_bot'], ['Research Bot']] },
    { key: 2, tiers: [['作業A'], ['Grok_Bot'], ['Grok Bot']] },
    { key: 3, tiers: [['Grok Bot'], [''], ['別のタイトル']] },
    { key: 4, tiers: [[''], [''], ['Writer']] },
    { key: 5, tiers: [[''], [''], ['Writer']] },
  ];
  t('findBot: the user\'s own name beats a Bot name / title anywhere', SR.findBot('grok bot', P) === 3);
  t('findBot: a Bot name the app read (space / underscore / case / full-width equal)', SR.findBot('RESEARCH_BOT', P) === 1 && SR.findBot(FW('Research Bot'), P) === 1 && SR.findBot('作業Ａ', P) === 2);
  t('findBot: the strip\'s title; the first pane in order on a tie (the sender\'s window first)', SR.findBot('writer', P) === 4 && SR.findBot('writer', [P[4], P[3]]) === 5);
  t('findBot: no such pane / a bad name -> null (nothing is done)', SR.findBot('nobody', P) === null && SR.findBot('', P) === null && SR.findBot('x'.repeat(81), P) === null
    && SR.findBot(5, P) === null && SR.findBot('Writer', null) === null && SR.findBot('Writer', []) === null);
  t('findBot: empty names never match', SR.findBot('Writer', [{ key: 9, tiers: [[''], ['', null, 5], ['']] }]) === null);
  t('findBot: odd entries are skipped, not fatal', SR.findBot('writer', [null, { key: 8 }, { key: 7, tiers: 'x' }, ...P]) === 4); }

// ---- jump: agentId / name -> the pane, or the URL of a new one ----
const A1 = 'dddddddd-dddd-dddd-dddd-dddddddddddd', A2 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', BOT = id => 'https://grok.com/bot/' + id;
t('agentOk: a lowercase UUID only', SR.agentOk(A1) && SR.agentOk(A2) && !SR.agentOk(A1.toUpperCase()) && !SR.agentOk(A1 + 'x') && !SR.agentOk(A1.slice(1))
  && !SR.agentOk('abc') && !SR.agentOk('') && !SR.agentOk(5) && !SR.agentOk(null) && !SR.agentOk(` ${A1}`) && !SR.agentOk(A1.replace(/-/g, '')) && !SR.agentOk('g' + A1.slice(1)));
t('agentOf: the UUID of a grok.com/bot/<uuid> page (query / hash / trailing slash ok, lowercased), else \'\'', SR.agentOf(BOT(A1)) === A1 && SR.agentOf(BOT(A1) + '/') === A1
  && SR.agentOf(BOT(A1) + '?conversation=x#y') === A1 && SR.agentOf(BOT(A1.toUpperCase())) === A1
  && ['https://grok.com/bot/abc', 'http://grok.com/bot/' + A1, 'https://grok.com.evil/bot/' + A1, 'https://evil.com/?u=' + BOT(A1), BOT(A1) + '/c/x', 'https://grok.com/', 'https://u@grok.com/bot/' + A1, '', null, 5]
    .every(u => SR.agentOf(u) === ''));
t('botUrl: built from a valid UUID only (never anything else)', SR.botUrl(A1) === BOT(A1) && SR.botUrl('../x') === '' && SR.botUrl('https://evil.com/') === '' && SR.botUrl(A1.toUpperCase()) === '' && SR.botUrl() === '');
t('jumpOk: { name, agentId?, open? } only (no URL, no other key)', [{ name: 'Bot' }, { name: 'Bot', agentId: A1 }, { name: 'Bot', agentId: A1, open: true }, { name: 'Bot', open: false }].every(SR.jumpOk)
  && ![{ name: 'Bot', url: BOT(A1) }, { name: 'Bot', agentId: 'abc' }, { name: 'Bot', agentId: A1.toUpperCase() }, { name: 'Bot', agentId: null }, { name: 'Bot', open: 'yes' }, { name: 'Bot', open: 1 },
    { agentId: A1 }, { name: '' }, { name: 'x'.repeat(81) }, { name: 'a\nb' }, null, 'Bot', [{ name: 'Bot' }], { name: 'Bot', __proto__: { open: true }, extra: 1 }].some(SR.jumpOk));
{ const P = [
    { key: 'w1-1', url: 'https://example.com/', tiers: [[''], [''], ['Example']] },
    { key: 'w1-2', url: BOT(A2), tiers: [['作業A'], ['Writer'], ['Writer']] },
    { key: 'w2-1', url: BOT(A1), tiers: [[''], ['Research Bot'], ['Research Bot']] },
    { key: 'w2-2', url: 'https://grok.com/bot/zz', tiers: [['Research Bot'], [''], ['x']] },
  ];
  const J1 = r => J(SR.jump(r, P));
  t('jump: a pane on that agentId first (any window, even when another pane has the name)', J1({ name: 'Research Bot', agentId: A1 }) === J({ result: 'focused', key: 'w2-1' }));
  t('jump: the agentId wins over a wrong name; open: true never opens when found', J1({ name: 'nobody', agentId: A2 }) === J({ result: 'focused', key: 'w1-2' }) && J1({ name: 'nobody', agentId: A2, open: true }) === J({ result: 'focused', key: 'w1-2' }));
  t('jump: no pane of that agentId -> findBot by name (the user\'s name first)', J1({ name: 'research_bot', agentId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }) === J({ result: 'focused', key: 'w2-2' }) && J1({ name: 'Writer' }) === J({ result: 'focused', key: 'w1-2' }));
  t('jump: the sender\'s window first (the order given) for the same agentId', SR.jump({ name: 'x', agentId: A1 }, [{ key: 'a', url: BOT(A1) + '?c=1', tiers: [] }, { key: 'b', url: BOT(A1), tiers: [] }]).key === 'a');
  const NEW = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  t('jump: none + an agentId -> nomatch (the page may ask)', J1({ name: 'nobody', agentId: NEW }) === J({ result: 'nomatch' }) && J1({ name: 'nobody', agentId: NEW, open: false }) === J({ result: 'nomatch' }));
  t('jump: none + an agentId + open: true -> opened with the URL built from the UUID', J1({ name: 'nobody', agentId: NEW, open: true }) === J({ result: 'opened', url: BOT(NEW) }));
  t('jump: none and no (valid) agentId -> none, never opened', J1({ name: 'nobody' }) === J({ result: 'none' }) && J1({ name: 'nobody', open: true }) === J({ result: 'none' })
    && J1({ name: 'nobody', agentId: 'abc', open: true }) === J({ result: 'none' }) && J1({ name: 'nobody', agentId: NEW.toUpperCase(), open: true }) === J({ result: 'none' }));
  t('jump: a URL in the request is never used', J1({ name: 'nobody', url: 'https://evil.com/', open: true }) === J({ result: 'none' }) && J1({ name: 'nobody', agentId: NEW, url: 'https://evil.com/', open: true }) === J({ result: 'opened', url: BOT(NEW) }));
  t('jump: odd input is not fatal', J(SR.jump(null, P)) === J({ result: 'none' }) && J(SR.jump({ name: 'Writer' }, null)) === J({ result: 'none' }) && SR.jump({ name: 'x', agentId: A1 }, [null, 5, ...P]).key === 'w2-1'); }

// ---- the state the page is told ----
t('confirmOpen: on unless the setting is false', SR.confirmOpen({}) === true && SR.confirmOpen(undefined) === true && SR.confirmOpen({ sidebarConfirmOpen: true }) === true
  && SR.confirmOpen({ sidebarConfirmOpen: false }) === false && SR.confirmOpen({ sidebarConfirmOpen: 'no' }) === true);
{ const N = SR.paneNames([['My Bot'], ['Bot A', 'bot_a', 'Bot B', 'Bot C', 'Bot D'], ['My_Bot', 'Title']]);
  t('paneNames: the tiers in order, the same name once (folded as findBot folds it), NAMES_PER_TIER of each', J(N) === J(['My Bot', 'Bot A', 'Bot B', 'Bot C', 'Title']) && SR.NAMES_PER_TIER === 3); }
t('paneNames: cut to NAME_MAX UTF-16 units = what nameOk takes back (not halfway into a surrogate pair), one line, empty / non-string skipped', (() => {
  const long = String.fromCodePoint(0x1f600).repeat(100), n = SR.paneNames([[long, 'a\nb\tc', '', '  ', null, 5, {}]]);
  return n.length === 2 && n[0].length === 80 && n[0] === String.fromCodePoint(0x1f600).repeat(40) && n[1] === 'a b c' && n.every(SR.nameOk)
    && SR.paneNames([['x'.repeat(79) + String.fromCodePoint(0x1f600)]])[0] === 'x'.repeat(79); })());
t('paneNames: never a part of the URL - a name that is a URL or the URL\'s host (the strip\'s title of a page without one) is left out', J(SR.paneNames([['www.Example.net'], ['example.net', 'Example', 'https://example.net/x?token=1', 'see http://a.b/'], ['example.net']], 'https://www.example.net/x?token=1')) === J(['Example'])
  && J(SR.paneNames([[''], [''], ['grok.com']], BOT(A1))) === '[]' && J(SR.paneNames([['grok.com']], 'https://example.com/')) === J(['grok.com']) && J(SR.paneNames([['a.com']], 'not a url')) === J(['a.com']));
t('paneNames: odd tiers are not fatal', J(SR.paneNames(null)) === '[]' && J(SR.paneNames(['x', null, [['a']]])) === '[]');
{ const rows = [
    { url: BOT(A1) + '?conversation=secret', tiers: [['Mine'], ['Research Bot'], ['Research Bot']], active: true, id: 4, key: { c: 1 } },
    { url: 'https://mail.example.com/inbox?token=secret', tiers: [[''], [''], ['Inbox']], active: false },
    { url: 'https://grok.com/bot/abc', tiers: [[''], [''], ['Old bot']], active: 'yes' },
    { url: '', tiers: [[''], [''], ['']] },
  ];
  const st = SR.state(rows, false), js = J(st);
  t('state: { panes, confirmOpen } and per pane exactly agentId / names / active', J(Object.keys(st)) === J(['panes', 'confirmOpen']) && st.panes.every(p => J(Object.keys(p)) === J(['agentId', 'names', 'active'])));
  t('state: agentId only from a grok.com/bot/<uuid> page, else null', J(st.panes.map(p => p.agentId)) === J([A1, null, null, null]));
  t('state: nothing else of any URL (no query / host / path / token) reaches the page', !/secret|mail\.example|inbox\?|https?:|grok\.com|\/bot\/|"url"|"tiers"|"key"|"id"/.test(js));
  t('state: names per pane; active only when exactly true; the confirm setting', J(st.panes[0].names) === J(['Mine', 'Research Bot']) && J(st.panes[1].names) === J(['Inbox']) && J(st.panes[3].names) === '[]'
    && J(st.panes.map(p => p.active)) === J([true, false, false, false]) && st.confirmOpen === false && SR.state(rows, true).confirmOpen === true);
  t('state: at most STATE_PANES panes; odd rows are not fatal', SR.state(Array(150).fill(rows[0]), true).panes.length === SR.STATE_PANES && SR.state(null).panes.length === 0
    && J(SR.state([null], true).panes) === J([{ agentId: null, names: [], active: false }])); }

// ---- the composer focus (FOCUS_JS), run on a tiny fake DOM ----
const vm = require('vm');
function page(els, extra = {}) {
  const doc = { activeElement: null, querySelectorAll: () => els.filter(e => !e.gone), createRange: () => ({ selectNodeContents(n) { this.n = n; }, collapse(end) { this.end = end; } }) };
  const sel = { ranges: [], removeAllRanges() { this.ranges = []; }, addRange(r) { this.ranges.push(r); } };
  for (const e of els) e.focus = () => { doc.activeElement = e; e.focused = (e.focused || 0) + 1; };
  return { document: doc, getSelection: () => sel, sel, setTimeout, Date, Promise, ...extra };
}
const el = (tag, o = {}) => ({ tagName: tag, offsetParent: {}, tabIndex: 0, value: '', closest: () => null, setSelectionRange(a, b) { this.caret = [a, b]; }, ...o });
const runFocus = (ctx, ms) => vm.runInNewContext(ms === undefined ? SR.FOCUS_JS : `(${SR.focusComposer})(${ms})`, ctx);
{ const mirror = el('TEXTAREA', { tabIndex: -1 }), hidden = el('TEXTAREA', { offsetParent: null }), aria = el('TEXTAREA', { closest: s => s === '[aria-hidden="true"]' ? {} : null });
  const old = el('TEXTAREA', { value: 'old' }), box = el('TEXTAREA', { value: '下書き' }), ctx = page([old, box, mirror, hidden, aria]);
  const r = runFocus(ctx);
  t('FOCUS_JS: the last visible composer (not a mirror / hidden / aria-hidden one) gets the focus, caret at its end', r === 'focused' && ctx.document.activeElement === box && J(box.caret) === J([3, 3]) && !old.focused && !mirror.focused); }
{ const ce = el('DIV'), ctx = page([ce]);
  t('FOCUS_JS: a contenteditable composer: focused, the caret collapsed at its end', runFocus(ctx) === 'focused' && ctx.document.activeElement === ce && ctx.sel.ranges.length === 1 && ctx.sel.ranges[0].n === ce && ctx.sel.ranges[0].end === false); }
{ const box = el('TEXTAREA', { value: 'abc' }), ctx = page([box]); ctx.document.activeElement = box; box.caret = [1, 1];
  t('FOCUS_JS: already focused: left as it is (the caret where the user put it)', runFocus(ctx) === 'focused' && !box.focused && J(box.caret) === J([1, 1])); }
{ const ro = el('TEXTAREA', { readOnly: true }), dis = el('TEXTAREA', { disabled: true }), ctx = page([ro, dis]);
  const r = runFocus(ctx, 150);
  t('FOCUS_JS: no usable composer -> waits, then \'none\' (a promise; nothing focused)', r instanceof ctx.Promise || typeof (r && r.then) === 'function');
  r.then(v => t('FOCUS_JS: ...resolved \'none\' after its wait', v === 'none' && !ro.focused && !dis.focused)); }
{ const late = el('TEXTAREA', { gone: true }), ctx = page([late]);
  const r = runFocus(ctx, 2000); setTimeout(() => { late.gone = false; }, 250);
  r.then(v => t('FOCUS_JS: a composer that appears later (React rendering) is focused once it is there', v === 'focused' && ctx.document.activeElement === late)); }
{ const box = el('TEXTAREA'), ctx = page([box]); box.focus = () => {};   // the page refuses the focus
  t('FOCUS_JS: a focus that did not take -> \'none\'', runFocus(ctx) === 'none'); }
t('FOCUS_JS: fixed code only (the page waits FOCUS_WAIT_MS at most; it never types / submits / reads text out)', SR.FOCUS_JS.endsWith(`)(${SR.FOCUS_WAIT_MS})`) && SR.FOCUS_WAIT_MS === 5000
  && !/execCommand|dispatchEvent|\.click\(|submit|innerText|textContent|fetch|XMLHttpRequest|postMessage|localStorage|cookie/.test(SR.FOCUS_JS));
t('composerPage: grok.com pages only', SR.composerPage(BOT(A1)) && SR.composerPage('https://grok.com/') && !SR.composerPage('https://grok.com.evil/') && !SR.composerPage('http://grok.com/') && !SR.composerPage('about:blank') && !SR.composerPage(null));
t('WORLD: its own isolated world (no other module uses it)', SR.WORLD === 1008 && ['grok-bots', 'copy-policy', 'usage-web', 'new-pane'].every(m => require('../src/' + m).WORLD !== SR.WORLD));
t('results the page may get', J(SR.RESULTS) === J(['focused', 'opened', 'none', 'blocked', 'nomatch']));

setTimeout(() => { console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0); }, 2500);   // the composer waits above settle first

