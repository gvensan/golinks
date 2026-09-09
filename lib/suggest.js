'use strict';

// Suggestions for a link being saved or edited: folder, tags and go keyword.
//
// Three sources, merged and ranked:
//   1. URL patterns of well-known tools (Confluence, Jira, SharePoint, GitHub, GitLab,
//      Google Docs): project keys, space keys, site names, repositories.
//   2. Page metadata collected by the bookmarklet inside the page (so it works on SSO
//      pages too): keywords, site name, breadcrumbs, author, published date, canonical URL.
//   3. What the user did before: folders and tags of existing links on the same host,
//      weighted by how much of the path they share.
// Everything here is a suggestion the UI shows as chips; nothing is applied silently.

const { hostname } = require('./url');
const { slugTag } = require('./rules');
const { normalizeFolder } = require('./folders');

const KEYWORD_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/;
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'at', 'by', 'with', 'from', 'home', 'page', 'pages', 'index', 'default', 'aspx', 'html', 'htm', 'php', 'www']);

function pathSegments(url) {
  try { return new URL(url).pathname.split('/').map((s) => decodeURIComponent(s)).filter(Boolean); } catch { return []; }
}

function cleanName(s) {
  return String(s || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---- 1. well-known tools -------------------------------------------------------------

function siteInfo(url) {
  const host = hostname(url).replace(/^www\./, '').toLowerCase();
  const segs = pathSegments(url);
  const out = { site: null, tags: [], folder: null, keyword: null };
  const add = (t) => { const s = slugTag(t); if (s && !out.tags.includes(s)) out.tags.push(s); };

  if (/\.atlassian\.net$/.test(host) || segs[0] === 'wiki' || segs[0] === 'browse') {
    const org = host.split('.')[0];
    const wiki = segs.indexOf('wiki');
    if (wiki >= 0 && segs[wiki + 1] === 'spaces' && segs[wiki + 2]) {
      const space = segs[wiki + 2];
      out.site = 'confluence';
      add('confluence'); add(space);
      out.folder = normalizeFolder(['Confluence', space]);
      // /wiki/spaces/KEY/pages/123/Title -> keyword from the title slug is rarely stable; skip
    }
    const issue = segs.find((s) => /^[A-Z][A-Z0-9]+-\d+$/.test(s));
    if (segs.includes('browse') && issue) {
      const proj = issue.split('-')[0];
      out.site = 'jira';
      add('jira'); add(proj);
      out.folder = normalizeFolder(['Jira', proj]);
      out.keyword = issue.toLowerCase();
    } else if (segs[0] === 'jira' && segs.includes('projects')) {
      const proj = segs[segs.indexOf('projects') + 1];
      if (proj) {
        out.site = 'jira';
        add('jira'); add(proj);
        out.folder = normalizeFolder(['Jira', proj]);
        if (segs.includes('boards')) out.keyword = (proj + '-board').toLowerCase();
      }
    }
    if (out.site && org && org !== 'www') add(org);
    return out;
  }

  if (/\.sharepoint\.com$/.test(host)) {
    out.site = 'sharepoint';
    if (/-my\.sharepoint\.com$/.test(host)) {
      add('onedrive');
      out.folder = 'OneDrive';
    } else {
      add('sharepoint');
      const i = segs.indexOf('sites') >= 0 ? segs.indexOf('sites') : segs.indexOf('teams');
      if (i >= 0 && segs[i + 1]) {
        const site = cleanName(segs[i + 1]);
        add(site);
        out.folder = normalizeFolder(['SharePoint', site]);
        // /sites/X/Shared Documents/Sub/... -> deeper folder from the library path
        const lib = segs.slice(i + 2).filter((s) => !/\.[a-z0-9]{2,5}$/i.test(s) && !/^(Forms|_layouts|SitePages)$/i.test(s) && !/^:[a-z]:$/.test(s) && s !== 'r');
        if (lib.length && /Documents|Shared/i.test(lib[0])) out.folder = normalizeFolder(['SharePoint', site, ...lib.slice(1, 3).map(cleanName)]);
      } else out.folder = 'SharePoint';
    }
    return out;
  }

  if (host === 'github.com' || host === 'gitlab.com' || /^gitlab\./.test(host)) {
    const tool = host === 'github.com' ? 'github' : 'gitlab';
    if (segs.length >= 2 && !/^(orgs|topics|settings|marketplace|explore|search|login)$/.test(segs[0])) {
      out.site = tool;
      add(tool); add(segs[0]); add(segs[1]);
      out.folder = normalizeFolder([tool === 'github' ? 'GitHub' : 'GitLab', segs[0]]);
      const repo = slugTag(segs[1].replace(/\.git$/, ''));
      if (segs.length === 2 && repo) out.keyword = repo;
      if (segs[2] === 'pull' || segs[2] === 'merge_requests') add(segs[2] === 'pull' ? 'pr' : 'mr');
      if (segs[2] === 'issues') add('issue');
    } else if (segs.length === 1) {
      out.site = tool; add(tool); add(segs[0]);
      out.folder = normalizeFolder([tool === 'github' ? 'GitHub' : 'GitLab', segs[0]]);
    }
    return out;
  }

  if (host === 'docs.google.com' || host === 'drive.google.com') {
    const kind = { document: 'gdoc', spreadsheets: 'gsheet', presentation: 'gslides', forms: 'gform', drive: 'gdrive' }[segs[0]] || 'gdrive';
    out.site = 'google';
    add(kind); add('google');
    out.folder = 'Google Drive';
    return out;
  }

  return out;
}

// ---- 2. page metadata from the bookmarklet -------------------------------------------

// page: { keywords: [], siteName, breadcrumbs: [], author, published, canonical, title }
function fromPage(page) {
  const out = { tags: [], folder: null, details: {} };
  if (!page || typeof page !== 'object') return out;
  const kw = Array.isArray(page.keywords) ? page.keywords : String(page.keywords || '').split(/[,;]/);
  for (const k of kw) {
    const s = slugTag(k);
    if (s && s.length >= 2 && s.length <= 30 && !STOP.has(s) && !/^\d+$/.test(s) && !out.tags.includes(s)) out.tags.push(s);
    if (out.tags.length >= 8) break;
  }
  if (page.siteName) {
    const s = slugTag(page.siteName);
    if (s && s.length <= 30 && !out.tags.includes(s)) out.tags.push(s);
  }
  if (Array.isArray(page.breadcrumbs) && page.breadcrumbs.length) {
    const crumbs = page.breadcrumbs.map(cleanName).filter((c) => c && !/^(home|start|pages|overview)$/i.test(c) && c.length <= 40);
    // drop the last crumb when it is the page itself
    if (crumbs.length > 1 && page.title && crumbs[crumbs.length - 1].toLowerCase() === cleanName(page.title).toLowerCase()) crumbs.pop();
    if (crumbs.length) out.folder = normalizeFolder(crumbs.slice(0, 4));
  }
  for (const k of ['author', 'published', 'canonical', 'siteName']) if (page[k]) out.details[k] = String(page[k]).slice(0, 200);
  return out;
}

// ---- 3. learn from existing links ----------------------------------------------------

function learned(url, links, selfId) {
  const host = hostname(url).replace(/^www\./, '').toLowerCase();
  const segs = pathSegments(url).map((s) => s.toLowerCase());
  const folders = new Map();
  const tags = new Map();
  if (!host) return { folders: [], tags: [] };
  for (const l of links || []) {
    if (!l || l.id === selfId) continue;
    const h = hostname(l.url).replace(/^www\./, '').toLowerCase();
    if (h !== host) continue;
    const ls = pathSegments(l.url).map((s) => s.toLowerCase());
    let shared = 0;
    while (shared < segs.length && shared < ls.length && segs[shared] === ls[shared]) shared++;
    const w = 1 + Math.min(shared, 3);
    if (l.folder) { const f = folders.get(l.folder) || { path: l.folder, score: 0, count: 0 }; f.score += w; f.count++; folders.set(l.folder, f); }
    for (const t of l.tags || []) { const e = tags.get(t) || { name: t, score: 0, count: 0 }; e.score += w; e.count++; tags.set(t, e); }
  }
  const rank = (m) => [...m.values()].sort((a, b) => b.score - a.score || b.count - a.count);
  return { folders: rank(folders).slice(0, 3), tags: rank(tags).slice(0, 8), host };
}

// ---- keyword candidates --------------------------------------------------------------

function keywordCandidates(url, title, site) {
  const out = [];
  const push = (k, why) => { k = String(k || '').toLowerCase(); if (KEYWORD_RE.test(k) && !out.some((o) => o.keyword === k)) out.push({ keyword: k, why }); };
  if (site && site.keyword) push(site.keyword, 'from the URL');
  // a short, clean last path segment ("css", "quick-start") is usually the most natural keyword
  const segs = pathSegments(url).filter((s) => !/^[:_]/.test(s));
  const last = segs.length ? segs[segs.length - 1].replace(/\.[a-z0-9]{2,5}$/i, '') : '';
  if (last && last.length >= 3 && last.length <= 24 && !/^\d+$/.test(last) && !/^(index|default|home|view|edit|browse|docs|wiki|pages)$/i.test(last)) push(slugTag(last), 'last part of the URL');
  const words = String(title || '').split(/[\s|:\u00b7\u2013\u2014-]+/).map((w) => w.replace(/[^a-z0-9]/gi, '')).filter((w) => w && !STOP.has(w.toLowerCase()));
  if (words.length >= 2 && words.length <= 6) {
    const ini = words.map((w) => w[0]).join('').toLowerCase();
    // skip initials when the title already starts with an acronym we suggested ("CSS: ..." -> css)
    if (ini.length >= 2 && ini.length <= 5 && !out.some((o) => o.keyword === words[0].toLowerCase())) push(ini, 'initials of the title');
  }
  if (words.length === 1 && words[0].length <= 16) push(words[0], 'the title');
  return out.slice(0, 3);
}

// ---- merge ---------------------------------------------------------------------------

// opts: { title, page, links, selfId, existingTags, currentFolder, isKeywordTaken(k) }
function suggest(url, opts = {}) {
  const site = siteInfo(url);
  const page = fromPage(opts.page);
  const learn = learned(url, opts.links, opts.selfId);
  const have = new Set((opts.existingTags || []).map((t) => slugTag(t)));

  const folders = [];
  const addFolder = (path, why, count) => {
    const p = normalizeFolder(path);
    if (!p || folders.some((f) => f.path.toLowerCase() === p.toLowerCase())) return;
    if (opts.currentFolder && p.toLowerCase() === String(opts.currentFolder).toLowerCase()) return;
    folders.push({ path: p, why, count: count || 0 });
  };
  for (const f of learn.folders) addFolder(f.path, (f.count === 1 ? 'another link' : f.count + ' links') + ' on ' + learn.host + ' use this folder', f.count);
  if (page.folder) addFolder(page.folder, 'page breadcrumbs');
  if (site.folder) addFolder(site.folder, 'from the URL');

  const tags = [];
  const addTag = (name, why) => {
    const s = slugTag(name);
    if (!s || have.has(s) || tags.some((t) => t.name === s)) return;
    tags.push({ name: s, why });
  };
  for (const t of site.tags) addTag(t, 'from the URL');
  for (const t of learn.tags) addTag(t.name, 'used on ' + (t.count === 1 ? 'another link' : t.count + ' links') + ' on ' + learn.host);
  for (const t of page.tags) addTag(t, 'page keywords');

  const keywords = keywordCandidates(url, opts.title, site).filter((k) => !(opts.isKeywordTaken && opts.isKeywordTaken(k.keyword)));

  return { site: site.site, folders: folders.slice(0, 4), tags: tags.slice(0, 10), keywords, details: page.details };
}

module.exports = { suggest, siteInfo, fromPage, learned, keywordCandidates };
