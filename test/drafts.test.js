// node test/drafts.test.js — pure policy + real atomic IO in /tmp + sandboxed preload with a mock DOM. No Electron / real user data.
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const { DRAFT: D } = require('../src/pane-rules');
const { createDraftStore } = require('../src/draft-store');
const S = require('../src/state-schema'), IPC = require('../src/ipc-policy');
const now = 1800000000000, url = 'https://grok.com/bot/abc', pane = 'pane-one';
const entry = { pane, url, text: '未送信の本文\n2行目', at: now };
const base = { enabled: true, gen: 2, currentGen: 2, url, currentUrl: url, text: entry.text };
assert.equal(D.url(url + '/?b=2&a=1#x'), url + '?a=1&b=2');
assert.notEqual(D.key(pane, url + '?c=one'), D.key(pane, url + '?c=two'));
assert.notEqual(D.key(pane, url), D.key('pane-two', url));
assert.notEqual(D.key(pane, url), D.key(pane, 'https://grok.com/c/abc'));
for (const u of ['https://grok.com.evil/bot/abc', 'http://grok.com/bot/abc', 'https://u@grok.com/bot/abc', 'https://grok.com:8443/bot/abc', 'about:blank', 'https://grok.com/settings', 'https://grok.com/bot/abc/other']) assert.equal(D.key(pane, u), '');
assert.equal(D.action(base), 'save');
assert.equal(D.action({ ...base, text: ' \n' }), 'delete');
assert.equal(D.action({ ...base, sent: true }), 'delete');
for (const patch of [{ enabled: false }, { gen: 1 }, { currentUrl: 'https://grok.com/c/other' }, { known: false }]) assert.equal(D.action({ ...base, ...patch }), 'ignore');
assert(!D.expired(now - D.AGE, now)); assert(D.expired(now - D.AGE - 1, now)); assert(D.expired(now + 1, now));
const restore = { ...base, entry, now, rev: 0, currentRev: 0, touched: false, empty: true, ime: false };
assert(D.restore(restore));
for (const patch of [{ enabled: false }, { gen: 1 }, { rev: 1 }, { touched: true }, { empty: false }, { ime: true }, { now: now + D.AGE + 1 }, { currentUrl: 'https://grok.com/bot/other' }]) assert(!D.restore({ ...restore, ...patch }));
assert.equal(D.clean([{ ...entry, text: 'あ'.repeat(D.MAX + 1) }, { ...entry, pane: 'expired', at: now - D.AGE - 1 }], now)[0].text.length, D.MAX);
assert.equal(D.clean(Array.from({ length: 110 }, (_, i) => ({ ...entry, pane: 'p' + i, at: now - i })), now).length, D.LIMIT);
console.log('ok  pure keys, URL isolation, save/delete/restore decisions, limits and expiry');

