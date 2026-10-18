// node test/zoom-policy.test.js — pane zoom (#53): src/zoom-policy.js decides the range / step / reset, which panes a change applies to, the
// restored state of a saved pane, the backend of a view (native isolated zoom when the WebContents has it, else the preload as before) and what
// to do on a page (native and legacy never both). Contract with the real main.js / preload / diagnostics. Not covered here: real Electron zoom
// (two same-site panes at 75% / 125%, sleep / wake, popup, background check) - that needs the manual check.
const fs = require('fs'), path = require('path');
const Z = require('../src/zoom-policy');
const DG = require('../src/diagnostics');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const SRC = path.join(__dirname, '..', 'src'), read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const J = JSON.stringify;
const count = (s, sub) => s.split(sub).length - 1;

// ---- range / step / reset: 30%..300%, 10% steps, 100% ----
t('range / step / reset constants as before', Z.MIN === 0.3 && Z.MAX === 3 && Z.STEP === 0.1 && Z.DEF === 1);
t('clamp: in range kept, 2 decimals', Z.clamp(0.75) === 0.75 && Z.clamp(1.25) === 1.25 && Z.clamp(1.234) === 1.23 && Z.clamp('1.5') === 1.5);
t('clamp: limits', Z.clamp(0.1) === 0.3 && Z.clamp(5) === 3 && Z.clamp(0.3) === 0.3 && Z.clamp(3) === 3);
t('clamp: menu / key steps land on whole percents', Z.clamp(1.1 + Z.STEP) === 1.2 && Z.clamp(0.7 + Z.STEP) === 0.8 && Z.clamp(1 - Z.STEP) === 0.9 && Z.clamp(0.3 - Z.STEP) === 0.3 && Z.clamp(3 + Z.STEP) === 3);
{ let z = 1; for (let i = 0; i < 40; i++) z = Z.clamp(z + Z.STEP); const up = z; for (let i = 0; i < 40; i++) z = Z.clamp(z - Z.STEP);
  t('clamp: 40 steps up stop at 300%, 40 down at 30%', up === 3 && z === 0.3); }
t('clamp: invalid -> 100% (not a number, empty, NaN, Infinity, zero, negative, object)', [undefined, null, '', 'big', NaN, Infinity, -Infinity, 0, -1, -0.5, {}, [1, 2]].every(v => Z.clamp(v) === 1));

// ---- which panes a change applies to ----
{ const a = { id: 1 }, b = { id: 2, zoomIndiv: true }, c = { id: 3, sleeping: true }, d = { id: 4, zoomIndiv: false };
  const f = Z.followers([a, b, null, c, d]);
  t('global change: every pane that follows the global zoom (asleep too), not the individual ones', J(f.map(p => p.id)) === J([1, 3, 4]));
  t('followers: not a list -> none', Z.followers(undefined).length === 0 && Z.followers({}).length === 0);
  // what main does with it: global 125% to the followers, pane b's own 75% to b only
  const all = [a, b, c, d]; all.forEach(p => { p.zoom = 1; }); b.zoom = 0.75;
  Z.followers(all).forEach(p => { p.zoom = Z.clamp(1.25); });
  t('global 125%: followers 125%, the individual pane keeps 75%', a.zoom === 1.25 && c.zoom === 1.25 && d.zoom === 1.25 && b.zoom === 0.75); }

// ---- restore (new pane / restart / ↩ reopen / workspace) ----
t('new pane: follows the global zoom', J(Z.restore({}, 1.2)) === J({ zoomIndiv: false, zoom: 1.2 }) && J(Z.restore(undefined, 1)) === J({ zoomIndiv: false, zoom: 1 }));
t('saved individual pane: its own zoom', J(Z.restore({ zoom: 0.75, zoomIndiv: true }, 1.2)) === J({ zoomIndiv: true, zoom: 0.75 }));
t('saved following pane: the global zoom, not its saved one', J(Z.restore({ zoom: 1.5, zoomIndiv: false }, 0.9)) === J({ zoomIndiv: false, zoom: 0.9 }));
t('old save (no zoomIndiv): individual when not 100%, else following', J(Z.restore({ zoom: 1.25 }, 1)) === J({ zoomIndiv: true, zoom: 1.25 }) && J(Z.restore({ zoom: 1 }, 1.1)) === J({ zoomIndiv: false, zoom: 1.1 }));
t('restore: invalid zoom -> 100% / invalid global -> 100%', J(Z.restore({ zoom: 'big', zoomIndiv: true }, 1)) === J({ zoomIndiv: true, zoom: 1 }) && J(Z.restore({ zoom: -2 }, NaN)) === J({ zoomIndiv: false, zoom: 1 })
  && J(Z.restore({ zoom: 9, zoomIndiv: true }, 1)) === J({ zoomIndiv: true, zoom: 3 }));
{ const spec = p => ({ zoom: p.zoom || 1, zoomIndiv: !!p.zoomIndiv });      // = main.js paneSpec's zoom fields
  const ok = [[{ zoom: 0.75, zoomIndiv: true }, 1.25], [{ zoom: 1.25, zoomIndiv: true }, 0.75], [{}, 1.25], [{ zoom: 1.1 }, 1]].every(([s, g]) => { const p = Z.restore(s, g); return J(Z.restore(spec(p), g)) === J(p); });
  t('saved -> restored -> saved again: the same state (restart / ↩ reopen)', ok); }

