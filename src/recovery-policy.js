// Limited recovery (#32) (unit-tested in test/recovery-policy.test.js): which page failures may be recovered automatically, when, and how
// often. Pure: every event, time and main's view of the pane come in as arguments; main.js owns the views, the timer tick, the input guard (#11),
// the queue (#31) and every side effect.
//   did-fail-load: a failed main-frame load is transient (connection / DNS / offline / network changed / timed out ...) or permanent (blocked,
//     certificate, bad URL ... and anything unknown). ERR_ABORTED is an intended cancel (another load / stop / URL change), a child frame's
//     failure and a load that is only slow are no failure of the page.
//   unresponsive: the page may only be slow - noted (until responsive), never a reason to reload.
//   render-process-gone: the page is gone (crashed / killed / oom ...): manual recovery only (the pane says so; a draft may not come back).
//     clean-exit is not a failure.
// Only a transient main-frame failure of the pane's current entity / generation is retried automatically: MAX_AUTO reloads in WINDOW_MS per pane
// (the blank-page watchdog's reloads count too), the first after WAITS[0], the second after WAITS[1]; beyond that manual only. A reservation is
// dropped when the pane is closed / asleep / moved to another page or generation / the user loads it, and is checked again right before it runs.
const WINDOW_MS = 10 * 60000;            // at most MAX_AUTO automatic reloads of one pane in this long
const MAX_AUTO = 2;
const WAITS = [15000, 60000];            // the wait before the 1st / 2nd automatic reload
const TICK_MS = 5000;                    // main checks the reservations this often; at most one reload starts per tick (all windows)
const RESUME_MS = 20000;                 // none right after the Mac woke / was unlocked (then the overdue ones go one per tick)
const HIST_MAX = 10;                     // automatic reloads remembered per pane (the watchdog may add more than MAX_AUTO)
// Chromium net errors (net_error_list.h) a retry may cure: timed out, socket not connected, network changed, connection closed / reset / refused /
// aborted / failed, name not resolved, internet disconnected, address unreachable, connection timed out, proxy connection failed, name resolution
// failed, empty response, network IO suspended (sleep)
const TRANSIENT = [-7, -15, -21, -100, -101, -102, -103, -104, -105, -106, -109, -118, -130, -137, -324, -331];
const ABORTED = -3;
// what an event is (classify): only TRANSIENT may be retried by itself; GONE is manual recovery
const KINDS = ['TRANSIENT', 'PERMANENT', 'ABORTED', 'SUBFRAME', 'NOT_WEB', 'NONE', 'GONE', 'CLEAN_EXIT', 'HANG', 'RESPONSIVE', 'SLOW'];
// diagnostics (recover): a reservation made (n = which attempt) / its reload started (n = automatic reloads in the window), no more automatic
// reloads (n), a permanent failure, dropped for input / a busy pane, dropped because the pane moved on (closed / asleep / another page or
// generation / the user's own load), the renderer gone (manual), its placeholder cleared by a new page
const CODES = ['SCHEDULED', 'RETRY', 'LIMIT', 'PERMANENT', 'SKIP_DRAFT', 'SKIP_BUSY', 'CANCELLED', 'GONE_MANUAL', 'CLEARED'];
const GONE_REASONS = ['abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'];

const isNo = v => Number.isSafeInteger(v) && v > 0;
const isTime = v => typeof v === 'number' && Number.isFinite(v);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
// a pane's record: automatic reload times, the reservation { at, wait, ent, gen, url }, the failure note ('' / RETRY / MANUAL), the renderer gone
// (reason code) and unresponsive. Memory only (never saved)
const createRec = () => ({ hist: [], due: null, fail: '', gone: '', hang: false });
const norm = r => isObj(r) ? { hist: Array.isArray(r.hist) ? r.hist.filter(isTime) : [], due: isObj(r.due) ? r.due : null, fail: r.fail === 'RETRY' || r.fail === 'MANUAL' ? r.fail : '',
  gone: typeof r.gone === 'string' ? r.gone : '', hang: r.hang === true } : createRec();
