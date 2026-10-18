// Notification delivery (#61): pure rules, no electron (test/notification-policy.test.js). Every time comes in as an argument; main.js owns the
// state object, the timer, the Notification objects and every side effect. It sits on top of what already decides that a pane alerts at all
// (canAlert + pane-state.js alert / DUP_ALERT): this only decides whether / how that alert reaches macOS. Glow, unread, the Dock badge and the
// unopened (cyan) state are never touched here - only the delivery.
//  - one event, one delivery: eventKey = pane id + its world generation (p.obs.gen) + kind + a short hash of the report key (pane-state.js
//    alertKey: user / bot / fp). Never page text, a URL or a name. Keys delivered or consumed are kept (at most KEEP_N, KEEP_MS; memory only,
//    so a restart starts empty - the first scan / background-check result of a launch is a baseline and never an event in main).
//  - a short window: candidates within WINDOW_MS of the first one become one notification; a pane is counted once (its latest candidate kept).
//    One pane: its own notification as before (title = its name, body = counts); two or more: 「Bots：確認待ち n件」 (no names, no text).
//  - suppressed (app notifications off / the pane muted / quiet hours): the candidate is consumed - its key is kept, nothing is queued, nothing
//    comes out when the suppression ends.
const WINDOW_MS = 4000;                     // aggregation window from the first candidate
const KEEP_N = 200, KEEP_MS = 24 * 3600000; // delivered / consumed keys remembered
const KINDS = ['ask', 'probe', 'update'];   // bot asks (live page) / background check found something new while asleep / a generic page update
// diagnostics (= diagnostics.js NOTIFY_CODES; checked by the test): one pane / merged sent, duplicate, consumed while muted / in quiet hours,
// dropped at delivery (pane closed / now in front of the user), click: pane opened / pane gone or changed (front only) / merged (front only)
const CODES = ['SENT', 'MERGED', 'DUP', 'MUTED', 'QUIET', 'GONE', 'SEEN', 'OPEN', 'STALE', 'FRONT'];
const QUIET_DEF = { on: false, from: '22:00', to: '07:00' };
const QUIET_PRESETS = [['22:00', '07:00'], ['23:00', '08:00'], ['00:00', '06:00']];
const isNo = v => Number.isSafeInteger(v) && v > 0;

// FNV-1a 32 bit, base 36: the report key is never kept as is (it carries the page's fingerprint hash)
function hash(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
// { pane, gen, kind, key } -> 'pane.gen.kind.hash', or '' when any part is missing / invalid
function eventKey({ pane, gen, kind, key } = {}) {
  if (!isNo(pane) || !isNo(gen) || !KINDS.includes(kind) || typeof key !== 'string' || !key) return '';
  return `${pane}.${gen}.${kind}.${hash(key)}`;
}

// 'H:MM' / 'HH:MM' -> minutes of the day, else null
function minutes(s) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
const hm = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
// settings.quietHours as saved (free form) -> { on, from, to } with valid times (an invalid time -> the default one)
function quietOf(v) {
  const q = v && typeof v === 'object' ? v : {}, f = minutes(q.from), t = minutes(q.to);
  return { on: q.on === true, from: f == null ? QUIET_DEF.from : hm(f), to: t == null ? QUIET_DEF.to : hm(t) };
}
// is `now` (ms) inside the quiet hours, in local time? from..to, to excluded; across midnight when from > to; from = to is no range
function inQuiet(v, now) {
  const q = quietOf(v);
  if (!q.on || !Number.isFinite(now)) return false;
  const d = new Date(now), m = d.getHours() * 60 + d.getMinutes(), f = minutes(q.from), t = minutes(q.to);
  if (f === t) return false;
  return f < t ? m >= f && m < t : m >= f || m < t;
}

const createState = () => ({ sent: [], pend: null });     // sent: [[key, at]] oldest first; pend: { at, items: [candidate] }
const prune = (sent, now) => sent.filter(([, at]) => now - at < KEEP_MS).slice(-KEEP_N);   // a clock set back keeps them (never re-delivers)
// a candidate { pane, gen, kind, key, ...whatever main needs back } at `now`; gate = { muted, quiet } (muted: app notifications off or the pane
// muted). -> { st, code, ek }: code 'BAD' (no key) | 'DUP' | 'MUTED' / 'QUIET' (consumed) | 'OPEN' (a window started: take it at st.pend.at +
// WINDOW_MS) | 'ADDED' (joined the window) | 'SAME_PANE' (that pane was in the window already: its newer candidate replaces the older one).
// main takes a due window (take) before offering, so a candidate at / after the due time starts the next window.
function offer(st, cand, now, gate = {}) {
  const s = st && Array.isArray(st.sent) ? st : createState();
  const ek = eventKey(cand || {});
  if (!ek) return { st: s, code: 'BAD', ek };
  const sent = prune(s.sent, now);
  if (sent.some(([k]) => k === ek)) return { st: { ...s, sent }, code: 'DUP', ek };
  const kept = [...sent, [ek, now]].slice(-KEEP_N);
  if (gate.muted) return { st: { ...s, sent: kept }, code: 'MUTED', ek };
  if (inQuiet(gate.quiet, now)) return { st: { ...s, sent: kept }, code: 'QUIET', ek };
  const item = { ...cand, ek };
  if (!s.pend) return { st: { sent: kept, pend: { at: now, items: [item] } }, code: 'OPEN', ek };
  const i = s.pend.items.findIndex(x => x.pane === cand.pane);
  const items = i < 0 ? [...s.pend.items, item] : s.pend.items.map((x, j) => j === i ? item : x);
  return { st: { sent: kept, pend: { ...s.pend, items } }, code: i < 0 ? 'ADDED' : 'SAME_PANE', ek };
}
// the window at `now`: -> { st, items, code } code '' (none) | 'WAIT' (not due: due = its time) | 'MUTED' / 'QUIET' (turned on meanwhile:
// consumed, items for counting only) | 'DUE' (items: one per pane, to be delivered after main dropped closed / muted / seen panes)
function take(st, now, gate = {}) {
  const s = st && Array.isArray(st.sent) ? st : createState();
  if (!s.pend) return { st: s, items: [], code: '' };
  const due = s.pend.at + WINDOW_MS;
  if (now < due) return { st: s, items: [], code: 'WAIT', due };
  const out = { st: { ...s, pend: null }, items: s.pend.items };
  return { ...out, code: gate.muted ? 'MUTED' : inQuiet(gate.quiet, now) ? 'QUIET' : 'DUE' };
}
// what is left to deliver -> null | { n: 1, item } (that pane's own notification) | { n, title, body, items } (merged: the title / body are
// counts only, no names / text; items only for the click to find a window)
function compose(items) {
  const list = [];
  for (const x of Array.isArray(items) ? items : []) { if (!x) continue; const i = list.findIndex(y => y.pane === x.pane); if (i < 0) list.push(x); else list[i] = x; }
  if (!list.length) return null;
  if (list.length === 1) return { n: 1, item: list[0] };
  return { n: list.length, title: `Bots：確認待ち ${list.length}件`, body: 'クリックでBotsを表示', items: list };
}
// a click on a one-pane notification: may it open that pane? Only the same pane (id), still open, in the generation it was sent for
const clickOk = (item, p) => !!item && !!p && p.id === item.pane && !!p.obs && !p.obs.closed && p.obs.gen === item.gen;

module.exports = { WINDOW_MS, KEEP_N, KEEP_MS, KINDS, CODES, QUIET_DEF, QUIET_PRESETS, hash, eventKey, minutes, quietOf, inQuiet, createState, offer, take, compose, clickOk };
