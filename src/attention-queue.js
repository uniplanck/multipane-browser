// 対応キュー (#01) (unit-tested in test/attention-queue.test.js). Pure: main.js builds one fact object per pane of a window from its own state
// (sendState) and keeps only p.qSince = { kind, at } (when the pane first got its current kind; memory only, never in panes.json); the overlay
// shows the list main sends. Opening, searching, hovering or moving through the list changes nothing (no read mark, notification or Dock badge);
// only an explicit choice (Enter / click) sends the pane id + the conversation it was listed for, and main checks it again (stale) before it
// focuses / wakes that very pane.
// Kinds, highest first. One item per pane: its highest reason (the others go to `also`):
//   REPLY    要返信: the bot waits for the user (needsReply), seen on the page as it is now or the pane's own sleep state
//   UNOPENED 未確認の新着: a background check found something new while asleep
//   ISSUE    観測異常: page stopped / load failed / unresponsive / sign-in page / checks stopped or failing / a 🟢 known only as the last
//            confirmed value (reload, move, a reply being written: not current, so never listed as 要返信 / 待機)
//   WAIT     待機中: 🟢 waiting without a reply request (current or asleep)
// Same kind: the time it first got that kind, then the pane id (stable).
const KINDS = ['REPLY', 'UNOPENED', 'ISSUE', 'WAIT'];
const KIND_JA = { REPLY: '要返信', UNOPENED: '未確認の新着', ISSUE: '観測異常', WAIT: '待機中' };
// reason codes, highest first within a kind
const REASONS = { REPLY: 'REPLY', UNOPENED: 'UNOPENED', GONE: 'ISSUE', FAIL_RETRY: 'ISSUE', FAIL_MANUAL: 'ISSUE', HANG: 'ISSUE', AUTH: 'ISSUE',
  CHECK_HOLD: 'ISSUE', CHECK_FAIL: 'ISSUE', STALE_REPLY: 'ISSUE', STALE_WAIT: 'ISSUE', WAIT: 'WAIT' };
const WHY_JA = {
  REPLY: 'Botが返信を待っています',
  UNOPENED: 'スリープ中に新着メッセージ（未開封）',
  GONE: 'ページが停止しました',
  FAIL_RETRY: '読込失敗・再試行待ち',
  FAIL_MANUAL: '読込失敗（自動では読み込み直しません）',
  HANG: 'ページが応答していません',
  AUTH: 'ログインが必要なページです',
  CHECK_HOLD: 'ログイン要確認で新着確認を停止中',
  CHECK_FAIL: '新着確認に失敗',
  STALE_REPLY: '最終確認値は要返信（今の状態は未確認）',
  STALE_WAIT: '最終確認値は待機中（今の状態は未確認）',
  WAIT: '🟢 待機中（未返信なし）',
};
// a choice that was not carried out (main: diagnostics 'queue' + the note in the list)
const STALE_JA = { GONE: 'このペインはもう閉じられています。何もせず一覧を更新しました', MOVED: 'このペインは別の会話・ページに移っています。何もせず一覧を更新しました' };
const CODES = ['OPEN', 'PICK', 'GONE', 'MOVED'];   // diagnostics 'queue': list opened (n = items) / a choice carried out / refused

const isId = v => Number.isSafeInteger(v) && v > 0;
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : 0;
const hm = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const BOT = /^https:\/\/grok\.com\/bot\/([A-Za-z0-9_-]+)/;
// the conversation a pane shows: the bot id of a /bot/<id> page, else the URL without its hash ('' = none)
const refOf = u => { u = String(u || ''); const m = BOT.exec(u); return m ? `bot:${m[1]}` : u.split('#')[0]; };

