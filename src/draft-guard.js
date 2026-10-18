// Input guard (#11) (unit-tested in test/draft-guard.test.js): may main throw a pane's page away now (sleep, reload, close, another URL,
// back / forward, a layout or workspace that drops the pane)? Pure: the live reading of the composer, main's stamps of the pane and every
// time come in as arguments; main.js owns the views, the live check (the shared composerState run in the page, with a timeout), the dialog
// and every side effect.
//   automatic (auto-sleep, auto-reload, the blank-page watchdog): only when the page clearly holds nothing. Typed text, an attachment / upload,
//     an IME composition, an unknown reading, a broadcast or a confirmation in progress, or a page / input that moved during the check refuse it.
//   manual (close / ⌘W / reload / reload-all / sleep / URL / back-forward / layout / workspace): the panes at risk are listed in one dialog whose
//     default and Esc are 'やめる'. A confirmation holds only for what was shown: everything is read again right after it, and any change of the
//     input or of the pane (another page / generation, asleep / awake, closed, typed) cancels the operation.
// A pane without a page (asleep, blank / queued at startup, error page, renderer gone) has nothing to lose: it is never read or asked about, so
// a new empty view, a first load and waking from sleep are never held up by 'unknown'.
const CHECK_MS = 1500;          // a live check that takes longer is unknown
const FRESH_MS = 5000;          // a reading older than this is not 'right before' the operation any more
// what can be lost (dialog order): typed text, an attachment, an upload, an IME composition, an unreadable composer, a broadcast into the pane
const RISKS = ['PRESENT', 'ATTACH', 'UPLOAD', 'IME', 'UNKNOWN', 'BUSY'];
// why an automatic operation was refused (diagnostics guard.auto): a risk, or the reading itself cannot be used
const AUTO_CODES = [...RISKS, 'CHANGED', 'STALE'];
// why a confirmation no longer holds (diagnostics guard.ask): a target closed / not read, moved while read, read too long ago,
// another page / generation / sleep state, other input
const EXPIRE_CODES = ['GONE', 'NEW', 'CHANGED', 'STALE', 'PANE', 'INPUT'];
// one reading's state: NOPAGE (nothing to lose, not read) / NOINPUT (a page without a composer) / EMPTY / PRESENT / UNKNOWN
const STATES = ['NOPAGE', 'NOINPUT', 'EMPTY', 'PRESENT', 'UNKNOWN'];

// main's stamp of a pane { ent, gen, rev, closed, sleeping }: entity and world generation (#02), the input revision (keys typed into the pane,
// counted by main), closed / asleep. -> '' (same) or GONE / PANE / INPUT
function stampDiff(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || a.closed || b.closed) return 'GONE';
  if (a.ent !== b.ent || a.gen !== b.gen || !!a.sleeping !== !!b.sleeping) return 'PANE';
  if (a.rev !== b.rev) return 'INPUT';
  return '';
}
const isTime = v => typeof v === 'number' && Number.isFinite(v);
const fresh = (r, now) => isTime(now) && isTime(r.at) && now >= r.at && now - r.at <= FRESH_MS;

// raw: what the page's composerState() returned ({ d: 'present' | 'empty' | 'none', text, att, up, fp }), or null (script error / timeout).
// c: { page: false when main knows the pane holds no page, before / after: main's stamps around the check, at: when it ended,
//      expect: a composer is expected (a confirmed conversation of this generation), ime: an IME composition reported, busy: a broadcast
//      into the pane, hold: a manual confirmation of the pane in progress (only automatic operations care) }
function read(raw, c = {}) {
  const r = { st: 'UNKNOWN', text: false, att: false, up: false, fp: '', ime: c.ime === true, busy: c.busy === true, hold: c.hold === true,
    moved: '', at: isTime(c.at) ? c.at : NaN, stamp: c.after || null };
  if (c.page === false) return { ...r, st: 'NOPAGE' };
  r.moved = stampDiff(c.before, c.after);                    // another page / generation / key typed while it was read: not a reading of now
  if (r.moved) return r;
  if (!raw || typeof raw !== 'object' || !['present', 'empty', 'none'].includes(raw.d)) return r;
  r.text = raw.text === true; r.att = raw.att === true; r.up = r.att && raw.up === true;
  r.fp = typeof raw.fp === 'string' ? raw.fp.slice(0, 16) : '';
  r.st = raw.d === 'present' ? 'PRESENT' : raw.d === 'empty' ? 'EMPTY' : c.expect ? 'UNKNOWN' : 'NOINPUT';   // no composer where one must be: cannot tell
  return r;
}
// a reading -> what could be lost, in RISKS order ([] = nothing)
function risks(r) {
  if (!r || typeof r !== 'object') return ['UNKNOWN'];
  if (r.st === 'NOPAGE') return [];
  const out = [];
  if (r.st === 'PRESENT' && (r.text || !r.att)) out.push('PRESENT');
  if (r.att) out.push('ATTACH');
  if (r.up) out.push('UPLOAD');
  if (r.ime) out.push('IME');
  if (!STATES.includes(r.st) || r.st === 'UNKNOWN' || r.moved) out.push('UNKNOWN');
  if (r.busy) out.push('BUSY');
  return out;
}
// automatic operation: '' (go) or the AUTO_CODES reason it must not happen now
function autoRefusal(r, now) {
  if (!r || typeof r !== 'object') return 'UNKNOWN';
  if (r.moved) return 'CHANGED';
  if (!fresh(r, now)) return 'STALE';
  if (r.hold) return 'BUSY';
  return risks(r)[0] || '';
}
// manual operation: items [{ id, r }] (every target, read) -> { ask: [{ id, codes }] the panes to show in the dialog, pass: [id] nothing to lose }
function plan(items) {
  const ask = [], pass = [];
  for (const it of Array.isArray(items) ? items : []) { const codes = risks(it && it.r); if (codes.length) ask.push({ id: it.id, codes }); else pass.push(it && it.id); }
  return { ask, pass };
}
// after the confirmation. shown: [{ id, r }] the targets as read when the dialog went up; again: [{ id, r }] the same read again now
// -> '' (the confirmation holds) or the EXPIRE_CODES reason it does not
function expired(shown, again, now) {
  const m = new Map((Array.isArray(again) ? again : []).map(x => [x && x.id, x && x.r]));
  for (const s of Array.isArray(shown) ? shown : []) {
    const a = s && s.r, r = m.get(s && s.id);
    if (!a || !r) return 'GONE';
    if (r.moved) return 'CHANGED';
    if (!fresh(r, now)) return 'STALE';
    const d = stampDiff(a.stamp, r.stamp); if (d) return d;
    if (r.st !== a.st || r.fp !== a.fp || r.text !== a.text || r.att !== a.att || r.up !== a.up || r.ime !== a.ime || r.busy !== a.busy) return 'INPUT';
  }
  return '';
}
// right before acting. last: [{ id, r }] the latest reading of every target; now: [{ id, stamp }] the panes main would act on at this moment
// -> '' or the EXPIRE_CODES reason (a pane that was never read, or one that moved since its reading)
function unmoved(last, now) {
  const m = new Map((Array.isArray(last) ? last : []).map(x => [x && x.id, x && x.r]));
  for (const c of Array.isArray(now) ? now : []) {
    const r = m.get(c && c.id);
    if (!r) return 'NEW';
    const d = stampDiff(r.stamp, c.stamp); if (d) return d;
  }
  return '';
}

