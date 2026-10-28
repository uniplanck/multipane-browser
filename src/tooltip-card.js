// Shared by the invisible chrome-side measurer and the input-transparent window.
window.TooltipCard = {
  create() {
    const wrap = document.createElement('div'); wrap.className = 'tip-wrap';
    wrap.innerHTML = '<div class="tip-card"><div class="tip-heading"><strong class="tip-name"></strong><kbd class="tip-key"></kbd></div><div class="tip-description"></div><div class="tip-detail"></div></div>';
    return wrap;
  },
  render(wrap, tip) {
    const card = wrap.querySelector('.tip-card');
    card.classList.toggle('light', !tip.dark);
    for (const [selector, value] of [['.tip-name', tip.name], ['.tip-key', tip.key], ['.tip-description', tip.description], ['.tip-detail', tip.detail]]) {
      const node = wrap.querySelector(selector); node.textContent = value || ''; node.hidden = !value;
    }
  },
};
