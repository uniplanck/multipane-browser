// node test/ipc-policy.test.js — IPC boundary (#71): src/ipc-policy.js accepts a message only from a registered sender of an allowed role, in its
// top frame, on the bundled page / allowed origin, of a still-open window / pane, with a valid payload for an existing target of its own window;
// everything else gets a fixed reject code. Contract with the real sources: every channel main.js listens on is in the policy and goes through
// ipcOn / ipcHandle only, preload.js exposes fixed channels only (no ipcRenderer / event), and every call renderer.js / overlay.js make today
// (sent through the real preload.js) is allowed for that page's role.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { pathToFileURL } = require('url');
const P = require('../src/ipc-policy');
const { loadPreload } = require('./preload-sandbox');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const SRC = path.join(__dirname, '..', 'src'), read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const fileUrl = f => pathToFileURL(path.join(SRC, f)).href;
const frame = (url, origin, extra) => ({ top: true, detached: false, url, origin, ...extra });
const SND = {
  chrome: { role: 'chrome', frame: frame(fileUrl('index.html'), 'file://') },
  overlay: { role: 'overlay', frame: frame(fileUrl('overlay.html'), 'file://') },
  pane: { role: 'pane', frame: frame('https://grok.com/bot/abc', 'https://grok.com') },
  newtab: { role: 'pane', frame: frame(fileUrl('newtab.html'), 'file://') },
  web: { role: 'pane', frame: frame('https://example.com/a', 'https://example.com') },
  probe: { role: 'probe', frame: frame('https://grok.com/bot/abc', 'https://grok.com') },
  approve: { role: 'approve', frame: frame('https://grok.com/bot/abc', 'https://grok.com') },
  sidebar: { role: 'sidebar', origin: 'https://example.com', frame: frame('https://example.com/#/p/sidebar', 'https://example.com') },   // 進捗サイドバー (origin: main's registry)
};
const as = (who, f) => ({ ...SND[who], frame: { ...SND[who].frame, ...f } });
// the sender's window: panes 1, 2, 3 / favorites 1, 2 / Grok bar Bots 'b1', 'b-2' / workspace 'A'; another window (id 2) has pane 7
const world = (o = {}) => ({ owned: true, pane: i => [1, 2, 3].includes(i), fav: i => [1, 2].includes(i), gbot: i => ['b1', 'b-2'].includes(i), ws: n => Object.hasOwn({ A: 1 }, n), winPane: (w, p) => w === 2 && p === 7, ...o });
const W = world();
const chk = (ch, who, args = [], w = W) => P.check(ch, typeof who === 'string' ? SND[who] : who, args, w);
const ROLE_SENDER = { chrome: 'chrome', overlay: 'overlay', pane: 'pane', probe: 'probe', approve: 'approve', sidebar: 'sidebar' };
const CH = Object.keys(P.CHANNELS);

// ---- one valid message per channel, shaped like what the app sends today ----
const SNAPV = { cid: 'abc', conv: 'OK', roles: 'TESTID', latest: 'BOT', marker: 'WAIT', stable: 'QUIET', draft: 'EMPTY', name: 'H1', quote: 'BLOCK' };
const COUNT = { user: 3, bot: 5, botSince: 2, waiting: true, working: false, done: false, q: '依頼の引用', hn: 'Bot', hh: 'Bot', asks: true, method: 'bot-entry', fp: '1x2y3z.120', snap: SNAPV };
const SAMPLE = {
  'pane:draft-load': ['pane', [{ gen: 1, url: 'https://grok.com/bot/abc', rev: 0 }]],
  'pane:draft-save': ['pane', [{ gen: 1, url: 'https://grok.com/bot/abc', rev: 1, text: '下書き' }]],
  navigate: ['chrome', [1, 'https://grok.com/bot/abc']], 'set-reload': ['chrome', [1, 5]], swap: ['chrome', [1, 3]],
  'maximize-half': ['chrome', [1, 'left']],
  'dock-begin': ['chrome', [2]], 'dock-ready': ['chrome', [4]], 'dock-hover': ['chrome', [640, 300]], 'dock-drop': ['chrome', [12, 70]], 'dock-end': ['chrome', []],
  layout: ['chrome', ['2x2']], 'split-start': ['chrome', ['c', 1, undefined]], 'split-reset': ['chrome', ['r', undefined]], 'sync-cols': ['chrome', [true]],
  'fav-open': ['chrome', [1, 'here']], 'fav-menu': ['chrome', [2]], 'fav-move': ['chrome', [2, 1]], 'fav-add': ['chrome', ['https://example.com/', '']],
  'focus-other': ['chrome', [2, 7]], 'usage-pop-show': ['chrome', [{ right: 812.5, bottom: 36, kind: 'grok', sel: '' }]], 'usage-win-menu': ['chrome', ['codex', '']],
  'tip-show': ['chrome', [{ tip: { name: '戻る', description: '前のページへ戻ります。', key: '⌘[', detail: '', dark: true }, rect: { x: 3, y: 4, width: 20, height: 20 }, size: { width: 180, height: 60 }, preferSide: false }]],
  'tip-prepare': ['chrome', []], 'tip-hide': ['chrome', []],
  'approve-inline-open': ['chrome', [{ x: 700, y: 5, width: 28, height: 28 }]],
  'approve-inline-anchor': ['chrome', [{ x: 700, y: 5, width: 28, height: 28 }]],
  'usage-pop-leave': ['overlay', []], 'usage-pop-keep': ['overlay', []], 'usage-pop-size': ['overlay', [242]], 'overlay-close': ['overlay', []],
  'overlay-run': ['overlay', [{ type: 'focus', id: 2 }]], 'usage:get': ['overlay', [false]], 'usage:detail': ['chrome', []], 'usage:margin': ['overlay', [5]],
  'aiusage:get': ['chrome', ['claude', true]], 'claude:auth-dialog': ['chrome', []], 'usage-connect': ['chrome', ['kimi']], 'usage-open': ['overlay', ['antigravity']],
  'pane:msgcount': ['pane', [COUNT]], 'pane:draft': ['pane', [true]], 'pane:editing': ['pane', [false]], 'pane:ime': ['pane', [true]], 'pane:sel': ['pane', [true]],
  'gbot-open': ['chrome', ['b1', 'here']], 'gbot-menu': ['chrome', ['b-2']], 'gbot-move': ['chrome', ['b-2', 'b1']], 'pane:img-closed': ['pane', [true]],
  'gbar-sec-toggle': ['chrome', ['待機']],
  'sidebar:focus-bot': ['sidebar', ['Grok Bot']],
};
for (const ch of ['back', 'forward', 'copy-pane-url', 'reload', 'close', 'focus-pane', 'activate-pane', 'maximize', 'sleep-toggle', 'wake-pane', 'sleep-now', 'load-cancel', 'pane-menu', 'chip-menu', 'rename-pane']) SAMPLE[ch] = ['chrome', [1]];
for (const ch of ['add', 'reopen-closed', 'reload-all', 'ws-menu', 'approve-open', 'approve-keep-awake-toggle', 'palette', 'ready', 'save-retry', 'recovery-open', 'sync-reset', 'split-end', 'probe-resume', 'gbar-refresh', 'gbar-mode', 'sidebar-toggle', 'sidebar-resize-start', 'sidebar-resize-reset']) SAMPLE[ch] = ['chrome', []];
for (const ch of ['pane:pc-opened', 'pane:img-opened', 'pane:pc-closed', 'pane:msgmode-off', 'pane:mutation', 'pane:interact', 'pane:mouseup', 'pane:typing']) SAMPLE[ch] = ['pane', []];

