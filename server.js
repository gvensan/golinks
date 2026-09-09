#!/usr/bin/env node
'use strict';

// Golinks: local smart bookmarks service. Zero dependencies, binds 127.0.0.1 only.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { Store, ROOT, HOME_DIR, DATA_DIR } = require('./lib/store');
const { cleanUrl, dedupeKey, hostname } = require('./lib/url');
const { applyRules, normalizeTags, slugTag } = require('./lib/rules');
const folders = require('./lib/folders');
const search = require('./lib/search');
const { enrich } = require('./lib/enrich');
const snapshots = require('./lib/snapshots');
const importer = require('./lib/importer');
const capture = require('./lib/capture');
const suggest = require('./lib/suggest');
const exporter = require('./lib/exporter');
const browserbatch = require('./lib/browserbatch');
const { HttpError, sendJson, sendText, redirect, readJson, serveFile } = require('./lib/http');

const VERSION = require('./package.json').version;
const PUBLIC_DIR = path.join(ROOT, 'public');
const HOST = '127.0.0.1';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '']);
const STARTED = Date.now();

const store = new Store();
store.loadAll();
store.watch();

const PORT = Number(process.env.LINKS_PORT || store.settings.port || 7777);

let index = search.buildIndex(store.links);
function reindex() { index = search.buildIndex(store.links); }
store.on('reloaded', reindex);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------------------
// Snapshot queue: background captures run one at a time (headless Chrome is heavy).

const pending = new Set();
const queue = [];
let draining = false;

function enqueueSnapshot(id, mode = 'auto', info = null) {
  if (pending.has(id)) return;
  pending.add(id);
  queue.push({ id, mode, info });
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      await captureFor(job.id, job.mode, job.info);
    } catch (err) {
      log('[snapshot]', job.id, 'failed:', err.message);
    } finally {
      pending.delete(job.id);
    }
  }
  draining = false;
}

async function captureFor(id, mode, info) {
  const link = store.findById(id);
  if (!link) return;
  let result;
  if (mode === 'tile') {
    result = { snapshot: await snapshots.saveTile(id, link.url, link.title, info && info.favicon), method: 'tile' };
  } else {
    const inf = info || (await enrich(link.url, store.rules, { timeoutMs: 8000 }));
    result = await snapshots.captureBest(id, link.url, inf, { headless: store.settings.headlessSnapshots !== false });
    // Fill in a missing title from the page when we got one and the title was just the hostname.
    if (inf.title && (!link.title || link.title === hostname(link.url))) link.title = inf.title;
    if (inf.description && !link.description) link.description = inf.description;
  }
  const current = store.findById(id);
  if (!current || !result.snapshot) return;
  current.snapshot = result.snapshot;
  current.snapshotAt = new Date().toISOString();
  current.snapshotMethod = result.method;
  store.save('links');
  reindex();
  log('[snapshot]', id, result.method);
}

// ---------------------------------------------------------------------------
// Link CRUD

const EDITABLE = ['url', 'title', 'description', 'tags', 'aliases', 'keyword', 'notes', 'folder'];

function normalizeList(v) {
  if (typeof v === 'string') v = v.split(/[,\n]+/);
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((s) => String(s).trim()).filter(Boolean))];
}

function normalizeKeyword(v, selfId) {
  const k = String(v || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!k) return null;
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(k)) throw new HttpError(400, 'keyword must be letters, digits, dots, dashes');
  const clash = store.findByKeyword(k);
  if (clash && clash.id !== selfId) throw new HttpError(409, `keyword "${k}" already used by "${clash.title}"`, { link: clash });
  if (store.templates && Object.keys(store.templates).some((t) => t.toLowerCase() === k)) throw new HttpError(409, `"${k}" is a template name`);
  return k;
}

// Normalizes a folder path and records it (with its ancestors) in folders.json.
function setFolder(v) {
  const p = folders.normalizeFolder(v);
  if (!p) return null;
  const before = store.folders.length;
  const path = store.ensureFolder(p);
  if (store.folders.length !== before) store.save('folders');
  return path;
}

function findDuplicate(url, selfId) {
  const key = dedupeKey(url);
  if (!key) return null;
  return store.links.find((l) => l.id !== selfId && dedupeKey(l.url) === key) || null;
}

function decorate(link) {
  const now = Date.now();
  return {
    ...link,
    stale: search.isStale(link, store.settings.staleDays, now),
    snapshotStale: search.snapshotStale(link, store.settings.staleDays, now),
    snapshotPending: pending.has(link.id),
  };
}

