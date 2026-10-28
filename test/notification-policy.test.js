// node test/notification-policy.test.js — notification delivery (#61): src/notification-policy.js decides the event key (pane + generation +
// kind + hashed report key; no text / URL / name), one delivery per key with a bounded memory (count / age), the merge window (boundary, a pane
// counted once, 「Bots：確認待ち n件」 without names), quiet hours (local time, across midnight), mute / quiet consuming candidates (nothing comes
// out afterwards) and the click check (same pane / open / same generation). Contract with the real main.js / diagnostics.
// Not covered here: real macOS notifications (shown / grouped / clicked, Focus mode, permission) and real Grok pages - that needs the manual check.
const fs = require('fs'), path = require('path');
const NP = require('../src/notification-policy');
const DG = require('../src/diagnostics');
const PS = require('../src/pane-state');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const W = NP.WINDOW_MS;
const at = (h, m, d = 19) => new Date(2026, 9, d, h, m).getTime();   // local time (whatever the TZ of the run)
const T0 = at(12, 0);
const SECRET = { name: 'ボット名ひみつ', url: 'https://grok.com/bot/secret-bot-id', text: '秘密の会話本文' };
const cand = (pane, gen, key, kind = 'ask', x = {}) => ({ pane, gen, kind, key, body: `待機中（未返信 ${pane}件）`, title: SECRET.name, ...x });
const open = { muted: false, quiet: { on: false } };
// main's loop in small: take a due window first, then offer; flush() = take at a time + compose
function run(steps) {
  let st = NP.createState(); const out = [], codes = [];
  for (const s of steps) {
    if (s.take != null) { const r = NP.take(st, s.take, s.gate || open); st = r.st; codes.push(r.code); if (r.code === 'DUE') { const m = NP.compose(r.items); if (m) out.push(m); } continue; }
    const pre = NP.take(st, s.now, s.gate || open); if (pre.code && pre.code !== 'WAIT') { st = pre.st; if (pre.code === 'DUE') { const m = NP.compose(pre.items); if (m) out.push(m); } }
    const r = NP.offer(st, s.c, s.now, s.gate || open); st = r.st; codes.push(r.code);
  }
  return { st, out, codes };
}

// ---- event key ----
{ const k = NP.eventKey(cand(3, 17, PS.alertKey({ user: 2, bot: 5, fp: 'k3j2h1.842' })));
  t('eventKey: pane.gen.kind.hash', /^3\.17\.ask\.[0-9a-z]{1,7}$/.test(k));
  t('eventKey: the report key is hashed (the fingerprint never kept as is)', !k.includes('k3j2h1') && !k.includes('842') && !k.includes('2/5/'));
  t('eventKey: no title / body / URL / name ever (only the four parts are read)', [SECRET.name, SECRET.url, SECRET.text, '待機中'].every(s => !NP.eventKey({ ...cand(3, 17, 'a'), title: s, body: s, url: s }).includes(s)));
  t('eventKey: same parts -> same key; any part differs -> another key', NP.eventKey(cand(3, 17, 'a')) === NP.eventKey(cand(3, 17, 'a'))
    && new Set([cand(3, 17, 'a'), cand(4, 17, 'a'), cand(3, 18, 'a'), cand(3, 17, 'b'), cand(3, 17, 'a', 'probe')].map(NP.eventKey)).size === 5);
  t('eventKey: missing / invalid part -> "" (never delivered)', [{}, cand(0, 1, 'a'), cand(1, 0, 'a'), cand(1.5, 1, 'a'), cand('1', 1, 'a'), cand(1, 1, ''), cand(1, 1, 5), cand(1, 1, 'a', 'chat')].every(c => NP.eventKey(c) === '')
    && NP.eventKey() === '' && NP.offer(NP.createState(), cand(1, 1, ''), T0, open).code === 'BAD');
  t('kinds: ask / probe / update', J(NP.KINDS) === J(['ask', 'probe', 'update']));
  t('hash: stable, short, differs for near keys', NP.hash('1/2/x.5') === NP.hash('1/2/x.5') && NP.hash('1/2/x.5') !== NP.hash('1/2/x.6') && NP.hash('2/2/x.5') !== NP.hash('1/2/x.5') && NP.hash('').length > 0); }

