// node test/navigation-policy.test.js — navigation / link / external-open policy (#72): src/navigation-policy.js parses every URL and compares
// scheme + hostname (exact or at a sub-domain boundary), refuses user names / passwords and dangerous schemes, and routes links: grok.com in
// the pane, sign-in popups in a child window, every other web link (window.open / target=_blank / a plain link on a grok.com page) in the
// default browser, mailto to Mail after a click / key, tel / sms / facetime / app schemes nowhere; the usage sign-in windows as before.
// Contract with the real main.js: every loadURL / shell.openExternal goes through the policy, the UI never moves.
const fs = require('fs'), path = require('path');
const N = require('../src/navigation-policy');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const SRC = path.join(__dirname, '..', 'src'), read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const J = JSON.stringify;
const act = (r, a, c = null) => r.action === a && r.code === c;
const WO = (u, o) => N.windowOpen(u, o), NV = (u, o) => N.navigate(u, o);

// ---- hosts: exact or a sub-domain, never a prefix / substring of the text ----
const SPOOF = ['https://evilgrok.com/', 'https://grok.com.evil.com/', 'https://grok.comevil.com/', 'https://evil.com/grok.com', 'https://evil.com/?u=https://grok.com/',
  'https://evil.com#grok.com', 'https://evil.com\\@grok.com/', 'https://grok.com%2eevil.com/', 'https://grok.com./', 'https://xn--grk-sqa.com/', 'https://grоk.com/',
  'https://grok-com.evil.com/', 'https://grok.co/', 'https://127.0.0.1/', 'https://[::1]/'];
t('grok hosts: grok.com and its sub-domains (upper case / port normalised by URL)', ['https://grok.com/bot/abc', 'https://GROK.COM/bot/x', 'https://www.grok.com/', 'https://a.b.grok.com/x', 'http://grok.com/', 'https://grok.com:8443/']
  .every(u => N.isGrokHost(new URL(u).hostname)));
t(`spoofed / look-alike hosts are not grok (${SPOOF.length})`, SPOOF.every(u => !N.isGrokHost(N.parse(u)?.hostname)));
t('sign-in hosts: exact or sub-domain only', ['https://accounts.google.com/o', 'https://x.com/i/oauth2', 'https://accounts.x.ai/sign-in', 'https://appleid.apple.com/', 'https://checkout.stripe.com/', 'https://login.microsoftonline.com/']
  .every(u => N.isAuthHost(new URL(u).hostname))
  && ['https://notgoogle.com/', 'https://google.com.evil.com/', 'https://evilx.com/', 'https://x.ai.evil.com/', 'https://googleusercontent.com.evil/', 'https://apple.co/'].every(u => !N.isAuthHost(new URL(u).hostname)));
t('hostIn: no empty host, no non-string', !N.hostIn('', N.GROK) && !N.hostIn(undefined, N.GROK) && !N.hostIn(5, N.GROK) && !N.hostIn('com', N.GROK));
t('parse: bad / empty / non-string / too long -> null', [undefined, null, '', 'not a url', 5, {}, 'https://' + 'a'.repeat(N.URL_MAX)].every(u => N.parse(u) === null) && N.parse('https://grok.com/').hostname === 'grok.com');
t('grok page: a web page on grok.com / a sub-domain (any path), nothing else', ['https://grok.com/bot/abc', 'https://grok.com/', 'https://grok.com/c/1', 'http://grok.com/x', 'https://www.grok.com/project/1'].every(N.isGrokPage)
  && ![...SPOOF, 'https://accounts.x.ai/sign-in', 'about:blank', 'file:///Users/x/newtab.html', 'blob:https://grok.com/1', 'https://u@grok.com/', '', null, undefined].some(N.isGrokPage));

// ---- window.open / target=_blank of a pane / the 承認Bot popup ----
const POP = { popup: true }, LOGIN = { login: true };
t('grok.com link -> this pane; with popup features -> child window', act(WO('https://grok.com/bot/abc'), 'pane') && act(WO('https://grok.com/c/1', POP), 'child') && act(WO('http://grok.com/'), 'pane') && act(WO('https://assets.grok.com/x.png'), 'pane'));
t('sign-in / OAuth popup (window features + a sign-in host) -> child window, as before', ['https://accounts.google.com/o/oauth2/auth?x=1', 'https://x.com/i/oauth2/authorize', 'https://appleid.apple.com/auth/authorize', 'https://accounts.x.ai/sign-in', 'https://checkout.stripe.com/c/pay']
  .every(u => act(WO(u, POP), 'child')));
