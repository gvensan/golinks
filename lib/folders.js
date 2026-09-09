'use strict';

// Folders: a link belongs to at most one folder, stored as a path string with
// "/" between levels ("Work/Projects/Alpha"). Nesting is implied by the path, so
// a folder exists when a link uses it or when it was created explicitly
// (data/folders.json keeps those so empty folders survive).

const SEP = '/';
const MAX_DEPTH = 8;
const MAX_SEGMENT = 60;

// "  work / Projects//alpha " -> "work/Projects/alpha"; empty -> null.
// Accepts an array of segments too (the importer passes Chrome folder names).
function normalizeFolder(v) {
  let parts;
  if (Array.isArray(v)) parts = v.map((s) => String(s == null ? '' : s));
  else parts = String(v == null ? '' : v).split(/[\/\\]/);
  const out = [];
  for (const raw of parts) {
    const s = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SEGMENT).trim();
    if (!s || s === '.' || s === '..') continue;
    out.push(s);
    if (out.length >= MAX_DEPTH) break;
  }
  return out.length ? out.join(SEP) : null;
}

function segments(path) {
  return path ? String(path).split(SEP) : [];
}

function parentOf(path) {
  const segs = segments(path);
  segs.pop();
  return segs.length ? segs.join(SEP) : null;
}

function nameOf(path) {
  const segs = segments(path);
  return segs.length ? segs[segs.length - 1] : '';
}

// Every ancestor including the path itself: "a/b/c" -> ["a", "a/b", "a/b/c"].
function ancestorsOf(path) {
  const segs = segments(path);
  const out = [];
  for (let i = 1; i <= segs.length; i++) out.push(segs.slice(0, i).join(SEP));
  return out;
}

// True when `path` is `folder` or lies inside it. Comparison is case-insensitive.
function isWithin(path, folder) {
  if (!path || !folder) return false;
  const a = String(path).toLowerCase();
  const b = String(folder).toLowerCase();
  return a === b || a.startsWith(b + SEP);
}

// Moves `path` from under `from` to under `to`; returns the path unchanged when it is
// not inside `from`. rebase("Work/A/x", "Work/A", "Archive") -> "Archive/x".
function rebase(path, from, to) {
  if (!isWithin(path, from)) return path;
  const rest = String(path).slice(from.length);
  const head = to || '';
  const joined = (head + rest).replace(/^\/+/, '');
  return joined || null;
}

// Flat list of folders with counts. `explicit` are the records from folders.json
// ({ path, created }); links contribute their `folder`. Ancestors are filled in so
// the tree is always complete. Sorted by path, case-insensitive, so children follow
// their parent.
function listFolders(links, explicit) {
  const map = new Map(); // lower-case path -> { path, count, total, created }
  const touch = (p, created) => {
    const key = p.toLowerCase();
    let f = map.get(key);
    if (!f) { f = { path: p, count: 0, total: 0, created: created || null }; map.set(key, f); }
    else if (created && !f.created) f.created = created;
    return f;
  };
  for (const rec of explicit || []) {
    const p = normalizeFolder(rec && rec.path);
    if (!p) continue;
    for (const a of ancestorsOf(p)) touch(a, a === p ? rec.created : null);
  }
  for (const l of links || []) {
    const p = normalizeFolder(l.folder);
    if (!p) continue;
    const anc = ancestorsOf(p);
    for (const a of anc) touch(a).total++;
    touch(p).count++;
  }
  return [...map.values()]
    .sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()))
    .map((f) => ({ path: f.path, name: nameOf(f.path), parent: parentOf(f.path), depth: segments(f.path).length - 1, count: f.count, total: f.total, created: f.created }));
}

module.exports = { SEP, MAX_DEPTH, normalizeFolder, segments, parentOf, nameOf, ancestorsOf, isWithin, rebase, listFolders };
