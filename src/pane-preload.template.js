// Preload for web content panes. Exposes NOTHING to the page (no contextBridge);
// it observes the DOM from the isolated world; draft text goes only to main's private draft store. Restore only types, never sends.
const { ipcRenderer, webFrame } = require('electron');

// Cover the new document canvas until its own styles have painted. Normal user-origin CSS yields to the page's author styles.
// paneBackgroundCss / paneBackgroundShouldRemove are hoisted from the shared block built into this sandboxed preload.
try {
  if (process.isMainFrame !== false && window.top === window && (/^https?:$/.test(location.protocol) || (location.protocol === 'about:' && location.pathname === 'blank'))) {
    const bgKey = webFrame.insertCSS(paneBackgroundCss(window.matchMedia('(prefers-color-scheme: dark)').matches), { cssOrigin: 'user' });
    try {
      let loaded = false, frames = 0, removed = false;
      const finish = timedOut => {
        try {
          if (removed || !paneBackgroundShouldRemove(loaded, frames, timedOut)) return;
          removed = true;
          try { clearTimeout(safety); } catch {}
          try { webFrame.removeInsertedCSS(bgKey); } catch {}
        } catch {}
      };
      const safety = setTimeout(() => finish(true), 15000);
      const afterLoad = () => {
        try {
          loaded = true;
          requestAnimationFrame(() => {
            try {
              if (removed) return;
              frames++;
              requestAnimationFrame(() => { try { frames++; finish(false); } catch {} });
            } catch {}
          });
        } catch {}
      };
      if (document.readyState === 'complete') afterLoad();
      else window.addEventListener('load', afterLoad, { once: true });
    } catch { try { webFrame.removeInsertedCSS(bgKey); } catch {} }
  }
} catch {}

let lastLen = -1, timer = null;