t('a plain link (no window features) to a sign-in host -> the default browser (x.com post / google.com / github.com ...)', ['https://x.com/someone/status/1', 'https://www.google.com/search?q=x', 'https://github.com/a/b', 'https://support.apple.com/x', 'https://accounts.google.com/']
  .every(u => act(WO(u), 'browser')));
t('a popup with window features to any other site -> the default browser (no Electron window)', ['https://example.com/', 'https://www.facebook.com/sharer/sharer.php?u=x', ...SPOOF.filter(u => N.parse(u))].every(u => act(WO(u, POP), 'browser')));
t('other web links -> the default browser', ['https://example.com/a?b=1#c', 'http://example.org/', 'https://en.wikipedia.org/wiki/Grok', ...SPOOF.filter(u => N.parse(u))].every(u => act(WO(u), 'browser')));
t('blob: / data: / about:blank -> child window (previews), as before', act(WO('blob:https://grok.com/1234-5678'), 'child') && act(WO('data:image/png;base64,AAAA'), 'child') && act(WO('about:blank'), 'child'));
t('mailto -> browser (openExt: Mail, after a click / key), with or without popup features', ['mailto:a@example.com', 'MAILTO:a@example.com', 'mailto:a@b.c?subject=x'].every(u => act(WO(u), 'browser') && act(WO(u, POP), 'browser')));
const NOAPP = ['tel:+81300000000', 'sms:+81300000000', 'facetime:a@example.com', 'facetime-audio:a@example.com', 'TEL:1', 'callto:1', 'skype:x', 'zoommtg://zoom.us/join', 'vscode://file/x', 'myapp://open'];
t(`tel / sms / facetime / custom app schemes -> deny E_SCHEME (${NOAPP.length}), also as a popup`, NOAPP.every(u => act(WO(u), 'deny', 'E_SCHEME') && act(WO(u, POP), 'deny', 'E_SCHEME')));
const DANGER = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'javascript://%0aalert(1)', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'file://localhost/Users/x/a.html', 'chrome://settings', 'chrome-extension://abc/x.html',
  'devtools://devtools/bundled/inspector.html', 'view-source:https://grok.com/', 'filesystem:https://grok.com/temporary/x', 'ftp://example.com/', 'ws://example.com/', 'wss://example.com/', 'about:config', 'about:blank#x',
  'smb://server/share', 'afp://server/share', 'x-apple.systempreferences:com.apple.preference', 'slack://open', 'itms-apps://x', 'mpb:newtab'];
t(`dangerous / unknown schemes -> deny E_SCHEME (${DANGER.length})`, DANGER.every(u => act(WO(u), 'deny', 'E_SCHEME')));
const USERINFO = ['https://user:pass@grok.com/bot/abc', 'https://x.com@evil.com/', 'https://grok.com@evil.com/', 'https://user@grok.com/', 'http://:pw@example.com/', 'https://a%40b@accounts.google.com/'];
t(`user name / password in the URL -> deny E_USERINFO (${USERINFO.length}), even towards grok / sign-in hosts`, USERINFO.every(u => act(WO(u), 'deny', 'E_USERINFO') && act(WO(u, { popup: true }), 'deny', 'E_USERINFO')));
t('an empty "@" is no user name (URL drops it)', act(WO('https://@grok.com/bot/a'), 'pane'));
t('bad URL -> deny E_URL', ['', 'not a url', 'https://', 'http://exa mple.com/', null, undefined, 42].every(u => act(WO(u), 'deny', 'E_URL')));
t('a window a page opened: http(s) -> browser, everything else -> deny', act(WO('https://grok.com/', { child: true }), 'browser') && act(WO('https://example.com/', { child: true }), 'browser')
  && act(WO('mailto:a@b.c', { child: true }), 'deny', 'E_SCHEME') && act(WO('about:blank', { child: true }), 'deny', 'E_SCHEME') && act(WO('data:text/html,x', { child: true }), 'deny', 'E_SCHEME')
  && act(WO('https://u:p@example.com/', { child: true }), 'deny', 'E_USERINFO') && act(WO('javascript:1', { child: true }), 'deny', 'E_SCHEME'));
