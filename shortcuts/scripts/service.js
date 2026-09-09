#!/usr/bin/env node
'use strict';
// "Links: start service" / "Links: stop service" / toggle.
// Usage: service.js start|stop|toggle|status
const { spawnSync } = require('child_process');
const path = require('path');
const C = require('./common');

async function main() {
  const cmd = process.argv[2] || 'toggle';
  const up = await C.serviceUp();
  if (cmd === 'status') { C.notify(up ? `Running on ${C.BASE}` : 'Stopped'); return 0; }
  if (cmd === 'stop' || (cmd === 'toggle' && up)) {
    if (!up) { C.notify('Already stopped'); return 0; }
    try { await C.api('POST', '/quit'); } catch { /* connection drops on exit */ }
    C.notify('Service stopped');
    return 0;
  }
  if (up) { C.notify('Already running'); return 0; }
  const r = spawnSync(path.join(C.ROOT, 'bin', 'golinks'), ['start'], { encoding: 'utf8', timeout: 20000 });
  for (let i = 0; i < 20; i++) {
    await new Promise((res) => setTimeout(res, 300));
    if (await C.serviceUp()) { C.notify(`Service started on ${C.BASE}`); return 0; }
  }
  C.notify('Service failed to start: ' + (r.stderr || '').trim().slice(0, 120));
  return 1;
}

main().then((code) => process.exit(code || 0), (err) => { C.notify(err.message); process.exit(1); });
