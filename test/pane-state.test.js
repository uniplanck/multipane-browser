// node test/pane-state.test.js — #02 generation-tagged pane state. The pure reducer (src/pane-state.js) on synthetic reports: out-of-order /
// duplicate scans, an older generation / page / check, pane number reuse, generation updates, the first background-check baseline, a reply being
// written, unknown pages, unread kept apart from unknown, one notification per report. Then the preload's generation stamp on a synthetic document
// and main's wiring (contract with src/main.js). Not covered here: real Grok pages / real timing of reload, wake and close - that needs the manual check.
const fs = require('fs'), path = require('path'), vm = require('vm');
const PS = require('../src/pane-state');
const { readConversation } = require('../src/pane-rules');
const DG = require('../src/diagnostics'), IPC = require('../src/ipc-policy');
const { loadPreload } = require('./preload-sandbox');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;

const W = '🟢 ━━ 《 待機中 》 ━━ 🟢', F = '🟣 ━━ ［ 終　了 ］ ━━ 🟣', K = '🔴 ━━ 【 作業中 】 ━━ 🔴';
// a report as the preload builds it (shared readConversation) from synthetic turns [role, text] ('u' user, 'b' bot, '' a block without text yet)
function rep(turns, extra = {}) {
  const entries = turns.map(([r, x]) => ({ user: r === 'u', blank: !String(x || '').trim() }));
  const li = entries.map(e => !e.blank).lastIndexOf(true);
  let last = null;
  if (li >= 0) { const [r, x] = turns[li]; last = { text: x }; if (r !== 'u') Object.assign(last, { inner: x, quotes: [], widget: false }); }
  return readConversation({ cid: 'bot1', ready: true, auth: false, entries, last, guess: null, h1s: ['Bot'], hh: 'Bot', draft: 'empty', quiet: true, ...extra });
}
const WAIT = rep([['u', '依頼'], ['b', '返信1\n' + W]]), DONE = rep([['u', '依頼'], ['b', '完了\n' + F]]), WORK = rep([['u', '依頼'], ['b', '作業\n' + K]]);
const NEWBOT = rep([['u', '依頼'], ['b', '返信1\n' + W], ['b', '返信2\n' + W]]), USER = rep([['u', '依頼'], ['b', '返信1\n' + W], ['u', '次の依頼']]);
const PARTIAL = rep([['u', '依頼'], ['b', '返信1\n' + W], ['', '']]), CHANGING = rep([['u', '依頼'], ['b', '返信1\n' + W], ['b', '書いている途中']], { quiet: false });
const LOADING = rep([], { ready: false }), AUTH = rep([], { auth: true }), UNKNOWN = rep([]);

// a pane: entity 1, generation 2; numbers come from one counter like main's
let no = 2; const next = () => ++no;
const mk = () => { no = 2; return PS.createObs(1, 2); };
const scan = (o, gen, seq, c, ent = o.ent) => PS.reduce(o, { type: 'scan', ent, gen, seq, c });
const deepFreeze = x => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); Object.values(x).forEach(deepFreeze); } return x; };

// ---- start / accept ----
{ const o = mk();
  t('new pane: nothing observed, nothing shown, no sleep', o.health === 'NONE' && PS.shown(o) === '' && !PS.sleepOk(o) && !PS.current(o) && !o.unopened);
  const r = scan(o, 2, 1, WAIT);
  t('a stable 🟢 report of the current generation: OK, live, may ground auto-sleep', r.code === '' && r.o.health === 'OK' && r.o.latest === 'BOT' && r.o.mark.m === 'WAIT' && r.o.mark.gen === 2
    && PS.current(r.o) && PS.sleepOk(r.o) && PS.shown(r.o) === 'live');
  t('🟣 too; 🔴 never', PS.sleepOk(scan(o, 2, 1, DONE).o) && !PS.sleepOk(scan(o, 2, 1, WORK).o) && PS.current(scan(o, 2, 1, WORK).o));
  t('the last stable fingerprint is kept with its generation', (s => s.user === 1 && s.bot === 1 && s.botSince === 1 && s.fp === WAIT.fp && s.gen === 2)(r.o.stable));
  t('pure: the given state is never changed', (() => { const f = deepFreeze(mk()); try { scan(f, 2, 1, WAIT); PS.reduce(f, { type: 'bump', gen: 9 }); PS.reduce(f, { type: 'sleep', gen: 9 }); PS.reduce(f, { type: 'close' }); return f.health === 'NONE' && f.gen === 2; } catch { return false; } })()); }

