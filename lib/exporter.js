'use strict';

// Export links in several formats. Every format is also accepted back by the importer.
//   json  Golinks JSON: links with every field plus the folder list (full fidelity)
//   html  Netscape bookmark file, the format browsers import (folders nest, tags kept)
//   csv   spreadsheet friendly, UTF-8 with BOM so Excel opens it correctly
//   xlsx  Excel workbook with a frozen header row and filters
//   md    Markdown list grouped by folder
//   txt   one URL per line

const { writeXlsx } = require('./xlsx');
const { isWithin, listFolders, segments } = require('./folders');

const COLUMNS = ['url', 'title', 'folder', 'tags', 'keyword', 'description', 'notes', 'aliases', 'created', 'lastUsed', 'useCount'];

const FORMATS = {
  json: { ext: 'json', mime: 'application/json; charset=utf-8', label: 'Golinks JSON' },
  html: { ext: 'html', mime: 'text/html; charset=utf-8', label: 'Browser bookmarks (HTML)' },
  csv: { ext: 'csv', mime: 'text/csv; charset=utf-8', label: 'CSV' },
  xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel workbook' },
  md: { ext: 'md', mime: 'text/markdown; charset=utf-8', label: 'Markdown' },
  txt: { ext: 'txt', mime: 'text/plain; charset=utf-8', label: 'Plain URLs' },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function epoch(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return isNaN(t) ? '' : String(Math.floor(t / 1000));
}

function selectLinks(links, opts = {}) {
  let out = links.slice();
  if (opts.folder) out = out.filter((l) => isWithin(l.folder, opts.folder));
  if (opts.tag) out = out.filter((l) => (l.tags || []).includes(opts.tag));
  return out.sort((a, b) => String(a.folder || '').localeCompare(String(b.folder || '')) || String(a.title || '').localeCompare(String(b.title || '')));
}

// ---- json -----------------------------------------------------------------------------

function toJson(links, folders, meta = {}) {
  const clean = links.map((l) => {
    const o = {};
    for (const k of ['id', 'url', 'title', 'description', 'tags', 'aliases', 'keyword', 'notes', 'folder', 'created', 'lastUsed', 'useCount', 'source', 'updated']) if (l[k] !== undefined) o[k] = l[k];
    return o;
  });
  const usedFolders = listFolders(links, folders).map((f) => f.path);
  return JSON.stringify({ app: 'golinks', version: meta.version || '', exported: new Date().toISOString(), count: clean.length, folders: usedFolders, links: clean }, null, 2) + '\n';
}

// ---- netscape bookmarks html ----------------------------------------------------------

function toHtml(links) {
  const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>'];
  // Build a tree keyed by folder path so nesting comes out right.
  const root = { kids: new Map(), links: [] };
  for (const l of links) {
    let node = root;
    for (const seg of segments(l.folder)) {
      if (!node.kids.has(seg)) node.kids.set(seg, { kids: new Map(), links: [] });
      node = node.kids.get(seg);
    }
    node.links.push(l);
  }
  const walk = (node, depth) => {
    const pad = '    '.repeat(depth);
    for (const [name, child] of [...node.kids.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`${pad}<DT><H3>${esc(name)}</H3>`);
      lines.push(`${pad}<DL><p>`);
      walk(child, depth + 1);
      lines.push(`${pad}</DL><p>`);
    }
    for (const l of node.links) {
      const attrs = [`HREF="${esc(l.url)}"`];
      if (l.created) attrs.push(`ADD_DATE="${epoch(l.created)}"`);
      if (l.lastUsed) attrs.push(`LAST_VISIT="${epoch(l.lastUsed)}"`);
      if (l.tags && l.tags.length) attrs.push(`TAGS="${esc(l.tags.join(','))}"`);
      if (l.keyword) attrs.push(`SHORTCUTURL="${esc(l.keyword)}"`);
      lines.push(`${pad}<DT><A ${attrs.join(' ')}>${esc(l.title || l.url)}</A>`);
      const dd = [l.description, l.notes].filter(Boolean).join('\n');
      if (dd) lines.push(`${pad}<DD>${esc(dd)}`);
    }
  };
  walk(root, 1);
  lines.push('</DL><p>');
  return lines.join('\n') + '\n';
}

// ---- csv / xlsx -----------------------------------------------------------------------

function rowsFor(links) {
  const rows = [COLUMNS.slice()];
  for (const l of links) {
    rows.push([l.url || '', l.title || '', l.folder || '', (l.tags || []).join(', '), l.keyword || '', l.description || '', l.notes || '', (l.aliases || []).join(', '), l.created || '', l.lastUsed || '', Number(l.useCount || 0)]);
  }
  return rows;
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(links) {
  return '﻿' + rowsFor(links).map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function toXlsx(links) {
  return writeXlsx(rowsFor(links), 'Links');
}

// ---- markdown / text ------------------------------------------------------------------

function toMarkdown(links) {
  const out = ['# Links', ''];
  let current = null;
  for (const l of links) {
    const f = l.folder || '';
    if (f !== current) {
      current = f;
      out.push('', '## ' + (f ? f.split('/').join(' / ') : 'Unfiled'), '');
    }
    const extras = [];
    if (l.keyword) extras.push('`:go ' + l.keyword + '`');
    if (l.tags && l.tags.length) extras.push(l.tags.map((t) => '#' + t).join(' '));
    out.push(`- [${(l.title || l.url).replace(/[[\]]/g, ' ')}](${l.url})${extras.length ? ' ' + extras.join(' ') : ''}${l.description ? '  \n  ' + l.description.replace(/\s+/g, ' ') : ''}`);
  }
  return out.join('\n') + '\n';
}

function toText(links) {
  return links.map((l) => l.url).join('\n') + '\n';
}

// -> { body: Buffer|string, mime, filename }
function exportLinks(format, links, folders, opts = {}) {
  const f = FORMATS[format];
  if (!f) throw new Error(`unknown format "${format}"; use ${Object.keys(FORMATS).join(', ')}`);
  const selected = selectLinks(links, opts);
  const stamp = new Date().toISOString().slice(0, 10);
  const scope = opts.folder ? '-' + opts.folder.replace(/[^A-Za-z0-9]+/g, '_') : opts.tag ? '-tag_' + opts.tag : '';
  const filename = `golinks${scope}-${stamp}.${f.ext}`;
  let body;
  if (format === 'json') body = toJson(selected, folders, opts);
  else if (format === 'html') body = toHtml(selected);
  else if (format === 'csv') body = toCsv(selected);
  else if (format === 'xlsx') body = toXlsx(selected);
  else if (format === 'md') body = toMarkdown(selected);
  else body = toText(selected);
  return { body, mime: f.mime, filename, count: selected.length };
}

module.exports = { FORMATS, COLUMNS, exportLinks, toJson, toHtml, toCsv, toXlsx, toMarkdown, toText, selectLinks };
