// node test/load-queue.test.js — #31 shared load queue. The pure queue (src/load-queue.js) with deferred promises and a fake clock: the limits
// (2 running, 1 background check) with 10+ requests, order (user > startup / reload-all > background, focused first, then request order),
// merged / replaced / taken-over requests, a cancelled task keeping its slot until the real stop is confirmed, exceptions, late results, a user's
// load stopping a background check, a burst after resume, and the settle rule. Then main's wiring (contract with src/main.js, the IPC policy and the
// diagnostics codes). Not covered here: real page loads / real stop timing / the placeholder on screen - that needs the manual check.
const fs = require('fs'), path = require('path');
const LQ = require('../src/load-queue');
const DG = require('../src/diagnostics'), IPC = require('../src/ipc-policy');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

// a queue with a fake clock; every task records what happened to it. load(): a view load whose start returns a deferred promise
function rig(opt = {}) {
  let clock = 1000, maxRun = 0, maxProbe = 0;
  const log = [], ends = new Map(), defs = new Map(), stops = [];
  const q = LQ.createLoadQueue({ now: () => clock, ...opt, onChange: e => { log.push(`${e.type}:${e.t.data?.n}${e.code ? ':' + e.code : ''}`); const s = q.stats(); maxRun = Math.max(maxRun, s.used); maxProbe = Math.max(maxProbe, s.probe); } });
  const req = (n, x = {}) => q.request({ ent: x.ent ?? n, gen: x.gen ?? 1, purpose: x.purpose || 'START', cls: x.cls || 'BULK', probe: !!x.probe, win: x.win ?? 'w1', url: x.url || `u${n}`,
    data: { n, rank: x.rank ?? 1 }, onStart: x.onStart || (tk => { const d = deferred(); defs.set(tk.id, d); return d.p; }),
    onStop: x.onStop || ((tk, code) => stops.push([tk.data.n, code])), onEnd: (tk, code) => ends.set(tk.id, code) });
  const running = () => q.list().filter(x => x.state !== 'wait').map(x => x.data.n).sort((a, b) => a - b);
  const waiting = () => q.list().filter(x => x.state === 'wait').sort((a, b) => q.position(a.id) - q.position(b.id)).map(x => x.data.n);   // in the order they will start
  return { q, req, log, ends, defs, stops, running, waiting, advance: ms => { clock += ms; }, get max() { return maxRun; }, get maxProbe() { return maxProbe; }, now: () => clock };
}
const rankOf = tk => tk.data.rank;

