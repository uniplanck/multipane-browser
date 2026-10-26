// node test/copy-policy.test.js — 選択部分だけコピー. The pure parts (src/copy-policy.js): the key taken (⌘C only, a selection outside any field,
// never during / with an unknown IME composition, never another modifier or key, a kana / other layout's C key), the clipboard check after the
// page's copy (the whole message / nothing / much shorter -> the selection as plain text; the same text with other whitespace / small
// differences -> the page's copy stands; the copy that never reached the clipboard); the preload's selection report (on change only, fields
// excluded) and the IPC gate; the wiring in main.js.
// Not covered here: a real ⌘C / right click in Electron, the real clipboard, grok.com's own copy handlers, the first click into another pane
// - that needs the manual check.
const fs = require('fs'), path = require('path'), vm = require('vm');
const CB = require('../src/copy-policy');
const IPC = require('../src/ipc-policy');
const PN = require('../src/pane-navigation');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const SRC = path.join(__dirname, '..', 'src'), read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const K = (o = {}) => ({ type: 'keyDown', key: 'c', code: 'KeyC', meta: true, control: false, alt: false, shift: false, isComposing: false, isAutoRepeat: false, ...o });
const S = { sel: true };

// ---- the key ----
t('⌘C with a selection: taken', CB.copyKey(K(), S) === true);
t('⌘C held down (a repeat): taken too (each press copies, as the browser does)', CB.copyKey(K({ isAutoRepeat: true }), S) === true);
t('⌘C without a selection (none / inside a field): left to the page', CB.copyKey(K(), { sel: false }) === false && CB.copyKey(K(), {}) === false && CB.copyKey(K(), { sel: 'yes' }) === false);
t('only ⌘: ⌘⇧C / ⌘⌥C / ⌘⌃C / Ctrl+C on the Mac / plain C are not taken', [{ shift: true }, { alt: true }, { control: true }, { meta: false, control: true }, { meta: false }].every(o => CB.copyKey(K(o), S) === false));
t('another key (⌘V ⌘A ⌘X ⌘J) / keyUp / bad input: not taken', ['v', 'a', 'x', 'j'].every(k => CB.copyKey(K({ key: k, code: 'Key' + k.toUpperCase() }), S) === false)
  && CB.copyKey(K({ type: 'keyUp' }), S) === false && CB.copyKey(null, S) === false && CB.copyKey('c', S) === false && CB.copyKey(K(), null) === false);
t('upper case C (caps lock) / a kana or other layout\'s C key: taken; a Latin letter on the C key (another layout): not', CB.copyKey(K({ key: 'C' }), S) === true
  && CB.copyKey(K({ key: 'そ' }), S) === true && CB.copyKey(K({ key: 'с' }), S) === true && CB.copyKey(K({ key: 'j', code: 'KeyC' }), S) === false);
t('an IME composition (reported by the page / the key / Process / 229) or not known whether one runs: not taken', CB.copyKey(K(), { sel: true, ime: true }) === false
  && CB.copyKey(K({ isComposing: true }), S) === false && CB.copyKey(K({ key: 'Process' }), S) === false && CB.copyKey(K({ keyCode: 229 }), S) === false
  && CB.copyKey(K({ isComposing: undefined }), S) === false);
t('elsewhere (not the Mac): Ctrl+C only', CB.copyKey(K({ meta: false, control: true }), { sel: true, mac: false }) === true && CB.copyKey(K(), { sel: true, mac: false }) === false
  && CB.copyKey(K({ meta: true, control: true }), { sel: true, mac: false }) === false);
t('⌘C is a standard menu key, never one of the app\'s own (pane-navigation TAKEN)', PN.TAKEN.includes('CmdOrCtrl+C') && !PN.KEYS.some(k => PN.norm(k.accel) === 'Cmd+C')
  && PN.match(K(), { mac: true }).id === '');

