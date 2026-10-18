// 一斉送信 (#12) (unit-tested in test/broadcast-state.test.js). Pure: main.js owns the panes, the live reading of the composer (#11 liveInput),
// the generation stamps (#02), the wake (#31 load queue), the page adapter (input / send) and every side effect; this file decides.
//   preview : main reads every chosen pane now. Each is READY, WAKE (asleep: woken through the existing wake first) or SKIP with a fixed reason
//             (typed text / attachment / upload / IME / unknown / busy / loading / no confirmed bot conversation). Nothing is ever typed over or
//             merged with a draft.
//   batch   : 「このN件に送信」 makes one batch from the preview on screen (its number starts a batch once: a second press / a key repeat is DUP).
//             Each target keeps the pane entity / generation / conversation / keys typed it was previewed with (a sleeping one: the generation it
//             woke into); right before input, after input and before the send it must still be that, else it is skipped - never redirected to
//             another pane or conversation.
//   result  : OK only on page evidence of the same generation (a new user turn, or the composer emptied with no key typed since); a target
//             whose send was started without evidence (timeout / page moved / crash) is UNSURE and is never sent again. Cancel stops only what
//             has not been typed yet.
// Memory only: never in panes.json, never resumed after a restart. Not exactly-once across the network.
const { risks } = require('./draft-guard');

const TEXT_MAX = 20000;                                          // characters main types (the IPC accepts more; longer is refused at the preview)
// ms: one page step (input / send script), input -> send, polls, a sleeping target's wake, page evidence after the send, composer re-read
const TIMING = { STEP_MS: 3000, SETTLE_MS: 400, POLL_MS: 300, WAKE_MS: 90000, CONFIRM_MS: 20000, READ_MS: 2000 };
// a target's state (the screen): 未送信 / 準備中 / 送信開始 / 確認済み / 結果不明 / スキップ
const STATES = ['WAIT', 'PREP', 'SENT', 'OK', 'UNSURE', 'SKIP'];
const FINAL = ['OK', 'UNSURE', 'SKIP'];
// why a target was not sent (never clicked)
const SKIP_WHY = {
  PRESENT: '入力欄に下書きがあります', ATTACH: '添付ファイルがあります', UPLOAD: '添付をアップロード中です', IME: '変換中の文字があります',
  UNKNOWN: '入力欄の状態を確認できません', BUSY: '別の操作の確認中です', LOADING: '読み込み中です',
  UNAVAILABLE: '送信できるBotの会話を確認できません', GONE: 'ペインが閉じられました', CHANGED: '宛先・入力欄が変わったため送りません',
  NO_WAKE: 'スリープから復帰しませんでした', CANCEL: '取消しました', FAILED: '入力に失敗しました', NOT_SENT: '送信ボタンを押す前に止めました',
};
// why a started send has no result (never sent again)
const UNSURE_WHY = { TIMEOUT: '送信の表示を確認できませんでした', CHANGED: 'ページが移動しました', GONE: 'ペインが閉じられました',
  CRASH: 'ページのプロセスが終了しました', ERROR: '送信の応答がありませんでした', DRYRUN: '試験モード（MPB_BROADCAST_DRYRUN）: 入力・送信していません' };
const ERR = { EMPTY: '本文が空です', LONG: `本文が長すぎます（${TEXT_MAX}字まで）` };
// diagnostics 'bcast' (fixed codes + counts / pane numbers only, never the text, a name or a URL)
const CODES = ['PREVIEW', 'START', 'DRYRUN', 'DUP', 'STALE', 'BUSY', 'SENT', 'OK', 'UNSURE', 'SKIP', 'CHANGED', 'NO_WAKE', 'CANCEL', 'DONE'];
const REJECT = ['BAD_ACTION', 'NO_ITEM', 'STATE', 'BAD_WHY'];
const INPUT = ['PRESENT', 'ATTACH', 'UPLOAD', 'IME'];          // what the composer holds (shown before 'loading' / 'unknown')

