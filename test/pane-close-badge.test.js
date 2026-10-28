// node test/pane-close-badge.test.js — source contracts and actual renderer handlers, with a stub DOM (no Electron).
const fs = require('fs'), path = require('path'), vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const renderer = read('src/renderer.js'), css = read('src/style.css'), html = read('src/index.html');
const main = read('src/main.js'), preload = read('src/preload.js');
let bad = 0; const t = (name, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name); };

const mkStart = renderer.indexOf('function mk(id) {'), mkEnd = renderer.indexOf('\nfunction startEdit', mkStart);
const mk = renderer.slice(mkStart, mkEnd);
const head = (mk.match(/<div class="head" draggable="true">([\s\S]*?)\n  <\/div>/) || [])[1] || '';
const tools = (head.match(/<div class="tools">([\s\S]*?)<\/div>/) || [])[1] || '';
const badgeMarkup = '<button type="button" class="badge" draggable="false" aria-label="閉じる" data-tip="閉じる" data-tip-desc="このペインを閉じます。"></button>';
t('renderer is loaded by the existing HTML without a new module', /<script src="renderer\.js"><\/script>/.test(html));
t('the accessible, non-draggable badge is the last header item after tools', head.includes(badgeMarkup)
  && head.indexOf(badgeMarkup) > head.indexOf('<div class="tools">') && head.trim().endsWith(badgeMarkup));
