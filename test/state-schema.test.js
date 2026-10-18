// node test/state-schema.test.js   (pure: no fs)
const S = require('../src/state-schema');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const A = 'https://a.example/', B = 'https://b.example/';
const win = (panes, extra = {}) => ({ layout: '2x2', focused: 0, panes, rows: [panes.length].filter(Boolean), window: { bounds: null, maximized: false }, ...extra });
const spec = url => ({ url, reloadMinutes: 0, name: '', color: 'none', muted: false, zoom: 1, zoomIndiv: false, sleep: true });
const cur = (over = {}) => ({ schema: 1, layout: '2x2', focused: 0, urls: [A], panes: [spec(A)], windows: [win([spec(A)])], favorites: [{ url: A, label: 'a' }], settings: { theme: 'dark' }, workspaces: {}, ...over });

// ---- old formats are still read ----
{
  const r = S.migrate({ layout: '3x1', focused: 1, urls: [A, B] });
  t('legacy urls-only file -> one window with those panes', r.ok && r.from === 0 && r.doc.windows.length === 1 && J(r.doc.windows[0].panes) === J([{ url: A }, { url: B }]) && r.doc.windows[0].layout === '3x1' && r.doc.windows[0].focused === 1);
  const p = S.migrate({ urls: [A], panes: [{ url: B, name: 'x' }] });
  t('legacy: panes win over urls (as before)', p.ok && p.doc.windows[0].panes[0].url === B);
  const e = S.migrate({});
  t('empty / missing state -> 4 new-tab panes, nothing else', e.ok && e.doc.windows[0].panes.length === 4 && e.doc.windows[0].panes.every(s => s.url === '') && J(e.doc.favorites) === '[]' && J(e.doc.workspaces) === '{}' && J(e.doc.settings) === '{}');
  t('emptyDoc() is the same default', J(S.emptyDoc()) === J(e.doc));
  const w = S.migrate({ windows: [], urls: [A] });
  t('empty windows[] falls back to the legacy fields (as before)', w.ok && w.doc.windows[0].panes[0].url === A);
  const c = S.migrate(cur({ urls: 'not-a-list', panes: 7 }));
  t('current format: legacy fields are ignored when windows[] exists', c.ok && c.doc.windows[0].panes[0].url === A);
  t('schema 0 (no field) and 1 are read', S.migrate(cur({ schema: undefined })).ok && S.migrate(cur()).ok);
}

// ---- future / broken -> not ready ----
{
  const f = S.migrate(cur({ schema: 2 }));
  t('newer schema -> unsupportedVersion', !f.ok && f.status === 'unsupportedVersion' && f.reason === 'newer');
  t('schema not a version number -> recoveryRequired', S.migrate(cur({ schema: 'x' })).status === 'recoveryRequired' && S.migrate(cur({ schema: -1 })).status === 'recoveryRequired');
  t('top level array / null / string -> recoveryRequired', [[], null, 'x', 3].every(v => S.migrate(v).status === 'recoveryRequired'));
  t('empty text / truncated JSON -> recoveryRequired (json)', ['', '{', J(cur()).slice(0, 40)].every(s => { const r = S.parse(s); return !r.ok && r.status === 'recoveryRequired' && r.reason === 'json'; }));
  t('valid JSON text -> ready', S.parse(J(cur())).ok);
}

