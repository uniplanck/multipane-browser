// node test/instruct-rules.test.js — NaoAIへの指示 (src/instruct-rules.js): the row's fields from the sidebar page (strings only, control characters out,
// each cut to its limit), the instruction (trimmed 1..4000), the webhook setting (https on cursor.com / cursor.sh or a subdomain, a key of 8..500
// visible ASCII), the JSON body (kind / messageId / instruction / task / source / createdAt / createdAtJst), the JST format, the box's Enter / Esc /
// IME decision, what the user is told (never the URL / key), the box / toast rectangles and the drafts kept per tid.
const R = require('../src/instruct-rules');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const HOOK = 'https://hooks.cursor.com/routine';

// ---- the row (request / requestOk / clean) ----
t('limits: tid 60, task 500, bot 40, state 20, memo 500; instruction 4000; key 8..500', J(R.LIMITS) === J({ tid: 60, task: 500, bot: 40, state: 20, memo: 500 }) && R.TEXT_MAX === 4000
  && R.KEY_MIN === 8 && R.KEY_MAX === 500 && J(R.FIELDS) === J(['tid', 'task', 'bot', 'state', 'memo']) && J(R.RESULTS) === J(['open', 'blocked', 'bad']));
t('request: every field as it is when usable; absent ones -> \'\'', J(R.request({ tid: 'T-12', task: 'LP修正', bot: 'Writer', state: '待機', memo: '急ぎ' })) === J({ tid: 'T-12', task: 'LP修正', bot: 'Writer', state: '待機', memo: '急ぎ' })
  && J(R.request({ tid: 'T-1' })) === J({ tid: 'T-1', task: '', bot: '', state: '', memo: '' }));
t('request: each field cut to its limit', (() => { const r = R.request({ tid: 'a'.repeat(61), task: 'b'.repeat(501), bot: 'c'.repeat(41), state: 'd'.repeat(21), memo: 'e'.repeat(9999) });
  return r.tid.length === 60 && r.task.length === 500 && r.bot.length === 40 && r.state.length === 20 && r.memo.length === 500; })());
t('request: control characters (newlines / tabs too) -> one space, folded, trimmed', J(R.request({ tid: ' T\u00001 ', memo: 'a\nb\r\n\tc\u007f\u0085d' })) === J({ tid: 'T 1', task: '', bot: '', state: '', memo: 'a b c d' }));
t('request: bidi / direction marks and lone surrogates are dropped', R.request({ tid: 'T\u202e1\u200f\u2066', task: 'x\ud800y\udc00z' }).tid === 'T1' && R.request({ tid: 'T', task: 'x\ud800y\udc00z' }).task === 'xyz');
t('request: a cut never splits a surrogate pair', (() => { const r = R.request({ tid: 'a'.repeat(59) + '😀' }); return r.tid === 'a'.repeat(59) && R.request({ tid: 'a'.repeat(58) + '😀' }).tid.length === 60; })());
t('request: not usable -> null (no tid / tid empty after cleaning / non-strings / other keys / not an object / too long raw)', [undefined, null, 'T-1', ['T-1'], {}, { tid: '' }, { tid: '  ' }, { tid: '\n\t' },
  { tid: 5 }, { tid: 'T', task: 5 }, { tid: 'T', memo: null }, { tid: 'T', url: 'https://x' }, { tid: 'T', __proto__x: 1 }, { tid: 'x'.repeat(R.RAW_MAX + 1) }, { tid: 'T', memo: 'x'.repeat(R.RAW_MAX + 1) }].every(v => R.request(v) === null));
t('requestOk = the IPC shape (strings up to RAW_MAX, a tid, no other key)', R.requestOk({ tid: 'x', memo: 'y'.repeat(R.RAW_MAX) }) && !R.requestOk({ tid: 'x', memo: 'y'.repeat(R.RAW_MAX + 1) }) && !R.requestOk({ task: 'x' })
  && !R.requestOk({ tid: 'x', extra: '' }) && R.requestOk({ tid: '' }) && R.request({ tid: '' }) === null);
t('request: a hostile toString / getter is never called (only typeof string counts)', (() => { let called = 0; const v = { tid: { toString() { called++; return 'x'; } } }; return R.request(v) === null && called === 0; })());