// ---- backend of a view ----
const fake = (o = {}) => ({ setZoomMode() {}, setZoomFactor() {}, getZoomFactor() { return 1; }, ...o });
t('hasNative: setZoomMode + setZoomFactor + getZoomFactor functions', Z.hasNative(fake()) && !Z.hasNative(fake({ setZoomMode: undefined })) && !Z.hasNative(fake({ getZoomFactor: 1 }))
  && !Z.hasNative(null) && !Z.hasNative(undefined) && !Z.hasNative({}));
const B = o => { const r = Z.backend(o); return `${r.backend}/${r.code}`; };
t('backend: native when the API is there, the mode did not throw and reads back isolated', B({ api: true, mode: 'isolated' }) === 'native/NATIVE');
t('backend: no getZoomMode (mode undefined) -> native on the call not throwing', B({ api: true }) === 'native/NATIVE');
t('backend: no API -> legacy NO_API', B({ api: false }) === 'legacy/NO_API' && B({}) === 'legacy/NO_API' && B() === 'legacy/NO_API');
t('backend: setZoomMode threw -> legacy INIT_FAIL', B({ api: true, threw: true }) === 'legacy/INIT_FAIL');
t('backend: mode reads back something else -> legacy MODE_FAIL', ['default', 'manual', 'disabled', ''].every(m => B({ api: true, mode: m }) === 'legacy/MODE_FAIL'));
t('backend: turned off (MPB_NO_NATIVE_ZOOM) -> legacy FORCED, whatever the API', B({ api: true, forced: true, mode: 'isolated' }) === 'legacy/FORCED' && B({ api: false, forced: true }) === 'legacy/FORCED');

// ---- what to do on a page: one backend only ----
const P = o => Z.plan(o).ops.join(',');
t('legacy: the preload only (send), whatever the page reads', ['default', 'isolated', undefined].every(m => P({ backend: 'legacy', mode: m, factor: 2, zoom: 0.75 }) === 'send') && P({}) === 'send');
t('native, same zoom: nothing (no flip-flop on a repeated dom-ready / change)', P({ backend: 'native', mode: 'isolated', factor: 0.75, zoom: 0.75 }) === '' && P({ backend: 'native', mode: 'isolated', factor: 1.2500000001, zoom: 1.25 }) === '');
t('native, other zoom: the factor only', P({ backend: 'native', mode: 'isolated', factor: 1, zoom: 0.75 }) === 'factor' && P({ backend: 'native', factor: 1, zoom: 1.25 }) === 'factor');
t('native, the page lost its mode: mode first, then the factor (even when it reads the same)', P({ backend: 'native', mode: 'default', factor: 1, zoom: 0.75 }) === 'mode,factor' && P({ backend: 'native', mode: 'default', factor: 0.75, zoom: 0.75 }) === 'mode,factor');
t('native, unreadable factor: set it', P({ backend: 'native', mode: 'isolated', factor: undefined, zoom: 1 }) === 'factor' && P({ backend: 'native', mode: 'isolated', factor: NaN, zoom: 1 }) === 'factor');
t('never both: native never sends, legacy never touches the mode / factor', [0.3, 0.75, 1, 1.25, 3].every(z => ['default', 'isolated', undefined].every(m => [0.5, 1, z].every(f =>
  !Z.plan({ backend: 'native', mode: m, factor: f, zoom: z }).ops.includes('send') && J(Z.plan({ backend: 'legacy', mode: m, factor: f, zoom: z }).ops) === J(['send'])))));
t('plan: the zoom it applies is clamped', Z.plan({ backend: 'native', mode: 'isolated', factor: 1, zoom: 7 }).zoom === 3 && Z.plan({ backend: 'legacy', zoom: 'x' }).zoom === 1);

// ---- diagnostics: fixed codes only ----
t('diagnostics: zoom takes every zoom-policy code', J([...DG.ZOOM_CODES].sort()) === J([...Z.CODES].sort()) && Z.CODES.every(c => DG.EVENTS.zoom.r.includes(c)));
t('every backend() code is a code', [{}, { api: true }, { api: true, threw: true }, { api: true, mode: 'default' }, { forced: true }].every(o => Z.CODES.includes(Z.backend(o).code)));

