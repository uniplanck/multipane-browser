// Grokバーの表示モード: 通常 → セミコンパクト → コンパクト → 通常 (a right-click on the Grok button takes the next one; main keeps it in
// settings.gbarMode). Pure; loaded by index.html as a plain script before renderer.js (no require there), required by main.js, state-schema.js
// and the test. セミコンパクト: the icon + the name cut to SEMI display units; コンパクト: the icon only (none: its first letter), the name in the tooltip.
// Display units (East Asian Width): W / F = 2; A (ambiguous) = AMB = 2 in this Japanese UI (lang=ja: Hiragino draws ①★※→… full-width, so a cut
// name never grows past its room; an accented Latin / Greek / Cyrillic letter only leaves a unit unused); everything else 1; combining marks, ZWJ,
// variation selectors and other format / control characters 0. A grapheme cluster (base + marks, an emoji ZWJ sequence, a flag, a skin tone, a
// keycap, a surrogate pair) is one character: never cut apart, as wide as its widest part (an emoji asked for as a picture with VS16: 2).
// The cut is hard, no ellipsis: '…' (A) would take half of 4 units, and the bar cuts its other labels the same way (renderer.js shortLabel).
const GbarMode = (() => {
  const MODES = ['normal', 'semi', 'compact'];
  const LABEL = { normal: '通常', semi: 'セミコンパクト', compact: 'コンパクト' };
  const SEMI = 4;                                            // セミコンパクト: a name's room (全角2文字 / 半角4文字)
  const AMB = 2;                                             // East Asian Width A (ambiguous): wide here (see above)
  const isMode = m => MODES.includes(m);
  const normMode = m => (isMode(m) ? m : 'normal');          // none / unknown / broken: 通常
  const nextMode = m => MODES[(MODES.indexOf(normMode(m)) + 1) % MODES.length];
  // East Asian Width (Unicode 15.1), code point ranges in hex, ascending. WIDE: W + F apart from the emoji (Emoji_Presentation below);
  // unassigned gaps inside a block are counted with it
  const ranges = s => s.trim().split(/\s+/).map(r => r.split('-').map(x => parseInt(x, 16))).map(([a, b = a]) => [a, b]);
  const WIDE = ranges(`1100-115f 2329-232a 2e80-303e 3041-3247 3250-4dbf 4e00-a4cf a960-a97f ac00-d7a3 f900-faff fe10-fe19 fe30-fe6f
    ff01-ff60 ffe0-ffe6 16fe0-16fff 17000-18cff 18d00-18d7f 1aff0-1b2ff 1f200-1f2ff 20000-2fffd 30000-3fffd`);
  const AMBI = ranges(`a1 a4 a7-a8 aa ad-ae b0-b4 b6-ba bc-bf c6 d0 d7-d8 de-e1 e6 e8-ea ec-ed f0 f2-f3 f7-fa fc fe 101 111 113 11b 126-127
    12b 131-133 138 13f-142 144 148-14b 14d 152-153 166-167 16b 1ce 1d0 1d2 1d4 1d6 1d8 1da 1dc 251 261 2c4 2c7 2c9-2cb 2cd 2d0 2d8-2db 2dd 2df
    391-3a1 3a3-3a9 3b1-3c1 3c3-3c9 401 410-44f 451 2010 2013-2016 2018-2019 201c-201d 2020-2022 2024-2027 2030 2032-2033 2035 203b 203e 2074
    207f 2081-2084 20ac 2103 2105 2109 2113 2116 2121-2122 2126 212b 2153-2154 215b-215e 2160-216b 2170-2179 2189 2190-2199 21b8-21b9 21d2 21d4
    21e7 2200 2202-2203 2207-2208 220b 220f 2211 2215 221a 221d-2220 2223 2225 2227-222c 222e 2234-2237 223c-223d 2248 224c 2252 2260-2261
    2264-2267 226a-226b 226e-226f 2282-2283 2286-2287 2295 2299 22a5 22bf 2312 2460-24e9 24eb-254b 2550-2573 2580-258f 2592-2595 25a0-25a1
    25a3-25a9 25b2-25b3 25b6-25b7 25bc-25bd 25c0-25c1 25c6-25c8 25cb 25ce-25d1 25e2-25e5 25ef 2605-2606 2609 260e-260f 261c 261e 2640 2642
    2660-2661 2663-2665 2667-266a 266c-266d 266f 269e-269f 26bf 26c6-26cd 26cf-26d3 26d5-26e1 26e3 26e8-26e9 26eb-26f1 26f4 26f6-26f9 26fb-26fc
    26fe-26ff 273d 2776-277f 2b56-2b59 3248-324f e000-f8ff fffd 1f100-1f10a 1f110-1f12d 1f130-1f169 1f170-1f18d 1f18f-1f190 1f19b-1f1ac
    f0000-ffffd 100000-10fffd`);
  const inR = (t, c) => { let lo = 0, hi = t.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (c < t[m][0]) hi = m - 1; else if (c > t[m][1]) lo = m + 1; else return true; } return false; };
  const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]$/u, EP = /^\p{Emoji_Presentation}$/u, EMOJI = /^\p{Emoji}$/u, MC = /^\p{Mc}$/u, XP = /^\p{Extended_Pictographic}$/u;
  const VS16 = String.fromCodePoint(0xfe0f);                 // variation selector 16: show this emoji as a picture
  function cpw(c) {                                          // one code point
    if (c < 0x20 || (c >= 0x7f && c < 0xa0)) return 0;       // control characters
    if (c >= 0xd800 && c <= 0xdfff) return AMB;              // a lone surrogate: drawn as U+FFFD (A)
    const ch = String.fromCodePoint(c);
    if (ZERO.test(ch)) return 0;                             // combining / enclosing marks, ZWJ / ZWNJ / ZWSP, variation selectors, tags, soft hyphen
    if (EP.test(ch) || inR(WIDE, c)) return 2;
    return inR(AMBI, c) ? AMB : 1;
  }
  // the width of one character as shown = one grapheme cluster (a longer string: taken as one cluster)
  function eaw(ch) {
    const s = String(ch ?? '');
    if (!s) return 0;
    if (s.includes(VS16) && EMOJI.test(String.fromCodePoint(s.codePointAt(0)))) return 2;   // a heart / keycap / (c) with VS16: drawn as a picture
    let w = 0;
    for (const c of s) w = Math.max(w, cpw(c.codePointAt(0)));
    return w;
  }
  // grapheme clusters: Intl.Segmenter (Chromium / Node); without it, code points with the zero-width ones, spacing marks, skin tones, an emoji
  // after a ZWJ and the second regional indicator of a pair kept on the one before
  function clusters(s) {
    const out = []; let prev = -1, ri = false;
    for (const ch of String(s ?? '')) {
      const c = ch.codePointAt(0), isRi = c >= 0x1f1e6 && c <= 0x1f1ff;
      const join = out.length > 0 && (ZERO.test(ch) || MC.test(ch) || (prev === 0x200d && XP.test(ch)) || (c >= 0x1f3fb && c <= 0x1f3ff) || (isRi && ri));
      if (join) out[out.length - 1] += ch; else out.push(ch);
      ri = isRi && !join; prev = c;
    }
    return out;
  }
  const SEG = typeof Intl === 'object' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('ja', { granularity: 'grapheme' }) : null;
  const graphemes = s => (SEG ? Array.from(SEG.segment(String(s ?? '')), x => x.segment) : clusters(s));
  const width = s => graphemes(s).reduce((a, g) => a + eaw(g), 0);
  // a name in at most `max` units: whole characters from the start (whitespace runs as one space, the ends trimmed), no ellipsis
  function truncate(name, max = SEMI) {
    if (!(max > 0)) return '';
    let out = '', w = 0;
    for (const g of graphemes(String(name ?? '').replace(/\s+/g, ' ').trim())) {
      const cw = eaw(g);
      if (w + cw > max) break;
      out += g; w += cw;
    }
    return out.trimEnd();
  }
  // the first visible character (upper case when that stays one character), for a badge; none: '•'
  function initial(name) {
    const g = graphemes(String(name ?? '').trim()).find(x => eaw(x) > 0);
    if (!g) return '•';
    const u = g.toUpperCase();
    return graphemes(u).length === 1 ? u : g;
  }
  return { MODES, LABEL, SEMI, AMB, isMode, normMode, nextMode, eaw, width, graphemes, clusters, truncate, initial, RANGES: { WIDE, AMBI } };
})();
if (typeof module === 'object' && module.exports) module.exports = GbarMode;
