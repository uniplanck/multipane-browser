// Preload for web content panes. Exposes NOTHING to the page (no contextBridge);
// it only observes the DOM from the isolated world and reports coarse signals to the main process.
const { ipcRenderer, webFrame } = require('electron');

let lastLen = -1, timer = null;

// ---------- grok.com chat message counting ----------
// Counts discrete message elements (a streaming reply is one element => counted once) and
// classifies each as user/bot, most reliable signal first:
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
function pageHead() {   // page heading (bot name / group room name) + header text (participants in a group room) for the sleeping placeholder
  const f = e => e ? (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  try { return [f(document.querySelector('h1')), f(document.querySelector('header'))]; } catch { return ['', '']; }
}
function scanMessages() {
  // grok.com/bot: each turn is a ".group/bot-entry" block; user turns contain [data-testid="user-message"]
  let ents = [...document.querySelectorAll('[class*="group/bot-entry"]')];
  ents = ents.filter(e => !ents.some(o => o !== e && o.contains(e)) && (e.textContent || '').trim());
  if (ents.length) {
    let user = 0, bot = 0, botSince = 0;
    for (const e of ents) { if (e.querySelector('[data-testid="user-message"]')) { user++; botSince = 0; } else { bot++; botSince++; } }
    const t = (ents[ents.length - 1].textContent || '').replace(/[\s\u3000]+/g, '').replace(/[ー－—–─━―]/g, '-');
    const le = ents[ents.length - 1];
    const widget = !!le.querySelector('[role="radio"],[role="radiogroup"],[role="option"],[role="listbox"],[role="checkbox"],input[type="radio"],input[type="checkbox"]');
    const asks = botSince > 0 && looksAsking(le.innerText || le.textContent, widget);
    const mk = botSince > 0 ? markerOf(le.textContent) : null;
    // fingerprint of the latest entry (tail of its text) so the app can tell whether a sleeping pane got something new
    let h = 5381; const tail = t.slice(-400); for (let i = 0; i < tail.length; i++) h = ((h * 33) ^ tail.charCodeAt(i)) >>> 0;
    let q = ''; if (mk === 'wait') { try { q = requestQuote(le.innerText || le.textContent, [...le.querySelectorAll('blockquote')].map(b => b.innerText || b.textContent)); } catch {} }
    return { user, bot, botSince, waiting: mk === 'wait', working: mk === 'work', done: mk === 'done', q, hn: pageHead()[0], hh: pageHead()[1], asks: asks && mk !== 'work' && mk !== 'done', method: 'bot-entry', fp: h.toString(36) + '.' + t.length };
  }
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
let lastSent = null, pendingKey = null;
function sendCount(c) {
  const key = `${c.user}/${c.bot}/${c.botSince}/${c.waiting}/${c.working}/${c.done}/${c.asks}/${c.fp || ''}/${c.q || ''}`;
  if (key === lastSent) return;
  lastSent = key;
  ipcRenderer.send('pane:msgcount', c);
}

function check() {
  timer = null;
  if (grokChat()) {
    // Grok chats: count only stable message scans; never fall back to raw DOM-change glow
    // (streaming, re-renders and question cards were causing phantom '1's).
    const c = scanMessages();
    if (c) {
      const k = `${c.user}/${c.bot}/${c.botSince}/${c.waiting}/${c.working}/${c.done}/${c.asks}/${c.fp || ''}/${c.q || ''}`;
      if (k === pendingKey) sendCount(c); else { pendingKey = k; if (!timer) timer = setTimeout(check, 1200); }
    }
    return;
  }
  if (lastSent !== 'off') { lastSent = 'off'; ipcRenderer.send('pane:msgmode-off'); }
  return;
  const len = document.body ? document.body.textContent.length : 0;
  if (lastLen >= 0 && len !== lastLen) ipcRenderer.send('pane:mutation');
  lastLen = len;
}
// Debounced: text length is compared at most every 1.5 s, so animations/attribute changes don't count.
const obs = new MutationObserver(() => { if (!timer) timer = setTimeout(check, 1500); scheduleDraft(); });
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
window.addEventListener('input', reportEditing, true);
window.addEventListener('focusin', reportEditing, true);
window.addEventListener('focusout', () => setTimeout(reportEditing, 0), true);

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

// ---- per-pane zoom (main sends the zoom for THIS page; the site-wide zoom level stays at 100% so panes on the same site don't affect each other) ----
let paneZoom = 1;
const applyPaneZoom = () => { try { webFrame.setZoomFactor(paneZoom); } catch {} };
ipcRenderer.on('mpb:zoom', (_e, z) => { paneZoom = Number(z) > 0 ? Number(z) : 1; applyPaneZoom(); });
window.addEventListener('DOMContentLoaded', () => { if (paneZoom !== 1) applyPaneZoom(); });