async function createLink(body) {
  const url = cleanUrl(body.url);
  if (!url) throw new HttpError(400, 'a valid http(s) url is required');
  const dup = findDuplicate(url, null);
  if (dup && !body.force) throw new HttpError(409, 'already saved', { link: decorate(dup) });

  const id = store.newId();
  const now = new Date().toISOString();
  let info = null;
  let title = String(body.title || '').trim();
  let description = String(body.description || '').trim();

  // No title given: try the page (public pages only; SSO pages come back as login and stay blank).
  if (!title && body.enrich !== false) {
    info = await enrich(url, store.rules, { timeoutMs: 6000 });
    if (info.title) title = info.title;
    if (!description && info.description) description = info.description;
  }
  if (!title) title = hostname(url);

  const tags = normalizeTags(body.tags);
  if (body.applyRules !== false) for (const t of applyRules(url, store.rules)) if (!tags.includes(t)) tags.push(t);

  const link = {
    id,
    url,
    title,
    description,
    tags,
    aliases: normalizeList(body.aliases),
    keyword: normalizeKeyword(body.keyword, id),
    notes: String(body.notes || '').trim(),
    folder: setFolder('folder' in body ? body.folder : body.collection),
    created: now,
    lastUsed: null,
    useCount: 0,
    snapshot: null,
    snapshotAt: null,
    source: String(body.source || 'api'),
  };
  store.links.push(link);

  if (body.snapshot) {
    try {
      link.snapshot = snapshots.saveFromBase64(id, body.snapshot);
      link.snapshotAt = now;
      link.snapshotMethod = 'upload';
    } catch (err) {
      log('[snapshot] upload rejected:', err.message);
    }
  }
  store.save('links');
  reindex();

  if (!link.snapshot) {
    const mode = body.snapshotMode || 'auto';
    if (mode !== 'none') {
      if (body.snapshotUrl && !info) info = { fetched: false, ogImage: String(body.snapshotUrl) };
      else if (body.snapshotUrl) info.ogImage = String(body.snapshotUrl);
      enqueueSnapshot(id, mode, info);
    }
  }
  return link;
}

function updateLink(link, body) {
  // `collection` is the pre-1.2 name of `folder`; still accepted from old callers.
  if ('collection' in body && !('folder' in body)) body = { ...body, folder: body.collection };
  for (const key of EDITABLE) {
    if (!(key in body)) continue;
    const v = body[key];
    if (key === 'url') {
      const url = cleanUrl(v);
      if (!url) throw new HttpError(400, 'invalid url');
      const dup = findDuplicate(url, link.id);
      if (dup) throw new HttpError(409, 'another link already has this url', { link: decorate(dup) });
      link.url = url;
    } else if (key === 'tags') link.tags = normalizeTags(v);
    else if (key === 'aliases') link.aliases = normalizeList(v);
    else if (key === 'keyword') link.keyword = normalizeKeyword(v, link.id);
    else if (key === 'folder') link.folder = setFolder(v);
    else link[key] = String(v ?? '').trim();
  }
  if (!link.title) link.title = hostname(link.url);
  link.updated = new Date().toISOString();
  store.save('links');
  reindex();
  return link;
}

function recordUse(link) {
  link.lastUsed = new Date().toISOString();
  link.useCount = (link.useCount || 0) + 1;
  store.save('links');
  reindex();
}

function deleteLink(link) {
  const i = store.links.indexOf(link);
  if (i >= 0) store.links.splice(i, 1);
  snapshots.removeAll(link.id);
  store.save('links');
  reindex();
}

// Screenshot the browser tab showing url. When no tab has it open (or the tab sits on
// another Space), open the page in a new tab of the front browser window, capture, close it.
// opts.open === false disables that fallback (the Add page and popup probe silently).
async function captureFromBrowser(url, opts = {}) {
  if (!cleanUrl(url)) throw new HttpError(400, 'a valid url is required');
  const toHttp = (err) => {
    if (err instanceof capture.CaptureError) {
      const status = err.code === 'notab' ? 404 : err.code === 'badurl' ? 400 : 503;
      return new HttpError(status, err.message, { code: err.code });
    }
    return err;
  };
  try {
    return capture.captureUrl(url, { topCrop: store.settings.topCrop, maxWidth: 960 });
  } catch (err) {
    const canOpen = opts.open !== false && err instanceof capture.CaptureError && (err.code === 'notab' || err.code === 'offscreen');
    if (!canOpen) throw toHttp(err);
    if (browserbatch.status().running) throw new HttpError(409, 'A browser capture batch is running; wait for it to finish or stop it in Settings.');
    try {
      const cap = await browserbatch.captureByOpening(url, { topCrop: store.settings.topCrop, maxWidth: 960 });
      log('[capture] opened', url.slice(0, 80), 'in', cap.app);
      return cap;
    } catch (err2) {
      if (err2.code === 'login') throw new HttpError(409, err2.message, { code: 'login' });
      throw toHttp(err2);
    }
  }
}

// ---------------------------------------------------------------------------
// Diagnostics

