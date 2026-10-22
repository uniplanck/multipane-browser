// Diagnostics log (#73): what happened (page loads, background checks, discarded state / IPC, failed saves), never what it was about.
// An entry is only { t: time, ev: known event, r: known result / error code, ms: duration, n: attempts, p: the pane's per-launch number }.
// Every field is checked against fixed lists, types and ranges and anything else is dropped before it is stored (nothing is masked afterwards):
// no payloads, page text, names, quotes, input, URLs, headers, cookies, tokens, paths or Error.message / stack. An error becomes a fixed code
// (ENOSPC, NET_TIMEOUT ...) or UNKNOWN, and is counted.
// Memory: a ring of the last RING_MAX entries. Disk only when asked (settings.diagPersist / MPB_DEBUG): its own directory (userData/diagnostics,
// owner-only), one JSON line per entry in diag-0.jsonl (newest) .. diag-2.jsonl, FILE_MAX bytes per file, files not written for MAX_AGE_MS removed.
// Only diag-N.jsonl in that directory is ever rotated or removed (pane-debug.log and anything else is left alone).
// Writes are async, batched and bounded; a failing disk is noted once per failure streak and never stops the app or the memory log.
// Pure parts (sanitize, ring, clock, rotation plan, summary / view) take time and inputs as arguments; fs / timers are injectable (test/diagnostics.test.js).
const realFs = require('fs'), path = require('path');

const RING_MAX = 1000;
const FILE_MAX = 2 * 1024 * 1024;           // bytes per file
const GENERATIONS = 3;                      // diag-0 (being written) .. diag-2
const MAX_AGE_MS = 7 * 86400000;            // a file not written for this long is removed
const MS_MAX = 24 * 3600000;                // durations above a day are not kept
const N_MAX = 10000;                        // attempts
const PANE_MAX = 999999;                    // main's per-launch pane counter (1, 2, 3 ...; never stored, not derived from the page)
const QUEUE_MAX = 1000;                     // lines waiting for the disk; beyond that the oldest are dropped (counted)
const BATCH_MAX = 200;                      // lines per write
const FLUSH_MS = 2000;                      // at most one write per this
const RETRY_MS = 60000, RETRY_MAX_MS = 15 * 60000;   // after a failed write: wait, doubling up to the max
const SUMMARY_RECENT = 20;                  // last entries in the copied summary
const FILE_RE = /^diag-(\d)\.jsonl$/;
const fileName = i => `diag-${i}.jsonl`;
const C = realFs.constants, APPEND = C.O_WRONLY | C.O_APPEND | C.O_CREAT | (C.O_NOFOLLOW || 0);   // never write through a symlink

// ---- fixed codes ----
const FS_CODES = ['ENOSPC', 'EDQUOT', 'EFBIG', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'EBUSY', 'EAGAIN', 'ELOOP', 'EINVALID'];
const NET = { [-2]: 'NET_FAILED', [-3]: 'NET_ABORTED', [-7]: 'NET_TIMEOUT', [-118]: 'NET_TIMEOUT', [-20]: 'NET_BLOCKED', [-27]: 'NET_BLOCKED', [-21]: 'NET_CHANGED',
  [-100]: 'NET_CLOSED', [-101]: 'NET_RESET', [-102]: 'NET_REFUSED', [-104]: 'NET_CONNECT', [-105]: 'NET_DNS', [-137]: 'NET_DNS', [-106]: 'NET_OFFLINE', [-107]: 'NET_TLS', [-109]: 'NET_UNREACHABLE' };
