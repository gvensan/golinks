'use strict';

// Search, ranking and go-link resolution.
//
// Tokenized fuzzy match over title, url, tags, aliases, notes, keyword, collection.
// Abbreviation match: "ep" matches "Event Portal" by initials.
// Operators: tag:x site:x col:x unused:90d added:7d is:untagged is:stale is:unused
// Score = text match quality x frecency. Exact keyword match always wins.

const { hostname } = require('./url');

const DAY = 86400000;

const FIELD_WEIGHTS = {
  keyword: 3,
  title: 2,
  tags: 2,
  aliases: 2,
  collection: 1.2,
  host: 1.2,
  path: 0.8,
  description: 0.7,
  notes: 0.5,
};

function splitCamel(s) {
  return String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function tokenize(s) {
  return splitCamel(s)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function initialsOf(s) {
  return tokenize(s).map((t) => t[0]).join('');
}

function indexLink(link) {
  const url = link.url || '';
  const host = hostname(url).replace(/^www\./, '');
  let pathPart = '';
  try { const u = new URL(url); pathPart = u.pathname + ' ' + u.search; } catch { /* ignore */ }
  const fields = {
    keyword: link.keyword ? [String(link.keyword).toLowerCase()] : [],
    title: tokenize(link.title),
    tags: (link.tags || []).flatMap((t) => [String(t).toLowerCase(), ...tokenize(t)]),
    aliases: (link.aliases || []).flatMap((a) => tokenize(a)),
    collection: tokenize(link.collection),
    host: [host, ...host.split('.').filter((p) => p.length > 2 && !/^(com|net|org|io|dev|co|www)$/.test(p))],
    path: tokenize(pathPart),
    description: tokenize(link.description),
    notes: tokenize(link.notes),
  };
  const initials = new Set([initialsOf(link.title), ...(link.aliases || []).map(initialsOf)].filter((x) => x.length >= 2));
  const phrases = [String(link.title || '').toLowerCase(), ...(link.aliases || []).map((a) => String(a).toLowerCase())];
  return { link, fields, initials, phrases, host };
}

function buildIndex(links) {
  return links.map(indexLink);
}

// ---- query parsing ----

function parseDays(v) {
  const m = /^(\d+)\s*(d|w|m|y)?$/i.exec(String(v || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'd').toLowerCase();
  return n * (unit === 'w' ? 7 : unit === 'm' ? 30 : unit === 'y' ? 365 : 1);
}

function parseQuery(q) {
  const parsed = { terms: [], phrase: '', tags: [], sites: [], cols: [], unusedDays: null, addedDays: null, flags: [] };
  const raw = String(q || '').trim();
  const words = [];
  for (const part of raw.split(/\s+/).filter(Boolean)) {
    const m = /^(tag|site|col|collection|unused|added|is):(.*)$/i.exec(part);
    if (!m) { words.push(part); continue; }
    const op = m[1].toLowerCase();
    const val = m[2].toLowerCase();
    if (!val) continue;
    if (op === 'tag') parsed.tags.push(val);
    else if (op === 'site') parsed.sites.push(val);
    else if (op === 'col' || op === 'collection') parsed.cols.push(val);
    else if (op === 'unused') parsed.unusedDays = parseDays(val);
    else if (op === 'added') parsed.addedDays = parseDays(val);
    else if (op === 'is') parsed.flags.push(val);
  }
  parsed.phrase = words.join(' ').toLowerCase();
  parsed.terms = tokenize(words.join(' '));
  return parsed;
}

// ---- matching ----

function isSubsequence(needle, hay) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
}

function matchToken(term, tok) {
  if (tok === term) return 1;
  if (tok.startsWith(term)) return 0.85;
  if (term.length >= 3 && tok.includes(term)) return 0.6;
  if (term.length >= 3 && tok.length <= term.length * 3 && isSubsequence(term, tok)) return 0.3 * (term.length / tok.length) + 0.1;
  return 0;
}

function scoreTerm(term, entry) {
  let best = 0;
  for (const [field, tokens] of Object.entries(entry.fields)) {
    const w = FIELD_WEIGHTS[field];
    for (const tok of tokens) {
      const s = matchToken(term, tok);
      if (s * w > best) best = s * w;
    }
  }
  // abbreviation: "ep" -> "event portal"
  if (term.length >= 2 && term.length <= 6) {
    for (const ini of entry.initials) {
      if (ini === term && 0.9 * FIELD_WEIGHTS.title > best) best = 0.9 * FIELD_WEIGHTS.title;
      else if (ini.startsWith(term) && 0.7 * FIELD_WEIGHTS.title > best) best = 0.7 * FIELD_WEIGHTS.title;
    }
  }
  return best;
}

function textScore(parsed, entry) {
  if (!parsed.terms.length) return 1;
  const kw = entry.fields.keyword[0];
  if (kw && parsed.phrase === kw) return 1000;
  let total = 0;
  for (const term of parsed.terms) {
    const s = scoreTerm(term, entry);
    if (s <= 0) return 0;
    total += s;
  }
  let score = total / parsed.terms.length;
  // phrase bonus when the whole query appears in the title or an alias
  if (parsed.terms.length > 1) {
    for (const p of entry.phrases) if (p.includes(parsed.phrase)) { score *= 1.25; break; }
  }
  return score;
}

function frecency(link, now = Date.now()) {
  const used = link.lastUsed ? (now - Date.parse(link.lastUsed)) / DAY : null;
  const decay = used === null ? 0 : Math.exp(-Math.max(0, used) / 30);
  const uses = Math.log1p(link.useCount || 0);
  return 1 + uses * (0.4 + 0.6 * decay) + 0.5 * decay;
}

function passesFilters(parsed, entry, opts, now) {
  const link = entry.link;
  const tags = (link.tags || []).map((t) => String(t).toLowerCase());
  for (const t of parsed.tags) if (!tags.includes(t)) return false;
  for (const s of parsed.sites) if (!entry.host.includes(s)) return false;
  for (const c of parsed.cols) if (!String(link.collection || '').toLowerCase().includes(c)) return false;
  if (parsed.unusedDays !== null) {
    const last = link.lastUsed ? Date.parse(link.lastUsed) : Date.parse(link.created);
    if (now - last < parsed.unusedDays * DAY) return false;
  }
  if (parsed.addedDays !== null) {
    if (now - Date.parse(link.created) > parsed.addedDays * DAY) return false;
  }
  for (const f of parsed.flags) {
    if (f === 'untagged' && tags.length) return false;
    if (f === 'unused' && (link.useCount || 0) > 0) return false;
    if (f === 'stale' && !isStale(link, opts.staleDays, now)) return false;
    if (f === 'keyword' && !link.keyword) return false;
    if (f === 'nosnapshot' && link.snapshot) return false;
  }
  if (opts.tag && !tags.includes(String(opts.tag).toLowerCase())) return false;
  if (opts.collection && String(link.collection || '') !== String(opts.collection)) return false;
  if (opts.view) {
    const v = opts.view;
    if (v === 'untagged' && tags.length) return false;
    if (v === 'stale' && !isStale(link, opts.staleDays, now)) return false;
    if (v === 'recent' && !link.lastUsed && now - Date.parse(link.created) > 30 * DAY) return false;
    if (v === 'mostused' && !(link.useCount > 0)) return false;
    if (v === 'keywords' && !link.keyword) return false;
  }
  return true;
}

function isStale(link, staleDays = 90, now = Date.now()) {
  const last = link.lastUsed ? Date.parse(link.lastUsed) : Date.parse(link.created);
  return now - last > staleDays * DAY;
}

function snapshotStale(link, staleDays = 90, now = Date.now()) {
  if (!link.snapshot || !link.snapshotAt) return false;
  return now - Date.parse(link.snapshotAt) > staleDays * DAY;
}

// opts: { tag, collection, view, limit, staleDays }
function search(index, q, opts = {}) {
  const now = Date.now();
  const parsed = parseQuery(q);
  const results = [];
  for (const entry of index) {
    if (!passesFilters(parsed, entry, opts, now)) continue;
    const ts = textScore(parsed, entry);
    if (ts <= 0) continue;
    const fr = frecency(entry.link, now);
    results.push({ link: entry.link, text: ts, frecency: fr, score: ts * fr });
  }
  const view = opts.view;
  if (!parsed.terms.length) {
    if (view === 'recent') results.sort((a, b) => Date.parse(b.link.lastUsed || b.link.created) - Date.parse(a.link.lastUsed || a.link.created));
    else if (view === 'mostused') results.sort((a, b) => (b.link.useCount || 0) - (a.link.useCount || 0) || b.frecency - a.frecency);
    else if (view === 'added') results.sort((a, b) => Date.parse(b.link.created) - Date.parse(a.link.created));
    else if (view === 'stale' || view === 'untagged') results.sort((a, b) => Date.parse(a.link.lastUsed || a.link.created) - Date.parse(b.link.lastUsed || b.link.created));
    else results.sort((a, b) => b.frecency - a.frecency || Date.parse(b.link.created) - Date.parse(a.link.created));
  } else {
    results.sort((a, b) => b.score - a.score);
  }
  const limit = opts.limit || 200;
  return {
    parsed,
    total: results.length,
    results: results.slice(0, limit).map((r) => ({
      ...r.link,
      score: Math.round(r.score * 1000) / 1000,
      textScore: Math.round(r.text * 1000) / 1000,
      stale: isStale(r.link, opts.staleDays, now),
      snapshotStale: snapshotStale(r.link, opts.staleDays, now),
    })),
  };
}

// Templates: { "jira": "https://.../browse/{0}", "conf": "https://.../search?text={q}" }
// {0} {1} positional words, {q} everything after the key url-encoded, {*} everything raw.
function expandTemplate(template, rest) {
  const words = rest.trim().split(/\s+/).filter(Boolean);
  return template
    .replace(/\{q\}/g, encodeURIComponent(rest.trim()))
    .replace(/\{\*\}/g, rest.trim())
    .replace(/\{(\d+)\}/g, (_, i) => encodeURIComponent(words[Number(i)] || ''));
}

// Resolution order: exact keyword, template prefix, top search hit, otherwise the web UI.
function resolveGo(text, store, index, opts = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { type: 'search', q: '' };
  const [first, ...restWords] = raw.split(/\s+/);
  const key = first.toLowerCase();
  const rest = restWords.join(' ');

  const byKeyword = store.findByKeyword(key);
  if (byKeyword && !rest) return { type: 'link', link: byKeyword, via: 'keyword' };

  const templates = store.templates || {};
  const tKey = Object.keys(templates).find((k) => k.toLowerCase() === key);
  if (tKey) return { type: 'url', url: expandTemplate(templates[tKey], rest), via: 'template', template: tKey };

  if (byKeyword) return { type: 'link', link: byKeyword, via: 'keyword' };

  const { results } = search(index, raw, { limit: 3 });
  const minScore = opts.minScore ?? 0.6;
  if (results.length) {
    const top = results[0];
    const second = results[1];
    const confident = top.textScore >= minScore * 2 && (!second || top.score >= second.score * 1.15 || top.textScore >= 1000);
    if (confident) return { type: 'link', link: store.findById(top.id), via: 'search' };
  }
  return { type: 'search', q: raw };
}

module.exports = { tokenize, buildIndex, parseQuery, search, frecency, isStale, snapshotStale, resolveGo, expandTemplate };
