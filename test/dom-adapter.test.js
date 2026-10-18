// node test/dom-adapter.test.js — #03 conversation snapshot. readConversation (the shared block of src/pane-rules.js) on structured, synthetic
// turns: roles, several markers, missing / partial DOM, a reply still changing, h1 / header that differ or are ambiguous, quote / draft / name each
// valid or unknown on their own — on the shared source and on the copy built into the sandboxed preload, with the same expected values. Then the
// preload's DOM reader on a synthetic document (never a real page or real text), its report through the IPC gate, and main's use of it (contract
// with src/main.js). Not covered here: the real Grok DOM (attachments / blockquotes / group rooms) - that needs the manual check.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { loadPreload } = require('./preload-sandbox');
const rules = require('../src/pane-rules'), pre = loadPreload();
const IPC = require('../src/ipc-policy'), DG = require('../src/diagnostics'), { sleepIdentity } = require('../src/sleep-rules');
const impls = [['rules', rules], ['preload', pre]];
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;

const W = '🟢 ━━ 《 待機中 》 ━━ 🟢', K = '🔴 ━━ 【 作業中 】 ━━ 🔴', F = '🟣 ━━ ［ 終　了 ］ ━━ 🟣', DT = '◆ 2026-10-18 17:00 ◆';
// synthetic turns [role, text]: 'u' user, 'b' bot, '' a block without text yet. The latest block with text gets the extra reads the preload does.
function facts(turns, extra = {}, quotes = [], widget = false) {
  const entries = turns.map(([r, x]) => ({ user: r === 'u', blank: !String(x || '').trim() }));
  const li = entries.map(e => !e.blank).lastIndexOf(true);
  let last = null;
  if (li >= 0) { const [r, x] = turns[li]; last = { text: x }; if (r !== 'u') Object.assign(last, { inner: x, quotes, widget }); }
  return { cid: 'bot1', ready: true, auth: false, entries, last, guess: null, h1s: ['Tibo'], hh: 'Tibo', draft: 'empty', quiet: true, ...extra };
}
// the bot-entry branch of scanMessages before #03, transcribed onto the same turns (its DOM reads replaced by the turn's fields): counts / flags /
// quote / heading / fingerprint must come out exactly as before
const DASH = new RegExp('[\\u30fc\\uff0d\\u2014\\u2013\\u2500\\u2501\\u2015]', 'g');
function legacy(turns, h1 = 'Tibo', hdr = 'Tibo', quotes = [], widget = false) {
  const ents = turns.filter(([, x]) => String(x || '').trim());
  if (!ents.length) return null;
  let user = 0, bot = 0, botSince = 0;
  for (const [r] of ents) { if (r === 'u') { user++; botSince = 0; } else { bot++; botSince++; } }
  const lt = ents[ents.length - 1][1], tx = lt.replace(/[\s　]+/g, '').replace(DASH, '-');
  const asks = botSince > 0 && rules.looksAsking(lt, widget), mk = botSince > 0 ? rules.markerOf(lt) : null;
  let h = 5381; const tail = tx.slice(-400); for (let i = 0; i < tail.length; i++) h = ((h * 33) ^ tail.charCodeAt(i)) >>> 0;
  let q = ''; if (mk === 'wait') { try { q = rules.requestQuote(lt, quotes); } catch {} }
  return { user, bot, botSince, waiting: mk === 'wait', working: mk === 'work', done: mk === 'done', q, hn: h1, hh: hdr, asks: asks && mk !== 'work' && mk !== 'done', method: 'bot-entry', fp: h.toString(36) + '.' + tx.length };
}
const counts = r => { const { snap, ...c } = r; return c; };
const codes = (r, ...ks) => ks.map(k => r.snap[k]).join(' ');

