// node test/usage-web.test.js — 使用量表示のWeb読み取り (src/usage-web.js): a usage page's visible text -> numbers only where the page says the
// number and what it is ('N% used / left', 使用 / 残り), its window from the heading words and its reset from a 'Resets …' line; no number ->
// null (never estimated). Synthetic page texts (the real pages after sign-in were not seen), the reset time forms, where the hidden window
// ended up (page / sign-in / moved), the fixed read script and the fixed links. Not covered: the real pages' DOM - manual check.
const vm = require('vm');
const U = require('../src/usage-web');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const NOW = new Date(2026, 9, 22, 10, 0, 0).getTime();       // local time, like the pages
const MIN = 60000, H = 60 * MIN, D = 24 * H;
const pick = (b, ...k) => b && b.map(x => Object.fromEntries(k.map(f => [f, x[f]])));

// ---- no number unless the page says what it is ----
t('nothing / not text -> null', [undefined, null, '', 5, {}, 'Usage\nSettings'].every(x => U.parse(x, NOW) === null));
t('a bare percentage (no used / left anywhere near) -> null', [ 'Weekly limit\n45%', 'Current session\n45 %\nResets in 2 hr', '5-hour limit: 45%', '45%' ].every(x => U.parse(x, NOW) === null));
t('promotions / other percentages -> null', ['Get 50% more usage with Max', 'Save 20% when billed yearly (used by teams)', '使用量が80%以上になると通知', 'Upgrade: up to 5x more, 20% off'].every(x => U.parse(x, NOW) === null));
t('over 100% -> null (not clamped into a number)', U.parse('Weekly\n150% used', NOW) === null && U.parse('Weekly\n100% used', NOW)[0].used === 100);
t('"used" in a sentence without a number -> null', U.parse("You haven't used Opus yet\nWeekly limits", NOW) === null);

// ---- Claude-like page (claude.ai/settings/usage: session + weekly + a model-only weekly) ----
{ const text = ['Settings', 'Usage', 'Plan usage limits', 'Current session', 'Resets in 4 hr 23 min', '12% used', 'Weekly limits', 'Learn more about usage limits',
    'All models', 'Resets Thu 10:59 AM', '34% used', 'Opus only', "You haven't used Opus yet", '0% used', 'Last updated: less than a minute ago'].join('\n');
  const b = U.parse(text, NOW);
  t('Claude-like: three readings in page order', b && b.length === 3);
  t('Claude-like: current session = セッション (not claimed as 5 hours), used 12, reset in 4 h 23 min', J(pick([b[0]], 'id', 'label', 'used', 'resetAt', 'resetText', 'five', 'weekly', 'main')) === J([{ id: 'five', label: 'セッション', used: 12, resetAt: NOW + 4 * H + 23 * MIN, resetText: 'Resets in 4 hr 23 min', five: true, weekly: false, main: true }]));
  t('Claude-like: all models weekly = 1週間 used 34; a weekday reset is kept as text (no date guessed)', J(pick([b[1]], 'id', 'label', 'used', 'resetAt', 'resetText', 'weekly', 'main')) === J([{ id: 'week', label: '1週間', used: 34, resetAt: null, resetText: 'Resets Thu 10:59 AM', weekly: true, main: true }]));
  t('Claude-like: Opus only = a model limit under the weekly heading, not main; no reset of its own', J(pick([b[2]], 'id', 'label', 'used', 'resetText', 'weekly', 'main')) === J([{ id: 'opus-week', label: 'Opus 1週間', used: 0, resetText: '', weekly: false, main: false }])); }

// ---- Codex-like page (left / remaining, reset on the next line or the same line, a model limit) ----
{ const text = ['Codex', 'Usage', '5 hour usage limit', '85% left', 'Resets 3:42 PM', 'Weekly usage limit', '60% remaining · Resets in 2 days 4 hours', 'GPT-5-Codex-Mini limit', '95% left'].join('\n');
  const b = U.parse(text, NOW);
  t('Codex-like: "left" / "remaining" turned into used (100 - left)', J(b.map(x => [x.id, x.used])) === J([['five', 15], ['week', 40], ['GPT-5-Codex-Mini-week'.toLowerCase(), 5]]));
  t('Codex-like: 5 hour heading = 5時間; its reset on the line below it', b[0].label === '5時間' && b[0].five && b[0].resetText === 'Resets 3:42 PM' && b[0].resetAt === null);
  t('Codex-like: a reset on the number\'s own line: from the keyword on, relative time converted', b[1].resetText === 'Resets in 2 days 4 hours' && b[1].resetAt === NOW + 2 * D + 4 * H && b[1].weekly);
  t('Codex-like: a GPT model limit keeps the page\'s spelling, not main', b[2].label === 'GPT-5-Codex-Mini 1週間' && !b[2].main && !b[2].weekly); }

