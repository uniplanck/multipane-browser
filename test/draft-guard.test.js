// node test/draft-guard.test.js — #11 input guard. The pure guard (src/draft-guard.js) on synthetic readings with explicit times: typed text,
// attachment / upload, IME, a failed / timed-out / junk check, a page / generation / key that moved during the check, a confirmation that no
// longer holds, several targets at once, the dialog text (default and Esc = やめる). Then the shared composer reading (src/pane-rules.js
// composerState, on synthetic documents, the same in the built preload and in main's COMPOSER_JS), the preload's IME report, the diagnostics
// codes, and main's wiring (contract with src/main.js). Not covered here: the real Grok composer / attachment / upload DOM, real IME timing and
// the dialogs on screen - that needs the manual check (with real typing, not textContent writes).
const fs = require('fs'), path = require('path'), vm = require('vm');
const G = require('../src/draft-guard');
const rules = require('../src/pane-rules');
const DG = require('../src/diagnostics'), IPC = require('../src/ipc-policy');
const { loadPreload } = require('./preload-sandbox');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;

// a pane's stamp as main builds it, and a reading of it at time `at`
const ST = (o = {}) => ({ ent: 1, gen: 5, rev: 0, closed: false, sleeping: false, ...o });
const RAW = { empty: { d: 'empty', text: false, att: false, up: false, n: 1, fp: 'e1' }, text: { d: 'present', text: true, att: false, up: false, n: 1, fp: 't1' },
  att: { d: 'present', text: false, att: true, up: false, n: 1, fp: 'a1' }, upload: { d: 'present', text: false, att: true, up: true, n: 1, fp: 'u1' },
  both: { d: 'present', text: true, att: true, up: true, n: 1, fp: 'b1' }, none: { d: 'none', text: false, att: false, up: false, n: 0, fp: '1' } };
const rd = (raw, o = {}) => G.read(raw, { page: true, before: ST(), after: ST(), at: 1000, expect: false, ...o });
const NOW = 1200;

// ---- stamps ----
t('stamp: same -> nothing', G.stampDiff(ST(), ST()) === '');
t('stamp: closed / missing -> GONE', G.stampDiff(ST(), ST({ closed: true })) === 'GONE' && G.stampDiff(null, ST()) === 'GONE' && G.stampDiff(ST(), undefined) === 'GONE');
t('stamp: another entity / generation / asleep-awake -> PANE', ['ent', 'gen'].every(k => G.stampDiff(ST(), ST({ [k]: 9 })) === 'PANE') && G.stampDiff(ST(), ST({ sleeping: true })) === 'PANE');
t('stamp: a key typed -> INPUT', G.stampDiff(ST(), ST({ rev: 1 })) === 'INPUT');

// ---- one reading ----
{ const r = rd(RAW.empty);
  t('empty composer: EMPTY, nothing at risk, automatic operations may go', r.st === 'EMPTY' && J(G.risks(r)) === '[]' && G.autoRefusal(r, NOW) === '');
  t('typed text: PRESENT -> automatic refused, manual asks', rd(RAW.text).st === 'PRESENT' && J(G.risks(rd(RAW.text))) === '["PRESENT"]' && G.autoRefusal(rd(RAW.text), NOW) === 'PRESENT');
  t('attachment only: ATTACH (not called typed text)', J(G.risks(rd(RAW.att))) === '["ATTACH"]' && G.autoRefusal(rd(RAW.att), NOW) === 'ATTACH');
  t('attachment uploading: ATTACH + UPLOAD', J(G.risks(rd(RAW.upload))) === '["ATTACH","UPLOAD"]');
  t('text + attachment + upload: all three, in order', J(G.risks(rd(RAW.both))) === '["PRESENT","ATTACH","UPLOAD"]');
  t('an upload flag without an attachment is ignored', rd({ ...RAW.empty, up: true }).up === false);
  t('IME composition: refused even with an empty composer', J(G.risks(rd(RAW.empty, { ime: true }))) === '["IME"]' && G.autoRefusal(rd(RAW.empty, { ime: true }), NOW) === 'IME');
  t('a broadcast into the pane: BUSY', J(G.risks(rd(RAW.empty, { busy: true }))) === '["BUSY"]' && G.autoRefusal(rd(RAW.empty, { busy: true }), NOW) === 'BUSY');
  t('a manual confirmation of the pane in progress: automatic refused (BUSY), the manual plan ignores it', G.autoRefusal(rd(RAW.empty, { hold: true }), NOW) === 'BUSY' && J(G.risks(rd(RAW.empty, { hold: true }))) === '[]');
  t('fingerprint kept, bounded', rd({ ...RAW.text, fp: 'x'.repeat(40) }).fp.length === 16 && rd(RAW.text).fp === 't1'); }

