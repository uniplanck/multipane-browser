// Sleep state across a restart (#22): pure rules, no fs / electron (test/session-snapshot.test.js). The time comes in as an argument.
// With 設定 > 前回のスリープ状態を復元 (settings.restoreSleep, default off) main adds to the spec of a pane that is asleep when the window is saved
// an optional `snap` (panes.json stays schema 1: older versions ignore the field and drop it on their next save; workspaces, ↩ and 複製 never get
// one). Off: no snap is written (the next save removes any), none is read, every pane loads as before.
//   snap = { v: 1, at: saved (ms), sl: true (asleep when saved), mk: 'WAIT' | 'DONE' | 'WORK' | '' (the marker it showed), ob: when that marker
//            was last seen (ms, 0 = unknown), nm / gp: the placeholder's bot name / group name, q: the quote (only with settings.saveQuote) }
// Never in it: the draft or whether there was one, attachments, the page / DOM, counts, unread / unopened, tokens or credentials.
// On the next start (store ready only) such a pane starts asleep without loading; its placeholder shows what was saved as 前回・未再確認.
// Nothing restored sets waiting / unread / glow / needsReply: no colour, Dock badge or notification comes from an old marker. A snap that is
// broken, of a newer version or not asleep is ignored (the pane loads as usual) - never fatal. A marker seen more than 7 days ago, or times
// that do not fit the clock, are not shown (the pane still starts asleep with its name).
const SNAP_VERSION = 1;
const NAME_MAX = 80;                          // = sleep-rules.js cleanId (the placeholder's bot / group name)
const QUOTE_MAX = 300;                        // = the quote shown in the placeholder
const MAX_AGE_MS = 7 * 86400000;              // a marker seen longer ago than this is not shown
const SKEW_MS = 10 * 60000;                   // clock tolerance: a time further in the future is not trusted
const MARKS = ['WAIT', 'DONE', 'WORK', ''];
const MARK_JA = { WAIT: '🟢 待機中', DONE: '🟣 終了', WORK: '🔴 作業中' };
// diagnostics (= diagnostics.js EVENTS.restore; checked by the test): panes started asleep (n), of those without a marker (old / clock, n),
// snaps not used (setting off, store not ready, no bot URL, sleep off for the pane, broken: n)
const CODES = ['ASLEEP', 'OLD', 'IGNORED'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const okTime = t => typeof t === 'number' && Number.isFinite(t) && t > 0 && t < 8.64e15;
const str = (v, max) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const quoteStr = v => typeof v === 'string' ? v.trim().slice(0, QUOTE_MAX) : '';
// the marker a pane / a scan shows (main: p.working / p.waiting / p.done)
const markOf = s => !s ? '' : s.working ? 'WORK' : s.waiting ? 'WAIT' : s.done ? 'DONE' : '';

// a stored snap -> the same in its clean form (unknown fields dropped, values typed / cut to the limits), or null when it cannot be used
function clean(raw) {
  if (!isObj(raw) || !Number.isSafeInteger(raw.v) || raw.v < 1 || raw.v > SNAP_VERSION) return null;   // a newer snap version: ignored
  if (!okTime(raw.at) || raw.sl !== true) return null;
  const c = { v: SNAP_VERSION, at: Math.floor(raw.at), sl: true, mk: MARKS.includes(raw.mk) ? raw.mk : '', ob: okTime(raw.ob) ? Math.floor(raw.ob) : 0,
    nm: str(raw.nm, NAME_MAX), gp: str(raw.gp, NAME_MAX) };
  const q = quoteStr(raw.q); if (q) c.q = q;
  return c;
}
// clean() changed nothing (state-schema.js reports anything else as a repair)
const same = (c, raw) => isObj(c) && isObj(raw) && Object.keys(raw).length === Object.keys(c).length && Object.keys(c).every(k => raw[k] === c[k]);

// a pane being saved -> its snap, or null (not asleep). i = { sleeping, mk, ob, nm, gp, q }; quote: settings.saveQuote (only a 🟢 pane's quote)
function make(i, now, { quote = false } = {}) {
  if (!i || i.sleeping !== true || !okTime(now)) return null;
  const mk = MARKS.includes(i.mk) ? i.mk : '';
  return clean({ v: SNAP_VERSION, at: now, sl: true, mk, ob: okTime(i.ob) && i.ob <= now ? i.ob : 0, nm: i.nm, gp: i.gp, q: quote === true && mk === 'WAIT' ? i.q : '' });
}

// a saved pane spec at startup -> how it starts: null = loads as usual; else asleep with what its placeholder shows
//   { age: 'fresh' | 'old' (marker seen > 7 days ago / unknown) | 'clock' (saved in the future / seen after it was saved), at, ob, mk, nm, gp, q, seen: false }
// enabled: settings.restoreSleep; ready: the store loaded the file as ready (and may write); quote: settings.saveQuote (a quote saved before
// it was turned off is not shown)
function plan(spec, now, { enabled = false, ready = false, quote = false } = {}) {
  if (enabled !== true || ready !== true || !isObj(spec) || spec.sleep === false || !okTime(now)) return null;
  const s = clean(spec.snap);
  if (!s) return null;
  const age = s.at > now + SKEW_MS || s.ob > s.at + SKEW_MS ? 'clock' : !s.ob || now - s.ob > MAX_AGE_MS ? 'old' : 'fresh';
  const fresh = age === 'fresh';
  return { age, at: s.at, ob: fresh ? s.ob : 0, mk: fresh ? s.mk : '', nm: s.nm, gp: s.gp, q: fresh && quote === true && s.mk === 'WAIT' ? s.q || '' : '', seen: false };
}
// a background check (#33) read the restored pane's page now: what it showed replaces the saved values (no longer 前回・未再確認)
function rechecked(r, mk, q, now) {
  if (!r) return r;
  const m = MARKS.includes(mk) ? mk : '';
  return { ...r, age: 'fresh', seen: true, mk: m, ob: okTime(now) ? now : 0, q: m === 'WAIT' ? quoteStr(q) : '' };
}

// the line in a restored pane's placeholder (local time; the date only when it is not today)
const pad = n => String(n).padStart(2, '0');
function when(t, now) {
  const d = new Date(t), n = new Date(now), hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function label(r, now) {
  if (!r) return '';
  if (r.seen) return `再確認: ${MARK_JA[r.mk] || 'マーカーなし'}`;
  if (r.age === 'old') return '前回の記録・未再確認（7日以上前のため状態は表示しません）';
  if (r.age === 'clock') return '前回の記録・未再確認（時刻が合わないため状態は表示しません）';
  return `${r.mk ? `前回 ${MARK_JA[r.mk]}` : '前回の記録'}・未再確認（${when(r.ob, now)} 時点）`;
}

module.exports = { SNAP_VERSION, NAME_MAX, QUOTE_MAX, MAX_AGE_MS, SKEW_MS, MARKS, CODES, markOf, clean, same, make, plan, rechecked, when, label };