const NET_CODES = [...new Set([...Object.values(NET), 'NET_CERT', 'NET_HTTP'])];
const GONE = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'];   // render-process-gone reasons
const GONE_CODES = GONE.map(g => g.toUpperCase().replace(/-/g, '_'));
const IPC_CODES = ['E_CHANNEL', 'E_SENDER', 'E_ROLE', 'E_FRAME', 'E_PAGE', 'E_OWNER', 'E_PAYLOAD', 'E_TARGET'];   // = ipc-policy.js REJECT (checked by the test)
// a scan main could not act on: pane-rules snapIssue() codes + a heading that is not unambiguous + a report about another bot than the pane shows
const DOM_CODES = ['LOADING', 'AUTH_REQUIRED', 'DOM_UNKNOWN', 'ROLE_GUESS', 'LATEST_PARTIAL', 'CHANGING', 'NAME_UNSURE', 'OTHER_CONV'];
// a report main dropped by its generation stamp (#02, pane-state.js admit / probe-scan): closed or other pane, no number yet, older generation,
// duplicate / out of order, a background check that is no longer the running one
const GEN_CODES = ['CLOSED', 'OTHER_PANE', 'NO_TOKEN', 'STALE_GEN', 'STALE_SEQ', 'STALE_RUN'];
// input guard (#11, draft-guard.js; checked by the test): why an automatic operation was refused / why a confirmation no longer held
const GUARD_AUTO_CODES = ['PRESENT', 'ATTACH', 'UPLOAD', 'IME', 'UNKNOWN', 'BUSY', 'CHANGED', 'STALE'];
const GUARD_EXPIRE_CODES = ['GONE', 'NEW', 'CHANGED', 'STALE', 'PANE', 'INPUT'];
// shared load queue (#31, load-queue.js CODES; checked by test/load-queue.test.js): queued / merged / replaced / a check stopped for the user's load,
// how a load ended (settled / released at the cap / stopped after a cancel / view gone / input check refused / error) and why it was cancelled
const LOAD_CODES = ['WAIT', 'MERGED', 'SUPERSEDED', 'PREEMPT', 'DONE', 'CAP', 'STOPPED', 'GONE', 'GUARD', 'ERROR', 'USER', 'CLOSED', 'URL', 'WINDOW', 'ABORT'];
// (#72) a move / link / load / external open refused (= navigation-policy.js REJECT) and a site permission / download refused (= permission-policy.js
// REJECT; both checked by the test)
const NAV_CODES = ['E_URL', 'E_USERINFO', 'E_SCHEME', 'E_GESTURE', 'E_UI'];
const PERM_CODES = ['E_PERM', 'E_ROLE', 'E_ORIGIN', 'E_FRAME', 'E_MEDIA', 'E_DOWNLOAD'];
// (#53, zoom-policy.js CODES; checked by test/zoom-policy.test.js) a pane view's zoom backend and why, a page that lost the isolated mode, a fallback
const ZOOM_CODES = ['NATIVE', 'NO_API', 'FORCED', 'INIT_FAIL', 'MODE_FAIL', 'MODE_RESET', 'FALLBACK'];
// (#61, notification-policy.js CODES; checked by test/notification-policy.test.js) a notification sent for one pane / merged (n = panes), a
// duplicate, consumed while muted / in quiet hours, dropped at delivery (closed / now in front), a click: pane opened / front only (gone, merged)
const NOTIFY_CODES = ['SENT', 'MERGED', 'DUP', 'MUTED', 'QUIET', 'GONE', 'SEEN', 'OPEN', 'STALE', 'FRONT'];
// (#23, closed-panes.js CODES; checked by test/closed-panes.test.js) 閉じたペインを開き直す: reopened / nothing closed / MAX panes open / one
// already running / the pane could not be made (n = entries left in the history; never its URL or name)
const REOPEN_CODES = ['OK', 'EMPTY', 'FULL', 'BUSY', 'FAIL'];
// (#12, broadcast-state.js CODES; checked by test/broadcast-state.test.js) 一斉送信: a preview (n = panes), a batch started (n = targets) / in the
// dry-run mode, a send refused (the same preview again / a batch still running / not the preview on screen), per target (p): send started,
// confirmed, result unknown, skipped / moved since the preview / did not wake, cancelled (n), finished (n = confirmed). Never the text / a name / a URL
const BCAST_CODES = ['PREVIEW', 'START', 'DRYRUN', 'DUP', 'STALE', 'BUSY', 'SENT', 'OK', 'UNSURE', 'SKIP', 'CHANGED', 'NO_WAKE', 'CANCEL', 'DONE'];
// (#32, recovery-policy.js CODES; checked by test/recovery-policy.test.js) a transient load failure's automatic reload planned (n = attempt) /
// started (n = automatic reloads in 10 min), no more (n), a permanent failure, dropped for input / a busy pane / because the pane moved on, the
// renderer gone (manual reload only), its placeholder cleared by a new page. Never the URL / a name
const RECOVER_CODES = ['SCHEDULED', 'RETRY', 'LIMIT', 'PERMANENT', 'SKIP_DRAFT', 'SKIP_BUSY', 'CANCELLED', 'GONE_MANUAL', 'CLEARED'];
// (#22, session-snapshot.js CODES; checked by the test) 前回のスリープ状態を復元 at startup: panes started asleep (n), of those shown without a
// marker (saved too long ago / times off, n), saved snapshots not used (n). Counts only, never a name / quote / URL
const RESTORE_CODES = ['ASLEEP', 'OLD', 'IGNORED'];
// (#01, attention-queue.js CODES; checked by test/attention-queue.test.js) 対応キュー: the list opened (n = items), a choice carried out (p), a
// choice refused because the pane is closed / shows another conversation now (p). Never a name / reason text / URL
const QUEUE_CODES = ['OPEN', 'PICK', 'GONE', 'MOVED'];
// (#51, pane-navigation.js CODES; checked by test/pane-navigation.test.js) キーボードでのペイン移動: moved by position / to the next 対応キュー item (p =
// the pane), nothing that way / nothing listed, a pane not on screen yet waited for, given the keyboard once shown / the wait dropped (the user
// moved / too late), a key held back from the pane that kept the keyboard. Never a name / URL / key typed
const PANE_NAV_CODES = ['MOVE', 'EDGE', 'QUEUE', 'NONE', 'WAIT', 'FOCUS', 'DROP', 'HELD'];
// (Grok bar, grok-bots.js CODES; checked by test/grok-bots.test.js) a read of the Bot list (n = Bots, ms): read / not signed in / timeout / none
// found / the ボット section closed / left grok.com / error / cut short / a press while one runs; the old favorites moved to their backup once (n);
// the sidebar state not confirmed back. Never a name / URL / icon
const GBAR_CODES = ['OK', 'AUTH', 'TIMEOUT', 'EMPTY', 'COLLAPSED', 'OFFSITE', 'ERROR', 'ABORT', 'BUSY', 'MIGRATED', 'RESTORE_FAIL'];

