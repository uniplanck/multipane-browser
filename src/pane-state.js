// Generation-tagged observation state of one pane (#02) (unit-tested in test/pane-state.test.js). Pure: every number, report and time comes in
// as an argument; main.js owns the counter, the pane objects and every side effect (IPC, views, timers, notifications). Nothing here is saved:
// after a restart every pane starts with new numbers.
// main numbers every pane entity, world generation and background-check run from one per-launch counter (never reused, so a closed pane's
// number can never match a new pane with the same id). A new generation starts on load / reload / URL change / SPA move / sleep / wake /
// renderer gone; the page's preload gets the number (mpb:gen) and stamps it, with its own scan sequence number, on every report.
// A report is compared only within the entity + generation (+ run) it was stamped with - it is never moved onto the current generation when it
// arrives. A report of another pane, an older page / URL / view / check, a duplicate or an out-of-order one gets a fixed code and changes nothing.
// The axes of one pane are kept apart:
//   health : the current generation's latest accepted report: NONE (none yet) / OK / LOADING / UNSURE (a snapshot item unknown, or a partial
//            newest turn) / CHANGING (the page moved after its last stable report: a reply is being written)
//   latest : the newest turn in that report: BOT / USER / PARTIAL / NONE ('' = unknown)
//   mark   : the last CONFIRMED closing marker (snap.marker: WAIT / DONE / WORK / NONE / NA) + the generation that confirmed it. From an older
//            generation, or while health is not OK, it is only the 'last confirmed' value: it may be shown, it never grounds an action
//   stable : the last stable fingerprint (counts + fp) + its generation - separate from what the newest turn is doing now
//   read   : unopened (a background check found something new while asleep; cleared on wake) + the key of the last report that alerted
//   sleep  : the sleep generation { id, base: fingerprint it compares against, run: the background check running for it }
const { SNAP, snapOk, snapUsable, snapIssue } = require('./pane-rules');

const REJECT = ['CLOSED', 'OTHER_PANE', 'NO_TOKEN', 'STALE_GEN', 'STALE_SEQ', 'STALE_RUN', 'NOT_SLEEPING', 'ASLEEP', 'DUP_ALERT', 'BAD_ACTION'];
const isNo = v => Number.isSafeInteger(v) && v > 0;

function createObs(ent, gen) {
  return { ent, gen, why: 'NEW', seq: 0, closed: false, health: 'NONE', issue: '', latest: '', mark: null, stable: null, sleep: null, unopened: false, alerted: '' };
}
// the generation's own report, confirmed and stable: the marker may be acted on
const current = o => !!o && !o.closed && o.health === 'OK' && !!o.mark && o.mark.gen === o.gen;
// observation side of auto-sleep: the latest turn of the current generation is the bot's and its confirmed marker is 🟢 / 🟣.
// A new user / bot turn, a reply being written, a partial turn, loading or an unknown page -> no (whatever was shown before)
const sleepOk = o => current(o) && !o.sleep && o.latest === 'BOT' && (o.mark.m === 'WAIT' || o.mark.m === 'DONE');
// how the marker on screen may be presented: 'live' (confirmed now), 'last' (last confirmed value, not current), 'sleep' (asleep), '' (none)
const shown = o => !o ? '' : o.sleep ? 'sleep' : current(o) ? 'live' : o.mark ? 'last' : '';
// one notification per report content (the same scan delivered again, re-read after a reload or by a background check alerts once)
const alertKey = c => `${c.user}/${c.bot}/${c.fp || ''}`;
const fpOf = c => ({ user: c.user, bot: c.bot, botSince: c.botSince, fp: String(c.fp || '') });
// (debug log only) where a background check's report differs from the sleep's baseline: the fields the verdict compares (user / bot / fp) and
// botSince, as numbers. The fingerprint only as 'hash same / differs' + the length of the text it was taken from - never the hash, the text,
// a name or a URL. Changes no state and no verdict.
function fpDiff(base, c) {
  if (!base || !c) return 'no baseline';
  const b = fpOf(c), num = v => Number.isSafeInteger(v) ? v : '?', len = fp => (/^[0-9a-z]+\.(\d{1,9})$/.exec(fp) || [])[1] || '?';
  const out = ['user', 'bot', 'botSince'].filter(k => base[k] !== b[k]).map(k => `${k} ${num(base[k])}->${num(b[k])}`);
  if (base.fp !== b.fp) out.push(`fp ${base.fp.split('.')[0] === b.fp.split('.')[0] ? 'hash same' : 'hash differs'} len ${len(base.fp)}->${len(b.fp)}`);
  return out.join(', ') || 'no difference';
}
// a report stamped { ent, gen, seq } may be taken by this pane now? -> '' or the reject code (pure check, nothing changes)
function admit(o, ent, gen, seq) {
  if (!o || o.closed) return 'CLOSED';
  if (ent !== o.ent) return 'OTHER_PANE';
  if (!isNo(gen)) return 'NO_TOKEN';
  if (gen !== o.gen) return 'STALE_GEN';
  if (!isNo(seq) || seq <= o.seq) return 'STALE_SEQ';
  return '';
}
const bumped = (o, gen, why) => ({ ...o, gen, why, seq: 0, health: 'NONE', issue: '', latest: '' });
// an accepted report of the current generation -> its axes. Counts / marker / fingerprint are taken only from a usable, stable report
function observe(o, seq, c) {
  const s = c && c.snap, latestCode = s && typeof s.latest === 'string' && Object.hasOwn(SNAP.latest, s.latest) ? s.latest : '';
  const n = { ...o, seq, issue: snapIssue(s) };
  if (!snapOk(s, 'conv') || !snapOk(s, 'roles')) return { ...n, health: s && s.conv === 'LOADING' ? 'LOADING' : 'UNSURE', latest: '' };
  if (!snapOk(s, 'stable')) return { ...n, health: 'CHANGING', latest: '' };
  if (!snapUsable(s)) return { ...n, health: 'UNSURE', latest: latestCode };
  return { ...n, health: 'OK', latest: latestCode, mark: { m: s.marker, gen: o.gen }, stable: { ...fpOf(c), gen: o.gen } };
}

