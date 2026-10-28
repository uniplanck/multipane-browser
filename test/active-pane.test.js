// Focus decoration must not move or cover the Electron WebContentsView.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
const css = read('style.css'), main = read('main.js'), renderer = read('renderer.js');
const rule = selector => {
  const start = css.indexOf(selector + '{'); assert(start >= 0, selector);
  return css.slice(start + selector.length + 1, css.indexOf('}', start));
};
const pane = rule('.pane'), focused = rule('.pane.focused'), unreadFocused = rule('.pane.focused.unread');
assert(!/border(?:-width)?\s*:/.test(focused));
assert(/outline:3px solid var\(--accent\)/.test(focused) && /box-shadow:/.test(focused));
assert(!/outline-color|box-shadow/.test(pane.split('transition:')[1]), 'focus decoration changes without a transition');
assert(/outline:3px solid var\(--accent\)/.test(unreadFocused) && /var\(--glow\)/.test(unreadFocused) && /animation:none/.test(unreadFocused));
assert(/var\(--pc\)/.test(rule('.pane.colored .head::before')));
assert(/var\(--pc\)/.test(rule('.pane.focused.colored .head')));
assert(/var\(--pc\)/.test(rule('.pane.colored.unread:not(.focused) .head')) && /var\(--glow\)/.test(rule('.pane.colored.unread:not(.focused) .head')));
assert(/var\(--accent\)/.test(rule('.pane.focused.unread .head')) && /var\(--glow\)/.test(rule('.pane.focused.unread .head')));
assert(/opacity:\.75/.test(rule('.pane:not(.focused) .title')) && /font-weight:700/.test(rule('.pane.focused .title')));
assert(/font-weight:700/.test(rule('.pane.focused .title b')));
assert(/d\.classList\.toggle\('focused', p\.id === s\.focusedId\)/.test(renderer));
assert(/const PHEAD = 30/.test(main) && /const GAP = 6/.test(main));
const source = main.match(/const viewRect = c => \([^\n]+\);/)[0];
const viewRect = vm.runInNewContext(`${source}\nviewRect`, { PHEAD: 30 });
assert.deepStrictEqual(JSON.parse(JSON.stringify(viewRect({ x: 6, y: 82, w: 300, h: 200 }))), { x: 6, y: 112, width: 300, height: 170 });
assert(css.includes('body.light{') && /--accent:#0a84ff/.test(css), 'accent remains defined for both themes');
console.log('ok  focused pane outline, header priorities and unchanged view geometry');
