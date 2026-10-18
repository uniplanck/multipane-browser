// node test/session-snapshot.test.js   (pure: no fs / electron; #22 sleep state across a restart)
const SS = require('../src/session-snapshot');
const S = require('../src/state-schema');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const MIN = 60000, DAY = 86400000;
const NOW = new Date(2026, 9, 19, 15, 30).getTime();          // local time: the labels are local
const BOT = 'https://grok.com/bot/abc';
const ON = { enabled: true, ready: true };
const snap = (o = {}) => ({ v: 1, at: NOW - 10 * MIN, sl: true, mk: 'WAIT', ob: NOW - 40 * MIN, nm: 'Bot', gp: 'Room', ...o });
const spec = (o = {}, s = snap()) => ({ url: BOT, name: '', sleep: true, ...o, snap: s });

// ---- make: what a sleeping pane writes ----
{
  const m = SS.make({ sleeping: true, mk: 'WAIT', ob: NOW - 5 * MIN, nm: '  Bot\n name ', gp: 'Room', q: 'please do X' }, NOW);
  t('asleep -> { v, at, sl, mk, ob, nm, gp } (names on one line)', J(m) === J({ v: 1, at: NOW, sl: true, mk: 'WAIT', ob: NOW - 5 * MIN, nm: 'Bot name', gp: 'Room' }));
  t('the quote is not saved by default', !('q' in m));
  t('quote on: saved for a 🟢 pane, at most 300 characters', SS.make({ sleeping: true, mk: 'WAIT', ob: NOW, q: 'x'.repeat(500) }, NOW, { quote: true }).q.length === SS.QUOTE_MAX && SS.QUOTE_MAX === 300);
  t('quote on: not for 🟣 / 🔴 / unmarked panes', ['DONE', 'WORK', ''].every(mk => !('q' in SS.make({ sleeping: true, mk, ob: NOW, q: 'quote' }, NOW, { quote: true }))));
  t('quote on, but no quote: no field', !('q' in SS.make({ sleeping: true, mk: 'WAIT', ob: NOW, q: '  ' }, NOW, { quote: true })));
  t('awake / no info / bad clock -> no snap', [SS.make({ sleeping: false, mk: 'WAIT' }, NOW), SS.make(null, NOW), SS.make({ sleeping: true }, NaN), SS.make({ sleeping: true }, 0)].every(x => x === null));
  t('unknown marker -> "", a seen time after now -> 0 (unknown)', SS.make({ sleeping: true, mk: 'GREEN', ob: NOW + 1 }, NOW).mk === '' && SS.make({ sleeping: true, mk: 'WAIT', ob: NOW + 1 }, NOW).ob === 0);
  const long = SS.make({ sleeping: true, mk: 'DONE', ob: NOW, nm: 'n'.repeat(200), gp: 'g'.repeat(200) }, NOW);
  t('names cut to the placeholder limit (80)', long.nm.length === SS.NAME_MAX && long.gp.length === SS.NAME_MAX && SS.NAME_MAX === 80);
  t('no draft / attachment / count / unread / URL ever in it', Object.keys(SS.make({ sleeping: true, mk: 'WAIT', ob: NOW, hasDraft: true, draft: 'secret', unread: 3, url: BOT, token: 't' }, NOW, { quote: true }))
    .every(k => ['v', 'at', 'sl', 'mk', 'ob', 'nm', 'gp', 'q'].includes(k)));
  t('markOf: 🔴 > 🟢 > 🟣 > none', SS.markOf({ working: true, waiting: true }) === 'WORK' && SS.markOf({ waiting: true }) === 'WAIT' && SS.markOf({ done: true }) === 'DONE' && SS.markOf({}) === '' && SS.markOf(null) === '');
}

