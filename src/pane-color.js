// Per-Bot pane tint: muted colours (readable text) chosen from the pane header menu, saved in
// settings.botColors by Bot URL / agentId, and washed over the header and the page (insertCSS).
// Kept as a plain module so tests cover the names, the wash, the key, and the map (no electron).
const NAMES = ['none', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];
const COLOR_JA = { none: 'なし', red: '赤', orange: 'オレンジ', yellow: '黄', green: '緑', teal: '水色', blue: '青', purple: '紫', pink: 'ピンク' };
// muted mid-tones used as --pc (header bar / chip). Bright system colours failed "薄く重ねても読める" for the chat wash.
const HEX = {
  none: null,
  red: '#b86b6b',
  orange: '#b8845a',
  yellow: '#a8964e',
  green: '#5e8a6c',
  teal: '#4f8a8e',
  blue: '#5a7198',
  purple: '#7a6490',
  pink: '#a66b80',
};
const WASH = {         // rgba overlay on the page (dark / light). Keep opacity low so the chat stays readable (P08 / P10)
  red:    { dark: 'rgba(120, 50, 50, 0.13)',  light: 'rgba(140, 60, 60, 0.08)' },
  orange: { dark: 'rgba(120, 78, 36, 0.13)',  light: 'rgba(140, 90, 40, 0.08)' },
  yellow: { dark: 'rgba(110, 100, 36, 0.12)', light: 'rgba(130, 110, 40, 0.08)' },
  green:  { dark: 'rgba(40, 90, 58, 0.13)',   light: 'rgba(40, 100, 60, 0.08)' },
  teal:   { dark: 'rgba(32, 90, 96, 0.13)',   light: 'rgba(30, 100, 105, 0.08)' },
  blue:   { dark: 'rgba(40, 60, 110, 0.14)',  light: 'rgba(40, 70, 130, 0.08)' },
  purple: { dark: 'rgba(80, 50, 110, 0.14)',  light: 'rgba(90, 55, 120, 0.08)' },
  pink:   { dark: 'rgba(110, 45, 70, 0.13)',  light: 'rgba(130, 50, 80, 0.08)' },
};
const BOT_RE = /^https:\/\/grok\.com\/bot\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/?(?:[?#].*)?$/;
const KEY_MAX = 300;

const isName = c => NAMES.includes(c);
const hex = c => (c && HEX[c]) || null;
const ja = c => COLOR_JA[c] || COLOR_JA.none;

function botKey(url) {
  if (typeof url !== 'string' || !url) return '';
  const m = url.match(BOT_RE);
  if (m) return 'bot:' + m[1].toLowerCase();
  let u; try { u = new URL(url); } catch { return ''; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return '';
  const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
  const key = 'url:' + u.protocol + '//' + u.host + path;
  return key.length <= KEY_MAX ? key : '';
}

function wash(c, dark) {
  const w = WASH[c];
  return w ? (dark === false ? w.light : w.dark) : '';
}

// CSS inserted into the page (pointer-events none; a unique attribute so it is easy to recognise). Never includes a Bot URL / id.
function washCss(c, dark) {
  const bg = wash(c, dark);
  if (!bg) return '';
  return `html::after{content:"";position:fixed;inset:0;background:${bg};pointer-events:none;z-index:2147483646;}\n`;
}

function setBg(color, map, key) {
  const next = { ...(map && typeof map === 'object' && !Array.isArray(map) ? map : {}) };
  if (!key || !isName(color)) return next;
  if (color === 'none') delete next[key];
  else next[key] = color;
  return next;
}

function lookup(map, key, fallback) {
  const c = map && key && isName(map[key]) && map[key] !== 'none' ? map[key] : '';
  if (c) return c;
  return isName(fallback) ? fallback : 'none';
}

function validMap(v) {
  if (v === undefined) return true;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.keys(v).every(k => typeof k === 'string' && k.length <= KEY_MAX && (k.startsWith('bot:') || k.startsWith('url:'))
    && isName(v[k]) && v[k] !== 'none');
}

function cleanMap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [k, c] of Object.entries(v)) {
    if (typeof k === 'string' && k.length <= KEY_MAX && (k.startsWith('bot:') || k.startsWith('url:')) && isName(c) && c !== 'none') out[k] = c;
  }
  return out;
}

// a slightly tinted chrome / view background (never opaque)
function viewBg(c, dark) {
  const base = dark === false ? '#ffffff' : '#1c1c1e';
  const hexC = hex(c);
  if (!hexC) return base;
  return dark === false ? base : base; // the wash + header carry the colour; keep the view base readable
}

module.exports = { NAMES, COLOR_JA, HEX, WASH, isName, hex, ja, botKey, wash, washCss, setBg, lookup, validMap, cleanMap, viewBg };
