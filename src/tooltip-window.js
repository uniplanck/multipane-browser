const card = TooltipCard.create(); document.body.appendChild(card);
window.tipWindow.onTip(tip => {
  TooltipCard.render(card, tip);
  if (tip.entering) { card.classList.remove('tip-in'); void card.offsetWidth; card.classList.add('tip-in'); }
});
