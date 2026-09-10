'use strict';

// Duplicate and near-duplicate detection, and merging.
//
// Groups, in order of confidence:
//   exact    same dedupe key (scheme, www, fragment, trailing slash and param order ignored)
//   variant  same host and path, different query string (tabs, view params, unknown trackers)
//   title    same site and the same title, different address (moved pages, print views)
// A group can be dismissed with "not duplicates"; that stores the id pairs so the group stays hidden.

const { parse, dedupeKey, domainLabel, hostname } = require('./url');

function variantKey(url) {
  const u = parse(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let path = u.pathname.toLowerCase().replace(/\/+$/, '').replace(/\/(index|default)\.(html?|php|aspx?)$/, '');
  return host + (path || '/');
}

const GENERIC_TITLE = /^(home|untitled|login|sign in|index|dashboard|overview|document|page|new tab)$/i;
const HOST_LIKE = /^[\w-]+(\.[\w-]+)+$/; // "docs.example.com": the fallback title when a page gave none

function normTitle(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' '); }

function titleKey(link) {
  const raw = String(link.title || '').trim();
  const t = normTitle(raw);
  if (t.length < 8 || GENERIC_TITLE.test(t) || HOST_LIKE.test(raw)) return null;
  const host = hostname(link.url).replace(/^www\./, '');
  if (!host || t === normTitle(host) || t === normTitle(domainLabel(link.url))) return null;
  return domainLabel(link.url) + '|' + t;
}

function pairKey(a, b) { return a < b ? a + ':' + b : b + ':' + a; }

// Every pair inside the group is on the ignore list.
function isIgnored(ids, ignore) {
  if (!ignore || !ignore.size) return false;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (!ignore.has(pairKey(ids[i], ids[j]))) return false;
  return true;
}

// The link that survives a merge: most used, then a real snapshot over a tile, then oldest.
function pickKeep(links) {
  return [...links].sort((a, b) =>
    (b.useCount || 0) - (a.useCount || 0)
    || Number(Boolean(b.snapshot && b.snapshotMethod !== 'tile')) - Number(Boolean(a.snapshot && a.snapshotMethod !== 'tile'))
    || Date.parse(a.created || 0) - Date.parse(b.created || 0))[0];
}

// links: live links. ignore: iterable of "idA:idB" pairs. Returns groups with the member ids
// (ordered with the suggested survivor first) and a short reason.
function findGroups(links, ignore = []) {
  const ign = new Set(ignore);
  const groups = [];
  const covered = new Set(); // "sorted ids" already emitted, so a variant group never repeats an exact one
  const emit = (kind, members, why) => {
    if (members.length < 2) return;
    const ids = members.map((l) => l.id).sort();
    const sig = ids.join(',');
    if (covered.has(sig) || isIgnored(ids, ign)) return;
    covered.add(sig);
    const keep = pickKeep(members);
    groups.push({ kind, why, keep: keep.id, ids: [keep.id, ...ids.filter((id) => id !== keep.id)] });
  };
  const bucket = (keyFn) => {
    const m = new Map();
    for (const l of links) {
      const k = keyFn(l);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(l);
    }
    return m;
  };
  for (const [, members] of bucket((l) => dedupeKey(l.url))) emit('exact', members, 'Same address');
  for (const [, members] of bucket((l) => variantKey(l.url))) {
    if (new Set(members.map((l) => dedupeKey(l.url))).size < 2) continue; // all exact, already emitted
    emit('variant', members, 'Same page, different query string');
  }
  for (const [, members] of bucket(titleKey)) {
    if (new Set(members.map((l) => variantKey(l.url))).size < 2) continue;
    emit('title', members, 'Same site and title, different address');
  }
  const rank = { exact: 0, variant: 1, title: 2 };
  groups.sort((a, b) => rank[a.kind] - rank[b.kind] || b.ids.length - a.ids.length);
  return groups;
}

function uniq(list) { return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))]; }

// Folds `others` into `keep` (mutates keep). Tags and aliases are unioned, other titles become
// aliases, notes are appended, missing fields are filled, use counts add up. Returns the field
// names that changed. Snapshot files are the caller's business (ids differ).
function mergeInto(keep, others) {
  const changed = new Set();
  const set = (field, value) => { keep[field] = value; changed.add(field); };
  const tags = uniq([...(keep.tags || []), ...others.flatMap((o) => o.tags || [])]);
  if (tags.length !== (keep.tags || []).length) set('tags', tags);
  const aliases = uniq([...(keep.aliases || []), ...others.flatMap((o) => [...(o.aliases || []), o.title && o.title !== keep.title ? o.title : ''])]);
  if (aliases.length !== (keep.aliases || []).length) set('aliases', aliases);
  if (!keep.keyword) { const kw = others.find((o) => o.keyword); if (kw) set('keyword', kw.keyword); }
  if (!keep.folder) { const f = others.find((o) => o.folder); if (f) set('folder', f.folder); }
  if (!keep.description) { const d = others.find((o) => o.description); if (d) set('description', d.description); }
  const notes = [keep.notes, ...others.map((o) => o.notes)].map((n) => String(n || '').trim()).filter(Boolean);
  if (uniq(notes).length > 1 || (!keep.notes && notes.length)) set('notes', uniq(notes).join('\n\n'));
  const uses = others.reduce((n, o) => n + (o.useCount || 0), 0);
  if (uses) set('useCount', (keep.useCount || 0) + uses);
  const last = [keep.lastUsed, ...others.map((o) => o.lastUsed)].filter(Boolean).sort().pop() || null;
  if (last !== (keep.lastUsed || null)) set('lastUsed', last);
  const first = [keep.created, ...others.map((o) => o.created)].filter(Boolean).sort()[0];
  if (first && first !== keep.created) set('created', first);
  return [...changed];
}

module.exports = { variantKey, titleKey, pairKey, pickKeep, findGroups, mergeInto };