// ---- one delivery per key ----
{ const r = run([{ now: T0, c: cand(1, 5, 'k1') }, { now: T0 + 100, c: cand(1, 5, 'k1') }, { take: T0 + W }, { now: T0 + W + 10, c: cand(1, 5, 'k1') }, { take: T0 + 9 * W }]);
  t('same key: once (again inside the window and after it: DUP)', J(r.codes) === J(['OPEN', 'DUP', 'DUE', 'DUP', '']) && r.out.length === 1 && r.out[0].n === 1); }
{ const r = run([{ now: T0, c: cand(1, 5, 'k1') }, { take: T0 + W }, { now: T0 + 60000, c: cand(1, 5, 'k2') }, { take: T0 + 60000 + W }]);
  t('another wait transition of the same pane (new report key): its own notification', J(r.codes) === J(['OPEN', 'DUE', 'OPEN', 'DUE']) && r.out.length === 2); }
{ const r = run([{ now: T0, c: cand(1, 5, 'k1') }, { take: T0 + W }, { now: T0 + 60000, c: cand(1, 6, 'k1') }, { take: T0 + 60000 + W }]);
  t('the same report in a new generation is another key here (re-reads of one report are stopped before: pane-state alert / DUP_ALERT)', r.out.length === 2); }
{ let o = PS.createObs(1, 2); const a1 = PS.reduce(o, { type: 'alert', key: '1/2/f.3' }); o = a1.o;
  const a2 = PS.reduce(PS.reduce(o, { type: 'bump', gen: 9 }).o, { type: 'alert', key: '1/2/f.3' });
  t('(pane-state, unchanged) the same report after a reload is DUP_ALERT before it ever gets here', a1.code === '' && a2.code === 'DUP_ALERT'); }

// ---- memory bounds: count and age ----
{ let st = NP.createState();
  for (let i = 0; i < NP.KEEP_N + 1; i++) st = NP.offer(st, cand(1, 5, 'k' + i), T0 + i, { muted: true }).st;
  t(`keys kept: at most ${NP.KEEP_N}`, st.sent.length === NP.KEEP_N);
  t('beyond the count: the oldest is forgotten, the newest still DUP', NP.offer(st, cand(1, 5, 'k0'), T0 + 500, open).code === 'OPEN' && NP.offer(st, cand(1, 5, 'k' + NP.KEEP_N), T0 + 500, open).code === 'DUP');
  const s1 = NP.offer(NP.createState(), cand(2, 5, 'x'), T0, open).st;
  t('age: DUP until KEEP_MS (24h), then forgotten', NP.KEEP_MS === 24 * 3600000 && NP.offer(s1, cand(2, 5, 'x'), T0 + NP.KEEP_MS - 1, open).code === 'DUP'
    && NP.offer(NP.take(s1, T0 + NP.KEEP_MS, open).st, cand(2, 5, 'x'), T0 + NP.KEEP_MS, open).code === 'OPEN');
  t('a clock set back keeps the keys (no second delivery)', NP.offer(s1, cand(2, 5, 'x'), T0 - 3600000, open).code === 'DUP');
  const before = J(s1); NP.offer(s1, cand(3, 5, 'y'), T0 + 1, open); NP.take(s1, T0 + W, open);
  t('offer / take never change the state passed in', J(s1) === before); }

