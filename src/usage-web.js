// 使用量表示のWeb読み取り (usage-config.js source 'web'): the provider's own public usage page, opened by main in a hidden window of the
// provider's own persistent partition (signed in by the user in the app's login window), read as the page's visible text only (innerText).
// No internal API, no token: the numbers are exactly what the page says in words. Pure (no electron) so plain Node tests cover it
// (test/usage-web.test.js): the page table, the fixed read script, where the hidden window ended up, and the text -> numbers parser.
// Page layouts after sign-in were not seen when this was written (2026-10): the parser goes by heading words, 'N% used / left' and a
// 'Resets …' line, and gives nothing (null) when the page does not say both the number and what it is. It never estimates a number.
const { hostIn } = require('./navigation-policy');

const WORLD = 1006;                    // main.js: the isolated world of the reader (1001-1005 are taken)
const READ_MS = 22000;                 // one page: load + render, then given up (PAGE without numbers = 接続済み・数値を読めません)
const STEP_MS = 1000;                  // poll interval; numbers count once two polls in a row read the same
const TEXT_MAX = 60000;                // characters of visible text taken from a page
const RESET_MAX = 60;                  // characters of a 'Resets …' phrase kept for the popover
// pages[0] decides the state (sign-in / moved / no numbers); later pages only add numbers when they have some (Kimi Code's console: URL
// not confirmed, read only if it shows usage). hosts: where the page may be (anything else = sent to a sign-in)
const PROV = {
  claude: { partition: 'persist:usage-claude', pages: ['https://claude.ai/settings/usage'], hosts: ['claude.ai'] },
  codex: { partition: 'persist:usage-codex', pages: ['https://chatgpt.com/codex/settings/usage'], hosts: ['chatgpt.com'] },
  kimi: { partition: 'persist:usage-kimi', pages: ['https://www.kimi.com/membership/subscription', 'https://www.kimi.com/code/console'], hosts: ['kimi.com'] },
};
// links the popover / menus open in the default browser (fixed here; a page never names the URL)
const LINKS = { claude: PROV.claude.pages[0], codex: PROV.codex.pages[0], kimi: PROV.kimi.pages[0], antigravity: 'https://antigravity.google/docs/plans/' };
const link = k => Object.prototype.hasOwnProperty.call(LINKS, k) ? LINKS[k] : '';

// run in WORLD (fixed code): where the page is, whether it finished loading, and its visible text
const READ_JS = `(() => { const b = document.body; return { href: String(location.href), ready: String(document.readyState), text: b ? String(b.innerText || '').slice(0, ${TEXT_MAX}) : '' }; })()`;

// the hidden window's URL after loading `wanted` -> 'PAGE' (on that page) / 'AUTH' (a sign-in page / another site) / 'MOVED' (the site sent
// it to another of its pages: not signed in, or the page moved) / 'UNKNOWN' (about:blank / an error page while loading)
const LOGIN_PATH = /(^|\/)(log-?in|sign-?in|sign-?up|auth|oauth|sso)(\/|$)/i;
function pageState(k, wanted, href) {
  const P = Object.prototype.hasOwnProperty.call(PROV, k) ? PROV[k] : null; if (!P) return 'UNKNOWN';
  let u, w; try { u = new URL(href); w = new URL(wanted); } catch { return 'UNKNOWN'; }
  if (u.protocol !== 'https:') return 'UNKNOWN';
  if (u.username || u.password || !hostIn(u.hostname, P.hosts) || LOGIN_PATH.test(u.pathname)) return 'AUTH';
  const base = w.pathname.replace(/\/+$/, '');
  return u.pathname === base || u.pathname.startsWith(base + '/') ? 'PAGE' : 'MOVED';
}

// ---- visible text -> numbers ----
const USED = /\bused\b|consumed|使用済み?|使用|消費|利用済み?|已用|已使用/gi;
const LEFT = /\bleft\b|remaining|\bremain\b|available|残り|残量|剩余|可用/gi;
const ADJ_USED = /^(?:used|使用済み?|使用|已用|已使用)(?:[\s:：]|$)/i, ADJ_LEFT = /^(?:left|remaining|available|残り|残量|剩余)(?:[\s:：]|$)/i;   // a short label line next to a bare 'N%'
const PROMO = /\bmore\b|\bless\b|\boff\b|\bsave\b|discount|extra|bonus|up to|多く|お得|割引|オフ|追加|最大|以上|以下|更多|折/i;   // 'N% more usage' is no reading
const PCT = /(?<![\d.,])(\d{1,3}(?:[.,]\d{1,2})?)\s*%/g;      // never the tail of a longer number ('1050%' is no 50%)
const SEP = /[·・|｜;；•]|\s{3,}/;
const WIN = [['five', /\b5[\s-]*(?:hours?|hrs?|h)\b|five[\s-]*hours?|5\s*時間|5\s*小时|current session|\bsession\b|セッション/i], ['week', /\bweek(?:ly)?\b|\b7[\s-]*days?\b|週|周/i],
  ['month', /\bmonth(?:ly)?\b|月間|月度|毎月|每月|本月/i]];