// ---- failed / unknown checks ----
{ const fail = [null, undefined, 'present', 5, [], {}, { d: 'maybe' }, { d: true }, { d: '__proto__' }];
  t('check failed / timed out / junk answer -> UNKNOWN: automatic refused, manual asks', fail.every(x => { const r = rd(x); return r.st === 'UNKNOWN' && G.autoRefusal(r, NOW) === 'UNKNOWN' && J(G.risks(r)) === '["UNKNOWN"]'; }));
  t('no composer on a page that is not a confirmed conversation: NOINPUT, nothing at risk (a first load / generic page is not held up)', rd(RAW.none).st === 'NOINPUT' && G.autoRefusal(rd(RAW.none), NOW) === '' && !G.risks(rd(RAW.none)).length);
  t('no composer where one must be (confirmed conversation): UNKNOWN', rd(RAW.none, { expect: true }).st === 'UNKNOWN' && G.autoRefusal(rd(RAW.none, { expect: true }), NOW) === 'UNKNOWN');
  t('no page (asleep / blank / queued / error page): NOPAGE, never at risk, nothing read', (r => r.st === 'NOPAGE' && !G.risks(r).length && G.autoRefusal(r, NOW) === '')(G.read(RAW.text, { page: false, before: ST(), after: ST({ sleeping: true }), at: 1000, ime: true, busy: true })));
  t('not an object reading -> UNKNOWN / refused', J(G.risks(null)) === '["UNKNOWN"]' && G.autoRefusal(undefined, NOW) === 'UNKNOWN'); }

// ---- the page or the input moved while it was read ----
{ const gen = rd(RAW.empty, { after: ST({ gen: 6 }) }), key = rd(RAW.empty, { after: ST({ rev: 3 }) }), gone = rd(RAW.empty, { after: ST({ closed: true }) });
  t('generation changed during the check (navigated / reloaded / slept): not a reading of now -> CHANGED', gen.st === 'UNKNOWN' && gen.moved === 'PANE' && G.autoRefusal(gen, NOW) === 'CHANGED');
  t('a key typed during the check -> CHANGED (even though the answer said empty)', key.moved === 'INPUT' && G.autoRefusal(key, NOW) === 'CHANGED' && G.risks(key).includes('UNKNOWN'));
  t('closed during the check -> CHANGED', gone.moved === 'GONE' && G.autoRefusal(gone, NOW) === 'CHANGED'); }

// ---- time: only a reading taken right before counts ----
{ const r = rd(RAW.empty, { at: 1000 });
  t('fresh reading: goes', G.autoRefusal(r, 1000 + G.FRESH_MS) === '');
  t('older than FRESH_MS: STALE', G.autoRefusal(r, 1001 + G.FRESH_MS) === 'STALE');
  t('a reading from the future / no time / bad clock: STALE', G.autoRefusal(r, 999) === 'STALE' && G.autoRefusal(rd(RAW.empty, { at: undefined }), NOW) === 'STALE' && G.autoRefusal(r, NaN) === 'STALE');
  t('check timeout is short (the user waits for it)', G.CHECK_MS > 0 && G.CHECK_MS <= 3000 && G.FRESH_MS > G.CHECK_MS); }

