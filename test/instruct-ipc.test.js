// node test/instruct-ipc.test.js — NaoAIへの指示 and the IPC boundary: only the 進捗サイドバー's own page (role 'sidebar', top frame, its origin) may
// send 'sidebar:instruct' ({ tid, task?, bot?, state?, memo? }: strings only); only the overlay may send the box's / settings' actions; the
// sidebar preload exposes instruct() and shapes nothing else; a right-click's mouse-down is a gesture. main gates it like jump, keeps the URL / key
// in main (the overlay learns { configured, host, available } only; nothing of them in a log / a toast / a send to any page), POSTs from its own
// memory-only session, shows the box on its rect only and the result as a display-only toast. The box (Enter / ⇧↵ / IME / Esc / drafts) and the
// settings section run here on tiny fake DOMs.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { pathToFileURL } = require('url');
const P = require('../src/ipc-policy'), SI = require('../src/instruct-rules'), NAV = require('../src/navigation-policy');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const SRC = path.join(__dirname, '..', 'src'), read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const frame = (url, origin, extra) => ({ top: true, detached: false, url, origin, ...extra });
const ORIGIN = 'https://example.com';
const SIDE = { role: 'sidebar', origin: ORIGIN, frame: frame('https://example.com/#/p/sidebar', ORIGIN) };
const OV = { role: 'overlay', frame: frame(pathToFileURL(path.join(SRC, 'overlay.html')).href, 'file://') };
const UI = { role: 'chrome', frame: frame(pathToFileURL(path.join(SRC, 'index.html')).href, 'file://') };
const as = (s, f, o) => ({ ...s, ...o, frame: { ...s.frame, ...f } });
const W = { owned: true, pane: i => [1, 2].includes(i), fav: () => false, gbot: () => false, ws: () => false, winPane: () => false };
const chk = (ch, who, args, w = W) => P.check(ch, who, args, w);
const INS = 'sidebar:instruct', HOOK = 'https://hooks.cursor.com/routine', KEY = 'test-key-0123456789';
const ROW = { tid: 'T-12', task: 'LP修正', bot: 'Writer', state: '待機', memo: '急ぎ' };

// ---- the policy ----
t('instruct: a row from the sidebar\'s own page -> allowed (tid only, every field, up to RAW_MAX each)', [ROW, { tid: 'T' }, { tid: 'T', memo: 'x'.repeat(SI.RAW_MAX) }, { tid: ' ' }].every(x => chk(INS, SIDE, [x]) === null));
t('instruct: not strings / no tid / other keys / too long / not one object -> E_PAYLOAD', [[{}], [{ task: 'x' }], [{ tid: 5 }], [{ tid: 'T', bot: 5 }], [{ tid: 'T', memo: null }], [{ tid: 'T', url: HOOK }],
  [{ tid: 'T', webhook: HOOK }], [{ tid: 'x'.repeat(SI.RAW_MAX + 1) }], [{ tid: 'T', task: 'x'.repeat(SI.RAW_MAX + 1) }], [], [ROW, ROW], ['T-1'], [null], [[ROW]]].every(a => chk(INS, SIDE, a) === 'E_PAYLOAD'));
const NA = { tid: 'N_1', task: '確認A', bot: 'NaoAI', state: '待ち', memo: '' }, NB = { tid: 'N_2', task: '確認B', bot: 'NaoAI' };
t('instruct batch: the selected rows ({ tasks }: 1..BATCH_MAX rows of the five fields) from the sidebar\'s own page -> allowed', [{ tasks: [NA] }, { tasks: [NA, NB] }, { tasks: Array(SI.BATCH_MAX).fill(NA) },
  { tasks: [{ tid: 'T' }] }].every(x => chk(INS, SIDE, [x]) === null));
t('instruct batch: empty / too many / other keys / answer keys in a row / not strings / too long / not an array -> E_PAYLOAD', [[{ tasks: [] }], [{ tasks: Array(SI.BATCH_MAX + 1).fill(NA) }],
  [{ tasks: [NA], text: 'x' }], [{ tasks: [NA], bot: 'NaoAI' }], [{ tasks: [NA], url: HOOK }], [{ tasks: [{ ...NA, mode: 'answer' }] }], [{ tasks: [{ ...NA, options: ['a'] }] }], [{ tasks: [{ ...NA, url: HOOK }] }],
  [{ tasks: [{ ...NA, tid: 5 }] }], [{ tasks: [{ task: 'x' }] }], [{ tasks: [{ ...NA, memo: 'x'.repeat(SI.RAW_MAX + 1) }] }], [{ tasks: NA }], [{ tasks: [[NA]] }], [{ tasks: [null] }], [{ tasks: ['N_1'] }],
  [{ ...NA, tasks: [NA] }], [{ tasks: [NA] }, { tasks: [NB] }]].every(a => chk(INS, SIDE, a) === 'E_PAYLOAD'));
t('instruct batch: mixed Bots pass the shape but main refuses them (SI.batch -> null -> \'bad\')', chk(INS, SIDE, [{ tasks: [NA, { ...NB, bot: 'Kimiマン' }] }]) === null && SI.batch({ tasks: [NA, { ...NB, bot: 'Kimiマン' }] }) === null);
t('instruct batch: only the sidebar may send it', ['chrome', 'overlay', 'pane', 'probe', 'approve'].every(r => chk(INS, { role: r, origin: ORIGIN, frame: SIDE.frame }, [{ tasks: [NA] }]) === 'E_ROLE'));
t('instruct: the sidebar\'s sender checks (origin, top frame, its window)', chk(INS, as(SIDE, { url: 'https://evil.example/', origin: 'https://evil.example' }), [ROW]) === 'E_PAGE'
  && chk(INS, as(SIDE, {}, { origin: undefined }), [ROW]) === 'E_PAGE' && chk(INS, as(SIDE, { top: false }), [ROW]) === 'E_FRAME' && chk(INS, as(SIDE, { detached: true }), [ROW]) === 'E_FRAME'
  && chk(INS, SIDE, [ROW], { ...W, owned: false }) === 'E_OWNER');
t('instruct: no other page may send it (UI / overlay / panes / probe / 承認Bot / unregistered)', ['chrome', 'overlay', 'pane', 'probe', 'approve'].every(r => chk(INS, { role: r, origin: ORIGIN, frame: SIDE.frame }, [ROW]) === 'E_ROLE')
  && chk(INS, { role: null, frame: SIDE.frame }, [ROW]) === 'E_SENDER');
const run = (who, a) => chk('overlay-run', who, [a]);
const ACT = [{ type: 'instruct-send', no: 1, text: '確認して' }, { type: 'instruct-draft', no: 3, text: '' }, { type: 'instruct-settings' }, { type: 'instruct-hook-save', url: HOOK, key: KEY }, { type: 'instruct-hook-clear' }];
t('overlay actions: the box\'s send / draft / settings and the webhook save / removal from the overlay only', ACT.every(a => run(OV, a) === null) && ACT.every(a => run(UI, a) === 'E_ROLE' && run(SIDE, a) === 'E_ROLE'
  && run({ role: 'pane', frame: frame('https://grok.com/', 'https://grok.com') }, a) === 'E_ROLE'));
t('overlay actions: send / draft = the box\'s number + text (4000 at most), nothing else - never a row, URL or key', [{ type: 'instruct-send', no: 1, text: 'x'.repeat(SI.TEXT_MAX + 1) }, { type: 'instruct-send', no: 0, text: 'x' },
  { type: 'instruct-send', no: '1', text: 'x' }, { type: 'instruct-send', no: 1, text: 5 }, { type: 'instruct-send', no: 1, text: 'x', tid: 'T' }, { type: 'instruct-send', no: 1, text: 'x', url: HOOK },
  { type: 'instruct-draft', no: 1 }, { type: 'instruct-draft', no: 1, text: 'x', task: {} }, { type: 'instruct-settings', x: 1 }, { type: 'instruct-hook-clear', url: '' }].every(a => run(OV, a) === 'E_PAYLOAD'));
