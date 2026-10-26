// Pure pointer-gesture state. The renderer supplies event timestamps; no DOM,
// timers or navigation here. Long holds act only on release, never at 500 ms.
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
  function release(state, e) {
    if (!matches(state, e)) return { state, openHere: false };
    const moved = move(state, e);
    const openHere = !!moved.press && plainLeft(e) && e.timeStamp - moved.press.at >= HOLD_MS;
    return { state: { press: null, suppressClick: moved.suppressClick || openHere }, openHere };
  }
  function click(state, e) {
    // Keyboard / accessibility activation (detail=0) must not be swallowed if
    // Chromium sent no click after a cancelled pointer gesture.
    return { state: idle(), suppress: state.suppressClick && e.detail !== 0 };
  }
  return { HOLD_MS, MOVE_PX, idle, begin, cancel, move, release, click };
})();
if (typeof module === 'object' && module.exports) module.exports = GbarLongPress;