// the same page for a reservation: a grok.com bot by its id, anything else by its URL without the fragment / a trailing slash
const pageKey = u => { const s = String(u || ''), m = /^https:\/\/grok\.com\/bot\/([A-Za-z0-9_-]+)/.exec(s); return m ? 'bot:' + m[1] : s.split('#')[0].replace(/\/$/, ''); };
const samePage = (a, b) => !!a && !!b && pageKey(a) === pageKey(b);

// ev: { type: 'fail', code, main, web } (did-fail-load: errorCode, isMainFrame, validatedURL is http(s)) | { type: 'gone', reason } |
// { type: 'hang' } | { type: 'responsive' } | { type: 'slow' } (still loading) -> { kind, auto: may be retried by itself, manual: the pane says
// it stopped and waits for the user }
function classify(ev) {
  const r = kind => ({ kind, auto: kind === 'TRANSIENT', manual: kind === 'GONE' });
  const t = isObj(ev) ? ev.type : '';
  if (t === 'gone') return r(ev.reason === 'clean-exit' ? 'CLEAN_EXIT' : 'GONE');          // any other / unknown reason: the page is gone
  if (t === 'hang') return r('HANG');
  if (t === 'responsive') return r('RESPONSIVE');
  if (t !== 'fail') return r('SLOW');                                                          // a load still going is never a failure
  if (!Number.isSafeInteger(ev.code) || ev.code >= 0) return r('NONE');
  if (ev.code === ABORTED) return r('ABORTED');
  if (ev.main !== true) return r('SUBFRAME');
  if (ev.web !== true) return r('NOT_WEB');                                                   // the local new-tab page, about:blank ...
  return r(TRANSIENT.includes(ev.code) ? 'TRANSIENT' : 'PERMANENT');
}