// ---- order: duplicates and out-of-order scans change nothing ----
{ let o = scan(mk(), 2, 5, WAIT).o;
  const dup = scan(o, 2, 5, WORK), back = scan(o, 2, 4, WORK), zero = scan(o, 2, 0, WORK), junk = scan(o, 2, 5.5, WORK);
  t('the same scan again -> STALE_SEQ, state untouched (same object)', dup.code === 'STALE_SEQ' && dup.o === o);
  t('an older scan arriving late (reversed order) -> STALE_SEQ, state untouched', back.code === 'STALE_SEQ' && back.o === o && o.mark.m === 'WAIT');
  t('no / broken scan number -> STALE_SEQ', zero.code === 'STALE_SEQ' && junk.code === 'STALE_SEQ');
  o = scan(o, 2, 6, WORK).o;
  t('a newer scan is taken', o.seq === 6 && o.mark.m === 'WORK'); }

// ---- generations: older page / URL / reload / SPA move / view ----
{ let o = scan(mk(), 2, 3, WAIT).o;
  const b = PS.reduce(o, { type: 'bump', gen: next(), why: 'SPA' }); o = b.o;
  t('a new generation: nothing observed in it yet, the old 🟢 is only the last confirmed value', b.code === '' && o.gen === 3 && o.why === 'SPA' && o.seq === 0 && o.health === 'NONE'
    && o.mark.m === 'WAIT' && o.mark.gen === 2 && !PS.current(o) && !PS.sleepOk(o) && PS.shown(o) === 'last');
  const old = scan(o, 2, 9, DONE);
  t('a report stamped with the older generation -> STALE_GEN, no change (never moved onto the current one)', old.code === 'STALE_GEN' && old.o === o);
  t('a report without a number yet -> NO_TOKEN', scan(o, 0, 1, WAIT).code === 'NO_TOKEN' && scan(o, undefined, 1, WAIT).code === 'NO_TOKEN' && scan(o, '3', 1, WAIT).code === 'NO_TOKEN');
  t('a report of a generation that does not exist yet -> STALE_GEN', scan(o, 99, 1, WAIT).code === 'STALE_GEN');
  t('scan numbers start again in the new generation', scan(o, 3, 1, WAIT).code === '');
  t('a generation never goes back or repeats', PS.reduce(o, { type: 'bump', gen: 3 }).code === 'STALE_GEN' && PS.reduce(o, { type: 'bump', gen: 2 }).code === 'STALE_GEN' && PS.reduce(o, { type: 'bump', gen: 0 }).code === 'STALE_GEN');
  o = scan(o, 3, 1, WAIT).o;
  t('confirmed again in the new generation: live, may sleep', PS.current(o) && PS.sleepOk(o) && PS.shown(o) === 'live'); }