const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const handlers = main.slice(main.indexOf("paneOn('pane:draft-save'"), main.indexOf("paneOn('pane:editing'"));
function mainDrafts(store) {
  const fns = {}, sent = [], p = { draftId: pane, obs: { gen: 2 }, view: { webContents: { getURL: () => url, send: (...a) => sent.push(a) } } };
  let enabled = true, page = true;
  vm.runInNewContext(handlers, { paneOn: (ch, fn) => { fns[ch] = fn; }, hasPage: () => page, DRAFT: D, draftsEnabled: () => enabled, draftStore: store });
  return { p, sent, load: d => fns['pane:draft-load'](p, d), save: d => fns['pane:draft-save'](p, d), off: () => { enabled = false; }, gone: () => { page = false; } };
}
// Test the generated preload itself in a sandbox, with simulated native setters / React input, timers and IPC. No browser is launched.
function preload(initial = '', { editable = false, mirror = false } = {}) {
  let clock = now, tid = 0, present = true, attachment = false, clicks = 0, commands = 0, inputEvents = 0;
  const listeners = {}, ipc = {}, timers = new Map(), sent = [];
  const win = { addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); } };
  const fire = (type, extra = {}) => { for (const fn of listeners[type] || []) fn({ type, target: el, isTrusted: true, ...extra }); };
  const doc = { readyState: 'complete', documentElement: null, activeElement: null,
    querySelector: () => null, querySelectorAll: s => present && /textarea/.test(s) ? (mirror ? [ghost, el] : [el]) : [],
    getSelection: () => ({ selectAllChildren: () => {} }),
    execCommand: (cmd, _ui, text) => { assert.equal(cmd, 'insertText'); commands++; el.innerText = text; el.textContent = text; fire('input', { isTrusted: false }); return true; } };
  class TextArea { get value() { return this._value; } set value(v) { this._value = v; } }
  const el = Object.assign(new TextArea(), { _value: initial, tagName: editable ? 'DIV' : 'TEXTAREA', isContentEditable: editable,
    innerText: initial, textContent: initial, tabIndex: 0, offsetParent: {}, isConnected: true,
    getAttribute: () => null, closest: s => s === 'form' ? { querySelector: () => attachment ? {} : null } : null,
    contains: x => x === el, focus: () => { doc.activeElement = el; }, click: () => { clicks++; },
    dispatchEvent: e => { assert.equal(e.type, 'input'); inputEvents++; fire('input', { isTrusted: false }); } });
  const ghost = { ...el, tagName: 'TEXTAREA', value: 'x', tabIndex: -1 };
  const location = new URL(url), date = class extends Date { static now() { return clock; } };
  const context = vm.createContext({ window: win, document: doc, location, URL, Date: date, HTMLTextAreaElement: TextArea,
    Event: class { constructor(type, opts) { this.type = type; Object.assign(this, opts); } },
    MutationObserver: class { observe() {} },
    setTimeout: (fn, ms) => { const id = ++tid; timers.set(id, { fn, at: clock + ms }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: () => 0, clearInterval: () => {},
    require: name => { assert.equal(name, 'electron'); return { ipcRenderer: { send: (...a) => sent.push(a), on: (ch, fn) => { ipc[ch] = fn; } }, webFrame: {} }; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/pane-preload.js'), 'utf8'), context);
  const emit = (name, body) => ipc[name](null, body);
  const tick = ms => { const end = clock + ms; for (;;) { const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; timers.delete(next[0]); clock = next[1].at; next[1].fn(); } clock = end; };
  const input = text => { el.value = text; el.innerText = text; el.textContent = text; fire('input'); };
  const poll = () => vm.runInContext('persistDraftText()', context);
  return { emit, tick, input, poll, fire, sent, el, context, location, doc, stats: () => ({ clicks, commands, inputEvents }),
    present: on => { present = on; }, attachment: on => { attachment = on; } };
}
function start(p) { p.emit('mpb:gen', 2); p.emit('mpb:draft-config', true); p.tick(750); }
const saves = p => p.sent.filter(([ch]) => ch === 'pane:draft-save');
const loads = p => p.sent.filter(([ch]) => ch === 'pane:draft-load');
const reply = { gen: 2, url, rev: 0, at: now, text: entry.text };
{
  const p = preload('', { mirror: true }); start(p);
  assert.equal(loads(p).length, 1); assert.equal(saves(p).length, 0);
  p.emit('mpb:draft-restore', reply);
  assert.equal(p.el.value, entry.text); assert.equal(p.stats().inputEvents, 1);
  assert.deepEqual(p.stats(), { clicks: 0, commands: 0, inputEvents: 1 });
  p.poll(); assert.equal(saves(p).length, 0); // restoring does not extend the seven-day timestamp
  p.input('変更'); p.tick(500); assert.equal(saves(p).length, 0);
  p.input('変更後'); p.tick(749); assert.equal(saves(p).length, 0);
  p.tick(1); assert.equal(saves(p).at(-1)[1].text, '変更後');
  p.input(''); p.tick(750); assert.equal(saves(p).at(-1)[1].text, '');
}
for (const alter of [p => p.input('先に入力'), p => { p.input('入力'); p.input(''); }, p => { p.location.pathname = '/bot/other'; }, p => p.emit('mpb:gen', 3), p => p.attachment(true), p => p.emit('mpb:draft-config', false), p => p.fire('compositionstart')]) {
  const p = preload(); start(p); alter(p); const before = p.el.value; p.emit('mpb:draft-restore', reply); assert.equal(p.el.value, before);
}
{
  const p = preload('サイトの内容'); start(p); p.emit('mpb:draft-restore', reply); assert.equal(p.el.value, 'サイトの内容');
  const e = preload('', { editable: true }); start(e); e.emit('mpb:draft-restore', reply);
  assert.equal(e.el.innerText, entry.text); assert.deepEqual(e.stats(), { clicks: 0, commands: 1, inputEvents: 0 });
  const late = preload(); late.present(false); start(late); assert.equal(loads(late).length, 0);
  late.present(true); late.poll(); assert.equal(loads(late).length, 1); late.emit('mpb:draft-restore', reply); assert.equal(late.el.value, entry.text);
  const composing = preload(); start(composing); composing.fire('compositionstart'); composing.input('変換中'); composing.tick(750); assert.equal(saves(composing).length, 0);
  composing.fire('compositionend'); composing.tick(750); assert.equal(saves(composing).at(-1)[1].text, '変換中');
}
{
  const p = preload('送信する文章'); start(p); p.fire('keydown', { key: 'Enter' });
  p.emit('mpb:draft-sent', { gen: 2, url }); p.poll(); const n = saves(p).length; p.poll(); assert.equal(saves(p).length, n);
  p.input('次の下書き'); p.tick(750); assert.equal(saves(p).at(-1)[1].text, '次の下書き');
  const q = preload('送信する文章'); start(q); q.fire('keydown', { key: 'Enter' }); q.input('既に入力した次の下書き');
  q.emit('mpb:draft-sent', { gen: 2, url }); q.tick(750); assert.equal(saves(q).at(-1)[1].text, '既に入力した次の下書き');
  const same = preload('同じ文章'); start(same); same.fire('keydown', { key: 'Enter' }); same.input(''); same.input('同じ文章');
  same.emit('mpb:draft-sent', { gen: 2, url }); same.tick(750); assert.equal(saves(same).at(-1)[1].text, '同じ文章');
}
console.log('ok  generated preload: debounce, React textarea/contenteditable, restore races, IME, delayed composer and no send');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-drafts-'));
  try {
    const file = path.join(tmp, 'drafts.json'), errors = [];
    let clock = now;
    const options = { file, now: () => clock, onError: c => errors.push(c) };
    const st = createDraftStore(options); st.load(); st.put(pane, url, entry.text); await st.flush();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const disk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(disk().items[0].text, entry.text);
    const restarted = createDraftStore(options); restarted.load(); assert.equal(restarted.get(pane, url).text, entry.text);
    assert.equal(restarted.get('another-pane', url), null); assert.equal(restarted.get(pane, 'https://grok.com/bot/other'), null);
    const h = mainDrafts(restarted); h.load({ gen: 2, url, rev: 0 }); assert.equal(h.sent[0][1].text, entry.text);
    h.save({ gen: 1, url, rev: 1, text: '古いページ' }); assert.equal(restarted.get(pane, url).text, entry.text);
    h.save({ gen: 2, url: 'https://grok.com/bot/other', rev: 1, text: '別のページ' }); assert.equal(restarted.get(pane, url).text, entry.text);
    h.off(); h.save({ gen: 2, url, rev: 2, text: '偽のON', enabled: true }); assert.equal(restarted.get(pane, url).text, entry.text);
    const current = mainDrafts(restarted); current.save({ gen: 2, url, rev: 2, text: '' }); await restarted.flush(); assert.equal(restarted.get(pane, url), null);
    restarted.put(pane, url, '一つ目'); restarted.put(pane, 'https://grok.com/c/second', '二つ目'); restarted.put('other', url, '他ペイン');
    restarted.remove(pane); await restarted.flush(); assert.equal(disk().items.length, 1); assert.equal(disk().items[0].pane, 'other');
    clock += D.AGE + 1; restarted.prune(); await restarted.flush(); assert.deepEqual(disk().items, []);
    clock = now; restarted.put(pane, url, entry.text); await restarted.flush(); const before = fs.readFileSync(file, 'utf8');
    const failing = createDraftStore({ ...options, fs: { ...fs, promises: { ...fs.promises, rename: async () => { throw new Error('fixture failure'); } } } });
    failing.load(); failing.put(pane, url, '失敗する更新'); assert.equal(await failing.flush(), false);
    assert.equal(fs.readFileSync(file, 'utf8'), before); assert(errors.every(c => ['DRAFT_READ', 'DRAFT_WRITE'].includes(c)));
    assert(!fs.readdirSync(tmp).some(n => n.includes('.tmp-')));
    // Delay an actual write while newer changes and OFF arrive: the old snapshot must never win.
    let release, entered;
    const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
    let first = true;
    const slow = createDraftStore({ ...options, fs: { ...fs, promises: { ...fs.promises, open: async (...a) => {
      const fh = await fs.promises.open(...a);
      return { writeFile: (...args) => fh.writeFile(...args), close: () => fh.close(), sync: async () => { if (first) { first = false; entered(); await gate; } await fh.sync(); } };
    } } } });
    slow.load(); slow.put(pane, url, '古い更新'); await started;
    slow.put(pane, url, '新しい更新'); slow.setEnabled(false); slow.put(pane, url, 'OFF中'); release(); await slow.flush(); assert.deepEqual(disk().items, []);
    const stale = file + '.tmp-99999-1'; fs.writeFileSync(stale, 'fixture'); fs.utimesSync(stale, new Date(now - 120000), new Date(now - 120000));
    const again = createDraftStore(options); again.load(); assert(!fs.existsSync(stale));
    fs.writeFileSync(stale, 'fixture'); fs.utimesSync(stale, new Date(now - D.AGE - 1), new Date(now - D.AGE - 1));
    again.prune(); assert(!fs.existsSync(stale));
    fs.writeFileSync(file, JSON.stringify({ v: 1, items: [entry, { ...entry, pane: 'expired', at: now - D.AGE - 1 }] }));
    const pruned = createDraftStore(options); pruned.load(); await pruned.flush(); assert.equal(disk().items.length, 1);
    // Stable identity survives the state schema / reordering, while a workspace cannot inherit it.
    const doc = S.emptyDoc(); doc.windows[0].panes = [{ url, draftId: pane }, { url, draftId: 'pane-two' }]; doc.windows[0].panes.reverse();
    doc.workspaces = { sample: { panes: [{ url, draftId: pane }] } };
    const loaded = S.parse(S.serialize(doc)); assert(loaded.ok); assert.equal(loaded.doc.windows[0].panes[1].draftId, pane); assert(!loaded.doc.workspaces.sample.panes[0].draftId);
    // Only a registered Grok top frame can send bounded draft data; hidden probes / other sites cannot read drafts.
    const sender = { role: 'pane', frame: { top: true, detached: false, origin: 'https://grok.com', url } }, world = { owned: true };
    const payload = { gen: 2, url, rev: 1, text: entry.text };
    assert.equal(IPC.check('pane:draft-save', sender, [payload], world), null);
    assert.equal(IPC.check('pane:draft-load', { ...sender, role: 'probe' }, [payload], world), 'E_ROLE');
    assert.equal(IPC.check('pane:draft-save', { ...sender, frame: { ...sender.frame, origin: 'https://example.com' } }, [payload], world), 'E_PAGE');
    assert.equal(IPC.check('pane:draft-save', sender, [{ ...payload, text: 'x'.repeat(D.MAX + 1) }], world), 'E_PAYLOAD');
    assert.equal(IPC.check('pane:draft-load', { ...sender, frame: { ...sender.frame, top: false } }, [payload], world), 'E_FRAME');
    assert(main.includes('draftStore?.remove(p.draftId);'));
    console.log('ok  atomic 0600 disk IO, restart, main IPC routing, delete/close, expiry, failure preservation, OFF during write, stable identity and IPC boundary');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log('all passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