// ---- allowed ----
t(`every channel has a sample (${CH.length} channels)`, CH.every(ch => SAMPLE[ch]) && Object.keys(SAMPLE).every(ch => P.CHANNELS[ch]));
t('every sample is allowed', CH.every(ch => chk(ch, SAMPLE[ch][0], SAMPLE[ch][1]) === null));
t('every role in a channel is a known role', CH.every(ch => P.CHANNELS[ch].roles.length && P.CHANNELS[ch].roles.every(r => P.ROLES.includes(r))));
t('the 承認Bot popup may not send anything', CH.every(ch => !P.CHANNELS[ch].roles.includes('approve')));
t('a probe may only report its message count', CH.filter(ch => P.CHANNELS[ch].roles.includes('probe')).join() === 'pane:msgcount');
t('panes / probe get no UI channel, the UI no pane channel', CH.every(ch => ch.startsWith('pane:') ? P.CHANNELS[ch].roles.every(r => r === 'pane' || r === 'probe') : ch.startsWith('sidebar:') ? P.CHANNELS[ch].roles.join() === 'sidebar' : P.CHANNELS[ch].roles.every(r => r === 'chrome' || r === 'overlay')));
t('the 進捗サイドバー may only ask to focus a Bot', CH.filter(ch => P.CHANNELS[ch].roles.includes('sidebar')).join() === 'sidebar:focus-bot');

// ---- sender: unregistered / wrong role ----
t('unregistered sender (no role) -> E_SENDER on every channel', CH.every(ch => chk(ch, { role: null, frame: SND.chrome.frame }, SAMPLE[ch][1]) === 'E_SENDER'));
t('no sender / unknown role -> E_SENDER', chk('add', undefined) === 'E_SENDER' && chk('add', { role: 'admin', frame: SND.chrome.frame }) === 'E_SENDER' && chk('add', { role: '__proto__', frame: SND.chrome.frame }) === 'E_SENDER');
t('every role not listed for a channel -> E_ROLE', CH.every(ch => P.ROLES.filter(r => !P.CHANNELS[ch].roles.includes(r)).every(r => chk(ch, ROLE_SENDER[r], SAMPLE[ch][1]) === 'E_ROLE')));
t('a web pane cannot change settings / other panes (UI channels)', ['navigate', 'close', 'layout', 'sync-cols', 'overlay-run', 'fav-add', 'focus-other', 'usage:margin', 'set-reload'].every(ch => chk(ch, 'pane', SAMPLE[ch][1]) === 'E_ROLE' && chk(ch, 'web', SAMPLE[ch][1]) === 'E_ROLE'));
t('the UI cannot fake pane signals', ['pane:msgcount', 'pane:interact', 'pane:draft'].every(ch => chk(ch, 'chrome', SAMPLE[ch][1]) === 'E_ROLE' && chk(ch, 'overlay', SAMPLE[ch][1]) === 'E_ROLE'));
t('chrome-only channels from the overlay -> E_ROLE', chk('navigate', 'overlay', [1, 'x']) === 'E_ROLE' && chk('focus-other', 'overlay', [2, 7]) === 'E_ROLE' && chk('claude:auth-dialog', 'overlay') === 'E_ROLE');
t('half maximize accepts only a local pane and a left/right side from chrome', ['left', 'right'].every(side => chk('maximize-half', 'chrome', [1, side]) === null)
  && ['full', '', null, 1].every(side => chk('maximize-half', 'chrome', [1, side]) === 'E_PAYLOAD')
  && chk('maximize-half', 'chrome', [1, 'left', 'extra']) === 'E_PAYLOAD' && chk('maximize-half', 'chrome', [7, 'left']) === 'E_TARGET'
  && chk('maximize-half', 'overlay', [1, 'right']) === 'E_ROLE' && chk('maximize-half', 'pane', [1, 'left']) === 'E_ROLE');
t('overlay-only channels from the chrome bar -> E_ROLE', chk('overlay-close', 'chrome') === 'E_ROLE' && chk('usage:margin', 'chrome', [5]) === 'E_ROLE' && chk('usage-pop-size', 'chrome', [10]) === 'E_ROLE');
t('probe sending other pane signals -> E_ROLE (ignored)', ['pane:draft', 'pane:editing', 'pane:ime', 'pane:sel', 'pane:msgmode-off', 'pane:interact'].every(ch => chk(ch, 'probe', SAMPLE[ch][1]) === 'E_ROLE'));

// ---- frame: child / gone / detached ----
t('child frame -> E_FRAME on every channel', CH.every(ch => chk(ch, as(SAMPLE[ch][0], { top: false }), SAMPLE[ch][1]) === 'E_FRAME'));
t('frame gone (null) -> E_FRAME on every channel', CH.every(ch => chk(ch, { role: SND[SAMPLE[ch][0]].role, frame: null }, SAMPLE[ch][1]) === 'E_FRAME'));
t('detached frame (unloading) -> E_FRAME', chk('pane:typing', as('pane', { detached: true })) === 'E_FRAME' && chk('ready', as('chrome', { detached: true })) === 'E_FRAME');
t('top must be exactly true', chk('add', as('chrome', { top: 1 })) === 'E_FRAME' && chk('add', as('chrome', { top: undefined })) === 'E_FRAME');

// ---- page: bundled file (exact) / origin ----
t('chrome on its own index.html: ok (query / hash ignored)', chk('add', as('chrome', { url: fileUrl('index.html') + '#x' })) === null && chk('add', as('chrome', { url: fileUrl('index.html') + '?a=1' })) === null);
t('chrome showing overlay.html / newtab.html -> E_PAGE', chk('add', as('chrome', { url: fileUrl('overlay.html') })) === 'E_PAGE' && chk('add', as('chrome', { url: fileUrl('newtab.html') })) === 'E_PAGE');
t('chrome navigated to a web page (dropped link) -> E_PAGE', chk('navigate', as('chrome', { url: 'https://example.com/index.html', origin: 'https://example.com' }), [1, 'x']) === 'E_PAGE');
t('chrome on a dropped local file named index.html elsewhere -> E_PAGE', chk('add', as('chrome', { url: pathToFileURL(path.join(SRC, '..', 'index.html')).href })) === 'E_PAGE' && chk('add', as('chrome', { url: 'file:///tmp/src/index.html' })) === 'E_PAGE');
t('file origin alone is not enough', chk('add', as('chrome', { url: 'file:///', origin: 'file://' })) === 'E_PAGE');
t('file URL with a host -> E_PAGE', chk('add', as('chrome', { url: fileUrl('index.html').replace('file:///', 'file://evil.example/') })) === 'E_PAGE');
t('file URL with localhost: same file -> ok', chk('add', as('chrome', { url: fileUrl('index.html').replace('file:///', 'file://localhost/') })) === null);
t('bad / empty URL -> E_PAGE', chk('add', as('chrome', { url: '' })) === 'E_PAGE' && chk('add', as('chrome', { url: 'not a url' })) === 'E_PAGE' && chk('add', as('chrome', { url: undefined })) === 'E_PAGE');
t('overlay showing index.html -> E_PAGE', chk('overlay-close', as('overlay', { url: fileUrl('index.html') })) === 'E_PAGE');
t('msgcount only from https://grok.com', chk('pane:msgcount', 'pane', [COUNT]) === null && chk('pane:msgcount', 'probe', [COUNT]) === null
  && ['https://example.com', 'http://grok.com', 'https://grok.com.evil.example', 'https://x.grok.com', 'https://grok.com:8443', 'null', 'file://', ''].every(o => chk('pane:msgcount', as('pane', { origin: o }), [COUNT]) === 'E_PAGE' && chk('pane:msgcount', as('probe', { origin: o }), [COUNT]) === 'E_PAGE'));
t('newtab page cannot report counts', chk('pane:msgcount', 'newtab', [COUNT]) === 'E_PAGE');
t('pc-opened only from grok.com', chk('pane:pc-opened', 'pane') === null && chk('pane:pc-opened', 'web') === 'E_PAGE');
t('画像クリック: img-opened only from grok.com (not the newtab page / a probe); img-closed = a boolean only', chk('pane:img-opened', 'pane') === null && chk('pane:img-opened', 'web') === 'E_PAGE' && chk('pane:img-opened', 'newtab') === 'E_PAGE'
  && chk('pane:img-opened', 'probe') === 'E_ROLE' && chk('pane:img-closed', 'pane', [false]) === null && [1, 'true', null, undefined, {}].every(v => chk('pane:img-closed', 'pane', [v]) === 'E_PAYLOAD'));
