// node test/sidebar-ipc.test.js — 進捗サイドバー and the IPC boundary: only the sidebar's own page (role 'sidebar', top frame, the origin main created
// its view for) may send 'sidebar:focus-bot' with one name (string, up to 80 characters), and it may send nothing else; sidebar-preload.js
// exposes exactly window.xgBotsSidebar.focusBot; main creates the view sandboxed in its own partition, never as a pane.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { pathToFileURL } = require('url');
const P = require('../src/ipc-policy');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const SRC = path.join(__dirname, '..', 'src'), read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const frame = (url, origin, extra) => ({ top: true, detached: false, url, origin, ...extra });
const ORIGIN = 'https://example.com';
const SIDE = { role: 'sidebar', origin: ORIGIN, frame: frame('https://example.com/#/p/sidebar', ORIGIN) };
const as = (s, f, o) => ({ ...s, ...o, frame: { ...s.frame, ...f } });
const W = { owned: true, pane: i => [1, 2].includes(i), fav: () => false, gbot: () => false, ws: () => false, winPane: () => false };
const chk = (ch, who, args, w = W) => P.check(ch, who, args, w);
const CH = 'sidebar:focus-bot';

t('sidebar is a known role', P.ROLES.includes('sidebar'));
t('focus-bot: a name from the sidebar\'s own page -> allowed', chk(CH, SIDE, ['Grok Bot']) === null && chk(CH, SIDE, ['x'.repeat(80)]) === null && chk(CH, SIDE, ['作業 A']) === null);
t('focus-bot: a route / hash of the same origin is still its page', chk(CH, as(SIDE, { url: 'https://example.com/board?x=1#/p/2' }), ['a']) === null);
t('focus-bot: payload = one string, 1..80 characters, no control characters', [[], ['x'.repeat(81)], [''], ['  '], ['a\nb'], [5], [null], [{}], [['a']], ['a', 'b']].every(a => chk(CH, SIDE, a) === 'E_PAYLOAD'));
t('focus-bot: another origin / no origin from main / a non-web origin -> E_PAGE', [
  as(SIDE, { url: 'https://evil.example/', origin: 'https://evil.example' }), as(SIDE, { origin: 'https://example.com:444' }), as(SIDE, { origin: 'null' }),
  as(SIDE, {}, { origin: undefined }), as(SIDE, {}, { origin: '' }), as(SIDE, { origin: 'file://' }, { origin: 'file://' }), as(SIDE, {}, { origin: 'https://example.com/x' }),
  as(SIDE, { url: 'http://example.com/', origin: 'http://example.com' }, { origin: 'http://example.com' })].every(s => chk(CH, s, ['a']) === 'E_PAGE'));
t('focus-bot: a child frame / gone / detached frame -> E_FRAME', chk(CH, as(SIDE, { top: false }), ['a']) === 'E_FRAME' && chk(CH, { ...SIDE, frame: null }, ['a']) === 'E_FRAME'
  && chk(CH, as(SIDE, { detached: true }), ['a']) === 'E_FRAME');
t('focus-bot: its window closed -> E_OWNER', chk(CH, SIDE, ['a'], { ...W, owned: false }) === 'E_OWNER' && chk(CH, SIDE, ['a'], null) === 'E_OWNER');
t('focus-bot: no other page may send it (UI / panes / probe / 承認Bot / unregistered)', ['chrome', 'overlay', 'pane', 'probe', 'approve'].every(r => chk(CH, { role: r, origin: ORIGIN, frame: SIDE.frame }, ['a']) === 'E_ROLE')
  && chk(CH, { role: null, frame: SIDE.frame }, ['a']) === 'E_SENDER');
