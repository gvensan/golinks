'use strict';
// Shared helpers for the Shortcut scripts. Runs on the plain Node that bin/node points to.

const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function port() {
  if (process.env.LINKS_PORT) return Number(process.env.LINKS_PORT);
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'settings.json'), 'utf8')).port || 7777; } catch { return 7777; }
}
const BASE = `http://127.0.0.1:${port()}`;

function osascript(script) {
  return execFileSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8', timeout: 120000 }).replace(/\n$/, '');
}

function notify(text, title = 'Golinks') {
  try { osascript(`display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`); } catch { /* ignore */ }
}

// Returns null when the user cancels.
function ask(prompt, defaultAnswer = '', title = 'Golinks') {
  try {
    const out = osascript(`set r to display dialog ${JSON.stringify(prompt)} default answer ${JSON.stringify(defaultAnswer)} with title ${JSON.stringify(title)} buttons {"Cancel", "OK"} default button "OK"
return text returned of r`);
    return out;
  } catch (err) {
    if (/-128/.test(String(err.stderr || err.message))) return null;
    throw err;
  }
}

function confirm(prompt, okLabel = 'OK', title = 'Golinks') {
  try {
    osascript(`display dialog ${JSON.stringify(prompt)} with title ${JSON.stringify(title)} buttons {"Cancel", ${JSON.stringify(okLabel)}} default button ${JSON.stringify(okLabel)}`);
    return true;
  } catch { return false; }
}

// items: array of display strings. Returns chosen string or null.
function chooseFrom(items, prompt, title = 'Golinks') {
  if (!items.length) return null;
  const list = '{' + items.map((s) => JSON.stringify(s.replace(/"/g, "'"))).join(', ') + '}';
  try {
    const out = osascript(`set r to choose from list ${list} with prompt ${JSON.stringify(prompt)} with title ${JSON.stringify(title)} OK button name "Open" cancel button name "Cancel"
if r is false then error number -128
return item 1 of r`);
    return out;
  } catch { return null; }
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

async function serviceUp() {
  try { await api('GET', '/api/health'); return true; } catch { return false; }
}

function startService() {
  const r = spawnSync(path.join(ROOT, 'bin', 'golinks'), ['start'], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0;
}

async function ensureService() {
  if (await serviceUp()) return true;
  if (!confirm('Golinks service is not running. Start it?', 'Start')) return false;
  startService();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (await serviceUp()) return true;
  }
  notify('Service did not start. Check bin/golinks status.');
  return false;
}

function openUrl(url) {
  spawnSync('/usr/bin/open', [url]);
}

module.exports = { ROOT, BASE, osascript, notify, ask, confirm, chooseFrom, api, serviceUp, ensureService, startService, openUrl };
