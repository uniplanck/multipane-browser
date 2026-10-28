// Git operations use only disposable local repositories; no installed app or real remote is touched.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const U = require('../src/update-core'), B = require('../scripts/build-pane-preload');
let bad = 0; const t = (name, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb update test '));
const git = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const config = dir => { git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.invalid'); };
const commit = (dir, value) => { fs.writeFileSync(path.join(dir, 'tracked.txt'), value); git(dir, 'add', 'tracked.txt'); git(dir, 'commit', '-m', value); return git(dir, 'rev-parse', 'HEAD'); };
const clone = (remote, name) => { git(root, 'clone', remote, name); const dir = path.join(root, name); config(dir); return dir; };
const info = (repoDir, commit = '') => ({ repoDir, commit, nodeBin: path.dirname(process.execPath), config: 'default' });
(async () => {
  try {
    const remote = path.join(root, 'remote.git'); git(root, 'init', '--bare', '--initial-branch=main', remote);
    const writer = clone(remote, 'writer'); const first = commit(writer, 'first'); git(writer, 'push', 'origin', 'main');
    const checkout = clone(remote, 'checkout');
    let r = await U.inspect(info(checkout, first));
    t('current checkout is up-to-date', r.state === 'up-to-date' && r.head === first && r.behind === 0);
    const diverged = clone(remote, 'diverged'); commit(diverged, 'local');
    const wrong = clone(remote, 'wrong'); git(wrong, 'checkout', '-b', 'feature');
    const dirty = clone(remote, 'dirty'); fs.writeFileSync(path.join(dirty, 'tracked.txt'), 'dirty');
    const second = commit(writer, 'second'); git(writer, 'push', 'origin', 'main');
    r = await U.inspect(info(checkout, first)); t('behind is available', r.state === 'available' && r.behind === 1 && r.ahead === 0);
    r = await U.inspect(info(diverged, first)); t('diverged is blocked', r.state === 'blocked' && r.reason === 'diverged' && r.ahead === 1 && r.behind === 1);
    r = await U.inspect(info(dirty, first)); t('tracked edits block updates', r.state === 'blocked' && r.reason === 'dirty');
    r = await U.inspect(info(wrong, first)); t('wrong branch blocks updates', r.state === 'blocked' && r.reason === 'wrong-branch');
    const ahead = clone(remote, 'ahead'); commit(ahead, 'ahead'); r = await U.inspect(info(ahead, second));
    t('ahead is blocked', r.state === 'blocked' && r.reason === 'diverged' && r.behind === 0);
    const pulled = clone(remote, 'pulled'); r = await U.inspect(info(pulled, first));
    t('checkout already pulled but installed commit older requires rebuild', r.state === 'available' && r.rebuild && r.behind === 0);
    r = await U.inspect({ ...info(pulled), builtAt: new Date().toISOString() });
    t('unknown installed commit does not claim latest', r.state === 'available' && r.rebuild);
    let fetchOptions;
    const fetchFail = async (cmd, args, opts) => { if (cmd === 'git' && args[0] === 'fetch') { fetchOptions = opts; throw new Error('failed'); } return U.exec(cmd, args, opts); };
    r = await U.inspect(info(pulled, second), fetchFail);
    t('fetch failure is blocked without interactive prompt and has timeout', r.reason === 'fetch-failed' && fetchOptions.env.GIT_TERMINAL_PROMPT === '0' && fetchOptions.timeout > 0);
    const noNode = async (cmd, args, opts) => { if (cmd === 'node' || cmd === 'npm' || cmd === '/bin/zsh') throw new Error('missing'); return U.exec(cmd, args, opts); };
    r = await U.inspect(info(pulled, second), noNode);
    t('missing Node and npm is blocked', r.reason === 'no-node');
    let timeout = false; try { await U.exec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 50, env: process.env }); } catch (e) { timeout = e.message === 'timeout'; }
    t('command timeout stops a long-running process', timeout);
    const streamed = []; const redacted = await U.exec(process.execPath, ['-e', "process.stdout.write('https://user:'); setTimeout(() => process.stdout.write('password@github.com/example/repo?key=secret\\n'), 20)"], { env: process.env, onLine: x => streamed.push(x) });
    t('split command output never exposes URL credentials or query', !JSON.stringify([redacted, streamed]).includes('password') && !JSON.stringify([redacted, streamed]).includes('secret') && streamed.length === 1);
    t('missing repository is blocked', (await U.inspect(info(path.join(root, 'missing')))).reason === 'repo-missing');
    t('non git folder is blocked', (await U.inspect(info(root))).reason === 'not-git');
    t('credentials and query removed', U.stripCredentials('https://user:password@github.com/example/repo.git?key=secret') === 'https://github.com/example/repo.git');
    t('malformed URL cannot preserve userinfo', !U.stripCredentials('https://user:password@bad host/repo').includes('password') && !B.stripCredentials('https://user:password@bad host/repo').includes('password'));
    t('https and ssh labels', U.remoteLabel('https://github.com/example/repo.git') === 'example/repo' && U.remoteLabel('git@github.com:example/repo.git') === 'example/repo');
    git(pulled, 'remote', 'set-url', 'origin', 'https://user:password@github.com/example/repo.git?key=secret');
    fs.mkdirSync(path.join(pulled, 'src'));
    const written = B.writeBuildInfo(pulled, { packager: { config: { directories: { output: 'dist-local' } } } });
    t('build-info stores no credentials, full commit, node path, and local config', written.remote === 'https://github.com/example/repo.git' && written.commit === second && written.repoDir === pulled && written.config === 'local' && written.nodeBin === path.dirname(process.execPath));
    t('build-info on disk is sanitized', !fs.readFileSync(path.join(pulled, 'src/build-info.json'), 'utf8').includes('password'));
    const noGit = path.join(root, 'no-git'); fs.mkdirSync(path.join(noGit, 'src'), { recursive: true });
    const partial = B.writeBuildInfo(noGit);
    t('missing Git metadata still writes what is known', !partial.commit && !partial.remote && partial.nodeBin && partial.builtAt);
    const altRemote = path.join(root, 'alt.git'); git(root, 'init', '--bare', '--initial-branch=release', altRemote);
    const altWriter = clone(altRemote, 'alt-writer'); const altCommit = commit(altWriter, 'release'); git(altWriter, 'push', 'origin', 'release');
    const altCheckout = clone(altRemote, 'alt-checkout'); r = await U.inspect(info(altCheckout, altCommit));
    t('remote default branch is discovered rather than assumed main', r.state === 'up-to-date' && r.defaultBranch === 'release');

    // A fake runner exercises every preparation branch without pulling, building, signing, or modifying the installed bundle.
    async function fakePrepare(name, { changed = false, modules = true, local = false, includeConfig = true, behind = 1, fail = '', installedCommit = 'old', dirtyAfterBuild = false } = {}) {
      const dir = path.join(root, name); fs.mkdirSync(dir); if (modules) fs.mkdirSync(path.join(dir, 'node_modules'));
      if (local && includeConfig) fs.writeFileSync(path.join(dir, 'electron-builder.local.json'), '{}');
      const installed = path.join(dir, 'Installed App.app'); fs.mkdirSync(installed); fs.writeFileSync(path.join(installed, 'keep'), 'unchanged');
      const calls = []; let head = 'old', built = false;
      const fake = async (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        if (cmd === fail || args[0] === fail) throw new Error('command failed');
        if (cmd === 'git') {
          if (args[0] === 'branch') return { stdout: 'main\n' };
          if (args[0] === 'status') return { stdout: built && dirtyAfterBuild ? ' M tracked.txt' : '' };
          if (args[0] === 'rev-list') return { stdout: `0\t${behind}\n` };
          if (args[0] === 'pull') { head = 'new'; return { stdout: '' }; }
          if (args[0] === 'rev-parse') return { stdout: head };
          if (args[0] === 'diff') return { stdout: changed ? 'package-lock.json\n' : '' };
        }
        if (cmd === 'npx') {
          built = true;
          const out = args.find(a => a.startsWith('-c.directories.output=')).split('=').slice(1).join('=');
          fs.mkdirSync(path.join(out, 'mac-arm64', 'Staged App.app'), { recursive: true });
        }
        return { stdout: '' };
      };
      const inspection = { state: 'available', head: 'old', defaultBranch: 'main', behind,
        toolchain: { npm: 'npm', npx: 'npx', env: { PATH: 'test' } } };
      const result = await U.prepare({ repoDir: dir, commit: installedCommit, config: local ? 'local' : 'default' }, fake, { inspection });
      return { result, calls, installed };
    }
    let p = await fakePrepare('prep local', { changed: true, local: true });
    const build = p.calls.find(c => c.cmd === 'npx');
    t('prepare pulls with ff-only', p.result.ok && p.calls.some(c => c.cmd === 'git' && c.args.join(' ') === 'pull --ff-only origin main'));
    t('lockfile change runs npm ci', p.calls.some(c => c.cmd === 'npm' && c.args.join(' ') === 'ci'));
    t('preload is checked', p.calls.some(c => c.cmd === 'node' && c.args.join(' ') === 'scripts/build-pane-preload.js --check'));
    t('local build writes metadata even if external config omits beforePack', p.calls.some(c => c.cmd === 'node' && c.args.includes('--write-info') && c.args.includes('electron-builder.local.json')));
    t('local build uses config and staging output with signing disabled', build.args.includes('electron-builder.local.json') && build.args.some(a => a.startsWith('-c.directories.output=') && a.includes('/dist-update/')) && build.opts.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false');
    t('staged app is signed and installed app untouched', p.calls.some(c => c.cmd === 'codesign' && c.args.at(-1) === p.result.appPath) && fs.readFileSync(path.join(p.installed, 'keep'), 'utf8') === 'unchanged');
    p = await fakePrepare('prep default', {});
    t('unchanged lock and existing modules skip npm ci', p.result.ok && !p.calls.some(c => c.cmd === 'npm'));
    t('default build does not use local config', !p.calls.find(c => c.cmd === 'npx').args.includes('--config'));
    p = await fakePrepare('prep missing modules', { modules: false, behind: 0 });
    t('missing modules trigger npm ci and rebuild skips pull', p.result.ok && p.calls.some(c => c.cmd === 'npm') && !p.calls.some(c => c.args[0] === 'pull'));
    p = await fakePrepare('prep already pulled lock', { behind: 0, changed: true, installedCommit: 'older' });
    t('already pulled lockfile change runs npm ci', p.result.ok && p.calls.some(c => c.cmd === 'npm') && !p.calls.some(c => c.args[0] === 'pull'));
    p = await fakePrepare('prep missing local config', { local: true, includeConfig: false });
    t('missing optional local config falls back to default build', p.result.ok && !p.calls.find(c => c.cmd === 'npx').args.includes('--config'));
    p = await fakePrepare('prep changed during build', { dirtyAfterBuild: true });
    t('tracked changes during build prevent signing', !p.result.ok && !p.calls.some(c => c.cmd === 'codesign') && fs.readFileSync(path.join(p.installed, 'keep'), 'utf8') === 'unchanged');
    p = await fakePrepare('prep failure', { changed: true, fail: 'npm' });
    t('first failure stops build and leaves installed app alone', !p.result.ok && !p.calls.some(c => c.cmd === 'npx' || c.cmd === 'codesign') && fs.readFileSync(path.join(p.installed, 'keep'), 'utf8') === 'unchanged');

    const helperDir = path.join(root, "helper's folder"); fs.mkdirSync(helperDir);
    const bundle = path.join(helperDir, "Old app's bundle.app"), staged = path.join(helperDir, 'New app.app'), logPath = path.join(helperDir, 'update log.txt');
    fs.mkdirSync(bundle); fs.writeFileSync(path.join(bundle, 'old'), 'original'); fs.mkdirSync(staged); fs.writeFileSync(path.join(staged, 'new'), 'new');
    const bin = path.join(helperDir, 'bin'); fs.mkdirSync(bin);
    const ditto = path.join(bin, 'ditto'); fs.writeFileSync(ditto, '#!/bin/sh\nmkdir -p "$2"\necho partial > "$2/partial"\nexit 1\n', { mode: 0o755 });
    const script = U.applyScript({ pid: 99999999, bundlePath: bundle, appPath: staged, logPath, relaunch: true });
    t('helper quotes paths and has rollback and reopen', script.includes("'\\''") && script.includes('restoring backup') && script.includes('mv "$backup" "$bundle"') && script.includes('open "$bundle"'));
    const helper = path.join(helperDir, 'apply.sh'); fs.writeFileSync(helper, script);
    const shell = cp.spawnSync('/bin/sh', [helper], { env: { ...process.env, PATH: bin + ':/usr/bin:/bin:/usr/sbin:/sbin' } });
    t('failed copy restores original bundle even with spaces and quotes', shell.status !== 0 && fs.readFileSync(path.join(bundle, 'old'), 'utf8') === 'original' && !fs.existsSync(path.join(bundle, 'partial')));
    fs.writeFileSync(ditto, '#!/bin/sh\ncp -R "$1" "$2"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'open'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const failedOpen = cp.spawnSync('/bin/sh', [helper], { env: { ...process.env, PATH: bin + ':/usr/bin:/bin:/usr/sbin:/sbin' } });
    t('failed relaunch restores original bundle', failedOpen.status !== 0 && fs.readFileSync(path.join(bundle, 'old'), 'utf8') === 'original' && !fs.existsSync(path.join(bundle, 'new')));
    const success = U.applyScript({ pid: 99999999, bundlePath: bundle, appPath: staged, logPath }); fs.writeFileSync(helper, success);
    const ok = cp.spawnSync('/bin/sh', [helper], { env: { ...process.env, PATH: bin + ':/usr/bin:/bin:/usr/sbin:/sbin' } });
    t('successful helper replaces bundle and removes backup', ok.status === 0 && fs.existsSync(path.join(bundle, 'new')) && !fs.readdirSync(helperDir).some(n => n.includes('.update.')));
  } catch (e) { bad++; console.error(e.stack); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
})();
