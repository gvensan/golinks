#!/usr/bin/env node
'use strict';
// Prints JSON { app, url, title, bounds } for the active tab of the frontmost supported browser.
// Usage: current-tab.js [--app "Google Chrome"|"Brave Browser"]
const { osascript } = require('./common');

const BROWSERS = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Chromium', 'Safari'];

function running(app) {
  try { return osascript(`tell application "System Events" to (name of processes) contains ${JSON.stringify(app)}`) === 'true'; } catch { return false; }
}

function frontmostApp() {
  try { return osascript('tell application "System Events" to get name of first application process whose frontmost is true'); } catch { return ''; }
}

function pickApp(argv) {
  const i = argv.indexOf('--app');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (process.env.LINKS_BROWSER) return process.env.LINKS_BROWSER;
  const front = frontmostApp();
  if (BROWSERS.includes(front)) return front;
  return BROWSERS.find(running) || 'Google Chrome';
}

function currentTab(app) {
  const tabExpr = app === 'Safari' ? 'current tab of w' : 'active tab of w';
  const titleExpr = app === 'Safari' ? 'name of t' : 'title of t';
  const out = osascript(`tell application ${JSON.stringify(app)}
  if (count of windows) is 0 then error "no windows"
  set w to front window
  set t to ${tabExpr}
  set b to bounds of w
  return (URL of t) & linefeed & (${titleExpr}) & linefeed & ((item 1 of b) as text) & "," & ((item 2 of b) as text) & "," & ((item 3 of b) as text) & "," & ((item 4 of b) as text)
end tell`);
  const [url, title, bounds] = out.split('\n');
  const [x1, y1, x2, y2] = bounds.split(',').map(Number);
  return { app, url, title, bounds: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } };
}

if (require.main === module) {
  try {
    const app = pickApp(process.argv.slice(2));
    process.stdout.write(JSON.stringify(currentTab(app)) + '\n');
  } catch (err) {
    process.stderr.write(`could not read the active tab: ${err.stderr || err.message}\n`);
    process.exit(2);
  }
}

module.exports = { currentTab, pickApp, BROWSERS };
