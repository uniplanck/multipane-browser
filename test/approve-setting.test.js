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
assert.strictEqual(AS.label('  ', 'Tibo'), '');
assert.strictEqual(AS.label(undefined, 'Tibo'), 'Tibo');
assert(AS.validUrl('') && AS.validUrl('   ') && AS.validUrl(bot));
for (const input of [null, 'invalid', 'https://evil.com/bot/a', '\n', bot + '\n', 'x'.repeat(AS.URL_MAX + 1)]) assert(!AS.validUrl(input));
assert.strictEqual(AS.paneLabel(`  ${'😀'.repeat(21)}\n  `), '😀'.repeat(20));

// The picker uses the same names and image sources as the bar, merges favorites
// and panes by normalized bot ID, and never includes non-Bot links or unsafe images.
{
  const items = AS.knownBots([
    { url: `${bot}/?from=bar`, name: '別名', icon: 'data:image/png;base64,AAAA' },
    { url: other, name: 'グループ', group: true, icon: 'https://cdn.example/a.png' },
    { url: 'https://grok.com/group/not-a-bot', name: '無関係', group: true },
  ], [{ url: `${bot}#duplicate`, label: '重複' }, { url: 'https://grok.com/bot/fav', label: 'お気に入り' }], [
    { url: bot, name: 'ペイン名', favicon: 'https://cdn.example/pane.png' },
    { url: 'https://grok.com/bot/pane', name: '😀'.repeat(21), favicon: 'http://example.com/x' },
    { url: 'https://grok.com/bot/evil/sub', name: '除外' },
  ]);
  assert.deepStrictEqual(items.map(x => x.id), ['abc-XYZ_123', 'other', 'fav', 'pane']);
  assert.deepStrictEqual(items[0], { id: 'abc-XYZ_123', url: bot, name: '別名', icon: 'https://cdn.example/pane.png' });
  assert.strictEqual(items[1].icon, 'https://cdn.example/a.png');
  assert.strictEqual(items[2].name, 'お気に入り');
  assert.strictEqual(items[3].name, '😀'.repeat(20)); assert.strictEqual(items[3].icon, '');
  for (const value of ['http://example.com/a', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'https://u:p@example.com/a', 'https://example.com/a\n'])
    assert.strictEqual(AS.httpsImage(value), '');
}

let effective = AS.effective({ approveUrl: `${bot}/?q=a`, approveLabel: '  名前  ' }, other, def, 'Tibo');
assert.deepStrictEqual(effective, { url: bot, label: '名前', source: 'setting' });
assert.deepStrictEqual(AS.effective({ approveUrl: 'invalid', approveLabel: '' }, `${other}#hash`, def, 'Tibo'), { url: other, label: '', source: 'environment' });
assert.deepStrictEqual(AS.effective({ approveUrl: '', approveLabel: '' }, other, def, 'Tibo'), { url: '', label: '', source: 'setting' });
assert.deepStrictEqual(AS.effective({ approveUrl: '', approveLabel: '名前' }, other, def, 'Tibo'), { url: '', label: '名前', source: 'setting' });
assert.deepStrictEqual(AS.effective({ approveLabel: '' }, other, def, 'Tibo'), { url: other, label: '', source: 'environment' });
assert.deepStrictEqual(AS.effective({ approveUrl: bot }, other, def, 'Tibo'), { url: bot, label: 'Tibo', source: 'setting' });
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
for (const bad of [null, 10, false]) {
  migrated = SC.migrate({ settings: { approveUrl: bad, approveLabel: bad } });
  assert(migrated.ok); assert(!Object.hasOwn(migrated.doc.settings, 'approveUrl')); assert(!Object.hasOwn(migrated.doc.settings, 'approveLabel'));
}
migrated = SC.migrate({ settings: { approveUrl: '', approveLabel: '' } });
assert(migrated.ok); assert.deepStrictEqual(migrated.doc.settings, { approveUrl: '', approveLabel: '' });
assert.deepStrictEqual(SC.validate(migrated.doc), []);
assert.deepStrictEqual(SC.parse(SC.serialize(migrated.doc)).doc.settings, { approveUrl: '', approveLabel: '' });
migrated = SC.migrate({ settings: { approveUrl: '   ', approveLabel: '  ' } });
assert.deepStrictEqual(migrated.doc.settings, { approveUrl: '', approveLabel: '' });
assert(SC.validate({ ...SC.emptyDoc(), settings: { approveUrl: 'invalid' } }).length === 1);
assert(SC.validate({ ...SC.emptyDoc(), settings: { approveUrl: `${bot}/`, approveLabel: 'x'.repeat(21) } }).length === 2);
assert(!Object.hasOwn(DG.safeEnv({ settings: { approveUrl: bot, approveLabel: 'Private name' } }).settings, 'approveUrl'));
assert(!Object.hasOwn(DG.safeEnv({ settings: { approveUrl: bot, approveLabel: 'Private name' } }).settings, 'approveLabel'));

