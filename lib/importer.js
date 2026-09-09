'use strict';

// Import from browser profiles (Chrome-style Bookmarks JSON), and from files in every
// format the exporter writes: Golinks JSON, Netscape bookmarks HTML, CSV, XLSX, Markdown
// and plain text. Every loader yields the same item shape:
//   { url, title, folder, folders, tags, keyword, description, notes, aliases, added, lastUsed, useCount }

const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanUrl, dedupeKey } = require('./url');
const { applyRules, slugTag } = require('./rules');
const { normalizeFolder, nameOf } = require('./folders');
const { readXlsx } = require('./xlsx');

const HOME = os.homedir();
const KNOWN_PATHS = {
  chrome: path.join(HOME, 'Library/Application Support/Google/Chrome/Default/Bookmarks'),
  brave: path.join(HOME, 'Library/Application Support/BraveSoftware/Brave-Browser/Default/Bookmarks'),
  chromium: path.join(HOME, 'Library/Application Support/Chromium/Default/Bookmarks'),
  edge: path.join(HOME, 'Library/Application Support/Microsoft Edge/Default/Bookmarks'),
};

function availableSources() {
  return Object.entries(KNOWN_PATHS)
    .filter(([, p]) => fs.existsSync(p))
    .map(([name, p]) => ({ name, path: p, size: fs.statSync(p).size, modified: fs.statSync(p).mtime.toISOString() }));
}

// Chrome stores dates as microseconds since 1601-01-01.
function chromeTime(v) {
  const n = Number(v);
  if (!n) return null;
  const ms = n / 1000 - 11644473600000;
  if (!isFinite(ms) || ms < 0) return null;
  return new Date(ms).toISOString();
}

function flattenChrome(json) {
  const out = [];
  const roots = (json && json.roots) || {};
  const rootNames = { bookmark_bar: 'Bookmarks Bar', other: 'Other Bookmarks', synced: 'Mobile Bookmarks' };
  for (const [key, node] of Object.entries(roots)) {
    if (!node || typeof node !== 'object') continue;
    walk(node, [], rootNames[key] || node.name || key);
  }
  function walk(node, folders, rootName) {
    if (node.type === 'url') {
      const url = cleanUrl(node.url);
      if (!url) return;
      out.push({
        url,
        title: node.name || '',
        folders: folders.slice(),
        folder: normalizeFolder(folders) || '',
        root: rootName,
        added: chromeTime(node.date_added),
      });
    } else if (Array.isArray(node.children)) {
      const next = node.type === 'folder' && !isRoot(node) ? [...folders, node.name] : folders;
      for (const c of node.children) walk(c, next, rootName);
    }
  }
  function isRoot(node) {
    return Object.values(roots).includes(node);
  }
  return out;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;

// Plain text or Markdown. Markdown links keep their title; "## Folder" headings written by
// our own exporter become folders; trailing #tags on a line become tags.
function extractFromText(text) {
  const out = [];
  const seen = new Set();
  let folder = '';
  const push = (rawUrl, title, tags) => {
    const url = cleanUrl(String(rawUrl || '').replace(/[.,;:!?]+$/, ''));
    if (!url) return;
    const key = dedupeKey(url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url, title: title || '', folders: [], folder, tags: tags || [], root: 'text', added: null });
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { const name = h[1].trim(); folder = /^unfiled$/i.test(name) ? '' : normalizeFolder(name.split(/\s*\/\s*/)) || ''; continue; }
    const tags = (line.match(/(?:^|\s)#([a-z0-9][a-z0-9._+-]*)/gi) || []).map((t) => t.trim().slice(1));
    let rest = line;
    const md = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
    let m;
    while ((m = md.exec(line))) { push(m[2], m[1].trim(), tags); rest = rest.replace(m[0], ' '); }
    for (const raw of rest.match(URL_RE) || []) push(raw, '', tags);
  }
  return out;
}

// Netscape bookmark file (what browsers export): <H3> folders nest, <A> entries carry
// ADD_DATE, TAGS (Firefox and our exporter) and SHORTCUTURL (Firefox keyword).
function parseBookmarksHtml(html) {
  const out = [];
  const stack = [];
  const dec = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&').trim();
  const attr = (tag, name) => { const m = new RegExp(name + '="([^"]*)"', 'i').exec(tag); return m ? dec(m[1]) : ''; };
  const re = /<H3[^>]*>([\s\S]*?)<\/H3>|<\/DL>|<A\s([^>]*)>([\s\S]*?)<\/A>(?:\s*<DD>([^<]*))?/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].toUpperCase().startsWith('<H3')) { stack.push(dec(m[1].replace(/<[^>]+>/g, ''))); continue; }
    if (m[0].toUpperCase() === '</DL>') { stack.pop(); continue; }
    const tag = m[2];
    const url = cleanUrl(attr(tag, 'HREF'));
    if (!url) continue;
    const add = Number(attr(tag, 'ADD_DATE'));
    const visit = Number(attr(tag, 'LAST_VISIT'));
    const tags = attr(tag, 'TAGS').split(',').map((t) => t.trim()).filter(Boolean);
    const dd = dec(m[4] || '');
    // browsers put the root folder ("Bookmarks bar") first; drop it
    const folders = stack.filter((f) => f && !/^(bookmarks?( bar| menu| toolbar)?|other bookmarks|mobile bookmarks|favorites bar|imported)$/i.test(f));
    out.push({ url, title: dec(m[3].replace(/<[^>]+>/g, '')), folders, folder: normalizeFolder(folders) || '', tags, keyword: attr(tag, 'SHORTCUTURL') || null, description: dd, root: 'html', added: add > 0 ? new Date(add * (add > 1e12 ? 1 : 1000)).toISOString() : null, lastUsed: visit > 0 ? new Date(visit * (visit > 1e12 ? 1 : 1000)).toISOString() : null });
  }
  return out;
}

