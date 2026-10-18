// Pure rules for auto-sleep (unit-tested in test/sleep.test.js). Working / unmarked panes never sleep.
const SLEEP_DONE_MS = 60000;      // 🟣 終了: sleeps 1 minute after it became 終了
const SLEEP_WAIT_MS = 600000;     // 🟢 待機中 (also the old 入力待機中 wording): sleeps 10 minutes after
// state: { working, done, waiting } -> delay in ms, or null when the pane must not auto-sleep
function sleepDelayFor(state, waitMs = SLEEP_WAIT_MS, doneMs = SLEEP_DONE_MS) {
  if (!state || state.working) return null;
  if (state.done) return doneMs;
  if (state.waiting) return waitMs;
  return null;
}
// true when enough quiet time has passed: since = latest of (state became waiting/done, last interaction, last typing, last load)
function sleepDue(state, since, now, waitMs, doneMs) { const d = sleepDelayFor(state, waitMs, doneMs); return d != null && now - since >= d; }
module.exports = { SLEEP_DONE_MS, SLEEP_WAIT_MS, sleepDelayFor, sleepDue };