// ---- Japanese page ----
{ const text = ['使用量', '現在のセッション', '12% 使用済み', 'あと 3 時間 10 分でリセット', '週間制限', 'すべてのモデル', '残り 70%', 'リセット: 2026/10/30 9:00'].join('\n');
  const b = U.parse(text, NOW);
  t('Japanese: 使用済み / 残り read, windows from セッション / 週', J(b.map(x => [x.id, x.label, x.used])) === J([['five', 'セッション', 12], ['week', '1週間', 30]]));
  t('Japanese: a reset line after the number belongs to it; the next block does not take it', b[0].resetText === 'あと 3 時間 10 分でリセット' && b[0].resetAt === NOW + 3 * H + 10 * MIN
    && b[1].resetText === 'リセット: 2026/10/30 9:00' && b[1].resetAt === new Date(2026, 9, 30, 9, 0).getTime()); }

// ---- Kimi-like page (monthly credits left + next refresh) ----
{ const b = U.parse(['Subscription', 'Moderato', 'Monthly credits', 'Remaining 85%', 'Next refresh: 2026-11-01 08:00', 'Manage plan'].join('\n'), NOW);
  t('Kimi-like: monthly credits remaining 85% -> 月間クレジット used 15, refresh time', J(pick(b, 'id', 'label', 'used', 'resetAt', 'main')) === J([{ id: 'month-credit', label: '月間クレジット', used: 15, resetAt: new Date(2026, 10, 1, 8, 0).getTime(), main: true }]));
  const zh = U.parse(['会员订阅', '本月额度', '剩余 40%', '重置时间 2026-11-01 00:00'].join('\n'), NOW);
  t('Kimi-like (Chinese): 剩余 = left, 本月 = month, 重置 = reset', zh && zh[0].used === 60 && zh[0].label === '月間クレジット' && zh[0].resetAt === new Date(2026, 10, 1).getTime()); }

// ---- layout details ----
{ const one = U.parse('Weekly limit\n12% used · 88% left', NOW);
  t('"12% used · 88% left" on one line: one reading (the same number twice)', one.length === 1 && one[0].used === 12);
  const two = U.parse('Weekly limit\n12% used · 30% left', NOW);
  t('two different numbers for one window: kept apart (id #2), none dropped silently', two.length === 2 && two[0].id === 'week' && two[1].id === 'week#2' && two[1].used === 70);
  t('a bare number with a short label line next to it', U.parse('Weekly limit\nUsed\n45%', NOW)[0].used === 45 && U.parse('Weekly limit\n45%\nremaining', NOW)[0].used === 55 && U.parse('5-hour limit\n残り\n45%', NOW)[0].used === 55);
  t('a long sentence next to a bare number is no label', U.parse('Weekly limit\nThis is how much you have used so far this week\n45%', NOW) === null);
  t('"Last updated 5 hours ago" is no 5-hour heading', U.parse('Weekly\nLast updated 5 hours ago\n40% used', NOW)[0].id === 'week');
  t('"resets in 5 hr" on the number\'s line is no 5-hour heading', U.parse('Weekly limits\n45% used, resets in 5 hr', NOW)[0].id === 'week');
  t('no heading word: label 制限 (no window claimed)', J(pick(U.parse('Plan\n30% used', NOW), 'id', 'label', 'five', 'weekly', 'main')) === J([{ id: 'limit', label: '制限', five: false, weekly: false, main: true }]));
  t('decimals (12.5% / 12,5 %) kept to 0.1', U.parse('Weekly\n12.5% used', NOW)[0].used === 12.5 && U.parse('Weekly\n12,5 % used', NOW)[0].used === 12.5 && U.parse('Weekly\n33.33% left', NOW)[0].used === 66.7);
  t('a longer number is never read by its tail', U.parse('Weekly\n1050% used', NOW) === null && U.parse('Weekly\n2.150% used', NOW) === null && U.parse('Weekly\n1,234% used', NOW) === null);
  t('full-width digits / ％, NBSP / full-width spaces / zero-width spaces in the text', U.parse('週間\n使用済み　４5％', NOW)[0].used === 45 &&U.parse('Weekly limit\n45 % used', NOW)[0].used === 45
    && U.parse('Weekly limit\n4' + String.fromCharCode(0x200b) + '5% used', NOW)[0].used === 45 && U.parse('週間制限\n使用済み 45％', NOW)[0].used === 45);
  t('a far direction word (over 24 characters away) is not taken', U.parse('Weekly\n45% of something rather long here then used', NOW) === null); }