const sender = role => ({ role, frame: { top: true, detached: false, url: role === 'overlay' ? pathToFileURL(path.join(root, 'src/overlay.html')).href : role === 'chrome' ? pathToFileURL(path.join(root, 'src/index.html')).href : bot, origin: role === 'overlay' || role === 'chrome' ? 'file://' : 'https://grok.com' } });
const check = (role, action) => IPC.check('overlay-run', sender(role), [action], { owned: true });
assert.strictEqual(check('overlay', { type: 'approve-save', url: bot, label: 'A' }), null);
assert.strictEqual(check('overlay', { type: 'approve-save', url: '', label: '' }), null);
assert.strictEqual(check('overlay', { type: 'approve-save', url: '   ', label: '' }), null);
assert.strictEqual(check('overlay', { type: 'approve-save', url: '\n', label: '' }), 'E_PAYLOAD');
assert.strictEqual(check('overlay', { type: 'approve-save', url: 'https://evil.com/bot/a', label: 'A' }), 'E_PAYLOAD');
assert.strictEqual(check('overlay', { type: 'approve-save', url: bot, label: 'x'.repeat(21) }), 'E_PAYLOAD');
assert.strictEqual(check('overlay', { type: 'approve-save', url: bot, label: 'A', extra: true }), 'E_PAYLOAD');
assert.strictEqual(check('overlay', { type: 'approve-reset' }), null);
assert.strictEqual(check('overlay', { type: 'approve-reset', url: bot }), 'E_PAYLOAD');
assert.strictEqual(check('overlay', { type: 'approve-pick', id: 'abc-XYZ_123' }), null);
for (const id of ['', '../a', 'a?b', 'a#b', 'https://grok.com/bot/a', '__proto__', 'x'.repeat(AS.URL_MAX), null])
  assert.strictEqual(check('overlay', { type: 'approve-pick', id }), 'E_PAYLOAD');
assert.strictEqual(check('overlay', { type: 'approve-pick', id: 'abc', url: bot }), 'E_PAYLOAD');
for (const role of ['chrome', 'pane', 'approve']) assert.strictEqual(check(role, { type: 'approve-pick', id: 'abc' }), 'E_ROLE');
for (const role of ['chrome', 'pane', 'approve']) assert.strictEqual(check(role, { type: 'approve-save', url: bot, label: 'A' }), 'E_ROLE');
const anchor = { x: 950, y: 10, width: 30, height: 28 };
for (const channel of ['approve-open', 'approve-inline-open', 'approve-inline-anchor']) {
  assert.strictEqual(IPC.check(channel, sender('chrome'), [anchor], { owned: true }), null);
  for (const role of ['overlay', 'pane', 'approve']) assert.strictEqual(IPC.check(channel, sender(role), [anchor], { owned: true }), 'E_ROLE');
  for (const rect of [{ ...anchor, x: NaN }, { ...anchor, height: -1 }, { ...anchor, extra: true }, {}, 'x'])
    assert.strictEqual(IPC.check(channel, sender('chrome'), [rect], { owned: true }), 'E_PAYLOAD');
  assert.strictEqual(IPC.check(channel, sender('chrome'), [anchor, anchor], { owned: true }), 'E_PAYLOAD');
}
assert.strictEqual(IPC.check('approve-inline-open', sender('chrome'), [], { owned: true }), 'E_PAYLOAD');

assert.deepStrictEqual(AS.inlinePosition(anchor, { width: 340, height: 220 }, { width: 1000, height: 700 }), { x: 640, y: 44 });
assert.deepStrictEqual(AS.inlinePosition({ x: -50, y: -100, width: 10, height: 10 }, { width: 340, height: 220 }, { width: 500, height: 400 }), { x: 8, y: 8 });
assert.deepStrictEqual(AS.inlinePosition({ x: 990, y: 390, width: 30, height: 30 }, { width: 340, height: 220 }, { width: 1000, height: 500 }), { x: 652, y: 272 });

