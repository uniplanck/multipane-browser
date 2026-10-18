// node test/attention-queue.test.js — #01 対応キュー. The pure list (src/attention-queue.js): which panes are listed and why (要返信 → 未確認の新着 →
// 観測異常 → 待機, one item per pane with its other reasons kept), the stable order (first time of the kind, then id), a kind change / a resolved
// pane, 0 / 10 panes, long Japanese names, sleeping panes, a stale / unknown / sign-in state never shown as the current 🟢, and the check of a
// choice (closed pane / another conversation). Then the diagnostics codes and the wiring in main.js / overlay.js / renderer.js / ipc-policy.js.
// Not covered here: the overlay on screen, focus / wake of real views, read marks on a real window - that needs the manual check.
const fs = require('fs'), path = require('path');
const AQ = require('../src/attention-queue');
const DG = require('../src/diagnostics');
const IPC = require('../src/ipc-policy');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const NOW = 1.7e12;
const bot = c => `https://grok.com/bot/${c}`;
// one pane as main describes it (queueBuild): awake, confirmed now, nothing to do
const F = (id, o = {}) => ({ id, url: bot('b' + id), name: `Bot${id}`, since: null, sleeping: false, needsReply: false, waiting: false, unopened: false,
  shown: 'live', issue: '', gone: false, fail: '', hang: false, hold: false, fails: 0, checkedAt: 0, ...o });
const kinds = items => items.map(it => it.kind).join();
const ids = items => items.map(it => it.id).join();

// ---- nothing to do ----
t('0 panes / no facts: empty list', J(AQ.build([], NOW)) === '[]' && J(AQ.build(undefined, NOW)) === '[]' && J(AQ.build(null, NOW)) === '[]');
t('panes with nothing to do are not listed (plain / 🔴 working / 🟣 done / new tab / generic site)',
  AQ.build([F(1), F(2, { working: true }), F(3, { done: true }), F(4, { url: '', shown: '' }), F(5, { url: 'https://example.com/', shown: '' })], NOW).length === 0);
t('bad entries are skipped (no id / id 0 / not an object)', AQ.build([null, 5, F(0, { needsReply: true }), F(-1, { needsReply: true }), { needsReply: true }], NOW).length === 0);

// ---- kinds and their order ----
{ const L = AQ.build([F(1, { waiting: true }), F(2, { gone: true }), F(3, { needsReply: true, waiting: true }), F(4, { sleeping: true, shown: 'sleep', unopened: true })], NOW);
  t('order: 要返信 → 未確認の新着 → 観測異常 → 待機', kinds(L) === 'REPLY,UNOPENED,ISSUE,WAIT' && ids(L) === '3,4,2,1');
  t('kind labels in Japanese', L.map(it => it.kja).join() === '要返信,未確認の新着,観測異常,待機中' && AQ.KINDS.every(k => AQ.KIND_JA[k]));
  t('item: key = id:kind, the reason, the conversation ref', L[0].key === '3:REPLY' && L[0].why === AQ.WHY_JA.REPLY && L[0].ref === 'bot:b3' && L[3].why === AQ.WHY_JA.WAIT);
  t('item: a fixed set of fields', L.every(it => J(Object.keys(it).sort()) === J(['also', 'at', 'code', 'id', 'key', 'kind', 'kja', 'name', 'ref', 'seen', 'sleeping', 'why']))); }
t('🟢 waiting with a reply request is 要返信, without one 待機中', AQ.build([F(1, { waiting: true, needsReply: true })], NOW)[0].kind === 'REPLY' && AQ.build([F(1, { waiting: true })], NOW)[0].kind === 'WAIT');
t('every reason code belongs to a kind', Object.values(AQ.REASONS).every(k => AQ.KINDS.includes(k)) && Object.keys(AQ.REASONS).every(c => AQ.WHY_JA[c]));

