// NaoAIへの指示: the result of a send at the bottom centre of the window (main places / hides this window and gives the text: never a URL / key)
const toast = document.getElementById('toast');
window.toastWindow.onToast(m => {
  const o = m && typeof m === 'object' ? m : {};
  document.body.classList.toggle('light', o.dark === false);
  toast.className = 'k-' + (['ok', 'warn', 'err'].includes(o.kind) ? o.kind : 'ok');
  toast.textContent = typeof o.text === 'string' ? o.text : '';
  void toast.offsetWidth; toast.classList.add('in');           // the pop again for every message
});
