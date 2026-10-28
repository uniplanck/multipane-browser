// Settings validation, IPC, and the actual popup lifecycle without touching an Electron profile.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { pathToFileURL } = require('url');
const AS = require('../src/approve-setting'), SC = require('../src/state-schema'), IPC = require('../src/ipc-policy'), DG = require('../src/diagnostics');
const root = path.join(__dirname, '..'), read = f => fs.readFileSync(path.join(root, f), 'utf8');
const main = read('src/main.js'), overlay = read('src/overlay.js'), renderer = read('src/renderer.js');
const bot = 'https://grok.com/bot/abc-XYZ_123', other = 'https://grok.com/bot/other';
const def = 'https://grok.com/bot/default';

for (const [input, expected] of [[bot, bot], [` ${bot}/?from=x#top `, bot], [`${bot}#x`, bot], [`${bot}?x/y`, bot]]) assert.strictEqual(AS.normalizeUrl(input), expected);
for (const input of ['', null, 10, 'http://grok.com/bot/a', 'https://grok.com.evil.com/bot/a', 'https://evil.com/bot/a', 'https://user@grok.com/bot/a',
  'https://grok.com:443/bot/a', 'https://GROK.com/bot/a', 'https://grok.com/bot/', 'https://grok.com/bot/a/b', 'https://grok.com/bot/a%2Fb',
  `${bot}?bad space`, `${bot}\n`, `${bot}#\u0085`, 'javascript:alert(1)']) assert.strictEqual(AS.normalizeUrl(input), '', String(input));
assert(AS.grokPage(bot) && AS.grokPage('https://grok.com/') && AS.grokPage('https://grok.com/a?q=x'));
for (const input of ['about:blank', 'http://grok.com/', 'https://grok.com.evil.com/', 'https://sub.grok.com/', 'https://grok.com:444/', 'https://user@grok.com/', 'https://x.com/']) assert(!AS.grokPage(input));
assert(AS.validLabel('  Bot  ') && AS.validLabel('') && AS.validLabel('猫'.repeat(20)) && AS.validLabel('😀'.repeat(20)));
assert(!AS.validLabel('猫'.repeat(21)) && !AS.validLabel('A\nB') && !AS.validLabel('\u0085') && !AS.validLabel(4));
assert.strictEqual(AS.label('  名前  ', 'Tibo'), '名前');
assert.strictEqual(AS.label('  ', 'Tibo'), 'Tibo');
assert.strictEqual(AS.paneLabel(`  ${'😀'.repeat(21)}\n  `), '😀'.repeat(20));

let effective = AS.effective({ approveUrl: `${bot}/?q=a`, approveLabel: '  名前  ' }, other, def, 'Tibo');
assert.deepStrictEqual(effective, { url: bot, label: '名前', source: 'setting' });
assert.deepStrictEqual(AS.effective({ approveUrl: 'invalid', approveLabel: '' }, `${other}#hash`, def, 'Tibo'), { url: other, label: 'Tibo', source: 'environment' });
assert.deepStrictEqual(AS.effective({}, 'invalid', def, 'Tibo'), { url: def, label: 'Tibo', source: 'default' });
assert.deepStrictEqual(AS.effective({}, 'invalid', '', 'Helper'), { url: '', label: 'Helper', source: 'unset' });
assert.strictEqual(AS.effective({}, other, '', 'Helper').url, other);
assert.strictEqual(AS.effective({ approveUrl: bot }, other, '', 'Helper').url, bot);

