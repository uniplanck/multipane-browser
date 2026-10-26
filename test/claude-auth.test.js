// node test/claude-auth.test.js — pure decisions; no CLI, Keychain or account access.
const assert = require('assert');
const A = require('../src/claude-auth');
const now = 1800000000000, token = { t: 'fixture', exp: now - 1, refreshExp: now - 1 };
assert.equal(A.state(token, now), 'relogin');
for (const exp of [0, null, undefined, NaN, -1, Infinity]) assert.equal(A.state({ ...token, exp }, now), 'relogin');
assert.equal(A.state({ ...token, exp: now + 1 }, now), 'ok');
assert.equal(A.state({ ...token, refreshExp: now + 1 }, now), 'expired');
assert.equal(A.state({ ...token, refreshExp: null }, now), 'expired');
assert.equal(A.state(null, now), 'missing');
assert.equal(A.canRefresh('claude', { auth: true, relogin: true }, {}, now), false);
assert.equal(A.canRefresh('claude', { auth: true }, {}, now), true);
assert.equal(A.canRefresh('claude', { auth: true }, { refreshTry: now - 1000 }, now), false);
assert.equal(A.canRefresh('claude', { auth: true }, { nextAt: now + 1 }, now), false);
assert.equal(A.canRefresh('claude:web', { auth: true }, {}, now), false);
assert.equal(A.canRefresh('codex', { auth: true }, {}, now), false);
assert.equal(A.canRefresh('claude', { status: 429 }, {}, now), false);
const d = A.dialog(true);
assert.deepEqual(d.buttons, ['ターミナルでログイン', '閉じる']);
assert.equal(d.defaultId, 0); assert.equal(d.cancelId, 1);
assert.equal(d.actions[d.defaultId], 'terminal');
assert(d.detail.includes('ターミナルで /login を入力し、ブラウザで承認してください'));
assert(A.dialog(false).actions[0] === 'auto');
assert.deepEqual(A.LOGIN_POLLS, [30000, 90000, 180000, 300000, 600000]);
console.log('all passed: Claude expiry, auto refresh gate, login dialog and poll times');

// keychain with expiresAt 0 + expired refresh, older file without refreshTokenExpiresAt: re-login
{ const kc = { t: 'k', exp: 0, refreshExp: now - 1 }, file = { t: 'f', exp: now - 5 };
  const c = A.pick([kc, file]); assert.equal(c.t, 'f'); assert.equal(A.state(c, now), 'relogin');
  assert.equal(A.pick([null, null]), null); assert.equal(A.pick([{ t: 'a', exp: now + 9 }]).refreshExp, undefined); }
