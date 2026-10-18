// node test/recovery-policy.test.js — limited recovery (#32): src/recovery-policy.js tells a failed main-frame load (transient / permanent), an
// intended cancel (ERR_ABORTED), a child frame's failure, a slow load, an unresponsive page and a gone renderer apart; only a transient failure of
// the pane's current entity / generation is reloaded by itself, at most 2 times in 10 min (15 s, then 60 s), checked again right before (closed /
// asleep / another page or generation / input / busy), and a gone renderer waits for the user. Fake clock throughout. Contract with the real
// main.js / renderer / style / IPC / diagnostics. Not covered here: real Chromium failures / crashes, the placeholder on screen - manual check.
const fs = require('fs'), path = require('path');
const RP = require('../src/recovery-policy');
const DG = require('../src/diagnostics');
const GUARD = require('../src/draft-guard');
const IPC = require('../src/ipc-policy');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const SRC = path.join(__dirname, '..', 'src'), read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const J = JSON.stringify;
const S = 1000, MIN = 60 * S;
const T0 = Date.UTC(2026, 9, 19, 1, 0, 0);
const BOT = 'https://grok.com/bot/abc', OTHER = 'https://grok.com/bot/xyz';
const fail = (code, o = {}) => ({ code, main: true, web: true, ent: 1, gen: 5, url: BOT, ...o });
const seen = (o = {}) => ({ ent: 1, gen: 5, url: BOT, closed: false, sleeping: false, crashed: false, idle: false, busy: false, ime: false, hold: false, loading: false, queued: false, fixing: false, ...o });

// ---- constants / codes ----
t('10 min / 2 automatic reloads, waits 15 s then 60 s, tick 5 s, 20 s after a wake', RP.WINDOW_MS === 10 * MIN && RP.MAX_AUTO === 2 && J(RP.WAITS) === J([15 * S, 60 * S]) && RP.TICK_MS === 5 * S && RP.RESUME_MS === 20 * S);
t('recover codes = diagnostics RECOVER_CODES, all accepted by the event (no UNKNOWN among them)', J([...RP.CODES].sort()) === J([...DG.RECOVER_CODES].sort()) && RP.CODES.every(c => DG.EVENTS.recover.r.includes(c)) && !RP.CODES.includes('UNKNOWN'));
t('diagnostics: unresponsive / responsive again, a reload after the renderer was gone', J(DG.EVENTS['pane.hang'].r) === J(['HANG', 'RESPONSIVE']) && DG.EVENTS.reload.r.includes('GONE_LOAD'));
t('gone reasons = Electron 44 RenderProcessGoneDetails.reason without clean-exit (all known to diagnostics)', J([...RP.GONE_REASONS, 'clean-exit'].sort()) === J(['abnormal-exit', 'clean-exit', 'crashed', 'integrity-failure', 'killed', 'launch-failed', 'memory-eviction', 'oom'])
  && RP.GONE_REASONS.every(r => DG.goneCode(r) !== 'UNKNOWN'));

