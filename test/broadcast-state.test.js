// node test/broadcast-state.test.js — #12 一斉送信の安全化. The pure part (src/broadcast-state.js): how one chosen pane is judged for the preview
// (with real #11 readings from draft-guard.js), the preview / one batch per preview (a second press / key repeat), what moved since the preview,
// every state change of a target and what cancel may still stop, the page evidence that makes a send 確認済み, the screen's labels. Then a small
// model of main's per-target run with a stub page adapter (double press, a moved target, a draft, a failure before the send, no evidence after
// it, partial success, cancel) and the contract with src/main.js / overlay.js / diagnostics.js.
// Not covered here: a real Grok page (its composer, its send button, what it shows after a send) - that needs the manual check, which must
// stop at the preview (nothing is sent to a real conversation by any test).
const fs = require('fs'), path = require('path');
const BS = require('../src/broadcast-state');
const G = require('../src/draft-guard');
const DG = require('../src/diagnostics');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const NOW = 1_000_000;
const STAMP = { ent: 1, gen: 2, rev: 0, closed: false, sleeping: false };
const RAW = { empty: { d: 'empty', text: false, att: false, up: false, n: 1, fp: 'e' }, text: { d: 'present', text: true, att: false, up: false, n: 1, fp: 't' },
  att: { d: 'present', text: false, att: true, up: false, n: 1, fp: 'a' }, up: { d: 'present', text: false, att: true, up: true, n: 1, fp: 'u' }, none: { d: 'none', text: false, att: false, up: false, n: 0, fp: '' } };
const rd = (raw, c = {}) => G.read(raw, { page: true, before: STAMP, after: STAMP, at: NOW, expect: true, ...c });
const F = (o = {}) => ({ open: true, bot: 'abc123', sleeping: false, r: rd(RAW.empty), cur: true, loading: false, ...o });

// ---- one chosen pane, now ----
t('classify: an empty composer of a confirmed bot conversation -> READY', J(BS.classify(F())) === J({ st: 'READY', why: '' }));
t('classify: asleep on a bot conversation -> WAKE (not read; woken at the send)', J(BS.classify(F({ sleeping: true, r: null, cur: false }))) === J({ st: 'WAKE', why: '' }));
t('classify: typed text / attachment / upload / IME -> skipped with that reason', BS.classify(F({ r: rd(RAW.text) })).why === 'PRESENT' && BS.classify(F({ r: rd(RAW.att) })).why === 'ATTACH'
  && BS.classify(F({ r: rd(RAW.up) })).why === 'ATTACH' && BS.classify(F({ r: rd(RAW.empty, { ime: true }) })).why === 'IME' && BS.classify(F({ r: rd(RAW.text, { ime: true }) })).why === 'PRESENT');
t('classify: a draft is reported even while loading (what would be lost first)', BS.classify(F({ r: rd(RAW.text), loading: true })).why === 'PRESENT' && BS.classify(F({ r: rd(RAW.empty), loading: true })).why === 'LOADING');
t('classify: unknown reading (timeout / moved while read / no composer where one must be) -> UNKNOWN', BS.classify(F({ r: rd(null) })).why === 'UNKNOWN'
  && BS.classify(F({ r: rd(RAW.empty, { after: { ...STAMP, rev: 1 } }) })).why === 'UNKNOWN' && BS.classify(F({ r: rd(RAW.none) })).why === 'UNKNOWN' && BS.classify(F({ r: null })).why === 'UNKNOWN');
t('classify: a #11 confirmation open for it / another broadcast -> BUSY; this broadcast\'s own mark is not a reason', BS.classify(F({ r: rd(RAW.empty, { hold: true }) })).why === 'BUSY'
  && BS.classify(F({ r: rd(RAW.empty, { busy: true }) })).why === 'BUSY' && BS.classify(F({ r: rd(RAW.empty, { busy: true }), own: true })).st === 'READY');
t('classify: not a bot conversation / no composer on the page / conversation not confirmed in this generation -> UNAVAILABLE', BS.classify(F({ bot: '' })).why === 'UNAVAILABLE'
  && BS.classify(F({ r: rd(RAW.none, { expect: false }) })).why === 'UNAVAILABLE' && BS.classify(F({ cur: false })).why === 'UNAVAILABLE' && BS.classify(F({ r: G.read(null, { page: false }) })).why === 'UNAVAILABLE');
