const $ = s => document.querySelector(s);
const root = $('#panes'), strip = $('#strip'), els = new Map();
const mac = mpb.platform === 'darwin';
document.body.classList.add(mac ? 'mac' : 'other');
const MOD = mac ? '⌘' : 'Ctrl+';
if (!mac) $('#cmdk kbd').textContent = 'Ctrl+K';
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
  b.title = `${k.replace('x', '×')}（${MOD}${i + 1}）`;
  b.onclick = () => mpb.layout(k); $('#presets').appendChild(b);
});
$('#add').onclick = () => mpb.add();
$('#reopen').onclick = () => { if (S && S.canReopen) mpb.reopenClosed(); };
$('#reload-all').onclick = () => mpb.reloadAll();
$('#ws-btn').onclick = () => mpb.wsMenu();
$('#cmdk').onclick = () => mpb.palette();
$('#unread-sum').onclick = () => mpb.run({ type: 'next-unread' });
$('#approve-btn').onclick = () => mpb.approveOpen();
// panes.json warning (state-store.js): unreadable at start -> recovery list; a save failed -> retry. The panes stay as they are.
$('#save-warn').onclick = () => { const st = (S && S.store) || {}; if (st.status && st.status !== 'ready') mpb.recoveryOpen(); else mpb.saveRetry(); };
// memory meter: fixed-width, tabular digits; <1GB -> "333MB", else "1.2GB"
const memEl = $('#mem');
const fmtMem = b => { const mb = b / 1048576; return Math.round(mb) < 1024 ? `${Math.round(mb)}MB` : `${(mb / 1024).toFixed(1)}GB`; };
mpb.onMem(b => { const t = fmtMem(b); if (memEl.textContent !== t) memEl.textContent = t; });
// notification chips for panes in other windows (hidden when there is only one window)
const othersEl = $('#others'), othersSep = $('#others-sep');
mpb.onOthers(list => {
  const has = Array.isArray(list) && list.length > 0;
  othersEl.classList.toggle('show', has); othersSep.classList.toggle('show', has);
  if (!has) { othersEl.innerHTML = ''; return; }
  othersEl.innerHTML = list.map(w => `<span class="owin" title="ウィンドウ${w.n}">${w.n}</span>` + w.panes.map(p => {
    const st = p.unopened ? 'unopened' : p.waiting ? 'waiting' : p.working ? 'working' : p.done ? 'done' : p.glow ? 'glow' : '';
    const ch = (Array.from(String(p.name || '•').trim())[0] || '•').toUpperCase();
    const lab = p.unopened ? '未開封の新着' : p.waiting ? '待機中' : p.working ? '作業中' : p.done ? '終了' : '新着';
    return `<button class="ochip ${st}" data-w="${w.wid}" data-p="${p.id}" title="ウィンドウ${w.n}: ${esc(p.name)}（${lab}${p.unread ? ' ' + p.unread : ''}）クリックで移動">` +
      `<span class="oc">${p.unread ? (p.unread > 99 ? '99' : p.unread) : esc(ch)}</span>${p.waiting ? '<span class="od"></span>' : p.working ? '<span class="od work"></span>' : p.done ? '<span class="od done"></span>' : ''}</button>`;
  }).join('')).join('');
});
othersEl.onclick = e => { const b = e.target.closest('.ochip'); if (b) mpb.focusOther(Number(b.dataset.w), Number(b.dataset.p)); };
// "saved layout" feedback: the ⧉ button shows a tick for a moment
mpb.onWsSaved(n => { const b = $('#ws-btn'); b.textContent = '✓'; b.classList.add('saved'); b.title = `「${n}」を保存しました`; setTimeout(() => { b.textContent = '⧉'; b.classList.remove('saved'); b.title = 'レイアウト保存・切替（保存したペイン構成をワンクリックで開く）'; }, 1400); });
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

