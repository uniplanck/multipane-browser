// Background check freshness / backoff (#33): pure rules, no electron (test/probe-policy.test.js). main.js keeps one state per sleeping pane
// (p.pb, memory only: never in panes.json, new for every sleep) and does what these say; the time and the base interval are arguments.
//   pb = { lastAttemptAt, lastSuccessAt, failureCount, nextEligibleAt, kind }
// Success is only a usable, stable scan of the expected conversation that became a result (SAME / CHANGED / BASELINE). Unsure / timeout / a
// sign-in or other site / not found / error are failures: never 'nothing new', lastSuccessAt stays, 'unopened' is not touched (pane-state.js).
// A check cut short (woke / aborted / for an older sleep) is no failure. Waits after consecutive failures: 1/2/4/8/12 x the base (5/10/20/40/60
// min at the default 5 min; MPB_CHECK_SEC sets the base, so the same steps in seconds), never more than 60 min; a success goes back to the base.
// A clearly identified sign-in page (authPage / the page's own AUTH_REQUIRED code) stops every check of the shared session until the user
// resumes them (main: probeAuthHold); anything less certain (another site, DOM_UNKNOWN, a timeout) only backs that pane off.
const BASE_MS = 5 * 60000;                   // = main.js SLEEP_CHECK_MS without MPB_CHECK_SEC
const STEPS = [1, 2, 4, 8, 12];              // wait after 1, 2, 3, 4, 5+ failures in a row, in base intervals
const CAP_MS = 60 * 60000;                   // no wait is longer (unless the base itself is)
const KINDS = ['ok', 'unsure', 'timeout', 'offsite', 'auth', 'notfound', 'error', 'aborted'];
const FAILS = ['unsure', 'timeout', 'offsite', 'auth', 'notfound', 'error'];
// diagnostics (= part of diagnostics.js EVENTS.probe; checked by the test): a failure backed off (n = failures in a row), the sign-in stop, 確認を再開
const CODES = ['BACKOFF', 'AUTH_HOLD', 'RESUME'];
const COUNT_MAX = 9999;

const num = v => typeof v === 'number' && Number.isFinite(v) ? v : 0;
const baseOf = b => typeof b === 'number' && Number.isFinite(b) && b > 0 ? b : BASE_MS;
function clean(pb) {
  const o = pb && typeof pb === 'object' ? pb : {};
  return { lastAttemptAt: num(o.lastAttemptAt), lastSuccessAt: num(o.lastSuccessAt), failureCount: Number.isSafeInteger(o.failureCount) && o.failureCount > 0 ? Math.min(o.failureCount, COUNT_MAX) : 0,
    nextEligibleAt: num(o.nextEligibleAt), kind: KINDS.includes(o.kind) ? o.kind : '' };
}
// the wait after `failures` in a row (0: the base)
function waitFor(failures, base) {
  const b = baseOf(base), n = Number.isSafeInteger(failures) && failures > 0 ? failures : 0;
  return n ? Math.max(b, Math.min(CAP_MS, STEPS[Math.min(n, STEPS.length) - 1] * b)) : b;
}
// a new sleep: the first check one base interval after it fell asleep (as before)
const init = (now, base) => ({ lastAttemptAt: 0, lastSuccessAt: 0, failureCount: 0, nextEligibleAt: num(now) + baseOf(base), kind: '' });
// the state to keep: the next check is never further away than the wait it stands for (the clock was set back / an odd value). A time in the
// past only means due; the check then counts from its own time
function settle(pb, now, base) {
  const s = clean(pb), t = num(now), w = waitFor(s.failureCount, base);
  if (s.nextEligibleAt > t + w) s.nextEligibleAt = t + w;
  return s;
}
const isDue = (pb, now) => clean(pb).nextEligibleAt <= num(now);
// the pane to check now, of those that may be checked at all (asleep, not focused / maximized): the one due longest; one per call
function pick(list, now) {
  let best = null;
  for (const q of Array.isArray(list) ? list : []) {
    if (!q || !isDue(q.pb, now)) continue;
    if (!best || clean(q.pb).nextEligibleAt < clean(best.pb).nextEligibleAt) best = q;
  }
  return best;
}
// a check starts: an attempt now; if it never reports, the next one waits as for its state so far
function start(pb, now, base) {
  const s = settle(pb, now, base), t = num(now);
  return { ...s, lastAttemptAt: t, nextEligibleAt: t + waitFor(s.failureCount, base) };
}
// a check ended with `kind` -> the new state (the wait counts from its end)
function record(pb, kind, now, base) {
  const s = clean(pb), t = num(now), k = KINDS.includes(kind) ? kind : 'error';
  if (k === 'ok') return { ...s, kind: k, failureCount: 0, lastSuccessAt: t, nextEligibleAt: t + baseOf(base) };
  if (k === 'aborted') return { ...s, kind: k, nextEligibleAt: t + waitFor(s.failureCount, base) };
  const n = Math.min(s.failureCount + 1, COUNT_MAX);
  return { ...s, kind: k, failureCount: n, nextEligibleAt: t + waitFor(n, base) };
}
const failed = kind => FAILS.includes(kind);
// 確認を再開 (after a sign-in stop): the pane that saw the sign-in page starts over and is due now; the others keep their state. The usual
// tick then checks one at a time
function resume(pb, now) {
  const s = clean(pb);
  return s.kind === 'auth' ? { ...s, kind: '', failureCount: 0, nextEligibleAt: num(now) } : s;
}