// ---- 10-pane limit, value types, ids, rows ----
{
  const eleven = Array(11).fill(0).map(() => spec(A));
  t('11 panes in a window -> recoveryRequired (never silently cut)', S.migrate(cur({ windows: [win(eleven, { rows: [6, 5] })] })).status === 'recoveryRequired');
  t('10 panes are fine', S.migrate(cur({ windows: [win(eleven.slice(1), { rows: [5, 5] })] })).ok);
  t('11 panes in a workspace -> recoveryRequired', S.migrate(cur({ workspaces: { w: { layout: '2x2', panes: eleven } } })).status === 'recoveryRequired');
  t('pane zoom as string -> recoveryRequired', S.migrate(cur({ windows: [win([{ ...spec(A), zoom: '2' }])] })).status === 'recoveryRequired');
  t('pane url as number -> recoveryRequired', S.migrate(cur({ windows: [win([{ url: 5 }], { rows: [1] })] })).status === 'recoveryRequired');
  t('pane spec not an object -> recoveryRequired', S.migrate(cur({ windows: [win(['x'], { rows: [1] })] })).status === 'recoveryRequired');
  t('legacy urls with a non-string -> recoveryRequired', S.migrate({ urls: [A, 3] }).status === 'recoveryRequired');
  t('windows not an array -> recoveryRequired', S.migrate(cur({ windows: 'x' })).status === 'recoveryRequired');
  t('favorites / settings / workspaces of the wrong type -> recoveryRequired', [{ favorites: {} }, { favorites: [{ label: 'no url' }] }, { settings: [] }, { workspaces: [] }, { workspaces: { w: 'x' } }].every(o => S.migrate(cur(o)).status === 'recoveryRequired'));
  t('missing optional pane fields are fine (old saves)', S.migrate(cur({ windows: [{ panes: [{ url: A }] }] })).ok);
  const d = S.migrate(cur({ favorites: [{ url: A, label: 'a' }, { url: B }, { url: A, label: 'dup' }] }));
  t('duplicate favorite URLs: first kept, repair reported', d.ok && d.doc.favorites.length === 2 && d.doc.favorites[0].label === 'a' && d.fixes.some(x => /duplicate/.test(x)));
  t('validate(): duplicate favorite URL is an error (checked before every write)', S.validate({ ...d.doc, favorites: [{ url: A }, { url: A }] }).some(x => /duplicate/.test(x)));
  const r = S.migrate(cur({ windows: [win([spec(A), spec(B)], { rows: [3] })] }));
  t('rows not matching the panes: dropped (default grid, as before), repair reported', r.ok && r.doc.windows[0].rows === undefined && r.fixes.some(x => /rows/.test(x)));
  const k = S.migrate(cur({ windows: [win([spec(A), spec(B), spec(A)], { rows: [2, 1] })] }));
  t('matching rows are kept', k.ok && J(k.doc.windows[0].rows) === '[2,1]');
  t('validate(): rows not matching -> error', S.validate({ ...k.doc, windows: [win([spec(A)], { rows: [2] })] }).some(x => /rows/.test(x)));
  t('validate(): more than 10 panes -> error', S.validate({ ...k.doc, windows: [win(eleven, { rows: [11] })] }).some(x => /max 10/.test(x)));
  const many = Array(120).fill(0).map((_, i) => ({ url: `https://f${i}.example/` }));
  t('favorites over 100: first 100 kept (as before)', S.migrate(cur({ favorites: many })).doc.favorites.length === 100);
  const secret = S.migrate(cur({ workspaces: { 'SECRET-ROOM': { panes: [{ url: 'https://secret.example/bot/x', zoom: 'big' }] } } }));
  t('error messages name positions only (no workspace names / URLs)', !secret.ok && !/SECRET|secret\.example/.test(secret.errors.join(' ')) && /workspaces#0\.panes\[0\]\.zoom/.test(secret.errors.join(' ')));
}

// ---- serialize: same file shape as before (+ schema), round trip ----
{
  const doc = S.migrate(cur({ windows: [win([spec(A), spec(B)], { rows: [2] }), win([spec(B)])], workspaces: { w: { layout: '2x1', panes: [spec(A)], rows: [1] } } })).doc;
  const f = JSON.parse(S.serialize(doc));
  t('file keeps the legacy fields = first window', f.layout === '2x2' && f.focused === 0 && J(f.urls) === J([A, B]) && J(f.panes) === J(doc.windows[0].panes) && J(f.window) === J(doc.windows[0].window));
  t('file keeps windows / favorites / settings / workspaces', J(f.windows) === J(doc.windows) && J(f.favorites) === J(doc.favorites) && J(f.settings) === J(doc.settings) && J(f.workspaces) === J(doc.workspaces));
  t('file carries schema 1', f.schema === S.SCHEMA_VERSION && S.SCHEMA_VERSION === 1);
  const back = S.parse(S.serialize(doc));
  t('round trip: parse(serialize(doc)) is the same doc', back.ok && J(back.doc) === J(doc) && back.fixes.length === 0);
  t('summary counts only', J(S.summary(doc)) === J({ windows: 2, panes: 3, favorites: 1, workspaces: 1 }));
}

// ---- (#22) optional sleep snapshot in a pane spec: no new schema, never fatal (details: test/session-snapshot.test.js) ----
{
  const snap = { v: 1, at: 1760000000000, sl: true, mk: 'WAIT', ob: 1759999990000, nm: 'n', gp: '' };
  const ok = S.migrate(cur({ windows: [win([{ ...spec(A), snap }])] }));
  t('a valid snap: ready, kept, no repair, schema stays 1', ok.ok && J(ok.doc.windows[0].panes[0].snap) === J(snap) && !ok.fixes.length && S.SCHEMA_VERSION === 1);
  t('round trip keeps it', S.parse(S.serialize(ok.doc)).ok && J(S.parse(S.serialize(ok.doc)).doc) === J(ok.doc));
  const br = S.migrate(cur({ windows: [win([{ ...spec(A), snap: 'broken' }, { ...spec(B), snap: { ...snap, v: 5 } }])] }));
  t('broken / newer snap: dropped as a repair (not recoveryRequired)', br.ok && br.doc.windows[0].panes.every(s => !('snap' in s)) && br.fixes.length === 2);
  t('a spec without snap is untouched (older files read as before)', J(S.migrate(cur()).doc.windows[0].panes[0]) === J(spec(A)));
}
console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