// ---- classification ----
{ const k = ev => RP.classify(ev).kind;
  const transient = [-7, -15, -21, -100, -101, -102, -103, -104, -105, -106, -109, -118, -130, -137, -324, -331];
  t('transient main-frame failures (connection / DNS / offline / network changed / timeout ...) may be retried', transient.every(c => k({ type: 'fail', code: c, main: true, web: true }) === 'TRANSIENT' && RP.classify({ type: 'fail', code: c, main: true, web: true }).auto));
  const permanent = [-2, -10, -20, -27, -29, -30, -107, -200, -201, -202, -300, -301, -302, -310, -999];
  t('blocked / certificate / invalid URL / redirects / unknown: permanent, never by itself', permanent.every(c => k({ type: 'fail', code: c, main: true, web: true }) === 'PERMANENT' && !RP.classify({ type: 'fail', code: c, main: true, web: true }).auto));
  t('ERR_ABORTED (-3) is an intended cancel, in the main frame and in a child frame', k({ type: 'fail', code: -3, main: true, web: true }) === 'ABORTED' && k({ type: 'fail', code: -3, main: false, web: true }) === 'ABORTED');
  t('a child frame\'s failure is no failure of the page', [-106, -105, -20, -201].every(c => k({ type: 'fail', code: c, main: false, web: true }) === 'SUBFRAME') && k({ type: 'fail', code: -106 }) === 'SUBFRAME');
  t('not a web page (new tab / about:blank): nothing', k({ type: 'fail', code: -106, main: true, web: false }) === 'NOT_WEB');
  t('no error number: nothing', [0, 1, 200, NaN, '-106', null, undefined, -1.5].every(c => k({ type: 'fail', code: c, main: true, web: true }) === 'NONE'));
  t('a load still going is only slow (never a failure)', k({ type: 'slow' }) === 'SLOW' && k({}) === 'SLOW' && k(null) === 'SLOW' && !RP.classify({ type: 'slow' }).auto);
  t('unresponsive: never a reload; responsive: back', k({ type: 'hang' }) === 'HANG' && !RP.classify({ type: 'hang' }).auto && !RP.classify({ type: 'hang' }).manual && k({ type: 'responsive' }) === 'RESPONSIVE');
  t('renderer gone (crashed / oom / killed / launch / integrity / abnormal / eviction / unknown): manual, never by itself',
    [...RP.GONE_REASONS, undefined, 'x'].every(r => k({ type: 'gone', reason: r }) === 'GONE' && RP.classify({ type: 'gone', reason: r }).manual && !RP.classify({ type: 'gone', reason: r }).auto));
  t('clean-exit is no failure', k({ type: 'gone', reason: 'clean-exit' }) === 'CLEAN_EXIT' && !RP.classify({ type: 'gone', reason: 'clean-exit' }).manual);
  t('pageKey: a bot by its id (query / fragment / slash), other pages without the fragment', RP.samePage(BOT, BOT + '/?x=1#y') && !RP.samePage(BOT, OTHER) && RP.samePage('https://a.example/p#x', 'https://a.example/p/') && !RP.samePage('https://a.example/p', 'https://a.example/q') && !RP.samePage('', '') && !RP.samePage(BOT, '')); }

// ---- a failure -> a planned reload; the 2 / 10 min limit ----
{ let rec = RP.createRec();
  let r = RP.onFail(rec, fail(-106), T0); rec = r.rec;
  t('1st transient failure: planned 15 s later for this entity / generation / URL', r.code === 'SCHEDULED' && r.n === 1 && J(rec.due) === J({ at: T0 + 15 * S, wait: 15 * S, ent: 1, gen: 5, url: BOT }) && rec.fail === 'RETRY');
  t('...shown as a planned reload; the watchdog leaves the pane alone', RP.view(rec).fail === 'retry' && RP.owns(rec));
  t('not due before 15 s, due at 15 s', !RP.isDue(rec, T0 + 15 * S - 1) && RP.isDue(rec, T0 + 15 * S));
  t('check before it is due: nothing', RP.check(rec, seen(), T0 + 14 * S).act === 'none');
  const c = RP.check(rec, seen(), T0 + 15 * S);
  t('due, the same pane / generation / page, nothing going on: go', c.act === 'go' && !c.code);
  rec = RP.took(c.rec, T0 + 15 * S);
  t('took: counted once, the plan used up', RP.count(rec, T0 + 15 * S) === 1 && !rec.due && !RP.owns(rec) && RP.view(rec).fail === '');
  r = RP.onFail(rec, fail(-106, { gen: 6 }), T0 + 16 * S); rec = r.rec;
  t('2nd failure: planned 60 s later (staged)', r.code === 'SCHEDULED' && r.n === 2 && rec.due.at === T0 + 76 * S && rec.due.wait === 60 * S && rec.due.gen === 6);
  rec = RP.took(RP.check(rec, seen({ gen: 6 }), T0 + 76 * S).rec, T0 + 76 * S);
  r = RP.onFail(rec, fail(-106, { gen: 7 }), T0 + 77 * S); rec = r.rec;
  t('3rd failure within 10 min: LIMIT, nothing planned, manual only (shown)', r.code === 'LIMIT' && r.n === 2 && !rec.due && rec.fail === 'MANUAL' && RP.view(rec).fail === 'manual' && RP.owns(rec));
  // boundaries: automatic reloads at T0+15 s and T0+76 s
  const at = ms => RP.onFail(rec, fail(-105, { gen: 8 }), T0 + ms);
  t('just before the 1st leaves the window: still LIMIT', at(15 * S + 10 * MIN - 1).code === 'LIMIT');
  t('exactly 10 min after the 1st: one left -> planned with the 2nd wait (60 s)', at(15 * S + 10 * MIN).code === 'SCHEDULED' && at(15 * S + 10 * MIN).rec.due.wait === 60 * S && at(15 * S + 10 * MIN).n === 2);
  t('10 min after the 2nd too: a fresh start (15 s)', at(76 * S + 10 * MIN).code === 'SCHEDULED' && at(76 * S + 10 * MIN).rec.due.wait === 15 * S && at(76 * S + 10 * MIN).n === 1);
  t('the clock set back: automatic reloads "ahead" still count', RP.count(rec, T0) === 2 && RP.onFail(rec, fail(-106, { gen: 8 }), T0).code === 'LIMIT'); }

