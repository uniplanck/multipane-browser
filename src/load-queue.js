// Shared load queue (#31) (unit-tested in test/load-queue.test.js). Pure: no electron, no timers; the clock, the id counter, the order within a
// class and what a task does come in as arguments. main.js owns the views, the background-check windows and every side effect, and tells the queue
// when a load has settled or - after a cancel - when it has really stopped (load stopped / view gone / check window destroyed).
// Every load main starts goes through it: at most LIMIT running at once in all windows, at most PROBE_LIMIT of them background checks. A waiting
// task starts by class (USER: the user's own wake / reload / URL / new pane > BULK: startup / workspace / reload-all / automatic reloads > BG:
// background checks), then by main's rank (the focused pane first), then in request order. A user's task waiting for a full queue stops a running
// background check (it is checked again later); a load of a pane on screen is never stopped for another one.
// One task per pane resource (its view / its background check), keyed by pane entity + generation + purpose (#02 numbers):
//   the same key again                   -> merged into the existing task (a waiting one takes the higher class)
//   waiting, another load of the same page (same generation, not another URL) -> merged too
//   waiting, another URL (NAV) / a newer generation -> replaces it
//   running                              -> takes over its slot at once (the new load replaces the old one in the same view: no extra slot)
// A slot is given back only by finish() (or the start's promise settling): when the load has settled, or - cancelled - once main has confirmed
// the real stop. A cancel never frees a running task's slot by itself; a start that throws frees it at once (nothing began), a stop that throws
// keeps it (main's own check ends it). A late finish of a task that already ended or was replaced changes nothing.
const CLASSES = ['USER', 'BULK', 'BG'];
const LIMIT = 2, PROBE_LIMIT = 1;
const SETTLE_MS = 1500;          // a load counts as settled after this long with nothing loading and no bot-page fix running
const CAP_MS = 25000;            // ...or after this long when only a bot-page fix is still polling (the fix goes on, the slot goes back)
const HARD_MS = 60000;           // still loading after this long: main stops the load (the slot goes back once it has stopped)
// fixed codes (diagnostics load.queue): queued without a free slot / merged into an existing task / replaced by a newer one / a background check
// stopped for the user's load; how a task ended: settled / released at the cap / stopped after a cancel / view gone / the input check refused it /
// error; why it was cancelled: 取消 / pane closed / another URL / window closed / background check aborted (wake / reload-all / close)
const CODES = ['WAIT', 'MERGED', 'SUPERSEDED', 'PREEMPT', 'DONE', 'CAP', 'STOPPED', 'GONE', 'GUARD', 'ERROR', 'USER', 'CLOSED', 'URL', 'WINDOW', 'ABORT'];
const END_CODES = ['DONE', 'CAP', 'GONE', 'GUARD', 'ERROR'];
const clsRank = c => { const i = CLASSES.indexOf(c); return i < 0 ? CLASSES.length : i; };
const better = (a, b) => clsRank(a) <= clsRank(b) ? a : b;

// a running load of a pane's view -> '' (still busy) / DONE / CAP / STOP (main stops it; the next check gives the slot back).
// t0: when it started; quiet: the last time the page started / stopped loading or a fix finished; loading: the view is loading; fixing: a bot-page
// fix (router hop / retries) is running
function settle({ now, t0, quiet = 0, loading = false, fixing = false } = {}) {
  if (![now, t0].every(Number.isFinite)) return '';
  const ms = now - t0;
  if (loading) return ms >= HARD_MS ? 'STOP' : '';
  if (fixing) return ms >= CAP_MS ? 'CAP' : '';
  return now - Math.max(t0, Number.isFinite(quiet) ? quiet : 0) >= SETTLE_MS ? 'DONE' : '';
}

