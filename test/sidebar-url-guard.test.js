'use strict';
const { test: t } = require('node:test');
const assert = require('node:assert/strict');
const SR = require('../src/sidebar-rules');

const KEY = 'k=' + 'a'.repeat(64);
const good = 'https://example.com/#/p/sidebar?' + KEY;
const cur = good;

t('a complete sidebar URL is accepted; empty clears', () => {
  const r = SR.decideSidebarUrl(good, '');
  assert.equal(r.ok, true);
  assert.equal(r.code, 'OK');
  assert.ok(r.url.includes('/p/sidebar'));
  assert.ok(r.url.includes('k='));
  assert.deepEqual(SR.decideSidebarUrl('  ', cur), { ok: true, url: '', code: 'EMPTY', message: '', completed: false });
});

t('a Cursor webhook host is refused and the message does not include the URL', () => {
  for (const u of ['https://cursor.com/v1/webhook/abc', 'https://hooks.cursor.sh/routine', 'https://api.cursor.com/x']) {
    const r = SR.decideSidebarUrl(u, cur);
    assert.equal(r.ok, false, u);
    assert.equal(r.code, 'WEBHOOK', u);
    assert.equal(r.url, '');
    assert.ok(r.message.includes('NaoAIのwebhook'));
    assert.ok(!r.message.includes('http'));
    assert.ok(!r.message.includes('abc'));
  }
});

t('a non-sidebar https URL is refused', () => {
  const r = SR.decideSidebarUrl('https://example.com/other', cur);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'OTHER');
  assert.ok(r.message.includes('#/p/sidebar'));
});

t('#/p/sidebar without a key is completed from the saved URL of the same origin', () => {
  const r = SR.decideSidebarUrl('#/p/sidebar', cur);
  assert.equal(r.ok, true);
  assert.equal(r.completed, true);
  assert.ok(r.url.includes('k=' + 'a'.repeat(64)));
  assert.ok(r.url.startsWith('https://example.com/'));
  const r2 = SR.decideSidebarUrl('https://example.com/#/p/sidebar', cur);
  assert.equal(r2.ok, true);
  assert.equal(r2.completed, true);
  assert.ok(r2.url.includes('k='));
});

t('missing key with no saved key (or a different origin) is refused, not invented', () => {
  const r = SR.decideSidebarUrl('https://example.com/#/p/sidebar', '');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_KEY');
  assert.equal(r.url, '');
  const r2 = SR.decideSidebarUrl('https://other.example/#/p/sidebar', cur);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'NO_KEY');
  assert.ok(!r2.message.includes('k='));
});

t('invalid / too short schemes are refused', () => {
  assert.equal(SR.decideSidebarUrl('ftp://x/#/p/sidebar', cur).code, 'INVALID');
  assert.equal(SR.decideSidebarUrl('not a url', cur).code, 'INVALID');
});
