'use strict';

// Capture snapshots through the user's own browser, one link at a time: open the page in
// a new tab of the frontmost browser window, wait for it to load, screenshot the window,
// save, close the tab. Runs in the user's session, so pages behind SSO come out as the
// user sees them. Pages that land on a sign-in screen are skipped and keep their tile.
//
// One batch at a time. Progress is exposed for the UI and the batch can be stopped.

const capture = require('./capture');
const { looksLikeLogin } = require('./enrich');

const LOAD_TIMEOUT_MS = 12000;
const SETTLE_MS = 1200; // after "loading" turns false, let dynamic pages paint

const state = {
  running: false,
  stopRequested: false,
  app: null,
  total: 0,
  done: 0,
  ok: 0,
  skipped: [], // { id, title, reason }
  current: null, // { id, title }
  startedAt: null,
  finishedAt: null,
  error: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function status() {
  return { ...state, skipped: state.skipped.slice(-50) };
}

// Frontmost browser if one is frontmost, else the first running one.
function pickBrowser(preferred) {
  const running = capture.runningBrowsers();
  if (!running.length) throw new Error('no supported browser is running (Brave, Chrome, Edge, Chromium or Safari)');
  if (preferred && running.includes(preferred)) return preferred;
  const front = capture.frontmostApp();
  return running.includes(front) ? front : running[0];
}

async function waitLoaded(app, windowIndex, tabIndex) {
  const t0 = Date.now();
  while (Date.now() - t0 < LOAD_TIMEOUT_MS) {
    if (!capture.tabLoading(app, windowIndex, tabIndex)) break;
    await sleep(300);
  }
  await sleep(SETTLE_MS);
}

// Open url in a new tab of app's front window, wait for it to load, screenshot, close the
// tab and return { buffer, title, url, app }. Throws with code 'login' when the page lands
// on a sign-in screen. Shared by the batch and by the drawer's "From browser tab" fallback.
async function captureByOpening(url, opts = {}) {
  const app = pickBrowser(opts.app);
  const tab = capture.openTab(app, url);
  try {
    await waitLoaded(app, tab.windowIndex, tab.tabIndex);
    const info = capture.tabInfo(app, tab.windowIndex, tab.tabIndex);
    if (looksLikeLogin({ finalUrl: info.url, title: info.title, html: '' })) throw Object.assign(new Error('The page landed on a sign-in screen. Log in there first, then try again.'), { code: 'login' });
    const cap = capture.captureUrl(url, { topCrop: opts.topCrop, maxWidth: opts.maxWidth, tabHint: { app, ...tab } });
    return { buffer: cap.buffer, title: info.title, url: info.url, app, method: 'opened' };
  } finally {
    try { capture.closeTab(app, tab.windowIndex, tab.tabIndex, tab.previousTab); } catch { /* best effort */ }
  }
}

// opts: { store, links: [link], app, topCrop, maxWidth, onSaved(link, buffer) }
async function start(opts) {
  if (state.running) throw new Error('a browser capture is already running');
  const links = opts.links.filter(Boolean);
  Object.assign(state, { running: true, stopRequested: false, app: null, total: links.length, done: 0, ok: 0, skipped: [], current: null, startedAt: new Date().toISOString(), finishedAt: null, error: null });
  try {
    state.app = pickBrowser(opts.app);
  } catch (err) {
    Object.assign(state, { running: false, finishedAt: new Date().toISOString(), error: err.message });
    throw err;
  }
  // Run in the background; the caller gets the status immediately.
  (async () => {
    const app = state.app;
    for (const link of links) {
      if (state.stopRequested) break;
      state.current = { id: link.id, title: link.title };
      try {
        const cap = await captureByOpening(link.url, { app, topCrop: opts.topCrop, maxWidth: opts.maxWidth });
        await opts.onSaved(link, cap.buffer, cap);
        state.ok++;
      } catch (err) {
        state.skipped.push({ id: link.id, title: link.title, reason: err.code === 'login' ? 'landed on a sign-in page' : err.message });
      } finally {
        state.done++;
      }
      await sleep(250);
    }
    state.current = null;
    state.running = false;
    state.finishedAt = new Date().toISOString();
  })().catch((err) => { state.error = err.message; state.running = false; state.finishedAt = new Date().toISOString(); });
  return status();
}

function stop() {
  if (state.running) state.stopRequested = true;
  return status();
}

module.exports = { start, stop, status, captureByOpening, pickBrowser };
