// node test/gbar-long-press.test.js — pure transitions with event timestamps.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const Hold = require('../src/gbar-long-press');
const event = (timeStamp = 0, extra = {}) => ({ button: 0, pointerId: 1, isPrimary: true, clientX: 20, clientY: 30, timeStamp, ...extra });

assert.strictEqual(Hold.HOLD_MS, 500);
assert.strictEqual(Hold.MOVE_PX, 6);
// The hold acts when HOLD_MS has passed (the renderer's timer calls fire), without a release.
for (const [elapsed, expected] of [[0, false], [499, false], [500, true], [501, true], [5000, true]]) {
  const pressed = Hold.begin(event(1000)), snapshot = JSON.stringify(pressed);
  const fired = Hold.fire(pressed, 1000 + elapsed);
  assert.strictEqual(fired.openHere, expected);
  assert.strictEqual(JSON.stringify(pressed), snapshot, 'fire does not mutate its input');
  if (!expected) { assert.strictEqual(fired.state, pressed, 'too early: still armed, nothing changed'); continue; }
  assert.strictEqual(fired.state.press, null);
  assert.strictEqual(Hold.fire(fired.state, 1000 + elapsed).openHere, false, 'a second timer never fires twice');
  assert.strictEqual(Hold.fire(fired.state, 9000).state, fired.state);
  const released = Hold.release(fired.state, event(1000 + elapsed + 200));
  assert.strictEqual(released.openHere, false, 'the release after a fired hold does nothing more');
  assert.strictEqual(released.state, fired.state);
  const click = Hold.click(released.state, { detail: 1 });
  assert.strictEqual(click.suppress, true, 'the click after a fired hold is consumed');
  assert.strictEqual(Hold.click(click.state, { detail: 1 }).suppress, false, 'only the following click is consumed');
  assert.strictEqual(Hold.click(fired.state, { detail: 0 }).suppress, false, 'keyboard activation survives');
}
// Released before HOLD_MS: a short press, as before. Nothing opens, the click goes through, a late timer finds nothing.
for (const elapsed of [0, 100, 499]) {
  const pressed = Hold.begin(event(1000)), snapshot = JSON.stringify(pressed);
  const result = Hold.release(pressed, event(1000 + elapsed));
  assert.strictEqual(result.openHere, false);
  assert.strictEqual(result.state.press, null);
  assert.strictEqual(JSON.stringify(pressed), snapshot, 'release does not mutate its input');
  assert.strictEqual(Hold.fire(result.state, 1500).openHere, false, 'the timer of a released press never fires');
  assert.strictEqual(Hold.click(result.state, { detail: 1 }).suppress, false);
  assert.strictEqual(Hold.release(result.state, event(7000)).openHere, false, 'duplicate release never opens');
}
// A release that overtook the timer at HOLD_MS or later is the same hold: once, and the timer then finds nothing.
{
  const late = Hold.release(Hold.begin(event(1000)), event(1500));
  assert.strictEqual(late.openHere, true);
  assert.strictEqual(late.state.press, null);
  assert.strictEqual(Hold.fire(late.state, 1500).openHere, false);
  assert.strictEqual(Hold.release(late.state, event(1600)).openHere, false);
  assert.strictEqual(Hold.click(late.state, { detail: 1 }).suppress, true);
}
// A timer left over from an earlier press cannot fire a newer one early.
assert.strictEqual(Hold.fire(Hold.begin(event(1300)), 1000 + Hold.HOLD_MS).openHere, false);
assert.strictEqual(Hold.fire(Hold.idle(), 9000).openHere, false);
assert.strictEqual(Hold.fire(Hold.begin(event(1000)), NaN).openHere, false);

// Only a plain primary left press qualifies. Modifiers retain click handling,
// even when held past the threshold.
for (const extra of [{ button: 1 }, { button: 2 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isPrimary: false }]) {
  const state = Hold.begin(event(0, extra));
  assert.strictEqual(state.press, null);
  assert.strictEqual(Hold.fire(state, 1000).openHere, false);
  assert.strictEqual(Hold.release(state, event(1000, extra)).openHere, false);
  assert.strictEqual(Hold.click(state, { detail: 1 }).suppress, false);
}

const pressed = Hold.begin(event()), snapshot = JSON.stringify(pressed);
for (const [dx, dy, cancelled] of [[0, 0, false], [6, 0, false], [0, -6, false], [3, 4, false], [6.01, 0, true], [0, -7, true], [5, 5, true]]) {
  const moved = Hold.move(pressed, event(100, { clientX: 20 + dx, clientY: 30 + dy }));
  assert.strictEqual(!moved.press, cancelled, 'Euclidean distance >6 px cancels');
  assert.strictEqual(Hold.fire(moved, 500).openHere, !cancelled);
  if (cancelled) {
    assert.strictEqual(Hold.click(moved, { detail: 1 }).suppress, true);
    assert.strictEqual(Hold.move(moved, event(200)).press, null, 'moving back does not rearm');
    assert.strictEqual(Hold.fire(Hold.move(moved, event(200)), 600).openHere, false);
    assert.strictEqual(Hold.release(moved, event(600)).openHere, false);
  }
}
assert.strictEqual(JSON.stringify(pressed), snapshot, 'move does not mutate its input');
// Recheck displacement at release, even if no pointermove was delivered.
assert.strictEqual(Hold.release(pressed, event(600, { clientX: 27 })).openHere, false);
assert.strictEqual(Hold.click(Hold.release(pressed, event(300, { clientX: 27 })).state, { detail: 1 }).suppress, true);
for (const e of [event(100), undefined]) {
  const cancelled = Hold.cancel(pressed, e); // pointerleave/cancel and dragstart
  assert.strictEqual(cancelled.press, null);
  assert.strictEqual(Hold.fire(cancelled, 700).openHere, false);
  assert.strictEqual(Hold.release(cancelled, event(700)).openHere, false);
  assert.strictEqual(Hold.click(cancelled, { detail: 1 }).suppress, true);
  assert.strictEqual(Hold.click(cancelled, { detail: 0 }).suppress, false, 'keyboard activation survives a missing pointer click');
  const restarted = Hold.begin(event(1000));
  assert.strictEqual(Hold.release(restarted, event(1100)).state.suppressClick, false, 'a fresh press clears stale suppression');
}
assert.strictEqual(JSON.stringify(pressed), snapshot, 'cancel does not mutate its input');
// Unrelated pointers cannot cancel, move or release the active pointer.
const other = event(700, { pointerId: 2, clientX: 200 });
assert.strictEqual(Hold.move(pressed, other), pressed);
assert.strictEqual(Hold.cancel(pressed, other), pressed);
assert.strictEqual(Hold.release(pressed, other).state, pressed);
assert.strictEqual(Hold.release(pressed, other).openHere, false);

// The same helper loads as a plain browser script without Node or Electron.
const browser = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/gbar-long-press.js'), 'utf8'), browser);
assert.strictEqual(vm.runInContext('GbarLongPress.HOLD_MS', browser), 500);
console.log('ok  gbar-long-press');
