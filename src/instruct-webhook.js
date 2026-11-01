// NaoAIへの指示 (main process only): the webhook's URL + key and the POST. No electron here - main hands over safeStorage, fs and fetch, so
// plain Node tests drive it with fakes (test/instruct-webhook.test.js).
//   createStore({ file, safe, fs }): the setting, encrypted with safeStorage (the Keychain on macOS) into its own file (userData/instruct-webhook.json:
//     { "v": 1, "data": base64 of the ciphertext }, mode 0600, written through a temporary file) - never in panes.json, never in a log. Kept in main's
//     memory once read. status() -> { configured, host, available } is all a renderer may learn; secret() -> { url, key } is for the POST only.
//     set({ url, key }) refuses what instruct-rules.js refuses ('URL' / 'KEY') and, without a usable safeStorage, everything ('UNAVAILABLE'):
//     nothing is ever written in plain text. clear() removes the file.
//   post({ url, key, body, fetch, timeoutMs }): one POST of the JSON body (content-type: application/json, authorization: Bearer <key>), no
//     redirect followed -> { ok: true, status } (2xx) | { ok: false, code: 'HTTP', status } | { code: 'TIMEOUT' } | { code: 'NETWORK' }. The answer
//     never carries the URL, the key or an error's text.
const SI = require('./instruct-rules');

const VERSION = 1;
const ERR = ['URL', 'KEY', 'UNAVAILABLE', 'WRITE', 'READ'];   // set() / clear() / secret() failures (fixed codes)

function createStore({ file, safe, fs }) {
  let cache;                                                 // undefined = not read yet; null = none; { url, key }; false = a file it cannot read
  function available() {
    try {
      if (!safe || safe.isEncryptionAvailable() !== true) return false;
      let backend = '';
      try { backend = typeof safe.getSelectedStorageBackend === 'function' ? safe.getSelectedStorageBackend() : ''; } catch {}
      return backend !== 'basic_text';                       // Linux without a keyring: a fixed key, as good as plain text - refused
    } catch { return false; }
  }
  function read() {
    if (cache !== undefined) return cache;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { cache = e && e.code === 'ENOENT' ? null : false; return cache; }
    try {
      const doc = JSON.parse(text);
      if (!doc || doc.v !== VERSION || typeof doc.data !== 'string' || !doc.data) throw new Error('shape');
      const plain = JSON.parse(safe.decryptString(Buffer.from(doc.data, 'base64')));
      const url = SI.hookUrl(plain && plain.url), key = SI.hookKey(plain && plain.key);
      cache = url && key ? { url, key } : false;
    } catch { cache = false; }
    return cache;
  }
  const status = () => { const c = read(); return { configured: c !== null, host: c ? new URL(c.url).hostname : '', available: available() }; };
  const fail = code => ({ ok: false, code, ...status() });
  function set(v) {
    const o = v && typeof v === 'object' ? v : {}, url = SI.hookUrl(o.url), key = SI.hookKey(o.key);
    if (!url) return fail('URL');
    if (!key) return fail('KEY');
    if (!available()) return fail('UNAVAILABLE');
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      const data = safe.encryptString(JSON.stringify({ url, key })).toString('base64');
      fs.writeFileSync(tmp, JSON.stringify({ v: VERSION, data }) + '\n', { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);                              // an old temporary file keeps its mode on write: set it again
      fs.renameSync(tmp, file);
    } catch { try { fs.rmSync(tmp, { force: true }); } catch {} return fail('WRITE'); }
    cache = { url, key };
    return { ok: true, ...status() };
  }
  function clear() {
    try { fs.rmSync(file, { force: true }); } catch { return fail('WRITE'); }
    cache = null;
    return { ok: true, ...status() };
  }
  // the POST only: { url, key } | null (none) | false (a file it cannot read: a Keychain refused / another Mac's file / broken)
  const secret = () => { const c = read(); return c ? { url: c.url, key: c.key } : c; };
  return { status, set, clear, secret, available };
}

async function post({ url, key, body, fetch, timeoutMs = SI.TIMEOUT_MS }) {
  const ctl = new AbortController();
  let timer = null;
  const late = new Promise(res => { timer = setTimeout(() => { ctl.abort(); res({ ok: false, code: 'TIMEOUT' }); }, timeoutMs); });
  const send = (async () => {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body), redirect: 'error', cache: 'no-store', credentials: 'omit', signal: ctl.signal });
      const status = Number(res && res.status);
      try { await res.body?.cancel?.(); } catch {}          // the answer's body is not read
      return status >= 200 && status <= 299 ? { ok: true, status } : { ok: false, code: 'HTTP', status: Number.isSafeInteger(status) ? status : 0 };
    } catch (e) { return ctl.signal.aborted ? { ok: false, code: 'TIMEOUT' } : { ok: false, code: 'NETWORK' }; }
  })();
  try { return await Promise.race([send, late]); } finally { clearTimeout(timer); }
}

module.exports = { VERSION, ERR, createStore, post };
