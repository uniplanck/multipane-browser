// node test/gbar-mode.test.js — Grokバーの表示モード (src/gbar-mode.js): display widths (East Asian Width: W / F 2, A 2, the rest 1; combining
// marks / ZWJ / variation selectors / format characters 0; a grapheme cluster is one character), the cut of セミコンパクト (whole characters, at most
// 4 units, no ellipsis) with fixed and random cases against an independent count, the cycle 通常 → セミコンパクト → コンパクト → 通常 and its repair;
// settings.gbarMode in panes.json (state-schema.js: kept, repaired to normal, validated, round trip); the wiring in main.js / ipc-policy.js /
// preload.js / index.html / style.css; then renderer.js' Grok bar run in a vm on a tiny fake DOM: the right-click, what each mode shows (pins,
// favorites, sections) and the pages measured again on every mode change and resize. Not covered here: the real bar on screen (fonts, Chromium's
// widths, the tooltip, the right-click itself) - manual check.
const fs = require('fs'), path = require('path'), vm = require('vm');
const GM = require('../src/gbar-mode');
const S = require('../src/state-schema');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const SRC = path.join(__dirname, '..', 'src'), read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const U = (...c) => String.fromCodePoint(...c);               // characters that do not show (marks, joiners, selectors) are built, not typed
const ZWJ = U(0x200d), VS16 = U(0xfe0f);
const MAN_PC = U(0x1f468, 0x200d, 0x1f4bb), FLAG_JP = U(0x1f1ef, 0x1f1f5), THUMB = U(0x1f44d, 0x1f3fd), HEART = U(0x2764), KEYCAP1 = U(0x31, 0xfe0f, 0x20e3);
const RAINBOW = U(0x1f3f3, 0xfe0f, 0x200d, 0x1f308), ENGLAND = U(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f);
const E_ACUTE = 'e' + U(0x301), GA = 'か' + U(0x3099), HANGUL_GA = U(0x1100, 0x1161);

// ---- the tables ----
{ const ordered = r => r.every(([a, b], i) => a <= b && (!i || r[i - 1][1] < a));
  t(`tables: ascending, no overlap (W/F ${GM.RANGES.WIDE.length}, A ${GM.RANGES.AMBI.length} ranges)`, ordered(GM.RANGES.WIDE) && ordered(GM.RANGES.AMBI) && GM.RANGES.AMBI.length > 150); }

// ---- eaw: one character as shown ----
const each = (list, w) => list.filter(c => GM.eaw(c) !== w);
{ const W = ['あ', 'ア', 'ン', '漢', '字', '한', '、', '。', '「', '」', '【', 'ー', '〜', '・', '㈱', '㌔', '𠮷', U(0x1f202)];
  const F = ['Ａ', 'ｚ', '１', '（', '！', '￥', U(0x3000)];
  const N = ['a', 'Z', '0', ' ', '~', '-', 'ｱ', 'ﾞ', '©', '«', '¢', '₩', HEART, U(0x263a), 'ä'.normalize('NFD')[0]];
  const A = ['é', 'ü', 'ß', 'æ', 'α', 'Ω', 'Ж', 'ё', '①', '⑳', 'Ⅻ', '★', '☆', '→', '⇒', '※', '…', '‥', '°', '±', '×', '÷', '■', '□', '○', '◆', '▲', '♪', '€', '™', '§', '¶', U(0xe000), U(0xfffd)];
  t(`eaw: W (kana, kanji, hangul, CJK punctuation, supplementary-plane kanji) = 2${each(W, 2).length ? ' — not: ' + each(W, 2) : ''}`, !each(W, 2).length);
  t(`eaw: F (full-width ASCII / signs, ideographic space) = 2${each(F, 2).length ? ' — not: ' + each(F, 2) : ''}`, !each(F, 2).length);
  t(`eaw: Na / H / N (ASCII, half-width katakana, ©, ₩, a text-style ❤) = 1${each(N, 1).length ? ' — not: ' + each(N, 1) : ''}`, !each(N, 1).length);
  t(`eaw: A (ambiguous: accented Latin, Greek, Cyrillic, ①, Ⅻ, ★, →, ※, …, °, ×, ■, ○, ♪, €, ™, private use, U+FFFD) = AMB = 2${each(A, 2).length ? ' — not: ' + each(A, 2) : ''}`, GM.AMB === 2 && !each(A, 2).length); }
{ const Z = [U(0x301), U(0x3099), U(0x20e3), ZWJ, U(0x200c), U(0x200b), VS16, U(0xfe0e), U(0xe0100), U(0xad), U(0x2060), U(0xfeff), U(0xe0067), U(0x7), U(0x1b), U(0x85)];
  t('eaw: combining / enclosing marks, ZWJ / ZWNJ / ZWSP, variation selectors, tags, soft hyphen, controls = 0', !each(Z, 0).length && GM.eaw('') === 0 && GM.eaw(null) === 0 && GM.eaw(undefined) === 0); }
t('eaw: a base with its marks = the base (e + acute: 1, か + voiced mark: 2, decomposed hangul: 2)', GM.eaw(E_ACUTE) === 1 && GM.eaw(GA) === 2 && GM.eaw(HANGUL_GA) === 2 && GM.eaw('ä'.normalize('NFD')) === 1);
t('eaw: emoji = 2 (one, skin tone, ZWJ sequence, flag, tag sequence); VS16 makes a text-default one 2 (heart, keycap, rainbow flag)',
  ['😀', '🍣', '🤖', THUMB, MAN_PC, FLAG_JP, ENGLAND].every(c => GM.eaw(c) === 2) && GM.eaw(HEART) === 1 && GM.eaw(HEART + VS16) === 2 && GM.eaw(KEYCAP1) === 2 && GM.eaw(RAINBOW) === 2 && GM.eaw('a' + VS16) === 1);
t('eaw: surrogates - a pair is one character (𠮷: 2, 😀: 2), a lone one is drawn as U+FFFD (A: 2)', GM.eaw('𠮷') === 2 && '𠮷'.length === 2 && GM.eaw(U(0xd842)) === 2 && GM.eaw(U(0xdc00)) === 2);