// an error -> fixed code. Only `code` is read (fs / state-store codes); message / stack are never looked at
function errCode(e) {
  let c; try { c = typeof e === 'string' ? e : e && e.code; } catch { return 'UNKNOWN'; }
  return typeof c === 'string' && FS_CODES.includes(c) ? c : 'UNKNOWN';
}
// Chromium net error number (did-fail-load) -> fixed code
function netCode(n) {
  if (!Number.isSafeInteger(n)) return 'UNKNOWN';
  if (Object.hasOwn(NET, n)) return NET[n];
  if (n <= -200 && n > -300) return 'NET_CERT';
  if (n <= -300 && n > -400) return 'NET_HTTP';
  return 'UNKNOWN';
}
const goneCode = reason => { const i = GONE.indexOf(reason); return i < 0 ? 'UNKNOWN' : GONE_CODES[i]; };

// event -> the result codes it may carry (UNKNOWN always) + the label on the diagnostics screen
const EVENTS = {
  app: { ja: '起動', r: ['START'] },
  'pane.load': { ja: 'ページの読込', r: ['OK', ...NET_CODES] },
  'pane.gone': { ja: 'ページのプロセス終了', r: GONE_CODES },
  'pane.hang': { ja: 'ページの無応答', r: ['HANG', 'RESPONSIVE'] },
  grokfix: { ja: 'Bot表示の補正', r: ['FAST_RENDERED', 'FAST_NOTFOUND', 'HARD_RELOAD', 'OK_ROUTER', 'OK_CLICK', 'RENDERED', 'NOTFOUND', 'FALLBACK_HOME', 'GAVE_UP'] },
  reload: { ja: '再読み込み', r: ['PLAIN', 'BLANK_LOAD', 'GONE_LOAD', 'ROUTER_OK', 'ROUTER_MISS', 'HARD_LOAD'] },
  watchdog: { ja: '真っ白なBotの再読込', r: ['RELOAD'] },
  recover: { ja: '読込失敗・ページ停止からの復旧', r: RECOVER_CODES },
  'load.queue': { ja: '読み込みの順番待ち', r: LOAD_CODES },
  // (#33, probe-policy.js CODES; checked by test/probe-policy.test.js) + a failure backed off (n = failures in a row), the sign-in stop, 確認を再開
  probe: { ja: 'スリープ中の新着確認', r: ['CHANGED', 'SAME', 'BASELINE', 'UNSURE', 'STALE', 'TIMEOUT', 'ABORT', 'WOKE', 'OFFSITE', 'NOTFOUND', 'ERROR', 'BACKOFF', 'AUTH_HOLD', 'RESUME'] },
  sleep: { ja: 'スリープ', r: ['SLEPT', 'WAKE'] },
  restore: { ja: '前回のスリープ状態の復元', r: RESTORE_CODES },
  draft: { ja: '操作前の入力欄の確認', r: ['EMPTY', 'PRESENT', 'NOINPUT'] },
  'guard.auto': { ja: '入力があるため止めた自動操作', r: GUARD_AUTO_CODES },
  'guard.ask': { ja: '入力が失われる操作の確認', r: ['ASKED', 'CANCEL', 'GO', 'BUSY', ...GUARD_EXPIRE_CODES] },
  'count.drop': { ja: '採用しなかった件数の報告', r: ['SLEEPING', 'NOT_BOT', ...GEN_CODES] },
  dom: { ja: '会話を確定できなかった読み取り', r: DOM_CODES },
  'ipc.reject': { ja: '拒否したIPC', r: IPC_CODES },
  'nav.block': { ja: '止めた遷移・リンク・外部起動', r: NAV_CODES },
  'perm.deny': { ja: '拒否したサイト権限・ダウンロード', r: PERM_CODES },
  zoom: { ja: 'ペインのズーム方式', r: ZOOM_CODES },
  notify: { ja: '通知の配送', r: NOTIFY_CODES },
  reopen: { ja: '閉じたペインを開き直す', r: REOPEN_CODES },
  bcast: { ja: '一斉送信', r: BCAST_CODES },
  queue: { ja: '対応キュー', r: QUEUE_CODES },
  nav: { ja: 'キーボードでのペイン移動', r: PANE_NAV_CODES },
  gbar: { ja: 'Bot一覧の読み込み（Grokボタン）', r: GBAR_CODES },
  'state.load': { ja: '構成の読込', r: ['READY', 'REPAIRED', 'RECOVERY_READ', 'RECOVERY_JSON', 'RECOVERY_INVALID', 'NEWER'] },
  'state.save': { ja: '構成の保存', r: ['RECOVERED', ...FS_CODES] },
  'diag.disk': { ja: '診断ログのファイル保存', r: ['ON', 'OFF', 'RECOVERED', ...FS_CODES] },
};
const EV_ORDER = Object.keys(EVENTS);

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined;
const intIn = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
// (event, result, { ms, n, p }) -> a new entry with known values only, or null (unknown event). Throws only if reading `f` throws (rec catches).
function sanitize(ev, r, f, t) {
  if (typeof ev !== 'string' || !Object.hasOwn(EVENTS, ev)) return null;
  const e = { t: intIn(t, 0, 8.64e15) ? t : 0, ev, r: typeof r === 'string' && EVENTS[ev].r.includes(r) ? r : 'UNKNOWN' };
  const ms = own(f, 'ms'), n = own(f, 'n'), p = own(f, 'p');
  if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= MS_MAX) e.ms = Math.round(ms);
  if (intIn(n, 0, N_MAX)) e.n = n;
  if (intIn(p, 1, PANE_MAX)) e.p = p;
  return e;
}