const segment = (text, from, to) => { const a = text.indexOf(from), b = text.indexOf(to, a + from.length); assert(a >= 0 && b > a, from); return text.slice(a, b); };
const openCode = segment(main, 'function openApprove(rect) {', 'function openApproveSettings() {');
const changeCode = segment(main, 'function approveChanged() {', 'function hideApprove() {');
const destroyCode = segment(main, 'function destroyApprove() {', 'function openApprove(rect) {');
{
  const events = [], settings = {}, ctx = { AS, settings, DEFAULT_APPROVE_LABEL: 'Tibo', save: () => events.push('save'),
    ctxs: [{ approveChanged: () => events.push('window1') }, { approveChanged: () => events.push('window2') }], broadcast: () => events.push('broadcast') };
  const code = segment(main, 'function setApproveSettings(value) {', '// ---- links opened from page content');
  vm.runInNewContext(`${code}\nsetApproveSettings({url:'${bot}/?q=x',label:'  名前  '});`, ctx);
  assert.deepStrictEqual(settings, { approveUrl: bot, approveLabel: '名前' });
  assert.deepStrictEqual(events, ['save', 'window1', 'window2', 'broadcast']);
  assert.strictEqual(vm.runInNewContext("setApproveSettings({url:'https://evil.com/bot/x',label:'A'})", ctx), false);
  assert.strictEqual(events.length, 4);
  vm.runInNewContext("setApproveSettings({url:'  ',label:'  '})", ctx);
  assert.deepStrictEqual(settings, { approveUrl: '', approveLabel: '' });
  assert.deepStrictEqual(events.slice(4), ['save', 'window1', 'window2', 'broadcast']);
  vm.runInNewContext('setApproveSettings(null)', ctx);
  assert.deepStrictEqual(settings, {});
}
{
  const events = [], ctx = { anchor, dlog() {}, approveOpen: false, approveEffective: () => ({ url: '' }), openApproveInline: r => events.push(r),
    closeOverlay: () => events.push('close'), ensureApprove: () => events.push('LOAD'), clearTimeout() {}, approveTimer: null };
  vm.runInNewContext(`${openCode}\nopenApprove(anchor);`, ctx);
  assert.deepStrictEqual(events, [anchor]);
  vm.runInNewContext('openApprove()', ctx);
  assert.strictEqual(events[1], undefined);
}
{
  const events = [], ctx = { anchor, AS, GB: { view: () => ({ pins: [], sections: [] }) }, grok: {}, favorites: [], ctxs: [], paneUrl() {}, displayTitle() {},
    approveOpen: true, approveEffective: () => ({ url: bot, label: '名前', source: 'setting' }),
    hideApprove: () => events.push('hide'), openOverlay: (mode, extra) => events.push({ mode, extra }),
    win: { webContents: { send: channel => events.push(channel) } } };
  const code = segment(main, 'let approveAnchorPending = false;', 'function approveChanged() {');
  vm.runInNewContext(`${code}\nopenApproveInline();`, ctx);
  assert.strictEqual(events[0], 'approve-anchor-request');
  vm.runInNewContext('openApproveInline(anchor)', ctx);
  assert.strictEqual(events[1], 'hide');
  assert.strictEqual(events[2].mode, 'approve-inline');
  assert.strictEqual(events[2].extra.anchor, anchor);
  assert.deepStrictEqual(events[2].extra.approve, { url: bot, label: '名前', source: 'setting' });
  assert.deepStrictEqual(Array.from(events[2].extra.bots), []);
}
{
  const GB = require('../src/grok-bots');
  const grok = { bots: [{ id: 'abc-XYZ_123', url: bot, name: '元の名前', isGroup: false, section: '', order: 0, icon: 'https://img.example/a.png' }],
    aliases: { 'abc-XYZ_123': 'バーの別名' }, pins: ['abc-XYZ_123'], at: 0 };
  const makePane = (url, name, favicon = '') => ({ url, name, favicon, view: { webContents: { isDestroyed: () => false } } });
  const ctx = { AS, GB, grok, favorites: [{ url: 'https://grok.com/bot/favorite', label: 'お気に入り' }],
    ctxs: [{ panes: [makePane(bot, '重複')] }, { panes: [makePane(other, '別ウィンドウ', 'https://img.example/other.png')] }],
    paneUrl: p => p.url, displayTitle: p => p.name };
  vm.runInNewContext(segment(main, 'function knownApproveBots() {', 'function openApproveInline(rect) {'), ctx);
  const bots = ctx.knownApproveBots();
  assert.deepStrictEqual(Array.from(bots, b => b.id), ['abc-XYZ_123', 'favorite', 'other']);
  assert.strictEqual(bots[0].name, 'バーの別名'); assert.strictEqual(bots[2].name, '別ウィンドウ');
  assert.strictEqual(bots[2].icon, 'https://img.example/other.png');
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
    closeOverlay: () => events.push('close-overlay'), openApproveInline: () => events.push('inline'), approveRect: () => ({ x: 1 }),
    overlay: { webContents: { send: () => events.push('rect') } }, win: { contentView: { removeChildView: () => events.push('remove'), addChildView: () => events.push('add') } } };
  vm.runInNewContext(`${changeCode}\napproveChanged();`, ctx);
  return events;
}
assert.deepStrictEqual(exerciseChange(false, bot), ['destroy']);
assert.deepStrictEqual(exerciseChange(true, other), ['visible:false', 'destroy', `load:${other}`, 'rect', 'remove', 'add', 'bounds', 'visible:true', 'focus']);
assert.deepStrictEqual(exerciseChange(true, ''), ['visible:false', 'destroy', 'close-overlay', 'inline']);

