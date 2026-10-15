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
    if (!r.ok) throw new Error('HTTP ' + r.status);
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
  const c = await claudeToken();
  if (!c) throw new Error('Claude Codeにログインしていません');
  if (c.exp && c.exp < Date.now() - 60000) throw new Error('Claudeのログインが期限切れです（Claude Codeを一度起動して更新）');
  try { return claudeParse(await getJson('https://api.anthropic.com/api/oauth/usage', { Authorization: 'Bearer ' + c.t, 'anthropic-beta': 'oauth-2025-04-20' })); }
  catch (e) { if (e.auth) throw new Error('Claudeのログインが期限切れです（Claude Codeを一度起動して更新）'); throw e; }
}

const cache = {}, busy = {}, tried = {};
async function get(kind, force) {
  const c = cache[kind];
  if (!force && c && c.ok && Date.now() - c.at < 60000) return c;
  if (c && tried[kind] && Date.now() - tried[kind] < (c.rate ? 150000 : 20000)) return c;   // be gentle: never hammer the endpoints (429)
  tried[kind] = Date.now();
  if (busy[kind]) return busy[kind];
  busy[kind] = (async () => {
    try { const buckets = await (kind === 'codex' ? fetchCodex() : fetchClaude()); cache[kind] = { ok: true, buckets, at: Date.now() }; }
    catch (e) {
      const prev = cache[kind];
      if (/429/.test(String(e && e.message)) && prev && prev.buckets && prev.buckets.length) { cache[kind] = { ...prev, ok: true, stale: true, rate: true, err: 'HTTP 429（制限中のため前回の値を表示）' }; }
      else cache[kind] = { ok: false, err: String(e && e.message || e), buckets: (cache[kind] && cache[kind].buckets) || [], at: Date.now(), lastOkAt: cache[kind] && cache[kind].ok ? cache[kind].at : (cache[kind] && cache[kind].lastOkAt) || 0 }; }
    finally { delete busy[kind]; }
    return cache[kind];
  })();
  return busy[kind];
}
const peek = k => cache[k];
module.exports = { get, peek, codexParse, claudeParse };
