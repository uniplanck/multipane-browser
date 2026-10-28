// node test/grok-bots.test.js — Grok ボタン＋Bot一覧バー (src/grok-bots.js): the sidebar reader on a small fake DOM built from fixture HTML (no
// jsdom), the list it makes, merge / pins / names, the saved shape (state-schema), the one-time move of the old favorites, the read's steps
// (decide) and the page-side scripts (they compile, put in only JSON values). Plus the image click of the pane preload (画像クリックで最大化) run
// in a vm with a recording ipcRenderer, and the main.js contract. Not covered here: the real grok.com DOM, the real hidden window, the bar on
// screen, a real image viewer (manual check: 実装済み・UI検証待ち).
const fs = require('fs'), path = require('path'), vm = require('vm');
const GB = require('../src/grok-bots');
const S = require('../src/state-schema');
const D = require('../src/diagnostics');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const SRC = path.join(__dirname, '..', 'src'), read = f => fs.readFileSync(path.join(SRC, f), 'utf8');

// ---- a tiny DOM: tagName / children / parentElement / getAttribute / textContent (+ src), from well-formed fixture HTML ----
const VOID = new Set(['IMG', 'BR', 'INPUT', 'META', 'LINK']);
let onClick = null;                                          // the fake page's reaction to a click (fakePage below)
function node(tag, attrs, parent) {
  const n = { nodeType: 1, tagName: tag, attrs, children: [], childNodes: [], parentElement: parent,
    getAttribute: k => Object.hasOwn(attrs, k) ? attrs[k] : null, click() { if (onClick) onClick(this); },
    get textContent() { return this.childNodes.map(c => typeof c === 'string' ? c : c.textContent).join(''); } };
  if (tag === 'IMG') n.src = attrs.src || '';
  return n;
}
function parseHtml(html) {
  const doc = { documentElement: null }; let cur = null;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g)) {
    if (m[4] !== undefined) { if (cur) cur.childNodes.push(m[4].replace(/&amp;/g, '&')); continue; }
    const tag = m[2].toUpperCase();
    if (m[1]) { cur = cur && cur.parentElement; continue; }
    const attrs = {}; for (const a of (m[3] || '').matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? '' : a[2].replace(/&amp;/g, '&');
    const n = node(tag, attrs, cur);
    if (cur) { cur.children.push(n); cur.childNodes.push(n); } else doc.documentElement = n;
    if (!VOID.has(tag)) cur = n;
  }
  return doc;
}
const U = i => `0e1f2a3b-4c5d-4e6f-8a9b-${String(i).padStart(12, '0')}`;
const SIDEBAR = (o = {}) => `<html><body>
<button data-sidebar="trigger"><span class="sr-only">Toggle Sidebar</span></button>
<div data-sidebar="sidebar">
  <div data-sidebar="group"><span>ホーム</span><a href="/c/1"><span>会話A</span></a></div>
  <div data-sidebar="group">
    <button aria-expanded="${o.expanded || 'true'}"><span>ボット</span><svg></svg></button>
    ${o.noBots ? '' : `<div>
      <span>ピン留め済み</span>
      <ul><li data-sidebar="menu-item"><a data-sidebar="menu-button" href="/bot/${U(1)}"><div data-testid="bot-avatar-stack"><img src="https://assets.grok.com/a1.png"><img src="https://assets.grok.com/a2.png"></div><span>Team 樹央</span></a><button data-sidebar="menu-action" aria-label="Team 樹央のオプション"><span class="sr-only">Team 樹央のオプション</span></button></li></ul>
      <span>稼働</span>
      <ul>
        <li><a data-sidebar="menu-button" href="/bot/${U(2)}"><img src="https://x-bucket.s3.amazonaws.com/i.png?X-Amz-Signature=abc&amp;X-Amz-Expires=600"><span>Tibo</span></a><button aria-haspopup="menu"><span>Tiboのオプション</span></button></li>
        <li><a data-sidebar="menu-button" href="/bot/${U(3)}?ref=side"><span>Grok   Bots</span></a></li>
      </ul>
      <span>Dev</span>
      <ul>
        <li><a data-sidebar="menu-button" href="https://grok.com/bot/${U(4)}"><span>鬼ﾉ樹央</span></a></li>
        <li><a data-sidebar="menu-button" href="/bot/${U(2)}"><span>Tibo（再掲）</span></a></li>
        <li><a data-sidebar="menu-button" href="/bot/not a bot"><span>bad</span></a></li>
        <li><a data-sidebar="menu-button" href="javascript:alert(1)//bot/x"><span>evil</span></a></li>
      </ul>
      <span>未割り当て</span>
      <ul><li><a data-sidebar="menu-button" href="/bot/${U(5)}"><span>   </span></a></li></ul>
      <span>待機</span>
      <ul><li><a data-sidebar="menu-button" href="/bot/${U(6)}"><div data-testid="bot-avatar-stack"></div><span>Nao-OS</span></a></li>
      ${o.less ? `<li><a data-sidebar="menu-button" href="/bot/${U(7)}"><img src="https://assets.grok.com/a7.webp"><span>Seven</span></a></li>` : ''}</ul>
      ${o.more === false ? '' : o.less ? '<button><span>少なく表示</span></button>' : '<button><span>さらに表示</span></button>'}
    </div>`}
  </div>
  <div data-sidebar="group"><span>履歴</span><a href="/c/2"><span>会話B</span></a><button><span>さらに表示</span></button></div>
</div></body></html>`;