t('classify: closed / junk -> GONE; asleep but not a bot page -> UNAVAILABLE', BS.classify(F({ open: false })).why === 'GONE' && BS.classify(null).why === 'GONE' && BS.classify(F({ sleeping: true, bot: '' })).why === 'UNAVAILABLE');
t('text: empty / blank / too long refused; up to TEXT_MAX ok', BS.textError('') === 'EMPTY' && BS.textError(' \n ') === 'EMPTY' && BS.textError(5) === 'EMPTY' && BS.textError('x'.repeat(BS.TEXT_MAX + 1)) === 'LONG' && BS.textError('x'.repeat(BS.TEXT_MAX)) === '');
t('conversation shown short (never the whole URL)', BS.shortConv('abc') === 'bot/abc' && BS.shortConv('abcdefghijklmnopqrstuvwxyz') === 'bot/abcde…wxyz' && BS.shortConv('') === '');

// ---- preview -> one batch ----
const it = (id, st = 'READY', o = {}) => ({ id, ent: id * 10, gen: id * 10 + 1, rev: 0, cid: `bot${id}`, sleeping: st === 'WAKE', label: `ペイン${id}`, conv: BS.shortConv(`bot${id}`), st, why: st === 'SKIP' ? 'PRESENT' : '', ...o });
const PV = BS.preview(7, '本文', [it(1), it(2, 'SKIP'), it(3, 'WAKE'), it(4)]);
t('preview: N = READY + WAKE, skipped ones listed with their reason', PV.n === 3 && PV.items.length === 4 && PV.items[1].why === 'PRESENT' && PV.err === '');
t('preview: a text error -> nothing to send', BS.preview(8, '', [it(1)], 'EMPTY').n === 0 && BS.preview(8, '', [it(1)], 'EMPTY').items.length === 0);
t('admit: the preview on screen -> go', BS.admit({ preview: PV, batch: null }, 7) === '');
t('admit: not the preview on screen / none / nothing to send -> STALE', BS.admit({ preview: PV }, 6) === 'STALE' && BS.admit({}, 7) === 'STALE' && BS.admit(null, 7) === 'STALE'
  && BS.admit({ preview: BS.preview(9, 'x', [it(1, 'SKIP')]) }, 9) === 'STALE' && BS.admit({ preview: BS.preview(9, '', [], 'LONG') }, 9) === 'STALE');
const B0 = BS.batch(PV, 70, NOW);
t('batch: targets WAIT, a preview skip stays skipped (pre), the text kept for this batch only', J(B0.items.map(x => x.st)) === J(['WAIT', 'SKIP', 'WAIT', 'WAIT']) && B0.items[1].pre && !B0.items[0].pre && B0.text === '本文' && B0.pid === 7 && B0.bid === 70);
t('admit: the same preview again (second press / key repeat) -> DUP, while running and after it ended', BS.admit({ preview: null, batch: B0 }, 7) === 'DUP' && BS.admit({ preview: PV, batch: B0 }, 7) === 'DUP');
t('admit: another preview while a batch runs -> BUSY; after it ended -> go', BS.admit({ preview: BS.preview(9, 'x', [it(1)]), batch: B0 }, 9) === 'BUSY'
  && BS.admit({ preview: BS.preview(9, 'x', [it(1)]), batch: { ...B0, items: B0.items.map(x => ({ ...x, st: 'OK' })) } }, 9) === '');

// ---- what moved since the preview ----
const NOWP = x => ({ open: true, closed: false, ent: x.ent, gen: x.gen, rev: x.rev, cid: x.cid, sleeping: x.sleeping });
{ const x = B0.items[0];
  t('moved: the same pane / generation / conversation / keys typed / awake -> nothing', BS.moved(x, NOWP(x)) === '');
  t('moved: another generation / conversation / key typed / asleep now / another entity -> CHANGED', ['gen', 'cid', 'rev', 'ent'].every(k => BS.moved(x, { ...NOWP(x), [k]: k === 'cid' ? 'other' : x[k] + 1 }) === 'CHANGED')
    && BS.moved(x, { ...NOWP(x), sleeping: true }) === 'CHANGED');
  t('moved: closed / gone -> GONE', BS.moved(x, { ...NOWP(x), open: false }) === 'GONE' && BS.moved(x, { ...NOWP(x), closed: true }) === 'GONE' && BS.moved(x, null) === 'GONE'); }