t('the sidebar may send nothing else (every other channel -> E_ROLE)', Object.keys(P.CHANNELS).filter(ch => ch !== CH).every(ch => chk(ch, SIDE, []) === 'E_ROLE'));
t('the sidebar cannot run overlay actions (settings, panes, its own URL)', ['sidebar-save', 'focus', 'open-new', 'approve-save'].every(type => chk('overlay-run', SIDE, [{ type, url: '', id: 1 }]) === 'E_ROLE'));
// the bar / overlay side
t('sidebar-toggle / resize-start / resize-reset: the window UI only, no payload', ['sidebar-toggle', 'sidebar-resize-start', 'sidebar-resize-reset'].every(ch => {
  const ui = { role: 'chrome', frame: frame(pathToFileURL(path.join(SRC, 'index.html')).href, 'file://') };
  return chk(ch, ui, []) === null && chk(ch, ui, [1]) === 'E_PAYLOAD' && ['overlay', 'pane', 'sidebar'].every(r => chk(ch, { ...ui, role: r }, []) === 'E_ROLE'); }));
{ const ov = { role: 'overlay', frame: frame(pathToFileURL(path.join(SRC, 'overlay.html')).href, 'file://') };
  t('sidebar-save: a usable URL or \'\' (none), nothing else', chk('overlay-run', ov, [{ type: 'sidebar-save', url: 'https://example.com/#/p/sidebar' }]) === null
    && chk('overlay-run', ov, [{ type: 'sidebar-save', url: '' }]) === null && chk('overlay-run', ov, [{ type: 'sidebar-save', url: 'http://localhost:5173/' }]) === null
    && ['http://example.com/', 'javascript:alert(1)', 'https://u:p@example.com/', 5, null, undefined].every(url => chk('overlay-run', ov, [{ type: 'sidebar-save', url }]) === 'E_PAYLOAD')
    && chk('overlay-run', ov, [{ type: 'sidebar-save', url: '', extra: 1 }]) === 'E_PAYLOAD'
    && chk('overlay-run', { ...ov, role: 'chrome', frame: frame(pathToFileURL(path.join(SRC, 'index.html')).href, 'file://') }, [{ type: 'sidebar-save', url: '' }]) === 'E_ROLE'); }

// ---- sidebar-preload.js, run like a sandboxed preload with a recording ipcRenderer ----
{ const sent = [], exposed = {}, other = [];
  const ipc = new Proxy({ send: (ch, ...a) => { sent.push([ch, a]); } }, { get: (o, k) => k in o ? o[k] : (...a) => { other.push(k); } });
  vm.runInNewContext(read('sidebar-preload.js'), { require: m => { if (m !== 'electron') throw new Error(`requires ${m}`); return { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: ipc }; } });
  const api = exposed.xgBotsSidebar;
  t('preload: exposes only window.xgBotsSidebar = { focusBot } (frozen)', Object.keys(exposed).join() === 'xgBotsSidebar' && Object.keys(api).join() === 'focusBot' && Object.isFrozen(api) && typeof api.focusBot === 'function');
  const r = api.focusBot('Grok Bot');
  t('preload: focusBot sends exactly one fixed channel with the name, returns nothing', r === undefined && sent.length === 1 && sent[0][0] === CH && sent[0][1].length === 1 && sent[0][1][0] === 'Grok Bot');
  api.focusBot(5); api.focusBot({ toString: () => 'x' }); api.focusBot('x'.repeat(81)); api.focusBot();
  t('preload: a non-string / too long name is not sent', sent.length === 1);
  api.focusBot('pane:msgcount');
  t('preload: a channel name as the argument is just data', sent.length === 2 && sent[1][0] === CH && sent[1][1][0] === 'pane:msgcount');
  t('preload: nothing but send is used (no listener, no invoke)', other.length === 0 && !/ipcRenderer\.(on|once|invoke|sendSync|sendTo)\b/.test(read('sidebar-preload.js')));
  t('preload: the channel it sends is in the policy for the sidebar only', P.CHANNELS[CH].roles.join() === 'sidebar'); }