// ---- merge window ----
{ const r = run([{ now: T0, c: cand(1, 5, 'a') }, { now: T0 + W - 1, c: cand(2, 5, 'b') }, { take: T0 + W - 1 }, { take: T0 + W }]);
  t('boundary: a candidate at first + WINDOW_MS - 1 joins; not due before first + WINDOW_MS', J(r.codes) === J(['OPEN', 'ADDED', 'WAIT', 'DUE']) && r.out.length === 1 && r.out[0].n === 2); }
{ const r = run([{ now: T0, c: cand(1, 5, 'a') }, { now: T0 + W, c: cand(2, 5, 'b') }, { take: T0 + 2 * W }]);
  t('boundary: a candidate at first + WINDOW_MS starts the next window (the due one goes first)', J(r.codes) === J(['OPEN', 'OPEN', 'DUE']) && r.out.length === 2 && r.out.every(m => m.n === 1)); }
{ const st = NP.offer(NP.createState(), cand(1, 5, 'a'), T0, open).st, w = NP.take(st, T0 + 1, open);
  t('take before due: WAIT + the due time, nothing taken', w.code === 'WAIT' && w.due === T0 + W && w.st === st && w.items.length === 0); }
{ const r = run([{ now: T0, c: cand(1, 5, 'a') }, { now: T0 + 500, c: cand(1, 5, 'b', 'ask', { body: '待機中（未返信 2件）' }) }, { now: T0 + 900, c: cand(1, 5, 'c', 'ask', { body: '待機中（未返信 3件）' }) }, { take: T0 + W }]);
  t('the same pane twice in a window: counted once, its latest candidate kept', J(r.codes) === J(['OPEN', 'SAME_PANE', 'SAME_PANE', 'DUE']) && r.out.length === 1 && r.out[0].n === 1 && r.out[0].item.key === 'c' && r.out[0].item.body === '待機中（未返信 3件）'); }
{ const steps = []; for (let i = 1; i <= 10; i++) steps.push({ now: T0 + i * 100, c: cand(i, 5, 'k' + i, i % 2 ? 'ask' : 'probe') }); steps.push({ now: T0 + 1200, c: cand(3, 5, 'k3b') }, { take: T0 + 100 + W });
  const r = run(steps), m = r.out[0];
  t('10 panes at once: one notification 「Bots：確認待ち 10件」', r.out.length === 1 && m.n === 10 && m.title === 'Bots：確認待ち 10件');
  t('merged: no name / body / URL of any pane in title or body', [SECRET.name, SECRET.url, SECRET.text, '未返信'].every(s => !m.title.includes(s) && !m.body.includes(s)) && m.items.length === 10); }
{ const m1 = NP.compose([cand(4, 5, 'a')]);
  t('one pane: its own notification (title = its name, body = its counts)', m1.n === 1 && m1.item.title === SECRET.name && m1.item.body === '待機中（未返信 4件）' && !('title' in m1));
  t('compose: nothing / holes -> null; duplicates of a pane counted once', NP.compose([]) === null && NP.compose(null) === null && NP.compose([null]) === null
    && NP.compose([cand(1, 5, 'a'), cand(1, 6, 'b')]).n === 1 && NP.compose([cand(1, 5, 'a'), cand(2, 5, 'b'), cand(1, 6, 'c')]).n === 2); }