// ---- the instruction ----
t('instruction: trimmed; line breaks kept (CR LF -> LF); other control characters out', R.instruction('  確認して\r\nください\t ') === '確認して\nください' && R.instruction('a\u0000b\u0007c') === 'abc');
t('instruction: 1..4000 after trimming, else \'\'', R.instruction('x'.repeat(4000)) === 'x'.repeat(4000) && R.instruction(' ' + 'x'.repeat(4000) + ' ') === 'x'.repeat(4000) && R.instruction('x'.repeat(4001)) === ''
  && R.instruction('') === '' && R.instruction(' \n ') === '' && R.instruction(5) === '' && R.instruction(null) === '');

// ---- the webhook setting ----
t('hookUrl: https on cursor.com / cursor.sh or a subdomain -> normalised', R.hookUrl(HOOK) === HOOK && R.hookUrl(' https://cursor.com/x ') === 'https://cursor.com/x' && R.hookUrl('https://a.b.cursor.sh/h?x=1') === 'https://a.b.cursor.sh/h?x=1'
  && R.hookUrl('https://HOOKS.Cursor.COM/routine') === HOOK && R.hookUrl('https://hooks.cursor.com:443/routine') === HOOK);
t('hookUrl: anything else -> \'\' (http, other hosts, look-alikes, user / password, own port, spaces, schemes, junk)', ['http://hooks.cursor.com/routine', 'https://evilcursor.com/x', 'https://cursor.com.evil.example/x',
  'https://cursor.community/x', 'https://cursor.sh.example/', 'https://u:p@hooks.cursor.com/x', 'https://u@hooks.cursor.com/x', 'https://hooks.cursor.com:8443/x', 'https://hooks.cursor.com/a b', 'https://cursor.com./x',
  'javascript:alert(1)', 'file:///etc/hosts', 'wss://hooks.cursor.com/x', 'hooks.cursor.com/x', '', 'https://' + 'a'.repeat(2100) + '.cursor.com/', 'https://hooks.cursor.com/a\nb', 5, null, undefined, {}].every(v => R.hookUrl(v) === ''));
t('hostOk / hookHost: the host only', R.hostOk('cursor.com') && R.hostOk('x.cursor.sh') && !R.hostOk('xcursor.com') && !R.hostOk('cursor.com.x') && !R.hostOk(5) && R.hookHost(HOOK) === 'hooks.cursor.com' && R.hookHost('http://x') === '');
t('hookKey: 8..500 visible ASCII after trimming, else \'\'', R.hookKey('k'.repeat(8)) === 'k'.repeat(8) && R.hookKey(' abc-DEF_123.~+/= ') === 'abc-DEF_123.~+/=' && R.hookKey('k'.repeat(500)) === 'k'.repeat(500)
  && ['k'.repeat(7), 'k'.repeat(501), 'abc def gh', 'abcdefg\n', 'ｋｅｙｋｅｙｋｅｙ', 'キーキーキーキー', '', 12345678, null].every(v => R.hookKey(v) === ''));
t('hookView: { configured, host, available } only - a URL / key handed in never passes', J(R.hookView({ configured: true, host: 'hooks.cursor.com', available: true, url: HOOK, key: 'secret-key' })) === J({ configured: true, host: 'hooks.cursor.com', available: true })
  && J(R.hookView({ configured: true, host: HOOK })) === J({ configured: true, host: '', available: true }) && J(R.hookView({ configured: 'yes', host: 'evil.example' })) === J({ configured: false, host: '', available: true })
  && J(R.hookView(null)) === J({ configured: false, host: '', available: true }) && R.hookView({ available: false }).available === false);

// ---- the body ----
const BYTES = Uint8Array.from({ length: 12 }, (_, i) => i * 21);
t('messageId: \'x_\' + 24 hex of 12 random bytes; fewer bytes -> \'\'', R.messageId(BYTES) === 'x_' + Array.from(BYTES, b => b.toString(16).padStart(2, '0')).join('') && R.ID_RE.test(R.messageId(BYTES))
  && R.messageId(Buffer.alloc(16, 255)) === 'x_' + 'ff'.repeat(12) && R.messageId(new Uint8Array(11)) === '' && R.messageId(null) === '' && R.messageId('abcdefabcdefabcdef') === ''
  && R.messageId(Array(12).fill(256)) === '' && R.messageId(Array(12).fill('a')) === '');