t('Grok bar: open / menu / move / rename name a listed Bot by its grok.com id; where here / new / window; refresh has no payload; chrome only (rename: overlay)',
  ['here', 'new', 'window'].every(w => chk('gbot-open', 'chrome', ['b1', w]) === null) && chk('gbot-open', 'chrome', ['b1', 'tab']) === 'E_PAYLOAD'
  && ['', 'a/b', '../x', 'x'.repeat(65), '__proto__', 5, null, undefined].every(v => chk('gbot-menu', 'chrome', [v]) === 'E_PAYLOAD' && chk('gbot-open', 'chrome', [v, 'here']) === 'E_PAYLOAD')
  && chk('gbot-menu', 'chrome', ['b3']) === 'E_TARGET' && chk('gbot-move', 'chrome', ['b1', 'b3']) === 'E_TARGET' && chk('gbot-move', 'chrome', ['b1']) === 'E_PAYLOAD'
  && chk('overlay-run', 'overlay', [{ type: 'gbot-rename', id: 'b3', value: 'x' }]) === 'E_TARGET' && chk('overlay-run', 'overlay', [{ type: 'gbot-rename', id: 'b1', value: 5 }]) === 'E_PAYLOAD'
  && chk('overlay-run', 'chrome', [{ type: 'gbot-rename', id: 'b1', value: 'x' }]) === 'E_ROLE'
  && ['gbar-refresh', 'gbar-mode', 'gbar-sec-toggle', 'gbot-open', 'gbot-menu', 'gbot-move'].every(ch => ['overlay', 'pane', 'probe'].every(w => chk(ch, w, SAMPLE[ch][1]) === 'E_ROLE')));
t('coarse pane signals from any site and the newtab page', ['pane:typing', 'pane:interact', 'pane:mouseup', 'pane:msgmode-off', 'pane:pc-closed'].every(ch => chk(ch, 'web') === null && chk(ch, 'newtab') === null) && chk('pane:draft', 'newtab', [false]) === null && chk('pane:editing', 'web', [true]) === null);
// how Chromium and Node escape a packaged path can differ: compare as paths
{ const f = '/Applications/Multi Pane ブラウザ (1).app/Contents/Resources/app.asar/src/index.html';
  t('docMatches: Node-escaped URL', P.docMatches(pathToFileURL(f).href, f));
  t('docMatches: Chromium-style escaping (%20, upper-case UTF-8, raw parentheses)', P.docMatches('file:///Applications/Multi%20Pane%20%E3%83%96%E3%83%A9%E3%82%A6%E3%82%B6%20(1).app/Contents/Resources/app.asar/src/index.html', f));
  t('docMatches: a raw % in the path', P.docMatches('file:///Applications/100% Bots.app/src/index.html', '/Applications/100% Bots.app/src/index.html') && P.docMatches('file:///Applications/100%25%20Bots.app/src/index.html', '/Applications/100% Bots.app/src/index.html'));
  t('docMatches: other file / other dir / https / encoded slash -> false', !P.docMatches(pathToFileURL(f.replace('index', 'overlay')).href, f) && !P.docMatches(pathToFileURL('/tmp/index.html').href, f)
    && !P.docMatches('https://localhost' + f, f) && !P.docMatches('file:///Applications%2FMulti%20Pane/index.html', '/Applications/Multi Pane/index.html')); }
t('DOCS are the bundled pages next to the policy', P.DOCS.chrome === path.join(SRC, 'index.html') && P.DOCS.overlay === path.join(SRC, 'overlay.html') && fs.existsSync(P.DOCS.chrome) && fs.existsSync(P.DOCS.overlay));

// ---- owner: the sender's window / pane already closed ----
t('owner gone -> E_OWNER on every channel', CH.every(ch => chk(ch, SAMPLE[ch][0], SAMPLE[ch][1], world({ owned: false })) === 'E_OWNER'));
t('no world -> E_OWNER', chk('add', 'chrome', [], null) === 'E_OWNER' && chk('add', 'chrome', [], world({ owned: 1 })) === 'E_OWNER');

// ---- payload: types, finite numbers, integer ranges, lengths, enums ----
const pay = (ch, who, args) => chk(ch, who, args) === 'E_PAYLOAD';
t('pane id: positive safe integer only', [0, -1, 1.5, NaN, Infinity, '1', null, undefined, true, 2 ** 53].every(v => pay('reload', 'chrome', [v])) && chk('reload', 'chrome', [3]) === null);
t('navigate: URL string up to URL_MAX', chk('navigate', 'chrome', [1, 'x'.repeat(P.URL_MAX)]) === null && pay('navigate', 'chrome', [1, 'x'.repeat(P.URL_MAX + 1)]) && pay('navigate', 'chrome', [1, 5]) && pay('navigate', 'chrome', [1]) && chk('navigate', 'chrome', [1, '']) === null);
t('layout: presets only', P.PRESETS.every(k => chk('layout', 'chrome', [k]) === null) && ['6x6', '', '2X2', 22, null, 'toString'].every(v => pay('layout', 'chrome', [v])));
t('set-reload: reload choices only', P.RELOAD_CHOICES.every(m => chk('set-reload', 'chrome', [1, m]) === null) && [2, -1, '5', 0.5, null].every(m => pay('set-reload', 'chrome', [1, m])));
t('split-start: axis c/r, splitter 1..MAX, row none or 0..MAX', chk('split-start', 'chrome', ['r', 1, undefined]) === null && chk('split-start', 'chrome', ['c', P.MAX_PANES, null]) === null && chk('split-start', 'chrome', ['c', 2, 0]) === null && chk('split-start', 'chrome', ['c', 2, P.MAX_PANES]) === null
  && pay('split-start', 'chrome', ['x', 1]) && pay('split-start', 'chrome', ['c', 0]) && pay('split-start', 'chrome', ['c', P.MAX_PANES + 1]) && pay('split-start', 'chrome', ['c', 1.5]) && pay('split-start', 'chrome', ['c', 1, -1]) && pay('split-start', 'chrome', ['c', 1, P.MAX_PANES + 1]) && pay('split-start', 'chrome', ['c', 1, '0']));
t('split-reset: axis + optional row', chk('split-reset', 'chrome', ['c', 0]) === null && chk('split-reset', 'chrome', ['c', undefined]) === null && pay('split-reset', 'chrome', ['', 0]) && pay('split-reset', 'chrome', ['c', 2.5]));
t('sync-cols / draft / editing / ime / sel / usage:get: booleans only', [1, 0, 'true', null, undefined].every(v => pay('sync-cols', 'chrome', [v]) && pay('pane:draft', 'pane', [v]) && pay('pane:editing', 'pane', [v]) && pay('pane:ime', 'pane', [v]) && pay('pane:sel', 'pane', [v]) && pay('usage:get', 'chrome', [v])));
t('usage-pop-show: finite rect + kind + optional selection', chk('usage-pop-show', 'chrome', [{ right: 1, bottom: 2, kind: 'codex' }]) === null && chk('usage-pop-show', 'chrome', [{ right: 0, bottom: 0, kind: 'claude', sel: 'x'.repeat(P.TEXT_MAX) }]) === null
  && pay('usage-pop-show', 'chrome', [{ bottom: 2, kind: 'grok' }]) && pay('usage-pop-show', 'chrome', [{ right: Infinity, bottom: 2, kind: 'grok' }]) && pay('usage-pop-show', 'chrome', [{ right: 1, bottom: 2e5, kind: 'grok' }])
  && pay('usage-pop-show', 'chrome', [{ right: 1, bottom: 2, kind: 'gpt' }]) && pay('usage-pop-show', 'chrome', [{ right: 1, bottom: 2, kind: 'grok', sel: 'x'.repeat(P.TEXT_MAX + 1) }]) && pay('usage-pop-show', 'chrome', [[1, 2]]) && pay('usage-pop-show', 'chrome', [null]));