// ---- several targets (reload-all / close others / workspace / layout) ----
{ const items = [{ id: 1, r: rd(RAW.empty) }, { id: 2, r: rd(RAW.text) }, { id: 3, r: G.read(null, { page: false, after: ST(), at: 1000 }) }, { id: 4, r: rd(null) }, { id: 5, r: rd(RAW.empty, { ime: true }) }, { id: 6, r: rd(RAW.none) }];
  const pl = G.plan(items);
  t('plan: only the panes at risk are asked about, each with its reasons', J(pl.ask) === J([{ id: 2, codes: ['PRESENT'] }, { id: 4, codes: ['UNKNOWN'] }, { id: 5, codes: ['IME'] }]));
  t('plan: the others pass (empty / no page / no composer)', J(pl.pass) === '[1,3,6]');
  t('plan: nothing at risk -> no dialog', G.plan([{ id: 1, r: rd(RAW.empty) }, { id: 3, r: G.read(null, { page: false }) }]).ask.length === 0);
  t('plan: no targets / junk', J(G.plan([])) === J({ ask: [], pass: [] }) && J(G.plan(null)) === J({ ask: [], pass: [] })); }

// ---- after the confirmation: it holds only for what was shown ----
{ const shown = [{ id: 1, r: rd(RAW.text, { at: 1000 }) }, { id: 2, r: rd(RAW.empty, { at: 1000 }) }];
  const again = (o1 = {}, o2 = {}, raw1 = RAW.text, raw2 = RAW.empty) => [{ id: 1, r: rd(raw1, { at: 3000, ...o1 }) }, { id: 2, r: rd(raw2, { at: 3000, ...o2 }) }];
  t('nothing changed: the confirmation holds', G.expired(shown, again(), 3100) === '');
  t('the text changed meanwhile (fingerprint) -> INPUT', G.expired(shown, again({}, {}, { ...RAW.text, fp: 't2' }), 3100) === 'INPUT');
  t('the draft was sent / cleared meanwhile -> INPUT', G.expired(shown, again({}, {}, RAW.empty), 3100) === 'INPUT');
  t('a pane that was empty got input meanwhile -> INPUT', G.expired(shown, again({}, {}, RAW.text, RAW.text), 3100) === 'INPUT');
  t('an attachment / upload / IME appeared meanwhile -> INPUT', G.expired(shown, again({}, {}, RAW.both), 3100) === 'INPUT' && G.expired(shown, again({ ime: true }), 3100) === 'INPUT');
  t('a key typed since the dialog went up (input revision) -> INPUT', G.expired(shown, again({ before: ST({ rev: 4 }), after: ST({ rev: 4 }) }), 3100) === 'INPUT');
  t('the page / generation changed (reload, navigation, slept) -> PANE', G.expired(shown, again({}, { before: ST({ gen: 9 }), after: ST({ gen: 9 }) }), 3100) === 'PANE');
  t('a target closed meanwhile (main: no page any more) -> GONE', G.expired(shown, again({ page: false, before: ST({ closed: true }), after: ST({ closed: true }) }), 3100) === 'GONE' && G.expired(shown, again().slice(0, 1), 3100) === 'GONE');
  t('a target put to sleep meanwhile -> PANE', G.expired(shown, again({}, { page: false, before: ST({ sleeping: true }), after: ST({ sleeping: true }) }), 3100) === 'PANE');
  t('moved while read again -> CHANGED', G.expired(shown, again({ after: ST({ rev: 1 }) }), 3100) === 'CHANGED');
  t('second reading too old -> STALE', G.expired(shown, again(), 3001 + G.FRESH_MS) === 'STALE');
  const unk = [{ id: 4, r: rd(null, { at: 1000 }) }];
  t('consented to an unknown state that is still unknown: holds', G.expired(unk, [{ id: 4, r: rd(null, { at: 3000 }) }], 3100) === '');
  t('unknown then readable with a draft: does not hold', G.expired(unk, [{ id: 4, r: rd(RAW.text, { at: 3000 }) }], 3100) === 'INPUT');
  t('nothing shown -> holds; junk -> GONE', G.expired([], [], 3100) === '' && G.expired([{ id: 1, r: null }], [], 3100) === 'GONE'); }

