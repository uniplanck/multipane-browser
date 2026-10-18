// Site permissions and downloads (#72): which page may use what, and the name a download is saved under. Pure (no electron) so plain Node
// tests cover it. main.js asks it from session.setPermissionCheckHandler and setPermissionRequestHandler (both: Chromium checks first and asks
// only when the check says no) with the role of the asking page from its own registry (ipc-policy.js roles; 'popup' = a window a page opened,
// 'worker' = no page, e.g. a service worker), the asking frame's origin and the page's top-level URL - and from will-download.
// A permission is allowed only when it is one of those the app has always allowed, the role may have it, the asking frame's origin is a sound
// web origin (https, or plain http on this Mac's loopback; no user name) and it asks for its own page: a top frame of the same origin as its
// top-level page, a child frame of that same origin (or a grok.com frame inside a grok.com page; https, default port, sub-domains count), a
// worker. Any site the panes show (chatgpt.com, gemini, claude.ai, ...) keeps its copy buttons / paste / notifications / microphone. A
// cross-origin child frame (ad, embed, sign-in, challenge), a frame inside another site, an opaque ('null') / missing / file / plain http
// origin, an unknown permission: no. No prompt of its own: the answer is immediate.
// Results: null (allowed) or a fixed reject code (never an origin / URL / name).
const { hostIn, GROK } = require('./navigation-policy');

const PAGE = ['pane', 'approve', 'popup'];                 // pages the user sees
const STORE = [...PAGE, 'probe', 'worker'];                // + the hidden background check / a worker: storage only
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];      // the only hosts plain http may ask from (a local dev server)
// = the set the app allowed (for every site) before #72; still for every site, from a sound origin asking for its own page
const ALLOWED = {
  notifications: [...PAGE, 'worker'],                      // web notifications (also from grok.com's service worker)
  'clipboard-sanitized-write': PAGE, 'clipboard-read': PAGE,   // copy buttons / paste
  fullscreen: PAGE,
  media: PAGE,                                             // microphone / camera (voice)
  'storage-access': STORE, 'top-level-storage-access': STORE, 'persistent-storage': STORE,
};
const MEDIA = ['audio', 'video'];                          // request: mediaTypes; a check also says 'unknown'
const DOWNLOAD_ROLES = PAGE;                               // not the background check (nobody sees it), not the app's own UI
const NAME_MAX = 200;                                      // UTF-8 bytes of a saved name before ' (n)' (APFS allows 255)

const REJECT = {
  E_PERM: '許可していない権限',
  E_ROLE: 'この画面には許可していない権限',
  E_ORIGIN: 'https でない・不正なページからの要求',
  E_FRAME: 'トップページと別サイトのフレームからの要求',
  E_MEDIA: '許可していない種類のデバイス',
  E_DOWNLOAD: 'この画面からのダウンロード',
};

// an origin / URL string -> its origin ('https://host[:port]'), or '' when it is no sound web origin: not a URL ('null' = opaque), not https
// (plain http: loopback only), a user name / password, no host
function webOrigin(s) {
  if (typeof s !== 'string' || !s) return '';
  let u; try { u = new URL(s); } catch { return ''; }
  if (u.username || u.password || !u.hostname) return '';
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.includes(u.hostname)) ? u.origin : '';
}
function grokOrigin(s) {                                   // an origin / URL string: https://grok.com or a sub-domain, default port, no user name
  if (typeof s !== 'string' || !s) return false;
  let u; try { u = new URL(s); } catch { return false; }   // 'null' (opaque) is no URL
  return u.protocol === 'https:' && !u.port && !u.username && !u.password && hostIn(u.hostname, GROK);
}
const given = v => v !== undefined && v !== null && v !== '';
const mediaOk = m => !given(m) || (Array.isArray(m) ? m.every(t => MEDIA.includes(t)) : m === 'unknown' || MEDIA.includes(m));

// q: { role, origin: the asking frame's origin / URL, origin2?: the same said again (a media request's securityOrigin), main: the asking frame
//      is the top frame, top: the page's top-level URL ('' for a worker), embedding?: the frame around a cross-origin child frame,
//      media?: a request's types (array) / a check's type (string) } -> null | code
function decide(perm, q) {
  if (typeof perm !== 'string' || !Object.hasOwn(ALLOWED, perm)) return 'E_PERM';
  if (!q || typeof q !== 'object' || typeof q.role !== 'string' || !ALLOWED[perm].includes(q.role)) return 'E_ROLE';
  const worker = q.role === 'worker', main = !worker && q.main === true;
  const o = webOrigin(q.origin);
  if (!o || (given(q.origin2) && webOrigin(q.origin2) !== o)) return worker || main ? 'E_ORIGIN' : 'E_FRAME';
  const top = worker ? o : webOrigin(q.top);               // a worker has no page: its own origin stands in
  if (!top) return 'E_FRAME';
  if (o !== top && (main || !(grokOrigin(q.top) && grokOrigin(q.origin)))) return 'E_FRAME';   // a child frame: same origin, or grok.com in grok.com
  if (given(q.embedding) && webOrigin(q.embedding) !== top) return 'E_FRAME';
  if (perm === 'media' && !mediaOk(q.media)) return 'E_MEDIA';
  return null;
}
const download = role => typeof role === 'string' && DOWNLOAD_ROLES.includes(role) ? null : 'E_DOWNLOAD';

// the page's suggested file name -> a plain name in the Downloads folder: no folder part, no control / invisible characters (an extension
// disguised by a right-to-left override), no ':' (a folder separator in Finder), no leading / trailing dot or space (hidden, '.', '..'),
// at most NAME_MAX bytes (the extension kept); nothing left -> 'download'
const CTRL = /[\u0000-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[­؜᠎​-‏‪-‮⁠-⁩﻿]/g;
function downloadName(raw) {
  let s = typeof raw === 'string' ? raw.replace(CTRL, '').replace(INVISIBLE, '') : '';
  s = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1).replace(/:/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  if (!s) return 'download';
  if (Buffer.byteLength(s) <= NAME_MAX) return s;
  const dot = s.lastIndexOf('.'), ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
  let out = '', n = Buffer.byteLength(ext);
  for (const ch of s.slice(0, s.length - ext.length)) { const b = Buffer.byteLength(ch); if (n + b > NAME_MAX) break; out += ch; n += b; }   // whole characters only
  return (out.replace(/[\s.]+$/, '') || 'download') + ext;
}

module.exports = { ALLOWED, PAGE, MEDIA, LOOPBACK, DOWNLOAD_ROLES, NAME_MAX, REJECT, webOrigin, grokOrigin, decide, download, downloadName };