// ---- what does not plan anything ----
{ const base = RP.onFail(RP.createRec(), fail(-106), T0).rec;
  for (const [n, ev] of [['ERR_ABORTED', fail(-3)], ['a child frame', fail(-106, { main: false })], ['not a web page', fail(-106, { web: false })], ['no error', fail(0)]]) {
    const r = RP.onFail(base, ev, T0 + S);
    t(`${n}: nothing changes (the plan made before stays)`, r.code === '' && J(r.rec) === J(base));
  }
  const p = RP.onFail(base, fail(-201), T0 + S);
  t('a permanent failure: the plan goes, manual only', p.code === 'PERMANENT' && !p.rec.due && RP.view(p.rec).fail === 'manual');
  t('no entity / generation / URL known: manual only', [{ ent: 0 }, { gen: undefined }, { url: '' }, { ent: 1.5 }].every(o => { const r = RP.onFail(RP.createRec(), fail(-106, o), T0); return r.code === 'PERMANENT' && !r.rec.due; }));
  t('no time: manual only', RP.onFail(RP.createRec(), fail(-106), NaN).code === 'PERMANENT');
  const again = RP.onFail(base, fail(-106, { gen: 9 }), T0 + 5 * S);
  t('a new failure before the plan ran: re-planned for the new generation (still the 1st attempt)', again.code === 'SCHEDULED' && again.rec.due.gen === 9 && again.rec.due.at === T0 + 20 * S && again.n === 1); }

// ---- right before it runs: invalidated / held / waiting ----
{ const rec = RP.onFail(RP.createRec(), fail(-106), T0).rec, now = T0 + 15 * S;
  const drop = (o, code) => { const r = RP.check(rec, seen(o), now); return r.act === 'drop' && r.code === code && !r.rec.due; };
  t('another generation (reload / page / SPA move / renderer loss): dropped', drop({ gen: 6 }, 'CANCELLED'));
  t('another pane entity: dropped', drop({ ent: 2 }, 'CANCELLED'));
  t('another page (URL changed): dropped; the same bot with a query: kept', drop({ url: OTHER }, 'CANCELLED') && drop({ url: 'https://example.com/' }, 'CANCELLED') && RP.check(rec, seen({ url: BOT + '?r=1' }), now).act === 'go');
  t('closed / asleep (never woken by itself) / renderer gone / the user cancelled its load: dropped', ['closed', 'sleeping', 'crashed', 'idle'].every(k => drop({ [k]: true }, 'CANCELLED')));
  t('...and nothing is shown about it afterwards', RP.view(RP.check(rec, seen({ sleeping: true }), now).rec).fail === '');
  t('a broadcast into the pane: dropped, manual only', drop({ busy: true }, 'SKIP_BUSY') && RP.view(RP.check(rec, seen({ busy: true }), now).rec).fail === 'manual');
  t('an IME composition: dropped, manual only', drop({ ime: true }, 'SKIP_DRAFT'));
  t('loading / a load of it queued / a bot-page fix / a manual confirmation: later (the plan stays)', ['loading', 'queued', 'fixing', 'hold'].every(k => { const r = RP.check(rec, seen({ [k]: true }), now); return r.act === 'wait' && !r.code && J(r.rec.due) === J(rec.due); }));
  const wd = RP.took(RP.took(rec, T0 + 2 * S), T0 + 3 * S);       // the watchdog reloaded it twice meanwhile (counts here too, its plan dropped by took)
  t('the watchdog\'s reloads count: no 3rd one', RP.count(wd, now) === 2 && RP.onFail(wd, fail(-106), now).code === 'LIMIT');
  const late = { ...rec, hist: [T0 + S, T0 + 2 * S] };
  t('the limit reached while it waited: dropped (LIMIT)', RP.check(late, seen(), now).code === 'LIMIT' && RP.check(late, seen(), now).act === 'drop');
  t('nothing planned: nothing to check', RP.check(RP.createRec(), seen(), now).act === 'none' && RP.check(undefined, undefined, now).act === 'none');
  t('the clock set back after planning: due at once (at most its wait early), never stuck', RP.isDue(rec, T0 - 5 * MIN) && !RP.isDue(rec, T0 + S) && !RP.isDue(rec, NaN)); }