// ---- main.js: the view, its registration and its limits ----
{ const main = read('main.js');
  const fn = name => { const i = main.indexOf(`function ${name}(`); if (i < 0) return ''; let d = 0, j = main.indexOf('{', main.indexOf(')', i)); for (; j < main.length; j++) { if (main[j] === '{') d++; else if (main[j] === '}' && --d === 0) break; } return main.slice(i, j + 1); };
  const ens = fn('ensureSide');
  t('main: the view is sandboxed, isolated, no Node, no webview, its own session and preload', /new WebContentsView\(\{ webPreferences: \{ session: sideSes\(\), preload: path\.join\(__dirname, 'sidebar-preload\.js'\),\s*contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false/.test(ens));
  t('main: sidebar-preload.js is used for this view only', (main.match(/'sidebar-preload\.js'/g) || []).length === 1);
  t('main: registered as role sidebar with the origin of the URL it loads (ipc-policy checks the page against it)', /regWc\(wc, 'sidebar', \{ ctx, origin: SR\.originOf\(url\) \}\)/.test(ens) && /origin: reg \? reg\.origin : undefined/.test(fn('ipcSender')));
  t('main: never a pane (no addPane / insertPane / panes[] / guard / sleep / queue in its code)', !/addPane|insertPane|panes\.push|guardRun|sleepPane|viewLoad|lq\./.test(ens + fn('sideSync') + fn('destroySide')));
  t('main: loads only the configured URL through appLoad; theme background; below the overlay', /appLoad\(wc, url\)/.test(ens) && /setBackgroundColor\(nativeTheme\.shouldUseDarkColors/.test(ens)
    && /if \(overlayOpen \|\| popOpen\) bringOverlayToFront\(\)/.test(ens) && /side\.setBackgroundColor\(color\)/.test(fn('updateViewBackgrounds')));
  t('main: stays on its origin (will-navigate / will-redirect), window.open never opens a window', /SR\.navOk\(u, url\)/.test(ens) && /wc\.on\('will-redirect'[\s\S]*?SR\.navOk\(/.test(ens)
    && /setWindowOpenHandler\(d => \{[^\n]*return \{ action: 'deny' \}; \}\)/.test(ens) && !/action: 'allow'/.test(ens));
  t('main: a link leaves only to the default browser, http(s), after the user\'s click', (ens.match(/openExt\(/g) || []).length === 2 && (ens.match(/SR\.httpUrl\([^)]*\) && recentGesture\(wc\)/g) || []).length === 2);
  t('main: focus-bot is gated (ipcOn), only right after a click / key in the sidebar and with no prompt open, and goes to focusPaneById (the chip\'s path)',
    /^ipcOn\('sidebar:focus-bot', \(r, name\) => \{ if \(recentGesture\(r\.wc\) && !r\.ctx\.overlayOpen\) sidebarFocusBot\(r\.ctx, name\);/m.test(main) && /trackGesture\(wc\)/.test(ens)
    && /hit\.c\.focusPaneById\(hit\.id\)/.test(fn('sidebarFocusBot')) && !/dlog\([^\n]*[,(]\s*name\b/.test(fn('sidebarFocusBot')));
  t('main: the pane area is narrowed in one place (areaNow) for every layout path', /const areaNow = \(\) => sideLay\(\)\.panes;/.test(main) && (main.match(/getContentSize\(\); return \{ x: GAP, y: TOPBAR \+ GAP/g) || []).length === 1);
  t('main: closed -> hidden, destroyed after SR.KEEP_MS; a window closing destroys it', /setTimeout\(\(\) => \{ sideTimer = null; if \(!SR\.view\(settings\)\.open\) destroySide\(\); \}, SR\.KEEP_MS\)/.test(fn('sideSync'))
    && /try \{ destroySide\(\); \} catch \{\}/.test(main) && /wc\.close\(\)/.test(fn('destroySide')) && /unregWc\(r => r\.wc === wc\)/.test(fn('destroySide')));
  t('main: nothing polls for it (only the edge drag follows the cursor while held, 60 s at most)', !/setInterval/.test(fn('sideSync') + ens + fn('destroySide') + fn('sidebarFocusBot') + fn('sidePlace'))
    && (fn('sideResizeStart').match(/setInterval\(/g) || []).length === 1 && /Date\.now\(\) - d\.t0 > 60000/.test(fn('sideResizeStart')) && /clearInterval\(d\.timer\)/.test(fn('sideResizeEnd')));
  t('main: the Grok usage read never uses the sidebar\'s page', /wcReg\.get\(w\.id\)\?\.role !== 'sidebar'/.test(fn('fetchUsage'))); }

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