t('popup features: width / height / popup', N.popupFeatures('width=500,height=600') && N.popupFeatures('popup') && N.popupFeatures('left=1, height=2') && !N.popupFeatures('') && !N.popupFeatures('noopener') && !N.popupFeatures(undefined) && !N.popupFeatures('popupx=1'));
t('usage sign-in window (persist:usage-*): any web popup -> its child window, as before (sign-in pages / Google / SSO)', ['https://claude.ai/login', 'https://accounts.google.com/o/oauth2/auth', 'https://auth.openai.com/x', 'https://sso.example.com/', 'https://grok.com/', 'about:blank', 'blob:https://claude.ai/1']
  .every(u => act(WO(u, LOGIN), 'child')) && act(WO('mailto:a@b.c', LOGIN), 'browser') && ['tel:1', 'javascript:1', 'file:///x', 'myapp://x'].every(u => act(WO(u, LOGIN), 'deny', 'E_SCHEME')) && act(WO('https://u@claude.ai/', LOGIN), 'deny', 'E_USERINFO'));

// ---- will-navigate (main frame) ----
const BOT = { pane: true, from: 'https://grok.com/bot/abc' }, GPAGES = ['https://grok.com/', 'https://grok.com/c/1', 'https://grok.com/project/x', 'https://grok.com/bot/abc?x=1#y'];
t('grok.com page: grok.com / sign-in stay, other web links -> browser', act(NV('https://grok.com/bot/other', BOT), 'allow') && act(NV('https://accounts.x.ai/sign-in', BOT), 'allow') && act(NV('https://accounts.google.com/', BOT), 'allow')
  && act(NV('https://checkout.stripe.com/c/pay', BOT), 'allow') && act(NV('https://example.com/', BOT), 'browser') && SPOOF.filter(u => N.parse(u)).every(u => act(NV(u, BOT), 'browser')));
t('any grok.com page of a pane (home / chat / project, not only /bot/): a link that leaves grok.com -> browser', GPAGES.every(f => act(NV('https://example.com/', { pane: true, from: f }), 'browser') && act(NV('https://grok.com/bot/x', { pane: true, from: f }), 'allow')));
t('pane: mailto -> browser (openExt: Mail after a click / key) on any page; tel / sms / facetime / app schemes -> deny', ['mailto:a@b.c', 'MAILTO:x@y.z'].every(u => act(NV(u, BOT), 'browser') && act(NV(u, { pane: true, from: 'https://example.com/' }), 'browser'))
  && NOAPP.every(u => act(NV(u, BOT), 'deny', 'E_SCHEME') && act(NV(u, { pane: true }), 'deny', 'E_SCHEME')));
t('background check / a window a page opened (usage sign-in too): no app (mailto / tel ... -> deny), web pages allowed', ['mailto:a@b.c', ...NOAPP].every(u => act(NV(u), 'deny', 'E_SCHEME'))
  && ['https://example.com/', 'https://accounts.google.com/o', 'https://claude.ai/settings/usage', 'https://sso.example.com/saml'].every(u => act(NV(u), 'allow') && act(NV(u, { from: 'https://grok.com/' }), 'allow')));
t('pane on a page the user opened elsewhere (address bar / new tab / sign-in page): web links allowed as before', ['https://example.com/', 'http://example.org/x', 'https://grok.com/'].every(u => act(NV(u), 'allow')
  && ['https://example.com/', 'file:///Users/x/newtab.html', 'https://accounts.x.ai/sign-in', 'about:blank', ''].every(f => act(NV(u, { pane: true, from: f }), 'allow'))));
t('blob: of the page / about:blank: allowed as before', act(NV('blob:https://grok.com/1'), 'allow') && act(NV('blob:https://grok.com/1', BOT), 'allow') && act(NV('about:blank', BOT), 'allow'));
t('any page: dangerous schemes (file: from the new-tab page, data:, chrome: ...) -> deny E_SCHEME', [...DANGER, 'data:text/html,<b>x</b>'].every(u => act(NV(u), 'deny', 'E_SCHEME') && act(NV(u, BOT), 'deny', 'E_SCHEME')));
t('any page: user name / password -> deny E_USERINFO (not even to the browser)', USERINFO.every(u => act(NV(u), 'deny', 'E_USERINFO') && act(NV(u, BOT), 'deny', 'E_USERINFO')));
t('any page: bad URL -> deny E_URL', ['', 'x', null].every(u => act(NV(u), 'deny', 'E_URL')));
t('the app\'s own UI never moves (a dropped link / file, any URL)', ['https://grok.com/', 'file:///tmp/a.html', 'about:blank', '', null].every(u => act(NV(u, { ui: true }), 'deny', 'E_UI') && act(NV(u, { ui: true, bot: true }), 'deny', 'E_UI')));