// ---- a target's states ----
const S = (b, a) => BS.step(b, a);
{ let r = S(B0, { type: 'begin', id: 1 }); const b1 = r.b;
  t('begin: WAIT -> PREP (a new batch object; the old one unchanged)', r.code === '' && BS.item(b1, 1).st === 'PREP' && BS.item(B0, 1).st === 'WAIT');
  t('begin: twice / an asleep target without its woken generation / a woken one for an awake target -> STATE', S(b1, { type: 'begin', id: 1 }).code === 'STATE' && S(b1, { type: 'begin', id: 3 }).code === 'STATE'
    && S(b1, { type: 'begin', id: 4, wake: { gen: 99, rev: 0 } }).code === 'STATE');
  r = S(b1, { type: 'begin', id: 3, wake: { gen: 55, rev: 2 } });
  t('begin: an asleep target takes the generation it woke into (awake from then on)', r.code === '' && BS.item(r.b, 3).gen === 55 && BS.item(r.b, 3).rev === 2 && BS.item(r.b, 3).sleeping === false && BS.item(r.b, 3).woke === true);
  t('send before input -> STATE; input then send -> SENT', S(b1, { type: 'send', id: 1 }).code === 'STATE' && BS.item(S(S(b1, { type: 'input', id: 1 }).b, { type: 'send', id: 1 }).b, 1).st === 'SENT');
  const sent = S(S(b1, { type: 'input', id: 1 }).b, { type: 'send', id: 1 }).b;
  t('SENT: no skip / begin / input any more (a started send is never "not sent")', ['skip', 'begin', 'input', 'send'].every(k => S(sent, { type: k, id: 1, why: 'CHANGED' }).code === 'STATE'));
  t('SENT -> OK (evidence) / UNSURE (with a reason) / SKIP NOT_SENT only when the page said it did not click', BS.item(S(sent, { type: 'confirm', id: 1 }).b, 1).st === 'OK'
    && BS.item(S(sent, { type: 'unsure', id: 1, why: 'TIMEOUT' }).b, 1).st === 'UNSURE' && J(BS.item(S(sent, { type: 'notsent', id: 1 }).b, 1)).includes('"why":"NOT_SENT"'));
  t('final states stay final', ['confirm', 'unsure', 'notsent', 'skip', 'begin'].every(k => S(S(sent, { type: 'confirm', id: 1 }).b, { type: k, id: 1, why: 'TIMEOUT' }).code !== ''));
  t('unknown reasons / items / actions are refused', S(b1, { type: 'skip', id: 1, why: 'NOPE' }).code === 'BAD_WHY' && S(sent, { type: 'unsure', id: 1, why: 'toString' }).code === 'BAD_WHY'
    && S(b1, { type: 'skip', id: 9, why: 'GONE' }).code === 'NO_ITEM' && S(b1, { type: 'eval' }).code === 'BAD_ACTION' && S(null, { type: 'cancel' }).code === 'BAD_ACTION' && S(b1, null).code === 'BAD_ACTION'); }

// ---- cancel: only what has not been typed ----
{ let b = S(B0, { type: 'begin', id: 1 }).b; b = S(b, { type: 'input', id: 1 }).b; b = S(b, { type: 'begin', id: 4 }).b;     // 1 typed, 4 being read, 3 waiting (asleep)
  const r = S(b, { type: 'cancel' }), c = r.b;
  t('cancel: waiting + read-but-not-typed -> SKIP CANCEL (n = 2); the typed one goes on', r.n === 2 && BS.item(c, 3).why === 'CANCEL' && BS.item(c, 4).why === 'CANCEL' && BS.item(c, 1).st === 'PREP' && c.cancelled);
  t('cancel: nothing begins afterwards; the typed one may still send', S(c, { type: 'begin', id: 3 }).code === 'STATE' && S(c, { type: 'send', id: 1 }).code === '' && !BS.cancellable(c));
  t('cancel: a preview skip keeps its own reason', BS.item(c, 2).why === 'PRESENT'); }