let migrated = SC.migrate({ settings: { approveUrl: `${bot}/?q=x`, approveLabel: '  名前  ' } });
assert(migrated.ok); assert.strictEqual(migrated.doc.settings.approveUrl, bot); assert.strictEqual(migrated.doc.settings.approveLabel, '名前');
assert.deepStrictEqual(SC.validate(migrated.doc), []);
assert.deepStrictEqual(SC.parse(SC.serialize(migrated.doc)).doc.settings, migrated.doc.settings);
migrated = SC.migrate({ settings: { approveUrl: 'https://evil.com/bot/a', approveLabel: 'bad\nlabel' } });
assert(migrated.ok); assert(!Object.hasOwn(migrated.doc.settings, 'approveUrl')); assert(!Object.hasOwn(migrated.doc.settings, 'approveLabel'));
assert(SC.validate({ ...SC.emptyDoc(), settings: { approveUrl: `${bot}/`, approveLabel: 'x'.repeat(21) } }).length === 2);
assert(!Object.hasOwn(DG.safeEnv({ settings: { approveUrl: bot, approveLabel: 'Private name' } }).settings, 'approveUrl'));
assert(!Object.hasOwn(DG.safeEnv({ settings: { approveUrl: bot, approveLabel: 'Private name' } }).settings, 'approveLabel'));

const sender = role => ({ role, frame: { top: true, detached: false, url: role === 'overlay' ? pathToFileURL(path.join(root, 'src/overlay.html')).href : role === 'chrome' ? pathToFileURL(path.join(root, 'src/index.html')).href : bot, origin: role === 'overlay' || role === 'chrome' ? 'file://' : 'https://grok.com' } });
const check = (role, action) => IPC.check('overlay-run', sender(role), [action], { owned: true });
assert.strictEqual(check('overlay', { type: 'approve-save', url: bot, label: 'A' }), null);
assert.strictEqual(check('overlay', { type: 'approve-save', url: 'https://evil.com/bot/a', label: 'A' }), 'E_PAYLOAD');
assert.strictEqual(check('overlay', { type: 'approve-save', url: bot, label: 'x'.repeat(21) }), 'E_PAYLOAD');
assert.strictEqual(check('overlay', { type: 'approve-save', url: bot, label: 'A', extra: true }), 'E_PAYLOAD');
assert.strictEqual(check('overlay', { type: 'approve-reset' }), null);
assert.strictEqual(check('overlay', { type: 'approve-reset', url: bot }), 'E_PAYLOAD');
for (const role of ['chrome', 'pane', 'approve']) assert.strictEqual(check(role, { type: 'approve-save', url: bot, label: 'A' }), 'E_ROLE');

const segment = (text, from, to) => { const a = text.indexOf(from), b = text.indexOf(to, a + from.length); assert(a >= 0 && b > a, from); return text.slice(a, b); };
const openCode = segment(main, 'function openApprove() {', 'function openApproveSettings() {');
const changeCode = segment(main, 'function approveChanged() {', 'function hideApprove() {');
const destroyCode = segment(main, 'function destroyApprove() {', 'function openApprove() {');
{
  const events = [], settings = {}, ctx = { AS, settings, DEFAULT_APPROVE_LABEL: 'Tibo', save: () => events.push('save'),
    ctxs: [{ approveChanged: () => events.push('window1') }, { approveChanged: () => events.push('window2') }], broadcast: () => events.push('broadcast') };
  const code = segment(main, 'function setApproveSettings(value) {', '// ---- links opened from page content');
  vm.runInNewContext(`${code}\nsetApproveSettings({url:'${bot}/?q=x',label:'  名前  '});`, ctx);
  assert.deepStrictEqual(settings, { approveUrl: bot, approveLabel: '名前' });
  assert.deepStrictEqual(events, ['save', 'window1', 'window2', 'broadcast']);
  assert.strictEqual(vm.runInNewContext("setApproveSettings({url:'https://evil.com/bot/x',label:'A'})", ctx), false);
  assert.strictEqual(events.length, 4);
  vm.runInNewContext('setApproveSettings(null)', ctx);
  assert.deepStrictEqual(settings, {});
}
{
  const events = [], ctx = { dlog() {}, approveOpen: false, approveEffective: () => ({ url: '' }), openApproveSettings: () => events.push('settings'),
    closeOverlay: () => events.push('close'), ensureApprove: () => events.push('LOAD'), clearTimeout() {}, approveTimer: null };
  vm.runInNewContext(`${openCode}\nopenApprove();`, ctx);
  assert.deepStrictEqual(events, ['settings']);
}
{
  const events = [], old = { webContents: { isDestroyed: () => false, close: () => events.push('close-old') } };
  const ctx = { approve: old, approveOpen: false, approvePane: { grokToken: 1, grokPending: 2 }, approveTimer: 1,
    clearTimeout: () => events.push('timer'), win: { contentView: { removeChildView: () => events.push('remove-old') } }, unregWc: () => events.push('unregister') };
  vm.runInNewContext(`${destroyCode}\ndestroyApprove();`, ctx);
  assert.deepStrictEqual(events, ['timer', 'remove-old', 'unregister', 'close-old']); assert.strictEqual(ctx.approve, null); assert.strictEqual(ctx.approvePane, null);
}
function exerciseChange(wasOpen, url) {
  const events = [], view = { setVisible: v => events.push(`visible:${v}`), setBounds: () => events.push('bounds'), webContents: { focus: () => events.push('focus') } };
  const ctx = { approveOpen: wasOpen, approve: view, approveEffective: () => ({ url }),
    destroyApprove: () => { events.push('destroy'); ctx.approve = null; }, ensureApprove: u => { events.push(`load:${u}`); return (ctx.approve = view); },
    closeOverlay: () => events.push('close-overlay'), openApproveSettings: () => events.push('settings'), approveRect: () => ({ x: 1 }),
    overlay: { webContents: { send: () => events.push('rect') } }, win: { contentView: { removeChildView: () => events.push('remove'), addChildView: () => events.push('add') } } };
  vm.runInNewContext(`${changeCode}\napproveChanged();`, ctx);
  return events;
}
assert.deepStrictEqual(exerciseChange(false, bot), ['destroy']);
assert.deepStrictEqual(exerciseChange(true, other), ['visible:false', 'destroy', `load:${other}`, 'rect', 'remove', 'add', 'bounds', 'visible:true', 'focus']);
assert.deepStrictEqual(exerciseChange(true, ''), ['visible:false', 'destroy', 'close-overlay', 'settings']);

