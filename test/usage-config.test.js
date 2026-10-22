// node test/usage-config.test.js — 使用量表示の設定 (src/usage-config.js): defaults (a new install shows no gauge), the one-time migration
// (new install = off; an install used before = on + the local sign-ins it used as checked opt-ins; a second run does nothing), the repair of
// panes.json's settings (also through state-schema.js: older files read as before), where each gauge's numbers come from, and the bar's view.
const UC = require('../src/usage-config');
const S = require('../src/state-schema');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const ALL = UC.PROVIDERS;
const srcs = s => Object.fromEntries(ALL.map(k => [k, UC.source(s, k)]));

// ---- defaults ----
{ const d = UC.defaults();
  t('providers in bar order: codex, claude, kimi, antigravity, grok', J(ALL) === J(['codex', 'claude', 'kimi', 'antigravity', 'grok']));
  t('defaults: the three gauges the bar had are on, Kimi / Antigravity off; nothing connected, no local opt-in',
    d.codex.on && d.claude.on && d.grok.on && !d.kimi.on && !d.antigravity.on && !d.codex.web && !d.claude.web && !d.kimi.web && !d.codex.local && !d.claude.local);
  t('defaults: exactly the fields of each provider (web for login providers, local for codex / claude only)', J(Object.keys(d.claude)) === J(['on', 'web', 'local']) && J(Object.keys(d.kimi)) === J(['on', 'web']) && J(Object.keys(d.antigravity)) === J(['on']) && J(Object.keys(d.grok)) === J(['on']));
  t('defaults() is a new object each time', UC.defaults() !== d && UC.defaults().claude !== d.claude && UC.valid(d)); }

// ---- the toggle: off unless explicitly true ----
t('no settings / usageShow missing / not exactly true -> every gauge off (nothing read)', [undefined, null, {}, { usageShow: false }, { usageShow: 'yes' }, { usageShow: 1 }, { usageProv: UC.defaults() }].every(s => ALL.every(k => UC.source(s, k) === 'off')));
t('view: off -> { show: false, list: [] }', J(UC.view({})) === J({ show: false, list: [] }) && J(UC.view({ usageShow: false, usageProv: UC.defaults() })) === J({ show: false, list: [] }));

// ---- migration ----
{ const m = UC.migrate({ theme: 'dark' }, { existing: false });
  t('new install: changed, usageShow off, usageV2 set, other settings kept', m.changed && m.settings.usageShow === false && m.settings.usageV2 === true && m.settings.theme === 'dark');
  t('new install: no local opt-in (Keychain / auth.json not read), nothing shown', !m.settings.usageProv.claude.local && !m.settings.usageProv.codex.local && ALL.every(k => UC.source(m.settings, k) === 'off'));
  t('new install, turned on later: the default gauges, not connected (click = login window), Grok from its panes', J(srcs({ ...m.settings, usageShow: true })) === J({ codex: 'none', claude: 'none', kimi: 'off', antigravity: 'off', grok: 'grok' }));
  const again = UC.migrate({ ...m.settings, usageShow: true }, { existing: true });
  t('second run (usageV2): nothing changes, the same object back', !again.changed && again.settings.usageShow === true && !again.settings.usageProv.claude.local); }
{ const old = { theme: 'system', usageBase: { day: '2026-10-21', used: 12, at: 1, periodEnd: 2 }, usageMargin: 5, notifV2: true };
  const m = UC.migrate(old, { existing: true });
  t('existing install: on, with the local sign-ins as checked opt-ins (the same gauges as before)', m.changed && m.settings.usageShow === true && m.settings.usageV2 === true && m.settings.usageProv.claude.local && m.settings.usageProv.codex.local);
  t('existing install: codex / claude read locally, Grok from its panes, Kimi / Antigravity not shown', J(srcs(m.settings)) === J({ codex: 'local', claude: 'local', kimi: 'off', antigravity: 'off', grok: 'grok' }));
  t('existing install: the bar = codex, claude, grok (as before), in order', J(UC.view(m.settings)) === J({ show: true, list: [{ id: 'codex', src: 'local' }, { id: 'claude', src: 'local' }, { id: 'grok', src: 'grok' }] }));
  t('existing install: the old gauge settings stay (usageBase / usageMargin)', J(m.settings.usageBase) === J(old.usageBase) && m.settings.usageMargin === 5);
  t('migrate does not change its input', !('usageV2' in old) && !('usageShow' in old) && !('usageProv' in old));
  const again = UC.migrate(m.settings, { existing: true });
  t('existing install, second run: nothing (a later choice is kept)', !again.changed && again.settings === m.settings);
  const userOff = UC.migrate({ ...m.settings, usageShow: false, usageProv: UC.set(m.settings, 'claude', 'local', false).usageProv }, { existing: true });
  t('after the migration, the user\'s own off / opt-out stays off', !userOff.changed && userOff.settings.usageShow === false && !userOff.settings.usageProv.claude.local); }
