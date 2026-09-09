'use strict';

// Tagging rules: [{ "match": "atlassian.net/wiki", "tags": ["confluence"] }]
// match is tried as a case-insensitive regex against the full URL; if it is not
// a valid regex it is used as a plain substring. $1..$9 in tags are replaced with
// capture groups (lowercased).

const { domainLabel } = require('./url');

const regexCache = new Map();

function compile(match) {
  if (regexCache.has(match)) return regexCache.get(match);
  let re;
  try {
    re = new RegExp(match, 'i');
  } catch {
    re = new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  regexCache.set(match, re);
  return re;
}

function slugTag(t) {
  return String(t || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._+-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function applyRules(url, rules) {
  const out = [];
  if (!url || !Array.isArray(rules)) return out;
  for (const rule of rules) {
    if (!rule || !rule.match || !Array.isArray(rule.tags)) continue;
    const m = compile(rule.match).exec(url);
    if (!m) continue;
    for (const t of rule.tags) {
      const tag = slugTag(String(t).replace(/\$(\d)/g, (_, i) => (m[Number(i)] || '')));
      if (tag && !out.includes(tag)) out.push(tag);
    }
  }
  return out;
}

// Rule tags first, then a domain label as a softer suggestion.
function suggestTags(url, rules) {
  const tags = applyRules(url, rules);
  const label = slugTag(domainLabel(url));
  const suggested = [];
  if (label && !tags.includes(label)) suggested.push(label);
  return { tags, suggested };
}

function normalizeTags(list) {
  if (typeof list === 'string') list = list.split(/[,\n]+/);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list) {
    const s = slugTag(t);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

module.exports = { applyRules, suggestTags, normalizeTags, slugTag };
