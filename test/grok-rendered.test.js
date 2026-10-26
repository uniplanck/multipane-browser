// node test/grok-rendered.test.js — run main's actual page snippets without Electron or a live page.
const assert = require('assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const declaration = name => {
  const match = main.match(new RegExp('^const ' + name + ' = [\\s\\S]*?`;', 'm'));
  assert(match, name);
  return match[0];
};
const { probeCode, GROK_RENDERED } = vm.runInNewContext([
  declaration('GROK_COMPOSER_JS'), declaration('probeCode'), declaration('GROK_RENDERED'), '({ probeCode, GROK_RENDERED })'
].join('\n'));

function element(tagName, { ariaHidden, parentElement = null, width = 439, height = 42, contentEditable = 'inherit' } = {}) {
  return {
    tagName, ariaHidden, parentElement, contentEditable,
    closest(selector) {
      assert.strictEqual(selector, '[aria-hidden="true"]');
      for (let el = this; el; el = el.parentElement) if (el.ariaHidden === 'true') return el;
      return null;
    },
    getBoundingClientRect: () => ({ width, height })
  };
}
const hidden = () => element('TEXTAREA', { ariaHidden: 'true', width: 463, height: 14 });
const composer = options => element('DIV', { contentEditable: 'true', ...options });
function check(name, elements, probe, rendered, { text = 'メインコンテンツへスキップ', pathname = '/bot/test-bot', links = [] } = {}) {
  const context = vm.createContext({
    location: { pathname },
    document: {
      body: { innerText: text },
      querySelectorAll(selector) {
        if (selector === 'a[href]') return links;
        assert.strictEqual(selector, 'textarea, [contenteditable="true"], [contenteditable=""]');
        return elements.filter(el => el.tagName === 'TEXTAREA' || ['true', ''].includes(el.contentEditable));
      }
    }
  });
  assert.strictEqual(vm.runInContext(probeCode('test-bot'), context), probe, `${name}: probe`);
  assert.strictEqual(vm.runInContext(GROK_RENDERED('test-bot'), context), rendered, `${name}: watchdog`);
}

check('only aria-hidden autosize textarea with non-zero size', [hidden()], 'nolink', false);
const ancestor = element('DIV', { ariaHidden: 'true' });
for (const child of [element('TEXTAREA', { parentElement: ancestor }), composer({ parentElement: ancestor })]) {
  check('editable inside an aria-hidden ancestor', [child], 'nolink', false);
}
check('real contenteditable and hidden autosize textarea', [composer(), hidden()], 'rendered', true);
check('ordinary textarea', [element('TEXTAREA')], 'rendered', true);
check('empty contenteditable attribute, aria-hidden false', [composer({ contentEditable: '', ariaHidden: 'false' })], 'rendered', true);
for (const size of [{ width: 0 }, { height: 0 }]) {
  check('zero-size editables', [element('TEXTAREA', size), composer(size), hidden()], 'nolink', false);
}
check('Page not found', [hidden()], 'notfound', true, { text: 'Page not found' });
check('composer still takes precedence over not-found text', [composer()], 'rendered', true, { text: 'Page not found' });
check('composer on another bot path', [composer()], 'nolink', false, { pathname: '/bot/other' });
let clicks = 0;
check('blank page still clicks the matching sidebar link', [hidden()], 'clicked', false, {
  links: [{ getAttribute: () => '/bot/test-bot', click: () => clicks++ }]
});
assert.strictEqual(clicks, 1);
console.log('all passed: Grok probe / rendered composer detection');