// ---- one item per pane, other reasons kept ----
{ const L = AQ.build([F(1, { sleeping: true, shown: 'sleep', needsReply: true, waiting: true, unopened: true, hold: true })], NOW);
  t('several reasons: one item, the highest kind', L.length === 1 && L[0].kind === 'REPLY' && L[0].code === 'REPLY');
  t('several reasons: the others under it (未確認の新着, 確認停止), never 待機 twice', J(L[0].also) === J([AQ.WHY_JA.UNOPENED, AQ.WHY_JA.CHECK_HOLD])); }
{ const L = AQ.build([F(2, { gone: true, fail: 'manual', hang: true })], NOW);
  t('several 観測異常: the first (page stopped), the rest kept', L.length === 1 && L[0].code === 'GONE' && J(L[0].also) === J([AQ.WHY_JA.FAIL_MANUAL, AQ.WHY_JA.HANG])); }
t('the same pane id twice: listed once (the first)', (L => L.length === 1 && L[0].kind === 'REPLY')(AQ.build([F(1, { needsReply: true }), F(1, { gone: true })], NOW)));

// ---- unknown / stale / sign-in are never the current 🟢 ----
t('🟢 known only as the last confirmed value (reload / move / a reply being written): 観測異常, not 要返信',
  (L => L.length === 1 && L[0].kind === 'ISSUE' && L[0].code === 'STALE_REPLY' && L[0].seen === '今の状態は未確認')(AQ.build([F(1, { shown: 'last', needsReply: true, waiting: true })], NOW)));
t('waiting known only as the last value: 観測異常, not 待機', (L => L[0].kind === 'ISSUE' && L[0].code === 'STALE_WAIT')(AQ.build([F(1, { shown: 'last', waiting: true })], NOW)));
t('no confirmed marker at all (new generation, nothing read yet): not listed as 要返信 / 待機', AQ.build([F(1, { shown: '', needsReply: true, waiting: true })], NOW).length === 0);
t('🔴 / 🟣 known only as the last value: not listed (nothing to do)', AQ.build([F(1, { shown: 'last', working: true }), F(2, { shown: 'last', done: true })], NOW).length === 0);
t('a sign-in page (awake): 観測異常', (L => L[0].code === 'AUTH' && L[0].kind === 'ISSUE')(AQ.build([F(1, { issue: 'AUTH_REQUIRED', shown: '' })], NOW)));
t('other unknown pages (empty conversation, loading, guesses) are not listed', ['DOM_UNKNOWN', 'LOADING', 'ROLE_GUESS', 'LATEST_PARTIAL', 'CHANGING'].every(i => AQ.build([F(1, { issue: i, shown: '' })], NOW).length === 0));
t('load failed (retry / manual) and unresponsive: 観測異常', ['retry', 'manual'].every(f => AQ.build([F(1, { fail: f })], NOW)[0].kind === 'ISSUE') && AQ.build([F(1, { hang: true })], NOW)[0].code === 'HANG');

// ---- sleeping panes ----
{ const at = new Date(2026, 9, 19, 8, 5).getTime();
  const L = AQ.build([F(1, { sleeping: true, shown: 'sleep', needsReply: true, waiting: true, checkedAt: at }), F(2, { sleeping: true, shown: 'sleep', unopened: true }), F(3, { sleeping: true, shown: 'sleep', waiting: true, checkedAt: at })], NOW);
  t('asleep with a reply request: 要返信 (its own sleep state), the last check time shown', L[0].id === 1 && L[0].kind === 'REPLY' && L[0].sleeping === true && L[0].seen === 'スリープ中・最終確認 08:05');
  t('asleep with something new: 未確認の新着; never checked: says so', L[1].kind === 'UNOPENED' && L[1].seen === 'スリープ中・未確認');
  t('asleep and waiting: 待機中', L[2].kind === 'WAIT'); }
