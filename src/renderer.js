const $ = s => document.querySelector(s);
const root = $('#panes'), strip = $('#strip'), els = new Map();
const mac = mpb.platform === 'darwin';
document.body.classList.add(mac ? 'mac' : 'other');
const MOD = mac ? '⌘' : 'Ctrl+';
if (!mac) $('#cmdk kbd').textContent = 'Ctrl+K';
function setTip(el, name, description, key = '', detail = '') {
  el.dataset.tip = String(name || ''); el.dataset.tipDesc = String(description || '');
  el.dataset.tipKey = String(key || ''); el.dataset.tipDetail = String(detail || '');
  el.setAttribute('aria-label', [name, description, detail].filter(Boolean).join('。'));
}
function tipAttrs(name, description, key = '', detail = '') {
  return `data-tip="${esc(name)}" data-tip-desc="${esc(description)}" data-tip-key="${esc(key)}" data-tip-detail="${esc(detail)}" aria-label="${esc([name, description, detail].filter(Boolean).join('。'))}"`;
}
for (const [id, key] of [['unread-sum', 'J'], ['reload-all', '⇧R'], ['reopen', '⇧T'], ['add', 'T'], ['cmdk', 'K']]) {
  document.getElementById(id).dataset.tipKey = MOD + key;
}
const PK = ['2x1', '3x1', '4x1', '2x2', '3x2', '4x2', '3x3', '5x2'];
function layoutIcon(k) {
  const [c, r] = k.split('x').map(Number), W = 16, H = 12, g = 1.5;
  const w = (W - g * (c - 1)) / c, h = (H - g * (r - 1)) / r;
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  for (let y = 0; y < r; y++) for (let x = 0; x < c; x++) s += `<rect x="${x * (w + g)}" y="${y * (h + g)}" width="${w}" height="${h}" rx="1.2"/>`;
  return s + '</svg>';
}
PK.forEach((k, i) => {
  const b = document.createElement('button');
  b.innerHTML = layoutIcon(k) + `<span>${k}</span>`; b.dataset.k = k;
  setTip(b, `レイアウト ${k.replace('x', '×')}`, 'ペインの並べ方を切り替えます。', `${MOD}${i + 1}`);
  b.onclick = () => mpb.layout(k); $('#presets').appendChild(b);
});
$('#add').onclick = () => mpb.add();
$('#reopen').onclick = () => { if (S && S.canReopen) mpb.reopenClosed(); };
$('#reload-all').onclick = () => mpb.reloadAll();
$('#ws-btn').onclick = () => mpb.wsMenu();
$('#cmdk').onclick = () => mpb.palette();
$('#unread-sum').onclick = () => mpb.run({ type: 'next-unread' });
$('#queue-sum').onclick = () => mpb.run({ type: 'queue-open' });   // (#01) 対応キュー in the overlay (opening it marks nothing read)
function approveButtonRect() {
  const { x, y, width, height } = $('#approve-btn').getBoundingClientRect();
  return { x, y, width, height };
}
function renderApproveButton(a) {
  const name = a.label || '右上ボタンのBot';
  $('#approve-label').textContent = a.label;
  $('#approve-label').hidden = !a.label;
  $('#approve-btn').classList.toggle('icon-only', !a.label);
  setTip($('#approve-btn'), name, a.configured ? (a.label ? `${a.label}を別の画面で開きます。` : '設定したBotを別の画面で開きます。') : '右クリックまたはクリックでBotのリンクを設定します。');
}
$('#approve-btn').onclick = () => mpb.approveOpen(approveButtonRect());
$('#approve-btn').oncontextmenu = e => { e.preventDefault(); mpb.approveInline(approveButtonRect()); };
mpb.onApproveAnchorRequest(() => mpb.approveInlineAnchor(approveButtonRect()));
let approveSavedTimer;
mpb.onApproveSaved?.(() => { const b = $('#approve-btn'); b.classList.add('saved'); clearTimeout(approveSavedTimer); approveSavedTimer = setTimeout(() => b.classList.remove('saved'), 1400); });
// panes.json warning (state-store.js): unreadable at start -> recovery list; a save failed -> retry. The panes stay as they are.
$('#save-warn').onclick = () => { const st = (S && S.store) || {}; if (st.status && st.status !== 'ready') mpb.recoveryOpen(); else mpb.saveRetry(); };
// Memory / CPU meters: tabular digits; <1GB -> "333MB", else "1.2GB". IPC carries numbers only.
const memEl = $('#mem'), cpuEl = $('#cpu');
const fmtMem = b => { const mb = b / 1048576; return Math.round(mb) < 1024 ? `${Math.round(mb)}MB` : `${(mb / 1024).toFixed(1)}GB`; };
mpb.onMem(data => {
  const mem = fmtMem(data.bytes), cpu = CpuMeter.formatCpu(data.appCpu, data.macCpu);
  if (memEl.textContent !== mem) memEl.textContent = mem;
  if (cpuEl.textContent !== cpu) cpuEl.textContent = cpu;
  memEl.dataset.tipDetail = `現在: ${mem}`;
  cpuEl.dataset.tipDetail = `現在: ${cpu}。Botsは100%を超えることがあります。取得できない値は -- です。`;
});
// notification chips for panes in other windows (hidden when there is only one window)
const othersEl = $('#others'), othersSep = $('#others-sep');
mpb.onOthers(list => {
  const has = Array.isArray(list) && list.length > 0;
  othersEl.classList.toggle('show', has); othersSep.classList.toggle('show', has);
  if (!has) { othersEl.innerHTML = ''; return; }
  reconcileTooltipMarkup(othersEl, list.map(w => `<span class="owin" data-tip-window="${w.wid}" ${tipAttrs(`ウィンドウ ${w.n}`, '別のウィンドウにあるペインです。')}>${w.n}</span>` + w.panes.map(p => {
    const st = p.unopened ? 'unopened' : p.waiting ? 'waiting' : p.working ? 'working' : p.done ? 'done' : p.glow ? 'glow' : '';
    const ch = (Array.from(String(p.name || '•').trim())[0] || '•').toUpperCase();
    const lab = p.unopened ? '未開封の新着' : p.waiting ? '待機中' : p.working ? '作業中' : p.done ? '終了' : '新着';
    return `<button class="ochip ${st}" data-w="${w.wid}" data-p="${p.id}" ${tipAttrs(p.name || 'ペイン', '別のウィンドウのペインへ移動します。', '', `ウィンドウ ${w.n}・${lab}${p.unread ? ` ${p.unread}件` : ''}`)}>` +
      `<span class="oc">${p.unread ? (p.unread > 99 ? '99' : p.unread) : esc(ch)}</span>${p.waiting ? '<span class="od"></span>' : p.working ? '<span class="od work"></span>' : p.done ? '<span class="od done"></span>' : ''}</button>`;
  }).join('')).join(''));
});
othersEl.onclick = e => { const b = e.target.closest('.ochip'); if (b) mpb.focusOther(Number(b.dataset.w), Number(b.dataset.p)); };
// "saved layout" feedback: the ⧉ button shows a tick for a moment
mpb.onWsSaved(n => { const b = $('#ws-btn'); b.textContent = '✓'; b.classList.add('saved'); setTip(b, 'レイアウトを保存', 'ペインの配置を保存・切り替えます。', '', `「${n}」を保存しました`); setTimeout(() => { b.textContent = '⧉'; b.classList.remove('saved'); setTip(b, 'レイアウト', 'ペインの配置を保存・切り替えます。', '', S?.activeWs ? `現在: ${S.activeWs}` : ''); }, 1400); });
let S = null;
// ---- short labels: max 6 display columns (half-width 1, full-width 2), hard cut, no ellipsis ----
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
function colw(ch) { const c = ch.codePointAt(0); return WIDE.test(ch) || c >= 0x1F300 ? 2 : 1; }
function shortLabel(s, max = 6) {
  let out = '', w = 0;
  for (const ch of String(s || '').trim()) { const cw = colw(ch); if (w + cw > max) break; out += ch; w += cw; }
  return out;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function badgeTitle(b) { const count = `${b.dataset.countTitle || '更新回数'}: ${b.dataset.count || '0'}`; if (b.matches(':hover, :focus')) setTip(b, '閉じる', 'このペインを閉じます。', `${MOD}W`, count); else setTip(b, b.dataset.countTitle || '更新回数', 'ペインの更新状況を表示します。', '', count); b.setAttribute('aria-label', '閉じる'); }

function mk(id) {
  const d = document.createElement('div'); d.className = 'pane entering';
  d.innerHTML = `
  <div class="head" draggable="true">
    <span class="fav"></span>
    <div class="titlebox"><span class="title"></span><input class="url" spellcheck="false" autocomplete="off"></div>
    <span class="meta"></span>
    <div class="tools">
      <button data-a="back" ${tipAttrs('戻る', '前に見たページへ戻ります。', `${MOD}[`)}>‹</button>
      <button data-a="forward" ${tipAttrs('進む', '戻る前のページへ進みます。', `${MOD}]`)}>›</button>
      <button data-a="reload" ${tipAttrs('再読み込み', 'このページを読み込み直します。', `${MOD}R`)}>↻</button>
      <button data-a="maximize" ${tipAttrs('最大化・元に戻す', 'このペインの大きさを切り替えます。', `${MOD}\\`, 'ヘッダーのダブルクリックでも切り替えられます。')}>⤢</button>
      <button data-a="paneMenu" ${tipAttrs('ペインの設定', '名前や色、通知などを設定します。')}>⋯</button>
      <button data-a="sleepToggle" class="slp" ${tipAttrs('自動スリープ', '待機中や終了後のスリープを切り替えます。', '', 'ON')}>💤</button>
    </div>
    <button type="button" class="badge" draggable="false" aria-label="閉じる" data-tip="閉じる" data-tip-desc="このペインを閉じます。"></button>
  </div>
  <div class="sleepph"><div class="sleepid"><div class="sn"></div><div class="sg"></div></div><div class="sleepr"></div><span class="sp1">💤 スリープ中 — クリックで復帰</span><span class="sp2">✉ 未開封の新着メッセージがあります — クリックで開く</span><span class="sp3">⏳ 読み込み待ち<b class="lpn"></b><button class="lqx" ${tipAttrs('読み込みを取消', '読み込み待ちを取り消します。', '', 'スリープは続きます。')}>取消</button></span><blockquote class="sleepq"></blockquote><div class="chk"><span class="chkt"></span><button class="pbx pbl" ${tipAttrs('ログインを確認', 'ペインを開いてログイン状態を確認します。')}>ログインを確認</button><button class="pbx pbr" ${tipAttrs('確認を再開', 'スリープ中の新着確認を再開します。')}>確認を再開</button></div><small>終了（1分後）・待機中（30分後）に休止（メモリ節約）。入力途中の文字やリアルタイム更新は復帰まで失われます</small></div>
  <div class="loadph"><span class="lp1">⏳ 読み込み待ち<b class="lpn"></b></span><span class="lp2">読み込みを取り消しました — クリックで読み込む</span><button class="lqx" ${tipAttrs('読み込みを取消', 'このペインの読み込み待ちを取り消します。')}>取消</button><small>同時に読み込むのは通常4枚まで。順番が来ると自動で読み込みます</small></div>
  <div class="goneph"><span class="gp1">⚠ ページが停止しました</span><button class="pbx gpr" ${tipAttrs('再読み込み', 'このページを読み込み直します。')}>再読み込み</button><span class="gp2">⏳ 読み込み待ち<b class="lpn"></b><button class="lqx" ${tipAttrs('読み込みを取消', 'このペインの読み込み待ちを取り消します。')}>取消</button></span><span class="gp3">再読み込み中…</span><small>このペインのページの処理が止まりました（ほかのペインはそのままです）。自動では再読み込みしません。入力途中の文字・添付は戻らないことがあります</small></div>
  <img class="dockshot" alt="" draggable="false">`;
  const openSleeping = () => { mpb.focusPane(id); mpb.wakePane(id); };   // only this explicit pane click selects; wake-pane itself preserves focus
  d.querySelector('.sleepph').onclick = openSleeping;
  // (#32) the page's renderer is gone: 再読み込み is the pane's usual reload (the input guard and the load queue as ↻)
  d.querySelector('.gpr').onclick = e => { e.stopPropagation(); mpb.reload(id); };
  d.querySelector('.loadph').onclick = () => { if (d.classList.contains('idle')) openSleeping(); };
  // 取消 of a pane waiting for a load slot (placeholder / sleeping placeholder / header): only the wait ends, the click goes nowhere else
  d.addEventListener('click', e => { if (e.target.closest('.lqx')) { e.stopPropagation(); mpb.loadCancel(id); } }, true);
  // (#33) stopped after a sign-in page: ログインを確認 opens this pane (the page shows the sign-in), 確認を再開 only resumes the checks
  d.querySelector('.pbl').onclick = e => { e.stopPropagation(); openSleeping(); };
  d.querySelector('.pbr').onclick = e => { e.stopPropagation(); mpb.probeResume(); };
  d.querySelectorAll('.tools button').forEach(b => b.onclick = e => { e.stopPropagation(); mpb[b.dataset.a](id); });
  const head = d.querySelector('.head'), inp = d.querySelector('.url'), title = d.querySelector('.title'), badge = d.querySelector('.badge');
  // A non-draggable child can still start a drag on its draggable parent; exclude that press from docking too.
  let badgePressed = false;
  badge.onclick = e => { e.stopPropagation(); mpb.close(id); };
  badge.onmousedown = e => { badgePressed = true; e.preventDefault(); e.stopPropagation(); };
  badge.ondblclick = e => e.stopPropagation();
  badge.ondragstart = e => { e.preventDefault(); e.stopPropagation(); };
  badge.onmouseenter = badge.onmouseleave = badge.onfocus = badge.onblur = () => badgeTitle(badge);
  head.onmousedown = e => { badgePressed = false; if (!e.target.closest('button,input')) mpb.focusPane(id); };
  head.ondblclick = e => { if (!e.target.closest('button,input')) mpb.maximize(id); };
  title.onclick = () => startEdit(d);
  inp.onkeydown = e => {
    if (e.key === 'Enter') { mpb.navigate(id, inp.value); inp.blur(); }
    if (e.key === 'Escape') { inp.blur(); }
  };
  inp.onfocus = () => { d.classList.add('editing'); inp.select(); mpb.focusPane(id); };
  inp.onblur = () => d.classList.remove('editing');
  // drag a pane by its header: docking (dockStart below; main decides the zone and the drop). A tab of the strip dropped on a header still swaps
  head.ondragstart = e => { if (badgePressed || e.target.closest('.badge')) { e.preventDefault(); return; } e.dataTransfer.setData('text/x-mpb-pane', String(id)); e.dataTransfer.effectAllowed = 'move'; document.body.classList.add('dragging'); d.classList.add('drag-src'); dockStart(id); };
  head.ondragend = () => { document.body.classList.remove('dragging'); d.classList.remove('drag-src'); document.querySelectorAll('.drop-over').forEach(x => x.classList.remove('drop-over')); dockStop(); };
  const accept = e => !drag && e.dataTransfer.types.includes('text/x-mpb-pane');
  d.ondragover = e => { if (accept(e)) { e.preventDefault(); d.classList.add('drop-over'); } };
  d.ondragleave = () => d.classList.remove('drop-over');
  d.ondrop = e => { if (drag) return; const from = Number(e.dataTransfer.getData('text/x-mpb-pane')); d.classList.remove('drop-over'); if (from && from !== id) mpb.swap(from, id); };
  root.appendChild(d); els.set(id, d);
  requestAnimationFrame(() => requestAnimationFrame(() => d.classList.remove('entering')));
  return d;
}
function startEdit(d) { const inp = d.querySelector('.url'); inp.focus(); }

const copied = new Map();
function flashIcon(c) { const ic = c.querySelector('.cicon'); if (ic) { ic.textContent = '✓'; ic.classList.add('copied'); setTip(ic, 'コピーしました', 'このペインのリンクをコピーしました。'); } }
function chip(p) {
  const c = document.createElement('button');
  c.className = 'chip'; c.dataset.id = p.id;
  c.onmousedown = () => { c._down = Date.now(); c._dragged = false; };
  c.onclick = e => {
    const ic = e.target.closest && e.target.closest('.cicon');
    if (ic && !c._dragged && Date.now() - (c._down || Date.now()) < 450) {      // short press on the icon: copy this pane's link (long press / drag keeps the reorder behaviour)
      mpb.copyPaneUrl(p.id); copied.set(p.id, Date.now() + 1100); flashIcon(c);
      setTimeout(() => { if (S) onS(S); }, 1150);
    }
    mpb.activatePane(p.id);
  };
  c.ondblclick = () => mpb.renamePane(p.id);
  c.oncontextmenu = e => { e.preventDefault(); mpb.chipMenu(p.id); };
  c.draggable = true;
  c.ondragstart = e => { c._dragged = true; e.dataTransfer.setData('text/x-mpb-pane', String(p.id)); };
  c.ondragover = e => { if (e.dataTransfer.types.includes('text/x-mpb-pane')) e.preventDefault(); };
  c.ondrop = e => { const from = Number(e.dataTransfer.getData('text/x-mpb-pane')); if (from && from !== p.id) mpb.swap(from, p.id); };
  return c;
}
function favHtml(p) {
  if (p.favicon) return `<img src="${esc(p.favicon)}" alt="" referrerpolicy="no-referrer">`;
  return `<span class="letter">${esc((p.name || p.title || '?').trim().charAt(0).toUpperCase() || '•')}</span>`;
}

// 上下の幅を同期: short press = ON/OFF, long press (600 ms) = even columns in all rows
const SYNC_ON = '<svg viewBox="0 0 18 16" width="18" height="16"><rect x="1.5" y="1.5" width="6.5" height="5.5" rx="1.4" fill="currentColor"/><rect x="10" y="1.5" width="6.5" height="5.5" rx="1.4" fill="currentColor"/><rect x="1.5" y="9" width="6.5" height="5.5" rx="1.4" fill="currentColor"/><rect x="10" y="9" width="6.5" height="5.5" rx="1.4" fill="currentColor"/></svg>';
const SYNC_OFF = '<svg viewBox="0 0 18 16" width="18" height="16"><rect x="1.5" y="1.5" width="6.5" height="5.5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="10" y="1.5" width="6.5" height="5.5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="9" width="10.5" height="5.5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="14" y="9" width="2.5" height="5.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
const syncEl = $('#sync-cols'); let syncHold = null, syncHeld = false;
function syncBtn(s) {
  const on = s.syncCols !== false;
  syncEl.innerHTML = on ? SYNC_ON : SYNC_OFF;
  syncEl.classList.toggle('on', on && s.canSync); syncEl.classList.toggle('off', !on); syncEl.classList.toggle('na', !s.canSync);
  setTip(syncEl, '上下の幅を同期', '上下のペインの幅をそろえます。', '', s.canSync ? `${on ? 'ON' : 'OFF'}・長押しで均等幅に戻します。` : '2段以上のレイアウトで使えます。');
}
syncEl.onmousedown = () => { syncHeld = false; clearTimeout(syncHold); if (!S || !S.canSync) return; syncHold = setTimeout(() => { syncHeld = true; mpb.syncReset(); syncEl.classList.add('pulse'); setTimeout(() => syncEl.classList.remove('pulse'), 700); }, 600); };
syncEl.onmouseup = syncEl.onmouseleave = () => clearTimeout(syncHold);
syncEl.onclick = () => { if (syncHeld || !S || !S.canSync) return; mpb.syncCols(S.syncCols === false); };
function renderSummaryTips(s) {
  const lists = TooltipList.fromState(s, G);
  $('#unread-sum').dataset.tipList = JSON.stringify(lists.unread);
  $('#queue-sum').dataset.tipList = JSON.stringify(lists.queue);
}
const onS = s => {
  S = s;
  renderFavs(s.favorites || []);
  if (s.approve) renderApproveButton(s.approve);
  document.body.classList.toggle('light', !s.dark);
  document.body.classList.toggle('has-max', s.maximizedId != null);
  $('#presets').querySelectorAll('button').forEach(b => { const active = b.dataset.k === (s.effLayout || s.layout); b.classList.toggle('active', active); b.dataset.tipDetail = active ? '現在のレイアウト' : ''; });
  const glowN = 0, unreadN = s.panes.filter(p => p.needsReply).length;
  const us = $('#unread-sum');
  us.innerHTML = glowN || unreadN ? `<span class="dot"></span>${glowN ? `新着 ${glowN}ペイン` : `未返信 ${unreadN}`}<kbd>${MOD}J</kbd>` : '';
  us.dataset.tipDetail = `未返信 ${unreadN}ペイン`;
  us.classList.toggle('show', !!(glowN || unreadN));
  { const q = s.queue || [], qs = $('#queue-sum'), n = {};   // (#01) 対応 n: main's list (要返信 → 未確認の新着 → 観測異常 → 待機); the dot = its first kind
    q.forEach(it => { n[it.kja] = (n[it.kja] || 0) + 1; });
    qs.innerHTML = q.length ? `<span class="dot"></span>対応 ${q.length}` : '';
    qs.dataset.k = q.length ? q[0].kind : '';
    qs.dataset.tipDetail = q.length ? `${q.length}件・${Object.entries(n).map(([k, c]) => `${k} ${c}`).join('・')}` : '';
    qs.classList.toggle('show', q.length > 0); }
  renderSummaryTips(s);
  $('#add').disabled = s.panes.length >= s.max;
  $('#reopen').disabled = !s.canReopen; $('#reopen').style.opacity = s.canReopen ? '' : '.4';
  { const w = $('#save-warn'), st = s.store || {}, rec = !!st.status && st.status !== 'ready';
    w.classList.toggle('show', rec || !!st.saveError);
    w.textContent = rec ? '⚠ 構成を復旧' : '⚠ 保存できません';
    setTip(w, rec ? '構成を復旧' : '保存できません', rec ? '保存した構成の復旧方法を選びます。' : '構成の保存を再試行します。', '', rec ? '読み込めないため自動保存を停止中です。' : `前回の保存は残っています。${st.saveError || ''}`); }
  { const wb = $('#ws-btn'); if (!wb.classList.contains('saved')) setTip(wb, 'レイアウト', 'ペインの配置を保存・切り替えます。', '', s.activeWs ? `現在: ${s.activeWs}` : ''); wb.classList.toggle('active-ws', !!s.activeWs); }

  // strip
  const ids = s.panes.map(p => p.id);
  [...strip.children].forEach(c => { if (!ids.includes(Number(c.dataset.id))) c.remove(); });
  s.panes.forEach((p, i) => {
    let c = strip.querySelector(`.chip[data-id="${p.id}"]`) || chip(p);
    if (strip.children[i] !== c) strip.insertBefore(c, strip.children[i] || null);
    const color = s.colors[p.color];
    c.style.setProperty('--pc', color || 'transparent');
    c.classList.toggle('focused', p.id === s.focusedId);
    c.classList.toggle('glow', p.glow);
    c.classList.toggle('waiting', !!p.waiting);
    c.classList.toggle('done', !!p.done);
    c.classList.toggle('working', !!p.working);
    c.classList.toggle('unopened', !!p.unopened);
    const lastOnly = p.obs === 'last' && !!(p.waiting || p.working || p.done), lt = lastOnly ? '・最終確認値（現在は未確認）' : '';   // marker not confirmed for the page as it is now
    c.classList.toggle('stale', lastOnly);
    c.classList.toggle('colored', !!color);
    setTip(c, p.name || p.title || '新しいペイン', 'クリックで開き、ダブルクリックで名前を変えます。', '', `${p.url || '新しいペイン'}${p.muted ? '・通知ミュート中' : ''}`);
    const n = p.unread || 0;
    const chars = Array.from(String(p.name || p.title || '').trim());
    const first = (chars[0] || '•').toUpperCase();
    const lbl = shortLabel(chars.slice(1).join(''));
    const justCopied = (copied.get(p.id) || 0) > Date.now();
    reconcileTooltipMarkup(c, (justCopied ? `<span class="cicon copied" ${tipAttrs('コピーしました', 'このペインのリンクをコピーしました。')}>✓</span>` : n >= 1 ? `<span class="cicon ccount${p.glow ? ' hot' : ''}${p.unopened ? ' unop' : ''}" ${tipAttrs('リンクをコピー', 'このペインのリンクをコピーします。', '', `新着 ${n}件`)}>${n > 99 ? '99' : n}</span>` : `<span class="cicon" ${tipAttrs('リンクをコピー', 'このペインのリンクをコピーします。')}>${esc(first)}</span>`) +
      `<span class="clabel">${esc(lbl)}</span>` + (p.sleeping ? (p.unopened ? `<span class="zz" ${tipAttrs('スリープ中', 'スリープ中に新着が届きました。', '', '未開封')}>💤✉</span>` : `<span class="zz" ${tipAttrs('スリープ中', 'このペインは休止しています。')}>💤</span>`) : '') + (p.waiting ? `<span class="wdot" ${tipAttrs('待機中', 'Botが次の指示を待っています。', '', lt)}></span>` : p.working ? `<span class="wdot work" ${tipAttrs('作業中', 'Botが作業しています。', '', lt)}></span>` : p.done ? `<span class="wdot done" ${tipAttrs('終了', 'Botの作業が終了しました。', '', lt)}></span>` : ''));
  });

  syncBtn(s);
  // splitters
  const sh = $('#splits'); sh.innerHTML = '';
  (s.splitters || []).forEach(g => {
    const e = document.createElement('div'); e.className = 'splitter ' + g.axis;
    Object.assign(e.style, { left: g.x + 'px', top: g.y + 'px', width: g.w + 'px', height: g.h + 'px' });
    setTip(e, 'ペインの幅を調整', 'ドラッグで大きさを変えます。', '', 'ダブルクリックで均等に戻します。');
    e.onmousedown = ev => { ev.preventDefault(); document.body.classList.add('splitting', 'split-' + g.axis); mpb.splitStart(g.axis, g.i, g.row); };
    e.ondblclick = () => mpb.splitReset(g.axis, g.row);
    sh.appendChild(e);
  });

  // pane cards
  for (const [id, d] of els) if (!ids.includes(id)) { d.classList.add('leaving'); els.delete(id); setTimeout(() => d.remove(), 160); }
  for (const p of s.panes) {
    const d = els.get(p.id) || mk(p.id), r = p.rect;
    d.classList.toggle('hidden', !r);
    if (r) Object.assign(d.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    d.classList.toggle('focused', p.id === s.focusedId);
    d.classList.toggle('loading', p.loading);
    d.classList.toggle('unread', !!p.glow);
    d.classList.toggle('waiting', !!p.waiting);
    d.classList.toggle('done', !!p.done);
    d.classList.toggle('working', !!p.working);
    d.classList.toggle('unopened', !!p.unopened);
    d.classList.toggle('maxed', p.id === s.maximizedId);
    d.classList.toggle('sleeping', !!p.sleeping);
    const lqWait = p.lq === 'wait';                                 // waiting for a load slot (#31); held: nothing to show yet, the placeholder instead of the page
    d.classList.toggle('lqwait', lqWait); d.classList.toggle('held', !!p.held); d.classList.toggle('idle', !!p.idle);
    d.classList.toggle('gone', !!p.gone);                              // (#32) renderer gone: the 'stopped' placeholder (main hides the view)
    d.querySelectorAll('.lpn').forEach(b => { b.textContent = lqWait && p.lqPos ? `（${p.lqPos}番目）` : ''; });
    const lastOnly = p.obs === 'last' && !!(p.waiting || p.working || p.done);
    d.classList.toggle('stale', lastOnly);
    { const sn = d.querySelector('.sleepid .sn'), sg = d.querySelector('.sleepid .sg'); sn.textContent = p.sname || ''; sg.textContent = p.sgroup || ''; sg.style.display = p.sgroup ? '' : 'none'; }
    { const r = d.querySelector('.sleepr'); r.textContent = p.rs || ''; r.classList.toggle('on', !!p.rs); }   // (#22) restored after a restart: 前回・未再確認 (main's line)
    { const q = d.querySelector('.sleepq'); q.textContent = p.quote || ''; q.classList.toggle('on', !!p.quote); }
    { const c = d.querySelector('.chk'); c.querySelector('.chkt').textContent = p.chk || ''; c.classList.toggle('on', !!p.chk); c.classList.toggle('hold', !!(p.chk && s.chkHold)); }   // (#33) main's line: last success / next / failures / stopped
    { const sb = d.querySelector('.slp'); sb.classList.toggle('on', p.sleepOn); setTip(sb, '自動スリープ', '待機中や終了後のスリープを切り替えます。', '', `${p.sleepOn ? 'ON' : 'OFF'}${s.sleepGlobal ? '' : '・全体設定はOFFです。'}`); }
    const color = s.colors[p.color];
    d.style.setProperty('--pc', color || 'transparent');
    d.classList.toggle('colored', !!color);
    d.querySelector('.fav').innerHTML = favHtml(p);
    d.querySelector('.title').innerHTML = p.name ? `<b>${esc(p.name)}</b><span class="sub">${esc(p.title)}</span>` : esc(p.title);
    setTip(d.querySelector('.title'), 'URLを編集', 'クリックしてURLや検索語を入力します。', `${MOD}L`, p.url || '新しいペイン');
    const inp = d.querySelector('.url'); if (document.activeElement !== inp) inp.value = p.url;
    inp.placeholder = 'URL・検索語を入力（Grok BotのURLを貼り付けてもOK）';
    const meta = [];
    if (p.sleeping) meta.push(p.unopened ? `<span ${tipAttrs('未開封の新着', 'スリープ中に新着が届きました。')}>💤✉ 未開封</span>` : `<span ${tipAttrs('スリープ中', 'このペインは休止しています。')}>💤</span>`);
    if (lqWait && !p.held && !p.sleeping) meta.push(`<span class="lqw" ${tipAttrs('読み込み待ち', '順番が来ると自動で読み込みます。', '', p.lqPos ? `${p.lqPos}番目` : '')}>⏳ 読み込み待ち${p.lqPos ? ` ${p.lqPos}番目` : ''}</span><button class="lqx" ${tipAttrs('読み込みを取消', 'このペインの読み込み待ちを取り消します。')}>取消</button>`);
    // (#32) a failed load: an automatic reload is planned (bounded) / manual only; unresponsive: noted only, never reloaded by itself
    if (p.fail === 'retry') meta.push(`<span class="rfail" ${tipAttrs('読み込み失敗', '少し待って自動で読み込み直します。', '', '入力中は再読み込みしません。')}>⚠ 読込失敗・再試行待ち</span>`);
    else if (p.fail === 'manual') meta.push(`<span class="rfail" ${tipAttrs('読み込み失敗', '再読み込みボタンでやり直せます。', '', '自動では再読み込みしません。')}>⚠ 読込失敗</span>`);
    if (p.hang) meta.push(`<span class="rhang" ${tipAttrs('応答なし', 'ページの応答を待っています。', '', '必要なら再読み込みできます。')}>⏳ 応答なし</span>`);
    if (lastOnly) meta.push(`<span class="lastok" ${tipAttrs('最終確認', '表示は最後に確認できた状態です。', '', '現在の状態はまだ確認できていません。')}>最終確認</span>`);
    if (p.muted) meta.push(`<span ${tipAttrs('通知ミュート', 'このペインの通知を止めています。')}>🔕</span>`);
    if (p.reloadMinutes) meta.push(`<span ${tipAttrs('自動再読み込み', 'このページを定期的に読み込み直します。', '', `${p.reloadMinutes}分ごと`)}>↻${p.reloadMinutes}m</span>`);
    if (p.zoomIndiv) meta.push(`<span class="zind" ${tipAttrs('個別ズーム', 'このペインだけの表示倍率です。', '', `${Math.round(p.zoom * 100)}%`)}>🔍個別 ${Math.round(p.zoom * 100)}%</span>`);
    else if (p.zoom && Math.abs(p.zoom - 1) > 0.01) meta.push(`<span ${tipAttrs('全体ズーム', '全体に設定した表示倍率です。', '', `${Math.round(p.zoom * 100)}%`)}>${Math.round(p.zoom * 100)}%</span>`);
    reconcileTooltipMarkup(d.querySelector('.meta'), meta.join(''));
    const b = d.querySelector('.badge');
    b.textContent = p.unread ? (p.unread > 99 ? '99+' : p.unread) : '';
    b.dataset.count = String(p.unread || 0);
    b.dataset.countTitle = p.isGrok ? '自分の最後の送信以降に届いたBotのメッセージ数' : '更新回数';
    badgeTitle(b);
    b.classList.toggle('quiet', !p.glow);
    b.classList.toggle('wait', !!p.waiting); b.classList.toggle('work', !!p.working); b.classList.toggle('done', !!p.done); b.classList.toggle('unop', !!p.unopened);
    d.querySelector('[data-a=back]').disabled = !p.canBack;
    d.querySelector('[data-a=forward]').disabled = !p.canForward;
    d.querySelector('[data-a=maximize]').textContent = p.id === s.maximizedId ? '⤡' : '⤢';
    d.querySelector('[data-a=maximize]').dataset.tipDetail = p.id === s.maximizedId ? '現在: 最大化中' : 'ヘッダーのダブルクリックでも切り替えられます。';
  }
};
mpb.onState(onS);
// ---- お気に入りバー: [Grok button][pins][favorites = other URLs][the Bot list in grok.com's sections]. main reads the list (Grok button only) and
// sends it on 'gbar' (G: pins / sections / busy / note / mode); the bar is rebuilt only when that or the favorites change.
// 表示モード (gbar-mode.js; main keeps it): a right-click on the Grok button takes the next one, 通常 → セミコンパクト → コンパクト → 通常
const favs = $('#favs'), gbtn = $('#fav-star'), gnote = $('#gbar-note');
let G = null, gRev = 0, favKey = '', gMode = 'normal';
let gItems = [];                                            // includes pins and detached pages; state changes never rebuild the bar
function gTrack(el, item) { gItems.push({ el, id: GbarPresence.botId(item.url), detail: el.dataset.tipDetail }); }
function gPresence() {
  const { openIds, focusedId } = GbarPresence.match(S ? S.panes || [] : [], S && S.focusedId);
  gItems.forEach(({ el, id, detail }) => {
    const open = openIds.has(id), active = !!id && id === focusedId;
    el.classList.toggle('gopen', open); el.classList.toggle('gactive', active);
    el.dataset.tipDetail = (active ? '今のペインで開いています・' : open ? 'ペインで開いています・' : '') + detail;
    el.setAttribute('aria-label', [el.dataset.tip, el.dataset.tipDesc, el.dataset.tipDetail].filter(Boolean).join('。'));
    el.setAttribute('aria-current', active ? 'page' : 'false');
  });
}
const openWhere = e => e.shiftKey ? 'window' : (e.metaKey || e.altKey) ? 'here' : 'new';
// a name as the mode shows it: 通常 = as before (up to max columns), セミコンパクト = 4 units (コンパクト: no name, see gbotBtn / renderFavs)
const gLabel = (s, max) => (gMode === 'semi' ? GbarMode.truncate(s) : shortLabel(s, max));
// Handle secondary mousedown too in case native contextmenu is missed; consume its contextmenu / click once.
// A new press (or keyboard interaction) resets the gesture: rapid distinct right-clicks still each advance the mode.
let gModePress = false, gModeClick = false;
gbtn.onmousedown = e => {
  gModePress = gModeClick = e.button === 2 || (e.button === 0 && e.ctrlKey);
  if (gModePress) { e.preventDefault(); mpb.gbarMode(); }
};
gbtn.oncontextmenu = e => { e.preventDefault(); if (!gModePress) mpb.gbarMode(); gModePress = false; gModeClick = true; };
gbtn.onkeydown = () => { gModePress = gModeClick = false; };
gbtn.onclick = (e = {}) => {
  if (gModeClick || e.button === 2 || e.ctrlKey) { e.preventDefault?.(); gModeClick = false; return; }
  if (!(G && G.busy)) mpb.gbarRefresh();
};
mpb.onGbar(v => {
  G = v; gRev++; gMode = GbarMode.normMode(v.mode);
  gbtn.classList.toggle('busy', !!v.busy); gbtn.setAttribute('aria-busy', v.busy ? 'true' : 'false');
  setTip(gbtn, 'Bot一覧を更新', v.busy ? 'GrokのBot一覧を読み込み中です。' : 'GrokのBot一覧を読み込み直します。', '',
    `${v.at ? `前回: ${new Date(v.at).toLocaleString('ja-JP', { hour12: false })}・${v.count}件・` : ''}右クリックで表示を切替（${GbarMode.LABEL[gMode]} → ${GbarMode.LABEL[GbarMode.nextMode(gMode)]}）`);
  gnote.textContent = v.busy ? '読み込み中…' : v.note || '';
  renderFavs(S ? S.favorites || [] : []);
  if (S) renderSummaryTips(S);
});
function gIcon(b) {                                          // its icon (16 px round), or the first letter when there is none / it does not load
  const l = document.createElement('span'); l.className = 'fic'; l.textContent = GbarMode.initial(b.name);   // a whole character (emoji, marks)
  if (!b.icon) return l;
  const im = document.createElement('img'); im.className = 'gic'; im.alt = ''; im.draggable = false; im.referrerPolicy = 'no-referrer';
  im.addEventListener('error', () => im.replaceWith(l), { once: true }); im.src = b.icon;
  return im;
}
function gbotBtn(b, pin) {
  const el = document.createElement('button');
  el.className = 'fav-btn gbot' + (pin ? ' gpin' : '') + (b.group ? ' grp' : '');
  el.appendChild(gIcon(b));
  if (gMode !== 'compact') el.insertAdjacentHTML('beforeend', `<span class="flabel">${esc(gLabel(b.name, 10))}</span>`);   // コンパクト: the icon only
  setTip(el, b.name, 'クリックで開き、長押しで今のペインに開きます。', '',
    `${b.name !== b.orig ? `元の名前: ${b.orig}・` : ''}${b.group ? 'グループ・' : ''}${b.pinned ? 'お気に入り・' : ''}${b.url}・右クリックでメニュー`);
  gTrack(el, b);
  let hold = GbarLongPress.idle(), feedback = null;
  const clearFeedback = () => { if (feedback) feedback.cancel(); feedback = null; };
  const cancelHold = e => { hold = GbarLongPress.cancel(hold, e); if (!hold.press) clearFeedback(); };
  el.onpointerdown = e => {
    clearFeedback(); hold = GbarLongPress.begin(e);
    if (hold.press) feedback = el.animate([{ backgroundColor: 'var(--ctl-hi)' }, { backgroundColor: 'var(--accent)' }], { duration: GbarLongPress.HOLD_MS, easing: 'linear', fill: 'forwards' });
  };
  el.onpointermove = e => { hold = GbarLongPress.move(hold, e); if (!hold.press) clearFeedback(); };
  el.onpointerleave = el.onpointercancel = cancelHold;
  // Do not capture the pointer or prevent pointerdown/dragstart: pinned items
  // retain Chromium's native drag-and-drop reorder gesture.
  el.addEventListener('dragstart', () => cancelHold());
  el.onpointerup = e => {
    const result = GbarLongPress.release(hold, e); hold = result.state;
    if (!hold.press) clearFeedback();
    if (result.openHere) mpb.gbotOpen(b.id, 'here');
  };
  el.onclick = e => {
    const result = GbarLongPress.click(hold, e); hold = result.state;
    clearFeedback();
    if (result.suppress) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.button === 2 || e.ctrlKey) return;
    mpb.gbotOpen(b.id, openWhere(e));
  };
  el.onauxclick = e => { if (e.button === 1) mpb.gbotOpen(b.id, 'new'); };
  el.oncontextmenu = e => { e.preventDefault(); mpb.gbotMenu(b.id); };
  if (pin) {                                                 // pins: drag one onto another to reorder (as the favorites)
    el.draggable = true;
    el.ondragstart = e => { e.dataTransfer.setData('text/x-mpb-gpin', b.id); el.classList.add('drag-src'); };
    el.ondragend = () => el.classList.remove('drag-src');
    el.ondragover = e => { if (e.dataTransfer.types.includes('text/x-mpb-gpin')) { e.preventDefault(); el.classList.add('drop-over'); } };
    el.ondragleave = () => el.classList.remove('drop-over');
    el.ondrop = e => { el.classList.remove('drop-over'); const from = e.dataTransfer.getData('text/x-mpb-gpin'); if (from) { e.preventDefault(); e.stopPropagation(); if (from !== b.id) mpb.gbotMove(from, b.id); } };
  }
  return el;
}
const mkEl = (cls, text) => { const e = document.createElement('span'); e.className = cls; if (text) e.textContent = text; return e; };
// ページ送り (gbar-pages.js): the pins always stay; the rest (favorites, then the sections' Bots) is cut into pages that fit the bar, each page
// starting with its section's heading. 次へ › at the right end goes to the next page (after the last: the first); no button when all fits. Redone
// when the bar's width or the list changes: it stays on the page that holds the item 次へ last went to (gone: the first page). No sideways scroll
let GP = null, gAnchor = null;                               // GP: the paged part (elements, widths, pages, page); gAnchor: that item's key
const gNext = document.createElement('button');
gNext.id = 'gbar-next'; gNext.className = 'fav-btn'; gNext.textContent = '次へ ›';
gNext.onclick = () => { if (!GP || GP.pages.length < 2) return; GP.page = (GP.page + 1) % GP.pages.length; gAnchor = GP.keys[GP.pages[GP.page][0]]; gShow(); };
function gMeasure() {                                        // every element once in the bar (none shrinks): its width with its margins
  const gap = parseFloat(getComputedStyle(favs).columnGap) || 0;
  const ow = e => { const cs = getComputedStyle(e); return e.getBoundingClientRect().width + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0); };
  favs.append(...GP.els, ...GP.heads.filter(Boolean), GP.sep, gNext);
  GP.pinW = [...favs.children].slice(0, GP.pinN).reduce((a, e) => a + ow(e) + gap, 0);
  GP.ws = GP.els.map(ow);
  GP.o = { gap, sec: GP.sec, head: GP.heads.map(h => (h ? ow(h) : 0)), sep: ow(GP.sep), lead: GP.pinN > 0 };
  GP.btnW = gNext.getBoundingClientRect().width;             // not its margin (auto: it stands at the right end)
  GP.ok = GP.btnW > 0;                                       // read while the bar had no size: again once it has one
}
function gLayout() {
  if (!GP) return;
  const w = favs.getBoundingClientRect().width;
  if (!w || (w === GP.w && GP.ok)) return;
  if (!GP.ok) gMeasure();
  GP.w = w;
  GP.pages = GbarPages.pages(GP.ws, w - GP.pinW, GP.btnW, GP.o);
  const at = GbarPages.pageOf(GP.pages, GP.keys.indexOf(gAnchor));
  GP.page = at < 0 ? 0 : at;
  if (at < 0) gAnchor = null;
  gShow();
}
function gShow() {                                           // the page after the pins (the same elements: their handlers stay)
  const [from, to] = GP.pages[GP.page] || [0, 0], n = GP.pages.length, out = [];
  for (let j = from; j < to; j++) {
    const b = GbarPages.before(j, from, GP.o);
    if (b.sep) out.push(GP.sep);
    if (b.head >= 0 && GP.heads[b.head]) out.push(GP.heads[b.head]);
    out.push(GP.els[j]);
  }
  if (n > 1) { out.push(gNext); setTip(gNext, '次のページ', GP.page + 1 < n ? '次のBot一覧を表示します。' : 'Bot一覧の先頭に戻ります。', '', `ページ ${GP.page + 1}/${n}`); }
  const now = [...favs.children].slice(GP.pinN);
  if (now.length === out.length && now.every((e, i) => e === out[i])) return;
  while (favs.children.length > GP.pinN) favs.lastElementChild.remove();
  favs.append(...out);
}
new ResizeObserver(() => gLayout()).observe(favs);
function renderFavs(list) {
  const key = JSON.stringify(list) + '|' + gRev;
  if (key === favKey) { gPresence(); return; }                // onState: navigation / open / close / focus, without remeasuring or changing page
  favKey = key;
  const pins = G ? G.pins : [], secs = G ? G.sections : [];
  $('#fav-hint').style.display = list.length || pins.length || secs.length ? 'none' : '';
  favs.classList.toggle('gm-semi', gMode === 'semi'); favs.classList.toggle('gm-compact', gMode === 'compact');   // (表示モード) before anything is measured
  favs.innerHTML = '';
  gItems = [];
  pins.forEach(b => favs.appendChild(gbotBtn(b, true)));
  const els = [], keys = [], sec = [];                       // the paged items: favorites (no section), then each section's Bots
  list.forEach(f => {
    const b = document.createElement('button');
    b.className = 'fav-btn'; b.draggable = true;
    let host = ''; try { host = new URL(f.url).hostname; } catch {}
    const isBot = /grok\.com$/.test(host) && /\/bot\//.test(f.url), name = f.label || host;
    b.innerHTML = gMode === 'compact' ? `<span class="fic">${esc(GbarMode.initial(name))}</span>` : `<span class="flabel">${esc(gLabel(name))}</span>`;   // no icon of its own: コンパクト shows its first letter
    setTip(b, name || 'お気に入り', '今のペインでお気に入りを開きます。', '', `${f.url}・右クリックでメニュー`);
    gTrack(b, f);
    b.onclick = e => mpb.favOpen(f.id, e.shiftKey ? 'window' : (e.metaKey || e.ctrlKey) ? 'new' : 'here');
    b.onauxclick = e => { if (e.button === 1) mpb.favOpen(f.id, 'new'); };
    b.oncontextmenu = e => { e.preventDefault(); mpb.favMenu(f.id); };
    b.ondragstart = e => { e.dataTransfer.setData('text/x-mpb-fav', String(f.id)); b.classList.add('drag-src'); };
    b.ondragend = () => b.classList.remove('drag-src');
    b.ondragover = e => { if (e.dataTransfer.types.includes('text/x-mpb-fav')) { e.preventDefault(); b.classList.add('drop-over'); } };
    b.ondragleave = () => b.classList.remove('drop-over');
    b.ondrop = e => { b.classList.remove('drop-over'); const from = Number(e.dataTransfer.getData('text/x-mpb-fav')); if (from) { e.preventDefault(); e.stopPropagation(); mpb.favMove(from, f.id); } };
    els.push(b); keys.push('f' + f.id); sec.push(null);
  });
  const heads = secs.map((s, k) => {                         // grok.com's own sections (the user's tabs), in the page's order
    s.items.forEach(b => { els.push(gbotBtn(b, false)); keys.push('b' + b.id); sec.push(k); });
    if (!s.name) return null;
    const h = mkEl('gsec', gMode === 'compact' ? GbarMode.truncate(s.name, 2) : gLabel(s.name, 12)); setTip(h, s.name, 'このグループのBotを表示しています。'); return h;   // コンパクト: 2 units
  });
  GP = { pinN: pins.length, els, keys, sec, heads, sep: mkEl('gsep'), w: -1, ok: false, pages: [], page: 0 };
  gLayout();
  gPresence();
}
// drop a link / URL text onto the favorites bar to add it
const fb = $('#favbar');
fb.ondragover = e => { if (e.dataTransfer.types.includes('text/uri-list') || e.dataTransfer.types.includes('text/plain')) { e.preventDefault(); fb.classList.add('drop-over'); } };
fb.ondragleave = () => fb.classList.remove('drop-over');
fb.ondrop = e => {
  fb.classList.remove('drop-over');
  const t = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
  if (/^https?:\/\//.test(t)) { e.preventDefault(); mpb.favAdd(t, ''); }
};
// ---- ドッキング型の並べ替え: a header drag. The panes' views lie above this page (it would not see the drag over them): main hides them behind
// stills of their pages (shown here first, then dockReady), says where a drop would put the pane (the red preview: the place it would take) and
// does the drop. This page only reports the cursor; main ends the drag by itself too (Esc / another window / an overlay): then nothing is shown
let drag = null;                                             // { id, seq, x, y } while a header drag lasts
const hint = $('#drop-hint');
function dockClear() {
  hint.classList.remove('on'); document.body.classList.remove('docking');
  root.querySelectorAll('.dockshot[src]').forEach(i => i.removeAttribute('src'));
}
function dockStart(id) { dockClear(); drag = { id, seq: 0, x: NaN, y: NaN }; mpb.dockBegin(id); }
function dockStop() { if (!drag) return; drag = null; dockClear(); mpb.dockEnd(); }
mpb.onDock(m => {
  if (!m || !drag) return;
  if (m.on === false) { if (!drag.seq || m.seq === drag.seq) dockClear(); return; }   // over (the drag itself may go on: it does nothing more)
  if (m.on === true && !m.shots) { drag.seq = m.seq; document.body.classList.add('docking'); return; }
  if (m.seq !== drag.seq) return;
  if (m.shots) {
    const imgs = m.shots.map(s => { const i = els.get(s.id)?.querySelector('.dockshot'); if (i) i.src = s.url; return i; }).filter(Boolean);
    Promise.all(imgs.map(i => i.decode().catch(() => {}))).then(() => { if (drag && drag.seq === m.seq) mpb.dockReady(m.seq); });
    return;
  }
  if ('hover' in m) { const r = m.hover; hint.classList.toggle('on', !!r); if (r) Object.assign(hint.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' }); }
});
document.addEventListener('dragover', e => {
  if (!drag) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  const x = Math.round(e.clientX), y = Math.round(e.clientY);
  if (x !== drag.x || y !== drag.y) { drag.x = x; drag.y = y; mpb.dockHover(x, y); }
});
document.addEventListener('drop', e => {
  if (!drag || (e.target.closest && e.target.closest('.chip'))) return;   // onto a tab of the strip: it swaps (chip.ondrop)
  e.preventDefault(); mpb.dockDrop(Math.round(e.clientX), Math.round(e.clientY));
});
mpb.onFocusUrl(id => { const d = els.get(id); if (d) startEdit(d); });
mpb.ready();

// compact mode: tabs show icon only
(function(){
  const KEY='mpb-compact';
  const apply=v=>{document.body.classList.toggle('compact',v);const b=document.getElementById('compact-btn');if(b){b.classList.toggle('active',v);setTip(b,'コンパクト表示','ペインのタブ表示を切り替えます。',MOD+'⇧C',v?'ON':'OFF');}};
  const b=document.createElement('button');
  b.id='compact-btn';b.className='compact-btn';b.textContent='◫';setTip(b,'コンパクト表示','ペインのタブ表示を切り替えます。',MOD+'⇧C');
  const strip=document.getElementById('strip');strip.parentNode.insertBefore(b,strip);
  const toggle=()=>{const v=!document.body.classList.contains('compact');localStorage.setItem(KEY,v?'1':'0');apply(v);};
  b.onclick=toggle;
  window.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.code==='KeyC'){e.preventDefault();toggle();}});
  apply(localStorage.getItem(KEY)==='1');
})();