// (state, action) -> { o: the new state (the same object when rejected), code: '' or a REJECT code, ...action results }
// actions: bump { gen, why } | scan { ent, gen, seq, c } | sleep { gen } | wake { gen } | close
//          probe-start { run } | probe-doc { run, tok } | probe-scan { run, gen, seq } | probe-stop { run } | probe-result { sleep, c } | alert { key }
function reduce(o, a) {
  const no = code => ({ o, code }), ok = (n, x) => ({ o: n, code: '', ...x });
  if (!a || typeof a !== 'object') return no('BAD_ACTION');
  if (!o || o.closed && a.type !== 'close') return no('CLOSED');
  const run = o.sleep && o.sleep.run;
  switch (a.type) {
    case 'bump': return isNo(a.gen) && a.gen > o.gen ? ok(bumped(o, a.gen, String(a.why || 'NAV'))) : no('STALE_GEN');
    case 'scan': { const code = admit(o, a.ent, a.gen, a.seq); return code ? no(code) : ok(observe(o, a.seq, a.c)); }
    case 'sleep': {                                            // the baseline is the stable fingerprint confirmed in the generation that fell asleep, or none
      if (o.sleep) return no('ASLEEP');
      if (!isNo(a.gen) || a.gen <= o.gen) return no('STALE_GEN');
      const base = current(o) && o.stable && o.stable.gen === o.gen ? fpOf(o.stable) : null;
      return ok({ ...bumped(o, a.gen, 'SLEEP'), sleep: { id: a.gen, base, run: null }, unopened: false });
    }
    case 'wake': return isNo(a.gen) && a.gen > o.gen ? ok({ ...bumped(o, a.gen, 'WAKE'), sleep: null, unopened: false }) : no('STALE_GEN');
    case 'close': return ok({ ...o, closed: true, health: 'NONE', latest: '', sleep: null });
    case 'probe-start': return o.sleep && isNo(a.run) ? ok({ ...o, sleep: { ...o.sleep, run: { id: a.run, tok: 0, seq: 0 } } }) : no('NOT_SLEEPING');
    case 'probe-doc':                                          // the check's window got a new page: its reports carry a new number
      return run && run.id === a.run && isNo(a.tok) && a.tok > run.tok ? ok({ ...o, sleep: { ...o.sleep, run: { ...run, tok: a.tok, seq: 0 } } }) : no('STALE_RUN');
    case 'probe-scan': {
      if (!run || run.id !== a.run) return no('STALE_RUN');
      if (!isNo(a.gen)) return no('NO_TOKEN');
      if (a.gen !== run.tok) return no('STALE_GEN');
      if (!isNo(a.seq) || a.seq <= run.seq) return no('STALE_SEQ');
      return ok({ ...o, sleep: { ...o.sleep, run: { ...run, seq: a.seq } } });
    }
    case 'probe-stop': return run && run.id === a.run ? ok({ ...o, sleep: { ...o.sleep, run: null } }) : no('STALE_RUN');
    case 'probe-result': {                                     // only the sleep the check was started for: never after a wake / another sleep
      if (!o.sleep || o.sleep.id !== a.sleep || !a.c) return no('STALE_RUN');
      const nf = fpOf(a.c), old = o.sleep.base;
      const verdict = !old ? 'BASELINE' : old.fp !== nf.fp || old.botSince !== nf.botSince ? 'CHANGED' : 'SAME';   // the user / bot totals are not compared: how much history a page has rendered differs between the awake page and the check window (observed: user 1->2 with nothing new)
      const fresh = verdict === 'CHANGED' && nf.botSince > 0;   // something new from the bot (the user speaking last is not 'new')
      return ok({ ...o, sleep: { ...o.sleep, base: nf }, unopened: o.unopened || fresh }, { verdict, fresh });
    }
    case 'alert': return typeof a.key === 'string' && a.key && a.key !== o.alerted ? ok({ ...o, alerted: a.key }) : no('DUP_ALERT');
  }
  return no('BAD_ACTION');
}

module.exports = { REJECT, createObs, admit, reduce, current, sleepOk, shown, alertKey, fpDiff };
