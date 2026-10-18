// Pure placement rule for "閉じたペインを開き直す" (unit-tested in test/reopen.test.js).
// rows = current row lengths; e = { row, col, rowGone, cols } recorded when the pane was closed
// (row/col = where it sat, rowGone = its row disappeared because it was the only pane, cols = widest row at that time).
// Returns { rows, index }: the new row lengths and the index in the row-major panes[] array to insert at.
function placeReopened(rows, e) {
  const R = rows.slice(), cols = Math.max(Number(e && e.cols) || 1, 1, ...R);
  const row = Math.max(0, Number(e && e.row) || 0), col = Math.max(0, Number(e && e.col) || 0);
  let r, c;
  if (e && e.rowGone) { r = Math.min(row, R.length); R.splice(r, 0, 1); c = 0; }                  // its row vanished: bring the row back where it was
  else if (row < R.length && R[row] < cols) { r = row; c = Math.min(col, R[r]); R[r]++; }        // its own row has room
  else if (R.length && R[R.length - 1] < cols) { r = R.length - 1; c = R[r]; R[r]++; }           // else append to the last row if it has room
  else { R.push(1); r = R.length - 1; c = 0; }                                                    // else a new row at the end
  let index = c; for (let i = 0; i < r; i++) index += R[i];
  return { rows: R, index };
}
module.exports = { placeReopened };