// Golinks JSON export ({ links: [...] }) or a bare array of links.
function parseGolinksJson(json) {
  const links = Array.isArray(json) ? json : json && Array.isArray(json.links) ? json.links : null;
  if (!links) throw new Error('not a Golinks JSON export');
  const out = [];
  for (const l of links) {
    if (!l || typeof l !== 'object') continue;
    const url = cleanUrl(l.url);
    if (!url) continue;
    out.push({ url, title: String(l.title || ''), folders: [], folder: normalizeFolder(l.folder || l.collection) || '', tags: Array.isArray(l.tags) ? l.tags : [], keyword: l.keyword || null, description: String(l.description || ''), notes: String(l.notes || ''), aliases: Array.isArray(l.aliases) ? l.aliases : [], root: 'golinks', added: l.created || null, lastUsed: l.lastUsed || null, useCount: Number(l.useCount) || 0 });
  }
  return out;
}

// RFC 4180 style CSV -> rows of strings.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^\ufeff/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' ) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

// Rows with a header (from CSV or XLSX) -> items. Column names are matched loosely, so
// "URL", "Address", "Link" all work, and a header-less single column of URLs works too.
function itemsFromRows(rows) {
  if (!rows.length) return [];
  const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const header = rows[0].map(norm);
  const find = (...names) => header.findIndex((h) => names.includes(h));
  const col = {
    url: find('url', 'address', 'link', 'href'), title: find('title', 'name'), folder: find('folder', 'path', 'collection'), tags: find('tags', 'tag', 'labels'),
    keyword: find('keyword', 'shortcut', 'alias'), description: find('description', 'summary'), notes: find('notes', 'note', 'comment'), aliases: find('aliases'),
    created: find('created', 'added', 'adddate', 'date'), lastUsed: find('lastused', 'lastvisit', 'visited'), useCount: find('usecount', 'opens', 'visits'),
  };
  let body = rows.slice(1);
  if (col.url < 0) {
    // no header: take the first column that looks like URLs
    const idx = rows[0].findIndex((c) => /^https?:\/\//i.test(String(c)));
    if (idx < 0) throw new Error('no URL column found (expected a header such as url, title, folder, tags)');
    col.url = idx; body = rows;
    for (const k of Object.keys(col)) if (k !== 'url') col[k] = -1;
  }
  const get = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
  const list = (v) => v.split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
  const out = [];
  for (const r of body) {
    const url = cleanUrl(get(r, col.url));
    if (!url) continue;
    const created = get(r, col.created);
    const used = get(r, col.lastUsed);
    out.push({ url, title: get(r, col.title), folders: [], folder: normalizeFolder(get(r, col.folder)) || '', tags: list(get(r, col.tags)), keyword: get(r, col.keyword) || null, description: get(r, col.description), notes: get(r, col.notes), aliases: list(get(r, col.aliases)), root: 'table', added: created && Date.parse(created) ? new Date(created).toISOString() : null, lastUsed: used && Date.parse(used) ? new Date(used).toISOString() : null, useCount: Number(get(r, col.useCount)) || 0 });
  }
  return out;
}

// Detects the format from the file name and content. content is a string, or a Buffer for
// binary files (.xlsx). Returns { format, items }.
function loadAny(name, content) {
  const ext = (String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  const buf = Buffer.isBuffer(content) ? content : null;
  const text = buf ? (ext === 'xlsx' || (buf[0] === 0x50 && buf[1] === 0x4b) ? '' : buf.toString('utf8')) : String(content || '');
  if (ext === 'xlsx' || (buf && buf[0] === 0x50 && buf[1] === 0x4b)) return { format: 'xlsx', items: itemsFromRows(readXlsx(buf || Buffer.from(content, 'binary'))) };
  const trimmed = text.replace(/^\ufeff/, '').trimStart();
  if (ext === 'json' || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let json;
    try { json = JSON.parse(trimmed); } catch { throw new Error('not valid JSON'); }
    if (json && json.roots) return { format: 'chrome', items: flattenChrome(json) };
    return { format: 'golinks', items: parseGolinksJson(json) };
  }
  if (ext === 'html' || ext === 'htm' || /<!DOCTYPE NETSCAPE-Bookmark|<DL>|<A\s+HREF=/i.test(trimmed)) return { format: 'html', items: parseBookmarksHtml(text) };
  if (ext === 'csv' || (ext !== 'md' && ext !== 'txt' && /^[^\n]*\b(url|address|link)\b[^\n]*\n/i.test(trimmed) && trimmed.split('\n')[0].includes(','))) return { format: 'csv', items: itemsFromRows(parseCsv(text)) };
  return { format: ext === 'md' ? 'markdown' : 'text', items: extractFromText(text) };
}

// Decorate items with rule tags, a tag for the innermost folder, the folder path and duplicate info.
function preview(items, store) {
  const existing = new Map();
  for (const l of store.links) {
    const k = dedupeKey(l.url);
    if (k && !existing.has(k)) existing.set(k, l);
  }
  const seen = new Map();
  return items.map((it) => {
    const key = dedupeKey(it.url);
    const dup = existing.get(key) || null;
    const within = seen.get(key);
    seen.set(key, true);
    const tags = [];
    for (const t of [...(Array.isArray(it.tags) ? it.tags : []), ...applyRules(it.url, store.rules)]) { const s = slugTag(t); if (s && !tags.includes(s)) tags.push(s); }
    const folder = normalizeFolder(Array.isArray(it.folders) && it.folders.length ? it.folders : it.folder);
    const leaf = folder ? slugTag(nameOf(folder)) : '';
    // a tag for the innermost folder, unless the source already carried its own tags
    if (leaf && !tags.includes(leaf) && !(Array.isArray(it.tags) && it.tags.length)) tags.push(leaf);
    return {
      ...it,
      key,
      tags,
      folder,
      duplicate: Boolean(dup) || Boolean(within),
      existingId: dup ? dup.id : null,
      selected: !dup && !within,
    };
  });
}

function loadBookmarksFile(source, filePath, content) {
  let text = content;
  let resolved = filePath;
  if (!text) {
    resolved = filePath || KNOWN_PATHS[source];
    if (!resolved || !fs.existsSync(resolved)) throw new Error(`bookmarks file not found for ${source || filePath}`);
    text = fs.readFileSync(resolved, 'utf8');
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('not a Chrome-style Bookmarks JSON file'); }
  return { items: flattenChrome(json), path: resolved || null };
}

module.exports = { KNOWN_PATHS, availableSources, flattenChrome, extractFromText, parseBookmarksHtml, parseGolinksJson, parseCsv, itemsFromRows, loadAny, preview, loadBookmarksFile, chromeTime };
