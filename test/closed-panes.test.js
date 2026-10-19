// node test/closed-panes.test.js — #23 閉じたペインを開き直す. The pure history (src/closed-panes.js): what a closed pane leaves (minimal
// metadata only), the 10-entry limit, last in first out, an empty history, a full window (10 panes), a second reopen while one runs and a pane
// that could not be made (none of them takes an entry), where the pane goes back in the rows (with reopen-rules.js placeReopened, on a small
// model of main's rows), when the keyboard may follow. Then the diagnostics codes and main's wiring (contract with src/main.js).
// Not covered here: the real views, the load queue and the focus on screen - that needs the manual check.
const fs = require('fs'), path = require('path');
const CP = require('../src/closed-panes');
const { placeReopened } = require('../src/reopen-rules');
const DG = require('../src/diagnostics');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const NEWTAB = 'mpb://newtab';
const spec = (u, o = {}) => ({ url: u, reloadMinutes: 0, name: '', color: 'none', muted: false, zoom: 1, zoomIndiv: false, sleep: true, ...o });

// ---- where a pane sat ----
t('where: row / column in the row-major panes[]', J(CP.where([3, 2], 4)) === J({ row: 1, col: 1, rowGone: false, cols: 3 }) && J(CP.where([3, 2], 0)) === J({ row: 0, col: 0, rowGone: false, cols: 3 }));
t('where: the only pane of its row (the row will vanish)', J(CP.where([2, 1, 2], 2)) === J({ row: 1, col: 0, rowGone: true, cols: 2 }));
t('where: past the end stays in the last row; no rows is safe', CP.where([2, 2], 9).row === 1 && J(CP.where([], 0)) === J({ row: 0, col: 0, rowGone: false, cols: 1 }) && CP.where(null, 0).cols === 1);

// ---- what is kept: the spec main restores from + where it sat, nothing else ----
{ const e = CP.entry({ ...spec('https://grok.com/bot/a', { name: 'A', color: 'blue', zoom: 1.25, zoomIndiv: true, reloadMinutes: 5, muted: true, sleep: false }),
    draft: '下書き', text: '本文', attachments: ['a.png'], snap: { q: 'x' }, grokToken: 't', id: 7, view: {} }, CP.where([2, 2], 3), NEWTAB);
  t('entry: only url / name / color / muted / zoom / zoomIndiv / reloadMinutes / sleep and row / col / rowGone / cols',
    J(Object.keys(e).sort()) === J(['col', 'cols', 'row', 'rowGone', 'spec']) && J(Object.keys(e.spec).sort()) === J([...CP.SPEC_KEYS].sort()));
  t('entry: no draft / text / attachment / snapshot / token / pane id / view', !/下書き|本文|a\.png|grokToken|"id"|view/.test(J(e)) && e.spec.zoom === 1.25 && e.spec.zoomIndiv === true && e.spec.name === 'A');
  t('entry: a copy (changing the pane later does not change it)', (() => { const s = spec('https://x.test/'), k = CP.entry(s, CP.where([1], 0), NEWTAB); s.name = 'later'; return k.spec.name === ''; })());
  t('entry: a blank pane / the new-tab page / no spec -> nothing to reopen', [spec(''), spec(NEWTAB), null, { url: 5 }].every(s => CP.entry(s, CP.where([1], 0), NEWTAB) === null) && CP.entry(spec('https://x.test/'), null, NEWTAB) === null); }