// ---- right before acting ----
{ const last = [{ id: 1, r: rd(RAW.empty) }, { id: 2, r: rd(RAW.text) }];
  t('same panes, nothing moved: go', G.unmoved(last, [{ id: 1, stamp: ST() }, { id: 2, stamp: ST() }]) === '');
  t('a target closed meanwhile is simply not acted on', G.unmoved(last, [{ id: 2, stamp: ST() }]) === '');
  t('a pane that was never read (opened meanwhile) -> NEW', G.unmoved(last, [{ id: 1, stamp: ST() }, { id: 7, stamp: ST() }]) === 'NEW');
  t('typed / navigated since the reading -> INPUT / PANE', G.unmoved(last, [{ id: 1, stamp: ST({ rev: 1 }) }]) === 'INPUT' && G.unmoved(last, [{ id: 2, stamp: ST({ gen: 8 }) }]) === 'PANE'); }

// ---- pure ----
{ const deepFreeze = x => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); Object.values(x).forEach(deepFreeze); } return x; };
  const fr = deepFreeze([{ id: 1, r: rd(RAW.text) }, { id: 2, r: rd(RAW.empty) }]);
  t('pure: readings / lists are never changed', (() => { try { G.plan(fr); G.expired(fr, fr, 1100); G.unmoved(fr, [{ id: 1, stamp: ST() }]); G.risks(fr[0].r); G.autoRefusal(fr[0].r, 1100); G.read(deepFreeze({ ...RAW.text }), deepFreeze({ page: true, before: ST(), after: ST(), at: 1 })); return true; } catch { return false; } })()); }

// ---- the dialog ----
{ const d = G.dialogText('CLOSE', [{ label: 'Tibo', codes: ['PRESENT', 'ATTACH'] }]);
  t('dialog: says what happens and that input may be lost', d.message === 'このペインを閉じると、入力中の内容が失われる可能性があります');
  t('dialog: lists the pane and why', d.detail.split('\n')[0] === '・Tibo：入力欄に下書きがあります・添付ファイルがあります' && /やめる.*そのまま残ります/.test(d.detail));
  t('dialog: default and Esc = やめる (last button)', J(d.buttons) === J(['閉じる', 'やめる']) && d.defaultId === 1 && d.cancelId === 1 && J(d.actions) === J(['go', 'cancel']));
  const s = G.dialogText('RELOAD_ALL', [{ label: 'A', codes: ['UNKNOWN'] }, { label: 'B', codes: ['IME'] }], { skip: true });
  t('dialog: reload-all offers "all but those"; default / Esc still やめる', J(s.buttons) === J(['すべて再読み込み', '入力のあるペインを除いて再読み込み', 'やめる']) && s.defaultId === 2 && s.cancelId === 2 && J(s.actions) === J(['go', 'skip', 'cancel']));
  t('dialog: several panes, one line each', s.detail.split('\n').slice(0, 2).join('|') === '・A：入力欄の状態を確認できませんでした|・B：変換中の文字があります');
  t('dialog: skip only where it makes sense', G.dialogText('CLOSE', [{ label: 'A', codes: ['PRESENT'] }], { skip: true }).buttons.length === 2);
  const long = G.dialogText('SLEEP', [{ label: 'x'.repeat(100), codes: ['ZZZ'] }, { label: '  ', codes: [] }]);
  t('dialog: long name clipped, empty name / unknown reason still readable', long.detail.split('\n')[0] === `・${'x'.repeat(39)}…：入力欄の状態を確認できませんでした` && long.detail.split('\n')[1] === '・（名前なし）：入力欄の状態を確認できませんでした');
  t('dialog: unknown operation falls back to the close wording', G.dialogText('NOPE', []).message.startsWith('このペインを閉じると'));
  t('dialog: every operation has its wording and button; every risk its own reason', Object.values(G.OPS).every(o => /と$/.test(o.when) && o.go)
    && new Set(G.RISKS.map(c => G.dialogText('CLOSE', [{ label: 'a', codes: [c] }]).detail.split('\n')[0])).size === G.RISKS.length);
  // (#23) closing one pane puts it into the 閉じたペインを開き直す history: the dialog says its input does not come back (the やめる line stays last)
  const NOTE = '閉じたペインを元に戻しても、下書き・添付は復元できません。', tail = x => x.detail.split('\n').slice(-2);
  t('dialog: close says reopening does not bring the draft / attachment back', J(tail(d)) === J([NOTE, '「やめる」を選ぶと、入力内容と添付はそのまま残ります。']));
  t('dialog: closing many at once / other operations (not in the history) do not mention it', ['CLOSE_OTHERS', 'LAYOUT', 'WORKSPACE', 'RELOAD', 'RELOAD_ALL', 'SLEEP', 'NAVIGATE']
    .every(op => !G.dialogText(op, [{ label: 'a', codes: ['PRESENT'] }]).detail.includes(NOTE))
    && Object.keys(G.OPS).filter(op => G.OPS[op].reopen).join() === 'CLOSE'); }

