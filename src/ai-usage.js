// Read-only usage readouts for Codex (ChatGPT) and Claude Code, using the local CLI sign-ins.
// Tokens are only held in memory for one request; they are never logged, stored or sent anywhere except the provider's own usage endpoint.
const fs = require('fs'), os = require('os'), path = require('path');
const { execFile } = require('child_process');

const num = v => { const n = typeof v === 'string' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
const winLabel = s => !s ? '制限' : (s >= 17400 && s <= 18600) ? '5時間' : (s >= 6 * 86400 && s <= 8 * 86400) ? '1週間' : s % 86400 === 0 ? `${s / 86400}日` : s % 3600 === 0 ? `${s / 3600}時間` : '制限';

const uniq = a => { const seen = {}; a.forEach(b => { seen[b.id] = (seen[b.id] || 0) + 1; if (seen[b.id] > 1) b.id += '#' + seen[b.id]; }); };
function codexParse(root) {
  const out = [];
  const add = (rl, model) => ['primary_window', 'secondary_window'].forEach(k => {
    const w = rl && rl[k]; if (!w) return;
    const used = num(w.used_percent); if (used == null || used < 0) return;
    const sec = num(w.limit_window_seconds) || 0, at = num(w.reset_at);
    out.push({ id: `${model || 'general'}-${k}-${sec}`, label: (model ? model + ' ' : '') + winLabel(sec), used: Math.min(100, used), resetAt: at ? at * 1000 : null, weekly: !model && sec >= 6 * 86400, five: !model && sec >= 17400 && sec <= 18600, main: !model });
  });
  add(root.rate_limit, null);
  (root.additional_rate_limits || []).forEach(it => add(it && it.rate_limit, String(it.limit_name || it.metered_feature || '追加')));
  if (!out.length) throw new Error('Codexの使用量データを認識できません');
  uniq(out);
  return out;
}
function claudePct(v) { const n = num(v); if (n == null || n < 0) return null; return Math.min(100, (n > 1 ? n : n * 100)); }
function claudeParse(root) {
  const out = [], t = v => { const d = v ? Date.parse(v) : NaN; return Number.isFinite(d) ? d : null; };
  if (Array.isArray(root.limits) && root.limits.length) {
    root.limits.forEach(l => {
      const u = claudePct(l.percent ?? l.utilization); if (u == null) return;
      const model = l.scope && l.scope.model && l.scope.model.display_name;
      const kind = String(l.kind || l.group || '');
      const weekly = /weekly|seven/.test(kind), session = /session|five/.test(kind);
      out.push({ id: [l.kind, l.group, model].filter(Boolean).join('-') || ('limit' + out.length), label: model ? model : session ? '5時間' : weekly ? '1週間' : (kind || '制限'), used: u, resetAt: t(l.resets_at), weekly: weekly && !model, five: session && !model, main: !model });
    });
  } else {
    [['five_hour', '5時間', false], ['seven_day', '1週間', true]].forEach(([k, label, weekly]) => {
      const w = root[k]; if (!w) return; const u = claudePct(w.utilization ?? w.percent); if (u == null) return;
      out.push({ id: k, label, used: u, resetAt: t(w.resets_at), weekly, five: k === 'five_hour', main: true });
    });
    Object.keys(root).filter(k => k.startsWith('seven_day_') && k !== 'seven_day_oauth_apps').sort().forEach(k => {
      const w = root[k]; if (!w || typeof w !== 'object') return; const u = claudePct(w.utilization ?? w.percent); if (u == null) return;
      out.push({ id: k, label: k.slice(10).replace(/[_-]/g, ' ') + ' 1週間', used: u, resetAt: t(w.resets_at), weekly: false, five: false, main: false });
    });
  }
  if (!out.length) throw new Error('Claudeの使用量データを認識できません');
  uniq(out);
  return out;
}

async function getJson(url, headers) {
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: ctl.signal });
    if (r.status === 401 || r.status === 403) { const e = new Error('ログインの期限切れ'); e.auth = true; throw e; }
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; const ra = Number(r.headers.get('retry-after')); if (Number.isFinite(ra) && ra > 0) e.retryAfter = ra; throw e; }
    return await r.json();
  } finally { clearTimeout(tm); }
}