// ---- clean: what is read back ----
{
  const s = snap({ q: 'q' });
  t('a clean snap stays the same', SS.same(SS.clean(s), s));
  t('round trip: make -> clean is unchanged', (m => SS.same(SS.clean(m), m))(SS.make({ sleeping: true, mk: 'WAIT', ob: NOW - MIN, nm: 'a', gp: 'b', q: 'c' }, NOW, { quote: true })));
  t('not an object / array / null -> null', [null, undefined, 'x', 5, [], [snap()]].every(x => SS.clean(x) === null));
  t('a newer snap version -> null (ignored, the pane loads as usual)', SS.clean(snap({ v: 2 })) === null && SS.clean(snap({ v: 99 })) === null);
  t('missing / wrong version, time or asleep flag -> null', [{ v: undefined }, { v: 0 }, { v: '1' }, { v: 1.5 }, { at: undefined }, { at: 0 }, { at: -5 }, { at: 'x' }, { at: Infinity }, { sl: false }, { sl: 'true' }, { sl: undefined }]
    .every(o => SS.clean(snap(o)) === null));
  const r = SS.clean(snap({ mk: 'PURPLE', ob: 'yesterday', nm: 5, gp: { x: 1 }, q: 7, extra: 'drop me', at: NOW + 0.7 }));
  t('wrong values repaired: marker "", seen 0, names "", no quote, unknown fields dropped, time whole ms', J(r) === J({ v: 1, at: Math.floor(NOW + 0.7), sl: true, mk: '', ob: 0, nm: '', gp: '' }));
  t('long text cut: names 80, quote 300', (c => c.nm.length === 80 && c.gp.length === 80 && c.q.length === 300)(SS.clean(snap({ nm: 'x'.repeat(1000), gp: 'y'.repeat(1000), q: 'z'.repeat(5000) }))));
  t('same(): a repaired / reordered-with-extra snap is not the same', !SS.same(SS.clean(snap({ extra: 1 })), snap({ extra: 1 })) && !SS.same(SS.clean(snap({ nm: ' a ' })), snap({ nm: ' a ' })));
}

// ---- plan: how a saved pane starts ----
{
  const p = SS.plan(spec(), NOW, ON);
  t('on + ready + saved asleep -> starts asleep with name / group / marker / seen time (未再確認)', p && p.age === 'fresh' && p.mk === 'WAIT' && p.nm === 'Bot' && p.gp === 'Room' && p.ob === NOW - 40 * MIN && p.seen === false);
  t('setting off (default) -> loads as usual', SS.plan(spec(), NOW, {}) === null && SS.plan(spec(), NOW, { ready: true }) === null && SS.plan(spec(), NOW, { enabled: 'yes', ready: true }) === null);
  t('store not ready (recoveryRequired / unsupportedVersion / frozen) -> loads as usual', SS.plan(spec(), NOW, { enabled: true, ready: false }) === null);
  t('no snap / broken / newer snap -> loads as usual', [{ url: BOT, sleep: true }, spec({}, null), spec({}, 'x'), spec({}, snap({ v: 2 })), spec({}, snap({ at: 0 })), spec({}, snap({ sl: false }))].every(s => SS.plan(s, NOW, ON) === null));
  t('sleep turned off for the pane -> loads as usual', SS.plan(spec({ sleep: false }), NOW, ON) === null);
  t('not a spec / bad clock -> null', SS.plan(null, NOW, ON) === null && SS.plan('x', NOW, ON) === null && SS.plan(spec(), NaN, ON) === null);
  const old = SS.plan(spec({}, snap({ at: NOW - 8 * DAY, ob: NOW - 8 * DAY - MIN })), NOW, ON);
  t('marker seen more than 7 days ago: asleep with its name, no marker / time / quote (old)', old && old.age === 'old' && old.mk === '' && old.ob === 0 && old.q === '' && old.nm === 'Bot');
  t('exactly 7 days is still shown', SS.plan(spec({}, snap({ at: NOW - 7 * DAY, ob: NOW - 7 * DAY })), NOW, ON).age === 'fresh');
  t('seen time unknown (0) -> old', SS.plan(spec({}, snap({ ob: 0 })), NOW, ON).age === 'old');
  const fut = SS.plan(spec({}, snap({ at: NOW + 2 * DAY, ob: NOW + DAY })), NOW, ON);
  t('saved in the future (clock set back): asleep, no marker / time (clock)', fut && fut.age === 'clock' && fut.mk === '' && fut.ob === 0);
  t('seen after it was saved -> clock', SS.plan(spec({}, snap({ ob: NOW - 10 * MIN + SS.SKEW_MS + 1 })), NOW, ON).age === 'clock');
  t('a few minutes of clock difference is tolerated', SS.plan(spec({}, snap({ at: NOW + 5 * MIN, ob: NOW + 4 * MIN })), NOW, ON).age === 'fresh');
  const q = spec({}, snap({ q: 'the request' }));
  t('a saved quote is shown only while 引用も保存 is on', SS.plan(q, NOW, ON).q === '' && SS.plan(q, NOW, { ...ON, quote: true }).q === 'the request');
  t('...and only for a 🟢 marker', SS.plan(spec({}, snap({ mk: 'DONE', q: 'x' })), NOW, { ...ON, quote: true }).q === '');
  t('the plan carries no URL / draft / count', Object.keys(p).every(k => ['age', 'at', 'ob', 'mk', 'nm', 'gp', 'q', 'seen'].includes(k)));
}