// ---- the shared composer reading (src/pane-rules.js composerState) ----
const pre = loadPreload();
const field = ({ tag = 'TEXTAREA', value = '', text = '', hidden = false, tabIndex = 0, attachment = false, progress = false } = {}) => {
  const box = { querySelector: s => (attachment && s.includes('img[src^="blob:"]') ? {} : progress && s.includes('progressbar') ? {} : null) };
  return { tagName: tag, value, innerText: text, textContent: text, tabIndex, getAttribute: a => (a === 'aria-hidden' && hidden ? 'true' : null), closest: s => (s === 'form' ? box : null), parentElement: { parentElement: box } };
};
const doc = els => ({ querySelectorAll: () => els });
const viaMain = els => vm.runInNewContext(rules.COMPOSER_JS, { document: doc(els), Array, String });   // like main's executeJavaScript: the source alone
const viaPre = els => { pre.ctx.document = doc(els); return vm.runInContext('composerState()', pre.ctx); };
const cases = [
  ['no composer', [], { d: 'none', text: false, att: false, up: false, n: 0 }],
  ['empty textarea', [field()], { d: 'empty', text: false, att: false, up: false, n: 1 }],
  ['typed text', [field({ value: '書きかけ' })], { d: 'present', text: true, att: false, up: false, n: 1 }],
  ['contenteditable text', [field({ tag: 'DIV', text: '下書き' })], { d: 'present', text: true, att: false, up: false, n: 1 }],
  ['attachment only', [field({ attachment: true })], { d: 'present', text: false, att: true, up: false, n: 1 }],
  ['attachment uploading', [field({ attachment: true, progress: true })], { d: 'present', text: false, att: true, up: true, n: 1 }],
  ['progress without attachment is not an upload', [field({ progress: true })], { d: 'empty', text: false, att: false, up: false, n: 1 }],
  ['mirror / hidden fields ignored', [field({ value: 'x', tabIndex: -1 }), field({ tag: 'DIV', text: 'y', hidden: true })], { d: 'none', text: false, att: false, up: false, n: 0 }],
];
for (const [n, els, exp] of cases) {
  const m = viaMain(els), p = viaPre(els), pick = o => J({ d: o.d, text: o.text, att: o.att, up: o.up, n: o.n });
  t(`composer: ${n}`, pick(m) === J(exp) && J(m) === J(p) && typeof m.fp === 'string');
}
t('composer: the preload has the same composerState built in; composerDraft follows it', vm.runInContext('composerState.toString()', pre.ctx) === rules.composerState.toString() && rules.COMPOSER_JS === `(${rules.composerState})()`
  && cases.every(([, els, exp]) => { pre.ctx.document = doc(els); return pre.composerDraft() === (exp.d === 'present'); }));
{ const a = viaMain([field({ value: 'ひみつの下書き' })]), b = viaMain([field({ value: 'ひみつの下書き。' })]), c = viaMain([field({ value: 'ひみつの下書き' })]);
  t('composer: fingerprint changes with the text, stays for the same text', a.fp !== b.fp && a.fp === c.fp && viaMain([field({ attachment: true })]).fp !== viaMain([field()]).fp);
  t('composer: the answer carries no text (only flags, a count and a short hash)', !J(a).includes('ひみつ') && Object.keys(a).sort().join() === 'att,d,fp,n,text,up' && a.fp.length <= 7); }
{ const r = G.read(viaMain([field({ value: '本文' })]), { page: true, before: ST(), after: ST(), at: 1 }), e = G.read(viaMain([field()]), { page: true, before: ST(), after: ST(), at: 1 });
  t('composer -> guard: typed text is PRESENT, an empty one EMPTY', r.st === 'PRESENT' && r.text && e.st === 'EMPTY'); }