// ---- page evidence after a send ----
{ const base = { ent: 1, gen: 2, cid: 'abc', user: 3, rev: 5 }, now = (o = {}) => ({ open: true, closed: false, crashed: false, ent: 1, gen: 2, cid: 'abc', user: 3, rev: 5, composer: '', ...o });
  t('evidence: nothing yet -> ""', BS.evidence(base, now()) === '' && BS.evidence(base, now({ composer: 'PRESENT' })) === '' && BS.evidence(base, now({ user: 2 })) === '');
  t('evidence: a new user turn in the same generation -> OK', BS.evidence(base, now({ user: 4 })) === 'OK');
  t('evidence: the composer emptied, no key typed since -> OK; a key typed -> not evidence', BS.evidence(base, now({ composer: 'EMPTY' })) === 'OK' && BS.evidence(base, now({ composer: 'EMPTY', rev: 6 })) === '');
  t('evidence: no user count before / now -> only the composer can tell', BS.evidence({ ...base, user: null }, now({ user: 9 })) === '' && BS.evidence(base, now({ user: null })) === '');
  t('evidence: another generation / conversation / entity -> CHANGED (even with a higher count)', BS.evidence(base, now({ gen: 3, user: 9 })) === 'CHANGED' && BS.evidence(base, now({ cid: 'x', composer: 'EMPTY' })) === 'CHANGED' && BS.evidence(base, now({ ent: 7 })) === 'CHANGED');
  t('evidence: closed -> GONE, renderer gone -> CRASH', BS.evidence(base, now({ open: false })) === 'GONE' && BS.evidence(base, now({ closed: true })) === 'GONE' && BS.evidence(base, now({ crashed: true })) === 'CRASH' && BS.evidence(null, now()) === 'GONE'); }

