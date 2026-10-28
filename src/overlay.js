const $ = s => document.querySelector(s);
const mac = mpb.platform === 'darwin', MOD = mac ? '⌘' : 'Ctrl+';
const q = $('#q'), list = $('#list');
let S = null, mode = 'palette', ctx = {}, items = [], sel = 0;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LAYOUTS = ['2x1', '3x1', '4x1', '2x2', '3x2', '4x2', '3x3', '5x2'];
const looksUrl = v => /^https?:\/\/\S+$/i.test(v) || /^[^\s]+\.[a-z]{2,}(\/\S*)?$/i.test(v);
const grokBot = v => /grok\.com\/bot\/[A-Za-z0-9_-]+/.test(v);
const QCOL = { REPLY: '#ff9f0a', UNOPENED: '#64d2ff', ISSUE: '#ff453a', WAIT: '#30d158' };   // 対応キュー: the dot of each kind
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
  if (mode === 'gbot-rename') return [{ sec: 'Botの表示名（このバーだけ・grok.com は変わりません）', label: v && v !== ctx.orig ? `「${v}」に変更` : `元の名前「${ctx.orig || ''}」に戻す`, icon: '✦', act: { type: 'gbot-rename', id: ctx.id, value: v } }];
  if (mode === 'ws-rename') return [{ sec: `「${ctx.name}」の名前を変更`, label: v ? `「${v}」に変更` : '名前を入力してください', icon: '✎', act: v ? { type: 'ws-rename', name: ctx.name, value: v } : null }];
  if (mode === 'ws-save') return [{ sec: 'ワークスペースを保存', label: v ? `「${v}」として現在のペイン構成を保存` : '名前を入力してください', icon: '⧉', act: v ? { type: 'ws-save', value: v } : null }];
  if (mode === 'recovery') {                     // panes.json unreadable: every choice is confirmed again in main before anything is written
    const r = ctx.recovery || {}, cs = r.candidates || [];
    return [{ sec: '構成ファイル（panes.json）を読み込めません', label: r.why || '読み込めません', sub: '自動保存と構成の読み込みを止めています。元のファイルは変更していません', icon: '⚠', act: null },
      ...(cs.length ? cs.map(c => ({ sec: '読み込める保存世代から復元（新しい順）', label: `${c.atText}（${c.kind === 'prev' ? '保存世代' : '起動時のバックアップ'}）`,
        sub: `ウィンドウ${c.windows}・ペイン${c.panes}・お気に入り${c.favorites}・ワークスペース${c.workspaces}`, icon: '↺', act: { type: 'recovery-restore', id: c.id } }))
        : [{ sec: '読み込める保存世代から復元', label: '復元できる保存世代がありません', icon: '–', act: null }]),
      { sec: 'そのほか', label: '新しい構成で始める（元のファイルは別名で残す）', icon: '＋', act: { type: 'recovery-fresh' } },
      { sec: 'そのほか', label: 'あとで決める（保存は止めたまま・上部の「⚠ 構成を復旧」から再表示）', icon: '✕', act: { type: 'close' } }];
  }
  if (mode === 'diag') {                         // 診断: main builds the rows from fixed codes / numbers only; copying asks again in main
    const d = ctx.diag || {};
    return [{ sec: '操作', label: 'summaryをクリップボードにコピー…', sub: '内容を確認してから・外部には送りません', icon: '📋', act: { type: 'diag-copy' } },
      { sec: '操作', label: d.persist ? 'ファイル保存をオフにする' : 'ファイルにも保存する（userData/diagnostics・2MiB×3・7日）', sub: d.forced ? 'MPB_DEBUG で起動中は設定に関係なく保存します' : d.persist ? '保存済みのファイルは消しません' : '', icon: '💾', act: { type: 'diag-persist', on: !d.persist } },
      { sec: '操作', label: '表示を更新', icon: '↻', act: { type: 'diag-open' } },
      { sec: '操作', label: '閉じる', icon: '✕', act: { type: 'close' } },
      ...(d.rows || []).map(r => ({ sec: r.sec, label: r.label, sub: r.sub, icon: '·', act: null }))];
  }
  if (mode === 'queue') {                        // 対応キュー (#01): main's list as it is now; only ↵ / click sends a choice (pane id + its conversation), checked again in main
    const qs = (S?.queue || []).filter(it => fuzzy(`${it.name} ${it.kja} ${it.why}`, v) > 0), n = {};
    qs.forEach(it => { n[it.kind] = (n[it.kind] || 0) + 1; });
    const note = S?.qNote ? [{ sec: 'お知らせ', label: S.qNote, icon: '⚠', act: null }] : [];
    if (!qs.length) return [...note, { sec: '対応キュー', label: v ? '該当なし' : '対応が必要なペインはありません', icon: '✓', act: null }];
    return [...note, ...qs.map(it => { const sub = [it.why, it.seen, ...(it.also || [])].filter(Boolean).join('・');
      return { sec: `${it.kja}（${n[it.kind]}）`, label: it.name, sub, tip: `${it.name}\n${sub}`, color: QCOL[it.kind] || '', tag: it.sleeping ? '💤' : '', qk: it.key,
        act: { type: 'queue-pick', id: it.id, ref: it.ref } }; })];
  }
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
    ['対応キュー（要返信・未確認の新着・観測異常・待機）', '☰', { type: 'queue-open' }],
    ['フォーカス中のペインを最大化 / 元に戻す', '⤢', { type: 'maximize' }, `${MOD}\\`],
    ['フォーカス中のペインの名前を変更', '✎', { type: 'rename-prompt' }],
    ...(S?.activeWs ? [[`ワークスペース「${S.activeWs}」を上書き保存`, '⧉', { type: 'ws-overwrite', name: S.activeWs }]] : []),
    ['ワークスペースとして新規保存…', '⧉', { type: 'ws-save-prompt' }],
    [S?.approve?.configured ? `${S.approve.label}を開く` : '右上ボタンのBotを設定（未設定）', '✓', { type: 'approve-open' }],
    ['一斉送信（複数のBotに同じメッセージ）…', '📣', { type: 'broadcast-prompt' }, `${MOD}⇧B`],
    ['フォーカス中のペインをお気に入りに追加', '★', { type: 'fav-add-current' }],
    ['新しいウィンドウ', '⧉', { type: 'new-window', url: '' }, `${MOD}N`],
    ['すべてのペインを再読み込み（一括更新）', '↻', { type: 'reload-all' }, `${MOD}⇧R`],
    ['すべての未読をクリア', '✓', { type: 'clear-unread' }],
    ['新しい空のペイン', '＋', { type: 'open-new', url: '' }, `${MOD}T`],
    ...(S?.canReopen ? [['閉じたペインを開き直す（下書き・添付は戻りません）', '↩', { type: 'reopen-closed' }, `${MOD}⇧T`]] : []),   // nothing closed / 10 panes: not offered
    ['Grok を新しいペインで開く', '✦', { type: 'open-new', url: 'https://grok.com/' }],
    ['診断（バージョン・設定・件数・保存状態）', '🩺', { type: 'diag-open' }],
  ];
  LAYOUTS.forEach((k, i) => cmds.push([`レイアウト: ${k.replace('x', '×')}`, '▦', { type: 'layout', layout: k }, `${MOD}${i + 1}`]));
  (S?.workspaces || []).forEach(n => { cmds.push([`ワークスペースを開く: ${n}`, '⧉', { type: 'ws-load', name: n }]); if (n !== S.activeWs) cmds.push([`ワークスペースを上書き保存: ${n}`, '⧉', { type: 'ws-overwrite', name: n, confirm: true }]); cmds.push([`ワークスペースの名前を変更: ${n}`, '✎', { type: 'ws-rename-prompt', name: n }]); cmds.push([`ワークスペースを削除: ${n}`, '🗑', { type: 'ws-delete', name: n }]); });
  cmds.forEach(([label, icon, act, key]) => { if (fuzzy(label, v) > 0) out.push({ sec: 'コマンド', label, icon, act, key }); });
  if (v && !looksUrl(v)) out.push({ sec: '検索', label: `「${v}」をGoogleで検索（新しいペイン）`, icon: '⌕', act: { type: 'open-new', url: v } });
  return out;
}
// 対応キュー: after an update the selection stays on its item (pane id + kind), wherever it moved; gone -> the nearest row that can be chosen
function queueSel(was) {
  const k = was ? items.findIndex(it => it.qk === was) : -1;
  if (k >= 0) return k;
  const i = Math.min(sel, Math.max(0, items.length - 1));
  for (let d = 0; d < items.length; d++) for (const j of [i + d, i - d]) if (items[j] && items[j].act) return j;
  return i;
}
function render() {
  if (mode === 'broadcast') return renderBc();
  const was = mode === 'queue' && items[sel] ? items[sel].qk : '';
  items = build(); sel = mode === 'queue' ? queueSel(was) : Math.min(sel, Math.max(0, items.length - 1));
  let html = '', last = '';
  items.forEach((it, i) => {
    if (it.sec !== last) { html += `<div class="sec">${esc(it.sec)}</div>`; last = it.sec; }
    const ic = it.fav ? `<img src="${esc(it.fav)}" alt="">` : it.color ? `<span class="dot" style="background:${esc(it.color)}"></span>` : esc(it.icon || '•');
    html += `<div class="it${i === sel ? ' sel' : ''}" data-i="${i}" role="option"${it.tip ? ` title="${esc(it.tip)}"` : ''}><span class="ic">${ic}</span>
      <span class="lb">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>
      <span class="rt">${it.tag ? `<span>${esc(it.tag)}</span>` : ''}${it.badge ? `<span class="bd">${it.badge}</span>` : ''}${it.glow ? '<span style="color:var(--glow)">●</span>' : ''}${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</span></div>`;
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
q.oninput = () => { sel = 0; if (mode === 'queue') items = []; render(); };   // 対応キュー: a new search starts on its first row
q.onkeydown = e => {
  if (mode === 'broadcast') return;
  if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
  else if (e.key === 'Enter') { run(sel, e.metaKey || e.ctrlKey); e.preventDefault(); }
  else if (e.key === 'Escape') { mpb.closeOverlay(); e.preventDefault(); }
};
let mxy = '';                                                // 対応キュー: only a real pointer move selects (not the list re-drawn / scrolled under a still pointer)
list.onmousemove = e => { if (mode === 'broadcast') return; const at = `${e.clientX},${e.clientY}`; if (mode === 'queue' && at === mxy) return; mxy = at; const el = e.target.closest('.it'); if (el && Number(el.dataset.i) !== sel) { sel = Number(el.dataset.i); render(); } };
list.onclick = e => { const el = e.target.closest('.it'); if (el) run(Number(el.dataset.i), e.metaKey || e.ctrlKey); };
$('#scrim').onclick = () => mpb.closeOverlay();
function apRect(r) { if (!r) return; const e = $('#apshadow'); Object.assign(e.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' }); }
mpb.onApproveRect(apRect);
addEventListener('keydown', e => { if ((mode === 'approve' || mode === 'approve-settings' || mode === 'update' || mode === 'update-first') && e.key === 'Escape') { mpb.closeOverlay(); e.preventDefault(); } });
mpb.onState(s => { S = s; document.body.classList.toggle('light', !s.dark); if (mode === 'palette' || mode === 'queue') render(); else if (mode === 'broadcast') renderBc(true);
  else if (mode === 'approve-settings') { const source = $('#approve-source'); if (source) source.textContent = approveSource(s.approve?.source); } });
mpb.onOverlayOpen(o => {
  document.body.classList.remove('upop');
  mode = o.mode; ctx = o; sel = 0;
  document.body.classList.toggle('approve', mode === 'approve');
  document.body.classList.toggle('update', mode === 'update' || mode === 'update-first');
  document.body.classList.toggle('approve-settings', mode === 'approve-settings');
  document.body.classList.toggle('diag', mode === 'diag');
  document.body.classList.toggle('queue', mode === 'queue');
  document.body.classList.toggle('bc', mode === 'broadcast');
  items = [];                                                // (#01) nothing kept from the previous screen
  if (mode === 'update' || mode === 'update-first') { document.body.classList.toggle('light', !o.dark); renderUpdate(o); return; }
  if (mode === 'approve-settings') { document.body.classList.toggle('light', !o.dark); renderApproveSettings(o); return; }
  if (mode === 'approve') { apRect(o.rect); return; }
  if (mode === 'broadcast') { bcV = o.bc && o.bc.phase ? o.bc : null; bcWait = false; if (!bcV) { bcSel.clear(); bcText.value = ''; } $('#icon').textContent = '📣'; const b = $('#box'); b.style.animation = 'none'; b.offsetHeight; b.style.animation = ''; renderBc(); setTimeout(() => bcText.focus(), 30); return; }
  document.body.classList.toggle('prompt', mode !== 'palette');
  q.value = o.value || ''; q.readOnly = mode === 'recovery' || mode === 'diag';
  q.placeholder = mode === 'fav-rename' ? 'お気に入りの名前' : mode === 'gbot-rename' ? `表示名（空欄で元の名前「${o.orig || ''}」）` : mode === 'rename' ? 'ペインの名前（空欄でタイトル表示）' : mode === 'ws-save' ? 'ワークスペース名（例: 監視セットA）'
    : mode === 'recovery' ? '構成の復旧（↑↓で選んで ↵・選んだあとに確認があります）' : mode === 'diag' ? '診断（会話・名前・URLは記録していません）'
    : mode === 'queue' ? '対応キュー（↑↓で選んで ↵ でそのペインへ・文字で絞り込み・esc で閉じる）'
    : 'ペイン・コマンドを検索、URLやGrok BotのURLを貼り付け…';
  $('#icon').textContent = mode === 'palette' ? '⌕' : mode === 'recovery' ? '⚠' : mode === 'diag' ? '🩺' : mode === 'queue' ? '☰' : '✎';
  // restart pop animation
  const b = $('#box'); b.style.animation = 'none'; b.offsetHeight; b.style.animation = '';
  render();
  if (mode === 'recovery') { sel = Math.max(0, items.findIndex(it => it.act)); render(); }   // start on the first choice, not the explanation
  q.focus(); q.select();
});

// ---- update settings: main owns all state and operations; this view sends only fixed actions. ----
const updatePanel = $('#update-panel');
const approveSettingsPanel = $('#approve-settings-panel');
const approveSource = source => ({ setting: '設定', environment: '環境変数', default: '既定', unset: '未設定' }[source] || '未設定');
function renderApproveSettings(o) {
  const a = o.approve || {}, source = approveSource(a.source);
  approveSettingsPanel.innerHTML = `<div class="update-head"><span class="update-icon">✓</span><h2>右上ボタンのBot</h2></div>
    <p class="update-copy">右上のボタンで開くGrok Botを設定します。現在の設定元: <b id="approve-source">${esc(source)}</b></p>
    <form id="approve-settings-form" novalidate>
      <label class="approve-field">BotのURL<input id="approve-url" type="text" spellcheck="false" autocomplete="off" placeholder="https://grok.com/bot/…" value="${esc(a.url || '')}"></label>
      <label class="approve-field">表示名（20文字まで）<input id="approve-name" type="text" autocomplete="off" placeholder="空欄なら既定の名前" value="${esc(a.label || '')}"></label>
      <div id="approve-error" role="alert" aria-live="polite"></div>
      <div class="update-actions"><button class="primary" type="submit">保存</button><button type="button" data-approve-action="reset">既定に戻す</button><button type="button" data-approve-action="cancel">キャンセル</button></div>
    </form>`;
  setTimeout(() => approveSettingsPanel.querySelector('#approve-url')?.focus(), 0);
}
approveSettingsPanel.addEventListener('submit', e => {
  e.preventDefault();
  const url = approveSettingsPanel.querySelector('#approve-url').value, label = approveSettingsPanel.querySelector('#approve-name').value;
  const error = approveSettingsPanel.querySelector('#approve-error');
  if (!ApproveSetting.normalizeUrl(url)) { error.textContent = 'https://grok.com/bot/ で始まるBotのURLを入力してください。'; return; }
  if (!ApproveSetting.validLabel(label)) { error.textContent = '表示名は制御文字を含まない20文字以内で入力してください。'; return; }
  error.textContent = '';
  mpb.run({ type: 'approve-save', url, label });
});
approveSettingsPanel.addEventListener('input', () => { const error = approveSettingsPanel.querySelector('#approve-error'); if (error) error.textContent = ''; });
approveSettingsPanel.addEventListener('click', e => {
  const action = e.target.closest('[data-approve-action]')?.dataset.approveAction;
  if (action === 'reset') mpb.run({ type: 'approve-reset' });
  else if (action === 'cancel') mpb.closeOverlay();
});
function renderUpdate(o) {
  const u = o.update || {}, active = document.activeElement?.dataset?.updateAction || '';
  if (mode === 'update-first') {
    updatePanel.innerHTML = `<div class="update-head"><span class="update-icon">↻</span><h2>アップデートの設定</h2></div>
      <p class="update-copy">GitHub の <b>${esc(o.repo || 'このリポジトリ')}</b> から新しい版を確認して更新します。<br>ペイン・下書き・設定・ログインはそのままです。</p>
      <div class="update-actions update-first-actions"><button class="primary" data-update-action="update-choice" data-on="true">自動アップデートをオンにする（おすすめ）</button>
      <button data-update-action="update-choice" data-on="false">オフ（設定からいつでも手動で更新）</button></div>`;
  } else {
    const actions = u.busy ? '' : u.pending ? '<button class="primary" data-update-action="update-restart">今すぐ再起動</button>'
      : u.available ? '<button class="primary" data-update-action="update-start">更新して再起動</button><button data-update-action="update-later">あとで</button>' : '';
    updatePanel.innerHTML = `<div class="update-head"><span class="update-icon">↻</span><h2>アップデート</h2></div>
      <div class="update-card"><div class="caption">インストール中の版</div><div>${esc(u.status || '')}</div></div>
      <label class="update-toggle"><input type="checkbox" id="update-auto" ${u.auto ? 'checked' : ''}><span>自動アップデート<br><small>起動時と6時間ごとに確認し、見つかれば裏で準備して次回の終了時に適用します。</small></span></label>
      <div class="update-card"><div class="caption">前回の確認: ${esc(u.last || 'まだ確認していません')}</div><div>${esc(u.message || '')}</div>${u.progress ? `<div class="detail">${esc(u.progress)}</div>` : ''}
      ${u.unavailable ? '<div class="detail">クローンしたフォルダで npm ci と npm run install:mac を実行してください。</div>' : ''}</div>
      <div class="update-actions"><button class="${actions ? '' : 'primary'}" data-update-action="update-check" ${u.busy ? 'disabled' : ''}>今すぐ確認・更新</button>${actions}</div>`;
  }
  if (!o.refresh) setTimeout(() => updatePanel.querySelector('.primary')?.focus(), 0);
  else if (active) updatePanel.querySelector(`[data-update-action="${active}"]`)?.focus();
}
updatePanel.addEventListener('click', e => {
  const b = e.target.closest('[data-update-action]'); if (!b || b.disabled) return;
  const action = { type: b.dataset.updateAction }; if (action.type === 'update-choice') action.on = b.dataset.on === 'true';
  mpb.run(action);
});
updatePanel.addEventListener('change', e => { if (e.target.id === 'update-auto') mpb.run({ type: 'update-toggle', on: e.target.checked }); });

// ---- broadcast composer (#12): compose -> プレビュー (main reads every chosen pane, nothing is sent) -> 「このN件に送信」 -> progress per target ----
// main builds the preview / progress (bc-state: phase + Japanese labels); this page shows it and sends back only the numbers main gave it.
const bcSel = new Set();
let bcV = null, bcWait = false, bcSentPid = 0, bcClear = false;   // main's view (null: composing), a preview being read, the preview confirmed here, 新しい一斉送信 asked
const bcText = document.createElement('textarea');
bcText.id = 'bc-text'; bcText.placeholder = '送信するメッセージ（⌘↵ で送信先をプレビュー／esc で閉じる）';
$('#inwrap').after(bcText);
const bcFoot = document.createElement('div'); bcFoot.id = 'bc-foot'; $('#box').appendChild(bcFoot);
function grokPanes() { return (S?.panes || []).filter(p => /^https:\/\/grok\.com\//.test(p.url || '')); }
const bcPhase = () => (bcV && bcV.phase) || '';
function renderBc(soft) {
  if (mode !== 'broadcast') return;
  const ph = bcPhase();
  bcText.readOnly = !!ph; document.body.classList.toggle('bcv', !!ph);
  if (ph) { if (!soft) renderBcView(); return; }             // the preview / progress changes only with main's bc-state
  const ps = grokPanes();
  [...bcSel].forEach(id => { if (!ps.some(p => p.id === id)) bcSel.delete(id); });
  list.innerHTML = '<div class="sec">送信先（Grokのペイン）</div>' + (ps.length ? ps.map(p => `<label class="it bci"><input type="checkbox" data-id="${p.id}" ${bcSel.has(p.id) ? 'checked' : ''}><span class="lb">${esc(p.name || p.title)}<small>${esc(p.url)}</small></span><span class="rt">${p.sleeping ? '<span style="color:#64d2ff">💤 スリープ中</span>' : ''}${p.waiting ? '<span style="color:#30d158">● 待機中</span>' : p.working ? '<span style="color:#ff453a">● 作業中</span>' : ''}<kbd>${p.index + 1}</kbd></span></label>`).join('') : '<div class="empty">Grokのペインがありません</div>');
  list.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = () => { const id = Number(cb.dataset.id); cb.checked ? bcSel.add(id) : bcSel.delete(id); bcFootR(); });
  bcFootR();
}
function renderBcView() {
  const v = bcV;
  if (bcText.value !== v.text) bcText.value = v.text;        // exactly the text main holds for this preview / batch
  list.innerHTML = (v.dry ? '<div class="sec bcdry">試験モード（MPB_BROADCAST_DRYRUN）: 実際には入力・送信しません</div>' : '') + `<div class="sec">${esc(v.head)}</div>`
    + (v.err ? `<div class="empty">${esc(v.err)}</div>` : '')
    + v.items.map(it => `<div class="it bcr"><span class="lb">${esc(it.label || '（名前なし）')}<small>${esc(it.conv)}</small>${it.whyJa ? `<small class="why">${esc(it.whyJa)}</small>` : ''}</span><span class="rt"><span class="bst s-${esc(String(it.st).toLowerCase())}">${esc(it.stJa)}</span></span></div>`).join('');
  bcFootR();
}
function bcFootR() {
  const ph = bcPhase(), v = bcV, on = (s, f) => { const e = $(s); if (e) e.onclick = f; };
  if (ph === 'preview') bcFoot.innerHTML = `<button id="bc-back">戻る</button><span class="sp"></span><span>${esc(v.foot)}</span><button id="bc-go" ${v.canSend && bcSentPid !== v.pid ? '' : 'disabled'}>${v.n ? `この${v.n}件に送信` : '送信できる対象がありません'} <kbd>⌘↵</kbd></button>`;
  else if (ph) bcFoot.innerHTML = `${ph === 'run' ? `<button id="bc-cancel" ${v.canCancel ? '' : 'disabled'}>未送信分を取消</button>` : '<button id="bc-new">新しい一斉送信</button>'}<span class="sp"></span><span>${esc(v.foot)}</span><button id="bc-close">閉じる</button>`;
  else {
    const ps = grokPanes();
    bcFoot.innerHTML = `<button id="bc-all">全選択</button><button id="bc-none">選択解除</button><span class="sp"></span><span>${bcSel.size}件を選択</span><button id="bc-go" ${bcSel.size && bcText.value.trim() && !bcWait ? '' : 'disabled'}>${bcWait ? '確認中…' : 'プレビュー'} <kbd>⌘↵</kbd></button>`;
    on('#bc-all', () => { ps.forEach(p => bcSel.add(p.id)); renderBc(); });
    on('#bc-none', () => { bcSel.clear(); renderBc(); });
  }
  on('#bc-go', bcGo);
  on('#bc-back', () => { bcClear = false; mpb.run({ type: 'bc-reset' }); });   // back to the text and the selection
  on('#bc-new', () => { bcClear = true; mpb.run({ type: 'bc-reset' }); });
  on('#bc-cancel', () => mpb.run({ type: 'bc-cancel', bid: v.bid }));
  on('#bc-close', () => mpb.closeOverlay());
}
function bcGo() {
  const ph = bcPhase();
  if (ph === 'preview') { if (!bcV.canSend || bcSentPid === bcV.pid) return; bcSentPid = bcV.pid; bcFootR(); mpb.run({ type: 'bc-send', pid: bcV.pid }); return; }   // once per preview (main also takes it once)
  if (ph) return;
  const t = bcText.value; if (!t.trim() || !bcSel.size || bcWait) return;
  bcWait = true; bcFootR(); mpb.run({ type: 'bc-preview', text: t, ids: [...bcSel] });
}
bcText.oninput = () => { if (!bcPhase()) bcFootR(); };
addEventListener('keydown', e => {                           // ⌘↵ anywhere in the composer: プレビュー / このN件に送信 (a held key repeats: ignored)
  if (mode !== 'broadcast' || e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault(); if (!e.repeat) bcGo();
});
mpb.onBroadcast(v => {
  bcWait = false; bcV = v && v.phase ? v : null;
  if (!bcV && bcClear) { bcSel.clear(); bcText.value = ''; bcClear = false; }
  if (mode === 'broadcast') { renderBc(); if (!bcV) bcText.focus(); }
});

// ---- usage hover popover ----
const up = $('#upop');
const pc = v => { if (v == null || !Number.isFinite(v)) return '-'; const n = Math.round(v); return n >= 100 ? 'MAX' : String(n).padStart(2, '0') + '%'; };
const ri = v => v == null || !Number.isFinite(v) ? '-' : String(Math.round(v));
const f1 = v => v == null || !Number.isFinite(v) ? '-' : (Math.round(v * 10) / 10).toString();
function upRender(d) {
  document.body.classList.add('upop');
  if (!d || !d.ok) { up.innerHTML = `<h4>サブスク使用量</h4><div>取得できません${d && d.err ? `（${esc(d.err)}）` : ''}</div><div class="sm">クリックで再取得</div>`; return upSize(); }
  const rem = d.remD == null ? '-' : `${d.remD}日${d.remH}時間${d.remM}分`;
  up.innerHTML = `<h4>1週間の期限</h4>
    <div class="row"><span>リセット</span><b>${esc(d.endText || '-')}</b></div>
    <div class="row"><span>残り時間</span><b>${esc(rem)}</b></div>
    <hr><div class="row"><span>残り</span><b>${pc(d.left)}</b></div>
    <div class="row"><span>使用</span><b>${pc(d.used)}</b></div>
    <hr><h4>今日使える目安</h4>
    <div class="row"><span>目安</span><b class="big g">${d.allowance == null ? '-' : pc(d.allowance)}</b></div>
    <div class="sm" id="up-formula">= (今日の開始時点の残り ${pc(d.baseLeft)} − 余裕 <input id="up-margin" type="number" min="0" max="50" step="1" value="${d.margin}">%) ÷ ${d.days == null ? '-' : f1(d.days)}日</div>
    <div class="sm">日数 ${d.days == null ? '-' : f1(d.days) + '日'}${d.daysWhole ? ` (${esc(d.daysFrom)}〜${esc(d.daysTo)} + 最終日 ${d.daysWeight})` : ` (最終日 ${d.daysWeight})`}　※毎日9:00に日付が切替</div>
    <div class="row"><span>今日の使用</span><b>${d.usedToday == null ? '-' : pc(d.usedToday)}</b></div>
    <div class="row"><span>今日の残り枠</span><b>${d.allowLeft == null ? '-' : pc(d.allowLeft)}</b></div>
    <div class="sm">${d.baseAt ? `今日の基準（9:00起点）: ${new Date(d.baseAt).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })} 時点の使用量からの増加分` : '今日の基準を取得中'}</div>
    <hr><div class="sm" style="margin:0 0 2px">表示の見方: 数字は2桁（100%はMAX）。<br>塗り＝残り（緑50%以上／黄20〜49%／赤20%未満）、枠線＝使用（緑50%以下／黄〜80%／赤81%以上）、紫の塗り＝今日の残り枠（濃い紫=目安の50%以上／薄い紫=20〜49%／ピンク紫=20%未満）。クリックで切替。</div><div class="sm" style="margin:0">更新: ${esc(d.atText || '-')}</div>`;
  const inp = $('#up-margin');
  inp.oninput = async () => { const v = Number(inp.value); if (inp.value !== '' && v >= 0 && v <= 50) { const n = await mpb.usageMargin(v); upFill(n); } };
  inp.onblur = () => { if (!up.matches(':hover')) mpb.usagePopLeave(); };
  upSize();
}
// update numbers in place while the margin input is being edited
function upFill(d) { const g = up.querySelector('.big'); if (g) g.textContent = d.allowance == null ? '-' : pc(d.allowance); const rows = up.querySelectorAll('.row b'); if (rows[6]) rows[6].textContent = d.allowLeft == null ? '-' : pc(d.allowLeft); }
function upSize() { requestAnimationFrame(() => mpb.usagePopSize(up.offsetHeight + 2)); }
let upKind = 'grok';
const hm = t => new Date(t).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const remain = ms => { const m = Math.max(0, Math.floor(ms / 60000)); const d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60); return d ? `${d}日${h}時間` : h ? `${h}時間${m % 60}分` : `${m}分`; };
// Codex / Claude / Kimi (ai-usage.js view; src: 'local' = the opt-in local sign-in, 'web' = the app's own login, 'none' = not connected) and
// Antigravity (no web usage page: a note and a link). Links are buttons: main opens the provider's fixed page in the default browser
const UNAME = { codex: 'ChatGPT / Codex', claude: 'Claude', kimi: 'Kimi', antigravity: 'Google Antigravity' };
const SRC_JA = { local: k => (k === 'claude' ? 'Claude Code の認証情報（Keychain・ローカル）' : 'Codex CLI の auth.json（ローカル）'), web: k => `${UNAME[k]} のWebログイン（このアプリの使用量表示専用）` };
const uLink = (kind, label) => `<button class="ulink" data-open="${esc(kind)}">${esc(label)} ↗</button>`;
function aiRender(d) {
  document.body.classList.add('upop');
  const name = UNAME[d.kind] || '';
  if (d.kind === 'antigravity') {
    up.innerHTML = `<h4>${name}</h4><div>使用量はWebで公開されていないため、数値は表示しません（ログイン・接続は不要）。</div>` +
      `<div class="sm">使用量は Antigravity IDE の 設定 → Models（CLI では /usage）で確認してください。</div>${uLink('antigravity', 'プランと使用量の案内を開く')}`;
    return upSize();
  }
  const at = d.at ? new Date(d.at).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }) : '-';
  const rows = (d.buckets || []).map(b => {
    const used = Math.round(b.used), left = Math.max(0, 100 - used);
    const shown = !!d.sel && b.id === d.sel;
    return `<div class="row"><span>${shown ? '✓ ' : ''}${esc(b.label)}${shown ? ' <small style="color:#30d158">（表示中）</small>' : ''}</span><b>残り ${pc(left)} ／ 使用 ${pc(used)}</b></div>` +
      `<div class="sm">${b.resetAt ? `リセット ${esc(hm(b.resetAt))}（あと ${esc(remain(b.resetAt - Date.now()))}）` : b.resetText ? esc(b.resetText) : 'リセット時刻なし'}</div>`;
  }).join('');
  const web = d.src === 'web' || d.src === 'none';
  const body = d.ok ? rows
    : d.needConnect ? `<div style="color:#ff9f0a">未接続</div><div class="sm">このゲージをクリックすると ${esc(name)} のログイン用ウィンドウが開きます（通常のWebログイン。このアプリの使用量表示専用の保存領域に保存し、ペインのログインとは別）。ログインできたらそのウィンドウを閉じてください。</div>`
    : d.noNum ? `<div style="color:#ff9f0a">接続済み・数値を読めません</div><div class="sm">使用量ページの表示から %（使用 / 残り）を読み取れませんでした。推定した数値は出しません。</div>`
    : d.needLogin && d.src === 'web' ? `<div style="color:#ff9f0a">${esc(d.err || 'ログインが必要です')}</div><div class="sm">このゲージをクリックすると、ログイン用のウィンドウが開きます。</div>`
    : d.relogin ? `<div style="color:#ff9f0a">Terminalで /login が必要</div><div class="sm">このピルをクリックして「ターミナルでログイン」を選び、ターミナルで /login を入力し、ブラウザで承認してください。</div>`
    : d.needLogin ? `<div style="color:#ff9f0a">Claudeの認証が切れています</div><div class="sm">このピルをクリックすると、再認証のダイアログが開きます。</div>`
    : `<div style="color:#ff9f0a">取得できません: ${esc(d.err || '')}</div>` + (rows ? `<div class="sm">（前回の値）</div>` + rows : '');
  up.innerHTML = `<h4>${esc(name)} 使用量</h4>` + (d.stale ? `<div class="sm" style="color:#ff9f0a">${esc(d.err || '')}（更新: ${esc(at)}）</div>` : '') + body +
    (web && !d.ok && !d.needConnect ? uLink(d.kind, '使用量ページを開く') : '') +
    `<hr><div class="sm" style="margin:0 0 2px">右クリックで表示する枠・接続・切断。表示の見方: 数字は2桁（100%はMAX）。塗り＝残り（緑50%以上／黄20〜49%／赤20%未満）、枠線＝使用（緑50%以下／黄〜80%／赤81%以上）。クリックで切替。</div>` +
    (SRC_JA[d.src] ? `<div class="sm" style="margin:0 0 2px">取得元: ${esc(SRC_JA[d.src](d.kind))}</div>` : '') + `<div class="sm" style="margin:0">更新: ${esc(at)}　長押しで再取得</div>`;
  upSize();
}
up.addEventListener('click', e => { const b = e.target && e.target.closest ? e.target.closest('[data-open]') : null; if (b) { e.preventDefault(); mpb.usageOpen(b.dataset.open); } });
mpb.onUsagePop(d => { document.body.classList.remove('approve'); if (document.activeElement && document.activeElement.id === 'up-margin') return; upKind = d.kind || 'grok'; if (upKind === 'grok') upRender(d); else aiRender(d); });
up.addEventListener('mouseenter', () => mpb.usagePopKeep());
document.documentElement.addEventListener('mouseleave', () => { if (document.activeElement && document.activeElement.id === 'up-margin') return; mpb.usagePopLeave(); });
mpb.onUsageUpdated(() => { if (document.body.classList.contains('upop') && upKind === 'grok') mpb.usage(false).then(() => mpb.usageMargin(Number.NaN)).then(upRender).catch(() => {}); });