t('usage-win-menu / aiusage:get: codex / claude / kimi only', chk('usage-win-menu', 'chrome', ['claude', 'five_hour']) === null && chk('usage-win-menu', 'chrome', ['kimi', '']) === null && pay('usage-win-menu', 'chrome', ['grok', '']) && pay('usage-win-menu', 'chrome', ['antigravity', '']) && pay('usage-win-menu', 'chrome', ['codex', 5])
  && chk('aiusage:get', 'chrome', ['codex', false]) === null && chk('aiusage:get', 'chrome', ['kimi', false]) === null && pay('aiusage:get', 'chrome', ['grok', false]) && pay('aiusage:get', 'chrome', ['antigravity', false]) && pay('aiusage:get', 'chrome', ['codex']));
t('usage-pop-show: every gauge of the bar (codex / claude / kimi / antigravity / grok), nothing else', ['codex', 'claude', 'kimi', 'antigravity', 'grok'].every(k => chk('usage-pop-show', 'chrome', [{ right: 1, bottom: 2, kind: k }]) === null)
  && ['gemini', '', null, 5, '__proto__', 'toString'].every(k => pay('usage-pop-show', 'chrome', [{ right: 1, bottom: 2, kind: k }])));
t('使用量表示: usage-connect = a provider with a login window (codex / claude / kimi), usage-open = also antigravity; a kind only (never a URL); UI pages only',
  ['codex', 'claude', 'kimi'].every(k => chk('usage-connect', 'chrome', [k]) === null && chk('usage-connect', 'overlay', [k]) === null && chk('usage-open', 'overlay', [k]) === null)
  && chk('usage-open', 'chrome', ['antigravity']) === null && pay('usage-connect', 'chrome', ['antigravity']) && pay('usage-connect', 'chrome', ['grok'])
  && ['https://claude.ai/settings/usage', 'grok', '', null, undefined, 5, ['kimi'], '__proto__'].every(v => pay('usage-open', 'overlay', [v]) && pay('usage-connect', 'chrome', [v]))
  && ['pane', 'probe', 'approve'].every(w => chk('usage-connect', w, ['kimi']) === 'E_ROLE' && chk('usage-open', w, ['kimi']) === 'E_ROLE'));
t('usage-pop-size: 0..1e5', chk('usage-pop-size', 'overlay', [0]) === null && chk('usage-pop-size', 'overlay', [1e5]) === null && [-1, 1e5 + 1, NaN, '10'].every(v => pay('usage-pop-size', 'overlay', [v])));
t('usage:margin: any number (NaN = read only), nothing else', [0, 50, 2.5, NaN, 99].every(v => chk('usage:margin', 'overlay', [v]) === null) && ['5', undefined, null].every(v => pay('usage:margin', 'overlay', [v])));
t('fav-open: where here / new / window', ['here', 'new', 'window'].every(w => chk('fav-open', 'chrome', [1, w]) === null) && pay('fav-open', 'chrome', [1, 'tab']) && pay('fav-open', 'chrome', [1]));
t('fav-add: URL + label strings', chk('fav-add', 'chrome', ['https://e.com/', 'x'.repeat(P.TEXT_MAX)]) === null && pay('fav-add', 'chrome', ['https://e.com/', 'x'.repeat(P.TEXT_MAX + 1)]) && pay('fav-add', 'chrome', ['x'.repeat(P.URL_MAX + 1), '']) && pay('fav-add', 'chrome', [5, '']));
t('focus-other: two ids', pay('focus-other', 'chrome', [2]) && pay('focus-other', 'chrome', ['2', 7]) && pay('focus-other', 'chrome', [2, 0]));
t('msgcount: counts 0..COUNT_MAX-1 integers', chk('pane:msgcount', 'pane', [{ ...COUNT, user: 0, bot: 0, botSince: 0 }]) === null && chk('pane:msgcount', 'pane', [{ ...COUNT, user: P.COUNT_MAX - 1 }]) === null
  && [P.COUNT_MAX, -1, 1.5, '1', null, undefined].every(v => pay('pane:msgcount', 'pane', [{ ...COUNT, botSince: v }])));
t('msgcount: the selector-fallback shape (no quote / heading / fingerprint) is fine', chk('pane:msgcount', 'pane', [{ user: 1, bot: 2, botSince: 1, waiting: false, working: false, done: false, asks: false, method: 'selector' }]) === null);
t('msgcount: flags booleans, strings bounded', pay('pane:msgcount', 'pane', [{ ...COUNT, waiting: 'yes' }]) && pay('pane:msgcount', 'pane', [{ ...COUNT, q: 5 }]) && pay('pane:msgcount', 'pane', [{ ...COUNT, fp: 'x'.repeat(P.TEXT_MAX + 1) }])
  && chk('pane:msgcount', 'pane', [{ ...COUNT, q: 'x'.repeat(P.TEXT_MAX) }]) === null && pay('pane:msgcount', 'pane', [null]) && pay('pane:msgcount', 'pane', [[3, 5, 2]]) && pay('pane:msgcount', 'pane', []));
t('msgcount: snapshot = every item one of its fixed codes + a bot id', chk('pane:msgcount', 'probe', [{ ...COUNT, snap: { ...SNAPV, conv: 'AUTH_REQUIRED', roles: 'NONE', latest: 'NONE', marker: 'UNKNOWN', quote: 'UNKNOWN', cid: '' } }]) === null
  && [{ ...SNAPV, conv: 'MAYBE' }, { ...SNAPV, marker: 'wait' }, { ...SNAPV, name: '__proto__' }, { ...SNAPV, quote: 'toString' }, { ...SNAPV, stable: true }, { ...SNAPV, extra: 'x' }, { ...SNAPV, cid: '../x' }, { ...SNAPV, cid: 5 },
    { ...SNAPV, cid: 'a'.repeat(P.TEXT_MAX + 1) }, (({ draft, ...o }) => o)(SNAPV), 'OK', [SNAPV], { ...SNAPV, confidence: 0.9 }].every(s => pay('pane:msgcount', 'pane', [{ ...COUNT, snap: s }])));
t('args not an array: treated as none', chk('add', 'chrome', null) === null && chk('reload', 'chrome', 'x') === 'E_PAYLOAD');
t('a payload that throws while read -> E_PAYLOAD', chk('usage-pop-show', 'chrome', [new Proxy({}, { get() { throw new Error('x'); } })]) === 'E_PAYLOAD');

