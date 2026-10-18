// node test/probe-policy.test.js — background check freshness / backoff (#33): src/probe-policy.js keeps per sleeping pane the last attempt /
// success, failures in a row and the next check; only a usable result is a success, failures back off 5/10/20/40/60 min (MPB_CHECK_SEC: the
// same steps of its base), a clear sign-in page stops every check until 確認を再開, the placeholder line. Fake clock throughout. Contract with
// the real main.js / renderer / preload / IPC / diagnostics. Not covered here: a real expired Grok login, the hidden window, the UI - manual check.
const fs = require('fs'), path = require('path');
const PB = require('../src/probe-policy');
const DG = require('../src/diagnostics');
const IPC = require('../src/ipc-policy');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const SRC = path.join(__dirname, '..', 'src'), read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const J = JSON.stringify;
const MIN = 60000, BASE = PB.BASE_MS;
const T0 = Date.UTC(2026, 9, 19, 1, 0, 0);                   // a fixed time; every `now` below is T0 + something
const fails = ['unsure', 'timeout', 'offsite', 'auth', 'notfound', 'error'];

// ---- constants ----
t('base 5 min, steps 1/2/4/8/12, cap 60 min', BASE === 5 * MIN && J(PB.STEPS) === J([1, 2, 4, 8, 12]) && PB.CAP_MS === 60 * MIN);
t('kinds: ok / unsure / timeout / offsite / auth / notfound / error / aborted; failures = all but ok / aborted',
  J(PB.KINDS) === J(['ok', ...fails, 'aborted']) && J(PB.FAILS) === J(fails) && fails.every(PB.failed) && !PB.failed('ok') && !PB.failed('aborted') && !PB.failed('x'));

// ---- the waits ----
t('wait: 0 failures -> the base; 1..5 -> 5/10/20/40/60 min; more -> 60 min', J([0, 1, 2, 3, 4, 5, 6, 50, 9999].map(n => PB.waitFor(n, BASE) / MIN)) === J([5, 5, 10, 20, 40, 60, 60, 60, 60]));
t('wait: odd counts -> the base', [-1, 1.5, NaN, '3', null, undefined].every(n => PB.waitFor(n, BASE) === BASE));
t('wait: no / odd base -> 5 min', [undefined, 0, -5, NaN, Infinity, '300000'].every(b => PB.waitFor(0, b) === BASE && PB.waitFor(5, b) === 60 * MIN));
t('MPB_CHECK_SEC=20: the same steps in seconds (20/40/80/160/240 s)', J([0, 1, 2, 3, 4, 5, 6].map(n => PB.waitFor(n, 20000) / 1000)) === J([20, 20, 40, 80, 160, 240, 240]));
t('MPB_CHECK_SEC=600: 10/20/40/60/60 min (cap 60 min)', J([1, 2, 3, 4, 5].map(n => PB.waitFor(n, 10 * MIN) / MIN)) === J([10, 20, 40, 60, 60]));
t('a base above the cap: never shorter than the base', [0, 1, 5].every(n => PB.waitFor(n, 2 * 60 * MIN) === 2 * 60 * MIN));
t('no wait above 60 min at the default / any dev base up to 5 min', [BASE, 1000, 20000, 60000].every(b => [1, 2, 3, 4, 5, 6, 100].every(n => PB.waitFor(n, b) <= PB.CAP_MS)));