// f = { id, url, name, since, sleeping, needsReply, waiting, unopened, shown: PS.shown ('live' / 'last' / 'sleep' / ''), issue: the current
//   generation's snapshot issue, gone, fail ('retry' / 'manual' / ''), hang, hold: asleep and checks stopped after a sign-in page, fails: failed
//   checks in a row (asleep), checkedAt: last confirmation of a sleeping pane (0 = none) } -> [{ kind, code }] highest first ([] = not listed)
function reasons(f) {
  if (!f || typeof f !== 'object') return [];
  const cur = f.shown === 'live' || (f.sleeping === true && f.shown === 'sleep'), out = [];
  const add = code => out.push({ kind: REASONS[code], code });
  if (f.needsReply === true && cur) add('REPLY');
  if (f.unopened === true) add('UNOPENED');
  if (f.gone === true) add('GONE');
  if (f.fail === 'retry') add('FAIL_RETRY'); else if (f.fail === 'manual') add('FAIL_MANUAL');
  if (f.hang === true) add('HANG');
  if (f.sleeping !== true && f.issue === 'AUTH_REQUIRED') add('AUTH');
  if (f.sleeping === true && f.hold === true) add('CHECK_HOLD'); else if (f.sleeping === true && num(f.fails) > 0) add('CHECK_FAIL');
  if (f.shown === 'last' && f.needsReply === true) add('STALE_REPLY'); else if (f.shown === 'last' && f.waiting === true) add('STALE_WAIT');
  if (f.waiting === true && f.needsReply !== true && cur) add('WAIT');
  return out.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));   // stable: the order above within a kind
}
const whyOf = (code, f) => code === 'CHECK_FAIL' ? `${WHY_JA.CHECK_FAIL}（${Math.min(num(f.fails), 99)}回）` : WHY_JA[code];
// when the pane's facts were last confirmed (the line under the name)
function seenOf(f) {
  if (f.sleeping === true) return num(f.checkedAt) > 0 ? `スリープ中・最終確認 ${hm(f.checkedAt)}` : 'スリープ中・未確認';
  if (f.shown === 'live') return '表示中のページで確認済み';
  if (f.shown === 'last') return '今の状態は未確認';
  return BOT.test(String(f.url || '')) ? '状態を確認できていません' : '';
}
// p.qSince for this kind: kept while the kind stays, a new time when it changes
const since = (prev, kind, now) => prev && typeof prev === 'object' && prev.kind === kind && Number.isFinite(prev.at) ? { kind, at: prev.at } : { kind, at: num(now) };

// facts of one window's panes -> the queue: [{ key: 'id:kind' (the overlay keeps its selection by it), id, kind, kja, code, name (as given,
// the overlay shortens it), why, also: [other reasons], seen, at, ref, sleeping }] in kind order, then at, then id. A pane id once only.
function build(facts, now) {
  const out = [], ids = new Set();
  for (const f of Array.isArray(facts) ? facts : []) {
    if (!f || !isId(f.id) || ids.has(f.id)) continue;
    ids.add(f.id);
    const rs = reasons(f); if (!rs.length) continue;
    const top = rs[0], s = since(f.since, top.kind, now);
    out.push({ key: `${f.id}:${top.kind}`, id: f.id, kind: top.kind, kja: KIND_JA[top.kind], code: top.code, name: String(f.name || '').trim() || '（名前なし）',
      why: whyOf(top.code, f), also: rs.slice(1).map(r => whyOf(r.code, f)), seen: seenOf(f), at: s.at, ref: refOf(f.url), sleeping: f.sleeping === true });
  }
  return out.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.at - b.at || a.id - b.id);
}
// a choice { id, ref } against the window's panes now ([{ id, url }]) -> '' (go) | 'GONE' (no such pane) | 'MOVED' (another conversation / page)
function stale(pick, facts) {
  const f = pick && isId(pick.id) ? (Array.isArray(facts) ? facts : []).find(x => x && x.id === pick.id) : null;
  if (!f) return 'GONE';
  return refOf(f.url) === String(pick.ref ?? '') ? '' : 'MOVED';
}

module.exports = { KINDS, KIND_JA, REASONS, WHY_JA, STALE_JA, CODES, refOf, reasons, since, build, stale };