t('hookUrl: a pasted URL\'s surrounding spaces / newline are trimmed', R.hookUrl(' ' + HOOK + '\n') === HOOK);
t('jst: yyyy-MM-dd HH:mm JST (UTC+9; the date moves at 15:00 UTC)', R.jst(new Date('2026-11-01T03:04:05.678Z')) === '2026-11-01 12:04 JST' && R.jst(new Date('2026-11-01T15:00:00Z')) === '2026-11-02 00:00 JST'
  && R.jst(new Date('2026-12-31T14:59:59Z')) === '2026-12-31 23:59 JST' && R.jst(new Date('2026-12-31T15:00:00Z')) === '2027-01-01 00:00 JST' && R.jst(Date.UTC(2024, 1, 28, 15)) === '2024-02-29 00:00 JST');
t('jst: no time -> \'\'', [NaN, 'now', null, undefined, new Date('x'), {}].every(v => R.jst(v) === ''));
{ const now = new Date('2026-11-01T03:04:05.678Z'), id = R.messageId(BYTES), task = { tid: 'T-12', task: 'LP修正', bot: 'Writer', state: '待機', memo: '急ぎ' };
  const p = R.payload({ id, instruction: '  見出しを直して\n画像も  ', task, now });
  t('payload: exactly kind, messageId, instruction, task, source, createdAt, createdAtJst (in that order)', J(Object.keys(p)) === J(['kind', 'messageId', 'instruction', 'task', 'source', 'createdAt', 'createdAtJst']));
  t('payload: the values', p.kind === 'xg-bots-instruction' && p.messageId === id && p.instruction === '見出しを直して\n画像も' && J(p.task) === J(task) && p.source === 'xG-Bots 進捗サイドバー'
    && p.createdAt === '2026-11-01T03:04:05.678Z' && p.createdAtJst === '2026-11-01 12:04 JST');
  t('payload: the task cleaned again, all five keys', J(R.payload({ id, instruction: 'x', task: { tid: 'T\n1', memo: 'a'.repeat(600) }, now }).task) === J({ tid: 'T 1', task: '', bot: '', state: '', memo: 'a'.repeat(500) }));
  t('payload: anything unusable -> null (id, text, task, time)', [{ id: 'x_123', instruction: 'x', task, now }, { id, instruction: ' ', task, now }, { id, instruction: 'x'.repeat(4001), task, now }, { id, instruction: 'x', task: { tid: '' }, now },
    { id, instruction: 'x', task: { tid: 'T', url: HOOK }, now }, { id, instruction: 'x', task, now: 'today' }, { id, instruction: 'x', task, now: new Date('x') }, null].every(v => R.payload(v) === null));
  t('payload: JSON round trip keeps it as it is', J(JSON.parse(J(p))) === J(p)); }

// ---- the box: Enter / Esc / IME ----
const K = (key, o = {}) => R.keyAction({ key, shiftKey: false, altKey: false, repeat: false, isComposing: false, keyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : 65, ...o });
t('keyAction: Enter -> send; ⌘↵ / Ctrl+↵ too', K('Enter') === 'send' && K('Enter', { metaKey: true }) === 'send' && K('Enter', { ctrlKey: true }) === 'send');
t('keyAction: ⇧↵ / ⌥↵ -> newline (the field\'s own)', K('Enter', { shiftKey: true }) === 'newline' && K('Enter', { altKey: true }) === 'newline');
t('keyAction: Esc -> close', K('Escape') === 'close');
t('keyAction: an IME composition never sends / closes (isComposing, keyCode 229, the page\'s own flag)', K('Enter', { isComposing: true }) === 'none' && K('Enter', { keyCode: 229 }) === 'none' && K('Process', { keyCode: 229 }) === 'none'
  && K('Enter', { composing: true }) === 'none' && K('Escape', { isComposing: true }) === 'none' && K('Escape', { keyCode: 229 }) === 'none' && K('Enter', { shiftKey: true, isComposing: true }) === 'none');