// ---------- grok.com chat message counting ----------
// grok.com/bot turns are read by scanMessages (DOM -> plain data) and judged by readConversation (shared rules): counts + a snapshot whose items
// are each valid or unknown (#03). The heuristics below are the older generic guesses, used only without bot-entry blocks (their result is
// marked GUESS = unknown). They count discrete message elements (a streaming reply is one element => counted once) and
// classify each as user/bot, most reliable signal first:
//   1. explicit attributes: data-message-author-role / data-role / data-author / data-testid / aria-label
//   2. class hints: "user"/"human" vs "assistant"/"bot"/"response"; flex alignment items-end/justify-end
//   3. geometry: bubble right-aligned (its right edge near the chat's right, left edge well
//      right of the chat's left) and narrow => user; otherwise bot.
const grokChat = () => location.hostname === 'grok.com' && /^\/bot\//.test(location.pathname);
const MSG_SEL = [
  '[data-message-author-role]', '[data-testid*="message" i]', '[data-role="user"]', '[data-role="assistant"]',
  '.message-bubble', '[class*="message-bubble"]', '[class*="MessageBubble"]', '[id^="response-"]',
  '[aria-label*="message" i]', '[aria-label*="メッセージ"]',
].join(',');
const USER_RE = /\b(user|human|you|self|own|sent|outgoing)\b|ユーザー|あなた/i;
const BOT_RE = /\b(assistant|bot|ai|grok|model|response|incoming|agent)\b/i;
function attrRole(el) {
  for (let e = el, d = 0; e && d < 4; e = e.parentElement, d++) {
    for (const a of ['data-message-author-role', 'data-role', 'data-author', 'data-sender', 'data-testid', 'aria-label']) {
      const v = e.getAttribute && e.getAttribute(a);
      if (!v) continue;
      if (USER_RE.test(v)) return 'user';
      if (BOT_RE.test(v)) return 'bot';
    }
  }
  return null;
}
function classRole(el) {
  for (let e = el, d = 0; e && d < 4; e = e.parentElement, d++) {
    const c = typeof e.className === 'string' ? e.className : '';
    if (/\b(items-end|justify-end|self-end|ml-auto|flex-row-reverse)\b/.test(c)) return 'user';
    if (/\b(items-start|justify-start|self-start)\b/.test(c) && d > 0) return 'bot';
    if (/(^|[\s_-])(user|human)([\s_-]|$)/i.test(c)) return 'user';
    if (/(^|[\s_-])(assistant|bot|response)([\s_-]|$)/i.test(c)) return 'bot';
  }
  return null;
}
function chatBox(els) {
  // the common scroll container of the messages, or <main>, or the viewport right of the sidebar
  const m = document.querySelector('main');
  const r = (m || document.documentElement).getBoundingClientRect();
  return { left: Math.max(r.left, 60), right: r.right || innerWidth };
}
function styleRole(el) {
  // computed flex alignment on the element or its single-child chain (wrapper -> bubble)
  for (let e = el, d = 0; e && d < 4; e = e.children.length === 1 ? e.children[0] : null, d++) {
    const cs = getComputedStyle(e);
    if (/flex-end|^end|right/.test(cs.alignItems) && cs.flexDirection.startsWith('column')) return 'user';
    if (/flex-end|^end|right/.test(cs.justifyContent) && cs.flexDirection.startsWith('row')) return 'user';
    if (cs.alignSelf === 'flex-end' || cs.alignSelf === 'end') return 'user';
  }
  return null;
}
function innerBox(el) {
  // shrink to the visible bubble: descend single-child wrappers, then union the children's rects
  let e = el; for (let d = 0; d < 4 && e.children.length === 1; d++) e = e.children[0];
  const kids = [...e.children].map(c => c.getBoundingClientRect()).filter(r => r.width > 0);
  if (!kids.length) return e.getBoundingClientRect();
  return { left: Math.min(...kids.map(r => r.left)), right: Math.max(...kids.map(r => r.right)),
    width: Math.max(...kids.map(r => r.right)) - Math.min(...kids.map(r => r.left)) };
}
function geoRole(el, box) {
  const r = innerBox(el);
  const w = box.right - box.left;
  if (r.width === 0) return null;
  const nearRight = box.right - r.right < w * 0.15;
  const farFromLeft = r.left - box.left > w * 0.25;
  return nearRight && farFromLeft && r.width < w * 0.8 ? 'user' : 'bot';
}
// @include src/pane-rules.js
// page heading (bot name / group room name) + header text (participants in a group room) for the sleeping placeholder
const headText = e => e ? (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
// composer for the snapshot: 'present' / 'empty' / 'none' (no composer on the page: cannot tell) - composerState of the shared rules decides - / 'error'
function draftState() { try { return composerState().d; } catch { return 'error'; } }
// Reads the page for readConversation (shared rules, which decide everything): DOM in, plain data out. The whole document - turns scrolled out of
// view too, no visibility test - and only these structures: grok.com/bot turns are ".group/bot-entry" blocks, user turns contain
// [data-testid="user-message"], h1 / header for the name. Never document.body's text. Without bot-entry blocks the old generic guesses below
// still run, but readConversation marks their result GUESS (unknown).
function scanMessages() {
  let all = [...document.querySelectorAll('[class*="group/bot-entry"]')];
  // outermost only: an entry nested in another entry has a matching ancestor (O(n); the former pairwise contains() test was O(n^2): ~70 ms at 1000 turns)
  all = all.filter(e => !(e.parentElement && e.parentElement.closest('[class*="group/bot-entry"]')));
  const entries = all.map(e => ({ user: !!e.querySelector('[data-testid="user-message"]'), blank: !(e.textContent || '').trim() }));
  const li = entries.map(e => !e.blank).lastIndexOf(true), le = li >= 0 ? all[li] : null;
  let last = null;
  if (le) {
    last = { text: le.textContent || '' };
    if (!entries[li].user) {                     // innerText costs a layout: only for the latest bot turn, as before
      let quotes = null; try { quotes = [...le.querySelectorAll('blockquote')].map(b => b.innerText || b.textContent); } catch {}
      last.inner = le.innerText || le.textContent; last.quotes = quotes;
      last.widget = !!le.querySelector('[role="radio"],[role="radiogroup"],[role="option"],[role="listbox"],[role="checkbox"],input[type="radio"],input[type="checkbox"]');
    }
  }
  let h1s = [], hh = ''; try { h1s = [...document.querySelectorAll('h1')].map(headText); hh = headText(document.querySelector('header')); } catch {}
  return { cid: (location.pathname.match(/^\/bot\/([A-Za-z0-9_-]+)/) || [])[1] || '', ready: document.readyState === 'complete',
    auth: !!document.querySelector('input[type="password"]'), entries, last, guess: le ? null : guessMessages(), h1s, hh, draft: draftState() };
}
// The generic guesses from before the bot-entry structure was known (attribute / class / flex alignment / geometry): counts or null.
function guessMessages() {
  let els = [...document.querySelectorAll(MSG_SEL)].filter(e => (e.textContent || '').trim() || e.querySelector('img,video'));
  els = els.filter(e => !els.some(o => o !== e && o.contains(e)));  // outermost only => one per message
  // ignore the composer / anything inside a form or textbox
  els = els.filter(e => !e.closest('form, [contenteditable="true"], textarea'));
  let method = 'selector';
  if (els.length === 0) {
    // Geometry fallback: bubbles = text blocks in <main> that are direct children of a column list.
    const main = document.querySelector('main'); if (!main) return null;
    const lists = [...main.querySelectorAll('div')].filter(d => d.children.length >= 2 && [...d.children].every(c => c.getBoundingClientRect().height > 10)
      && getComputedStyle(d).flexDirection.startsWith('column') && d.textContent.trim().length > 20);
    const list = lists.sort((a, b) => b.children.length - a.children.length)[0];
    if (!list) return null;
    els = [...list.children].filter(c => (c.textContent || '').trim() && !c.querySelector('textarea,[contenteditable="true"]'));
    method = 'geometry';
    if (els.length === 0) return null;
  }
  const box = chatBox(els);
  let user = 0, bot = 0, botSince = 0, lastBot = null;
  for (const e of els) {
    const role = attrRole(e) || classRole(e) || styleRole(e) || geoRole(e, box) || 'bot';
    if (role === 'user') { user++; botSince = 0; lastBot = null; } else { bot++; botSince++; lastBot = e; }
  }
  const lastEl = els[els.length - 1];
  const mk = lastEl && botSince > 0 ? markerOf(lastEl.textContent) : null, waiting = mk === 'wait';
  return { user, bot, botSince, waiting, working: mk === 'work', done: mk === 'done', asks: waiting, method };
}
// Generation (#02): main numbers the page's world (load / URL / SPA move / reload / wake ...) and sends it here (mpb:gen). Every report carries the
// number its scans ran under plus the scan's sequence number; main compares a report only within that generation, so a report of an older
// generation, a duplicate or an out-of-order one changes nothing. 0 = no number yet (main drops such a report; it is sent again once one arrives).
let lastSent = null, pendingKey = null, gen = 0, seq = 0, moving = true;
function setGen(g) {
  if (!Number.isSafeInteger(g) || g <= 0 || g === gen) return;
  gen = g; lastSent = null; pendingKey = null; moving = true;   // scans of the old generation never confirm a report of the new one
  if (grokChat() && !timer) timer = setTimeout(check, 300);
  scheduleDraftText();
}
ipcRenderer.on('mpb:gen', (_e, g) => setGen(g));
function sendCount(c) {
  const key = gen + '/' + c.snap.stable + '/' + msgKey(c);
  if (key === lastSent) return;
  lastSent = key;
  ipcRenderer.send('pane:msgcount', { ...c, gen, seq });
}

function check() {
  timer = null;
  if (grokChat()) {
    // Grok chats: count only stable message scans; never fall back to raw DOM-change glow
    // (streaming, re-renders and question cards were causing phantom '1's).
    // A report goes out only when two scans >= 1.2 s apart agree (snap.stable QUIET; a reply can still be in progress - the DOM cannot prove it ended).
    // A page without a conversation is reported too (snap.conv LOADING / AUTH_REQUIRED / DOM_UNKNOWN), so main knows the state is unknown.
    // When the page changes after a stable report (a reply being written), one CHANGING report says so: main applies no counts from it and no
    // longer acts on the earlier stable one (no auto-sleep on an old 🟢 / 🟣) until the next stable report.
    seq++;
    const f = scanMessages(), c = readConversation(f), k = gen + '|' + msgKey(c);
    if (k === pendingKey) { moving = false; sendCount(readConversation({ ...f, quiet: true })); }
    else { if (!moving) { moving = true; sendCount(c); } pendingKey = k; if (!timer) timer = setTimeout(check, 1200); }
    return;
  }
  if (lastSent !== 'off') { lastSent = 'off'; ipcRenderer.send('pane:msgmode-off'); }
  return;
  const len = document.body ? document.body.textContent.length : 0;
  if (lastLen >= 0 && len !== lastLen) ipcRenderer.send('pane:mutation');
  lastLen = len;
}
// Debounced: text length is compared at most every 1.5 s, so animations/attribute changes don't count.
const obs = new MutationObserver(() => { if (!timer) timer = setTimeout(check, 1500); scheduleDraft(); scheduleDraftText(); });
window.addEventListener('DOMContentLoaded', () => {
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setTimeout(check, 3000);
});

const isEditable = el => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
let typingSent = 0;
window.addEventListener('keydown', () => {
  if (Date.now() - typingSent > 2000) { typingSent = Date.now(); ipcRenderer.send('pane:typing'); }
}, true);
// "editing" = focus is in a field that has unsent text; auto-reload is skipped while true.
function reportEditing() {
  const el = document.activeElement;
  const hasText = isEditable(el) && ((el.value ?? el.textContent ?? '').trim().length > 0);
  ipcRenderer.send('pane:editing', hasText);
}
// Reports whether the composer holds typed text / a pending attachment (blocks auto-sleep). Debounced, only sends on change.
let lastDraft = null, draftTimer = null;
function reportDraft() { draftTimer = null; let d = false; try { d = composerDraft(); } catch {} if (d !== lastDraft) { lastDraft = d; ipcRenderer.send('pane:draft', d); } }
const scheduleDraft = () => { if (grokChat() && !draftTimer) draftTimer = setTimeout(reportDraft, 500); };
window.addEventListener('input', scheduleDraft, true);
window.addEventListener('focusout', scheduleDraft, true);
window.addEventListener('keyup', scheduleDraft, true);
window.addEventListener('paste', scheduleDraft, true);
window.addEventListener('drop', scheduleDraft, true);
// Disk drafts: main supplies the generation / opt-in and validates every report. An initial empty field is never a deletion.
// Restore waits for a complete page and a visible composer, then checks again on receipt; any real editing cancels it, even type-then-clear.
let draftEnabled = false, draftTextTimer = null, draftUrlNow = '', draftGen = 0, draftRev = 0, draftTouched = false;
let draftRequested = false, draftLastText = '', draftLastSent = null, draftBlocked = null, draftSubmitting = null;
function syncDraftPage() {
  const u = DRAFT.url(location.href);
  const moved = u !== draftUrlNow;
  if (moved) { draftUrlNow = u; draftRev = 0; draftTouched = false; draftLastText = ''; draftBlocked = null; draftSubmitting = null; }
  if (moved || gen !== draftGen) { draftGen = gen; draftRequested = false; draftLastSent = null; }
  return u;
}
function scheduleDraftText(reset = false) {
  if (!draftEnabled) return;
  if (reset) { clearTimeout(draftTextTimer); draftTextTimer = null; }
  if (!draftTextTimer) draftTextTimer = setTimeout(persistDraftText, 750);
}
function persistDraftText() {
  clearTimeout(draftTextTimer); draftTextTimer = null;
  if (!draftEnabled || !gen || !syncDraftPage() || imeOn) return;
  const el = draftComposer(); if (!el) return;
  const text = draftText(el).slice(0, DRAFT.MAX);
  if (!text.trim() && !draftTouched && !draftLastText && !draftRequested && document.readyState === 'complete' && composerState().d === 'empty') {
    draftRequested = true;
    ipcRenderer.send('pane:draft-load', { gen, url: draftUrlNow, rev: draftRev });
  }
  if (draftBlocked !== null && text === draftBlocked) return;
  if (text !== draftLastSent && (text.trim() || draftTouched || draftLastText)) {
    draftLastSent = text;
    ipcRenderer.send('pane:draft-save', { gen, url: draftUrlNow, rev: draftRev, text });
  }
  draftLastText = text;
}
function draftEdited(e) {
  if (!draftEnabled) return;
  const el = draftComposer();
  if (!el || !(e.target === el || el.contains(e.target))) return;
  syncDraftPage();
  if (e.isTrusted) { draftRev++; draftTouched = true; draftBlocked = null; }
  scheduleDraftText(true);
}
['beforeinput', 'input', 'compositionstart', 'compositionend'].forEach(type => window.addEventListener(type, draftEdited, true));
function noteDraftSend() { draftSubmitting = { text: draftText(draftComposer()).slice(0, DRAFT.MAX), rev: draftRev }; }
window.addEventListener('keydown', e => { if (draftEnabled && e.isTrusted && e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target === draftComposer()) noteDraftSend(); }, true);
window.addEventListener('submit', () => { if (draftEnabled) noteDraftSend(); }, true);
function draftClicked(e) {
  if (!draftEnabled || !e.isTrusted) return;
  const el = draftComposer(), b = e.target?.closest?.('button');
  const box = el && (el.closest('form') || el.parentElement?.parentElement);
  if (b && box?.contains(b) && (b.type === 'submit' || /送信|submit|send/i.test(b.getAttribute('aria-label') || ''))) noteDraftSend();
}
ipcRenderer.on('mpb:draft-config', (_e, on) => {
  if (draftEnabled === (on === true)) return;
  draftEnabled = on === true; draftRequested = false; draftLastSent = null;
  clearTimeout(draftTextTimer); draftTextTimer = null;
  scheduleDraftText();
});
ipcRenderer.on('mpb:draft-restore', (_e, d) => {
  syncDraftPage();
  const el = draftComposer();
  if (!el || !d || !DRAFT.restore({ enabled: draftEnabled, entry: d, now: Date.now(), gen: d.gen, currentGen: gen,
    url: d.url, currentUrl: location.href, rev: d.rev, currentRev: draftRev, touched: draftTouched,
    empty: composerState().d === 'empty', ime: imeOn })) return;
  const active = document.activeElement;
  try { composerFill(el, d.text.slice(0, DRAFT.MAX)); draftLastText = draftText(el).slice(0, DRAFT.MAX); draftLastSent = draftLastText; }
  catch {} finally { if (active && active !== el && active.isConnected) active.focus(); }
  scheduleDraft();
});
ipcRenderer.on('mpb:draft-sent', (_e, d) => {
  if (!d || d.gen !== gen || DRAFT.url(d.url) !== DRAFT.url(location.href)) return;
  const text = draftText(draftComposer()).slice(0, DRAFT.MAX);
  // A new draft typed since the actual send gesture is kept; an uncleared submitted value cannot be saved again by DOM polling.
  draftBlocked = draftSubmitting === null || (text === draftSubmitting.text && draftRev === draftSubmitting.rev) ? text : null;
  draftSubmitting = null; draftRequested = true; draftLastSent = null; draftLastText = '';
  if (draftBlocked !== null) ipcRenderer.send('pane:draft-save', { gen, url: DRAFT.url(location.href), rev: draftRev, text: '' }); // also supersedes any save already in flight
  scheduleDraftText(true);
});
setInterval(() => scheduleDraftText(), 1000);              // React may clear a textarea without a DOM mutation or input event
window.addEventListener('input', reportEditing, true);
window.addEventListener('focusin', reportEditing, true);
window.addEventListener('focusout', () => setTimeout(reportEditing, 0), true);
// An IME composition in progress (変換中, #11): main never throws the page away during one. Sent on change only.
let imeOn = false;
const reportIme = on => { if (on !== imeOn) { imeOn = on; ipcRenderer.send('pane:ime', on); } };
window.addEventListener('compositionstart', () => reportIme(true), true);
window.addEventListener('compositionend', () => reportIme(false), true);
// A selection in the page outside any field (選択部分だけコピー, copy-policy.js): main then copies it itself on ⌘C. Sent on change only; a
// field's own selection (input / textarea / contenteditable) is not one (the browser's copy as before)
let selOn = false;
function selNow() {
  const s = document.getSelection(), ae = document.activeElement;
  if (!s || s.isCollapsed || !s.rangeCount || (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName))) return false;
  const n = s.anchorNode, el = n && (n.nodeType === 1 ? n : n.parentElement);
  return !(el && el.isContentEditable);
}
window.addEventListener('selectionchange', () => { let on = false; try { on = selNow(); } catch {} if (on !== selOn) { selOn = on; ipcRenderer.send('pane:sel', on); } }, true);

