// node test/sidebar-settings.test.js — 進捗サイドバー settings in panes.json (src/state-schema.js + sidebar-rules.js): optional keys, no new schema.
// A file without them (any older version) loads unchanged as closed / 300 px / no URL; usable values load as they are; unusable ones are
// repaired (never fatal); validate() refuses what the app itself would never write.
const S = require('../src/state-schema');
const SR = require('../src/sidebar-rules');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const file = settings => ({ schema: 1, windows: [{ layout: '2x2', panes: [{ url: 'https://grok.com/' }] }], favorites: [], settings, workspaces: {} });
const load = settings => S.migrate(file(settings));

{ const r = load({ theme: 'dark' });
  t('an older file (no sidebar keys): ready, nothing repaired, no key added', r.ok && r.fixes.length === 0 && J(r.doc.settings) === J({ theme: 'dark' }));
  t('...and it reads as closed, 300 px, no URL (the button dimmed)', J(SR.view(r.doc.settings)) === J({ url: '', configured: false, open: false, width: 300 })); }
{ const r = S.parse(J({ layout: '2x2', urls: ['https://grok.com/'] }));
  t('the oldest single-window format still loads, no sidebar', r.ok && !SR.view(r.doc.settings).open); }
{ const st = { sidebarOpen: true, sidebarWidth: 420, sidebarUrl: 'https://example.com/#/p/sidebar' }, r = load(st);
  t('usable values load as they are', r.ok && r.fixes.length === 0 && J(r.doc.settings) === J(st));
  t('...open with that width and URL', J(SR.view(r.doc.settings)) === J({ url: 'https://example.com/#/p/sidebar', configured: true, open: true, width: 420 }));
  t('...and are written back unchanged (serialize -> parse)', J(S.parse(S.serialize(r.doc)).doc.settings) === J(st)); }
t('a loopback dev URL and the empty URL load as they are', load({ sidebarUrl: 'http://localhost:5173/' }).fixes.length === 0 && load({ sidebarUrl: '' }).fixes.length === 0);
{ const r = load({ sidebarOpen: 'yes', theme: 'light' });
  t('a non-boolean sidebarOpen: dropped (closed), the rest kept', r.ok && !('sidebarOpen' in r.doc.settings) && r.doc.settings.theme === 'light' && r.fixes.some(f => /sidebarOpen/.test(f))); }
t('a width out of range / not a number: clamped / the default', load({ sidebarWidth: 9000 }).doc.settings.sidebarWidth === 560 && load({ sidebarWidth: 10 }).doc.settings.sidebarWidth === 220
  && load({ sidebarWidth: '300' }).doc.settings.sidebarWidth === 300 && load({ sidebarWidth: 333.4 }).doc.settings.sidebarWidth === 333 && load({ sidebarWidth: 9000 }).fixes.some(f => /sidebarWidth/.test(f)));
{ const bads = ['javascript:alert(1)', 'http://example.com/', 'file:///etc/hosts', 'https://u:p@example.com/', 5, null, {}, ['https://example.com/']];
  t('an unusable URL: dropped (no sidebar), never fatal', bads.every(u => { const r = load({ sidebarUrl: u, sidebarOpen: true }); return r.ok && !('sidebarUrl' in r.doc.settings) && !SR.view(r.doc.settings).open; })); }
{ const r = load({ sidebarUrl: '  https://example.com  ' });
  t('a URL that is usable but not normalised: normalised', r.ok && r.doc.settings.sidebarUrl === 'https://example.com/' && r.fixes.some(f => /sidebarUrl: repaired/.test(f))); }
{ const doc = load({}).doc, v = s => S.validate({ ...doc, settings: s });
  t('validate: what the app writes passes', v({ sidebarOpen: false, sidebarWidth: 300, sidebarUrl: 'https://example.com/' }).length === 0 && v({ sidebarUrl: '' }).length === 0 && v({}).length === 0);
  t('validate: anything else is refused (no write of a broken setting)', v({ sidebarOpen: 1 }).length === 1 && v({ sidebarWidth: 600 }).length === 1 && v({ sidebarWidth: '300' }).length === 1
    && v({ sidebarUrl: 'http://example.com/' }).length === 1 && v({ sidebarUrl: 'https://example.com' }).length === 1 && v({ sidebarUrl: 7 }).length === 1); }
