#!/usr/bin/env node
'use strict';
// "Links: add current tab". Reads the active browser tab, screenshots the window
// (minus the tab strip and toolbar), asks for tags with suggestions, and POSTs to
// the service. Works for SSO pages because the capture happens in your browser.
//
// Env / flags:
//   --no-shot        skip the screenshot
//   --no-ask         do not prompt for tags (use rule suggestions only)
//   --revisit        used by the open Shortcut: refresh the snapshot of an existing link and exit
//   LINKS_TOP_CROP   pixels to crop from the top of the window (tab strip + toolbar), default 87

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./common');
const { currentTab, pickApp } = require('./current-tab');

const TOP_CROP = Number(process.env.LINKS_TOP_CROP || 87);

function screenshot(bounds) {
  const png = path.join(os.tmpdir(), `links-shot-${Date.now()}.png`);
  const jpg = png.replace(/\.png$/, '.jpg');
  const region = `${bounds.x},${bounds.y + TOP_CROP},${bounds.w},${Math.max(100, bounds.h - TOP_CROP)}`;
  let r = spawnSync('/usr/sbin/screencapture', ['-x', '-r', '-R', region, png], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0 || !fs.existsSync(png) || fs.statSync(png).size === 0) throw new Error('screencapture failed: ' + (r.stderr || 'no output, is Screen Recording allowed for Shortcuts?'));
  r = spawnSync('/usr/bin/sips', ['-Z', '960', '-s', 'format', 'jpeg', '-s', 'formatOptions', '75', png, '--out', jpg], { encoding: 'utf8', timeout: 20000 });
  const src = r.status === 0 && fs.existsSync(jpg) ? jpg : png;
  const b64 = fs.readFileSync(src).toString('base64');
  for (const f of [png, jpg]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  return b64;
}

async function main() {
  const argv = process.argv.slice(2);
  const noShot = argv.includes('--no-shot');
  const noAsk = argv.includes('--no-ask');
  const revisit = argv.includes('--revisit');

  if (!(await C.ensureService())) return 1;

  let tab;
  try { tab = currentTab(pickApp(argv)); } catch (err) {
    C.notify('Could not read the browser tab. Check Automation permission for Shortcuts.');
    process.stderr.write(String(err.stderr || err.message) + '\n');
    return 2;
  }
  if (!/^https?:/i.test(tab.url)) { C.notify('Active tab is not a web page.'); return 0; }

  const info = await C.api('POST', '/api/enrich', { url: tab.url, fetch: false });

  if (revisit) {
    if (!info.duplicate) return 0;
    if (noShot) return 0;
    const snapshot = screenshot(tab.bounds);
    await C.api('POST', `/api/links/${info.duplicate.id}/snapshot`, { snapshot });
    return 0;
  }

  if (info.duplicate) {
    const d = info.duplicate;
    if (!C.confirm(`Already saved as "${d.title}".\nRefresh its snapshot from this window?`, 'Refresh')) return 0;
    if (!noShot) {
      const snapshot = screenshot(tab.bounds);
      await C.api('POST', `/api/links/${d.id}/snapshot`, { snapshot });
    }
    await C.api('POST', `/api/links/${d.id}/use`);
    C.notify(`Snapshot refreshed: ${d.title}`);
    return 0;
  }

  let tags = info.tags.slice();
  if (!noAsk) {
    const hint = info.suggestedTags.length ? `\nSuggestions: ${info.suggestedTags.join(', ')}` : '';
    const answer = C.ask(`Tags for:\n${tab.title}${hint}`, [...tags, ...info.suggestedTags].join(' '));
    if (answer === null) return 0; // cancelled
    tags = answer.split(/[\s,]+/).filter(Boolean);
  }

  let snapshot;
  if (!noShot) {
    try { snapshot = screenshot(tab.bounds); } catch (err) { process.stderr.write(err.message + '\n'); }
  }

  const body = { url: tab.url, title: tab.title, tags, snapshot, source: 'shortcut', enrich: false, snapshotMode: snapshot ? 'none' : 'tile' };
  const r = await C.api('POST', '/api/links', body);
  C.notify(`Saved: ${r.link.title}${snapshot ? '' : ' (no screenshot)'}`);
  return 0;
}

main().then((code) => process.exit(code || 0), (err) => {
  C.notify(`Add failed: ${err.message}`);
  process.stderr.write(String(err.stack || err) + '\n');
  process.exit(1);
});