// ---- overlay-run: action types per role ----
const run = (who, a, w) => chk('overlay-run', who, [a], w);
const RUNS = [
  { type: 'rename', id: 1, value: '新しい名前' }, { type: 'rename', id: 1, value: '' }, { type: 'fav-rename', id: 2, value: 'お気に入り' }, { type: 'ws-rename', name: 'A', value: 'B' },
  { type: 'ws-save', value: '監視セットA' }, { type: 'recovery-restore', id: 'panes.json.prev-1' }, { type: 'recovery-fresh' }, { type: 'close' },
  { type: 'open-new', url: 'https://example.com/' }, { type: 'open-new', url: '' }, { type: 'open-new', url: 'https://grok.com/' }, { type: 'open-new', url: 'search words' },
  { type: 'open-here', url: 'example.com' }, { type: 'new-window', url: '' }, { type: 'fav-add', url: 'https://example.com/' }, { type: 'fav-open', id: 1, where: 'here' }, { type: 'fav-open', id: 1, where: 'new' },
  { type: 'focus', id: 3 }, { type: 'next-unread' }, { type: 'maximize' }, { type: 'rename-prompt' }, { type: 'ws-overwrite', name: 'A' }, { type: 'ws-overwrite', name: 'A', confirm: true },
  { type: 'ws-save-prompt' }, { type: 'approve-open' }, { type: 'broadcast-prompt' }, { type: 'fav-add-current' }, { type: 'reload-all' }, { type: 'reopen-closed' }, { type: 'clear-unread' },
  { type: 'approve-save', url: 'https://grok.com/bot/abc', label: 'Bot' }, { type: 'approve-pick', id: 'abc' }, { type: 'approve-reset' },
  { type: 'layout', layout: '5x2' }, { type: 'ws-load', name: 'A' }, { type: 'ws-rename-prompt', name: 'A' }, { type: 'ws-delete', name: 'A' },
  { type: 'bc-preview', text: 'こんにちは', ids: [1, 3] }, { type: 'bc-send', pid: 5 }, { type: 'bc-cancel', bid: 6 }, { type: 'bc-reset' }, { type: 'toggle-notifications' },
  { type: 'diag-open' }, { type: 'diag-copy' }, { type: 'diag-persist', on: true }, { type: 'diag-persist', on: false },
  { type: 'update-check' }, { type: 'update-start' }, { type: 'update-restart' }, { type: 'update-later' },
  { type: 'update-choice', on: true }, { type: 'update-choice', on: false }, { type: 'update-toggle', on: true }, { type: 'update-toggle', on: false },
  { type: 'queue-open' }, { type: 'queue-pick', id: 3, ref: 'bot:abc' }, { type: 'queue-pick', id: 1, ref: '' },
  { type: 'gbot-rename', id: 'b1', value: '新しい名前' }, { type: 'gbot-rename', id: 'b-2', value: '' },
  { type: 'sidebar-save', url: 'https://example.com/#/p/sidebar' }, { type: 'sidebar-save', url: '' },
];
const CHROME_RUNS = [{ type: 'gbar-sec-toggle', name: '待機' }];
t('every action from the overlay is allowed', RUNS.every(a => run('overlay', a) === null));
t('every action type has a sample', Object.keys(P.ACTIONS).every(k => [...RUNS, ...CHROME_RUNS].some(a => a.type === k)));
t('chrome bar: next-unread / queue-open / section toggle only', run('chrome', { type: 'next-unread' }) === null && run('chrome', { type: 'queue-open' }) === null
  && CHROME_RUNS.every(a => run('chrome', a) === null && run('overlay', a) === 'E_ROLE')
  && RUNS.filter(a => a.type !== 'next-unread' && a.type !== 'queue-open').every(a => run('chrome', a) === 'E_ROLE'));
t('対応キュー (#01): a choice is a pane id + a bounded conversation ref; a pane closed / in another window is left to main (it says why)',
  run('overlay', { type: 'queue-pick', id: 7, ref: 'bot:x' }) === null && run('overlay', { type: 'queue-pick', id: 1, ref: 'x'.repeat(P.URL_MAX) }) === null
  && [0, -1, 1.5, '3', null, undefined].every(v => run('overlay', { type: 'queue-pick', id: v, ref: '' }) === 'E_PAYLOAD')
  && [undefined, null, 5, 'x'.repeat(P.URL_MAX + 1)].every(v => run('overlay', { type: 'queue-pick', id: 1, ref: v }) === 'E_PAYLOAD')
  && run('pane', { type: 'queue-open' }) === 'E_ROLE' && run('pane', { type: 'queue-pick', id: 1, ref: '' }) === 'E_ROLE');
t('unknown / inherited / missing type -> E_PAYLOAD', [{ type: 'eval' }, { type: '__proto__' }, { type: 'toString' }, { type: 'constructor' }, {}, { type: 5 }, null, 'focus', ['focus']].every(a => run('overlay', a) === 'E_PAYLOAD'));
t('focus / rename: pane of this window', run('overlay', { type: 'focus', id: 7 }) === 'E_TARGET' && run('overlay', { type: 'rename', id: 9, value: 'x' }) === 'E_TARGET' && run('overlay', { type: 'focus', id: '3' }) === 'E_PAYLOAD');
t('broadcast preview (#12): 1..MAX distinct pane ids of this window, text up to BROADCAST_MAX', run('overlay', { type: 'bc-preview', text: 'x'.repeat(P.BROADCAST_MAX), ids: [1, 2, 3] }) === null
  && run('overlay', { type: 'bc-preview', text: 'x'.repeat(P.BROADCAST_MAX + 1), ids: [1] }) === 'E_PAYLOAD' && run('overlay', { type: 'bc-preview', text: 'x', ids: [] }) === 'E_PAYLOAD'
  && run('overlay', { type: 'bc-preview', text: 'x', ids: Array.from({ length: P.MAX_PANES + 1 }, (_, i) => i + 1) }) === 'E_PAYLOAD' && run('overlay', { type: 'bc-preview', text: 'x', ids: [1, 1] }) === 'E_PAYLOAD'
  && run('overlay', { type: 'bc-preview', text: 'x', ids: [1, '2'] }) === 'E_PAYLOAD' && run('overlay', { type: 'bc-preview', text: 'x', ids: 1 }) === 'E_PAYLOAD' && run('overlay', { type: 'bc-preview', ids: [1] }) === 'E_PAYLOAD'
  && run('overlay', { type: 'bc-preview', text: 'x', ids: [1, 7] }) === 'E_TARGET'
  && run('overlay', { type: 'bc-preview', text: 'x', ids: Array.from({ length: P.MAX_PANES }, (_, i) => i + 1) }, world({ pane: () => true })) === null);
t('broadcast send / cancel (#12): only the numbers main gave (no text, no pane ids); the old one-step send is gone', !Object.hasOwn(P.ACTIONS, 'broadcast')
  && run('overlay', { type: 'broadcast', text: 'x', ids: [1] }) === 'E_PAYLOAD'
  && [0, -1, 1.5, '5', null, undefined, Number.MAX_SAFE_INTEGER + 1].every(v => run('overlay', { type: 'bc-send', pid: v }) === 'E_PAYLOAD' && run('overlay', { type: 'bc-cancel', bid: v }) === 'E_PAYLOAD')
  && run('overlay', { type: 'bc-send', pid: 1, text: 'ignored' }) === null && ['bc-preview', 'bc-send', 'bc-cancel', 'bc-reset'].every(k => run('chrome', { type: k, pid: 1, bid: 1, text: 'x', ids: [1] }) === 'E_ROLE'));
t('workspaces: existing names only (own keys), no "__proto__" as a new name', run('overlay', { type: 'ws-load', name: 'B' }) === 'E_TARGET' && run('overlay', { type: 'ws-load', name: '__proto__' }) === 'E_TARGET' && run('overlay', { type: 'ws-delete', name: 'toString' }) === 'E_TARGET'
  && run('overlay', { type: 'ws-save', value: '__proto__' }) === 'E_PAYLOAD' && run('overlay', { type: 'ws-save', value: ' __proto__ ' }) === 'E_PAYLOAD' && run('overlay', { type: 'ws-rename', name: 'A', value: '__proto__' }) === 'E_PAYLOAD'
  && run('overlay', { type: 'ws-overwrite', name: 'A', confirm: 'yes' }) === 'E_PAYLOAD' && run('overlay', { type: 'ws-save', value: 'x'.repeat(P.TEXT_MAX + 1) }) === 'E_PAYLOAD');