// Real user interaction in this pane (clears its update highlight).
window.addEventListener('mousedown', () => ipcRenderer.send('pane:interact'), true);
window.addEventListener('mouseup', () => ipcRenderer.send('pane:mouseup'), true);

// ---- cloud PC (the bot's "ボットのコンピュータビュー" dialog) ----
// grok.com sizes that dialog to the viewport: padding 8vw/8dvh and width min(100cqw, 1080px, 160cqh). When requested by the app
// (menu / ⌘⇧P) we open the page's own "コンピュータを表示" button if needed and relax those limits so it fills the pane.
const PC_CSS = `[role="dialog"] [class*="container-type:size"]{padding:10px !important}
[role="dialog"] [class*="container-type:size"] > div[style*="cqw"]{width:min(100cqw,160cqh) !important}`;
let pcCss = null, pcTimer = null;
function pcStop(notify) {
  clearInterval(pcTimer); pcTimer = null;
  if (pcCss != null) { try { webFrame.removeInsertedCSS(pcCss); } catch {} pcCss = null; }
  if (notify) ipcRenderer.send('pane:pc-closed');
}
ipcRenderer.on('mpb:pc', (_e, on) => {
  if (!on) { pcStop(false); return; }
  if (pcCss == null) { try { pcCss = webFrame.insertCSS(PC_CSS); } catch {} }
  const open = () => !!document.querySelector('[data-bot-computer-vnc]');
  if (!open()) {
    const b = [...document.querySelectorAll('button,[role="button"]')].find(x => /コンピュータを表示|show computer|view computer/i.test(x.getAttribute('aria-label') || ''));
    if (b) b.click();
  }
  let seen = open(), waited = 0;
  clearInterval(pcTimer);
  pcTimer = setInterval(() => {            // when the computer view goes away (Esc / close button) hand the pane back
    waited += 400;
    if (open()) { seen = true; return; }
    if (seen || waited > 5000) pcStop(true);
  }, 400);
});

