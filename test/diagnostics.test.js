// node test/diagnostics.test.js — diagnostics log (#73): only known events / result codes / bounded numbers are kept; secrets mixed into any
// input never reach the memory ring, the files, the screen rows or the copied summary; ring / rotation / age / clock limits hold; a failing or
// hostile disk never stops the log. fs: only its own directory under os.tmpdir() (errors injected per log).
const fs = require('fs'), os = require('os'), path = require('path');
const D = require('../src/diagnostics');
const IPC = require('../src/ipc-policy');
const NAV = require('../src/navigation-policy'), PERM = require('../src/permission-policy');
const NP = require('../src/notification-policy');
const CP = require('../src/closed-panes');
const BS = require('../src/broadcast-state');
const SS = require('../src/session-snapshot');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-diag-'));
let dirs = 0; const box = () => path.join(root, String(++dirs), 'diagnostics');
const J = JSON.stringify;
const SECRETS = ['sk-SECRET-TOKEN-123', 'https://grok.com/bot/secret-bot-id', '/Users/someone/Library/Application Support', '秘密の会話本文', 'sid=cookie-secret', 'Bearer xyz.secret', 'ボット名ひみつ', 'stack-at-secret.js:12'];
const S = SECRETS[0];
const leaks = s => SECRETS.filter(x => String(s).includes(x));
const manual = { set: () => null, clear: () => {} };                    // no timers: the tests call flushNow()
const err = (code, msg = S) => Object.assign(new Error(msg), code ? { code } : {});
const lines = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const KEYS = ['t', 'ev', 'r', 'ms', 'n', 'p'];
const onlyKeys = e => Object.keys(e).every(k => KEYS.includes(k));