t('keyAction: a held Enter / Esc -> ignore (one send at most); other keys -> none', K('Enter', { repeat: true }) === 'ignore' && K('Escape', { repeat: true }) === 'ignore' && K('a') === 'none' && K('Tab') === 'none'
  && R.keyAction(null) === 'none' && R.keyAction({}) === 'none');

// ---- what the user is told ----
t('toastText: sent -> NaoAIに送りました（tid）', R.toastText({ ok: true, status: 200 }, 'T-12') === 'NaoAIに送りました（T-12）' && R.toastText({ ok: true }, 'T\n1') === 'NaoAIに送りました（T 1）' && R.toastText({ ok: true }, '') === 'NaoAIに送りました（-）');
t('toastText: HTTP n / タイムアウト / 未設定 / 通信エラー / 設定を読めません / 入力なし', R.toastText({ ok: false, code: 'HTTP', status: 401 }) === '送れませんでした（HTTP 401）' && R.toastText({ code: 'HTTP', status: 503 }) === '送れませんでした（HTTP 503）'
  && R.toastText({ code: 'TIMEOUT' }) === '送れませんでした（タイムアウト）' && R.toastText({ code: 'UNSET' }) === 'NaoAIのwebhookが未設定です' && R.toastText({ code: 'NETWORK' }) === '送れませんでした（通信エラー）'
  && R.toastText({ code: 'READ' }) === '送れませんでした（保存した設定を読めません）' && R.toastText({ code: 'TEXT' }) === '指示を入力してください（4000文字まで）');
t('toastText: unknown / junk -> 送れませんでした（エラー）; a bad status is not shown', R.toastText({ code: 'HTTP', status: 'x' }) === '送れませんでした（エラー）' && R.toastText({ code: 'toString' }) === '送れませんでした（エラー）'
  && R.toastText(null) === '送れませんでした（エラー）' && R.toastText({ code: 'HTTP', status: 1e6 }) === '送れませんでした（エラー）');
t('toastText: never the URL / key / an error\'s text, whatever the answer carries', ['ok', 'HTTP', 'TIMEOUT', 'NETWORK', 'UNSET', 'READ', 'X'].every(code => { const s = R.toastText({ ok: code === 'ok', code, status: 500, url: HOOK, key: 'secret-key-1', message: 'ECONNREFUSED ' + HOOK }, 'T');
  return !s.includes('cursor') && !s.includes('secret') && !s.includes('ECONN'); }));
t('toastKind: ok / warn (未設定・入力なし) / err', R.toastKind({ ok: true }) === 'ok' && R.toastKind({ code: 'UNSET' }) === 'warn' && R.toastKind({ code: 'TEXT' }) === 'warn' && R.toastKind({ code: 'HTTP', status: 500 }) === 'err' && R.toastKind(null) === 'err');

// ---- geometry / drafts ----
t('boxRect: centred, 720 x 380 at most, 12 px from the edges', J(R.boxRect(1400, 900)) === J({ x: 340, y: 260, width: 720, height: 380 }) && J(R.boxRect(600, 400)) === J({ x: 12, y: 12, width: 576, height: 376 })
  && J(R.boxRect(10, 10)) === J({ x: 5, y: 5, width: 0, height: 0 }));
t('toastRect: bottom centre, 480 wide at most', J(R.toastRect(1400, 900)) === J({ x: 460, y: 812, width: 480, height: 64 }) && J(R.toastRect(400, 300)) === J({ x: 16, y: 212, width: 368, height: 64 }));
{ const m = new Map();
  R.draftSet(m, 'T-1', 'a'); R.draftSet(m, 'T-2', 'b'); R.draftSet(m, 'T-1', 'a2');
  t('draftSet: per tid, the newest last', J([...m]) === J([['T-2', 'b'], ['T-1', 'a2']]));
  R.draftSet(m, 'T-2', '  '); R.draftSet(m, 'T-1', '');
  t('draftSet: empty / spaces only -> none', m.size === 0);
  for (let i = 0; i < R.DRAFTS_MAX + 5; i++) R.draftSet(m, 'T' + i, 'x');
  t('draftSet: at most DRAFTS_MAX (the oldest go)', m.size === R.DRAFTS_MAX && !m.has('T0') && m.has('T' + (R.DRAFTS_MAX + 4)));
  R.draftSet(m, 'T9', 'y'.repeat(5000)); R.draftSet(m, '', 'x'); R.draftSet(null, 'a', 'b');
  t('draftSet: a draft is cut to TEXT_MAX; no tid / no map: nothing', m.get('T9').length === R.TEXT_MAX && !m.has('')); }