t('the old duplicate close button and its selector are gone', !!tools && !/data-a=["']close["']/.test(tools)
  && !/data-a\s*=\s*["']?close/.test(renderer) && !/\.tools\s+button\.x/.test(css));
t('click and mouse-down stop propagation, and a badge drag is prevented', /badge\.onclick = e => \{ e\.stopPropagation\(\); mpb\.close\(id\); \}/.test(mk)
  && /badge\.onmousedown = e => \{[^\n]*e\.preventDefault\(\); e\.stopPropagation\(\);/.test(mk)
  && /badge\.ondragstart = e => \{ e\.preventDefault\(\); e\.stopPropagation\(\); \}/.test(mk));
t('the same preload, IPC, guarded close and shortcut paths remain in place', /close: id => send\('close', id\)/.test(preload)
  && /on\('close', id => askClose\(id\)\)/.test(main) && /function askClose\(id\)[\s\S]*?guardRun\('CLOSE'/.test(main)
  && /if \(k === 'w' && !input\.shift\) \{ if \(fp\) askClose\(\);/.test(main));

// Pull declarations from the real stylesheet rather than guessing the computed state of a CSS-only hover.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({ selectors: selectors.split(',').map(s => s.trim()), body }));
const rule = (selector, declaration) => rules.some(r => r.selectors.includes(selector) && declaration.test(r.body));
t('the badge has a fixed non-shrinking slot for empty, count and hover states', rule('.head .badge', /width:30px;min-width:30px;height:22px/)
  && rule('.badge', /flex:none/) && !rules.some(r => r.selectors.some(s => /\.badge:empty/.test(s)) && /display\s*:\s*none/.test(r.body)));
t('empty slot is transparent, and header hover reveals the close glyph in that slot', rule('.head .badge:empty', /background:transparent/)
  && rule('.head:hover .badge:empty::after', /content:"✕"/) && rule('.head .badge:hover::after', /content:"✕"/));
t('badge hover and keyboard focus replace the count with a red close control', rule('.head .badge:hover', /background:#ff453a;.*font-size:0/)
  && rule('.head .badge:focus-visible', /background:#ff453a;.*font-size:0/) && rule('.head .badge:focus-visible::after', /content:"✕"/));
t('stale state does not dim the exposed close control', rule('.pane.stale .head:hover .badge:empty', /opacity:1/)
  && rule('.pane.stale .badge:hover', /opacity:1/) && rule('.pane.stale .badge:focus-visible', /opacity:1/));
t('title, metadata and tools can shrink without pushing the fixed close slot away', rule('.head', /display:flex/)
  && rule('.titlebox', /flex:1;min-width:0;.*overflow:hidden/) && rule('.title', /min-width:0;overflow:hidden/)
  && rule('.meta', /flex:0 1 auto;min-width:0;overflow:hidden/) && rule('.tools', /flex:0 1 auto;min-width:0;overflow:hidden/));
t('quiet, wait, work, done, unopened and stale styles are retained', ['.badge.quiet', '.badge.wait', '.badge.work', '.badge.done', '.badge.unop', '.pane.stale .badge']
  .every(s => rules.some(r => r.selectors.includes(s))));

function element() {
  const classes = new Set(); let content = '';
  return { dataset: {}, hovered: false, focused: false, style: {}, setAttribute() {},
    get textContent() { return content; }, set textContent(v) { content = String(v); },
    classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)),
      contains: x => classes.has(x), toggle: (x, on) => on ? classes.add(x) : classes.delete(x) },
    matches: () => false, closest: () => null,
  };
}
function setup(mod = '⌘') {
  const calls = { close: [], focus: [], max: [], half: [], dock: [], payloads: [], animations: [] };
  const nodes = Object.fromEntries(['.head', '.url', '.title', '.badge', '.sleepph', '.gpr', '.loadph', '.pbl', '.pbr', '[data-a=maximize]'].map(s => [s, element()]));
  const badge = nodes['.badge'], header = nodes['.head'], pane = element(), body = element();
  nodes['[data-a=maximize]'].animate = (frames, opts) => { calls.animations.push({ frames, opts }); return { cancel() {} }; };
  badge.closest = s => (s === '.badge' || s === 'button,input') ? badge : null;
  badge.matches = s => s === ':hover, :focus' && (badge.hovered || badge.focused);
  header.closest = () => null;
  pane.querySelector = s => nodes[s]; pane.querySelectorAll = () => []; pane.addEventListener = () => {};
  const document = { createElement: () => pane, body, querySelectorAll: () => [] };
  const context = vm.createContext({ document, MOD: mod, root: { appendChild: () => {} }, els: new Map(), esc: String,
    GbarLongPress: require('../src/gbar-long-press'),
    mpb: { close: id => calls.close.push(id), focusPane: id => calls.focus.push(id), maximize: id => calls.max.push(id), maximizeHalf: (id, side) => calls.half.push([id, side]) },
    requestAnimationFrame: () => {}, dockStart: id => calls.dock.push(['start', id]), dockStop: () => calls.dock.push(['stop']) });
  const titleFn = renderer.slice(renderer.indexOf('function badgeTitle('), renderer.indexOf('\n', renderer.indexOf('function badgeTitle(')));
  const updateStart = renderer.indexOf("    const b = d.querySelector('.badge');"), updateEnd = renderer.indexOf("    d.querySelector('[data-a=back]')", updateStart);
  const update = renderer.slice(updateStart, updateEnd);
  const tipHelpers = renderer.slice(renderer.indexOf('function setTip('), renderer.indexOf("for (const [id, key]"));
  vm.runInContext(tipHelpers + titleFn + '\n' + mk + '\nfunction updateBadge(d, p) {\n' + update + '\n}', context);
  context.mk(42);
  return { calls, nodes, pane, body, context, badge, header, update: p => context.updateBadge(pane, { unread: 0, glow: false, isGrok: false, ...p }) };
}
{
  const { nodes, calls, header } = setup();
  const button = nodes['[data-a=maximize]'];
  const e = (at, extra = {}) => ({ ...event(button, calls), button: 0, detail: 1, pointerId: 1, clientX: 0, clientY: 0, timeStamp: at, ...extra });
  let down = e(0); button.onpointerdown(down); button.onmousedown(down); button.onpointerup(e(100)); button.onclick(e(100));
  t('maximize short left press selects left half and shows the same hold feedback', JSON.stringify(calls.half) === '[[42,"left"]]' && calls.animations[0].opts.duration === 500);
  button.onpointerdown(e(200)); button.onpointerup(e(701)); const longClick = e(701); button.onclick(longClick);
  t('maximize long press selects full once and suppresses the subsequent click', JSON.stringify(calls.max) === '[42]' && calls.half.length === 1 && longClick.prevented && longClick.stopped);
  const right = e(800, { button: 2 }); button.onpointerdown(right); button.oncontextmenu(right);
  t('maximize right click selects right half and prevents and stops contextmenu', right.prevented && right.stopped && JSON.stringify(calls.half) === '[[42,"left"],[42,"right"]]');
  const trailing = e(801); button.onclick(trailing);
  t('a trailing click after contextmenu cannot also select left', trailing.prevented && trailing.stopped && calls.half.length === 2);
  button.onpointerdown(e(900)); button.onpointermove(e(920, { clientX: 7 })); button.onpointerup(e(1500, { clientX: 7 })); const moved = e(1500); button.onclick(moved);
  t('moving more than 6px cancels the hold and its click', moved.prevented && calls.max.length === 1 && calls.half.length === 2);
  down = e(1600); button.onpointerdown(down); button.onmousedown(down); const drag = event(header, calls); header.ondragstart(drag);
  t('maximize button press cannot start a retargeted header dock drag', drag.prevented && !calls.dock.length);
}
function event(target, calls) {
  return { target, stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; },
    dataTransfer: { setData: (type, value) => calls.payloads.push([type, value]), effectAllowed: '' } };
}
for (const mod of ['⌘', 'Ctrl+']) {
  const { badge, update } = setup(mod);
  update({});
  t(mod + ' zero count: blank slot keeps the existing update tooltip', badge.textContent === '' && badge.dataset.tip === '更新回数' && badge.dataset.tipDetail === '更新回数: 0');
  update({ unread: 8, isGrok: true, glow: true, waiting: true });
  t(mod + ' count and marker: unread value, original tooltip and color class', badge.textContent === '8'
    && badge.dataset.tip === '自分の最後の送信以降に届いたBotのメッセージ数' && badge.dataset.tipDetail.endsWith(': 8') && badge.classList.contains('wait') && !badge.classList.contains('quiet'));
  badge.hovered = true; badge.onmouseenter();
  update({ unread: 100, isGrok: false, working: true });
  t(mod + ' hover survives a state update: capped count and close tooltip', badge.textContent === '99+' && badge.dataset.tip === '閉じる' && badge.dataset.tipKey === `${mod}W` && badge.dataset.tipDetail === '更新回数: 100'
    && badge.classList.contains('work') && badge.classList.contains('quiet') && !badge.classList.contains('wait'));
  badge.hovered = false; badge.onmouseleave();
  t(mod + ' leaving restores the latest original tooltip', badge.dataset.tip === '更新回数');
  badge.focused = true; badge.onfocus();
  t(mod + ' keyboard focus uses the close tooltip', badge.dataset.tip === '閉じる' && badge.dataset.tipKey === `${mod}W`);
  badge.focused = false; badge.onblur();
  t(mod + ' blur restores the original tooltip', badge.dataset.tip === '更新回数');
}
{
  const { badge, header, body, calls, update } = setup();
  update({ unread: 0 });
  let e = event(badge, calls); badge.onmousedown(e);
  t('badge mousedown neither focuses the pane nor bubbles or starts the native drag', e.prevented && e.stopped && !calls.focus.length);
  e = event(badge, calls); badge.onclick(e);
  t('empty badge click closes exactly its pane and does not bubble', e.stopped && JSON.stringify(calls.close) === '[42]' && !calls.focus.length);
  update({ unread: 8 }); badge.hovered = true; badge.onmouseenter();
  e = event(badge, calls); badge.onclick(e);
  t('count badge click uses the same close path', e.stopped && badge.dataset.tip === '閉じる' && badge.dataset.tipKey === '⌘W' && JSON.stringify(calls.close) === '[42,42]');
  e = event(badge, calls); badge.ondblclick(e); if (!e.stopped) header.ondblclick(e);
  t('badge double-click cannot maximize the pane', e.stopped && !calls.max.length);
  e = event(badge, calls); header.ondblclick(e);
  t('header also ignores a double-click targeted at the badge', !calls.max.length);
  e = event(badge, calls); badge.ondragstart(e);
  t('a drag event on the badge is cancelled and does not bubble', e.prevented && e.stopped && !calls.payloads.length);
  e = event(header, calls); header.ondragstart(e);
  t('a native drag retargeted to the header after badge mousedown is cancelled', e.prevented && !calls.payloads.length && !calls.dock.length && !body.classList.contains('dragging'));
  e = event(header, calls); header.onmousedown(e); header.ondragstart(e);
  t('a subsequent ordinary header drag still focuses and docks the pane', !e.prevented && calls.focus[0] === 42
    && JSON.stringify(calls.payloads) === '[["text/x-mpb-pane","42"]]' && JSON.stringify(calls.dock) === '[["start",42]]' && body.classList.contains('dragging'));
  header.ondragend(); t('ordinary header drag cleanup still runs', !body.classList.contains('dragging') && calls.dock.length === 2);
}
console.log(bad ? `\n${bad} failed` : '\nall passed'); process.exit(bad ? 1 : 0);