const textError = t => typeof t !== 'string' || !t.trim() ? 'EMPTY' : t.length > TEXT_MAX ? 'LONG' : '';
// the conversation as shown in the preview: enough to tell bots apart, never the whole URL
const shortConv = cid => { const s = String(cid || ''); return !s ? '' : 'bot/' + (s.length > 12 ? `${s.slice(0, 5)}…${s.slice(-4)}` : s); };

// one chosen pane now. f: { open: still in this window, bot: the grok.com/bot conversation id it shows ('' = none; asleep: the one it wakes
// into), sleeping, r: the live reading (#11 GUARD.read; none when asleep), cur: this generation confirmed this very conversation (pane-state
// current + its scan is of this bot), loading: a load / bot-page fix of it runs or waits, own: the pane's BUSY is this broadcast's own mark }
// -> { st: 'READY' | 'WAKE' | 'SKIP', why: '' | a SKIP_WHY code }
function classify(f) {
  const skip = why => ({ st: 'SKIP', why });
  if (!f || typeof f !== 'object' || !f.open) return skip('GONE');
  if (!f.bot) return skip('UNAVAILABLE');
  if (f.sleeping) return { st: 'WAKE', why: '' };
  const r = f.r;
  if (!r || typeof r !== 'object') return skip('UNKNOWN');
  const rk = risks(r).filter(c => !(c === 'BUSY' && f.own));
  const held = rk.find(c => INPUT.includes(c)); if (held) return skip(held);
  if (r.hold === true) return skip('BUSY');                   // a confirmation dialog of #11 is open for it
  if (f.loading) return skip('LOADING');
  if (rk.length) return skip(rk[0]);
  if (r.st !== 'EMPTY' || !f.cur) return skip('UNAVAILABLE');
  return { st: 'READY', why: '' };
}

// the preview on screen. items: [{ id, ent, gen, rev, cid, sleeping, label, conv, st, why }] in pane order; err: textError() code
function preview(pid, text, items, err = '') {
  const its = err ? [] : (Array.isArray(items) ? items : []).map(x => ({ ...x }));
  return { pid, text: String(text ?? ''), err: err || '', items: its, n: its.filter(x => x.st === 'READY' || x.st === 'WAKE').length };
}
// may 「このN件に送信」 for preview number pid start a batch now? -> '' | 'DUP' (that preview already started one: a second press / a key
// repeat) | 'BUSY' (another batch of this window still runs) | 'STALE' (not the preview on screen: replaced / closed / none / nothing to send)
function admit(state, pid) {
  const b = state && state.batch, pv = state && state.preview;
  if (b && b.pid === pid) return 'DUP';
  if (b && !done(b)) return 'BUSY';
  if (!pv || pv.pid !== pid || pv.err || !(pv.n > 0)) return 'STALE';
  return '';
}
// the batch from the preview (a target skipped there stays skipped with its reason)
function batch(pv, bid, at) {
  return { bid, pid: pv.pid, at, text: pv.text, cancelled: false,
    items: pv.items.map(x => { const go = x.st === 'READY' || x.st === 'WAKE';
      return { id: x.id, ent: x.ent, gen: x.gen, rev: x.rev, cid: x.cid, sleeping: !!x.sleeping, label: x.label, conv: x.conv,
        st: go ? 'WAIT' : 'SKIP', why: go ? '' : x.why, typed: false, pre: !go }; }) };
}
const item = (b, id) => b && Array.isArray(b.items) ? b.items.find(x => x.id === id) || null : null;
// is the pane still the one the target was confirmed for? now: { open, closed, ent, gen, rev, cid, sleeping } -> '' | 'GONE' | 'CHANGED'
function moved(it, now) {
  if (!it || !now || !now.open || now.closed) return 'GONE';
  if (now.ent !== it.ent || now.gen !== it.gen || now.cid !== it.cid || now.rev !== it.rev || !!now.sleeping !== !!it.sleeping) return 'CHANGED';
  return '';
}

