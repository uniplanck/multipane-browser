// node test/quote.test.js — request-quote extraction (above the 🟢 marker) + the draft check, on the shared source (src/pane-rules.js)
// and on the copy built into the sandboxed preload (src/pane-preload.js); main must use the shared draft check, not a copy of its own
const fs = require('fs'), path = require('path'), vm = require('vm');
const { loadPreload } = require('./preload-sandbox');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const rules = require('../src/pane-rules'), pre = loadPreload();
const impls = [['rules', rules], ['preload', pre]];
const M = '🟢 ━━ 《 待機中 》 ━━ 🟢', D = '◆ 2026-10-18 17:00 ◆';
let bad = 0; const check = (n, got, exp) => { const ok = got === exp; if (!ok) { bad++; console.log('FAIL', n, JSON.stringify(got), '!=', JSON.stringify(exp)); } else console.log('ok  ', n); };
for (const [impl, { requestQuote, clipQuote }] of impls) {   // the same expected values for both
const eq = (n, got, exp) => check(`${impl} ${n}`, got, exp);
eq('blockquote directly above marker', requestQuote(`本文です\n---\n\n> 次の作業を指示してください\n\n${M}\n${D}`, ['次の作業を指示してください']), '次の作業を指示してください');
eq('blockquote with > markers kept clean', requestQuote(`本文\n> A案かB案か選んでください\n${M}`, ['> A案かB案か選んでください']), 'A案かB案か選んでください');
eq('rule between quote and marker', requestQuote(`本文\n\n> どうしますか\n\n---\n${M}`, ['どうしますか']), 'どうしますか');
eq('datetime after marker', requestQuote(`> 確認をお願いします\n${M} ${D}`, ['確認をお願いします']), '確認をお願いします');
eq('multi-line blockquote', requestQuote(`本文\n1行目\n2行目\n${M}`, ['1行目\n2行目']), '1行目\n2行目');
eq('old ◆ marker', requestQuote('本文\n> 旧表記の依頼\n◆ ━━ 入力待機中 ━━ ◆', ['旧表記の依頼']), '旧表記の依頼');
eq('old 🟢 入力待機中 marker', requestQuote('本文\n> 旧の依頼\n🟢 ━━ 入力待機中 ━━ 🟢', ['旧の依頼']), '旧の依頼');
eq('full-width spaces in marker', requestQuote('本文\n> 依頼X\n🟢　━━　《　待機中　》　━━　🟢', ['依頼X']), '依頼X');
eq('待機中30 follow-up', requestQuote('本文\n> 依頼Y\n🟢 ━━ 《 待機中30 》 ━━ 🟢', ['依頼Y']), '依頼Y');
eq('last of two blockquotes wins', requestQuote(`> 古い引用\n本文\n> 新しい依頼\n${M}`, ['古い引用', '新しい依頼']), '新しい依頼');
eq('non-adjacent blockquote is ignored -> fallback line', requestQuote(`> 途中の引用\n\nその後に長い説明が続きます。\n\n${M}`, ['途中の引用']), 'その後に長い説明が続きます。');
eq('no blockquote -> line above marker', requestQuote(`進捗です\n\n次は何をしますか？\n---\n${M}`, []), '次は何をしますか？');
eq('fallback up to 3 lines', requestQuote(`a\nb\nc\nd\n${M}`, []), 'b\nc\nd');
eq('fallback stops at blank line', requestQuote(`前の段落\n\n依頼1\n依頼2\n${M}`, []), '依頼1\n依頼2');
eq('fallback strips > prefix', requestQuote(`> 依頼Z\n${M}`, []), '依頼Z');
eq('no marker -> empty', requestQuote('ただの本文\n> 引用', ['引用']), '');
eq('empty input', requestQuote('', []), '');
eq('done marker is not a request', requestQuote('本文\n> 引用\n🟣 ━━ ［ 終　了 ］ ━━ 🟣', ['引用']), '');
const long = 'あ'.repeat(500);
eq('clip to 300', clipQuote(long).length, 300);
eq('clip adds ellipsis', clipQuote(long).endsWith('…'), true);
eq('long quote clipped via requestQuote', requestQuote(`> ${long}\n${M}`, [long]).length, 300);
eq('short not clipped', clipQuote('短い'), '短い');
}
// the composer reading has one copy (src/pane-rules.js composerState; composerDraft follows it): the preload has it built in, main runs its
// source (COMPOSER_JS) in the live page right before a page is thrown away (#11 input guard)
check('preload has the shared composerDraft', pre.composerDraft.toString(), rules.composerDraft.toString());
check('COMPOSER_JS is the shared composerState', rules.COMPOSER_JS, `(${rules.composerState})()`);
check('main has no draft check of its own', /function composer(Draft|State)|DRAFT_FN|DRAFT_JS/.test(main), false);
check('main takes COMPOSER_JS from the shared rules', /const \{ COMPOSER_JS \} = require\('\.\/pane-rules'\)/.test(main), true);
// the draft protection itself, on both: main's COMPOSER_JS (run in a fresh context, like executeJavaScript) and the preload's function
const field = ({ tag = 'TEXTAREA', value = '', text = '', hidden = false, tabIndex = 0, attachment = false } = {}) => {
  const box = { querySelector: s => (attachment && s.includes('img[src^="blob:"]') ? {} : null) };
  return { tagName: tag, value, innerText: text, textContent: text, tabIndex, getAttribute: a => (a === 'aria-hidden' && hidden ? 'true' : null), closest: s => (s === 'form' ? box : null), parentElement: { parentElement: box } };
};
const drafts = [
  ['no composer', [], false],
  ['empty textarea', [field()], false],
  ['whitespace only', [field({ value: '  \n ' })], false],
  ['typed text', [field({ value: 'こんにちは' })], true],
  ['contenteditable text', [field({ tag: 'DIV', text: '下書き' })], true],
  ['autosize mirror textarea (tabIndex -1, value x) ignored', [field({ value: 'x', tabIndex: -1 })], false],
  ['aria-hidden field ignored', [field({ tag: 'DIV', text: 'x', hidden: true })], false],
  ['mirror + composer with text', [field({ value: 'x', tabIndex: -1 }), field({ value: '本文' })], true],
  ['empty composer + pending attachment', [field({ attachment: true })], true],
];
for (const [n, els, exp] of drafts) {
  const doc = { querySelectorAll: () => els };
  check('main draft: ' + n, vm.runInNewContext(rules.COMPOSER_JS, { document: doc }).d === 'present', exp);
  pre.ctx.document = doc; check('preload draft: ' + n, pre.composerDraft(), exp);
}
console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
