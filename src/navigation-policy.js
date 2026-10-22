// Navigation / link / external-open policy (#72): where a page may take itself, what main itself may load, and what is handed to the default
// browser or the mail app. Pure (no electron) so plain Node tests cover it. Every decision parses the URL with WHATWG URL and compares its scheme
// and hostname - exact, or at a sub-domain boundary; never a prefix / substring of the URL text - and refuses a URL with a user name / password.
// main.js asks it from setWindowOpenHandler (linkOpen), will-navigate / will-redirect (guardNavigation / guardUi), every loadURL it starts
// (appLoad) and shell.openExternal (openExt). Results: an action and / or a fixed reject code (never the URL).
const URL_MAX = 2 * 1024 * 1024;                 // = Chromium's own limit (url::kMaxURLChars)
const GROK = ['grok.com'];                       // the site a bot pane stays on
// sign-in / OAuth / payment hosts: a popup to them (window features) gets a real child window (window.opener keeps working) and a grok.com
// page may go there in the same frame (login redirects); a plain link to them goes to the default browser like any other
const AUTH = ['x.ai', 'x.com', 'twitter.com', 'google.com', 'googleusercontent.com', 'apple.com', 'github.com', 'microsoftonline.com', 'live.com',
  'microsoft.com', 'stripe.com', 'stripe.network', 'okta.com', 'auth0.com'];
const WEB = ['https:', 'http:'];
const MAIL = ['mailto:'];                        // the Mac's mail app, right after a click / key only; tel: / sms: / facetime: / other app schemes: never
const GESTURE_MS = 5000;                         // a click / key this recent counts as the user's (= Chromium's transient user activation)
const GESTURES = ['mouseDown', 'mouseUp', 'rawKeyDown', 'keyDown', 'gestureTap', 'touchEnd'];   // webContents 'input-event' types (from the browser, not the page)

// reject codes: fixed, short Japanese reason; never the URL, a host or a name
const REJECT = {
  E_URL: '解釈できないURL',
  E_USERINFO: 'ユーザー名・パスワード付きのURL',
  E_SCHEME: '許可していないスキーム',
  E_GESTURE: 'クリック・キー操作なしの外部アプリ起動',
  E_UI: 'アプリ画面の移動・新しいウィンドウ',
};

function parse(raw) {                                        // -> URL, or null (not a string / too long / not a URL)
  if (typeof raw !== 'string' || !raw || raw.length > URL_MAX) return null;
  try { return new URL(raw); } catch { return null; }
}
// WHATWG hostname (lower case, punycode, percent-decoded) is the domain itself or one of its sub-domains
const hostIn = (host, list) => typeof host === 'string' && !!host && list.some(d => host === d || host.endsWith('.' + d));
const isGrokHost = h => hostIn(h, GROK);
const isAuthHost = h => hostIn(h, AUTH);
const webCode = u => !WEB.includes(u.protocol) ? 'E_SCHEME' : u.username || u.password ? 'E_USERINFO' : null;   // http(s) always has a host
const isGrokPage = raw => { const u = parse(raw); return !!u && !webCode(u) && isGrokHost(u.hostname); };   // a page on grok.com (any path)
const popupFeatures = f => /(^|,)\s*(width|height|popup)\b/i.test(typeof f === 'string' ? f : '');
const R = (action, code = null) => ({ action, code });