// ---- the same expected values for both copies ----
const seenIssues = new Set();
for (const [impl, R] of impls) {
  const n = s => `${impl}: ${s}`, read = (...a) => { const r = R.readConversation(facts(...a)); seenIssues.add(R.snapIssue(r.snap)); return r; };
  // roles / counts
  { const r = read([['u', 'こんにちは'], ['b', '了解です\n' + W]]);
    t(n('user + bot turn: counts and 🟢'), r.user === 1 && r.bot === 1 && r.botSince === 1 && r.waiting && !r.working && !r.done && r.method === 'bot-entry');
    t(n('confirmed structure: conv OK, roles TESTID, latest BOT, marker WAIT, stable QUIET'), codes(r, 'conv', 'roles', 'latest', 'marker', 'stable') === 'OK TESTID BOT WAIT QUIET');
    t(n('usable for automatic actions, no issue'), R.snapUsable(r.snap) && R.snapIssue(r.snap) === '');
    t(n('no blockquote: the line above the marker, quote LINES'), r.q === '了解です' && r.snap.quote === 'LINES'); }
  { const r = read([['b', '本文\n> 次の作業を指示してください\n' + W]], {}, ['次の作業を指示してください']);
    t(n('blockquote right above the marker: quote BLOCK'), r.q === '次の作業を指示してください' && r.snap.quote === 'BLOCK'); }
  { const r = read([['b', '本文\n' + W], ['u', 'はい']]);
    t(n('user spoke last: botSince 0, latest USER, marker NA, quote NA (the older 🟢 is not used)'), r.botSince === 0 && !r.waiting && codes(r, 'latest', 'marker', 'quote') === 'USER NA NA' && R.snapUsable(r.snap)); }
  // markers: the last one in the latest bot turn, nothing from other turns
  t(n('several markers in the latest turn: the last wins (work)'), codes(read([['b', W + '\n続けます\n' + K]]), 'marker') === 'WORK');
  t(n('several markers in the latest turn: the last wins (done)'), codes(read([['b', K + '\n終わり\n' + F + '\n' + DT]]), 'marker', 'quote') === 'DONE NA');
  { const r = read([['b', '本文\n' + W], ['b', '進捗です']]);
    t(n('marker only in an older bot turn: latest has none (NONE, not waiting)'), r.snap.marker === 'NONE' && !r.waiting && r.botSince === 2 && R.snapUsable(r.snap)); }
  t(n('legacy ◆ wording counts as 🟢'), codes(read([['b', '本文\n◆ ━━ 入力待機中 ━━ ◆']]), 'marker') === 'WAIT');
  t(n('待機中30 / 入力待機中60 count as 🟢'), codes(read([['b', '本文\n🟢 ━━ 《 待機中30 》 ━━ 🟢\n' + DT]]), 'marker') === 'WAIT' && codes(read([['b', '本文\n🟢 ━━ 入力待機中60 ━━ 🟢']]), 'marker') === 'WAIT');
  t(n('pinned as before: marker in a > blockquote / code block at the very end counts'), codes(read([['b', '本文\n> ' + W]]), 'marker') === 'WAIT' && codes(read([['b', '本文\n```\n' + K + '\n```']]), 'marker') === 'WORK');
  t(n('pinned as before: marker followed by more text does not count'), codes(read([['b', W + '\nconst x = 1;']]), 'marker') === 'NONE');
  // missing DOM is never an empty conversation
  { const r = read([]);
    t(n('no turns at all: counts 0 but conv DOM_UNKNOWN, roles NONE, method none'), r.user === 0 && r.bot === 0 && r.botSince === 0 && r.method === 'none' && codes(r, 'conv', 'roles', 'latest', 'marker', 'quote') === 'DOM_UNKNOWN NONE NONE UNKNOWN UNKNOWN');
    t(n('no turns at all: not usable (not "empty" / "nothing new")'), !R.snapUsable(r.snap) && !R.snapOk(r.snap, 'conv') && R.snapIssue(r.snap) === 'DOM_UNKNOWN'); }
  t(n('document still loading: LOADING'), codes(read([], { ready: false }), 'conv') === 'LOADING');
  t(n('password field and no conversation: AUTH_REQUIRED'), codes(read([], { auth: true }), 'conv') === 'AUTH_REQUIRED' && codes(read([], { auth: true, ready: false }), 'conv') === 'AUTH_REQUIRED');
  t(n('a conversation on screen is never called a login problem'), codes(read([['b', '本文\n' + W]], { auth: true }), 'conv') === 'OK');
  t(n('no turns, no evidence: DOM_UNKNOWN, never AUTH_REQUIRED'), codes(read([], { ready: true }), 'conv') === 'DOM_UNKNOWN');
  { const g = { user: 0, bot: 4, botSince: 4, waiting: true, working: false, done: false, asks: true, method: 'geometry' }, r = read([], { guess: g });
    t(n('sidebar only / generic guesses: their counts pass through, roles GUESS, conv DOM_UNKNOWN'), J(counts(r)) === J(g) && codes(r, 'conv', 'roles') === 'DOM_UNKNOWN GUESS');
    t(n('generic guesses: not usable, issue ROLE_GUESS'), !R.snapUsable(r.snap) && R.snapIssue(r.snap) === 'ROLE_GUESS');
    t(n('generic guesses on a login page: AUTH_REQUIRED wins'), R.snapIssue(read([], { guess: g, auth: true }).snap) === 'AUTH_REQUIRED'); }
  t(n('bot-entry turns but no /bot/<id> in the path: counted, conv DOM_UNKNOWN'), (r => r.bot === 1 && codes(r, 'conv', 'roles') === 'DOM_UNKNOWN NONE')(read([['b', '本文']], { cid: '' })));
  // partially rendered newest block
  { const turns = [['u', '質問'], ['b', '本文\n' + W]], r = read([...turns, ['', '']]);
    t(n('newest block has no text yet: latest PARTIAL, marker / quote UNKNOWN'), codes(r, 'latest', 'marker', 'quote') === 'PARTIAL UNKNOWN UNKNOWN');
    t(n('partial: not usable, issue LATEST_PARTIAL'), !R.snapUsable(r.snap) && R.snapIssue(r.snap) === 'LATEST_PARTIAL');
    t(n('partial: counts / flags / quote / fingerprint as before (the blank block is skipped)'), J(counts(r)) === J(counts(read(turns))) && J(counts(r)) === J(legacy(turns))); }
  { const r = read([['b', '本文\n' + W], ['', ''], ['u', '次']]);
    t(n('a blank block in the middle is skipped and does not make the latest unknown'), codes(r, 'latest', 'marker') === 'USER NA' && r.user === 1 && r.bot === 1); }
  // a reply that is still changing
  { const turns = [['b', '途中まで書いた返信']], live = read(turns, { quiet: false }), calm = read(turns, { quiet: true });
    t(n('scan differs from the one before: stable CHANGING, not usable'), live.snap.stable === 'CHANGING' && !R.snapUsable(live.snap) && R.snapIssue(live.snap) === 'CHANGING');
    t(n('same scan twice: stable QUIET'), calm.snap.stable === 'QUIET');
    t(n('msgKey leaves stable out (the preload compares scans with it)'), R.msgKey(live) === R.msgKey(calm));
    t(n('text still growing: msgKey changes, so nothing is sent yet'), R.msgKey(read([['b', '途中まで書いた返信と続き']], { quiet: false })) !== R.msgKey(live));
    t(n('quiet is only true when given'), read(turns, { quiet: 'yes' }).snap.stable === 'CHANGING'); }
  // name: h1 / header
  { const r = read([['b', '本文\n' + W]], { h1s: ['Nao-OS with Tibo'], hh: 'Nao-OS Tibo Tibo Jr.' }), id = sleepIdentity({ h1: r.hn, hdr: r.hh });
    t(n('h1 and header differ (group room): name H1, both kept, group as before'), r.snap.name === 'H1' && r.hn === 'Nao-OS with Tibo' && r.hh === 'Nao-OS Tibo Tibo Jr.' && id.group === 'Nao-OS with Tibo'); }
  { const r = read([['b', '本文\n> 依頼\n' + W]], { h1s: ['Tibo', 'Other'] }, ['依頼']);
    t(n('two different h1: name AMBIGUOUS (hn = first h1, as before)'), r.snap.name === 'AMBIGUOUS' && r.hn === 'Tibo' && !R.snapOk(r.snap, 'name'));
    t(n('ambiguous name does not touch the other items'), codes(r, 'conv', 'latest', 'marker', 'quote', 'draft') === 'OK BOT WAIT BLOCK EMPTY' && R.snapUsable(r.snap) && r.q === '依頼'); }
  t(n('no h1: name MISSING, rest usable'), (r => r.snap.name === 'MISSING' && r.hn === '' && R.snapUsable(r.snap))(read([['b', '本文']], { h1s: [] })));
  t(n('the same h1 twice: H1'), codes(read([['b', '本文']], { h1s: ['Tibo', 'Tibo'] }), 'name') === 'H1');
  t(n('first h1 empty: hn stays empty as before'), (r => r.hn === '' && r.snap.name === 'H1')(read([['b', '本文']], { h1s: ['', 'Tibo'] })));
  { const r = read([], { h1s: ['Tibo'] });
    t(n('name valid on its own even when the conversation is unknown'), R.snapOk(r.snap, 'name') && !R.snapOk(r.snap, 'conv')); }
  // quote
  { const r = read([['b', '本文\n> 依頼\n' + W]], {}, null);
    t(n('blockquotes unreadable: quote ERROR, empty, the rest still usable'), r.q === '' && r.snap.quote === 'ERROR' && R.snapUsable(r.snap)); }
  { const long = 'あ'.repeat(500), r = read([['b', '> ' + long + '\n' + W]], {}, [long]);
    t(n('quote at most 300 characters'), r.q.length === R.QUOTE_MAX && R.QUOTE_MAX === 300 && r.snap.quote === 'BLOCK'); }
  t(n('🟢 marker with nothing above it: quote NONE (valid empty)'), (r => r.q === '' && r.snap.quote === 'NONE' && R.snapOk(r.snap, 'quote'))(read([['b', W]])));
  // draft
  t(n('draft codes: present / empty / no composer / error'), ['present', 'empty', 'none', 'error', undefined, 'constructor'].map(d => read([['b', '本文']], { draft: d }).snap.draft).join() === 'PRESENT,EMPTY,NO_COMPOSER,ERROR,ERROR,ERROR');
  t(n('draft unknown does not make the conversation unknown'), R.snapUsable(read([['b', '本文\n' + W]], { draft: 'none' }).snap));
  { const r = read([['b', '本文\n> 依頼\n' + W]], { h1s: ['A', 'B'], draft: 'error' }, null);
    t(n('name, quote and draft all unknown: conversation / marker still usable'), R.snapUsable(r.snap) && codes(r, 'name', 'quote', 'draft') === 'AMBIGUOUS ERROR ERROR'); }
  // before / after: the counting itself is unchanged
  for (const [nm, turns, q, w] of [['wait + quote', [['u', 'a'], ['b', '本文\n> 依頼です\n' + W + '\n' + DT]], ['依頼です'], false], ['question', [['b', 'どちらにしますか？']], [], false],
    ['widget', [['u', 'x'], ['b', '選んでください']], [], true], ['work', [['b', '進捗\n' + K]], [], false], ['done', [['b', 'どうしますか？\n' + F]], [], true],
    ['user last', [['b', W], ['u', 'ok']], [], false], ['many turns', Array.from({ length: 30 }, (_, i) => [i % 3 ? 'b' : 'u', `turn ${i}`]), [], false]]) {
    t(n(`same counts / flags / quote / fingerprint as before: ${nm}`), J(counts(read(turns, {}, q, w))) === J(legacy(turns, 'Tibo', 'Tibo', q, w)));
  }
  // the codes themselves
  t(n('every code is a fixed upper-case word; every item has a valid and an unknown code'), Object.entries(R.SNAP).every(([k, m]) => /^[a-z]+$/.test(k) && Object.keys(m).every(c => /^[A-Z][A-Z0-9_]*$/.test(c))
    && Object.values(m).some(v => v === true) && Object.values(m).some(v => v === false) && Object.values(m).every(v => typeof v === 'boolean')));
  t(n('a snapshot holds codes only (no scores / percentages)'), Object.values(read([['b', '本文\n' + W]]).snap).every(v => typeof v === 'string') && Object.keys(read([]).snap).join() === 'cid,' + Object.keys(R.SNAP).join());
  t(n('snapOk: nothing / junk / inherited names are not valid'), [null, undefined, 'OK', 5, {}, { conv: '__proto__' }, { conv: 'toString' }, { conv: 'ok' }].every(s => !R.snapOk(s, 'conv')) && !R.snapOk({ conv: 'OK' }, 'toString') && !R.snapOk({ constructor: 'OK' }, 'constructor'));
  t(n('junk input never throws: no facts / null entries / no last'), (() => { try { const a = R.readConversation(), b = R.readConversation({ cid: 'x', entries: [{ user: false, blank: false }, null], quiet: true });
    return a.snap.conv === 'DOM_UNKNOWN' && b.snap.latest === 'PARTIAL' && b.bot === 1; } catch { return false; } })());
  t(n('snapIssue of nothing: DOM_UNKNOWN'), R.snapIssue(null) === 'DOM_UNKNOWN' && R.snapIssue({}) === 'DOM_UNKNOWN' && R.snapIssue({ conv: '__proto__' }) === 'DOM_UNKNOWN');
}
t('the preload copy gives byte-identical reports', [[[['u', 'a'], ['b', '本文\n' + W]]], [[]], [[['b', 'x'], ['', '']], { quiet: false, h1s: ['A', 'B'], draft: 'none' }]].every(a => J(rules.readConversation(facts(...a))) === J(pre.readConversation(facts(...a)))));
t('preload has the shared functions built in (same source)', ['readConversation', 'snapIssue', 'requestQuoteSrc'].every(k => pre[k].toString() === rules[k].toString()));
t(`every snapIssue result is a diagnostics code (${[...seenIssues].filter(Boolean).sort().join(' ')})`, [...seenIssues].every(c => c === '' || DG.DOM_CODES.includes(c)) && DG.DOM_CODES.every(c => DG.EVENTS.dom.r.includes(c)));
t('every unknown conv code is a diagnostics code', Object.keys(rules.SNAP.conv).filter(c => !rules.SNAP.conv[c]).every(c => DG.DOM_CODES.includes(c)));

