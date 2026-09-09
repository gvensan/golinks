'use strict';

// Capture a screenshot of the browser window that currently shows a given URL as
// its active tab. Runs inside the user's session, so SSO pages render as the user
// sees them. Uses osascript (AppleScript for tab urls, JXA for CGWindow ids),
// screencapture -l (captures a window even when covered) and sips (crop, resize).
//
// Needs, once, for the process that runs the service (node under launchd):
//   Automation: control Brave / Chrome    (macOS prompts on first use)
//   Screen Recording                        (System Settings > Privacy & Security)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { dedupeKey } = require('./url');

const BROWSERS = ['Brave Browser', 'Google Chrome', 'Microsoft Edge', 'Chromium', 'Safari'];
const JXA_WINDOWS = path.join(__dirname, 'jxa', 'windows.js');
const SEP = ' ~|~ ';

class CaptureError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function osa(args, timeout = 15000) {
  try {
    return execFileSync('/usr/bin/osascript', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '');
  } catch (err) {
    const msg = String(err.stderr || err.message);
    if (/-1743|not allowed assistive|not authorized|not permitted/i.test(msg)) {
      throw new CaptureError('automation', 'macOS blocked the service from reading the browser. Allow "node" to control the browser under System Settings > Privacy & Security > Automation, then retry.');
    }
    if (/-600|isn.t running/i.test(msg)) throw new CaptureError('notrunning', 'browser is not running');
    throw new CaptureError('osascript', msg.trim().slice(0, 300));
  }
}

function runningBrowsers() {
  let names;
  try {
    names = osa(['-e', 'tell application "System Events" to get name of every application process']);
  } catch (err) {
    if (err.code === 'automation') throw err;
    return BROWSERS.filter((b) => fs.existsSync(`/Applications/${b}.app`));
  }
  const set = new Set(names.split(', ').map((s) => s.trim()));
  return BROWSERS.filter((b) => set.has(b));
}

// [{ index, title, url }] for every window's active tab of one browser.
function activeTabs(app) {
  const isSafari = app === 'Safari';
  const script = isSafari ? `tell application "Safari"
  set out to ""
  set i to 0
  repeat with w in windows
    set i to i + 1
    try
      set t to current tab of w
      set out to out & i & "${SEP}" & (name of t) & "${SEP}" & (URL of t) & linefeed
    end try
  end repeat
  return out
end tell` : `tell application "${app}"
  set out to ""
  set i to 0
  repeat with w in windows
    set i to i + 1
    try
      set t to active tab of w
      set out to out & i & "${SEP}" & (title of t) & "${SEP}" & (URL of t) & linefeed
    end try
  end repeat
  return out
end tell`;
  const out = osa(['-e', script]);
  return out.split('\n').filter(Boolean).map((line) => {
    const parts = line.split(SEP);
    const url = parts.pop() || '';
    const index = Number(parts.shift());
    return { index, title: parts.join(SEP), url };
  });
}

function cgWindows() {
  const out = osa(['-l', 'JavaScript', JXA_WINDOWS]);
  try { return JSON.parse(out); } catch { return []; }
}

function windowBounds(app, index) {
  const out = osa(['-e', `tell application "${app}" to get bounds of window ${index}`]);
  const [x1, y1, x2, y2] = out.split(',').map((s) => Number(s.trim()));
  return { X: x1, Y: y1, Width: x2 - x1, Height: y2 - y1 };
}