// ---- grapheme clusters / width ----
{ const cases = ['abc', 'あいう', E_ACUTE + E_ACUTE, GA + 'き', THUMB + '!', MAN_PC + '開発', FLAG_JP + FLAG_JP + 'a', KEYCAP1 + 'x', RAINBOW, ENGLAND + 'z', '𠮷野家', 'a' + ZWJ + 'b', U(0x301) + 'x'];
  const seg = cases.map(s => J(GM.graphemes(s))), fb = cases.map(s => J(GM.clusters(s)));
  t('graphemes: whole characters (marks, ZWJ sequences, flags in pairs, keycaps, tags, surrogate pairs)', J(GM.graphemes(MAN_PC + '開発')) === J([MAN_PC, '開', '発']) && J(GM.graphemes(FLAG_JP + FLAG_JP + 'a')) === J([FLAG_JP, FLAG_JP, 'a'])
    && J(GM.graphemes(E_ACUTE + E_ACUTE)) === J([E_ACUTE, E_ACUTE]) && GM.graphemes('𠮷野家').length === 3 && GM.graphemes('').length === 0);
  t('graphemes: the fallback without Intl.Segmenter cuts these the same', seg.every((s, i) => s === fb[i])); }
t('width: the sum of the characters', GM.width('abc') === 3 && GM.width('あいう') === 6 && GM.width('aあ') === 3 && GM.width(MAN_PC + '開発') === 6 && GM.width(E_ACUTE + 'x') === 2 && GM.width('') === 0 && GM.width(null) === 0);

// ---- truncate: セミコンパクト's cut ----
{ const cut = s => GM.truncate(s, 4);
  const fixed = [['テスト用Bot', 'テス'], ['GrokBot', 'Grok'], ['Grok', 'Grok'], ['あい', 'あい'], ['aあい', 'aあ'], ['AIあいう', 'AIあ'], ['aaaあ', 'aaa'], ['ｱｲｳｴｵ', 'ｱｲｳｴ'],
    ['😀😀😀', '😀😀'], [MAN_PC + '開発', MAN_PC + '開'], [FLAG_JP + 'ニュース', FLAG_JP + 'ニ'], [E_ACUTE.repeat(5), E_ACUTE.repeat(4)], [GA.repeat(3), GA.repeat(2)],
    ['𠮷野家', '𠮷野'], ['①下書き', '①下'], ['①②③', '①②'], ['Café Bot', 'Caf'], ['αβγ', 'αβ'], ['★重要', '★重'], [KEYCAP1 + 'ab', KEYCAP1 + 'ab'], [THUMB + THUMB + THUMB, THUMB + THUMB]];
  const wrong = fixed.filter(([s, w]) => cut(s) !== w);
  t(`truncate(name, 4): 全角2文字 / 半角4文字 / mixed; never splits a character (emoji sequence, flag, marks, surrogate pair); A counts 2${wrong.length ? ' — wrong: ' + J(wrong.map(([s]) => [s, cut(s)])) : ''}`, !wrong.length);
  t('truncate: whitespace runs as one space, the ends trimmed (a space at the cut is not kept)', cut('  空白  あり ') === '空白' && cut('あa b') === 'あa' && cut('AB C') === 'AB C' && cut('AB   CD') === 'AB C' && cut('   ') === '' && cut('a\tb\nc') === 'a b' && GM.truncate('a\tb\nc', 5) === 'a b c');
  t('truncate: no ellipsis is added', !fixed.some(([s]) => cut(s).endsWith('…') && !s.includes('…')) && cut('とても長いボットの名前') === 'とて');
  t('truncate: default room is SEMI = 4; other rooms; nothing for 0 / negative / NaN / no name', GM.SEMI === 4 && GM.truncate('あいう') === 'あい' && GM.truncate('あいう', 2) === 'あ' && GM.truncate('abcdef', 5) === 'abcde'
    && GM.truncate('あいう', 3) === 'あ' && [0, -1, NaN, null].every(m => GM.truncate('abc', m) === '') && GM.truncate(null) === '' && GM.truncate(undefined) === '' && GM.truncate(1234567) === '1234'); }
{ let s = 11; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }, pick = a => a[Math.floor(rnd() * a.length)];
  const POOL = ['a', 'Z', '7', ' ', ' ', '-', 'あ', 'ア', '漢', 'ｱ', 'Ａ', 'é', 'α', '①', '★', '…', '😀', THUMB, MAN_PC, FLAG_JP, E_ACUTE, GA, KEYCAP1, '𠮷', U(0x200b)];
  const fails = [];
  for (let c = 0; c < 3000; c++) {
    const name = Array.from({ length: Math.floor(rnd() * 14) }, () => pick(POOL)).join(''), max = 1 + Math.floor(rnd() * 8);
    const out = GM.truncate(name, max), norm = name.replace(/\s+/g, ' ').trim(), gs = GM.graphemes(norm);
    let k = 0, w = 0; while (k < gs.length && w + GM.eaw(gs[k]) <= max) w += GM.eaw(gs[k++]);   // the longest whole-character start within the room
    if (out !== gs.slice(0, k).join('').trimEnd() || GM.width(out) > max || !norm.startsWith(out)) fails.push(J([name, max, out]));
  }
  t(`truncate: 3000 random names: the longest start of whole characters within the room (ends trimmed), never wider${fails.length ? ' — failed: ' + fails.slice(0, 3) : ''}`, !fails.length); }

// ---- initial: the badge of an item without an icon ----
t('initial: the first visible character, upper case when it stays one character; none: •', GM.initial('grok') === 'G' && GM.initial('  bots') === 'B' && GM.initial('ぐろっく') === 'ぐ' && GM.initial(MAN_PC + 'Dev') === MAN_PC
  && GM.initial(FLAG_JP + 'News') === FLAG_JP && GM.initial(E_ACUTE + 'x') === 'E' + U(0x301) && GM.initial('ß') === 'ß' && GM.initial(U(0x200b) + 'x') === 'X' && GM.initial('') === '•' && GM.initial(null) === '•');

// ---- the cycle ----
t('modes: 通常 / セミコンパクト / コンパクト', J(GM.MODES) === J(['normal', 'semi', 'compact']) && J(GM.MODES.map(m => GM.LABEL[m])) === J(['通常', 'セミコンパクト', 'コンパクト']));
t('nextMode: normal -> semi -> compact -> normal', GM.nextMode('normal') === 'semi' && GM.nextMode('semi') === 'compact' && GM.nextMode('compact') === 'normal'
  && GM.nextMode(GM.nextMode(GM.nextMode('semi'))) === 'semi');
