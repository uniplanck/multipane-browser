// node test/state-store.test.js   (only touches its own directory under os.tmpdir(); fs errors are injected per store)
const fs = require('fs'), os = require('os'), path = require('path');
const { createStore } = require('../src/state-store');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-store-'));
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const A = 'https://a.example/', B = 'https://b.example/', C = 'https://c.example/', D = 'https://d.example/', E = 'https://e.example/';
let dirs = 0;
const box = () => { const d = path.join(root, String(++dirs)); fs.mkdirSync(d); return { d, f: path.join(d, 'panes.json') }; };
const io = () => ({ ...fs, promises: { ...fs.promises } });          // a store's own fs: a test replaces single calls to inject errors
const err = code => Object.assign(new Error(code), { code });
const doc = (urls, extra = {}) => ({ windows: [{ layout: '2x2', focused: 0, panes: urls.map(url => ({ url })), rows: urls.length ? [urls.length] : [] }], favorites: [], settings: {}, workspaces: {}, ...extra });
const read = f => fs.readFileSync(f, 'utf8');
const urlsOf = f => JSON.parse(read(f)).windows[0].panes.map(p => p.url);
const temps = d => fs.readdirSync(d).filter(n => n.includes('.tmp-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---- first start, atomic save, file shape ----
  {
    const { d, f } = box(), st = createStore({ file: f });
    const ld = st.load();
    t('missing file -> ready, default 4 panes, nothing written by load', ld.status === 'ready' && !ld.exists && ld.doc.windows[0].panes.length === 4 && !fs.existsSync(f));
    t('flush writes and confirms', await st.flush(doc([A, B]), 2000) === true);
    const j = JSON.parse(read(f));
    t('file: schema 1 + legacy fields + windows[]', j.schema === 1 && J(j.urls) === J([A, B]) && j.layout === '2x2' && j.windows.length === 1 && J(urlsOf(f)) === J([A, B]));
    t('no temp file left', temps(d).length === 0);
    t('first save keeps no generation (there was no file)', !fs.existsSync(f + '.prev-1'));
  }

  // ---- revisions: one write at a time, pending requests merged into the newest, an old snapshot never lands after a new one ----
  {
    const { f } = box(), x = io(), st = createStore({ file: f, fs: x }); st.load();
    await st.flush(doc([A]), 2000);
    let opens = 0, release; const gate = new Promise(r => { release = r; });
    const open0 = x.promises.open;
    x.promises.open = async (...a) => { opens++; if (opens === 1) await gate; return open0(...a); };
    const r1 = st.save(doc([B])), r2 = st.save(doc([C])), r3 = st.save(doc([D]));
    t('revisions increase', r1 > 0 && r1 < r2 && r2 < r3);
    const fl = st.flush(null, 3000);
    await sleep(30);
    t('while the first write hangs, panes.json is still the last good one', J(urlsOf(f)) === J([A]));
    release();
    t('flush waits for the newest rev', await fl === true && st.info().committed === r3);
    t('newest snapshot on disk; the merged-away middle one was never written', J(urlsOf(f)) === J([D]) && opens === 2);
    t('the in-flight older write became the generation, not the current file', J(JSON.parse(read(f + '.prev-1')).windows[0].panes.map(p => p.url)) === J([B]));
    const before = read(f);
    t('identical snapshot -> no write, still confirmed', await st.flush(doc([D]), 2000) === true && read(f) === before && opens === 2);
  }

  // ---- write / fsync / rename / open failures: last good file stays readable ----
  for (const [what, inject] of [
    ['open (ENOSPC)', x => { x.promises.open = async () => { throw err('ENOSPC'); }; }],
    ['write (EIO)', x => { const o = fs.promises.open; x.promises.open = async (...a) => { const h = await o(...a); return { writeFile: async () => { throw err('EIO'); }, sync: () => h.sync(), close: () => h.close() }; }; }],
    ['fsync (EIO)', x => { const o = fs.promises.open; x.promises.open = async (...a) => { const h = await o(...a); return { writeFile: (...w) => h.writeFile(...w), sync: async () => { throw err('EIO'); }, close: () => h.close() }; }; }],
    ['rename (EACCES)', x => { x.promises.rename = async () => { throw err('EACCES'); }; }],
  ]) {
    const { d, f } = box(), x = io(), seen = [], st = createStore({ file: f, fs: x, onChange: i => seen.push(i.saveError) }); st.load();
    await st.flush(doc([A]), 2000);
    const good = read(f);
    inject(x);
    const ok = await st.flush(doc([B]), 2000);
    t(`${what} fails -> flush false, error reported`, ok === false && st.info().saveError !== '' && seen.includes(st.info().saveError));
    t(`${what} fails -> panes.json unchanged and readable, no temp left`, read(f) === good && J(urlsOf(f)) === J([A]) && temps(d).length === 0);
    const fresh = createStore({ file: f }).load();
    t(`${what} fails -> a new start still loads the last good state`, fresh.status === 'ready' && J(fresh.doc.windows[0].panes.map(p => p.url)) === J([A]));
    Object.assign(x.promises, fs.promises);                           // the disk recovers: retry
    t(`${what}: retry succeeds and clears the error`, await st.flush(doc([B]), 2000) === true && st.info().saveError === '' && J(urlsOf(f)) === J([B]));
  }
  {
    const { f } = box(), st = createStore({ file: f }); st.load();
    await st.flush(doc([A]), 2000);
    const eleven = doc(Array(11).fill(A)); eleven.windows[0].rows = [6, 5];
    t('invalid state (11 panes) is never written', await st.flush(eleven, 2000) === false && st.info().saveError === 'EINVALID' && J(urlsOf(f)) === J([A]));
  }

  // ---- generations: the replaced good files, newest first, at most 3, distinct contents only ----
  {
    const { d, f } = box(), st = createStore({ file: f }); st.load();
    for (const u of [A, B, C, D, E]) await st.flush(doc([u]), 2000);
    const g = i => JSON.parse(read(`${f}.prev-${i}`)).windows[0].panes[0].url;
    t('prev-1..3 = the last three replaced states', g(1) === D && g(2) === C && g(3) === B && !fs.existsSync(f + '.prev-4'));
    await st.flush(doc([E]), 2000);
    t('saving the same content again does not rotate', g(1) === D);
    t('generations are not .bak (rotateBackup never deletes them)', fs.readdirSync(d).filter(n => n.endsWith('.bak')).length === 0);
  }
  {
    const { f } = box(), x = io(), st = createStore({ file: f, fs: x }); st.load();
    await st.flush(doc([A]), 2000);
    fs.linkSync(f, f + '.prev-1');                                     // prev-1 is still panes.json itself (left by an earlier failed rename)
    const rn = x.promises.rename;
    x.promises.rename = async (a, b) => { if (String(a).includes('.prev-')) throw err('EBUSY'); return rn(a, b); };
    x.promises.link = async () => { throw err('EPERM'); };             // no hard links: copy fallback
    t('generation fallback with prev-1 == panes.json: save still works', await st.flush(doc([B]), 2000) === true && J(urlsOf(f)) === J([B]));
    t('... and never truncates through the shared link (prev-1 = the old state)', J(JSON.parse(read(f + '.prev-1')).windows[0].panes.map(p => p.url)) === J([A]));
  }

  // ---- broken file: never overwritten, saves blocked, recovery ----
  {
    const { d, f } = box(), x = io();
    fs.writeFileSync(f + '.prev-1', JSON.stringify({ urls: [A] }));          // a readable older generation (legacy format)
    fs.writeFileSync(f + '.20261018-100000.bak', JSON.stringify({ urls: [B] }));
    fs.writeFileSync(f + '.20261018-090000.bak', '{"windows": [');           // an unreadable backup: not offered
    fs.writeFileSync(f + '.20261018-080000.bak', JSON.stringify({ urls: [A] })); // same content as prev-1: offered once
    fs.utimesSync(f + '.20261018-080000.bak', new Date(2026, 9, 18, 8), new Date(2026, 9, 18, 8));
    const broken = '{"layout":"2x2","windows":[{"panes":[{"url":"https://a.exa';   // cut off mid-write by something else
    fs.writeFileSync(f, broken);
    const st = createStore({ file: f, fs: x, now: () => new Date(2026, 9, 18, 12, 0, 0) });
    const ld = st.load();
    t('truncated JSON -> recoveryRequired (json)', ld.status === 'recoveryRequired' && ld.reason === 'json' && !st.writable());
    t('save is refused, flush is false', st.save(doc([C])) === 0 && await st.flush(doc([C]), 200) === false);
    t('the broken file is untouched', read(f) === broken && temps(d).length === 0);
    const cs = st.candidates();
    t('candidates: readable generations + backups only, identical content once', cs.length === 2 && cs.some(c => c.id === 'panes.json.prev-1' && c.kind === 'prev') && cs.some(c => c.id === 'panes.json.20261018-100000.bak' && c.kind === 'bak'));
    t('candidates carry counts only', cs.every(c => c.panes === 1 && c.windows === 1 && c.favorites === 0 && !('text' in c)));
    t('unknown id is refused', st.restore('../../etc/passwd').ok === false && st.restore('panes.json.20261018-090000.bak').ok === false && read(f) === broken);
    const r = st.restore('panes.json.20261018-100000.bak');
    t('restore: panes.json = the chosen backup', r.ok && read(f) === JSON.stringify({ urls: [B] }));
    t('restore: the broken original is kept aside', r.kept === 'panes.json.broken-20261018-120000' && read(path.join(d, r.kept)) === broken);
    t('restore: store frozen (nothing written before the relaunch)', st.save(doc([C])) === 0 && !st.writable() && read(f) === JSON.stringify({ urls: [B] }));
    t('restore: the restored file loads as ready', createStore({ file: f }).load().status === 'ready');
  }
  {
    const { d, f } = box(), st = createStore({ file: f, now: () => new Date(2026, 9, 18, 12, 0, 0) });
    fs.writeFileSync(f, JSON.stringify({ urls: [A], windows: [{ panes: [{ url: A, zoom: 'big' }] }] }));
    t('wrong value type -> recoveryRequired (invalid)', st.load().reason === 'invalid');
    fs.mkdirSync(path.join(d, 'x')); const dirAsFile = path.join(d, 'x');
    t('unreadable path (EISDIR) -> recoveryRequired (read)', createStore({ file: dirAsFile }).load().reason === 'read');
  }

  // ---- newer schema: never read or overwritten; start fresh keeps it aside ----
  {
    const { d, f } = box(), future = JSON.stringify({ schema: 9, windows: [{ panes: [{ url: A }] }], somethingNew: true });
    fs.writeFileSync(f, future);
    const st = createStore({ file: f, now: () => new Date(2026, 9, 18, 12, 0, 0) });
    const ld = st.load();
    t('newer schema -> unsupportedVersion, saves refused', ld.status === 'unsupportedVersion' && st.save(doc([B])) === 0 && read(f) === future);
    const r = st.startFresh();
    t('start fresh: original moved aside as .newer-, panes.json gone', r.ok && r.kept === 'panes.json.newer-20261018-120000' && read(path.join(d, r.kept)) === future && !fs.existsSync(f));
    t('start fresh: saving works again', st.writable() && await st.flush(doc([B]), 2000) === true && J(urlsOf(f)) === J([B]));
    t('start fresh: the unusable file never becomes a generation', !fs.existsSync(f + '.prev-1'));
    fs.writeFileSync(f, future);
    const again = createStore({ file: f, now: () => new Date(2026, 9, 18, 12, 0, 0) }); again.load();
    t('keep-aside never overwrites an earlier kept file (same second)', again.startFresh().kept === 'panes.json.newer-20261018-120000-2' && read(path.join(d, 'panes.json.newer-20261018-120000')) === future);
  }

  // ---- legacy file, temp cleanup, flush deadline ----
  {
    const { d, f } = box();
    fs.writeFileSync(f, JSON.stringify({ layout: '3x1', focused: 1, urls: [A, B, C] }));
    const old = path.join(d, 'panes.json.tmp-1-1'), recent = path.join(d, 'panes.json.tmp-2-1');
    fs.writeFileSync(old, '{'); fs.writeFileSync(recent, '{');
    fs.utimesSync(old, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
    const st = createStore({ file: f }), ld = st.load();
    t('legacy file -> ready, migrated from schema 0', ld.status === 'ready' && ld.from === 0 && J(ld.doc.windows[0].panes.map(p => p.url)) === J([A, B, C]) && ld.doc.windows[0].layout === '3x1');
    t('stale temp files removed at load, a fresh one (maybe another writer) kept', !fs.existsSync(old) && fs.existsSync(recent));
    await st.flush(ld.doc, 2000);
    const j = JSON.parse(read(f));
    t('first save upgrades the file, legacy fields kept', j.schema === 1 && J(j.urls) === J([A, B, C]) && j.layout === '3x1' && j.focused === 1 && j.windows.length === 1);
    t('the legacy original is kept as prev-1', JSON.parse(read(f + '.prev-1')).schema === undefined);
  }
  {
    const { f } = box(), x = io(), st = createStore({ file: f, fs: x }); st.load();
    x.promises.open = () => new Promise(() => {});                       // a disk that never answers
    const t0 = Date.now(), ok = await st.flush(doc([A]), 80);
    t('flush gives up at its deadline', ok === false && Date.now() - t0 < 1000);
  }

  fs.rmSync(root, { recursive: true });
  console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(root, { recursive: true }); } catch {} process.exit(1); });
