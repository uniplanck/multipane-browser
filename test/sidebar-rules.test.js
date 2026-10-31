// node test/sidebar-rules.test.js — 進捗サイドバー (src/sidebar-rules.js): the pane area with / without the sidebar, the width limits and the
// drag, the URL rules (https / loopback http, no user name, its origin only), the settings defaults and the Bot-name matching.
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

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