// The main-process action gate applies saves and resets only while an editor is open.
{
  const cases = segment(main, "    case 'approve-save':", "    case 'ws-overwrite':");
  for (const [overlayOpen, overlayMode, allowed] of [[true, 'approve-inline', true], [true, 'approve-settings', true], [true, 'palette', false], [false, 'approve-inline', false]]) {
    const events = [], ctx = { AS, overlayOpen, overlayMode, knownApproveBots: () => [], overlay: { webContents: { send() {} } },
      setApproveSettings: v => { events.push(v); return true; }, closeOverlay: () => events.push('close') };
    vm.runInNewContext(`function act(a) { switch (a.type) { ${cases} } }`, ctx);
    ctx.act({ type: 'approve-save', url: '', label: '' });
    assert.strictEqual(events.length, allowed ? 2 : 0);
    if (allowed) { assert.strictEqual(events[0].url, ''); assert.strictEqual(events[0].label, ''); }
    events.length = 0; ctx.act({ type: 'approve-reset' });
    assert.deepStrictEqual(events, allowed ? [null, 'close'] : []);
  }
}

// Main recomputes the known list when a pick arrives, checks the mode and URL,
// persists its own name and only then acknowledges; the editor stays open.
{
  const cases = segment(main, "    case 'approve-pick':", "    case 'approve-reset':");
  const events = [], known = [{ id: 'abc-XYZ_123', url: bot, name: '正しい名前' }];
  const ctx = { AS, overlayOpen: true, overlayMode: 'approve-inline', knownApproveBots: () => known,
    setApproveSettings: v => { events.push(['save', v]); return true; }, overlay: { webContents: { send: (...v) => events.push(v) } } };
  vm.runInNewContext(`function pick(a) { switch (a.type) { ${cases} } }`, ctx);
  ctx.pick({ type: 'approve-pick', id: 'abc-XYZ_123' });
  assert.strictEqual(events.length, 2); assert.strictEqual(events[0][1].url, bot); assert.strictEqual(events[0][1].label, '正しい名前');
  assert.strictEqual(events[1][0], 'approve-picked');
  events.length = 0;
  for (const id of ['unknown', '../abc-XYZ_123', 'abc-XYZ_123/x']) ctx.pick({ type: 'approve-pick', id });
  assert.strictEqual(events.length, 0);
  ctx.overlayMode = 'approve-settings'; ctx.pick({ type: 'approve-pick', id: 'abc-XYZ_123' });
  ctx.overlayMode = 'approve-inline'; ctx.overlayOpen = false; ctx.pick({ type: 'approve-pick', id: 'abc-XYZ_123' });
  assert.strictEqual(events.length, 0);
  ctx.overlayOpen = true; known.length = 0; ctx.pick({ type: 'approve-pick', id: 'abc-XYZ_123' });
  assert.strictEqual(events.length, 0, 'a removed Bot is not picked from a stale overlay');
}