// ---- the preload's DOM reader on a synthetic document ----
function block({ text = '', user = false, quotes = [], widget = false } = {}) {
  const kids = [], e = { textContent: text, innerText: text, kids, parentElement: null,
    closest: s => { for (let a = e; a; a = a.parentElement) if (a.isBlock && s === '[class*="group/bot-entry"]') return a; return null; }, isBlock: true, contains: o => o === e || kids.some(k => k.contains(o)),
    querySelector: s => (s === '[data-testid="user-message"]' ? (user ? {} : null) : /role="radio"/.test(s) ? (widget ? {} : null) : null),
    querySelectorAll: s => (s === 'blockquote' ? quotes.map(q => ({ innerText: q, textContent: q })) : []) };
  return e;
}
const COMPOSER = 'textarea, [contenteditable="true"], [contenteditable=""]';
const field = (value = '') => ({ tagName: 'TEXTAREA', value, tabIndex: 0, getAttribute: () => null, closest: () => null, parentElement: { parentElement: { querySelector: () => null } } });
function page(o = {}) {
  const st = { body: 0 };
  const doc = { readyState: o.ready || 'complete', documentElement: null,
    get body() { st.body++; return { innerText: 'NOT TO BE READ', textContent: 'NOT TO BE READ' }; },
    querySelectorAll: s => (s === '[class*="group/bot-entry"]' ? o.blocks || [] : s === 'h1' ? (o.h1 || []).map(x => ({ innerText: x, textContent: x })) : s === COMPOSER ? o.composer || [] : []),
    querySelector: s => (s === 'header' ? (o.header == null ? null : { innerText: o.header, textContent: o.header }) : s === 'input[type="password"]' ? (o.password ? {} : null) : null) };
  const p = loadPreload(), sent = [];
  vm.runInContext('ipcRenderer', p.ctx).send = (ch, payload) => sent.push([ch, payload]);
  p.ctx.document = doc; p.ctx.location = { hostname: 'grok.com', pathname: o.path || '/bot/bot1' };
  const run = src => vm.runInContext(src, p.ctx);
  return { p, sent, st, doc, run, check: () => run('check()'), scan: () => run('scanMessages()') };
}
const sender = role => ({ role, frame: { top: true, detached: false, url: 'https://grok.com/bot/bot1', origin: 'https://grok.com' } });
const world = { owned: true, pane: () => true, fav: () => false, ws: () => false, winPane: () => false };
{ const outer = block({ text: '本文です\n> 次の作業を指示してください\n' + W, quotes: ['次の作業を指示してください'] }), inner = block({ text: '本文です' });
  outer.kids.push(inner); inner.parentElement = outer;
  const pg = page({ blocks: [block({ text: '依頼します', user: true }), outer, inner], h1: ['Tibo'], header: 'Tibo', composer: [field('')] });
  pg.check();
  t('dom: first scan sends nothing (waits for a second, equal scan)', pg.sent.length === 0);
  pg.check();
  const [ch, c] = pg.sent[0] || [];
  t('dom: second equal scan sends one pane:msgcount', pg.sent.length === 1 && ch === 'pane:msgcount');
  t('dom: nested blocks count once (outermost only)', c && c.user === 1 && c.bot === 1 && c.botSince === 1);
  t('dom: report = counts + quote + heading + snapshot', c && c.waiting && c.q === '次の作業を指示してください' && c.hn === 'Tibo' && c.hh === 'Tibo'
    && J(c.snap) === J({ cid: 'bot1', conv: 'OK', roles: 'TESTID', latest: 'BOT', marker: 'WAIT', stable: 'QUIET', draft: 'EMPTY', name: 'H1', quote: 'BLOCK' }));
  t('dom: the report passes the IPC gate (pane and probe) and keeps its snapshot', IPC.check('pane:msgcount', sender('pane'), [c], world) === null && IPC.check('pane:msgcount', sender('probe'), [c], world) === null
    && J(IPC.msgCount(c).snap) === J(c.snap));
  pg.check();
  t('dom: unchanged page: nothing more is sent', pg.sent.length === 1);
  t('dom: document.body is never read', pg.st.body === 0);
  t('dom: scan reads no visibility / geometry on the bot-entry path (turns scrolled out of view count)', !/getBoundingClientRect|getComputedStyle|offset(Width|Height|Top)/.test(pg.run('scanMessages.toString() + readConversation.toString()'))); }
{ const pg = page({ blocks: [], h1: [] });
  pg.check(); pg.check();
  const c = pg.sent[0] && pg.sent[0][1];
  t('dom: no conversation on the page: a report that says DOM_UNKNOWN (not an empty chat)', c && c.method === 'none' && c.snap.conv === 'DOM_UNKNOWN' && c.snap.roles === 'NONE' && !rules.snapUsable(c.snap)
    && IPC.check('pane:msgcount', sender('pane'), [c], world) === null);
  t('dom: no conversation: body still not read', pg.st.body === 0); }