window.addEventListener('mouseup', () => { if (document.body.classList.contains('splitting')) { document.body.classList.remove('splitting', 'split-c', 'split-r'); mpb.splitEnd(); } });
window.addEventListener('blur', () => { document.body.classList.remove('splitting', 'split-c', 'split-r'); });

// ---- usage readouts (使用量表示): Codex / Claude / Kimi / Antigravity / Grok. Shown only while 設定 > 使用量表示 is on, and only the providers
// turned on there (main's state.usage = { show, list: [{ id, src }] }); a hidden gauge reads nothing. Each pill has its own mode (click cycles),
// number in a coloured frame. Not connected (src 'none') / a lapsed web sign-in: the click opens that provider's login window (main).
// Antigravity (src 'info') has no web usage page: no number, its popover says where to look. ----
(function(){
  const ICON={
    codex:'<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 6.2l2.4 1.8L5 9.8M8.9 10h2.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    claude:'<svg viewBox="0 0 16 16"><g stroke="#d97757" stroke-width="1.7" stroke-linecap="round"><path d="M8 1.8v12.4M1.8 8h12.4M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8"/></g></svg>',
    kimi:'<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.6 4.6v6.8M10.6 4.6 6.4 8l4.4 3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    antigravity:'<svg viewBox="0 0 16 16"><path d="M2.2 13.2 8 2.6l5.8 10.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.4 13.2c.6-2 1.5-3 2.6-3s2 1 2.6 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    grok:'<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.3 10.7l5.4-5.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'};
  const NAME={codex:'Codex',claude:'Claude',kimi:'Kimi',antigravity:'Antigravity',grok:'Grok'};
  const MODES={codex:['left','used'],claude:['left','used'],kimi:['left','used'],antigravity:['left'],grok:['left','used','today']};
  const seed=localStorage.getItem('mpb-usage-mode')==='used'?'used':'left';
  const R=Math.round, fmt=v=>v>=100?'MAX':String(v).padStart(2,'0');
  const pills={};
  document.querySelectorAll('.pill.usage').forEach(btn=>{
    const kind=btn.dataset.kind, KEY='mpb-um-'+kind, modes=MODES[kind];
    if(!modes) return;
    const L=window.MPB_ICONS&&window.MPB_ICONS[kind], ico=btn.querySelector('.uico');
    if(L&&L.mask) ico.innerHTML='<span class="mico" style="background:'+(L.color||'currentColor')+';-webkit-mask-image:url('+L.mask+');mask-image:url('+L.mask+')"></span>';
    else if(L&&L.img) ico.innerHTML='<img class="gico" alt="" src="'+L.img+'">';
    else ico.innerHTML=ICON[kind];
    let mode=localStorage.getItem(KEY); if(!modes.includes(mode)) mode=seed;
    let last=null, det=null, src='off', started=false;
    const on=()=>src!=='off'&&src!=='info';   // a gauge that reads numbers right now
    const WKEY='mpb-uwin-'+kind; let selId=localStorage.getItem(WKEY)||'';
    const defBucket=bs=>{const m=bs.filter(x=>x.main);const a=m.length?m:bs;return a.find(x=>x.five)||a.find(x=>x.weekly)||a[0]||null;};   // default: 5-hour window if present, else 1-week
    const pickBucket=bs=>{bs=bs||[];return bs.find(x=>x.id===selId)||defBucket(bs);};
    const level=(m,pct)=>m==='used'?(pct<=50?'g':pct<=80?'y':'r'):(pct>=50?'g':pct>=20?'y':'r');
    const calc=()=>{
      if(kind==='grok'){
        if(!last||!last.ok) return null;
        const used=R(last.used), left=Math.max(0,100-used);
        if(mode==='today'){ if(!det||det.allowance==null||det.allowLeft==null) return null;
          const frac=det.allowance>0?Math.max(0,Math.min(1,det.allowLeft/det.allowance)):0;
          return {v:R(det.allowLeft),pct:frac*100,frac}; }
        return {v:mode==='used'?used:left,pct:mode==='used'?used:left};
      }
      const b=last&&last.ok?pickBucket(last.buckets):null; if(!b) return null;
      const used=R(b.used), left=Math.max(0,100-used);
      return {v:mode==='used'?used:left,pct:mode==='used'?used:left};
    };
    // not connected / web sign-in lapsed (click: login window) / Claude Code's local login expired (click: the re-auth dialog, as before)
    const login=()=>src==='none'||!!(last&&last.needLogin&&(last.src==='web'||kind==='claude'));
    const render=()=>{
      const c=on()?calc():null, u=btn.querySelector('.uval');
      btn.hidden=src==='off';
      btn.className='pill usage mode-'+mode+(src==='info'?' info':c?' lv-'+level(mode,c.pct):' err')+(c&&last&&last.stale?' stale':'')+(on()&&login()?' needlogin':'');
      if(!c) u.textContent=kind==='claude'&&last&&last.relogin&&last.needLogin?'Terminalで /login が必要':'--';
      else u.textContent=fmt(c.v);
      setTip(btn, NAME[kind]+'の使用量', src==='info'?'確認方法を表示します。':login()?'接続やログインを確認します。':'使用状況を確認し、表示を切り替えます。', '',
        c ? `${mode==='used'?'使用済み':mode==='today'?'本日の残り':'残り'}: ${u.textContent}${mode==='today'?'':'%'}${last&&last.stale?'・前回の値':''}` : src==='info'?'詳細を表示できます。':login()?'ログインが必要です。':'現在の値を取得できていません。');
    };
    const load=async force=>{
      if(!on()) return;
      const was=src;
      try{
        if(kind==='grok'){last=await mpb.usage(force);det=await mpb.usageDetail();}
        else last=await mpb.aiUsage(kind,force);
      }catch(e){last={ok:false,err:String(e),buckets:[]};}
      if(src!==was) return;   // the source changed meanwhile: that answer is not this gauge's any more
      render();
    };
    // main's state.usage: shown or not / where the numbers come from. The first time it shows: the first read after a moment (as at startup before)
    pills[kind]=s=>{
      if(s===src) return;
      src=s; last=null; det=null; render();
      if(!on()) return;
      if(started) { load(false); return; }
      started=true; setTimeout(()=>load(kind==='grok'),kind==='grok'?8000:1500); setTimeout(()=>{if(!last||!last.ok)load(kind==='grok');},30000);
    };
    let hold=null,held=false,popT=null;
    btn.onmousedown=()=>{held=false;hold=setTimeout(()=>{held=true;btn.classList.add('spin');load(true).then(()=>btn.classList.remove('spin'));},600);};
    btn.onmouseup=()=>clearTimeout(hold);
    const popNow=()=>{clearTimeout(popT);const r=btn.getBoundingClientRect();mpb.usagePopShow({right:r.right,bottom:r.bottom,kind,sel:curId()});};
    btn.onclick=()=>{if(held)return;
      if(src==='info'){popNow();return;}
      if(src==='none'||(last&&last.needLogin&&last.src==='web')){clearTimeout(popT);mpb.usagePopLeave();mpb.usageConnect(kind);return;}
      if(kind==='claude'&&last&&last.needLogin){clearTimeout(popT);mpb.usagePopLeave();mpb.claudeAuthDialog().then(()=>{load(true);setTimeout(()=>load(true),20000);});return;}
      mode=modes[(modes.indexOf(mode)+1)%modes.length];localStorage.setItem(KEY,mode);render();if(kind==='grok'&&mode==='today'&&!det)load(false);};
    const curId=()=>{const b=kind==='grok'?null:(last&&last.ok?pickBucket(last.buckets):null);return b?b.id:'';};
    btn.onmouseenter=()=>{clearTimeout(popT);popT=setTimeout(popNow,280);};
    if(kind!=='grok'&&kind!=='antigravity'){
      btn.oncontextmenu=e=>{e.preventDefault();clearTimeout(popT);mpb.usagePopLeave();const go=()=>mpb.usageWinMenu(kind,curId());(last&&last.buckets&&last.buckets.length)||!on()?go():load(false).then(go);};
      mpb.onUsageWin((k,id)=>{if(k!==kind)return;selId=id;localStorage.setItem(WKEY,id);render();});
    }
    btn.addEventListener('mouseleave',()=>{clearTimeout(hold);clearTimeout(popT);mpb.usagePopLeave();});
    window.addEventListener('focus',()=>load(false));
    mpb.onUsageUpdated(()=>load(false));
    setInterval(()=>load(kind==='grok'),5*60*1000);
    if(kind==='grok') setInterval(()=>{if(on())mpb.usageDetail().then(d=>{det=d;render();}).catch(()=>{});},60000);
    render();
  });
  mpb.onState(s=>{
    const u=s&&s.usage; if(!u||!Array.isArray(u.list)) return;
    const m={}; u.list.forEach(x=>{m[x.id]=x.src;});
    Object.keys(pills).forEach(k=>pills[k](u.show&&m[k]?m[k]:'off'));
  });
})();
