// Open the local Grok Bot macOS app (toolbar button). Pure helpers + a small driver the tests fake
// (fs / shell.openPath / execFile). The path is a constant: never taken from a renderer, settings, or the environment.
const APP = '/Applications/Grok Bot.app';
const TOAST = {
  missing: { text: 'Grok Botアプリが見つかりません', kind: 'warn' },
  fail: { text: 'Grok Botを開けませんでした', kind: 'err' },
  platform: { text: 'Grok Botを開くのはMacのみです', kind: 'warn' },
};

function isAppDir(st) {
  return !!st && (st.isDirectory?.() === true || st.isDirectory === true);
}

// exists at APP and looks like an .app bundle (a directory) -> true; anything else / unreadable -> false
function present(fs) {
  try {
    if (!fs || typeof fs.statSync !== 'function' && typeof fs.existsSync !== 'function') return false;
    if (typeof fs.existsSync === 'function' && fs.existsSync(APP) !== true) return false;
    if (typeof fs.statSync === 'function') {
      const st = fs.statSync(APP);
      return isAppDir(st);
    }
    return true;
  } catch { return false; }
}

// decide first (no I/O besides a stat): 'open' | 'missing' | 'platform'
function plan(platform, fs) {
  if (platform !== 'darwin') return 'platform';
  return present(fs) ? 'open' : 'missing';
}

// Launch / bring to front. Prefer `open -a` (fixed argv, no shell) so an already-running app comes forward;
// fall back to shell.openPath with the same constant path. Success: no toast. Failure / missing: a fixed Japanese toast (never a path in it).
async function open({ platform, fs, execFile, openPath }) {
  const step = plan(platform, fs);
  if (step !== 'open') return { ok: false, code: step, toast: TOAST[step] };
  try {
    if (typeof execFile === 'function') {
      await new Promise((resolve, reject) => {
        execFile('/usr/bin/open', ['-a', APP], (err) => err ? reject(err) : resolve());
      });
      return { ok: true, code: 'OK' };
    }
    if (typeof openPath === 'function') {
      const err = await openPath(APP);
      if (err) return { ok: false, code: 'fail', toast: TOAST.fail };
      return { ok: true, code: 'OK' };
    }
    return { ok: false, code: 'fail', toast: TOAST.fail };
  } catch { return { ok: false, code: 'fail', toast: TOAST.fail }; }
}

module.exports = { APP, TOAST, plan, present, open };
