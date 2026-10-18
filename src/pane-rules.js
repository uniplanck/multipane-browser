// Rules shared by the pane preload and main (unit-tested in test/marker.test.js, test/quote.test.js and test/dom-adapter.test.js). This file is the only copy to edit.
// The pane preload is sandboxed and cannot require local files, so scripts/build-pane-preload.js copies the marked block below
// into src/pane-preload.js at build time: after editing, run `npm run build:preload` (`npm run check:preload` verifies).
// Inside the block: plain declarations only (it runs in the page's isolated world) - no require / module / process / Node APIs.
// SHARED-BEGIN
// Closing markers of the latest bot message. Text is whitespace-stripped (incl. full-width space); heavy bars -> '-'; bold/backticks/brackets are dropped.
//   waiting (green) : 🟢 ━━ 《 待機中 》 ━━ 🟢   (+ 待機中30/60 follow-ups; old wordings 入力待機中 / 入力待ち / 出力待ち and the ◆ variants still count)
//   done (purple)   : 🟣 ━━ ［ 終　了 ］ ━━ 🟣   (nothing left to do / phase finished)
//   working (red)   : 🔴 ━━ 【 作業中 】 ━━ 🔴
// Allowed after the marker (end of message only): --- rules, a ◆ yyyy-MM-dd hh:mm ◆ stamp (same line or separate lines).
const normMark = t => String(t || '').replace(/[\s\u3000]+/g, '').replace(/[ー－—–─━―]/g, '-').replace(/[*`_【】\[\]「」『』()（）《》〈〉［］｛｝{}<>]/g, '');
const WAIT_CORE = '(?:◆-*(?:[入出]力待ち|(?:入力)?待機中)(?:30|60)?-*◆|🟢-*(?:入力)?待機中(?:30|60)?-*🟢)';
const WORK_CORE = '🔴-*作業中-*🔴';
const DONE_CORE = '🟣-*終了-*🟣';
const MARK_TAIL = '(?:-+|◆[^◆]{0,40}◆)*';
const WAIT_ANY = new RegExp(WAIT_CORE), WAIT_END = new RegExp(WAIT_CORE + MARK_TAIL + '$'), WORK_END = new RegExp(WORK_CORE + MARK_TAIL + '$'), DONE_END = new RegExp(DONE_CORE + MARK_TAIL + '$');
// -> 'wait' | 'work' | 'done' | null, judged only at the very end (last ~300 chars) of the message; the latest marker wins
function markerOf(text) {
  const t = normMark(text).slice(-300);
  let best = null, at = -1;
  for (const [k, re] of [['wait', WAIT_END], ['work', WORK_END], ['done', DONE_END]]) { const m = re.exec(t); if (m && m.index > at) { at = m.index; best = k; } }
  return best;
}
// The "request" a 🟢 待機中 reply leaves for the user: the <blockquote> right above the marker (layout: --- / blank / > text / blank / marker).
// Pure functions: fullText = the entry's text, blockquoteTexts = texts of its <blockquote> elements in document order.
const QUOTE_MAX = 300;
const clipQuote = t => { t = String(t || '').replace(/[ \t\u3000]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); return t.length > QUOTE_MAX ? t.slice(0, QUOTE_MAX - 1) + '…' : t; };
// -> { q: the quote, src: 'block' (a <blockquote> right above the marker) | 'lines' (the line(s) just above it) | '' (none) }
function requestQuoteSrc(fullText, blockquoteTexts) {
  const full = String(fullText || ''), nf = full.replace(/[\s\u3000]+/g, ''), tailRe = new RegExp('^-*' + WAIT_CORE);
  for (let i = (blockquoteTexts || []).length - 1; i >= 0; i--) {
    const q = String(blockquoteTexts[i] || '').trim(), nq = q.replace(/[\s\u3000]+/g, ''); if (!nq) continue;
    const at = nf.lastIndexOf(nq); if (at < 0) continue;
    if (tailRe.test(normMark(nf.slice(at + nq.length)))) { const c = clipQuote(q.replace(/^>[ \t]*/gm, '')); return { q: c, src: c ? 'block' : '' }; }   // only a quote that sits immediately above the marker
  }
  const lines = full.split('\n').map(l => l.trim());       // fallback: the line(s) just above the marker
  let mi = -1; for (let i = lines.length - 1; i >= 0; i--) if (WAIT_ANY.test(normMark(lines[i]))) { mi = i; break; }
  if (mi < 0) return { q: '', src: '' };
  const out = [];
  for (let i = mi - 1; i >= 0 && out.length < 3; i--) {
    const l = lines[i];
    if (!l || /^[-─━=*_\s]+$/.test(l)) { if (out.length) break; continue; }
    out.unshift(l.replace(/^>[ \t]*/, ''));
  }
  const c = clipQuote(out.join('\n'));
  return { q: c, src: c ? 'lines' : '' };
}
function requestQuote(fullText, blockquoteTexts) { return requestQuoteSrc(fullText, blockquoteTexts).q; }
// Does the latest bot message wait for the user? (explicit marker / question / choice widget / asking phrases)
function looksAsking(text, hasWidget) {
  const raw = String(text || '');
  const flat = raw.replace(/[\s\u3000]+/g, '').replace(/[ー－—–─━―]/g, '-');
  const mk = markerOf(raw);
  if (mk === 'work' || mk === 'done') return false;       // latest marker says: still working / finished (nothing to answer)
  if (mk === 'wait' || WAIT_ANY.test(flat.slice(-300))) return true;
  if (hasWidget) return true;
  const lines = raw.split(/\n/).map(l => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  if (/[?？][)）」』"'”’\s]*$/.test(last)) return true;
  const tail = raw.replace(/\s+/g, '').slice(-200);
  return /教えてください|どちら|確認してください|よろしいですか/.test(tail);
}
// What the composer holds (#11). Read by the preload (draft report / snapshot) and by main in the live page right before an operation that
// throws the page away (sleep / reload / close / another URL ...), as source text (COMPOSER_JS below), so it must only use the page's
// globals - nothing else declared in this file.
// -> { d: 'present' (typed text or a pending attachment) | 'empty' | 'none' (no composer on the page), text, att: an attachment preview,
//      up: an upload progress indicator next to an attachment, n: composers, fp: a short hash of what they hold (never the text itself) }
function composerState() {
  const els = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]'));
  let n = 0, text = false, att = false, up = false, h = 5381;
  for (const e of els) {
    if (e.getAttribute('aria-hidden') === 'true' || e.tabIndex < 0 && e.tagName === 'TEXTAREA') continue;   // autosize mirror textarea (value 'x')
    n++;
    const txt = String((e.tagName === 'TEXTAREA' ? e.value : (e.innerText || e.textContent || '')) || '');
    if (txt.trim().length > 0) text = true;
    const box = e.closest('form') || (e.parentElement && e.parentElement.parentElement);
    const a = !!(box && box.querySelector('img[src^="blob:"], [data-testid*="attachment-preview" i], [data-testid*="file-preview" i]'));
    if (a) { att = true; if (box.querySelector('[role="progressbar"], progress')) up = true; }
    const s = n + '|' + txt + '|' + (a ? 1 : 0);
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return { d: text || att ? 'present' : n ? 'empty' : 'none', text, att, up, n, fp: h.toString(36) };
}
// Composer holds typed text / a pending attachment? (blocks auto-sleep)
function composerDraft() { return composerState().d === 'present'; }
// ---- conversation snapshot (#03): what one scan of the page is sure about, item by item ----
// Each item is one fixed code; SNAP says whether that code is a valid reading (true) or unknown (false), and the code is the reason.
// No scores: a reading comes from a confirmed structure of the page, or it is unknown.
const SNAP = {
  conv: { OK: true, LOADING: false, AUTH_REQUIRED: false, DOM_UNKNOWN: false },      // the conversation of the page's /bot/<id>: bot-entry blocks with text
  roles: { TESTID: true, GUESS: false, NONE: false },                     // user turn = [data-testid="user-message"] in the block / generic guesses / no turns
  latest: { BOT: true, USER: true, PARTIAL: false, NONE: false },         // the newest block (PARTIAL: it is there but has no text yet)
  marker: { WAIT: true, WORK: true, DONE: true, NONE: true, NA: true, UNKNOWN: false },   // last marker of the latest bot block (NA: the user spoke last)
  stable: { QUIET: true, CHANGING: false },                               // same report in two scans >= 1.2 s apart - NOT proof that a reply is finished
  draft: { EMPTY: true, PRESENT: true, NO_COMPOSER: false, ERROR: false },
  name: { H1: true, MISSING: false, AMBIGUOUS: false },                   // one page heading (h1) text; the header text goes with it
  quote: { BLOCK: true, LINES: true, NONE: true, NA: true, UNKNOWN: false, ERROR: false },   // the request above a 🟢 marker (NA: no 🟢 marker)
};
const snapOk = (s, k) => !!s && typeof s === 'object' && Object.hasOwn(SNAP, k) && SNAP[k][s[k]] === true;
// may main act on it (auto-sleep, a sleeping pane's 'new / nothing new')? Name, quote and draft are separate and do not count here
const snapUsable = s => ['conv', 'roles', 'latest', 'marker', 'stable'].every(k => snapOk(s, k));
// -> '' (usable) or the fixed reason it is not (a diagnostics code)
function snapIssue(s) {
  if (!snapOk(s, 'conv')) {                                 // only generic guesses found (e.g. a sidebar list) -> ROLE_GUESS; login / loading evidence wins over it
    const c = s && typeof s === 'object' && SNAP.conv[s.conv] === false ? s.conv : 'DOM_UNKNOWN';
    return c === 'DOM_UNKNOWN' && s && s.roles === 'GUESS' ? 'ROLE_GUESS' : c;
  }
  if (!snapOk(s, 'roles')) return 'ROLE_GUESS';
  if (!snapOk(s, 'latest') || !snapOk(s, 'marker')) return 'LATEST_PARTIAL';
  return snapOk(s, 'stable') ? '' : 'CHANGING';
}
// The page as the pane preload read it -> the report for main: the same counts / flags / quote / heading / fingerprint as before, plus `snap`.
// f = { cid: bot id from the path ('' = none), ready: document loaded, auth: a password field is on the page (the only login evidence used),
//   entries: every outermost bot-entry block in document order, blank ones too: [{ user: has the user-message testid, blank: no text }],
//   last: the latest block with text: { text: textContent, inner: innerText, quotes: its blockquote texts (null = unreadable), widget: has a choice widget }
//         (inner / quotes / widget only when it is not the user's),
//   guess: counts from the generic selector / geometry guesses, only when there is no bot-entry block with text (or null),
//   h1s: texts of every h1 in order, hh: text of the first header, draft: 'present' | 'empty' | 'none' (no composer) | 'error', quiet: same report as the scan before }
function readConversation(f) {
  f = f || {};
  const all = Array.isArray(f.entries) ? f.entries : [], ents = all.filter(e => e && !e.blank), cid = String(f.cid || '');
  const h1s = Array.isArray(f.h1s) ? f.h1s.map(h => String(h || '')) : [], named = h1s.filter(Boolean);
  const draft = f.draft === 'present' ? 'PRESENT' : f.draft === 'empty' ? 'EMPTY' : f.draft === 'none' ? 'NO_COMPOSER' : 'ERROR';
  const snap = { cid, conv: 'DOM_UNKNOWN', roles: 'NONE', latest: 'NONE', marker: 'UNKNOWN', stable: f.quiet === true ? 'QUIET' : 'CHANGING', draft,
    name: !named.length ? 'MISSING' : new Set(named).size > 1 ? 'AMBIGUOUS' : 'H1', quote: 'UNKNOWN' };
  let r;
  if (ents.length) {
    let user = 0, bot = 0, botSince = 0;
    for (const e of ents) { if (e.user) { user++; botSince = 0; } else { bot++; botSince++; } }
    const x = f.last || {}, text = String(x.text || ''), inner = String(x.inner || text);
    const t = text.replace(/[\s\u3000]+/g, '').replace(/[ー－—–─━―]/g, '-');
    const asks = botSince > 0 && looksAsking(inner, !!x.widget), mk = botSince > 0 ? markerOf(text) : null;
    // fingerprint of the latest entry (tail of its text) so the app can tell whether a sleeping pane got something new
    let h = 5381; const tail = t.slice(-400); for (let i = 0; i < tail.length; i++) h = ((h * 33) ^ tail.charCodeAt(i)) >>> 0;
    let q = '', src = '';
    if (mk === 'wait') { if (Array.isArray(x.quotes)) { try { ({ q, src } = requestQuoteSrc(inner, x.quotes)); } catch { q = ''; src = 'error'; } } else src = 'error'; }
    r = { user, bot, botSince, waiting: mk === 'wait', working: mk === 'work', done: mk === 'done', q, hn: h1s[0] || '', hh: String(f.hh || ''),
      asks: asks && mk !== 'work' && mk !== 'done', method: 'bot-entry', fp: h.toString(36) + '.' + t.length };
    if (cid) {
      snap.conv = 'OK'; snap.roles = 'TESTID';
      const newest = all[all.length - 1];
      snap.latest = !newest || newest.blank ? 'PARTIAL' : botSince > 0 ? 'BOT' : 'USER';
      snap.marker = snap.latest === 'USER' ? 'NA' : snap.latest === 'BOT' ? (mk ? mk.toUpperCase() : 'NONE') : 'UNKNOWN';
      snap.quote = snap.marker === 'WAIT' ? (src === 'block' ? 'BLOCK' : src === 'lines' ? 'LINES' : src === '' ? 'NONE' : 'ERROR') : snap.marker === 'UNKNOWN' ? 'UNKNOWN' : 'NA';
    }
  } else {
    // no conversation block on the page: never 'an empty conversation' - loading / login / sidebar only / changed page are all unknown
    r = f.guess && typeof f.guess === 'object' ? { ...f.guess } : { user: 0, bot: 0, botSince: 0, waiting: false, working: false, done: false, asks: false, method: 'none' };
    if (f.guess) snap.roles = 'GUESS';
    snap.conv = f.auth ? 'AUTH_REQUIRED' : f.ready === false ? 'LOADING' : 'DOM_UNKNOWN';
  }
  r.snap = snap;
  return r;
}
// two reports are the same (the preload sends one only after two equal scans >= 1.2 s apart, and only when it changed); snap.stable is left out
const msgKey = c => [c.user, c.bot, c.botSince, c.waiting, c.working, c.done, c.asks, c.fp || '', c.q || '',
  c.snap ? Object.keys(SNAP).filter(k => k !== 'stable').map(k => c.snap[k]).join(',') + ',' + c.snap.cid : ''].join('/');
// SHARED-END
const COMPOSER_JS = `(${composerState})()`;
module.exports = { QUOTE_MAX, markerOf, clipQuote, requestQuote, requestQuoteSrc, looksAsking, composerState, composerDraft, COMPOSER_JS, SNAP, snapOk, snapUsable, snapIssue, readConversation, msgKey };