async function fetchCodex() {
  let tokens;
  try { tokens = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8')).tokens; } catch { tokens = null; }
  if (!tokens || !tokens.access_token) throw new Error('Codexにログインしていません（codex login が必要）');
  const h = { Authorization: 'Bearer ' + tokens.access_token };
  if (tokens.account_id) h['ChatGPT-Account-Id'] = tokens.account_id;
  try { return codexParse(await getJson('https://chatgpt.com/backend-api/wham/usage', h)); }
  catch (e) { if (e.auth) throw new Error('Codexのログインが期限切れです（codex を一度起動して更新）'); throw e; }
}

function claudeToken() {
  const fromJson = txt => { try { const o = JSON.parse(txt).claudeAiOauth; return o && o.accessToken ? { t: o.accessToken, exp: num(o.expiresAt) } : null; } catch { return null; } };
  return new Promise(res => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 20000 }, (err, so) => {
      const kc = !err && so ? fromJson(so.trim()) : null;
      let file = null; try { file = fromJson(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')); } catch {}
      const c = [kc, file].filter(Boolean).sort((a, b) => (b.exp || 0) - (a.exp || 0))[0];   // the freshest sign-in
      res(c || null);
    });
  });
}
async function fetchClaude() {
  const authErr = m => { const e = new Error(m); e.auth = true; return e; };
  const c = await claudeToken();
  if (!c) throw authErr('Claude Codeにログインしていません');
  if (c.exp && c.exp < Date.now() - 60000) throw authErr('Claudeのログインが期限切れです');
  try { return claudeParse(await getJson('https://api.anthropic.com/api/oauth/usage', { Authorization: 'Bearer ' + c.t, 'anthropic-beta': 'oauth-2025-04-20' })); }
  catch (e) { if (e.auth) throw authErr('Claudeのログインが期限切れです'); throw e; }
}

// ---- silent re-auth through the Claude CLI (the same mechanism Claude Code itself uses to refresh its login) ----
// We never read or store the refresh token: `claude -p ok` makes Claude Code refresh its own credentials. Own timeout (macOS has no `timeout`).
const EXTRA_BIN = () => ['.local/bin', '.claude/local', '.hermes/node/bin', '.bun/bin', '.npm-global/bin', '.volta/bin', 'bin'].map(d => path.join(os.homedir(), d)).concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']);
let claudeBin = null;
function findClaude() {
  return new Promise(res => {
    if (claudeBin) return res(claudeBin);
    const hit = EXTRA_BIN().map(d => path.join(d, 'claude')).find(f => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } });
    if (hit) { claudeBin = hit; return res(hit); }
    execFile('/bin/zsh', ['-lc', 'command -v claude'], { timeout: 8000 }, (err, so) => { const f = !err && String(so || '').trim().split('\n').pop(); claudeBin = f && f.startsWith('/') ? f : null; res(claudeBin); });
  });
}
const cliEnv = () => ({ ...process.env, PATH: [...new Set(EXTRA_BIN().concat(String(process.env.PATH || '').split(':')))].join(':'), CI: '1' });
async function claudeCliRefresh(ms = 90000) {
  const bin = await findClaude(); if (!bin) return false;
  const { spawn } = require('child_process');
  return new Promise(res => {
    let done = false, p;
    const fin = ok => { if (done) return; done = true; clearTimeout(tm); res(ok); };
    try { p = spawn(bin, ['-p', 'ok'], { env: cliEnv(), stdio: ['ignore', 'ignore', 'ignore'] }); } catch { return res(false); }
    const tm = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} fin(false); }, ms);
    p.on('error', () => fin(false)); p.on('close', code => fin(code === 0));
  });
}
async function claudeReauth() {
  const ok = await claudeCliRefresh();
  saveSt('claude', { refreshTry: Date.now(), nextAt: 0, lastTry: 0 });
  return ok;
}
function openClaudeLoginInTerminal() {
  // Terminal.app runs the user's own login shell (so its PATH finds `claude`); the user then signs in there.
  execFile('/usr/bin/osascript', ['-e', 'tell application "Terminal" to activate', '-e', 'tell application "Terminal" to do script "claude"'], () => {});
}