t('messages name the key only, never the URL', load({ sidebarUrl: 'https://u:p@secret.example/token' }).fixes.every(f => !/secret|token/.test(f)));
t('the sidebar is not part of a window / workspace / pane spec (one shared setting)', (() => { const r = load({ sidebarOpen: true, sidebarUrl: 'https://example.com/' });
  return r.ok && r.doc.windows.every(w => !Object.keys(w).some(k => /sidebar/i.test(k))) && J(r.doc.workspaces) === '{}'; })());

// ---- the settings screen (overlay.js, the real handlers on a tiny fake panel) ----
{ const fs = require('fs'), path = require('path'), vm = require('vm');
  const ov = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay.js'), 'utf8');
  const a = ov.indexOf("const updatePanel = $('#update-panel');"), b = ov.indexOf('function renderUpdate(o) {', a);
  const handlers = {}, timers = [], focus = [], calls = [];
  const fields = { '#sidebar-url': { value: '', focus: () => focus.push('url') }, '#approve-error': { textContent: '' } };
  const panel = { innerHTML: '', querySelector: sel => fields[sel] || null, querySelectorAll: () => [], addEventListener: (type, fn) => { handlers[type] = fn; } };
  const ctx = { $: () => panel, ApproveSetting: require('../src/approve-setting'), SidebarRules: SR, mode: 'sidebar-settings', ctx: {}, setTimeout: f => timers.push(f),
    mpb: { run: x => calls.push(x), closeOverlay: () => calls.push('close'), onApprovePicked() {} },
    esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) };
  vm.runInNewContext(ov.slice(a, b), ctx);
  ctx.renderSidebarSettings({ mode: 'sidebar-settings', sidebar: { url: 'https://example.com/?a="x"' } });
  t('screen: title, the rules, the page contract, the URL (escaped), placeholder only', panel.innerHTML.includes('進捗サイドバー') && panel.innerHTML.includes('https://')
    && panel.innerHTML.includes('window.xgBotsSidebar.focusBot') && panel.innerHTML.includes('value="https://example.com/?a=&quot;x&quot;"') && panel.innerHTML.includes('placeholder="https://example.com/#/p/sidebar"'));
  timers.pop()(); t('screen: the URL field gets the focus', focus.join() === 'url');
  const submit = v => { fields['#sidebar-url'].value = v; fields['#approve-error'].textContent = ''; handlers.submit({ preventDefault() {} }); };
  submit('http://example.com/');
  t('screen: an unusable URL -> a message, nothing sent', fields['#approve-error'].textContent.includes('https://') && calls.length === 0);
  submit('  https://example.com/#/p/sidebar  ');
  t('screen: a usable URL -> sidebar-save (trimmed)', JSON.stringify(calls[0]) === JSON.stringify({ type: 'sidebar-save', url: 'https://example.com/#/p/sidebar' }));
  submit('');
  t('screen: empty -> sidebar-save with no URL (turns it off)', JSON.stringify(calls[1]) === JSON.stringify({ type: 'sidebar-save', url: '' }));
  handlers.click({ target: { closest: s => s === '[data-sidebar-action="clear"]' ? {} : null } });
  t('screen: 「URLを消す」 -> sidebar-save with no URL', JSON.stringify(calls[2]) === JSON.stringify({ type: 'sidebar-save', url: '' }));
  handlers.click({ target: { closest: s => s === '[data-approve-action]' ? { dataset: { approveAction: 'cancel' } } : null } });
  t('screen: キャンセル closes', calls[3] === 'close');
  ctx.mode = 'approve-settings';
  handlers.click({ target: { closest: s => s === '[data-sidebar-action="clear"]' ? {} : null } });
  t('the 右上ボタンのBot screen never sends a sidebar save', calls.length === 4); }

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