(async () => {
  // ---- whitelist: event, result, fields ----
  {
    const e = D.sanitize('probe', 'SAME', { ms: 1234.4, n: 2, p: 3, extra: S, url: SECRETS[1], q: SECRETS[3] }, 1000);
    t('known event / result / fields kept, everything else dropped', J(e) === J({ t: 1000, ev: 'probe', r: 'SAME', ms: 1234, n: 2, p: 3 }));
    t('unknown / inherited / non-string event -> nothing', [S, '__proto__', 'toString', 'constructor', '', 5, null, undefined, {}].every(ev => D.sanitize(ev, 'OK', {}, 1) === null));
    t('unknown / inherited / secret result -> UNKNOWN', [S, 'toString', '__proto__', 'ok', '', 7, null, undefined, { r: 'OK' }].every(r => D.sanitize('pane.load', r, {}, 1).r === 'UNKNOWN'));
    t('a result of another event -> UNKNOWN', D.sanitize('probe', 'HANG', {}, 1).r === 'UNKNOWN' && D.sanitize('pane.hang', 'HANG', {}, 1).r === 'HANG');
    const f = v => D.sanitize('probe', 'SAME', v, 1);
    t('ms: finite 0..MS_MAX (rounded), else dropped', f({ ms: 0 }).ms === 0 && f({ ms: D.MS_MAX }).ms === D.MS_MAX && [-1, NaN, Infinity, '5', D.MS_MAX + 1, null, true, [5]].every(ms => !('ms' in f({ ms }))));
    t('n: integer 0..N_MAX, else dropped', f({ n: 0 }).n === 0 && f({ n: D.N_MAX }).n === D.N_MAX && [1.5, -1, D.N_MAX + 1, '2', NaN].every(n => !('n' in f({ n }))));
    t('p: integer 1..PANE_MAX (approve popup "approve" / 0 dropped)', f({ p: 1 }).p === 1 && [0, -1, 'approve', 1.5, D.PANE_MAX + 1, '3', S].every(p => !('p' in f({ p }))));
    t('fields not an object / an array / inherited -> none', [null, 'ms=5', [1, 2], 5].every(v => J(f(v)) === J({ t: 1, ev: 'probe', r: 'SAME' })) && !('ms' in f(Object.create({ ms: 5 }))));
    t('bad time -> 0', D.sanitize('app', 'START', {}, NaN).t === 0 && D.sanitize('app', 'START', {}, -5).t === 0 && D.sanitize('app', 'START', {}, 1.5).t === 0);
    t('events: lower-case names, upper-case result codes, a Japanese label each', Object.entries(D.EVENTS).every(([ev, x]) => /^[a-z]+(\.[a-z]+)?$/.test(ev) && x.r.every(r => /^[A-Z][A-Z0-9_]*$/.test(r)) && /[぀-ヿ一-鿿]/.test(x.ja)));
  }

  // ---- errors -> fixed codes (message / stack never read) ----
  {
    t('errCode: known fs / store codes', D.errCode(err('ENOSPC')) === 'ENOSPC' && D.errCode('EACCES') === 'EACCES' && D.errCode(err('EINVALID')) === 'EINVALID' && D.errCode({ code: 'EROFS' }) === 'EROFS');
    t('errCode: no / unknown / secret code -> UNKNOWN', [err(null), err(S), err('ERR_SOMETHING'), S, '', null, undefined, 5, {}, new Error('ENOSPC')].every(e => D.errCode(e) === 'UNKNOWN'));
    t('errCode: a throwing error object -> UNKNOWN', D.errCode(new Proxy({}, { get() { throw new Error(S); } })) === 'UNKNOWN');
    t('netCode: known Chromium errors, cert / http ranges', D.netCode(-105) === 'NET_DNS' && D.netCode(-3) === 'NET_ABORTED' && D.netCode(-118) === 'NET_TIMEOUT' && D.netCode(-106) === 'NET_OFFLINE' && D.netCode(-201) === 'NET_CERT' && D.netCode(-310) === 'NET_HTTP');
    t('netCode: anything else -> UNKNOWN', [-999, 0, 1, -1.5, '-105', NaN, null, S].every(n => D.netCode(n) === 'UNKNOWN'));
    t('goneCode: render-process-gone reasons', D.goneCode('crashed') === 'CRASHED' && D.goneCode('oom') === 'OOM' && D.goneCode('clean-exit') === 'CLEAN_EXIT' && [S, undefined, 'CRASHED', 'toString'].every(r => D.goneCode(r) === 'UNKNOWN'));
    t('every mapped code is a result the event accepts', D.NET_CODES.every(c => D.EVENTS['pane.load'].r.includes(c)) && D.GONE_CODES.every(c => D.EVENTS['pane.gone'].r.includes(c))
      && D.FS_CODES.every(c => D.EVENTS['state.save'].r.includes(c) && D.EVENTS['diag.disk'].r.includes(c)));
    t('IPC reject codes = ipc-policy.js REJECT', J([...D.IPC_CODES].sort()) === J(Object.keys(IPC.REJECT).sort()) && D.IPC_CODES.every(c => D.EVENTS['ipc.reject'].r.includes(c)));
    t('navigation / permission reject codes = navigation-policy.js / permission-policy.js REJECT (#72)', J([...D.NAV_CODES].sort()) === J(Object.keys(NAV.REJECT).sort()) && J([...D.PERM_CODES].sort()) === J(Object.keys(PERM.REJECT).sort())
      && D.NAV_CODES.every(c => D.EVENTS['nav.block'].r.includes(c)) && D.PERM_CODES.every(c => D.EVENTS['perm.deny'].r.includes(c)));
    t('notification codes = notification-policy.js CODES (#61)', J([...D.NOTIFY_CODES].sort()) === J([...NP.CODES].sort()) && D.NOTIFY_CODES.every(c => D.EVENTS.notify.r.includes(c)));
    t('reopen codes = closed-panes.js CODES (#23)', J([...D.REOPEN_CODES].sort()) === J([...CP.CODES].sort()) && D.REOPEN_CODES.every(c => D.EVENTS.reopen.r.includes(c)));
    t('broadcast codes = broadcast-state.js CODES (#12; no UNKNOWN among them)', J([...D.BCAST_CODES].sort()) === J([...BS.CODES].sort()) && D.BCAST_CODES.every(c => D.EVENTS.bcast.r.includes(c)) && !D.BCAST_CODES.includes('UNKNOWN'));
    t('restore codes = session-snapshot.js CODES (#22)', J([...D.RESTORE_CODES].sort()) === J([...SS.CODES].sort()) && D.RESTORE_CODES.every(c => D.EVENTS.restore.r.includes(c)));
    t('settings view: restoreSleep / saveQuote booleans only (#22)', J(D.safeEnv({ settings: { restoreSleep: true, saveQuote: 'x' } }).settings) === J({ restoreSleep: true }));
  }

  // ---- ring ----
  {
    const r = D.createRing(5); for (let i = 0; i < 7; i++) r.push(i);
    t('ring: keeps the newest max, in order, counts what fell out', J(r.list()) === J([2, 3, 4, 5, 6]) && r.size === 5 && r.dropped === 2);
    let now = 1e12; const dg = D.createDiag({ timers: manual, wall: () => now, mono: () => now });
    for (let i = 0; i < D.RING_MAX + 5; i++) { now++; dg.rec('watchdog', 'RELOAD', { n: i % 100, p: 1 }); }
    const es = dg.entries(), st = dg.stats();
    t(`log: memory holds ${D.RING_MAX} entries, oldest first`, es.length === D.RING_MAX && es[0].t === 1e12 + 6 && es[es.length - 1].t === 1e12 + D.RING_MAX + 5);
    t('log: totals count everything, overflow counted', st.total === D.RING_MAX + 5 && st.dropped === 5 && st.size === D.RING_MAX && J(st.counts) === J([['watchdog', 'RELOAD', D.RING_MAX + 5]]));
  }

  // ---- counters, UNKNOWN, rejected, throttled repeats, never throws ----
  {
    let now = 5e12; const dg = D.createDiag({ timers: manual, wall: () => now, mono: () => now });
    t('rec: true for a known event, false for an unknown one', dg.rec('pane.load', 'OK', { p: 1 }) === true && dg.rec(S, 'OK') === false);
    dg.rec('pane.load', S, { p: 1 }); dg.rec('state.save', D.errCode(err(null)));
    const st = dg.stats();
    t('unknown results -> UNKNOWN and counted; unknown events counted as rejected', st.unknown === 2 && st.rejected === 1 && st.total === 3
      && st.counts.some(([ev, r, n]) => ev === 'pane.load' && r === 'UNKNOWN' && n === 1));
    for (let i = 0; i < 5; i++) { now += 1000; dg.rec('draft', 'PRESENT', { p: 2 }, 600000); }
    dg.rec('draft', 'PRESENT', { p: 3 }, 600000);
    const kept = dg.entries().filter(e => e.ev === 'draft');
    t('throttle: every call counted, one entry per event + result + pane per period', kept.length === 2 && dg.stats().counts.find(c => c[0] === 'draft')[2] === 6);
    now += 600000; dg.rec('draft', 'PRESENT', { p: 2 }, 600000);
    t('throttle: kept again after the period', dg.entries().filter(e => e.ev === 'draft').length === 3);
    let threw = false;
    const boom = () => { throw new Error(S); };
    try { t('rec with fields that throw while read -> false', dg.rec('probe', 'SAME', new Proxy({}, { get: boom, getOwnPropertyDescriptor: boom, has: boom })) === false); } catch { threw = true; }
    t('rec never throws (getter throws, odd arguments)', !threw && (() => { try { dg.rec(); dg.rec(null, null, null, null); dg.rec('probe', 'SAME', undefined, NaN); return true; } catch { return false; } })());
    t('nothing secret in memory', !leaks(J(dg.entries())).length && dg.entries().every(onlyKeys));
  }

  // ---- rotation plan (pure) ----
  {
    const now = 1e12, d = 86400000, F = (name, size, age = 0) => ({ name, size, mtimeMs: now - age });
    const pl = (files, incoming, o = {}) => D.planRotation({ files, now, incoming, fileMax: 1000, ...o });
    t('empty directory: append to diag-0, nothing else', J(pl([], 10)) === J({ unlink: [], rename: [], target: 'diag-0.jsonl', rotate: false }));
    t('room left: no rotation', !pl([F('diag-0.jsonl', 900)], 100).rotate);
    t('diag-0 would pass the size: diag-0 -> diag-1', J(pl([F('diag-0.jsonl', 950)], 100)) === J({ unlink: [], rename: [['diag-0.jsonl', 'diag-1.jsonl']], target: 'diag-0.jsonl', rotate: true }));
    t('three generations: the oldest goes, then 1 -> 2, 0 -> 1', J(pl([F('diag-2.jsonl', 1000), F('diag-0.jsonl', 990), F('diag-1.jsonl', 1000)], 20)) === J({ unlink: ['diag-2.jsonl'], rename: [['diag-1.jsonl', 'diag-2.jsonl'], ['diag-0.jsonl', 'diag-1.jsonl']], target: 'diag-0.jsonl', rotate: true }));
    t('gap (0 and 2): 2 removed, 0 -> 1', J(pl([F('diag-0.jsonl', 1000), F('diag-2.jsonl', 5)], 1)) === J({ unlink: ['diag-2.jsonl'], rename: [['diag-0.jsonl', 'diag-1.jsonl']], target: 'diag-0.jsonl', rotate: true }));
    t('older than 7 days: removed (not rotated)', J(pl([F('diag-0.jsonl', 10, 8 * d), F('diag-1.jsonl', 10, 7 * d + 1), F('diag-2.jsonl', 10, 6 * d)], 1).unlink) === J(['diag-0.jsonl', 'diag-1.jsonl']));
    t('exactly 7 days / dated in the future: kept', pl([F('diag-0.jsonl', 10, 7 * d), F('diag-1.jsonl', 10, -30 * d)], 1).unlink.length === 0);
    t('generations beyond the limit: removed', J(pl([F('diag-3.jsonl', 1), F('diag-9.jsonl', 1)], 1).unlink) === J(['diag-3.jsonl', 'diag-9.jsonl']));
    const foreign = ['pane-debug.log', 'diag-0.jsonl.bak', 'diag-10.jsonl', 'diag-a.jsonl', 'notes.txt', 'panes.json', 'xdiag-0.jsonl'].map(n => F(n, 5e6, 30 * d));
    t('other files (old, huge, similar names) are never touched', J(pl(foreign, 10)) === J({ unlink: [], rename: [], target: 'diag-0.jsonl', rotate: false }));
    t('an empty diag-0 is used even for a big write', !pl([F('diag-0.jsonl', 0)], 5000).rotate);
    t('one generation: a full diag-0 is replaced', J(pl([F('diag-0.jsonl', 1000)], 1, { gens: 1 })) === J({ unlink: ['diag-0.jsonl'], rename: [], target: 'diag-0.jsonl', rotate: true }));
    t('defaults: 2 MiB, 3 generations, 7 days', D.FILE_MAX === 2 * 1024 * 1024 && D.GENERATIONS === 3 && D.MAX_AGE_MS === 7 * d && D.RING_MAX === 1000);
  }

  // ---- clock: never backwards ----
  {
    const W = [1000, 2000, 1500, 1600, 3000], M = [0, 1000, 1100, 1200, 2000]; let i = -1;
    const c = D.createClock(() => W[i], () => M[i]), seq = W.map(() => { i++; return c(); });
    t('wall clock set back: continues from the monotonic clock, then follows the wall again', J(seq) === J([1000, 2000, 2100, 2200, 3000]));
    let w = 5000, m = 0; const c2 = D.createClock(() => w, () => m);
    const a = c2(); w = NaN; m = 250; const b = c2(); w = 9e9; m = 300; const x = c2(); m = 'x'; w = 1; const y = c2();
    t('invalid wall clock -> monotonic; a jump forward is taken; broken monotonic clock -> no step back', a === 5000 && b === 5250 && x === 9e9 && y === 9e9);
    const c3 = D.createClock(() => { throw new Error(S); }, () => { throw new Error(S); });
    t('throwing clocks -> 0, never throws', c3() === 0 && c3() === 0);
  }

  // ---- files: written only when switched on, owner-only, rotated, aged, other files left alone ----
  {
    const dir = box(), dg = D.createDiag({ timers: manual });
    dg.rec('app', 'START'); dg.rec('state.load', 'READY', { n: 0 });
    t('off by default: nothing on disk', !fs.existsSync(dir) && dg.diskInfo().on === false && await dg.flushNow() === false);
    dg.setDisk('relative/dir'); t('a relative directory is refused', dg.diskInfo().on === false);
    dg.setDisk(dir); dg.rec('probe', 'SAME', { ms: 5230, n: 1, p: 3 });
    t('flush writes', await dg.flushNow() === true);
    const f0 = path.join(dir, 'diag-0.jsonl'), ls = lines(f0);
    t('what happened before it was switched on comes first, then ON, then new entries', J(ls.map(e => `${e.ev} ${e.r}`)) === J(['app START', 'state.load READY', 'diag.disk ON', 'probe SAME']));
    t('one JSON object per line with the allowed keys only', ls.every(onlyKeys) && ls[3].ms === 5230 && ls[3].p === 3);
    t('directory 0700, file 0600', (fs.statSync(dir).mode & 0o777) === 0o700 && (fs.statSync(f0).mode & 0o777) === 0o600);
    const dir2 = box(); fs.mkdirSync(dir2, { recursive: true }); fs.chmodSync(dir2, 0o755);
    const dg2 = D.createDiag({ timers: manual }); dg2.setDisk(dir2); await dg2.flushNow();
    t('an existing directory is tightened to 0700', (fs.statSync(dir2).mode & 0o777) === 0o700);
    t('screen / summary never show the directory path', !J(dg.view({})).includes(root) && !dg.summary({}).includes(root));
    dg.setDisk(dir); dg.rec('probe', 'SAME');
    t('setDisk with the same directory again: no duplicate backlog', (await dg.flushNow(), lines(f0).length === 5));
    const size = fs.statSync(f0).size;
    dg.setDisk(null); dg.rec('probe', 'CHANGED'); await dg.flushNow();
    t('switched off: files stay, nothing more is written, OFF noted in memory', fs.existsSync(f0) && fs.statSync(f0).size === size && dg.entries().some(e => e.ev === 'diag.disk' && e.r === 'OFF'));
    dg.setDisk(dir); await dg.flushNow();
    const after = lines(f0).map(e => `${e.ev} ${e.r}`);
    t('switched on again: only what was not written yet', J(after.slice(5)) === J(['diag.disk OFF', 'probe CHANGED', 'diag.disk ON']));
  }
  {
    const dir = box(), dg = D.createDiag({ timers: manual, fileMax: 400 });
    dg.setDisk(dir);
    for (let i = 0; i < 60; i++) { dg.rec('probe', 'SAME', { ms: i, n: 1, p: 2 }); await dg.flushNow(); }
    const names = fs.readdirSync(dir).sort();
    t('rotation: at most 3 files', J(names) === J(['diag-0.jsonl', 'diag-1.jsonl', 'diag-2.jsonl']));
    t('rotation: every file within the size limit', names.every(n => fs.statSync(path.join(dir, n)).size <= 400));
    const newest = lines(path.join(dir, 'diag-0.jsonl')), older = lines(path.join(dir, 'diag-2.jsonl'));
    t('rotation: newest entries in diag-0, older ones in diag-2, the oldest are gone', newest[newest.length - 1].ms === 59 && older[0].ms > 0 && older[older.length - 1].ms < newest[0].ms);
  }
  {
    const dir = box(); fs.mkdirSync(dir, { recursive: true });
    const old = (Date.now() - 8 * 86400000) / 1000;
    for (const n of ['diag-1.jsonl', 'diag-2.jsonl', 'pane-debug.log', 'keep.txt', 'diag-1.jsonl.bak']) { fs.writeFileSync(path.join(dir, n), '{}\n'); fs.utimesSync(path.join(dir, n), old, old); }
    fs.writeFileSync(path.join(dir, 'diag-0.jsonl'), '{}\n');
    const dg = D.createDiag({ timers: manual }); dg.setDisk(dir); await dg.flushNow();
    const names = fs.readdirSync(dir).sort();
    t('age: our files older than 7 days removed; the recent one kept; other files untouched', J(names) === J(['diag-0.jsonl', 'diag-1.jsonl.bak', 'keep.txt', 'pane-debug.log']));
  }

  // ---- a failing / hostile disk: noted once per streak, the log goes on, retried later ----
  {
    const dir = box(), x = { ...fs, promises: { ...fs.promises } }, open0 = fs.promises.open;
    x.promises.open = async () => { throw err('ENOSPC', `no space left on ${SECRETS[2]} ${S}`); };
    const delays = [], dg = D.createDiag({ fs: x, timers: { set: (fn, ms) => { delays.push(ms); return null; }, clear: () => {} } });
    dg.setDisk(dir); dg.rec('probe', 'SAME', { p: 1 });
    t('failed write -> false, no throw', await dg.flushNow() === false);
    t('state fail, fixed code, counted', dg.diskInfo().state === 'fail' && dg.diskInfo().code === 'ENOSPC' && dg.diskInfo().failures === 1);
    t('retry is scheduled later (about a minute), not at once', delays.length > 0 && delays[delays.length - 1] > 59000);
    for (let i = 0; i < 5; i++) { dg.rec('probe', 'SAME', { p: 1 }); await dg.flushNow(); }
    const noted = dg.entries().filter(e => e.ev === 'diag.disk' && e.r === 'ENOSPC');
    t('a failure streak is noted once, not once per failure', noted.length === 1 && dg.diskInfo().failures === 6);
    t('the memory log keeps working while the disk fails', dg.entries().filter(e => e.ev === 'probe').length === 6);
    t('retry delay grows, capped', delays[delays.length - 1] > delays[0] && delays.every(ms => ms <= 15 * 60000));
    t('the error text never shows up', !leaks(J(dg.entries()) + dg.summary({}) + J(dg.view({}))).length && dg.summary({}).includes('code=ENOSPC'));
    x.promises.open = open0;
    dg.rec('probe', 'CHANGED', { p: 1 });
    t('disk back: written again', await dg.flushNow() === true && dg.diskInfo().state === 'ok');
    t('recovery noted', dg.entries().some(e => e.ev === 'diag.disk' && e.r === 'RECOVERED'));
    t('lines that could not be written were dropped and counted (no endless re-queue)', dg.diskInfo().dropped > 0 && lines(path.join(dir, 'diag-0.jsonl')).every(onlyKeys));
  }
  {
    const x = { ...fs, promises: { ...fs.promises, mkdir: () => { throw err('EACCES'); } } };
    const dg = D.createDiag({ fs: x, timers: manual }); dg.setDisk(box()); dg.rec('probe', 'SAME');
    t('fs that throws synchronously: flush resolves false', await dg.flushNow() === false && dg.diskInfo().code === 'EACCES');
    const dg2 = D.createDiag({ fs: {}, timers: manual }); dg2.setDisk(box()); dg2.rec('probe', 'SAME');
    t('fs without promises: flush resolves false, UNKNOWN', await dg2.flushNow() === false && dg2.diskInfo().code === 'UNKNOWN');
    const dg3 = D.createDiag({ timers: { set: () => { throw new Error('timer'); }, clear: () => { throw new Error('timer'); } } });
    t('timers that throw: rec / setDisk still fine', dg3.rec('probe', 'SAME') === true && (() => { try { dg3.setDisk(box()); dg3.setDisk(null); return true; } catch { return false; } })());
  }
  {
    const dir = box(); fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(root, 'outside.txt'); fs.writeFileSync(outside, 'keep\n');
    fs.symlinkSync(outside, path.join(dir, 'diag-0.jsonl'));
    const dg = D.createDiag({ timers: manual }); dg.setDisk(dir); dg.rec('probe', 'SAME');
    t('a symlink in place of diag-0 is never written through', await dg.flushNow() === false && fs.readFileSync(outside, 'utf8') === 'keep\n' && dg.diskInfo().state === 'fail');
  }
  {
    const dir = box(), dg = D.createDiag({ timers: manual, queueMax: 10 });
    dg.setDisk(dir); for (let i = 0; i < 50; i++) dg.rec('probe', 'SAME', { n: i });
    t('pending lines bounded (oldest dropped, counted)', dg.diskInfo().queued === 10 && dg.diskInfo().dropped === 41);
    await dg.flushNow();
    const ls = lines(path.join(dir, 'diag-0.jsonl'));
    t('the newest pending lines are written', ls.length === 10 && ls[9].n === 49);
  }

  // ---- secrets mixed into every input: not stored, not written, not shown, not copied; allowed items stay ----
  {
    const dir = box(), dg = D.createDiag({ timers: manual }); dg.setDisk(dir);
    for (const s of SECRETS) {
      dg.rec(s, 'OK'); dg.rec('pane.load', s, { p: 1 }); dg.rec('probe', 'SAME', { ms: s, n: s, p: s, [s]: s, url: s, q: s, name: s, message: s, stack: s, headers: { cookie: s } });
      dg.rec('state.save', D.errCode(err(null, s))); dg.rec('pane.load', D.netCode(s)); dg.rec('pane.gone', D.goneCode(s)); dg.rec('state.save', D.errCode({ code: s, message: s }));
    }
    dg.rec('probe', 'SAME', { ms: 812, n: 2, p: 4 }); dg.rec('pane.load', D.netCode(-105), { p: 1, ms: 30 });
    await dg.flushNow();
    const env = {
      versions: { app: '1.0.0', electron: '44.7.2', chrome: '140.0.7339.80', node: '22.19.0', os: '15.6.1', extra: S }, platform: 'darwin', arch: 'arm64', packaged: false,
      settings: { notifications: true, ecoMode: false, grokFix: false, theme: 'dark', memSaver: 'std', globalZoom: 1.1, diagPersist: true, sleepMinutes: S, usageMargin: 5, name: SECRETS[6], usageBase: { day: S }, splits: { [S]: 1 } },
      counts: { windows: 1, panes: 8, bots: 6, sleeping: 3, names: [SECRETS[6]] },
      store: { status: 'ready', saveError: SECRETS[2], frozen: false, file: SECRETS[2] },
      url: SECRETS[1], cookie: SECRETS[4], quote: SECRETS[3],
    };
    const evil = { versions: { app: S, electron: SECRETS[2], chrome: '1.0 ' + S, os: '../' + S }, platform: S, arch: S, packaged: S, settings: { theme: S, memSaver: S, globalZoom: S, notifications: S }, counts: { panes: S }, store: { status: S, saveError: S } };
    const files = fs.readdirSync(dir).map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
    const out = { memory: J(dg.entries()), files, view: J(dg.view(env)), summary: dg.summary(env), viewEvil: J(dg.view(evil)), summaryEvil: dg.summary(evil) };
    for (const [k, v] of Object.entries(out)) t(`no secret in ${k}`, leaks(v).length === 0);
    t('files: allowed keys only', lines(path.join(dir, 'diag-0.jsonl')).every(onlyKeys));
    const sum = out.summary;
    t('summary keeps the allowed items (versions, settings, counts, store, entries)', sum.includes('app 1.0.0') && sum.includes('Electron 44.7.2') && sum.includes('darwin arm64 15.6.1') && sum.includes('theme=dark') && sum.includes('notifications=on')
      && sum.includes('grokFix=off') && sum.includes('globalZoom=1.1') && sum.includes('panes=8') && sum.includes('構成の保存: ready saveError=UNKNOWN') && /probe .*SAME=\d+/.test(sum) && sum.includes('pane.load') && sum.includes('NET_DNS=1') && / probe SAME ms=812 n=2 p=4/.test(sum));
    t('summary: invalid values dropped, not cut or masked', !sum.includes('sleepMinutes') && !sum.includes('usageBase') && !sum.includes('splits') && !/\*{3}|\[redacted\]/i.test(sum));
    t('ecoMode (kept in panes.json, no effect) is not shown', !sum.includes('ecoMode') && !J(dg.view(env)).includes('省電力'));
    const rows = dg.view(env).rows;
    t('screen rows: version, settings, counts, save state', rows.every(r => typeof r.sec === 'string' && typeof r.label === 'string' && typeof r.sub === 'string')
      && rows.some(r => r.sec === 'バージョン' && r.label.includes('アプリ 1.0.0')) && rows.some(r => r.sec === '設定' && r.label.includes('通知'))
      && rows.some(r => r.label.includes('スリープ中の新着確認（probe）') && r.sub.includes('SAME')) && rows.some(r => r.sec === '保存状態' && r.label.includes('ファイルにも保存')));
    t('summary: the last 20 entries only', sum.split('\n').filter(l => /^ {2}\d{4}-\d\d-\d\dT/.test(l)).length === 20);
    t('view tells whether the setting is on', dg.view(env).persist === true && dg.view({}).persist === false);
  }

  // ---- contract with main.js: every recorded event / literal result is known, no content goes in ----
  {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const calls = [];
    for (let i = main.indexOf('diag.rec('); i >= 0; i = main.indexOf('diag.rec(', i + 1)) {
      let d = 0, j = i + 8; for (; j < main.length; j++) { if (main[j] === '(') d++; else if (main[j] === ')' && --d === 0) break; }
      calls.push(main.slice(i + 9, j));
    }
    const lit = calls.map(c => c.match(/^'([^']+)'(?:,\s*'([^']+)')?/)).filter(Boolean);
    t(`main.js: ${calls.length} diag.rec calls, every event a literal known one`, calls.length >= 25 && lit.length === calls.length && lit.every(m => Object.hasOwn(D.EVENTS, m[1])));
    t('main.js: every literal result is one its event accepts', lit.every(m => !m[2] || m[2] === 'UNKNOWN' || D.EVENTS[m[1]].r.includes(m[2])));
    t('main.js: no URL / title / name / text / error message / stack passed to diag', calls.every(c => !/getURL|\burl\b|\.url\b|title|\.name\b|text|quote|reqQuote|message|stack|String\(|JSON\.|desc|paneUrl|target/.test(c)));
    const whys = [...main.matchAll(/why = '(\w+)'/g)].map(m => m[1].toUpperCase());
    t(`main.js: probe outcomes map to known results (${whys.join(' ')})`, whys.length >= 4 && whys.every(w => w === 'OK' || D.EVENTS.probe.r.includes(w)));
    t('state-store load reasons map to known results', ['read', 'json', 'invalid'].every(r => D.EVENTS['state.load'].r.includes(`RECOVERY_${r.toUpperCase()}`)));
    t('main.js: files only with the setting / MPB_DEBUG, in userData/diagnostics', /function diagSync\(\) \{[^\n]*settings\.diagPersist === true \|\| forced \? path\.join\(app\.getPath\('userData'\), 'diagnostics'\) : null/.test(main));
    t('main.js: the summary goes to the clipboard only after the dialog', /if \(response === 0\) clipboard\.writeText\(text\);/.test(main) && !/net\.request|https?\.request|fetch\(/.test(main.slice(main.indexOf('function diagEnv'), main.indexOf('function startup'))));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('test crashed', e); process.exit(1); });