t('asleep, checks stopped after a sign-in page / failing: 観測異常 with the count', (L => L[0].code === 'CHECK_HOLD' && L[1].code === 'CHECK_FAIL' && L[1].why === `${AQ.WHY_JA.CHECK_FAIL}（3回）`)(
  AQ.build([F(1, { sleeping: true, shown: 'sleep', hold: true, fails: 3 }), F(2, { sleeping: true, shown: 'sleep', fails: 3 })], NOW)));
t('restored after a restart without its own state (no colour / count): not listed', AQ.build([F(1, { sleeping: true, shown: 'sleep' })], NOW).length === 0);
t('an awake pane is never 未確認の新着 by the sleep check flags (hold / fails ignored)', AQ.build([F(1, { hold: true, fails: 2 })], NOW).length === 0);

// ---- 10 panes ----
{ const all = Array.from({ length: 10 }, (_, i) => F(i + 1, [{ needsReply: true }, { sleeping: true, shown: 'sleep', unopened: true }, { gone: true }, { waiting: true }][i % 4]));
  const L = AQ.build(all, NOW);
  t('10 panes: 10 items, every id once, kinds grouped in order', L.length === 10 && new Set(L.map(it => it.id)).size === 10 && kinds(L) === 'REPLY,REPLY,REPLY,UNOPENED,UNOPENED,UNOPENED,ISSUE,ISSUE,WAIT,WAIT'
    && ids(L) === '1,5,9,2,6,10,3,7,4,8');
  t('10 panes: unique keys', new Set(L.map(it => it.key)).size === 10); }

// ---- names ----
{ const long = '株式会社サンプルの経理部門向け月次決算チェックリスト自動確認ボット（第二版・テスト運用中）'.repeat(3);
  const L = AQ.build([F(1, { needsReply: true, name: `  ${long}  ` }), F(2, { needsReply: true, name: '' })], NOW);
  t('a long Japanese name is passed whole (trimmed; the overlay shortens it on screen)', L[0].name === long && L[0].name.length > 100);
  t('no name: a fixed placeholder', L[1].name === '（名前なし）'); }

// ---- stable order and first time of the kind ----
{ const a = [F(3, { needsReply: true, since: { kind: 'REPLY', at: 500 } }), F(1, { needsReply: true, since: { kind: 'REPLY', at: 900 } }), F(2, { needsReply: true, since: { kind: 'REPLY', at: 500 } })];
  const L1 = AQ.build(a, NOW), L2 = AQ.build([...a].reverse(), NOW);
  t('same kind: the earliest first, then the smaller id', ids(L1) === '2,3,1' && L1.map(it => it.at).join() === '500,500,900');
  t('same input in another order: the same list', J(L1) === J(L2)); }
t('since: kept while the kind stays, a new time when it changes / was none', J(AQ.since({ kind: 'REPLY', at: 5 }, 'REPLY', NOW)) === J({ kind: 'REPLY', at: 5 })
  && J(AQ.since({ kind: 'WAIT', at: 5 }, 'REPLY', NOW)) === J({ kind: 'REPLY', at: NOW }) && J(AQ.since(null, 'ISSUE', NOW)) === J({ kind: 'ISSUE', at: NOW }) && AQ.since({ kind: 'REPLY', at: NaN }, 'REPLY', NOW).at === NOW);
{ // a pane's kind over time, the way main keeps p.qSince (set from the item, removed when it is no longer listed)
  const p = F(1), step = (o, now) => { Object.assign(p, o); const it = AQ.build([p], now)[0]; if (it) p.since = { kind: it.kind, at: it.at }; else p.since = null; return it; };
  const a = step({ waiting: true }, 100), b = step({}, 200), c = step({ needsReply: true }, 300), d = step({}, 400);
  const e = step({ needsReply: false, waiting: false }, 500), eSince = p.since, f = step({ needsReply: true, waiting: true }, 600);
  t('kind change: 待機 at 100, still 100, 要返信 from 300 (new time), still 300', a.kind === 'WAIT' && a.at === 100 && b.at === 100 && c.kind === 'REPLY' && c.at === 300 && d.at === 300);
  t('resolved: not listed, nothing kept; listed again later: a new time', !e && eSince === null && f.kind === 'REPLY' && f.at === 600); }