// ---- will-redirect (main frame), main's own loads, shell.openExternal ----
t('redirect: any web host (sign-in goes through many) -> allowed', ['https://accounts.x.ai/a', 'https://example.com/', 'http://grok.com/', 'https://grok.com/bot/a'].every(u => N.redirect(u) === null));
t('redirect: user name, non-web scheme, bad URL -> refused', N.redirect('https://u@grok.com/') === 'E_USERINFO' && ['data:text/html,x', 'file:///x', 'javascript:1', 'mailto:a@b.c', 'about:blank'].every(u => N.redirect(u) === 'E_SCHEME') && N.redirect('') === 'E_URL');
const APP_OK = ['https://grok.com/bot/abc', 'https://grok.com/', 'https://www.google.com/search?q=%E3%81%82', 'http://localhost:3000/', 'https://example.com/a#b', 'about:blank', 'https://grok.com/bot/5674ea26-494f-49a0-acc1-f55ce2dd9c94'];
t(`app loads: web pages + about:blank (sleep) allowed (${APP_OK.length})`, APP_OK.every(u => N.appLoad(u) === null));
t('app loads: javascript: / file: / data: / chrome: / other about: / user names / internal marker refused', [...DANGER, 'data:text/html,x', 'blob:https://grok.com/1', 'mailto:a@b.c'].every(u => N.appLoad(u) === 'E_SCHEME')
  && USERINFO.every(u => N.appLoad(u) === 'E_USERINFO') && ['', 'grok.com', null].every(u => N.appLoad(u) === 'E_URL'));
const EX = (u, g) => N.external(u, { gesture: g });
t('external: http(s) -> the parsed URL (with or without a click)', EX('https://example.com/a b', false).href === 'https://example.com/a%20b' && EX('http://EXAMPLE.com/', false).href === 'http://example.com/' && EX('https://grok.com/', true).code === null);
t('external: mailto only right after a click / key', ['mailto:a@b.c?subject=x y', 'MAILTO:a@b.c'].every(u => EX(u, true).code === null && EX(u, true).href.startsWith('mailto:') && EX(u, false).code === 'E_GESTURE' && EX(u, false).href === '')
  && N.external('mailto:a@b.c').code === 'E_GESTURE' && N.external('mailto:a@b.c', { gesture: 1 }).code === 'E_GESTURE');
t('external: only http / https / mailto - tel / sms / facetime / app schemes refused, even after a click', NOAPP.every(u => EX(u, true).code === 'E_SCHEME' && EX(u, true).href === '' && EX(u, false).code === 'E_SCHEME'));
{ const OUT = ['https://example.com/', 'mailto:a@b.c', 'tel:1', 'file:///etc/passwd', 'javascript:alert(1)', 'myapp://x', 'data:text/html,x'];   // what a pane's link may hand to openExternal
  const handed = u => [WO(u), WO(u, POP), NV(u, BOT)].some(r => r.action === 'browser') && !EX(u, true).code;
  t('pane links reach openExternal only for http / https / mailto', J(OUT.filter(handed)) === J(['https://example.com/', 'mailto:a@b.c'])); }
t('external: anything else refused, even after a click (file: would launch an app, smb: mounts a share)', [...DANGER, 'data:text/html,x', 'blob:https://grok.com/1', 'about:blank'].every(u => EX(u, true).code === 'E_SCHEME' && EX(u, true).href === '')
  && USERINFO.every(u => EX(u, true).code === 'E_USERINFO') && EX('', true).code === 'E_URL' && EX(undefined, true).code === 'E_URL');
t('gesture: click / key types only; recent = within GESTURE_MS, not in the future', ['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown'].every(N.isGesture) && !['mouseMove', 'mouseWheel', 'char', 'keyUp', 'mouseEnter', undefined, 'toString'].some(N.isGesture)
  && N.gestureOk(1000, 1000) && N.gestureOk(1000, 1000 + N.GESTURE_MS) && !N.gestureOk(1000, 1001 + N.GESTURE_MS) && !N.gestureOk(2000, 1000) && !N.gestureOk(undefined, 1000) && !N.gestureOk(0, 10) && !N.gestureOk(NaN, 1));