// ---- a sleep: first check, failures in a row, success ----
{ let pb = PB.init(T0, BASE);
  t('new sleep: nothing tried, the first check one base interval later (as before)', J(pb) === J({ lastAttemptAt: 0, lastSuccessAt: 0, failureCount: 0, nextEligibleAt: T0 + BASE, kind: '' })
    && !PB.isDue(pb, T0 + BASE - 1) && PB.isDue(pb, T0 + BASE));
  // every check fails (30 s each): the next one waits 5/10/20/40/60/60 min after its end
  let now = T0 + BASE, lastStart = 0; const gaps = [];
  for (let i = 0; i < 7; i++) {
    lastStart = now; pb = PB.start(pb, now, BASE); now += 30000; pb = PB.record(pb, 'timeout', now, BASE);
    gaps.push((pb.nextEligibleAt - now) / MIN); now = pb.nextEligibleAt;
  }
  t(`failures in a row: waits ${gaps.join('/')} min`, J(gaps) === J([5, 10, 20, 40, 60, 60, 60]) && pb.failureCount === 7);
  t('failures: lastSuccessAt never moves, the attempt time does', pb.lastSuccessAt === 0 && pb.lastAttemptAt === lastStart && pb.kind === 'timeout');
  pb = PB.start(pb, now, BASE); now += 20000; pb = PB.record(pb, 'ok', now, BASE);
  t('a success: back to 5 min, count 0, lastSuccessAt = its time', pb.failureCount === 0 && pb.lastSuccessAt === now && pb.nextEligibleAt === now + BASE && pb.kind === 'ok');
  const ok = pb;
  pb = PB.record(pb, 'unsure', now + MIN, BASE);
  t('the next failure starts the steps again at 5 min; the last success stays', pb.failureCount === 1 && pb.nextEligibleAt === now + MIN + 5 * MIN && pb.lastSuccessAt === ok.lastSuccessAt); }
t('every failure kind backs off and keeps the last success', fails.every(k => { const s = PB.record({ lastSuccessAt: T0, failureCount: 2, nextEligibleAt: T0, lastAttemptAt: T0 }, k, T0 + MIN, BASE);
  return s.failureCount === 3 && s.lastSuccessAt === T0 && s.nextEligibleAt === T0 + MIN + 20 * MIN && s.kind === k; }));
{ const s0 = { lastSuccessAt: T0, failureCount: 2, nextEligibleAt: T0, lastAttemptAt: T0, kind: 'offsite' }, s = PB.record(s0, 'aborted', T0 + MIN, BASE);
  t('cut short (woke / aborted / stale): no failure, no success; waits as for its count so far', s.failureCount === 2 && s.lastSuccessAt === T0 && s.nextEligibleAt === T0 + MIN + 10 * MIN);
  const s1 = PB.record({ ...s0, failureCount: 0 }, 'aborted', T0 + MIN, BASE);
  t('...with no failures: the base again (as the old check-start time did)', s1.failureCount === 0 && s1.nextEligibleAt === T0 + MIN + BASE); }
t('an unknown kind counts as an error', PB.record(PB.init(T0, BASE), 'weird', T0, BASE).kind === 'error' && PB.record(PB.init(T0, BASE), undefined, T0, BASE).failureCount === 1);
t('the count stops at 9999 (never NaN / unbounded)', PB.record({ failureCount: 9999 }, 'error', T0, BASE).failureCount === 9999 && PB.record({ failureCount: 1e12 }, 'error', T0, BASE).failureCount === 9999);
{ const s = PB.start({ failureCount: 3, nextEligibleAt: T0, lastSuccessAt: T0 - MIN }, T0 + 5, BASE);
  t('start: an attempt now; until its result the next one waits as for its count (a check that never reports is not retried at once)', s.lastAttemptAt === T0 + 5 && s.nextEligibleAt === T0 + 5 + 20 * MIN && s.failureCount === 3 && s.lastSuccessAt === T0 - MIN); }

// ---- clock set back / odd values ----
{ const pb = PB.record(PB.init(T0, BASE), 'timeout', T0, BASE);   // next at T0 + 5 min
  const back = T0 - 24 * 60 * MIN;                                 // the clock goes back a day
  const s = PB.settle(pb, back, BASE);
  t('clock set back a day: the next check is the wait from now, not a day later', s.nextEligibleAt === back + 5 * MIN && !PB.isDue(s, back) && PB.isDue(s, back + 5 * MIN));
  const s2 = PB.settle(s, back + 60000, BASE);
  t('...and stays put (no drift on every tick)', s2.nextEligibleAt === s.nextEligibleAt);
  const st = PB.start(pb, back, BASE);
  t('start while the clock is back: the next check counts from now', st.lastAttemptAt === back && st.nextEligibleAt === back + 5 * MIN);
  const far = PB.settle({ failureCount: 5, nextEligibleAt: T0 + 365 * 24 * 60 * MIN }, T0, BASE);
  t('a next check far away (any reason): at most the wait (60 min at 5 failures)', far.nextEligibleAt === T0 + 60 * MIN);
  t('within its wait: unchanged', PB.settle(pb, T0 + MIN, BASE).nextEligibleAt === pb.nextEligibleAt);
  const fwd = PB.settle(pb, T0 + 10 * 24 * 60 * MIN, BASE);
  t('clock jumped forward: simply due (one check, then counted from its own time)', fwd.nextEligibleAt === pb.nextEligibleAt && PB.isDue(fwd, T0 + 10 * 24 * 60 * MIN)
    && PB.record(PB.start(fwd, T0 + 10 * 24 * 60 * MIN, BASE), 'timeout', T0 + 10 * 24 * 60 * MIN, BASE).nextEligibleAt === T0 + 10 * 24 * 60 * MIN + 10 * MIN); }