// ---- the stack ----
{ const st = [];
  for (let i = 1; i <= 12; i++) CP.push(st, CP.entry(spec(`https://x.test/${i}`), CP.where([3], 0), NEWTAB));
  t('push: the newest 10 only (oldest dropped)', st.length === CP.LIMIT && CP.LIMIT === 10 && st[0].spec.url === 'https://x.test/3' && CP.peek(st).spec.url === 'https://x.test/12');
  CP.push(st, null);
  t('push: nothing (null) changes nothing', st.length === 10);
  const order = []; while (st.length) { const e = CP.peek(st); order.push(e.spec.url.split('/').pop()); CP.take(st, e); }
  t('last in, first out', order.join() === '12,11,10,9,8,7,6,5,4,3');
  t('empty: peek null, take false, cannot reopen', CP.peek(st) === null && CP.take(st, null) === false && !CP.canReopen(st, 0, 10) && CP.peek(null) === null && !CP.canReopen(undefined, 0, 10)); }
{ const st = [], a = CP.entry(spec('https://x.test/a'), CP.where([1], 0), NEWTAB), b = CP.entry(spec('https://x.test/b'), CP.where([1], 0), NEWTAB);
  CP.push(st, a); CP.push(st, b);
  t('take: only the newest entry, and only once (a second take of it does nothing)', !CP.take(st, a) && st.length === 2 && CP.take(st, b) && !CP.take(st, b) && st.length === 1 && CP.peek(st) === a);
  t('canReopen: an entry and fewer than MAX panes', CP.canReopen(st, 9, 10) && !CP.canReopen(st, 10, 10) && !CP.canReopen(st, 11, 10)); }

// ---- before a reopen ----
{ const st = [], e = CP.entry(spec('https://x.test/a'), CP.where([1], 0), NEWTAB); CP.push(st, e);
  t('plan: go with the newest entry, which stays in the history until the pane exists', J(CP.plan(st, 3, 10, false)) === J({ code: '', e }) && CP.plan(st, 3, 10, false).e === e && st.length === 1);
  t('plan: 10 panes -> FULL, nothing taken', CP.plan(st, 10, 10, false).code === 'FULL' && CP.plan(st, 10, 10, false).e === null && st.length === 1);
  t('plan: a reopen already running -> BUSY, nothing taken', CP.plan(st, 3, 10, true).code === 'BUSY' && st.length === 1);
  t('plan: nothing closed -> EMPTY', CP.plan([], 0, 10, false).code === 'EMPTY' && CP.plan(null, 0, 10, false).code === 'EMPTY');
  t('codes: fixed, = diagnostics reopen results', J(CP.CODES) === J(['OK', 'EMPTY', 'FULL', 'BUSY', 'FAIL']) && J(DG.REOPEN_CODES) === J(CP.CODES) && CP.CODES.every(c => DG.EVENTS.reopen.r.includes(c))); }

