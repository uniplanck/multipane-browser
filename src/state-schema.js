// panes.json schema: pure parse / migrate / validate / serialize (no fs, no Electron). Unit-tested in test/state-schema.test.js.
// File shape (backward compatible): legacy single-window fields (layout/focused/urls/panes/window = first window) + windows[] + favorites
// + settings + workspaces. `schema` is new: absent = 0 = every file written before it. A file from a newer schema is never read.
// In memory the state is a "doc" { schema, windows, favorites, settings, workspaces }; the legacy fields only exist in the file.
// Policy: wrong container / value types and more than MAX_PANES panes are fatal (the file is kept and the user decides);
// what the app silently dropped anyway (rows that do not match the panes, duplicate favorite URLs, favorites over 100) is repaired.
// Messages name the position only (windows[0].panes[3].zoom), never URLs, pane / workspace names or other content.
// (#22) A pane spec may carry an optional sleep snapshot `snap` (session-snapshot.js; no new schema): never fatal. A broken / newer-version one
// is dropped and a usable one cleaned (types, limits) as a repair; a workspace never keeps one. validate() does not look at it.
// (dock) A window / workspace may carry optional `stacks` next to `rows` (dock-layout.js: the panes stacked in each cell; no new schema, `rows`
// still counts every pane, so an older app lays the stacked panes side by side). Stacks that do not fit the rows / the limits are dropped as a
// repair (the rows alone are read); validate() refuses them like rows that do not match.
// (Grok bar) An optional top-level `grok` (grok-bots.js: the Bot list read with the Grok button, the user's names, pins; no new schema, an older
// app ignores it): never fatal, cleaned as a repair (the Grok button reads the list again); validate() wants exactly what grok-bots clean() keeps.
// (使用量表示) settings.usageShow / usageV2 (booleans) and settings.usageProv (usage-config.js: providers × on / web / local): optional, no new
// schema (a file without them = before the redesign; main migrates it once). A non-boolean flag is dropped, a broken usageProv cleaned, as a
// repair; validate() wants booleans and exactly what usage-config clean() keeps. Other settings are not looked at (as before).
// (Grok bar 表示モード) settings.gbarMode (gbar-mode.js: 'normal' / 'semi' / 'compact'): optional, no new schema (none = 通常). Anything else is
// repaired to 'normal'; validate() wants one of the modes.
// (進捗サイドバー) settings.sidebarOpen (boolean), sidebarWidth (220-560) and sidebarUrl (sidebar-rules.js: https / loopback http, normalised):
// optional, no new schema (none = closed, 300 px, no URL). A non-boolean flag / unusable URL is dropped, a width out of range clamped, as a repair.
const SS = require('./session-snapshot');
const DL = require('./dock-layout');
const GB = require('./grok-bots');
const UC = require('./usage-config');
const GM = require('./gbar-mode');
const GS = require('./gbar-sections');
const AS = require('./approve-setting');
const SR = require('./sidebar-rules');
const { DRAFT } = require('./pane-rules');
const BOOL_FLAGS = ['usageShow', 'usageV2', 'saveDrafts', 'approveKeepAwake', 'sidebarOpen'];
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
  if (has(g, 'stacks') && !DL.stacksOk(g.stacks, g.rows)) e.push(`${at}.stacks: does not match the rows`);
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
  if (doc.grok !== undefined && !GB.valid(doc.grok)) e.push('grok: not a clean Bot list');
  if (!isObj(doc.settings)) e.push('settings: not an object');
  else {
    BOOL_FLAGS.forEach(k => { if (doc.settings[k] !== undefined && typeof doc.settings[k] !== 'boolean') e.push(`settings.${k}: not a boolean`); });
    if (doc.settings.usageProv !== undefined && !UC.valid(doc.settings.usageProv)) e.push('settings.usageProv: not a clean provider list');
    if (doc.settings.gbarMode !== undefined && !GM.isMode(doc.settings.gbarMode)) e.push('settings.gbarMode: not a mode');
    if (doc.settings.gbarSecOpen !== undefined && !GS.valid(doc.settings.gbarSecOpen)) e.push('settings.gbarSecOpen: not a clean section list');
    if (doc.settings.approveUrl !== undefined && (!AS.validUrl(doc.settings.approveUrl) || AS.normalizeUrl(doc.settings.approveUrl) !== doc.settings.approveUrl)) e.push('settings.approveUrl: not a normalized Bot URL');
    if (doc.settings.approveLabel !== undefined && (!AS.validLabel(doc.settings.approveLabel) || doc.settings.approveLabel !== doc.settings.approveLabel.trim())) e.push('settings.approveLabel: not a clean label');
    if (doc.settings.sidebarWidth !== undefined && SR.clampWidth(doc.settings.sidebarWidth) !== doc.settings.sidebarWidth) e.push('settings.sidebarWidth: not a width');
    if (doc.settings.sidebarUrl !== undefined && (typeof doc.settings.sidebarUrl !== 'string' || (doc.settings.sidebarUrl !== '' && SR.normalizeUrl(doc.settings.sidebarUrl) !== doc.settings.sidebarUrl))) e.push('settings.sidebarUrl: not a normalized URL');
  }
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
  const fixStacks = (g, at) => {                               // (dock) stacks that do not fit the (kept) rows / the limits: read as one pane per cell
    if (!isObj(g) || g.stacks === undefined || DL.stacksOk(g.stacks, g.rows)) return g;
    const c = { ...g }; delete c.stacks; fixes.push(`${at}.stacks: does not match the rows, dropped`); return c;
  };
  const fixSnaps = (g, at, drop) => {                         // (#22) the panes' sleep snapshots: cleaned (windows) / dropped (workspaces, unusable)
    if (!isObj(g) || !Array.isArray(g.panes) || !g.panes.some(s => isObj(s) && s.snap !== undefined)) return g;
    return { ...g, panes: g.panes.map((s, i) => {
      if (!isObj(s) || s.snap === undefined) return s;
      const c = drop ? null : SS.clean(s.snap);
      if (c && SS.same(c, s.snap)) return s;
      const n = { ...s }; if (c) n.snap = c; else delete n.snap;
      fixes.push(`${at}.panes[${i}].snap: ${c ? 'repaired' : 'dropped'}`); return n;
    }) };
  };
  if (Array.isArray(windows)) windows = windows.map((w, i) => fixSnaps(fixStacks(fixRows(w, `windows[${i}]`), `windows[${i}]`), `windows[${i}]`, false));
  const draftIds = new Set();
  const fixDraftIds = (g, drop) => !isObj(g) || !Array.isArray(g.panes) ? g : { ...g, panes: g.panes.map(s => {
    if (!isObj(s) || s.draftId === undefined) return s;
    if (!drop && DRAFT.id(s.draftId) && !draftIds.has(s.draftId)) { draftIds.add(s.draftId); return s; }
    const c = { ...s }; delete c.draftId; fixes.push('draftId: dropped'); return c;
  }) };
  if (Array.isArray(windows)) windows = windows.map(w => fixDraftIds(w, false));
  let favorites = raw.favorites == null ? [] : raw.favorites;
  if (Array.isArray(favorites) && favorites.every(f => isObj(f) && typeof f.url === 'string')) {
    const seen = new Set(), uniq = favorites.filter(f => !seen.has(f.url) && seen.add(f.url));
    if (uniq.length < favorites.length) fixes.push(`favorites: ${favorites.length - uniq.length} duplicate URL(s) dropped`);
    if (uniq.length > MAX_FAVS) fixes.push(`favorites: kept the first ${MAX_FAVS}`);
    favorites = uniq.slice(0, MAX_FAVS);
  }
  let workspaces = raw.workspaces == null ? {} : raw.workspaces;
  if (isObj(workspaces)) workspaces = Object.fromEntries(Object.entries(workspaces).map(([n, ws], i) => [n, fixDraftIds(fixSnaps(fixStacks(fixRows(ws, `workspaces#${i}`), `workspaces#${i}`), `workspaces#${i}`, true), true)]));
  let grok;                                                    // (Grok bar) unusable entries dropped, the rest cut to the limits
  if (raw.grok != null) { const c = GB.clean(raw.grok); grok = c.grok; if (!c.same) fixes.push('grok: repaired'); }
  let settings = raw.settings == null ? {} : raw.settings;
  if (isObj(settings) && (BOOL_FLAGS.some(k => settings[k] !== undefined && typeof settings[k] !== 'boolean') || (settings.usageProv !== undefined && !UC.valid(settings.usageProv)))) {
    settings = { ...settings };                              // (使用量表示) a bad flag: dropped (main decides again); a broken provider list: cleaned
    BOOL_FLAGS.forEach(k => { if (settings[k] !== undefined && typeof settings[k] !== 'boolean') { delete settings[k]; fixes.push(`settings.${k}: not a boolean, dropped`); } });
    if (settings.usageProv !== undefined && !UC.valid(settings.usageProv)) { settings.usageProv = UC.clean(settings.usageProv).prov; fixes.push('settings.usageProv: repaired'); }
  }
  if (isObj(settings) && settings.gbarMode !== undefined && !GM.isMode(settings.gbarMode)) {   // (表示モード) unknown: back to 通常
    settings = { ...settings, gbarMode: 'normal' }; fixes.push('settings.gbarMode: not a mode, set to normal');
  }
  if (isObj(settings) && settings.gbarSecOpen !== undefined && !GS.valid(settings.gbarSecOpen)) {
    settings = { ...settings, gbarSecOpen: GS.clean(settings.gbarSecOpen) }; fixes.push('settings.gbarSecOpen: repaired');
  }
  if (isObj(settings)) {
    for (const key of ['approveUrl', 'approveLabel']) {
      if (settings[key] === undefined) continue;
      const value = key === 'approveUrl' ? AS.validUrl(settings[key]) ? AS.normalizeUrl(settings[key]) : null : AS.validLabel(settings[key]) ? settings[key].trim() : null;
      if (value !== null && value === settings[key]) continue;
      settings = { ...settings };
      if (value === null) delete settings[key]; else settings[key] = value;
      fixes.push(`settings.${key}: ${value === null ? 'dropped' : 'repaired'}`);
    }
  }
  if (isObj(settings) && settings.sidebarWidth !== undefined && SR.clampWidth(settings.sidebarWidth) !== settings.sidebarWidth) {   // (進捗サイドバー) into 220-560 (not a number: 300)
    settings = { ...settings, sidebarWidth: SR.clampWidth(settings.sidebarWidth) }; fixes.push('settings.sidebarWidth: repaired');
  }
  if (isObj(settings) && settings.sidebarUrl !== undefined && settings.sidebarUrl !== '' && SR.normalizeUrl(settings.sidebarUrl) !== settings.sidebarUrl) {   // unusable: no sidebar
    const url = typeof settings.sidebarUrl === 'string' ? SR.normalizeUrl(settings.sidebarUrl) : '';
    settings = { ...settings }; if (url) settings.sidebarUrl = url; else delete settings.sidebarUrl;
    fixes.push(`settings.sidebarUrl: ${url ? 'repaired' : 'dropped'}`);
  }
  const doc = { schema: SCHEMA_VERSION, windows, favorites, ...(grok ? { grok } : {}), settings, workspaces };
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
    ...(doc.grok ? { grok: doc.grok } : {}),
    settings: doc.settings, workspaces: doc.workspaces,
  }, null, 2);
}
// counts only (shown in the recovery list): no URLs or names
const summary = doc => ({ windows: doc.windows.length, panes: doc.windows.reduce((a, w) => a + paneCount(w), 0), favorites: doc.favorites.length, workspaces: Object.keys(doc.workspaces).length });

module.exports = { SCHEMA_VERSION, MAX_PANES, MAX_FAVS, parse, migrate, validate, serialize, emptyDoc, summary };