// ---- a small model of main's run (bcRun / broadcastSend / bcWatch) with a stub page adapter ----
// panes: id -> { ent, gen, rev, cid, sleeping, open, reading (raw), page: { input(), send(), after() } }; nothing real is touched
function model(panes, pick, page, { cancelAfter = null } = {}) {
  const log = [];
  const items = pick.map(id => { const p = panes[id], c = BS.classify({ open: p.open, bot: p.cid, sleeping: p.sleeping, r: p.sleeping ? null : rd(p.raw), cur: true, loading: false });
    return { id, ent: p.ent, gen: p.gen, rev: p.rev, cid: p.cid, sleeping: p.sleeping, label: `ペイン${id}`, conv: BS.shortConv(p.cid), st: c.st, why: c.why }; });
  const st = { preview: BS.preview(11, '本文', items), batch: null };
  const press = () => { const code = BS.admit(st, 11); if (code) { log.push(code); return false; } st.batch = BS.batch(st.preview, 12, NOW); st.preview = null; return true; };
  const go = [press(), press(), press()];                      // the button pressed three times / ⌘↵ held
  const now = p => ({ open: p.open, closed: false, ent: p.ent, gen: p.gen, rev: p.rev, cid: p.cid, sleeping: p.sleeping });
  const doo = a => { const r = BS.step(st.batch, a); st.batch = r.b; return r.code; };
  for (const x of st.batch.items) {
    if (x.st !== 'WAIT') continue;
    const id = x.id, p = panes[id];
    if (cancelAfter === id) doo({ type: 'cancel' });
    if (doo({ type: 'begin', id })) continue;
    p.beforeRead?.();
    let why = BS.moved(BS.item(st.batch, id), now(p)); if (why) { doo({ type: 'skip', id, why }); continue; }
    const c = BS.classify({ open: true, bot: p.cid, sleeping: false, r: rd(p.raw), cur: true, loading: false, own: true });
    if (c.st !== 'READY') { doo({ type: 'skip', id, why: c.why }); continue; }
    if (doo({ type: 'input', id })) continue;
    let x1; try { x1 = page.input(p); } catch { x1 = null; }
    if (!x1 || x1.r !== 'typed') { doo({ type: 'skip', id, why: x1 && x1.r === 'notempty' ? 'PRESENT' : 'FAILED' }); continue; }
    p.afterInput?.();
    why = BS.moved(BS.item(st.batch, id), now(p)); if (why) { doo({ type: 'skip', id, why }); continue; }
    const base = { ent: p.ent, gen: p.gen, cid: p.cid, user: p.user };
    doo({ type: 'send', id });
    let s; try { s = page.send(p, x1.h); } catch { s = 'error'; }
    if (['mismatch', 'nocomposer', 'nobutton'].includes(s)) { doo({ type: 'notsent', id }); continue; }
    page.after(p);                                             // what the page shows afterwards (or not)
    const v = BS.evidence({ ...base, rev: p.rev }, { ...now(p), crashed: !!p.crashed, user: p.user, composer: p.composer || '' });
    v === 'OK' ? doo({ type: 'confirm', id }) : doo({ type: 'unsure', id, why: v || (s === 'clicked' ? 'TIMEOUT' : 'ERROR') });
  }
  return { b: st.batch, log, go };
}
const mk = (id, o = {}) => ({ ent: id * 10, gen: id * 10 + 1, rev: 0, cid: `bot${id}`, sleeping: false, open: true, raw: RAW.empty, user: 2, composer: '', ...o });
const stubPage = (o = {}) => { const calls = { input: [], send: [] }; return { calls,
  input: p => { calls.input.push(p.ent / 10); if (o.inputThrows === p.ent / 10) throw new Error('x'); if (o.notEmpty === p.ent / 10) return { r: 'notempty' }; return { r: 'typed', h: 'h1' }; },
  send: (p, h) => { calls.send.push(p.ent / 10); return o.sendAns?.[p.ent / 10] || 'clicked'; },
  after: p => { const a = o.after?.[p.ent / 10] || 'turn'; if (a === 'turn') p.user++; else if (a === 'empty') p.composer = 'EMPTY'; else if (a === 'crash') p.crashed = true; else if (a === 'spa') p.gen++; } }; };
{ const P = { 1: mk(1), 2: mk(2) }, pg = stubPage(), m = model(P, [1, 2], pg);
  t('model: pressed three times -> one batch, DUP twice; each target typed once and sent once', J(m.go) === J([true, false, false]) && J(m.log) === J(['DUP', 'DUP']) && J(pg.calls.input) === J([1, 2]) && J(pg.calls.send) === J([1, 2]));
  t('model: a new user turn after each -> 確認済み x2', J(m.b.items.map(x => x.st)) === J(['OK', 'OK'])); }
{ const P = { 1: mk(1, { raw: RAW.text }), 2: mk(2), 3: mk(3, { beforeRead() { this.gen++; } }), 4: mk(4, { afterInput() { this.rev++; } }) }, pg = stubPage(), m = model(P, [1, 2, 3, 4], pg);
  t('model: a draft at the preview -> skipped there, never typed into', BS.item(m.b, 1).st === 'SKIP' && BS.item(m.b, 1).pre && !pg.calls.input.includes(1));
  t('model: moved (new generation) before its turn -> SKIP CHANGED, nothing typed / sent, never another pane instead', BS.item(m.b, 3).why === 'CHANGED' && !pg.calls.input.includes(3) && !pg.calls.send.includes(3));
  t('model: a key typed between input and send -> SKIP CHANGED (typed, never clicked)', BS.item(m.b, 4).why === 'CHANGED' && BS.item(m.b, 4).typed && pg.calls.input.includes(4) && !pg.calls.send.includes(4));
  t('model: the others go on', BS.item(m.b, 2).st === 'OK' && J(pg.calls.send) === J([2])); }
{ const P = { 1: mk(1), 2: mk(2), 3: mk(3), 4: mk(4), 5: mk(5), 6: mk(6), 7: mk(7) };
  const pg = stubPage({ inputThrows: 2, notEmpty: 3, sendAns: { 4: 'mismatch' }, after: { 5: 'none', 6: 'empty', 7: 'crash' } }), m = model(P, [1, 2, 3, 4, 5, 6, 7], pg);
  const st = id => `${BS.item(m.b, id).st}${BS.item(m.b, id).why ? ':' + BS.item(m.b, id).why : ''}`;
  t('model: input failed before the send -> SKIP FAILED (never sent)', st(2) === 'SKIP:FAILED' && !pg.calls.send.includes(2));
  t('model: the composer was not empty any more at input -> SKIP PRESENT (nothing typed over)', st(3) === 'SKIP:PRESENT' && !pg.calls.send.includes(3));
  t('model: the page did not click (content changed) -> SKIP NOT_SENT', st(4) === 'SKIP:NOT_SENT');
  t('model: clicked but no evidence -> UNSURE TIMEOUT, sent exactly once (no retry)', st(5) === 'UNSURE:TIMEOUT' && pg.calls.send.filter(x => x === 5).length === 1);
  t('model: the composer emptied -> OK; renderer gone -> UNSURE CRASH', st(6) === 'OK' && st(7) === 'UNSURE:CRASH');
  const c = BS.counts(m.b);
  t(`model: partial success counted apart (ok ${c.ok} / unsure ${c.unsure} / skip ${c.skip})`, c.ok === 2 && c.unsure === 2 && c.skip === 3 && c.total === 7 && BS.done(m.b));
  const v = BS.view({ batch: m.b });
  t('view: done, 確認済み / 結果不明 / スキップ apart, 結果不明 tells to check the chat and is not resent', v.phase === 'done' && /確認済み 2・結果不明 2・スキップ 3/.test(v.foot) && /自動で再送しません/.test(v.foot)
    && v.items.find(x => x.id === 5).whyJa.startsWith('結果不明。チャットを確認してください') && v.items.find(x => x.id === 5).stJa === '結果不明' && !v.canCancel); }
{ const P = { 1: mk(1), 2: mk(2), 3: mk(3) }, pg = stubPage(), m = model(P, [1, 2, 3], pg, { cancelAfter: 2 });
  t('model: 取消 after the first target -> the rest SKIP CANCEL, never typed; the first keeps its result', BS.item(m.b, 1).st === 'OK' && BS.item(m.b, 2).why === 'CANCEL' && BS.item(m.b, 3).why === 'CANCEL'
    && J(pg.calls.input) === J([1]) && BS.counts(m.b).cancel === 2); }