// ---- memory ring ----
function createRing(max = RING_MAX) {
  const buf = new Array(max); let start = 0, size = 0, dropped = 0;
  return {
    push(x) { if (size < max) { buf[(start + size) % max] = x; size++; } else { buf[start] = x; start = (start + 1) % max; dropped++; } },
    list() { const out = []; for (let i = 0; i < size; i++) out.push(buf[(start + i) % max]); return out; },
    get size() { return size; }, get dropped() { return dropped; }, max,
  };
}

// ---- clock: the wall clock, never backwards ----
// When the wall clock is set back (or steps back) the time goes on from the monotonic clock until the wall clock has caught up, so entries
// stay in order. A jump forward is taken as is.
const hrMs = () => Number(process.hrtime.bigint() / 1000000n);
function createClock(wall = Date.now, mono = hrMs) {
  let lastT = null, lastM = 0;
  return () => {
    let w, m;
    try { w = Number(wall()); } catch { w = NaN; }
    try { m = Number(mono()); } catch { m = NaN; }
    if (!Number.isFinite(m)) m = lastM;
    let t;
    if (lastT === null) t = Number.isFinite(w) && w >= 0 ? w : 0;
    else t = Number.isFinite(w) && w >= lastT ? w : lastT + Math.max(0, m - lastM);
    lastT = t; lastM = m;
    return Math.floor(t);
  };
}