t('codes: every result code is a known one with a short Japanese reason', Object.entries(N.REJECT).every(([k, v]) => /^E_[A-Z]+$/.test(k) && typeof v === 'string' && v.length <= 30 && /[぀-ヿ一-鿿]/.test(v)));
{ const all = [];
  for (const u of [...SPOOF, ...DANGER, ...USERINFO, ...APP_OK, ...NOAPP, '', 'mailto:a@b.c', 'data:x,y']) for (const o of [{}, BOT, { ui: true }, POP, LOGIN, { child: true }]) {
    all.push(WO(u, o).code, NV(u, o).code, N.redirect(u), N.appLoad(u), N.external(u, { gesture: !!o.pane }).code); }
  const seen = new Set(all.filter(Boolean));
  t('results are null or a known code (never a URL)', all.every(c => c === null || Object.hasOwn(N.REJECT, c)));
  t(`every reject code is reachable (${[...seen].sort().join(' ')})`, Object.keys(N.REJECT).every(k => seen.has(k))); }

// ======================= contract with the real main.js =======================
const main = read('main.js');
const fn = name => { const i = main.indexOf(`function ${name}(`); if (i < 0) return ''; let d = 0, j = main.indexOf('{', main.indexOf(')', i)); for (; j < main.length; j++) { if (main[j] === '{') d++; else if (main[j] === '}' && --d === 0) break; } return main.slice(i, j + 1); };
const count = (s, re) => (s.match(re) || []).length;
t('main.js: the only loadURL is inside appLoad, after its check', count(main, /\.loadURL\(/g) === 1 && /const code = NAV\.appLoad\(url\);\s*if \(code\) \{[^}]*return; \}\s*wc\.loadURL\(url\)/.test(fn('appLoad')));
t('main.js: the only shell.openExternal is inside openExt, with the parsed URL after its check', count(main, /shell\.openExternal\(/g) === 1 && /const r = NAV\.external\(url, \{ gesture \}\);\s*if \(r\.code\)[^\n]*return; \}[\s\S]*shell\.openExternal\(r\.href\)/.test(fn('openExt')));
t('main.js: loadFile only for bundled pages (index / overlay / tooltip / new tab)', [...main.matchAll(/\.loadFile\(([^)]*\))?/g)].map(m => main.slice(m.index, m.index + 60)).every(s => /loadFile\((NEWTAB_FILE|path\.join\(__dirname, '(index|overlay|tooltip)\.html'\))\)/.test(s))
  && /const NEWTAB_FILE = path\.join\(__dirname, 'newtab\.html'\);/.test(main));
