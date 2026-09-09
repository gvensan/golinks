#!/usr/bin/env node
'use strict';
// "Links: search". Ask for a query, resolve like the omnibox (keyword, template,
// confident match) or show a pick list, then open the chosen link via /open/:id.
// Usage: search.js [query words]   (no args: prompts with a dialog)

const C = require('./common');

async function main() {
  if (!(await C.ensureService())) return 1;
  let q = process.argv.slice(2).join(' ').trim();
  if (!q) {
    q = C.ask('Search links (keyword, words, tag:x, go-link template):', '');
    if (q === null) return 0;
    q = q.trim();
  }
  if (!q) { C.openUrl(`${C.BASE}/`); return 0; }

  // Let the server resolve keyword and templates first.
  const res = await fetch(`${C.BASE}/go/${encodeURIComponent(q)}`, { redirect: 'manual' });
  const loc = res.headers.get('location') || '';
  if (loc && !loc.startsWith(C.BASE + '/?q=') && !loc.startsWith('/?q=')) {
    C.openUrl(loc);
    return 0;
  }

  const data = await C.api('GET', `/api/search?q=${encodeURIComponent(q)}&limit=15`);
  if (!data.results.length) {
    if (C.confirm(`No links match "${q}".\nOpen the web UI?`, 'Open')) C.openUrl(`${C.BASE}/?q=${encodeURIComponent(q)}`);
    return 0;
  }
  const items = data.results.map((l) => {
    let host = '';
    try { host = new URL(l.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    const tags = l.tags.length ? `  #${l.tags.slice(0, 3).join(' #')}` : '';
    return `${l.title}  (${host})${tags}`;
  });
  const picked = C.chooseFrom(items, `Results for "${q}"`);
  if (!picked) return 0;
  const idx = items.indexOf(picked);
  const link = data.results[idx >= 0 ? idx : 0];
  C.openUrl(`${C.BASE}/open/${link.id}`);
  return 0;
}

main().then((code) => process.exit(code || 0), (err) => {
  C.notify(`Search failed: ${err.message}`);
  process.stderr.write(String(err.stack || err) + '\n');
  process.exit(1);
});