// ---- reset times ----
{ const r = s => U.resetAt(s, NOW);
  t('relative English forms', r('Resets in 4 hr 23 min') === NOW + 4 * H + 23 * MIN && r('in 3h 12m') === NOW + 3 * H + 12 * MIN && r('Resets in 2 days') === NOW + 2 * D && r('renews in 45 minutes') === NOW + 45 * MIN && r('in 1 day, 2 hours and 5 minutes') === NOW + D + 2 * H + 5 * MIN);
  t('relative times are rounded to the minute', U.resetAt('in 1 min', NOW + 20000) === NOW + 60000);
  t('weekday / month names / months -> null (shown as text)', [r('Resets Thu 10:59 AM'), r('Resets Oct 28, 3:00 PM'), r('Resets in 2 months'), r('Resets soon'), r('')].every(x => x === null));
  t('absolute dates (local time)', r('2026-11-01 08:00') === new Date(2026, 10, 1, 8, 0).getTime() && r('2026/11/1') === new Date(2026, 10, 1).getTime() && r('次回: 2026年11月1日 9時05') === new Date(2026, 10, 1, 9, 5).getTime());
  t('impossible dates -> null', [r('2026-02-31'), r('2026-13-01'), r('2026-11-01 25:00')].every(x => x === null));
  t('Japanese relative forms; a month-day date is no relative day', r('あと2日3時間') === NOW + 2 * D + 3 * H && r('10分後にリセット') === NOW + 10 * MIN && r('11月1日までにリセット') === null && r('毎月1日') === null); }

// ---- where the hidden window ended up ----
{ const W = U.PROV.claude.pages[0], ps = (k, href, w = U.PROV[k].pages[0]) => U.pageState(k, w, href);
  t('claude: the usage page (also with a query / sub path) -> PAGE', ps('claude', W) === 'PAGE' && ps('claude', W + '?tab=1') === 'PAGE' && ps('claude', W + '/details') === 'PAGE');
  t('claude: its sign-in / another site -> AUTH', ['https://claude.ai/login?returnTo=%2Fsettings%2Fusage', 'https://accounts.google.com/o/oauth2/auth', 'https://claude.ai.evil.example/settings/usage', 'https://user:pw@claude.ai/settings/usage', 'https://claude.ai/sso/x'].every(h => ps('claude', h) === 'AUTH'));
  t('claude: another page of the site -> MOVED (a prefix is not the page)', ps('claude', 'https://claude.ai/new') === 'MOVED' && ps('claude', W + '-old') === 'MOVED');
  t('loading / error pages -> UNKNOWN', ['about:blank', 'chrome-error://chromewebdata/', '', 'not a url', 'http://claude.ai/settings/usage'].every(h => ps('claude', h) === 'UNKNOWN'));
  t('codex: chatgpt.com/auth/login and auth.openai.com -> AUTH; chatgpt.com/ -> MOVED', ps('codex', 'https://chatgpt.com/auth/login') === 'AUTH' && ps('codex', 'https://auth.openai.com/log-in') === 'AUTH' && ps('codex', 'https://chatgpt.com/') === 'MOVED' && ps('codex', 'https://chatgpt.com/codex/settings/usage') === 'PAGE');
  t('kimi: www / bare host both count', ps('kimi', 'https://www.kimi.com/membership/subscription') === 'PAGE' && ps('kimi', 'https://kimi.com/membership/subscription') === 'PAGE');
  t('unknown provider -> UNKNOWN', U.pageState('grok', 'https://grok.com/', 'https://grok.com/') === 'UNKNOWN' && U.pageState('__proto__', W, W) === 'UNKNOWN'); }