t('favorites: existing ids only', run('overlay', { type: 'fav-open', id: 3, where: 'here' }) === 'E_TARGET' && run('overlay', { type: 'fav-rename', id: 9, value: 'x' }) === 'E_TARGET' && run('overlay', { type: 'fav-open', id: 1, where: 'top' }) === 'E_PAYLOAD');
t('update choice and toggle: booleans only, overlay only', ['update-choice', 'update-toggle'].every(type => run('overlay', { type, on: true }) === null && run('overlay', { type, on: false }) === null && run('overlay', { type, on: 'true' }) === 'E_PAYLOAD' && run('chrome', { type, on: true }) === 'E_ROLE'));
t('diag-persist: boolean only (the summary itself is built in main, never sent by a page)', ['true', 1, null, undefined].every(v => run('overlay', { type: 'diag-persist', on: v }) === 'E_PAYLOAD')
  && ['diag-open', 'diag-copy', 'diag-persist'].every(k => run('pane', { type: k, on: true }) === 'E_ROLE'));
t('open / fav-add URLs bounded', run('overlay', { type: 'open-new', url: 'x'.repeat(P.URL_MAX + 1) }) === 'E_PAYLOAD' && run('overlay', { type: 'open-here' }) === 'E_PAYLOAD' && run('overlay', { type: 'fav-add', url: 'u', label: 5 }) === 'E_PAYLOAD');

// ---- target: exists, and belongs to the sender's window ----
t('pane of another window / closed pane -> E_TARGET', ['navigate', 'close', 'reload', 'sleep-toggle', 'wake-pane', 'pane-menu'].every(ch => chk(ch, 'chrome', ch === 'navigate' ? [7, 'x'] : [7]) === 'E_TARGET'));
t('swap needs both panes in this window', chk('swap', 'chrome', [1, 7]) === 'E_TARGET' && chk('swap', 'chrome', [7, 1]) === 'E_TARGET');
t('dock (header drag): begin = a pane of this window, ready = main\'s number, hover / drop = a finite point, end = nothing; chrome only',
  chk('dock-begin', 'chrome', [7]) === 'E_TARGET' && [0, -1, 1.5, '2', null, undefined].every(v => pay('dock-begin', 'chrome', [v]))
  && [0, -1, 1.5, '4', null, undefined, Number.MAX_SAFE_INTEGER + 1].every(v => pay('dock-ready', 'chrome', [v]))
  && ['dock-hover', 'dock-drop'].every(ch => chk(ch, 'chrome', [0, 0]) === null && chk(ch, 'chrome', [-5.5, 1e5]) === null
    && [[NaN, 1], [1, Infinity], ['1', 2], [1], [], [{ x: 1, y: 2 }], [2e5, 1], [1, -2e5]].every(a => pay(ch, 'chrome', a)))
  && ['dock-begin', 'dock-ready', 'dock-hover', 'dock-drop', 'dock-end'].every(ch => ['overlay', 'pane', 'probe'].every(w => chk(ch, w, SAMPLE[ch][1]) === 'E_ROLE')));
t('favorites must exist', chk('fav-open', 'chrome', [3, 'here']) === 'E_TARGET' && chk('fav-move', 'chrome', [1, 3]) === 'E_TARGET' && chk('fav-menu', 'chrome', [9]) === 'E_TARGET');
t('focus-other: an existing window + its pane', chk('focus-other', 'chrome', [3, 7]) === 'E_TARGET' && chk('focus-other', 'chrome', [2, 1]) === 'E_TARGET');

// ---- order and side effects: nothing about the world is looked at before the sender / frame / page / payload pass ----
{ let looked = 0; const spy = world({ pane: () => { looked++; return true; }, fav: () => { looked++; return true; }, gbot: () => { looked++; return true; }, ws: () => { looked++; return true; }, winPane: () => { looked++; return true; } });
  chk('reload', { role: null, frame: SND.chrome.frame }, [1], spy); chk('reload', 'pane', [1], spy); chk('reload', as('chrome', { top: false }), [1], spy); chk('reload', as('chrome', { url: 'https://e.com/' }), [1], spy);
  chk('reload', 'chrome', ['1'], spy); chk('overlay-run', 'chrome', [{ type: 'bc-preview', text: 'x', ids: [1] }], spy); chk('reload', 'chrome', [1], world({ owned: false, pane: spy.pane }));
  t('rejected before the target check: the world is never consulted', looked === 0);
  t('allowed: the target is checked once', chk('reload', 'chrome', [1], spy) === null && looked === 1); }
t('order: sender before role before frame before page before owner before payload', chk('reload', { role: null, frame: null }, ['x'], world({ owned: false })) === 'E_SENDER' && chk('reload', { role: 'pane', frame: null }, ['x']) === 'E_ROLE'
  && chk('reload', as('chrome', { top: false, url: 'https://e.com/' }), ['x']) === 'E_FRAME' && chk('reload', as('chrome', { url: 'https://e.com/' }), ['x'], world({ owned: false })) === 'E_PAGE' && chk('reload', 'chrome', ['x'], world({ owned: false })) === 'E_OWNER');
t('unknown / inherited channel names -> E_CHANNEL', ['eval', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'mem', 'state', 'mpb:zoom'].every(ch => chk(ch, 'chrome') === 'E_CHANNEL') && chk(5, 'chrome') === 'E_CHANNEL' && chk(undefined, 'chrome') === 'E_CHANNEL');
// every result is null or a fixed code with a short Japanese reason (no payload, URL or name in it)
{ const seen = new Set(); const all = [];
  for (const ch of [...CH, 'nope']) for (const who of [...Object.values(SND), { role: null, frame: SND.chrome.frame }, as('chrome', { top: false })]) for (const args of [SAMPLE[ch]?.[1] || [], ['https://secret.example/x?token=1'], [{ type: 'focus', id: 7 }], [7, 'secret']]) for (const w of [W, world({ owned: false })]) all.push(chk(ch, who, args, w));
  all.forEach(r => { if (r) seen.add(r); });
  t('results are null or a known code', all.every(r => r === null || Object.hasOwn(P.REJECT, r)));
  t(`every reject code is reachable (${[...seen].sort().join(' ')})`, Object.keys(P.REJECT).every(k => seen.has(k)));
  t('codes are fixed E_* strings with a short Japanese reason', Object.entries(P.REJECT).every(([k, v]) => /^E_[A-Z]+$/.test(k) && typeof v === 'string' && v.length <= 30 && /[぀-ヿ一-鿿]/.test(v) && !/[{}$]/.test(v))); }

// ---- msgCount: only the fields main uses, cut as before ----
{ const m = P.msgCount({ ...COUNT, q: 'あ'.repeat(400), hn: 'h'.repeat(100), hh: 'x'.repeat(100), fp: 'f'.repeat(30), method: 'm'.repeat(50), extra: 'drop me', waiting: true, asks: 1 });
  t('msgCount: known fields only', Object.keys(m).sort().join() === 'asks,bot,botSince,done,fp,gen,hh,hn,method,q,seq,snap,user,waiting,working');
  t('msgCount: strings cut (quote 320, heading / header 80, fingerprint 24, method 40)', m.q.length === 320 && m.hn.length === 80 && m.hh.length === 80 && m.fp.length === 24 && m.method.length === 40);
  t('msgCount: flags are true only for true', m.waiting === true && m.asks === false && m.done === false);
  t('msgCount: snapshot copied item by item (a new object)', JSON.stringify(m.snap) === JSON.stringify(SNAPV) && m.snap !== SNAPV);
  const s = P.msgCount({ user: 1, bot: 2, botSince: 1 }); t('msgCount: missing strings -> empty, missing snapshot -> null (= all unknown)', s.q === '' && s.hn === '' && s.fp === '' && s.method === '' && s.waiting === false && s.snap === null);
  t('msgCount: generation / scan numbers passed through, missing -> 0 (main drops it)', (g => g.gen === 7 && g.seq === 3)(P.msgCount({ ...COUNT, gen: 7, seq: 3 })) && s.gen === 0 && s.seq === 0); }