t('main.js: no hand-made host / scheme tests for links any more (AUTH_HOST, isGrokHost regex, protocol list)', !/AUTH_HOST|const isGrokHost|\(\^\|\\\.\)grok\\\.com\$|\^\(https\?\|mailto/.test(main));
t('main.js: every window-open handler is decided by the policy (panes / popup: linkOpen; child windows: windowOpen child; probe / UI: deny)', (() => {
  const h = [...main.matchAll(/setWindowOpenHandler\(([^\n]*)/g)].map(m => m[1]);
  return h.length === 9 && h.filter(s => s.startsWith('d => linkOpen(wc, d))')).length === 2
    && h.filter(s => s.startsWith("d => { if (SR.httpUrl(d.url) && recentGesture(wc)) openExt(d.url, 'sidebar window.open', true); else navBlocked(") && s.endsWith("return { action: 'deny' }; });")).length === 1   // 進捗サイドバー: never a window && h.some(s => /NAV\.windowOpen\(d\.url, \{ child: true \}\)/.test(s))
    && h.filter(s => s.startsWith("() => ({ action: 'deny' })")).length === 3 && h.some(s => /navBlocked\('E_UI'/.test(s))   // deny: the background check + the Grok bar's read + the usage reader
    && /wc\.setWindowOpenHandler\(d => \{\s*const r = NAV\.windowOpen\(d\.url, \{ login: true \}\);/.test(fn('usageConnect')); })());   // the usage login window: sign-in popups as child windows
t('main.js: the usage display\'s login window and hidden reader go through guardNavigation + appLoad, the reader opens no window and has no preload',
  /guardNavigation\(wc, 'popup'\)/.test(fn('usageConnect')) && /appLoad\(wc, P\.pages\[0\]\)/.test(fn('usageConnect')) && /guardNavigation\(wc, 'probe'\)/.test(fn('usageWebReadNow'))
  && /wc\.setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\);/.test(fn('usageWebReadNow')) && /appLoad\(wc, url\)/.test(fn('usagePage')) && !/preload:/.test(fn('usageWebReadNow') + fn('usageConnect')));
t('main.js: the Grok bar\'s hidden read stays on grok.com (main-frame moves / redirects elsewhere stopped), opens no window, has no preload',
  /wc\.setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\);/.test(fn('grokRefresh')) && /const stay = \(e, url\) => \{ if \(GB\.navOk\(url\)\) return; e\.preventDefault\(\);/.test(fn('grokRefresh'))
  && /wc\.on\('will-navigate'[^\n]*stay\(e,/.test(fn('grokRefresh')) && /wc\.on\('will-redirect'[^\n]*stay\(e,/.test(fn('grokRefresh')) && !/preload:/.test(fn('grokRefresh')) && /appLoad\(wc, GB\.HOME\)/.test(fn('grokRefresh')));
t('main.js: linkOpen asks the policy and follows it (browser: openExt with the click / key for mailto; no window of its own for other sites)', /const r = NAV\.windowOpen\(d\.url, \{ popup: NAV\.popupFeatures\(d\.features\) \}\);/.test(fn('linkOpen'))
  && /if \(r\.action === 'browser'\) openExt\(d\.url, 'external-browser', recentGesture\(wc\)\);/.test(fn('linkOpen')) && count(fn('linkOpen'), /return childWin\(\)/g) === 1 && /if \(r\.action === 'child'\) \{[^}]*return childWin\(\); \}/.test(fn('linkOpen'))
  && !/'system'/.test(fn('linkOpen') + fn('guardNavigation') + fn('usageConnect')));
t('main.js: guardNavigation covers will-navigate + will-redirect (main frame) through the policy, with the page it is on', /wc\.on\('will-navigate'[\s\S]*NAV\.navigate\(url, \{ pane: own, from: wc\.getURL\(\) \}\)[\s\S]*wc\.on\('will-redirect'[\s\S]*NAV\.redirect\(/.test(fn('guardNavigation'))
  && /if \(r\.action === 'allow'\) return;\s*e\.preventDefault\(\);\s*if \(r\.action === 'browser'\) openExt\(url, '[^']+', recentGesture\(wc\)\);/.test(fn('guardNavigation')) && /const own = kind === 'pane' \|\| kind === 'approve';/.test(fn('guardNavigation')));
t('main.js: guardNavigation on panes, the 承認Bot popup, the background check and windows pages open; the UI: guardUi', /setWindowOpenHandler\(d => linkOpen\(wc, d\)\);\s*guardNavigation\(wc\);/.test(main) && /guardNavigation\(wc, 'approve'\)/.test(main)
  && /guardNavigation\(wc, 'probe'\)/.test(fn('probePane')) && /guardNavigation\(cw, 'popup'\)/.test(main) && /guardUi\(win\.webContents\)/.test(main) && /guardUi\(overlay\.webContents\)/.test(main));
t('main.js: the click / key comes from the browser (input-event), not from the page', /wc\.on\('input-event', \(e, i\) => \{ if \(NAV\.isGesture\(i && i\.type\)\) gestureAt\.set\(id, Date\.now\(\)\); \}\);/.test(fn('trackGesture')) && !/gestureAt\.set/.test(main.replace(fn('trackGesture'), '')));
t('main.js: a new / restored pane and the address bar refuse what appLoad refuses (new pane -> new tab; address bar -> nothing)', /url: paneStart\(normalize\(spec\.url\)\)/.test(fn('addPane')) && /if \(paneStart\(u\) !== u\) \{ navBlocked\([^}]*return; \}[^\n]*\n\s*guardRun\(/.test(fn('openIn')));
t('main.js: the link menu opens only what the policy allows (explicit choice)', /enabled: panes\.length < MAX && !NAV\.appLoad\(params\.linkURL\)/.test(main) && /openExt\(params\.linkURL, 'link menu', true\)/.test(main) && /openExt\(paneUrl\(p\), 'pane menu'\)/.test(main));
t('main.js: refusals record a fixed code only', /diag\.rec\('nav\.block', code, \{ p: p && p\.id \}, 60000\);/.test(fn('navBlocked')) && !/dlog\([^\n]*\burl\b/.test(fn('navBlocked')));
t('main.js: every page, including the tooltip, keeps sandbox and isolation', count(main, /contextIsolation: true, nodeIntegration: false, sandbox: true/g) === 11   // + the 進捗サイドバー
  && /guardUi\(tipWindow\.webContents\)/.test(fn('prepareTip')) && /preload: path\.join\(__dirname, 'tooltip-preload\.js'\), contextIsolation: true, nodeIntegration: false, sandbox: true/.test(fn('prepareTip'))
  && !/sandbox: false|nodeIntegration: true|contextIsolation: false|webSecurity: false|allowRunningInsecureContent/.test(main));

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