// ---- the table, the fixed links, the read script ----
t('PROV: codex / claude / kimi, each its own persist:usage-<kind> partition, https pages on its own hosts', ['codex', 'claude', 'kimi'].every(k => U.PROV[k].partition === 'persist:usage-' + k
  && U.PROV[k].pages.length >= 1 && U.PROV[k].pages.every(p => { const u = new URL(p); return u.protocol === 'https:' && U.PROV[k].hosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h)); })) && J(Object.keys(U.PROV).sort()) === J(['claude', 'codex', 'kimi']));
t('the usage pages asked for (2026-10)', U.PROV.claude.pages[0] === 'https://claude.ai/settings/usage' && U.PROV.codex.pages[0] === 'https://chatgpt.com/codex/settings/usage' && U.PROV.kimi.pages[0] === 'https://www.kimi.com/membership/subscription');
t('links: fixed https URLs per provider (Antigravity: its plans page); anything else -> ""', U.link('antigravity') === 'https://antigravity.google/docs/plans/' && U.link('claude') === U.PROV.claude.pages[0]
  && ['grok', '', '__proto__', 'constructor', 'toString', undefined].every(k => U.link(k) === '') && Object.values(U.LINKS).every(u => new URL(u).protocol === 'https:'));
{ const doc = { readyState: 'complete', body: { innerText: 'Weekly limits\n12% used\n' + 'x'.repeat(U.TEXT_MAX) } };
  const o = vm.runInNewContext(U.READ_JS, { document: doc, location: { href: 'https://claude.ai/settings/usage' } });
  t('READ_JS: where / ready / visible text (cut to TEXT_MAX), nothing else', J(Object.keys(o)) === J(['href', 'ready', 'text']) && o.href === 'https://claude.ai/settings/usage' && o.ready === 'complete' && o.text.length === U.TEXT_MAX && U.parse(o.text, NOW)[0].used === 12);
  t('READ_JS: no body yet -> empty text', vm.runInNewContext(U.READ_JS, { document: { readyState: 'loading', body: null }, location: { href: 'about:blank' } }).text === '');
  t('READ_JS: reads only (no fetch / storage / cookies / eval / clicks)', !/fetch|XMLHttpRequest|cookie|Storage|indexedDB|eval|Function|click|postMessage|import\(/.test(U.READ_JS)); }
t('combine: several pages -> one list, ids kept apart; nothing -> null', J(U.combine([[{ id: 'month-credit', used: 1 }], null, [{ id: 'month-credit', used: 2 }, { id: 'five', used: 3 }]]).map(b => b.id)) === J(['month-credit', 'month-credit#2', 'five']) && U.combine([null, []]) === null);
t('notes: a Japanese reason per code; no number in them', ['PAGE', 'AUTH', 'MOVED', 'TIMEOUT', 'BUSY', 'ABORT', 'ERROR'].every(k => /[぀-ヿ一-鿿]/.test(U.NOTE[k]) && !/\d/.test(U.NOTE[k])) && U.NOTE.PAGE === '接続済み・数値を読めません');
t('the reader\'s isolated world is its own (1001-1005 are taken)', U.WORLD === 1006 && U.WORLD !== require('../src/grok-bots').WORLD && U.WORLD !== require('../src/copy-policy').WORLD);

// ---- never a number that the text does not state: shuffled lines of number-free / direction-free text stay null ----
{ let seed = 7; const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const parts = ['Weekly limits', 'Current session', 'Resets in 2 hr', '45%', '5-hour', 'Plan: Max', 'Opus only', 'Usage', '7 days', '残量', 'Monthly credits', '100%', '20% off', 'Get 50% more usage'];
  let ok = true;
  for (let n = 0; n < 300; n++) { const lines = Array.from({ length: 2 + rnd(8) }, () => parts[rnd(parts.length)]); const b = U.parse(lines.join('\n'), NOW);
    const labelled = lines.some((l, i) => /^\d+%$/.test(l) && (lines[i - 1] === '残量' || lines[i + 1] === '残量'));
    if (b && !labelled) { ok = false; console.log('   unexpected:', J(lines), J(b)); break; } }
  t('300 random layouts of words without used / left next to a number: no number (except a bare N% beside a 残量 label)', ok); }

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