const SEND = { type: 'instruct-send', no: 1, text: '' };
t('overlay actions: an answer\'s send may carry the one choice button\'s label (up to 80), with or without a text',
  [{ ...SEND, choice: '案A' }, { ...SEND, text: '補足', choice: '案A' }, { ...SEND, choice: 'x'.repeat(SI.OPT_MAX) }].every(a => run(OV, a) === null));
t('overlay actions: no multi-pick / batch keys, an oversize / malformed label, a missing number / text -> E_PAYLOAD', [{ ...SEND, choices: ['案A', '案B'] }, { ...SEND, choices: [] }, { ...SEND, choices: ['案A'], choice: '案A' },
  { ...SEND, choice: 'x'.repeat(SI.OPT_MAX + 1) }, { ...SEND, choice: ['案A'] }, { ...SEND, choice: 5 }, { ...SEND, choice: '案A', options: ['案A'] }, { ...SEND, choice: '案A', mode: 'answer' }, { ...SEND, choice: '案A', task: { tid: 'T' } },
  { ...SEND, tasks: [{ tid: 'T' }] }, { ...SEND, tids: ['T'] }, { ...SEND, mode: 'batch' }, { type: 'instruct-send', no: 1, choice: '案A' }, { type: 'instruct-send', text: '', choice: '案A' },
  { ...SEND, text: 'x'.repeat(SI.TEXT_MAX + 1), choice: '案A' }].every(a => run(OV, a) === 'E_PAYLOAD')
  && run(UI, { ...SEND, choice: '案A' }) === 'E_ROLE' && run(SIDE, { ...SEND, choice: '案A' }) === 'E_ROLE');
t('overlay actions: the webhook save takes a usable URL (https, cursor.com / cursor.sh) and key only', [{ type: 'instruct-hook-save', url: 'http://hooks.cursor.com/x', key: KEY }, { type: 'instruct-hook-save', url: 'https://evil.example/', key: KEY },
  { type: 'instruct-hook-save', url: HOOK, key: 'short' }, { type: 'instruct-hook-save', url: HOOK, key: 'a b c d e f g h' }, { type: 'instruct-hook-save', url: HOOK }, { type: 'instruct-hook-save', url: HOOK, key: KEY, extra: 1 },
  { type: 'instruct-hook-save', url: 'x'.repeat(SI.URL_MAX + 1), key: KEY }].every(a => run(OV, a) === 'E_PAYLOAD'));