// ---- the preload reports an IME composition (on change only) ----
{ const listeners = {}, sent = [];
  const ctx = vm.createContext({
    require: m => { if (m !== 'electron') throw new Error(m); return { ipcRenderer: { send: (ch, v) => sent.push([ch, v]), on: () => {} }, webFrame: { insertCSS() {}, removeInsertedCSS() {}, setZoomFactor() {} } }; },
    window: { addEventListener: (ev, f) => { (listeners[ev] = listeners[ev] || []).push(f); } }, document: { documentElement: null, querySelector: () => null, querySelectorAll: () => [] },
    location: { hostname: 'grok.com', pathname: '/bot/b1' }, MutationObserver: class { observe() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'pane-preload.js'), 'utf8'), ctx);
  const fire = ev => (listeners[ev] || []).forEach(f => f({}));
  fire('compositionstart'); fire('compositionstart'); fire('compositionend'); fire('compositionend');
  const ime = sent.filter(s => s[0] === 'pane:ime');
  t('preload: composition start / end -> pane:ime true / false, once each', J(ime) === J([['pane:ime', true], ['pane:ime', false]]));
  t('preload: pane:ime passes the IPC gate for a pane (boolean only)', IPC.check('pane:ime', { role: 'pane', frame: { top: true, detached: false, url: 'https://grok.com/bot/b1', origin: 'https://grok.com' } }, [true], { owned: true }) === null
    && IPC.check('pane:ime', { role: 'pane', frame: { top: true, detached: false, url: 'https://grok.com/bot/b1', origin: 'https://grok.com' } }, ['yes'], { owned: true }) === 'E_PAYLOAD'); }

// ---- diagnostics: fixed codes only ----
t('diagnostics: guard.auto codes = draft-guard AUTO_CODES', J([...DG.GUARD_AUTO_CODES].sort()) === J([...G.AUTO_CODES].sort()) && G.AUTO_CODES.every(c => DG.EVENTS['guard.auto'].r.includes(c)));
t('diagnostics: guard.ask takes the expiry codes + asked / cancel / go / busy', J([...DG.GUARD_EXPIRE_CODES].sort()) === J([...G.EXPIRE_CODES].sort()) && [...G.EXPIRE_CODES, 'ASKED', 'CANCEL', 'GO', 'BUSY'].every(c => DG.EVENTS['guard.ask'].r.includes(c)));
t('diagnostics: every reading state main records is a draft result', G.STATES.filter(s => s !== 'NOPAGE' && s !== 'UNKNOWN').every(s => DG.EVENTS.draft.r.includes(s)));