// ---- the sidebar reader (scanSidebar) on the fixture ----
{ const s = GB.scanSidebar(parseHtml(SIDEBAR()));
  const secs = s.items.filter(x => x.t === 'sec').map(x => x.text), bots = s.items.filter(x => x.t === 'bot');
  t('scan: sidebar + ボット heading found, expanded, さらに表示 of the ボット section seen (the history one is outside it)', s.sidebar && s.head && s.expanded === 'true' && s.more === true && s.less === false && s.el.more && s.el.more.tagName === 'BUTTON');
  t(`scan: section labels in order, nothing outside the ボット section, no option / screen-reader text (${secs.join(' / ')})`, J(secs) === J(['ピン留め済み', '稼働', 'Dev', '未割り当て', '待機']));
  t(`scan: every Bot link of the section in page order (${bots.length})`, bots.length === 8 && bots[0].name === 'Team 樹央' && bots[1].name === 'Tibo' && bots[3].href === `https://grok.com/bot/${U(4)}`);
  t('scan: a group = it holds the avatar stack; its first image is the icon', bots[0].group === true && bots[0].icon === 'https://assets.grok.com/a1.png' && bots[7].group === true && bots[7].icon === '' && bots[1].group === false);
  t('scan: a link that is not a Bot gives neither a Bot nor a section label (javascript:)', !s.items.some(x => x.text === 'evil' || x.name === 'evil'));
  t('scan: no history link / no non-/bot/ link', !bots.some(b => /\/c\//.test(b.href)) && !s.items.some(x => /会話|ホーム|履歴|Toggle/.test(x.text || x.name || '')));
  const c = GB.scanSidebar(parseHtml(SIDEBAR({ expanded: 'false', noBots: true })));
  t('scan: the ボット section closed -> heading, expanded "false", no items', c.head && c.expanded === 'false' && c.items.length === 0 && !c.more);
  t('scan: no sidebar in the page -> sidebar false, nothing else', J(GB.scanSidebar(parseHtml('<html><body><main><a href="/bot/x"><span>x</span></a></main></body></html>'))) === J({ sidebar: false, head: false, expanded: '', more: false, less: false, items: [], el: { more: null, less: null } }));
  const l = GB.scanSidebar(parseHtml(SIDEBAR({ less: true })));
  t('scan: after さらに表示: 少なく表示 seen (the button to undo it)', l.less === true && l.more === false && l.el.less && l.el.less.tagName === 'BUTTON');
  const nh = GB.scanSidebar(parseHtml(SIDEBAR().replace('<span>ボット</span>', '<span>Library</span>')));
  t('scan: no ボット heading -> the whole sidebar is read (its Bots still found), but さらに表示 is never pressed without the heading', !nh.head && nh.items.filter(x => x.t === 'bot').length === 8 && GB.decide({ ...GB.start(0), readyAt: 1, orig: null }, { ready: true, items: nh.items, more: true, head: false }, 5000).act !== 'more'); }

// ---- scan -> the list (parse) ----
const scanned = GB.scanSidebar(parseHtml(SIDEBAR()));
const list = GB.parse(scanned);
t(`parse: Bots with id / url / name / group / section / order; duplicates, bad / foreign hrefs and nameless links left out (${list.map(b => b.name).join(', ')})`,
  J(list.map(b => [b.id, b.name, b.isGroup, b.section, b.order])) === J([[U(1), 'Team 樹央', true, 'ピン留め済み', 0], [U(2), 'Tibo', false, '稼働', 1], [U(3), 'Grok Bots', false, '稼働', 2], [U(4), '鬼ﾉ樹央', false, 'Dev', 3], [U(6), 'Nao-OS', true, '待機', 4]])
  && list.every(b => b.url === 'https://grok.com/bot/' + b.id));
t('parse: icons only https (a signed URL kept as it is) / image data', list[0].icon === 'https://assets.grok.com/a1.png' && /^https:\/\/x-bucket\.s3\.amazonaws\.com\/i\.png\?X-Amz-Signature=abc&X-Amz-Expires=600$/.test(list[1].icon) && list[2].icon === '');
t('parse: junk in -> nothing (no throw)', [null, undefined, 5, 'x', {}, { items: 'x' }, { items: [null, 5, { t: 'bot' }, { t: 'bot', href: 5, name: 'x' }, { t: 'bot', href: '/bot/__proto__', name: 'x' }] }].every(r => J(GB.parse(r)) === '[]'));
t('parse: a name is one line, control characters out, cut to NAME_MAX', (b => b.name === 'a b c' )(GB.parse({ items: [{ t: 'bot', href: '/bot/ab', name: 'a\nb\t\u0007c' }] })[0]) && GB.parse({ items: [{ t: 'bot', href: '/bot/ab', name: 'あ'.repeat(99) }] })[0].name.length === GB.NAME_MAX);
t('parse: icons: javascript: / http: / a non-image data URL dropped', ['javascript:alert(1)', 'http://assets.grok.com/a.png', 'data:text/html;base64,PGI+', 'https://u:p@grok.com/a.png'].every(i => GB.parse({ items: [{ t: 'bot', href: '/bot/ab', name: 'x', icon: i }] })[0].icon === ''));
t('parse: at most MAX_BOTS', GB.parse({ items: Array.from({ length: GB.MAX_BOTS + 20 }, (_, i) => ({ t: 'bot', href: '/bot/b' + i, name: 'n' + i })) }).length === GB.MAX_BOTS);
{ const png = 'data:image/png;base64,' + 'A'.repeat(200) + '==';
  const w = GB.withIcons(list, { 'https://assets.grok.com/a1.png': png, [list[1].icon]: 'data:text/html;base64,AAAA' });
  t('withIcons: the small data URL it made, else the https URL as it was, a non-image result ignored', w[0].icon === png && w[1].icon === list[1].icon && w[2].icon === '' && GB.withIcons(list, null)[0].icon === list[0].icon);
  t('withIcons: a data URL over ICON_MAX is not kept', GB.withIcons([{ ...list[0], icon: 'data:image/png;base64,' + 'A'.repeat(GB.ICON_MAX) }], {})[0].icon === ''); }

// ---- merge / pins / names / view ----
const g0 = GB.merge(GB.empty(), list, 1000).grok;
t('merge into nothing: all added, the page order, time kept, a clean list', (m => m.added === 5 && m.removed === 0 && m.grok.at === 1000 && GB.valid(m.grok))(GB.merge(GB.empty(), list, 1000)) && J(g0.bots.map(b => b.order)) === '[0,1,2,3,4]');
let g = GB.pin(GB.pin(g0, U(4), true), U(2), true);
g = GB.rename(g, U(2), 'ティボ'); g = GB.rename(g, U(3), '  ');
t('pin: listed Bots only, once each, in the order pinned; unpin', J(g.pins) === J([U(4), U(2)]) && GB.pin(g, 'nope', true) === g && GB.pin(g, U(4), true) === g && J(GB.pin(g, U(4), false).pins) === J([U(2)]));
t('rename: a name of its own for this bar; empty / the page name = the page name again', g.aliases[U(2)] === 'ティボ' && !Object.hasOwn(g.aliases, U(3)) && !Object.hasOwn(GB.rename(g, U(2), '').aliases, U(2)) && !Object.hasOwn(GB.rename(g, U(2), 'Tibo').aliases, U(2)) && GB.rename(g, 'nope', 'x') === g);
t('movePin: dropped onto another pin takes its place (as the favorites); not pinned / same: unchanged', J(GB.movePin(g, U(2), U(4)).pins) === J([U(2), U(4)]) && GB.movePin(g, U(2), U(2)) === g && GB.movePin(g, U(1), U(2)) === g);
{ const v = GB.view(g);
  t('view: pins in their order with the shown name; sections in the page order; each item says pinned / group / original name', J(v.pins.map(b => b.name)) === J(['鬼ﾉ樹央', 'ティボ']) && v.pins[1].orig === 'Tibo'
    && J(v.sections.map(s => [s.name, s.items.length])) === J([['ピン留め済み', 1], ['稼働', 2], ['Dev', 1], ['待機', 1]]) && v.sections[1].items[0].pinned === true && v.sections[0].items[0].group === true && v.count === 5); }
{ const next = [list[1], { ...list[0], name: 'Team 樹央 2', section: '稼働' }, { id: 'new-bot', url: 'https://grok.com/bot/new-bot', name: '新入り', isGroup: false, section: 'Dev', order: 9, icon: '' }];
  const m = GB.merge(g, next, 2000);
  t('merge: new ones added, gone ones removed (and unpinned), names / sections updated, order = the new page order', m.added === 1 && m.removed === 3 && m.changed === 1
    && J(m.grok.bots.map(b => [b.id, b.name, b.section, b.order])) === J([[U(2), 'Tibo', '稼働', 0], [U(1), 'Team 樹央 2', '稼働', 1], ['new-bot', '新入り', 'Dev', 2]]) && J(m.grok.pins) === J([U(2)]));
  t('merge: the user\'s names stay (also of a Bot gone for now: back with it)', m.grok.aliases[U(2)] === 'ティボ' && GB.valid(m.grok)); }
{ const favs = [{ id: 1, url: 'https://example.com/', label: 'ex' }, { id: 2, url: `https://grok.com/bot/${U(6)}`, label: 'NaoOS' }, { id: 3, url: 'https://grok.com/bot/unknown-bot', label: 'u' }];
  const a = GB.absorbFavs(g0, favs);
  t('absorbFavs: a favorite that is a listed Bot becomes its pin; the others stay as they were (same objects)', a.moved === 1 && J(a.grok.pins) === J([U(6)]) && a.keep.length === 2 && a.keep[0] === favs[0] && a.keep[1] === favs[2]);
  t('addUrl (お気に入りに追加): a listed Bot -> pinned; another URL / an unknown Bot -> an ordinary favorite', (r => r.pinned && J(r.grok.pins) === J([U(3)]))(GB.addUrl(g0, `https://grok.com/bot/${U(3)}?x=1`))
    && !GB.addUrl(g0, 'https://grok.com/bot/unknown-bot').pinned && !GB.addUrl(g0, 'https://example.com/').pinned && !GB.addUrl(g0, `https://grok.com.evil.example/bot/${U(3)}`).pinned); }
t('note: counts only (+added −removed); a failure keeps the list and says so', GB.note('OK', { grok: g0, added: 2, removed: 1 }) === 'Bot 5件を読み込みました（+2 −1）' && GB.note('OK', { grok: g0, added: 0, removed: 0 }) === 'Bot 5件を読み込みました'
  && GB.CODES.filter(c => GB.NOTE[c]).every(c => /一覧はそのまま/.test(GB.note(c))) && /一覧はそのまま/.test(GB.note('???')));

// ---- the saved shape (panes.json `grok`) ----
{ const raw = { bots: [...g.bots, { id: '__proto__', name: 'x' }, { id: 'a b', name: 'x' }, { id: U(1), name: 'dup' }, { id: 'noname', name: ' ' }, { id: 'ic', name: 'i', icon: 'javascript:x' }, 5],
    aliases: { ...g.aliases, 'bad id': 'x', [U(1)]: '' }, pins: [...g.pins, 'ghost', U(4)], at: -3 };
  const c = GB.clean(raw);
  t('clean: unusable Bots / names / pins / icons dropped, never a throw; the result is valid', !c.same && GB.valid(c.grok) && c.grok.bots.length === 6 && c.grok.bots[5].icon === '' && J(c.grok.pins) === J(g.pins) && c.grok.at === 0 && J(Object.keys(c.grok.aliases)) === J([U(2)]));
  t('clean: what it keeps is kept as is (same)', GB.clean(g).same && GB.clean(GB.empty()).same && [null, 5, 'x', []].every(v => J(GB.clean(v).grok) === J(GB.empty())));
  const file = { schema: 1, windows: [{ layout: '2x2', focused: 0, panes: [{ url: '' }], rows: [1] }], favorites: [{ url: 'https://example.com/', label: 'ex' }], settings: {}, workspaces: {} };
  const m0 = S.migrate(file);
  t('schema: a file without grok reads as before (no grok in the doc, none written)', m0.ok && !('grok' in m0.doc) && !m0.fixes.length && !/"grok"/.test(S.serialize(m0.doc)));
  const m1 = S.migrate({ ...file, grok: g });
  t('schema: grok read and written back as it was', m1.ok && !m1.fixes.length && J(m1.doc.grok) === J(g) && J(JSON.parse(S.serialize(m1.doc)).grok) === J(g) && S.parse(S.serialize(m1.doc)).ok);
  const m2 = S.migrate({ ...file, grok: raw });
  t('schema: a broken grok is repaired (never fatal), the rest of the file untouched', m2.ok && m2.fixes.includes('grok: repaired') && J(m2.doc.grok) === J(c.grok) && J(m2.doc.favorites) === J(file.favorites));
  t('schema: a grok of the wrong type is dropped to an empty list (still ready)', [5, 'x', [1]].every(v => (r => r.ok && J(r.doc.grok) === J(GB.empty()))(S.migrate({ ...file, grok: v }))));
  t('schema: validate() refuses an unclean grok before a write', S.validate({ ...m1.doc, grok: raw }).some(e => /^grok:/.test(e)) && !S.validate(m1.doc).length && !S.validate({ ...m1.doc, grok: undefined }).length); }

// ---- the old favorites, once ----
{ const now = new Date(2026, 9, 22, 9, 5, 7);
  const m = GB.migration([{ id: 1, url: 'https://example.com/', label: 'ex' }, { id: 2, url: 'https://grok.com/bot/x' }, { url: 5 }], now);
  t('migration: the old favorites (url + label) in favorites.backup-<日時>.json', m.file === 'favorites.backup-20261022-090507.json' && m.n === 2 && J(JSON.parse(m.text).favorites) === J([{ url: 'https://example.com/', label: 'ex' }, { url: 'https://grok.com/bot/x', label: '' }]) && JSON.parse(m.text).savedAt === now.toISOString());
  t('migration: nothing to keep -> no file', GB.migration([], now).file === '' && GB.migration(undefined, now).n === 0); }

// ---- the read (decide) ----
{ const H = (o = {}) => ({ ready: true, ls: 'false', trigger: true, signin: false, sidebar: true, head: false, expanded: '', more: false, items: [], ...o });
  const bot = { t: 'bot', href: '/bot/a', name: 'a' };
  const run = (steps) => { let rs = GB.start(0); const acts = []; for (const [at, o] of steps) { const d = GB.decide(rs, o, at); rs = d.rs; acts.push(d.act); } return { acts, rs }; };
  t('decide: waits for the page; gives up after TIMEOUT_MS', GB.decide(GB.start(0), { ready: false }, 100).act === 'wait' && GB.decide(GB.start(0), null, 100).act === 'wait' && GB.decide(GB.start(0), H(), GB.TIMEOUT_MS + 1).act === 'TIMEOUT');
  t('decide: a stopped move off grok.com -> AUTH on a sign-in page, else OFFSITE', GB.decide(GB.start(0), { left: 'https://accounts.x.ai/sign-in?redirect=grok-com' }, 10).act === 'AUTH' && GB.decide(GB.start(0), { left: 'https://example.com/' }, 10).act === 'OFFSITE');
  const a = run([[400, H()], [1000, H()], [1900, H()], [2300, H({ ls: 'true' })], [3000, H({ ls: 'true', head: true })], [3400, H({ ls: 'true', head: true, items: [bot] })], [4300, H({ ls: 'true', head: true, items: [bot] })]]);
  t(`decide: closed sidebar ("false") -> toggle once after 1.5 s, then the list, collected once still (${a.acts.join(' ')})`, J(a.acts) === J(['wait', 'wait', 'open', 'wait', 'wait', 'wait', 'collect']) && a.rs.orig === 'false' && a.rs.opened && GB.touched(a.rs));
  const b = run([[400, H({ ls: null })], [2000, H({ ls: null })], [4500, H({ ls: null })]]);
  t('decide: sidebarOpen never set -> waits longer (4 s) before the toggle; orig = null', J(b.acts) === J(['wait', 'wait', 'open']) && b.rs.orig === null);
  const c = run([[400, H({ ls: 'true' })], [3000, H({ ls: 'true' })], [9000, H({ ls: 'true' })]]);
  t('decide: sidebar said open: never toggled; nothing found -> EMPTY after 8 s', J(c.acts) === J(['wait', 'wait', 'EMPTY']) && !c.rs.opened && !GB.touched(c.rs));
  const d = run([[400, H()], [2000, H()], [2400, H()], [12000, H()]]);
  t('decide: the toggle is pressed at most once', d.acts.filter(x => x === 'open').length === 1 && d.acts[3] === 'EMPTY');
  const e = run([[400, H({ ls: 'true', head: true, expanded: 'false' })], [2000, H({ ls: 'true', head: true, expanded: 'false' })]]);
  t('decide: the ボット section closed in grok.com -> COLLAPSED (it is not opened for the user)', J(e.acts) === J(['wait', 'COLLAPSED']));
  const f = run([[400, H({ ls: 'true', head: false, signin: true, trigger: false })], [3500, H({ ls: 'true', signin: true, trigger: false })]]);
  t('decide: a sign-in link and no list -> AUTH', J(f.acts) === J(['wait', 'AUTH']));
  const mo = [bot, { ...bot, href: '/bot/b' }];
  const h = run([[400, H({ ls: 'true', head: true, items: [bot], more: true })], [1400, H({ ls: 'true', head: true, items: [bot], more: true })], [1800, H({ ls: 'true', head: true, items: [bot], more: true })], [2400, H({ ls: 'true', head: true, items: mo, more: false, less: true })], [3300, H({ ls: 'true', head: true, items: mo, less: true })]]);
  t(`decide: さらに表示 pressed (not twice within 0.9 s), then the longer list collected (${h.acts.join(' ')})`, J(h.acts) === J(['wait', 'more', 'wait', 'wait', 'collect']) && h.rs.more === 1 && GB.touched(h.rs));
  let rs = { ...GB.start(0), readyAt: 1, orig: 'true' }, more = 0;
  for (let at = 1000; at < 20000; at += 1000) { const r = GB.decide(rs, H({ ls: 'true', head: true, items: [bot], more: true }), at); rs = r.rs; if (r.act === 'more') more++; }
  t('decide: さらに表示 at most MORE_MAX times, then what is there is collected', more === GB.MORE_MAX && GB.decide(rs, H({ ls: 'true', head: true, items: [bot], more: true }), 30000 - 1).act !== 'more');
  t('decide: sidebarOpen as found = the first ready observation, never one after a click of ours', (r => r.rs.orig === 'false')(run([[400, H()], [2000, H()], [2400, H({ ls: 'true' })]]))); }

// ---- the page-side scripts ----
{ const ok = s => { try { new vm.Script(s); return true; } catch { return false; } };
  const evil = `x');alert(1)//"\`\${1}`;
  t('scripts compile: state / toggle / さらに表示 / icons / undo', [GB.STATE_JS, GB.CLICK_JS('trigger'), GB.CLICK_JS('more'), GB.ICONS_JS(['https://a.example/i.png']), GB.RESTORE_JS({ orig: 'false', opened: true, more: 1 }), GB.RESTORE_JS({ orig: null, opened: false, more: 0 }), GB.RESTORE_JS({ orig: evil, opened: true, more: 0 })].every(ok));
  t('undo: sidebarOpen as found put in as a JSON value only (a quote cannot end the script)', GB.RESTORE_JS({ orig: evil, opened: true, more: 0 }).includes(`const O=${J(evil)}`) && GB.RESTORE_JS({ orig: undefined, opened: true, more: 0 }).includes('const O=null'));
  t('undo: 少なく表示 only when さらに表示 was pressed, the toggle only when it opened the sidebar', /if\(true\)\{const s=/.test(GB.RESTORE_JS({ orig: 'true', opened: false, more: 2 })) && /if\(false\)\{const s=/.test(GB.RESTORE_JS({ orig: 'true', opened: false, more: 0 }))
    && /if\(false&&ls\(\)!==O\)/.test(GB.RESTORE_JS({ orig: 'true', opened: false, more: 0 })) && /if\(true&&ls\(\)!==O\)/.test(GB.RESTORE_JS({ orig: 'false', opened: true, more: 0 })));
  t('icons: only https / image data sources go in (javascript: / http: dropped), as JSON', (s => s.includes(J(['https://a.example/i.png'])) && !/javascript:|http:\/\/b/.test(s))(GB.ICONS_JS(['https://a.example/i.png', 'javascript:alert(1)', 'http://b.example/x.png', 'https://a.example/i.png'])));
  t('scripts: no internal API, no typing / sending, no navigation (only the toggle / さらに表示 / 少なく表示 are clicked)', [GB.STATE_JS, GB.CLICK_JS('trigger'), GB.CLICK_JS('more'), GB.ICONS_JS([]), GB.RESTORE_JS({ orig: 'x', opened: true, more: 1 })].every(s => !/fetch\(|XMLHttpRequest|grok_api|execCommand|\.value\s*=|submit|location\s*=|location\.(href|assign|replace)|history\.|\.push\(['"`]\//.test(s))
    && (GB.STATE_JS + GB.CLICK_JS('trigger') + GB.CLICK_JS('more') + GB.RESTORE_JS({ orig: 'x', opened: true, more: 1 })).match(/\.click\(\)/g).length === 4);
  t('navOk: https://grok.com only', GB.navOk('https://grok.com/') && GB.navOk('https://grok.com/bot/x?y=1') && !['http://grok.com/', 'https://accounts.x.ai/sign-in', 'https://grok.com.evil.example/', 'https://x.grok.com/', 'https://grok.com:444/', 'https://u:p@grok.com/', 'javascript:x', '', null].some(GB.navOk)); }

// ---- the scripts themselves on a fake grok.com page (vm): the toggle / さらに表示 react like the page, localStorage is the page's ----
function fakePage({ ls, signin = false }) {
  const store = new Map(); if (ls !== null) store.set('sidebarOpen', ls);
  const pg = { open: ls === 'true', expanded: false, clicks: [] };
  const html = () => pg.open ? (signin ? '<html><body><button data-sidebar="trigger"><span>Toggle</span></button><div data-sidebar="sidebar"><span>ログイン</span></div></body></html>' : SIDEBAR({ less: pg.expanded }))
    : '<html><body><button data-sidebar="trigger"><span>Toggle</span></button><main><span>こんにちは</span></main></body></html>';
  const click = n => {
    const s = n.textContent.trim(); pg.clicks.push(n.getAttribute('data-sidebar') === 'trigger' ? 'toggle' : s);
    if (n.getAttribute('data-sidebar') === 'trigger') { pg.open = !pg.open; store.set('sidebarOpen', String(pg.open)); }   // the page writes it, as grok.com does
    else if (s === 'さらに表示') pg.expanded = true; else if (s === '少なく表示') pg.expanded = false;
  };
  const find = (root, f) => { for (const c of root.children) { if (f(c)) return c; const x = find(c, f); if (x) return x; } return null; };
  const document = {
    readyState: 'complete', get documentElement() { return parseHtml(html()).documentElement; },
    querySelector(sel) {
      const root = this.documentElement;
      if (sel === '[data-sidebar="trigger"]') return find(root, n => n.getAttribute('data-sidebar') === 'trigger');
      if (/password|sign-in/.test(sel)) return signin ? {} : null;
      throw new Error('selector not in the fake page: ' + sel);
    },
    createElement: tag => tag === 'canvas' ? { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' } : {},
  };
  class Image { set src(v) { this._s = v; setTimeout(() => (/\.webp$/.test(v) ? this.onerror() : (this.naturalWidth = 64, this.naturalHeight = 48, this.onload())), 5); } }   // .webp: as if CORS refused
  const ctx = vm.createContext({ document, localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }, Image, setTimeout, clearTimeout });
  const run = code => { onClick = click; try { return vm.runInContext(code, ctx); } finally { onClick = null; } };
  return { pg, store, run: async code => { onClick = click; try { return JSON.parse(JSON.stringify(await vm.runInContext(code, ctx))); } finally { onClick = null; } }, runSync: run };
}
async function readOn(page) {                                 // main's loop (grokRefresh) with a fake clock
  let rs = GB.start(0), now = 0, bots = null; const acts = [];
  for (let i = 0; i < 120; i++) {
    now += 400;
    const o = await page.run(GB.STATE_JS), d = GB.decide(rs, o, now); rs = d.rs; acts.push(d.act);
    if (d.act === 'open') await page.run(GB.CLICK_JS('trigger'));
    else if (d.act === 'more') await page.run(GB.CLICK_JS('more'));
    else if (d.act === 'collect') { bots = GB.parse(o); break; }
    else if (d.act !== 'wait') break;
  }
  const back = GB.touched(rs) ? await page.run(GB.RESTORE_JS(rs)) : null;
  return { rs, acts, bots, back, code: acts[acts.length - 1] };
}
async function pageRuns() {
  { const p = fakePage({ ls: 'false' }), r = await readOn(p);
    t(`page: closed sidebar -> toggle, さらに表示, the whole list (${r.bots && r.bots.length}); clicks: ${p.pg.clicks.join(' / ')}`, r.code === 'collect' && r.bots.length === 6 && r.bots[5].name === 'Seven' && J(p.pg.clicks) === J(['toggle', 'さらに表示', '少なく表示', 'toggle']));
    t('page: everything undone (sidebar closed, list short, sidebarOpen "false" as found) and confirmed', !p.pg.open && !p.pg.expanded && p.store.get('sidebarOpen') === 'false' && r.back.ok === true && r.back.fixed === false);
    const icons = await p.run(GB.ICONS_JS(r.bots.map(b => b.icon))), w = GB.withIcons(r.bots, icons);
    t('page: icons made 32 px data URLs where the image allows it; a refused one keeps its URL', w[0].icon === 'data:image/png;base64,iVBORw0KGgo=' && w[5].icon === 'https://assets.grok.com/a7.webp' && w[2].icon === '' && !Object.hasOwn(icons, 'https://assets.grok.com/a7.webp')); }
  { const p = fakePage({ ls: null }), r = await readOn(p);
    t('page: sidebarOpen never set -> after the read it is not set again (removed: the page had written "false" on the second toggle)', r.code === 'collect' && !p.store.has('sidebarOpen') && r.back.ok && r.back.fixed && !p.pg.open); }
  { const p = fakePage({ ls: 'true' }), r = await readOn(p);
    t('page: sidebar already open -> no toggle at all; only さらに表示 / 少なく表示; sidebarOpen untouched', r.code === 'collect' && J(p.pg.clicks) === J(['さらに表示', '少なく表示']) && p.pg.open && !p.pg.expanded && p.store.get('sidebarOpen') === 'true' && r.back.ok); }
  { const p = fakePage({ ls: 'false', signin: true }), r = await readOn(p);
    t(`page: signed out (no list, a sign-in link) -> AUTH, the toggle undone (${r.code})`, r.code === 'AUTH' && J(p.pg.clicks) === J(['toggle', 'toggle']) && p.store.get('sidebarOpen') === 'false' && r.back.ok && !r.bots); }
}

// ---- diagnostics ----
t('diagnostics: gbar codes = grok-bots.js CODES; the image setting shown as on / off', J([...D.GBAR_CODES].sort()) === J([...GB.CODES].sort()) && GB.CODES.every(c => D.EVENTS.gbar.r.includes(c)) && D.SETTINGS.autoImg === 'bool'
  && D.safeEnv({ settings: { autoImg: false } }).settings.autoImg === false);

// ---- 画像クリックで最大化: the built pane preload in a vm, a recording ipcRenderer, a fake page ----
function imgPreload(host = 'grok.com') {
  const sent = [], listeners = {}, timers = [];
  let dialogs = [];
  const document = { documentElement: {}, readyState: 'complete', querySelector: () => null, querySelectorAll: s => s.includes('dialog') ? dialogs : [] };
  const ctx = vm.createContext({
    require: m => { if (m !== 'electron') throw new Error(m); return { ipcRenderer: { send: (ch, ...a) => sent.push([ch, ...a]), on: () => {} }, webFrame: { insertCSS: () => {}, removeInsertedCSS: () => {}, setZoomFactor: () => {} } }; },
    window: { addEventListener: (k, f, cap) => { (listeners[k] = listeners[k] || []).push(f); } }, document, location: { hostname: host, pathname: '/bot/x' },
    MutationObserver: class { observe() {} }, setTimeout: () => 0, clearTimeout: () => {}, setInterval: f => { timers.push(f); return timers.length; }, clearInterval: i => { if (i) timers[i - 1] = null; },
  });
  vm.runInContext(read('pane-preload.js'), ctx);
  const click = (target, o = {}) => { const e = { isTrusted: true, button: 0, target, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...o }; (listeners.click || []).forEach(f => f(e)); return e; };
  const tick = (n = 1) => { for (let i = 0; i < n; i++) timers.forEach(f => f && f()); };
  return { sent, click, tick, setDialogs: d => { dialogs = d; } };
}
const img = (o = {}) => ({ nodeType: 1, tagName: 'IMG', currentSrc: 'https://assets.grok.com/gen/abc.jpg', src: '', closest: () => null, getBoundingClientRect: () => ({ width: 320, height: 240 }), ...o });
const dialog = (media = true) => ({ querySelector: () => (media ? {} : null) });
{ const P = imgPreload(), e = P.click(img());
  t('img: a real click on a large image of grok.com -> img-opened; the click is not stopped or prevented', J(P.sent) === J([['pane:img-opened']]) && !e.prevented && !e.stopped);
  P.tick(2); P.setDialogs([dialog()]); P.tick(3);
  t('img: its viewer appeared -> nothing more while it is open', P.sent.length === 1);
  P.setDialogs([]); P.tick(1);
  t('img: a re-render (gone for one look) is still the viewer', P.sent.length === 1);
  P.tick(1);
  t('img: the viewer gone (twice in a row) -> img-closed(true) once', J(P.sent) === J([['pane:img-opened'], ['pane:img-closed', true]]));
  P.tick(10);
  t('img: then the watch stops (no second message)', P.sent.length === 2); }
{ const P = imgPreload(); P.click(img()); P.tick(4);
  t('img: still looking for a viewer at 1.2 s', P.sent.length === 1); P.tick(1);
  t('img: no viewer within 1.5 s -> img-closed(false) (the pane stays maximized)', J(P.sent) === J([['pane:img-opened'], ['pane:img-closed', false]]));
  const Q = imgPreload(); Q.setDialogs([dialog()]); Q.click(img()); Q.tick(6);
  t('img: a dialog already open before the click is not its viewer', J(Q.sent) === J([['pane:img-opened'], ['pane:img-closed', false]])); }
{ const none = (target, o, host) => { const P = imgPreload(host); P.click(target, o); P.tick(8); return P.sent.length === 0; };
  t('img: untrusted (a script\'s click) / not the main button -> nothing', none(img(), { isTrusted: false }) && none(img(), { button: 1 }));
  t('img: avatars / icons (< 48 px either way) and svg files -> nothing', none(img({ getBoundingClientRect: () => ({ width: 40, height: 300 }) })) && none(img({ getBoundingClientRect: () => ({ width: 300, height: 47 }) }))
    && none(img({ currentSrc: 'https://grok.com/icons/x.svg' })) && none(img({ currentSrc: 'data:image/svg+xml;base64,AAAA' })));
  t('img: in the sidebar / header / nav / an avatar stack / a link / a dialog -> nothing', none(img({ closest: () => ({}) })));
  t('img: not an image (text, a button without one image) -> nothing; another site -> nothing', none({ nodeType: 1, tagName: 'P', closest: () => null }) && none({ nodeType: 1, tagName: 'DIV', closest: () => ({ querySelectorAll: () => [img(), img()] }) })
    && none(img(), {}, 'example.com') && none(img(), {}, 'x.grok.com'));
  const P = imgPreload(); P.click({ nodeType: 1, tagName: 'SPAN', closest: () => ({ querySelectorAll: () => [img()] }) });
  t('img: a button over exactly one image counts as that image', J(P.sent) === J([['pane:img-opened']])); }
{ const tp = read('pane-preload.template.js'), body = tp.slice(tp.indexOf('function imgClicked'), tp.indexOf("window.addEventListener('click'"));
  t('img: the template has it (the built preload is generated from it), no preventDefault / stopPropagation in it, capture listener', body.length > 200 && !/preventDefault|stopPropagation/.test(body) && /window\.addEventListener\('click', e => \{ try \{ imgClicked\(e\); \} catch \{\} \}, true\);/.test(tp)); }

// ---- main.js contract ----
{ const main = read('main.js');
  const fn = name => { const i = main.indexOf(`function ${name}(`); if (i < 0) return ''; let d = 0, j = main.indexOf('{', main.indexOf(')', i)); for (; j < main.length; j++) { if (main[j] === '{') d++; else if (main[j] === '}' && --d === 0) break; } return main.slice(i, j + 1); };
  t('main: img-opened maximizes only with settings.autoImg on (default on), awake, on grok.com, not during the cloud PC', /settings\.autoImg === false/.test(main) && /paneOn\('pane:img-opened', p => \{[^\n]*\n\s*if \(p\.imgMax \|\| p\.pcMax \|\| p\.sleeping \|\| settings\.autoImg === false \|\| !\/\^https:\\\/\\\/grok\\\.com\\\/\/\.test/.test(main));
  t('main: setImgMax gives back only what it fully maximized itself, and only when the viewer closed, without taking focus', /if \(on\) \{ if \(maximizedId !== p\.id \|\| maxMode !== 'full'\) \{ toggleMaximize\(p\.id\); p\.imgMaxedPane = true; \} else p\.imgMaxedPane = false; \}/.test(fn('setImgMax')) && /if \(back && mine && maximizedId === p\.id && maxMode === 'full'\) toggleMaximize\(p\.id, false\);/.test(fn('setImgMax'))
    && /paneOn\('pane:img-closed', \(p, viewer\) => \{ if \(p\.imgMax\) setImgMax\(p, false, viewer === true\); \}\);/.test(main) && !/mpb:pc/.test(fn('setImgMax')));
  t('main: Esc goes to the image viewer first (as the cloud PC); a new page drops the image state', /if \(pane\?\.imgMax\) return false;/.test(fn('handleKey')) && /if \(p\.imgMax\) setImgMax\(p, false\); \}\);/.test(main));
  t('main: 設定 has the image setting (checked unless turned off)', /checked: settings\.autoImg !== false, click: m => \{ settings\.autoImg = m\.checked; save\(\); \}/.test(fn('buildMenu')));
  t('main: the list is saved in panes.json (grok) and read at startup; never read by itself (no timer / startup call)', /favorites: favorites\.map\(\(\{ url, label \}\) => \(\{ url, label \}\)\), grok, settings, workspaces \};/.test(fn('stateDoc')) && /grok = st\.grok \|\| GB\.empty\(\);/.test(fn('startup'))
    && (main.replace('async function grokRefresh()', '').match(/grokRefresh\(\)/g) || []).length === 1 && /^on\('gbar-refresh', \(\) => grokRefresh\(\)\);/m.test(main));
  t('main: the old favorites move once, only from a ready panes.json, only after their backup is written (wx)', /if \(ld\.status === 'ready' && !settings\.favGrokV1\) gbMigrate\(\);/.test(fn('startup')) && /flag: 'wx'[\s\S]*return; \}[\s\S]*favorites = \[\]; settings\.favGrokV1 = true; save\(\);/.test(fn('gbMigrate')));
  t('main: one read at a time; the hidden window is muted, sandboxed, without preload, in the background-check role; clicks undone before it closes', /if \(gbRun\) \{ diag\.rec\('gbar', 'BUSY'\); return; \}/.test(fn('grokRefresh')) && /wc\.setAudioMuted\(true\)/.test(fn('grokRefresh')) && /show: false/.test(fn('grokRefresh'))
    && /regWc\(wc, 'probe', \{ ctx: null \}\)/.test(fn('grokRefresh')) && /finally \{\s*await undo\(\)[\s\S]*bw\.destroy\(\)/.test(fn('grokRefresh')) && fn('grokRefresh').indexOf('await undo();') < fn('grokRefresh').indexOf('GB.ICONS_JS'));
  t('main: a failed read keeps the list (it changes only on OK)', /if \(code === 'OK'\) \{\s*m = GB\.merge\(grok, bots, Date\.now\(\)\);/.test(fn('grokRefresh')) && (fn('grokRefresh').match(/grok = /g) || []).length === 1);
  t('main: お気に入りに追加 of a listed Bot pins it; the Bots open like favorites', /const r = GB\.addUrl\(grok, url\); if \(r\.pinned\)/.test(fn('addFavorite')) && /openFavorite\(null, where, \{ id: 'g:' \+ b\.id, url: b\.url, label: GB\.nameOf\(grok, b\) \}\)/.test(fn('openGrokBot')));
  const gbCode = ['grokRefresh', 'gbMigrate', 'gbotMenu', 'openGrokBot', 'setImgMax'].map(fn).join('\n');
  t('main: the read restores the sidebar before the icons and before the window goes; the outcome goes to the bar', /back = await gbJs\(wc, GB\.RESTORE_JS\(rs\), 4000\)/.test(fn('grokRefresh')) && /gbSay\(GB\.note\(code, m\)/.test(fn('grokRefresh')));
  t('main: nothing of the list is logged (counts / codes only)', gbCode.length > 2000 && (gbCode.match(/dlog\([^\n]*/g) || []).every(l => !/name|url|icon|label|bots\.map|grok\.bots|left|favorites/i.test(l.replace(/dlog\('grok bar', '[^']*'/, '').replace('e && e.name', '')))); }   // an error's type name only

pageRuns().catch(e => { bad++; console.log('FAIL page runs threw:', e && e.message); })
  .then(() => { console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0); });