// (batch, action) -> { b: the new batch (the same object when rejected), code: '' | a REJECT code, ...results }
// begin { id, wake?: { gen, rev } (an asleep target: the generation it woke into) } WAIT -> PREP | input { id } PREP: typed from now on (cancel no
// longer stops it) | send { id } PREP typed -> SENT | skip { id, why } WAIT / PREP -> SKIP | notsent { id } SENT -> SKIP NOT_SENT (the page
// answered that it did not click) | confirm { id } SENT -> OK | unsure { id, why } SENT -> UNSURE | cancel: every WAIT / not yet typed PREP -> SKIP CANCEL
function step(b, a) {
  const no = code => ({ b, code }), ok = (nb, x) => ({ b: nb, code: '', ...x });
  if (!b || typeof b !== 'object' || !Array.isArray(b.items) || !a || typeof a !== 'object') return no('BAD_ACTION');
  if (a.type === 'cancel') {
    let n = 0;
    const items = b.items.map(it => it.st === 'WAIT' || (it.st === 'PREP' && !it.typed) ? (n++, { ...it, st: 'SKIP', why: 'CANCEL' }) : it);
    return ok({ ...b, cancelled: true, items }, { n });
  }
  if (!['begin', 'input', 'send', 'skip', 'notsent', 'confirm', 'unsure'].includes(a.type)) return no('BAD_ACTION');
  const i = b.items.findIndex(x => x.id === a.id); if (i < 0) return no('NO_ITEM');
  const it = b.items[i], put = x => ok({ ...b, items: b.items.map((y, j) => j === i ? { ...y, ...x } : y) });
  switch (a.type) {
    case 'begin':
      if (it.st !== 'WAIT' || b.cancelled) return no('STATE');
      if (!a.wake) return it.sleeping ? no('STATE') : put({ st: 'PREP' });
      return it.sleeping ? put({ st: 'PREP', sleeping: false, woke: true, gen: a.wake.gen, rev: a.wake.rev }) : no('STATE');
    case 'input': return it.st === 'PREP' && !it.typed ? put({ typed: true }) : no('STATE');
    case 'send': return it.st === 'PREP' && it.typed ? put({ st: 'SENT' }) : no('STATE');
    case 'skip': if (!Object.hasOwn(SKIP_WHY, a.why)) return no('BAD_WHY'); return it.st === 'WAIT' || it.st === 'PREP' ? put({ st: 'SKIP', why: a.why }) : no('STATE');
    case 'notsent': return it.st === 'SENT' ? put({ st: 'SKIP', why: 'NOT_SENT' }) : no('STATE');
    case 'confirm': return it.st === 'SENT' ? put({ st: 'OK', why: '' }) : no('STATE');
    default: if (!Object.hasOwn(UNSURE_WHY, a.why)) return no('BAD_WHY'); return it.st === 'SENT' ? put({ st: 'UNSURE', why: a.why }) : no('STATE');   // unsure
  }
}
const done = b => !!b && Array.isArray(b.items) && b.items.every(it => FINAL.includes(it.st));
const cancellable = b => !!b && Array.isArray(b.items) && b.items.some(it => it.st === 'WAIT' || (it.st === 'PREP' && !it.typed));
function counts(b) {
  const c = { wait: 0, prep: 0, sent: 0, ok: 0, unsure: 0, skip: 0, cancel: 0, total: 0 };
  for (const it of b && Array.isArray(b.items) ? b.items : []) { c.total++; c[it.st.toLowerCase()]++; if (it.st === 'SKIP' && it.why === 'CANCEL') c.cancel++; }
  return c;
}

// after one target's send. base: what main saw around it ({ ent, gen, cid, user: user turns of this generation in the latest report before
// the send (null = none), rev: keys typed into the pane right after the send }); now: the same now + open, closed, crashed and composer (the
// live reading's st, '' = not read / moved). -> 'OK' (the page shows it) | '' (no evidence yet) | an UNSURE_WHY code (no evidence can come)
function evidence(base, now) {
  if (!base || !now || !now.open || now.closed) return 'GONE';
  if (now.crashed) return 'CRASH';
  if (now.ent !== base.ent || now.gen !== base.gen || now.cid !== base.cid) return 'CHANGED';
  const n = v => Number.isSafeInteger(v) && v >= 0;
  if (n(base.user) && n(now.user) && now.user > base.user) return 'OK';    // a new user turn in this very conversation and generation
  if (now.composer === 'EMPTY' && now.rev === base.rev) return 'OK';      // the page emptied the composer it was typed into, nobody typed since
  return '';
}