t('build never changes the facts it is given', (() => { const a = [F(1, { needsReply: true, since: { kind: 'WAIT', at: 1 } })], s = J(a); AQ.build(a, NOW); return J(a) === s; })());

// ---- a choice: the same pane, the same conversation ----
t('refOf: the bot id of a /bot/ page (query / hash ignored), else the URL without its hash', AQ.refOf(bot('abc')) === 'bot:abc' && AQ.refOf(bot('abc') + '?x=1#y') === 'bot:abc'
  && AQ.refOf('https://example.com/a?b=1#c') === 'https://example.com/a?b=1' && AQ.refOf('') === '' && AQ.refOf(undefined) === '');
{ const now = [{ id: 1, url: bot('abc') }, { id: 2, url: 'https://example.com/a' }];
  t('choice: the pane still shows that conversation -> go', AQ.stale({ id: 1, ref: 'bot:abc' }, now) === '' && AQ.stale({ id: 1, ref: 'bot:abc' }, [{ id: 1, url: bot('abc') + '?r=1' }]) === '' && AQ.stale({ id: 2, ref: 'https://example.com/a' }, now) === '');
  t('choice: the pane was closed (id gone) -> GONE', AQ.stale({ id: 3, ref: 'bot:abc' }, now) === 'GONE' && AQ.stale({ id: 1, ref: 'bot:abc' }, []) === 'GONE');
  t('choice: the pane moved to another bot / page -> MOVED', AQ.stale({ id: 1, ref: 'bot:other' }, now) === 'MOVED' && AQ.stale({ id: 2, ref: 'https://example.com/b' }, now) === 'MOVED' && AQ.stale({ id: 1, ref: '' }, now) === 'MOVED');
  t('choice: a bad pick -> GONE', [null, {}, { id: '1', ref: 'bot:abc' }, { id: 0, ref: '' }].every(p => AQ.stale(p, now) === 'GONE') && AQ.stale({ id: 1, ref: 'bot:abc' }, null) === 'GONE');
  t('a refused choice says why in Japanese', ['GONE', 'MOVED'].every(c => /[぀-ヿ一-鿿]/.test(AQ.STALE_JA[c]))); }

// ---- diagnostics codes ----
t('queue codes = diagnostics QUEUE_CODES (#01)', J([...DG.QUEUE_CODES].sort()) === J([...AQ.CODES].sort()) && AQ.CODES.every(c => DG.EVENTS.queue.r.includes(c)));

// ======================= wiring in the real sources =======================
const SRC = path.join(__dirname, '..', 'src'), read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const main = read('main.js'), ov = read('overlay.js'), rd = read('renderer.js');
const fnBody = (src, name) => { const i = src.indexOf(`function ${name}(`); if (i < 0) return ''; let d = 0, j = src.indexOf('{', i); for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(i, j + 1); };
const pick = fnBody(main, 'queuePick'), qopen = fnBody(main, 'queueOpen'), qbuild = fnBody(main, 'queueBuild');
t('main.js: the list goes out with every state (bar count + open list)', /state\.queue = queueBuild\(state\.panes\);/.test(main) && /state\.qNote = overlayOpen && overlayMode === 'queue' \? queueNote : '';/.test(main));
t('main.js: p.qSince follows the item, removed with it; never saved', /p\.qSince = \{ kind: it\.kind, at: it\.at \}; else delete p\.qSince;/.test(qbuild)
  && !/qSince/.test(main.match(/const paneSpec = [^\n]*/)[0]) && !/qSince/.test(fnBody(main, 'paneSave')) && !/qSince/.test(fnBody(main, 'snapshot')));
