// node test/permission-policy.test.js — site permissions and downloads (#72): src/permission-policy.js allows only the permissions the app
// allowed before, for every site the panes show (as before #72), but only from a sound origin (https, or plain http on loopback; no user name)
// asking for its own page: a top frame of its top-level page's origin, a child frame of that origin (or grok.com inside grok.com), a worker.
// Never for the hidden background check (storage aside) or the app's own UI; everything else (a cross-origin child frame, a frame inside
// another site, an opaque / file / plain http origin, an unknown permission) is refused with a fixed code. Downloads: pages the user sees only,
// under a plain name. Contract with the real main.js: both handlers and will-download ask the policy with main's own registry role.
const fs = require('fs'), path = require('path');
const P = require('../src/permission-policy');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const G = 'https://grok.com', BOT = 'https://grok.com/bot/abc';
const PERMS = Object.keys(P.ALLOWED);
// a grok.com pane's top frame asking (check: origin as Electron gives it, with a trailing slash)
const q = o => ({ role: 'pane', origin: G + '/', main: true, top: BOT, ...o });
const D = (perm, o) => P.decide(perm, q(o));

// ---- allowed: what the app allowed before, for every site's own page ----
t('the allowed set = the one the app had before #72 (no permission added)', J(PERMS.sort()) === J(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media', 'notifications', 'persistent-storage', 'storage-access', 'top-level-storage-access']));
t('every allowed permission: a grok.com pane, top frame (check: origin / request: requesting URL)', PERMS.every(p => D(p) === null && D(p, { origin: BOT }) === null && D(p, { origin: G }) === null));
// the regression this guards: before #72 every site got these; a pane of another site must keep its copy button / paste / notifications / mic
const SITES = [['https://chatgpt.com/', 'https://chatgpt.com/c/abc'], ['https://gemini.google.com/', 'https://gemini.google.com/app/1'], ['https://claude.ai/', 'https://claude.ai/chat/x'],
  ['https://www.perplexity.ai/', 'https://www.perplexity.ai/search?q=1'], ['https://example.com:8443/', 'https://example.com:8443/x'], ['https://grok.com.evil.com/', 'https://grok.com.evil.com/x']];
t(`every allowed permission: another site's pane, top frame of its own page (${SITES.length} sites; check origin / request URL)`, PERMS.every(p => SITES.every(([o, top]) =>
  D(p, { origin: o, top }) === null && D(p, { origin: top, top }) === null && D(p, { origin: o, top, embedding: o }) === null)));
t('the 承認Bot popup and a window a page opened (grok.com / another site / a sign-in window): the same', PERMS.every(p => D(p, { role: 'approve' }) === null && D(p, { role: 'popup', top: 'https://grok.com/share/x' }) === null
  && D(p, { role: 'popup', origin: 'https://accounts.google.com/', top: 'https://accounts.google.com/o/oauth2' }) === null));
t('a same-origin child frame of another site\'s page', PERMS.every(p => D(p, { main: false, origin: 'https://claude.ai/', top: 'https://claude.ai/chat/x' }) === null
  && D(p, { main: false, origin: 'https://chatgpt.com/embed/1', top: 'https://chatgpt.com/c/1', embedding: 'https://chatgpt.com' }) === null));
t('grok.com sub-domains: a top frame of its own page / a child frame inside a grok.com page', D('clipboard-sanitized-write', { origin: 'https://assets.grok.com', top: 'https://assets.grok.com/x' }) === null
  && D('clipboard-sanitized-write', { main: false, origin: 'https://assets.grok.com', top: 'https://www.grok.com/x' }) === null);
t('a grok.com child frame inside a grok.com page', D('clipboard-sanitized-write', { main: false, origin: 'https://grok.com/embed', embedding: G }) === null && D('notifications', { main: false, origin: 'https://x.grok.com' }) === null
  && D('notifications', { main: false, origin: 'https://x.grok.com', embedding: 'https://grok.com/' }) === null);
t('plain http on this Mac\'s loopback (a local dev server)', PERMS.every(p => [['http://localhost:3000/', 'http://localhost:3000/app'], ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/x'], ['http://[::1]:5173/', 'http://[::1]:5173/']]
  .every(([o, top]) => D(p, { origin: o, top }) === null && D(p, { main: false, origin: o, top }) === null)));
t('media: microphone / camera from grok.com (request types / check type)', D('media', { media: ['audio'] }) === null && D('media', { media: ['audio', 'video'] }) === null && D('media', { media: [] }) === null
  && ['audio', 'video', 'unknown', undefined, null].every(m => D('media', { media: m }) === null) && D('media', { origin2: G }) === null && D('media', { origin2: BOT }) === null);
t('media: microphone / camera from another site\'s page (voice input)', D('media', { origin: 'https://chatgpt.com/c/1', origin2: 'https://chatgpt.com/', top: 'https://chatgpt.com/c/1', media: ['audio'] }) === null
  && D('media', { origin: 'https://gemini.google.com/', top: 'https://gemini.google.com/app', media: 'audio' }) === null);
const W = o => ({ role: 'worker', main: false, top: '', ...o });
t('a worker (no page) of grok.com / another site / loopback: notifications / storage only', ['notifications', 'storage-access', 'persistent-storage'].every(p => ['https://grok.com/', 'https://chatgpt.com', 'http://localhost:3000']
  .every(o => P.decide(p, W({ origin: o })) === null)) && ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media'].every(p => P.decide(p, W({ origin: G })) === 'E_ROLE'));
t('the background check: storage only (no notifications / clipboard / microphone / fullscreen)', ['storage-access', 'top-level-storage-access', 'persistent-storage'].every(p => D(p, { role: 'probe' }) === null)
  && ['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media'].every(p => D(p, { role: 'probe' }) === 'E_ROLE'));

// ---- refused ----
const UNKNOWN = ['geolocation', 'midi', 'midiSysex', 'openExternal', 'hid', 'serial', 'usb', 'unknown', 'pointerLock', 'keyboardLock', 'idle-detection', 'display-capture', 'window-management', 'fileSystem',
  'deprecated-sync-clipboard-read', 'speaker-selection', 'local-fonts', '__proto__', 'toString', 'constructor', 'hasOwnProperty', '', 'Notifications', 5, null, undefined];
t(`unknown / inherited / other permissions -> E_PERM, even from grok.com / another site (${UNKNOWN.length})`, UNKNOWN.every(p => D(p) === 'E_PERM' && D(p, { origin: 'https://chatgpt.com', top: 'https://chatgpt.com/' }) === 'E_PERM'));
t('the app\'s own UI / an unknown role / no query -> E_ROLE', PERMS.every(p => ['chrome', 'overlay', 'admin', '', null, undefined, 5].every(r => D(p, { role: r }) === 'E_ROLE') && P.decide(p, null) === 'E_ROLE' && P.decide(p) === 'E_ROLE'));
const BAD_ORIGIN = ['http://grok.com', 'http://example.com', 'http://192.168.0.1:3000', 'http://0.0.0.0', 'http://127.0.0.2', 'http://foo.localhost', 'http://localhost.evil.com', 'http://[::2]',
  'https://user@grok.com', 'https://u:p@grok.com', 'https://u@chatgpt.com', 'http://u:p@localhost', 'null', '', undefined, null, 5, {}, 'file:///Users/x/newtab.html', 'blob:https://grok.com/1',
  'data:text/html,x', 'about:blank', 'about:srcdoc', 'chrome://settings', 'chrome-extension://abc/x', 'wss://grok.com', 'ftp://example.com', 'javascript:alert(1)', 'https://', 'grok.com', '//grok.com'];
t(`top frame with an opaque / missing / plain http / file / user-name origin -> E_ORIGIN (${BAD_ORIGIN.length})`, PERMS.every(p => BAD_ORIGIN.every(o => D(p, { origin: o, top: typeof o === 'string' && o ? o : BOT }) === 'E_ORIGIN')));
t('a worker with such an origin -> E_ORIGIN', ['null', 'http://example.com', 'file:///x', 'https://u@chatgpt.com', ''].every(o => P.decide('notifications', W({ origin: o })) === 'E_ORIGIN'));
const XFRAME = ['https://accounts.google.com', 'https://challenges.cloudflare.com', 'https://googleads.g.doubleclick.net/x', 'https://www.youtube.com/embed/1', 'https://evilgrok.com', 'https://grok.com.evil.com',
  'https://xn--grk-sqa.com', 'https://grok.com:8443', 'https://grok.com.', 'http://grok.com', 'http://localhost:3000', 'null', ''];
t(`a cross-origin child frame inside grok.com -> E_FRAME (sign-in / challenge / ad / embed / look-alike; ${XFRAME.length})`, PERMS.every(p => XFRAME.every(o => D(p, { main: false, origin: o, embedding: G }) === 'E_FRAME' && D(p, { main: false, origin: o }) === 'E_FRAME')));
t('a cross-origin child frame inside another site -> E_FRAME (sub-domains of another site do not count)', PERMS.every(p => [['https://challenges.cloudflare.com', 'https://chatgpt.com/c/1'], ['https://cdn.claude.ai', 'https://claude.ai/chat/x'],
  ['https://claude.ai', 'https://www.claude.ai/'], ['https://grok.com', 'https://chatgpt.com/'], ['https://assets.grok.com', 'https://chatgpt.com/'], ['http://localhost:3001', 'http://localhost:3000/']]
  .every(([o, top]) => D(p, { main: false, origin: o, top }) === 'E_FRAME')));
t('the grok.com child frame exception is exact: a look-alike page / non-default port is not grok.com', PERMS.every(p => D(p, { main: false, origin: 'https://assets.grok.com', top: 'https://grok.com.evil.com/x' }) === 'E_FRAME'
  && D(p, { main: false, origin: 'https://assets.grok.com', top: 'https://evilgrok.com/' }) === 'E_FRAME' && D(p, { main: false, origin: 'https://grok.com', top: 'https://grok.com:8443/' }) === 'E_FRAME'
  && D(p, { main: false, origin: 'https://grok.com.evil.com', top: 'https://grok.com/' }) === 'E_FRAME') && !P.grokOrigin('https://grok.com.evil.com') && D('notifications', { origin: 'https://grok.com.evil.com', top: 'https://grok.com.evil.com/' }) === null);
t('a frame inside another site -> E_FRAME (embedding / top-level page)', PERMS.every(p => D(p, { main: false, origin: G, embedding: 'https://evil.example' }) === 'E_FRAME' && D(p, { main: false, origin: G, top: 'https://evil.example/x' }) === 'E_FRAME'
  && D(p, { main: false, origin: 'https://assets.grok.com', embedding: 'https://evil.example' }) === 'E_FRAME' && D(p, { main: false, origin: 'https://claude.ai/x', top: 'https://claude.ai/', embedding: 'https://evil.example' }) === 'E_FRAME'
  && ['null', 'https://u@grok.com', 'http://grok.com', 5].every(e => D(p, { main: false, origin: G, embedding: e }) === 'E_FRAME')));
t('a top frame must be the same origin as its top-level page (no grok.com sub-domain leeway for a top frame)', PERMS.every(p => D(p, { origin: 'https://chatgpt.com', top: BOT }) === 'E_FRAME' && D(p, { origin: G, top: 'https://chatgpt.com/' }) === 'E_FRAME'
  && D(p, { origin: 'https://assets.grok.com', top: BOT }) === 'E_FRAME' && D(p, { origin: 'http://localhost:3000', top: 'http://localhost:3001/' }) === 'E_FRAME' && D(p, { origin: 'https://example.com', top: 'http://example.com/' }) === 'E_FRAME'));
t('the top-level page must be a sound origin too', PERMS.every(p => ['about:blank', '', 'file:///x/newtab.html', 'https://u@grok.com/', undefined, 'null', 'http://grok.com/'].every(top => D(p, { top }) === 'E_FRAME' && D(p, { main: false, top }) === 'E_FRAME')));
t('main frame flag must be exactly true for the E_ORIGIN reading (else a child frame)', D('fullscreen', { main: 1, origin: 'null' }) === 'E_FRAME' && D('fullscreen', { main: undefined, origin: 'null' }) === 'E_FRAME'
  && D('fullscreen', { main: true, origin: 'null' }) === 'E_ORIGIN' && D('fullscreen', { main: 'true', origin: 'https://e.com' }) === 'E_FRAME');
t('media: a second origin that is not the asking frame\'s -> E_ORIGIN / E_FRAME', D('media', { origin2: 'https://example.com' }) === 'E_ORIGIN' && D('media', { origin2: 'https://u@grok.com' }) === 'E_ORIGIN'
  && D('media', { main: false, origin2: 'null' }) === 'E_FRAME' && D('media', { origin: 'https://chatgpt.com', top: 'https://chatgpt.com/', origin2: G }) === 'E_ORIGIN');
t('media: unknown device types -> E_MEDIA (any site)', [['screen'], ['audio', 'screen'], ['window'], 'screen', 5, [5], {}].every(m => D('media', { media: m }) === 'E_MEDIA'
  && D('media', { origin: 'https://claude.ai', top: 'https://claude.ai/', media: m }) === 'E_MEDIA') && D('notifications', { media: ['screen'] }) === null);
t('order: permission before role before origin before page before media', P.decide('geolocation', { role: 'chrome', origin: 'null' }) === 'E_PERM' && D('media', { role: 'chrome', origin: 'null', media: ['x'] }) === 'E_ROLE'
  && D('media', { origin: 'null', top: 'https://e.com', media: ['x'] }) === 'E_ORIGIN' && D('media', { top: 'https://e.com', media: ['x'] }) === 'E_FRAME');
t('webOrigin: https (any host / port) or loopback http, no user name -> the origin; anything else -> \'\'', P.webOrigin('https://grok.com/bot/1') === G && P.webOrigin('https://grok.com:443/') === G
  && P.webOrigin('https://Example.COM:8443/x?y#z') === 'https://example.com:8443' && P.webOrigin('http://localhost:3000/a') === 'http://localhost:3000' && P.webOrigin('http://[::1]/') === 'http://[::1]'
  && P.webOrigin('http://127.0.0.1') === 'http://127.0.0.1' && BAD_ORIGIN.every(o => P.webOrigin(o) === ''));
const GROK_SPOOF = ['https://example.com', 'http://grok.com', 'https://evilgrok.com', 'https://grok.com.evil.com', 'https://grok.com:8443', 'https://user@grok.com', 'https://u:p@grok.com', 'https://xn--grk-sqa.com', 'https://grok.com.'];
t('grokOrigin: https grok.com / sub-domain, default port, no user name only', P.grokOrigin('https://grok.com') && P.grokOrigin('https://grok.com/') && P.grokOrigin('https://a.grok.com/x?y') && P.grokOrigin('https://grok.com:443/')
  && ![...GROK_SPOOF, ...BAD_ORIGIN].some(P.grokOrigin));

// ---- downloads ----
t('downloads: from pages the user sees (pane / 承認Bot / a window a page opened)', ['pane', 'approve', 'popup'].every(r => P.download(r) === null));
t('downloads: not from the background check, the app\'s UI, no page / unknown role', ['probe', 'chrome', 'overlay', 'worker', 'admin', '', null, undefined, '__proto__'].every(r => P.download(r) === 'E_DOWNLOAD'));
const NAMES = [
  ['report.pdf', 'report.pdf'], ['画像 (1).png', '画像 (1).png'], ['../../../.ssh/authorized_keys', 'authorized_keys'], ['..\\..\\evil.command', 'evil.command'], ['/etc/passwd', 'passwd'],
  ['.zshrc', 'zshrc'], ['..', 'download'], ['.', 'download'], ['', 'download'], [undefined, 'download'], [null, 'download'], [5, 'download'], ['   ', 'download'], ['...pdf', 'pdf'],
  ['invoice‮fdp.exe', 'invoicefdp.exe'], ['a​b﻿.txt', 'ab.txt'], ['line\nbreak\r.txt', 'linebreak.txt'], ['tab\there.txt', 'tabhere.txt'], ['nul\u0000.txt', 'nul.txt'], ['a:b.txt', 'a_b.txt'],
  ['trailing. ', 'trailing'], ['dir/', 'download'], ['x.app/Contents/MacOS/run', 'run'],
];
t(`downloadName: a plain name in the folder (${NAMES.length} cases)`, NAMES.every(([i, o]) => { const r = P.downloadName(i); if (r !== o) console.log('   ', J(i), '->', J(r), 'expected', J(o)); return r === o; }));
t('downloadName: never a folder part, a hidden / dot name, a control or invisible character', [...NAMES.map(n => n[0]), 'a/b\\c:d', '‮⁦x', '.' + 'a'.repeat(300)].every(i => {
  const r = P.downloadName(i); return typeof r === 'string' && r.length > 0 && !/[\/\\:]/.test(r) && !/^[.\s]|[.\s]$/.test(r) && !/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/.test(r) && r !== '.' && r !== '..'; }));
{ const long = 'あ'.repeat(300) + '.pdf', r = P.downloadName(long), r2 = P.downloadName('x'.repeat(1000)), r3 = P.downloadName('😀'.repeat(100) + '.verylongextension1234');
  t('downloadName: at most NAME_MAX bytes, whole characters, the extension kept', Buffer.byteLength(r) <= P.NAME_MAX && r.endsWith('.pdf') && /^あ+\.pdf$/.test(r) && Buffer.byteLength(r2) === P.NAME_MAX && !/�/.test(r3) && Buffer.byteLength(r3) <= P.NAME_MAX && [...r3].every(c => c === '😀' || c === '.' || /\w/.test(c))); }

// ---- codes ----
{ const all = [];
  for (const p of [...PERMS, ...UNKNOWN]) for (const o of [{}, { role: 'probe' }, { role: 'chrome' }, { origin: 'null' }, { main: false, origin: 'https://e.com' }, { top: 'https://e.com' }, { media: ['x'] }, { role: 'worker', top: '' }]) all.push(D(p, o));
  for (const r of ['pane', 'probe', null]) all.push(P.download(r));
  const seen = new Set(all.filter(Boolean));
  t('results are null or a known code (never an origin / URL)', all.every(c => c === null || Object.hasOwn(P.REJECT, c)));
  t(`every reject code is reachable (${[...seen].sort().join(' ')})`, Object.keys(P.REJECT).every(k => seen.has(k)));
  t('codes are fixed E_* strings with a short Japanese reason', Object.entries(P.REJECT).every(([k, v]) => /^E_[A-Z]+$/.test(k) && typeof v === 'string' && v.length <= 30 && /[぀-ヿ一-鿿]/.test(v) && !/[{}$]/.test(v))); }

// ======================= contract with the real main.js =======================
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const ready = main.slice(main.indexOf('app.whenReady().then('), main.indexOf('startup();', main.indexOf('app.whenReady().then(')));
t('main.js: both the request and the check handler are set, and both ask PERM.decide', /setPermissionRequestHandler\(\(wc, perm, cb, d = \{\}\) => \{\s*const code = PERM\.decide\(perm, \{ role: permRole\(wc\), origin: d\.requestingUrl, origin2: d\.securityOrigin, main: d\.isMainFrame, top: topUrl\(wc\), media: d\.mediaTypes \}\);[\s\S]*?cb\(!code\);/.test(ready)
  && /setPermissionCheckHandler\(\(wc, perm, origin, d = \{\}\) =>\s*!permDenied\(perm, PERM\.decide\(perm, \{ role: permRole\(wc\), origin, main: d\.isMainFrame, top: wc \? topUrl\(wc\) : '', embedding: d\.embeddingOrigin, media: d\.mediaType \}\), wc\)\);/.test(ready));
// 使用量表示 (usage-web.js): the app's own login partitions (persist:usage-*) get the same two handlers, asking PERM.decide as the background
// check ('probe': storage only), in usageSes; no other handler
const fnOf = name => { const i = main.indexOf(`function ${name}(`); if (i < 0) return ''; let d = 0, j = main.indexOf('{', main.indexOf(')', i)); for (; j < main.length; j++) { if (main[j] === '{') d++; else if (main[j] === '}' && --d === 0) break; } return main.slice(i, j + 1); };
const uses = fnOf('usageSes');
t('main.js: no other permission decision (no fixed allow list, no other handler)', !/const allowed = new Set|allowed\.has\(/.test(main) && (main.match(/setPermission\w+Handler\(/g) || []).length === 4 && !/setDevicePermissionHandler|setDisplayMediaRequestHandler/.test(main)
  && (uses.match(/setPermission\w+Handler\(/g) || []).length === 2 && (uses.match(/!PERM\.decide\(perm, \{ role,/g) || []).length === 2 && /const role = 'probe';/.test(uses));
t('main.js: the usage login partitions: no download, Chrome\'s user agent', /ses\.on\('will-download', e => e\.preventDefault\(\)\);/.test(uses) && /ses\.setUserAgent\(chromeUA\(\)\);/.test(uses));
t('main.js: the role comes from main\'s registry (not registered: a window a page opened; no page: a worker)', /const permRole = wc => \{ if \(!wc\) return 'worker'; try \{ const r = wcReg\.get\(wc\.id\); return r && r\.wc === wc \? r\.role : 'popup'; \} catch \{ return 'popup'; \} \};/.test(ready));
t('main.js: will-download asks PERM.download (cancels otherwise) and saves under PERM.downloadName in ~/Downloads, never opened by itself', /on\('will-download', \(e, item, wc\) => \{\s*if \(permDenied\('download', PERM\.download\(permRole\(wc\)\), wc\)\) \{ e\.preventDefault\(\); return; \}\s*const dir = app\.getPath\('downloads'\); const name = PERM\.downloadName\(item\.getFilename\(\)\);/.test(ready)
  && /item\.setSavePath\(dest\)/.test(ready) && !/shell\.openPath|openExternal\(dest|\.openItem/.test(main) && /shell\.showItemInFolder\(dest\)/.test(ready));
t('main.js: a refusal records a fixed code only (no origin / URL)', /diag\.rec\('perm\.deny', code, \{ p: p && p\.id \}, 600000\);/.test(ready) && !/dlog\('permission'[^\n]*(origin|getURL|requestingUrl)/.test(ready));
// panes / UI / background check / 承認Bot / the Grok bar's read: the shared default session. The only other sessions are the usage display's own
// login partitions (usage-web.js PROV: persist:usage-<kind>), opened in usageSes and used only by its login window and its hidden reader
{ const U = require('../src/usage-web');
  const parts = [...main.matchAll(/partition:\s*([^,}]+)/g)].map(m => m[1].trim());
  t('main.js: the session is the shared default session except the usage login partitions', parts.length === 2 && parts.every(p => p === 'P.partition')
    && (main.match(/session\.fromPartition\(/g) || []).length === 1 && /session\.fromPartition\(UW\.PROV\[k\]\.partition\)/.test(uses) && !/fromPath\(/.test(main)
    && ['usageWebReadNow', 'usageConnect'].every(f => /partition: P\.partition/.test(fnOf(f)))
    && Object.values(U.PROV).every(p => /^persist:usage-[a-z]+$/.test(p.partition)) && new Set(Object.values(U.PROV).map(p => p.partition)).size === Object.keys(U.PROV).length); }

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