// ---- pane numbers reused / closed panes ----
{ no = 2; const a0 = PS.createObs(next(), next()); let a = scan(a0, a0.gen, 1, WAIT).o;          // entity 3, generation 4
  a = PS.reduce(a, { type: 'close' }).o;
  const b = PS.createObs(next(), next());                                                          // the 'same' pane id later: entity 5, generation 6
  t('closed: every report, generation, sleep and check is refused', [scan(a, a.gen, 2, WAIT), PS.reduce(a, { type: 'bump', gen: 99 }), PS.reduce(a, { type: 'sleep', gen: 99 }), PS.reduce(a, { type: 'wake', gen: 99 }),
    PS.reduce(a, { type: 'probe-start', run: 99 }), PS.reduce(a, { type: 'alert', key: 'x' })].every(r => r.code === 'CLOSED' && r.o === a) && !PS.sleepOk(a) && PS.shown(a) === 'last');
  t('closing twice is harmless', PS.reduce(a, { type: 'close' }).code === '');
  t('a report of the closed pane delivered to a new pane -> refused (other entity / its generation is not the new one)', scan(b, a.gen, 2, WAIT, a.ent).code === 'OTHER_PANE' && scan(b, a.gen, 2, WAIT).code === 'STALE_GEN');
  t('numbers are never shared between panes', new Set([a.ent, a.gen, b.ent, b.gen]).size === 4); }

// ---- the latest turn is kept apart from the last stable fingerprint: a new turn / a reply being written / loading stop auto-sleep ----
{ const o = scan(mk(), 2, 1, WAIT).o;
  const ch = scan(o, 2, 2, CHANGING).o;
  t('previous 🟢, then the page is changing (reply being written): no sleep, shown as last confirmed', ch.health === 'CHANGING' && ch.latest === '' && !PS.sleepOk(ch) && PS.shown(ch) === 'last'
    && ch.mark.m === 'WAIT' && ch.stable.fp === WAIT.fp);
  const pa = scan(o, 2, 2, PARTIAL).o;
  t('previous 🟢, then a new empty bot turn (generation started): no sleep, fingerprint stays the last stable one', pa.health === 'UNSURE' && pa.latest === 'PARTIAL' && !PS.sleepOk(pa) && pa.stable.fp === WAIT.fp
    && PARTIAL.waiting === true);
  const us = scan(o, 2, 2, USER).o;
  t('previous 🟢, then the user spoke: confirmed (marker NA), no sleep', us.health === 'OK' && us.latest === 'USER' && us.mark.m === 'NA' && !PS.sleepOk(us) && PS.shown(us) === 'live');
  const nb = scan(o, 2, 2, NEWBOT).o;
  t('a new bot turn with its own 🟢: a new stable fingerprint, may sleep', PS.sleepOk(nb) && nb.stable.fp === NEWBOT.fp && nb.stable.fp !== WAIT.fp && nb.stable.bot === 2);
  const lo = scan(o, 2, 2, LOADING).o, au = scan(o, 2, 2, AUTH).o, un = scan(o, 2, 2, UNKNOWN).o;
  t('loading / login / unknown page: no sleep, the old marker only last confirmed', lo.health === 'LOADING' && au.health === 'UNSURE' && un.health === 'UNSURE' && [lo, au, un].every(x => !PS.sleepOk(x) && PS.shown(x) === 'last' && x.mark.m === 'WAIT'));
  t('unknown items keep their fixed reason', lo.issue === 'LOADING' && au.issue === 'AUTH_REQUIRED' && un.issue === 'DOM_UNKNOWN' && ch.issue === 'CHANGING' && pa.issue === 'LATEST_PARTIAL');
  const back = scan(ch, 2, 3, WAIT).o;
  t('stable again (next QUIET report): live, may sleep', PS.sleepOk(back) && PS.shown(back) === 'live'); }

