'use strict';
const { test: t } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/pane-color');

t('eight muted colours plus なし; every wash is translucent', () => {
  assert.deepEqual(C.NAMES, ['none', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']);
  assert.equal(C.ja('none'), 'なし');
  assert.equal(C.hex('none'), null);
  C.NAMES.filter(n => n !== 'none').forEach(n => {
    assert.match(C.hex(n), /^#[0-9a-f]{6}$/);
    const d = C.wash(n, true), l = C.wash(n, false);
    assert.match(d, /^rgba\(/);
    assert.match(l, /^rgba\(/);
    const op = Number(d.replace(/^.*,\s*/, '').replace(/\)$/, ''));
    assert.ok(op > 0 && op <= 0.18, n + ' dark opacity ' + op);
    assert.ok(C.washCss(n, true).includes('pointer-events:none'));
    assert.ok(!C.washCss(n, true).includes('http'));
  });
  assert.equal(C.washCss('none', true), '');
});

t('botKey: grok.com/bot/<id> is the id; other URLs are origin+path; junk is empty', () => {
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  assert.equal(C.botKey('https://grok.com/bot/' + id), 'bot:' + id);
  assert.equal(C.botKey('https://grok.com/bot/' + id.toUpperCase() + '/?x=1#h'), 'bot:' + id);
  assert.equal(C.botKey('https://example.com/app/'), 'url:https://example.com/app');
  assert.equal(C.botKey('https://user:pass@x.com/'), '');
  assert.equal(C.botKey('not a url'), '');
  assert.equal(C.botKey(''), '');
});

t('setBg / lookup / cleanMap: none drops the entry; unknown keys dropped; per-bot not per-pane', () => {
  const k = 'bot:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const m = C.setBg('blue', {}, k);
  assert.deepEqual(m, { [k]: 'blue' });
  assert.equal(C.lookup(m, k, 'red'), 'blue');
  assert.equal(C.lookup(m, 'url:https://x.com', 'red'), 'red');
  assert.deepEqual(C.setBg('none', m, k), {});
  assert.equal(C.validMap({ [k]: 'teal' }), true);
  assert.equal(C.validMap({ [k]: 'none' }), false);
  assert.equal(C.validMap({ bad: 'blue' }), false);
  assert.deepEqual(C.cleanMap({ [k]: 'teal', junk: 'red', x: 'none' }), { [k]: 'teal' });
});