t('odd state (none, NaN, strings, a list): numbers only, due at once (never stuck)', [undefined, null, 5, 'x', [], { nextEligibleAt: NaN, failureCount: 'x', lastSuccessAt: Infinity }].every(o => {
  const s = PB.settle(o, T0, BASE); return s.nextEligibleAt === 0 && s.failureCount === 0 && s.lastSuccessAt === 0 && PB.isDue(s, T0); }));
t('odd now: treated as 0, never NaN', Number.isFinite(PB.start(PB.init(T0, BASE), NaN, BASE).nextEligibleAt) && Number.isFinite(PB.record(null, 'ok', 'x', BASE).nextEligibleAt));

// ---- which pane: one per call, the one due longest ----
{ const mk = (id, next, f = 0) => ({ id, pb: { lastAttemptAt: 0, lastSuccessAt: 0, failureCount: f, nextEligibleAt: next, kind: '' } });
  t('pick: none due -> none', PB.pick([mk(1, T0 + 1), mk(2, T0 + 5)], T0) === null && PB.pick([], T0) === null && PB.pick(undefined, T0) === null && PB.pick([null], T0) === null);
  t('pick: the one due longest', PB.pick([mk(1, T0 - 10), mk(2, T0 - 99), mk(3, T0)], T0).id === 2 && PB.pick([mk(1, T0), mk(2, T0)], T0).id === 1);
  t('pick: a backed-off pane is not due before its wait', PB.pick([mk(1, T0 + 20 * MIN, 3)], T0 + 19 * MIN) === null && PB.pick([mk(1, T0 + 20 * MIN, 3)], T0 + 20 * MIN).id === 1);
  // the Mac wakes / unlocks with 10 sleeping panes all overdue: main's tick (15 s, none for 20 s after resume, one check at a time) checks one per tick
  const list = Array.from({ length: 10 }, (_, i) => mk(i + 1, T0 - (i + 1) * 3 * MIN));
  const resumeAt = T0; let now = T0, busyUntil = 0; const order = [], perTick = [];
  for (let tick = 0; tick < 80; tick++) {
    now += 15000; let n = 0;
    if (now - resumeAt >= 20000 && now >= busyUntil) {
      const q = PB.pick(list, now);
      if (q) { n++; q.pb = PB.start(q.pb, now, BASE); busyUntil = now + 28000; q.pb = PB.record(q.pb, 'ok', now + 28000, BASE); order.push(q.id); }
    }
    perTick.push(n);
  }
  t(`after resume: overdue panes one per tick, longest due first (${order.slice(0, 10).join(',')})`, perTick.every(n => n <= 1) && J(order.slice(0, 10)) === J([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]) && perTick[0] === 0); }
{ // load: 10 sleeping panes whose every check fails, over 2 hours (old: one check per pane every 5 min = 240)
  const list = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, pb: PB.init(T0 + i * 1000, BASE) }));
  let now = T0, busyUntil = 0, n = 0;
  while (now < T0 + 120 * MIN) { now += 15000; if (now < busyUntil) continue; const q = PB.pick(list, now); if (!q) continue; q.pb = PB.start(q.pb, now, BASE); busyUntil = now + 30000; q.pb = PB.record(q.pb, 'timeout', now + 30000, BASE); n++; }
  t(`failing checks back off: ${n} checks in 2 h for 10 panes (each at most 5: at 5, +5, +10, +20, +40 min; was 24 each)`, n <= 50 && n >= 40 && list.every(q => q.pb.failureCount <= 5)); }

