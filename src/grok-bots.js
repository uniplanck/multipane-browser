// Grok ボタン＋Bot一覧バー (the favorites bar, reworked): pure rules and the fixed page-side code, no electron (test/grok-bots.test.js).
// main.js keeps the list in panes.json `grok` and runs the hidden window that reads it; this file decides what is read, kept, shown and undone.
//   grok = { bots: [{ id, url, name, isGroup, section, order, icon }], aliases: { id: the user's name }, pins: [id], at: ms of the last good read }
// A read (the Grok button only, never by itself) opens https://grok.com/ in a hidden window of the shared session and takes the sidebar's ボット
// list as the page shows it: no internal API, no conversation opened / typed into / sent. The only clicks are the sidebar toggle and さらに表示 /
// 少なく表示, each undone before the window closes (`sidebarOpen` in grok.com's localStorage is shared with the real panes). decide() drives the
// read from plain observations of the page; scanSidebar() is the one DOM reader (in the page's own world, and in Node on a tiny fake DOM).
// Nothing here is logged: names, URLs and icons stay in panes.json and the bar.
const { stamp } = require('./state-backup');
const { authPage } = require('./probe-policy');                // a clear sign-in page (the same test as the background check's)

const HOME = 'https://grok.com/';
const TIMEOUT_MS = 30000;                   // one read gives up after this long (the list stays as it was)
const MAX_BOTS = 300, NAME_MAX = 60, SEC_MAX = 40, URL_MAX = 2048, ICON_MAX = 16384, ALIAS_MAX = 500;
const MORE_MAX = 5;                         // さらに表示 pressed at most this often in one read
const ICON_PX = 32;                         // icons kept as 32 px PNG data URLs (shown at 16 px), so panes.json stays small
const WORLD = 1004;                         // main.js: the isolated world of the hidden window's scripts (1001-1003 are taken)
// outcome codes (= diagnostics.js EVENTS.gbar, checked by the test): read / not signed in / timeout / no Bot found / the ボット section closed in
// grok.com / the page tried to leave grok.com / an error / cut short (quitting) / a second press while one runs / the old favorites moved to the
// backup file once / the sidebar state could not be confirmed back
const CODES = ['OK', 'AUTH', 'TIMEOUT', 'EMPTY', 'COLLAPSED', 'OFFSITE', 'ERROR', 'ABORT', 'BUSY', 'MIGRATED', 'RESTORE_FAIL'];
const NOTE = {
  AUTH: 'grok.com にログインしていません（一覧はそのまま）', TIMEOUT: '読み込みがタイムアウトしました（一覧はそのまま）',
  EMPTY: 'Bot が見つかりませんでした（一覧はそのまま）', COLLAPSED: 'grok.com のサイドバーで「ボット」欄が閉じています（一覧はそのまま）',
  OFFSITE: 'grok.com 以外へ移動しかけたため中止しました（一覧はそのまま）', ERROR: '読み込めませんでした（一覧はそのまま）', ABORT: '中止しました（一覧はそのまま）',
};

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HREF_RE = /^(?:https:\/\/grok\.com)?\/bot\/([A-Za-z0-9_-]{1,64})\/?(?:[?#].*)?$/;
const URL_RE = /^https:\/\/grok\.com\/bot\/([A-Za-z0-9_-]{1,64})\/?(?:[?#].*)?$/;
const DATA_ICON_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined;
// names / section labels: one line, no control characters, cut
const text = (s, max) => typeof s === 'string' ? Array.from(s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim() : '';
const okId = v => typeof v === 'string' && ID_RE.test(v) && v !== '__proto__';
const botId = u => { const m = typeof u === 'string' ? u.match(URL_RE) : null; return m ? m[1] : ''; };
const httpsIcon = s => { if (typeof s !== 'string' || s.length > URL_MAX) return ''; try { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password ? s : ''; } catch { return ''; } };
const dataIcon = (s, max = ICON_MAX) => typeof s === 'string' && s.length <= max && DATA_ICON_RE.test(s) ? s : '';
const icon = s => httpsIcon(s) || dataIcon(s);                // what may be kept / shown: an https image or a small image data URL
const empty = () => ({ bots: [], aliases: {}, pins: [], at: 0 });

// a saved `grok` (panes.json) -> { grok, same }: unusable entries dropped, the rest cut to the limits; never fatal (the Grok button reads it again)
function clean(g) {
  const bots = [], seen = new Set();
  for (const b of Array.isArray(own(g, 'bots')) ? g.bots : []) {
    if (!isObj(b) || !okId(b.id) || seen.has(b.id) || bots.length >= MAX_BOTS) continue;
    const name = text(b.name, NAME_MAX); if (!name) continue;
    seen.add(b.id);
    bots.push({ id: b.id, url: 'https://grok.com/bot/' + b.id, name, isGroup: b.isGroup === true, section: text(b.section, SEC_MAX), order: bots.length, icon: icon(b.icon) });
  }
  const aliases = {};
  const al = own(g, 'aliases');
  if (isObj(al)) for (const [k, v] of Object.entries(al)) { const n = text(v, NAME_MAX); if (okId(k) && n && Object.keys(aliases).length < ALIAS_MAX) aliases[k] = n; }
  const pins = [...new Set((Array.isArray(own(g, 'pins')) ? g.pins : []).filter(id => okId(id) && seen.has(id)))];
  const at = own(g, 'at'), c = { bots, aliases, pins, at: Number.isSafeInteger(at) && at > 0 ? at : 0 };
  return { grok: c, same: JSON.stringify(c) === JSON.stringify(g) };
}
const valid = g => clean(g).same;                             // state-schema validate(): exactly what clean() keeps

// the page's sidebar (scanSidebar items) -> bots in the page's order, each with the section label above it. Unknown hrefs, duplicates (a Bot
// shown in two sections: the first) and nameless links are left out; the icon is the page's own image URL (iconsOf below makes it a data URL)
function parse(raw) {
  const items = Array.isArray(own(raw, 'items')) ? raw.items.slice(0, 4000) : [];
  const out = [], seen = new Set(); let sec = '';
  for (const it of items) {
    if (!isObj(it)) continue;
    if (it.t === 'sec') { sec = text(it.text, SEC_MAX); continue; }
    if (it.t !== 'bot' || typeof it.href !== 'string') continue;
    const m = it.href.match(HREF_RE), name = text(it.name, NAME_MAX);
    if (!m || seen.has(m[1]) || !name || m[1] === '__proto__') continue;
    seen.add(m[1]);
    out.push({ id: m[1], url: 'https://grok.com/bot/' + m[1], name, isGroup: it.group === true, section: sec, order: out.length, icon: httpsIcon(it.icon) || dataIcon(it.icon, 400000) });
    if (out.length >= MAX_BOTS) break;
  }
  return out;
}
// icons after ICONS_JS: the small data URL it made, else the https URL as it was (may expire: the bar then shows the first letter), else none
const withIcons = (bots, made) => bots.map(b => ({ ...b, icon: dataIcon(own(made, b.icon)) || httpsIcon(b.icon) || dataIcon(b.icon) }));

// a good read -> the new list (the page's order and sections); gone ones leave the pins (their names stay, they come back with the Bot)
function merge(prev, bots, now) {
  const g = clean(prev).grok, old = new Map(g.bots.map(b => [b.id, b])), ids = new Set(bots.map(b => b.id));
  const list = clean({ bots, aliases: g.aliases, pins: g.pins.filter(id => ids.has(id)), at: now }).grok;
  return { grok: list, added: list.bots.filter(b => !old.has(b.id)).length, removed: g.bots.filter(b => !ids.has(b.id)).length,
    changed: list.bots.filter(b => old.has(b.id) && (old.get(b.id).name !== b.name || old.get(b.id).section !== b.section)).length };
}
// favorites that are a listed Bot's URL become its pin (no Bot shown twice): -> { grok, keep: the other favorites (same objects), moved }
function absorbFavs(g, favorites) {
  let gg = g, moved = 0;
  const keep = (favorites || []).filter(f => {
    const id = botId(f && f.url);
    if (!id || !gg.bots.some(b => b.id === id)) return true;
    gg = pin(gg, id, true); moved++; return false;
  });
  return { grok: gg, keep, moved };
}
// お気に入りに追加 (⌘K / ⋯ / a dropped URL) of a listed Bot -> pinned instead (pinned: true); anything else stays an ordinary favorite
function addUrl(g, url) {
  const id = botId(url);
  return id && g.bots.some(b => b.id === id) ? { grok: pin(g, id, true), pinned: true } : { grok: g, pinned: false };
}
const has = (g, id) => g.bots.some(b => b.id === id);
function pin(g, id, on) {
  if (!has(g, id) || g.pins.includes(id) === !!on) return g;
  return { ...g, pins: on ? [...g.pins, id] : g.pins.filter(x => x !== id) };
}
function movePin(g, a, b) {                                   // drag a pin onto another: it takes that place (as fav-move)
  const i = g.pins.indexOf(a), j = g.pins.indexOf(b);
  if (i < 0 || j < 0 || i === j) return g;
  const pins = [...g.pins]; pins.splice(i, 1); pins.splice(j, 0, a);
  return { ...g, pins };
}
function rename(g, id, value) {                               // empty / the page's own name: back to the page's name
  const b = g.bots.find(x => x.id === id); if (!b) return g;
  const n = text(value, NAME_MAX), aliases = { ...g.aliases };
  if (!n || n === b.name) delete aliases[id]; else aliases[id] = n;
  if (Object.keys(aliases).length > ALIAS_MAX) for (const k of Object.keys(aliases)) if (!has(g, k)) delete aliases[k];   // full: names of Bots gone go first
  return { ...g, aliases };
}
const nameOf = (g, b) => (Object.hasOwn(g.aliases, b.id) && g.aliases[b.id]) || b.name;
// the bar: pins (in their order) and the sections in the page's order
function view(g) {
  const item = b => ({ id: b.id, name: nameOf(g, b), orig: b.name, url: b.url, group: b.isGroup, icon: b.icon, pinned: g.pins.includes(b.id) });
  const byId = new Map(g.bots.map(b => [b.id, b])), sections = [];
  for (const b of g.bots) { let s = sections[sections.length - 1]; if (!s || s.name !== b.section) sections.push(s = { name: b.section, items: [] }); s.items.push(item(b)); }
  return { pins: g.pins.map(id => byId.get(id)).filter(Boolean).map(item), sections, count: g.bots.length, at: g.at };
}
const note = (code, m) => code === 'OK' ? `Bot ${m.grok.bots.length}件を読み込みました${m.added || m.removed ? `（+${m.added} −${m.removed}）` : ''}` : NOTE[code] || NOTE.ERROR;

// ---- the old favorites, once (settings.favGrokV1): kept in userData/favorites.backup-<日時>.json, then the bar starts from the Grok button ----
// -> { file: '' when there was nothing to keep, text }
function migration(favorites, now = new Date()) {
  const list = (favorites || []).filter(f => isObj(f) && typeof f.url === 'string').map(f => ({ url: f.url, label: typeof f.label === 'string' ? f.label : '' }));
  return { file: list.length ? `favorites.backup-${stamp(now)}.json` : '', n: list.length, text: JSON.stringify({ savedAt: now.toISOString(), favorites: list }, null, 2) };
}

// ---- the hidden window ----
// where it may go: grok.com only (a sign-in redirect / anything else is stopped there and ends the read)
const navOk = u => { try { const x = new URL(String(u)); return x.protocol === 'https:' && x.hostname === 'grok.com' && !x.port && !x.username && !x.password; } catch { return false; } };
// rs: what this read did so far (sidebarOpen as found, clicks, times)
const start = now => ({ t0: now, readyAt: 0, orig: undefined, opened: false, openAt: 0, more: 0, moreAt: 0, n: -1, nAt: 0 });
// one observation (STATE_JS + main: left = a stopped move away from grok.com; a sign-in page = AUTH) -> { act, rs }. act: 'wait' / 'open'
// (click the sidebar toggle, once) / 'more' (さらに表示) / 'collect' (the list is complete and still) / a failure code. The toggle is clicked only
// when the sidebar is found closed (sidebarOpen not 'true', no ボット heading after a moment); さらに表示 only under the ボット heading
function decide(rs, o, now) {
  const r = { ...rs }, out = act => ({ act, rs: r });
  if (now - r.t0 > TIMEOUT_MS) return out('TIMEOUT');
  if (o && o.left) return out(authPage(o.left) ? 'AUTH' : 'OFFSITE');
  if (!o || o.ready !== true) return out('wait');
  if (!r.readyAt) { r.readyAt = now; r.orig = typeof o.ls === 'string' ? o.ls : null; }   // as found, before any click of ours
  const n = Array.isArray(o.items) ? o.items.filter(x => isObj(x) && x.t === 'bot').length : 0;
  const since = now - Math.max(r.readyAt, r.openAt, r.moreAt);
  if (n > 0) {
    if (o.more === true && o.head === true && r.more < MORE_MAX) { if (since < 900) return out('wait'); r.more++; r.moreAt = now; return out('more'); }
    if (n !== r.n) { r.n = n; r.nAt = now; return out('wait'); }
    return now - r.nAt >= 800 && since >= 800 ? out('collect') : out('wait');
  }
  if (o.head === true && o.expanded === 'false' && since >= 1500) return out('COLLAPSED');
  // closed: said so ('false') after a moment, or never set and still no ボット heading after a longer one (the page may still be loading it)
  if (!r.opened && o.trigger === true && o.ls !== 'true' && o.head !== true && since >= (o.ls === 'false' ? 1500 : 4000)) { r.opened = true; r.openAt = now; return out('open'); }
  if (o.signin === true && since >= 3000) return out('AUTH');
  return since >= 8000 ? out('EMPTY') : out('wait');
}

// The sidebar as the page shows it -> { sidebar, head, expanded, more, less, items: [{ t: 'sec', text } | { t: 'bot', href, name, group, icon }], el }.
// Self-contained (it is also run in the page as its own source text): only tagName / children / parentElement / getAttribute / textContent.
// The ボット section = the closest box around its heading that holds the Bot links; in it, in order: a Bot link (a[href^="/bot/"]: its text, a
// group when it holds [data-testid="bot-avatar-stack"], its first image) and the section labels = leaf SPANs outside the links (not a button
// label of the heading / さらに表示 / 少なく表示 / an item's options, not screen-reader-only text). el: the さらに表示 / 少なく表示 buttons (page only)
function scanSidebar(doc) {
  const kids = e => Array.from((e && e.children) || []);
  const attr = (e, k) => (e && e.getAttribute && e.getAttribute(k)) || '';
  const tag = e => String((e && e.tagName) || '').toUpperCase();
  const txt = e => String((e && e.textContent) || '').replace(/\s+/g, ' ').trim();
  const desc = (e, out) => { for (const c of kids(e)) { out.push(c); desc(c, out); } return out; };
  const inside = (e, box) => { for (let x = e; x; x = x.parentElement) if (x === box) return true; return false; };
  const HEAD = /^(ボット|bots?)(\s*\d+)?$/i, MORE = /^(さらに表示|もっと見る|show more)$/i, LESS = /^(少なく表示|表示を減らす|show less)$/i, OPT = /のオプション$|options?$/i;
  const isBot = e => tag(e) === 'A' && /^(https:\/\/grok\.com)?\/bot\/[A-Za-z0-9_-]/.test(attr(e, 'href'));
  const isBtn = e => tag(e) === 'BUTTON' || attr(e, 'role') === 'button';
  const res = { sidebar: false, head: false, expanded: '', more: false, less: false, items: [], el: { more: null, less: null } };
  const sb = desc(doc.documentElement || doc, []).find(e => attr(e, 'data-sidebar') === 'sidebar');
  if (!sb) return res;
  res.sidebar = true;
  const all = desc(sb, []), head = all.find(e => isBtn(e) && HEAD.test(txt(e))) || null, first = all.find(isBot) || null;
  res.head = !!head; res.expanded = head ? attr(head, 'aria-expanded') : '';
  let box = head ? head.parentElement || sb : sb;              // no Bot link (yet): the heading's own group
  if (head && first) for (let x = head.parentElement; x && x !== sb; x = x.parentElement) if (inside(first, x)) { box = x; break; }
  let on = !head || !inside(head, box);
  const walk = e => {
    for (const c of kids(e)) {
      if (c === head) { on = true; continue; }
      if (isBot(c)) {
        if (!on) continue;
        const d = desc(c, []), img = d.find(x => tag(x) === 'IMG');
        res.items.push({ t: 'bot', href: attr(c, 'href'), name: txt(c), group: d.some(x => attr(x, 'data-testid') === 'bot-avatar-stack'), icon: img ? String(img.currentSrc || img.src || attr(img, 'src') || '') : '' });
        continue;
      }
      if (tag(c) === 'A') continue;                          // another link: neither a Bot nor a section label
      if (isBtn(c)) {
        const s = txt(c);
        if (MORE.test(s)) { res.more = true; res.el.more = c; continue; }
        if (LESS.test(s)) { res.less = true; res.el.less = c; continue; }
        if (attr(c, 'data-sidebar') === 'menu-action' || attr(c, 'aria-haspopup')) continue;
      }
      if (tag(c) === 'SPAN' && !kids(c).length) {
        const s = txt(c);
        if (on && s && s.length <= 40 && !HEAD.test(s) && !MORE.test(s) && !LESS.test(s) && !OPT.test(s) && !/(^|\s)sr-only(\s|$)/.test(attr(c, 'class'))) res.items.push({ t: 'sec', text: s });
        continue;
      }
      walk(c);
    }
  };
  walk(box);
  return res;
}
// the page-side scripts (fixed code; only JSON values main checked are put in). Run in the hidden window's own world (WORLD)
const SCAN = `(${scanSidebar})`;
const STATE_JS = `(()=>{/*mpb:gbar-state*/const s=${SCAN}(document);delete s.el;let ls=null;try{ls=localStorage.getItem('sidebarOpen');}catch(e){}
return Object.assign(s,{ready:document.readyState==='complete',ls,trigger:!!document.querySelector('[data-sidebar="trigger"]'),
signin:!!document.querySelector('input[type="password"],a[href*="/sign-in"],a[href*="accounts.x.ai"]')});})()`;
const CLICK_JS = what => what === 'trigger' ? `(()=>{/*mpb:gbar-open*/const t=document.querySelector('[data-sidebar="trigger"]');if(t){t.click();return true;}return false;})()`
  : `(()=>{/*mpb:gbar-more*/const s=${SCAN}(document);if(s.head&&s.el.more){s.el.more.click();return true;}return false;})()`;
// each https / data image -> a centred square ICON_PX PNG data URL when the image allows it (CORS); { src: dataURL } of the ones that worked
const ICONS_JS = srcs => `(async()=>{/*mpb:gbar-icons*/const S=${JSON.stringify([...new Set(srcs.filter(s => icon(s) || dataIcon(s, 400000)))].slice(0, MAX_BOTS))},o={};
await Promise.all(S.map(src=>new Promise(res=>{const im=new Image();let t=0;const done=v=>{clearTimeout(t);if(v)o[src]=v;res();};t=setTimeout(()=>done(''),4000);
im.crossOrigin='anonymous';im.onerror=()=>done('');im.onload=()=>{try{const w=im.naturalWidth,h=im.naturalHeight,s=Math.min(w,h);if(!s)return done('');
const c=document.createElement('canvas');c.width=c.height=${ICON_PX};c.getContext('2d').drawImage(im,(w-s)/2,(h-s)/2,s,s,0,0,${ICON_PX},${ICON_PX});done(c.toDataURL('image/png'));}catch(e){done('');}};im.src=src;})));
return o;})()`;
// undo this read's clicks: 少なく表示 when it pressed さらに表示, the toggle when it opened the sidebar, then sidebarOpen exactly as found
// (set / removed directly if the clicks did not bring it back) -> { ok: sidebarOpen is as found, fixed: it had to be set directly }
const RESTORE_JS = rs => `(async()=>{/*mpb:gbar-restore*/const O=${JSON.stringify(typeof rs.orig === 'string' ? rs.orig : null)},w=ms=>new Promise(r=>setTimeout(r,ms));
const ls=()=>{try{return localStorage.getItem('sidebarOpen');}catch(e){return undefined;}};
if(${rs.more > 0}){const s=${SCAN}(document);if(s.el.less){s.el.less.click();await w(500);}}
if(${rs.opened === true}&&ls()!==O){const t=document.querySelector('[data-sidebar="trigger"]');if(t){t.click();await w(500);}}
let fixed=false;if(ls()!==O){fixed=true;try{if(O===null)localStorage.removeItem('sidebarOpen');else localStorage.setItem('sidebarOpen',O);}catch(e){}}
return {ok:ls()===O,fixed};})()`;
const touched = rs => rs.orig !== undefined && (rs.opened === true || rs.more > 0);   // anything to undo

module.exports = { HOME, TIMEOUT_MS, MAX_BOTS, NAME_MAX, SEC_MAX, ICON_MAX, ICON_PX, MORE_MAX, WORLD, CODES, NOTE,
  empty, clean, valid, parse, withIcons, merge, absorbFavs, addUrl, pin, movePin, rename, nameOf, view, note, botId, icon, okId,
  migration, navOk, start, decide, scanSidebar, STATE_JS, CLICK_JS, ICONS_JS, RESTORE_JS, touched };
