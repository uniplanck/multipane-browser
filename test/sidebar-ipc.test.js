// node test/sidebar-ipc.test.js — 進捗サイドバー and the IPC boundary: only the sidebar's own page (role 'sidebar', top frame, the origin main created
// its view for) may send 'sidebar:focus-bot' (one name, a string up to 80 characters), 'sidebar:jump' ({ name, agentId?: a UUID, open? } - never a
// URL), 'sidebar:get-state' / 'sidebar:open-settings' (no argument), and nothing else; sidebar-preload.js exposes exactly window.xgBotsSidebar
// { focusBot, jump, onState, getState, openSettings }; main creates the view sandboxed in its own partition, never as a pane, gates the jump like
// focus-bot, builds the only URL it opens from the UUID and tells the pane state to that sidebar view only.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { pathToFileURL } = require('url');
const P = require('../src/ipc-policy');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const SRC = path.join(__dirname, '..', 'src'), read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const frame = (url, origin, extra) => ({ top: true, detached: false, url, origin, ...extra });
const ORIGIN = 'https://example.com';
const SIDE = { role: 'sidebar', origin: ORIGIN, frame: frame('https://example.com/#/p/sidebar', ORIGIN) };
const as = (s, f, o) => ({ ...s, ...o, frame: { ...s.frame, ...f } });
const W = { owned: true, pane: i => [1, 2].includes(i), fav: () => false, gbot: () => false, ws: () => false, winPane: () => false };
const chk = (ch, who, args, w = W) => P.check(ch, who, args, w);
const CH = 'sidebar:focus-bot', JUMP = 'sidebar:jump', GET = 'sidebar:get-state', OPEN = 'sidebar:open-settings', SIDE_CH = [CH, JUMP, GET, OPEN];
const A1 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

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
t('the sidebar may send nothing else (every other channel -> E_ROLE)', Object.keys(P.CHANNELS).filter(ch => !SIDE_CH.includes(ch)).every(ch => chk(ch, SIDE, []) === 'E_ROLE'));
// jump / get-state / open-settings
t('jump: { name }, + a UUID agentId, + open (boolean) from the sidebar\'s own page -> allowed', [{ name: 'Grok Bot' }, { name: 'Grok Bot', agentId: A1 }, { name: 'Grok Bot', agentId: A1, open: true },
  { name: '作業 A', open: false }, { name: 'x'.repeat(80), agentId: A1 }].every(x => chk(JUMP, SIDE, [x]) === null));
t('jump: a URL / another key / a non-UUID agentId / a bad name / open not boolean / not one object -> E_PAYLOAD', [[{ name: 'a', url: 'https://grok.com/bot/' + A1 }], [{ name: 'a', agentId: 'https://evil.example/' }],
  [{ name: 'a', agentId: A1.toUpperCase() }], [{ name: 'a', agentId: 'abc' }], [{ name: 'a', agentId: 5 }], [{ name: 'a', open: 'true' }], [{ name: '' }], [{ name: 'x'.repeat(81) }], [{ name: 'a\nb' }],
  [{ agentId: A1 }], [], [{ name: 'a' }, { name: 'b' }], ['a'], [null], [[{ name: 'a' }]]].every(a => chk(JUMP, SIDE, a) === 'E_PAYLOAD'));
t('get-state / open-settings: no argument', chk(GET, SIDE, []) === null && chk(OPEN, SIDE, []) === null && chk(GET, SIDE, [1]) === 'E_PAYLOAD' && chk(OPEN, SIDE, [{}]) === 'E_PAYLOAD');
t('jump / get-state / open-settings: the same sender checks as focus-bot (origin, top frame, its window, the sidebar only)', [[JUMP, [{ name: 'a' }]], [GET, []], [OPEN, []]].every(([ch, a]) =>
  chk(ch, as(SIDE, { url: 'https://evil.example/', origin: 'https://evil.example' }), a) === 'E_PAGE' && chk(ch, as(SIDE, {}, { origin: undefined }), a) === 'E_PAGE'
  && chk(ch, as(SIDE, { top: false }), a) === 'E_FRAME' && chk(ch, SIDE, a, { ...W, owned: false }) === 'E_OWNER'
  && ['chrome', 'overlay', 'pane', 'probe', 'approve'].every(r => chk(ch, { role: r, origin: ORIGIN, frame: SIDE.frame }, a) === 'E_ROLE')));