// the defaults are one line each so the public export can blank them (local/sanitize-public.py)
const DEF_URL_RE = /const DEFAULT_APPROVE_URL = '(?:https:\/\/grok\.com\/bot\/[A-Za-z0-9_-]+)?';/, DEF_LABEL_RE = /const DEFAULT_APPROVE_LABEL = '[^'\n]*';/;
assert(DEF_URL_RE.test(main) && DEF_LABEL_RE.test(main));
{
  const definitions = segment(main, "const DEFAULT_APPROVE_URL = '", 'function setApproveSettings(value) {')
    .replace(DEF_URL_RE, "const DEFAULT_APPROVE_URL = ''; ")
    .replace(DEF_LABEL_RE, "const DEFAULT_APPROVE_LABEL = ''; ");
  const result = vm.runInNewContext(`${definitions}\napproveEffective()`, { require: () => AS, settings: {}, process: { env: {} } });
  assert.strictEqual(result.url, ''); assert.strictEqual(result.source, 'unset'); assert.strictEqual(result.label, '');
  const events = [], blankCtx = { anchor, dlog() {}, approveOpen: false, approveEffective: () => result,
    openApproveInline: r => events.push(['inline', r]), ensureApprove: () => events.push(['unexpected load']) };
  vm.runInNewContext(`${openCode}\nopenApprove(anchor);`, blankCtx);
  assert.strictEqual(events.length, 1); assert.strictEqual(events[0][0], 'inline'); assert.strictEqual(events[0][1], anchor);
  const owner = vm.runInNewContext(`${segment(main, "const DEFAULT_APPROVE_URL = '", 'function setApproveSettings(value) {')}\napproveEffective()`, { require: () => AS, settings: {}, process: { env: {} } });
  // whatever this build ships (owner build: a Bot and its name; public build: blank)
  const shipUrl = main.match(DEF_URL_RE)[0].split("'")[1], shipLabel = main.match(DEF_LABEL_RE)[0].split("'")[1];
  assert.strictEqual(owner.url, shipUrl); assert.strictEqual(owner.label, shipLabel); assert.strictEqual(owner.source, shipUrl ? 'default' : 'unset');
}
assert(!main.includes('APPROVE_URL.match(GROK_BOT_RE)[1]'));
assert(main.includes("guardNavigation(wc, 'approve')") && main.includes('ctxs.forEach(c => c.approveChanged())') && main.includes('broadcast();'));
assert(main.includes("wcReg.get(wc.id)?.role === 'approve' && !AS.grokPage(url)") && main.includes("kind === 'approve' && !AS.grokPage(url)") && main.includes("'approve redirect'"));
assert(main.includes("label: '右上ボタンのBotを設定…'") && main.includes("label: 'このBotを右上ボタンにする'"));
assert.strictEqual((main.match(/approvePaneItem\(p\),/g) || []).length, 2);
assert(main.includes("case 'approve-open': closeOverlay(); openApprove();") && main.includes("on('approve-open', rect => openApprove(rect))"));
assert(overlay.includes("S.approve.label || '右上ボタンのBot'") && overlay.includes('右上ボタンのBotを設定（未設定）'));
assert(renderer.includes("setTip($('#approve-btn'), name") && read('src/index.html').includes('id="approve-label" hidden'));
assert(read('src/style.css').includes('#approve-btn.icon-only'));

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
  ctx.S.approve = { configured: true, label: '' };
  assert(ctx.build().some(x => x.label === '右上ボタンのBotを開く' && x.act.type === 'approve-open'));
  ctx.S.approve = { configured: false, label: '' };
  assert(ctx.build().some(x => x.label.includes('未設定') && x.act.type === 'approve-open'));
}