t('dom: still loading -> LOADING, password field -> AUTH_REQUIRED', page({ ready: 'interactive' }).run('readConversation(scanMessages())').snap.conv === 'LOADING'
  && page({ password: true }).run('readConversation(scanMessages())').snap.conv === 'AUTH_REQUIRED');
{ const pg = page({ blocks: [block({ text: '本文\n' + W })], h1: ['Tibo'], composer: [field('書きかけ')] });
  t('dom: typed text in the composer -> draft PRESENT', pg.run('readConversation(scanMessages())').snap.draft === 'PRESENT');
  t('dom: no composer -> draft NO_COMPOSER (unknown), conversation still usable', (r => r.snap.draft === 'NO_COMPOSER' && rules.snapUsable({ ...r.snap, stable: 'QUIET' }))(page({ blocks: [block({ text: '本文\n' + W })] }).run('readConversation(scanMessages())'))); }
{ const b = block({ text: '書いている途中' }), pg = page({ blocks: [block({ text: 'q', user: true }), b] });
  pg.check(); b.textContent = b.innerText = '書いている途中、さらに続き'; pg.check();
  t('dom: text changed between the two scans: nothing sent yet', pg.sent.length === 0);
  pg.check();
  t('dom: then two equal scans: sent, stable QUIET', pg.sent.length === 1 && pg.sent[0][1].snap.stable === 'QUIET'); }
{ const pg = page({ blocks: [block({ text: '質問', user: true }), block({ text: '本文\n' + W }), block({ text: '   ' })] });
  t('dom: an empty newest block -> latest PARTIAL', pg.run('readConversation(scanMessages())').snap.latest === 'PARTIAL'); }