// ---- sidebar-preload.js instruct() ----
const tests = [];
{ const sent = [], exposed = {}; let reply = { result: 'open' };
  const ipc = { send: (ch, ...a) => sent.push([ch, a]), invoke: (ch, ...a) => { sent.push([ch, a, 'invoke']); return typeof reply === 'function' ? reply() : Promise.resolve(reply); }, on() {} };
  vm.runInNewContext(read('sidebar-preload.js'), { require: m => { if (m !== 'electron') throw new Error(m); return { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: ipc }; } });
  const api = exposed.xgBotsSidebar;
  const p1 = api.instruct({ ...ROW, url: HOOK, extra: 1, agentId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  t('preload: instruct invokes its fixed channel with the five string fields only (other keys dropped)', sent.length === 1 && sent[0][0] === INS && sent[0][2] === 'invoke' && sent[0][1].length === 1
    && J(sent[0][1][0]) === J(ROW) && chk(INS, SIDE, sent[0][1]) === null);
  tests.push(p1.then(v => t('preload: instruct resolves { result } from main', J(v) === J({ result: 'open' }))));
  sent.length = 0;
  api.instruct({ tid: 'T-1', task: null, bot: undefined });
  t('preload: null / absent fields are left out', sent.length === 1 && J(sent[0][1][0]) === J({ tid: 'T-1' }));
  sent.length = 0;
  const bads = [api.instruct({ tid: 5 }), api.instruct({ tid: 'T', memo: 7 }), api.instruct({ tid: 'T', task: { toString: () => 'x' } }), api.instruct({ task: 'x' }), api.instruct({ tid: '  ' }),
    api.instruct({ tid: 'x'.repeat(SI.RAW_MAX + 1) }), api.instruct(null), api.instruct('T-1'), api.instruct()];
  t('preload: not strings / no tid / too long -> not sent', sent.length === 0);
  tests.push(Promise.all(bads).then(v => t('preload: ...and resolves bad', v.every(x => J(x) === J({ result: 'bad' })))));
  for (const [rep, want] of [[null, 'blocked'], [{ result: 'focused' }, 'blocked'], [{ result: 'bad' }, 'bad'], [{ result: 'blocked' }, 'blocked'], [{ result: 'open', url: HOOK }, 'open']]) {
    reply = rep; tests.push(api.instruct({ tid: 'T' }).then(v => t(`preload: main's reply ${J(rep)} -> ${want} (nothing else passed on)`, J(v) === J({ result: want })))); }
  reply = () => Promise.reject(new Error('refused'));
  tests.push(api.instruct({ tid: 'T' }).then(v => t('preload: a rejected invoke -> blocked', J(v) === J({ result: 'blocked' }))));
  // the selected rows: { tasks } with each row's five fields washed the same way; one Bot; 1..BATCH_MAX
  sent.length = 0; reply = { result: 'open' };
  const pb = api.instruct({ tasks: [{ ...NA, mode: 'answer', ask: 'q', options: ['x'], url: HOOK }, { ...NB, memo: null }], text: 'x', url: HOOK });
  t('preload: instruct({ tasks }) invokes the same channel with { tasks } only - each row its five string fields (answer keys / others dropped), in order', sent.length === 1 && sent[0][0] === INS
    && sent[0][2] === 'invoke' && J(sent[0][1]) === J([{ tasks: [NA, NB] }]) && chk(INS, SIDE, sent[0][1]) === null);
  tests.push(pb.then(v => t('preload: a batch resolves { result } from main', J(v) === J({ result: 'open' }))));
  sent.length = 0;
  const bb = [api.instruct({ tasks: [] }), api.instruct({ tasks: Array(SI.BATCH_MAX + 1).fill(NA) }), api.instruct({ tasks: [NA, { ...NB, bot: 'Kimiマン' }] }), api.instruct({ tasks: [NA, { tid: 'N_3' }] }),
    api.instruct({ tasks: [NA, { tid: ' ' }] }), api.instruct({ tasks: [NA, { tid: 'N_3', bot: 'NaoAI', task: 5 }] }), api.instruct({ tasks: [NA, null] }), api.instruct({ tasks: [{ ...NA, memo: 'x'.repeat(SI.RAW_MAX + 1) }] })];
  t('preload: an empty / too long list, two Bots (a row without bot too), a row with no tid / not strings / too long -> not sent', sent.length === 0);
  tests.push(Promise.all(bb).then(v => t('preload: ...and resolves bad', v.every(x => J(x) === J({ result: 'bad' })))));
  api.instruct({ tasks: Array(SI.BATCH_MAX).fill(NA) });
  t('preload: BATCH_MAX rows are sent', sent.length === 1 && sent[0][1][0].tasks.length === SI.BATCH_MAX);
  const code = read('sidebar-preload.js');
  t('preload: its BATCH_MAX = instruct-rules.js', code.includes(`const BATCH_MAX = ${SI.BATCH_MAX};`));
  t('preload: its field names / RAW_MAX / results = instruct-rules.js', code.includes(`const FIELDS = ${J(SI.FIELDS).replace(/"/g, "'").replace(/,/g, ', ')}, RAW_MAX = ${SI.RAW_MAX};`)
    && code.includes(`const INSTRUCT = ${J(SI.RESULTS).replace(/"/g, "'").replace(/,/g, ', ')};`)); }

// ---- a right-click is a gesture ----
{ const main = read('main.js'), fn = name => { const i = main.indexOf(`function ${name}(`); if (i < 0) return ''; let d = 0, j = main.indexOf('{', main.indexOf(')', i)); for (; j < main.length; j++) { if (main[j] === '{') d++; else if (main[j] === '}' && --d === 0) break; } return main.slice(i, j + 1); };
  t('gesture: a mouse-down of any button counts (input-event \'mouseDown\'; a right-click\'s too), within 5 s', NAV.isGesture('mouseDown') && NAV.isGesture('rawKeyDown') && !NAV.isGesture('mouseMove') && !NAV.isGesture('contextMenu')
    && !/button/.test(fn('trackGesture')) && NAV.gestureOk(1000, 5999) && !NAV.gestureOk(1000, 6001));
  t('gesture: the sidebar view tracks it (trackGesture in ensureSide)', /trackGesture\(wc\);/.test(fn('ensureSide')));

  // ---- main.js ----
  const gate = fn('sidebarInstruct'), post = fn('instructPost'), send = fn('instructSend'), open = fn('openInstruct'), toast = fn('showToast');
  const noStr = s => s.replace(/'[^'\n]*'/g, "''").replace(/`[^`\n]*`/g, '``');
  t('main: sidebar:instruct is answered by ipcHandle (the policy runs first) with { result } only', /^ipcHandle\('sidebar:instruct', \(r, req\) => \(\{ result: sidebarInstruct\(r, req\) \}\)\);/m.test(main));
  t('main: only right after a click / key in the sidebar and with no other prompt over it (the box itself may be open) -> else blocked, before anything is read; a row or a batch (SI.batch: one Bot), else bad',
    /^function sidebarInstruct\(r, req\) \{\n  if \(!recentGesture\(r\.wc\) \|\| \(r\.ctx\.overlayOpen && r\.ctx\.overlayMode !== 'instruct'\)\) \{[^\n]*return 'blocked'; \}\n  const task = SI\.request\(req\), batch = task \? null : SI\.batch\(req\);\n  if \(!task && !batch\) \{[^\n]*return 'bad'; \}/m.test(gate));
  t('main: one box at a time (another window\'s closes), the draft of that tid (a batch: of its Bot), -> open', /ctxs\.forEach\(c => \{ if \(c !== r\.ctx\) \{ try \{ c\.closeInstruct\(\); \} catch \{\} \} \}\);/.test(gate)
    && /const no = \+\+insNo, key = task \? task\.tid : SI\.batchKey\(batch\.bot\);/.test(gate) && /r\.ctx\.openInstruct\(no, task \|\| batch, insDrafts\.get\(key\) \|\| ''\);/.test(gate) && /return 'open';\n\}$/.test(gate));
  t('main: the row is never logged (only fixed words)', !/dlog\([^\n]*\b(req|task|no)\b/.test(noStr(gate)) && !/dlog\([^\n]*\b(task|text|hook|body)\b/.test(noStr(post + send)));
  t('main: the POST: the setting read in main (secret: here only), the body built here (a new messageId from 12 random bytes, the time now), IW.post with its own session',
    (main.match(/hooks\(\)\.secret\(\)/g) || []).length === 1 && /const hook = hooks\(\)\.secret\(\);/.test(post)
    && /SI\.payload\(\{ id: SI\.messageId\(randomBytes\(12\)\), instruction: text, task, now: new Date\(\), \.\.\.\(extra && typeof extra === 'object' \? extra : \{\}\) \}\)/.test(post) && /IW\.post\(\{ url: hook\.url, key: hook\.key, body, fetch: insFetch, timeoutMs: SI\.TIMEOUT_MS \}\)/.test(post)
    && /if \(!hook\) return \{ ok: false, code: hook === false \? 'READ' : 'UNSET' \};/.test(post));
  t('main: the POST\'s log: the result code / HTTP status only', /dlog\('instruct', r\.ok \? 'sent' : 'not sent', r\.code \|\| '', r\.status \|\| ''\);/.test(post) && (post.match(/dlog\(/g) || []).length === 1);
  t('main: the URL / key never reach a page, a log or a diagnostic (hook.url / hook.key only inside the IW.post call)', (main.match(/hook\.(url|key)\b/g) || []).length === 2
    && !/(webContents|wc)\.send\([^\n]*(secret|hook\.url|hook\.key|hooks\(\))/.test(main) && !/dlog\([^\n]*(secret\(|hook\.url|hook\.key|a\.url|a\.key)/.test(main) && !/diag\.rec\([^\n]*(instruct|hook)/i.test(main));
  t('main: what a page learns of the setting: hookView / hookReply (SI.hookView: configured, host, available) only', /^const hookView = \(\) => SI\.hookView\(hooks\(\)\.status\(\)\);/m.test(main)
    && /^const hookReply = r => \(\{ \.\.\.SI\.hookView\(r\), code: r\.ok \? '' : IW\.ERR\.includes\(r\.code\) \? r\.code : 'WRITE' \}\);/m.test(main)
    && /openOverlay\('instruct', batch \? \{ no, batch, draft, hook: hookView\(\) \} : \{ no, task, draft, hook: hookView\(\) \}\);/.test(open) && /hook: hookView\(\) \}\); \}/.test(fn('openSidebarSettings'))
    && (main.match(/'instruct-hook'/g) || []).length === 2 && (main.match(/overlay\.webContents\.send\('instruct-hook', hookReply\(instructWebhook\.(set\(\{ url: a\.url, key: a\.key \}\)|clear\(\))\)\)/g) || []).length === 2);
  t('main: the webhook save / removal only while the 進捗サイドバー settings screen is open', /case 'instruct-hook-save': if \(overlayOpen && overlayMode === 'sidebar-settings'\)/.test(main) && /case 'instruct-hook-clear': if \(overlayOpen && overlayMode === 'sidebar-settings'\)/.test(main));
  t('main: stored in its own file in userData through safeStorage (instruct-webhook.js), never in panes.json\'s settings',
    /IW\.createStore\(\{ file: path\.join\(app\.getPath\('userData'\), 'instruct-webhook\.json'\), safe: safeStorage, fs \}\)/.test(main) && !/settings\.(instruct|hook|webhook|naoai)/i.test(main)
    && !/instruct|webhook/i.test(read('state-schema.js') + read('state-store.js')));
  t('main: the scripted setup (instructWebhook.set / status / clear) is on the module export only - the same store as the settings screen, no IPC for it',
    /^if \(typeof module !== 'undefined' && module\.exports\) module\.exports\.instructWebhook = instructWebhook;/m.test(main) && /set: v => \{ const r = hooks\(\)\.set\(v\);/.test(main)
    && /process\.mainModule\.exports\.instructWebhook\.set\(\{ url: 'https:\/\/hooks\.cursor\.com\/routine', key: '…' \}\)/.test(main) && !Object.keys(P.CHANNELS).some(ch => /hook|webhook/.test(ch)));
  t('main: the POST\'s session: in memory (no persist:), nothing else uses it', SI.PARTITION === 'xg-instruct' && !SI.PARTITION.startsWith('persist:') && /^const insFetch = \(url, opts\) => instructSession\(\)\.fetch\(url, opts\);/m.test(main));
  t('main: the box = the overlay in mode instruct on SI.boxRect only (open + relayout), focused, sent at once', /overlay\.setBounds\(mode === 'instruct' \? insRect\(\) : \{ x: 0, y: 0, width: w, height: h \}\)/.test(fn('openOverlay'))
    && /overlay\.setBounds\(overlayMode === 'instruct' \? insRect\(\)/.test(fn('relayout')) && /const insRect = \(\) => \{ const \[w, h\] = win\.getContentSize\(\); return SI\.boxRect\(w, h\); \};/.test(main)
    && /mode === 'sidebar-settings' \|\| mode === 'instruct'\) \{ overlay\.webContents\.send\('overlay-open'/.test(fn('openOverlay')) && /overlay\.webContents\.focus\(\);/.test(fn('openOverlay')));
  t('main: a click outside closes it, the keyboard left where the user went (the sidebar at once; a pane / the bar through the overlay\'s blur; another app: kept)',
    /if \(m\.type === 'mouseDown'\) closeInstruct\(\);/.test(fn('ensureSide')) && /function closeInstruct\(\) \{ if \(overlayOpen && overlayMode === 'instruct'\) closeOverlay\(true\); \}/.test(main)
    && /overlay\.webContents\.on\('blur', \(\) => \{ if \(overlayOpen && overlayMode === 'instruct'\) setTimeout\(instructBlur, 60\); \}\);/.test(main) && /windowActive\(\) && !overlay\.webContents\.isDestroyed\(\) && !overlay\.webContents\.isFocused\(\)\) closeInstruct\(\);/.test(fn('instructBlur'))
    && /if \(keepFocus === true\) return;\n  keyboardFocus = panes\[focused\]/.test(fn('closeOverlay')) && /ins = null;/.test(fn('closeOverlay')));
  t('main: Esc in the box is the page\'s (an IME composition cancels, never closes)', /if \(overlayMode === 'instruct' && input\.key === 'Escape'\) return;/.test(main));
  t('main: send: the box on screen only, once at a time, the text kept as the draft until it went out; sent -> draft gone + closed; not sent -> stays with why; a toast either way',
    /if \(!box \|\| box\.no !== no \|\| box\.sending\) return;\n  instructDraft\(no, text\);/.test(send) && /if \(r\.ok && insDrafts\.get\(box\.key\) === text\) SI\.draftSet\(insDrafts, box\.key, ''\);/.test(send)
    && /const m = \{ text: SI\.toastText\(r, box\.batch \? `\$\{box\.batch\.tasks\.length\}件` : box\.task\.tid\), kind: SI\.toastKind\(r\) \};\n  showToast\(m\);/.test(send) && /if \(r\.ok\) closeOverlay\(\); else insTell\(box, \{ sending: false, note: m\.text, kind: m\.kind, hook: hookView\(\) \}\);/.test(send));
  t('main: the toast: a display-only child window (no focus, no mouse, toast-preload: no send API), bottom centre, SI.TOAST_MS', /focusable: false/.test(toast) && /toastWin\.setIgnoreMouseEvents\(true\);/.test(toast)
    && /preload: path\.join\(__dirname, 'toast-preload\.js'\), contextIsolation: true, nodeIntegration: false, sandbox: true/.test(toast) && /guardUi\(toastWin\.webContents\);/.test(toast)
    && /SI\.toastRect\(c\.width, c\.height\)/.test(toast) && /child\.showInactive\(\)/.test(toast) && /setTimeout\(hideToast, SI\.TOAST_MS\)/.test(toast)
    && /child\.webContents\.send\('toast-display', \{ text: m\.text, kind: m\.kind, dark: nativeTheme\.shouldUseDarkColors \}\);/.test(toast) && (main.match(/showToast\(/g) || []).length >= 2);
  t('main: the box\'s actions: send / draft / settings (the box on screen only)', /case 'instruct-send': instructSend\(a\.no, a\.text, a\.choice\)\.catch\(\(\) => \{\}\); break;/.test(main) && /case 'instruct-draft': instructDraft\(a\.no, a\.text\); break;/.test(main)
    && /case 'instruct-settings': if \(overlayOpen && overlayMode === 'instruct'\) openSidebarSettings\(\); break;/.test(main));

  // main's own instructSend (vm): a choice button's label goes through SI.choiceOf (the row's options) into the object SI.payload sees; the label
  // alone is enough to send. A batch: every row in one POST, nothing typed is fine, the page's selection dropped once it went out
  const posts = [], toasts = [], told = []; let clears = 0, postOk = true;
  const mctx = { SI, ins: null, insDrafts: new Map(), overlayOpen: true, overlayMode: 'instruct', hookView: () => ({ configured: true, host: '', available: true }), instructDraft() {},
    insTell: (box, v) => told.push(v), showToast: m => toasts.push(m), closeOverlay: () => told.push('closed'), sideClear: () => { clears++; },
    instructPost: async (task, text, extra) => { const body = SI.payload({ id: 'x_' + '1'.repeat(24), instruction: text, task, now: new Date(0), ...extra }); posts.push({ task, extra, body });
      return body && postOk ? { ok: true, status: 200 } : body ? { ok: false, code: 'HTTP', status: 500 } : { ok: false, code: 'TEXT' }; } };
  vm.runInNewContext('async ' + send, mctx);   // fn() starts at 'function'
  t('main: instructSend is the async function run here', /^async function instructSend\(no, text, choice\) \{$/m.test(main));
  const ROWA = SI.request({ tid: 'T-5', task: '方針', mode: 'answer', ask: 'どれ？', options: ['案A', '案B', '案C'] });
  const box = (task, batch) => ({ no: 5, task, batch: batch || null, key: batch ? SI.batchKey(batch.bot) : task.tid, sending: false });
  const go = (b, msg) => { mctx.ins = b; posts.length = 0; toasts.length = 0; told.length = 0; clears = 0;
    return chk('overlay-run', OV, [{ type: 'instruct-send', no: 5, ...msg }]) === null ? mctx.instructSend(5, msg.text, msg.choice).then(() => posts[0]) : Promise.resolve('refused'); };
  tests.push((async () => {
    let q = await go(box(ROWA), { text: '', choice: '案B' });
    t('main: a choice button, nothing typed -> mode answer + choice, instruction = the label, task { tid, task }, closed', J(q.extra) === J({ mode: 'answer', choice: '案B' })
      && q.body.choice === '案B' && q.body.instruction === '案B' && !('choices' in q.body) && J(q.body.task) === J({ tid: 'T-5', task: '方針' }) && told.includes('closed')
      && /NaoAIに送りました（T-5）/.test(toasts[0].text) && clears === 0);
    q = await go(box(ROWA), { text: ' 急ぎで ', choice: '案A' });
    t('main: a choice button + a typed text -> instruction = the text, choice = the label', q.body.instruction === '急ぎで' && q.body.choice === '案A');
    q = await go(box(ROWA), { text: '理由はこれ' });
    t('main: 送信 with a text only -> mode answer, no choice', J(q.extra) === J({ mode: 'answer' }) && q.body.instruction === '理由はこれ' && !('choice' in q.body));
    q = await go(box(ROWA), { text: 'メモ', choice: '案Z' });
    t('main: a label not on the row is dropped before the POST (never in the body)', J(q.extra) === J({ mode: 'answer' }) && !J(q.body).includes('案Z') && q.body.instruction === 'メモ');
    q = await go(box(ROWA), { text: '  ', choice: '案Z' });
    t('main: nothing usable (no text, no label of the row) -> no POST, 「指示を入力してください」 and the box stays', q === undefined && toasts.length === 1 && /指示を入力してください/.test(toasts[0].text)
      && told.some(v => v && v.note && /指示を入力/.test(v.note)) && !told.includes('closed'));
    q = await go(box(SI.request({ tid: 'T-6', task: '普通' })), { text: '普通', choice: '案A' });
    t('main: not an answer -> the label ignored, the row as before', J(q.extra) === J({}) && !('mode' in q.body) && !('choice' in q.body) && J(Object.keys(q.body.task)) === J(SI.FIELDS));
    const BT = SI.batch({ tasks: [{ tid: 'N_2', task: '確認B', bot: 'NaoAI' }, { tid: 'N_1', task: '確認A', bot: 'NaoAI' }] });
    mctx.insDrafts.set(SI.batchKey('NaoAI'), '');
    q = await go(box(null, BT), { text: '' });
    t('main: a batch, nothing typed -> one POST: mode batch, tasks in the page\'s order, bot, the titles as the instruction; 「（2件）」; closed; the page\'s selection dropped',
      posts.length === 1 && q.task === null && J(q.extra) === J({ mode: 'batch', tasks: BT.tasks }) && q.body.mode === 'batch' && J(q.body.tasks) === J([{ tid: 'N_2', task: '確認B' }, { tid: 'N_1', task: '確認A' }])
      && q.body.bot === 'NaoAI' && !('task' in q.body) && q.body.instruction === '確認B\n確認A' && /NaoAIに送りました（2件）/.test(toasts[0].text) && told.includes('closed') && clears === 1);
    q = await go(box(null, BT), { text: 'まとめて把握。残りは別タスクで' });
    t('main: a batch with a text -> that text, still one POST', posts.length === 1 && q.body.instruction === 'まとめて把握。残りは別タスクで' && q.body.tasks.length === 2 && clears === 1);
    q = await go(box(null, BT), { text: 'x', choice: '案A' });
    t('main: a batch never carries a choice / answer mode', q.body.mode === 'batch' && !('choice' in q.body) && J(q.extra) === J({ mode: 'batch', tasks: BT.tasks }));
    postOk = false; mctx.insDrafts.set(SI.batchKey('NaoAI'), '書きかけ');
    q = await go(box(null, BT), { text: '書きかけ' });
    t('main: a batch not sent -> the box stays with why, the draft (per Bot) kept, the selection kept', !told.includes('closed') && told.some(v => v && /HTTP 500/.test(v.note || ''))
      && clears === 0 && mctx.insDrafts.get(SI.batchKey('NaoAI')) === '書きかけ');
    postOk = true;
    t('main: the app never removes / completes a ledger task (no delete / done in the send path)', !/delete|remove|done|complete/i.test(noStr(send).replace(/insDrafts|draftSet/g, '')));
  })());

  // (進捗サイドバー) a click outside the sidebar drops the page's selection: main -> its own sidebar view only, no payload
  const clear = fn('sideClear');
  t('main: sideClear tells this window\'s sidebar page only, on its fixed channel, with nothing else', /const wc = side && side\.webContents;/.test(clear)
    && /if \(wc && !wc\.isDestroyed\(\) && !wc\.isCrashed\(\)\) wc\.send\('sidebar:clear-selection'\);/.test(clear) && (main.match(/'sidebar:clear-selection'/g) || []).length === 1);
  t('main: a mouse-down in a pane / on the bar (not on the sidebar\'s edge) clears it; one in the sidebar / the box does not', /wc\.on\('before-mouse-event', \(e, m\) => \{ if \(m\.type === 'mouseDown'\) sideClear\(\); \}\);/.test(fn('addPane') || main)
    && /win\.webContents\.on\('before-mouse-event', \(e, m\) => \{ if \(m\.type === 'mouseDown' && !SR\.inRect\(m, sideLay\(\)\.handle\)\) sideClear\(\); \}\);/.test(main)
    && !/sideClear/.test(fn('ensureSide')) && !/overlay\.webContents\.on\('before-mouse-event'[^\n]*sideClear/.test(main) && (main.match(/sideClear\(\);/g) || []).length === 3);
  { const SRL = require('../src/sidebar-rules'), L = SRL.layout({ x: 0, y: 40, w: 1200, h: 700 }, 300, 6), H = L.handle;
    t('sidebar-rules inRect: the edge strip only (a press there is a resize, not outside)', SRL.inRect({ x: H.x, y: H.y + 10 }, H) && SRL.inRect({ x: H.x + H.w - 1, y: H.y + H.h - 1 }, H)
      && !SRL.inRect({ x: H.x + H.w, y: H.y + 10 }, H) && !SRL.inRect({ x: H.x - 1, y: H.y + 10 }, H) && !SRL.inRect({ x: H.x, y: H.y - 1 }, H) && !SRL.inRect({ x: 5, y: 5 }, null) && !SRL.inRect(null, H)
      && !SRL.inRect({ x: NaN, y: 50 }, H)); } }

// ---- toast page / preload ----
{ const tp = read('toast-preload.js');
  t('toast-preload: receives only (no send / invoke / sendSync), one fixed channel, never the event', !/ipcRenderer\.(send|invoke|sendSync|sendTo|postMessage)/.test(tp) && /ipcRenderer\.on\('toast-display', \(_, m\) => cb\(m\)\)/.test(tp));
  t('toast page: strict CSP (no inline script, nothing remote), text only (textContent)', /default-src 'none'; script-src 'self'; style-src 'self'/.test(read('toast.html')) && /textContent = /.test(read('toast.js')) && !/innerHTML/.test(read('toast.js'))); }

// ---- the box (overlay.js), its real handlers on a tiny fake DOM ----
{ const ov = read('overlay.js'), a = ov.indexOf('// ---- NaoAIへの指示 (instruct-rules.js): the box over the panes'), b = ov.indexOf('// ---- update settings:', a);
  let focused = null;
  const mk = (id, extra) => ({ id, handlers: {}, style: {}, textContent: '', hidden: false, className: '', value: '', disabled: false, readOnly: false, scrollHeight: 30, offsetHeight: 0, title: '', maxLength: -1,
    addEventListener(type, f) { (this.handlers[type] = this.handlers[type] || []).push(f); }, focus() { focused = this; }, setSelectionRange(x, y) { this.sel = [x, y]; }, ...extra });
  const els = Object.fromEntries(['#ins', '#ins-text', '#ins-send', '#ins-note', '#ins-settings', '#ins-count', '#ins-tid', '#ins-bot', '#ins-task', '#ins-ask', '#ins-choices', '.ins-head', '.ins-box', '.ins-in'].map(s => [s, mk(s)]));
  const calls = [], win = {}; let onIns = null;
  const ctx = { $: s => els[s], mode: 'instruct', InstructRules: SI, addEventListener: (type, f) => { (win[type] = win[type] || []).push(f); },
    mpb: { run: x => calls.push(x), closeOverlay: () => calls.push('close'), onInstruct: cb => { onIns = cb; } } };
  vm.runInNewContext(ov.slice(a, b), ctx);
  const text = els['#ins-text'], key = (k, o = {}) => { const e = { key: k, shiftKey: false, altKey: false, repeat: false, isComposing: false, keyCode: k === 'Enter' ? 13 : k === 'Escape' ? 27 : 65, ...o, prevented: false, target: text, preventDefault() { this.prevented = true; } };
    text.handlers.keydown.forEach(f => f(e)); return e; };
  const typeIn = v => { text.value = v; text.handlers.input.forEach(f => f({ target: text })); };
  ctx.renderInstruct({ mode: 'instruct', no: 7, task: { tid: 'T-12', task: 'LP修正', bot: 'Writer', state: '待機', memo: '' }, draft: '下書き', hook: { configured: true, host: 'hooks.cursor.com', available: true } });
  t('box: the row on one line (tid · Bot · task), the draft restored, the keyboard in the field at its end', els['#ins-tid'].textContent === 'T-12' && els['#ins-bot'].textContent === 'Writer' && !els['#ins-bot'].hidden
    && els['#ins-task'].textContent === 'LP修正' && text.value === '下書き' && focused === text && J(text.sel) === J([3, 3]) && text.maxLength === SI.TEXT_MAX && els['#ins-settings'].hidden === true && els['#ins-note'].textContent === '');
  typeIn('見出しを直して');
  t('box: every change goes to main as the draft of this box (its number, the text) - nothing else', J(calls.pop()) === J({ type: 'instruct-draft', no: 7, text: '見出しを直して' }) && calls.length === 0);
  let e = key('Enter', { isComposing: true }); const e2 = key('Enter', { keyCode: 229 }); text.handlers.compositionstart.forEach(f => f()); const e3 = key('Enter'); text.handlers.compositionend.forEach(f => f());
  t('box: Enter during an IME composition (isComposing / 229 / between compositionstart and -end) sends nothing and is left to the IME', calls.length === 0 && !e.prevented && !e2.prevented && !e3.prevented);
  e = key('Escape', { isComposing: true });
  t('box: Esc during a composition does not close', calls.length === 0 && !e.prevented);
  e = key('Enter', { shiftKey: true });
  t('box: ⇧↵ is a new line (the field\'s own, nothing sent)', calls.length === 0 && !e.prevented);
  e = key('Enter');
  t('box: Enter sends this box\'s number + the text once; the field read-only and 送信 off meanwhile', e.prevented && J(calls.pop()) === J({ type: 'instruct-send', no: 7, text: '見出しを直して' }) && text.readOnly && els['#ins-send'].disabled
    && els['#ins-note'].textContent === '送信中…');
  key('Enter'); els['#ins-send'].onclick();
  t('box: no second send while one is under way', calls.length === 0);
  onIns({ no: 6, sending: false, note: 'x', kind: 'err' });
  t('box: an answer for another box is ignored', text.readOnly === true);
  onIns({ no: 7, sending: false, note: '送れませんでした（HTTP 401）', kind: 'err', hook: { configured: true, host: 'hooks.cursor.com', available: true } });
  t('box: not sent -> the text kept, editable, the reason shown, the keyboard back in the field', text.value === '見出しを直して' && !text.readOnly && !els['#ins-send'].disabled && els['#ins-note'].textContent === '送れませんでした（HTTP 401）'
    && els['#ins-note'].className === 'k-err' && focused === text);
  e = key('Enter', { repeat: true });
  t('box: a held Enter sends nothing', e.prevented && calls.length === 0);
  e = key('Escape');
  t('box: Esc closes (the draft is main\'s already)', e.prevented && calls.pop() === 'close');
  typeIn('   ');
  t('box: spaces only -> 送信 off, Enter sends nothing', els['#ins-send'].disabled && (calls.pop(), key('Enter'), calls.length === 0));
  els['#ins'].handlers.mousedown.forEach(f => f({ target: els['#ins'], preventDefault() {} }));
  t('box: a click on the margin around the box closes it; on the box itself not', calls.pop() === 'close' && (els['#ins'].handlers.mousedown.forEach(f => f({ target: els['.ins-box'], preventDefault() {} })), calls.length === 0));
  ctx.renderInstruct({ mode: 'instruct', no: 8, task: { tid: 'T-13' }, draft: '', hook: { configured: false, host: '', available: true } });
  t('box: no webhook -> 「NaoAIのwebhookが未設定です」 + 設定を開く; no Bot -> no badge', els['#ins-note'].textContent === 'NaoAIのwebhookが未設定です' && els['#ins-settings'].hidden === false && els['#ins-bot'].hidden === true);
  els['#ins-settings'].onclick();
  t('box: 設定を開く asks main for the settings screen', J(calls.pop()) === J({ type: 'instruct-settings' }));
  const seg = ov.slice(a, b);
  t('box: never reads / shows a URL or key (the page gets none)', !/\.url\b|\.key\b(?!Code)|hookUrl|hookKey/.test(seg.replace(/e\.key/g, '')) && !/innerHTML/.test(seg)); }

// ---- 待ちの回答 in the box (overlay.js): the field + 送信 stay with the choices; a choice sends that one label at once; 送信 = the text ----
{ const ov = read('overlay.js'), a = ov.indexOf('// ---- NaoAIへの指示 (instruct-rules.js): the box over the panes'), b = ov.indexOf('// ---- update settings:', a);
  let focused = null;
  const mk = tag => ({ tag, handlers: {}, style: {}, attrs: {}, children: [], textContent: '', hidden: false, className: '', value: '', disabled: false, readOnly: false, scrollHeight: 30, scrollTop: 0,
    offsetHeight: 0, title: '', maxLength: -1, placeholder: '', type: '',
    addEventListener(type, f) { (this.handlers[type] = this.handlers[type] || []).push(f); }, focus() { focused = this; }, setSelectionRange(x, y) { this.sel = [x, y]; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; },
    get firstChild() { return this.children[0] || null; }, appendChild(c) { this.children.push(c); return c; }, removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; } });
  const els = Object.fromEntries(['#ins', '#ins-text', '#ins-send', '#ins-note', '#ins-settings', '#ins-count', '#ins-tid', '#ins-bot', '#ins-task', '#ins-ask', '#ins-choices', '#ins-list', '.ins-head', '.ins-box', '.ins-in'].map(s => [s, mk(s)]));
  const bodyCls = new Set(), document = { body: { classList: { toggle: (c, on) => { if (on) bodyCls.add(c); else bodyCls.delete(c); } } }, createElement: tag => mk(tag) };
  const calls = []; let onIns = null;
  const ctx = { $: s => els[s], mode: 'instruct', InstructRules: SI, document, addEventListener() {},
    mpb: { run: x => calls.push(x), closeOverlay: () => calls.push('close'), onInstruct: cb => { onIns = cb; } } };
  vm.runInNewContext(ov.slice(a, b), ctx);
  const text = els['#ins-text'], sendB = els['#ins-send'], chEl = els['#ins-choices'], listEl = els['#ins-list'], btns = () => chEl.children;
  const key = (k, o = {}) => { const e = { key: k, shiftKey: false, altKey: false, repeat: false, isComposing: false, keyCode: k === 'Enter' ? 13 : k === 'Escape' ? 27 : 65, ...o, prevented: false, target: text, preventDefault() { this.prevented = true; } };
    text.handlers.keydown.forEach(f => f(e)); return e; };
  const typeIn = v => { text.value = v; text.handlers.input.forEach(f => f({ target: text })); calls.splice(calls.findIndex(c => c && c.type === 'instruct-draft'), 1); };
  const click = label => btns().find(x => x.textContent === label).handlers.click.forEach(f => f({ detail: 1 }));
  const HOOKV = { configured: true, host: 'hooks.cursor.com', available: true };
  ctx.renderInstruct({ mode: 'instruct', no: 9, task: { tid: 'T-9', task: '方針', bot: 'Writer', mode: 'answer', ask: 'どれにしますか', options: ['案A', '案B', '案C'] }, draft: '', hook: HOOKV });
  t('answer box: with choices the field + 送信 stay visible (「回答を入力」), the wait prompt above, the choices as buttons (no toggle state), the keyboard in the field', els['.ins-in'].hidden === false
    && text.placeholder === '回答を入力' && els['#ins-ask'].hidden === false && els['#ins-ask'].textContent === 'どれにしますか' && chEl.hidden === false && bodyCls.has('answer') && !bodyCls.has('batch')
    && btns().map(x => x.textContent).join() === '案A,案B,案C' && btns().every(x => x.tag === 'button' && x.type === 'button' && x.getAttribute('aria-pressed') === null) && focused === text
    && listEl.hidden === true && els['#ins-tid'].hidden === false);
  t('answer box: nothing typed -> 送信 off, Enter sends nothing', sendB.disabled === true && (key('Enter'), calls.length === 0));
  typeIn('   ');
  t('answer box: spaces only -> still off', sendB.disabled === true && (key('Enter'), calls.length === 0));
  typeIn('');
  click('案C');
  const m0 = calls.pop();
  t('answer box: a choice click sends that one label at once (choice set; nothing to toggle, no 送信 needed), the IPC shape', J(m0) === J({ type: 'instruct-send', no: 9, text: '', choice: '案C' })
    && chk('overlay-run', OV, [m0]) === null && calls.length === 0 && els['#ins-note'].textContent === '送信中…');
  click('案B'); sendB.onclick(); key('Enter');
  t('answer box: while sending: choices and 送信 off, no second send', btns().every(x => x.disabled) && sendB.disabled && text.readOnly && calls.length === 0);
  onIns({ no: 9, sending: false, note: '送れませんでした（HTTP 500）', kind: 'err', hook: HOOKV });
  t('answer box: not sent -> choices on again, the reason shown, the keyboard back in the field', btns().every(x => !x.disabled) && els['#ins-note'].textContent === '送れませんでした（HTTP 500）' && focused === text);
  typeIn('補足です');
  let e = key('Enter', { isComposing: true }); const e2 = key('Enter', { keyCode: 229 });
  text.handlers.compositionstart.forEach(f => f()); const e3 = key('Enter'); text.handlers.compositionend.forEach(f => f());
  t('answer box: Enter during an IME composition sends nothing', calls.length === 0 && !e.prevented && !e2.prevented && !e3.prevented);
  e = key('Enter');
  const m1 = calls.pop();
  t('answer box: 送信 / Enter with a text only -> the text, no choice key', e.prevented && J(m1) === J({ type: 'instruct-send', no: 9, text: '補足です' }) && chk('overlay-run', OV, [m1]) === null);
  onIns({ no: 9, sending: false, note: 'x', kind: 'err', hook: HOOKV }); click('案A');
  t('answer box: a typed text goes with a choice click', J(calls.pop()) === J({ type: 'instruct-send', no: 9, text: '補足です', choice: '案A' }));
  ctx.renderInstruct({ mode: 'instruct', no: 10, task: { tid: 'T-10', task: '別', mode: 'answer', options: ['はい', 'いいえ'] }, draft: '', hook: HOOKV });
  t('answer box: another row -> its own choices, the prompt hidden (none given), 送信 off', btns().map(x => x.textContent).join() === 'はい,いいえ' && sendB.disabled && els['#ins-ask'].hidden === true);
  ctx.renderInstruct({ mode: 'instruct', no: 11, task: { tid: 'T-11', task: '待ち', mode: 'answer' }, draft: '', hook: HOOKV });
  t('answer box: a wait with no options -> 「何を待っているか」, no choices, the field; a text is needed', chEl.hidden === true && btns().length === 0 && els['.ins-in'].hidden === false
    && /何を待っているか/.test(els['#ins-ask'].textContent) && sendB.disabled && (typeIn('了解'), !sendB.disabled) && (key('Enter'), J(calls.pop()) === J({ type: 'instruct-send', no: 11, text: '了解' })));
  ctx.renderInstruct({ mode: 'instruct', no: 12, task: { tid: 'T-12', task: '普通', options: ['案A'] }, draft: '', hook: HOOKV });
  t('box: a right-click row (not an answer) -> no choices, 「NaoAIへの指示」', chEl.hidden === true && btns().length === 0 && text.placeholder === 'NaoAIへの指示' && !bodyCls.has('answer'));

  // 一括: the rows selected on the page -> one box: the Bot + N件, the rows (tid + title), the field; 送信 even with nothing typed
  const BATCH = { bot: 'NaoAI', tasks: [{ tid: 'N_2', task: '確認B', bot: 'NaoAI', state: '待ち', memo: '' }, { tid: 'N_1', task: '確認A', bot: 'NaoAI', state: '待ち', memo: '' }] };
  ctx.renderInstruct({ mode: 'instruct', no: 13, batch: BATCH, draft: '', hook: HOOKV });
  const items = listEl.children.map(li => li.children.map(c => c.tag + ':' + c.textContent).join('|'));
  t('batch box: the Bot and 2件 on the head line (no tid chip), the rows in order (tid + title), the field 「NaoAIへの指示」, no choices / wait prompt', els['#ins-tid'].hidden === true && els['#ins-bot'].textContent === 'NaoAI'
    && els['#ins-task'].textContent === '2件' && listEl.hidden === false && J(items) === J(['code:N_2|span:確認B', 'code:N_1|span:確認A']) && listEl.children.every(li => li.className === 'ins-li')
    && text.placeholder === 'NaoAIへの指示' && chEl.hidden === true && els['#ins-ask'].hidden === true && bodyCls.has('batch') && !bodyCls.has('answer') && focused === text && els['.ins-head'].title === 'N_2 · N_1');
  t('batch box: nothing typed -> 送信 on (main sends the titles)', sendB.disabled === false);
  e = key('Enter', { isComposing: true }); const be2 = key('Enter', { keyCode: 229 });
  t('batch box: Enter during an IME composition sends nothing', calls.length === 0 && !e.prevented && !be2.prevented);
  e = key('Escape');
  t('batch box: Esc closes without sending', e.prevented && calls.pop() === 'close' && calls.length === 0);
  e = key('Enter');
  const mb = calls.pop();
  t('batch box: Enter sends once: this box\'s number + the text only (the rows are main\'s)', e.prevented && J(mb) === J({ type: 'instruct-send', no: 13, text: '' }) && chk('overlay-run', OV, [mb]) === null && calls.length === 0);
  sendB.onclick();
  t('batch box: no second send while one is under way', calls.length === 0 && sendB.disabled);
  ctx.renderInstruct({ mode: 'instruct', no: 14, task: { tid: 'T-14', task: '普通' }, draft: '', hook: HOOKV });
  t('box: a row after a batch -> no list, the tid chip back, 送信 needs a text again', listEl.hidden === true && listEl.children.length === 0 && els['#ins-tid'].hidden === false && els['#ins-tid'].textContent === 'T-14'
    && !bodyCls.has('batch') && sendB.disabled === true);

  // no new copy: the box's markup and its strings are the ones it had (+ the list element, empty)
  const html = read('overlay.html'), ins = html.slice(html.indexOf('<div id="ins"'), html.indexOf('<script', html.indexOf('<div id="ins"')));
  t('markup: the box\'s visible text is unchanged (no helper sentence); the choices / list / field elements are there', ins.replace(/<[^>]*>/g, '').replace(/\s+/g, '') === '✦送信設定を開く↵送信⇧↵改行esc閉じる'
    && /<div id="ins-choices" hidden><\/div>/.test(ins) && /<div id="ins-list" hidden><\/div>/.test(ins) && /<div class="ins-in">/.test(ins) && /placeholder="NaoAIへの指示"/.test(ins));
  const seg = ov.slice(a, b).replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, ''), ja = [...new Set([...seg.matchAll(/'([^'\n]*[぀-ヿ一-鿿][^'\n]*)'/g)].map(m => m[1]))].sort();
  const tpl = [...new Set([...seg.matchAll(/`([^`\n]*[぀-ヿ一-鿿][^`\n]*)`/g)].map(m => m[1]))];
  t('overlay.js: the box says nothing new (its Japanese strings are the ones it had; the batch adds only 「N件」)', J(ja) === J(['NaoAIのwebhookが未設定です', 'NaoAIへの指示', '何を待っているか：待ちの内容が台帳にありません。', '回答を入力', '送信中…'].sort())
    && J(tpl) === J(['${rows.length}件']));
  t('overlay.js: no toggle left (insToggle / insPick / aria-pressed), a choice click = insGoChoice', !/insToggle|insPick|aria-pressed/.test(seg) && /b\.addEventListener\('click', \(\) => insGoChoice\(label\)\);/.test(seg));
  const css = read('overlay.css');
  t('overlay.css: no picked state for choices; the batch list scrolls inside the box (wrapped titles, never cut), which never outgrows its view; no emoji / marks',
    !/#ins-choices button\[aria-pressed/.test(css) && !/#ins-(choices|list)[^{]*::?(before|after)/.test(css) && !/\.ins-li[^{]*::?(before|after)/.test(css)
    && /\.ins-box\{[^}]*max-height:100%;display:flex;flex-direction:column/.test(css) && /#ins-choices\{flex:0 1 auto;min-height:\d+px;overflow-y:auto/.test(css)
    && /#ins-list\{flex:0 1 auto;min-height:\d+px;overflow-y:auto/.test(css) && /\.ins-li span\{[^}]*overflow-wrap:anywhere/.test(css) && !/\.ins-li[^}]*(ellipsis|nowrap)/.test(css)
    && /#ins-tid\[hidden\]\{display:none\}/.test(css) && /body\.instruct\.batch #ins-text\{max-height:calc\(4px \+ 3lh\)\}/.test(css.replace('body.instruct.answer #ins-text,', ''))
    && /\.ins-box>\*\{flex:none\}/.test(css) && !/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(css.slice(css.indexOf('/* 待ちの回答'), css.indexOf('body.instruct.answer #ins{')))); }

// ---- the settings section (overlay.js renderSidebarSettings + the webhook form), real handlers on a fake panel ----
{ const ov = read('overlay.js'), a = ov.indexOf("const updatePanel = $('#update-panel');"), b = ov.indexOf('function renderUpdate(o) {', a);
  const handlers = {}, calls = [];
  const field = v => ({ value: v, textContent: '', className: '', innerHTML: '', disabled: false, focus() {} });
  const fields = { '#sidebar-url': field(''), '#approve-error': field(''), '#hook-url': field(''), '#hook-key': field(''), '#hook-error': field(''), '#hook-status': field(''), '#hook-save': field('') };
  const panel = { innerHTML: '', querySelector: sel => fields[sel] || null, querySelectorAll: () => [], addEventListener: (type, fn) => { handlers[type] = fn; } };
  let onHook = null;
  const ctx = { $: () => panel, ApproveSetting: require('../src/approve-setting'), SidebarRules: require('../src/sidebar-rules'), InstructRules: SI, mode: 'sidebar-settings', ctx: {}, setTimeout: () => {},
    mpb: { run: x => calls.push(x), closeOverlay: () => calls.push('close'), onApprovePicked() {}, onInstructHook: cb => { onHook = cb; } },
    esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) };
  vm.runInNewContext(ov.slice(a, b), ctx);
  ctx.renderSidebarSettings({ mode: 'sidebar-settings', sidebar: { url: '' }, hook: { configured: true, host: 'hooks.cursor.com', available: true } });
  const html = panel.innerHTML;
  t('settings: 「NaoAIへの指示（webhook）」 with a URL field and a password field for the key, 保存 / 削除, both empty', html.includes('NaoAIへの指示（webhook）') && /<input id="hook-url" type="text"[^>]*>/.test(html)
    && /<input id="hook-key" type="password"[^>]*>/.test(html) && !/id="hook-(url|key)"[^>]*value=/.test(html) && html.includes('>保存</button>') && html.includes('data-hook-action="clear">削除</button>'));
  t('settings: what is set is told by its host only', fields['#hook-status'].innerHTML === '設定済み: <b>hooks.cursor.com</b>' && !html.includes('routine'));
  const submit = id => handlers.submit({ preventDefault() {}, target: { id } });
  fields['#hook-url'].value = 'http://hooks.cursor.com/routine'; fields['#hook-key'].value = KEY; submit('hook-form');
  t('settings: an unusable URL -> said on the screen, nothing sent', calls.length === 0 && /cursor\.com \/ cursor\.sh/.test(fields['#hook-error'].textContent));
  fields['#hook-url'].value = HOOK; fields['#hook-key'].value = 'short'; submit('hook-form');
  t('settings: a short key -> said, nothing sent', calls.length === 0 && /8〜500/.test(fields['#hook-error'].textContent));
  fields['#hook-url'].value = ' ' + HOOK + ' '; fields['#hook-key'].value = ' ' + KEY + ' '; submit('hook-form');
  t('settings: 保存 (the webhook form) -> instruct-hook-save with the trimmed URL + key; the sidebar URL form is not sent', calls.length === 1 && J(calls[0]) === J({ type: 'instruct-hook-save', url: HOOK, key: KEY })
    && chk('overlay-run', OV, [calls[0]]) === null);
  onHook({ configured: true, host: 'hooks.cursor.com', available: true, code: '' });
  t('settings: saved -> both fields emptied, 保存しました', fields['#hook-url'].value === '' && fields['#hook-key'].value === '' && fields['#hook-error'].textContent === '保存しました。');
  fields['#hook-url'].value = HOOK; fields['#hook-key'].value = KEY; onHook({ configured: false, host: '', available: false, code: 'UNAVAILABLE' });
  t('settings: refused by main (no safeStorage) -> why, 保存 off, the fields kept for another try', /暗号化して保存できない/.test(fields['#hook-error'].textContent) && fields['#hook-save'].disabled === true && fields['#hook-key'].value === KEY
    && fields['#hook-status'].innerHTML.startsWith('未設定'));
  calls.length = 0;
  handlers.click({ target: { closest: s => s === '[data-hook-action="clear"]' ? {} : null } });
  t('settings: 削除 -> instruct-hook-clear', J(calls) === J([{ type: 'instruct-hook-clear' }]));
  onHook({ configured: false, host: '', available: true, code: '' });
  t('settings: removed -> 未設定, 削除しました', fields['#hook-status'].innerHTML === '未設定' && fields['#hook-error'].textContent === '削除しました。');
  calls.length = 0; fields['#sidebar-url'].value = 'https://example.com/#/p/sidebar?k=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; submit('sidebar-settings-form');
  t('settings: the sidebar URL form still saves the URL only', J(calls) === J([{ type: 'sidebar-save', url: 'https://example.com/#/p/sidebar?k=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }])); }

// ---- the public build: nothing personal, nothing configured ----
{ const files = fs.readdirSync(SRC).filter(f => /\.(js|html|css)$/.test(f) && f !== 'pane-preload.js'), all = files.map(f => [f, read(f)]);
  const urls = all.flatMap(([f, s]) => [...s.matchAll(/https?:\/\/[^\s'"`<>)]*cursor\.(?:com|sh)[^\s'"`<>)]*/g)].map(m => `${f}: ${m[0]}`));
  t('no webhook URL in the app but the example in a comment and the placeholder', urls.every(u => /^main\.js: https:\/\/hooks\.cursor\.com\/routine$|^overlay\.js: https:\/\/hooks\.cursor\.com\/…$/.test(u)) && urls.length === 2);
  t('no key / token default, no settings file shipped', !fs.existsSync(path.join(SRC, 'instruct-webhook.json')) && !/(key|token)\s*[:=]\s*'[A-Za-z0-9_-]{8,}'/.test(read('instruct-rules.js') + read('instruct-webhook.js') + read('overlay.js')));
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  t('README documents instruct(), the settings, the payload and the encrypted storage', /instruct\(\{ tid, task, bot, state, memo \}\)/.test(readme) && readme.includes('NaoAIへの指示（webhook）') && readme.includes('xg-bots-instruction')
    && readme.includes('instruct-webhook.json') && readme.includes('safeStorage') && readme.includes('createdAtJst')); }

Promise.all(tests).then(() => { console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0); });
