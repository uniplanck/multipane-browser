// node test/reopen.test.js — where a reopened pane goes
const { placeReopened } = require('../src/reopen-rules');
let bad = 0; const t = (n, got, rows, index) => { const ok = JSON.stringify(got.rows) === JSON.stringify(rows) && got.index === index; if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n, ok ? '' : JSON.stringify(got)); };
t('back into its own row, same column', placeReopened([3, 2], { row: 1, col: 1, cols: 3 }), [3, 3], 4);
t('first row first column', placeReopened([2, 3], { row: 0, col: 0, cols: 3 }), [3, 3], 0);
t('column clamped to row length', placeReopened([3, 1], { row: 1, col: 2, cols: 3 }), [3, 2], 4);
t('row full -> append to last row with room', placeReopened([3, 2], { row: 0, col: 1, cols: 3 }), [3, 3], 5);
t('row full and last row full -> new row', placeReopened([3, 3], { row: 0, col: 0, cols: 3 }), [3, 3, 1], 6);
t('vanished row comes back at its index', placeReopened([3, 3], { row: 1, col: 0, rowGone: true, cols: 3 }), [3, 1, 3], 3);
t('vanished last row', placeReopened([3], { row: 1, col: 0, rowGone: true, cols: 3 }), [3, 1], 3);
t('no panes left', placeReopened([], { row: 0, col: 0, rowGone: true, cols: 2 }), [1], 0);
t('row index beyond rows -> append', placeReopened([2], { row: 5, col: 0, cols: 2 }), [2, 1], 2);
t('garbage entry is safe', placeReopened([2, 2], {}), [2, 2, 1], 4);
t('no entry is safe', placeReopened([1]), [1, 1], 1);
console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