// ---- a small model of main's rows: closePane / reopenClosed as main does them (the pane is made by `make`, which may fail) ----
function model(rows) {
  let n = 0; const m = { rows: [...rows], panes: [], st: [], busy: false };
  rows.forEach(k => { for (let i = 0; i < k; i++) m.panes.push({ id: ++n, url: `https://x.test/${n}` }); });
  m.close = (id, keepEmpty) => {
    const i = m.panes.findIndex(p => p.id === id), w = CP.where(m.rows, i);
    if (!keepEmpty) CP.push(m.st, CP.entry(spec(m.panes[i].url), w, NEWTAB));
    m.rows[w.row]--; if (m.rows[w.row] <= 0) m.rows.splice(w.row, 1);
    m.panes.splice(i, 1);
  };
  m.reopen = (make = s => ({ id: ++n, url: s.url })) => {
    const pre = CP.plan(m.st, m.panes.length, 10, m.busy); if (pre.code) return pre.code;
    m.busy = true;
    try {
      let p = null; try { p = make(pre.e.spec); } catch {} if (!p) return 'FAIL';
      CP.take(m.st, pre.e);
      const pl = placeReopened(m.rows, pre.e); m.panes.splice(pl.index, 0, p); m.rows = pl.rows;
      return 'OK';
    } finally { m.busy = false; }
  };
  m.urls = () => m.panes.map(p => p.url.split('/').pop()).join();
  return m;
}
{ const m = model([3, 2]); m.close(4);
  t('model: a closed pane comes back into its row and column', m.reopen() === 'OK' && J(m.rows) === J([3, 2]) && m.urls() === '1,2,3,4,5'); }
{ const m = model([2, 1, 2]); m.close(3);
  t('model: its row had vanished -> the row comes back where it was, other rows unchanged', J(m.rows) === J([2, 2]) && m.reopen() === 'OK' && J(m.rows) === J([2, 1, 2]) && m.urls() === '1,2,3,4,5'); }
{ const m = model([3, 3]); m.close(2); m.close(6);
  t('model: two closed, reopened last first, each back in place', m.reopen() === 'OK' && m.urls() === '1,3,4,5,6' && m.reopen() === 'OK' && m.urls() === '1,2,3,4,5,6' && J(m.rows) === J([3, 3])); }
{ const m = model([3, 2]); m.close(2); m.panes.splice(2, 0, { id: 99, url: 'https://x.test/n' }); m.rows = [3, 2];   // its row filled up again meanwhile
  t('model: its row is full meanwhile -> the last row with room, other panes keep their places', m.reopen() === 'OK' && J(m.rows) === J([3, 3]) && m.urls() === '1,3,n,4,5,2'); }
{ const m = model([5, 5]); m.close(3); m.panes.push({ id: 98, url: 'https://x.test/n' }); m.rows = [5, 5];
  t('model: 10 panes -> FULL, nothing closed or taken, rows unchanged', m.reopen() === 'FULL' && m.st.length === 1 && m.panes.length === 10 && J(m.rows) === J([5, 5])); }
{ const m = model([2, 2]); m.close(1);
  t('model: the pane could not be made (null / throws) -> FAIL, the entry stays for the next try', m.reopen(() => null) === 'FAIL' && m.reopen(() => { throw new Error('x'); }) === 'FAIL'
    && m.st.length === 1 && m.panes.length === 3 && m.reopen() === 'OK' && m.st.length === 0 && m.urls() === '1,2,3,4'); }
{ const m = model([2, 2]); m.close(1); let inner = '';
  t('model: a second reopen while one runs -> BUSY, the same entry never comes back twice', m.reopen(s => { inner = m.reopen(); return { id: 50, url: s.url }; }) === 'OK' && inner === 'BUSY'
    && m.panes.length === 4 && m.st.length === 0 && m.reopen() === 'EMPTY'); }
{ const m = model([2, 2]); m.close(1, true); m.close(2, true);
  t('model: closing many at once (layout / workspace / close others) is not kept', m.st.length === 0 && m.reopen() === 'EMPTY'); }
{ const m = model([2]); m.panes[0].url = NEWTAB; m.close(1);
  t('model: the new-tab page is not kept', m.st.length === 0); }
{ const m = model([4, 4]); for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) m.close(id);
  let ok = 0; while (m.reopen() === 'OK') ok++;
  t('model: closing every pane one by one and reopening them all gives the same rows and order back', ok === 8 && J(m.rows) === J([4, 4]) && m.urls() === '1,2,3,4,5,6,7,8'); }

// ---- the keyboard after a reopen ----
{ const at = { id: 5, focusedId: 5, overlay: false, fw: 101, fws: [101, 102, 105], revs: [[1, 3], [2, 0], [5, 0]] };
  const now = o => ({ focusedId: 5, overlay: false, fw: 101, revs: [[1, 3], [2, 0], [5, 0]], ...o });
  t('focus: nothing moved -> follow into the new pane', CP.mayFocus(at, now()));
  t('focus: the keyboard still where ⌘⇧T / the palette left it, or already in the new pane', CP.mayFocus(at, now({ fw: 102 })) && CP.mayFocus(at, now({ fw: 105 })) && CP.mayFocus(at, now({ fw: 0 })));
  t('focus: another pane clicked (main focus moved) -> not taken back', !CP.mayFocus(at, now({ focusedId: 2 })));
  t('focus: a key typed into another pane -> not taken back', !CP.mayFocus(at, now({ revs: [[1, 4], [2, 0], [5, 0]] })) && !CP.mayFocus(at, now({ revs: [[1, 3], [2, 1], [5, 0]] })));
  t('focus: the keyboard went elsewhere (the address bar) / the palette opened -> not taken back', !CP.mayFocus(at, now({ fw: 200 })) && !CP.mayFocus(at, now({ overlay: true })));
  t('focus: a pane that appeared meanwhile does not count; junk -> no', CP.mayFocus(at, now({ revs: [[1, 3], [2, 0], [5, 0], [9, 4]] })) && !CP.mayFocus(null, now()) && !CP.mayFocus(at, null) && !CP.mayFocus({ ...at, fws: undefined }, now())); }