t('nothing personal in the rules: no URL but the hosts rule, no UUID, no key', !/https?:\/\/[^\s'"`]*cursor/.test(require('fs').readFileSync(require.resolve('../src/instruct-rules'), 'utf8'))
  && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(require('fs').readFileSync(require.resolve('../src/instruct-rules'), 'utf8')));

// ---- 待ちの回答 (mode answer): the row's wait prompt / options, a choice button's label and the body ----
{ const id = 'x_' + '1'.repeat(24), now = new Date('2026-11-11T07:00:00.000Z');
  const ROW = { tid: 'T1', task: '仕事', bot: 'NaoAI', state: '待ち', memo: 'x', mode: 'answer', ask: 'どれにしますか', options: ['案A', '案B', '案C'] };
  const P = o => R.payload({ id, task: ROW, now, mode: 'answer', ...o });
  const BASE = ['kind', 'messageId', 'instruction', 'task', 'source', 'createdAt', 'createdAtJst', 'mode'];
  const r = R.request({ tid: 'T1', task: '仕事', mode: 'answer', ask: '  どちら？  ', options: [' 案A ', '', '案B', '案A'] });
  t('request: mode answer + ask + options are kept and cleaned (no empties / duplicates); unknown keys / modes still refused', r.mode === 'answer' && r.ask === 'どちら？' && J(r.options) === J(['案A', '案B'])
    && R.request({ tid: 'T1', extra: 'x' }) === null && R.request({ tid: 'T1', mode: 'instruct' }) === null && R.request({ tid: 'T1', mode: 'batch' }) === null && R.request({ tid: 'T1', tasks: [] }) === null);
  t('choiceOf: the label as the row keeps it when it is one of the row\'s options, else \'\'', R.choiceOf('案B', ROW.options) === '案B' && R.choiceOf(' 案B\n', ROW.options) === '案B'
    && R.choiceOf('案Z', ROW.options) === '' && R.choiceOf('', ROW.options) === '' && R.choiceOf(['案A'], ROW.options) === '' && R.choiceOf(5, ROW.options) === '' && R.choiceOf(undefined, ROW.options) === ''
    && R.choiceOf('案A', []) === '' && R.choiceOf('案A', undefined) === '' && (() => { const o = R.request({ tid: 'T', options: ['y'.repeat(100)] }).options; return R.choiceOf('y'.repeat(100), o) === o[0] && o[0].length === 80; })());
  t('no multi-pick left: no choices / CHOICE_SEP / choicesOk / choicesOf', !('choicesOk' in R) && !('choicesOf' in R) && !('CHOICE_SEP' in R));
  let p = P({ instruction: '', choice: '案B' });
  t('payload: a choice button, nothing typed -> choice = label, instruction = label, no choices key', p.choice === '案B' && p.instruction === '案B' && !('choices' in p)
    && J(Object.keys(p)) === J([...BASE, 'choice']));
  p = P({ instruction: ' 急ぎで ', choice: '案A' });
  t('payload: a choice button + a typed text -> instruction = the text, choice = label', p.instruction === '急ぎで' && p.choice === '案A');
  p = P({ instruction: '自由に書きます' });
  const w = R.payload({ id, instruction: '返事です', task: { tid: 'T2', task: '待ち', mode: 'answer' }, now, mode: 'answer' });
  t('payload: text only (no button / a wait with no options) -> no choice', p.instruction === '自由に書きます' && !('choice' in p) && J(Object.keys(p)) === J(BASE)
    && w.instruction === '返事です' && !('choice' in w));
  p = P({ instruction: 'メモ', choice: '案Z' });
  t('payload: a label not on the row never appears; only such a label and no text -> null (nothing to send)', !('choice' in p) && !J(p).includes('案Z') && p.instruction === 'メモ'
    && P({ instruction: '', choice: '案Z' }) === null && P({ instruction: '' }) === null && P({ instruction: '', choices: ['案A', '案B'] }) === null);
  p = P({ instruction: '', choice: '案A', choices: ['案B', '案C'] });
  t('payload: a choices array is not read any more (the button\'s one label only)', p.choice === '案A' && !('choices' in p) && p.instruction === '案A');
  t('payload: answer mode: kind as before, task { tid, task } only', p.kind === 'xg-bots-instruction' && p.mode === 'answer' && J(p.task) === J({ tid: 'T1', task: '仕事' }));
  const n = R.payload({ id, instruction: '普通', task: ROW, now, choice: '案A' });
  t('payload: not an answer -> the row as before, the label ignored, nothing of mode / choice', n.instruction === '普通' && !('mode' in n) && !('choice' in n)
    && J(Object.keys(n.task)) === J(['tid', 'task', 'bot', 'state', 'memo']) && R.payload({ id, instruction: '', task: ROW, now, choice: '案A' }) === null);
  t('keyAction: an IME composition still never sends (answer box too)', K('Enter', { isComposing: true }) === 'none' && K('Enter', { keyCode: 229 }) === 'none' && K('Enter', { composing: true }) === 'none'); }

// ---- 一括 (mode batch): the rows selected on the page (one Bot) -> one body ----
{ const id = 'x_' + '2'.repeat(24), now = new Date('2026-11-12T03:00:00.000Z');
  const A = { tid: 'N_1', task: '確認: ロゴ案', bot: 'NaoAI', state: '待ち', memo: 'm' }, B = { tid: 'N_2', task: '確認: 公開日', bot: 'NaoAI', state: '待ち', memo: '' }, C = { tid: 'N_3', task: '', bot: 'NaoAI', state: '作業中' };
  const X = { tid: 'K_1', task: '別のBot', bot: 'Kimiマン', state: '待ち' };
  t('limits: BATCH_MAX 20 rows; titles one per line', R.BATCH_MAX === 20 && R.TITLE_SEP === '\n');
  t('batchOk = the IPC shape: { tasks } only, 1..20 rows of the five fields (strings up to RAW_MAX, a tid)', R.batchOk({ tasks: [A] }) && R.batchOk({ tasks: [A, B, C] }) && R.batchOk({ tasks: Array(20).fill(A) })
    && R.batchOk({ tasks: [A, X] }) && [undefined, null, [], {}, { tasks: [] }, { tasks: Array(21).fill(A) }, { tasks: A }, { tasks: [A], bot: 'NaoAI' }, { tasks: [A], text: 'x' }, { tasks: [{ ...A, mode: 'answer' }] },
      { tasks: [{ ...A, options: ['x'] }] }, { tasks: [{ ...A, url: 'https://x' }] }, { tasks: [{ task: 'x' }] }, { tasks: [{ tid: 5 }] }, { tasks: [{ ...A, memo: 'x'.repeat(R.RAW_MAX + 1) }] }, { tasks: [null] }, { tasks: [[A]] }, { tasks: ['N_1'] }]
      .every(v => !R.batchOk(v)) && !R.requestOk({ tasks: [A] }) && !R.batchOk(A));
  let b = R.batch({ tasks: [B, A, { ...B, task: '同じtid' }, { tid: ' \n ', bot: 'NaoAI' }, C] });
  t('batch: each row cleaned (request()), the page\'s order kept, a tid once, rows with no tid left dropped; bot = theirs', b && b.bot === 'NaoAI' && J(b.tasks.map(x => x.tid)) === J(['N_2', 'N_1', 'N_3'])
    && J(b.tasks[1]) === J(R.request(A)) && b.tasks[0].task === '確認: 公開日');
  t('batch: two Bots -> null (never mixed); nothing usable -> null', R.batch({ tasks: [A, X] }) === null && R.batch({ tasks: [A, { ...B, bot: 'NaoAI ' }, { ...B, tid: 'N_9', bot: 'naoai' }] }) === null
    && R.batch({ tasks: [{ tid: '  ', bot: 'NaoAI' }] }) === null && R.batch(null) === null && R.batch({ tasks: [A, { ...X, tid: '\n' }] }) !== null);
  t('batch: the same name after cleaning is the same Bot', R.batch({ tasks: [A, { ...B, bot: ' NaoAI\n' }] }).tasks.length === 2);
  t('batchKey: one per Bot, never a tid (a cleaned tid has no line break)', R.batchKey('NaoAI') === 'batch\nNaoAI' && R.batchKey('NaoAI') !== R.batchKey('Kimiマン') && R.batchKey(5) === 'batch\n'
    && !R.request({ tid: R.batchKey('NaoAI') }).tid.includes('\n'));
  const BB = ['kind', 'messageId', 'instruction', 'tasks', 'bot', 'source', 'createdAt', 'createdAtJst', 'mode'];
  let p = R.payload({ id, instruction: '  まとめて把握しました\n残りは別タスクで  ', now, mode: 'batch', tasks: [B, A] });
  t('payload batch: kind as before, mode batch, tasks [{ tid, task }] in the page\'s order, bot, no task key, the typed text', J(Object.keys(p)) === J(BB) && p.kind === 'xg-bots-instruction' && p.mode === 'batch'
    && J(p.tasks) === J([{ tid: 'N_2', task: '確認: 公開日' }, { tid: 'N_1', task: '確認: ロゴ案' }]) && p.bot === 'NaoAI' && !('task' in p) && !('choice' in p)
    && p.instruction === 'まとめて把握しました\n残りは別タスクで' && p.source === 'xG-Bots 進捗サイドバー' && p.createdAtJst === '2026-11-12 12:00 JST' && J(JSON.parse(J(p))) === J(p));
  p = R.payload({ id, instruction: ' ', now, mode: 'batch', tasks: [A, B, C] });
  t('payload batch: nothing typed -> instruction = the titles one per line (a row without one: its tid)', p.instruction === '確認: ロゴ案\n確認: 公開日\nN_3' && p.tasks.length === 3);
  p = R.payload({ id, instruction: '', now, mode: 'batch', tasks: [A] });
  t('payload batch: one row is still a batch (never mode answer, no task key)', p.mode === 'batch' && J(p.tasks) === J([{ tid: 'N_1', task: '確認: ロゴ案' }]) && !('task' in p));
  { const many = Array.from({ length: 20 }, (_, i) => ({ tid: 'M_' + i, task: String(i % 10).repeat(500), bot: 'NaoAI' })), q = R.payload({ id, instruction: '', now, mode: 'batch', tasks: many });
    t('payload batch: the titles fallback keeps whole lines within TEXT_MAX; tasks still carry all 20', q.instruction.length <= R.TEXT_MAX && q.instruction.split('\n').length === 7
      && q.instruction.split('\n').every(l => l.length === 500) && q.tasks.length === 20); }
  t('payload batch: mixed Bots / none usable / a bad id or time / too many -> null (nothing sent)', [{ tasks: [A, X] }, { tasks: [] }, { tasks: [{ tid: ' ' }] }, { tasks: Array.from({ length: 21 }, (_, i) => ({ ...A, tid: 'Z' + i })) },
    { tasks: [A], id: 'x_1' }, { tasks: [A], now: 'today' }, { tasks: [{ ...A, mode: 'answer' }] }, { tasks: A }].every(o => R.payload({ id, instruction: 'x', now, mode: 'batch', ...o }) === null));
  t('payload batch: a task key alone is not a batch; mode batch never reads task', R.payload({ id, instruction: 'x', now, mode: 'batch', task: A }) === null
    && R.payload({ id, instruction: 'x', now, mode: 'batch', task: X, tasks: [A] }).bot === 'NaoAI');
  t('payload: never "answer" for several tids; a single row\'s answer unchanged', R.payload({ id, instruction: 'x', now, mode: 'answer', tasks: [A, B] }) === null
    && R.payload({ id, instruction: 'x', now, mode: 'answer', task: { ...A, mode: 'answer' } }).mode === 'answer'); }

console.log(bad ? `${bad} failed` : 'all passed');
process.exit(bad ? 1 : 0);