// ---- what a check that gave no stable scan was ----
const K = o => PB.kindOf(o);
t('kindOf: woke / aborted -> aborted (whatever else)', K({ woke: true, why: 'timeout' }) === 'aborted' && K({ why: 'abort' }) === 'aborted' && K({ why: 'abort', auth: true }) === 'aborted' && K({ woke: true, error: true }) === 'aborted');
t('kindOf: threw -> error', K({ error: true, why: 'timeout' }) === 'error' && K({ error: true, why: 'timeout', auth: true }) === 'error');
t('kindOf: a sign-in page (URL) or the page\'s own AUTH_REQUIRED -> auth', K({ why: 'offsite', auth: true }) === 'auth' && K({ why: 'timeout', auth: true }) === 'auth' && K({ why: 'timeout', issue: 'AUTH_REQUIRED' }) === 'auth');
t('kindOf: another site that is not a sign-in -> offsite (no stop)', K({ why: 'offsite', auth: false }) === 'offsite' && K({ why: 'offsite' }) === 'offsite' && K({ why: 'offsite', issue: 'DOM_UNKNOWN' }) === 'offsite');
t('kindOf: not found -> notfound', K({ why: 'notfound' }) === 'notfound');
t('kindOf: timeout with an unsure page (DOM_UNKNOWN / CHANGING / LOADING ...) -> unsure, never auth', ['DOM_UNKNOWN', 'CHANGING', 'LOADING', 'LATEST_PARTIAL', 'ROLE_GUESS'].every(i => K({ why: 'timeout', issue: i }) === 'unsure'));
t('kindOf: timeout, nothing reported -> timeout', K({ why: 'timeout' }) === 'timeout' && K({ why: 'timeout', issue: '' }) === 'timeout');
t('kindOf: anything else -> error (never ok)', K({}) === 'error' && K() === 'error' && K({ why: 'ok' }) === 'error');
t('kindOf: only auth stops checks; DOM_UNKNOWN / offsite / timeout never', ['DOM_UNKNOWN', '', 'LOADING'].every(i => ['offsite', 'timeout', 'notfound'].every(w => K({ why: w, issue: i }) !== 'auth')));

// ---- a sign-in page: from the URL only, known hosts / paths ----
const AP = u => PB.authPage(u);
t('authPage: the x.ai account host (any page)', ['https://accounts.x.ai/sign-in?redirect=grok-com', 'https://accounts.x.ai/', 'https://ACCOUNTS.X.AI/sign-in', 'https://accounts.x.ai./sign-in'].every(AP));
t('authPage: sign-in paths on grok.com / x.ai / X / Google / Apple', ['https://grok.com/sign-in', 'https://grok.com/login?x=1', 'https://x.ai/auth/x', 'https://x.com/i/oauth2/authorize?a=1', 'https://twitter.com/i/flow/login',
  'https://accounts.google.com/o/oauth2/v2/auth', 'https://appleid.apple.com/auth/authorize'].every(AP));
t('authPage: a bot page, home, another page of the same hosts -> no', ['https://grok.com/bot/abc', 'https://grok.com/', 'https://grok.com/c/123', 'https://x.com/home', 'https://x.ai/', 'https://accounts.google.com/'].every(u => !AP(u)));
t('authPage: other sites, even with a sign-in path -> no (only "left grok.com")', ['https://example.com/login', 'https://evil.example/accounts.x.ai/sign-in', 'https://accounts.x.ai.evil.example/sign-in', 'https://grok.com.evil.example/sign-in',
  'https://login.example.com/', 'https://sub.grok.com/sign-in'].every(u => !AP(u)));
t('authPage: not https / user info / another port / not a URL -> no', ['http://accounts.x.ai/sign-in', 'https://u:p@accounts.x.ai/sign-in', 'https://accounts.x.ai:8443/sign-in', 'about:blank', 'chrome-error://chromewebdata/', '', 'x', null, undefined, 42, {}].every(u => !AP(u)));
t('authPage: a path segment, not a substring', !AP('https://grok.com/bot/login-helper') && !AP('https://grok.com/bot/signin2') && AP('https://grok.com/bot/x/login'));