// onChange({ type: 'wait' | 'merge' | 'start' | 'stop' | 'end', t, code }) after every change (never throws into the queue)
function createLoadQueue({ limit = LIMIT, probeLimit = PROBE_LIMIT, now = Date.now, nextId = null, rank = () => 0, preempt = true, onChange = () => {} } = {}) {
  const tasks = [];                                          // wait / run / stop, in request order
  let seq = 0, ids = 0, batching = 0, batchNew = [], pumping = false, again = false, fresh = null;
  const newId = typeof nextId === 'function' ? nextId : () => ++ids;
  const notify = (type, t, code = '') => { try { onChange({ type, t, code }); } catch {} };
  const rk = t => { let r; try { r = Number(rank(t)); } catch { r = 0; } return Number.isFinite(r) ? r : 0; };
  const used = () => tasks.filter(t => t.state !== 'wait').length;
  const probes = () => tasks.filter(t => t.state !== 'wait' && t.probe).length;
  const canStart = t => used() < limit && (!t.probe || probes() < probeLimit);
  const order = () => tasks.filter(t => t.state === 'wait').map(t => ({ t, c: clsRank(t.cls), r: rk(t) }))
    .sort((a, b) => a.c - b.c || a.r - b.r || a.t.seq - b.t.seq).map(x => x.t);

  function end(t, code) {
    const i = tasks.indexOf(t); if (i >= 0) tasks.splice(i, 1);
    t.state = 'end'; t.endCode = code; t.endAt = now();
    try { if (t.onEnd) t.onEnd(t, code); } catch {}
    notify('end', t, code);
  }
  function begin(t) {
    t.state = 'run'; t.startAt = now(); t.waited = !(fresh && fresh.has(t));
    notify('start', t);
    let r;
    try { r = t.onStart(t); } catch { if (t.state === 'run' || t.state === 'stop') end(t, 'ERROR'); return; }   // nothing began: the slot goes back at once
    if (r && typeof r.then === 'function') r.then(code => finish(t.id, code), () => finish(t.id, 'ERROR'));
  }
  function stop(t, code) {
    t.state = 'stop'; t.code = code; t.stopAt = now();
    notify('stop', t, code);
    try { if (t.onStop) t.onStop(t, code); } catch {}       // a stop that throws: the slot stays held until main's own check ends the task
  }
  function pump() {
    if (batching) return;
    if (pumping) { again = true; return; }
    pumping = true;
    try {
      do {
        again = false;
        const w = order(), next = w.find(canStart);
        if (next) { begin(next); again = true; continue; }
        if (preempt && w.length && w[0].cls === 'USER' && used() >= limit) {   // the user's load never waits for a background check
          const bg = tasks.find(t => t.state === 'run' && t.probe && t.cls === 'BG');
          if (bg) stop(bg, 'PREEMPT');
        }
      } while (again);
    } finally { pumping = false; }
  }
  // spec: { ent (pane entity), gen, purpose, cls, probe, win, url (expected), data (main's own), onStart(t) [-> promise], onStop(t, code), onEnd(t, code) }
  function request(spec) {
    const s = spec || {};
    if (s.ent == null || typeof s.onStart !== 'function') throw new TypeError('load-queue: ent and onStart are required');
    const t = { id: newId(), ent: s.ent, gen: Number.isFinite(s.gen) ? s.gen : 0, purpose: String(s.purpose || 'LOAD'), cls: CLASSES.includes(s.cls) ? s.cls : 'BULK',
      probe: !!s.probe, win: s.win ?? null, url: String(s.url || ''), data: s.data, state: 'wait', seq: ++seq, at: now(), startAt: 0, waited: false, code: '',
      onStart: s.onStart, onStop: s.onStop, onEnd: s.onEnd };
    const same = tasks.find(x => x.ent === t.ent && x.probe === t.probe && x.state !== 'stop');
    if (same) {
      const merge = t.probe || (same.gen === t.gen && (same.purpose === t.purpose || (same.state === 'wait' && t.purpose !== 'NAV')));
      if (merge) {
        if (same.state === 'wait') same.cls = better(same.cls, t.cls);
        notify('merge', same, 'MERGED'); pump();
        return { task: same, merged: true };
      }
      if (same.state === 'run') {                            // take over the running slot: the new load replaces the old one in the same view
        tasks.push(t); t.state = 'run';                       // reserved before the old one ends, so nothing else can take the slot in between
        end(same, 'SUPERSEDED');
        const prev = fresh; fresh = new Set([t]);
        try { begin(t); } finally { fresh = prev; }
        pump();
        return { task: t, merged: false };
      }
      t.cls = better(t.cls, same.cls); end(same, 'SUPERSEDED');   // waiting: replaced (another URL / a newer generation), keeping the higher class
    }
    tasks.push(t);
    if (batching) { batchNew.push(t); return { task: t, merged: false }; }
    const prev = fresh; fresh = new Set([t]);
    try { pump(); } finally { fresh = prev; }
    if (t.state === 'wait') notify('wait', t, 'WAIT');
    return { task: t, merged: false };
  }
  // several requests at once (startup / workspace / reload-all): nothing starts until all are in, so main's rank (the focused pane) decides
  function batch(fn) {
    batching++;
    try { fn(); } finally {
      if (--batching === 0) {
        const list = batchNew; batchNew = [];
        const prev = fresh; fresh = new Set(list);
        try { pump(); } finally { fresh = prev; }
        list.forEach(t => { if (t.state === 'wait') notify('wait', t, 'WAIT'); });
      }
    }
  }
  // sel: a task id or a predicate. Waiting -> ended at once (code); running -> onStop, its slot held until finish(); stopping -> unchanged
  function cancel(sel, code = 'USER') {
    const hit = tasks.filter(typeof sel === 'function' ? (t => { try { return !!sel(t); } catch { return false; } }) : (t => t.id === sel));
    for (const t of hit) { if (t.state === 'wait') end(t, code); else if (t.state === 'run') stop(t, code); }
    pump();
    return hit.length;
  }
  // a running / stopping task is over: its slot goes back. A stopped one ends as STOPPED whatever the code. -> false for a task that already ended
  function finish(id, code = 'DONE') {
    const t = tasks.find(x => x.id === id && x.state !== 'wait');
    if (!t) return false;
    end(t, t.state === 'stop' ? 'STOPPED' : END_CODES.includes(code) ? code : 'DONE');
    pump();
    return true;
  }
  const find = pred => tasks.find(t => { try { return !!pred(t); } catch { return false; } }) || null;
  const position = id => { const i = order().findIndex(t => t.id === id); return i < 0 ? 0 : i + 1; };   // 1 = starts next
  const stats = () => ({ wait: tasks.filter(t => t.state === 'wait').length, run: tasks.filter(t => t.state === 'run').length,
    stop: tasks.filter(t => t.state === 'stop').length, probe: probes(), used: used() });
  return { request, batch, cancel, finish, pump, find, some: pred => !!find(pred), position, stats, list: () => tasks.slice(), limit, probeLimit };
}

module.exports = { CLASSES, LIMIT, PROBE_LIMIT, SETTLE_MS, CAP_MS, HARD_MS, CODES, END_CODES, settle, createLoadQueue };
