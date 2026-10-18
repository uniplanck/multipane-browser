// Startup safety net for panes.json: keep the last few distinct versions next to it (panes.json.YYYYMMDD-HHMMSS.bak),
// so a bad restore / overwrite can always be undone. Pure fs helper, unit-tested in test/state-backup.test.js.
const fs = require('fs'), path = require('path');
const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
function rotateBackup(file, keep = 5, now = new Date()) {
  if (!fs.existsSync(file)) return null;
  const dir = path.dirname(file), base = path.basename(file);
  const cur = fs.readFileSync(file);
  const list = fs.readdirSync(dir).filter(n => n.startsWith(base + '.') && n.endsWith('.bak')).sort();
  if (list.length && fs.readFileSync(path.join(dir, list[list.length - 1])).equals(cur)) return null;   // unchanged since the last backup
  const name = `${base}.${stamp(now)}.bak`;
  fs.writeFileSync(path.join(dir, name), cur);
  list.concat(name).sort().slice(0, Math.max(0, list.length + 1 - keep)).forEach(n => { try { fs.unlinkSync(path.join(dir, n)); } catch {} });
  return name;
}
module.exports = { rotateBackup, stamp };