function mk(id) {
  const d = document.createElement('div'); d.className = 'pane entering';
  d.innerHTML = `
  <div class="head" draggable="true">
    <span class="fav"></span>
    <div class="titlebox"><span class="title"></span><input class="url" spellcheck="false" autocomplete="off"></div>
    <span class="meta"></span>
    <span class="badge"></span>
    <div class="tools">
      <button data-a="back" title="戻る (${MOD}[)">‹</button>
      <button data-a="forward" title="進む (${MOD}])">›</button>
      <button data-a="reload" title="再読み込み (${MOD}R)">↻</button>
      <button data-a="maximize" title="最大化 / 元に戻す (${MOD}\\・ダブルクリック)">⤢</button>
      <button data-a="paneMenu" title="名前・色・ミュート・自動リロード・ズームなど">⋯</button>
      <button data-a="sleepToggle" class="slp" title="待機中・終了にスリープ: ON">💤</button>
      <button data-a="close" class="x" title="閉じる (${MOD}W)">✕</button>
    </div>
  </div>
  <div class="sleepph"><div class="sleepid"><div class="sn"></div><div class="sg"></div></div><span class="sp1">💤 スリープ中 — クリックで復帰</span><span class="sp2">✉ 未開封の新着メッセージがあります — クリックで開く</span><span class="sp3">⏳ 読み込み待ち<b class="lpn"></b><button class="lqx" title="このペインの読み込み待ちを取り消す（スリープのまま）">取消</button></span><blockquote class="sleepq"></blockquote><small>終了（1分後）・待機中（30分後）に休止（メモリ節約）。入力途中の文字やリアルタイム更新は復帰まで失われます</small></div>
  <div class="loadph"><span class="lp1">⏳ 読み込み待ち<b class="lpn"></b></span><span class="lp2">読み込みを取り消しました — クリックで読み込む</span><button class="lqx" title="このペインの読み込み待ちを取り消す">取消</button><small>同時に読み込むのは2枚まで。順番が来ると自動で読み込みます</small></div>`;
  d.querySelector('.sleepph').onclick = () => mpb.wakePane(id);
  d.querySelector('.loadph').onclick = () => { if (d.classList.contains('idle')) mpb.wakePane(id); };
  // 取消 of a pane waiting for a load slot (placeholder / sleeping placeholder / header): only the wait ends, the click goes nowhere else
  d.addEventListener('click', e => { if (e.target.closest('.lqx')) { e.stopPropagation(); mpb.loadCancel(id); } }, true);
  d.querySelectorAll('.tools button').forEach(b => b.onclick = e => { e.stopPropagation(); mpb[b.dataset.a](id); });
  const head = d.querySelector('.head'), inp = d.querySelector('.url'), title = d.querySelector('.title');
  head.onmousedown = e => { if (!e.target.closest('button,input')) mpb.focusPane(id); };
  head.ondblclick = e => { if (!e.target.closest('button,input')) mpb.maximize(id); };
  title.onclick = () => startEdit(d);
  inp.onkeydown = e => {
    if (e.key === 'Enter') { mpb.navigate(id, inp.value); inp.blur(); }
    if (e.key === 'Escape') { inp.blur(); }
  };
  inp.onfocus = () => { d.classList.add('editing'); inp.select(); mpb.focusPane(id); };
  inp.onblur = () => d.classList.remove('editing');
  // drag & drop to swap panes
  head.ondragstart = e => { e.dataTransfer.setData('text/x-mpb-pane', String(id)); e.dataTransfer.effectAllowed = 'move'; document.body.classList.add('dragging'); d.classList.add('drag-src'); };
  head.ondragend = () => { document.body.classList.remove('dragging'); d.classList.remove('drag-src'); document.querySelectorAll('.drop-over').forEach(x => x.classList.remove('drop-over')); };
  const accept = e => e.dataTransfer.types.includes('text/x-mpb-pane');
  d.ondragover = e => { if (accept(e)) { e.preventDefault(); d.classList.add('drop-over'); } };
  d.ondragleave = () => d.classList.remove('drop-over');
  d.ondrop = e => { const from = Number(e.dataTransfer.getData('text/x-mpb-pane')); d.classList.remove('drop-over'); if (from && from !== id) mpb.swap(from, id); };
  root.appendChild(d); els.set(id, d);
  requestAnimationFrame(() => requestAnimationFrame(() => d.classList.remove('entering')));
  return d;
}
function startEdit(d) { const inp = d.querySelector('.url'); inp.focus(); }