// ---- the input guard (#11) right before: draft present / unknown, attachment / upload, IME, busy -> manual only ----
{ const rec = RP.onFail(RP.createRec(), fail(-106), T0).rec, now = T0 + 15 * S, st = { ent: 1, gen: 5, rev: 0 };
  const g = (raw, c = {}) => GUARD.autoRefusal(GUARD.read(raw, { page: true, before: st, after: st, at: now, expect: true, ...c }), now);
  const cases = [['typed text', g({ d: 'present', text: true }), 'SKIP_DRAFT'], ['an attachment', g({ d: 'present', att: true }), 'SKIP_DRAFT'], ['an upload', g({ d: 'present', att: true, up: true }), 'SKIP_DRAFT'],
    ['unknown (no reading)', g(null), 'SKIP_DRAFT'], ['an IME composition', g({ d: 'empty' }, { ime: true }), 'SKIP_DRAFT'], ['typed while read', g({ d: 'empty' }, { after: { ...st, rev: 1 } }), 'SKIP_DRAFT'],
    ['a broadcast', g({ d: 'empty' }, { busy: true }), 'SKIP_BUSY'], ['a manual confirmation', g({ d: 'empty' }, { hold: true }), 'SKIP_BUSY']];
  t('the guard refuses every one of them', cases.every(([, code]) => code));
  t('...each drops the plan: manual only, shown', cases.every(([, code, want]) => { const r = RP.skip(rec, code); return r.code === want && !r.rec.due && RP.view(r.rec).fail === 'manual'; }));
  t('an empty composer / an error page without one / no page: the guard lets it go', g({ d: 'empty' }) === '' && GUARD.autoRefusal(GUARD.read({ d: 'none' }, { page: true, before: st, after: st, at: now, expect: false }), now) === ''
    && GUARD.autoRefusal(GUARD.read(null, { page: false, at: now }), now) === ''); }

// ---- renderer gone: manual; the placeholder goes with a live renderer ----
{ const planned = RP.onFail(RP.createRec(), fail(-106), T0).rec;
  const g = RP.onGone(planned, 'crashed');
  t('crashed: GONE_MANUAL, the plan goes, the placeholder shown, nothing for the watchdog', g.code === 'GONE_MANUAL' && !g.rec.due && g.rec.gone === 'CRASHED' && RP.view(g.rec).gone && RP.view(g.rec).fail === '' && !RP.owns(g.rec));
  t('the tick never reloads it (nothing due)', RP.dueList([g.rec], T0 + HOUR()).length === 0);
  t('oom / killed / unknown reason: the same', RP.onGone(planned, 'oom').rec.gone === 'OOM' && RP.onGone(planned, 'killed').code === 'GONE_MANUAL' && RP.onGone(planned, 'x').rec.gone === 'UNKNOWN');
  const c = RP.onGone(planned, 'clean-exit');
  t('clean-exit: nothing changes', c.code === '' && J(c.rec) === J(planned));
  const v = RP.revived(g.rec);
  t('a live renderer again: CLEARED once (a second call: nothing)', v.code === 'CLEARED' && !RP.view(v.rec).gone && RP.revived(v.rec).code === '');
  const hang = RP.onHang(RP.createRec(), true);
  t('unresponsive: shown only, never planned', RP.view(hang).hang && !hang.due && RP.dueList([hang], T0 + HOUR()).length === 0 && !RP.view(RP.onHang(hang, false)).hang);
  t('gone clears unresponsive', !RP.view(RP.onGone(hang, 'crashed').rec).hang); }