// ---- sleep / background check / wake ----
{ let o = scan(mk(), 2, 1, WAIT).o;
  const s = PS.reduce(o, { type: 'sleep', gen: next() }); o = s.o;
  t('sleep: a sleep generation, its baseline = the fingerprint confirmed before it', s.code === '' && o.sleep.id === 3 && o.sleep.base.fp === WAIT.fp && o.gen === 3 && PS.shown(o) === 'sleep' && !PS.sleepOk(o));
  t('sleeping twice -> refused (the sleep generation stays)', (r => r.code === 'ASLEEP' && r.o === o)(PS.reduce(o, { type: 'sleep', gen: 99 })));
  o = PS.reduce(o, { type: 'bump', gen: next(), why: 'NAV' }).o;                                  // the blank page of the sleeping pane
  t('a new page while asleep keeps the sleep generation', o.sleep && o.sleep.id === 3 && o.gen === 4);
  t('a check needs a sleeping pane', PS.reduce(PS.createObs(1, 2), { type: 'probe-start', run: 50 }).code === 'NOT_SLEEPING');
  const run = next(); o = PS.reduce(o, { type: 'probe-start', run }).o;
  const tok = next(); o = PS.reduce(o, { type: 'probe-doc', run, tok }).o;
  const ps = (x, a) => PS.reduce(x, { type: 'probe-scan', run, ...a });
  t('check reports: only with the check page\'s number, in order', ps(o, { gen: tok, seq: 1 }).code === '' && ps(o, { gen: 0, seq: 1 }).code === 'NO_TOKEN' && ps(o, { gen: 4, seq: 1 }).code === 'STALE_GEN'
    && ps(ps(o, { gen: tok, seq: 2 }).o, { gen: tok, seq: 2 }).code === 'STALE_SEQ' && ps(ps(o, { gen: tok, seq: 2 }).o, { gen: tok, seq: 1 }).code === 'STALE_SEQ');
  t('an older check run -> STALE_RUN', PS.reduce(o, { type: 'probe-scan', run: run - 1, gen: tok, seq: 1 }).code === 'STALE_RUN' && PS.reduce(o, { type: 'probe-doc', run: run + 99, tok: 999 }).code === 'STALE_RUN');
  const tok2 = next(), o2 = PS.reduce(o, { type: 'probe-doc', run, tok: tok2 }).o;
  t('the check window loads another page: reports of the earlier page refused', ps(o2, { gen: tok, seq: 5 }).code === 'STALE_GEN' && ps(o2, { gen: tok2, seq: 1 }).code === '');
  const same = PS.reduce(o, { type: 'probe-result', sleep: 3, c: WAIT });
  t('nothing new: SAME, not unopened', same.code === '' && same.verdict === 'SAME' && !same.fresh && !same.o.unopened);
  const nw = PS.reduce(o, { type: 'probe-result', sleep: 3, c: NEWBOT });
  t('a new bot turn while asleep: CHANGED, unopened, it becomes the baseline', nw.verdict === 'CHANGED' && nw.fresh && nw.o.unopened && nw.o.sleep.base.fp === NEWBOT.fp);
  const us = PS.reduce(o, { type: 'probe-result', sleep: 3, c: USER });
  t('changed but the user spoke last: not unopened', us.verdict === 'CHANGED' && !us.fresh && !us.o.unopened);
  const more = PS.reduce(o, { type: 'probe-result', sleep: 3, c: { ...WAIT, user: WAIT.user + 1, bot: WAIT.bot + 2 } });
  t('only the history totals differ (a page that rendered more of it): SAME, not unopened', more.verdict === 'SAME' && !more.fresh && !more.o.unopened);
  const stop = PS.reduce(nw.o, { type: 'probe-stop', run });
  t('a stopped run takes nothing more', stop.code === '' && stop.o.sleep.run === null && PS.reduce(stop.o, { type: 'probe-scan', run, gen: tok, seq: 9 }).code === 'STALE_RUN');
  // unread / unopened is its own axis: unknown reports and new generations do not clear it, only waking does
  let u = stop.o;
  u = PS.reduce(u, { type: 'bump', gen: next(), why: 'NAV' }).o;
  t('unopened survives an unknown state / a new generation', u.unopened && u.health === 'NONE' && u.sleep);
  const w = PS.reduce(u, { type: 'wake', gen: next() });
  t('wake: a new generation, sleep and its check ended, unopened cleared, the old 🟢 only last confirmed', w.code === '' && w.o.sleep === null && !w.o.unopened && w.o.why === 'WAKE' && PS.shown(w.o) === 'last' && !PS.sleepOk(w.o));
  t('a check result after the wake -> STALE_RUN (draft / focus after waking are never touched by it)', PS.reduce(w.o, { type: 'probe-result', sleep: 3, c: NEWBOT }).code === 'STALE_RUN');
  const again = PS.reduce(w.o, { type: 'sleep', gen: next() }).o;
  t('...and after falling asleep again: the old check is for an older sleep -> STALE_RUN', PS.reduce(again, { type: 'probe-result', sleep: 3, c: NEWBOT }).code === 'STALE_RUN'
    && PS.reduce(again, { type: 'probe-result', sleep: again.sleep.id, c: NEWBOT }).code === ''); }