t('main.js: only 要返信 / 待機 from the shown state (live / sleep), the sleep-check flags only while checks are on', /shown: s\.obs/.test(qbuild) && /hold: !!p\.sleeping && chk && probeAuthHold/.test(qbuild));
t('main.js: opening the list only opens the overlay (no focus / wake / read mark)', qopen && !/focusPane|setFocused|clearUnread|reloadPane|wake|updateBadge/.test(qopen));
t('main.js: a choice only from the open list, checked again by id + conversation, refused ones say why', /if \(!overlayOpen \|\| overlayMode !== 'queue'\) return;/.test(pick)
  && /AQ\.stale\(\{ id: a\.id, ref: a\.ref \}, panes\.map\(p => \(\{ id: p\.id, url: paneUrl\(p\) \}\)\)\)/.test(pick) && /queueNote = AQ\.STALE_JA\[code\];[^\n]*sendState\(\); return;/.test(pick));
t('main.js: a choice focuses that very pane (byId) without marking it read, then read only if really seen (inView)', /const p = byId\(a\.id\);/.test(pick)
  && /focusPane\(panes\.indexOf\(p\), \{ clear: false \}\);\s*if \(inView\(p\)\) clearUnread\(p\);/.test(pick) && !/maximizedId|rowLens|relayout/.test(pick));
t('main.js: a sleeping pane is woken by focusing it (setFocused -> reloadPane: the load queue)', /if \(panes\[i\]\.sleeping\) reloadPane\(panes\[i\]\);/.test(fnBody(main, 'setFocused')));
t('main.js: both actions in runAction; ⌘J / next-unread unchanged', /case 'queue-open': queueOpen\(\); break;/.test(main) && /case 'queue-pick': queuePick\(a\); break;/.test(main)
  && /if \(k === 'j'\) \{ nextUnread\(\); return true; \}/.test(main) && /case 'next-unread': closeOverlay\(\); nextUnread\(\); break;/.test(main));
t('main.js: the overlay mode is kept for the check and cleared on close', /overlayOpen = true; overlayMode = mode;/.test(main) && /overlayOpen = false; overlayMode = '';/.test(fnBody(main, 'closeOverlay')));
t('ipc-policy: queue-open from the bar / overlay, queue-pick from the overlay only', J(IPC.ACTIONS['queue-open'].roles) === J(['chrome', 'overlay']) && !IPC.ACTIONS['queue-pick'].roles && !IPC.ACTIONS['queue-pick'].target);
t('overlay.js: a choice is sent only by run() (Enter / click), never on a state update / hover / search', /act: \{ type: 'queue-pick', id: it\.id, ref: it\.ref \}/.test(ov)
  && (ov.match(/mpb\.run\(/g) || []).length === (ov.match(/mpb\.run\(act\)|mpb\.run\(\{ type: 'bc-/g) || []).length
  && !/mpb\.run/.test(ov.match(/^mpb\.onState\([^\n]*/m)[0]) && !/mpb\.run/.test(ov.match(/^list\.onmousemove[^\n]*/m)[0]) && !/mpb\.run/.test(ov.match(/^q\.oninput[^\n]*/m)[0]));
t('overlay.js: the selection follows its item across updates', /const was = mode === 'queue' && items\[sel\] \? items\[sel\]\.qk : '';/.test(ov) && /sel = mode === 'queue' \? queueSel\(was\)/.test(ov)
  && /if \(mode === 'palette' \|\| mode === 'queue'\) render\(\);/.test(ov));
t('overlay.js: Esc closes (back to the focused pane in main)', /else if \(e\.key === 'Escape'\) \{ mpb\.closeOverlay\(\);/.test(ov));
t('renderer.js: 対応 n opens the list; 未返信 n / ⌘J still go to the next unread pane', /\$\('#queue-sum'\)\.onclick = \(\) => mpb\.run\(\{ type: 'queue-open' \}\);/.test(rd)
  && /\$\('#unread-sum'\)\.onclick = \(\) => mpb\.run\(\{ type: 'next-unread' \}\);/.test(rd) && /id="queue-sum"/.test(read('index.html')));

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