// ---- the screen ----
{ const v = BS.view({ preview: PV });
  t('view: preview lists name / short conversation / state / reason, N to send', v.phase === 'preview' && v.n === 3 && v.canSend && v.items.length === 4 && v.items[1].stJa === 'スキップ' && v.items[1].whyJa === '入力欄に下書きがあります'
    && v.items[2].stJa === '起床待ち' && v.items[0].stJa === '送信可' && v.items[0].conv === 'bot/bot1' && /送信 3件・スキップ 1件/.test(v.head));
  const e = BS.view({ preview: BS.preview(3, 'x'.repeat(BS.TEXT_MAX + 1), [it(1)], 'LONG') });
  t('view: a text error -> no send button', e.err.includes(String(BS.TEXT_MAX)) && !e.canSend && e.n === 0);
  const r = BS.view({ batch: S(B0, { type: 'begin', id: 1 }).b, dry: true });
  t('view: running -> 未送信 / 準備中 / 起床待ち, cancel offered, dry-run flag passed', r.phase === 'run' && r.canCancel && r.dry && r.items[0].stJa === '準備中' && r.items[3].stJa === '未送信' && /起床待ち/.test(r.items[2].whyJa));
  t('view: nothing -> composing', BS.view().phase === '' && BS.view({}).items.length === 0);
  t('view: every state / reason has a Japanese label', BS.STATES.every(s => BS.view({ batch: { ...B0, items: [{ ...B0.items[0], st: s, why: s === 'SKIP' ? 'GONE' : s === 'UNSURE' ? 'TIMEOUT' : '' }] } }).items[0].stJa !== s)
    && Object.values(BS.SKIP_WHY).concat(Object.values(BS.UNSURE_WHY)).every(s => /[぀-ヿ一-鿿]/.test(s))); }

// ---- diagnostics codes ----
t('diagnostics: bcast takes every broadcast-state code (fixed, no text)', J([...DG.BCAST_CODES].sort()) === J([...BS.CODES].sort()) && BS.CODES.every(c => DG.EVENTS.bcast.r.includes(c)) && BS.CODES.every(c => /^[A-Z_]+$/.test(c)));

