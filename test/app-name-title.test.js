// node test/app-name-title.test.js — window titles follow the app's name (productName / app.setName), so a renamed build is not shown as "MultiPane Browser".
const assert = require('assert');
const fs = require('fs'), path = require('path');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
assert(!/title:\s*'MultiPane Browser'/.test(main), 'no hard-coded window title');
assert(/win = new BrowserWindow\(\{[^\n]*title: app\.getName\(\)/.test(main), 'main window title = app.getName()');
assert(/autoHideMenuBar: true, title: app\.getName\(\)/.test(main), 'popup window title = app.getName()');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
assert.strictEqual(pkg.productName, 'xG-Bots', 'app name (app.getName() = productName)');
assert.strictEqual(pkg.build.productName, 'xG-Bots', 'bundle name: xG-Bots.app');
assert.strictEqual(pkg.build.appId, 'com.multipanebrowser.app', 'bundle id unchanged');
assert.strictEqual(pkg.build.mac.icon, 'build/icon.icns', 'app icon');
assert(fs.existsSync(path.join(__dirname, '../build/icon.icns')) && fs.existsSync(path.join(__dirname, '../build/icon.png')), 'icon files tracked');
assert(/xG-Bots\.app/.test(pkg.scripts['install:mac']), 'install:mac installs xG-Bots.app');
// the data dir does not follow the new name: userData + sessionData stay <appData>/MultiPane Browser (logins, panes.json, drafts)
assert(/else \{ const DATA_DIR = path\.join\(app\.getPath\('appData'\), 'MultiPane Browser'\); app\.setPath\('userData', DATA_DIR\); app\.setPath\('sessionData', DATA_DIR\); \}/.test(main), 'userData pinned');
assert(main.indexOf("setPath('userData', DATA_DIR)") < main.indexOf("app.getPath('userData')"), 'pinned before the first userData read');
console.log('app-name-title: ok');