function codeChangedSinceStart() {
  try {
    const files = [path.join(ROOT, 'server.js'), ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'lib', f))];
    return files.some((f) => fs.statSync(f).mtimeMs > STARTED);
  } catch { return false; }
}

// Runs inside the service process, so permission results are the ones that matter.
async function doctor() {
  const checks = [];
  const add = (id, ok, label, detail, fix) => checks.push({ id, ok, label, detail: detail || '', fix: fix || '' });
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 18, `Node ${process.version}`, process.execPath, major >= 18 ? '' : 'Install Node 18 or newer (the .pkg from nodejs.org, nvm or Homebrew) and run bin/golinks node && bin/golinks restart');
  let writable = true;
  try { fs.accessSync(DATA_DIR, fs.constants.W_OK); } catch { writable = false; }
  add('data', writable, 'Data folder writable', DATA_DIR, 'Check permissions on the data folder');
  add('chrome', Boolean(snapshots.chromeBinary()), 'Chromium browser for headless snapshots', snapshots.chromeBinary() || 'none found', 'Optional. Install Chrome or Brave for headless snapshots of public pages');

  let browsers = [];
  let automation = { ok: false, detail: '' };
  try {
    browsers = capture.runningBrowsers();
    // Ask the first running browser for its tabs: the real Automation test.
    if (browsers.length) { capture.activeTabs(browsers[0]); automation = { ok: true, detail: `can read ${browsers[0]}` }; }
    else automation = { ok: null, detail: 'no supported browser is running, open Brave, Chrome, Edge or Safari and re-run' };
  } catch (err) {
    automation = { ok: false, detail: err.message };
  }
  add('automation', automation.ok, 'Automation: read browser tabs', automation.detail, 'System Settings > Privacy & Security > Automation: allow "node" to control your browser. macOS asks the first time a capture runs.');

  let screen = { ok: null, detail: 'no browser window on screen to test with' };
  try {
    const wins = capture.cgWindows();
    if (wins.length) {
      const named = wins.filter((w) => w.name);
      screen = named.length ? { ok: true, detail: `${wins.length} browser window(s) visible` } : { ok: false, detail: 'window titles are hidden, which means Screen Recording is not granted' };
    }
  } catch (err) { screen = { ok: false, detail: err.message }; }
  add('screen', screen.ok, 'Screen Recording: capture browser windows', screen.detail, `System Settings > Privacy & Security > Screen & System Audio Recording: enable "node". If missing, press + and pick ${process.execPath}. Then run bin/golinks restart.`);

  return { ok: checks.every((c) => c.ok !== false), checks, browsers, execPath: process.execPath, version: VERSION, port: PORT, home: HOME_DIR, restartNeeded: codeChangedSinceStart() };
}

// ---------------------------------------------------------------------------
// Meta

function meta() {
  const now = Date.now();
  const tags = new Map();
  let untagged = 0, stale = 0, recent = 0, mostused = 0, keywords = 0, nosnap = 0, unfiled = 0;
  for (const l of store.links) {
    if (!l.tags || !l.tags.length) untagged++;
    for (const t of l.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
    if (!l.folder) unfiled++;
    if (search.isStale(l, store.settings.staleDays, now)) stale++;
    if (l.lastUsed && now - Date.parse(l.lastUsed) < 30 * 86400000) recent++;
    if (l.useCount > 0) mostused++;
    if (l.keyword) keywords++;
    if (!l.snapshot) nosnap++;
  }
  const sortCount = (m) => [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    version: VERSION,
    port: PORT,
    counts: { all: store.links.length, untagged, stale, recent, mostused, keywords, nosnapshot: nosnap, unfiled },
    tags: sortCount(tags),
    folders: folders.listFolders(store.links, store.folders),
    templates: store.templates,
    rulesCount: store.rules.length,
    exportFormats: Object.entries(exporter.FORMATS).map(([id, f]) => ({ id, label: f.label, ext: f.ext })),
    setupComplete: ['go', 'bookmarklet', 'permissions'].every((k) => store.settings.setup && store.settings.setup[k]),
    settings: store.settings,
    pendingSnapshots: [...pending],
    snapshotStats: { missing: store.links.filter((l) => !l.snapshot).length, tiles: store.links.filter((l) => l.snapshotMethod === 'tile').length },
    browserBatch: browserbatch.status(),
    chrome: Boolean(snapshots.chromeBinary()),
    execPath: process.execPath,
    home: HOME_DIR,
    restartNeeded: codeChangedSinceStart(),
  };
}

// ---------------------------------------------------------------------------
// Suggestions (folder, tags, keyword) for a URL being saved or edited

function suggestFor(url, opts = {}) {
  const taken = (k) => Boolean(store.findByKeyword(k) && store.findByKeyword(k).id !== opts.selfId) || Object.keys(store.templates || {}).some((t) => t.toLowerCase() === k);
  return suggest.suggest(url, { ...opts, links: store.links, isKeywordTaken: taken });
}

// ---------------------------------------------------------------------------
// Bookmarklet

function bookmarkletCode() {
  const src = fs.readFileSync(path.join(ROOT, 'bookmarklet', 'add-to-links.js'), 'utf8');
  const min = src
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, '').trim())
    .filter(Boolean)
    .join('')
    .replace(/__PORT__/g, String(PORT));
  return 'javascript:' + encodeURIComponent(min).replace(/%20/g, ' ');
}

