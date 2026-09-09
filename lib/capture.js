'use strict';

// Capture a screenshot of the browser tab that shows a given URL, in any window. If
// that tab is not the active one in its window (typically because the user clicked back
// to the Golinks tab), it is activated for the capture and the previous tab restored
// afterwards. Runs inside the user's session, so SSO pages render as the user sees them. Uses osascript (AppleScript for tab urls, JXA for CGWindow ids),
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

// Every tab of every window: [{ index (window), tab, active, title, url }].
function allTabs(app) {
  const isSafari = app === 'Safari';
  const script = isSafari ? `tell application "Safari"
  set out to ""
  set i to 0
  repeat with w in windows
    set i to i + 1
    try
      set ai to index of current tab of w
      set j to 0
      repeat with t in tabs of w
        set j to j + 1
        set out to out & i & "${SEP}" & j & "${SEP}" & ((j = ai) as string) & "${SEP}" & (name of t) & "${SEP}" & (URL of t) & linefeed
      end repeat
    end try
  end repeat
  return out
end tell` : `tell application "${app}"
  set out to ""
  set i to 0
  repeat with w in windows
    set i to i + 1
    try
      set ai to active tab index of w
      set j to 0
      repeat with t in tabs of w
        set j to j + 1
        set out to out & i & "${SEP}" & j & "${SEP}" & ((j = ai) as string) & "${SEP}" & (title of t) & "${SEP}" & (URL of t) & linefeed
      end repeat
    end try
  end repeat
  return out
end tell`;
  const out = osa(['-e', script]);
  return out.split('\n').filter(Boolean).map((line) => {
    const parts = line.split(SEP);
    const url = parts.pop() || '';
    const index = Number(parts.shift());
    const tab = Number(parts.shift());
    const active = parts.shift() === 'true';
    return { index, tab, active, title: parts.join(SEP), url };
  });
}

// Name of the frontmost application process ('' when unknown).
function frontmostApp() {
  try { return osa(['-e', 'tell application "System Events" to get name of first application process whose frontmost is true']); } catch { return ''; }
}

// Open url in a new tab of the frontmost window of app and make it active.
// Returns { windowIndex, tabIndex, previousTab } so the caller can close it and go back.
function openTab(app, url) {
  const u = JSON.stringify(String(url));
  if (app === 'Safari') {
    const out = osa(['-e', `tell application "Safari"
  if (count of windows) = 0 then make new document
  set w to front window
  set prev to index of current tab of w
  set t to make new tab at end of tabs of w with properties {URL:${u}}
  set current tab of w to t
  return (prev as string) & "," & ((count of tabs of w) as string)
end tell`]);
    const [prev, idx] = out.split(',').map(Number);
    return { windowIndex: 1, tabIndex: idx, previousTab: prev };
  }
  const out = osa(['-e', `tell application "${app}"
  if (count of windows) = 0 then make new window
  set w to front window
  set prev to active tab index of w
  set t to make new tab at end of tabs of w with properties {URL:${u}}
  set active tab index of w to (count of tabs of w)
  return (prev as string) & "," & ((count of tabs of w) as string)
end tell`]);
  const [prev, idx] = out.split(',').map(Number);
  return { windowIndex: 1, tabIndex: idx, previousTab: prev };
}

function tabLoading(app, windowIndex, tabIndex) {
  if (app === 'Safari') {
    // Safari has no loading flag; treat a missing title or "Loading" as still loading
    const t = osa(['-e', `tell application "Safari" to get name of tab ${tabIndex} of window ${windowIndex}`]);
    return !t || /^loading/i.test(t);
  }
  return osa(['-e', `tell application "${app}" to get loading of tab ${tabIndex} of window ${windowIndex}`]) === 'true';
}

function tabInfo(app, windowIndex, tabIndex) {
  const isSafari = app === 'Safari';
  const out = osa(['-e', `tell application "${app}" to get (${isSafari ? 'name' : 'title'} of tab ${tabIndex} of window ${windowIndex}) & "${SEP}" & (URL of tab ${tabIndex} of window ${windowIndex})`]);
  const parts = out.split(SEP);
  return { title: parts[0] || '', url: parts[1] || '' };
}