// ---- the clipboard after the page's copy ----
const MSG = '了解しました。以下の手順で進めます。\n\n1. 設定を開く\n2. 保存する\n\n🟢 待機中';
const PART = '設定を開く';
t('the page copied the whole message for a part: the selection is written', CB.fix({ sel: PART, clip: MSG, changed: true }) === PART);
t('the page copied exactly the selection: it stands', CB.fix({ sel: PART, clip: PART, changed: true }) === null);
t('the same text with other whitespace (newlines / NBSP / zero-width / trailing): it stands', CB.fix({ sel: 'a b\nc', clip: ' a\u00a0b\n\nc\u200b \n', changed: true }) === null
  && CB.fix({ sel: '1. 設定を開く\n2. 保存する', clip: '1. 設定を開く\n\n2. 保存する\n', changed: true }) === null);
t('small differences (a few extra characters, image alt text, bullets): it stands', CB.fix({ sel: PART, clip: '• ' + PART + ' 🙂', changed: true }) === null
  && CB.fix({ sel: 'x'.repeat(100), clip: 'x'.repeat(125), changed: true }) === null);
t('clearly longer (> 1.2 × + 10): the selection', CB.fix({ sel: 'x'.repeat(100), clip: 'x'.repeat(131), changed: true }) === 'x'.repeat(100)
  && CB.fix({ sel: 'ab', clip: 'ab' + 'y'.repeat(11), changed: true }) === 'ab' && CB.fix({ sel: 'ab', clip: 'ab' + 'y'.repeat(10), changed: true }) === null);
t('clearly shorter (less than half) / empty: the selection', CB.fix({ sel: 'x'.repeat(10), clip: 'x'.repeat(4), changed: true }) === 'x'.repeat(10)
  && CB.fix({ sel: PART, clip: '', changed: true }) === PART && CB.fix({ sel: 'x'.repeat(10), clip: 'x'.repeat(5), changed: true }) === null);
t('the copy never reached the clipboard (unchanged): the selection, unless it already holds the same text', CB.fix({ sel: PART, clip: 'older text', changed: false }) === PART
  && CB.fix({ sel: PART, clip: PART + '\n', changed: false }) === null && CB.fix({ sel: PART, clip: MSG }) === PART);
t('the whole message copied before and again now (unchanged clipboard): the selection', CB.fix({ sel: PART, clip: MSG, changed: false }) === PART);
t('nothing selected / only whitespace / not text: nothing written (the page\'s copy stands)', [undefined, null, '', ' \n\t', 42, {}].every(s => CB.fix({ sel: s, clip: MSG, changed: true }) === null)
  && CB.fix() === null && CB.fix({ sel: '  ', clip: '', changed: false }) === null);