// ---- quiet hours (local time) ----
{ const q = { on: true, from: '22:00', to: '07:00' };
  t('22:00-07:00 across midnight: 22:00 / 23:30 / 00:00 / 06:59 quiet', [at(22, 0), at(23, 30), at(0, 0, 20), at(6, 59, 20)].every(n => NP.inQuiet(q, n)));
  t('22:00-07:00: 07:00 / 12:00 / 21:59 not quiet', [at(7, 0), at(12, 0), at(21, 59)].every(n => !NP.inQuiet(q, n)));
  const d = { on: true, from: '09:00', to: '17:30' };
  t('same-day range 09:00-17:30: from included, to excluded', NP.inQuiet(d, at(9, 0)) && NP.inQuiet(d, at(17, 29)) && !NP.inQuiet(d, at(17, 30)) && !NP.inQuiet(d, at(8, 59)));
  t('off / from = to / no setting -> never quiet', !NP.inQuiet({ ...q, on: false }, at(23, 0)) && !NP.inQuiet({ on: true, from: '07:00', to: '07:00' }, at(7, 0)) && !NP.inQuiet(undefined, at(23, 0)) && !NP.inQuiet(null, at(23, 0))
    && !NP.inQuiet({ on: 'yes', from: '22:00', to: '07:00' }, at(23, 0)) && !NP.inQuiet(q, NaN));
  t('quietOf: default off 22:00-07:00; invalid times -> the default ones; H:MM accepted', J(NP.quietOf(undefined)) === J({ on: false, from: '22:00', to: '07:00' })
    && J(NP.quietOf({ on: true, from: '25:00', to: 'x' })) === J({ on: true, from: '22:00', to: '07:00' }) && J(NP.quietOf({ on: true, from: '0:00', to: '6:05' })) === J({ on: true, from: '00:00', to: '06:05' }));
  t('presets: 22:00-07:00 / 23:00-08:00 / 00:00-06:00 (all valid)', J(NP.QUIET_PRESETS) === J([['22:00', '07:00'], ['23:00', '08:00'], ['00:00', '06:00']]) && NP.QUIET_PRESETS.flat().every(s => NP.minutes(s) != null));
  t('00:00-06:00: 23:59 not quiet, 00:00 quiet, 06:00 not', !NP.inQuiet({ on: true, from: '00:00', to: '06:00' }, at(23, 59)) && NP.inQuiet({ on: true, from: '00:00', to: '06:00' }, at(0, 0)) && !NP.inQuiet({ on: true, from: '00:00', to: '06:00' }, at(6, 0))); }

// ---- mute / quiet: consumed, nothing afterwards ----
{ const quiet = { muted: false, quiet: { on: true, from: '22:00', to: '07:00' } }, n = at(23, 0);
  const r = run([{ now: n, c: cand(1, 5, 'a'), gate: quiet }, { now: n + 1000, c: cand(2, 5, 'b'), gate: quiet }, { take: at(7, 0, 20) }, { now: at(7, 1, 20), c: cand(1, 5, 'a') }, { take: at(7, 2, 20) }]);
  t('quiet hours: consumed (nothing queued), nothing when they end, the same event later is DUP', J(r.codes) === J(['QUIET', 'QUIET', '', 'DUP', '']) && r.out.length === 0 && r.st.pend === null); }
{ const r = run([{ now: T0, c: cand(1, 5, 'a'), gate: { muted: true } }, { take: T0 + W }, { now: T0 + 60000, c: cand(1, 5, 'a') }, { now: T0 + 60000, c: cand(1, 5, 'b') }, { take: T0 + 60000 + W }]);
  t('muted (app off / pane muted): consumed; after unmute the past one is not sent, a new one is', J(r.codes) === J(['MUTED', '', 'DUP', 'OPEN', 'DUE']) && r.out.length === 1 && r.out[0].item.key === 'b'); }
{ const st = NP.offer(NP.offer(NP.createState(), cand(1, 5, 'a'), T0, open).st, cand(2, 5, 'b'), T0 + 10, open).st;
  const m = NP.take(st, T0 + W, { muted: true }), q = NP.take(st, at(23, 0), { quiet: { on: true, from: '22:00', to: '07:00' } });
  t('muted / quiet began while the window was open: consumed at delivery (items only to count)', m.code === 'MUTED' && m.st.pend === null && m.items.length === 2 && q.code === 'QUIET' && q.st.pend === null
    && NP.offer(m.st, cand(1, 5, 'a'), T0 + W + 1, open).code === 'DUP'); }
{ t('restart: a new state is empty (the first scan / check of a launch is a baseline in main, never offered)', J(NP.createState()) === J({ sent: [], pend: null })); }

// ---- click ----
{ const it = cand(7, 12, 'a'), p = { id: 7, obs: { gen: 12, closed: false } };
  t('click: the same pane, open, same generation -> may open it', NP.clickOk(it, p));
  t('click: closed / other generation / other pane / none -> front only', !NP.clickOk(it, { ...p, obs: { gen: 12, closed: true } }) && !NP.clickOk(it, { ...p, obs: { gen: 13, closed: false } })
    && !NP.clickOk(it, { id: 8, obs: { gen: 12, closed: false } }) && !NP.clickOk(it, null) && !NP.clickOk(null, p) && !NP.clickOk(it, { id: 7 })); }

