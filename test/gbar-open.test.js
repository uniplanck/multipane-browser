// node test/gbar-open.test.js — run the real Grok-open / menu / newPane functions with side effects stubbed.
// Synthetic URLs and pane entities only. No Electron process, user profile, real DOM or draft-preservation claim.
const fs = require('fs'), path = require('path'), vm = require('vm');
const GB = require('../src/grok-bots');
const main = fs.readFileSync(path.join(__dirname, '..', 'src/main.js'), 'utf8');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
function source(name) {
  const a = main.indexOf('function ' + name + '(');
  if (a < 0) throw Error('missing function ' + name);
  const line = main.indexOf('\n', a);
  return main.slice(a, name === 'openGrokBot' ? line : main.indexOf('\n}', a) + 2);
}
const code = ['newPane', 'openIn', 'openFavorite', 'openGrokBot', 'gbotMenu'].map(source).join('\n');
const b = { id: 'fixture', url: 'https://grok.com/bot/fixture', name: 'Fixture group', group: true };
function setup(n = 1, opt = {}) {
  const box = { adds: [], navs: [], guards: [], focus: [], layouts: [], windows: [], timers: [], copies: [], overlays: [], pushes: 0, changes: 0, allow: true, template: null, added: null };
  const pane = id => ({ id, url: 'https://grok.com/bot/existing', name: '', view: { webContents: { isDestroyed: () => false, focus: () => box.focus.push(id) } } });
  const ctx = vm.createContext({ MAX: 10, panes: Array.from({ length: n }, (_, i) => pane(i + 1)), focused: 0, maximizedId: n ? 1 : null,
    favorites: [], grok: { ...GB.empty(), bots: [b], pins: opt.pinned ? [b.id] : [] }, GB, isMac: true, win: {}, NEWTAB: 'mpb:newtab',
    normalize: u => u, paneStart: u => u, onlyPane: p => () => ctx.panes.filter(q => q === p),
    guardRun: (op, targets, run) => { box.guards.push({ op, targets: targets() }); if (box.allow) run(targets()); },
    navTo: (p, url) => { box.navs.push({ p, url }); p.url = url; },
    addPane: spec => {
      if (ctx.panes.length >= 10) throw Error('addPane reached at limit');
      const p = { ...pane(100 + ctx.panes.length), ...spec }; box.adds.push(spec); box.added = p;
      // Simulate the existing insertion rule choosing an earlier row, rather than assuming the new pane is last.
      if (opt.insertFirst) ctx.panes.unshift(p); else ctx.panes.push(p);
      ctx.focused = ctx.panes.indexOf(p); return p;
    },
    relayout: fit => box.layouts.push(fit), setTimeout: (fn, ms) => { box.timers.push(ms); fn(); },
    focusPane: (i, o) => { ctx.focused = i; box.focus.push({ i, ...o }); }, sendState: () => box.pushes++,
    makeWindow: spec => box.windows.push(spec), Menu: { buildFromTemplate: items => { box.template = items; return { popup: o => { box.popup = o; } }; } },
    clipboard: { writeText: s => box.copies.push(s) }, openOverlay: (...a) => box.overlays.push(a), gbChanged: () => box.changes++,
  });
  vm.runInContext(code, ctx);
  return { box, ctx, open: (where, id = b.id) => ctx.openGrokBot(id, where), menu: () => ctx.gbotMenu(b.id) };
}
{ const { box, ctx, open } = setup(2), old = ctx.panes.slice(); ctx.panes[0].url = b.url; open();
  t('default -> a fresh pane even when the same bot is already open', box.adds.length === 1 && ctx.panes.length === 3 && !old.includes(box.added) && !box.navs.length);
  t('new pane reuses newPane / addPane and layout fitting, unmaximizes and focuses the created view', box.added.url === b.url && box.added.name === b.name && ctx.maximizedId === null && J(box.layouts) === J([true]) && J(box.timers) === J([50]) && box.focus.includes(box.added.id));
  open(); t('repeated default openings create additional panes (no reuse / dedup)', ctx.panes.length === 4 && box.adds.length === 2);
}
{ const { box, ctx, open } = setup(3, { insertFirst: true }), last = ctx.panes.at(-1); open('new');
  t('existing row placement can insert before the last pane: name applies to the returned pane only', ctx.panes[0] === box.added && box.added.name === b.name && last.name === '');
}
{ const { box, ctx, open } = setup(1); const p = ctx.panes[0]; open('here');
  t('explicit current pane -> guarded navigation, no new pane', box.adds.length === 0 && box.navs.length === 1 && box.navs[0].p === p && box.navs[0].url === b.url && box.guards[0].op === 'NAVIGATE' && box.guards[0].targets[0] === p);
  t('current-pane metadata and focus follow the navigation callback', p.name === b.name && p.favId === 'g:' + b.id && box.focus[0].clear === false);
}
{ const { box, ctx, open } = setup(10), p = ctx.panes[3], last = ctx.panes.at(-1); ctx.focused = 3; open();
  t('MAX: default new request uses the existing focused-pane fallback (no extra pane)', ctx.panes.length === 10 && box.adds.length === 0 && box.navs.length === 1 && box.navs[0].p === p && box.guards[0].targets[0] === p);
  t('MAX: only the navigated focused pane is named; the last pane stays untouched', p.name === b.name && p.favId === 'g:' + b.id && last.name === '' && !last.favId);
}
{ const { box, ctx, open } = setup(10), before = J(ctx.panes.map(p => ({ url: p.url, name: p.name, favId: p.favId }))); box.allow = false; open('new');
  t('MAX: the existing input guard may stop the fallback, with no navigation / naming / focus side effects', box.guards.length === 1 && !box.navs.length && !box.focus.length && before === J(ctx.panes.map(p => ({ url: p.url, name: p.name, favId: p.favId }))));
}
{ const { box, ctx, open } = setup(10); ctx.focused = -1; open();
  t('MAX without a focused pane -> no action, no arbitrary pane renamed', !box.adds.length && !box.navs.length && ctx.panes.every(p => p.name === ''));
}
{ const { box, ctx, open } = setup(0); open('here');
  t('no current pane -> existing new-pane path', ctx.panes.length === 1 && box.adds.length === 1 && box.added.name === b.name);
}
{ const { box, open } = setup(1); open('window');
  t('Shift / separate window keeps existing behavior', box.adds.length === 0 && box.navs.length === 0 && J(box.windows) === J([{ layout: '2x2', panes: [{ url: b.url, name: b.name }] }]));
  open('new', 'missing'); t('stale item id -> no extra action', box.adds.length === 0 && box.windows.length === 1);
}
for (const pinned of [false, true]) {
  const { box, ctx, menu } = setup(2, { pinned }); menu(); const items = box.template;
  const item = label => items.find(x => x.label === label);
  t('menu ' + pinned + ': explicit current pane plus new / window / rename / pin / copy retained', !!item('今のペインで開く') && !!item('新しいペインで開く') && !!item('別ウィンドウで開く') && !!item('名前を変更…') && !!item('URLをコピー') && items.some(x => x.type === 'checkbox' && x.checked === pinned) && box.popup.window === ctx.win);
  t('menu: Cmd+Click hint belongs to current-pane item', item('今のペインで開く').accelerator === 'Cmd+Click' && !item('新しいペインで開く').accelerator);
  item('今のペインで開く').click(); t('menu current action routes to guarded current-pane path', box.navs.length === 1 && !box.adds.length && box.guards.length === 1);
  item('新しいペインで開く').click(); t('menu new action makes a fresh pane', box.adds.length === 1);
  item('別ウィンドウで開く').click(); t('menu separate window action retained', box.windows.length === 1);
  item('名前を変更…').click(); t('menu rename action retained', box.overlays[0][0] === 'gbot-rename');
  item('URLをコピー').click(); t('menu copy action retained', J(box.copies) === J([b.url]));
  items.find(x => x.type === 'checkbox').click(); t('menu pin action still toggles membership', ctx.grok.pins.includes(b.id) === !pinned && box.changes === 1);
}
{ const { box, ctx, menu } = setup(10); menu();
  t('MAX menu: new-pane entry disabled, current-pane entry remains usable', box.template.find(x => x.label === '新しいペインで開く').enabled === false && box.template.find(x => x.label === '今のペインで開く').enabled !== false);
  ctx.isMac = false; menu(); t('non-Mac menu current-pane hint uses supported Alt-click', box.template.find(x => x.label === '今のペインで開く').accelerator === 'Alt+Click');
}
for (const isGroup of [false, true]) {
  const { box, ctx, menu } = setup(3); ctx.grok.bots[0] = { ...b, isGroup }; ctx.focused = 2;
  const target = ctx.panes[2]; menu(); box.template.find(x => x.label === '今のペインで開く').click();
  t((isGroup ? 'group' : 'bot') + ' menu: current action navigates the focused pane (not the first), with the exact item URL',
    box.navs.length === 1 && box.navs[0].p === target && box.navs[0].url === b.url && box.guards[0].targets[0] === target && !box.adds.length);
}
console.log(bad ? bad + ' failed' : 'all passed'); process.exit(bad ? 1 : 0);