t('dom: the bot id is taken from the path', page({ blocks: [block({ text: 'x' })], path: '/bot/Ab_9-z/extra' }).run('scanMessages()').cid === 'Ab_9-z'
  && page({ blocks: [block({ text: 'x' })], path: '/bot/' }).run('readConversation(scanMessages())').snap.conv === 'DOM_UNKNOWN');

// ---- main uses the snapshot (contract with src/main.js) ----
{ const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const fn = name => { const i = main.indexOf(`function ${name}(`); if (i < 0) return ''; let d = 0, j = main.indexOf('{', i); for (; j < main.length; j++) { if (main[j] === '{') d++; else if (main[j] === '}' && --d === 0) break; } return main.slice(i, j + 1); };
  const om = fn('onMsgCount'), cs = fn('canSleep'), pp = fn('probePane'), rc = fn('resetCounts');
  t('main: takes the snapshot rules from the shared rules (no copy of its own)', /const \{ snapOk, snapUsable, snapIssue \} = require\('\.\/pane-rules'\);/.test(main) && !/function readConversation|const SNAP\b/.test(main));
  t('main: a report about another bot than the pane shows is dropped', /s\.cid !== botIdOf\(wc\.getURL\(\)\)\) \{ diag\.rec\('dom', 'OTHER_CONV'/.test(om));
  const gate = om.indexOf("if (!snapOk(s, 'conv') || !snapOk(s, 'roles'))");
  t('main: no confirmed conversation -> return before anything is applied (no reset to 0, no "nothing new")', gate > 0 && om.indexOf('p.snap = s;') < gate && om.indexOf('return;', gate) < om.indexOf('p.msgMode = true')
    && om.indexOf('p.unread = c.botSince') > gate);
  t('main: the name is kept only when unambiguous (live pane and background check)', /if \(c\.hn && snapOk\(s, 'name'\)\)/.test(om) && /if \(last\.hn && snapOk\(last\.snap, 'name'\)\)/.test(pp));
  t('main: auto-sleep needs a usable snapshot of the current conversation (manual sleep unchanged)', /if \(!force && !\(snapUsable\(p\.snap\) && p\.snap\.cid === botIdOf\(wc\.getURL\(\)\)\)\) return false;/.test(cs));
  t('main: background check counts only confirmed conversations and compares only usable ones', /if \(snapOk\(c\.snap, 'conv'\) && snapOk\(c\.snap, 'roles'\)\) \{ last = c; lastAt = Date\.now\(\); \} else \{ last = null;/.test(pp)
    && /if \(!snapUsable\(last\.snap\) \|\| last\.snap\.cid !== id\) \{/.test(pp) && pp.indexOf("diag.rec('probe', 'UNSURE'") > 0 && pp.indexOf("diag.rec('probe', 'UNSURE'") < pp.indexOf("type: 'probe-result'"));
  t('main: the snapshot is forgotten on navigation and reset (never carried to a new page)', /wc\.on\('did-navigate', \(\) => \{ if \(p\.sleeping\) return; p\.snap = null;/.test(main) && /p\.snap = null;/.test(rc));
  t('main: the draft guard holds (reported draft blocks auto-sleep; final live check through the #11 input guard before sleep)', /if \(!force && p\.hasDraft\) return false;/.test(cs)
    && /const r = await liveInput\(p\);[\s\S]{0,300}if \(autoGate\(p, r, 'sleep'\) && canSleep\(p, panes\.indexOf\(p\)\)\) sleepPane\(p\);/.test(main));
  const lit = [...main.matchAll(/diag\.rec\('dom', '([A-Z_]+)'/g)].map(m => m[1]);
  t(`main: literal dom codes are known (${lit.join(' ')})`, lit.length >= 2 && lit.every(c => DG.DOM_CODES.includes(c)) && DG.EVENTS.probe.r.includes('UNSURE'));
  t('main: the snapshot is not saved to panes.json', !/snap:/.test(fn('paneSpec') || main.slice(main.indexOf('const paneSpec'), main.indexOf('\n', main.indexOf('const paneSpec')))));
}
console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