// ---- what the overlay shows (Japanese, built here; overlay.js renders it as it is) ----
const PV_JA = { READY: '送信可', WAKE: '起床待ち', SKIP: 'スキップ' };
const ST_JA = { WAIT: '未送信', PREP: '準備中', SENT: '送信開始', OK: '確認済み', UNSURE: '結果不明', SKIP: 'スキップ' };
function itemWhy(it) {
  if (it.st === 'SKIP') return (SKIP_WHY[it.why] || SKIP_WHY.UNKNOWN) + (it.typed ? '（入力した本文が入力欄に残っている場合があります）' : '');
  if (it.st === 'UNSURE') return `結果不明。チャットを確認してください（${UNSURE_WHY[it.why] || UNSURE_WHY.ERROR}）`;
  if (it.st === 'OK') return '画面上で送信を確認しました';
  if (it.st === 'SENT') return '画面上の確認を待っています';
  if (it.st === 'WAIT' && it.sleeping) return '起床待ち（スリープから起こしてから確認します）';
  return '';
}
// { preview, batch, dry } -> { phase: '' (compose) | 'preview' | 'run' | 'done', pid, bid, text, err, head, foot, n, items, canSend, canCancel, dry }
function view({ preview: pv, batch: b, dry } = {}) {
  if (b) {
    const c = counts(b), fin = done(b);
    const foot = `確認済み ${c.ok}・結果不明 ${c.unsure}・スキップ ${c.skip}${c.cancel ? `（取消 ${c.cancel}）` : ''}${fin ? '' : `・処理中 ${c.wait + c.prep + c.sent}`}`;
    return { phase: fin ? 'done' : 'run', pid: b.pid, bid: b.bid, text: b.text, err: '', dry: !!dry, n: c.total - b.items.filter(x => x.pre).length,
      head: fin ? `一斉送信の結果（${c.total}件）` : `一斉送信中（${c.ok + c.unsure + c.skip}/${c.total}件 完了）`,
      foot: foot + (c.unsure ? '　結果不明は自動で再送しません' : ''),
      items: b.items.map(it => ({ id: it.id, label: it.label, conv: it.conv, st: it.st, why: it.why, stJa: ST_JA[it.st] || it.st, whyJa: itemWhy(it) })),
      canSend: false, canCancel: !fin && cancellable(b) };
  }
  if (pv) {
    const skip = pv.items.length - pv.n;
    return { phase: 'preview', pid: pv.pid, bid: 0, text: pv.text, err: pv.err ? ERR[pv.err] || ERR.EMPTY : '', dry: !!dry, n: pv.n,
      head: pv.err ? '送信できません' : `送信先の確認（送信 ${pv.n}件・スキップ ${skip}件）`,
      foot: pv.err ? '' : skip ? 'スキップの対象には送りません。入力欄の内容は変えません' : '',
      items: pv.items.map(x => ({ id: x.id, label: x.label, conv: x.conv, st: x.st, why: x.why, stJa: PV_JA[x.st] || x.st,
        whyJa: x.st === 'SKIP' ? SKIP_WHY[x.why] || SKIP_WHY.UNKNOWN : x.st === 'WAKE' ? '送信時にスリープから起こして、もう一度確認します' : '' })),
      canSend: !pv.err && pv.n > 0, canCancel: false };
  }
  return { phase: '', pid: 0, bid: 0, text: '', err: '', dry: !!dry, n: 0, head: '', foot: '', items: [], canSend: false, canCancel: false };
}

module.exports = { TEXT_MAX, TIMING, STATES, FINAL, SKIP_WHY, UNSURE_WHY, CODES, REJECT, textError, shortConv, classify, preview, admit, batch, item, moved, step,
  done, cancellable, counts, evidence, view };
