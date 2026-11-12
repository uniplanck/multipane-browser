// NaoAIへの指示: pure rules (no electron), shared by main, the overlay's box (a plain <script>) and the IPC validators; plain Node tests:
// test/instruct-*.test.js. A row of the 進捗サイドバー page (right-click -> window.xgBotsSidebar.instruct({ tid, task, bot, state, memo })) opens a
// Spotlight-like box in the centre of the window; its text is POSTed as JSON to one webhook the user set (settings: URL + key, stored encrypted
// by main - instruct-webhook.js - never in panes.json, never handed to a renderer). Nothing here knows the URL / key beyond checking them.
//   request() / requestOk(): the page's fields -> { tid, task, bot, state, memo } (strings only, control characters out, each cut to its limit)
//   instruction(): the box's text -> what is sent (trimmed, 1..TEXT_MAX) or ''
//   hookUrl() / hostOk() / hookHost() / hookKey(): the setting - https on cursor.com / cursor.sh (or a subdomain), a key of KEY_MIN..KEY_MAX
//   payload() / messageId() / jst(): the JSON body (kind, messageId, instruction, task, source, createdAt, createdAtJst; an answer: mode, choices?, choice?)
//   choicesOk() / choicesOf(): the answer box's picked labels (the IPC shape; only the row's own options are kept)
//   keyAction(): a keydown in the box -> send / newline / close / ignore / none (an IME composition never sends or closes)
//   toastText() / toastKind() / hookView(): what the user is told (never the URL / key: at most the host)
//   boxRect() / toastRect() / draftSet(): the box's view in the window, the result toast, the drafts kept per tid (memory only)
const InstructRules = (() => {
  const LIMITS = { tid: 60, task: 500, bot: 40, state: 20, memo: 500 };   // each field of a row, cut to this many UTF-16 units
  const FIELDS = Object.keys(LIMITS);
  const RAW_MAX = 10000;                     // a field as the page sends it (longer: refused by the IPC policy; shorter ones are cut to LIMITS)
  const TEXT_MAX = 4000;                     // the instruction (the box's maxlength; trimmed 1..TEXT_MAX is sent)
  const URL_MAX = 2048, KEY_MIN = 8, KEY_MAX = 500;
  const HOSTS = ['cursor.com', 'cursor.sh'];   // the webhook's host: one of these or a subdomain (the rule of the Grok Bot webhooks)
  const TIMEOUT_MS = 15000;                  // the POST gives up after this long
  const TOAST_MS = 3000;                     // the result toast stays this long
  const DRAFTS_MAX = 50;                     // drafts kept (per tid, oldest dropped first; memory only, until the app quits)
  const PARTITION = 'xg-instruct';           // main's session for the POST: in memory (no 'persist:'), nothing shared with the panes / the sidebar
  const KIND = 'xg-bots-instruction', SOURCE = 'xG-Bots 進捗サイドバー';
  const RESULTS = ['open', 'blocked', 'bad'];   // instruct()'s answers to the page (= sidebar-preload.js)
  const ID_RE = /^x_[0-9a-f]{24}$/;
  const BOX = { w: 720, h: 380, m: 12 };     // the box's view (the box + room for its shadow; a click there = outside), at least m from the window's edges
  const TOAST = { w: 480, h: 64, bottom: 24 };

  const obj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  // a field: control characters (newlines / tabs too) -> one space, bidi / direction marks and lone surrogates out, spaces folded, trimmed, cut to
  // max without splitting a surrogate pair
  function clean(s, max) {
    if (typeof s !== 'string') return '';
    const t = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '').replace(/\s+/g, ' ').trim();
    let out = '';
    for (const ch of t) { if (out.length + ch.length > max) break; out += ch; }
    return out.trim();
  }
  const ASK_MAX = 500, OPT_MAX = 80, OPT_N = 8;   // 待ち内容 / 選択肢 (task.sh --ask / --options; the answer box)
  const EXTRA = ['mode', 'ask', 'options'];        // optional: mode "answer", the wait prompt, up to 8 choice strings
  // the IPC payload: the row fields (strings) plus the optional answer keys; tid present
  const requestOk = v => obj(v) && Object.keys(v).every(k => FIELDS.includes(k) || EXTRA.includes(k)) && typeof v.tid === 'string'
    && FIELDS.every(k => v[k] === undefined || (typeof v[k] === 'string' && v[k].length <= RAW_MAX))
    && (v.mode === undefined || v.mode === 'answer' || v.mode === '')
    && (v.ask === undefined || (typeof v.ask === 'string' && v.ask.length <= RAW_MAX))
    && (v.options === undefined || (Array.isArray(v.options) && v.options.length <= OPT_N && v.options.every(x => typeof x === 'string' && x.length <= RAW_MAX)));
  function optionsOf(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const x of v) {
      const s = clean(x, OPT_MAX);
      if (s && !out.includes(s)) out.push(s);
      if (out.length >= OPT_N) break;
    }
    return out;
  }
  // the answer box's picks (IPC: an array of at most OPT_N labels of at most OPT_MAX each; a lone string = the legacy one choice) -> the row's own
  // options that were picked (optionsOf: the row's order, cleaned, no duplicates); a label not on the row / empty / not a string is dropped
  const CHOICE_SEP = '\n';                         // the picks one per line = the instruction when nothing usable was typed
  const choicesOk = v => Array.isArray(v) && v.length <= OPT_N && v.every(x => typeof x === 'string' && x.length <= OPT_MAX);
  function choicesOf(picked, options) {
    const p = [].concat(picked).filter(x => typeof x === 'string' && x.length <= RAW_MAX).map(x => clean(x, OPT_MAX));
    return optionsOf(options).filter(s => p.includes(s));
  }
  // -> { tid, task, bot, state, memo, mode?, ask?, options? }, or null (not usable / no tid left after cleaning)
  function request(v) {
    if (!requestOk(v)) return null;
    const o = {};
    for (const k of FIELDS) o[k] = clean(v[k], LIMITS[k]);
    if (!o.tid) return null;
    if (v.mode === 'answer') o.mode = 'answer';
    const ask = clean(v.ask, ASK_MAX);
    if (ask) o.ask = ask;
    const opts = optionsOf(v.options);
    if (opts.length) o.options = opts;
    return o;
  }
  // the box's text -> what is sent: line breaks kept (CR LF -> LF), other control characters out, trimmed; '' = nothing to send / too long
  function instruction(text) {
    if (typeof text !== 'string') return '';
    const t = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').trim();
    return t.length >= 1 && t.length <= TEXT_MAX ? t : '';
  }

  // ---- the setting ----
  const hostOk = h => typeof h === 'string' && HOSTS.some(d => h === d || h.endsWith('.' + d));
  // https only, no user name / password / port of its own, no spaces / control characters, host on HOSTS -> the normalised URL, or ''
  function hookUrl(value) {
    if (typeof value !== 'string') return '';
    const s = value.trim();
    if (!s || s.length > URL_MAX || /[\u0000- \u007f-\u009f]/.test(s)) return '';
    let u; try { u = new URL(s); } catch { return ''; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !hostOk(u.hostname)) return '';
    return u.href.length <= URL_MAX ? u.href : '';
  }
  const hookHost = value => { const h = hookUrl(value); return h ? new URL(h).hostname : ''; };
  // the key (the Bearer token): visible ASCII only (an HTTP header value), KEY_MIN..KEY_MAX after trimming -> the key, or ''
  const hookKey = value => { const k = typeof value === 'string' ? value.trim() : ''; return k.length >= KEY_MIN && k.length <= KEY_MAX && /^[\x21-\x7e]+$/.test(k) ? k : ''; };
  // what the settings screen / the box may know of it: { configured, host, available } and nothing else
  const hookView = s => { const o = obj(s) ? s : {}; return { configured: o.configured === true, host: hostOk(o.host) && o.host.length <= 253 ? o.host : '', available: o.available !== false }; };

  // ---- the request body ----
  // 12 random bytes (main: crypto.randomBytes) -> 'x_' + 24 hex, or '' (not 12 bytes: fewer, a string, other values)
  function messageId(bytes) {
    if (!bytes || typeof bytes !== 'object' || typeof bytes.length !== 'number' || bytes.length < 12) return '';
    const b = Array.from(bytes).slice(0, 12);
    return b.every(x => Number.isInteger(x) && x >= 0 && x <= 255) ? 'x_' + b.map(x => x.toString(16).padStart(2, '0')).join('') : '';
  }
  const timeOf = d => d && typeof d.getTime === 'function' ? d.getTime() : typeof d === 'number' ? d : NaN;
  // a time -> 'yyyy-MM-dd HH:mm JST' (UTC+9, no daylight saving), or ''
  function jst(d) {
    const t = timeOf(d);
    if (!Number.isFinite(t)) return '';
    const j = new Date(t + 9 * 3600000), p = n => String(n).padStart(2, '0');
    return Number.isNaN(j.getTime()) ? '' : `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())} JST`;
  }
  // { id: messageId(), instruction: the box's text, task: the row (request()), now: a Date[, mode: 'answer', choices: [labels], choice: label] }
  // -> the JSON body, or null (anything unusable). mode answer: task { tid, task } only; choices = the picks on the row's options (choicesOf;
  // others dropped), choice = the same label when exactly one (an older receiver reads choice only: with two or more it is left out, never cut
  // to one); instruction = the typed text, or the picks one per line when nothing usable was typed. The app never closes / removes the task
  function payload(o) {
    const x = obj(o) ? o : {}, task = request(x.task), t = timeOf(x.now);
    const picks = x.mode === 'answer' && task ? choicesOf([].concat(x.choices, x.choice), task.options) : [];
    const ins = instruction(x.instruction) || instruction(picks.join(CHOICE_SEP));
    if (typeof x.id !== 'string' || !ID_RE.test(x.id) || !task || !ins || !Number.isFinite(t) || Number.isNaN(new Date(t).getTime())) return null;
    if (x.mode === 'answer') {
      const body = { kind: KIND, messageId: x.id, instruction: ins, task: { tid: task.tid, task: task.task },
        source: SOURCE, createdAt: new Date(t).toISOString(), createdAtJst: jst(t), mode: 'answer' };
      if (picks.length) body.choices = picks;
      if (picks.length === 1) body.choice = picks[0];
      return body;
    }
    return { kind: KIND, messageId: x.id, instruction: ins, task: { tid: task.tid, task: task.task, bot: task.bot, state: task.state, memo: task.memo },
      source: SOURCE, createdAt: new Date(t).toISOString(), createdAtJst: jst(t) };
  }

  // ---- the box ----
  // a keydown in the box's field ({ key, shiftKey, altKey, repeat, isComposing, keyCode } + composing: the page's own composition flag) ->
  // 'send' (Enter, ⌘↵ / Ctrl+↵ too) | 'newline' (⇧↵ / ⌥↵: the field's own) | 'close' (Esc) | 'ignore' (a held Enter: nothing) | 'none' (not ours).
  // An IME composition (isComposing / keyCode 229) is always 'none': its Enter commits the text, its Esc cancels it - never a send or a close
  function keyAction(e) {
    const k = obj(e) ? e : {};
    if (k.isComposing === true || k.composing === true || k.keyCode === 229) return 'none';
    if (k.key === 'Escape') return k.repeat === true ? 'ignore' : 'close';
    if (k.key !== 'Enter') return 'none';
    if (k.shiftKey === true || k.altKey === true) return 'newline';
    return k.repeat === true ? 'ignore' : 'send';
  }
  // the box's view: centred in the window's content (w x h), BOX at most, BOX.m from every edge
  function boxRect(w, h) {
    const W = Math.max(0, Math.min(BOX.w, Math.floor(w - 2 * BOX.m))), H = Math.max(0, Math.min(BOX.h, Math.floor(h - 2 * BOX.m)));
    return { x: Math.round((w - W) / 2), y: Math.round((h - H) / 2), width: W, height: H };
  }
  // the toast: bottom centre of the window's content (w x h)
  function toastRect(w, h) {
    const W = Math.max(0, Math.min(TOAST.w, Math.floor(w - 32)));
    return { x: Math.round((w - W) / 2), y: Math.max(0, Math.round(h - TOAST.h - TOAST.bottom)), width: W, height: TOAST.h };
  }
  // drafts: Map tid -> text (the newest last). '' / spaces only = none; more than DRAFTS_MAX: the oldest goes. Returns the map
  function draftSet(map, tid, text) {
    if (!map || typeof map.set !== 'function' || typeof map.delete !== 'function' || typeof tid !== 'string' || !tid) return map;   // a Map (of any realm)
    map.delete(tid);
    if (typeof text === 'string' && text.trim()) map.set(tid, text.slice(0, TEXT_MAX));
    while (map.size > DRAFTS_MAX) map.delete(map.keys().next().value);
    return map;
  }

  // ---- what the user is told ----
  // r = { ok: true } | { code: 'UNSET' | 'HTTP' (status) | 'TIMEOUT' | 'NETWORK' | 'READ' | 'TEXT' | ... } -> one line (Japanese). Never the URL / key
  const WHY = { TIMEOUT: 'タイムアウト', NETWORK: '通信エラー', READ: '保存した設定を読めません', UNAVAILABLE: '暗号化した保存が使えません' };
  function toastText(r, tid) {
    const o = obj(r) ? r : {};
    if (o.ok === true) return `NaoAIに送りました（${clean(tid, LIMITS.tid) || '-'}）`;
    if (o.code === 'UNSET') return 'NaoAIのwebhookが未設定です';
    if (o.code === 'TEXT') return `指示を入力してください（${TEXT_MAX}文字まで）`;
    if (o.code === 'HTTP' && Number.isSafeInteger(o.status) && o.status >= 100 && o.status <= 999) return `送れませんでした（HTTP ${o.status}）`;
    return `送れませんでした（${Object.hasOwn(WHY, o.code) ? WHY[o.code] : 'エラー'}）`;
  }
  const toastKind = r => { const o = obj(r) ? r : {}; return o.ok === true ? 'ok' : o.code === 'UNSET' || o.code === 'TEXT' ? 'warn' : 'err'; };

  return { LIMITS, FIELDS, EXTRA, ASK_MAX, OPT_MAX, OPT_N, RAW_MAX, TEXT_MAX, URL_MAX, KEY_MIN, KEY_MAX, HOSTS, TIMEOUT_MS, TOAST_MS, DRAFTS_MAX, PARTITION, KIND, SOURCE, RESULTS, ID_RE, BOX, TOAST,
    CHOICE_SEP, clean, requestOk, request, optionsOf, choicesOk, choicesOf, instruction, hostOk, hookUrl, hookHost, hookKey, hookView, messageId, jst, payload, keyAction, boxRect, toastRect, draftSet,
    toastText, toastKind };
})();
if (typeof module !== 'undefined') module.exports = InstructRules;
