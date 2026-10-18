// Rules shared by the pane preload and main (unit-tested in test/marker.test.js and test/quote.test.js). This file is the only copy to edit.
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
function requestQuote(fullText, blockquoteTexts) {
  const full = String(fullText || ''), nf = full.replace(/[\s\u3000]+/g, ''), tailRe = new RegExp('^-*' + WAIT_CORE);
  for (let i = (blockquoteTexts || []).length - 1; i >= 0; i--) {
    const q = String(blockquoteTexts[i] || '').trim(), nq = q.replace(/[\s\u3000]+/g, ''); if (!nq) continue;
    const at = nf.lastIndexOf(nq); if (at < 0) continue;
    if (tailRe.test(normMark(nf.slice(at + nq.length)))) return clipQuote(q.replace(/^>[ \t]*/gm, ''));   // only a quote that sits immediately above the marker
  }
  const lines = full.split('\n').map(l => l.trim());       // fallback: the line(s) just above the marker
  let mi = -1; for (let i = lines.length - 1; i >= 0; i--) if (WAIT_ANY.test(normMark(lines[i]))) { mi = i; break; }
  if (mi < 0) return '';
  const out = [];
  for (let i = mi - 1; i >= 0 && out.length < 3; i--) {
    const l = lines[i];
    if (!l || /^[-─━=*_\s]+$/.test(l)) { if (out.length) break; continue; }
    out.unshift(l.replace(/^>[ \t]*/, ''));
  }
  return clipQuote(out.join('\n'));
}
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
// Composer holds typed text / a pending attachment? (blocks auto-sleep). Also run by main in the live page right before a pane sleeps,
// as source text (DRAFT_JS below), so it must only use the page's globals - nothing else declared in this file.
function composerDraft() {
  const els = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]'));
  for (const e of els) {
    if (e.getAttribute('aria-hidden') === 'true' || e.tabIndex < 0 && e.tagName === 'TEXTAREA') continue;   // autosize mirror textarea (value 'x')
    const txt = e.tagName === 'TEXTAREA' ? e.value : (e.innerText || e.textContent || '');
    if (String(txt).trim().length > 0) return true;
    const box = e.closest('form') || (e.parentElement && e.parentElement.parentElement);
    if (box && box.querySelector('img[src^="blob:"], [data-testid*="attachment-preview" i], [data-testid*="file-preview" i]')) return true;
  }
  return false;
}
// SHARED-END
const DRAFT_JS = `(${composerDraft})()`;
module.exports = { QUOTE_MAX, markerOf, clipQuote, requestQuote, looksAsking, composerDraft, DRAFT_JS };
