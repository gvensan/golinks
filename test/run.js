'use strict';
// Unit tests for the pure modules. Run: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const url = require('../lib/url');
const rules = require('../lib/rules');
const search = require('../lib/search');
const importer = require('../lib/importer');
const { Store } = require('../lib/store');
const { looksLikeLogin } = require('../lib/enrich');
const { tileSvg } = require('../lib/snapshots');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.message}`); process.exitCode = 1; }
}

test('cleanUrl strips tracking params and keeps the rest', () => {
  assert.strictEqual(url.cleanUrl('HTTPS://Example.com/a?b=1&utm_source=x&fbclid=y#frag'), 'https://example.com/a?b=1#frag');
  assert.strictEqual(url.cleanUrl('docs.solace.com/x'), 'https://docs.solace.com/x');
  assert.strictEqual(url.cleanUrl('not a url'), null);
  assert.strictEqual(url.cleanUrl('ftp://x.com/a'), null);
});

test('dedupeKey ignores scheme, www, fragment, trailing slash, param order', () => {
  const a = url.dedupeKey('http://www.example.com/path/?b=2&a=1#x');
  const b = url.dedupeKey('https://example.com/path?a=1&b=2');
  assert.strictEqual(a, b);
  assert.notStrictEqual(url.dedupeKey('https://example.com/a'), url.dedupeKey('https://example.com/b'));
});

test('domainLabel', () => {
  assert.strictEqual(url.domainLabel('https://docs.solace.com/x'), 'solace');
  assert.strictEqual(url.domainLabel('https://solace.atlassian.net/wiki'), 'atlassian');
  assert.strictEqual(url.domainLabel('https://www.bbc.co.uk/news'), 'bbc');
});

test('rules apply with capture groups', () => {
  const r = [
    { match: 'atlassian\\.net/wiki', tags: ['confluence'] },
    { match: 'atlassian\\.net/browse/([A-Za-z]+)-\\d+', tags: ['jira', '$1'] },
    { match: '[invalid(regex', tags: ['never'] },
  ];
  assert.deepStrictEqual(rules.applyRules('https://solace.atlassian.net/wiki/spaces/X', r), ['confluence']);
  assert.deepStrictEqual(rules.applyRules('https://solace.atlassian.net/browse/DATAGO-12', r), ['jira', 'datago']);
  assert.deepStrictEqual(rules.normalizeTags('Event Portal, jira,JIRA'), ['event-portal', 'jira']);
});

const links = [
  { id: 'a', url: 'https://solace.atlassian.net/wiki/spaces/EP/pages/1/Design', title: 'Event Portal design notes', tags: ['confluence', 'event-portal'], aliases: ['ep design'], keyword: 'epdesign', created: '2026-01-01T00:00:00Z', lastUsed: null, useCount: 0 },
  { id: 'b', url: 'https://github.com/SolaceLabs/solace-agent-mesh', title: 'Solace Agent Mesh repo', tags: ['github', 'sam'], aliases: [], keyword: 'sam', created: '2026-01-01T00:00:00Z', lastUsed: new Date().toISOString(), useCount: 20 },
  { id: 'c', url: 'https://docs.solace.com/Cloud/Event-Portal/event-portal-overview.htm', title: 'Event Portal overview', tags: ['solace-docs'], aliases: [], keyword: null, created: '2020-01-01T00:00:00Z', lastUsed: '2020-02-01T00:00:00Z', useCount: 3 },
  { id: 'd', url: 'https://example.com/untagged', title: 'Untagged thing', tags: [], aliases: [], keyword: null, created: '2026-01-01T00:00:00Z', lastUsed: null, useCount: 0 },
];
const index = search.buildIndex(links);

test('search: abbreviation matches initials', () => {
  const r = search.search(index, 'ep');
  assert.ok(r.results.length >= 2);
  assert.ok(r.results.slice(0, 2).every((l) => l.title.startsWith('Event Portal')));
});

test('search: exact keyword wins', () => {
  const r = search.search(index, 'sam');
  assert.strictEqual(r.results[0].id, 'b');
  assert.ok(r.results[0].textScore >= 1000);
});

test('search: operators', () => {
  assert.deepStrictEqual(search.search(index, 'tag:github').results.map((l) => l.id), ['b']);
  assert.deepStrictEqual(search.search(index, 'site:docs.solace').results.map((l) => l.id), ['c']);
  assert.deepStrictEqual(search.search(index, 'is:untagged').results.map((l) => l.id), ['d']);
  assert.deepStrictEqual(search.search(index, 'unused:90d docs').results.map((l) => l.id), ['c']);
  assert.deepStrictEqual(search.search(index, 'added:7d').results.map((l) => l.id), []);
});

test('search: frecency orders empty query by use', () => {
  const r = search.search(index, '');
  assert.strictEqual(r.results[0].id, 'b');
});

test('search: fuzzy and no-match', () => {
  assert.ok(search.search(index, 'agnt mesh').results.some((l) => l.id === 'b'));
  assert.strictEqual(search.search(index, 'zzzzqqq').results.length, 0);
});

test('resolveGo: keyword, template, search, fallback', () => {
  const store = { findByKeyword: (k) => links.find((l) => l.keyword === k) || null, findById: (id) => links.find((l) => l.id === id), templates: { jira: 'https://x/browse/{0}', conf: 'https://x/s?text={q}' } };
  assert.strictEqual(search.resolveGo('epdesign', store, index).link.id, 'a');
  assert.strictEqual(search.resolveGo('jira DATAGO-1', store, index).url, 'https://x/browse/DATAGO-1');
  assert.strictEqual(search.resolveGo('conf event portal', store, index).url, 'https://x/s?text=event%20portal');
  assert.strictEqual(search.resolveGo('agent mesh repo', store, index).link.id, 'b');
  assert.strictEqual(search.resolveGo('nothing here at all', store, index).type, 'search');
});

test('importer: flatten chrome bookmarks and extract text urls', () => {
  const json = { roots: { bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [
    { type: 'url', name: 'A', url: 'https://a.com/', date_added: '13390000000000000' },
    { type: 'folder', name: 'Work', children: [{ type: 'url', name: 'B', url: 'https://b.com/x?utm_source=1' }] },
  ] }, other: { type: 'folder', name: 'Other', children: [] } } };
  const flat = importer.flattenChrome(json);
  assert.strictEqual(flat.length, 2);
  assert.strictEqual(flat[0].folder, '');
  assert.strictEqual(flat[1].folder, 'Work');
  assert.strictEqual(flat[1].url, 'https://b.com/x');
  assert.ok(flat[0].added.startsWith('20'));
  const t = importer.extractFromText('see https://x.com/a, and http://y.org/b. Also https://x.com/a again');
  assert.deepStrictEqual(t.map((i) => i.url), ['https://x.com/a', 'http://y.org/b']);
});

test('importer: preview marks duplicates', () => {
  const store = { links: [{ id: 'z', url: 'https://b.com/x' }], rules: [] };
  const p = importer.preview([{ url: 'https://B.com/x/', title: 'B', folder: 'Work' }, { url: 'https://c.com', title: 'C', folder: '' }], store);
  assert.strictEqual(p[0].duplicate, true);
  assert.strictEqual(p[0].existingId, 'z');
  assert.deepStrictEqual(p[0].tags, ['work']);
  assert.strictEqual(p[1].duplicate, false);
});

test('store: atomic write, bak, reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-store-'));
  const s = new Store(dir);
  s.loadAll();
  assert.deepStrictEqual(s.links, []);
  s.links.push({ id: 'x1', url: 'https://a.com', title: 'A' });
  s.save('links');
  s.save('links');
  assert.ok(fs.existsSync(path.join(dir, 'links.json.bak')));
  assert.ok(fs.existsSync(path.join(dir, 'backups')));
  fs.writeFileSync(path.join(dir, 'links.json'), JSON.stringify([{ id: 'x2', url: 'https://b.com', title: 'B' }]));
  s.reloadIfChanged('links');
  assert.strictEqual(s.links[0].id, 'x2');
  assert.strictEqual(s.findById('x2').title, 'B');
  assert.match(s.newId(), /^[a-z0-9]{6}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('enrich: login detection', () => {
  assert.strictEqual(looksLikeLogin({ finalUrl: 'https://solace.okta.com/login/login.htm', title: '', html: '' }), true);
  assert.strictEqual(looksLikeLogin({ finalUrl: 'https://x.com/a', title: 'Sign in to Confluence', html: '' }), true);
  assert.strictEqual(looksLikeLogin({ finalUrl: 'https://x.com/a', title: 'Design notes', html: '<main>hi</main>' }), false);
});

test('snapshots: tile svg escapes', () => {
  const svg = tileSvg('https://docs.solace.com/x', 'A <b> "title"');
  assert.ok(svg.includes('docs.solace.com'));
  assert.ok(!svg.includes('<b>'));
});

console.log(`${passed} tests passed${process.exitCode ? ', some failed' : ''}`);