// ---- rechecked / label ----
{
  const p = SS.plan(spec(), NOW, ON);
  t('label: 前回 + marker + 未再確認 + seen time (today: hh:mm)', SS.label(p, NOW) === '前回 🟢 待機中・未再確認（14:50 時点）');
  t('label: another day -> M/D hh:mm', SS.label(SS.plan(spec({}, snap({ at: NOW - DAY, ob: NOW - DAY - 30 * MIN })), NOW, ON), NOW) === '前回 🟢 待機中・未再確認（10/18 15:00 時点）');
  t('label: no marker -> 前回の記録', SS.label(SS.plan(spec({}, snap({ mk: '' })), NOW, ON), NOW).startsWith('前回の記録・未再確認（'));
  t('label: 🟣 / 🔴', /^前回 🟣 終了・未再確認/.test(SS.label(SS.plan(spec({}, snap({ mk: 'DONE' })), NOW, ON), NOW)) && /^前回 🔴 作業中・未再確認/.test(SS.label(SS.plan(spec({}, snap({ mk: 'WORK' })), NOW, ON), NOW)));
  t('label: old / clock say why nothing is shown', /7日以上前/.test(SS.label(SS.plan(spec({}, snap({ ob: 0 })), NOW, ON), NOW)) && /時刻が合わない/.test(SS.label(SS.plan(spec({}, snap({ at: NOW + DAY })), NOW, ON), NOW)));
  t('label: none -> ""', SS.label(null, NOW) === '');
  const r = SS.rechecked(p, 'DONE', 'q', NOW + MIN);
  t('rechecked: no longer 前回・未再確認; the marker / time seen now; no quote for 🟣', r.seen && r.mk === 'DONE' && r.ob === NOW + MIN && r.q === '' && SS.label(r, NOW + MIN) === '再確認: 🟣 終了' && r.nm === 'Bot');
  t('rechecked 🟢 keeps the quote it read (cut to 300); unmarked -> マーカーなし', SS.rechecked(p, 'WAIT', 'x'.repeat(400), NOW).q.length === 300 && SS.label(SS.rechecked(p, '', '', NOW), NOW) === '再確認: マーカーなし');
  t('rechecked old / clock -> fresh (seen now)', SS.rechecked(SS.plan(spec({}, snap({ ob: 0 })), NOW, ON), 'WAIT', '', NOW).age === 'fresh');
  t('rechecked(null) -> null', SS.rechecked(null, 'WAIT', '', NOW) === null);
  const back = SS.make({ sleeping: true, mk: r.mk, ob: r.ob, nm: r.nm, gp: r.gp, q: r.q }, NOW + 2 * MIN);
  t('saved again after the restart: the seen time is kept (not the restart time)', back.ob === NOW + MIN && back.at === NOW + 2 * MIN);
  const o = SS.plan(spec({}, snap({ ob: 0 })), NOW, ON), o2 = SS.make({ sleeping: true, mk: o.mk, ob: o.ob, nm: o.nm, gp: o.gp }, NOW);
  t('an old one saved again stays old (no marker, seen unknown)', SS.plan(spec({}, o2), NOW + MIN, ON).age === 'old');
}