t('the sidebar cannot run overlay actions (settings, panes, its own URL)', ['sidebar-save', 'focus', 'open-new', 'approve-save'].every(type => chk('overlay-run', SIDE, [{ type, url: '', id: 1 }]) === 'E_ROLE'));
// the bar / overlay side
t('sidebar-toggle / settings (right-click) / resize-start / resize-reset: the window UI only, no payload', ['sidebar-toggle', 'sidebar-settings', 'sidebar-resize-start', 'sidebar-resize-reset'].every(ch => {
  const ui = { role: 'chrome', frame: frame(pathToFileURL(path.join(SRC, 'index.html')).href, 'file://') };
  return chk(ch, ui, []) === null && chk(ch, ui, [1]) === 'E_PAYLOAD' && ['overlay', 'pane', 'sidebar'].every(r => chk(ch, { ...ui, role: r }, []) === 'E_ROLE'); }));
{ const ov = { role: 'overlay', frame: frame(pathToFileURL(path.join(SRC, 'overlay.html')).href, 'file://') };
  t('sidebar-save: a usable URL or \'\' (none), nothing else', chk('overlay-run', ov, [{ type: 'sidebar-save', url: 'https://example.com/#/p/sidebar' }]) === null
    && chk('overlay-run', ov, [{ type: 'sidebar-save', url: '' }]) === null && chk('overlay-run', ov, [{ type: 'sidebar-save', url: 'http://localhost:5173/' }]) === null
    && ['http://example.com/', 'javascript:alert(1)', 'https://u:p@example.com/', 5, null, undefined].every(url => chk('overlay-run', ov, [{ type: 'sidebar-save', url }]) === 'E_PAYLOAD')
    && chk('overlay-run', ov, [{ type: 'sidebar-save', url: '', extra: 1 }]) === 'E_PAYLOAD'
    && chk('overlay-run', ov, [{ type: 'sidebar-save', url: 'https://example.com/', confirm: false }]) === null && chk('overlay-run', ov, [{ type: 'sidebar-save', url: '', confirm: true }]) === null
    && ['yes', 1, null, {}].every(confirm => chk('overlay-run', ov, [{ type: 'sidebar-save', url: '', confirm }]) === 'E_PAYLOAD')
    && chk('overlay-run', { ...ov, role: 'chrome', frame: frame(pathToFileURL(path.join(SRC, 'index.html')).href, 'file://') }, [{ type: 'sidebar-save', url: '' }]) === 'E_ROLE'); }