function HOUR() { return 60 * MIN; }

// ---- a new page / the user's own load / sleep / close ----
{ const planned = RP.onFail(RP.createRec(), fail(-106), T0).rec, manual = RP.onFail(RP.took(RP.took(RP.createRec(), T0), T0), fail(-106), T0).rec;
  const cm = RP.committed(RP.onHang(planned, true));
  t('a new page committed: the plan / note / unresponsive go (CANCELLED)', cm.code === 'CANCELLED' && !cm.rec.due && cm.rec.fail === '' && !cm.rec.hang && RP.committed(cm.rec).code === '');
  const u = RP.cancel(planned);
  t('the user\'s own load: the plan goes (CANCELLED), a second time nothing', u.code === 'CANCELLED' && !u.rec.due && RP.view(u.rec).fail === '' && RP.cancel(u.rec).code === '');
  t('...a "manual only" note stays until a new page', RP.view(RP.cancel(manual).rec).fail === 'manual' && RP.view(RP.committed(manual).rec).fail === '');
  const z = RP.cancel(RP.onGone(manual, 'crashed').rec, { clear: true });
  t('sleep / close (clear): everything shown goes', z.code === '' && J(RP.view(z.rec)) === J({ gone: false, fail: '', hang: false }) && !RP.owns(z.rec));
  t('dispose twice / odd records: no exception, a fresh record', (() => { try { RP.cancel(RP.cancel(planned, { clear: true }).rec, { clear: true }); RP.cancel(undefined, { clear: true }); RP.cancel(null); RP.cancel('x'); return J(RP.cancel(42).rec) === J(RP.createRec()); } catch { return false; } })());
  t('every function takes a missing record', (() => { try { return [RP.count(undefined, T0), RP.onFail(undefined, fail(-106), T0).code, RP.onGone(undefined, 'crashed').code, RP.onHang(undefined, true).hang, RP.committed(undefined).code, RP.revived(undefined).code,
    RP.took(undefined, T0).hist.length, RP.isDue(undefined, T0), RP.skip(undefined, 'PRESENT').code, RP.view(undefined).gone, RP.owns(undefined)].join() === '0,SCHEDULED,GONE_MANUAL,true,,,1,false,SKIP_DRAFT,false,false'; } catch { return false; } })());
  t('took keeps the last HIST_MAX times only', RP.took({ hist: Array.from({ length: 30 }, (_, i) => T0 + i) }, T0 + 30).hist.length === RP.HIST_MAX); }

// ---- the tick: the due ones first-due first; at most one goes (main) ----
{ const a = RP.onFail(RP.createRec(), fail(-106), T0).rec, b = RP.onFail(RP.createRec(), fail(-106), T0 - 10 * S).rec, c = RP.onFail(RP.createRec(), fail(-106), T0 + 10 * S).rec;   // due T0+15 / T0+5 / T0+25 s
  t('dueList: only due ones, the one due first first', J(RP.dueList([a, b, c, RP.createRec(), undefined], T0 + 15 * S)) === J([1, 0]) && J(RP.dueList([a, c], T0 + 10 * S)) === J([]) && J(RP.dueList('x', T0)) === J([]));
  t('equal times: in pane order', J(RP.dueList([a, a, a], T0 + 15 * S)) === J([0, 1, 2])); }

// ---- a pane through random events: never more than 2 automatic reloads in any 10 min, none while asleep / after close ----
{ let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let worst = 0, bad2 = 0;
  for (let run = 0; run < 200; run++) {
    let rec = RP.createRec(), now = T0, gen = 1, asleep = false, closed = false; const reloads = [];
    for (let step = 0; step < 300; step++) {
      now += Math.floor(rnd() * 20 * S);
      const x = rnd();
      if (x < 0.35) rec = RP.onFail(rec, fail([-106, -105, -3, -201, -7][Math.floor(rnd() * 5)], { gen, main: rnd() < 0.9 }), now).rec;
      else if (x < 0.40) { gen++; rec = RP.committed(rec).rec; }
      else if (x < 0.43) { asleep = !asleep; if (asleep) rec = RP.cancel(rec, { clear: true }).rec; }
      else if (x < 0.45) { gen++; rec = RP.cancel(rec).rec; }                                     // the user's own reload
      else if (x < 0.46) { closed = true; rec = RP.cancel(rec, { clear: true }).rec; }
      else if (x < 0.48) rec = RP.onGone(rec, 'crashed').rec;
      const r = RP.check(rec, seen({ gen, sleeping: asleep, closed, loading: rnd() < 0.1 }), now); rec = r.rec;
      if (r.act === 'go') { if (asleep || closed) bad2++; rec = RP.took(rec, now); reloads.push(now); gen++; }
    }
    for (let i = 0; i < reloads.length; i++) worst = Math.max(worst, reloads.filter(x => x >= reloads[i] && x - reloads[i] < 10 * MIN).length);
  }
  t(`random runs: at most ${worst} automatic reloads in any 10 min (limit 2)`, worst <= 2 && worst > 0);
  t('random runs: none while asleep / after close', bad2 === 0); }