// a sign-in page, from the hidden window's last URL only (never kept / logged): https, the x.ai account host (any page of it) or a sign-in
// path on grok.com / a sign-in provider. Leaving grok.com for anything else, or an unreadable page, is no evidence of a sign-in.
const ACCOUNT_HOSTS = ['accounts.x.ai'];
const SIGNIN_HOSTS = ['grok.com', 'x.ai', 'x.com', 'twitter.com', 'accounts.google.com', 'appleid.apple.com'];
const SIGNIN_SEGS = ['sign-in', 'signin', 'log-in', 'login', 'oauth', 'oauth2', 'authorize', 'auth'];
function authPage(u) {
  let x; try { x = new URL(String(u)); } catch { return false; }
  if (x.protocol !== 'https:' || x.username || x.password || (x.port && x.port !== '443')) return false;
  const h = x.hostname.toLowerCase().replace(/\.$/, '');
  if (ACCOUNT_HOSTS.includes(h)) return true;
  return SIGNIN_HOSTS.includes(h) && x.pathname.toLowerCase().split('/').some(s => SIGNIN_SEGS.includes(s));
}
// a check that ended without a stable scan -> its kind. error: it threw; woke: the pane is awake; why: the check loop's ok / timeout / abort /
// offsite / notfound; issue: the last scan's snapIssue code ('' none); auth: authPage() of the window's last URL
function kindOf({ error, woke, why, issue, auth } = {}) {
  if (woke || why === 'abort') return 'aborted';
  if (error) return 'error';
  if (auth === true || issue === 'AUTH_REQUIRED') return 'auth';
  if (why === 'offsite') return 'offsite';
  if (why === 'notfound') return 'notfound';
  if (why === 'timeout') return issue ? 'unsure' : 'timeout';
  return 'error';
}

// the line in a sleeping pane's placeholder (hh:mm, local time). off: checks turned off in the settings; hold: stopped after a sign-in page
const hm = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function label(pb, { hold = false, off = false } = {}) {
  if (off) return '';
  const s = clean(pb), last = s.lastSuccessAt ? `最終確認 ${hm(s.lastSuccessAt)}` : '';
  if (hold) return ['ログイン要確認で新着確認を停止中', last].filter(Boolean).join('・');
  if (s.failureCount) return [last, `確認失敗（${s.failureCount}回）`, `次回 ${hm(s.nextEligibleAt)}`].filter(Boolean).join('・');
  return last ? `${last}・次回 ${hm(s.nextEligibleAt)}` : `次回確認 ${hm(s.nextEligibleAt)}`;
}

module.exports = { BASE_MS, STEPS, CAP_MS, KINDS, FAILS, CODES, waitFor, init, settle, isDue, pick, start, record, failed, resume, authPage, kindOf, label };