// ---- 確認を再開 ----
{ const a = { lastSuccessAt: T0 - MIN, failureCount: 1, nextEligibleAt: T0 + 5 * MIN, lastAttemptAt: T0, kind: 'auth' };
  const o = { lastSuccessAt: 0, failureCount: 2, nextEligibleAt: T0 + 10 * MIN, lastAttemptAt: T0, kind: 'timeout' };
  const ra = PB.resume(a, T0 + MIN), ro = PB.resume(o, T0 + MIN);
  t('resume: the pane that saw the sign-in page starts over and is due now (its last success stays)', ra.failureCount === 0 && ra.nextEligibleAt === T0 + MIN && ra.kind === '' && ra.lastSuccessAt === T0 - MIN && PB.isDue(ra, T0 + MIN));
  t('resume: every other pane keeps its backoff', Object.keys(o).every(k => ro[k] === o[k]));
  t('resume twice: the same (nothing more becomes due)', J(PB.resume(ra, T0 + 2 * MIN)) === J(ra));
  // after resume, the checks still go one per pick (the tick): never two at once
  const list = [{ id: 1, pb: ra }, { id: 2, pb: { ...o, nextEligibleAt: T0 - MIN } }, { id: 3, pb: { ...o, nextEligibleAt: T0 } }];
  const first = PB.pick(list, T0 + MIN); first.pb = PB.start(first.pb, T0 + MIN, BASE);
  const second = PB.pick(list, T0 + MIN);
  t('after resume: one at a time through pick (the started one is not due again)', first.id === 2 && second.id === 3 && second !== first); }