// ---- rotation plan (pure) ----
// files: the directory listing [{ name, size, mtimeMs }] (regular files; any names: only diag-N.jsonl counts). Before appending `incoming` bytes:
// files not written for maxAge and generations beyond `gens` go; a diag-0 that would pass fileMax shifts to diag-1 .. diag-(gens-1) (the oldest goes).
// -> { unlink: [name], rename: [[from, to]] (in this order), target: the file to append to, rotate }
function planRotation({ files, now, incoming = 0, fileMax = FILE_MAX, gens = GENERATIONS, maxAge = MAX_AGE_MS }) {
  const have = new Map(), unlink = [], rename = [];
  for (const f of Array.isArray(files) ? files : []) {
    const m = f && typeof f.name === 'string' && FILE_RE.exec(f.name); if (!m) continue;
    const i = Number(m[1]);
    if (i >= gens || (Number.isFinite(f.mtimeMs) && Number.isFinite(now) && now - f.mtimeMs > maxAge)) { unlink.push(f.name); continue; }
    have.set(i, f);
  }
  const cur = have.get(0);
  const rotate = !!cur && cur.size > 0 && cur.size + incoming > fileMax;
  if (rotate) {
    if (have.has(gens - 1)) unlink.push(fileName(gens - 1));
    for (let i = gens - 1; i >= 1; i--) if (have.has(i - 1)) rename.push([fileName(i - 1), fileName(i)]);
  }
  return { unlink, rename, target: fileName(0), rotate };
}

// ---- what the summary / screen may show about the app (everything else in `x` is ignored) ----
const VER_RE = /^[0-9][0-9A-Za-z.+-]{0,31}$/;
const SETTINGS = { notifications: 'bool', quietHours: 'bool', sleepWaiting: 'bool', sleepCheck: 'bool', restoreSleep: 'bool', saveQuote: 'bool', grokFix: 'bool', autoPc: 'bool', autoImg: 'bool', syncCols: 'bool', debugLog: 'bool', diagPersist: 'bool',
  theme: ['system', 'dark', 'light'], memSaver: ['off', 'std', 'max'], globalZoom: [0.3, 3], sleepMinutes: [0, 1440], usageMargin: [0, 50] };
const SET_JA = { notifications: '通知', quietHours: '静音時間', sleepWaiting: '自動スリープ', sleepCheck: 'スリープ中の新着確認', restoreSleep: 'スリープ状態の復元', saveQuote: '引用の保存', grokFix: 'Bot表示の補正', autoPc: 'クラウドPC自動最大化', autoImg: '画像クリックで最大化',
  syncCols: '列幅の同期', debugLog: 'デバッグログ', diagPersist: '診断ログのファイル保存', theme: 'テーマ', memSaver: 'メモリ節約', globalZoom: '全体ズーム', sleepMinutes: 'スリープまでの分', usageMargin: '使用量の余裕%' };
const STORE_STATUS = ['ready', 'recoveryRequired', 'unsupportedVersion'];
function safeEnv(x) {
  const out = { versions: {}, settings: {}, counts: {}, store: null };
  try {
    const v = own(x, 'versions');
    for (const k of ['app', 'electron', 'chrome', 'node', 'os']) { const s = own(v, k); if (typeof s === 'string' && VER_RE.test(s)) out.versions[k] = s; }
    const pf = own(x, 'platform'), ar = own(x, 'arch');
    if (['darwin', 'win32', 'linux'].includes(pf)) out.platform = pf;
    if (['arm64', 'x64', 'ia32'].includes(ar)) out.arch = ar;
    if (typeof own(x, 'packaged') === 'boolean') out.packaged = own(x, 'packaged');
    const s = own(x, 'settings');
    for (const [k, rule] of Object.entries(SETTINGS)) {
      const val = own(s, k);
      if (rule === 'bool' ? typeof val === 'boolean' : typeof rule[0] === 'string' ? rule.includes(val) : typeof val === 'number' && Number.isFinite(val) && val >= rule[0] && val <= rule[1]) out.settings[k] = val;
    }
    const c = own(x, 'counts');
    for (const k of ['windows', 'panes', 'bots', 'sleeping']) { const n = own(c, k); if (intIn(n, 0, 1000)) out.counts[k] = n; }
    const st = own(x, 'store');
    if (STORE_STATUS.includes(own(st, 'status'))) out.store = { status: own(st, 'status'), frozen: own(st, 'frozen') === true, saveError: own(st, 'saveError') ? errCode(own(st, 'saveError')) : '' };
  } catch {}
  return out;
}

const iso = t => { try { return new Date(t).toISOString(); } catch { return '-'; } };
const byEvent = counts => {                              // [[ev, r, n]] -> [[ev, [[r, n] ...]]] in EVENTS order
  const m = new Map(); for (const [ev, r, n] of counts) { if (!m.has(ev)) m.set(ev, []); m.get(ev).push([r, n]); }
  return EV_ORDER.filter(ev => m.has(ev)).map(ev => [ev, m.get(ev)]);
};
const storeJa = s => !s ? '不明' : s.frozen ? '復元済み（再起動待ち）' : s.status === 'recoveryRequired' ? '読み込めないため保存を停止中（復旧待ち）'
  : s.status === 'unsupportedVersion' ? '新しいバージョンの構成のため保存を停止中' : s.saveError ? `保存に失敗（${s.saveError}）` : '正常';