// setWindowOpenHandler (target=_blank / window.open) of a pane / the 承認Bot popup. Only grok.com stays in the app (this pane; with window
// features: a child window) and a sign-in / OAuth / payment popup (window features + an AUTH host: a child window); every other web link - a
// plain link to x.com / google.com ... too - goes to the default browser, mailto to Mail (openExt checks the click / key).
// login: of a usage sign-in window (persist:usage-*: any web popup is its child window in the same partition, as before);
// child: of a window a page opened (its links: the browser)
// -> action: 'child' (a real child window) / 'pane' (grok.com: this pane) / 'browser' (openExt) / 'deny'
function windowOpen(raw, { popup = false, child = false, login = false } = {}) {
  const u = parse(raw); if (!u) return R('deny', 'E_URL');
  if (child) { const c = webCode(u); return c ? R('deny', c) : R('browser'); }
  if (MAIL.includes(u.protocol)) return R('browser');
  if (u.protocol === 'blob:' || u.protocol === 'data:' || raw === 'about:blank') return R('child');   // previews / an empty window the page writes into
  const c = webCode(u); if (c) return R('deny', c);                         // tel: / sms: / facetime: / javascript: / file: / custom app schemes ...
  if (login) return R('child');
  if (isGrokHost(u.hostname)) return R(popup ? 'child' : 'pane');
  if (popup && isAuthHost(u.hostname)) return R('child');
  return R('browser');
}
// will-navigate in a page's main frame (a link without target / a script / a dropped link or file)
// pane: a pane / the 承認Bot popup, from: the URL it shows now. On a grok.com page only grok.com and the sign-in hosts (login redirects) stay
// in the pane, any other web link goes to the default browser; a page the user opened elsewhere (address bar ...) browses freely as before.
// ui: the window's own UI / overlay (never moves)
// -> action: 'allow' / 'browser' (openExt: http(s) -> the default browser, mailto -> Mail after a click / key) / 'deny'
function navigate(raw, { pane = false, from = '', ui = false } = {}) {
  if (ui) return R('deny', 'E_UI');
  const u = parse(raw); if (!u) return R('deny', 'E_URL');
  if (MAIL.includes(u.protocol)) return pane ? R('browser') : R('deny', 'E_SCHEME');   // the background check / a window a page opened: no app
  if (u.protocol === 'blob:' || raw === 'about:blank') return R('allow');   // the page's own blob / an empty page, as before
  const c = webCode(u); if (c) return R('deny', c);                         // tel: / javascript: / file: / data: / chrome: / devtools: / view-source: / custom app schemes ...
  if (!pane || !isGrokPage(from) || isGrokHost(u.hostname) || isAuthHost(u.hostname)) return R('allow');
  return R('browser');
}
// will-redirect of a page's main frame (server redirects): any web host (sign-in goes through many), no user name / password -> null | code
function redirect(raw) { const u = parse(raw); return u ? webCode(u) : 'E_URL'; }
// main's own loadURL (address bar / palette / favorites / restored or new panes / reload / wake / bot-page fixes / background check / sleep):
// web pages and the empty page only; the bundled pages are loaded with loadFile from fixed paths -> null | code
function appLoad(raw) { if (raw === 'about:blank') return null; const u = parse(raw); return u ? webCode(u) : 'E_URL'; }
// shell.openExternal: http(s) (the default browser); mailto only right after the user's click / key (gesture) or from main's own menu;
// anything else (tel: / sms: / facetime: / file: / data: / custom app schemes ...) never -> { href: the parsed URL to hand over ('' when refused), code }
function external(raw, { gesture = false } = {}) {
  const u = parse(raw); if (!u) return { href: '', code: 'E_URL' };
  if (MAIL.includes(u.protocol)) return gesture === true ? { href: u.href, code: null } : { href: '', code: 'E_GESTURE' };
  const c = webCode(u); return c ? { href: '', code: c } : { href: u.href, code: null };
}
const isGesture = type => GESTURES.includes(type);
const gestureOk = (at, now) => Number.isFinite(at) && at > 0 && Number.isFinite(now) && now >= at && now - at <= GESTURE_MS;

module.exports = { URL_MAX, GROK, AUTH, WEB, MAIL, GESTURE_MS, GESTURES, REJECT, parse, hostIn, isGrokHost, isAuthHost, isGrokPage, popupFeatures,
  windowOpen, navigate, redirect, appLoad, external, isGesture, gestureOk };
