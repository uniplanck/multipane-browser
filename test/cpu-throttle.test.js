// node test/cpu-throttle.test.js — no DevTools CPU throttling of panes (the old 省電力 / settings.ecoMode: Emulation.setCPUThrottlingRate 2 on
// every unfocused pane, re-applied every 5 s). Its throttler kept stopping and resuming each throttled renderer's main thread (~40% CPU per pane),
// sleeping about:blank panes included. Contract with src/*.js: no rate above 1, no Emulation command, no wc.debugger, panes keep Chromium's own
// backgroundThrottling, ecoMode only kept for panes.json. Not covered here: the real CPU use of a running Bots (Activity Monitor / top, manual check).
const fs = require('fs'), path = require('path');
const D = require('../src/diagnostics');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const SRC = path.join(__dirname, '..', 'src');
const code = s => s.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');   // line comments out (they may name the old mechanism); https:// stays
const files = fs.readdirSync(SRC).filter(n => n.endsWith('.js')).map(n => [n, code(fs.readFileSync(path.join(SRC, n), 'utf8'))]);
const main = files.find(([n]) => n === 'main.js')[1];
const hits = re => files.filter(([, s]) => re.test(s)).map(([n]) => n);

t('comment stripping keeps code and URLs', code("a(); // x\nconst u = 'https://grok.com/'; // y") === "a(); \nconst u = 'https://grok.com/'; ");
t(`src: ${files.length} files read, main.js among them`, files.length >= 20 && main.includes('function sleepPane('));
t('src: no Emulation.setCPUThrottlingRate (no CPU throttling rate above 1 can come back)', hits(/setCPUThrottlingRate/).length === 0);
t('src: no DevTools Emulation.* command at all (none can reach a sleeping about:blank pane)', hits(/Emulation\./).length === 0);
t('src: no wc.debugger (the app never attaches the DevTools protocol to a pane / probe / window)', hits(/\.debugger\b/).length === 0);
t('main.js: no periodic re-throttling left (applyThrottling / cpuRate / MPB_NO_ECO)', !/applyThrottling|cpuRate|MPB_NO_ECO/.test(main));
t('main.js: panes keep Chromium\'s backgroundThrottling (hidden panes slowed by Chromium itself)',
  /new WebContentsView\(\{ webPreferences: \{\n[^\n]*pane-preload\.js'\),\n[^\n]*backgroundThrottling: true/.test(main));
t('settings menu: no 省電力 (CPU limit) item', !/省電力|CPUを制限/.test(main));
t('ecoMode still read / written as before for panes.json (default kept, file settings spread over it, saved whole)',
  /let settings = \{[^}\n]*ecoMode: true/.test(main) && main.includes('settings = { ...settings, ...st.settings };') && /favorites: [^\n]*, settings, workspaces \};/.test(main));
t('ecoMode not used for anything else (no settings.ecoMode read)', !/settings\.ecoMode/.test(main));
t('diagnostics: ecoMode not shown (it has no effect)', !Object.hasOwn(D.SETTINGS, 'ecoMode') && !/ecoMode/.test(main.slice(main.indexOf('function diagEnv'), main.indexOf('const diagView'))));

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);