// The user opened the computer view themselves ('コンピュータを表示' button): tell main so it can enlarge the pane (only grok.com/bot/*).
let pcWasOpen = false, pcObsT = null;
function pcCheck() {
  pcObsT = null;
  if (location.hostname !== 'grok.com' && !/\.grok\.com$/.test(location.hostname) || !location.pathname.startsWith('/bot/')) { pcWasOpen = false; return; }
  const o = !!document.querySelector('[data-bot-computer-vnc]');
  if (o && !pcWasOpen) { pcWasOpen = true; if (pcCss == null) ipcRenderer.send('pane:pc-opened'); } else if (!o) pcWasOpen = false;
}
function startPcObs() { try { new MutationObserver(() => { if (!pcObsT) pcObsT = setTimeout(pcCheck, 300); }).observe(document.documentElement, { childList: true, subtree: true }); } catch {} }
if (document.documentElement) startPcObs(); else window.addEventListener('DOMContentLoaded', startPcObs);

// ---- 画像クリックで最大化: the user's own click (isTrusted) on an image of a grok.com page -> main maximizes the pane like the cloud PC above
// (settings.autoImg). Images only: at least IMG_MIN px both ways (no avatar / icon), not an svg file, not in the sidebar / header / nav / an avatar
// stack / a dialog already open / a link (that opens a page, not a viewer). The click itself goes on to the page untouched (no preventDefault /
// stopPropagation). The viewer the page opens
// for it = a dialog that was not there before the click and holds an image / video; once it is gone, main gets img-closed(true) and gives back
// only what it maximized itself. No viewer within IMG_WAIT ms: img-closed(false) (the pane stays maximized; ⌘\ / Esc / ⤡ as usual)
const IMG_MIN = 48, IMG_WAIT = 1500, VIEWER = '[role="dialog"],[aria-modal="true"]';
let imgT = null;
function imgOf(t) {
  if (!t || t.nodeType !== 1) return null;
  if (t.tagName === 'IMG') return t;
  const b = t.closest('button,[role="button"]'), im = b && b.querySelectorAll('img');   // a clickable wrapper over one image
  return im && im.length === 1 ? im[0] : null;
}
function imgClicked(e) {
  if (!e.isTrusted || e.button !== 0 || location.hostname !== 'grok.com') return;
  const img = imgOf(e.target); if (!img) return;
  if (img.closest(`[data-sidebar],header,nav,[data-testid="bot-avatar-stack"],a[href]:not([href^="#"]),${VIEWER}`)) return;
  const r = img.getBoundingClientRect(), src = String(img.currentSrc || img.src || '');
  if (r.width < IMG_MIN || r.height < IMG_MIN || /^data:image\/svg|\.svg(?:[?#]|$)/i.test(src)) return;
  const before = new Set(document.querySelectorAll(VIEWER));
  const viewer = () => [...document.querySelectorAll(VIEWER)].some(d => !before.has(d) && d.querySelector('img,video,canvas'));
  ipcRenderer.send('pane:img-opened');
  clearInterval(imgT);
  let seen = false, waited = 0, gone = 0;
  imgT = setInterval(() => {                 // a re-rendered viewer is still the viewer: closed only when none is there twice in a row
    waited += 300;
    if (viewer()) { seen = true; gone = 0; return; }
    if (seen ? ++gone < 2 : waited < IMG_WAIT) return;
    clearInterval(imgT); imgT = null;
    ipcRenderer.send('pane:img-closed', seen);
  }, 300);
}
window.addEventListener('click', e => { try { imgClicked(e); } catch {} }, true);
window.addEventListener('click', draftClicked, true);

// ---- 画像ビューアの拡大: in grok.com's image viewer (the dialog an image click opens: caption, the picture, ‹ ›, thumbnails, close) the picture
// fills the area the viewer leaves it (the flex-1 box between caption and thumbnails) with object-fit: contain - aspect kept, larger than its own
// size if need be - instead of stopping at its own size / 95vw. CSS only, so it follows every window / pane resize. Only the <img> changes (its
// box = the area; the shadow would frame the empty part, so none): caption, thumbnails, arrows and close keep their places. Tailwind names may
// change: each rule needs two of three signs (zoom-out wrapper, flex-1 area, object-contain img) and is a rule of its own. Never matched: an image
// outside a dialog (the chat), in a button / link (thumbnails), round (avatars), cropped (object-cover), or in a box holding several images.
const IMG_DLG = ':is([role="dialog"],[aria-modal="true"])', IMG_AREA = 'div:not(:has(> img ~ img))';
const IMG_PIC = 'img:not([class~="rounded-full"]):not([class~="object-cover"]):not(button img):not(a img):not([role="button"] img)';
const IMG_VIEW_CSS = [
  `${IMG_DLG} [class~="cursor-zoom-out"] ${IMG_AREA}[class~="flex-1"] > ${IMG_PIC}`,             // today: zoom-out wrapper + flex-1 area
  `${IMG_DLG} [class~="cursor-zoom-out"] > ${IMG_AREA} > ${IMG_PIC}[class~="object-contain"]`,    // the area's classes changed
  `${IMG_DLG} ${IMG_AREA}[class~="flex-1"] > ${IMG_PIC}[class~="object-contain"]`,                   // the wrapper's classes changed
].map(s => `${s}{width:100% !important;height:100% !important;max-width:none !important;max-height:none !important;min-width:0 !important;min-height:0 !important;object-fit:contain !important;box-shadow:none !important}`).join('\n');
function imgViewCss() { if (location.hostname === 'grok.com') { try { webFrame.insertCSS(IMG_VIEW_CSS); } catch {} } }
if (document.documentElement) imgViewCss(); else window.addEventListener('DOMContentLoaded', imgViewCss);

// ---- per-pane zoom (main sends the zoom for THIS page; the site-wide zoom level stays at 100% so panes on the same site don't affect each other) ----
// (#53) the legacy backend only: a pane on native isolated zoom (wc.setZoomFactor in main) never gets 'mpb:zoom', so this stays at 1 and does nothing

let paneZoom = 1;
const applyPaneZoom = () => { try { webFrame.setZoomFactor(paneZoom); } catch {} };
ipcRenderer.on('mpb:zoom', (_e, z) => { paneZoom = Number(z) > 0 ? Number(z) : 1; applyPaneZoom(); });
window.addEventListener('DOMContentLoaded', () => { if (paneZoom !== 1) applyPaneZoom(); });
