// panes.json reader / writer. main is the only writer, and this module the only code touching panes.json, its generations and temp files.
// Save: validate -> serialise -> temp file in the same directory -> write + fsync + close -> keep the file being replaced (a good one) as a
// generation -> rename over panes.json. A failed write / fsync / rename leaves the last good panes.json as it was.
// Requests are numbered (rev). One write at a time; while it runs only the newest pending snapshot is kept (older ones are merged into it),
// and a snapshot older than the last committed one is never renamed into place.
// load() status: 'ready' | 'recoveryRequired' (unreadable, broken JSON, wrong types) | 'unsupportedVersion' (written by a newer schema).
// Anything but 'ready' blocks every write until the user restores a generation or starts fresh; the original is then kept under another name.
// No power-loss guarantee: fsync on macOS does not force the drive cache, so the very last changes may still be lost.
// fs and the clock are injectable (test/state-store.test.js: temp directory + error injection).
const realFs = require('fs'), path = require('path');
const S = require('./state-schema');
const { stamp } = require('./state-backup');
const TMP_STALE_MS = 60000;                                   // temp files older than this at load are leftovers of an interrupted write

function createStore({ file, keep = 3, fs = realFs, now = () => new Date(), onChange = () => {} }) {
  const dir = path.dirname(file), base = path.basename(file), P = fs.promises;
  const at = n => path.join(dir, n);
  const genName = i => `${base}.prev-${i}`;                   // prev-1 = newest; never ends in .bak, so rotateBackup leaves it alone
  const isGen = n => n.startsWith(base + '.prev-') && /^\d+$/.test(n.slice(base.length + 6));
  const isBak = n => n.startsWith(base + '.') && n.endsWith('.bak');   // startup backups (state-backup.js)
  const isTmp = n => n.startsWith(base + '.tmp-');
  let status = 'ready', reason = '', errors = [], frozen = false;
  let rev = 0, committed = 0, pending = null, busy = false, lastText = null, saveError = '';
  let waiters = [];

  const writable = () => status === 'ready' && !frozen;
  const info = () => ({ status, reason, errors: errors.length, saveError, rev, committed, frozen });
  const changed = () => { try { onChange(info()); } catch {} };
  function block(st, why, errs) { status = st; reason = why; errors = errs; changed(); return { status, reason, errors }; }

  function cleanTemps() {
    let names = []; try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names.filter(isTmp)) { try { if (now().getTime() - fs.statSync(at(n)).mtimeMs > TMP_STALE_MS) fs.unlinkSync(at(n)); } catch {} }
  }
  // -> { status: 'ready', exists, doc, from, fixes } | { status: 'recoveryRequired' | 'unsupportedVersion', reason, errors }
  function load() {
    cleanTemps();
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') { status = 'ready'; return { status, exists: false, doc: S.emptyDoc(), from: S.SCHEMA_VERSION, fixes: [] }; }
      return block('recoveryRequired', 'read', [e.code || 'read error']);
    }
    const r = S.parse(text);
    if (!r.ok) return block(r.status, r.reason, r.errors);
    status = 'ready'; lastText = text;
    return { status, exists: true, doc: r.doc, from: r.from, fixes: r.fixes };
  }

  // queue a snapshot; returns its rev (0 = blocked: nothing is written)
  function save(doc) {
    if (!writable()) return 0;
    pending = { rev: ++rev, doc };                            // replaces an older request that has not started yet
    if (!busy) drain();
    return rev;
  }
  async function drain() {
    busy = true;
    while (pending) {
      const job = pending; pending = null;
      try { await commit(job); if (saveError) { saveError = ''; changed(); } }
      catch (e) { saveError = e.code || 'EIO'; changed(); }
      settle();
    }
    busy = false; settle();
  }
  async function commit(job) {
    if (!writable() || job.rev <= committed) return;          // an older snapshot never replaces a newer one
    const errs = S.validate(job.doc);
    if (errs.length) throw Object.assign(new Error('invalid state: ' + errs[0]), { code: 'EINVALID' });   // never write what load() would refuse
    const text = S.serialize(job.doc);
    if (text !== lastText) {
      const tmp = at(`${base}.tmp-${process.pid}-${job.rev}`);
      let fh = null;
      try {
        fh = await P.open(tmp, 'w');
        await fh.writeFile(text, 'utf8');
        await fh.sync();
        await fh.close(); fh = null;
        if (!writable()) { await P.unlink(tmp).catch(() => {}); return; }
        await keepGeneration().catch(() => {});               // best effort: a missing generation must not block the save itself
        await P.rename(tmp, file);
      } catch (e) {
        if (fh) await fh.close().catch(() => {});
        await P.unlink(tmp).catch(() => {});
        throw e;
      }
      lastText = text;
    }
    committed = job.rev;
  }
  // the file about to be replaced is good (loaded as ready, or written here): it becomes prev-1, older ones shift, at most `keep`
  async function keepGeneration() {
    if (keep < 1 || lastText === null) return;
    for (let i = keep; i > 1; i--) await P.rename(at(genName(i - 1)), at(genName(i))).catch(() => {});
    // prev-1 may still be a hard link to panes.json itself (an earlier rename failed): only ever remove that name, never write into it
    await P.unlink(at(genName(1))).catch(() => {});
    await P.link(file, at(genName(1))).catch(() => P.copyFile(file, at(genName(1)), realFs.constants.COPYFILE_EXCL));   // hard link: no copy, panes.json never missing
  }
  // save `doc` (if given) and wait until it is on disk. false = blocked, failed, or not done within `ms` (the write itself goes on)
  function flush(doc, ms = 3000) {
    if (!writable()) return Promise.resolve(false);
    const target = doc ? save(doc) : rev;
    return new Promise(resolve => {
      const w = { target, done: ok => { clearTimeout(w.timer); waiters = waiters.filter(x => x !== w); resolve(ok); } };
      w.timer = setTimeout(() => w.done(false), ms);
      waiters.push(w); settle();
    });
  }
  function settle() {
    for (const w of [...waiters]) {
      if (committed >= w.target) w.done(true);
      else if (!busy && !pending) w.done(false);
    }
  }

  // ---- recovery ----
  // generations + startup backups that load as a supported, valid state: newest first, each content once
  function candidates() {
    let names = []; try { names = fs.readdirSync(dir); } catch {}
    const seen = new Set();
    return names.filter(n => isGen(n) || isBak(n)).map(n => {
      try {
        const text = fs.readFileSync(at(n), 'utf8'), r = S.parse(text);
        return r.ok ? { id: n, kind: isGen(n) ? 'prev' : 'bak', at: fs.statSync(at(n)).mtimeMs, text, ...S.summary(r.doc) } : null;
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.at - a.at).filter(c => !seen.has(c.text) && seen.add(c.text)).map(({ text, ...c }) => c);
  }
  // the unusable original goes under a name nothing reads, rotates or deletes (panes.json.broken-… / .newer-…)
  function keepAside(move) {
    const tag = status === 'unsupportedVersion' ? 'newer' : 'broken', st = stamp(now());
    let name = `${base}.${tag}-${st}`;
    for (let i = 2; fs.existsSync(at(name)); i++) name = `${base}.${tag}-${st}-${i}`;
    try { if (move) fs.renameSync(file, at(name)); else fs.copyFileSync(file, at(name), realFs.constants.COPYFILE_EXCL); }
    catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
    return name;
  }
  function writeAtomicSync(text) {
    const tmp = at(`${base}.tmp-${process.pid}-restore`);
    let fd = null;
    try { fd = fs.openSync(tmp, 'w'); fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = null; fs.renameSync(tmp, file); }
    catch (e) { if (fd !== null) try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(tmp); } catch {} throw e; }
  }
  // put candidate `id` back as panes.json (the original is copied aside first; on any failure panes.json stays as it was).
  // Afterwards the store stays frozen: the caller relaunches, and the in-memory (default) state must not be written before that.
  function restore(id) {
    if (writable() || frozen) return { ok: false, error: 'EBUSY' };
    const c = candidates().find(x => x.id === id);
    if (!c) return { ok: false, error: 'ENOENT' };
    try {
      const text = fs.readFileSync(at(c.id), 'utf8');
      if (!S.parse(text).ok) return { ok: false, error: 'EINVALID' };
      const kept = keepAside(false);
      writeAtomicSync(text);
      frozen = true; changed();
      return { ok: true, kept };
    } catch (e) { return { ok: false, error: e.code || 'EIO' }; }
  }
  // move the original aside and allow saving again (the next save writes the current in-memory state as a new panes.json)
  function startFresh() {
    if (writable() || frozen) return { ok: false, error: 'EBUSY' };
    try {
      const kept = keepAside(true);
      status = 'ready'; reason = ''; errors = []; lastText = null; changed();
      return { ok: true, kept };
    } catch (e) { return { ok: false, error: e.code || 'EIO' }; }
  }

  return { load, save, flush, writable, info, candidates, restore, startFresh };
}
module.exports = { createStore };
