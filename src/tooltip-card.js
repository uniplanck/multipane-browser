// Shared by the invisible chrome-side measurer and the input-transparent window.
window.TooltipCard = {
  create() {
    const wrap = document.createElement('div'); wrap.className = 'tip-wrap';
    wrap.innerHTML = '<div class="tip-card"><div class="tip-heading"><strong class="tip-name"></strong><kbd class="tip-key"></kbd></div><div class="tip-description"></div><div class="tip-detail"></div><div class="tip-list" hidden></div></div>';
    return wrap;
  },
  render(wrap, tip) {
    const card = wrap.querySelector('.tip-card');
    card.classList.toggle('light', !tip.dark);
    for (const [selector, value] of [['.tip-name', tip.name], ['.tip-key', tip.key], ['.tip-description', tip.description], ['.tip-detail', tip.detail]]) {
      const node = wrap.querySelector(selector); node.textContent = value || ''; node.hidden = !value;
    }
    const list = wrap.querySelector('.tip-list');
    list.replaceChildren();
    const data = TooltipList.validList(tip.list) ? tip.list : null;
    list.hidden = !data || (!data.rows.length && !data.more);
    if (!data) return;
    for (const item of data.rows) {
      const row = document.createElement('div'); row.className = 'tip-row';
      const avatar = document.createElement('span'); avatar.className = 'tip-avatar';
      avatar.textContent = (Array.from(item.name.trim())[0] || '•').toUpperCase();
      if (item.image) {
        const img = document.createElement('img'); img.alt = ''; img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => img.remove(), { once: true }); img.src = item.image; avatar.appendChild(img);
      }
      const name = document.createElement('span'); name.className = 'tip-row-name'; name.textContent = item.name;
      const kind = document.createElement('span'); kind.className = 'tip-row-kind'; kind.textContent = item.kind;
      row.append(avatar, name, kind); list.appendChild(row);
    }
    if (data.more) { const more = document.createElement('div'); more.className = 'tip-more'; more.textContent = `…ほか ${data.more}件`; list.appendChild(more); }
  },
};