// ---- main's wiring (contract with src/main.js) ----
{ const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const fn = name => { const i = main.indexOf(`function ${name}(`); if (i < 0) return ''; let d = 0, j = main.indexOf('{', main.indexOf(')', i)); for (; j < main.length; j++) { if (main[j] === '{') d++; else if (main[j] === '}' && --d === 0) break; } return main.slice(i, j + 1); };
  const li = fn('liveInput'), hp = fn('hasPage'), gr = fn('guardRun'), go = fn('guardOnce'), ts = fn('trySleep'), ar = fn('autoReload'), hk = fn('handleKey'), cm = fn('chipMenu'), pm = fn('paneMenu');
  t('main: the live check runs the shared composerState (no copy of its own), with a timeout, framed by stamps before / after', /const \{ COMPOSER_JS \} = require\('\.\/pane-rules'\);/.test(main) && !/function composerState|DRAFT_JS/.test(main)
    && /executeJavaScriptInIsolatedWorld\(\d+, \[\{ code: COMPOSER_JS \}\]\)/.test(li) && /sleep\(GUARD\.CHECK_MS\)/.test(li) && /const before = inStamp\(p\)/.test(li) && /after: inStamp\(p\)/.test(li));
  t('main: the stamp is entity / generation / keys typed / closed / asleep (memory only)', /const inStamp = p => \(\{ ent: p\.obs\.ent, gen: p\.obs\.gen, rev: p\.inputRev \|\| 0, closed: !!p\.obs\.closed, sleeping: !!p\.sleeping \}\);/.test(main)
    && /p\.inputRev\+\+/.test(fn('addPane')) && !/\binputRev\b|\bime\b|guardHold/.test(main.slice(main.indexOf('const paneSpec'), main.indexOf('\n', main.indexOf('const paneSpec')))));
  t('main: no page (asleep / blank / new tab / gone renderer) is never read or asked about', /p\.sleeping \|\| wc\.isDestroyed\(\) \|\| wc\.isCrashed\(\)/.test(hp) && /isBlankUrl\(u\)/.test(hp) && /newtab\.html/.test(hp) && /if \(!guardN && !targets\(\)\.some\(hasPage\)\) \{ run\(targets\(\)\); return; \}/.test(gr));
  t('main: auto-sleep reads live, goes only through the guard, then the existing sleep rules', /const r = await liveInput\(p\);/.test(ts) && /if \(autoGate\(p, r, 'sleep'\) && canSleep\(p, panes\.indexOf\(p\)\)\) sleepPane\(p\);/.test(ts)
    && /if \(!force && p\.hasDraft\) return false;/.test(fn('canSleep')));
  t('main: auto-reload and the watchdog go through the guard first', /autoGate\(p, r, 'reload'\)/.test(ar) && ar.indexOf('autoGate') < ar.indexOf('reloadPane(p, ') && /c\.autoReload\(p\);/.test(main) && !/^\s*reloadPane\(p\);\s*$/m.test(main.slice(0, main.indexOf('function makeWindow')))
    && /if \(!autoGate\(p, await liveInput\(p\), 'watchdog'\)\) continue;/.test(main) && main.indexOf("autoGate(p, await liveInput(p), 'watchdog')") < main.indexOf("diag.rec('watchdog', 'RELOAD'"));
  t('main: the dialog default and Esc are the cancel button from the guard', /defaultId: d\.defaultId, cancelId: d\.cancelId/.test(go) && /d\.actions\[response\] \|\| 'cancel'/.test(go));
  t('main: after a confirmation everything is read again and must still match; right before acting nothing may have moved', go.indexOf('GUARD.expired(') > go.indexOf('showMessageBox') && go.indexOf('GUARD.unmoved(') > go.indexOf('GUARD.expired(') && go.indexOf('GUARD.unmoved(') < go.indexOf('run(cur)'));
  t('main: cancelled / expired -> nothing happens, focus goes back', (go.match(/back\(\); return;/g) || []).length === 3 && /getFocusedWebContents\(\)/.test(go));
  t('main: keys ⌘W / ⌘R / ⌘[ / ⌘] go through the guard', /k === 'w' && !input\.shift\) \{ if \(fp\) askClose\(\);/.test(hk) && /k === 'r' && !input\.shift\) \{ if \(fp\) askReload\(\);/.test(hk) && /goHist\(fp, -1\)/.test(hk) && /goHist\(fp, 1\)/.test(hk) && !/closePane\(|reloadPane\(|goBack\(|goForward\(/.test(hk));
  t('main: buttons / IPC (close, reload, address bar, back, forward) go through the guard', /^on\('navigate', \(id, url\) => \{ const p = byId\(id\); if \(p\) openIn\(p, url\); \}\);$/m.test(main) && /^on\('close', id => askClose\(id\)\);$/m.test(main)
    && /^on\('reload', id => \{ if \(byId\(id\)\) askReload\(id\); \}\);$/m.test(main) && /^on\('back', id => goHist\(byId\(id\), -1\)\);$/m.test(main) && /^on\('forward', id => goHist\(byId\(id\), 1\)\);$/m.test(main));
  t('main: menus (pane / chip / app) close / reload / back to new tab / close others through the guard', !/closePane\(|loadInto\(/.test(pm) && /askClose\(id\)/.test(pm) && /askClose\(id\)/.test(cm)
    && /askReload\(id\)/.test(cm) && /openIn\(p, '', 'NEWTAB'/.test(cm) && /guardRun\('CLOSE_OTHERS'/.test(cm) && /k\.askClose\(\)/.test(fn('buildMenu')) && /k\.askReload\(\)/.test(fn('buildMenu')));
  t('main: layout / workspace / reload-all / URL in the focused pane / favorite / ⌘T at the limit / grok links go through the guard', /guardRun\('LAYOUT'/.test(fn('applyPreset')) && /guardRun\('WORKSPACE'/.test(fn('loadWorkspace')) && /guardRun\('RELOAD_ALL'[\s\S]*\{ skip: true \}/.test(fn('reloadAll'))
    && /case 'open-here': \{ closeOverlay\(\); const p = panes\[focused\]; if \(p\) openIn\(/.test(main) && /openIn\(panes\[focused\], f\.url/.test(fn('openFavorite')) && /if \(p\) openIn\(p, url\); return;/.test(fn('newPane')) && /if \(c\) c\.openLink\(wc, d\.url\);/.test(fn('linkOpen')));
  t('main: manual sleep asks through the guard (no dialog of its own)', /guardRun\('SLEEP'/.test(fn('sleepNowAsk')) && !/showMessageBox/.test(fn('sleepNowAsk')));
  t('main: a broadcast marks its pane busy while it runs (#12: until its result)', /p\.broadcasting = true;[\s\S]*finally \{ if \(!watching\) p\.broadcasting = false; \}/.test(fn('broadcastSend'))
    && /finally \{ p\.broadcasting = false; \}/.test(fn('bcWatch')));
  t('main: IME reports kept per pane, reset on a new page / renderer loss', /^paneOn\('pane:ime', \(p, v\) => \{ p\.ime = v === true; \}\);/m.test(main) && /wc\.on\('did-navigate', \(\) => \{ if \(p\.sleeping\) return;[^\n]*p\.hasDraft = false; p\.ime = false;/.test(main) && /wc\.on\('render-process-gone', \(e, d\) => \{ p\.ime = false;/.test(main));
  const g = main.slice(main.indexOf('// ---- input guard (#11, draft-guard.js) ----'), main.indexOf('function sleepTick()'));
  t('main: the guard never logs names / titles / URLs / page text (dialog only)', g.length > 1000 && ![...g.matchAll(/(?:dlog|diag\.rec)\(([^\n]*)/g)].some(m => /paneLabel|displayTitle|\.name\b|getURL|url|label|detail|message/.test(m[1]))); }

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
