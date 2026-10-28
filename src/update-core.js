// Git-based updater. No Electron dependency: command execution and filesystem are injectable.
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';
const MESSAGES = {
  'repo-missing': 'この版はGitHubのクローンから入れていないか、元のフォルダが見つかりません。クローンから npm ci と npm run install:mac を実行してください。',
  'not-git': '元のフォルダがGitの作業ツリーではありません。クローンを確認してください。',
  'wrong-branch': '既定のブランチではないため更新しません。ターミナルでブランチを確認してください。',
  dirty: 'ローカルの変更があるため自動では更新しません。ターミナルで git status を確認してください。',
  diverged: 'ローカルのコミットが先行または分岐しているため更新しません。ターミナルで履歴を確認してください。',
  'fetch-failed': 'GitHubに接続できません。ネットワークとGitの認証情報を確認してください。',
  'no-node': 'Node.js または npm が見つかりません。ターミナルでインストールを確認してください。'
};
const blocked = (reason, extra = {}) => ({ state: 'blocked', reason, message: MESSAGES[reason], ...extra });
function stripCredentials(remote) {
  const s = String(remote || '').trim().replace(/\/\/[^/\s]*@/, '//').replace(/^[^/@]+@(?=[^/:]+:)/, '').replace(/[?#].*$/, '');
  try { const u = new URL(s); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); }
  catch { return s; }
}
function remoteLabel(remote) {
  const s = stripCredentials(remote).replace(/[?#].*$/, '').replace(/\/$/, '').replace(/\.git$/, '');
  const m = s.match(/(?:github\.com[/:])([^/]+\/[^/]+)$/i);
  return m ? m[1] : '';
}
function commandPath(info) { return [info.nodeBin, BASE_PATH, process.env.PATH || ''].filter(Boolean).join(':'); }
function safeOutput(s) { return String(s || '').replace(/(https?:\/\/)[^\s/@]+@/gi, '$1').replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1'); }
// Captures a bounded tail and optionally streams lines; never invokes a shell for user-controlled arguments.
function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', pending = '', skipping = false;
    const line = s => { try { opts.onLine?.(safeOutput(s)); } catch {} };
    const add = (s, isErr) => {
      if (isErr) err = (err + s).slice(-65536); else out = (out + s).slice(-65536);
      if (!opts.onLine) return;
      pending += s; const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const part of lines) { if (skipping) skipping = false; else line(part.length > 65536 ? '長い出力を省略しました' : part); }
      if (pending.length > 65536) { pending = ''; if (!skipping) line('長い出力を省略しました'); skipping = true; }
    };
    child.stdout.on('data', d => add(d.toString(), false)); child.stderr.on('data', d => add(d.toString(), true));
    let timedOut = false, aborted = false, killTimer;
    const stop = signal => { try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
    const terminate = () => { stop('SIGTERM'); if (!killTimer) { killTimer = setTimeout(() => stop('SIGKILL'), 1000); killTimer.unref(); } };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, opts.timeout || 30000);
    const abort = () => { aborted = true; terminate(); };
    if (opts.signal?.aborted) abort(); else opts.signal?.addEventListener('abort', abort, { once: true });
    const done = () => { clearTimeout(timer); clearTimeout(killTimer); opts.signal?.removeEventListener('abort', abort); };
    child.on('error', e => { done(); reject(e); });
    child.on('close', code => { done(); if (pending && !skipping) line(pending); if (code === 0 && !timedOut && !aborted) resolve({ stdout: safeOutput(out), stderr: safeOutput(err) }); else reject(Object.assign(new Error(timedOut ? 'timeout' : aborted ? 'cancelled' : 'command failed'), { code, stdout: safeOutput(out), stderr: safeOutput(err) })); });
  });
}
const output = r => typeof r === 'string' ? r : r?.stdout || '';
function options(info, timeout = 30000) { return { cwd: info.repoDir, timeout, env: { ...process.env, PATH: commandPath(info), GIT_TERMINAL_PROMPT: '0' } }; }
async function toolsFor(info, run = exec, base = options(info), file = fs) {
  let nodeOk = false, npmOk = false;
  try { await run('node', ['--version'], base); nodeOk = true; } catch {}
  try { await run('npm', ['--version'], base); npmOk = true; } catch {}
  if (nodeOk && npmOk) return { npm: 'npm', npx: 'npx', env: base.env };
  if (nodeOk && info.npmCli && file.existsSync(info.npmCli)) {
    const npx = path.join(path.dirname(info.npmCli), 'npx-cli.js');
    if (file.existsSync(npx)) return { npm: 'node', npmPrefix: [info.npmCli], npx: 'node', npxPrefix: [npx], env: base.env };
  }
  try {
    const npm = output(await run('/bin/zsh', ['-lc', 'command -v npm'], base)).trim();
    if (!path.isAbsolute(npm)) return null;
    const env = { ...base.env, PATH: path.dirname(npm) + ':' + base.env.PATH };
    await run(npm, ['--version'], { ...base, env });
    await run('node', ['--version'], { ...base, env });
    return { npm, npx: path.join(path.dirname(npm), 'npx'), env };
  } catch { return null; }
}
async function inspect(info, run = exec, opts = {}) {
  const file = opts.fs || fs;
  if (!info || !info.repoDir || !file.existsSync(info.repoDir)) return blocked('repo-missing');
  const o = { ...options(info), signal: opts.signal }, git = async (...args) => output(await run('git', args, o)).trim();
  try { if (await git('rev-parse', '--is-inside-work-tree') !== 'true') return blocked('not-git'); } catch { return blocked('not-git'); }
  let branch, head, defaultBranch, remote;
  try {
    branch = await git('branch', '--show-current'); head = await git('rev-parse', 'HEAD');
    await git('fetch', '--quiet', 'origin');
    const refs = await git('ls-remote', '--symref', 'origin', 'HEAD');
    defaultBranch = refs.match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD$/m)?.[1];
    if (!defaultBranch) return blocked('fetch-failed');
    remote = stripCredentials(await git('remote', 'get-url', 'origin'));
  } catch { return blocked('fetch-failed'); }
  const base = { branch, defaultBranch, head, installedCommit: info.commit || '', remote };
  if (branch !== defaultBranch) return blocked('wrong-branch', base);
  try {
    if (await git('status', '--porcelain', '--untracked-files=no')) return blocked('dirty', base);
    const counts = (await git('rev-list', '--left-right', '--count', `HEAD...refs/remotes/origin/${branch}`)).split(/\s+/).map(Number);
    const [ahead, behind] = counts;
    if (counts.length !== 2 || !counts.every(Number.isInteger)) return blocked('fetch-failed', base);
    if (ahead) return blocked('diverged', { ...base, ahead, behind });
    let rebuild = !info.commit && !!info.builtAt;
    if (info.commit && info.commit !== head) {
      try { await git('merge-base', '--is-ancestor', info.commit, head); rebuild = true; }
      catch { return blocked('diverged', { ...base, ahead, behind }); }
    }
    const toolchain = await toolsFor(info, run, o, file);
    if (!toolchain) return blocked('no-node', { ...base, ahead, behind });
    return { ...base, ahead, behind, rebuild, state: behind || rebuild ? 'available' : 'up-to-date', toolchain };
  } catch { return blocked('fetch-failed', base); }
}
async function prepare(info, run = exec, opts = {}) {
  const file = opts.fs || fs, start = Date.now(), deadline = start + (opts.timeout || 30 * 60 * 1000), lines = [];
  const log = line => { const s = safeOutput(line).slice(0, 2000); lines.push(s); if (lines.length > 100) lines.shift(); try { opts.onProgress?.(s); } catch {} };
  const base = { ...options(info), signal: opts.signal }, call = async (cmd, args, env = base.env) => {
    const left = deadline - Date.now(); if (left <= 0) throw new Error('timeout');
    return output(await run(cmd, args, { ...base, env, timeout: left, onLine: log })).trim();
  };
  const git = (...args) => call('git', args);
  try {
    const check = opts.inspection;
    if (!check || check.state !== 'available') throw new Error('検査結果がありません');
    const branch = await git('branch', '--show-current'), old = await git('rev-parse', 'HEAD');
    if (branch !== check.defaultBranch || old !== check.head || await git('status', '--porcelain', '--untracked-files=no')) throw new Error('検査後に作業ツリーが変わりました。もう一度確認してください');
    const counts = (await git('rev-list', '--left-right', '--count', `HEAD...refs/remotes/origin/${branch}`)).split(/\s+/).map(Number);
    if (counts.length !== 2 || counts[0] !== 0 || counts[1] !== check.behind) throw new Error('検査後に履歴が変わりました。もう一度確認してください');
    const toolchain = check.toolchain || await toolsFor(info, run, base, file);
    if (!toolchain) throw new Error(MESSAGES['no-node']);
    if (check.behind > 0) { log('新しい版を取得しています…'); await git('pull', '--ff-only', 'origin', branch); }
    const newCommit = await git('rev-parse', 'HEAD');
    let changed = old !== newCommit && !!(await git('diff', '--name-only', old, newCommit, '--', 'package-lock.json'));
    if (info.commit && info.commit !== old) changed ||= !!(await git('diff', '--name-only', info.commit, newCommit, '--', 'package-lock.json'));
    if (changed || !file.existsSync(path.join(info.repoDir, 'node_modules'))) {
      log('依存関係を準備しています…'); await call(toolchain.npm, [...(toolchain.npmPrefix || []), 'ci'], toolchain.env);
    }
    log('プリロードを確認しています…'); await call('node', ['scripts/build-pane-preload.js', '--check'], toolchain.env);
    const root = path.join(info.repoDir, 'dist-update'); await file.promises.mkdir(root, { recursive: true });
    const staging = await file.promises.mkdtemp(path.join(root, 'stage-'));
    const args = [...(toolchain.npxPrefix || []), 'electron-builder', '--mac', 'dir', '--arm64'];
    const local = info.config === 'local' && file.existsSync(path.join(info.repoDir, 'electron-builder.local.json'));
    // An external builder config can replace package.json's config entirely, including beforePack.
    // Generate the same metadata before invoking it, even if that config does not inherit the hook.
    if (local) { await call('node', ['scripts/build-pane-preload.js', '--write-info', '--config', 'electron-builder.local.json'], toolchain.env); args.push('--config', 'electron-builder.local.json'); }
    args.push('-c.mac.identity=null', `-c.directories.output=${staging}`);
    log('アプリを準備しています…'); await call(toolchain.npx, args, { ...toolchain.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
    const mac = path.join(staging, 'mac-arm64');
    const apps = (await file.promises.readdir(mac)).filter(name => name.endsWith('.app'));
    if (apps.length !== 1) throw new Error('準備したアプリが見つからないか複数あります');
    const appPath = path.join(mac, apps[0]);
    if (await git('rev-parse', 'HEAD') !== newCommit || await git('status', '--porcelain', '--untracked-files=no')) throw new Error('ビルド中に作業ツリーが変わりました。もう一度確認してください');
    log('署名しています…'); await call('codesign', ['--force', '--deep', '-s', '-', appPath], toolchain.env);
    log('準備ができました。'); return { ok: true, appPath, newCommit, log: lines };
  } catch (e) { log(`準備に失敗しました: ${e.message === 'command failed' ? 'コマンドを確認してください' : e.message}`); return { ok: false, log: lines }; }
}
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
function applyScript({ pid, bundlePath, appPath, logPath, relaunch = false }) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || ![bundlePath, appPath, logPath].every(p => typeof p === 'string' && path.isAbsolute(p))) throw new Error('invalid apply arguments');
  const reopen = relaunch ? `if ! open "$bundle"; then\n  echo 'relaunch failed; restoring backup'\n  restore\n  exit 1\nfi\n` : '';
  return `#!/bin/sh\nexec >>${quote(logPath)} 2>&1\necho "$(date): update started"\npid=${pid}\ni=0\nwhile kill -0 "$pid" 2>/dev/null; do\n  if [ "$i" -ge 60 ]; then echo 'app did not exit'; exit 1; fi\n  sleep 1\n  i=$((i + 1))\ndone\nbundle=${quote(bundlePath)}\nstaged=${quote(appPath)}\nbackupdir=$(mktemp -d "\${bundle}.update.XXXXXX") || exit 1\nbackup="$backupdir/previous.app"\nif ! mv "$bundle" "$backup"; then rmdir "$backupdir"; exit 1; fi\nrestore() {\n  rm -rf "$bundle"\n  if mv "$backup" "$bundle"; then rmdir "$backupdir"; else echo "restore failed: $backup"; fi\n}\nif ! ditto "$staged" "$bundle"; then\n  echo 'copy failed; restoring backup'\n  restore\n  exit 1\nfi\n${reopen}rm -rf "$backupdir" || { echo 'backup cleanup failed'; exit 1; }\necho "$(date): update applied"\n`;
}
module.exports = { inspect, prepare, applyScript, remoteLabel, stripCredentials, exec, toolsFor, MESSAGES };