function closeTab(app, windowIndex, tabIndex, previousTab) {
  osa(['-e', `tell application "${app}" to close tab ${tabIndex} of window ${windowIndex}`]);
  if (previousTab) { try { setActiveTab(app, windowIndex, previousTab); } catch { /* best effort */ } }
}

function setActiveTab(app, windowIndex, tabIndex) {
  if (app === 'Safari') osa(['-e', `tell application "Safari" to set current tab of window ${windowIndex} to tab ${tabIndex} of window ${windowIndex}`]);
  else osa(['-e', `tell application "${app}" to set active tab index of window ${windowIndex} to ${tabIndex}`]);
}

// host + path, for pages that rewrite their query string after loading (SharePoint does).
function looseKey(url) {
  try { const u = new URL(url); return (u.hostname.replace(/^www\./, '') + decodeURIComponent(u.pathname)).toLowerCase().replace(/\/+$/, ''); } catch { return ''; }
}

// Same host and path is only "the same page" when the query strings agree on something:
// forms.cloud.microsoft/.../ResponsePage.aspx?id=A and ?id=B are different pages, while a
// SharePoint URL that gained or lost tracking parameters still shares its id or viewid.
function looseMatch(a, b) {
  if (!looseKey(a) || looseKey(a) !== looseKey(b)) return false;
  let qa, qb;
  try { qa = new URL(a).searchParams; qb = new URL(b).searchParams; } catch { return false; }
  const pairsA = [...qa.entries()].map(([k, v]) => k.toLowerCase() + '=' + v);
  const pairsB = new Set([...qb.entries()].map(([k, v]) => k.toLowerCase() + '=' + v));
  if (!pairsA.length || !pairsB.size) return true;
  return pairsA.some((pv) => pairsB.has(pv));
}

function cgWindows() {
  const out = osa(['-l', 'JavaScript', JXA_WINDOWS]);
  try { return JSON.parse(out); } catch { return []; }
}

function sleepMs(ms) {
  spawnSync('/bin/sleep', [String(ms / 1000)]);
}