const diskJa = d => !d.on ? 'メモリのみ（最新1000件・終了で消えます）' : `ファイルにも保存（userData/diagnostics${d.forced ? '・MPB_DEBUG' : ''}）`;
function diskSub(d) {
  if (!d.on) return 'ファイル保存は 設定メニュー か この画面 でオンにできます';
  const lim = '上限 2MiB×3ファイル・7日';
  if (d.state === 'fail') return `書込失敗 ${d.code}（${d.failures}回）・書けずに捨てた ${d.dropped}件・監視は続行中・${lim}`;
  if (d.state === 'ok') return `書込 ${d.written}件・最終 ${iso(d.lastWriteAt)}・${lim}`;
  return `準備中・${lim}`;
}

// the diagnostics screen: rows of { sec, label, sub } (overlay.js shows them as they are)
function viewRows({ env, st, disk }) {
  const v = env.versions, s = env.settings, c = env.counts, rows = [];
  rows.push({ sec: 'バージョン', label: [v.app && `アプリ ${v.app}`, v.electron && `Electron ${v.electron}`, v.chrome && `Chromium ${v.chrome}`].filter(Boolean).join('・') || '不明',
    sub: [env.platform, env.arch, v.os, v.node && `Node ${v.node}`, env.packaged === true ? 'パッケージ版' : env.packaged === false ? '開発起動' : ''].filter(Boolean).join(' ') });
  const bools = Object.keys(SETTINGS).filter(k => SETTINGS[k] === 'bool' && Object.hasOwn(s, k));
  rows.push({ sec: '設定', label: 'オン: ' + (bools.filter(k => s[k]).map(k => SET_JA[k]).join('・') || 'なし'), sub: '' });
  rows.push({ sec: '設定', label: 'オフ: ' + (bools.filter(k => !s[k]).map(k => SET_JA[k]).join('・') || 'なし'), sub: '' });
  const vals = Object.keys(SETTINGS).filter(k => SETTINGS[k] !== 'bool' && Object.hasOwn(s, k)).map(k => `${SET_JA[k]} ${s[k]}`);
  if (vals.length) rows.push({ sec: '設定', label: vals.join('・'), sub: '' });
  const sec = '件数（この起動から。会話・名前・URLは記録しません）';
  rows.push({ sec, label: `記録 ${st.total}件（メモリ ${st.size}/${st.max}件）`,
    sub: `ウィンドウ ${c.windows ?? '-'}・ペイン ${c.panes ?? '-'}（Bot ${c.bots ?? '-'}・スリープ中 ${c.sleeping ?? '-'}）・メモリからあふれ ${st.dropped}・UNKNOWN ${st.unknown}・未定義 ${st.rejected}` });
  for (const [ev, list] of byEvent(st.counts)) rows.push({ sec, label: `${EVENTS[ev].ja}（${ev}）`, sub: list.map(([r, n]) => `${r} ${n}`).join('・') });
  rows.push({ sec: '保存状態', label: `構成（panes.json）: ${storeJa(env.store)}`, sub: '' });
  rows.push({ sec: '保存状態', label: `診断ログ: ${diskJa(disk)}`, sub: diskSub(disk) });
  return rows;
}