// ---- first baseline: never a burst of 'new' ----
{ let o = PS.reduce(mk(), { type: 'bump', gen: next() }).o;                                     // e.g. slept by hand right after a reload: nothing confirmed in this generation
  o = PS.reduce(o, { type: 'sleep', gen: next() }).o;
  t('nothing confirmed in the generation that fell asleep: no baseline', o.sleep.base === null);
  const first = PS.reduce(o, { type: 'probe-result', sleep: o.sleep.id, c: NEWBOT });
  t('first check result is only the baseline: not new, not unopened', first.verdict === 'BASELINE' && !first.fresh && !first.o.unopened && first.o.sleep.base.fp === NEWBOT.fp);
  t('the next one compares with it', PS.reduce(first.o, { type: 'probe-result', sleep: o.sleep.id, c: NEWBOT }).verdict === 'SAME');
  // (debug log only) which field made a CHANGED: names and numbers, never the text / the hash itself; the verdict is untouched
  const base = first.o.sleep.base, more = rep([['u', '依頼'], ['b', '返信1\n' + W], ['b', '返信2\n' + W + '\n追記']]);
  t('fpDiff: count and fingerprint differences as numbers', PS.fpDiff(base, more) === `fp hash differs len ${NEWBOT.fp.split('.')[1]}->${more.fp.split('.')[1]}` && PS.fpDiff(base, USER) === `user 1->2, bot 2->1, botSince 2->0, fp hash differs len ${NEWBOT.fp.split('.')[1]}->${USER.fp.split('.')[1]}`);
  t('fpDiff: same report / no baseline / junk fingerprint', PS.fpDiff(base, NEWBOT) === 'no difference' && PS.fpDiff(null, NEWBOT) === 'no baseline' && PS.fpDiff({ ...base, fp: '秘密.12' }, { ...NEWBOT, fp: 'x' }) === 'fp hash differs len ?->?');
  t('fpDiff: no text and no hash in it', !/返信|依頼|追記/.test(PS.fpDiff(base, more)) && !PS.fpDiff(base, more).includes(NEWBOT.fp.split('.')[0]));
  let st = scan(mk(), 2, 1, WAIT).o; st = PS.reduce(st, { type: 'bump', gen: next() }).o; st = PS.reduce(st, { type: 'sleep', gen: next() }).o;
  t('a fingerprint of an older generation (another page / before a reload) is never a baseline', st.stable.fp === WAIT.fp && st.sleep.base === null);
  // ten panes falling asleep without a confirmed state: their first checks bring no unopened
  const all = Array.from({ length: 10 }, () => { let x = PS.reduce(PS.createObs(next(), next()), { type: 'sleep', gen: next() }).o; return PS.reduce(x, { type: 'probe-result', sleep: x.sleep.id, c: NEWBOT }); });
  t('first checks of 10 panes: no unopened at all', all.every(r => r.verdict === 'BASELINE' && !r.o.unopened)); }

