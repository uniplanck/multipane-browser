// panes.json schema: pure parse / migrate / validate / serialize (no fs, no Electron). Unit-tested in test/state-schema.test.js.
// File shape (backward compatible): legacy single-window fields (layout/focused/urls/panes/window = first window) + windows[] + favorites
// + settings + workspaces. `schema` is new: absent = 0 = every file written before it. A file from a newer schema is never read.
// In memory the state is a "doc" { schema, windows, favorites, settings, workspaces }; the legacy fields only exist in the file.
// Policy: wrong container / value types and more than MAX_PANES panes are fatal (the file is kept and the user decides);
// what the app silently dropped anyway (rows that do not match the panes, duplicate favorite URLs, favorites over 100) is repaired.
// Messages name the position only (windows[0].panes[3].zoom), never URLs, pane / workspace names or other content.
const SCHEMA_VERSION = 1;
const MAX_PANES = 10, MAX_FAVS = 100;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => o[k] !== undefined && o[k] !== null;
const defaultPanes = () => Array(4).fill(0).map(() => ({ url: '' }));
const rowsOk = (rows, n) => Array.isArray(rows) && rows.every(k => Number.isInteger(k) && k > 0) && rows.reduce((a, b) => a + b, 0) === n;
const paneCount = g => Array.isArray(g.panes) ? g.panes.length : 0;

const SPEC_TYPES = { url: 'string', name: 'string', color: 'string', reloadMinutes: 'number', zoom: 'number', muted: 'boolean', zoomIndiv: 'boolean', sleep: 'boolean' };
function specErrors(s, at) {
  if (!isObj(s)) return [`${at}: not an object`];
  return Object.entries(SPEC_TYPES).filter(([k, t]) => has(s, k) && typeof s[k] !== t).map(([k, t]) => `${at}.${k}: not a ${t}`);
}
// a window (windows[i]) or a saved workspace: both hold a layout, up to MAX_PANES pane specs and their row structure
function groupErrors(g, at) {
  if (!isObj(g)) return [`${at}: not an object`];
  const e = [];
  if (has(g, 'layout') && typeof g.layout !== 'string') e.push(`${at}.layout: not a string`);
  if (has(g, 'focused') && !Number.isFinite(g.focused)) e.push(`${at}.focused: not a number`);
  if (has(g, 'window') && !isObj(g.window)) e.push(`${at}.window: not an object`);
  if (has(g, 'panes')) {
    if (!Array.isArray(g.panes)) e.push(`${at}.panes: not an array`);
    else {
      if (g.panes.length > MAX_PANES) e.push(`${at}.panes: ${g.panes.length} panes (max ${MAX_PANES})`);
      g.panes.forEach((s, i) => e.push(...specErrors(s, `${at}.panes[${i}]`)));
    }
  }
  if (has(g, 'rows') && !rowsOk(g.rows, paneCount(g))) e.push(`${at}.rows: does not match the panes`);
  return e;
}

// strict check of an in-memory doc: run on every load (after migrate) and before every write
function validate(doc) {
  if (!isObj(doc)) return ['state: not an object'];
  const e = [];
  if (!Array.isArray(doc.windows) || !doc.windows.length) e.push('windows: not a non-empty array');
  else doc.windows.forEach((w, i) => e.push(...groupErrors(w, `windows[${i}]`)));
  if (!Array.isArray(doc.favorites)) e.push('favorites: not an array');
  else {
    const seen = new Set();                                  // a favorite is identified by its URL (numeric ids are assigned at load, never stored)
    doc.favorites.forEach((f, i) => {
      if (!isObj(f) || typeof f.url !== 'string') { e.push(`favorites[${i}]: no URL`); return; }
      if (has(f, 'label') && typeof f.label !== 'string') e.push(`favorites[${i}].label: not a string`);
      if (seen.has(f.url)) e.push(`favorites[${i}]: duplicate URL`);
      seen.add(f.url);
    });
  }
  if (!isObj(doc.settings)) e.push('settings: not an object');
  if (!isObj(doc.workspaces)) e.push('workspaces: not an object');
  else Object.values(doc.workspaces).forEach((ws, i) => e.push(...groupErrors(ws, `workspaces#${i}`)));
  return e;
}