// the text copied to the clipboard (after the user saw it): the same facts + the last entries, fixed codes and numbers only
function summaryText({ env, st, disk, recent, now, startedAt }) {
  const v = env.versions, s = env.settings, c = env.counts, L = [];
  L.push('MultiPane Browser 診断summary（会話・Bot名・URL・パス・エラー文・入力は含みません）');
  L.push(`作成 ${iso(now)}・起動から ${Math.max(0, Math.round((now - startedAt) / 60000))}分`);
  L.push(`version: app ${v.app || '-'} / Electron ${v.electron || '-'} / Chromium ${v.chrome || '-'} / Node ${v.node || '-'} / ${env.platform || '-'} ${env.arch || '-'} ${v.os || '-'}${env.packaged === true ? ' / packaged' : env.packaged === false ? ' / dev' : ''}`);
  L.push('設定: ' + (Object.keys(SETTINGS).filter(k => Object.hasOwn(s, k)).map(k => `${k}=${typeof s[k] === 'boolean' ? (s[k] ? 'on' : 'off') : s[k]}`).join(' ') || '-'));
  L.push(`ペイン: window=${c.windows ?? '-'} panes=${c.panes ?? '-'} bots=${c.bots ?? '-'} sleeping=${c.sleeping ?? '-'}`);
  L.push(`構成の保存: ${env.store ? `${env.store.status}${env.store.frozen ? ' frozen' : ''}${env.store.saveError ? ` saveError=${env.store.saveError}` : ''}` : '-'}`);
  L.push(`診断ログ: total=${st.total} memory=${st.size}/${st.max} overflow=${st.dropped} unknown=${st.unknown} rejected=${st.rejected}`);
  L.push(`ファイル保存: ${disk.on ? `on${disk.forced ? ' (MPB_DEBUG)' : ''} state=${disk.state}${disk.code ? ` code=${disk.code}` : ''} written=${disk.written} failures=${disk.failures} dropped=${disk.dropped}${disk.lastWriteAt ? ` last=${iso(disk.lastWriteAt)}` : ''}` : 'off'}`);
  L.push('件数:');
  for (const [ev, list] of byEvent(st.counts)) L.push(`  ${ev} ${list.map(([r, n]) => `${r}=${n}`).join(' ')}`);
  L.push(`直近${recent.length}件（時刻 event result ms 試行 pane）:`);
  for (const e of recent) L.push(`  ${iso(e.t)} ${e.ev} ${e.r}${e.ms !== undefined ? ` ms=${e.ms}` : ''}${e.n !== undefined ? ` n=${e.n}` : ''}${e.p !== undefined ? ` p=${e.p}` : ''}`);
  return L.join('\n');
}