// ---- one notification per report ----
{ let o = scan(mk(), 2, 1, WAIT).o;
  const k = PS.alertKey(WAIT), a1 = PS.reduce(o, { type: 'alert', key: k }); o = a1.o;
  t('first alert for a report: yes; the same report again: DUP_ALERT', a1.code === '' && PS.reduce(o, { type: 'alert', key: k }).code === 'DUP_ALERT');
  o = PS.reduce(o, { type: 'bump', gen: next() }).o;
  t('re-read after a reload / SPA move (same content): still no second alert', PS.reduce(o, { type: 'alert', key: PS.alertKey(scan(o, o.gen, 1, WAIT).o.stable) }).code === 'DUP_ALERT');
  t('a new bot message: alerts', PS.reduce(o, { type: 'alert', key: PS.alertKey(NEWBOT) }).code === '');
  t('empty / junk key: no alert', PS.reduce(o, { type: 'alert', key: '' }).code === 'DUP_ALERT' && PS.reduce(o, { type: 'alert' }).code === 'DUP_ALERT');
  // main's flow for one report delivered twice (IPC duplicate): the second one is refused before any alert is considered
  let n = 0; let m = mk();
  for (const seq of [1, 1, 1]) { const r = scan(m, 2, seq, WAIT); if (r.code) continue; m = r.o; const a = PS.reduce(m, { type: 'alert', key: PS.alertKey(WAIT) }); if (!a.code) { m = a.o; n++; } }
  t('the same scan three times: one notification', n === 1); }

// ---- codes ----
t('reject codes are fixed upper-case words', PS.REJECT.every(c => /^[A-Z][A-Z_]*$/.test(c)));
t('every code main records for a dropped report is a diagnostics result (count.drop)', ['CLOSED', 'OTHER_PANE', 'NO_TOKEN', 'STALE_GEN', 'STALE_SEQ', 'STALE_RUN'].every(c => DG.GEN_CODES.includes(c) && DG.EVENTS['count.drop'].r.includes(c) && PS.REJECT.includes(c))
  && DG.EVENTS.probe.r.includes('STALE'));
t('junk action / state never throws', (() => { try { return PS.reduce(mk(), null).code === 'BAD_ACTION' && PS.reduce(mk(), { type: 'nope' }).code === 'BAD_ACTION' && PS.reduce(null, { type: 'scan' }).code === 'CLOSED'
  && PS.admit(null, 1, 2, 3) === 'CLOSED' && !PS.sleepOk(null) && PS.shown(null) === '' && scan(mk(), 2, 1, null).o.health === 'UNSURE'; } catch { return false; } })());

