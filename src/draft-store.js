// Only main owns this store. Text never goes to diagnostics. One writer, newest pending snapshot, 0600 temp + fsync + rename.
const realFs = require('fs');
const path = require('path');
const { DRAFT } = require('./pane-rules');
function createDraftStore({ file, fs = realFs, now = Date.now, onError = () => {} }) {
  let items = [], rev = 0, pending = null, running = null, dirty = false, enabled = true;
  const report = code => { try { onError(code); } catch {} };
  const doc = () => JSON.stringify({ v: 1, items });
  function cleanTemps() {
    // Interrupted temp writes may contain text too; remove only this store's stale temp files.
    try {
      const base = path.basename(file) + '.tmp-';
      for (const name of fs.readdirSync(path.dirname(file))) {
        if (!name.startsWith(base) || !/^\d+-\d+$/.test(name.slice(base.length))) continue;
        const tmp = path.join(path.dirname(file), name);
        if (now() - fs.statSync(tmp).mtimeMs > 60000) fs.unlinkSync(tmp);
      }
    } catch { report('DRAFT_READ'); }
  }
  function load() {
    cleanTemps();
    try {
      if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error('size');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw.v !== 1 || !Array.isArray(raw.items)) throw new Error('format');
      items = DRAFT.clean(raw.items, now());
      if (JSON.stringify(items) !== JSON.stringify(raw.items)) queue();
    } catch (e) { if (e.code !== 'ENOENT') report('DRAFT_READ'); }
  }
  function queue() {
    dirty = true; pending = { rev: ++rev, text: doc() };
    if (!running) running = drain().finally(() => { running = null; });
    return running;
  }
  async function drain() {
    while (pending) {
      const job = pending; pending = null;
      const tmp = file + '.tmp-' + process.pid + '-' + job.rev;
      let fh;
      try {
        fh = await fs.promises.open(tmp, 'wx', 0o600);
        await fh.writeFile(job.text, 'utf8'); await fh.sync(); await fh.close(); fh = null;
        if (job.rev === rev) { await fs.promises.rename(tmp, file); if (job.rev === rev) dirty = false; }
        else await fs.promises.unlink(tmp);
      } catch {
        if (fh) await fh.close().catch(() => {});
        await fs.promises.unlink(tmp).catch(() => {}); report('DRAFT_WRITE');
      }
    }
  }
  function prune() {
    cleanTemps();
    const clean = DRAFT.clean(items, now());
    if (JSON.stringify(clean) !== JSON.stringify(items)) { items = clean; queue(); }
    else if (dirty && !running) queue();
  }
  function get(pane, url) { if (!enabled) return null; const d = items.find(x => DRAFT.key(x.pane, x.url) === DRAFT.key(pane, url)); return d && !DRAFT.expired(d.at, now()) ? { ...d } : null; }
  function remove(pane, url) {
    const keep = items.filter(d => d.pane !== pane || (url !== undefined && DRAFT.key(d.pane, d.url) !== DRAFT.key(pane, url)));
    if (keep.length !== items.length) { items = keep; queue(); }
  }
  function put(pane, url, text) {
    if (!enabled || !DRAFT.key(pane, url) || typeof text !== 'string') return;
    if (!text.trim()) return remove(pane, url);
    const key = DRAFT.key(pane, url), before = items.filter(d => DRAFT.key(d.pane, d.url) !== key);
    items = DRAFT.clean([...before, { pane, url, text, at: now() }], now()); queue();
  }
  function setEnabled(on) { enabled = on === true; if (!enabled) { items = []; queue(); } }
  async function flush() { if (dirty && !running) queue(); if (running) await running; return !dirty; }
  return { load, get, put, remove, prune, setEnabled, flush };
}
module.exports = { createDraftStore };