// ---- diagnostics: fixed codes only ----
t('diagnostics: notify takes every notification-policy code', J([...DG.NOTIFY_CODES].sort()) === J([...NP.CODES].sort()) && NP.CODES.every(c => DG.EVENTS.notify.r.includes(c)));
t('diagnostics: the quiet-hours setting is shown as on / off only', DG.SETTINGS.quietHours === 'bool' && DG.safeEnv({ settings: { quietHours: { on: true, from: '22:00' } } }).settings.quietHours === undefined
  && DG.safeEnv({ settings: { quietHours: true } }).settings.quietHours === true);

// ---- contract with the real main.js ----
{ const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const fn = name => { const i = main.indexOf(`function ${name}(`); return i < 0 ? '' : main.slice(i, main.indexOf('\n}\n', i) + 2); };
  const line = s => { const i = main.indexOf(s); return i < 0 ? '' : main.slice(main.lastIndexOf('\n', i) + 1, main.indexOf('\n', i)); };
  const offer = fn('noticeOffer'), take = fn('noticeTake'), click = fn('noticeClick'), light = fn('lightUp'), msg = fn('onMsgCount');
  t('main: notification-policy.js decides; app notifications off = mute, quiet hours from settings', /const NP = require\('\.\/notification-policy'\);/.test(main)
    && /const noticeGate = \(\) => \(\{ muted: !settings\.notifications, quiet: settings\.quietHours \}\);/.test(main) && /if \(p\.muted\) g\.muted = true;/.test(offer));
  t('main: every pane notification goes through noticeOffer (lightUp + background check); the old direct path is gone', !/showPaneNotification/.test(main) && /if \(first\) notifyPane\(p, /.test(light)
    && /notifyPane\(p, 'probe', PS\.alertKey\(nf\), `未開封の新着（待機中 \$\{p\.unread\}件）`\)/.test(main) && /lightUp\(p, `bot asks \(\$\{c\.botSince\}\)`, true, PS\.alertKey\(c\)\)/.test(msg)
    && /function notifyPane\(p, kind, key, body\) \{ noticeOffer\(p, kind, key, body, p\.name \|\| displayTitle\(p\)\); \}/.test(main));
  t('main: candidates carry pane id + generation + kind + report key', /NP\.offer\(notices, \{ pane: p\.id, gen: p\.obs\.gen, kind, key, p, body, title \}, Date\.now\(\), g\)/.test(offer));
  t('main: the alert itself is unchanged (canAlert 4 s after a load, prev != null baseline, pane-state alert key once)', /if \(Date\.now\(\) - p\.loadedAt < 4000\) return false;/.test(fn('canAlert'))
    && /else if \(prev != null && \(!wasAsk \|\| c\.botSince > prev\) && canAlert\(p\) && !obsDo\(p, \{ type: 'alert', key: PS\.alertKey\(c\) \}\)\.code\)/.test(msg)
    && /if \(p\.needsReply && canAlert\(p\) && !obsDo\(p, \{ type: 'alert', key: PS\.alertKey\(nf\) \}\)\.code\)/.test(main) && /if \(!res\.fresh\) return;/.test(main));
  t('main: 🟣 / 🔴 never alert (needsReply excludes done / working; glow cleared when not needed)', /p\.needsReply = !!\(c\.asks \|\| c\.waiting\) && !c\.working && !c\.done && c\.botSince > 0;/.test(msg)
    && /else if \(!p\.needsReply\) \{ p\.glow = false; \}/.test(msg) && /p\.needsReply = !!\(nf\.asks \|\| nf\.waiting\) && !nf\.working && !nf\.done;/.test(main));
  t('main: glow / badge / state are set before the delivery and the delivery never touches them', light.indexOf('p.glow = true;') < light.indexOf('notifyPane(') && light.indexOf('updateBadge(); sendState();') < light.indexOf('notifyPane(')
    && ![offer, take, click].some(f => /\.glow\b|\.unread\s*=|unopened|needsReply|setBadge|updateBadge|updateDockBadge|clearUnread|sendState/.test(f)));
  t('main: Dock badge still from the panes only (unmuted, needsReply, unread)', /const n = ctxs\.reduce\(\(a, c\) => a \+ c\.panes\.filter\(p => !p\.muted\)\.reduce\(\(b, p\) => b \+ \(p\.msgMode && p\.needsReply \? \(p\.unread \|\| 0\) : 0\), 0\), 0\);/.test(fn('updateDockBadge')));
  t('main: a due window goes out before a new candidate; one timer for the window', offer.indexOf('noticeTake();') < offer.indexOf('NP.offer(') && /if \(r\.code === 'OPEN'\) noticeArm\(NP\.WINDOW_MS\);/.test(offer)
    && /noticeTimer = setTimeout\(/.test(fn('noticeArm')) && /clearTimeout\(noticeTimer\)/.test(fn('noticeArm')));
  t('main: at delivery closed / muted / now-in-view panes are dropped, then one notification (merged title / body from the policy)', /'GONE' : it\.p\.muted \? 'MUTED' : c\.inView\(it\.p\) \? 'SEEN'/.test(take)
    && /const m = NP\.compose\(live\);/.test(take) && /\{ title: m\.item\.title, body: m\.item\.body, silent: false \} : \{ title: m\.title, body: m\.body, silent: false \}/.test(take));
  t('main: MPB_NOTIFY_DRYRUN shows nothing (returns before the Notification)', /const NOTIFY_DRYRUN = !!process\.env\.MPB_NOTIFY_DRYRUN;/.test(main) && take.indexOf('if (NOTIFY_DRYRUN || !Notification.isSupported()) return;') >= 0
    && take.indexOf('if (NOTIFY_DRYRUN') < take.indexOf('new Notification('));
  t('main: notification sites cover panes, downloads, and prepared updates', main.split('new Notification(').length - 1 === 3 && /new Notification\(\{ title: 'ダウンロード完了', body: path\.basename\(dest\) \}\)/.test(main) && /new Notification\(\{ title: 'アップデートの準備ができました'/.test(main));
  t('main: click - one pane: clickOk + its own window, focus without marking read; merged / stale: front only', /NP\.clickOk\(it, it\.p\) && ctxOf\(it\.p\) === c/.test(click) && /if \(ok\) c\.openPane\(it\.p\);/.test(click)
    && /openPane\(p\) \{ const i = panes\.indexOf\(p\); if \(i >= 0\) focusPane\(i, \{ clear: false \}\); \}/.test(main) && !/focusPaneById|clearUnread|panes\[/.test(click));
  t('main: diagnostics get fixed codes, pane numbers and counts only', [offer, take, click].every(f => [...f.matchAll(/diag\.rec\(([^\n]*?)\);/g)].every(m => /^'notify', /.test(m[1]) && !/title|body|\.name\b|url|key\b|ek\b/.test(m[1]))));
  t('main: the debug log gets kind / code / counts only (no title, body, key)', [...(offer + take).matchAll(/dlog\(([^\n]*?)\);/g)].every(m => !/title|body|\bkey\b|\.ek\b/.test(m[1])));
  t('main: 設定 menu - quiet hours (off + presets) after the notification switch, saved as settings.quietHours', line("label: '更新時にmacOS通知を出す'").length > 0
    && main.indexOf("label: '更新時にmacOS通知を出す'") < main.indexOf('quietMenu(),') && /settings\.quietHours = v; save\(\); buildMenu\(\);/.test(fn('quietMenu')) && /NP\.QUIET_PRESETS\.map/.test(fn('quietMenu')));
  t('main: no new IPC channel, renderer untouched by this', !/ipc(On|Handle)\('[^']*(notice|notify|quiet)/i.test(main));
  t('main: diag env shows quiet hours as on / off', /quietHours: NP\.quietOf\(settings\.quietHours\)\.on/.test(fn('diagEnv'))); }

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