// ---- the preload stamps its generation (synthetic document) ----
function block(text, user = false) { return { textContent: text, innerText: text, contains: o => o === null, querySelector: s => (s === '[data-testid="user-message"]' ? (user ? {} : null) : null), querySelectorAll: () => [] }; }
function page(blocks) {
  const doc = { readyState: 'complete', documentElement: null, get body() { return { innerText: '', textContent: '' }; },
    querySelectorAll: s => (s === '[class*="group/bot-entry"]' ? blocks : s === 'h1' ? [{ innerText: 'Bot', textContent: 'Bot' }] : []), querySelector: () => null };
  const p = loadPreload(), sent = [];
  vm.runInContext('ipcRenderer', p.ctx).send = (ch, payload) => sent.push([ch, payload]);
  p.ctx.document = doc; p.ctx.location = { hostname: 'grok.com', pathname: '/bot/bot1' };
  const run = src => vm.runInContext(src, p.ctx);
  return { sent, run, check: () => run('check()'), gen: g => run(`setGen(${J(g)})`) };
}
{ const b = block('返信\n' + W), pg = page([block('依頼', true), b]);
  pg.check(); pg.check();
  t('preload: before main gave a number, the report carries gen 0 (main drops it)', pg.sent.length === 1 && pg.sent[0][1].gen === 0 && pg.sent[0][1].seq === 2);
  pg.gen(7); pg.check();
  t('preload: a new number - one scan of it is not enough', pg.sent.length === 1);
  pg.check();
  const c = pg.sent[1] && pg.sent[1][1];
  t('preload: the same page is reported again under the new number, with its scan number', pg.sent.length === 2 && c.gen === 7 && c.seq === 4 && c.snap.stable === 'QUIET');
  t('preload: the stamped report passes the IPC gate and keeps its numbers', IPC.check('pane:msgcount', { role: 'pane', frame: { top: true, detached: false, url: 'https://grok.com/bot/bot1', origin: 'https://grok.com' } }, [c], { owned: true }) === null
    && (m => m.gen === 7 && m.seq === 4)(IPC.msgCount(c)));
  pg.check();
  t('preload: unchanged page, nothing more', pg.sent.length === 2);
  pg.gen(7); pg.gen(0); pg.gen(-3); pg.gen('9'); pg.gen(1.5); pg.check();
  t('preload: the same / junk numbers are ignored', pg.sent.length === 2);
  b.textContent = b.innerText = '返信の続きを書いている'; pg.check();
  const ch = pg.sent[2] && pg.sent[2][1];
  t('preload: the page changes after a stable report -> one CHANGING report', pg.sent.length === 3 && ch.snap.stable === 'CHANGING' && ch.gen === 7 && ch.seq > c.seq);
  b.textContent = b.innerText = '返信の続きを書いている途中、さらに'; pg.check();
  t('preload: still changing -> nothing more (one per change)', pg.sent.length === 3);
  pg.check();
  const q = pg.sent[3] && pg.sent[3][1];
  t('preload: settled -> a stable report again', pg.sent.length === 4 && q.snap.stable === 'QUIET' && q.seq > ch.seq);
  t('preload: scan numbers only grow', pg.sent.map(s => s[1].seq).every((s, i, a) => !i || s > a[i - 1])); }
{ const b = block('返信\n' + W), pg = page([block('依頼', true), b]);
  pg.gen(3); pg.check(); pg.gen(4); pg.check();
  t('preload: two equal scans under different numbers never make a report', pg.sent.length === 0);
  pg.check();
  t('preload: two under the same number do', pg.sent.length === 1 && pg.sent[0][1].gen === 4); }