// ---- main's wiring (contract with src/main.js) ----
{ const main = read('main.js');
  const fn = name => { const i = main.indexOf(`function ${name}(`); if (i < 0) return ''; let d = 0, j = main.indexOf('{', main.indexOf(')', i)); for (; j < main.length; j++) { if (main[j] === '{') d++; else if (main[j] === '}' && --d === 0) break; } return main.slice(i, j + 1); };
  const at = (s, x) => s.indexOf(x);
  const tick = main.slice(at(main, "const RP = require('./recovery-policy');"), at(main, '}, RP.TICK_MS);'));
  t('main: one tick for all windows, nothing while quitting / the Mac sleeps or is locked / just woke, one reload per tick', /if \(quitting \|\| sysBlocked \|\| Date\.now\(\) - resumeAt < RP\.RESUME_MS\) return;/.test(tick) && /if \(c\.recoverNext\(\)\) break;/.test(tick));
  const nx = fn('recoverNext'), go = fn('recoverGo'), st = fn('recoverStep'), rf = fn('recoverFail'), rg = fn('recoverGone'), ds = fn('disposePane');
  t('main: the tick takes the due ones first-due first and starts one', /RP\.dueList\(panes\.map\(q => q\.rcv\), Date\.now\(\)\)/.test(nx) && /recoverGo\(p\); return true;/.test(nx) && /p\.recChecking \|\| !recoverStep\(p\)/.test(nx));
  t('main: no timer per pane (nothing to leak)', ![nx, go, st, rf, rg, fn('recoverCancel'), fn('recoverLive'), fn('recoverPage'), fn('recoverHang')].some(f => /setTimeout|setInterval/.test(f)));
  t('main: read live, the guard, checked again, counted, then the usual reload through the queue (BULK)', at(go, 'await liveInput(p)') > 0 && at(go, 'await liveInput(p)') < at(go, "autoGate(p, g, 'recover')")
    && at(go, "autoGate(p, g, 'recover')") < at(go, 'if (!recoverStep(p)) return;') && at(go, 'if (!recoverStep(p)) return;') < at(go, 'RP.took(') && at(go, 'RP.took(') < at(go, "reloadPane(p, 'BULK')") && /RP\.skip\(p\.rcv, GUARD\.autoRefusal\(g, Date\.now\(\)\)\)/.test(go));
  t('main: the check sees entity / generation / URL / closed / asleep / gone / cancelled / busy / IME / confirmation / loading / queued / fixing',
    ['ent: p.obs.ent', 'gen: p.obs.gen', 'url: paneUrl(p)', 'closed:', 'sleeping: !!p.sleeping', 'crashed:', 'idle: !!p.loadIdle', 'busy: !!p.broadcasting', 'ime: !!p.ime', 'hold: !!p.guardHold', 'loading:', 'queued: !!lqView(p, false)', 'fixing: !!(p.grokToken || p.grokPending)'].every(k => main.includes(k)));
  t('main: did-fail-load -> recoverFail; only a main-frame web failure; the error page is a new generation before the plan', /recoverFail\(p, code, url, isMain\); \}\);/.test(main) && /if \(p\.disposed \|\| p\.sleeping \|\| !p\.rcv\) return;/.test(rf)
    && /if \(k !== 'TRANSIENT' && k !== 'PERMANENT'\) return;/.test(rf) && at(rf, "newGen(p, 'FAIL')") > 0 && at(rf, "newGen(p, 'FAIL')") < at(rf, 'RP.onFail('));
  t('main: renderer gone -> manual only (no reload / load from it), the view hidden behind the placeholder', /recoverGone\(p, d && d\.reason\); \}\);/.test(main) && !/reloadPane|appLoad|loadURL|\.reload\(/.test(rg) && /showViews\(\);/.test(rg) && /p\.grokToken = null; p\.grokPending = null;/.test(rg)
    && /RP\.view\(p\.rcv\)\.gone\);$/m.test(main.split('\n').find(l => l.startsWith('const viewHeld')) || ''));
  t('main: unresponsive / responsive only note it', /wc\.on\('unresponsive', \(\) => \{ diag\.rec\('pane\.hang', 'HANG', \{ p: p\.id \}\); dlog\(`pane\$\{p\.id\}`, 'unresponsive'\); recoverHang\(p, true\); \}\);/.test(main)
    && /wc\.on\('responsive', \(\) => \{ diag\.rec\('pane\.hang', 'RESPONSIVE', \{ p: p\.id \}\); dlog\(`pane\$\{p\.id\}`, 'responsive'\); recoverHang\(p, false\); \}\);/.test(main) && !/reload|Load/.test(fn('recoverHang')));
  t('main: a new page drops the plan; a live renderer clears the placeholder', /wc\.on\('did-navigate', \(\) => recoverPage\(p\)\);/.test(main) && /recoverLive\(p\);\n\s+onGrokLoad\(p\);/.test(main) && /wc\.isCrashed\(\)\) return;/.test(fn('recoverLive')));
  t('main: the user\'s own load / reload-all / sleep cancel the plan', /if \(cls === 'USER'\) recoverCancel\(p\);/.test(fn('viewLoad')) && /recoverCancel\(p\); reloadPane\(p, 'BULK'\)/.test(fn('reloadAll')) && /recoverCancel\(p, true\);/.test(fn('sleepPane')));
  t('main: the user\'s auto-reload setting leaves a stopped page alone; the watchdog leaves stopped / failed pages to this and counts its reloads here',
    /if \(p\.disposed \|\| RP\.view\(p\.rcv\)\.gone\) continue;/.test(main) && /if \(wc\.isCrashed\(\) \|\| RP\.view\(p\.rcv\)\.gone \|\| RP\.owns\(p\.rcv\)\) continue;/.test(main)
    && /p\.rcv = RP\.took\(p\.rcv, p\.wdAt\);[^\n]*\n[^\n]*'watchdog: blank bot pane -> reload'/.test(main));
  t('main: a reload after the renderer was gone is a fresh load (new renderer), not the router hop', /if \(wc\.isCrashed\(\) \|\| RP\.view\(p\.rcv\)\.gone\) \{[^\n]*diag\.rec\('reload', 'GONE_LOAD'[^\n]*appLoad\(wc, target\); return; \}/.test(fn('reloadPane'))
    && at(fn('reloadPane'), "'GONE_LOAD'") < at(fn('reloadPane'), 'const token = p.grokToken = Symbol()'));
  t('main: disposePane once per view: idempotent, page / check / loads / plan end, then the view leaves and its WebContents is closed', /if \(!p \|\| p\.disposed\) return false;/.test(ds) && at(ds, 'p.disposed = true') < at(ds, 'unregWc(')
    && at(ds, 'recoverCancel(p, true)') > 0 && at(ds, 'unregWc(') < at(ds, "obsDo(p, { type: 'close' })") && at(ds, 'abortProbe(p)') < at(ds, 'lqDrop(p, code)') && at(ds, 'lqDrop(p, code)') < at(ds, 'removeChildView(p.view)') && at(ds, 'removeChildView(p.view)') < at(ds, 'wc.close()')
    && /try \{ if \(!win\.isDestroyed\(\)\) win\.contentView\.removeChildView\(p\.view\); \} catch \{\}/.test(ds) && /try \{ if \(!wc\.isDestroyed\(\)\) wc\.close\(\); \} catch \{\}/.test(ds));
  t('main: closePane / a closed window go through it (no second close path)', /disposePane\(p, 'CLOSED'\);/.test(fn('closePane')) && !/webContents\.close\(\)|removeChildView/.test(fn('closePane'))
    && /win\.on\('closed', \(\) => \{\n  unregWc\(r => r\.ctx === ctx\);[^\n]*\n  if \(!quitting\) panes\.forEach\(p => disposePane\(p, 'WINDOW'\)\);/.test(main));
  t('main: the 承認Bot popup with a gone renderer is made anew when opened', /if \(approve && !approve\.webContents\.isDestroyed\(\) && approve\.webContents\.isCrashed\(\)\) destroyApprove\(\);/.test(fn('openApprove')) && at(fn('openApprove'), 'destroyApprove()') < at(fn('openApprove'), 'const had'));
  t('main: the screen gets gone / fail / hang', /gone: rv\.gone, fail: rv\.fail, hang: rv\.hang,/.test(fn('sendState')) && /rv = RP\.view\(p\.rcv\)/.test(fn('sendState')));
  t('main: every recover diagnostic is a fixed code + pane number + count (no URL)', [...main.matchAll(/diag\.rec\('recover', ([^,)]+)/g)].every(m => /^'[A-Z_]+'$|^r\.code$/.test(m[1].trim())) && [...main.matchAll(/diag\.rec\('recover', '([A-Z_]+)'/g)].every(m => RP.CODES.includes(m[1])));
  t('main: no URL in what the recovery writes to the debug log', ![rf, rg, go, fn('recoverLive'), fn('recoverPage')].some(f => /dlog\([^\n]*(url|paneUrl|getURL|target)/.test(f)));
  t('main: dev hook only with MPB_RECOVERY_DEBUG, synthetic events into the same handlers; no renderer is ever crashed', /^const RECOVERY_DEBUG = !!process\.env\.MPB_RECOVERY_DEBUG;$/m.test(main) && /if \(RECOVERY_DEBUG\) items\.push\(\{ type: 'separator' \}, \.\.\.recoverDebugItems\(p\)\);/.test(main)
    && !/forcefullyCrashRenderer|process\.crash\(|\.crash\(\)/.test(main)); }

// ---- the UI: placeholder + 再読み込み (the existing reload IPC) ----
{ const r = read('renderer.js'), css = read('style.css'), pre = read('preload.js');
  t('renderer: the stopped placeholder says so, has 再読み込み, waiting / reloading lines, and that a draft may not come back', /<div class="goneph"><span class="gp1">⚠ ページが停止しました<\/span><button class="pbx gpr"[^>]*>再読み込み<\/button>/.test(r) && /入力途中の文字・添付は戻らないことがあります/.test(r)
    && /<span class="gp2">⏳ 読み込み待ち<b class="lpn"><\/b><button class="lqx"/.test(r) && /<span class="gp3">再読み込み中…<\/span>/.test(r));
  t('renderer: 再読み込み is the pane\'s usual reload (guard + queue in main), nothing else', /d\.querySelector\('\.gpr'\)\.onclick = e => \{ e\.stopPropagation\(\); mpb\.reload\(id\); \};/.test(r) && /d\.classList\.toggle\('gone', !!p\.gone\);/.test(r));
  t('renderer: a failed load / unresponsive page: a header note', /if \(p\.fail === 'retry'\) meta\.push\(/.test(r) && /else if \(p\.fail === 'manual'\) meta\.push\(/.test(r) && /if \(p\.hang\) meta\.push\(/.test(r));
  t('style: shown only while gone; the load placeholder hidden then; button / waiting / reloading exclusive', /\.pane \.goneph\{display:none;/.test(css) && /\.pane\.gone \.goneph\{display:flex\}/.test(css) && /\.pane\.gone \.loadph\{display:none\}/.test(css)
    && /\.pane\.gone\.lqwait \.goneph \.gpr,\.pane\.gone\.loading \.goneph \.gpr\{display:none\}/.test(css));
  t('preload / IPC: no new channel; reload stays a chrome channel for one pane of its window', /reload: id => send\('reload', id\)/.test(pre) && !/recover(?!y)|crash|gone/i.test(pre) && J(IPC.CHANNELS.reload.roles) === '["chrome"]' && typeof IPC.CHANNELS.reload.target === 'function'
    && !Object.keys(IPC.CHANNELS).some(k => /crash|gone|^recover(-|$)/i.test(k))); }   // (recovery-open is the panes.json recovery screen, not this)

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