const copied = new Map();
function flashIcon(c) { const ic = c.querySelector('.cicon'); if (ic) { ic.textContent = '✓'; ic.classList.add('copied'); ic.title = 'リンクをコピーしました'; } }
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
  syncEl.title = s.canSync ? `上下の幅を同期: ${on ? 'ON' : 'OFF'}（クリックで切替／長押しで全行を均等幅に）` : '上下の幅を同期: 2段以上のレイアウトで使えます';
}
syncEl.onmousedown = () => { syncHeld = false; clearTimeout(syncHold); if (!S || !S.canSync) return; syncHold = setTimeout(() => { syncHeld = true; mpb.syncReset(); syncEl.classList.add('pulse'); setTimeout(() => syncEl.classList.remove('pulse'), 700); }, 600); };
syncEl.onmouseup = syncEl.onmouseleave = () => clearTimeout(syncHold);
syncEl.onclick = () => { if (syncHeld || !S || !S.canSync) return; mpb.syncCols(S.syncCols === false); };
const onS = s => {
  S = s;
  renderFavs(s.favorites || []);
  document.body.classList.toggle('light', !s.dark);
  document.body.classList.toggle('has-max', s.maximizedId != null);
  $('#presets').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.k === (s.effLayout || s.layout)));
  const glowN = 0, unreadN = s.panes.filter(p => p.needsReply).length;
  const us = $('#unread-sum');
  us.innerHTML = glowN || unreadN ? `<span class="dot"></span>${glowN ? `新着 ${glowN}ペイン` : `未返信 ${unreadN}`}<kbd>${MOD}J</kbd>` : '';
  us.classList.toggle('show', !!(glowN || unreadN));
  $('#add').disabled = s.panes.length >= s.max;
  $('#reopen').disabled = !s.canReopen; $('#reopen').style.opacity = s.canReopen ? '' : '.4';
  { const w = $('#save-warn'), st = s.store || {}, rec = !!st.status && st.status !== 'ready';
    w.classList.toggle('show', rec || !!st.saveError);
    w.textContent = rec ? '⚠ 構成を復旧' : '⚠ 保存できません';
    w.title = rec ? '構成ファイル（panes.json）を読み込めないため、自動保存を止めています（元のファイルは変更していません）。クリックで復旧方法を選ぶ'
      : `構成を保存できませんでした（${st.saveError}）。表示中の状態はそのままです。前回保存した内容は残っています。クリックで再試行`; }
  { const wb = $('#ws-btn'); if (!wb.classList.contains('saved')) wb.title = s.activeWs ? `レイアウト保存・切替（現在: 「${s.activeWs}」— クリックで上書き保存／新規保存／切替）` : 'レイアウト保存・切替（保存したペイン構成をワンクリックで開く）'; wb.classList.toggle('active-ws', !!s.activeWs); }

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
    c.title = `${p.name || p.title}（ダブルクリックで名前変更・右クリックでメニュー）\n${p.url || '新しいペイン'}${p.muted ? '\n🔕 通知ミュート' : ''}`;
    const n = p.unread || 0;
    const chars = Array.from(String(p.name || p.title || '').trim());
    const first = (chars[0] || '•').toUpperCase();
    const lbl = shortLabel(chars.slice(1).join(''));
    const justCopied = (copied.get(p.id) || 0) > Date.now();
    c.innerHTML = (justCopied ? `<span class="cicon copied" title="リンクをコピーしました">✓</span>` : n >= 1 ? `<span class="cicon ccount${p.glow ? ' hot' : ''}${p.unopened ? ' unop' : ''}" title="クリックでこのタブのリンクをコピー">${n > 99 ? '99' : n}</span>` : `<span class="cicon" title="クリックでこのタブのリンクをコピー">${esc(first)}</span>`) +
      `<span class="clabel">${esc(lbl)}</span>` + (p.sleeping ? (p.unopened ? '<span class="zz" title="スリープ中に新着あり（未開封）">💤✉</span>' : '<span class="zz" title="スリープ中">💤</span>') : '') + (p.waiting ? `<span class="wdot" title="待機中（緑）${lt}"></span>` : p.working ? `<span class="wdot work" title="作業中（赤）${lt}"></span>` : p.done ? `<span class="wdot done" title="終了（紫）${lt}"></span>` : '');
  });

  syncBtn(s);
  // splitters
  const sh = $('#splits'); sh.innerHTML = '';
  (s.splitters || []).forEach(g => {
    const e = document.createElement('div'); e.className = 'splitter ' + g.axis;
    Object.assign(e.style, { left: g.x + 'px', top: g.y + 'px', width: g.w + 'px', height: g.h + 'px' });
    e.title = 'ドラッグでサイズ変更・ダブルクリックで均等に戻す';
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
    d.querySelectorAll('.lpn').forEach(b => { b.textContent = lqWait && p.lqPos ? `（${p.lqPos}番目）` : ''; });
    const lastOnly = p.obs === 'last' && !!(p.waiting || p.working || p.done);
    d.classList.toggle('stale', lastOnly);
    { const sn = d.querySelector('.sleepid .sn'), sg = d.querySelector('.sleepid .sg'); sn.textContent = p.sname || ''; sg.textContent = p.sgroup || ''; sg.style.display = p.sgroup ? '' : 'none'; }
    { const q = d.querySelector('.sleepq'); q.textContent = p.quote || ''; q.classList.toggle('on', !!p.quote); }
    { const sb = d.querySelector('.slp'); sb.classList.toggle('on', p.sleepOn); sb.title = `待機中・終了にスリープ: ${p.sleepOn ? 'ON' : 'OFF'}（クリックで切替）${s.sleepGlobal ? '' : '\n※メニューの自動スリープが全体でOFFです'}`; }
    const color = s.colors[p.color];
    d.style.setProperty('--pc', color || 'transparent');
    d.classList.toggle('colored', !!color);
    d.querySelector('.fav').innerHTML = favHtml(p);
    d.querySelector('.title').innerHTML = p.name ? `<b>${esc(p.name)}</b><span class="sub">${esc(p.title)}</span>` : esc(p.title);
    d.querySelector('.title').title = p.url ? `${p.url}\nクリックでURLを編集 (${MOD}L)` : '';
    const inp = d.querySelector('.url'); if (document.activeElement !== inp) inp.value = p.url;
    inp.placeholder = 'URL・検索語を入力（Grok BotのURLを貼り付けてもOK）';
    const meta = [];
    if (p.sleeping) meta.push(p.unopened ? '<span title="スリープ中に新着メッセージ（未開封）— クリックで開く">💤✉ 未開封</span>' : '<span title="スリープ中（クリックで復帰）">💤</span>');
    if (lqWait && !p.held && !p.sleeping) meta.push(`<span class="lqw" title="同時に読み込むのは2枚まで。順番が来ると自動で読み込みます（それまで表示中のページはそのまま）">⏳ 読み込み待ち${p.lqPos ? ` ${p.lqPos}番目` : ''}</span><button class="lqx" title="この読み込み待ちを取り消す">取消</button>`);
    if (lastOnly) meta.push('<span class="lastok" title="表示中の待機中・作業中・終了は最後に確認できた状態です（再読み込み・移動・返信の生成中などで、今の状態はまだ確認できていません）。確認できるまで自動スリープしません">最終確認</span>');
    if (p.muted) meta.push('<span title="通知ミュート中">🔕</span>');
    if (p.reloadMinutes) meta.push(`<span title="${p.reloadMinutes}分ごとに自動リロード">↻${p.reloadMinutes}m</span>`);
    if (p.zoomIndiv) meta.push(`<span class="zind" title="ズームは個別設定（全体ズームの影響を受けません）">🔍個別 ${Math.round(p.zoom * 100)}%</span>`);
    else if (p.zoom && Math.abs(p.zoom - 1) > 0.01) meta.push(`<span title="全体ズーム">${Math.round(p.zoom * 100)}%</span>`);
    d.querySelector('.meta').innerHTML = meta.join('');
    const b = d.querySelector('.badge');
    b.textContent = p.unread ? (p.unread > 99 ? '99+' : p.unread) : '';
    b.title = p.isGrok ? '自分の最後の送信以降に届いたBotのメッセージ数' : '更新回数';
    b.classList.toggle('quiet', !p.glow);
    b.classList.toggle('wait', !!p.waiting); b.classList.toggle('work', !!p.working); b.classList.toggle('done', !!p.done); b.classList.toggle('unop', !!p.unopened);
    d.querySelector('[data-a=back]').disabled = !p.canBack;
    d.querySelector('[data-a=forward]').disabled = !p.canForward;
    d.querySelector('[data-a=maximize]').textContent = p.id === s.maximizedId ? '⤡' : '⤢';
  }
};
mpb.onState(onS);
const favs = $('#favs');
function renderFavs(list) {
  $('#fav-hint').style.display = list.length ? 'none' : '';
  favs.innerHTML = '';
  list.forEach(f => {
    const b = document.createElement('button');
    b.className = 'fav-btn'; b.draggable = true;
    let host = ''; try { host = new URL(f.url).hostname; } catch {}
    const isBot = /grok\.com$/.test(host) && /\/bot\//.test(f.url);
    b.innerHTML = `<span class="flabel">${esc(shortLabel(f.label || host))}</span>`;
    b.title = `${f.label}\n${f.url}\nクリック: 選択中のペインで開く\n${MOD}クリック: 新しいペイン ／ ⇧クリック: 別ウィンドウ\n右クリック: メニュー（名前変更・削除）／ ドラッグで並べ替え`;
    b.onclick = e => mpb.favOpen(f.id, e.shiftKey ? 'window' : (e.metaKey || e.ctrlKey) ? 'new' : 'here');
    b.onauxclick = e => { if (e.button === 1) mpb.favOpen(f.id, 'new'); };
    b.oncontextmenu = e => { e.preventDefault(); mpb.favMenu(f.id); };
    b.ondragstart = e => { e.dataTransfer.setData('text/x-mpb-fav', String(f.id)); b.classList.add('drag-src'); };
    b.ondragend = () => b.classList.remove('drag-src');
    b.ondragover = e => { if (e.dataTransfer.types.includes('text/x-mpb-fav')) { e.preventDefault(); b.classList.add('drop-over'); } };
    b.ondragleave = () => b.classList.remove('drop-over');
    b.ondrop = e => { b.classList.remove('drop-over'); const from = Number(e.dataTransfer.getData('text/x-mpb-fav')); if (from) { e.preventDefault(); e.stopPropagation(); mpb.favMove(from, f.id); } };
    favs.appendChild(b);
  });
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
mpb.onFocusUrl(id => { const d = els.get(id); if (d) startEdit(d); });
mpb.ready();

// compact mode: tabs show icon only
(function(){
  const KEY='mpb-compact';
  const apply=v=>{document.body.classList.toggle('compact',v);const b=document.getElementById('compact-btn');if(b)b.classList.toggle('active',v);};
  const b=document.createElement('button');
  b.id='compact-btn';b.className='compact-btn';b.textContent='◫';b.title='コンパクトモード（タブをアイコンだけに）  '+(typeof MOD!=='undefined'?MOD:'⌘')+'⇧C';
  const strip=document.getElementById('strip');strip.parentNode.insertBefore(b,strip);
  const toggle=()=>{const v=!document.body.classList.contains('compact');localStorage.setItem(KEY,v?'1':'0');apply(v);};
  b.onclick=toggle;
  window.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.code==='KeyC'){e.preventDefault();toggle();}});
  apply(localStorage.getItem(KEY)==='1');
})();