(async () => {
// ---- limits: 10 requests, never more than 2 running; one finishes -> the next starts ----
{ const r = rig({ rank: rankOf }); const ids = [];
  for (let i = 1; i <= 10; i++) ids.push(r.req(i).task.id);
  t('10 requests: 2 running, 8 waiting', J(r.running()) === '[1,2]' && r.waiting().length === 8 && r.q.stats().used === 2);
  t('waiting ones are told so (WAIT)', r.log.filter(x => x.endsWith(':WAIT')).length === 8);
  for (let k = 0; k < 10; k++) { const run = r.q.list().find(x => x.state === 'run'); if (!run) break; r.defs.get(run.id).resolve(); await tick(); }
  t('finishing one at a time: all ran, at most 2 at any moment', r.max === 2 && ids.every(id => r.ends.get(id) === 'DONE') && r.q.list().length === 0); }

// ---- background checks: at most one, even with free slots; foreground first ----
{ const r = rig({ rank: rankOf });
  const p1 = r.req(1, { probe: true, cls: 'BG' }), p2 = r.req(2, { probe: true, cls: 'BG' });
  t('two background checks: one runs, the other waits although a slot is free', J(r.running()) === '[1]' && J(r.waiting()) === '[2]');
  r.req(3); r.req(4);
  t('a foreground load takes the free slot; the next foreground waits before the second check', J(r.running()) === '[1,3]' && J(r.waiting()) === '[4,2]' && r.q.position(p2.task.id) === 2);
  r.defs.get(p1.task.id).resolve(); await tick();
  t('check over: the waiting foreground load goes before the waiting check', J(r.running()) === '[3,4]' && J(r.waiting()) === '[2]');
  r.defs.get(r.q.find(x => x.data.n === 3).id).resolve(); await tick();
  t('then the second check', J(r.running()) === '[2,4]' && r.maxProbe === 1 && r.max === 2); }

// ---- order: user > bulk > background; focused (rank) first; then request order ----
{ const r = rig({ rank: rankOf });
  r.req(1); r.req(2);                                        // both slots busy
  r.req(3, { cls: 'BG', probe: true }); r.req(4); r.req(5, { rank: 0 }); r.req(6, { cls: 'USER' }); r.req(7, { cls: 'USER' });
  t('waiting order: user (request order), then bulk with the focused pane first, then background', J(r.waiting()) === '[6,7,5,4,3]');
  r.defs.get(r.q.find(x => x.data.n === 1).id).resolve(); await tick();
  t('a free slot goes to the first user request', J(r.running()) === '[2,6]'); }

// ---- merged / replaced / taken over (one task per pane view) ----
{ const r = rig();
  r.req(1); r.req(2);                                         // slots busy
  const a = r.req(3, { ent: 30, purpose: 'WAKE', cls: 'BULK' }), b = r.req(3, { ent: 30, purpose: 'WAKE', cls: 'USER' });
  t('the same pane / generation / purpose twice -> one task, the higher class', b.merged && b.task === a.task && a.task.cls === 'USER' && r.q.list().filter(x => x.ent === 30).length === 1);
  const c = r.req(3, { ent: 30, purpose: 'RELOAD', cls: 'BULK' });
  t('a reload of the same page while one waits -> merged into it', c.merged && c.task === a.task);
  const d = r.req(3, { ent: 30, purpose: 'NAV', cls: 'USER', url: 'other' });
  t('another URL replaces the waiting one (SUPERSEDED), one task left', !d.merged && r.ends.get(a.task.id) === 'SUPERSEDED' && r.q.list().filter(x => x.ent === 30).length === 1 && d.task.url === 'other');
  const e = r.req(3, { ent: 30, purpose: 'RELOAD', cls: 'BULK' });
  t('a reload while another URL waits -> merged into the URL (the URL is not lost)', e.merged && e.task === d.task);
  const f = r.req(3, { ent: 30, gen: 2, purpose: 'RELOAD', cls: 'BULK' });
  t('a newer generation replaces the waiting one, keeping the higher class', !f.merged && r.ends.get(d.task.id) === 'SUPERSEDED' && f.task.cls === 'USER');
  // running: taken over in place
  const run1 = r.q.find(x => x.data.n === 1), before = r.q.stats().used;
  const g = r.req(10, { ent: 1, gen: 2, purpose: 'RELOAD', cls: 'USER' });
  t('a new load of a pane whose load runs takes over its slot at once (no extra slot)', !g.merged && g.task.state === 'run' && r.q.stats().used === before && r.ends.get(run1.id) === 'SUPERSEDED' && g.task.waited === false);
  r.defs.get(run1.id).resolve(); await tick();
  t('the replaced load finishing late changes nothing (its result is dropped)', r.q.stats().used === before && r.q.find(x => x.id === g.task.id).state === 'run' && r.q.finish(run1.id) === false);
  const h = r.req(10, { ent: 1, gen: 2, purpose: 'RELOAD', cls: 'USER' });
  t('the same request again while it runs -> merged, not restarted', h.merged && h.task === g.task && r.log.filter(x => x === 'start:10').length === 1);
  const pr = r.req(20, { ent: 1, probe: true, cls: 'BG' });
  t('a background check of the same pane is its own resource (not merged with the view load)', !pr.merged && pr.task.probe); }

// ---- cancel: waiting goes at once; running keeps its slot until the real stop is confirmed ----
{ const r = rig();
  const a = r.req(1), b = r.req(2), c = r.req(3), d = r.req(4, { win: 'w2' });
  t('cancel a waiting task: ended at once with the reason, no stop needed', r.q.cancel(c.task.id, 'USER') === 1 && r.ends.get(c.task.id) === 'USER' && r.stops.length === 0);
  r.q.cancel(a.task.id, 'CLOSED');
  t('cancel a running task: asked to stop, still holds its slot, nothing else starts', J(r.stops) === '[[1,"CLOSED"]]' && a.task.state === 'stop' && r.q.stats().used === 2 && J(r.waiting()) === '[4]');
  r.q.cancel(a.task.id, 'CLOSED');
  t('cancel again while stopping: no second stop', r.stops.length === 1);
  r.defs.get(a.task.id).resolve('DONE'); await tick();
  t('stop confirmed: ended as STOPPED, the slot goes to the next', r.ends.get(a.task.id) === 'STOPPED' && J(r.running()) === '[2,4]' && r.max === 2);
  t('cancel by predicate (window closed): every task of that window', r.q.cancel(x => x.win === 'w2', 'WINDOW') === 1 && d.task.state === 'stop' && r.q.cancel(x => { throw new Error('x'); }, 'USER') === 0);
  t('finish of an unknown / waiting id -> false', r.q.finish(9999) === false); }

// ---- exceptions: start throws / rejects, stop throws, callbacks throw ----
{ const r = rig({ rank: () => { throw new Error('rank'); } });
  const a = r.req(1, { onStart: () => { throw new Error('boom'); } });
  t('start throws: nothing began, the slot is free at once (ERROR)', r.ends.get(a.task.id) === 'ERROR' && r.q.stats().used === 0);
  const b = r.req(2, { onStart: () => Promise.reject(new Error('x')) }), c = r.req(3);
  t('a rejecting start holds its slot until it settles', r.q.stats().used === 2);
  await tick();
  t('rejected: ERROR, the slot goes back', r.ends.get(b.task.id) === 'ERROR' && r.q.stats().used === 1);
  const d = r.req(4, { onStop: () => { throw new Error('stop'); } });
  r.req(5);
  r.q.cancel(d.task.id, 'URL');
  t('stop throws: the slot stays held (no new start) until finish', d.task.state === 'stop' && J(r.waiting()) === '[5]');
  r.q.finish(d.task.id, 'DONE');
  t('...then STOPPED and the next starts', r.ends.get(d.task.id) === 'STOPPED' && J(r.running()) === '[3,5]');
  const q2 = LQ.createLoadQueue({ onChange: () => { throw new Error('change'); } });
  const x = q2.request({ ent: 1, onStart: () => {}, onEnd: () => { throw new Error('end'); } });
  t('onChange / onEnd / rank throwing never break the queue', x.task.state === 'run' && q2.finish(x.task.id) === true && q2.stats().used === 0);
  let threw = false; try { q2.request({ ent: null, onStart: () => {} }); } catch { threw = true; }
  t('a request without a pane / start is refused', threw && q2.stats().used === 0); }

// ---- a user's load stops a background check (never a foreground load) ----
{ const r = rig();
  const a = r.req(1), p = r.req(2, { probe: true, cls: 'BG' });
  r.req(3);                                                  // bulk waits: no preemption for it
  t('a waiting bulk load does not stop the running check', p.task.state === 'run' && r.stops.length === 0);
  const u = r.req(4, { cls: 'USER' });
  t('a waiting user load stops the check (PREEMPT) but waits for its real stop', J(r.stops) === '[[2,"PREEMPT"]]' && u.task.state === 'wait' && r.q.stats().used === 2);
  r.defs.get(p.task.id).resolve(); await tick();
  t('check window gone: the user load starts (before the waiting bulk one)', u.task.state === 'run' && r.ends.get(p.task.id) === 'STOPPED' && J(r.waiting()) === '[3]');
  const r2 = rig(); r2.req(1); r2.req(2); r2.req(3, { cls: 'USER' });
  t('two foreground loads running: a user load waits, nothing is stopped', r2.stops.length === 0 && J(r2.waiting()) === '[3]'); }

// ---- batch: the focused pane first although requested last; waited flag ----
{ const r = rig({ rank: rankOf });
  r.q.batch(() => { for (let i = 1; i <= 5; i++) r.req(i, { rank: i === 5 ? 0 : 1 }); });
  t('batch: the focused pane and the first other one start; the rest wait', J(r.running()) === '[1,5]' && J(r.waiting()) === '[2,3,4]');
  t('batch-started tasks did not wait (no input re-check needed)', r.q.list().filter(x => x.state === 'run').every(x => x.waited === false));
  r.defs.get(r.q.find(x => x.data.n === 1).id).resolve(); await tick();
  t('a task that started after waiting is marked waited', r.q.find(x => x.data.n === 2).waited === true);
  const r2 = rig(); const im = r2.req(1).task;
  t('a task started by its own request did not wait', im.waited === false && im.startAt === r2.now()); }

// ---- burst after resume: 10 automatic reloads + 2 user wakes at once ----
{ const r = rig({ rank: rankOf });
  for (let i = 1; i <= 10; i++) r.req(i, { purpose: 'RELOAD' });
  r.req(11, { cls: 'USER', purpose: 'WAKE' }); r.req(12, { cls: 'USER', purpose: 'WAKE' }); r.req(13, { probe: true, cls: 'BG' });
  t('after a burst: still 2 running, the user wakes next', r.q.stats().used === 2 && r.q.position(r.q.find(x => x.data.n === 11).id) === 1 && r.q.position(r.q.find(x => x.data.n === 12).id) === 2);
  while (r.q.list().length) { const run = r.q.list().find(x => x.state === 'run'); r.defs.get(run.id).resolve(); await tick(); }
  const starts = r.log.filter(x => x.startsWith('start:')).map(x => Number(x.split(':')[1]));
  t('everything ran, never more than 2 at once, at most 1 check: the wakes right after the first two, the check last', r.max === 2 && r.maxProbe <= 1 && starts.length === 13
    && J(starts.slice(0, 4)) === '[1,2,11,12]' && starts[starts.length - 1] === 13); }

// ---- settle: a running load gives its slot back (fake clock) ----
{ const s = (ms, x = {}) => LQ.settle({ now: 100000 + ms, t0: 100000, ...x });
  t('settle: not before SETTLE_MS of quiet', s(LQ.SETTLE_MS - 1) === '' && s(LQ.SETTLE_MS) === 'DONE');
  t('settle: quiet counts from the last load activity', s(5000, { quiet: 100000 + 4000 }) === '' && s(5600, { quiet: 100000 + 4000 }) === 'DONE');
  t('settle: never while loading or a fix runs (before the caps)', s(20000, { loading: true }) === '' && s(20000, { fixing: true }) === '');
  t('settle: a fix still polling after CAP_MS gives the slot back (CAP); a load still loading does not', s(LQ.CAP_MS, { fixing: true }) === 'CAP' && s(LQ.CAP_MS, { loading: true, fixing: true }) === '');
  t('settle: still loading after HARD_MS -> STOP (main stops it, then it settles)', s(LQ.HARD_MS, { loading: true }) === 'STOP' && s(LQ.HARD_MS + 300, { fixing: true }) === 'CAP');
  t('settle: bad times -> busy', LQ.settle({ now: NaN, t0: 1 }) === '' && LQ.settle() === ''); }

// ---- ids from main's counter, codes ----
{ let n = 40; const q = LQ.createLoadQueue({ nextId: () => ++n });
  t('task ids come from the given counter (main: the per-launch number)', q.request({ ent: 1, onStart: () => {} }).task.id === 41);
  t('diagnostics: load.queue takes every queue code', J([...DG.LOAD_CODES].sort()) === J([...LQ.CODES].sort()) && LQ.CODES.every(c => DG.EVENTS['load.queue'].r.includes(c)));
  t('end codes are codes', LQ.END_CODES.every(c => LQ.CODES.includes(c))); }

// ---- main's wiring (contract with src/main.js) ----
{ const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const fn = name => { const i = main.indexOf(`function ${name}(`); if (i < 0) return ''; let d = 0, j = main.indexOf('{', main.indexOf(')', i)); for (; j < main.length; j++) { if (main[j] === '{') d++; else if (main[j] === '}' && --d === 0) break; } return main.slice(i, j + 1); };
  t('main: one queue for all windows, ids from the per-launch counter', /^const lq = LQ\.createLoadQueue\(\{ nextId: nextNo,/m.test(main) && !/\bloadQ\b|pumpLoads|const LOAD_CONC|loadStartedAt|loadDone/.test(main));
  // every load main starts is inside a queue task (or one of the named exceptions)
  const spans = [...main.matchAll(/function (\w+)\(/g)].map(m => ({ name: m[1], a: m.index, b: m.index + fn(m[1]).length }));
  const enclosing = i => (spans.filter(s => s.a < i && i < s.b).sort((x, y) => (x.b - x.a) - (y.b - y.a))[0] || {}).name || '';   // the innermost named function
  // (#72) main's own loadURL calls all go through appLoad(wc, url) (navigation-policy.js; NAV.appLoad(...) is only its check, not a load)
  const calls = [...main.matchAll(/\.loadURL\(|\.reload\(\)|loadInto\(|(?<![\w.])appLoad\(|\.goBack\(\)|\.goForward\(\)|\.loadFile\(/g)].filter(m => main.slice(m.index - 9, m.index) !== 'function ')
    .map(m => [m[0], enclosing(m.index), main.slice(m.index - 60, m.index + 60).replace(/\s+/g, ' ')]);
  const ALLOWED = { loadInto: 'its definition', appLoad: 'its definition (#72)', reloadPane: 'the reload / wake task body', fixLoad: 'part of a running load, else its own task', navTo: 'another URL: a task (new tab: local)', goHist: 'inside its task',
    openLink: 'inside its task', addPane: 'a task (new tab: local)', probePane: 'the background check task (own window)', sleepPane: 'about:blank: an unload', ensureApprove: '承認Bot popup (not a pane)',
    linkOpen: '承認Bot popup link (not a pane)', makeWindow: 'the window UI / overlay files', grokRefresh: 'Grok bar: its own hidden window (not a pane), one read at a time, by the Grok button only',
    usagePage: '使用量表示: its own hidden window in the provider\'s login partition (not a pane), one read at a time', usageConnect: '使用量表示: the provider\'s login window (not a pane)' };
  const stray = calls.filter(([, f]) => !Object.hasOwn(ALLOWED, f));
  t(`main: every load call is a queue task or a named exception (${calls.length} calls)`, calls.length >= 12 && stray.length === 0);
  if (stray.length) console.log('   stray:', stray);
  t('main: ...and the window UI / overlay are the only loads in makeWindow itself', calls.filter(([, f]) => f === 'makeWindow').every(([, , ctx]) => /index\.html|overlay\.html/.test(ctx)));
  t('main: the about:blank of a sleep is the only load in sleepPane', calls.filter(([, f]) => f === 'sleepPane').length === 1 && /canSleep[\s\S]*lqView\(p, false\)\) return false;/.test(fn('canSleep')));
  t('main: reload / wake / startup / new pane / URL / back-forward / link / fix all request a task', /viewLoad\(p, p\.sleeping \? 'WAKE' : 'RELOAD', cls,/.test(fn('reloadPane')) && /viewLoad\(p, defer \? 'START' : 'OPEN', defer \? 'BULK' : 'USER',/.test(fn('addPane'))
    && /viewLoad\(p, 'NAV', 'USER',/.test(fn('navTo')) && /viewLoad\(q, 'NAV', 'USER',/.test(fn('goHist')) && /viewLoad\(q, 'NAV', 'USER', url,/.test(fn('openLink')) && /viewLoad\(p, 'FIX',/.test(fn('fixLoad')));
  t('main: grokFix loads only through fixLoad', !/\.loadURL\(|(?<![\w.])appLoad\(/.test(fn('grokFix')) && (fn('grokFix').match(/fixLoad\(p, /g) || []).length === 2);
  t('main: the background check is a task of its own (BG, probe), one at a time', /purpose: 'PROBE', cls: 'BG', probe: true/.test(fn('probeNext')) && /onStart: t => probePane\(q, t\)/.test(fn('probeNext')));
  t('main: reload-all / automatic reloads / watchdog are BULK; the user\'s are USER (default)', /async function reloadPane\(p, cls = 'USER', task = null\)/.test(main) && /reloadPane\(p, 'BULK'\)/.test(fn('reloadAll')) && /reloadPane\(p, 'BULK'\)/.test(fn('autoReload'))
    && /'watchdog: blank bot pane -> reload'[^\n]*\n\s*reloadPane\(p, 'BULK'\);/.test(main));
  t('main: startup / workspace / reload-all request in one batch (the focused pane first)', /lq\.batch\(\(\) => \{\s*\n?\s*specs\.slice\(0, MAX\)\.forEach\(s => addPane\(s, \{ focus: false, defer: true(?:, asleep: restore \? restorePlan\(s\) : null)? \}\)\);/.test(main) && /lq\.batch\(/.test(fn('loadWorkspace')) && /lq\.batch\(/.test(fn('reloadAll'))
    && /rank: \(\) => panes\[focused\] === p \? 0 : 1/.test(fn('viewLoad')));
  t('main: closing a pane / a window cancels its loads; waking / reload-all / close abort the check through the queue', /disposePane\(p, 'CLOSED'\);/.test(fn('closePane')) && /lqDrop\(p, code\);/.test(fn('disposePane')) && /lq\.cancel\(t => t\.win === ctx, 'WINDOW'\);/.test(main)
    && /lq\.cancel\(t => t\.probe && t\.win === ctx && \(!p \|\| t\.ent === p\.obs\.ent\), 'ABORT'\);/.test(fn('abortProbe')));
  const poll = fn('lqPoll');
  t('main: a cancelled load gives its slot back only once it has stopped / its view is gone', /if \(t\.state === 'stop'\) \{ if \(gone \|\| !wc\.isLoading\(\)\) lqEnd\(run, 'STOPPED'\); continue; \}/.test(poll) && poll.indexOf("t.state === 'stop'") < poll.indexOf('LQ.settle('));
  t('main: a stop stops the real load (and its bot-page fix)', /wc\.stop\(\)/.test(fn('stopView')) && /p\.grokToken = null; p\.grokPending = null;/.test(fn('stopView')));
  t('main: the check gives its slot back after its window is destroyed (finally)', (pp => pp.indexOf('bw.destroy()') > pp.indexOf('finally') && /return why/.test(pp) === false)(fn('probePane')));
  const sv = fn('startView');
  t('main: a load that waited reads the input again right before it replaces a page (#11); no page / no wait -> starts at once', /if \(!t\.waited \|\| !hasPage\(p\)\) \{ begin\(\); return; \}/.test(sv) && /lqRecheck\(t, p\)\.then\(ok => \{ if \(ok\) begin\(\); else lqEnd\(run, 'GUARD'\); \}\);/.test(sv)
    && /GUARD\.expired\(/.test(fn('lqRecheck')) && /GUARD\.autoRefusal\(/.test(fn('lqRecheck')) && /await liveInput\(p\)/.test(fn('lqRecheck')));
  t('main: the guard hands its confirmed reading to the task, then forgets it', /p\.guardOk = x \? x\.r : null;/.test(fn('guardOnce')) && fn('guardOnce').indexOf('p.guardOk = x') < fn('guardOnce').indexOf('run(cur)') && /p\.guardOk = null;/.test(fn('guardOnce')) && /ok: p\.guardOk \|\| null/.test(fn('viewLoad')));
  t('main: a waiting load of a pane that moved to another page is cancelled (URL)', /lq\.cancel\(t\.id, 'URL'\)/.test(fn('addPane')) && /!isBlankUrl\(u\)/.test(fn('addPane')));
  t('main: the view stays hidden while its pane waits with nothing to show; the screen gets wait / position / held / idle', /p\.view\.setVisible\(!!t && !p\.sleeping && !viewHeld\(p\) && !dockHide\(\)\);/.test(fn('relayout'))
    && /lq: lt \? lt\.state : '', lqPos: /.test(fn('sendState')) && /held: viewHeld\(p\)/.test(fn('sendState')));
  t('main: the watchdog leaves queued / cancelled panes alone; auto-sleep never sleeps a pane with a load', /lqView\(p, false\) \|\| p\.loadIdle/.test(main) && /lqView\(p, false\)\) return false;/.test(fn('canSleep')));
  t('main: 取消 only cancels a waiting load of that pane', /^on\('load-cancel', id => \{ const p = byId\(id\); if \(p\) lq\.cancel\(t => t\.win === ctx && t\.ent === p\.obs\.ent && !t\.probe && t\.state === 'wait', 'USER'\); \}\);$/m.test(main));
  t('main: the queue never logs URLs / names (codes, pane numbers, ms only)', ![...main.matchAll(/diag\.rec\('load\.queue'([^\n]*)/g)].some(m => /url|\.name\b|title|getURL|String\(/.test(m[1])));
  t('IPC: load-cancel is a chrome channel for a pane of the window', IPC.CHANNELS['load-cancel'] && J(IPC.CHANNELS['load-cancel'].roles) === '["chrome"]'
    && IPC.check('load-cancel', { role: 'chrome', frame: { top: true, detached: false, url: require('url').pathToFileURL(IPC.DOCS.chrome).href, origin: 'file://' } }, [1], { owned: true, pane: i => i === 1 }) === null
    && IPC.check('load-cancel', { role: 'pane', frame: { top: true, detached: false, url: 'https://grok.com/bot/a', origin: 'https://grok.com' } }, [1], { owned: true, pane: () => true }) === 'E_ROLE'); }

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('test crashed', e); process.exit(1); });