// ---- the log ----
// rec(event, result, { ms, n, p }, every?) never throws. `every` (ms): count every call, but keep (memory / disk) at most one entry per
// event + result + pane in that time (a page repeating the same thing cannot push everything else out of the ring).
// setDisk(absoluteDir | null, forced): start / stop writing files (stopping never deletes anything). flushNow(): write pending lines now.
function createDiag({ fs = realFs, wall = Date.now, mono = hrMs, timers = { set: setTimeout, clear: clearTimeout }, ringMax = RING_MAX, queueMax = QUEUE_MAX,
  flushMs = FLUSH_MS, fileMax = FILE_MAX, gens = GENERATIONS, maxAge = MAX_AGE_MS, retryMs = RETRY_MS, retryMaxMs = RETRY_MAX_MS } = {}) {
  const clock = createClock(wall, mono), ring = createRing(ringMax), startedAt = clock();
  const counts = new Map(), lastKept = new Map();
  let total = 0, rejected = 0, unknown = 0, pushed = 0, queuedUpTo = 0;
  const disk = { dir: null, forced: false, state: 'off', code: '', failures: 0, streak: 0, written: 0, dropped: 0, lastWriteAt: 0 };
  let queue = [], timer = null, busy = false, retryAt = 0, dirReady = false;

  function rec(ev, r, f, every) {
    try {
      const t = clock(), e = sanitize(ev, r, f, t);
      if (!e) { rejected++; return false; }
      total++; if (e.r === 'UNKNOWN') unknown++;
      const k = `${e.ev} ${e.r}`; counts.set(k, (counts.get(k) || 0) + 1);
      if (every > 0) {
        const key = `${k} ${e.p || 0}`, last = lastKept.get(key);
        if (last !== undefined && t - last < every) return true;
        if (lastKept.size > 5000) lastKept.clear();
        lastKept.set(key, t);
      }
      ring.push(e); pushed++;
      if (disk.dir) enqueue(e);
      return true;
    } catch { return false; }
  }
  function enqueue(e) {
    queue.push(JSON.stringify(e)); queuedUpTo = pushed;
    while (queue.length > queueMax) { queue.shift(); disk.dropped++; }
    schedule();
  }
  function schedule() {
    if (timer || !disk.dir || !queue.length) return;
    try {
      timer = timers.set(() => { timer = null; flushNow().catch(() => {}); }, Math.max(flushMs, retryAt - wall()));
      if (timer && typeof timer.unref === 'function') timer.unref();          // never keeps the app alive
    } catch { timer = null; }
  }
  async function writeBatch(dir, text) {
    const P = fs.promises;
    if (!dirReady) { await P.mkdir(dir, { recursive: true, mode: 0o700 }); await P.chmod(dir, 0o700); dirReady = true; }
    const files = [];
    for (const name of await P.readdir(dir)) {
      if (!FILE_RE.test(name)) continue;
      try { const s = await P.lstat(path.join(dir, name)); if (s.isFile()) files.push({ name, size: s.size, mtimeMs: s.mtimeMs }); } catch {}
    }
    const plan = planRotation({ files, now: wall(), incoming: Buffer.byteLength(text), fileMax, gens, maxAge });
    for (const n of plan.unlink) await P.unlink(path.join(dir, n)).catch(() => {});
    for (const [a, b] of plan.rename) await P.rename(path.join(dir, a), path.join(dir, b));
    const fh = await P.open(path.join(dir, plan.target), APPEND, 0o600);
    try { await fh.writeFile(text, 'utf8'); } finally { await fh.close().catch(() => {}); }
  }
  async function flushNow() {
    if (busy || !disk.dir || !queue.length) return false;
    busy = true;
    const dir = disk.dir, batch = queue.splice(0, BATCH_MAX);
    try {
      await writeBatch(dir, batch.join('\n') + '\n');
      disk.written += batch.length; disk.lastWriteAt = clock();
      if (dir === disk.dir) { disk.state = 'ok'; disk.code = ''; }
      if (disk.streak) { disk.streak = 0; retryAt = 0; rec('diag.disk', 'RECOVERED'); }
      return true;
    } catch (e) {
      disk.dropped += batch.length; disk.failures++; dirReady = false;
      if (dir === disk.dir) {
        disk.code = errCode(e); disk.state = 'fail';
        retryAt = wall() + Math.min(retryMaxMs, retryMs * 2 ** Math.min(10, disk.streak));
        if (!disk.streak++) rec('diag.disk', disk.code);                  // once per failure streak: a failing disk never fills the log with itself
      }
      return false;
    } finally { busy = false; schedule(); }
  }
  function setDisk(dir, forced = false) {
    try {
      const d = typeof dir === 'string' && path.isAbsolute(dir) ? dir : null;
      disk.forced = !!d && !!forced;
      if (d === disk.dir) return;
      const was = !!disk.dir;
      disk.dir = d; dirReady = false; disk.streak = 0; disk.code = ''; retryAt = 0;
      if (timer) { try { timers.clear(timer); } catch {} timer = null; }
      if (!d) { queue = []; disk.state = 'off'; if (was) rec('diag.disk', 'OFF'); return; }
      disk.state = 'starting';
      const kept = ring.list(), first = pushed - kept.length;               // what happened before it was switched on (not written yet) goes first
      queue = kept.filter((e, i) => first + i >= queuedUpTo).slice(-queueMax).map(e => JSON.stringify(e)); queuedUpTo = pushed;
      rec('diag.disk', 'ON');
      schedule();
    } catch {}
  }
  const stats = () => ({ total, size: ring.size, max: ring.max, dropped: ring.dropped, unknown, rejected,
    counts: [...counts].map(([k, n]) => [...k.split(' '), n]) });
  const diskInfo = () => ({ on: !!disk.dir, forced: disk.forced, state: disk.state, code: disk.code, failures: disk.failures, written: disk.written, dropped: disk.dropped, queued: queue.length, lastWriteAt: disk.lastWriteAt });
  function view(env) {
    try { return { rows: viewRows({ env: safeEnv(env), st: stats(), disk: diskInfo() }), persist: own(own(env, 'settings'), 'diagPersist') === true, forced: disk.forced }; }
    catch { return { rows: [{ sec: '診断', label: '表示できません', sub: '' }], persist: false, forced: false }; }
  }
  function summary(env) {
    try { return summaryText({ env: safeEnv(env), st: stats(), disk: diskInfo(), recent: ring.list().slice(-SUMMARY_RECENT), now: clock(), startedAt }); }
    catch { return 'MultiPane Browser 診断summary: 作成できませんでした'; }
  }
  return { rec, setDisk, flushNow, entries: () => ring.list().map(e => ({ ...e })), stats, diskInfo, view, summary };
}

module.exports = { RING_MAX, FILE_MAX, GENERATIONS, MAX_AGE_MS, MS_MAX, N_MAX, PANE_MAX, QUEUE_MAX, BATCH_MAX, EVENTS, FS_CODES, NET_CODES, GONE_CODES, IPC_CODES, DOM_CODES, GEN_CODES, GUARD_AUTO_CODES, GUARD_EXPIRE_CODES, LOAD_CODES, NAV_CODES, PERM_CODES, ZOOM_CODES, NOTIFY_CODES, REOPEN_CODES, BCAST_CODES, RECOVER_CODES, RESTORE_CODES, QUEUE_CODES, PANE_NAV_CODES, GBAR_CODES, SETTINGS,
  errCode, netCode, goneCode, sanitize, createRing, createClock, planRotation, safeEnv, viewRows, summaryText, createDiag };