t('migrate: a flag already in the file (no usageV2) is kept; a broken provider list is cleaned', (m => m.settings.usageShow === false && m.settings.usageProv.codex.local && UC.valid(m.settings.usageProv))(UC.migrate({ usageShow: false, usageProv: { codex: 'x' } }, { existing: true })));
t('migrate: no options = a new install; garbage settings -> a fresh object', (m => m.changed && m.settings.usageShow === false)(UC.migrate({})) && (m => m.changed && m.settings.usageV2 === true)(UC.migrate(null)));

// ---- is it an install used before? ----
t('existingInstall: panes.json existed (also an unreadable one) -> yes', UC.existingInstall({ fileExisted: true, settings: {} }));
t('existingInstall: the old gauges\' settings -> yes (usageBase / usageMargin)', UC.existingInstall({ fileExisted: false, settings: { usageBase: { day: 'x' } } }) && UC.existingInstall({ fileExisted: false, settings: { usageMargin: 0 } }));
t('existingInstall: first start (no file, no usage setting) -> no', !UC.existingInstall({ fileExisted: false, settings: { theme: 'system' } }) && !UC.existingInstall({}) && !UC.existingInstall() && !UC.existingInstall({ fileExisted: 'yes', settings: { usageBase: 'x', usageMargin: '5' } }));

// ---- where the numbers come from ----
{ const on = p => ({ usageShow: true, usageV2: true, usageProv: { ...UC.defaults(), ...p } });
  t('local opt-in wins over a web sign-in (the old path the user asked for)', UC.source(on({ claude: { on: true, web: true, local: true } }), 'claude') === 'local');
  t('web sign-in -> web; neither -> none (not connected)', UC.source(on({ codex: { on: true, web: true, local: false } }), 'codex') === 'web' && UC.source(on({}), 'codex') === 'none');
  t('Kimi: web only (no local path)', UC.source(on({ kimi: { on: true, web: true } }), 'kimi') === 'web' && UC.source(on({ kimi: { on: true, web: false } }), 'kimi') === 'none');
  t('Antigravity: info (no number, no login window)', UC.source(on({ antigravity: { on: true } }), 'antigravity') === 'info');
  t('a provider turned off -> off, whatever its sign-in', UC.source(on({ claude: { on: false, web: true, local: true } }), 'claude') === 'off' && UC.source(on({ grok: { on: false } }), 'grok') === 'off');
  t('unknown kind -> off', ['gemini', '', '__proto__', 'toString', null].every(k => UC.source(on({}), k) === 'off'));
  t('a broken usageProv is read as cleaned (missing provider = its default)', UC.source({ usageShow: true, usageProv: { claude: { on: 'yes', local: true } } }, 'claude') === 'local' && UC.source({ usageShow: true, usageProv: 5 }, 'grok') === 'grok');
  const v = UC.view(on({ kimi: { on: true, web: false }, antigravity: { on: true }, codex: { on: false, web: false, local: false } }));
  t('view: the shown gauges in bar order with their source', J(v) === J({ show: true, list: [{ id: 'claude', src: 'none' }, { id: 'kimi', src: 'none' }, { id: 'antigravity', src: 'info' }, { id: 'grok', src: 'grok' }] })); }