// ---- contract with src/main.js ----
{ const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const fn = name => { const i = main.indexOf(`function ${name}(`); return i < 0 ? '' : main.slice(i, main.indexOf('\n}\n', i)); };
  const close = fn('closePane'), reopen = fn('reopenClosed'), snap = fn('snapshot');
  t('main: closePane keeps an entry only when not closing many at once, through CP.entry (the new-tab page skipped)', /if \(!keepEmpty\) CP\.push\(closedStack, CP\.entry\(paneSpec\(panes\[i\]\), w, NEWTAB\)\)/.test(close));
  t('main: reopenClosed plans first, makes the pane through addPane (new id / generation, its load through the queue), takes the entry after',
    /CP\.plan\(closedStack, panes\.length, MAX, reopening\)/.test(reopen) && reopen.indexOf('addPane(') < reopen.indexOf('CP.take(closedStack, e)') && reopen.indexOf('if (!p)') < reopen.indexOf('CP.take(') && !/closedStack\.(pop|shift|splice)/.test(main));
  t('main: placed by dock-layout reopen (placeReopened on the cells, its stacked cell when it still fits), the keyboard follows only via CP.mayFocus', /DL\.reopen\(before, p\.id, e\)/.test(reopen) && /before = paneGrid\(\)/.test(reopen)
    && /CP\.mayFocus\(at, focusNow\(\)\)\) p\.view\.webContents\.focus\(\)/.test(reopen) && !/setTimeout\(\(\) => !p\.view/.test(reopen));
  t('main: closePane records where the pane sat in the cells (dock-layout where) and closes its cell / row (without)', /w = DL\.where\(g, id\)/.test(close) && /DL\.fromGrid\(DL\.without\(g, id\)\)/.test(close));
  const elsewhere = main.replace(close, '').replace(reopen, '').split('\n').filter(l => l.includes('closedStack'));
  t('main: the history is never saved (not in snapshot / panes.json) and the UI is told canReopen', snap.length > 100 && !/closedStack/.test(snap) && /canReopen: CP\.canReopen\(closedStack, panes\.length, MAX\)/.test(main)
    && elsewhere.length === 2 && /^const closedStack = \[\];/.test(elsewhere[0]) && elsewhere[1].includes('canReopen: CP.canReopen(closedStack'));
  t('main: ⌘⇧T, the menu, ↩ (IPC) and the palette all reach reopenClosed', /k === 't' && input\.shift\) \{ closeOverlay\(\); reopenClosed\(\)/.test(main) && /acc\('CmdOrCtrl\+Shift\+T', \(\) => cur\(\)\?\.reopenClosed\(\), '閉じたペインを開き直す'\)/.test(main)
    && /on\('reopen-closed', \(\) => reopenClosed\(\)\)/.test(main) && /case 'reopen-closed': closeOverlay\(\); reopenClosed\(\); break;/.test(main));
  t('main: reopen diagnostics are fixed codes + counts only', [...main.matchAll(/diag\.rec\('reopen'[^\n]*?\)/g)].length === 3 && [...main.matchAll(/diag\.rec\('reopen'([^\n]*?)\);/g)].every(m => !/url|name|spec|label/.test(m[1]))); }
{ const ov = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay.js'), 'utf8');
  t('palette: 閉じたペインを開き直す only while it can be done (S.canReopen), says the draft / attachment do not come back', /\.\.\.\(S\?\.canReopen \? \[\['閉じたペインを開き直す（下書き・添付は戻りません）', '↩', \{ type: 'reopen-closed' \}/.test(ov)); }

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
