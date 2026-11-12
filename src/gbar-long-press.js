// Pure pointer-gesture state. The renderer supplies event timestamps; no DOM,
// timers or navigation here. A long hold acts once HOLD_MS has passed, without
// a release: the renderer's timer calls fire(state, press.at + HOLD_MS).
const GbarLongPress = (() => {
  const HOLD_MS = 500, MOVE_PX = 6;
  const idle = () => ({ press: null, suppressClick: false });
  const plainLeft = e => e.button === 0 && e.isPrimary !== false && !e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey;
  const matches = (state, e) => state.press && (!e || e.pointerId === state.press.id);

  function begin(e) {
    return { press: plainLeft(e) ? { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp } : null, suppressClick: false };
  }
  function cancel(state, e) {
    return matches(state, e) ? { press: null, suppressClick: true } : state;
  }
  function move(state, e) {
    return matches(state, e) && Math.hypot(e.clientX - state.press.x, e.clientY - state.press.y) > MOVE_PX ? cancel(state, e) : state;
  }
  // timeStamp is on the clock of the press event. Fires at most once per press:
  // the press is consumed, so a late timer, the release and the click do nothing more.
  function fire(state, timeStamp) {
    if (!state.press || !(timeStamp - state.press.at >= HOLD_MS)) return { state, openHere: false };
    return { state: { press: null, suppressClick: true }, openHere: true };
  }
  function release(state, e) {
    if (!matches(state, e)) return { state, openHere: false };
    const moved = move(state, e);
    // Still armed at HOLD_MS or later: the release overtook the renderer's timer, the hold time has passed all the same.
    const fired = fire(moved, e.timeStamp);
    return { state: { press: null, suppressClick: fired.state.suppressClick }, openHere: fired.openHere };
  }
  function click(state, e) {
    // Keyboard / accessibility activation (detail=0) must not be swallowed if
    // Chromium sent no click after a cancelled pointer gesture.
    return { state: idle(), suppress: state.suppressClick && e.detail !== 0 };
  }
  return { HOLD_MS, MOVE_PX, idle, begin, cancel, move, fire, release, click };
})();
if (typeof module === 'object' && module.exports) module.exports = GbarLongPress;