// the defaults are one line each so the public export can blank them (local/sanitize-public.py)
const DEF_URL_RE = /const DEFAULT_APPROVE_URL = '(?:https:\/\/grok\.com\/bot\/[A-Za-z0-9_-]+)?';/, DEF_LABEL_RE = /const DEFAULT_APPROVE_LABEL = '[^'\n]*';/;
assert(DEF_URL_RE.test(main) && DEF_LABEL_RE.test(main));
{
  const definitions = segment(main, "const DEFAULT_APPROVE_URL = '", 'function setApproveSettings(value) {')
    .replace(DEF_URL_RE, "const DEFAULT_APPROVE_URL = ''; ")
    .replace(DEF_LABEL_RE, "const DEFAULT_APPROVE_LABEL = 'Helper';");
  const result = vm.runInNewContext(`${definitions}\napproveEffective()`, { require: () => AS, settings: {}, process: { env: {} } });
  assert.strictEqual(result.url, ''); assert.strictEqual(result.source, 'unset'); assert.strictEqual(result.label, 'Helper');
}
assert(!main.includes('APPROVE_URL.match(GROK_BOT_RE)[1]'));
assert(main.includes("guardNavigation(wc, 'approve')") && main.includes('ctxs.forEach(c => c.approveChanged())') && main.includes('broadcast();'));
assert(main.includes("wcReg.get(wc.id)?.role === 'approve' && !AS.grokPage(url)") && main.includes("kind === 'approve' && !AS.grokPage(url)") && main.includes("'approve redirect'"));
assert(main.includes("label: '右上ボタンのBotを設定…'") && main.includes("label: 'このBotを右上ボタンにする'"));
assert.strictEqual((main.match(/approvePaneItem\(p\),/g) || []).length, 2);
assert(main.includes("case 'approve-open': closeOverlay(); openApprove();") && main.includes("on('approve-open', () => openApprove())"));
assert(overlay.includes('${S.approve.label}を開く') && overlay.includes('右上ボタンのBotを設定（未設定）'));
assert(renderer.includes("setTip($('#approve-btn'), name") && read('src/index.html').includes('id="approve-label"'));

