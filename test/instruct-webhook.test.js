// node test/instruct-webhook.test.js — NaoAIへの指示 (src/instruct-webhook.js): the webhook setting is stored only encrypted (safeStorage; here a fake),
// in its own 0600 file (written through a temporary file), refused without a usable safeStorage, told to the outside as { configured, host,
// available } only; the POST sends exactly the JSON body with content-type + Bearer key, follows no redirect, gives up after the timeout and
// answers fixed codes (never the URL / key / an error's text).
const fs = require('fs'), os = require('os'), path = require('path');
const IW = require('../src/instruct-webhook'), SI = require('../src/instruct-rules');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const HOOK = 'https://hooks.cursor.com/routine', KEY = 'test-key-0123456789';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xg-instruct-')), file = path.join(dir, 'instruct-webhook.json');
// a stand-in for Electron's safeStorage: reversible, but nothing of the plain text is readable in its output
const fakeSafe = (o = {}) => ({ calls: 0, isEncryptionAvailable: () => o.available !== false, getSelectedStorageBackend: o.backend ? () => o.backend : undefined,
  encryptString(s) { this.calls++; return Buffer.concat([Buffer.from('ENC1'), Buffer.from(Buffer.from(s, 'utf8').map(b => b ^ 0x5a))]); },
  decryptString(b) { this.calls++; if (o.locked || b.subarray(0, 4).toString() !== 'ENC1') throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.'); return Buffer.from(b.subarray(4).map(x => x ^ 0x5a)).toString('utf8'); } });
const store = (safe = fakeSafe(), fsx = fs) => IW.createStore({ file, safe, fs: fsx });
const leaks = v => { const s = J(v); return s.includes(KEY) || s.includes('/routine') || s.includes('https://'); };

try {
  { const s = store();
    t('nothing set: not configured, no host, encryption available', J(s.status()) === J({ configured: false, host: '', available: true }) && s.secret() === null && !fs.existsSync(file)); }
  { const safe = fakeSafe(), s = store(safe), r = s.set({ url: ' ' + HOOK + ' ', key: ' ' + KEY + '\n' });
    t('set: ok -> configured, the host only', r.ok === true && r.configured === true && r.host === 'hooks.cursor.com' && r.available === true && !leaks(r) && !('url' in r) && !('key' in r));
    const raw = fs.readFileSync(file, 'utf8'), doc = JSON.parse(raw);
    t('file: { v: 1, data: base64 } and nothing else', J(Object.keys(doc)) === J(['v', 'data']) && doc.v === 1 && /^[A-Za-z0-9+/]+=*$/.test(doc.data));
    t('file: neither the URL, its host nor the key in plain text (also not base64-decoded)', !raw.includes(KEY) && !raw.includes('cursor') && !raw.includes('routine')
      && !Buffer.from(doc.data, 'base64').toString('latin1').includes(KEY) && !Buffer.from(doc.data, 'base64').toString('latin1').includes('cursor'));
    t('file: mode 0600, no temporary file left', (fs.statSync(file).mode & 0o777) === 0o600 && fs.readdirSync(dir).join() === 'instruct-webhook.json');
    t('secret: the normalised URL + trimmed key (main\'s POST only)', J(s.secret()) === J({ url: HOOK, key: KEY }));
    t('status: { configured, host, available } only', J(s.status()) === J({ configured: true, host: 'hooks.cursor.com', available: true })); }
  { const safe = fakeSafe(), s = store(safe);
    t('a new launch (a new store) reads it back through safeStorage', J(s.status()) === J({ configured: true, host: 'hooks.cursor.com', available: true }) && J(s.secret()) === J({ url: HOOK, key: KEY }));
    const n = safe.calls; s.status(); s.secret(); s.status();
    t('...once: kept in main\'s memory afterwards (no Keychain access per call)', safe.calls === n); }
  { const s = store(fakeSafe({ locked: true }));
    t('a file it cannot decrypt (Keychain refused / another Mac): configured, no host, secret false (the send says why)', J(s.status()) === J({ configured: true, host: '', available: true }) && s.secret() === false); }
  for (const junk of ['{', '{"v":2,"data":"RU5DMQ=="}', '{"v":1}', '{"v":1,"data":""}', J({ v: 1, data: fakeSafe().encryptString(J({ url: 'http://x.example/', key: KEY })).toString('base64') }),
    J({ v: 1, data: fakeSafe().encryptString(J({ url: HOOK, key: 'short' })).toString('base64') })]) {
    fs.writeFileSync(file, junk);
    const s = store();
    t(`a broken / foreign file (${junk.slice(0, 24)}…): configured but unusable - nothing of it is used`, s.secret() === false && s.status().configured === true && s.status().host === ''); }
  { const s = store(), r = s.set({ url: HOOK, key: KEY });
    t('set over a broken file: replaced', r.ok && J(s.secret()) === J({ url: HOOK, key: KEY })); }
  // refusals: nothing written
  { fs.rmSync(file, { force: true });
    const s = store();
    const cases = [[{ url: 'http://hooks.cursor.com/x', key: KEY }, 'URL'], [{ url: 'https://evil.example/x', key: KEY }, 'URL'], [{ url: HOOK, key: 'short' }, 'KEY'], [{ url: HOOK, key: 'a b c d e f g h' }, 'KEY'],
      [{ url: HOOK }, 'KEY'], [null, 'URL'], ['x', 'URL'], [{ url: 5, key: KEY }, 'URL']];
    t('set: a bad URL / key -> URL / KEY, nothing written', cases.every(([v, code]) => { const r = s.set(v); return r.ok === false && r.code === code && !leaks(r); }) && !fs.existsSync(file));
    for (const safe of [fakeSafe({ available: false }), fakeSafe({ backend: 'basic_text' }), null, { isEncryptionAvailable() { throw new Error('not ready'); } }]) {
      const u = store(safe), r = u.set({ url: HOOK, key: KEY });
      t(`set: no usable safeStorage (${safe ? safe.getSelectedStorageBackend ? 'basic_text' : safe.encryptString ? 'unavailable' : 'throws' : 'none'}) -> UNAVAILABLE, never plain text`,
        r.ok === false && r.code === 'UNAVAILABLE' && r.available === false && !fs.existsSync(file) && u.status().available === false); }
    t('a real keyring backend on Linux is fine', store(fakeSafe({ backend: 'gnome_libsecret' })).status().available === true); }
  { const s = store(), failing = { ...fs, writeFileSync: (f, ...a) => { fs.writeFileSync(f, ...a); }, renameSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
    const u = store(fakeSafe(), failing), r = u.set({ url: HOOK, key: KEY });
    t('set: a failed write -> WRITE, the temporary file removed, nothing configured', r.ok === false && r.code === 'WRITE' && !fs.existsSync(file) && fs.readdirSync(dir).length === 0 && !leaks(r) && s.status().configured === false); }
  { const s = store(); s.set({ url: HOOK, key: KEY });
    const r = s.clear();
    t('clear: the file removed, not configured', r.ok === true && r.configured === false && !fs.existsSync(file) && s.secret() === null && J(store().status()) === J({ configured: false, host: '', available: true }));
    t('clear: nothing set -> fine', store().clear().ok === true); }
  { const s = store(); fs.writeFileSync(file, 'x', { mode: 0o644 }); const old = path.join(dir, `instruct-webhook.json.${process.pid}.tmp`); fs.writeFileSync(old, 'old', { mode: 0o644 });
    s.set({ url: HOOK, key: KEY });
    t('set: an old file / temporary file of another mode ends as 0600', (fs.statSync(file).mode & 0o777) === 0o600 && !fs.existsSync(old)); }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

// ---- the POST ----
const tests = [];
const BODY = SI.payload({ id: 'x_' + 'ab'.repeat(12), instruction: '確認して', task: { tid: 'T-1', bot: 'Writer' }, now: new Date('2026-11-01T00:00:00Z') });
const fetchOf = (answer, log) => async (url, opts) => { log.push({ url, opts }); return typeof answer === 'function' ? answer(opts) : answer; };
{ const log = [];
  tests.push(IW.post({ url: HOOK, key: KEY, body: BODY, fetch: fetchOf({ status: 200, body: { cancel: async () => { log.cancelled = true; } } }, log) }).then(r => {
    const o = log[0] && log[0].opts;
    t('post: one request to the URL, POST, the JSON body exactly', log.length === 1 && log[0].url === HOOK && o.method === 'POST' && o.body === J(BODY) && J(JSON.parse(o.body)) === J(BODY));
    t('post: headers content-type: application/json + authorization: Bearer <key>, nothing else', J(o.headers) === J({ 'content-type': 'application/json', authorization: `Bearer ${KEY}` }));
    t('post: no redirect followed, no cache, no credentials, an abort signal', o.redirect === 'error' && o.cache === 'no-store' && o.credentials === 'omit' && !!o.signal && o.signal.aborted === false);
    t('post: 2xx -> { ok, status }; the answer\'s body is not read', J(r) === J({ ok: true, status: 200 }) && log.cancelled === true); })); }
for (const status of [201, 204, 299]) tests.push(IW.post({ url: HOOK, key: KEY, body: BODY, fetch: fetchOf({ status }, []) }).then(r => t(`post: HTTP ${status} -> ok`, r.ok === true && r.status === status)));
for (const status of [301, 400, 401, 403, 404, 500, 503]) tests.push(IW.post({ url: HOOK, key: KEY, body: BODY, fetch: fetchOf({ status }, []) }).then(r => t(`post: HTTP ${status} -> { ok: false, code: HTTP, status }`, J(r) === J({ ok: false, code: 'HTTP', status }))));
tests.push(IW.post({ url: HOOK, key: KEY, body: BODY, fetch: async () => { throw new Error(`net::ERR_NAME_NOT_RESOLVED ${HOOK} ${KEY}`); } })
  .then(r => t('post: a network error -> NETWORK, never its text / the URL / key', J(r) === J({ ok: false, code: 'NETWORK' }) && !leaks(r))));
tests.push(IW.post({ url: HOOK, key: KEY, body: BODY, fetch: async () => { throw new TypeError('redirect mode is set to error'); } })
  .then(r => t('post: a redirect (refused) -> NETWORK', r.code === 'NETWORK')));
{ let sig = null; const t0 = Date.now();
  tests.push(IW.post({ url: HOOK, key: KEY, body: BODY, timeoutMs: 60, fetch: (u, o) => { sig = o.signal; return new Promise((res, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))); } })
    .then(r => t('post: no answer within the timeout -> TIMEOUT, the request aborted', J(r) === J({ ok: false, code: 'TIMEOUT' }) && sig.aborted === true && Date.now() - t0 < 1000))); }
tests.push(IW.post({ url: HOOK, key: KEY, body: BODY, timeoutMs: 60, fetch: () => new Promise(() => {}) })
  .then(r => t('post: a fetch that ignores the abort still ends at the timeout', J(r) === J({ ok: false, code: 'TIMEOUT' }))));
t('the default timeout is 15 s', SI.TIMEOUT_MS === 15000 && /timeoutMs = SI\.TIMEOUT_MS/.test(fs.readFileSync(require.resolve('../src/instruct-webhook'), 'utf8')));
t('the module never logs / prints (no console, no dlog) and never imports electron', !/console\.|dlog|require\('electron'\)/.test(fs.readFileSync(require.resolve('../src/instruct-webhook'), 'utf8')));

Promise.all(tests).then(() => { console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0); });