window.addEventListener('mouseup', () => { if (document.body.classList.contains('splitting')) { document.body.classList.remove('splitting', 'split-c', 'split-r'); mpb.splitEnd(); } });
window.addEventListener('blur', () => { document.body.classList.remove('splitting', 'split-c', 'split-r'); });

// ---- usage readouts: Codex / Claude / Grok. Each pill has its own mode (click cycles), number in a coloured frame. ----
(function(){
  const ICON={
    codex:'<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 6.2l2.4 1.8L5 9.8M8.9 10h2.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    claude:'<svg viewBox="0 0 16 16"><g stroke="#d97757" stroke-width="1.7" stroke-linecap="round"><path d="M8 1.8v12.4M1.8 8h12.4M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8"/></g></svg>',
    grok:'<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.3 10.7l5.4-5.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'};
  const NAME={codex:'Codex',claude:'Claude',grok:'Grok'};
  const MODES={codex:['left','used'],claude:['left','used'],grok:['left','used','today']};
  const seed=localStorage.getItem('mpb-usage-mode')==='used'?'used':'left';
  const R=Math.round, fmt=v=>v>=100?'MAX':String(v).padStart(2,'0');
  document.querySelectorAll('.pill.usage').forEach(btn=>{
    const kind=btn.dataset.kind, KEY='mpb-um-'+kind, modes=MODES[kind];
    const L=window.MPB_ICONS&&window.MPB_ICONS[kind], ico=btn.querySelector('.uico');
    if(L&&L.mask) ico.innerHTML='<span class="mico" style="background:'+(L.color||'currentColor')+';-webkit-mask-image:url('+L.mask+');mask-image:url('+L.mask+')"></span>';
    else if(L&&L.img) ico.innerHTML='<img class="gico" alt="" src="'+L.img+'">';
    else ico.innerHTML=ICON[kind];
    ico.title=NAME[kind];
    let mode=localStorage.getItem(KEY); if(!modes.includes(mode)) mode=seed;
    let last=null, det=null;
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
    const render=()=>{
      const c=calc(), u=btn.querySelector('.uval');
      btn.className='pill usage mode-'+mode+(c?' lv-'+level(mode,c.pct):' err')+(c&&last&&last.stale?' stale':'')+(kind==='claude'&&last&&last.needLogin?' needlogin':'');
      if(!c){u.textContent='--';return;}
      u.textContent=fmt(c.v);
    };
    const load=async force=>{
      try{
        if(kind==='grok'){last=await mpb.usage(force);det=await mpb.usageDetail();}
        else last=await mpb.aiUsage(kind,force);
      }catch(e){last={ok:false,err:String(e),buckets:[]};}
      render();
    };
    let hold=null,held=false,popT=null;
    btn.onmousedown=()=>{held=false;hold=setTimeout(()=>{held=true;btn.classList.add('spin');load(true).then(()=>btn.classList.remove('spin'));},600);};
    btn.onmouseup=()=>clearTimeout(hold);
    btn.onclick=()=>{if(held)return;
      if(kind==='claude'&&last&&last.needLogin){clearTimeout(popT);mpb.usagePopLeave();mpb.claudeAuthDialog().then(()=>{load(true);setTimeout(()=>load(true),20000);});return;}
      mode=modes[(modes.indexOf(mode)+1)%modes.length];localStorage.setItem(KEY,mode);render();if(kind==='grok'&&mode==='today'&&!det)load(false);};
    const curId=()=>{const b=kind==='grok'?null:(last&&last.ok?pickBucket(last.buckets):null);return b?b.id:'';};
    btn.onmouseenter=()=>{clearTimeout(popT);popT=setTimeout(()=>{const r=btn.getBoundingClientRect();mpb.usagePopShow({right:r.right,bottom:r.bottom,kind,sel:curId()});},280);};
    if(kind!=='grok'){
      btn.oncontextmenu=e=>{e.preventDefault();clearTimeout(popT);mpb.usagePopLeave();const go=()=>mpb.usageWinMenu(kind,curId());(last&&last.buckets&&last.buckets.length)?go():load(false).then(go);};
      mpb.onUsageWin((k,id)=>{if(k!==kind)return;selId=id;localStorage.setItem(WKEY,id);render();});
    }
    btn.addEventListener('mouseleave',()=>{clearTimeout(hold);clearTimeout(popT);mpb.usagePopLeave();});
    window.addEventListener('focus',()=>load(false));
    mpb.onUsageUpdated(()=>load(false));
    setInterval(()=>load(kind==='grok'),5*60*1000);
    if(kind==='grok') setInterval(()=>{mpb.usageDetail().then(d=>{det=d;render();}).catch(()=>{});},60000);
    render(); setTimeout(()=>load(kind==='grok'),kind==='grok'?8000:1500); setTimeout(()=>{if(!last||!last.ok)load(kind==='grok');},30000);
  });
})();