// ---- the dialog (Japanese, the same style as main's other confirmations; default and Esc = やめる) ----
// reopen: the closed pane goes into the 閉じたペインを開き直す history (#23; closing many at once does not): say that its input does not come back
const OPS = {
  CLOSE: { when: 'このペインを閉じると', go: '閉じる', reopen: true },
  CLOSE_OTHERS: { when: '他のペインをすべて閉じると', go: 'すべて閉じる' },
  RELOAD: { when: '再読み込みすると', go: '再読み込み' },
  RELOAD_ALL: { when: 'すべてのペインを再読み込みすると', go: 'すべて再読み込み', skip: '入力のあるペインを除いて再読み込み' },
  SLEEP: { when: 'スリープすると', go: 'スリープする' },
  NAVIGATE: { when: 'このペインで別のページを開くと', go: '開く' },
  NEWTAB: { when: '新しいタブに戻すと', go: '新しいタブに戻す' },
  BACK: { when: '前のページに戻ると', go: '戻る' },
  FORWARD: { when: '次のページに進むと', go: '進む' },
  LINK: { when: 'リンクをこのペインで開くと', go: '開く' },
  LAYOUT: { when: 'レイアウトを変えてペインを閉じると', go: '変更する' },
  WORKSPACE: { when: 'ワークスペースを切り替えると', go: '切り替える' },
};
const WHY = { PRESENT: '入力欄に下書きがあります', ATTACH: '添付ファイルがあります', UPLOAD: '添付をアップロード中です', IME: '変換中の文字があります',
  UNKNOWN: '入力欄の状態を確認できませんでした', BUSY: '一斉送信の処理中です' };
const LABEL_MAX = 40;
// op: an OPS key; items: [{ label: the pane's name / title (shown to the user only), codes }]; skip: offer 'all but the panes at risk'
// -> { message, detail, buttons, defaultId, cancelId, actions: what each button means ('go' / 'skip' / 'cancel') }
function dialogText(op, items, { skip = false } = {}) {
  const o = Object.hasOwn(OPS, op) ? OPS[op] : OPS.CLOSE;
  const lines = (Array.isArray(items) ? items : []).map(x => {
    const name = String((x && x.label) || '').replace(/\s+/g, ' ').trim();
    const why = [...new Set((x && Array.isArray(x.codes) ? x.codes : []).map(c => Object.hasOwn(WHY, c) ? WHY[c] : WHY.UNKNOWN))];
    return `・${(name.length > LABEL_MAX ? name.slice(0, LABEL_MAX - 1) + '…' : name) || '（名前なし）'}：${why.join('・') || WHY.UNKNOWN}`;
  });
  const actions = ['go', ...(skip && o.skip ? ['skip'] : []), 'cancel'];
  const buttons = actions.map(a => a === 'go' ? o.go : a === 'skip' ? o.skip : 'やめる');
  const note = o.reopen ? ['閉じたペインを元に戻しても、下書き・添付は復元できません。'] : [];
  return { message: `${o.when}、入力中の内容が失われる可能性があります`, detail: [...lines, '', ...note, '「やめる」を選ぶと、入力内容と添付はそのまま残ります。'].join('\n'),
    buttons, defaultId: actions.length - 1, cancelId: actions.length - 1, actions };
}

module.exports = { CHECK_MS, FRESH_MS, RISKS, AUTO_CODES, EXPIRE_CODES, STATES, OPS, stampDiff, read, risks, autoRefusal, plan, expired, unmoved, dialogText };