// The chrome uses its actual button rectangle for click, right-click and anchor requests.
{
  const calls = [], label = {}, classes = {}, button = { getBoundingClientRect: () => anchor, classList: { toggle: (k, v) => { classes[k] = v; } } };
  const ctx = { $: sel => sel === '#approve-btn' ? button : label, setTip: (_, name, desc) => calls.push({ name, desc }),
    mpb: { approveOpen: r => calls.push({ action: 'open', rect: r }), approveInline: r => calls.push({ action: 'inline', rect: r }),
      approveInlineAnchor: r => calls.push({ action: 'anchor', rect: r }), onApproveAnchorRequest: cb => { ctx.request = cb; } } };
  vm.runInNewContext(segment(renderer, 'function approveButtonRect() {', 'let approveSavedTimer;'), ctx);
  button.onclick(); assert.strictEqual(calls[0].action, 'open'); assert.strictEqual(JSON.stringify(calls[0].rect), JSON.stringify(anchor));
  let prevented = false; button.oncontextmenu({ preventDefault: () => { prevented = true; } });
  assert(prevented && calls[1].action === 'inline'); assert.strictEqual(JSON.stringify(calls[1].rect), JSON.stringify(anchor));
  ctx.request(); assert.strictEqual(calls[2].action, 'anchor');
  ctx.renderApproveButton({ configured: true, label: '' });
  assert.strictEqual(label.textContent, ''); assert.strictEqual(label.hidden, true); assert.strictEqual(classes['icon-only'], true);
  assert.deepStrictEqual(calls[3], { name: '右上ボタンのBot', desc: '設定したBotを別の画面で開きます。' });
  ctx.renderApproveButton({ configured: false, label: '' });
  assert(calls[4].desc.includes('右クリックまたはクリック') && label.hidden);
  ctx.renderApproveButton({ configured: true, label: 'Tibo' });
  assert.strictEqual(label.textContent, 'Tibo'); assert.strictEqual(label.hidden, false); assert.strictEqual(classes['icon-only'], false);
}