const WIN_SKIP = /\bago\b|last updated|最終更新|前に更新/i;                // 'Last updated 5 hours ago' says nothing about a window
const MODEL = /\b(opus|sonnet|haiku)\b|\b(gpt-\d[\w.-]*)/i, ALL_MODELS = /all models|全モデル|すべてのモデル|所有模型/i;
const CREDIT = /credits?|クレジット|额度|积分/i;
const RESET = /\bresets?\b|\brenews?\b|\brefresh(?:es)?\b|リセット|リフレッシュ|次回更新|更新日|重置|刷新/i;
const LABEL = { five: '5時間', session: 'セッション', week: '1週間', month: '月間' };

// NFKC: full-width digits / ％ / spaces as ASCII ('４５％' = '45%'); zero-width spaces dropped (not in \s, which has NBSP, U+2000-200A, U+3000)
const ZWSP = String.fromCharCode(0x200b);
const norm = s => String(s).normalize('NFKC').split(ZWSP).join('').replace(/\s+/g, ' ').trim();
// the direction word nearest to the number in its segment of the line (a word after the number wins a tie)
function direction(seg, s, e) {
  let best = null;
  for (const [re, kind] of [[USED, 'used'], [LEFT, 'left']]) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(seg));) {
      const a = m.index, b = a + m[0].length, after = a >= e, d = after ? a - e : b <= s ? s - b : 0;
      if (d > 24) continue;
      if (!best || d < best.d || (d === best.d && after && !best.after)) best = { d, kind, after };
    }
  }
  return best ? best.kind : null;
}
// readings in one line: [{ value, dir }] (value 0..100, dir 'used' | 'left'); a bare number takes a short label line right above / below
function readings(lines, i) {
  const out = [];
  for (const seg of lines[i].split(SEP)) {
    if (PROMO.test(seg)) continue;
    PCT.lastIndex = 0;
    for (let m; (m = PCT.exec(seg));) {
      const v = Number(m[1].replace(',', '.'));
      if (!(v >= 0 && v <= 100)) continue;
      let dir = direction(seg, m.index, m.index + m[0].length);
      if (!dir && norm(seg.replace(m[0], '')) === '') {
        const near = [lines[i + 1], lines[i - 1]].find(l => l && l.length <= 20 && (ADJ_USED.test(l) || ADJ_LEFT.test(l)));
        if (near) dir = ADJ_USED.test(near) ? 'used' : 'left';
      }
      if (dir) out.push({ value: v, dir });
    }
  }
  return out;
}
// 'Resets in 4 hr 23 min' / 'あと2日3時間' / '2026-11-01 09:00' -> ms since epoch (local time); weekday / month-name / month-day forms -> null
// (the popover shows the phrase itself); relative times count from `now`, the moment the page was read (to the minute)
const minute = t => Math.round(t / 60000) * 60000;
function resetAt(text, now) {
  const t = String(text);
  const a = t.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:\D{0,6}?(\d{1,2})\s*[:時]\s*(\d{2}))?/);
  if (a) {
    const [y, mo, d, h, mi] = [a[1], a[2], a[3], a[4] || 0, a[5] || 0].map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    const x = new Date(y, mo - 1, d, h, mi);
    return x.getMonth() === mo - 1 && x.getDate() === d ? x.getTime() : null;   // 2026-02-31: no such day
  }
  const rel = t.match(/\bin\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b[\s,]*(?:and\s+)?)+)/i);
  if (rel) {
    let ms = 0; const U = { d: 86400000, h: 3600000, m: 60000 };
    for (const [, n, u] of rel[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi)) ms += Number(n) * U[u[0].toLowerCase()];
    return ms > 0 ? minute(now + ms) : null;
  }
  if (/後|まで|あと/.test(t) && !/月/.test(t)) {                   // '11月1日まで' is a date, not '1日'
    const d = t.match(/(\d+)\s*日/), h = t.match(/(\d+)\s*時間/), m = t.match(/(\d+)\s*分/);
    const ms = ((d ? Number(d[1]) * 86400 : 0) + (h ? Number(h[1]) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0)) * 1000;
    if (ms > 0) return minute(now + ms);
  }
  return null;
}
// a reset line as the popover shows it: the whole line ('あと3時間10分でリセット'), or from the keyword on when the line also holds a reading
const resetPhrase = (line, withReading) => { const m = line.match(RESET); return m ? norm(withReading ? line.slice(m.index) : line).slice(0, RESET_MAX) : ''; };
const heading = l => !RESET.test(l) && (WIN.some(([, re]) => re.test(l)) || MODEL.test(l) || ALL_MODELS.test(l) || CREDIT.test(l));

