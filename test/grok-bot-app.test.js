'use strict';
const { test: t } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const G = require('../src/grok-bot-app');

t('the path is a constant under /Applications and is not taken from arguments', () => {
  assert.equal(G.APP, '/Applications/Grok Bot.app');
  assert.equal(G.plan('linux', { existsSync: () => true, statSync: () => ({ isDirectory: () => true }) }), 'platform');
  assert.equal(G.open.length, 1); // one options bag; no path argument
});

t('missing app: no launch, warn toast, no path in the text', async () => {
  let n = 0;
  const r = await G.open({ platform: 'darwin', fs: { existsSync: () => false, statSync: () => { throw new Error('no'); } },
    execFile: () => { n++; }, openPath: async () => { n++; return ''; } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'missing');
  assert.equal(r.toast.text, 'Grok Botアプリが見つかりません');
  assert.equal(r.toast.kind, 'warn');
  assert.equal(n, 0);
  assert.ok(!r.toast.text.includes('/Applications'));
});

t('present: open -a with the exact path once, no toast', async () => {
  const calls = [];
  const r = await G.open({
    platform: 'darwin',
    fs: { existsSync: () => true, statSync: () => ({ isDirectory: () => true }) },
    execFile: (cmd, args, cb) => { calls.push([cmd, ...args]); cb(null); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.toast, undefined);
  assert.deepEqual(calls, [['/usr/bin/open', '-a', G.APP]]);
});

t('open -a failure: fail toast; openPath is used only when execFile is absent', async () => {
  const r = await G.open({
    platform: 'darwin',
    fs: { existsSync: () => true, statSync: () => ({ isDirectory: () => true }) },
    execFile: (cmd, args, cb) => cb(new Error('nope')),
  });
  assert.equal(r.ok, false);
  assert.equal(r.toast.text, 'Grok Botを開けませんでした');
  assert.equal(r.toast.kind, 'err');
  const paths = [];
  const r2 = await G.open({
    platform: 'darwin',
    fs: { existsSync: () => true, statSync: () => ({ isDirectory: () => true }) },
    openPath: async (p) => { paths.push(p); return ''; },
  });
  assert.equal(r2.ok, true);
  assert.deepEqual(paths, [G.APP]);
  const r3 = await G.open({
    platform: 'darwin',
    fs: { existsSync: () => true, statSync: () => ({ isDirectory: () => true }) },
    openPath: async () => 'failed',
  });
  assert.equal(r3.ok, false);
  assert.equal(r3.toast.kind, 'err');
});

t('non-darwin: no launch', async () => {
  let n = 0;
  const r = await G.open({ platform: 'win32', fs: { existsSync: () => true, statSync: () => ({ isDirectory: () => true }) }, execFile: () => n++ });
  assert.equal(r.code, 'platform');
  assert.equal(n, 0);
  assert.equal(r.toast.kind, 'warn');
});

void path;