t('the selection is written as read (its own newlines kept, not the compared form)', CB.fix({ sel: 'a\n\nb', clip: MSG, changed: true }) === 'a\n\nb');
t('norm / differs: whitespace runs as one space; no selection never differs', CB.norm(' a \n\u00a0b\u200b\u2060c ') === 'a b c' && CB.norm(null) === '' && CB.differs('anything', '') === false && CB.differs('', 'a') === true);
t('constants: own world (not 1001-1004), waits bounded, the read is fixed code', CB.WORLD === 1005 && CB.READ_MS > 0 && CB.READ_MS <= 1000 && CB.WAIT_MS <= 1000 && CB.STEP_MS > 0 && CB.STEP_MS < CB.WAIT_MS
  && /getSelection\(\)/.test(CB.SEL_JS) && !/\$\{|eval|Function/.test(CB.SEL_JS));
{ const g = { document: { getSelection: () => ({ toString: () => 'sel text' }) } }, none = { document: { getSelection: () => null } };
  t('the selection read (run as the page would): its text / "" without one', vm.runInNewContext(CB.SEL_JS, g) === 'sel text' && vm.runInNewContext(CB.SEL_JS, none) === ''); }

// ---- the preload reports a selection outside any field (on change only) ----
{ const listeners = {}, sent = [];
  const doc = { documentElement: null, querySelector: () => null, querySelectorAll: () => [], activeElement: null, sel: null, getSelection() { return this.sel; } };
  const ctx = vm.createContext({
    require: m => { if (m !== 'electron') throw new Error(m); return { ipcRenderer: { send: (ch, v) => sent.push([ch, v]), on: () => {} }, webFrame: { insertCSS() {}, removeInsertedCSS() {}, setZoomFactor() {} } }; },
    window: { addEventListener: (ev, f) => { (listeners[ev] = listeners[ev] || []).push(f); } }, document: doc,
    location: { hostname: 'grok.com', pathname: '/bot/b1' }, MutationObserver: class { observe() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  });
  vm.runInContext(read('pane-preload.js'), ctx);
  const fire = () => (listeners.selectionchange || []).forEach(f => f({})), last = () => sent.filter(s => s[0] === 'pane:sel');
  const text = (editable = false) => ({ nodeType: 3, parentElement: { isContentEditable: editable } });
  const range = node => ({ isCollapsed: false, rangeCount: 1, anchorNode: node });
  doc.sel = range(text()); fire(); fire();
  doc.sel = { isCollapsed: true, rangeCount: 1, anchorNode: text() }; fire(); fire();
  t('preload: a selection in the page -> pane:sel true, collapsed -> false, once each', J(last()) === J([['pane:sel', true], ['pane:sel', false]]));
  sent.length = 0;
  doc.sel = range(text(true)); fire();                                       // the composer (contenteditable)
  doc.sel = range({ nodeType: 1, isContentEditable: true }); fire();
  doc.activeElement = { tagName: 'TEXTAREA' }; doc.sel = range(text()); fire();
  doc.activeElement = { tagName: 'INPUT' }; fire();
  doc.activeElement = null; doc.sel = { isCollapsed: false, rangeCount: 0, anchorNode: null }; fire();
  doc.sel = null; fire();
  t('preload: a selection in a field (contenteditable / textarea / input) / no range / none: not one (nothing sent)', last().length === 0);
  doc.sel = range(text()); fire(); doc.getSelection = () => { throw new Error('x'); }; fire();
  t('preload: a failing read counts as none', J(last()) === J([['pane:sel', true], ['pane:sel', false]]));
  t('preload: listened in the capture phase on window (selectionchange is fired at the document)', (listeners.selectionchange || []).length === 1);
  const g = { role: 'pane', frame: { top: true, detached: false, url: 'https://grok.com/bot/b1', origin: 'https://grok.com' } };
  t('preload: pane:sel passes the IPC gate for a pane (boolean only), nothing else may send it', IPC.check('pane:sel', g, [true], { owned: true }) === null && IPC.check('pane:sel', g, [false], { owned: true }) === null
    && IPC.check('pane:sel', g, ['yes'], { owned: true }) === 'E_PAYLOAD' && IPC.check('pane:sel', { ...g, role: 'chrome' }, [true], { owned: true }) === 'E_ROLE'); }
{ const tp = read('pane-preload.template.js'), gen = read('pane-preload.js');
  t('preload: written in the template, built into the generated preload', /ipcRenderer\.send\('pane:sel', on\)/.test(tp) && gen.includes(tp.slice(tp.indexOf('let selOn = false;'), tp.indexOf("ipcRenderer.send('pane:sel', on)")))); }

// ---- main's wiring (contract with src/main.js) ----
{ const main = read('main.js');
  const fn = name => { const i = main.indexOf(`function ${name}(`); if (i < 0) return ''; let d = 0, j = main.indexOf('{', main.indexOf(')', i)); for (; j < main.length; j++) { if (main[j] === '{') d++; else if (main[j] === '}' && --d === 0) break; } return main.slice(i, j + 1); };
  const cs = fn('copySel'), fp = fn('focusPane'), hk = fn('handleKey');
  t('main: copy-policy loaded before the window code (one copySeq for all windows)', main.indexOf("const CB = require('./copy-policy');") > 0 && main.indexOf('let copySeq = 0;') > 0
    && main.indexOf('let copySeq = 0;') < main.indexOf('// ======================= one app window'));
  t('main: a pane\'s keys - held back (#51) and the input revision (#11) first, then ⌘C to copySel (the key never reaches the page / menu)',
    /if \(navHolds\(p, input\)\) \{[^\n]*\n    if \(input\.type === 'keyDown' && !input\.meta && !input\.control\) \{ clearUnread\(p\); p\.inputRev\+\+; \} if \(handleKey\(input, p\)\) e\.preventDefault\(\);[^\n]*\n    if \(CB\.copyKey\(input, \{ mac: isMac, sel: p\.sel, ime: p\.ime \}\)\) \{ e\.preventDefault\(\); copySel\(p\); \}/.test(main));
  t('main: handleKey has no ⌘C of its own', !/k === 'c'/.test(hk));
  t('main: the selection flag kept per pane, reset on a new page / renderer loss', /^paneOn\('pane:sel', \(p, v\) => \{ p\.sel = v === true; \}\);/m.test(main) && /inputRev: 0, ime: false, sel: false \}/.test(main)
    && /wc\.on\('did-navigate', \(\) => \{ if \(p\.sleeping\) return;[^\n]*p\.ime = false; p\.sel = false;/.test(main) && /wc\.on\('render-process-gone', \(e, d\) => \{ p\.ime = false; p\.sel = false;/.test(main));
  t('main: the menu\'s コピー = this pane\'s copySel (a field: the browser\'s copy of this pane), no role copy left in the pane menu', /items\.push\(\{ label: 'コピー', accelerator: 'CmdOrCtrl\+C', registerAccelerator: false, click: \(\) => params\.isEditable \? wc\.copy\(\) : copySel\(p\) \}\)/.test(main)
    && !/role: 'copy'/.test(main));
  t('main: the edit menu (standard copy elsewhere) is kept', /\{ role: 'editMenu', label: '編集' \}/.test(main));
  t('copySel: reads in its own world with a timeout, then wc.copy, then waits for the clipboard, writes only what fix returns', /executeJavaScriptInIsolatedWorld\(CB\.WORLD, \[\{ code: CB\.SEL_JS \}\]\), sleep\(CB\.READ_MS\)/.test(cs)
    && cs.indexOf('clipboard.readText()') < cs.indexOf('wc.copy()') && cs.indexOf('wc.copy()') < cs.indexOf('CB.fix(') && /const text = CB\.fix\(\{ sel, clip, changed \}\);\n  if \(text == null\) return;\n  clipboard\.writeText\(text\);/.test(cs));
  t('copySel: a newer copy drops an older one; never focuses the pane; the text is never logged', (cs.match(/seq !== copySeq/g) || []).length === 2 && !/\.focus\(/.test(cs)
    && !/dlog\([^\n]*\b(sel|clip|text|before)\b(?!')/.test(cs.replace(/'[^']*'/g, "''")));
  t('focusPane: a pane that has the keyboard already is not focused again', /if \(!p\.view\.webContents\.isFocused\(\)\) p\.view\.webContents\.focus\(\);/.test(fp) && !/^\s*p\.view\.webContents\.focus\(\);/m.test(fp));
  t('a native click selects explicitly through focusPane (no repeat focus); a focus event / renderer report cannot select', /wc\.on\('focus', \(\) => paneGotFocus\(p\)\);/.test(main)
    && /wc\.on\('before-mouse-event', \(e, m\) => \{ if \(m\.type === 'mouseDown' && !p\.sleeping\) focusPane\(panes\.indexOf\(p\)\); \}\);/.test(main)
    && /^paneOn\('pane:interact', p => \{ p\.lastInteract = Date\.now\(\); clearUnread\(p\); \}\);/m.test(main) && !/focus\(\)/.test(fn('setFocused'))); }

console.log(bad ? `\n${bad} failed` : '\nall passed');
process.exit(bad ? 1 : 0);