// ---- sidebar-preload.js, run like a sandboxed preload with a recording ipcRenderer ----
const SRL = require('../src/sidebar-rules');
const tests = [];                                           // async checks, awaited before the summary
{ const sent = [], exposed = {}, listeners = {}, other = []; let reply = null;
  const ipc = new Proxy({ send: (ch, ...a) => { sent.push([ch, a]); }, invoke: (ch, ...a) => { sent.push([ch, a, 'invoke']); return typeof reply === 'function' ? reply(ch, a) : Promise.resolve(reply); },
    on: (ch, f) => { (listeners[ch] = listeners[ch] || []).push(f); } }, { get: (o, k) => k in o ? o[k] : (...a) => { other.push(k); } });
  vm.runInNewContext(read('sidebar-preload.js'), { require: m => { if (m !== 'electron') throw new Error(`requires ${m}`); return { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: ipc }; } });
  const api = exposed.xgBotsSidebar;
  t('preload: exposes only window.xgBotsSidebar = { focusBot, jump, onState, getState, openSettings } (frozen, functions)', Object.keys(exposed).join() === 'xgBotsSidebar'
    && Object.keys(api).join() === 'focusBot,jump,onState,getState,openSettings' && Object.isFrozen(api) && Object.values(api).every(f => typeof f === 'function'));
  const r = api.focusBot('Grok Bot');
  t('preload: focusBot sends exactly one fixed channel with the name, returns nothing', r === undefined && sent.length === 1 && sent[0][0] === CH && sent[0][1].length === 1 && sent[0][1][0] === 'Grok Bot');
  api.focusBot(5); api.focusBot({ toString: () => 'x' }); api.focusBot('x'.repeat(81)); api.focusBot();
  t('preload: a non-string / too long name is not sent', sent.length === 1);
  api.focusBot('pane:msgcount');
  t('preload: a channel name as the argument is just data', sent.length === 2 && sent[1][0] === CH && sent[1][1][0] === 'pane:msgcount');
  // jump
  sent.length = 0; reply = { result: 'opened' };
  const j1 = api.jump({ name: 'Grok Bot', agentId: A1.toUpperCase(), open: true, url: 'https://evil.example/', extra: 1 });
  t('preload: jump invokes its fixed channel with { name, agentId (lowercased), open: true } only - never a URL / other keys', sent.length === 1 && sent[0][0] === JUMP && sent[0][2] === 'invoke'
    && sent[0][1].length === 1 && J(sent[0][1][0]) === J({ name: 'Grok Bot', agentId: A1, open: true }) && P.check(JUMP, SIDE, sent[0][1], W) === null);
  tests.push(j1.then(v => t('preload: jump resolves { result } from main', J(v) === J({ result: 'opened' }))));
  sent.length = 0;
  api.jump({ name: 'Bot', agentId: 'not-a-uuid', open: 'yes' }); api.jump({ name: 'Bot', agentId: 5, open: 1 }); api.jump({ name: 'Bot', agentId: A1 + '0' });
  t('preload: a bad agentId is left out (ignored), open only when exactly true', sent.length === 3 && sent.every(m => J(m[1][0]) === J({ name: 'Bot' }) && P.check(JUMP, SIDE, m[1], W) === null));
  sent.length = 0;
  const bads = [api.jump({ name: 5 }), api.jump({ name: 'x'.repeat(81) }), api.jump(null), api.jump('Bot'), api.jump()];
  t('preload: a request without a usable name is not sent', sent.length === 0);
  tests.push(Promise.all(bads).then(v => t('preload: ...and resolves blocked', v.every(x => J(x) === J({ result: 'blocked' })))));
  for (const [rep, want] of [[null, 'blocked'], [{ result: 'evil' }, 'blocked'], [{ result: 'nomatch', more: 'x' }, 'nomatch'], ['focused', 'blocked'], [{ result: 'focused' }, 'focused']]) {
    reply = rep; tests.push(api.jump({ name: 'Bot' }).then(v => t(`preload: main's reply ${J(rep)} -> ${want} (only the known results, nothing else passed on)`, J(v) === J({ result: want })))); }
  reply = () => Promise.reject(new Error('gone'));
  tests.push(api.jump({ name: 'Bot' }).then(v => t('preload: a rejected invoke -> blocked', J(v) === J({ result: 'blocked' }))));
  // onState / getState
  const got = [], got2 = [];
  const off = api.onState(s => got.push(s)); api.onState(() => { throw new Error('page bug'); }); api.onState(s => got2.push(s));
  const st = { panes: [{ agentId: A1, names: ['Bot'], active: true }], confirmOpen: false }, EVENT = { sender: ipc, senderFrame: {}, ports: [] };
  t('preload: one listener on the fixed state channel', J(Object.keys(listeners)) === J(['sidebar:state']) && listeners['sidebar:state'].length === 1);
  listeners['sidebar:state'][0](EVENT, st, 'extra');
  t('preload: onState callbacks get the state only (never the IPC event / ipcRenderer); a throwing callback does not stop the others', got.length === 1 && got[0] === st && got2.length === 1
    && !got.flat().includes(EVENT));
  t('preload: onState returns an unsubscribe function; a non-function is ignored', typeof off === 'function' && (off(), listeners['sidebar:state'][0](EVENT, st), got.length === 1 && got2.length === 2)
    && typeof api.onState('x') === 'function');
  sent.length = 0; reply = st;
  { const g = api.getState(), m = sent[0];
    tests.push(g.then(v => t('preload: getState invokes its fixed channel without arguments and resolves the state', sent.length >= 1 && m[0] === GET && m[1].length === 0 && m[2] === 'invoke' && v === st))); }
  for (const rep of [null, 'x', { panes: 'x' }]) { reply = rep; tests.push(api.getState().then(v => t(`preload: getState with main's reply ${J(rep)} -> no panes, ask before opening`, J(v) === J({ panes: [], confirmOpen: true })))); }
  reply = () => Promise.reject(new Error('refused')); tests.push(api.getState().then(v => t('preload: getState refused -> no panes, ask before opening', J(v) === J({ panes: [], confirmOpen: true }))));
  sent.length = 0;
  t('preload: openSettings sends its fixed channel without arguments, returns nothing', api.openSettings('x', 1) === undefined && sent.length === 1 && sent[0][0] === OPEN && sent[0][1].length === 0 && !sent[0][2]);
  const code = read('sidebar-preload.js'), chans = [...code.matchAll(/ipcRenderer\.(\w+)\('([^']+)'/g)].map(m => [m[1], m[2]]);
  t('preload: only send / invoke / on, on fixed channels (no sendSync / sendTo / once / removeAllListeners, nothing else of ipcRenderer)', other.length === 0
    && !/ipcRenderer\.(sendSync|sendTo|sendToHost|once|removeAllListeners|postMessage)\b/.test(code) && chans.length === 5 && chans.every(([f]) => ['send', 'invoke', 'on'].includes(f)));
  t('preload: every channel it sends is in the policy for the sidebar only', chans.filter(([f]) => f !== 'on').every(([, ch]) => SIDE_CH.includes(ch) && P.CHANNELS[ch].roles.join() === 'sidebar')
    && J(SIDE_CH.slice().sort()) === J([...new Set(chans.filter(([f]) => f !== 'on').map(([, ch]) => ch))].sort()));
  t('preload: its UUID pattern / results = sidebar-rules.js', (() => { const m = code.match(/const AGENT = (\/.*\/);/), re = m && vm.runInNewContext(m[1]);
    return !!re && re.source === /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.source && [A1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'abc', A1.toUpperCase(), ''].every(v => re.test(v) === SRL.agentOk(v)); })()
    && code.includes(`const RESULTS = ${J(SRL.RESULTS).replace(/"/g, "'").replace(/,/g, ', ')};`)); }

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
    && /SR\.findBot\(name, sidePanes\(from\)\)/.test(fn('sidebarFocusBot')) && /sideShow\(from, hit\)/.test(fn('sidebarFocusBot')) && /hit\.c\.focusPaneById\(hit\.id\)/.test(fn('sideShow'))
    && !/dlog\([^\n]*[,(]\s*name\b/.test(fn('sidebarFocusBot')));
  const jmp = fn('sidebarJump');
  t('main: jump is answered by ipcHandle (the policy runs first) with { result } only', /^ipcHandle\('sidebar:jump', \(r, req\) => \(\{ result: sidebarJump\(r, req\) \}\)\);/m.test(main));
  t('main: jump: only right after a click / key in the sidebar and with no prompt open, else blocked (before anything is looked up)',
    /^function sidebarJump\(r, req\) \{\n  if \(!recentGesture\(r\.wc\) \|\| r\.ctx\.overlayOpen\) \{[^\n]*return 'blocked'; \}\n  const plan = SR\.jump\(req, sidePanes\(r\.ctx\)\);/m.test(jmp));
  t('main: jump: found -> shown as focus-bot does (its window in front) + the keyboard into its composer, in that pane\'s window',
    /if \(plan\.result === 'focused'\) \{ sideShow\(r\.ctx, plan\.key\); plan\.key\.c\.composerFocus\(plan\.key\.id\); \}/.test(jmp));
  t('main: jump: opened -> a new pane in the sender\'s window from plan.url (built by SR.jump from the UUID; nothing of req), full -> blocked',
    /const p = r\.ctx\.openBot\(plan\.url\);\n\s*if \(!p\) \{[^\n]*return 'blocked'; \}\n\s*r\.ctx\.composerFocus\(p\.id\);/.test(jmp) && !/req\./.test(jmp) && !/dlog\([^\n]*(req|name|plan\.url|plan\.key)\b[^\n]*\)/.test(jmp.replace(/dlog\('sidebar', 'jump', plan\.result\)/, '')));
  const ob = fn('openBot');
  t('main: openBot: the normal ＋ path (newPane: saved like any pane), never past MAX, never replacing a pane (no openIn)', /if \(panes\.length >= MAX\) return null;/.test(ob) && /const p = newPane\(url\);/.test(ob)
    && !/openIn|loadURL|appLoad/.test(ob) && /focusPane\(panes\.indexOf\(p\), \{ clear: false \}\)/.test(ob));
  const cf = fn('composerFocus');
  t('main: composerFocus: SR.FOCUS_JS in its own world (SR.WORLD), grok.com pages only, bounded (SR.JUMP_WAIT_MS, the script\'s wait + 1 s)',
    /executeJavaScriptInIsolatedWorld\(SR\.WORLD, \[\{ code: SR\.FOCUS_JS \}\]\)/.test(cf) && /SR\.composerPage\(wc\.getURL\(\)\)/.test(cf) && /setTimeout\(\(\) => end\('TIMEOUT'\), SR\.JUMP_WAIT_MS\)/.test(cf)
    && /sleep\(SR\.FOCUS_WAIT_MS \+ 1000\)/.test(cf) && !/setInterval/.test(cf) && (main.match(/code: SR\.FOCUS_JS/g) || []).length === 1);
  t('main: composerFocus: dropped when the user is elsewhere (another pane / the keyboard elsewhere / a prompt / a key typed / a newer jump / a click in the page)',
    /p\.cmpAt === at && panes\.includes\(p\) && !wc\.isDestroyed\(\) && panes\[focused\] === p && !overlayOpen && p\.inputRev === at\.rev\s*&& keyboardFocus === wc/.test(cf)
    && /if \(m\.type === 'mouseDown'\) p\.cmpAt = null;/.test(fn('addPane')) && /wc\.removeListener\('did-stop-loading', onStop\)/.test(cf) && /if \(windowActive\(\) && !wc\.isFocused\(\)\) wc\.focus\(\);/.test(cf));
  t('main: composerFocus waits for a load only while it is queued / running (a load settling in its slot: the page is there)',
    /const ready = \(\) => \{ const t = lqView\(p\); return !p\.sleeping && !\(t && t\.state === 'wait'\) && !wc\.isLoading\(\) && SR\.composerPage\(wc\.getURL\(\)\); \};/.test(cf));
  t('main: get-state is answered (ipcHandle) with SR.state of the sender\'s window; open-settings has the focus-bot gate',
    /^ipcHandle\('sidebar:get-state', r => sideState\(r\.ctx\)\);/m.test(main) && /^const sideState = from => SR\.state\(sidePanes\(from\), SR\.confirmOpen\(settings\)\);/m.test(main)
    && /^ipcOn\('sidebar:open-settings', r => \{ if \(recentGesture\(r\.wc\) && !r\.ctx\.overlayOpen\) r\.ctx\.openSidebarSettings\(\);/m.test(main));
  const push = fn('sidePush');
  t('main: the state goes to the sidebar view only (one send, on its own channel, from sidePush), when it changed / its page loaded',
    (main.match(/'sidebar:state'/g) || []).length === 1 && /const wc = side && side\.webContents;/.test(push) && /wc\.send\('sidebar:state', st\)/.test(push) && /if \(!force && js === sideSent\) return;/.test(push)
    && /wc\.on\('did-finish-load', \(\) => sidePush\(true\)\)/.test(ens) && /sideSent = ''/.test(fn('destroySide')));
  t('main: pushed 200 ms after any window\'s sendState (one timer for all; none without a sidebar URL); nothing polls',
    /scheduleOthers\(\);\n  sideStateSoon\(\);/.test(fn('sendState')) && /if \(sideStateTimer \|\| !SR\.view\(settings\)\.configured\) return;/.test(fn('sideStateSoon'))
    && /\}, 200\);/.test(fn('sideStateSoon')) && !/setInterval/.test(fn('sideStateSoon') + push));
  t('main: botNames hands over the URL (for SR.jump / SR.state) and which pane is active', /return \{ id: p\.id, url: u, active: i === focused,/.test(fn('botNames')));
  t('main: the right-click on the bar\'s button / the settings: sidebar-settings opens the screen; it gets the URL and 開く前に確認する; a save takes both',
    /^on\('sidebar-settings', \(\) => openSidebarSettings\(\)\);/m.test(main) && /sidebar: \{ url: SR\.view\(settings\)\.url, confirm: SR\.confirmOpen\(settings\) \}/.test(fn('openSidebarSettings'))
    && /setSidebarUrl\(a\.url, a\.confirm\)/.test(main) && /if \(typeof confirm === 'boolean'\) settings\.sidebarConfirmOpen = confirm;/.test(fn('setSidebarUrl')));
  t('renderer / preload: a right-click on #sidebar-btn opens the settings (no native menu)', /sideEl\.oncontextmenu = e => \{ e\.preventDefault\(\); mpb\.sidebarSettings\(\); \};/.test(read('renderer.js'))
    && /sidebarSettings: \(\) => send\('sidebar-settings'\)/.test(read('preload.js')));
  t('nothing personal in the app: no agentId / Bot URL in the sidebar code, the public default URL stays empty', !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(read('sidebar-rules.js') + read('sidebar-preload.js') + jmp + ob + cf + push)
    && !/sidebarUrl\s*[:=]\s*'https?:/.test(main));
  t('main: the pane area is narrowed in one place (areaNow) for every layout path', /const areaNow = \(\) => sideLay\(\)\.panes;/.test(main) && (main.match(/getContentSize\(\); return \{ x: GAP, y: TOPBAR \+ GAP/g) || []).length === 1);
  t('main: closed -> hidden, destroyed after SR.KEEP_MS; a window closing destroys it', /setTimeout\(\(\) => \{ sideTimer = null; if \(!SR\.view\(settings\)\.open\) destroySide\(\); \}, SR\.KEEP_MS\)/.test(fn('sideSync'))
    && /try \{ destroySide\(\); \} catch \{\}/.test(main) && /wc\.close\(\)/.test(fn('destroySide')) && /unregWc\(r => r\.wc === wc\)/.test(fn('destroySide')));
  t('main: nothing polls for it (only the edge drag follows the cursor while held, 60 s at most)', !/setInterval/.test(fn('sideSync') + ens + fn('destroySide') + fn('sidebarFocusBot') + fn('sidePlace'))
    && (fn('sideResizeStart').match(/setInterval\(/g) || []).length === 1 && /Date\.now\(\) - d\.t0 > 60000/.test(fn('sideResizeStart')) && /clearInterval\(d\.timer\)/.test(fn('sideResizeEnd')));
  t('main: the Grok usage read never uses the sidebar\'s page', /wcReg\.get\(w\.id\)\?\.role !== 'sidebar'/.test(fn('fetchUsage'))); }

Promise.all(tests).then(() => { console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0); });