// ---- clean / valid / set ----
{ const c = UC.clean({ claude: { on: false, web: true, local: 'yes', extra: 1 }, gemini: { on: true }, kimi: null });
  t('clean: known providers / fields only, booleans kept, the rest = defaults', J(c.prov.claude) === J({ on: false, web: true, local: false }) && !('gemini' in c.prov) && J(c.prov.kimi) === J({ on: false, web: false }) && !c.same && UC.valid(c.prov));
  t('clean: a clean list is the same', UC.clean(UC.defaults()).same && J(UC.clean(UC.defaults()).prov) === J(UC.defaults()));
  t('clean: garbage -> defaults', [undefined, null, 5, 'x', [], [{ claude: {} }]].every(x => J(UC.clean(x).prov) === J(UC.defaults()) && !UC.clean(x).same));
  t('valid: an extra provider / field, a missing one, a non-boolean -> no', !UC.valid({ ...UC.defaults(), gemini: { on: true } }) && !UC.valid({ ...UC.defaults(), grok: { on: true, web: false } })
    && !UC.valid((({ kimi, ...o }) => o)(UC.defaults())) && !UC.valid({ ...UC.defaults(), codex: { on: 1, web: false, local: false } }) && !UC.valid({ ...UC.defaults(), claude: [] }));
  t('valid: an inherited key does not count', !UC.valid(Object.assign(Object.create({ grok: { on: true } }), (({ grok, ...o }) => o)(UC.defaults()))));
  const s0 = { usageShow: true, theme: 'dark' }, s1 = UC.set(s0, 'kimi', 'on', true);
  t('set: a new settings object, the provider list cleaned and changed', s1 !== s0 && s1.usageProv.kimi.on === true && s1.theme === 'dark' && UC.valid(s1.usageProv) && !('usageProv' in s0));
  t('set: unknown provider / field / non-boolean value -> unchanged', [['gemini', 'on', true], ['grok', 'web', true], ['kimi', 'local', true], ['claude', 'on', 'yes'], ['__proto__', 'on', true]].every(([k, f, v]) => UC.set(s1, k, f, v) === s1)); }

// ---- panes.json (state-schema.js): optional, older files as before, repaired when broken ----
{ const base = { windows: [{ layout: '2x2', panes: [{ url: '' }] }], favorites: [], workspaces: {} };
  const old = S.migrate({ ...base, settings: { theme: 'dark', usageBase: { day: 'd', used: 1 } } });
  t('state-schema: a file from before (no usage fields) reads unchanged, no repair', old.ok && !old.fixes.length && J(old.doc.settings) === J({ theme: 'dark', usageBase: { day: 'd', used: 1 } }));
  const m = UC.migrate(old.doc.settings, { existing: true }).settings, doc = { ...old.doc, settings: m };
  const back = S.parse(S.serialize(doc));
  t('state-schema: the migrated settings validate and round-trip unchanged', !S.validate(doc).length && back.ok && !back.fixes.length && J(back.doc.settings) === J(m));
  const broken = S.migrate({ ...base, settings: { usageShow: 'yes', usageV2: 1, usageProv: { claude: { on: true, local: 'x' } }, theme: 'dark' } });
  t('state-schema: a bad flag dropped, a broken provider list cleaned (repairs, never recoveryRequired)', broken.ok && !('usageShow' in broken.doc.settings) && !('usageV2' in broken.doc.settings)
    && UC.valid(broken.doc.settings.usageProv) && broken.doc.settings.usageProv.claude.local === false && broken.doc.settings.theme === 'dark' && broken.fixes.length === 3);
  t('state-schema: validate() refuses a bad flag / provider list before a write', S.validate({ ...doc, settings: { ...m, usageShow: 'on' } }).some(e => /usageShow/.test(e)) && S.validate({ ...doc, settings: { ...m, usageProv: { claude: {} } } }).some(e => /usageProv/.test(e)));
  t('state-schema: a dropped usageV2 makes main decide again (existing file -> on)', UC.migrate(broken.doc.settings, { existing: true }).changed); }

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