// ---- the placeholder line ----
{ const hm = x => { const d = new Date(x); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const L = (pb, o) => PB.label(pb, o);
  const fresh = PB.init(T0, BASE), ok = PB.record(fresh, 'ok', T0 + 5 * MIN, BASE), f2 = PB.record(PB.record(fresh, 'timeout', T0 + 5 * MIN, BASE), 'offsite', T0 + 10 * MIN, BASE);
  const okf = PB.record(ok, 'unsure', T0 + 10 * MIN, BASE);
  t('label: nothing tried yet -> 次回確認 hh:mm', L(fresh) === `次回確認 ${hm(T0 + BASE)}`);
  t('label: after a success -> 最終確認 hh:mm・次回 hh:mm', L(ok) === `最終確認 ${hm(T0 + 5 * MIN)}・次回 ${hm(T0 + 10 * MIN)}`);
  t('label: failures -> 確認失敗（n回）・次回 hh:mm (no success claimed)', L(f2) === `確認失敗（2回）・次回 ${hm(T0 + 10 * MIN + 10 * MIN)}` && !L(f2).includes('最終確認'));
  t('label: failures after a success -> the last success, then the failures', L(okf) === `最終確認 ${hm(T0 + 5 * MIN)}・確認失敗（1回）・次回 ${hm(T0 + 15 * MIN)}`);
  t('label: stopped after a sign-in page', L(f2, { hold: true }) === 'ログイン要確認で新着確認を停止中' && L(okf, { hold: true }) === `ログイン要確認で新着確認を停止中・最終確認 ${hm(T0 + 5 * MIN)}`);
  t('label: checks off in the settings -> none', L(ok, { off: true }) === '' && L(f2, { off: true, hold: true }) === '');
  t('label: odd state -> a line, never a throw', typeof L(undefined) === 'string' && typeof L({ failureCount: 'x' }) === 'string'); }

// ---- diagnostics: fixed codes, counts only ----
t('diagnostics: probe takes BACKOFF / AUTH_HOLD / RESUME and every earlier code', PB.CODES.every(c => DG.EVENTS.probe.r.includes(c))
  && ['CHANGED', 'SAME', 'BASELINE', 'UNSURE', 'STALE', 'TIMEOUT', 'ABORT', 'WOKE', 'OFFSITE', 'NOTFOUND', 'ERROR'].every(c => DG.EVENTS.probe.r.includes(c)));
t('diagnostics: a BACKOFF entry keeps the pane number and the failures in a row only', J(DG.sanitize('probe', 'BACKOFF', { p: 3, n: 4, url: 'https://accounts.x.ai/sign-in', kind: 'auth' }, 1)) === J({ t: 1, ev: 'probe', r: 'BACKOFF', n: 4, p: 3 }));

// ---- contract with the real main.js ----
{ const main = read('main.js');
  const fn = name => { const i = main.indexOf(`function ${name}(`); if (i < 0) return ''; let d = 0, j = main.indexOf(') {', i) + 2; for (; j < main.length; j++) { if (main[j] === '{') d++; else if (main[j] === '}' && --d === 0) break; } return main.slice(i, j + 1); };
  const sel = fn('probeSelect'), pp = fn('probePane'), pe = fn('probeEnd'), pr = fn('probeResume'), sp = fn('sleepPane'), ss = fn('sendState');
  const at = (s, x) => s.indexOf(x), count = (s, x) => s.split(x).length - 1;
  t('main: the rules come from probe-policy.js; the old per-pane lastCheck is gone', /^const PB = require\('\.\/probe-policy'\);$/m.test(main) && !/lastCheck/.test(main) && /^let probeAuthHold = false;$/m.test(main));
  t('main: a new sleep gets a new state (first check one interval later)', /p\.pb = PB\.init\(p\.sleepAt, SLEEP_CHECK_MS\);/.test(sp) && at(sp, 'p.sleepAt = Date.now()') < at(sp, 'PB.init('));
  t('main: the state is never saved (panes.json / workspaces)', !/pb/.test(main.slice(at(main, 'const paneSpec'), main.indexOf('\n', at(main, 'const paneSpec')))) && !/\.pb\b/.test(fn('stateDoc')));
  // the scheduler, budget and holds are as before (nothing added, nothing skipped)
  t('main: the 15 s tick, one check at a time, none while asleep / locked or within 20 s of resume (unchanged)', /setInterval\(async \(\) => \{[^\n]*\n\s*if \(probeBusy \|\| sysBlocked \|\| Date\.now\(\) - resumeAt < 20000\)/.test(main)
    && /try \{ for \(const c of ctxs\) if \(await c\.probeNext\(\)\) break; \}/.test(main) && /probeBusy = false;\n\}, 15000\);/.test(main));
  t('main: suspend / lock block, resume / unlock set resumeAt (unchanged)', /powerMonitor\.on\('suspend', \(\) => \{ sysBlocked = true; \}\); powerMonitor\.on\('lock-screen', \(\) => \{ sysBlocked = true; \}\);/.test(main)
    && /powerMonitor\.on\('resume', \(\) => \{ sysBlocked = false; resumeAt = Date\.now\(\); \}\); powerMonitor\.on\('unlock-screen', \(\) => \{ sysBlocked = false; resumeAt = Date\.now\(\); \}\);/.test(main));
  t('main: 30 s budget, router hops at most 3 (4 s apart), one hard reload after 14 s, inside the same loop (unchanged)', /^const PROBE_MAX_MS = 30000;/m.test(main) && /while \(Date\.now\(\) - t0 < PROBE_MAX_MS\) \{/.test(pp)
    && /if \(pushes >= 3 && hard < 1 && Date\.now\(\) - lastPush > 4000 && Date\.now\(\) - t0 > 14000\) \{ hard\+\+; pushes = 0;/.test(pp) && /if \(pushes < 3 && Date\.now\(\) - lastPush > 4000 && Date\.now\(\) - t0 > 1500\) \{/.test(pp)
    && count(pp, 'appLoad(wc, target)') === 2 && count(pp, 'while (') === 1);
  t('main: probeSelect keeps every hold (setting off, other loads / reload-all 30 s, a loading pane 15 s, focused / maximized) and adds the sign-in stop before them',
    /if \(settings\.sleepCheck === false \|\| !win \|\| win\.isDestroyed\(\) \|\| quitting\) return null;/.test(sel) && /if \(lq\.some\(t => !t\.probe\) \|\| now - lastReloadAll < 30000\) return hold\(/.test(sel)
    && /now - \(q\.loadedAt \|\| 0\) < 15000/.test(sel) && /i !== focused && maximizedId !== q\.id/.test(sel) && at(sel, 'if (probeAuthHold) return hold(') > 0 && at(sel, 'if (probeAuthHold)') < at(sel, 'lq.some('));
  t('main: probeSelect settles each candidate (clock set back) and picks one by its own next check', /cands\.forEach\(q => \{ q\.pb = PB\.settle\(q\.pb, now, SLEEP_CHECK_MS\); \}\);/.test(sel) && /const best = PB\.pick\(cands, now\);/.test(sel) && /return best;/.test(sel) && !/SLEEP_CHECK_MS\s*;?\s*\n?\s*if \(due/.test(sel));
  t('main: still one check task through the queue (BG, probe) per probeNext', /purpose: 'PROBE', cls: 'BG', probe: true/.test(fn('probeNext')) && count(main, "purpose: 'PROBE'") === 1);
  // the outcome of a check
  t('main: an attempt is noted when the check starts (before its window exists)', at(pp, 'p.pb = PB.start(p.pb, Date.now(), SLEEP_CHECK_MS);') > 0 && at(pp, 'PB.start(') < at(pp, 'new BrowserWindow') && at(pp, 'PB.start(') < at(pp, 'if (!id) return;'));
  t('main: no count -> kindOf (threw / woke / why / last page issue / sign-in URL)', /probeEnd\(p, sid, PB\.kindOf\(\{ error: failed, woke: !p\.sleeping, why, issue: unsure, auth: atAuth \}\)\); return; \}/.test(pp));
  t('main: the sign-in check reads the window\'s last URL once, before it is destroyed, and keeps a boolean only', count(main, 'PB.authPage(') === 1 && /try \{ if \(!last && !wc\.isDestroyed\(\)\) atAuth = PB\.authPage\(wc\.getURL\(\)\); \} catch \{\}/.test(pp)
    && at(pp, 'atAuth = PB.authPage') > at(pp, 'finally') && at(pp, 'atAuth = PB.authPage') < at(pp, 'bw.destroy()'));
  t('main: an unsure scan is a failure (UNSURE, before any result)', at(pp, "probeEnd(p, sid, 'unsure')") > at(pp, "diag.rec('probe', 'UNSURE'") && at(pp, "probeEnd(p, sid, 'unsure')") < at(pp, "type: 'probe-result'"));
  t('main: a result for another sleep is cut short (STALE), not a success', /diag\.rec\('probe', 'STALE'[^\n]*probeEnd\(p, sid, 'aborted'\); return; \}/.test(pp));
  t('main: the only success is after this sleep\'s probe-result (once)', count(main, "probeEnd(p, sid, 'ok')") === 1 && at(pp, "probeEnd(p, sid, 'ok')") > at(pp, 'if (res.code)') && at(pp, "probeEnd(p, sid, 'ok')") < at(pp, 'if (!res.fresh) return;'));
  t('main: probeEnd only for the sleep it was started in; record; BACKOFF / AUTH_HOLD fixed codes', /if \(!p\.sleeping \|\| !p\.obs\.sleep \|\| p\.obs\.sleep\.id !== sid\) return;/.test(pe) && at(pe, 'p.obs.sleep.id !== sid') < at(pe, 'PB.record(')
    && /p\.pb = PB\.record\(p\.pb, kind, Date\.now\(\), SLEEP_CHECK_MS\);/.test(pe) && /if \(PB\.failed\(kind\)\) \{ diag\.rec\('probe', 'BACKOFF', \{ p: p\.id, n: p\.pb\.failureCount \}\);/.test(pe));
  t('main: only an auth outcome stops the checks (all windows told)', count(main, 'probeAuthHold = true') === 1 && /if \(kind === 'auth' && !probeAuthHold\) \{ probeAuthHold = true; diag\.rec\('probe', 'AUTH_HOLD', \{ p: p\.id \}\);[^\n]*buildMenu\(\); broadcast\(\); return; \}/.test(pe));
  t('main: probeEnd never touches unopened / counts / notifications / the baseline', !/unopened|unread|needsReply|notifyPane|waiting|obsDo|glow/.test(pe));
  t('main: 確認を再開 - manual, once, the pane that saw it due again, then the usual tick (no check started here)', /^function probeResume\(\) \{\n  if \(!probeAuthHold\) return;\n  probeAuthHold = false;/m.test(main)
    && /p\.pb = PB\.resume\(p\.pb, now\)/.test(pr) && /diag\.rec\('probe', 'RESUME'\)/.test(pr) && !/probeNext|probePane|probeSelect|lq\.request|setInterval|setTimeout/.test(pr) && (main.match(/^\s+probeAuthHold = false;/gm) || []).length === 1);
  t('main: 確認を再開 from the placeholder (IPC) and the 設定 menu', /^on\('probe-resume', \(\) => probeResume\(\)\);/m.test(main) && /enabled: probeAuthHold, click: \(\) => probeResume\(\)/.test(main));
  t('main: wake / close / reload-all still stop a check (unchanged)', /abortProbe\(p\); p\.sleeping = false;/.test(fn('reloadPane')) && /disposePane\(p, 'CLOSED'\);/.test(fn('closePane')) && /obsDo\(p, \{ type: 'close' \}\); abortProbe\(p\);/.test(fn('disposePane')) && /lastReloadAll = Date\.now\(\); abortProbe\(\);/.test(fn('reloadAll')));
  t('main: the screen gets the line for sleeping panes only, and the stop', /chk: p\.sleeping \? PB\.label\(p\.pb, \{ hold: probeAuthHold, off: settings\.sleepCheck === false \}\) : ''/.test(ss) && /chkHold: probeAuthHold,/.test(ss));
  t('main: turning the check setting on / off updates the screens', /settings\.sleepCheck = m\.checked; save\(\); broadcast\(\);/.test(main));
  t('main: no URL / name in what probeEnd / probeResume log', ![pe, pr].some(s => /getURL|paneUrl|\.url\b|\.name\b|title|botTarget/.test(s))); }

// ---- the UI: placeholder line + two buttons; IPC / preload ----
{ const r = read('renderer.js'), css = read('style.css'), pre = read('preload.js');
  t('renderer: the placeholder has the line and ログインを確認 / 確認を再開', /<div class="chk"><span class="chkt"><\/span><button class="pbx pbl"[^>]*>ログインを確認<\/button><button class="pbx pbr"[^>]*>確認を再開<\/button><\/div>/.test(r));
  t('renderer: ログインを確認 opens this pane, 確認を再開 only resumes (neither wakes through the placeholder click)', /d\.querySelector\('\.pbl'\)\.onclick = e => \{ e\.stopPropagation\(\); mpb\.wakePane\(id\); \};/.test(r)
    && /d\.querySelector\('\.pbr'\)\.onclick = e => \{ e\.stopPropagation\(\); mpb\.probeResume\(\); \};/.test(r));
  t('renderer: shows main\'s text as text (no HTML), buttons only while stopped', /c\.querySelector\('\.chkt'\)\.textContent = p\.chk \|\| '';/.test(r) && /c\.classList\.toggle\('hold', !!\(p\.chk && s\.chkHold\)\);/.test(r));
  t('style: the line is shown only when there is one; buttons only while stopped; the buttons are not 取消 (.lqx)', /\.pane \.sleepph \.chk\{display:none;/.test(css) && /\.pane \.sleepph \.chk\.on\{display:flex\}/.test(css)
    && /\.pane \.sleepph \.chk \.pbx\{display:none\}/.test(css) && /\.pane \.sleepph \.chk\.hold \.pbx\{display:inline-flex/.test(css) && !/class="[^"]*lqx[^"]*"[^>]*>確認を再開/.test(r));
  t('preload: probeResume sends probe-resume with nothing else', /probeResume: \(\) => send\('probe-resume'\),/.test(pre));
  t('IPC: probe-resume is a chrome channel without payload (overlay / panes / probe refused)', J(IPC.CHANNELS['probe-resume'].roles) === '["chrome"]' && !IPC.CHANNELS['probe-resume'].shape && !IPC.CHANNELS['probe-resume'].target
    && IPC.check('probe-resume', { role: 'chrome', frame: { top: true, detached: false, url: require('url').pathToFileURL(IPC.DOCS.chrome).href, origin: 'file://' } }, [], { owned: true }) === null
    && ['pane', 'probe'].every(role => IPC.check('probe-resume', { role, frame: { top: true, detached: false, url: 'https://grok.com/bot/a', origin: 'https://grok.com' } }, [], { owned: true }) === 'E_ROLE')); }

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
