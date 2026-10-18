// Navigation / link / external-open policy (#72): where a page may take itself, what main itself may load, and what is handed to the default
// browser or a system app. Pure (no electron) so plain Node tests cover it. Every decision parses the URL with WHATWG URL and compares its scheme
// and hostname - exact, or at a sub-domain boundary; never a prefix / substring of the URL text - and refuses a URL with a user name / password.
// main.js asks it from setWindowOpenHandler (linkOpen), will-navigate / will-redirect (guardNavigation / guardUi), every loadURL it starts
// (appLoad) and shell.openExternal (openExt). Results: an action and / or a fixed reject code (never the URL).
const URL_MAX = 2 * 1024 * 1024;                 // = Chromium's own limit (url::kMaxURLChars)
const GROK = ['grok.com'];                       // the site a bot pane stays on
// sign-in / OAuth / payment hosts: their popup gets a real child window (window.opener keeps working) and a bot page may go there in the
// same frame (login redirects)
const AUTH = ['x.ai', 'x.com', 'twitter.com', 'google.com', 'googleusercontent.com', 'apple.com', 'github.com', 'microsoftonline.com', 'live.com',
  'microsoft.com', 'stripe.com', 'stripe.network', 'okta.com', 'auth0.com'];
const WEB = ['https:', 'http:'];
const SYSTEM = ['mailto:', 'tel:', 'sms:', 'facetime:'];   // the Mac's own app (Mail / phone / Messages / FaceTime), right after a click / key only
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
const popupFeatures = f => /(^|,)\s*(width|height|popup)\b/i.test(typeof f === 'string' ? f : '');
const R = (action, code = null) => ({ action, code });

// setWindowOpenHandler (target=_blank / window.open) of a pane / the 承認Bot popup; child: of a window a page opened (its links: the browser)
// -> action: 'system' (openExt checks the click / key) / 'child' (a real child window) / 'pane' (grok.com: this pane) / 'browser' / 'deny'
function windowOpen(raw, { popup = false, child = false } = {}) {
  const u = parse(raw); if (!u) return R('deny', 'E_URL');
  if (child) { const c = webCode(u); return c ? R('deny', c) : R('browser'); }
  if (SYSTEM.includes(u.protocol)) return R('system');
  if (u.protocol === 'blob:' || u.protocol === 'data:' || raw === 'about:blank') return R('child');   // previews / an empty window the page writes into
  const c = webCode(u); if (c) return R('deny', c);
  if (isGrokHost(u.hostname)) return R(popup ? 'child' : 'pane');
  if (popup || isAuthHost(u.hostname)) return R('child');
  return R('browser');
}
// will-navigate in a page's main frame (a link without target / a script / a dropped link or file)
// ui: the window's own UI / overlay (never moves); bot: the page is a grok.com/bot chat (an ordinary web link must not replace it)
// -> action: 'allow' / 'system' (openExt checks the click / key) / 'browser' / 'deny'
function navigate(raw, { bot = false, ui = false } = {}) {
  if (ui) return R('deny', 'E_UI');
  const u = parse(raw); if (!u) return R('deny', 'E_URL');
  if (SYSTEM.includes(u.protocol)) return R(bot ? 'system' : 'allow');   // other pages: as before (Chromium asks for openExternal, which is refused)
  if (u.protocol === 'blob:' || raw === 'about:blank') return R('allow');   // the page's own blob / an empty page, as before
  const c = webCode(u); if (c) return R('deny', c);                         // javascript: / file: / data: / chrome: / devtools: / view-source: / custom app schemes ...
  if (!bot || isGrokHost(u.hostname) || isAuthHost(u.hostname)) return R('allow');
  return R('browser');
}
// will-redirect of a page's main frame (server redirects): any web host (sign-in goes through many), no user name / password -> null | code
function redirect(raw) { const u = parse(raw); return u ? webCode(u) : 'E_URL'; }
// main's own loadURL (address bar / palette / favorites / restored or new panes / reload / wake / bot-page fixes / background check / sleep):
// web pages and the empty page only; the bundled pages are loaded with loadFile from fixed paths -> null | code
function appLoad(raw) { if (raw === 'about:blank') return null; const u = parse(raw); return u ? webCode(u) : 'E_URL'; }
// shell.openExternal: http(s) (the default browser); mailto / tel / sms / facetime only right after the user's click / key (gesture) or from
// main's own menu -> { href: the parsed URL to hand over ('' when refused), code }
function external(raw, { gesture = false } = {}) {
  const u = parse(raw); if (!u) return { href: '', code: 'E_URL' };
  if (SYSTEM.includes(u.protocol)) return gesture === true ? { href: u.href, code: null } : { href: '', code: 'E_GESTURE' };
  const c = webCode(u); return c ? { href: '', code: c } : { href: u.href, code: null };
}
const isGesture = type => GESTURES.includes(type);
const gestureOk = (at, now) => Number.isFinite(at) && at > 0 && Number.isFinite(now) && now >= at && now - at <= GESTURE_MS;

module.exports = { URL_MAX, GROK, AUTH, WEB, SYSTEM, GESTURE_MS, GESTURES, REJECT, parse, hostIn, isGrokHost, isAuthHost, popupFeatures,
  windowOpen, navigate, redirect, appLoad, external, isGesture, gestureOk };
