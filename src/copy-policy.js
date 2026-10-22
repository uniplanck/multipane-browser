// 選択部分だけコピー (unit-tested in test/copy-policy.test.js). Pure: main.js passes the before-input-event Input and what the pane's preload
// reported (a selection in the page outside any field, an IME composition), then the selection text it read in its own world and the clipboard
// after the page's copy; main does the copy itself (makeWindow: copySel).
//   ⌘C (only ⌘; Ctrl elsewhere) with a selection in the page: main takes the key (the page never sees it) and runs the page's normal copy
//   (wc.copy: its copy event as usual). A clipboard that is clearly not that selection afterwards (nothing / much longer, e.g. the whole message /
//   much shorter) gets the selection as plain text. The right-click コピー goes the same way.
// Left as before: no selection (the key reaches the page), a selection inside a field (input / textarea / contenteditable: the browser's own
// copy), an IME composition or not known whether one runs, any other modifier (⌘⇧C ⌘⌥C ...).
const WORLD = 1005;               // main.js: the isolated world that reads the selection (1001-1004 are taken)
const READ_MS = 500;              // the selection read gives up after this (the page busy): the page's copy alone, as before
const WAIT_MS = 800, STEP_MS = 40; // how long / how often main looks for the page's copy on the clipboard
const LONGER = 1.2, SLACK = 10;   // longer than the selection by more than this (whitespace aside) = clearly not the selection
// run in WORLD: the page's selection as text ('' = none / inside a field: input / textarea selections are not part of it)
const SEL_JS = '(() => { const s = document.getSelection(); return s ? String(s) : ""; })()';

// a before-input-event Input -> true: main copies the selection itself. mac: ⌘ is the modifier (Ctrl elsewhere); sel: the pane reported a
// selection outside any field; ime: the pane reported a composition
function copyKey(input, opts) {
  const { mac = true, sel = false, ime = false } = opts || {};
  if (!input || typeof input !== 'object' || input.type !== 'keyDown' || sel !== true) return false;
  const key = String(input.key || ''), k = key.toLowerCase(), code = String(input.code || '');
  const mod = mac ? input.meta === true && input.control !== true : input.control === true && input.meta !== true;
  if (!mod || input.alt === true || input.shift === true) return false;
  if (k !== 'c' && (/^[a-z]$/.test(k) || code !== 'KeyC')) return false;   // a kana / other layout: the C key
  const composing = input.isComposing !== false || key === 'Process' || input.keyCode === 229 || ime === true;   // not reported = not known
  return !composing;
}

// text as compared: whitespace runs (newlines, NBSP, zero-width) as one space, trimmed
const norm = s => String(s == null ? '' : s).replace(/[\s\u200b-\u200d\u2060]+/g, ' ').trim();
// the clipboard text is clearly not the selection: nothing, much longer (the whole message or more) or much shorter
function differs(clip, sel) {
  const c = norm(clip), s = norm(sel);
  if (!s || c === s) return false;
  return !c || c.length > s.length * LONGER + SLACK || c.length * 2 < s.length;
}
// sel: the page's selection (read before the copy), clip: the clipboard text after it, changed: the clipboard changed meanwhile -> the text to
// write instead (plain), or null (the page's copy stands). Not changed: the copy never reached the clipboard (or wrote what was there already)
function fix(r) {
  const { sel, clip, changed } = r || {};
  const s = typeof sel === 'string' ? sel : '';
  if (!norm(s)) return null;                                   // nothing to compare with
  if (changed !== true) return norm(clip) === norm(s) ? null : s;
  return differs(clip, s) ? s : null;
}

module.exports = { WORLD, READ_MS, WAIT_MS, STEP_MS, LONGER, SLACK, SEL_JS, copyKey, norm, differs, fix };
