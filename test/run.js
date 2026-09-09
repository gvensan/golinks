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
const folders = require('../lib/folders');
const suggest = require('../lib/suggest');
const exporter = require('../lib/exporter');
const xlsx = require('../lib/xlsx');
const { Store } = require('../lib/store');
const { looksLikeLogin } = require('../lib/enrich');
const { tileSvg } = require('../lib/snapshots');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.message}`); process.exitCode = 1; }
}

test('cleanUrl strips tracking params and keeps the rest', () => {
  assert.strictEqual(url.cleanUrl('HTTPS://Example.com/a?b=1&utm_source=x&fbclid=y#frag'), 'https://example.com/a?b=1#frag');
  assert.strictEqual(url.cleanUrl('docs.example.com/x'), 'https://docs.example.com/x');
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
  assert.strictEqual(url.domainLabel('https://docs.example.com/x'), 'example');
  assert.strictEqual(url.domainLabel('https://acme.atlassian.net/wiki'), 'atlassian');
  assert.strictEqual(url.domainLabel('https://www.bbc.co.uk/news'), 'bbc');
});

test('rules apply with capture groups', () => {
  const r = [
    { match: 'atlassian\\.net/wiki', tags: ['confluence'] },
    { match: 'atlassian\\.net/browse/([A-Za-z]+)-\\d+', tags: ['jira', '$1'] },
    { match: '[invalid(regex', tags: ['never'] },
  ];
  assert.deepStrictEqual(rules.applyRules('https://acme.atlassian.net/wiki/spaces/X', r), ['confluence']);
  assert.deepStrictEqual(rules.applyRules('https://acme.atlassian.net/browse/PROJ-12', r), ['jira', 'proj']);
  assert.deepStrictEqual(rules.normalizeTags('Event Portal, jira,JIRA'), ['event-portal', 'jira']);
});

const links = [
  { id: 'a', url: 'https://acme.atlassian.net/wiki/spaces/EP/pages/1/Design', title: 'Event Portal design notes', tags: ['confluence', 'event-portal'], aliases: ['ep design'], keyword: 'epdesign', created: '2026-01-01T00:00:00Z', lastUsed: null, useCount: 0 },
  { id: 'b', url: 'https://github.com/acme/service-agent-mesh', title: 'Service Agent Mesh repo', tags: ['github', 'sam'], aliases: [], keyword: 'sam', created: '2026-01-01T00:00:00Z', lastUsed: new Date().toISOString(), useCount: 20 },
  { id: 'c', url: 'https://docs.example.com/Cloud/Event-Portal/event-portal-overview.htm', title: 'Event Portal overview', tags: ['docs'], aliases: [], keyword: null, created: '2020-01-01T00:00:00Z', lastUsed: '2020-02-01T00:00:00Z', useCount: 3 },
  { id: 'd', url: 'https://example.com/untagged', title: 'Untagged thing', tags: [], aliases: [], keyword: null, created: '2026-01-01T00:00:00Z', lastUsed: null, useCount: 0 },
  { id: 'e', url: 'https://example.com/w1', title: 'Work root item', tags: ['w'], aliases: [], keyword: null, folder: 'Work', created: '2026-01-01T00:00:00Z', lastUsed: null, useCount: 0 },
  { id: 'f', url: 'https://example.com/w2', title: 'Alpha spec', tags: ['w'], aliases: [], keyword: null, folder: 'Work/Projects/Alpha', created: '2026-01-01T00:00:00Z', lastUsed: null, useCount: 0 },
  { id: 'g', url: 'https://example.com/h1', title: 'Home thing', tags: [], aliases: [], keyword: null, folder: 'Home', created: '2026-01-01T00:00:00Z', lastUsed: null, useCount: 0 },
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
  assert.deepStrictEqual(search.search(index, 'site:docs.example').results.map((l) => l.id), ['c']);
  assert.deepStrictEqual(search.search(index, 'is:untagged').results.map((l) => l.id).sort(), ['d', 'g']);
  assert.deepStrictEqual(search.search(index, 'unused:90d docs').results.map((l) => l.id), ['c']);
  assert.deepStrictEqual(search.search(index, 'added:7d').results.map((l) => l.id), []);
});

test('search: folder filter includes subfolders, in: operator, unfiled view', () => {
  assert.deepStrictEqual(search.search(index, '', { folder: 'Work' }).results.map((l) => l.id).sort(), ['e', 'f']);
  assert.deepStrictEqual(search.search(index, '', { folder: 'work/projects' }).results.map((l) => l.id), ['f']);
  assert.deepStrictEqual(search.search(index, 'in:alpha').results.map((l) => l.id), ['f']);
  assert.deepStrictEqual(search.search(index, 'folder:home').results.map((l) => l.id), ['g']);
  assert.deepStrictEqual(search.search(index, 'col:home').results.map((l) => l.id), ['g']);
  assert.ok(search.search(index, 'alpha').results.some((l) => l.id === 'f'), 'folder names are searchable');
  assert.ok(!search.search(index, '', { view: 'unfiled' }).results.some((l) => l.folder));
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
  assert.strictEqual(search.resolveGo('jira PROJ-1', store, index).url, 'https://x/browse/PROJ-1');
  assert.strictEqual(search.resolveGo('conf event portal', store, index).url, 'https://x/s?text=event%20portal');
  assert.strictEqual(search.resolveGo('agent mesh repo', store, index).link.id, 'b');
  assert.strictEqual(search.resolveGo('nothing here at all', store, index).type, 'search');
});

test('folders: normalize, parent, ancestors, within, rebase', () => {
  assert.strictEqual(folders.normalizeFolder('  work / Projects//alpha '), 'work/Projects/alpha');
  assert.strictEqual(folders.normalizeFolder('/a\\b/'), 'a/b');
  assert.strictEqual(folders.normalizeFolder(['Work', ' Projects ']), 'Work/Projects');
  assert.strictEqual(folders.normalizeFolder(''), null);
  assert.strictEqual(folders.normalizeFolder('/ / .'), null);
  assert.strictEqual(folders.parentOf('a/b/c'), 'a/b');
  assert.strictEqual(folders.parentOf('a'), null);
  assert.strictEqual(folders.nameOf('a/b/c'), 'c');
  assert.deepStrictEqual(folders.ancestorsOf('a/b/c'), ['a', 'a/b', 'a/b/c']);
  assert.strictEqual(folders.isWithin('Work/Projects', 'work'), true);
  assert.strictEqual(folders.isWithin('Workshop', 'Work'), false);
  assert.strictEqual(folders.isWithin(null, 'Work'), false);
  assert.strictEqual(folders.rebase('Work/A/x', 'Work/A', 'Archive'), 'Archive/x');
  assert.strictEqual(folders.rebase('Work/A', 'Work/A', 'B/C'), 'B/C');
  assert.strictEqual(folders.rebase('Other/x', 'Work', 'Archive'), 'Other/x');
});

test('folders: list fills ancestors and counts direct and total links', () => {
  const list = folders.listFolders(links, [{ path: 'Empty/Deep', created: '2026-01-01T00:00:00Z' }]);
  const byPath = Object.fromEntries(list.map((f) => [f.path, f]));
  assert.deepStrictEqual(list.map((f) => f.path), ['Empty', 'Empty/Deep', 'Home', 'Work', 'Work/Projects', 'Work/Projects/Alpha']);
  assert.strictEqual(byPath['Work'].count, 1);
  assert.strictEqual(byPath['Work'].total, 2);
  assert.strictEqual(byPath['Work/Projects'].count, 0);
  assert.strictEqual(byPath['Work/Projects'].total, 1);
  assert.strictEqual(byPath['Work/Projects/Alpha'].depth, 2);
  assert.strictEqual(byPath['Work/Projects/Alpha'].parent, 'Work/Projects');
  assert.strictEqual(byPath['Empty/Deep'].total, 0);
});

test('store: folders file, ensureFolder, and collection migration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-folders-'));
  fs.writeFileSync(path.join(dir, 'links.json'), JSON.stringify([{ id: 'x1', url: 'https://a.com', title: 'A', collection: 'Old / Group' }, { id: 'x2', url: 'https://b.com', title: 'B' }]));
  const s = new Store(dir);
  s.loadAll();
  assert.strictEqual(s.links[0].folder, 'Old/Group');
  assert.strictEqual('collection' in s.links[0], false);
  assert.strictEqual(s.links[1].folder, null);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'links.json'), 'utf8'))[0].folder === 'Old/Group', 'migration written back');
  assert.deepStrictEqual(s.folders, []);
  assert.strictEqual(s.ensureFolder(' Work / Projects '), 'Work/Projects');
  assert.deepStrictEqual(s.folders.map((f) => f.path), ['Work', 'Work/Projects']);
  assert.strictEqual(s.ensureFolder('work/projects/alpha'), 'work/projects/alpha');
  assert.strictEqual(s.folders.length, 3, 'existing ancestors are matched case-insensitively');
  assert.strictEqual(s.findFolder('WORK').path, 'Work');
  s.save('folders');
  assert.ok(fs.existsSync(path.join(dir, 'folders.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('importer: flatten chrome bookmarks and extract text urls', () => {
  const json = { roots: { bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [
    { type: 'url', name: 'A', url: 'https://a.com/', date_added: '13390000000000000' },
    { type: 'folder', name: 'Work', children: [{ type: 'url', name: 'B', url: 'https://b.com/x?utm_source=1' }, { type: 'folder', name: 'Projects', children: [{ type: 'url', name: 'C', url: 'https://c.com/' }] }] },
  ] }, other: { type: 'folder', name: 'Other', children: [] } } };
  const flat = importer.flattenChrome(json);
  assert.strictEqual(flat.length, 3);
  assert.strictEqual(flat[0].folder, '');
  assert.strictEqual(flat[1].folder, 'Work');
  assert.strictEqual(flat[2].folder, 'Work/Projects');
  assert.deepStrictEqual(flat[2].folders, ['Work', 'Projects']);
  assert.strictEqual(flat[1].url, 'https://b.com/x');
  assert.ok(flat[0].added.startsWith('20'));
  const t = importer.extractFromText('see https://x.com/a, and http://y.org/b. Also https://x.com/a again');
  assert.deepStrictEqual(t.map((i) => i.url), ['https://x.com/a', 'http://y.org/b']);
});

test('importer: preview marks duplicates', () => {
  const store = { links: [{ id: 'z', url: 'https://b.com/x' }], rules: [] };
  const p = importer.preview([{ url: 'https://B.com/x/', title: 'B', folder: 'Work' }, { url: 'https://c.com', title: 'C', folder: '' }, { url: 'https://d.com', title: 'D', folders: ['Work', 'Projects'] }], store);
  assert.strictEqual(p[0].duplicate, true);
  assert.strictEqual(p[0].existingId, 'z');
  assert.deepStrictEqual(p[0].tags, ['work']);
  assert.strictEqual(p[0].folder, 'Work');
  assert.strictEqual(p[1].duplicate, false);
  assert.strictEqual(p[1].folder, null);
  assert.strictEqual(p[2].folder, 'Work/Projects');
  assert.deepStrictEqual(p[2].tags, ['projects'], 'the innermost folder becomes a tag');
  const own = importer.preview([{ url: 'https://e.com', title: 'E', folder: 'Work', tags: ['Mine'] }], store);
  assert.deepStrictEqual(own[0].tags, ['mine'], 'tags from the file are kept and the folder tag is not added');
});

test('suggest: well-known tools from the URL', () => {
  const jira = suggest.siteInfo('https://acme.atlassian.net/browse/PROJ-123');
  assert.deepStrictEqual([jira.site, jira.folder, jira.keyword], ['jira', 'Jira/PROJ', 'proj-123']);
  assert.ok(jira.tags.includes('jira') && jira.tags.includes('proj'));
  const conf = suggest.siteInfo('https://acme.atlassian.net/wiki/spaces/EP/pages/1/Design');
  assert.deepStrictEqual([conf.site, conf.folder], ['confluence', 'Confluence/EP']);
  const sp = suggest.siteInfo('https://acme.sharepoint.com/sites/Marketing/Shared%20Documents/Plans/2026/plan.docx');
  assert.deepStrictEqual([sp.site, sp.folder], ['sharepoint', 'SharePoint/Marketing/Plans/2026']);
  assert.strictEqual(suggest.siteInfo('https://acme-my.sharepoint.com/personal/x/Documents/a.xlsx').folder, 'OneDrive');
  const gh = suggest.siteInfo('https://github.com/acme/service-mesh');
  assert.deepStrictEqual([gh.site, gh.folder, gh.keyword], ['github', 'GitHub/acme', 'service-mesh']);
  assert.strictEqual(suggest.siteInfo('https://github.com/acme/service-mesh/pull/12').keyword, null);
  assert.strictEqual(suggest.siteInfo('https://docs.google.com/spreadsheets/d/abc/edit').tags[0], 'gsheet');
  assert.strictEqual(suggest.siteInfo('https://example.com/x').site, null);
});

test('suggest: page metadata, learned folders and tags, keyword candidates', () => {
  const page = suggest.fromPage({ keywords: 'Platform, roadmap, the, 2026', siteName: 'Acme Wiki', breadcrumbs: ['Home', 'Projects', 'PROJ', 'Event Portal Rollout'], title: 'Event Portal Rollout', author: 'Giri' });
  assert.deepStrictEqual(page.tags, ['platform', 'roadmap', 'acme-wiki']);
  assert.strictEqual(page.folder, 'Projects/PROJ', 'home and the page itself are dropped from breadcrumbs');
  assert.strictEqual(page.details.author, 'Giri');
  const links = [
    { id: 'a', url: 'https://acme.atlassian.net/browse/PROJ-1', folder: 'Work/Jira', tags: ['jira', 'planning'] },
    { id: 'b', url: 'https://acme.atlassian.net/wiki/spaces/EP/pages/2/X', folder: 'Work/Docs', tags: ['confluence'] },
    { id: 'c', url: 'https://other.com/', folder: 'Elsewhere', tags: ['nope'] },
  ];
  const l = suggest.learned('https://acme.atlassian.net/browse/PROJ-9', links);
  assert.strictEqual(l.folders[0].path, 'Work/Jira', 'shared path prefix outranks host only');
  assert.ok(l.tags.map((t) => t.name).includes('planning') && !l.tags.map((t) => t.name).includes('nope'));
  const s = suggest.suggest('https://acme.atlassian.net/browse/PROJ-9', { title: 'Event Portal Rollout', page: { breadcrumbs: ['Projects', 'PROJ'] }, links, existingTags: ['jira'], isKeywordTaken: (k) => k === 'proj-9' });
  assert.deepStrictEqual(s.folders.map((f) => f.path), ['Work/Jira', 'Work/Docs', 'Projects/PROJ', 'Jira/PROJ']);
  assert.ok(!s.tags.some((t) => t.name === 'jira'), 'tags already on the link are not suggested again');
  assert.deepStrictEqual(s.keywords.map((k) => k.keyword), ['epr'], 'taken keyword filtered, initials kept');
  assert.strictEqual(suggest.suggest('https://acme.atlassian.net/browse/PROJ-9', { currentFolder: 'Jira/PROJ' }).folders.some((f) => f.path === 'Jira/PROJ'), false);
});

test('xlsx: write and read back strings, numbers and escapes', () => {
  const rows = xlsx.readXlsx(xlsx.writeXlsx([['url', 'title', 'n'], ['https://z.com', 'Zed & <co> "q"', 42], ['https://y.com', '', 0]]));
  assert.deepStrictEqual(rows[0], ['url', 'title', 'n']);
  assert.deepStrictEqual(rows[1], ['https://z.com', 'Zed & <co> "q"', '42']);
  assert.strictEqual(rows[2][0], 'https://y.com');
});

const exportLinks = [
  { id: 'a', url: 'https://a.com/x', title: 'A "quoted", title', folder: 'Work/Projects', tags: ['t1', 't2'], keyword: 'aa', description: 'desc', notes: 'n1\nn2', aliases: ['al'], created: '2026-01-01T00:00:00.000Z', lastUsed: '2026-02-01T00:00:00.000Z', useCount: 3 },
  { id: 'b', url: 'https://b.com/', title: 'B', folder: null, tags: [], created: '2026-01-02T00:00:00.000Z', useCount: 0 },
];

test('export and import round-trip for every format', () => {
  for (const f of Object.keys(exporter.FORMATS)) {
    const r = exporter.exportLinks(f, exportLinks, [], { version: 't' });
    assert.ok(r.filename.endsWith('.' + exporter.FORMATS[f].ext), f + ' filename');
    const back = importer.loadAny(r.filename, r.body);
    assert.strictEqual(back.items.length, 2, f + ' item count');
    const a = back.items.find((i) => i.url === 'https://a.com/x');
    assert.ok(a, f + ' keeps the url');
    if (f !== 'txt') assert.strictEqual(a.title, 'A "quoted", title', f + ' keeps the title');
    if (f !== 'txt') assert.strictEqual(a.folder, 'Work/Projects', f + ' keeps the folder');
    if (f !== 'txt') assert.deepStrictEqual(a.tags, ['t1', 't2'], f + ' keeps tags');
    if (['json', 'html', 'csv', 'xlsx'].includes(f)) assert.strictEqual(a.keyword, 'aa', f + ' keeps the keyword');
    if (['json', 'csv', 'xlsx'].includes(f)) assert.strictEqual(a.notes, 'n1\nn2', f + ' keeps notes');
    if (['json', 'html', 'csv', 'xlsx'].includes(f)) assert.strictEqual(a.added, '2026-01-01T00:00:00.000Z', f + ' keeps the created date');
  }
  assert.strictEqual(exporter.exportLinks('json', exportLinks, [], { folder: 'work' }).count, 1, 'folder scope includes subfolders');
  assert.strictEqual(exporter.exportLinks('txt', exportLinks, [], { tag: 't1' }).count, 1, 'tag scope');
});

test('importer: browser bookmarks html, csv with loose headers, markdown', () => {
  const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Bookmarks bar</H3><DL><p><DT><A HREF="https://a.com/" ADD_DATE="1704067200" TAGS="x,y">A &amp; B</A><DT><H3>Work</H3><DL><p><DT><H3>Sub</H3><DL><p><DT><A HREF="https://c.com/">C</A><DD>note here</DL><p></DL><p></DL><p></DL><p>';
  const items = importer.parseBookmarksHtml(html);
  assert.deepStrictEqual(items.map((i) => [i.title, i.folder, i.tags]), [['A & B', '', ['x', 'y']], ['C', 'Work/Sub', []]]);
  assert.strictEqual(items[0].added, '2024-01-01T00:00:00.000Z');
  assert.strictEqual(items[1].description, 'note here');
  const csv = importer.itemsFromRows(importer.parseCsv('Link,Name,Path,Labels\n"https://a.com/x","Hello, world",Work/Docs,"one; two"\nhttps://b.com,B,,\n'));
  assert.deepStrictEqual([csv[0].title, csv[0].folder, csv[0].tags], ['Hello, world', 'Work/Docs', ['one', 'two']]);
  assert.strictEqual(csv.length, 2);
  const bare = importer.itemsFromRows([['https://only.com/'], ['https://two.com/']]);
  assert.strictEqual(bare.length, 2, 'header-less url column');
  const md = importer.extractFromText('# Links\n\n## Work / Docs\n\n- [Spec](https://s.com/spec) #design #v2\n- plain https://p.com here\n\n## Unfiled\n\n- [U](https://u.com)');
  assert.deepStrictEqual(md.map((i) => [i.url, i.title, i.folder, i.tags]), [['https://s.com/spec', 'Spec', 'Work/Docs', ['design', 'v2']], ['https://p.com/', '', 'Work/Docs', []], ['https://u.com/', 'U', '', []]]);
  assert.strictEqual(importer.loadAny('x.json', JSON.stringify({ roots: { bookmark_bar: { type: 'folder', name: 'b', children: [] } } })).format, 'chrome');
  assert.strictEqual(importer.loadAny('x.json', JSON.stringify({ links: [{ url: 'https://q.com', title: 'Q', folder: 'F', keyword: 'q' }] })).items[0].keyword, 'q');
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
  assert.strictEqual(looksLikeLogin({ finalUrl: 'https://acme.okta.com/login/login.htm', title: '', html: '' }), true);
  assert.strictEqual(looksLikeLogin({ finalUrl: 'https://x.com/a', title: 'Sign in to Confluence', html: '' }), true);
  assert.strictEqual(looksLikeLogin({ finalUrl: 'https://x.com/a', title: 'Design notes', html: '<main>hi</main>' }), false);
});

test('snapshots: tile svg escapes', () => {
  const svg = tileSvg('https://docs.example.com/x', 'A <b> "title"');
  assert.ok(svg.includes('docs.example.com'));
  assert.ok(!svg.includes('<b>'));
});

console.log(`${passed} tests passed${process.exitCode ? ', some failed' : ''}`);