t('nextMode / normMode: anything else is 通常 (none / old / broken: the next is セミコンパクト)', [undefined, null, '', 'x', 'Normal', 'COMPACT', 3, true, {}, [], '__proto__', 'toString'].every(m => GM.normMode(m) === 'normal' && GM.nextMode(m) === 'semi' && !GM.isMode(m))
  && GM.MODES.every(m => GM.isMode(m) && GM.normMode(m) === m));

// ---- settings.gbarMode in panes.json (state-schema.js) ----
{ const A = 'https://a.example/';
  const spec = { url: A, reloadMinutes: 0, name: '', color: 'none', muted: false, zoom: 1, zoomIndiv: false, sleep: true };
  const win = { layout: '2x2', focused: 0, panes: [spec], rows: [1], window: { bounds: null, maximized: false } };
  const file = settings => ({ schema: 1, layout: '2x2', focused: 0, urls: [A], panes: [spec], windows: [win], favorites: [], settings, workspaces: {} });
  const old = S.migrate(file({ theme: 'dark', favGrokV1: true }));
  t('panes.json without gbarMode (older files): read as before, nothing repaired, nothing added (= 通常)', old.ok && !old.fixes.length && J(old.doc.settings) === J({ theme: 'dark', favGrokV1: true }));
  t('each mode is kept as is (no repair) and survives a round trip', GM.MODES.every(m => { const r = S.migrate(file({ theme: 'dark', gbarMode: m })), b = r.ok && S.parse(S.serialize(r.doc));
    return r.ok && !r.fixes.length && r.doc.settings.gbarMode === m && b.ok && !b.fixes.length && b.doc.settings.gbarMode === m && J(b.doc) === J(r.doc); }));
  const odd = ['x', '', 'Compact', 'SEMI', 0, 1, true, false, null, {}, [], 'toString', '__proto__'];
  t('anything else: repaired to normal (ready, not recoveryRequired), other settings untouched, the message names the field only', odd.every(v => {
    const r = S.migrate(file({ theme: 'dark', usageShow: true, gbarMode: v }));
    return r.ok && r.status === 'ready' && r.doc.settings.gbarMode === 'normal' && r.doc.settings.theme === 'dark' && r.doc.settings.usageShow === true
      && r.fixes.length === 1 && /^settings\.gbarMode: /.test(r.fixes[0]) && !/Compact|SEMI|toString|__proto__/.test(r.fixes[0]); }));
  t('… and the repaired file reads cleanly next time', (r => r.ok && !r.fixes.length && r.doc.settings.gbarMode === 'normal')(S.parse(S.serialize(S.migrate(file({ gbarMode: 'bogus' })).doc))));
  t('validate() (before every write): a mode passes, anything else is an error', GM.MODES.every(m => !S.validate({ ...old.doc, settings: { gbarMode: m } }).length)
    && odd.every(v => S.validate({ ...old.doc, settings: { gbarMode: v } }).includes('settings.gbarMode: not a mode')) && !S.validate(old.doc).length);
  t('the schema version is unchanged (an optional setting, as usageShow)', S.SCHEMA_VERSION === 1); }

// ---- wiring: main keeps the mode, the page only asks for the next one ----
const main = read('main.js'), ren = read('renderer.js'), P = require('../src/ipc-policy');
t('main.js: requires gbar-mode; the bar message carries the mode (normalised)', /const GM = require\('\.\/gbar-mode'\);/.test(main)
  && /const gbView = \(\) => \(\{ \.\.\.GB\.view\(grok\), busy: gbRun, note: gbNote, mode: GM\.normMode\(settings\.gbarMode\) \}\);/.test(main));
t('main.js: gbar-mode -> gbModeNext (a top-level function, the handler inside the window code like the other bar channels)', (() => {
  const mw = main.indexOf('\nfunction makeWindow('), fn = main.indexOf('\nfunction gbModeNext() {'), h = main.search(/^on\('gbar-mode', \(\) => gbModeNext\(\)\);/m);
  return mw > 0 && fn > 0 && fn < mw && h > mw; })());
{ const m = main.match(/function gbModeNext\(\) \{[^\n]*?\}(?=\s)/), box = { saves: 0, pushes: 0 };
  const ctx = vm.createContext({ GM, settings: {}, save: () => box.saves++, gbPush: c => { box.pushes++; box.arg = c; } });
  if (m) vm.runInContext(m[0], ctx);
  const seq = []; for (let i = 0; i < 4; i++) { vm.runInContext('gbModeNext()', ctx); seq.push(ctx.settings.gbarMode); }
  t('main.js gbModeNext (run): normal -> semi -> compact -> normal -> semi, saved and pushed to every window each time', !!m && J(seq) === J(['semi', 'compact', 'normal', 'semi']) && box.saves === 4 && box.pushes === 4 && box.arg === undefined);
  ctx.settings.gbarMode = 'bogus'; vm.runInContext('gbModeNext()', ctx);
  t('main.js gbModeNext: from an unknown value (never written by main) the next is セミコンパクト', ctx.settings.gbarMode === 'semi'); }
{ const m = main.match(/const gbView = \(\) => [^\n]*;/), ctx = vm.createContext({ GM, GB: { view: () => ({ pins: [], sections: [] }) }, grok: {}, settings: {}, gbRun: false, gbNote: '' });
  vm.runInContext(m[0].replace('const gbView', 'var gbView'), ctx);
  const mode = v => { ctx.settings = v === undefined ? {} : { gbarMode: v }; return vm.runInContext('gbView().mode', ctx); };
  t('main.js gbView (run): none / unknown -> normal, each mode as set', mode(undefined) === 'normal' && mode('x') === 'normal' && GM.MODES.every(x => mode(x) === x)); }
