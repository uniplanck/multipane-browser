// node test/app-name-title.test.js — window titles follow the app's name (productName / app.setName), so a renamed build is not shown as "MultiPane Browser".
const assert = require('assert');
const fs = require('fs'), path = require('path');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
assert(!/title:\s*'MultiPane Browser'/.test(main), 'no hard-coded window title');
assert(/win = new BrowserWindow\(\{[^\n]*title: app\.getName\(\)/.test(main), 'main window title = app.getName()');
assert(/autoHideMenuBar: true, title: app\.getName\(\)/.test(main), 'popup window title = app.getName()');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
assert.strictEqual(pkg.productName, 'MultiPane Browser', 'default build keeps its name (app.getName() = productName)');
console.log('app-name-title: ok');