// Exercise the actual navigation handlers, including a server redirect and a main-initiated load.
{
  const handlers = {}, blocked = [], external = [], NAV = require('../src/navigation-policy');
  const wc = { id: 1, on: (event, handler) => { handlers[event] = handler; }, getURL: () => bot, loadURL: url => { external.push(`load:${url}`); return Promise.resolve(); } };
  const ctx = { AS, NAV, wc, trackGesture() {}, navBlocked: (...a) => blocked.push(a[0]), openExt: url => external.push(url), recentGesture: () => true,
    wcReg: new Map([[1, { role: 'approve' }]]) };
  const guard = segment(main, 'function guardNavigation(wc,', 'function guardUi(wc)');
  const load = segment(main, 'function appLoad(wc,', 'function linkOpen(wc,');
  vm.runInNewContext(`${guard}\n${load}\nguardNavigation(wc, 'approve');`, ctx);
  const event = () => ({ isMainFrame: true, prevented: false, preventDefault() { this.prevented = true; } });
  let e = event(); handlers['will-navigate'](e, 'https://grok.com/chat'); assert(!e.prevented);
  e = event(); handlers['will-navigate'](e, 'https://x.com/login'); assert(e.prevented);
  e = event(); handlers['will-navigate'](e, 'https://example.com/'); assert(e.prevented && external.includes('https://example.com/'));
  e = event(); handlers['will-redirect'](e, 'https://evil.com/', false, true); assert(e.prevented);
  e = event(); handlers['will-redirect'](e, 'https://grok.com/chat', false, true); assert(!e.prevented);
  ctx.appLoad(wc, 'https://evil.com/'); assert(!external.includes('load:https://evil.com/'));
  ctx.appLoad(wc, bot); assert(external.includes(`load:${bot}`));
}

// Build the real palette twice to check a live rename and the unset action.
{
  const build = segment(overlay, 'function build() {', '// 対応キュー: after an update');
  const ctx = { q: { value: '' }, S: { approve: { configured: true, label: '新しいBot' }, panes: [], favorites: [], workspaces: [] },
    mode: 'palette', ctx: {}, fuzzy: () => 1, looksUrl: () => false, LAYOUTS: [], MOD: '⌘' };
  vm.runInNewContext(build, ctx);
  assert(ctx.build().some(x => x.label === '新しいBotを開く' && x.act.type === 'approve-open'));
  ctx.S.approve = { configured: false, label: 'Helper' };
  assert(ctx.build().some(x => x.label.includes('未設定') && x.act.type === 'approve-open'));
}

// The real overlay handler renders escaped values and refuses invalid input before IPC.
{
  const handlers = {}, fields = { '#approve-url': { value: '' }, '#approve-name': { value: '' }, '#approve-error': { textContent: '' } };
  const panel = { innerHTML: '', querySelector: sel => fields[sel] || { focus() {} }, addEventListener: (type, fn) => { handlers[type] = fn; } };
  const calls = [], ctx = { $: () => panel, ApproveSetting: AS, mpb: { run: a => calls.push(a), closeOverlay: () => calls.push('close') },
    esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), setTimeout() {} };
  const code = segment(overlay, "const updatePanel = $('#update-panel');", 'function renderUpdate(o) {');
  vm.runInNewContext(`${code}\nrenderApproveSettings({approve:{url:'${bot}',label:'<Bot>',source:'setting'}});`, ctx);
  assert(panel.innerHTML.includes('&lt;Bot&gt;') && panel.innerHTML.includes('設定'));
  fields['#approve-url'].value = 'https://evil.com/bot/a'; fields['#approve-name'].value = 'Bot'; handlers.submit({ preventDefault() {} });
  assert(fields['#approve-error'].textContent.includes('URL') && !calls.length);
  fields['#approve-url'].value = bot; fields['#approve-name'].value = 'x'.repeat(21); handlers.submit({ preventDefault() {} });
  assert(fields['#approve-error'].textContent.includes('20文字') && !calls.length);
  fields['#approve-name'].value = 'Bot'; handlers.submit({ preventDefault() {} });
  assert.strictEqual(calls[0].type, 'approve-save'); assert.strictEqual(calls[0].url, bot);
}
console.log('ok  approve settings validation, persistence, IPC, menu, UI and popup lifecycle');