// ---- contract with the real main.js / preload ----
{ const main = read('main.js');
  const fn = name => { const i = main.indexOf(`function ${name}(`); return i < 0 ? '' : main.slice(i, main.indexOf('\n}\n', i) + 2); };
  const add = fn('addPane'), apply = fn('applyZoom'), init = fn('initZoom'), norm = main.slice(main.indexOf('function normalizeHostZoom('), main.indexOf('\n', main.indexOf('function normalizeHostZoom(')));
  t('main: the zoom rules come from zoom-policy.js', /const ZP = require\('\.\/zoom-policy'\)/.test(main) && /const clampZ = ZP\.clamp;/.test(main) && /\.\.\.ZP\.restore\(spec, gZoom\(\)\)/.test(add)
    && /function applyGlobalZoom\(\) \{ ZP\.followers\(panes\)\.forEach\(p => applyZoom\(p, gZoom\(\)\)\)/.test(main));
  t('main: each pane view gets its backend before its first load', add.indexOf('initZoom(p);') > 0 && add.indexOf('initZoom(p);') < add.indexOf('loadInto(wc, p.url)') && add.indexOf('initZoom(p);') < add.indexOf('viewLoad('));
  t('main: initZoom checks the API, sets isolated in try/catch, reads the mode back, records a fixed code', /ZP\.hasNative\(wc\)/.test(init) && /try \{ wc\.setZoomMode\('isolated'\); mode = zoomModeOf\(wc\); \} catch \{ threw = true; \}/.test(init)
    && /ZP\.backend\(\{ api, forced: NO_NATIVE_ZOOM, threw, mode \}\)/.test(init) && /diag\.rec\('zoom', b\.code/.test(init));
  t('main: dev hook MPB_NO_NATIVE_ZOOM turns native off', /const NO_NATIVE_ZOOM = !!process\.env\.MPB_NO_NATIVE_ZOOM;/.test(main));
  t('main: applyZoom - native: plan, mode before factor, failure -> legacy; legacy: mpb:zoom', /ZP\.plan\(\{ backend: 'native'/.test(apply) && apply.indexOf("ops.includes('mode')") < apply.indexOf("ops.includes('factor')")
    && /catch \{ p\.zoomBackend = 'legacy'; diag\.rec\('zoom', 'FALLBACK'/.test(apply) && apply.indexOf('return;') < apply.indexOf("'mpb:zoom'"));
  t('main: the only zoom calls - setZoomMode in initZoom / applyZoom, setZoomFactor in applyZoom, setZoomLevel in normalizeHostZoom, mpb:zoom from applyZoom',
    count(main, '.setZoomMode(') === 2 && count(init, '.setZoomMode(') === 1 && count(apply, '.setZoomMode(') === 1 && count(main, '.setZoomFactor(') === 1 && count(apply, '.setZoomFactor(') === 1
    && count(main, '.setZoomLevel(') === 1 && count(norm, '.setZoomLevel(') === 1 && count(main, "send('mpb:zoom'") === 1 && count(apply, "send('mpb:zoom'") === 1);
  t('main: a native page never gets the host-level reset (it would read / reset its own zoom)', /wc\.on\('dom-ready', \(\) => \{ if \(p\.zoomBackend !== 'native'\) normalizeHostZoom\(wc\); applyZoom\(p, p\.zoom\);/.test(add)
    && /q\.zoomBackend !== 'native'/.test(norm));
  t('main: the 承認Bot popup keeps the default mode (host level reset only) and the background check gets no zoom', /wc\.on\('dom-ready', \(\) => normalizeHostZoom\(wc\)\);/.test(fn('ensureApprove')) && !/initZoom|applyZoom|setZoom/.test(fn('ensureApprove'))
    && !/initZoom|applyZoom|setZoom|mpb:zoom/.test(main.slice(main.indexOf('async function probePane('), main.indexOf('\n}\n', main.indexOf('async function probePane(')))));
  t('main: the saved form is unchanged (zoom, zoomIndiv; no backend saved)', /zoom: p\.zoom \|\| 1, zoomIndiv: !!p\.zoomIndiv, sleep:/.test(main) && !/zoomBackend[^\n]*paneSpec|paneSpec[^\n]*zoomBackend/.test(main));
  t('main: no zoom on focus', !/on\('focus'[^\n]*[Zz]oom/.test(main) && !/setFocused[^\n]*applyZoom/.test(main)); }
{ const tpl = read('pane-preload.template.js'), gen = read('pane-preload.js'), rx = /ipcRenderer\.on\('mpb:zoom', \(_e, z\) => \{ paneZoom = Number\(z\) > 0 \? Number\(z\) : 1; applyPaneZoom\(\); \}\);/;
  t('preload: the legacy receiver is kept (template and built preload)', rx.test(tpl) && rx.test(gen) && /webFrame\.setZoomFactor\(paneZoom\)/.test(gen) && /if \(paneZoom !== 1\) applyPaneZoom\(\)/.test(gen)); }

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