// Find the browser tab that shows url, in any window. Exact matches win over prefix
// matches over host+path matches; among equals, an already active tab wins, then the
// frontmost window. Returns { app, index, tab, title, url, windowId, bounds, restore }
// where restore() re-activates the tab that was active before, if we switched.
function findWindow(url) {
  const key = dedupeKey(url);
  if (!key) throw new CaptureError('badurl', 'invalid url');
  const loose = looseKey(url);
  const candidates = [];
  for (const app of runningBrowsers()) {
    let tabs;
    try { tabs = allTabs(app); } catch (err) { if (err.code === 'automation') throw err; continue; }
    const activeByWindow = new Map();
    const activeTitleByWindow = new Map();
    for (const t of tabs) if (t.active) { activeByWindow.set(t.index, t.tab); activeTitleByWindow.set(t.index, t.title); }
    for (const t of tabs) {
      const k = dedupeKey(t.url);
      let score = 0;
      if (k && k === key) score = 3;
      else if (k && (k.startsWith(key) || key.startsWith(k))) score = 2;
      else if (loose && looseMatch(url, t.url)) score = 1;
      if (score) candidates.push({ app, ...t, score, previousTab: activeByWindow.get(t.index), activeTitle: activeTitleByWindow.get(t.index) });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || Number(b.active) - Number(a.active) || a.index - b.index);
  const hit = candidates[0];
  // Identify the window before touching it: its name is the title of its currently
  // active tab. Then switch tabs if needed and capture by window id. Never guess another
  // window, since a wrong window would silently produce a wrong screenshot.
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const currentTitle = norm(hit.active ? hit.title : hit.activeTitle);
  const windows = cgWindows().filter((w) => w.owner === hit.app && w.name);
  const byName = (t) => windows.find((w) => norm(w.name) === t) || windows.find((w) => t && (norm(w.name).startsWith(t) || t.startsWith(norm(w.name))));
  let win = byName(currentTitle);
  let restore = () => {};
  if (!hit.active) {
    setActiveTab(hit.app, hit.index, hit.tab);
    const prev = hit.previousTab;
    if (prev) restore = () => { try { setActiveTab(hit.app, hit.index, prev); } catch { /* best effort */ } };
    if (!win) {
      // fall back to the name after the switch (works when the window is on screen)
      for (let i = 0; i < 6 && !win; i++) { sleepMs(250); win = cgWindows().filter((w) => w.owner === hit.app && w.name).find((w) => norm(w.name) === norm(hit.title)); }
    }
  }
  if (!win) {
    restore();
    throw new CaptureError('nowindow', `The tab was found in ${hit.app} but its window could not be identified for capture. Bring that window to the front and try again.`);
  }
  return { ...hit, windowId: win.id, bounds: win.bounds, onscreen: win.onscreen, restore };
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
// When the caller opened the tab itself (browser batch), find its window by the tab title.
function findWindowForTab(hint) {
  const info = tabInfo(hint.app, hint.windowIndex, hint.tabIndex);
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(info.title);
  let win = null;
  for (let i = 0; i < 6 && !win; i++) {
    if (i) sleepMs(250);
    const windows = cgWindows().filter((w) => w.owner === hint.app && w.name);
    win = windows.find((w) => norm(w.name) === want) || windows.find((w) => want && (norm(w.name).startsWith(want) || want.startsWith(norm(w.name))));
  }
  if (!win) throw new CaptureError('nowindow', `The window of ${hint.app} could not be identified for capture.`);
  return { app: hint.app, index: hint.windowIndex, tab: hint.tabIndex, active: true, title: info.title, url: info.url, windowId: win.id, bounds: win.bounds, onscreen: win.onscreen, restore: () => {} };
}

function captureUrl(url, opts = {}) {
  const t0 = Date.now();
  const topCrop = opts.topCrop ?? 116;
  const maxWidth = opts.maxWidth ?? 960;
  const hit = opts.tabHint ? findWindowForTab(opts.tabHint) : findWindow(url);
  if (!hit) throw new CaptureError('notab', 'This page is not open in any browser tab. Open it in Brave, Chrome, Edge or Safari and try again.');
  const method = 'window';
  // Capture, crop the browser chrome and resize. A window on another Space or minimised
  // renders as a flat white page: after cropping the toolbar away, that JPEG is tiny
  // (about 8 KB at 960 px) while any real page is several times larger.
  const BLANK_BYTES = 12000;
  const grab = () => {
    const png = tmp('png');
    spawnSync('/usr/sbin/screencapture', ['-l', String(hit.windowId), '-o', '-x', png], { timeout: 15000 });
    if (!fs.existsSync(png) || fs.statSync(png).size < 2000) {
      try { fs.unlinkSync(png); } catch { /* ignore */ }
      throw new CaptureError('screen', 'Screenshot came back empty. Allow Screen Recording for the service ("node") under System Settings > Privacy & Security > Screen & System Audio Recording, then run bin/golinks restart.');
    }
    return finish(png, hit.bounds && hit.bounds.Width, topCrop, maxWidth);
  };
  let buffer;
  try {
    if (!hit.active) sleepMs(350); // let the newly shown tab paint
    buffer = grab();
    if (buffer.length < BLANK_BYTES && hit.onscreen) { sleepMs(700); buffer = grab(); } // still painting: one more try
  } finally {
    hit.restore();
  }
  if (buffer.length < BLANK_BYTES) {
    if (!hit.onscreen) throw new CaptureError('offscreen', `The page is open in a ${hit.app} window on another Space or minimised, and macOS only renders windows on the current Space. Bring that window here (or open the page in this window) and try again.`);
    throw new CaptureError('blank', 'The screenshot came back blank. Make sure the page has finished loading and is not an empty tab, then try again.');
  }
  return { buffer, app: hit.app, title: hit.title, url: hit.url, method, ms: Date.now() - t0 };
}

module.exports = { captureUrl, findWindow, activeTabs, allTabs, cgWindows, runningBrowsers, frontmostApp, openTab, closeTab, tabLoading, tabInfo, CaptureError, BROWSERS };