// the page's visible text -> [{ id, label, used, resetAt, resetText, weekly, five, main }] (ai-usage.js' bucket shape) or null (no number
// the page states as used / left). Window: the nearest heading word at or above the number (12 lines; reset lines and 'ago' lines skipped);
// a model-only limit: a model name between the previous number and this one; reset: a 'Resets …' line in that block, else right below it
function parse(text, now = Date.now()) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.split(/\r?\n/).map(norm).filter(Boolean).slice(0, 3000);
  const hits = [];
  lines.forEach((_, i) => { const r = readings(lines, i); if (r.length) hits.push({ i, r }); });
  if (!hits.length) return null;
  const out = [];
  hits.forEach(({ i, r }, h) => {
    const prev = h ? hits[h - 1].i : -1, next = h + 1 < hits.length ? hits[h + 1].i : lines.length;
    let win = null, session = false;
    for (let j = i; j >= Math.max(0, i - 12) && !win; j--) {
      const m = RESET.exec(lines[j]), l = j === i && m ? lines[j].slice(0, m.index) : lines[j];   // the number's own line: up to its 'Resets …'
      if ((j !== i && m) || WIN_SKIP.test(l)) continue;
      const w = WIN.find(([, re]) => re.test(l));
      if (w) { win = w[0]; session = win === 'five' && !/5\s*(?:-|\s)?(?:hours?|hrs?|h\b|時間|小时)|five/i.test(l); }
    }
    let model = '', credit = false;
    for (let j = prev + 1; j <= i; j++) {
      const l = lines[j];
      if (CREDIT.test(l)) credit = true;
      if (ALL_MODELS.test(l)) continue;
      const m = l.match(MODEL); if (m && !model) model = m[1] ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : m[2];
    }
    // reset: on the number's own line; else in its block from the block's first heading on (a reset line before that heading ends the
    // previous block); else right below it, up to the next heading
    let rt = RESET.test(lines[i]) ? resetPhrase(lines[i], true) : '';
    let from = prev + 1; for (let j = prev + 1; j < i; j++) if (heading(lines[j])) { from = j; break; }
    for (let j = i - 1; !rt && j >= from; j--) if (RESET.test(lines[j])) rt = resetPhrase(lines[j], readings(lines, j).length > 0);
    for (let j = i + 1; !rt && j < Math.min(next, i + 3); j++) {
      if (heading(lines[j])) break;
      if (RESET.test(lines[j])) rt = resetPhrase(lines[j], false);
    }
    const base = win ? LABEL[session ? 'session' : win] : '';
    const label = (model ? model + ' ' : '') + (credit && (win === 'month' || !win) ? (base || '') + 'クレジット' : base || '制限');
    const at = rt ? resetAt(rt, now) : null;
    r.forEach(({ value, dir }) => {
      const used = Math.round((dir === 'used' ? value : 100 - value) * 10) / 10;
      const id = (model ? model.toLowerCase() + '-' : '') + (win || 'limit') + (credit ? '-credit' : '');
      if (out.some(b => b.id === id && b.used === used)) return;   // the same reading shown twice (e.g. a tooltip)
      out.push({ id, label, used, resetAt: at, resetText: rt, weekly: win === 'week' && !model, five: win === 'five' && !model, main: !model });
    });
  });
  if (!out.length) return null;
  const seen = {}; out.forEach(b => { seen[b.id] = (seen[b.id] || 0) + 1; if (seen[b.id] > 1) b.id += '#' + seen[b.id]; });
  return out;
}
// numbers from several pages of one provider (Kimi: subscription + Kimi Code console) -> one list, ids kept apart
function combine(lists) {
  const out = [], seen = {};
  for (const l of lists) for (const b of l || []) { const n = (seen[b.id] = (seen[b.id] || 0) + 1); out.push(n > 1 ? { ...b, id: b.id + '#' + n } : b); }
  return out.length ? out : null;
}

// read results -> a fixed code (debug log / diagnostics) and the Japanese reason the popover shows
const NOTE = {
  OK: '', PAGE: '接続済み・数値を読めません', AUTH: 'ログインが必要です（ゲージをクリックして接続）', MOVED: '使用量ページを開けませんでした（未ログインか、ページが移動しました）',
  TIMEOUT: '使用量ページの読み込みが時間内に終わりませんでした', BUSY: 'ログイン用のウィンドウを閉じると読み取ります', ABORT: '読み取りを中止しました', ERROR: '読み取りに失敗しました',
};
const loginTitle = name => `${name} にログイン（使用量表示用・ログインできたらこのウィンドウを閉じてください）`;

module.exports = { WORLD, READ_MS, STEP_MS, TEXT_MAX, RESET_MAX, PROV, LINKS, link, READ_JS, pageState, parse, resetAt, combine, NOTE, loginTitle };