const fail = (status, reason, errors) => ({ ok: false, status, reason, errors });
// raw parsed JSON (any version up to SCHEMA_VERSION) -> { ok, status: 'ready', doc, from, fixes } | { ok: false, status, reason, errors }
function migrate(raw) {
  if (!isObj(raw)) return fail('recoveryRequired', 'invalid', ['top level: not an object']);
  const from = raw.schema === undefined ? 0 : raw.schema;
  if (!Number.isInteger(from) || from < 0) return fail('recoveryRequired', 'invalid', ['schema: not a version number']);
  if (from > SCHEMA_VERSION) return fail('unsupportedVersion', 'newer', [`schema ${from} is newer than ${SCHEMA_VERSION}`]);
  const fixes = [];
  let windows = raw.windows;
  if (windows == null || (Array.isArray(windows) && !windows.length)) {      // old single-window format: the only case the legacy fields are read
    if (has(raw, 'panes') && !Array.isArray(raw.panes)) return fail('recoveryRequired', 'invalid', ['panes: not an array']);
    if (has(raw, 'urls') && !(Array.isArray(raw.urls) && raw.urls.every(u => typeof u === 'string'))) return fail('recoveryRequired', 'invalid', ['urls: not a list of strings']);
    const specs = raw.panes?.length ? raw.panes : raw.urls?.length ? raw.urls.map(url => ({ url })) : defaultPanes();
    windows = [{ layout: raw.layout, focused: raw.focused, panes: specs, window: raw.window }];
  }
  const fixRows = (g, at) => {                                 // rows that do not add up to the panes: the app falls back to the default grid anyway
    if (!isObj(g) || g.rows === undefined || rowsOk(g.rows, paneCount(g))) return g;
    const c = { ...g }; delete c.rows; fixes.push(`${at}.rows: does not match the panes, dropped`); return c;
  };
  if (Array.isArray(windows)) windows = windows.map((w, i) => fixRows(w, `windows[${i}]`));
  let favorites = raw.favorites == null ? [] : raw.favorites;
  if (Array.isArray(favorites) && favorites.every(f => isObj(f) && typeof f.url === 'string')) {
    const seen = new Set(), uniq = favorites.filter(f => !seen.has(f.url) && seen.add(f.url));
    if (uniq.length < favorites.length) fixes.push(`favorites: ${favorites.length - uniq.length} duplicate URL(s) dropped`);
    if (uniq.length > MAX_FAVS) fixes.push(`favorites: kept the first ${MAX_FAVS}`);
    favorites = uniq.slice(0, MAX_FAVS);
  }
  let workspaces = raw.workspaces == null ? {} : raw.workspaces;
  if (isObj(workspaces)) workspaces = Object.fromEntries(Object.entries(workspaces).map(([n, ws], i) => [n, fixRows(ws, `workspaces#${i}`)]));
  const doc = { schema: SCHEMA_VERSION, windows, favorites, settings: raw.settings == null ? {} : raw.settings, workspaces };
  const errors = validate(doc);
  return errors.length ? fail('recoveryRequired', 'invalid', errors) : { ok: true, status: 'ready', doc, from, fixes };
}
// file text -> migrate() result; reason: 'json' (not JSON / empty / truncated) | 'invalid' (wrong types, too many panes) | 'newer' (future schema)
function parse(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return fail('recoveryRequired', 'json', ['not valid JSON']); }
  return migrate(raw);
}
const emptyDoc = () => migrate({}).doc;                        // first start: 4 new-tab panes, no favorites / workspaces / settings

function serialize(doc) {
  const first = doc.windows[0], panes = Array.isArray(first.panes) ? first.panes : [];
  return JSON.stringify({
    schema: SCHEMA_VERSION,
    // legacy single-window fields (= first window): older versions read only these
    layout: first.layout, focused: first.focused, urls: panes.map(s => s.url), panes, window: first.window,
    windows: doc.windows,
    favorites: doc.favorites,
    settings: doc.settings, workspaces: doc.workspaces,
  }, null, 2);
}
// counts only (shown in the recovery list): no URLs or names
const summary = doc => ({ windows: doc.windows.length, panes: doc.windows.reduce((a, w) => a + paneCount(w), 0), favorites: doc.favorites.length, workspaces: Object.keys(doc.workspaces).length });

module.exports = { SCHEMA_VERSION, MAX_PANES, MAX_FAVS, parse, migrate, validate, serialize, emptyDoc, summary };
