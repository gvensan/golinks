'use strict';

// Import from Chrome and Brave Bookmarks files, and from pasted text.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanUrl, dedupeKey } = require('./url');
const { applyRules, slugTag } = require('./rules');

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
      const folderPath = folders.length ? folders : [];
      out.push({
        url,
        title: node.name || '',
        folder: folderPath.join(' / '),
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

function extractFromText(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').match(URL_RE) || []) {
    const trimmed = raw.replace(/[.,;:!?]+$/, '');
    const url = cleanUrl(trimmed);
    if (!url) continue;
    const key = dedupeKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, title: '', folder: '', root: 'text', added: null });
  }
  return out;
}

// Decorate items with rule tags, folder tag, collection and duplicate info.
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
    const tags = applyRules(it.url, store.rules);
    const folders = it.folder ? it.folder.split(' / ') : [];
    const leaf = folders.length ? slugTag(folders[folders.length - 1]) : '';
    if (leaf && !tags.includes(leaf)) tags.push(leaf);
    return {
      ...it,
      key,
      tags,
      collection: it.folder || null,
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

module.exports = { KNOWN_PATHS, availableSources, flattenChrome, extractFromText, preview, loadBookmarksFile, chromeTime };
