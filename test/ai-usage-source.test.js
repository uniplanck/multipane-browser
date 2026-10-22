// node test/ai-usage-source.test.js — 使用量表示: src/ai-usage.js reads the local sign-ins (Claude Code's Keychain item via /usr/bin/security,
// Codex CLI's ~/.codex/auth.json) only when main says the source is 'local' (the explicit opt-in); 'off' / 'none' read nothing, 'web' goes to
// main's reader only. A web page without numbers shows none (never the previous numbers); a lapsed web sign-in is not read again by itself.
// Runs with child_process / fs / fetch / electron replaced: nothing real is read, run or sent (HOME is a temp dir; the auth file is refused).
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), Module = require('module');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-aiusage-'));
process.env.HOME = tmp;
const calls = { exec: [], spawn: [], cred: [], fetch: [] };
cp.execFile = (file, args, opts, cb) => { calls.exec.push(file); (typeof opts === 'function' ? opts : cb)(new Error('stub'), '', ''); };
cp.spawn = (bin) => { calls.spawn.push(bin); throw new Error('stub'); };
const realRead = fs.readFileSync, realAccess = fs.accessSync;
fs.readFileSync = (f, ...a) => { if (/[\\/]\.(codex|claude)[\\/]/.test(String(f))) { calls.cred.push(String(f)); const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return realRead(f, ...a); };
fs.accessSync = (f, ...a) => { if (/claude/.test(String(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return realAccess(f, ...a); };
global.fetch = async url => { calls.fetch.push(String(url)); throw new Error('stub: no network'); };
const realLoad = Module._load;                               // electron: only app.getPath (the shared state file goes to the temp dir)
Module._load = function (req, ...a) { return req === 'electron' ? { app: { getPath: () => tmp } } : realLoad.call(this, req, ...a); };
const AIU = require('../src/ai-usage');
const UC = require('../src/usage-config');

let settings = {};
let reader = async () => { throw new Error('no reader'); };
const reads = [];
AIU.setup({ source: k => UC.source(settings, k), web: k => { reads.push(k); return reader(k); } });
const none = () => !calls.exec.length && !calls.spawn.length && !calls.cred.length && !calls.fetch.length;
const reset = () => { calls.exec = []; calls.spawn = []; calls.cred = []; calls.fetch = []; reads.length = 0; };
// forced reads are 5 s apart at least: move the last try back in the shared state file instead of waiting
const age = (key, ms) => { const f = path.join(tmp, 'ai-usage-cache.json'), o = JSON.parse(realRead(f, 'utf8')); o[key].lastTry -= ms; fs.writeFileSync(f, JSON.stringify(o)); };
const B = [{ id: 'week', label: '1週間', used: 34, resetAt: null, resetText: 'Resets Thu 10:59 AM', weekly: true, five: false, main: true }];

(async () => {
  // ---- off (new install) / not connected: nothing read ----
  settings = UC.migrate({}, { existing: false }).settings;
  for (const k of ['codex', 'claude', 'kimi']) { const r = await AIU.get(k, true); if (!(r.off && r.src === 'off' && !r.ok && !r.buckets.length)) t(`off: ${k}`, false); }
  t('new install (off): codex / claude / kimi read nothing, even forced (no Keychain, no auth.json, no network)', none() && !reads.length);
  settings = { ...settings, usageShow: true };
  const n = await AIU.get('claude', true);
  t('shown, not connected: needConnect, nothing read', n.needConnect && n.src === 'none' && none() && !reads.length && AIU.peek('codex').needConnect);

  // ---- web: main's reader only ----
  settings = UC.set(settings, 'claude', 'web', true);
  reader = async () => B;
  const w = await AIU.get('claude', true);
  t('web: numbers from main\'s reader, src web, no local sign-in touched', w.ok && w.src === 'web' && w.buckets[0].used === 34 && reads.join() === 'claude' && none());
  t('web: peek shows the same', AIU.peek('claude').ok && AIU.peek('claude').buckets[0].resetText === 'Resets Thu 10:59 AM');
  reset();
  t('web: fresh for 10 min, not read again unforced', (await AIU.get('claude', false)).ok && !reads.length);
  reader = async () => { throw Object.assign(new Error('接続済み・数値を読めません'), { noNum: true }); };
  age('claude:web', 6000);
  const nn = await AIU.get('claude', true);
  t('web page without numbers: noNum, no number at all (the previous 34% is not shown)', !nn.ok && nn.noNum && nn.buckets.length === 0 && nn.err === '接続済み・数値を読めません' && reads.length === 1);
  reader = async () => { throw Object.assign(new Error('ログインが必要です'), { auth: true }); };
  age('claude:web', 6000);
  const au = await AIU.get('claude', true); reset();
  t('web sign-in lapsed: needLogin, src web (the gauge\'s click opens the login window)', au.needLogin && au.src === 'web' && !au.ok);
  await AIU.get('claude', false);
  t('a lapsed web sign-in is not read again by itself (only forced)', !reads.length && none());
  AIU.forget('claude');
  t('forget (切断 / a new sign-in): the web reading is gone', !AIU.peek('claude').ok && !AIU.peek('claude').needLogin && AIU.peek('claude').err === 'まだ取得していません');
  reader = async () => B;
  await AIU.get('claude', true, 'web');
  t('get(.., .., "web"): the web reading even while the gauge would use another source', AIU.peek('claude', 'web').ok && reads.length === 1);

  // ---- local opt-in: only now the CLI sign-ins are read ----
  reset();
  settings = UC.set(settings, 'codex', 'local', true);
  const c = await AIU.get('codex', true);
  t('codex local opt-in: auth.json is read (here: refused by the test), no network without a token', calls.cred.length === 1 && /\.codex[\\/]auth\.json$/.test(calls.cred[0]) && !calls.fetch.length && !c.ok && c.src === 'local' && !reads.length);
  t('codex local: the web reader is not used', !reads.length);
  reset();
  settings = UC.set(settings, 'claude', 'local', true);
  const cl = await AIU.get('claude', true);
  t('claude local opt-in: the Keychain item is asked for (security), no reader', calls.exec.includes('/usr/bin/security') && !reads.length && cl.src === 'local');
  t('claude local: no CLI was started (none found here), no network without a token', !calls.spawn.length && !calls.fetch.length);
  reset();
  settings = UC.set(UC.set(settings, 'claude', 'local', false), 'codex', 'local', false);
  settings = UC.set(settings, 'claude', 'web', false);
  await AIU.get('claude', true); await AIU.get('codex', true);
  t('opt-in off again: nothing local read any more', none());
  settings = { ...settings, usageShow: false };
  await AIU.get('claude', true);
  t('使用量表示 off: nothing read', none() && !reads.length);

  // ---- the source file: the credential paths only in the local fetchers ----
  const src = realRead(path.join(__dirname, '..', 'src', 'ai-usage.js'), 'utf8');
  t('ai-usage.js: Keychain / auth.json only inside claudeToken / fetchCodex, and those only on the local path of doFetch',
    (src.match(/find-generic-password/g) || []).length === 1 && (src.match(/'auth\.json'/g) || []).length === 1
    && /const run = \(\) => \(web \? \(webRead \? webRead\(k\.slice\(0, -4\)\)[^\n]*: k === 'codex' \? fetchCodex\(\) : fetchClaude\(\)\);/.test(src)
    && /if \(src !== 'local' && src !== 'web'\) return stub\(kind, src\);/.test(src));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
})().catch(e => { console.log('FAIL', e && e.stack); process.exit(1); });
