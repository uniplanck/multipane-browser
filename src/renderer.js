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
$('#reload-all').onclick = () => mpb.reloadAll();
$('#ws-btn').onclick = () => mpb.wsMenu();
$('#cmdk').onclick = () => mpb.palette();
$('#unread-sum').onclick = () => mpb.run({ type: 'next-unread' });
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
      <button data-a="close" class="x" title="閉じる (${MOD}W)">✕</button>
    </div>
  </div>`;
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

function chip(p) {
  const c = document.createElement('button');
  c.className = 'chip'; c.dataset.id = p.id;
  c.onclick = () => mpb.activatePane(p.id);
  c.ondblclick = () => mpb.renamePane(p.id);
  c.oncontextmenu = e => { e.preventDefault(); mpb.chipMenu(p.id); };
  c.draggable = true;
  c.ondragstart = e => { e.dataTransfer.setData('text/x-mpb-pane', String(p.id)); };
  c.ondragover = e => { if (e.dataTransfer.types.includes('text/x-mpb-pane')) e.preventDefault(); };
  c.ondrop = e => { const from = Number(e.dataTransfer.getData('text/x-mpb-pane')); if (from && from !== p.id) mpb.swap(from, p.id); };
  return c;
}
function favHtml(p) {
  if (p.favicon) return `<img src="${esc(p.favicon)}" alt="" referrerpolicy="no-referrer">`;
  return `<span class="letter">${esc((p.name || p.title || '?').trim().charAt(0).toUpperCase() || '•')}</span>`;
}

mpb.onState(s => {
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
    c.classList.toggle('colored', !!color);
    c.title = `${p.name || p.title}（ダブルクリックで名前変更・右クリックでメニュー）\n${p.url || '新しいペイン'}${p.muted ? '\n🔕 通知ミュート' : ''}`;
    const n = p.unread || 0;
    const chars = Array.from(String(p.name || p.title || '').trim());
    const first = (chars[0] || '•').toUpperCase();
    const lbl = shortLabel(chars.slice(1).join(''));
    c.innerHTML = (n >= 1 ? `<span class="cicon ccount${p.glow ? ' hot' : ''}">${n > 99 ? '99' : n}</span>` : `<span class="cicon">${esc(first)}</span>`) +
      `<span class="clabel">${esc(lbl)}</span>` + (p.waiting ? '<span class="wdot" title="入力待ち"></span>' : '');
  });

  // splitters
  const sh = $('#splits'); sh.innerHTML = '';
  (s.splitters || []).forEach(g => {
    const e = document.createElement('div'); e.className = 'splitter ' + g.axis;
    Object.assign(e.style, { left: g.x + 'px', top: g.y + 'px', width: g.w + 'px', height: g.h + 'px' });
    e.title = 'ドラッグでサイズ変更・ダブルクリックで均等に戻す';
    e.onmousedown = ev => { ev.preventDefault(); document.body.classList.add('splitting', 'split-' + g.axis); mpb.splitStart(g.axis, g.i); };
    e.ondblclick = () => mpb.splitReset(g.axis);
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
    d.classList.toggle('maxed', p.id === s.maximizedId);
    const color = s.colors[p.color];
    d.style.setProperty('--pc', color || 'transparent');
    d.classList.toggle('colored', !!color);
    d.querySelector('.fav').innerHTML = favHtml(p);
    d.querySelector('.title').innerHTML = p.name ? `<b>${esc(p.name)}</b><span class="sub">${esc(p.title)}</span>` : esc(p.title);
    d.querySelector('.title').title = p.url ? `${p.url}\nクリックでURLを編集 (${MOD}L)` : '';
    const inp = d.querySelector('.url'); if (document.activeElement !== inp) inp.value = p.url;
    inp.placeholder = 'URL・検索語を入力（Grok BotのURLを貼り付けてもOK）';
    const meta = [];
    if (p.muted) meta.push('<span title="通知ミュート中">🔕</span>');
    if (p.reloadMinutes) meta.push(`<span title="${p.reloadMinutes}分ごとに自動リロード">↻${p.reloadMinutes}m</span>`);
    if (p.zoom && Math.abs(p.zoom - 1) > 0.01) meta.push(`<span title="ズーム">${Math.round(p.zoom * 100)}%</span>`);
    d.querySelector('.meta').innerHTML = meta.join('');
    const b = d.querySelector('.badge');
    b.textContent = p.unread ? (p.unread > 99 ? '99+' : p.unread) : '';
    b.title = p.isGrok ? '自分の最後の送信以降に届いたBotのメッセージ数' : '更新回数';
    b.classList.toggle('quiet', !p.glow);
    d.querySelector('[data-a=back]').disabled = !p.canBack;
    d.querySelector('[data-a=forward]').disabled = !p.canForward;
    d.querySelector('[data-a=maximize]').textContent = p.id === s.maximizedId ? '⤡' : '⤢';
  }
});
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

// subscription usage readout: number only; click toggles 残(remaining) / 使(used)
(function(){
  const KEY='mpb-usage-mode', btn=document.getElementById('usage');
  let mode=localStorage.getItem(KEY)==='used'?'used':'left', last=null;
  const render=()=>{
    btn.classList.toggle('used',mode==='used'); btn.classList.toggle('left',mode==='left');
    btn.querySelector('.umode').textContent=mode==='used'?'使':'残';
    if(!last||!last.ok){btn.querySelector('.uval').textContent='–';btn.classList.remove('warn');btn.removeAttribute('title');return;}
    const used=Math.round(last.used), left=Math.max(0,100-used), v=mode==='used'?used:left;
    btn.querySelector('.uval').textContent=String(v);
    btn.classList.toggle('warn',left<=10);
    const end=last.periodEnd?new Date(last.periodEnd).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
    btn.removeAttribute('title'); void (mode==='used'?`使用量 ${used}%（残り ${left}%）`:`残量 ${left}%（使用 ${used}%）`)+(end?`\nリセット: ${end}`:'')+`\n更新: ${new Date(last.at).toLocaleTimeString('ja-JP')}\nクリック: 残量／使用量を切替（長押しで再取得）`;
  };
  const load=async force=>{try{last=await mpb.usage(force);}catch(e){last={ok:false,err:String(e)};}render();};
  let hold=null,held=false;
  let popT=null;
  const showPop=()=>{const r=btn.getBoundingClientRect();mpb.usagePopShow({right:r.right,bottom:r.bottom});};
  btn.onmouseenter=()=>{clearTimeout(popT);popT=setTimeout(showPop,280);};
  btn.addEventListener('mouseleave',()=>{clearTimeout(popT);mpb.usagePopLeave();});
  mpb.onUsageUpdated(()=>load(false));
  btn.onmousedown=()=>{held=false;hold=setTimeout(()=>{held=true;btn.classList.add('spin');load(true).then(()=>btn.classList.remove('spin'));},600);};
  btn.onmouseup=()=>clearTimeout(hold); btn.addEventListener('mouseleave',()=>clearTimeout(hold));
  btn.onclick=()=>{if(held)return;mode=mode==='used'?'left':'used';localStorage.setItem(KEY,mode);render();if(!last||!last.ok)load(true);};
  window.addEventListener('focus',()=>load(false));
  setInterval(()=>load(true),5*60*1000);
  render(); setTimeout(()=>load(true),8000); setTimeout(()=>{if(!last||!last.ok)load(true);},25000);
})();
window.addEventListener('mouseup', () => { if (document.body.classList.contains('splitting')) { document.body.classList.remove('splitting', 'split-c', 'split-r'); mpb.splitEnd(); } });
window.addEventListener('blur', () => { document.body.classList.remove('splitting', 'split-c', 'split-r'); });
