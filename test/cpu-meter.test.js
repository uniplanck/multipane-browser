// node test/cpu-meter.test.js — pure app / Mac CPU meter math and formatting.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const Cpu = require('../src/cpu-meter');

const times = (user, nice, sys, idle, irq) => ({ user, nice, sys, idle, irq });
const cpus = (...rows) => rows.map(t => ({ model: 'test', speed: 1, times: t }));
const clone = value => JSON.parse(JSON.stringify(value));

// App CPU: Electron's value is per core, so the sum is allowed above 100 and
// must be rounded only after all process values have been added.
assert.strictEqual(Cpu.appCpuPercent([
  { cpu: { percentCPUUsage: 70.4 } },
  { cpu: { percentCPUUsage: 45.4 } },
]), 116);
assert.strictEqual(Cpu.appCpuPercent([
  { cpu: { percentCPUUsage: 40.4 } },
  { cpu: { percentCPUUsage: 40.4 } },
]), 81);
assert.strictEqual(Cpu.appCpuPercent([]), 0);

// Every busy category contributes to the aggregate delta.
assert.strictEqual(Cpu.macCpuPercent(
  cpus(times(10, 20, 30, 40, 50)),
  cpus(times(11, 22, 33, 44, 55)),
), 73);

// Aggregate all cores before taking the ratio; this is a weighted aggregate.
assert.strictEqual(Cpu.macCpuPercent(
  cpus(times(0, 0, 0, 0, 0), times(0, 0, 0, 0, 0)),
  cpus(times(90, 0, 0, 10, 0), times(10, 0, 0, 90, 0)),
), 50);
assert.strictEqual(Cpu.macCpuPercent(
  cpus(times(0, 0, 0, 0, 0), times(0, 0, 0, 0, 0)),
  cpus(times(1, 0, 0, 9, 0), times(90, 0, 0, 10, 0)),
), 83);
assert.strictEqual(Cpu.macCpuPercent(
  cpus(times(0, 0, 0, 0, 0)),
  cpus(times(3, 0, 0, 7, 0)),
), 30);
assert.strictEqual(Cpu.macCpuPercent(
  cpus(times(0, 0, 0, 0, 0)),
  cpus(times(10, 20, 30, 0, 40)),
), 100);
assert.strictEqual(Cpu.macCpuPercent(
  cpus(times(0, 0, 0, 0, 0)),
  cpus(times(0, 0, 0, 10, 0)),
), 0);
assert.strictEqual(Cpu.macCpuPercent(
  cpus(times(0, 0, 0, 0, 0)),
  cpus(times(1, 0, 0, 5, 0)),
), 17);

// No first sample, no elapsed time, rollback, or topology mismatch can produce
// a percentage.
assert.strictEqual(Cpu.macCpuPercent(null, cpus(times(1, 0, 0, 1, 0))), null);
assert.strictEqual(Cpu.macCpuPercent(cpus(times(1, 2, 3, 4, 5)), cpus(times(1, 2, 3, 4, 5))), null);
assert.strictEqual(Cpu.macCpuPercent(cpus(times(5, 2, 3, 4, 5)), cpus(times(4, 2, 3, 4, 5))), null);
assert.strictEqual(Cpu.macCpuPercent(cpus(times(0, 0, 0, 0, 0)), cpus(times(1, 0, 0, 1, 0), times(1, 0, 0, 1, 0))), null);
assert.strictEqual(Cpu.macCpuPercent(cpus(times(0, 0, 0, 0, 0)), cpus(times(1, 0, 0, 1)),), null);

// Inputs are snapshots: calculations must not mutate either one.
{
  const previous = cpus(times(1, 2, 3, 4, 5));
  const current = cpus(times(6, 7, 8, 9, 10));
  const before = clone(previous), after = clone(current);
  Cpu.macCpuPercent(previous, current);
  assert.deepStrictEqual(previous, before);
  assert.deepStrictEqual(current, after);
}

assert.strictEqual(Cpu.formatCpu(55, 99), '55 / 99%');
assert.strictEqual(Cpu.formatCpu(0, 0), '0 / 0%');
assert.strictEqual(Cpu.formatCpu(123.4, 56.6), '123 / 57%');
assert.strictEqual(Cpu.formatCpu(999, 100), '999 / 100%');
assert.strictEqual(Cpu.formatCpu(null, 34), '-- / 34%');
assert.strictEqual(Cpu.formatCpu(55, null), '55 / --%');
assert.strictEqual(Cpu.formatCpu(null, null), '-- / --%');
for (const unavailable of [undefined, NaN, Infinity, -1, '55']) {
  assert.strictEqual(Cpu.formatCpu(unavailable, 34), '-- / 34%');
  assert.strictEqual(Cpu.formatCpu(55, unavailable), '55 / --%');
}

// The browser gets the same API from the plain script, without CommonJS.
{
  const browser = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'cpu-meter.js'), 'utf8'), browser);
  assert.ok(browser.CpuMeter);
  assert.strictEqual(browser.CpuMeter.formatCpu(12, null), '12 / --%');
  assert.strictEqual(browser.CpuMeter.macCpuPercent(
    cpus(times(0, 0, 0, 0, 0)), cpus(times(1, 0, 0, 1, 0)),
  ), 50);
}

console.log('ok  cpu-meter');
