// Pure rules for auto-sleep (unit-tested in test/sleep.test.js). Working / unmarked panes never sleep.
const SLEEP_DONE_MS = 60000;      // 🟣 終了: sleeps 1 minute after it became 終了
const SLEEP_WAIT_MS = 1800000;    // 🟢 待機中 (also the old 入力待機中 wording): sleeps 30 minutes after
// state: { working, done, waiting } -> delay in ms, or null when the pane must not auto-sleep
function sleepDelayFor(state, waitMs = SLEEP_WAIT_MS, doneMs = SLEEP_DONE_MS) {
  if (!state || state.working) return null;
  if (state.done) return doneMs;
  if (state.waiting) return waitMs;
  return null;
}
// true when enough quiet time has passed: since = latest of (state became waiting/done, last interaction, last typing, last load)
function sleepDue(state, since, now, waitMs, doneMs) { const d = sleepDelayFor(state, waitMs, doneMs); return d != null && now - since >= d; }
// Showing / loading / fixing a woken view is not user intent. A native focus event may only keep the selected pane's existing keyboard owner.
// Main authorizes an explicit pane click / navigation before focusing it; chrome, overlays and other panes otherwise keep the keyboard.
function mayKeepPaneFocus({ paneId, focusedId, sleeping = false, ownsKeyboard = false } = {}) {
  return paneId != null && paneId === focusedId && !sleeping && ownsKeyboard;
}
// Who the sleeping placeholder is about: { name, group }. h1 = page heading (the bot's name, or the room name in a group chat),
// hdr = page header text (same as h1 for a 1:1 bot, the participant list for a group room), userName = the pane's own name, title = tab title.
const cleanId = s => String(s || '').replace(/\s*[-|–—]\s*Grok\s*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 80);
function sleepIdentity({ h1, hdr, userName, title } = {}) {
  const t = cleanId(title), a = cleanId(h1) || t, b = cleanId(hdr), u = cleanId(userName);
  const isGroup = !!(a && b && a.toLowerCase() !== b.toLowerCase());
  let name = u || (isGroup ? b : a) || t, group = isGroup ? a : '';
  if (group && name.toLowerCase() === group.toLowerCase()) group = '';
  return { name, group };
}
module.exports = { SLEEP_DONE_MS, SLEEP_WAIT_MS, sleepDelayFor, sleepDue, sleepIdentity, mayKeepPaneFocus };