// ---- in panes.json (state-schema.js): never fatal, no new schema ----
{
  const A = 'https://a.example/';
  const pane = (url, s) => ({ url, reloadMinutes: 0, name: '', color: 'none', muted: false, zoom: 1, zoomIndiv: false, sleep: true, ...(s === undefined ? {} : { snap: s }) });
  const file = (panes, ws = {}) => ({ schema: 1, windows: [{ layout: '2x2', focused: 0, panes, rows: [panes.length] }], favorites: [], settings: { restoreSleep: true }, workspaces: ws });
  const good = SS.make({ sleeping: true, mk: 'WAIT', ob: NOW - MIN, nm: 'Bot', gp: '' }, NOW);
  const r = S.migrate(file([pane(BOT, good), pane(A)]));
  t('a valid snap: ready, kept as it is, no repair', r.ok && SS.same(r.doc.windows[0].panes[0].snap, good) && r.fixes.length === 0);
  t('round trip keeps it (file still schema 1)', (b => b.ok && J(b.doc) === J(r.doc) && JSON.parse(S.serialize(r.doc)).schema === 1)(S.parse(S.serialize(r.doc))));
  t('legacy fields (= first window) carry it too: older versions ignore an unknown field', JSON.parse(S.serialize(r.doc)).panes[0].snap.v === 1);
  const bads = [null, 'x', 5, [], snap({ v: 2 }), snap({ at: 'x' }), snap({ sl: false })];
  const rb = S.migrate(file(bads.map(s => pane(BOT, s)).slice(0, 7)));
  t('broken / newer / not-asleep snaps: still ready, dropped, repairs named by position only', rb.ok && rb.doc.windows[0].panes.every(s => !('snap' in s)) && rb.fixes.length === bads.length && rb.fixes.every(f => /^windows\[0\]\.panes\[\d\]\.snap: dropped$/.test(f)));
  const rr = S.migrate(file([pane(BOT, snap({ nm: 'n'.repeat(300), mk: '??', extra: 'SECRET-NAME' }))]));
  t('a usable but odd snap: cleaned (limits / values), repair reported without content', rr.ok && rr.doc.windows[0].panes[0].snap.nm.length === 80 && rr.doc.windows[0].panes[0].snap.mk === '' && !('extra' in rr.doc.windows[0].panes[0].snap)
    && J(rr.fixes) === J(['windows[0].panes[0].snap: repaired']));
  const rw = S.migrate(file([pane(BOT)], { w: { layout: '2x2', panes: [pane(BOT, good)], rows: [1] } }));
  t('a workspace never keeps one (dropped, repaired)', rw.ok && !('snap' in rw.doc.workspaces.w.panes[0]) && J(rw.fixes) === J(['workspaces#0.panes[0].snap: dropped']));
  t('future schema with snaps: still unsupportedVersion (never read / written)', S.migrate({ ...file([pane(BOT, good)]), schema: 2 }).status === 'unsupportedVersion');
  t('wrong pane types stay fatal as before (snap does not hide them)', S.migrate(file([{ ...pane(BOT, good), zoom: 'big' }])).status === 'recoveryRequired');
  t('validate(): a snap is never an error (writes are not blocked by it)', S.validate({ ...r.doc, windows: [{ layout: '2x2', panes: [pane(BOT, 'garbage')] }] }).length === 0);
  const legacy = S.migrate({ layout: '2x2', urls: [BOT], panes: [pane(BOT, snap({ v: 9 }))] });
  t('old single-window format: the same repair', legacy.ok && !('snap' in legacy.doc.windows[0].panes[0]) && legacy.fixes.length === 1);
}
console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
