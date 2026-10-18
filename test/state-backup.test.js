// node test/state-backup.test.js
const fs = require('fs'), os = require('os'), path = require('path');
const { rotateBackup } = require('../src/state-backup');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-bak-')), f = path.join(dir, 'panes.json');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const baks = () => fs.readdirSync(dir).filter(n => n.endsWith('.bak')).sort();
t('missing file -> nothing', rotateBackup(f) === null && baks().length === 0);
fs.writeFileSync(f, 'A'); const a = rotateBackup(f, 3, new Date(2026, 9, 18, 10, 0, 0));
t('first backup created', a === 'panes.json.20261018-100000.bak' && baks().length === 1);
t('unchanged -> no new backup', rotateBackup(f, 3, new Date(2026, 9, 18, 10, 0, 5)) === null && baks().length === 1);
fs.writeFileSync(f, 'B'); rotateBackup(f, 3, new Date(2026, 9, 18, 11, 0, 0));
fs.writeFileSync(f, 'C'); rotateBackup(f, 3, new Date(2026, 9, 18, 12, 0, 0));
fs.writeFileSync(f, 'D'); rotateBackup(f, 3, new Date(2026, 9, 18, 13, 0, 0));
t('keeps only the newest 3', baks().length === 3 && baks()[0].includes('110000'));
t('newest backup holds the current content', fs.readFileSync(path.join(dir, baks()[2]), 'utf8') === 'D');
t('oldest content (A) is gone, B is kept', !baks().some(n => fs.readFileSync(path.join(dir, n), 'utf8') === 'A') && baks().some(n => fs.readFileSync(path.join(dir, n), 'utf8') === 'B'));
fs.rmSync(dir, { recursive: true });
console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
