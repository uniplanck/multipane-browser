// Pure Claude Code expiry / UI decisions. Times are milliseconds; no credential values here.
const RELOGIN = 'Terminalで /login が必要';
const LOGIN_POLLS = [30000, 90000, 180000, 300000, 600000];
const time = v => typeof v === 'number' && Number.isFinite(v);
function state(c, now) {
  if (!c) return 'missing';
  const expired = !c.t || !time(c.exp) || c.exp <= 0 || c.exp <= now;
  if (expired && time(c.refreshExp) && c.refreshExp <= now) return 'relogin';
  return expired ? 'expired' : 'ok';
}
// The freshest sign-in; an older source without a refresh expiry (old ~/.claude/.credentials.json) takes the known expiry of the others.
function pick(sources) {
  const list = (sources || []).filter(Boolean);
  const c = list.slice().sort((a, b) => (b.exp || 0) - (a.exp || 0))[0];
  if (!c) return null;
  if (time(c.refreshExp)) return c;
  const r = list.map(x => x.refreshExp).filter(time);
  return r.length ? { ...c, refreshExp: Math.max(...r) } : c;
}
function canRefresh(kind, error, prev, now) {
  return kind === 'claude' && !!error?.auth && !error.relogin && !(prev.nextAt && now < prev.nextAt)
    && now - (prev.refreshTry || 0) > 10 * 60000;
}
function dialog(relogin) {
  const actions = relogin ? ['terminal', 'close'] : ['auto', 'terminal', 'close'];
  return { type: 'warning', message: relogin ? RELOGIN : 'Claudeの認証が切れています',
    detail: 'Claudeの使用量を表示するには、Claude Codeの再ログインが必要です。\nターミナルで /login を入力し、ブラウザで承認してください。',
    buttons: actions.map(a => a === 'auto' ? '自動で再認証を試す' : a === 'terminal' ? 'ターミナルでログイン' : '閉じる'),
    defaultId: 0, cancelId: actions.length - 1, noLink: true, actions };
}
module.exports = { RELOGIN, LOGIN_POLLS, state, pick, canRefresh, dialog };