// Find the browser window whose active tab shows url.
function findWindow(url) {
  const key = dedupeKey(url);
  if (!key) throw new CaptureError('badurl', 'invalid url');
  const candidates = [];
  for (const app of runningBrowsers()) {
    let tabs;
    try { tabs = activeTabs(app); } catch (err) { if (err.code === 'automation') throw err; continue; }
    for (const t of tabs) {
      const k = dedupeKey(t.url);
      if (k === key) candidates.push({ app, ...t, exact: true });
      else if (k && (k.startsWith(key) || key.startsWith(k))) candidates.push({ app, ...t, exact: false });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => Number(b.exact) - Number(a.exact));
  const hit = candidates[0];
  const windows = cgWindows().filter((w) => w.owner === hit.app);
  let win = windows.find((w) => w.name === hit.title);
  if (!win && windows.length === 1) win = windows[0];
  if (!win) {
    // Not on screen (other Space, minimised): fall back to a region grab of its bounds.
    return { ...hit, windowId: null, bounds: windowBounds(hit.app, hit.index) };
  }
  return { ...hit, windowId: win.id, bounds: win.bounds };
}

function pixelSize(file) {
  const out = spawnSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' }).stdout || '';
  const w = Number((/pixelWidth:\s*(\d+)/.exec(out) || [])[1]);
  const h = Number((/pixelHeight:\s*(\d+)/.exec(out) || [])[1]);
  return { w, h };
}

function tmp(ext) {
  return path.join(os.tmpdir(), `links-cap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

// Crop topCrop points of browser chrome from the top, resize to maxWidth, return a JPEG buffer.
function finish(png, boundsWidth, topCrop, maxWidth) {
  const { w, h } = pixelSize(png);
  if (!w || !h) throw new CaptureError('image', 'screenshot could not be read');
  const scale = boundsWidth ? Math.max(1, Math.round(w / boundsWidth)) : 1;
  const T = Math.round(topCrop * scale);
  let src = png;
  if (T > 0 && h - 2 * T > 200) {
    // sips only crops around the centre (its --cropOffset does not move the window in
    // practice), so removing T from the top costs T at the bottom as well.
    const cropped = tmp('png');
    spawnSync('/usr/bin/sips', ['-c', String(h - 2 * T), String(w), png, '--out', cropped], { timeout: 20000 });
    if (fs.existsSync(cropped) && pixelSize(cropped).h === h - 2 * T) src = cropped;
  }
  const jpg = tmp('jpg');
  spawnSync('/usr/bin/sips', ['-Z', String(maxWidth), '-s', 'format', 'jpeg', '-s', 'formatOptions', '78', src, '--out', jpg], { timeout: 20000 });
  const out = fs.existsSync(jpg) ? fs.readFileSync(jpg) : fs.readFileSync(src);
  for (const f of [png, src, jpg]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  return out;
}

// Returns { buffer, app, title, url, method }.
function captureUrl(url, opts = {}) {
  const t0 = Date.now();
  const topCrop = opts.topCrop ?? 116;
  const maxWidth = opts.maxWidth ?? 960;
  const hit = findWindow(url);
  if (!hit) throw new CaptureError('notab', 'No browser window has this page as its active tab. Switch to the tab and try again.');
  const png = tmp('png');
  let method;
  if (hit.windowId) {
    spawnSync('/usr/sbin/screencapture', ['-l', String(hit.windowId), '-o', '-x', png], { timeout: 15000 });
    method = 'window';
  } else {
    const b = hit.bounds;
    spawnSync('/usr/sbin/screencapture', ['-x', '-R', `${b.X},${b.Y},${b.Width},${b.Height}`, png], { timeout: 15000 });
    method = 'region';
  }
  if (!fs.existsSync(png) || fs.statSync(png).size < 2000) {
    try { fs.unlinkSync(png); } catch { /* ignore */ }
    throw new CaptureError('screen', 'Screenshot came back empty. Allow Screen Recording for the service ("node") under System Settings > Privacy & Security > Screen & System Audio Recording, then run bin/golinks restart.');
  }
  const buffer = finish(png, hit.bounds && hit.bounds.Width, topCrop, maxWidth);
  return { buffer, app: hit.app, title: hit.title, url: hit.url, method, ms: Date.now() - t0 };
}

module.exports = { captureUrl, findWindow, activeTabs, cgWindows, runningBrowsers, CaptureError, BROWSERS };
