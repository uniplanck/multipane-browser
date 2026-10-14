const f = document.getElementById('f'), u = document.getElementById('u');
function normalize(v) {
  v = v.trim(); if (!v) return null;
  if (/^[a-z]+:\/\//i.test(v)) return v;
  if (/^[^\s]+\.[^\s]+$/.test(v)) return 'https://' + v;
  return 'https://www.google.com/search?q=' + encodeURIComponent(v);
}
f.onsubmit = e => { e.preventDefault(); const t = normalize(u.value); if (t) location.href = t; };
u.addEventListener('paste', () => setTimeout(() => { if (/^https?:\/\/\S+$/.test(u.value.trim())) f.requestSubmit(); }, 0));
window.addEventListener('focus', () => u.focus());