// ---- contract with src/main.js / overlay.js ----
{ const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8'), ov = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay.js'), 'utf8');
  const fn = name => { const i = main.indexOf(`function ${name}(`); if (i < 0) return ''; let d = 0, j = main.indexOf('{', main.indexOf(')', i)); for (; j < main.length; j++) { if (main[j] === '{') d++; else if (main[j] === '}' && --d === 0) break; } return main.slice(i, j + 1); };
  const blk = main.slice(main.indexOf('// ---- 一斉送信 (#12, broadcast-state.js): this window'), main.indexOf('// ---- IPC from app UI'));
  t('main: the old one-step send is gone (no "broadcast" action, no injectSend)', !/case 'broadcast':/.test(main) && !/injectSend/.test(main) && /case 'bc-send': bcStart\(a\.pid\); break;/.test(main));
  t('main: a batch only from the preview on screen, once (BS.admit before BS.batch)', /const code = BS\.admit\(\{ preview: bcPv, batch: bcB \}, pid\);/.test(fn('bcStart')) && fn('bcStart').indexOf('BS.admit(') < fn('bcStart').indexOf('BS.batch('));
  t('main: the confirmed set is checked against now right away (moved -> skipped, never replaced)', /BS\.moved\(it, bcNow\(p\)\)/.test(fn('bcStart')));
  const one = fn('broadcastSend');
  t('main: per target: re-check, live read, input, settle + re-check, then send - in this order', ['BS.moved(', 'await liveInput(p)', 'BS.classify(', "type: 'input'", 'bcPage.input(', 'BS.TIMING.SETTLE_MS', "type: 'send'", 'bcPage.send('].every((s, i, a) => one.indexOf(s) >= 0 && (!i || one.indexOf(a[i - 1]) < one.indexOf(s))));
  t('main: a started send ends in its evidence watch (OK / UNSURE), never a second send', (one.match(/bcPage\.send\(/g) || []).length === 1 && /bcWatch\(p, id,/.test(one) && !/bcPage\.(send|input)\(/.test(fn('bcWatch')) && !/bcPage\.(send|input)\(/.test(fn('bcRun')));
  t('main: the page adapter types / sends only when not in the dry run', /if \(BC_DRY\) return \{ r: 'dry', h: '' \};\s*const x = await bcJs\(p, BC_INPUT_JS\(body\)\);/.test(main) && /if \(BC_DRY\) return 'dry';\s*const x = await bcJs\(p, BC_SEND_JS\(h\)\)/.test(main)
    && /const BC_DRY = !!process\.env\.MPB_BROADCAST_DRYRUN;/.test(main) && (blk.match(/executeJavaScript\(/g) || []).length === 1 && (blk.match(/sendInputEvent\(/g) || []).length === 1);
  t('main: the input script types only into an empty composer; the send script clicks only while it holds what was typed', /return\{r:'notempty'\}/.test(main) && /if\(hash\(val\(el\)\)!==\$\{JSON\.stringify\(String\(h\)\)\}\)return\{r:'mismatch'\}/.test(main));
  t('main: asleep targets woken through the existing wake (reloadPane -> queue), never another loader', /reloadPane\(p\)/.test(fn('bcRun')) && !/loadURL|appLoad|loadInto/.test(blk));
  t('main: the text is never logged (diag / dlog in the broadcast code: codes, numbers, pane numbers only)', [...blk.matchAll(/(?:diag\.rec|dlog)\(([^\n]*?)\);/g)].every(m => !/body|text|label|\.name\b|url|conv|cid|title|\bh\b/i.test(m[1])));
  t('main: memory only (nothing of a batch in paneSpec / snapshot / panes.json)', !/bc[A-Z]|broadcast/.test(fn('snapshot')) && !/bc[A-Z]|broadcast/.test(main.slice(main.indexOf('const paneSpec'), main.indexOf('\n', main.indexOf('const paneSpec')))));
  t('main: the user turns of a confirmed conversation are noted per generation (evidence)', /p\.userSeen = \{ gen: c\.gen, n: c\.user \};/.test(fn('onMsgCount')) && fn('onMsgCount').indexOf('p.userSeen') < fn('onMsgCount').indexOf("if (!snapOk(s, 'stable'))"));
  t('main: ⌘⇧B and the palette open the broadcast overlay with main\'s view; closing drops the preview', /k === 'b' && input\.shift\) \{ openOverlay\('broadcast', \{ bc: bcView\(\) \}\)/.test(main) && /case 'broadcast-prompt': openOverlay\('broadcast', \{ bc: bcView\(\) \}\); break;/.test(main)
    && /bcPv = null; bcPvNo = 0;/.test(fn('closeOverlay')));
  t('overlay: プレビュー first, 「このN件に送信」 sends only the preview number once, ⌘↵ repeat ignored', /mpb\.run\(\{ type: 'bc-preview', text: t, ids: \[\.\.\.bcSel\] \}\)/.test(ov) && /mpb\.run\(\{ type: 'bc-send', pid: bcV\.pid \}\)/.test(ov)
    && /bcSentPid === bcV\.pid\) return; bcSentPid = bcV\.pid;/.test(ov) && /if \(!e\.repeat\) bcGo\(\)/.test(ov) && !/type: 'broadcast'/.test(ov) && /この\$\{v\.n\}件に送信/.test(ov));
  t('overlay: main\'s labels shown escaped, the text read-only while previewing / sending', /bcText\.readOnly = !!ph/.test(ov) && /esc\(it\.whyJa\)/.test(ov) && /esc\(it\.stJa\)/.test(ov) && /esc\(it\.label/.test(ov)); }

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