// automatic reloads in the last WINDOW_MS (a time ahead of now counts: the clock was set back)
const count = (rec, now) => norm(rec).hist.filter(t => now - t < WINDOW_MS).length;
// a failed load. ev: { code, main, web, ent, gen, url } (the pane's entity / generation after the failure, the URL that failed)
// -> { rec, code: '' (nothing changes) / SCHEDULED / LIMIT / PERMANENT, kind, n }
function onFail(rec, ev, now) {
  const c = classify({ type: 'fail', ...(isObj(ev) ? ev : {}) }), r = norm(rec);
  if (c.kind !== 'TRANSIENT' && c.kind !== 'PERMANENT') return { rec: r, code: '', kind: c.kind, n: 0 };
  const base = { ...r, due: null };
  if (c.kind === 'PERMANENT' || !isTime(now) || !isNo(ev.ent) || !isNo(ev.gen) || !ev.url) return { rec: { ...base, fail: 'MANUAL' }, code: 'PERMANENT', kind: c.kind, n: 0 };
  const n = count(r, now);
  if (n >= MAX_AUTO) return { rec: { ...base, fail: 'MANUAL' }, code: 'LIMIT', kind: c.kind, n };
  const wait = WAITS[n];
  return { rec: { ...base, fail: 'RETRY', due: { at: now + wait, wait, ent: ev.ent, gen: ev.gen, url: String(ev.url) } }, code: 'SCHEDULED', kind: c.kind, n: n + 1 };
}
// the renderer is gone -> { rec, code: GONE_MANUAL (the reason code is kept for the pane) / '' (clean exit: nothing changes) }
function onGone(rec, reason) {
  const r = norm(rec);
  if (classify({ type: 'gone', reason }).kind === 'CLEAN_EXIT') return { rec: r, code: '' };
  const g = GONE_REASONS.includes(reason) ? reason.toUpperCase().replace(/-/g, '_') : 'UNKNOWN';
  return { rec: { ...r, due: null, fail: '', gone: g, hang: false }, code: 'GONE_MANUAL' };
}
const onHang = (rec, on) => ({ ...norm(rec), hang: on === true });
// a new page was committed (not an error page): the reservation / note / unresponsive go -> { rec, code: CANCELLED (a reservation dropped) / '' }
function committed(rec) { const r = norm(rec); return { rec: { ...r, due: null, fail: '', hang: false }, code: r.due ? 'CANCELLED' : '' }; }
// the pane has a live renderer again (any new page, an error page too): the 'stopped' placeholder goes -> { rec, code: CLEARED / '' }
function revived(rec) { const r = norm(rec); return { rec: { ...r, gone: '' }, code: r.gone ? 'CLEARED' : '' }; }
// the user's own load / sleep / close: the reservation goes; clear (sleep / close): everything shown goes too -> { rec, code: CANCELLED / '' }
function cancel(rec, { clear = false } = {}) {
  const r = norm(rec), out = { ...r, due: null, fail: r.fail === 'RETRY' ? '' : r.fail };
  if (clear) Object.assign(out, { fail: '', gone: '', hang: false });
  return { rec: out, code: r.due ? 'CANCELLED' : '' };
}
// an automatic reload starts now (a reservation's, or the watchdog's): counted, the reservation used up
function took(rec, now) {
  const r = norm(rec), hist = [...r.hist.filter(t => now - t < WINDOW_MS), ...(isTime(now) ? [now] : [])].slice(-HIST_MAX);
  return { ...r, hist, due: null, fail: '' };
}
// due now? Also when the time left is longer than its whole wait (the clock was set back): at most that wait early, never stuck
const isDue = (rec, now) => { const d = norm(rec).due; return !!d && isTime(now) && (now >= d.at || d.at - now > d.wait); };
// recs: the panes' records -> the indexes of the due ones, the one due first first (main starts at most one of them per tick)
function dueList(recs, now) {
  return (Array.isArray(recs) ? recs : []).map((r, i) => [i, isDue(r, now) ? norm(r).due.at : NaN]).filter(([, at]) => !Number.isNaN(at)).sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([i]) => i);
}
// right before a due reservation runs. s: main's view of the pane now { ent, gen, url (the page it would load), closed, sleeping, crashed, idle
// (its load was cancelled by the user), busy (a broadcast into it), ime, hold (a manual confirmation of it in progress), loading, queued (a load
// of it waits / runs), fixing (a bot-page fix runs) } -> { rec, act: none / wait (later, the reservation stays) / drop / go, code }
function check(rec, s, now) {
  const r = norm(rec), d = r.due, v = isObj(s) ? s : {};
  if (!d || !isDue(r, now)) return { rec: r, act: 'none', code: '' };
  const drop = (code, fail) => ({ rec: { ...r, due: null, fail }, act: 'drop', code });
  if (v.closed || v.sleeping || v.crashed || v.idle || v.ent !== d.ent || v.gen !== d.gen || !samePage(d.url, v.url)) return drop('CANCELLED', '');
  if (v.busy) return drop('SKIP_BUSY', 'MANUAL');
  if (v.ime) return drop('SKIP_DRAFT', 'MANUAL');
  if (count(r, now) >= MAX_AUTO) return drop('LIMIT', 'MANUAL');
  if (v.hold || v.loading || v.queued || v.fixing) return { rec: r, act: 'wait', code: '' };
  return { rec: r, act: 'go', code: '' };
}
// the input guard refused the reload (draft-guard.js autoRefusal code) -> the reservation goes, manual only: { rec, code: SKIP_BUSY / SKIP_DRAFT }
function skip(rec, guardCode) { const r = norm(rec); return { rec: { ...r, due: null, fail: 'MANUAL' }, code: guardCode === 'BUSY' ? 'SKIP_BUSY' : 'SKIP_DRAFT' }; }
// what the pane shows: the 'stopped' placeholder, a failed load (retry: a reload is planned / manual: none will be), unresponsive
function view(rec) { const r = norm(rec); return { gone: !!r.gone, fail: r.due ? 'retry' : r.fail === 'MANUAL' ? 'manual' : '', hang: r.hang }; }
// a failed load of this pane is handled here (planned, or manual only): the blank-page watchdog leaves the pane alone
const owns = rec => { const r = norm(rec); return !!(r.due || r.fail); };

module.exports = { WINDOW_MS, MAX_AUTO, WAITS, TICK_MS, RESUME_MS, HIST_MAX, TRANSIENT, ABORTED, KINDS, CODES, GONE_REASONS,
  createRec, pageKey, samePage, classify, count, onFail, onGone, onHang, committed, revived, cancel, took, isDue, dueList, check, skip, view, owns };
