// Pure CPU meter math shared by the Electron main process and the renderer.
// The browser loads this file as a plain script; CommonJS keeps the same API
// available to the node tests and to main.js.
const CpuMeter = (() => {
  const TIMES = ['user', 'nice', 'sys', 'idle', 'irq'];

  const finite = n => typeof n === 'number' && Number.isFinite(n);

  // Electron reports percentCPUUsage as a percentage of one core. Keep that
  // meaning when adding processes, so a busy multi-process app may exceed 100.
  function appCpuPercent(metrics) {
    if (!Array.isArray(metrics)) return null;
    let sum = 0, seen = false;
    for (const metric of metrics) {
      const value = metric && metric.cpu && metric.cpu.percentCPUUsage;
      if (value === undefined || value === null) continue;
      if (!finite(value) || value < 0) return null;
      sum += value;
      seen = true;
    }
    return seen || metrics.length === 0 ? Math.round(sum) : null;
  }

  const sample = cpu => {
    if (!cpu || typeof cpu !== 'object' || !cpu.times || typeof cpu.times !== 'object') return null;
    const times = {};
    for (const key of TIMES) {
      if (!finite(cpu.times[key]) || cpu.times[key] < 0) return null;
      times[key] = cpu.times[key];
    }
    return times;
  };

  // os.cpus() has one times object per logical core. Aggregate deltas first,
  // then calculate the ratio so cores with different elapsed times are weighted
  // by their actual counter deltas.
  function macCpuPercent(previous, current) {
    if (!Array.isArray(previous) || !Array.isArray(current) || previous.length === 0 || previous.length !== current.length) return null;
    let busy = 0, idle = 0;
    for (let i = 0; i < current.length; i++) {
      const before = sample(previous[i]), after = sample(current[i]);
      if (!before || !after) return null;
      for (const key of TIMES) {
        const delta = after[key] - before[key];
        if (!finite(delta) || delta < 0) return null;
        if (key === 'idle') idle += delta;
        else busy += delta;
      }
    }
    const total = busy + idle;
    if (!(total > 0)) return null;
    return Math.max(0, Math.min(100, Math.round((busy * 100) / total)));
  }

  const formatValue = value => finite(value) && value >= 0 ? `${Math.round(value)}` : '--';

  // The first system sample has no meaningful Mac delta; keep the app side
  // visible while representing only the unavailable side with a placeholder.
  function formatCpu(appCpu, macCpu) {
    return `${formatValue(appCpu)} / ${formatValue(macCpu)}%`;
  }

  return { appCpuPercent, macCpuPercent, formatCpu };
})();

if (typeof globalThis === 'object') globalThis.CpuMeter = CpuMeter;
if (typeof module === 'object' && module.exports) module.exports = CpuMeter;