// The actual overlay handlers render escaped effective values, validate both editors and accept blank fields.
{
  const handlers = {}, focus = [], timers = [], fields = { '#approve-url': { value: '', focus: () => focus.push('url') }, '#approve-name': { value: '' }, '#approve-error': { textContent: '' } };
  const rows = ['abc-XYZ_123', 'other'].map(id => ({ dataset: { approvePick: id }, selected: false, attrs: {}, check: { textContent: '' },
    classList: { toggle(k, value) { this.owner.selected = value; }, owner: null }, setAttribute(k, v) { this.attrs[k] = v; }, querySelector() { return this.check; } }));
  rows.forEach(row => { row.classList.owner = row; });
  const panel = { innerHTML: '', querySelector: sel => fields[sel] || { focus() {} }, querySelectorAll: () => rows,
    addEventListener: (type, fn) => { handlers[type] = fn; } };
  const box = { style: {}, getBoundingClientRect: () => ({ width: 340, height: 220 }) };
  const calls = [], ctx = { $: sel => sel === '#box' ? box : panel, ApproveSetting: AS, mode: 'approve-settings', ctx: { anchor }, innerWidth: 1000, innerHeight: 700,
    mpb: { run: a => calls.push(a), closeOverlay: () => calls.push('close'), onApprovePicked: cb => { ctx.picked = cb; } },
    esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), setTimeout: f => timers.push(f) };
  const code = segment(overlay, "const updatePanel = $('#update-panel');", 'function renderUpdate(o) {');
  vm.runInNewContext(code, ctx);
  ctx.renderApproveSettings({ mode: 'approve-settings', approve: { url: bot, label: '<Bot>', source: 'setting' } });
  assert(panel.innerHTML.includes('&lt;Bot&gt;') && panel.innerHTML.includes('設定'));
  timers.pop()(); assert.deepStrictEqual(focus, ['url']);
  for (const [source, ja] of [['setting', '設定'], ['environment', '環境変数'], ['default', '既定'], ['unset', '未設定']])
    assert.strictEqual(vm.runInNewContext(`approveSource('${source}')`, ctx), ja);
  fields['#approve-url'].value = 'https://evil.com/bot/a'; fields['#approve-name'].value = 'Bot'; handlers.submit({ preventDefault() {} });
  assert(fields['#approve-error'].textContent.includes('URL') && !calls.length);
  fields['#approve-url'].value = bot; fields['#approve-name'].value = 'x'.repeat(21); handlers.submit({ preventDefault() {} });
  assert(fields['#approve-error'].textContent.includes('20文字') && !calls.length);
  fields['#approve-url'].value = ''; fields['#approve-name'].value = ''; handlers.submit({ preventDefault() {} });
  assert.strictEqual(calls[0].type, 'approve-save'); assert.strictEqual(calls[0].url, ''); assert.strictEqual(calls[0].label, '');
  fields['#approve-url'].value = bot;
  fields['#approve-name'].value = 'Bot'; handlers.submit({ preventDefault() {} });
  assert.strictEqual(calls[1].type, 'approve-save'); assert.strictEqual(calls[1].url, bot);
  ctx.mode = 'approve-inline'; ctx.ctx.bots = [{ id: 'abc-XYZ_123', url: bot, name: 'Tibo', icon: 'https://cdn.example/a.png' },
    { id: 'other', url: other, name: '<Bot>', icon: '' }];
  ctx.renderApproveSettings({ mode: 'approve-inline', bots: ctx.ctx.bots, approve: { url: bot, label: 'Tibo', source: 'default' } });
  assert(panel.innerHTML.includes(`value="${bot}"`) && panel.innerHTML.includes('value="Tibo"'));
  assert(panel.innerHTML.includes('Botのリンク') && panel.innerHTML.includes('キャンセル'));
  assert(panel.innerHTML.includes('Botを選択（すぐに反映）') && panel.innerHTML.includes('data-approve-pick="other"'));
  assert(panel.innerHTML.includes('&lt;Bot&gt;') && panel.innerHTML.includes('https://cdn.example/a.png') && panel.innerHTML.includes('aria-pressed="true"'));
  assert.strictEqual(box.style.left, '640px'); assert.strictEqual(box.style.top, '44px');
  timers.pop()(); assert.deepStrictEqual(focus, ['url', 'url']);
  calls.length = 0; fields['#approve-url'].value = 'https://invalid.example'; handlers.submit({ preventDefault() {} });
  assert(fields['#approve-error'].textContent.includes('URL') && !calls.length);
  fields['#approve-url'].value = ''; fields['#approve-name'].value = ''; handlers.submit({ preventDefault() {} });
  assert.strictEqual(calls[0].url, ''); assert.strictEqual(calls[0].label, '');
  handlers.click({ target: { closest: sel => sel === '[data-approve-pick]' ? rows[1] : null } });
  assert.strictEqual(calls[1].type, 'approve-pick'); assert.strictEqual(calls[1].id, 'other');
  assert.strictEqual(fields['#approve-url'].value, '', 'do not claim a pick before main accepts it');
  ctx.picked(ctx.ctx.bots[1]);
  assert.strictEqual(fields['#approve-url'].value, other); assert.strictEqual(fields['#approve-name'].value, '<Bot>');
  assert.strictEqual(rows[0].selected, false); assert.strictEqual(rows[1].selected, true); assert.strictEqual(rows[1].attrs['aria-pressed'], 'true');
  ctx.picked({ id: 'not-known', url: 'https://grok.com/bot/not-known', name: 'bad' });
  assert.strictEqual(fields['#approve-url'].value, other);
  fields['#approve-name'].value = ''; handlers.submit({ preventDefault() {} });
  assert.strictEqual(calls[2].url, other); assert.strictEqual(calls[2].label, '');
  handlers.click({ target: { closest: sel => sel === '[data-approve-action]' ? { dataset: { approveAction: 'reset' } } : null } });
  handlers.click({ target: { closest: sel => sel === '[data-approve-action]' ? { dataset: { approveAction: 'cancel' } } : null } });
  assert.strictEqual(calls[3].type, 'approve-reset'); assert.strictEqual(calls[4], 'close');
}

// Outside click and Escape close without submitting, while a new anchor only repositions the editor.
{
  const events = {}, scrim = {}, calls = [], ctx = { mode: 'approve-inline', ctx: { anchor }, $: () => scrim,
    addEventListener: (type, fn) => { events[type] = fn; }, positionApproveInline: () => calls.push('position'),
    mpb: { closeOverlay: () => calls.push('close'), onApproveRect() {}, onApproveInlineAnchor: fn => { ctx.newAnchor = fn; } } };
  vm.runInNewContext(segment(overlay, "$('#scrim').onclick", 'mpb.onState('), ctx);
  scrim.onclick(); let prevented = false; events.keydown({ key: 'Escape', preventDefault: () => { prevented = true; } });
  assert.deepStrictEqual(calls, ['close', 'close']); assert(prevented);
  const next = { x: 300, y: 10, width: 28, height: 28 }; ctx.newAnchor(next);
  assert.strictEqual(ctx.ctx.anchor, next); assert.strictEqual(calls[2], 'position');
}
console.log('ok  approve settings validation, persistence, IPC, menu, UI and popup lifecycle');