t('msgcount: generation / scan numbers are non-negative safe integers (0 = none yet)', chk('pane:msgcount', 'pane', [{ ...COUNT, gen: 0, seq: 0 }]) === null && chk('pane:msgcount', 'probe', [{ ...COUNT, gen: Number.MAX_SAFE_INTEGER, seq: 1 }]) === null
  && [-1, 1.5, '3', true, Number.MAX_SAFE_INTEGER + 1, NaN].every(v => pay('pane:msgcount', 'pane', [{ ...COUNT, gen: v }]) && pay('pane:msgcount', 'pane', [{ ...COUNT, seq: v }])));

// ======================= contract with the real sources =======================
const main = read('main.js');
const listed = re => [...main.matchAll(re)].map(m => m[1]);
const uiCh = listed(/^on\('([^']+)'/gm), paneCh = listed(/^paneOn\('([^']+)'/gm), onCh = listed(/^ipcOn\('([^']+)'/gm), hCh = listed(/^ipcHandle\('([^']+)'/gm);
const mainCh = [...uiCh, ...paneCh, ...onCh, ...hCh];
t(`main.js: listens on exactly the policy's channels (UI ${uiCh.length} + pane ${paneCh.length} + other ${onCh.length} + invoke ${hCh.length} = ${mainCh.length})`, mainCh.length === new Set(mainCh).size && mainCh.length === CH.length && mainCh.every(ch => P.CHANNELS[ch]));
t('main.js: ipcMain is used only by ipcOn / ipcHandle (the gate)', (main.match(/\bipcMain\s*\.\s*\w+\s*\(/g) || []).join() === 'ipcMain.on(,ipcMain.handle(' && /const ipcOn = \(ch, fn\) => ipcMain\.on\(ch, \(e, \.\.\.a\) => \{ const r = ipcGate\(ch, e, a\); if \(r\) fn\(r, \.\.\.a\); \}\);/.test(main) && /const ipcHandle = \(ch, fn\) => ipcMain\.handle\(ch, \(e, \.\.\.a\) => \{ const r = ipcGate\(ch, e, a\); return r \? fn\(r, \.\.\.a\) : null; \}\);/.test(main));
t('main.js: UI / pane registration goes through the gate', /function registerUi\(ch\) \{[^\n]*ipcOn\(ch,/.test(main) && /function registerPane\(ch\) \{[\s\S]{0,200}?ipcOn\(ch,/.test(main));
t('src: no other file listens on ipcMain', fs.readdirSync(SRC).filter(f => f.endsWith('.js') && f !== 'main.js').every(f => !/\bipcMain\b/.test(read(f))));
t('main.js: every role is registered for the pages main creates', P.ROLES.every(r => new RegExp(`regWc\\([^)]*, '${r}'`).test(main)));
t('main.js: sender is taken from the registry and the event frame, not from the payload', /wcReg\.get\(e\.sender\.id\)/.test(main) && /e\.senderFrame/.test(main) && /f\.parent === null/.test(main));
{ const keys = [...(main.match(/const PRESETS = \{([^}]*)\}/) || ['', ''])[1].matchAll(/'(\w+)':/g)].map(m => m[1]);
  const rel = ((main.match(/const RELOAD_CHOICES = \[([^\]]*)\]/) || ['', ''])[1]).split(',').map(Number);
  t('main.js constants = policy (presets, reload choices, MAX)', keys.join() === P.PRESETS.join() && rel.join() === P.RELOAD_CHOICES.join() && Number((main.match(/const MAX = (\d+);/) || [])[1]) === P.MAX_PANES); }

// ---- preload.js, run like a sandboxed preload with a recording ipcRenderer ----
function loadUiPreload() {
  const sent = [], listeners = {}, exposed = {};
  const ipc = { send: (ch, ...a) => { sent.push({ ch, a }); return ipc; }, invoke: (ch, ...a) => { sent.push({ ch, a, invoke: true }); return Promise.resolve(null); }, on: (ch, f) => { listeners[ch] = f; return ipc; } };
  const ctx = vm.createContext({ require: m => { if (m !== 'electron') throw new Error(`preload requires '${m}'`); return { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: ipc }; }, process: { platform: 'darwin' } });
  vm.runInContext(read('preload.js'), ctx, { filename: 'preload.js' });
  return { sent, listeners, exposed, ipc };
}
const UP = loadUiPreload(), api = UP.exposed.mpb || {};
t('preload: exposes only window.mpb', Object.keys(UP.exposed).join() === 'mpb');
t('preload: only functions plus the platform string', Object.entries(api).every(([k, v]) => typeof v === 'function' || (k === 'platform' && typeof v === 'string')));
const apiCh = {};                                            // mpb.<name> -> the one channel it sends
{ let ok = true, ret = true, lis = true, evt = true;
  for (const [k, f] of Object.entries(api)) {
    if (typeof f !== 'function') continue;
    if (/^on[A-Z]/.test(k)) {                                 // listener: registers one main->page channel, hands over the payload only
      const before = new Set(Object.keys(UP.listeners)), got = [];
      const r = f((...a) => got.push(a));
      const added = Object.keys(UP.listeners).filter(c => !before.has(c));
      if (r !== undefined) ret = false;
      if (added.length !== 1) { lis = false; continue; }
      const EVENT = { sender: UP.ipc, senderFrame: {}, ports: [] };
      UP.listeners[added[0]](EVENT, 'a', 'b');
      if (got.some(a => a.includes(EVENT) || a.includes(UP.ipc))) evt = false;
      continue;
    }
    const n0 = UP.sent.length, r1 = f(1, 2, 3), n1 = UP.sent.length, r2 = f('a', 'b', 'c'), n2 = UP.sent.length;
    if (n1 !== n0 + 1 || n2 !== n1 + 1 || UP.sent[n0].ch !== UP.sent[n1].ch) { ok = false; continue; }
    for (const r of [r1, r2]) if (!(r === undefined || r instanceof Promise) || r === UP.ipc) ret = false;
    apiCh[k] = UP.sent[n0].ch;
  }
  t('preload: every function sends exactly one fixed channel', ok);
  t('preload: nothing returns ipcRenderer (send -> undefined, invoke -> Promise, on* -> undefined)', ret);
  t('preload: every on* registers exactly one listener', lis);
  t('preload: listeners never hand the IPC event / ipcRenderer to the page', evt); }
t(`preload: every channel it sends is in the policy (${Object.keys(apiCh).length} functions)`, Object.values(apiCh).every(ch => P.CHANNELS[ch] && !ch.startsWith('pane:') && !ch.startsWith('sidebar:')));
t('preload: every UI channel in the policy is reachable from preload.js', CH.filter(ch => !ch.startsWith('pane:') && !ch.startsWith('sidebar:')).every(ch => Object.values(apiCh).includes(ch)));
t('preload: no generic send / invoke / listen in the API', !Object.keys(api).some(k => /^(send|invoke|on|once|listen|emit|ipc|ipcRenderer|electron)$/i.test(k)));
t('preload: a channel name as argument is just data', (() => { const n = UP.sent.length; api.reload('pane:msgcount'); api.layout('focus-other'); return UP.sent[n].ch === 'reload' && UP.sent[n + 1].ch === 'layout'; })());

// ---- what renderer.js (chrome) and overlay.js (overlay) send today, through the real preload ----
const CALLS = [
  ['chrome', 'layout', '3x2'], ['chrome', 'add'], ['chrome', 'reopenClosed'], ['chrome', 'reloadAll'], ['chrome', 'wsMenu'], ['chrome', 'palette'], ['chrome', 'run', { type: 'next-unread' }], ['chrome', 'run', { type: 'queue-open' }],
  ['chrome', 'approveOpen'], ['chrome', 'approveKeepAwakeToggle'], ['chrome', 'approveInline', { x: 700, y: 5, width: 28, height: 28 }], ['chrome', 'approveInlineAnchor', { x: 700, y: 5, width: 28, height: 28 }],
  ['chrome', 'recoveryOpen'], ['chrome', 'saveRetry'], ['chrome', 'focusOther', 2, 7], ['chrome', 'wakePane', 1], ['chrome', 'loadCancel', 1], ['chrome', 'probeResume'],
  ['chrome', 'back', 1], ['chrome', 'forward', 1], ['chrome', 'reload', 1], ['chrome', 'maximize', 1], ['chrome', 'maximizeHalf', 1, 'left'], ['chrome', 'maximizeHalf', 1, 'right'], ['chrome', 'paneMenu', 1], ['chrome', 'sleepToggle', 1], ['chrome', 'close', 1],
  ['chrome', 'focusPane', 2], ['chrome', 'navigate', 1, 'grok.com/bot/abc'], ['chrome', 'navigate', 1, ''], ['chrome', 'swap', 1, 3], ['chrome', 'copyPaneUrl', 1], ['chrome', 'activatePane', 3],
  ['chrome', 'dockBegin', 2], ['chrome', 'dockReady', 1], ['chrome', 'dockHover', 700, 95], ['chrome', 'dockHover', 0, 70], ['chrome', 'dockDrop', 1394, 893], ['chrome', 'dockEnd'],
  ['chrome', 'renamePane', 1], ['chrome', 'chipMenu', 2], ['chrome', 'syncReset'], ['chrome', 'syncCols', false], ['chrome', 'syncCols', true],
  ['chrome', 'splitStart', 'c', 1, undefined], ['chrome', 'splitStart', 'c', 2, 1], ['chrome', 'splitStart', 'r', 1, undefined], ['chrome', 'splitReset', 'c', undefined], ['chrome', 'splitReset', 'c', 0], ['chrome', 'splitEnd'],
  ['chrome', 'favOpen', 1, 'here'], ['chrome', 'favOpen', 2, 'new'], ['chrome', 'favOpen', 1, 'window'], ['chrome', 'favMenu', 1], ['chrome', 'favMove', 2, 1], ['chrome', 'favAdd', 'https://example.com/', ''],
  ['chrome', 'gbarRefresh'], ['chrome', 'gbarMode'], ['chrome', 'gbarSecToggle', '待機'], ['chrome', 'gbotOpen', 'b1', 'here'], ['chrome', 'gbotOpen', 'b-2', 'new'], ['chrome', 'gbotOpen', 'b1', 'window'], ['chrome', 'gbotMenu', 'b1'], ['chrome', 'gbotMove', 'b-2', 'b1'],
  ['chrome', 'ready'], ['chrome', 'usage', true], ['chrome', 'usage', undefined], ['chrome', 'usageDetail'], ['chrome', 'aiUsage', 'codex', false], ['chrome', 'aiUsage', 'claude', true], ['chrome', 'claudeAuthDialog'],
  ['chrome', 'usagePopLeave'], ['chrome', 'usagePopShow', { right: 812.5, bottom: 36, kind: 'grok', sel: '' }], ['chrome', 'usagePopShow', { right: 900, bottom: 36.25, kind: 'claude', sel: 'five_hour' }],
  ['chrome', 'usageWinMenu', 'codex', ''], ['chrome', 'usageWinMenu', 'claude', 'seven_day'], ['chrome', 'usageWinMenu', 'kimi', 'month-credit'],
  ['chrome', 'aiUsage', 'kimi', false], ['chrome', 'usagePopShow', { right: 700, bottom: 36, kind: 'antigravity', sel: '' }], ['chrome', 'usagePopShow', { right: 760, bottom: 36, kind: 'kimi', sel: '' }],
  ['chrome', 'sidebarToggle'], ['chrome', 'sidebarResizeStart'], ['chrome', 'sidebarResizeReset'],
  ['chrome', 'usageConnect', 'claude'], ['chrome', 'usageConnect', 'codex'], ['chrome', 'usageConnect', 'kimi'],
  ['overlay', 'usageOpen', 'claude'], ['overlay', 'usageOpen', 'codex'], ['overlay', 'usageOpen', 'kimi'], ['overlay', 'usageOpen', 'antigravity'],
  ['overlay', 'closeOverlay'], ['overlay', 'usagePopKeep'], ['overlay', 'usagePopLeave'], ['overlay', 'usagePopSize', 242], ['overlay', 'usageMargin', 5], ['overlay', 'usageMargin', NaN], ['overlay', 'usage', false],
  ...RUNS.map(a => ['overlay', 'run', a]),
];
const viaPreload = (name, args) => { const n = UP.sent.length; api[name](...args); const m = UP.sent[n]; return m ? [m.ch, m.a] : [null, []]; };
t(`every call the UI makes today is allowed (${CALLS.length} calls)`, CALLS.every(([who, name, ...args]) => { const [ch, a] = viaPreload(name, args); return chk(ch, who, a) === null; }));
{ const usedIn = (f, buttons) => { const s = read(f), u = new Set([...s.matchAll(/mpb\.(\w+)\s*\(/g)].map(m => m[1])); if (buttons) for (const m of s.matchAll(/data-a="(\w+)"/g)) u.add(m[1]); return [...u].filter(k => typeof api[k] === 'function' && !/^on[A-Z]/.test(k)); };
  const typesIn = f => [...new Set([...read(f).matchAll(/type: '([\w-]+)'/g)].map(m => m[1]))];
  const r = usedIn('renderer.js', true), o = usedIn('overlay.js');
  t(`renderer.js: every mpb call it makes has an allowed sample (${r.length})`, r.length > 30 && r.every(k => CALLS.some(c => c[0] === 'chrome' && c[1] === k)));
  t(`overlay.js: every mpb call it makes has an allowed sample (${o.length})`, o.length >= 7 && o.every(k => CALLS.some(c => c[0] === 'overlay' && c[1] === k)));
  t('renderer.js / overlay.js: every action type they run has an allowed sample', typesIn('renderer.js').every(k => CALLS.some(c => c[0] === 'chrome' && c[1] === 'run' && c[2].type === k)) && typesIn('overlay.js').every(k => RUNS.some(a => a.type === k)));
  t('only renderer / overlay use IPC in the UI pages (the other scripts are helpers)', /<script src="gbar-long-press\.js"><\/script><script src="cpu-meter\.js"><\/script><script src="local-icons\.js"><\/script><script src="gbar-presence\.js"><\/script><script src="gbar-mode\.js"><\/script><script src="gbar-pages\.js"><\/script><script src="renderer\.js"><\/script>/.test(read('index.html')) && /<script src="overlay\.js"><\/script>/.test(read('overlay.html'))
    && !(fs.existsSync(path.join(SRC, 'local-icons.js')) && /mpb\./.test(read('local-icons.js'))) && ['gbar-presence.js', 'gbar-mode.js', 'gbar-pages.js', 'gbar-long-press.js', 'cpu-meter.js'].every(f => !/mpb\.|ipcRenderer|require\(/.test(read(f)))); }

// ---- pane preload (built) and the newtab page ----
{ const pp = read('pane-preload.js'), code = pp.replace(/\/\/.*$/gm, ''), sends = [...new Set([...pp.matchAll(/ipcRenderer\.send\('([^']+)'/g)].map(m => m[1]))];
  t(`pane-preload: every channel it sends allows a pane (${sends.length}: ${sends.join(' ')})`, sends.length >= 9 && sends.every(ch => P.CHANNELS[ch]?.roles.includes('pane')));
  t('pane-preload: exposes nothing to the page (no contextBridge)', !/exposeInMainWorld|contextBridge/.test(code) && !!loadPreload());
  t('pane-preload: every pane channel in the policy is one it sends', CH.filter(ch => ch.startsWith('pane:')).every(ch => sends.includes(ch)));
  t('newtab page uses no app API', !/mpb|ipcRenderer|require/.test(read('newtab.js'))); }

console.log(`inventory: main listens on ${mainCh.length} channels (on ${uiCh.length} / paneOn ${paneCh.length} / ipcOn ${onCh.length} / ipcHandle ${hCh.length}); preload.js sends ${Object.keys(apiCh).length}, listens ${Object.keys(UP.listeners).length}`);
console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