// ---- fetch scheduling: shared on-disk state (no tokens), min interval, 429 back-off, single poller ----
const MIN_GAP = 60000, FRESH = 180000, BACKOFF = [5, 10, 20, 30];   // minutes: 5 -> 10 -> 20 -> cap 30
const busy = {}, started = {};
let onChange = null;
const stateFile = () => { try { return path.join(require('electron').app.getPath('userData'), 'ai-usage-cache.json'); } catch { return null; } };
const readAll = () => { const f = stateFile(); try { return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; } catch { return {}; } };
const writeAll = o => { const f = stateFile(); if (!f) return; try { fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); } catch {} };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const stOf = k => { const s = readAll()[k]; return s && typeof s === 'object' ? s : {}; };
const saveSt = (k, patch) => { const all = readAll(); all[k] = { ...(all[k] || {}), ...patch }; writeAll(all); return all[k]; };
const clock = t => new Date(t).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false, hour: '2-digit', minute: '2-digit' });
function view(k) {
  const s = stOf(k), has = Array.isArray(s.buckets) && s.buckets.length;
  const base = { at: s.okAt || 0, nextAt: s.nextAt || 0 };
  if (!has) return { ok: false, needLogin: !!s.authErr, err: s.err || 'まだ取得していません', buckets: [], ...base };
  const now = Date.now(), stale = !!(s.err || (s.okAt && now - s.okAt > 15 * 60000));
  let err = s.err || '';
  if (/429/.test(err)) err = 'HTTP 429（制限中のため前回の値を表示）' + (s.nextAt > now ? `　次回取得 ${clock(s.nextAt)}以降` : '');
  else if (err) err = err + '（前回の値を表示）';
  else if (stale) err = '最終更新から時間が経っています';
  return { ok: !(s.authErr), needLogin: !!s.authErr, buckets: s.buckets, ...base, ...(stale ? { stale: true, err } : {}), ...(s.authErr ? { err: s.err } : {}) };
}
const REAUTH_GAP = 10 * 60000;
async function doFetch(k) {
  const now = Date.now(), prev = stOf(k);
  saveSt(k, { lastTry: now, leader: { pid: process.pid, at: now } });
  const run = () => (k === 'codex' ? fetchCodex() : fetchClaude());
  try {
    let buckets;
    try { buckets = await run(); }
    catch (e) {
      // expired / invalid Claude login: one silent refresh via the CLI, at most once per 10 min, never while rate-limited
      const limited = prev.nextAt && Date.now() < prev.nextAt;
      if (k === 'claude' && e && e.auth && !limited && Date.now() - (prev.refreshTry || 0) > REAUTH_GAP) {
        saveSt(k, { refreshTry: Date.now() });
        if (await claudeCliRefresh()) buckets = await run(); else throw e;
      } else throw e;
    }
    saveSt(k, { buckets, okAt: Date.now(), fails: 0, nextAt: 0, err: '', authErr: false });
  } catch (e) {
    const msg = String(e && e.message || e), fails = (prev.fails || 0) + 1;
    if (e && e.status === 429) {
      const wait = Math.max((e.retryAfter || 0) * 1000, BACKOFF[Math.min(fails - 1, BACKOFF.length - 1)] * 60000);
      saveSt(k, { fails, nextAt: Date.now() + wait, err: msg + (e.retryAfter ? ` Retry-After ${e.retryAfter}s` : ' (Retry-Afterなし)') });
    } else if (e && e.auth) saveSt(k, { fails, err: msg, authErr: true });
    else saveSt(k, { fails, err: msg, authErr: false });
  }
  try { onChange && onChange(k); } catch {}
}
// force = explicit long-press only: skips the 60 s minimum interval (never the 429 back-off).
async function get(k, force) {
  const now = Date.now();
  const first = !started[k]; started[k] = true;
  const s = stOf(k), has = Array.isArray(s.buckets) && s.buckets.length;
  const fresh = s.okAt && now - s.okAt < FRESH && !s.err;
  const due = !fresh || force;
  const blocked = (s.nextAt && now < s.nextAt) || (!force && s.lastTry && now - s.lastTry < MIN_GAP) || (force && s.lastTry && now - s.lastTry < 5000);
  const other = s.leader && s.leader.pid !== process.pid && alive(s.leader.pid) && now - s.leader.at < 10 * 60000;   // another running instance is the poller
  if (due && !blocked && !other) {
    if (!busy[k]) { const p = doFetch(k).finally(() => { delete busy[k]; }); busy[k] = p.then(() => view(k)); }
    if (first && has) return view(k);   // right after a restart: show the saved value immediately, refresh in the background
    return busy[k];
  }
  return view(k);
}
const peek = k => view(k);
module.exports = { get, peek, claudeReauth, openClaudeLoginInTerminal, codexParse, claudeParse, setOnChange: f => { onChange = f; } };
