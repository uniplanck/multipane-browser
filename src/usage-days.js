// Day-count helpers for the usage allowance (Asia/Tokyo). The "day" rolls over at 09:00 JST.
const H = 3600000, D = 86400000, JST = 9 * H;
// day number of "today" (rolls at 09:00 JST) == UTC day number of `now`
const todayNum = now => Math.floor(now / D);
const dayKey = now => new Date(todayNum(now) * D).toISOString().slice(0, 10);
const resetWeight = periodEnd => {
  const s = new Date(periodEnd + JST), h = s.getUTCHours() + s.getUTCMinutes() / 60;
  return h < 9 ? 0 : h < 15 ? 0.25 : h < 19 ? 0.5 : 1;
};
const md = n => { const d = new Date(n * D); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
function allowanceDays(now, periodEnd) {
  const t = todayNum(now), r = Math.floor((periodEnd + JST) / D);
  const whole = Math.max(0, r - t), weight = r >= t ? resetWeight(periodEnd) : 0;
  return { whole, weight, days: whole + weight, from: md(t), to: whole > 0 ? md(r - 1) : '' };
}
const floor1 = x => Math.floor(x * 10 + 1e-9) / 10;
const allowance = (left, margin, days) => days > 0 ? floor1(Math.max(0, left - margin) / days) : null;
module.exports = { todayNum, dayKey, resetWeight, allowanceDays, floor1, allowance };
