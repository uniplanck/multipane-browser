const $ = s => document.querySelector(s);
const mac = mpb.platform === 'darwin', MOD = mac ? '⌘' : 'Ctrl+';
const q = $('#q'), list = $('#list');
let S = null, mode = 'palette', ctx = {}, items = [], sel = 0;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LAYOUTS = ['2x1', '3x1', '4x1', '2x2', '3x2', '4x2', '3x3', '5x2'];
const looksUrl = v => /^https?:\/\/\S+$/i.test(v) || /^[^\s]+\.[a-z]{2,}(\/\S*)?$/i.test(v);
const grokBot = v => /grok\.com\/bot\/[A-Za-z0-9_-]+/.test(v);
function fuzzy(text, query) {
  if (!query) return 1;
  text = text.toLowerCase(); query = query.toLowerCase();
  if (text.includes(query)) return 100 - text.indexOf(query);
  let i = 0; for (const ch of text) if (ch === query[i]) i++;
  return i === query.length ? 10 : 0;
}
function build() {
  const v = q.value.trim(), out = [];
  if (mode === 'rename') return [{ sec: 'ペインの名前', label: v ? `「${v}」に変更` : '名前を消す（ページのタイトルを表示）', icon: '✎', act: { type: 'rename', id: ctx.id, value: v } }];
  if (mode === 'fav-rename') return [{ sec: 'お気に入りの名前', label: v ? `「${v}」に変更` : '名前を入力してください', icon: '★', act: v ? { type: 'fav-rename', id: ctx.id, value: v } : null }];
  if (mode === 'ws-rename') return [{ sec: `「${ctx.name}」の名前を変更`, label: v ? `「${v}」に変更` : '名前を入力してください', icon: '✎', act: v ? { type: 'ws-rename', name: ctx.name, value: v } : null }];
  if (mode === 'ws-save') return [{ sec: 'ワークスペースを保存', label: v ? `「${v}」として現在のペイン構成を保存` : '名前を入力してください', icon: '⧉', act: v ? { type: 'ws-save', value: v } : null }];
  if (v && looksUrl(v)) {
    const g = grokBot(v);
    out.push({ sec: '開く', label: `${g ? 'Grok Botを' : ''}新しいペインで開く`, sub: v, icon: g ? '✦' : '＋', act: { type: 'open-new', url: v }, key: `${MOD}↵` });
    out.push({ sec: '開く', label: 'このペインで開く', sub: v, icon: '↗', act: { type: 'open-here', url: v } });
    out.push({ sec: '開く', label: '別ウィンドウで開く', sub: v, icon: '⧉', act: { type: 'new-window', url: v } });
    out.push({ sec: '開く', label: 'お気に入りに追加', sub: v, icon: '★', act: { type: 'fav-add', url: v } });
  } else if (!v && ctx.clipboardUrl) {
    const g = grokBot(ctx.clipboardUrl);
    out.push({ sec: 'クリップボード', label: g ? 'コピーしたGrok Botを新しいペインで開く' : 'コピーしたURLを新しいペインで開く', sub: ctx.clipboardUrl, icon: g ? '✦' : '📋', act: { type: 'open-new', url: ctx.clipboardUrl } });
    out.push({ sec: 'クリップボード', label: 'コピーしたURLをお気に入りに追加', sub: ctx.clipboardUrl, icon: '★', act: { type: 'fav-add', url: ctx.clipboardUrl } });
  }
  (S?.favorites || []).filter(f => fuzzy(`${f.label} ${f.url}`, v) > 0).forEach(f =>
    out.push({ sec: 'お気に入り（↵ 選択中のペイン / ⌘↵ 新しいペイン）', label: f.label, sub: f.url, icon: /grok\.com\/bot\//.test(f.url) ? '✦' : '★', act: { type: 'fav-open', id: f.id, where: 'here' }, alt: { type: 'fav-open', id: f.id, where: 'new' } }));
  const panes = (S?.panes || []).map(p => ({ p, score: fuzzy(`${p.name} ${p.title} ${p.url} ${p.index + 1}`, v) })).filter(x => x.score > 0);
  panes.sort((a, b) => (b.p.glow - a.p.glow) || (v ? b.score - a.score : a.p.index - b.p.index));
  panes.forEach(({ p }) => out.push({ sec: 'ペイン', label: p.name || p.title, sub: p.name ? p.title : (p.url || ''), fav: p.favicon, color: S.colors[p.color],
    badge: p.unread, glow: p.glow, key: `${p.index + 1}`, act: { type: 'focus', id: p.id } }));
  const cmds = [
    ['次の未読ペインへ', '●', { type: 'next-unread' }, `${MOD}J`],
    ['フォーカス中のペインを最大化 / 元に戻す', '⤢', { type: 'maximize' }, `${MOD}\\`],
    ['フォーカス中のペインの名前を変更', '✎', { type: 'rename-prompt' }],
    ['ワークスペースとして保存…', '⧉', { type: 'ws-save-prompt' }],
    ['一斉送信（複数のBotに同じメッセージ）…', '📣', { type: 'broadcast-prompt' }, `${MOD}⇧B`],
    ['フォーカス中のペインをお気に入りに追加', '★', { type: 'fav-add-current' }],
    ['新しいウィンドウ', '⧉', { type: 'new-window', url: '' }, `${MOD}N`],
    ['すべてのペインを再読み込み（一括更新）', '↻', { type: 'reload-all' }, `${MOD}⇧R`],
    ['すべての未読をクリア', '✓', { type: 'clear-unread' }],
    ['新しい空のペイン', '＋', { type: 'open-new', url: '' }, `${MOD}T`],
    ['Grok を新しいペインで開く', '✦', { type: 'open-new', url: 'https://grok.com/' }],
  ];
  LAYOUTS.forEach((k, i) => cmds.push([`レイアウト: ${k.replace('x', '×')}`, '▦', { type: 'layout', layout: k }, `${MOD}${i + 1}`]));
  (S?.workspaces || []).forEach(n => { cmds.push([`ワークスペースを開く: ${n}`, '⧉', { type: 'ws-load', name: n }]); cmds.push([`ワークスペースの名前を変更: ${n}`, '✎', { type: 'ws-rename-prompt', name: n }]); cmds.push([`ワークスペースを削除: ${n}`, '🗑', { type: 'ws-delete', name: n }]); });
  cmds.forEach(([label, icon, act, key]) => { if (fuzzy(label, v) > 0) out.push({ sec: 'コマンド', label, icon, act, key }); });
  if (v && !looksUrl(v)) out.push({ sec: '検索', label: `「${v}」をGoogleで検索（新しいペイン）`, icon: '⌕', act: { type: 'open-new', url: v } });
  return out;
}
function render() {
  if (mode === 'broadcast') return renderBc();
  items = build(); sel = Math.min(sel, Math.max(0, items.length - 1));
  let html = '', last = '';
  items.forEach((it, i) => {
    if (it.sec !== last) { html += `<div class="sec">${esc(it.sec)}</div>`; last = it.sec; }
    const ic = it.fav ? `<img src="${esc(it.fav)}" alt="">` : it.color ? `<span class="dot" style="background:${esc(it.color)}"></span>` : esc(it.icon || '•');
    html += `<div class="it${i === sel ? ' sel' : ''}" data-i="${i}" role="option"><span class="ic">${ic}</span>
      <span class="lb">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>
      <span class="rt">${it.badge ? `<span class="bd">${it.badge}</span>` : ''}${it.glow ? '<span style="color:var(--glow)">●</span>' : ''}${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</span></div>`;
  });
  list.innerHTML = html || '<div class="empty">該当なし</div>';
  list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}
function run(i, alt) {
  const it = items[i]; if (!it || !it.act) return;
  let act = it.act;
  if (alt && act.type === 'open-here') act = { ...act, type: 'open-new' };
  if (alt && it.alt) act = it.alt;
  mpb.run(act);
  if (act.type === 'ws-delete') render();
}
q.oninput = () => { sel = 0; render(); };
q.onkeydown = e => {
  if (mode === 'broadcast') return;
  if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
  else if (e.key === 'Enter') { run(sel, e.metaKey || e.ctrlKey); e.preventDefault(); }
  else if (e.key === 'Escape') { mpb.closeOverlay(); e.preventDefault(); }
};
list.onmousemove = e => { if (mode === 'broadcast') return; const el = e.target.closest('.it'); if (el && Number(el.dataset.i) !== sel) { sel = Number(el.dataset.i); render(); } };
list.onclick = e => { const el = e.target.closest('.it'); if (el) run(Number(el.dataset.i), e.metaKey || e.ctrlKey); };
$('#scrim').onclick = () => mpb.closeOverlay();
mpb.onState(s => { S = s; document.body.classList.toggle('light', !s.dark); if (mode === 'palette') render(); else if (mode === 'broadcast') renderBc(true); });
mpb.onOverlayOpen(o => {
  document.body.classList.remove('upop');
  mode = o.mode; ctx = o; sel = 0;
  document.body.classList.toggle('bc', mode === 'broadcast');
  if (mode === 'broadcast') { bcSel.clear(); bcText.value = ''; $('#icon').textContent = '📣'; const b = $('#box'); b.style.animation = 'none'; b.offsetHeight; b.style.animation = ''; renderBc(); setTimeout(() => bcText.focus(), 30); return; }
  document.body.classList.toggle('prompt', mode !== 'palette');
  q.value = o.value || '';
  q.placeholder = mode === 'fav-rename' ? 'お気に入りの名前' : mode === 'rename' ? 'ペインの名前（空欄でタイトル表示）' : mode === 'ws-save' ? 'ワークスペース名（例: 監視セットA）'
    : 'ペイン・コマンドを検索、URLやGrok BotのURLを貼り付け…';
  $('#icon').textContent = mode === 'palette' ? '⌕' : '✎';
  // restart pop animation
  const b = $('#box'); b.style.animation = 'none'; b.offsetHeight; b.style.animation = '';
  render(); q.focus(); q.select();
});

// ---- broadcast composer ----
const bcSel = new Set();
const bcText = document.createElement('textarea');
bcText.id = 'bc-text'; bcText.placeholder = '送信するメッセージ（⌘↵ でチェックしたペインに送信／esc で閉じる）';
$('#inwrap').after(bcText);
const bcFoot = document.createElement('div'); bcFoot.id = 'bc-foot'; $('#box').appendChild(bcFoot);
function grokPanes() { return (S?.panes || []).filter(p => /^https:\/\/grok\.com\//.test(p.url || '')); }
function renderBc(soft) {
  if (mode !== 'broadcast') return;
  const ps = grokPanes();
  [...bcSel].forEach(id => { if (!ps.some(p => p.id === id)) bcSel.delete(id); });
  list.innerHTML = '<div class="sec">送信先（Grokのペイン）</div>' + (ps.length ? ps.map(p => `<label class="it bci"><input type="checkbox" data-id="${p.id}" ${bcSel.has(p.id) ? 'checked' : ''}><span class="lb">${esc(p.name || p.title)}<small>${esc(p.url)}</small></span><span class="rt">${p.waiting ? '<span style="color:#30d158">● 入力待ち</span>' : ''}<kbd>${p.index + 1}</kbd></span></label>`).join('') : '<div class="empty">Grokのペインがありません</div>');
  list.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = () => { const id = Number(cb.dataset.id); cb.checked ? bcSel.add(id) : bcSel.delete(id); bcFootR(); });
  bcFootR();
}
function bcFootR() {
  const ps = grokPanes();
  bcFoot.innerHTML = `<button id="bc-all">全選択</button><button id="bc-none">選択解除</button><span class="sp"></span><span>${bcSel.size}件に送信</span><button id="bc-go" ${bcSel.size && bcText.value.trim() ? '' : 'disabled'}>送信 <kbd>⌘↵</kbd></button>`;
  $('#bc-all').onclick = () => { ps.forEach(p => bcSel.add(p.id)); renderBc(); };
  $('#bc-none').onclick = () => { bcSel.clear(); renderBc(); };
  $('#bc-go').onclick = bcGo;
}
function bcGo() { const t = bcText.value; if (!t.trim() || !bcSel.size) return; mpb.run({ type: 'broadcast', text: t, ids: [...bcSel] }); }
bcText.oninput = bcFootR;
bcText.onkeydown = e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); bcGo(); }
  else if (e.key === 'Escape') { e.preventDefault(); mpb.closeOverlay(); }
};

// ---- usage hover popover ----
const up = $('#upop');
const f1 = v => v == null || !Number.isFinite(v) ? '-' : (Math.round(v * 10) / 10).toString();
function upRender(d) {
  document.body.classList.add('upop');
  if (!d || !d.ok) { up.innerHTML = `<h4>サブスク使用量</h4><div>取得できません${d && d.err ? `（${esc(d.err)}）` : ''}</div><div class="sm">クリックで再取得</div>`; return upSize(); }
  const rem = d.remD == null ? '-' : `${d.remD}日${d.remH}時間${d.remM}分`;
  up.innerHTML = `<h4>1週間の期限</h4>
    <div class="row"><span>リセット</span><b>${esc(d.endText || '-')}</b></div>
    <div class="row"><span>残り時間</span><b>${esc(rem)}</b></div>
    <hr><div class="row"><span>残り</span><b>${f1(d.left)}%</b></div>
    <div class="row"><span>使用</span><b>${f1(d.used)}%</b></div>
    <hr><h4>今日使える目安</h4>
    <div class="row"><span>目安</span><b class="big g">${d.allowance == null ? '-' : f1(d.allowance) + '%'}</b></div>
    <div class="sm" id="up-formula">= (残り ${f1(d.left)}% − 余裕 <input id="up-margin" type="number" min="0" max="50" step="1" value="${d.margin}">%) ÷ ${d.days == null ? '-' : f1(d.days)}日</div>
    <div class="sm">日数 ${d.days == null ? '-' : f1(d.days) + '日'}${d.daysWhole ? ` (${esc(d.daysFrom)}〜${esc(d.daysTo)} + 最終日 ${d.daysWeight})` : ` (最終日 ${d.daysWeight})`}　※毎日9:00に日付が切替</div>
    <div class="row"><span>今日の使用</span><b>${d.usedToday == null ? '-' : f1(d.usedToday) + '%'}</b></div>
    <div class="row"><span>今日の残り枠</span><b>${d.allowLeft == null ? '-' : f1(d.allowLeft) + '%'}</b></div>
    <div class="sm">${d.baseAt ? `今日の基準（9:00起点）: ${new Date(d.baseAt).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })} 時点の使用量からの増加分` : '今日の基準を取得中'}</div>
    <hr><div class="sm" style="margin:0">更新: ${esc(d.atText || '-')}</div>`;
  const inp = $('#up-margin');
  inp.oninput = async () => { const v = Number(inp.value); if (inp.value !== '' && v >= 0 && v <= 50) { const n = await mpb.usageMargin(v); upFill(n); } };
  inp.onblur = () => { if (!up.matches(':hover')) mpb.usagePopLeave(); };
  upSize();
}
// update numbers in place while the margin input is being edited
function upFill(d) { const g = up.querySelector('.big'); if (g) g.textContent = d.allowance == null ? '-' : f1(d.allowance) + '%'; const rows = up.querySelectorAll('.row b'); if (rows[6]) rows[6].textContent = d.allowLeft == null ? '-' : f1(d.allowLeft) + '%'; }
function upSize() { requestAnimationFrame(() => mpb.usagePopSize(up.offsetHeight + 2)); }
mpb.onUsagePop(d => { if (document.activeElement && document.activeElement.id === 'up-margin') return; upRender(d); });
up.addEventListener('mouseenter', () => mpb.usagePopKeep());
document.documentElement.addEventListener('mouseleave', () => { if (document.activeElement && document.activeElement.id === 'up-margin') return; mpb.usagePopLeave(); });
mpb.onUsageUpdated(() => { if (document.body.classList.contains('upop')) mpb.usage(false).then(() => mpb.usageMargin(Number.NaN)).then(upRender).catch(() => {}); });