// ---- main's wiring (contract with src/main.js) ----
{ const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const fn = name => { const i = main.indexOf(`function ${name}(`); if (i < 0) return ''; let d = 0, j = main.indexOf(') {', i) + 2; for (; j < main.length; j++) { if (main[j] === '{') d++; else if (main[j] === '}' && --d === 0) break; } return main.slice(i, j + 1); };
  const om = fn('onMsgCount'), cs = fn('canSleep'), pp = fn('probePane'), sp = fn('sleepPane'), rp = fn('reloadPane'), cp = fn('closePane'), ap = fn('addPane'), ld = fn('liveInput');
  const at = (s, x) => s.indexOf(x);
  t('main: one per-launch counter for entities / generations / runs, at the top level (all windows)', /^let worldNo = 0;$/m.test(main) && /^const nextNo = \(\) => \+\+worldNo;$/m.test(main));
  t('main: a report is checked against its generation before anything else is done with it', at(om, 'PS.admit(p.obs, p.obs.ent, c.gen, c.seq)') > 0 && at(om, 'PS.admit(') < at(om, 'resetCounts(p)')
    && at(om, 'PS.admit(') < at(om, 'p.snap = s;') && at(om, 'PS.admit(') < at(om, "type: 'scan'") && at(om, "diag.rec('count.drop', drop") > 0);
  t('main: a CHANGING report applies no counts', at(om, "if (!snapOk(s, 'stable')) { sendState(); return; }") > 0 && at(om, "if (!snapOk(s, 'stable'))") < at(om, 'p.msgMode = true'));
  t('main: one notification per report', /canAlert\(p\) && !obsDo\(p, \{ type: 'alert', key: PS\.alertKey\(c\) \}\)\.code\) \{ lightUp/.test(om) && /!obsDo\(p, \{ type: 'alert', key: PS\.alertKey\(nf\) \}\)\.code\) notifyPane/.test(pp));   // (#61) delivery: notification-policy.js
  t('main: auto-sleep needs the current generation\'s confirmed 🟢 / 🟣 (manual sleep unchanged)', /if \(!force && !PS\.sleepOk\(p\.obs\)\) return false;/.test(cs));
  t('main: new generation on every page / SPA move of the main frame / renderer loss; the number sent again on dom-ready', /wc\.on\('did-navigate', \(\) => newGen\(p, 'NAV'\)\);/.test(ap)
    && /wc\.on\('did-navigate-in-page', \(e, u, isMain\) => \{ if \(isMain\) newGen\(p, 'SPA'\); \}\);/.test(ap) && /wc\.on\('render-process-gone', \(\) => newGen\(p, 'GONE'\)\);/.test(ap) && /wc\.on\('dom-ready', [^\n]*sendGen\(p\)/.test(ap)
    && at(ap, "newGen(p, 'NAV')") < at(ap, "wc.on('did-navigate', rememberUrl)"));
  t('main: reload and wake start a new generation; wake ends the sleep', /obsDo\(p, \{ type: 'wake', gen: nextNo\(\) \}\)/.test(rp) && /else newGen\(p, 'RELOAD'\);/.test(rp));
  t('main: sleep starts a sleep generation (baseline from the reducer, not from an older page)', /obsDo\(p, \{ type: 'sleep', gen: nextNo\(\) \}\);/.test(sp) && !/lastMsg/.test(sp));
  t('main: closing a pane closes its state and stops its check', /disposePane\(p, 'CLOSED'\);/.test(cp) && /obsDo\(p, \{ type: 'close' \}\); abortProbe\(p\);/.test(fn('disposePane')));   // (#32) the view's end: disposePane
  t('main: a check is a run of the sleep it starts in; its reports are checked per run / page, its result only for that sleep', at(pp, "type: 'probe-start', run") > 0 && at(pp, "type: 'probe-start'") < at(pp, 'new BrowserWindow')
    && at(pp, "type: 'probe-scan', run, gen: c.gen, seq: c.seq") < at(pp, 'last = c;') && /wc\.on\('did-navigate', docGen\);/.test(pp) && at(pp, "type: 'probe-stop', run") > at(pp, 'finally')
    && at(pp, "type: 'probe-result', sleep: sid") > at(pp, "diag.rec('probe', 'UNSURE'") && at(pp, "diag.rec('probe', 'STALE'") > 0);
  t('main: a draft check answered by an older page counts as unknown (#11: stamps with the generation around the live check)', /const before = inStamp\(p\)/.test(ld) && /after: inStamp\(p\)/.test(ld)
    && /const inStamp = p => \(\{ ent: p\.obs\.ent, gen: p\.obs\.gen,/.test(main) && require('../src/draft-guard').read({ d: 'empty' }, { page: true, before: { ent: 1, gen: 2, rev: 0 }, after: { ent: 1, gen: 3, rev: 0 }, at: 1 }).st === 'UNKNOWN');
  t('main: a background check that says CHANGED logs which field differed, numbers only (debug log)', /const base0 = p\.obs\.sleep && p\.obs\.sleep\.base;/.test(pp) && /if \(res\.verdict === 'CHANGED' && debugOn\(\)\) dlog\(`pane\$\{p\.id\}`, 'probe changed:', PS\.fpDiff\(base0, last\)\);/.test(pp)
    && pp.indexOf('const base0') < pp.indexOf("type: 'probe-result'"));
  t('main: unopened is the reducer\'s (no own copy left)', !/p\.unopened\s*=/.test(main) && !/sleepFp/.test(main));
  t('main: the generation state is never saved', !/obs/.test(main.slice(main.indexOf('const paneSpec'), main.indexOf('\n', main.indexOf('const paneSpec')))) && !/obs/.test(fn('stateDoc')));
  t('main: the screen gets live / last / sleep only', /obs: PS\.shown\(p\.obs\)/.test(fn('sendState'))); }

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