// ---------------------------------------------------------------------------
// Router

function param(url, name, def = '') {
  const v = url.searchParams.get(name);
  return v === null ? def : v;
}

// ?folder=Work/Projects (or the old ?collection=) normalized, else null.
function folderParam(url) {
  return folders.normalizeFolder(param(url, 'folder', null) || param(url, 'collection', null));
}

function getLinkOr404(id) {
  const link = store.findById(id);
  if (!link) throw new HttpError(404, 'no such link');
  return link;
}

async function route(req, res, url) {
  const { method } = req;
  const p = url.pathname;
  const seg = p.split('/').filter(Boolean).map((s) => decodeURIComponent(s));

  // static and pages
  if (method === 'GET' || method === 'HEAD') {
    if (p === '/') return serveFile(req, res, PUBLIC_DIR, 'index.html');
    if (p === '/add') return serveFile(req, res, PUBLIC_DIR, 'add.html');
    if (p === '/favicon.ico') return serveFile(req, res, PUBLIC_DIR, 'favicon.svg', { cache: 'public, max-age=86400' });
    if (seg[0] === 'snapshots' && seg.length === 2) return serveFile(req, res, snapshots.SNAP_DIR, seg[1], { cache: 'no-cache' });
    if (seg.length === 1 && /\.(js|css|svg|png|html|txt)$/.test(seg[0])) return serveFile(req, res, PUBLIC_DIR, seg[0]);

    if (seg[0] === 'go') {
      const text = seg.length > 1 ? seg.slice(1).join(' ') : param(url, 'q');
      const r = search.resolveGo(text, store, index, { minScore: store.settings.goMinScore });
      if (r.type === 'link') { recordUse(r.link); return redirect(res, r.link.url); }
      if (r.type === 'url') return redirect(res, r.url);
      return redirect(res, '/?q=' + encodeURIComponent(r.q || ''));
    }
    if (seg[0] === 'open' && seg[1]) {
      const link = getLinkOr404(seg[1]);
      recordUse(link);
      return redirect(res, link.url);
    }
  }

  if (seg[0] !== 'api' && p !== '/quit') throw new HttpError(404, 'not found');

  // API
  if (p === '/api/health') {
    return sendJson(res, 200, { ok: true, version: VERSION, pid: process.pid, port: PORT, uptimeSec: Math.round((Date.now() - STARTED) / 1000), links: store.links.length, pendingSnapshots: pending.size, restartNeeded: codeChangedSinceStart(), node: process.version, execPath: process.execPath, home: HOME_DIR });
  }
  if (p === '/api/doctor' && method === 'GET') return sendJson(res, 200, await doctor());
  if (p === '/api/meta' && method === 'GET') return sendJson(res, 200, meta());

  if (p === '/api/search' && method === 'GET') {
    const r = search.search(index, param(url, 'q'), {
      tag: param(url, 'tag', null),
      folder: folderParam(url),
      view: param(url, 'view', null),
      limit: Number(param(url, 'limit', 200)) || 200,
      staleDays: store.settings.staleDays,
    });
    r.results = r.results.map((l) => ({ ...l, snapshotPending: pending.has(l.id) }));
    return sendJson(res, 200, r);
  }

  if (p === '/api/links') {
    if (method === 'GET') {
      const q = param(url, 'q');
      if (q || url.searchParams.has('tag') || url.searchParams.has('folder') || url.searchParams.has('collection') || url.searchParams.has('view')) {
        const r = search.search(index, q, { tag: param(url, 'tag', null), folder: folderParam(url), view: param(url, 'view', null), limit: 10000, staleDays: store.settings.staleDays });
        return sendJson(res, 200, { total: r.total, links: r.results });
      }
      return sendJson(res, 200, { total: store.links.length, links: store.links.map(decorate) });
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const link = await createLink(body);
      return sendJson(res, 201, { link: decorate(link) });
    }
  }

  // Queue background snapshot captures. only: "missing" (no snapshot), "tiles" (missing or a
  // generated tile), "all". Public pages get a real capture, SSO pages fall back to a tile.
  if (p === '/api/snapshots/refresh' && method === 'POST') {
    const body = await readJson(req);
    const only = ['missing', 'tiles', 'all'].includes(body.only) ? body.only : 'tiles';
    let n = 0;
    for (const l of store.links) {
      const pick = only === 'all' || !l.snapshot || (only === 'tiles' && l.snapshotMethod === 'tile');
      if (!pick || pending.has(l.id)) continue;
      enqueueSnapshot(l.id, 'auto', null);
      n++;
    }
    return sendJson(res, 200, { queued: n, pending: pending.size });
  }

  // Capture through the user's browser: opens each page in a tab, screenshots, closes it.
  // body: { ids?: [...] } or { only: "missing" | "tiles" | "all" }, optional app.
  if (p === '/api/snapshots/browser' && method === 'POST') {
    const body = await readJson(req);
    let links;
    if (Array.isArray(body.ids)) links = body.ids.map((id) => store.findById(id)).filter(Boolean);
    else {
      const only = ['missing', 'tiles', 'all'].includes(body.only) ? body.only : 'tiles';
      links = store.links.filter((l) => only === 'all' || !l.snapshot || (only === 'tiles' && l.snapshotMethod === 'tile'));
    }
    if (!links.length) return sendJson(res, 200, { started: false, reason: 'nothing to capture', batch: browserbatch.status() });
    try {
      const st = await browserbatch.start({
        links, app: body.app, topCrop: store.settings.topCrop, maxWidth: 960,
        onSaved: async (link, buffer, info) => {
          const current = store.findById(link.id);
          if (!current) return;
          current.snapshot = snapshots.saveBuffer(current.id, buffer);
          current.snapshotAt = new Date().toISOString();
          current.snapshotMethod = 'browser';
          if (info && info.title && (!current.title || current.title === hostname(current.url))) current.title = info.title;
          store.save('links');
          reindex();
          log('[snapshot]', current.id, 'browser');
        },
      });
      return sendJson(res, 202, { started: true, batch: st });
    } catch (err) {
      throw new HttpError(409, err.message);
    }
  }
  if (p === '/api/snapshots/browser/stop' && method === 'POST') return sendJson(res, 200, { batch: browserbatch.stop() });
  if (p === '/api/snapshots/browser' && method === 'GET') return sendJson(res, 200, { batch: browserbatch.status() });

  // Wipe every link and its snapshots (and, on request, the folder list). Needs confirm: "DELETE".
  if (p === '/api/links/delete-all' && method === 'POST') {
    const body = await readJson(req);
    if (body.confirm !== 'DELETE') throw new HttpError(400, 'send {"confirm":"DELETE"} to delete everything');
    const n = store.links.length;
    for (const l of store.links) snapshots.removeAll(l.id);
    store.data.links = [];
    store.save('links');
    let foldersRemoved = 0;
    if (body.folders) { foldersRemoved = store.folders.length; store.data.folders = []; store.save('folders'); }
    reindex();
    log('[links] deleted all', n, 'links', body.folders ? 'and folders' : '');
    return sendJson(res, 200, { deleted: n, foldersRemoved });
  }

  if (seg[0] === 'api' && seg[1] === 'links' && seg[2]) {
    const link = getLinkOr404(seg[2]);
    if (seg.length === 3) {
      if (method === 'GET') return sendJson(res, 200, { link: decorate(link) });
      if (method === 'PUT' || method === 'PATCH') {
        const body = await readJson(req);
        return sendJson(res, 200, { link: decorate(updateLink(link, body)) });
      }
      if (method === 'DELETE') { deleteLink(link); return sendJson(res, 200, { ok: true, id: link.id }); }
    }
    if (seg[3] === 'use' && method === 'POST') { recordUse(link); return sendJson(res, 200, { link: decorate(link) }); }
    if (seg[3] === 'suggest' && method === 'GET') {
      const sug = suggestFor(link.url, { title: link.title, selfId: link.id, existingTags: link.tags, currentFolder: link.folder });
      if (link.keyword) sug.keywords = [];
      return sendJson(res, 200, { suggest: sug });
    }
    if (seg[3] === 'snapshot' && method === 'POST') {
      const body = await readJson(req);
      if (body.snapshot) {
        link.snapshot = snapshots.saveFromBase64(link.id, body.snapshot);
        link.snapshotAt = new Date().toISOString();
        link.snapshotMethod = 'upload';
        store.save('links');
        return sendJson(res, 200, { link: decorate(link) });
      }
      if (body.imageUrl) {
        link.snapshot = await snapshots.saveFromImageUrl(link.id, body.imageUrl);
        link.snapshotAt = new Date().toISOString();
        link.snapshotMethod = 'image-url';
        store.save('links');
        return sendJson(res, 200, { link: decorate(link) });
      }
      if (body.mode === 'browser') {
        const cap = await captureFromBrowser(link.url);
        link.snapshot = snapshots.saveFromBase64(link.id, cap.buffer.toString('base64'));
        link.snapshotAt = new Date().toISOString();
        link.snapshotMethod = 'browser';
        store.save('links');
        return sendJson(res, 200, { link: decorate(link), app: cap.app });
      }
      // refresh: synchronous so the UI can show the outcome
      pending.add(link.id);
      try {
        await captureFor(link.id, body.mode === 'tile' ? 'tile' : 'auto', null);
      } finally {
        pending.delete(link.id);
      }
      return sendJson(res, 200, { link: decorate(store.findById(link.id)) });
    }
    if (seg[3] === 'snapshot' && method === 'DELETE') {
      snapshots.removeAll(link.id);
      link.snapshot = null; link.snapshotAt = null; delete link.snapshotMethod;
      store.save('links');
      return sendJson(res, 200, { link: decorate(link) });
    }
  }

  // Screenshot of the browser window showing this url (active tab). Returns a data URL
  // the caller can send back as `snapshot` when saving.
  // body.open: false keeps it to tabs that are already open (the Add page and the popup
  // probe quietly while you type); the default opens the page in a tab when needed.
  if (p === '/api/capture' && method === 'POST') {
    const body = await readJson(req);
    const cap = await captureFromBrowser(body.url, { open: body.open !== false });
    return sendJson(res, 200, { ok: true, app: cap.app, title: cap.title, method: cap.method, snapshot: 'data:image/jpeg;base64,' + cap.buffer.toString('base64') });
  }

  // body: { url, fetch?, title?, page? } where page is the metadata the bookmarklet read
  // inside the page. Returns page info plus `suggest` for folder, tags and keyword.
  if (p === '/api/enrich' && method === 'POST') {
    const body = await readJson(req);
    const info = await enrich(body.url, store.rules, { fetch: body.fetch !== false && body.noFetch !== true, timeoutMs: 8000 });
    if (info.error && !info.url) throw new HttpError(400, info.error);
    const dup = findDuplicate(info.url, null);
    const page = body.page && typeof body.page === 'object' ? body.page : null;
    const sug = suggestFor(info.url, { title: info.title || body.title || (page && page.title), page, existingTags: info.tags });
    for (const t of info.suggestedTags || []) if (!sug.tags.some((x) => x.name === t) && !(info.tags || []).includes(t)) sug.tags.push({ name: t, why: 'site name' });
    if (dup) sug.tags = sug.tags.filter((t) => !(dup.tags || []).includes(t.name));
    return sendJson(res, 200, { ...info, duplicate: dup ? decorate(dup) : null, suggest: sug });
  }

  if (p === '/api/import/sources' && method === 'GET') return sendJson(res, 200, { sources: importer.availableSources() });
  if (p === '/api/import/chrome' && method === 'POST') {
    const body = await readJson(req, 50 * 1024 * 1024);
    let loaded;
    try { loaded = importer.loadBookmarksFile(body.source || 'chrome', body.path, body.content); } catch (err) { throw new HttpError(400, err.message); }
    const items = importer.preview(loaded.items, store);
    return sendJson(res, 200, { source: body.source || 'file', path: loaded.path, total: items.length, duplicates: items.filter((i) => i.duplicate).length, items });
  }
  // Any supported file: Chrome Bookmarks JSON, Golinks JSON, bookmarks HTML, CSV, XLSX, Markdown, text.
  // body: { name, content, encoding: "text" | "base64" }
  if (p === '/api/import/file' && method === 'POST') {
    const body = await readJson(req, 80 * 1024 * 1024);
    const content = body.encoding === 'base64' ? Buffer.from(String(body.content || ''), 'base64') : String(body.content || '');
    let loaded;
    try { loaded = importer.loadAny(body.name || '', content); } catch (err) { throw new HttpError(400, err.message); }
    const items = importer.preview(loaded.items, store);
    return sendJson(res, 200, { source: loaded.format, format: loaded.format, name: body.name || '', total: items.length, duplicates: items.filter((i) => i.duplicate).length, items });
  }
  if (p === '/api/export' && method === 'GET') {
    const format = param(url, 'format', 'json');
    if (!exporter.FORMATS[format]) throw new HttpError(400, `unknown format "${format}"`);
    const opts = { folder: folderParam(url), tag: param(url, 'tag', null) || null, version: VERSION };
    const r = exporter.exportLinks(format, store.links, store.folders, opts);
    if (url.searchParams.has('preview')) return sendJson(res, 200, { count: r.count, filename: r.filename, format });
    res.writeHead(200, { 'content-type': r.mime, 'content-disposition': `attachment; filename="${r.filename}"`, 'cache-control': 'no-store' });
    res.end(r.body);
    return;
  }
  if (p === '/api/import/text' && method === 'POST') {
    const body = await readJson(req, 10 * 1024 * 1024);
    const items = importer.preview(importer.extractFromText(body.text), store);
    return sendJson(res, 200, { source: 'text', total: items.length, duplicates: items.filter((i) => i.duplicate).length, items });
  }
  if (p === '/api/import/commit' && method === 'POST') {
    const body = await readJson(req, 50 * 1024 * 1024);
    const items = Array.isArray(body.items) ? body.items : [];
    const mode = ['none', 'tile', 'auto'].includes(body.snapshotMode) ? body.snapshotMode : 'tile';
    const added = [];
    const skipped = [];
    for (const it of items) {
      try {
        // keep a keyword from the file only when nothing here uses it yet
        const kw = it.keyword && !store.findByKeyword(it.keyword) && !Object.keys(store.templates || {}).some((t) => t.toLowerCase() === String(it.keyword).toLowerCase()) ? it.keyword : null;
        const link = await createLink({
          url: it.url,
          title: it.title,
          tags: it.tags,
          folder: it.folder,
          keyword: kw,
          description: it.description,
          notes: it.notes,
          aliases: it.aliases,
          source: `import:${body.source || 'file'}`,
          enrich: false,
          snapshotMode: mode,
        });
        if (it.added && Date.parse(it.added)) link.created = new Date(it.added).toISOString();
        if (it.lastUsed && Date.parse(it.lastUsed)) link.lastUsed = new Date(it.lastUsed).toISOString();
        if (Number(it.useCount) > 0) link.useCount = Number(it.useCount);
        added.push(link.id);
      } catch (err) {
        skipped.push({ url: it.url, reason: err.message });
      }
    }
    if (added.length) { store.save('links'); reindex(); }
    return sendJson(res, 200, { added: added.length, skipped, ids: added });
  }

  if (p === '/api/settings') {
    if (method === 'GET') return sendJson(res, 200, { settings: store.settings, activePort: PORT });
    if (method === 'PUT') {
      const body = await readJson(req);
      const s = store.settings;
      if ('port' in body) { const n = Number(body.port); if (!(n >= 1024 && n <= 65535)) throw new HttpError(400, 'port must be 1024..65535'); s.port = n; }
      if ('staleDays' in body) { const n = Number(body.staleDays); if (!(n >= 1 && n <= 3650)) throw new HttpError(400, 'staleDays must be 1..3650'); s.staleDays = n; }
      if ('snapshotOnRevisit' in body) s.snapshotOnRevisit = Boolean(body.snapshotOnRevisit);
      if ('headlessSnapshots' in body) s.headlessSnapshots = Boolean(body.headlessSnapshots);
      if ('topCrop' in body) { const n = Number(body.topCrop); if (!(n >= 0 && n <= 400)) throw new HttpError(400, 'topCrop must be 0..400'); s.topCrop = n; }
      if ('setup' in body && body.setup && typeof body.setup === 'object') s.setup = Object.assign({}, s.setup || {}, body.setup);
      if ('goMinScore' in body) { const n = Number(body.goMinScore); if (!(n >= 0 && n <= 10)) throw new HttpError(400, 'goMinScore must be 0..10'); s.goMinScore = n; }
      store.save('settings');
      return sendJson(res, 200, { settings: s, activePort: PORT, restartRequired: s.port !== PORT });
    }
  }
  if (p === '/api/rules') {
    if (method === 'GET') return sendJson(res, 200, { rules: store.rules });
    if (method === 'PUT') {
      const body = await readJson(req);
      const rules = Array.isArray(body) ? body : body.rules;
      if (!Array.isArray(rules)) throw new HttpError(400, 'rules must be an array');
      for (const r of rules) if (!r || typeof r.match !== 'string' || !Array.isArray(r.tags)) throw new HttpError(400, 'each rule needs "match" (string) and "tags" (array)');
      store.data.rules = rules;
      store.save('rules');
      return sendJson(res, 200, { rules });
    }
  }
  if (p === '/api/templates') {
    if (method === 'GET') return sendJson(res, 200, { templates: store.templates });
    if (method === 'PUT') {
      const body = await readJson(req);
      const t = body.templates || body;
      if (!t || typeof t !== 'object' || Array.isArray(t)) throw new HttpError(400, 'templates must be an object of name -> url');
      for (const [k, v] of Object.entries(t)) {
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(k)) throw new HttpError(400, `bad template name "${k}"`);
        if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) throw new HttpError(400, `template "${k}" must be an http(s) url`);
      }
      store.data.templates = t;
      store.save('templates');
      return sendJson(res, 200, { templates: t });
    }
  }
  if (p === '/api/folders' && method === 'GET') return sendJson(res, 200, { folders: folders.listFolders(store.links, store.folders) });
  if (p === '/api/folders' && method === 'POST') {
    const body = await readJson(req);
    const path = folders.normalizeFolder(body.path);
    if (!path) throw new HttpError(400, 'path is required, for example "Work/Projects"');
    const existed = Boolean(store.findFolder(path));
    const created = setFolder(path);
    return sendJson(res, existed ? 200 : 201, { folder: folders.listFolders(store.links, store.folders).find((f) => f.path === created), existed });
  }
  // Rename or move a folder: `to` is the complete new path, so "Work/A" -> "Archive/A" moves it.
  if (p === '/api/folders/rename' && method === 'POST') {
    const body = await readJson(req);
    const from = folders.normalizeFolder(body.from);
    const to = folders.normalizeFolder(body.to);
    if (!from || !to) throw new HttpError(400, 'from and to are required');
    if (folders.isWithin(to, from) && to.toLowerCase() !== from.toLowerCase()) throw new HttpError(400, 'cannot move a folder into itself');
    const clash = store.findFolder(to);
    if (clash && clash.path.toLowerCase() !== from.toLowerCase()) throw new HttpError(409, `folder "${clash.path}" already exists`);
    let n = 0;
    for (const l of store.links) {
      if (!folders.isWithin(l.folder, from)) continue;
      l.folder = folders.rebase(l.folder, from, to);
      n++;
    }
    for (const f of store.folders) if (folders.isWithin(f.path, from)) f.path = folders.rebase(f.path, from, to);
    store.ensureFolder(to);
    store.save('folders'); store.save('links'); reindex();
    return sendJson(res, 200, { from, to, changed: n });
  }
  // Delete a folder and its subfolders. links: "parent" (default) moves their links up one
  // level, "root" unfiles them, "delete" removes the links too.
  if (p === '/api/folders/delete' && method === 'POST') {
    const body = await readJson(req);
    const path = folders.normalizeFolder(body.path);
    if (!path) throw new HttpError(400, 'path is required');
    const mode = ['parent', 'root', 'delete'].includes(body.links) ? body.links : 'parent';
    const parent = folders.parentOf(path);
    let moved = 0, deleted = 0;
    for (const l of [...store.links]) {
      if (!folders.isWithin(l.folder, path)) continue;
      if (mode === 'delete') { deleteLink(l); deleted++; continue; }
      l.folder = mode === 'parent' ? parent : null;
      moved++;
    }
    store.data.folders = store.folders.filter((f) => !folders.isWithin(f.path, path));
    store.save('folders'); store.save('links'); reindex();
    return sendJson(res, 200, { path, moved, deleted, parent });
  }
  if (p === '/api/tags/rename' && method === 'POST') {
    const body = await readJson(req);
    const from = slugTag(body.from); const to = slugTag(body.to);
    if (!from) throw new HttpError(400, 'from is required');
    let n = 0;
    for (const l of store.links) {
      if (!l.tags || !l.tags.includes(from)) continue;
      l.tags = normalizeTags(l.tags.map((t) => (t === from ? to : t)));
      n++;
    }
    store.save('links'); reindex();
    return sendJson(res, 200, { changed: n });
  }
  if (p === '/api/bookmarklet' && method === 'GET') return sendJson(res, 200, { href: bookmarkletCode(), port: PORT });

  if (p === '/quit' && method === 'POST') {
    sendJson(res, 200, { ok: true, message: 'stopping' });
    log('quit requested via /quit');
    setTimeout(() => shutdown(0), 150);
    return;
  }

  throw new HttpError(404, 'not found');
}

// ---------------------------------------------------------------------------
// Server

function isLocalOrigin(origin) {
  try { return LOCAL_HOSTS.has(new URL(origin).hostname); } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
    const hostHeader = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(hostHeader)) throw new HttpError(403, 'local access only');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && origin !== 'null' && !isLocalOrigin(origin)) throw new HttpError(403, 'cross-origin writes are not allowed');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross-site writes are not allowed');
    }
    await route(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: err.message, ...(err.extra || {}) });
    else res.end();
  } finally {
    if (url && !/^\/(snapshots|api\/health)|\.(js|css|svg|png)$/.test(url.pathname)) {
      log(req.method, url.pathname + (url.search || ''), res.statusCode, `${Date.now() - t0}ms`);
    }
  }
});

function shutdown(code) {
  store.close();
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1000).unref();
}

process.on('SIGTERM', () => { log('SIGTERM'); shutdown(0); });
process.on('SIGINT', () => { log('SIGINT'); shutdown(0); });
process.on('uncaughtException', (err) => { console.error('uncaught', err); shutdown(1); });

server.listen(PORT, HOST, () => {
  log(`golinks v${VERSION} listening on http://${HOST}:${PORT} (${store.links.length} links, pid ${process.pid})`);
});