t('IPC: gbar-mode from the window\'s own page only (chrome), no payload used', J(P.CHANNELS['gbar-mode'].roles) === J(['chrome']) && !P.CHANNELS['gbar-mode'].shape && !P.CHANNELS['gbar-mode'].target);
t('preload: mpb.gbarMode sends gbar-mode (nothing else)', /gbarMode: \(\) => send\('gbar-mode'\)/.test(read('preload.js')));
t('index.html: gbar-mode.js before gbar-pages.js / renderer.js', /<script src="gbar-mode\.js"><\/script><script src="gbar-pages\.js"><\/script><script src="renderer\.js"><\/script>/.test(read('index.html')));
t('gbar-mode.js: plain script + CommonJS, no app API', /^const GbarMode = \(\(\) => \{/m.test(read('gbar-mode.js')) && !/mpb\.|ipcRenderer|require\(|document\.|window\./.test(read('gbar-mode.js')));
{ const css = read('style.css');
  t('style: rounded group frame is an inset shadow in every mode; no gmark style; bot borders invisible',
    /\.fav-btn\.gbot\.grp\{box-shadow:inset 0 0 0 1px [^}]+\}/.test(css) && !/\.gmark|\.fav-btn\.gpin\{border-color/.test(css)
    && /\.fav-btn\.gbot\{[^}]*border-color:transparent/.test(css) && /\.fav-btn\{[^}]*border-radius:6px/.test(css));
  t('style: the modes on #favs (セミコンパクト: tighter buttons / smaller headings; コンパクト: no gap, tight padding; 次へ › unchanged)', /#favs\.gm-semi \.fav-btn:not\(#gbar-next\)\{padding:0 6px\}/.test(css) && /#favs\.gm-semi \.fav-btn\.gbot\{[^}]*gap:4px/.test(css)
    && /#favs\.gm-compact \.fav-btn:not\(#gbar-next\)\{padding:0 3px;gap:0\}/.test(css) && /#favs\.gm-semi \.gsec,#favs\.gm-compact \.gsec\{font-size:9px;/.test(css) && !/gm-[a-z]+[^{}]*#gbar-next\{/.test(css)); }

// ---- renderer.js: the Grok bar in a vm on a tiny fake DOM ----
const A0 = ren.indexOf('// ---- short labels:'), A1 = ren.indexOf('function mk(id) {');
const B0 = ren.indexOf('// ---- お気に入りバー:'), B1 = ren.indexOf('// drop a link / URL text onto the favorites bar');
t('renderer: the short-label helpers and the bar block are there', A0 > 0 && A1 > A0 && B0 > A1 && B1 > B0);
{ const unesc = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[k]));
  let favs = null;
  const mode = () => (/\bgm-compact\b/.test(favs.className) ? 'compact' : /\bgm-semi\b/.test(favs.className) ? 'semi' : 'normal');
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.className = ''; this.id = ''; this.dataset = {}; this.style = {}; this.attrs = {}; this.on = {}; this._t = ''; }
    get classList() { const el = this, set = () => new Set(el.className.split(/\s+/).filter(Boolean));
      return { contains: c => set().has(c), add(c) { this.toggle(c, true); }, remove(c) { this.toggle(c, false); }, toggle(c, v) { const s = set(), on = v === undefined ? !s.has(c) : !!v; if (on) s.add(c); else s.delete(c); el.className = [...s].join(' '); return on; } }; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    appendChild(c) { c.remove(); c.parent = this; this.children.push(c); return c; }
    append(...cs) { cs.forEach(c => this.appendChild(c)); }
    remove() { if (this.parent) { const a = this.parent.children; a.splice(a.indexOf(this), 1); this.parent = null; } }
    replaceWith(n) { const p = this.parent; if (!p) return; n.remove(); p.children.splice(p.children.indexOf(this), 1, n); n.parent = p; this.parent = null; }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    get textContent() { return this._t + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this.children.forEach(c => { c.parent = null; }); this.children = []; this._t = String(v); }
    set innerHTML(h) { this.textContent = ''; this.insertAdjacentHTML('beforeend', h); }
    insertAdjacentHTML(_, h) {                                 // what the bar writes: <span class="…">text</span> …
      for (const m of String(h).matchAll(/<span class="([^"]*)">([^<]*)<\/span>|([^<]+)/g)) {
        if (m[3] !== undefined) { this._t += unesc(m[3]); continue; }
        const s = new El('span'); s.className = m[1]; s._t = unesc(m[2]); this.appendChild(s);
      }
    }
    addEventListener(k, f) { (this.on[k] = this.on[k] || []).push(f); }
    animate(frames, options) { const a = { frames, options, cancelled: false, cancel() { this.cancelled = true; } }; (this.animations ||= []).push(a); return a; }
    getBoundingClientRect() { let x = this; while (x && x !== favs) x = x.parent; return { width: x && favs.shown ? (this === favs ? favs.w : wOf(this)) : 0 }; }
  }
  const has = (e, c) => e.className.split(/\s+/).includes(c);
  function wOf(e) {                                          // a rough box model of style.css (units of gbar-mode.js × px per unit)
    const m = mode();
    if (e.id === 'gbar-next') return 52;
    if (has(e, 'gsep')) return 1;
    if (has(e, 'gsec')) return GM.width(e.textContent) * 5.5 + (m === 'normal' ? 8 : 5);
    if (has(e, 'flabel')) return GM.width(e.textContent) * 6;
    if (has(e, 'gic')) return 16;
    if (has(e, 'fic')) return e.parent && has(e.parent, 'gbot') ? 16 : 14;
    if (has(e, 'fav-btn')) {
      const g = has(e, 'gbot'), kids = e.children.map(wOf), pad = m === 'compact' ? 6 : m === 'semi' ? (g ? 9 : 12) : (g ? 11 : 16), gap = m === 'compact' ? 0 : m === 'semi' && g ? 4 : 5;
      return Math.min(2 + pad + kids.reduce((a, b) => a + b, 0) + gap * Math.max(0, kids.length - 1), g ? 136 : 96);
    }
    return 0;
  }
  favs = new El('div'); favs.id = 'favs'; favs.w = 1200; favs.shown = true;
  const byId = { '#favs': favs, '#fav-star': new El('button'), '#gbar-note': new El('span'), '#fav-hint': new El('span') };
  const box = { gbar: null, ro: null, calls: [] };
  const modeCtx = vm.createContext({ GM, settings: {}, save() {}, gbPush() {} });
  vm.runInContext(main.match(/function gbModeNext\(\) \{[^\n]*?\}(?=\s)/)[0], modeCtx);
  const mpb = new Proxy({}, { get: (_, k) => (k === 'onGbar' ? cb => { box.gbar = cb; } : (...a) => { box.calls.push([k, ...a]); if (k === 'gbarMode') modeCtx.gbModeNext(); }) });
  const ctx = vm.createContext({ $: s => byId[s], mpb, S: null, MOD: '⌘', GbarPresence: require('../src/gbar-presence'), GbarMode: GM, GbarPages: require('../src/gbar-pages'), GbarLongPress: require('../src/gbar-long-press'), URL, document: { createElement: tag => new El(tag) },
    getComputedStyle: e => (e === favs ? { columnGap: '4px' } : { marginLeft: has(e, 'gsep') ? '4px' : '0px', marginRight: has(e, 'gsep') ? '4px' : '0px' }),
    ResizeObserver: class { constructor(cb) { box.ro = cb; } observe() {} } });
  vm.runInContext(ren.slice(ren.indexOf('function setTip('), ren.indexOf('function tipAttrs(')) + ren.slice(A0, A1) + ren.slice(B0, B1), ctx);
  const run = s => vm.runInContext(s, ctx), gbtn = byId['#fav-star'], gNext = run('gNext'), shortLabel = run('shortLabel');
  // the bar's list: 2 pins (one without an icon), 3 sections (the last one nameless), 2 favorites (one without a label)
  const bot = (id, name, o = {}) => ({ id, name, orig: name, url: 'https://grok.com/bot/' + id, group: !!o.group, icon: o.icon ? 'data:image/png;base64,AAAA' : '', pinned: !!o.pinned });
  const PINS = [bot('p1', '翻訳アシスタント', { icon: 1, pinned: 1 }), bot('p2', 'Research Helper', { pinned: 1, group: 1 })];
  const SECS = [
    { name: '仕事の依頼', items: ['議事録まとめ係', '日報チェッカー', 'Slack要約', '見積もり作成', '契約書レビュー', '採用面接メモ', '請求書チェック', '経費精算', '週報ライター', '顧客対応', '翻訳（英日）', 'プレゼン構成'].map((n, i) => bot('w' + i, n, { icon: i % 3, group: i === 2 })) },
    { name: 'Dev tools', items: ['Code Reviewer', 'Test Writer', 'Bug Hunter', 'Doc Builder', MAN_PC + 'ペア', FLAG_JP + 'ニュース', 'Café Bot', 'αβγδ', '①下書き', 'Grok'].map((n, i) => bot('d' + i, n, { icon: i % 2, group: i === 0 })) },
    { name: '', items: ['misc one', 'その他', 'X'].map((n, i) => bot('m' + i, n)) }];
  const NAME = Object.fromEntries([...PINS, ...SECS.flatMap(s => s.items)].map(b => ['b' + b.id, b.name]));
  const GROUP = new Set([...PINS, ...SECS.flatMap(s => s.items)].filter(b => b.group).map(b => 'b' + b.id));
  ctx.S = { favorites: [{ id: 1, url: 'https://example.com/', label: 'Example Site' }, { id: 2, url: 'https://news.example.org/a', label: '' }] };
  const FAVNAME = { f1: 'Example Site', f2: 'news.example.org' };
  const send = (m, o = {}) => box.gbar({ pins: PINS, sections: SECS, count: 27, at: 0, busy: false, note: '', mode: m, ...o });
  const GP = () => run('GP'), pageN = () => GP().pages.length;
  const kids = () => favs.children;
  const used = () => kids().reduce((s, e, i) => { const cs = ctx.getComputedStyle(e); return s + wOf(e) + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight) + (i ? 4 : 0); }, 0);
  const fits = () => used() <= favs.w + 1e-6;
  const labelOf = e => (e.children.find(c => has(c, 'flabel')) || { textContent: null }).textContent;
  const allItems = () => GP().els.map((e, i) => ({ e, key: GP().keys[i] }));
  const pinsShown = () => kids().slice(0, GP().pinN);
  const everyPage = f => { const r = []; for (let i = 0; i < pageN(); i++) { r.push(f()); gNext.onclick(); } return r; };   // goes round once (back where it was)

  // 通常 (as before)
  t('vm: before any list: 通常', run('gMode') === 'normal');
  send('normal');
  t('vm 通常: no mode class; labels as before (Bots 10 columns, favorites 6, headings 12); group frame; the Grok button says right-click → セミコンパクト',
    favs.className === '' && allItems().every(({ e, key }) => labelOf(e) === shortLabel(key[0] === 'f' ? FAVNAME[key] : NAME[key], key[0] === 'f' ? 6 : 10))
    && allItems().filter(x => x.key[0] === 'b').every(({ e, key }) => !e.children.some(c => has(c, 'gmark')) && has(e, 'grp') === GROUP.has(key))
    && J(GP().heads.map(h => h && h.textContent)) === J([shortLabel('仕事の依頼', 12), shortLabel('Dev tools', 12), null]) && /右クリックで表示を切替（通常 → セミコンパクト）$/.test(gbtn.dataset.tipDetail));
  const pinW = { normal: GP().pinW }, pages = { normal: pageN() };
  t(`vm 通常: pins first (with names), the rest in pages that fit (${pages.normal} pages), 次へ at the end`, pinsShown().every((e, i) => has(e, 'gpin') && labelOf(e) === shortLabel(PINS[i].name, 10))
    && pages.normal >= 3 && kids().at(-1) === gNext && everyPage(fits).every(Boolean));
  gNext.onclick();                                           // to page 2: its first item is kept across a mode change (everyPage moves it: checked first)
  const anchor = run('gAnchor'), anchorShown = () => GP().page === ctx.GbarPages.pageOf(GP().pages, GP().keys.indexOf(anchor)) && kids().includes(GP().els[GP().keys.indexOf(anchor)]);

  // The frame has no layout dimensions. Check group / bot classes including pins in all three modes.
  const groupFrames = () => [...pinsShown().map((e, i) => ({ e, key: 'b' + PINS[i].id })), ...allItems().filter(x => x.key[0] === 'b')]
    .every(({ e, key }) => !e.children.some(c => has(c, 'gmark')) && !e.textContent.includes('👥') && has(e, 'grp') === GROUP.has(key));
  t('vm 通常: groups (pins too) have grp, bots do not; no group glyph or gmark node', groupFrames());

  // the right-click
  { box.calls.length = 0; let pd = 0; gbtn.oncontextmenu({ preventDefault: () => { pd++; } });
    const c1 = J(box.calls);
    box.calls.length = 0; send('normal', { busy: true }); gbtn.oncontextmenu({ preventDefault: () => { pd++; } }); gbtn.onclick();
    t('vm: a right-click on the Grok button asks main for the next mode (no menu, no list read; also while a read runs)', pd === 2 && c1 === J([['gbarMode']]) && J(box.calls) === J([['gbarMode']]));
    send('normal'); box.calls.length = 0; gbtn.onclick();
    t('vm: a left-click still reads the list (unchanged; nothing while a read runs); the list sent again keeps the page', J(box.calls) === J([['gbarRefresh']]) && run('gAnchor') === anchor && GP().page === 1 && anchorShown()); }

  // Native gesture sequences: contextmenu can be present or absent; a Ctrl-left click must never reload.
  { const ev = o => ({ button: 0, preventDefault() { this.prevented = true; }, ...o });
    const gesture = (down, context = true, click = down) => {
      box.calls.length = 0;
      const before = GM.normMode(modeCtx.settings.gbarMode), d = ev(down); gbtn.onmousedown(d);
      if (context) { const c = ev(down); gbtn.oncontextmenu(c); t('vm: secondary contextmenu prevented', c.prevented); }
      gbtn.onclick(ev(click));
      return d.prevented && J(box.calls) === J([['gbarMode']]) && modeCtx.settings.gbarMode === GM.nextMode(before);
    };
    t('vm: right mousedown + contextmenu + click -> one next-mode request, no refresh', gesture({ button: 2 }));
    t('vm: right mousedown without contextmenu -> one next-mode request, no refresh', gesture({ button: 2 }, false));
    for (const down of [{ button: 2 }, { ctrlKey: true }]) {
      box.calls.length = 0; gbtn.onmousedown(ev(down)); gbtn.onclick(ev(down)); gbtn.oncontextmenu(ev(down));
      t('vm: secondary click before a delayed contextmenu still advances once', J(box.calls) === J([['gbarMode']]));
    }
    t('vm: Ctrl-left + contextmenu + click (Ctrl released before click) -> once, no refresh', gesture({ ctrlKey: true }, true, {}));
    t('vm: Ctrl-left without contextmenu -> once, no refresh', gesture({ ctrlKey: true }, false));
    t('vm: rapid distinct secondary gestures each advance once (no time-based debounce)', Array.from({ length: 6 }, () => gesture({ button: 2 })).every(Boolean));
    box.calls.length = 0; gbtn.onkeydown(); const c = ev({}); gbtn.oncontextmenu(c); gbtn.onclick(ev({}));
    t('vm: contextmenu fallback (no mousedown) -> one mode request, any trailing click consumed', c.prevented && J(box.calls) === J([['gbarMode']]));
    box.calls.length = 0; gbtn.oncontextmenu(ev({})); gbtn.oncontextmenu(ev({}));
    t('vm: standalone contextmenu dispatches each advance', J(box.calls) === J([['gbarMode'], ['gbarMode']]));
    box.calls.length = 0; gbtn.onmousedown(ev({})); gbtn.onclick(ev({}));
    t('vm: next ordinary mouse press refreshes after a secondary gesture', J(box.calls) === J([['gbarRefresh']]));
    box.calls.length = 0; gbtn.onmousedown(ev({ button: 2 })); gbtn.onkeydown(); box.calls.length = 0; gbtn.onclick(ev({ detail: 0 }));
    t('vm: keyboard activation after a secondary press still refreshes', J(box.calls) === J([['gbarRefresh']]));
    send('normal', { busy: true }); box.calls.length = 0; gbtn.onmousedown(ev({})); gbtn.onclick(ev({}));
    t('vm: busy still suppresses an ordinary refresh', box.calls.length === 0);
    t('vm: busy still accepts a Ctrl-left mode change exactly once', gesture({ ctrlKey: true }));
    send('normal');
  }

  // セミコンパクト
  send('semi');
  pinW.semi = GP().pinW; pages.semi = pageN();
  t('vm セミコンパクト: on the page holding the item 次へ went to (page 2 in 通常, page 1 now)', run('gAnchor') === anchor && anchorShown() && GP().page === 0);
  t('vm セミコンパクト: the mode class is on the bar before it is measured; every name cut to 4 units (Bots, pins, favorites), group frame kept',
    favs.className === 'gm-semi' && allItems().every(({ e, key }) => { const l = labelOf(e), n = key[0] === 'f' ? FAVNAME[key] : NAME[key]; return l === GM.truncate(n) && GM.width(l) <= 4; })
    && pinsShown().every((e, i) => labelOf(e) === GM.truncate(PINS[i].name)) && allItems().filter(x => x.key[0] === 'b').every(({ e, key }) => !e.children.some(c => has(c, 'gmark')) && has(e, 'grp') === GROUP.has(key)));
  t('vm セミコンパクト: e.g. 議事録まとめ係 -> 議事, Code Reviewer -> Code, ①下書き -> ①下, a ZWJ emoji stays whole; headings cut to 4 units (title: the full name)',
    labelOf(GP().els[GP().keys.indexOf('bw0')]) === '議事' && labelOf(GP().els[GP().keys.indexOf('bd0')]) === 'Code' && labelOf(GP().els[GP().keys.indexOf('bd8')]) === '①下'
    && labelOf(GP().els[GP().keys.indexOf('bd4')]) === MAN_PC + 'ペ' && J(GP().heads.map(h => h && [h.textContent, h.dataset.tip])) === J([['仕事', '仕事の依頼'], ['Dev', 'Dev tools'], null]));
  t(`vm セミコンパクト: pages measured again: fewer pages (${pages.normal} -> ${pages.semi}), the pins narrower (${pinW.normal} -> ${pinW.semi} px), every page fits`,
    pages.semi < pages.normal && pinW.semi < pinW.normal && everyPage(fits).every(Boolean));
  t('vm セミコンパクト: the Grok button says → コンパクト', /右クリックで表示を切替（セミコンパクト → コンパクト）$/.test(gbtn.dataset.tipDetail));

  t('vm セミコンパクト: group frames / no gmark, including pins', groupFrames());

  // コンパクト
  send('compact');
  pinW.compact = GP().pinW; pages.compact = pageN();
  const iconOnly = (e, b) => e.children.length === 1 && (b.icon ? e.children[0].tagName === 'IMG' && has(e.children[0], 'gic') : has(e.children[0], 'fic') && e.children[0].textContent === GM.initial(b.name));
  const BOT = Object.fromEntries([...PINS, ...SECS.flatMap(s => s.items)].map(b => ['b' + b.id, b]));
  t('vm コンパクト: Bots and pins show the icon only (none: the first letter), no name, no group mark; the tooltip keeps the full name',
    favs.className === 'gm-compact' && allItems().filter(x => x.key[0] === 'b').every(({ e, key }) => iconOnly(e, BOT[key]) && e.dataset.tip === BOT[key].name)
    && pinsShown().every((e, i) => iconOnly(e, PINS[i]) && has(e, 'gpin')));
  t('vm コンパクト: favorites (no icon of their own) show a first-letter badge; headings cut to 2 units',
    J(allItems().filter(x => x.key[0] === 'f').map(({ e }) => e.children.map(c => [c.className, c.textContent]))) === J([[['fic', 'E']], [['fic', 'N']]])
    && J(GP().heads.map(h => h && [h.textContent, h.dataset.tip])) === J([['仕', '仕事の依頼'], ['De', 'Dev tools'], null]));
  t(`vm コンパクト: all fits in one page now (no 次へ), the pins narrower again (${pinW.compact} px)`, pages.compact === 1 && !kids().includes(gNext) && pinW.compact < pinW.semi && fits()
    && kids().length === GP().pinN + 27 + 1 + 2);           // pins + 2 favorites + 25 Bots, the separator, the 2 named headings
  t('vm コンパクト: group frames / no gmark, including pins', groupFrames());
  { // Use the actual item handlers in every mode (listed bots / groups and pinned ones).
    for (const m of GM.MODES) {
      send(m);
      const items = [...pinsShown(), ...allItems().filter(x => x.key[0] === 'b').map(x => x.e)];
      for (const [mods, where] of [[{}, 'new'], [{ metaKey: true }, 'here'], [{ altKey: true }, 'here'], [{ shiftKey: true }, 'window']]) {
        box.calls.length = 0; items.forEach(e => e.onclick({ button: 0, ...mods }));
        t('vm ' + m + ': every Bot / group (pins too), ' + J(mods) + ' -> ' + where,
          box.calls.length === items.length && box.calls.every(c => c[0] === 'gbotOpen' && c[2] === where));
      }
      box.calls.length = 0; items[0].onclick({ button: 0, ctrlKey: true }); items[0].onclick({ button: 2 });
      t('vm ' + m + ': secondary item clicks do not also navigate', box.calls.length === 0);
      box.calls.length = 0; items[0].onauxclick({ button: 1 });
      t('vm ' + m + ': middle-click keeps opening a new pane', J(box.calls) === J([['gbotOpen', 'p1', 'new']]));
      box.calls.length = 0; let pd = 0; items.forEach(e => e.oncontextmenu({ preventDefault: () => { pd++; } }));
      const menuIds = [...PINS.map(b => b.id), ...allItems().filter(x => x.key[0] === 'b').map(x => x.key.slice(1))];
      t('vm ' + m + ': every Bot / group / pin contextmenu opens its own menu', pd === items.length && J(box.calls) === J(menuIds.map(id => ['gbotMenu', id])));
      const pointer = (timeStamp, extra = {}) => ({ button: 0, pointerId: 1, clientX: 20, clientY: 30, timeStamp, ...extra });
      const click = (e, detail = 1) => { const c = { button: 0, detail, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; e.onclick(c); return c; };
      box.calls.length = 0;
      items.forEach(e => e.onpointerdown(pointer(0)));
      t('vm ' + m + ': holding never opens early; each item animates colour to the threshold', !box.calls.length && items.every(e => {
        const a = e.animations.at(-1); return a.options.duration === 500 && a.options.fill === 'forwards' && a.frames.at(-1).backgroundColor === 'var(--accent)';
      }));
      items.forEach(e => e.onpointerup(pointer(500)));
      t('vm ' + m + ': releasing every Bot / group / pin at 500ms opens here once', J(box.calls) === J(menuIds.map(id => ['gbotOpen', id, 'here'])));
      const opened = box.calls.length;
      const clicks = items.map(e => click(e));
      items.forEach(e => e.onpointerup(pointer(1000)));
      t('vm ' + m + ': following clicks are prevented, duplicate releases do nothing, feedback clears',
        box.calls.length === opened && clicks.every(c => c.prevented && c.stopped) && items.every(e => e.animations.at(-1).cancelled));
      box.calls.length = 0;
      items.forEach(e => { e.onpointerdown(pointer(1000)); e.onpointerup(pointer(1499)); click(e); });
      t('vm ' + m + ': a fresh short click still opens new', J(box.calls) === J(menuIds.map(id => ['gbotOpen', id, 'new'])));
      for (const cancel of ['onpointerleave', 'onpointercancel', 'onpointermove']) {
        box.calls.length = 0;
        items.forEach(e => { e.onpointerdown(pointer(0)); e[cancel](pointer(600, { clientX: 27 })); e.onpointerup(pointer(700)); click(e); });
        t('vm ' + m + ': ' + cancel + ' cancels even after 500ms, including the following click', !box.calls.length && items.every(e => e.animations.at(-1).cancelled));
      }
      for (const mods of [{ metaKey: true }, { altKey: true }, { shiftKey: true }, { ctrlKey: true }, { button: 2 }]) {
        box.calls.length = 0;
        items.forEach(e => { const n = e.animations.length; e.onpointerdown(pointer(0, mods)); e.onpointerup(pointer(700, mods));
          if (e.animations.length !== n) throw Error('modified press must not animate'); e.onclick({ button: 0, ...mods }); });
        const expected = mods.ctrlKey || mods.button === 2 ? [] : menuIds.map(id => ['gbotOpen', id, mods.shiftKey ? 'window' : 'here']);
        t('vm ' + m + ': holding with ' + J(mods) + ' preserves its click action', J(box.calls) === J(expected));
      }
      { const pin = items[0], target = items[1], data = {}, transfer = { types: ['text/x-mpb-gpin'], setData(k, v) { data[k] = v; }, getData(k) { return data[k]; } };
        box.calls.length = 0; pin.onpointerdown(pointer(0));
        pin.on.dragstart.forEach(fn => fn({ dataTransfer: transfer })); pin.ondragstart({ dataTransfer: transfer });
        pin.onpointerup(pointer(700)); click(pin);
        t('vm ' + m + ': dragging cancels hold and keeps native pin payload / source styling',
          !box.calls.length && pin.draggable && data['text/x-mpb-gpin'] === 'p1' && has(pin, 'drag-src') && pin.animations.at(-1).cancelled);
        const drop = { dataTransfer: transfer, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
        target.ondragover(drop); target.ondrop(drop); pin.ondragend();
        t('vm ' + m + ': pin drag reorder still reaches gbotMove', J(box.calls) === J([['gbotMove', 'p1', 'p2']]) && drop.prevented && drop.stopped && !has(pin, 'drag-src') && !has(target, 'drop-over'));
      }
      const f = allItems().find(x => x.key === 'f1').e; box.calls.length = 0; f.onclick({});
      t('vm ' + m + ': unrelated URL favorites keep their existing current-pane default', J(box.calls) === J([['favOpen', 1, 'here']]));
    }
    send('compact');
  }
  favs.w = 520; box.ro();
  t(`vm コンパクト + a narrower window: pages again (${pageN()}), each fits, 次へ back`, pageN() >= 2 && kids().at(-1) === gNext && everyPage(fits).every(Boolean));
  { const img = GP().els[GP().keys.indexOf('bd1')].children[0]; img.on.error[0]();
    t('vm コンパクト: an icon that does not load becomes its first letter', (e => e.children.length === 1 && has(e.children[0], 'fic') && e.children[0].textContent === 'T')(GP().els[GP().keys.indexOf('bd1')])); }

  // Presence updates existing elements, including pins duplicated in sections and pages currently detached.
  for (const m of GM.MODES) {
    ctx.S.panes = [{ id: 101, url: PINS[1].url + '/?chat=1' }, { id: 102, url: SECS[1].items[0].url + '#reply' }];
    ctx.S.focusedId = 102;
    send(m, { sections: [...SECS, { name: 'Pinned too', items: [PINS[1]] }] });
    const listed = [...pinsShown().map((e, i) => ({ e, id: PINS[i].id })), ...allItems().filter(x => x.key[0] === 'b').map(x => ({ e: x.e, id: x.key.slice(1) }))];
    const framed = (open, active) => listed.every(({ e, id }) => has(e, 'gopen') === open.includes(id) && has(e, 'gactive') === (id === active)
      && e.attrs['aria-current'] === (id === active ? 'page' : 'false'));
    t('vm ' + m + ': open and active frames (groups / pins / duplicate / detached page)',
      framed(['p2', 'd0'], 'd0') && listed.filter(x => x.id === 'p2').length === 2 && listed.some(x => !x.e.parent));
    t('vm ' + m + ': tooltip keeps name, group label and actions, and adds presence',
      listed.filter(x => x.id === 'p2').every(x => /グループ/.test(x.e.dataset.tipDetail) && /右クリックでメニュー/.test(x.e.dataset.tipDetail) && /^ペインで開いています/.test(x.e.dataset.tipDetail))
      && /^今のペインで開いています/.test(listed.find(x => x.id === 'd0').e.dataset.tipDetail));
    const gp = GP(), page = gp.page, width = gp.pinW, nodes = gp.els.slice();
    const update = () => run('renderFavs(S.favorites)');       // same path onState calls, with an unchanged list key
    ctx.S.focusedId = 101; update();
    t('vm ' + m + ': focus updates both copies without rebuilding, remeasuring or changing page',
      framed(['p2', 'd0'], 'p2') && GP() === gp && GP().page === page && GP().pinW === width && nodes.every((e, i) => GP().els[i] === e));
    ctx.S.panes.push({ id: 103, url: PINS[1].url }); ctx.S.panes[0].url = PINS[0].url + '/chat/new'; update();
    t('vm ' + m + ': navigation emphasizes the Bot; group remains open in another pane', framed(['p1', 'p2', 'd0'], 'p1'));
    ctx.S.panes.pop(); update();
    t('vm ' + m + ': closing the final matching pane removes its frame and status tooltip',
      framed(['p1', 'd0'], 'p1') && listed.filter(x => x.id === 'p2').every(x => !/ペインで開いています/.test(x.e.dataset.tipDetail)));
    ctx.S.panes[0].url = 'https://example.com/'; update();
    t('vm ' + m + ': unrelated focused URL clears emphasis; another open group stays framed', framed(['d0'], ''));
    const pageAt = GP().page; gNext.onclick();
    t('vm ' + m + ': page changes keep presence', framed(['d0'], '') && GP().page !== pageAt);
    ctx.S.panes = []; update();
    t('vm ' + m + ': no remaining panes clears all presence', framed([], ''));
  }
  // Legacy/unlisted Grok URL favorites also get presence; favorite actions stay as before.
  ctx.S.favorites.push({ id: 3, label: 'Unlisted Bot', url: 'https://grok.com/bot/unlisted' });
  ctx.S.panes = [{ id: 104, url: 'https://grok.com/bot/unlisted?chat=1' }]; ctx.S.focusedId = 104;
  run('renderFavs(S.favorites)');
  { const e = GP().els[GP().keys.indexOf('f3')];
    t('vm: a Grok URL favorite is framed and emphasized by URL ID too', has(e, 'gopen') && has(e, 'gactive') && /^今のペインで開いています/.test(e.dataset.tipDetail)); }
  ctx.S.favorites.pop(); ctx.S.panes = []; delete ctx.S.focusedId;

  // back to 通常, and an unknown value
  favs.w = 1200; send('normal');
  t('vm: コンパクト -> 通常: the labels and the pages as before', favs.className === '' && allItems().every(({ e, key }) => labelOf(e) === shortLabel(key[0] === 'f' ? FAVNAME[key] : NAME[key], key[0] === 'f' ? 6 : 10))
    && pageN() === pages.normal && GP().pinW === pinW.normal && everyPage(fits).every(Boolean));
  send('weird');
  t('vm: an unknown mode from main is shown as 通常 (→ セミコンパクト next)', run('gMode') === 'normal' && favs.className === '' && pageN() === pages.normal && /（通常 → セミコンパクト）$/.test(gbtn.dataset.tipDetail)); }

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
