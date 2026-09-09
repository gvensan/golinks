/* Golinks web UI. Vanilla JS, no build step. */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    route: { page: 'links', tag: null, collection: null, view: null, linkId: null },
    q: '',
    layout: 'list',
    results: [],
    total: 0,
    terms: [],
    selected: 0,
    meta: null,
    editing: null,
    showAllTags: false,
    down: false,
  };
  try { state.layout = localStorage.getItem('links.layout') || 'list'; } catch { /* ignore */ }

  // ------------------------------------------------------------------ api
  async function api(method, path, body, opts) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      setDown(true);
      throw new Error('service not reachable');
    }
    setDown(false);
    let data = null;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok && !(opts && opts.allow && opts.allow.includes(res.status))) {
      const e = new Error(data.error || res.statusText);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }

  function setDown(down) {
    if (down === state.down) return;
    state.down = down;
    const b = $('#banner');
    b.classList.toggle('hidden', !down);
    b.innerHTML = down ? 'Service not reachable. Start it with <code>bin/golinks start</code> and reload.' : '';
  }

  // ------------------------------------------------------------------ helpers
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), ms || 2200);
  }

  function rel(iso) {
    if (!iso) return 'never';
    const d = (Date.now() - Date.parse(iso)) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    if (d < 86400 * 30) return Math.floor(d / 86400) + 'd ago';
    if (d < 86400 * 365) return Math.floor(d / 86400 / 30) + 'mo ago';
    return Math.floor(d / 86400 / 365) + 'y ago';
  }

  function host(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  }

  function hue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function hl(text, terms) {
    const safe = esc(text);
    if (!terms || !terms.length) return safe;
    const re = new RegExp('(' + terms.filter((t) => t.length > 1).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
    return terms.some((t) => t.length > 1) ? safe.replace(re, '<mark>$1</mark>') : safe;
  }

  async function copy(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg || 'Copied'); } catch { toast('Copy failed'); }
  }

  function lbl(text, tipKey) {
    return '<label>' + text + (tipKey ? '<span class="info" tabindex="0" data-tip="' + esc(TIPS[tipKey]) + '">i</span>' : '') + '</label>';
  }
  const TIPS = {"title": "Name shown in lists and matched first by search. Defaults to the page title.", "url": "The address this link opens. Fixed once saved; duplicates are detected on it.", "tags": "Short labels for filtering (click a tag in the sidebar) and search (tag:name). Rules add some automatically. Type a tag and press Enter or comma.", "keyword": "Unique short name for the Chrome address bar: type \"go name\" to open this link instantly. Letters, digits, dots and dashes.", "collection": "Optional group of related links, like a folder. The collection view can open or copy all of them at once.", "aliases": "Other names search should match, comma separated. Initials work too: \"ep\" finds an alias \"event portal\".", "description": "Longer summary, searched with lower weight than the title. Filled from the page when it is public.", "notes": "Your own notes, searched. The bookmarklet puts the text you had selected on the page here.", "snapshot": "Where the thumbnail comes from. From browser tab screenshots your own browser window (works for SSO pages). Auto refresh tries the page preview image, then headless Chrome for public pages, then a tile.", "snapshotmode": "How the thumbnail is produced after saving. Auto tries the page preview image, then headless Chrome for public pages, then a tile. If the page is open as the active tab of another browser window, a screenshot of it is used instead."};

  function snapshotUrl(link) {
    return link.snapshot ? '/' + link.snapshot + '?v=' + encodeURIComponent(link.snapshotAt || '') : '';
  }

  function tileHtml(link, cls) {
    const h = hue(host(link.url));
    const letter = (host(link.url)[0] || '?').toUpperCase();
    return '<div class="' + cls + '" style="background:linear-gradient(135deg,hsl(' + h + ' 55% 26%),hsl(' + ((h + 40) % 360) + ' 50% 38%))">' + esc(letter) + '</div>';
  }

  // ------------------------------------------------------------------ routing
  function parseHash() {
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    const r = { page: 'links', tag: null, collection: null, view: null, linkId: null };
    const [head, ...rest] = h.split('/');
    const val = rest.join('/');
    if (head === 'tag' && val) r.tag = val;
    else if (head === 'col' && val) r.collection = val;
    else if (head === 'view' && val) r.view = val;
    else if (head === 'link' && val) r.linkId = val;
    else if (['add', 'import', 'settings', 'setup'].includes(head)) r.page = head;
    return r;
  }

  function go(hash) {
    if (location.hash === hash) onRoute(); else location.hash = hash;
  }

  async function onRoute() {
    state.route = parseHash();
    if (state.route.page === 'links') {
      renderLinksChrome();
      await doSearch();
      if (state.route.linkId) {
        const link = state.results.find((l) => l.id === state.route.linkId) || (await api('GET', '/api/links/' + state.route.linkId).then((r) => r.link).catch(() => null));
        if (link) openDrawer(link);
      }
    } else if (state.route.page === 'add') renderAddPage();
    else if (state.route.page === 'import') renderImportPage();
    else if (state.route.page === 'settings') renderSettingsPage();
    else if (state.route.page === 'setup') renderSetupPage();
    renderSidebar();
  }

  // ------------------------------------------------------------------ sidebar
  async function loadMeta() {
    try { state.meta = await api('GET', '/api/meta'); } catch { /* banner shown */ }
    return state.meta;
  }

  function navItem(hash, label, count, ico, active) {
    return '<a href="' + hash + '" class="' + (active ? 'active' : '') + '"><span class="ico">' + (ico || '') + '</span><span class="label">' + esc(label) + '</span>' + (count != null ? '<span class="n">' + count + '</span>' : '') + '</a>';
  }

  function renderSidebar() {
    const m = state.meta;
    const r = state.route;
    const isLinks = r.page === 'links';
    const c = m ? m.counts : {};
    let html = '<div class="brand"><img src="/favicon.svg" alt=""> Golinks <span class="ver">' + (m ? 'v' + esc(m.version) : '') + '</span></div>';
    html += '<div class="nav">';
    html += navItem('#/', 'All links', c.all, '&#9776;', isLinks && !r.tag && !r.collection && !r.view);
    html += navItem('#/view/recent', 'Recent', c.recent, '&#9201;', r.view === 'recent');
    html += navItem('#/view/mostused', 'Most used', c.mostused, '&#9733;', r.view === 'mostused');
    html += navItem('#/view/keywords', 'Go keywords', c.keywords, '&#8594;', r.view === 'keywords');
    html += navItem('#/view/untagged', 'Untagged', c.untagged, '&#9675;', r.view === 'untagged');
    html += navItem('#/view/stale', 'Stale', c.stale, '&#9203;', r.view === 'stale');
    html += '</div>';
    if (m && m.tags.length) {
      const list = state.showAllTags ? m.tags : m.tags.slice(0, 18);
      html += '<h4>Tags' + (m.tags.length > 18 ? '<button id="toggleTags">' + (state.showAllTags ? 'fewer' : 'all ' + m.tags.length) + '</button>' : '') + '</h4><div class="nav">';
      for (const t of list) html += navItem('#/tag/' + encodeURIComponent(t.name), t.name, t.count, '#', r.tag === t.name);
      html += '</div>';
    }
    if (m && m.collections.length) {
      html += '<h4>Collections</h4><div class="nav">';
      for (const t of m.collections) html += navItem('#/col/' + encodeURIComponent(t.name), t.name, t.count, '&#9776;', r.collection === t.name);
      html += '</div>';
    }
    html += '<div class="spacer"></div><div class="nav foot">';
    if (m && m.restartNeeded) html += '<a href="#/settings" class="restart-note" title="The code on disk is newer than the running service">&#9888; restart needed</a>';
    html += navItem('#/setup', 'Setup checklist', null, '&#10003;', r.page === 'setup');
    html += navItem('#/add', 'Add link', null, '+', r.page === 'add');
    html += navItem('#/import', 'Import', null, '&#8615;', r.page === 'import');
    html += navItem('#/settings', 'Settings', null, '&#9881;', r.page === 'settings');
    html += '</div>';
    $('#side').innerHTML = html;
    const tt = $('#toggleTags');
    if (tt) tt.onclick = () => { state.showAllTags = !state.showAllTags; renderSidebar(); };
  }

  // ------------------------------------------------------------------ links view
  function renderLinksChrome() {
    $('.top').classList.remove('hidden');
    const r = state.route;
    document.title = (r.tag ? '#' + r.tag : r.collection ? r.collection : r.view ? r.view : 'Golinks') + (r.tag || r.collection || r.view ? ' | Golinks' : '');
  }

  function renderToolbar() {
    const r = state.route;
    if (r.page !== 'links') { $('#toolbar').innerHTML = ''; return; }
    let html = '<span>' + state.total + ' link' + (state.total === 1 ? '' : 's') + '</span>';
    if (r.tag) html += '<span class="chip filter">tag: ' + esc(r.tag) + ' <button data-clear title="clear">&times;</button></span>';
    if (r.collection) html += '<span class="chip filter">collection: ' + esc(r.collection) + ' <button data-clear title="clear">&times;</button></span>';
    if (r.view) html += '<span class="chip filter">' + esc(r.view) + ' <button data-clear title="clear">&times;</button></span>';
    if (r.collection && state.results.length) html += '<button class="btn sm" id="openAll">Open all</button><button class="btn sm" id="copyAll">Copy all URLs</button>';
    if (r.tag) html += '<button class="btn sm ghost" id="renameTag">Rename tag</button>';
    html += '<span class="grow"></span>';
    html += '<span class="small muted"><kbd>&uarr;&darr;</kbd> move <kbd>&#8629;</kbd> open <kbd>&#8984;&#8629;</kbd> copy <kbd>E</kbd> edit</span>';
    html += '<div class="seg"><button data-layout="list" class="' + (state.layout === 'list' ? 'on' : '') + '" title="List">&#9776; List</button><button data-layout="grid" class="' + (state.layout === 'grid' ? 'on' : '') + '" title="Grid">&#9638; Grid</button></div>';
    const tb = $('#toolbar');
    tb.innerHTML = html;
    $$('[data-clear]', tb).forEach((b) => (b.onclick = () => go('#/')));
    $$('[data-layout]', tb).forEach((b) => (b.onclick = () => { state.layout = b.dataset.layout; try { localStorage.setItem('links.layout', state.layout); } catch { /* ignore */ } renderResults(); renderToolbar(); }));
    const oa = $('#openAll');
    if (oa) oa.onclick = () => {
      let n = 0;
      for (const l of state.results) { const w = window.open('/open/' + l.id, '_blank'); if (w) n++; }
      if (n < state.results.length) toast('Chrome blocked some popups. Allow popups for localhost to open all ' + state.results.length + '.', 4000);
      else toast('Opened ' + n);
    };
    const ca = $('#copyAll');
    if (ca) ca.onclick = () => copy(state.results.map((l) => l.url).join('\n'), 'Copied ' + state.results.length + ' URLs');
    const rt = $('#renameTag');
    if (rt) rt.onclick = async () => {
      const to = prompt('Rename tag "' + r.tag + '" to:', r.tag);
      if (!to || to === r.tag) return;
      const res = await api('POST', '/api/tags/rename', { from: r.tag, to });
      toast('Renamed on ' + res.changed + ' links');
      await loadMeta();
      go('#/tag/' + encodeURIComponent(slugTag(to)));
    };
  }

  let searchTimer = null;
  let searchSeq = 0;
  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, 110);
  }

  async function doSearch() {
    if (state.route.page !== 'links') return;
    const r = state.route;
    const params = new URLSearchParams();
    state.q = $('#q').value;
    if (state.q) params.set('q', state.q);
    if (r.tag) params.set('tag', r.tag);
    if (r.collection) params.set('collection', r.collection);
    if (r.view) params.set('view', r.view);
    params.set('limit', '300');
    const seq = ++searchSeq;
    let data;
    try { data = await api('GET', '/api/search?' + params); } catch (err) { $('#content').innerHTML = '<div class="empty"><b>' + esc(err.message) + '</b></div>'; return; }
    if (seq !== searchSeq) return;
    state.results = data.results;
    state.total = data.total;
    state.terms = data.parsed.terms;
    state.selected = 0;
    renderToolbar();
    renderResults();
  }

  function renderResults() {
    const c = $('#content');
    if (!state.results.length) {
      c.innerHTML = '<div class="empty"><b>' + (state.q ? 'No matches for "' + esc(state.q) + '"' : 'Nothing here yet') + '</b>' +
        (state.q ? 'Try fewer words, or operators like <code>tag:jira</code>, <code>site:atlassian</code>, <code>unused:90d</code>.' : 'Add a link with the Shortcut, the bookmarklet, or <a href="#/add">Add link</a>. Or <a href="#/import">import</a> your Chrome bookmarks.') +
        '</div>';
      return;
    }
    const terms = state.terms;
    if (state.layout === 'grid') {
      c.innerHTML = '<div class="grid">' + state.results.map((l, i) => {
        const shot = l.snapshot ? '<img src="' + esc(snapshotUrl(l)) + '" alt="" loading="lazy">' : tileHtml(l, 'none');
        return '<div class="card' + (i === state.selected ? ' selected' : '') + '" data-i="' + i + '" data-id="' + esc(l.id) + '">' +
          '<div class="shot">' + shot + (l.snapshotPending ? '<span class="pend spin"></span>' : '') + (l.snapshotStale ? '<span class="pend badge warn">old snapshot</span>' : '') + '</div>' +
          '<div class="body"><div class="title" title="' + esc(l.title) + '">' + hl(l.title, terms) + '</div>' +
          '<div class="host">' + (l.keyword ? '<span class="chip kw">go ' + esc(l.keyword) + '</span> ' : '') + esc(host(l.url)) + '</div>' +
          (l.tags.length ? '<div class="tags">' + l.tags.map((t) => '<span class="chip">' + hl(t, terms) + '</span>').join('') + '</div>' : '') +
          '<div class="meta"><span>' + (l.lastUsed ? 'used ' + rel(l.lastUsed) : 'added ' + rel(l.created)) + '</span><span>' + (l.useCount ? l.useCount + '&times;' : '') + (l.stale ? ' <span class="badge warn">stale</span>' : '') + '</span></div>' +
          '<div class="acts"><button class="btn sm" data-edit title="Edit (E)">Edit</button><button class="btn sm ghost" data-copy title="Copy URL (C)">Copy</button><button class="btn sm ghost danger" data-del title="Delete (click twice)">Delete</button></div>' +
          '</div></div>';
      }).join('') + '</div>';
    } else {
      c.innerHTML = '<div class="list">' + state.results.map((l, i) => {
        const shot = l.snapshot ? '<img class="thumb" src="' + esc(snapshotUrl(l)) + '" alt="" loading="lazy">' : tileHtml(l, 'thumb none');
        return '<div class="row' + (i === state.selected ? ' selected' : '') + '" data-i="' + i + '" data-id="' + esc(l.id) + '">' + shot +
          '<div class="main"><div class="title"><span class="t">' + hl(l.title, terms) + '</span>' + (l.keyword ? '<span class="chip kw">go ' + esc(l.keyword) + '</span>' : '') + (l.snapshotPending ? '<span class="spin" title="capturing snapshot"></span>' : '') + '</div>' +
          '<div class="sub"><span class="host">' + esc(host(l.url)) + (l.collection ? ' &middot; ' + esc(l.collection) : '') + '</span>' +
          (l.tags.length ? '<span class="tags">' + l.tags.map((t) => '<span class="chip">' + hl(t, terms) + '</span>').join('') + '</span>' : '') + '</div></div>' +
          '<div class="right"><div>' + (l.lastUsed ? 'used ' + rel(l.lastUsed) : 'added ' + rel(l.created)) + '</div><div>' + (l.useCount ? l.useCount + ' open' + (l.useCount === 1 ? '' : 's') : '') + (l.stale ? ' <span class="stale">stale</span>' : '') + '</div></div>' +
          '<div class="acts"><button class="btn sm" data-edit title="Edit (E)">Edit</button><button class="btn sm ghost" data-copy title="Copy URL (C)">Copy</button><button class="btn sm ghost danger" data-del title="Delete (click twice)">Delete</button></div>' +
          '</div>';
      }).join('') + '</div>';
    }
  }

  function select(i, scroll) {
    if (!state.results.length) return;
    state.selected = Math.max(0, Math.min(state.results.length - 1, i));
    $$('.row.selected, .card.selected').forEach((e) => e.classList.remove('selected'));
    const el = $('[data-i="' + state.selected + '"]');
    if (el) { el.classList.add('selected'); if (scroll) el.scrollIntoView({ block: 'nearest' }); }
  }

  function selectedLink() { return state.results[state.selected]; }

  function openLink(link) {
    if (!link) return;
    window.open('/open/' + link.id, '_blank');
    link.useCount = (link.useCount || 0) + 1;
    link.lastUsed = new Date().toISOString();
    setTimeout(() => { renderResults(); loadMeta().then(renderSidebar); }, 400);
  }

  // hover preview in list mode: only while over the thumbnail or the text, anchored
  // below the row and aligned with the text column so it never covers the row actions.
  const preview = $('#preview');
  function showPreview(link, anchor) {
    if (!link || !link.snapshot || state.layout !== 'list') { preview.style.display = 'none'; return; }
    $('img', preview).src = snapshotUrl(link);
    $('.cap', preview).textContent = link.url;
    preview.style.display = 'block';
    const w = 360, h = 260;
    const r = anchor.getBoundingClientRect();
    const left = Math.min(window.innerWidth - w - 12, Math.max(12, r.left));
    const below = r.bottom + 6;
    const top = below + h <= window.innerHeight - 8 ? below : Math.max(8, r.top - h - 6);
    preview.style.left = left + 'px';
    preview.style.top = top + 'px';
  }

  $('#content').addEventListener('mousemove', (e) => {
    const hot = e.target.closest('.row .thumb, .row .main');
    if (!hot) { preview.style.display = 'none'; return; }
    const row = hot.closest('.row');
    const link = state.results[Number(row.dataset.i)];
    showPreview(link, row.querySelector('.main'));
  });
  $('#content').addEventListener('mouseleave', () => { preview.style.display = 'none'; });
  $('#content').addEventListener('click', (e) => {
    const item = e.target.closest('.row, .card');
    if (!item) return;
    const i = Number(item.dataset.i);
    select(i);
    if (e.target.closest('[data-edit]')) { openDrawer(state.results[i]); return; }
    if (e.target.closest('[data-copy]')) { copy(state.results[i].url, 'URL copied'); return; }
    const del = e.target.closest('[data-del]');
    if (del) { confirmDelete(del, state.results[i]); return; }
    if (e.metaKey || e.ctrlKey) { copy(state.results[i].url, 'URL copied'); return; }
    if (e.altKey) { openDrawer(state.results[i]); return; }
    openLink(state.results[i]);
  });
  $('#content').addEventListener('dblclick', (e) => {
    const item = e.target.closest('.row, .card');
    if (item) openDrawer(state.results[Number(item.dataset.i)]);
  });
  $('#content').addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.row, .card');
    if (!item) return;
    e.preventDefault();
    openDrawer(state.results[Number(item.dataset.i)]);
  });

  // ------------------------------------------------------------------ keyboard
  document.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    const inSearch = e.target.id === 'q';
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); if (state.route.page !== 'links') go('#/'); const q = $('#q'); q.focus(); q.select(); return; }
    if (e.key === 'Escape') {
      if ($('#drawer').classList.contains('open')) { closeDrawer(); return; }
      if (inSearch && $('#q').value) { $('#q').value = ''; scheduleSearch(); return; }
      if (inField) e.target.blur();
      return;
    }
    if (mod && e.key.toLowerCase() === 's' && $('#drawer').classList.contains('open')) { e.preventDefault(); saveDrawer(); return; }
    if (mod && e.key === 'Enter' && $('#drawer').classList.contains('open')) { e.preventDefault(); saveDrawer(); return; }
    if (inField && !inSearch) return;
    if (state.route.page !== 'links') return;

    if (e.key === 'ArrowDown') { e.preventDefault(); select(state.selected + 1, true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(state.selected - 1, true); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const l = selectedLink();
      if (!l) return;
      if (mod) copy(l.url, 'URL copied');
      else if (e.shiftKey) openDrawer(l);
      else openLink(l);
    } else if (!inField) {
      if (e.key === 'e') { e.preventDefault(); openDrawer(selectedLink()); }
      else if (e.key === 'c') { const l = selectedLink(); if (l) copy(l.url, 'URL copied'); }
      else if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
      else if (e.key === 'l') { state.layout = state.layout === 'list' ? 'grid' : 'list'; renderResults(); renderToolbar(); }
      else if (e.key === 'n') { go('#/add'); }
    }
  });

  $('#q').addEventListener('input', scheduleSearch);

  // ------------------------------------------------------------------ drawer
  let drawerChips = null;
  function openDrawer(link) {
    if (!link) return;
    state.editing = link;
    const d = $('#drawer');
    const shot = link.snapshot ? '<img src="' + esc(snapshotUrl(link)) + '" alt="">' : '<div class="none">no snapshot</div>';
    d.innerHTML =
      '<div class="drawer-head"><h3 title="' + esc(link.title) + '">' + esc(link.title) + '</h3>' +
      '<button class="btn sm" id="dOpen" title="Open">Open</button><button class="btn sm" id="dCopy" title="Copy URL">Copy</button><button class="btn sm ghost" id="dClose" title="Close (Esc)">&times;</button></div>' +
      '<div class="drawer-body">' +
      '<div class="shot-edit">' + shot + '</div>' +
      '<div class="field" style="margin-bottom:0">' + lbl('Snapshot source', 'snapshot') + '</div>' +
      '<div class="shot-actions"><button class="btn sm primary" id="dSnapBrowser" title="Screenshot the browser window that has this page open as its active tab (works for SSO pages)">From browser tab</button>' +
      '<button class="btn sm" id="dSnapRefresh" title="Automatic: page preview image (og:image), else headless Chrome for public pages, else a tile">Auto refresh</button>' +
      '<button class="btn sm" id="dSnapTile" title="Generate a coloured tile with the site favicon">Tile</button><label class="btn sm" title="Use an image file from disk">Upload<input type="file" id="dSnapFile" accept="image/*" class="hidden"></label>' +
      (link.snapshot ? '<button class="btn sm ghost" id="dSnapRemove" title="Delete the snapshot; the list shows a letter tile">Remove</button>' : '') +
      (link.snapshotStale ? '<span class="badge warn">snapshot older than ' + (state.meta ? state.meta.settings.staleDays : 90) + ' days</span>' : '') + '</div>' +
      '<div class="field">' + lbl('Title', 'title') + '<input type="text" id="fTitle" value="' + esc(link.title) + '"></div>' +
      '<div class="field">' + lbl('URL', 'url') + '<div class="readonly-url" title="' + esc(link.url) + '">' + esc(link.url) + '</div></div>' +
      '<div class="field">' + lbl('Tags', 'tags') + '<div id="fTags"></div></div>' +
      '<div class="row2"><div class="field">' + lbl('Go keyword', 'keyword') + '<input type="text" id="fKeyword" value="' + esc(link.keyword || '') + '" placeholder="epdesign"><div class="help">Type <code>go ' + esc(link.keyword || 'name') + '</code> in Chrome</div></div>' +
      '<div class="field">' + lbl('Collection', 'collection') + '<input type="text" id="fCollection" list="collections" value="' + esc(link.collection || '') + '"><datalist id="collections">' + (state.meta ? state.meta.collections.map((c) => '<option value="' + esc(c.name) + '">').join('') : '') + '</datalist></div></div>' +
      '<div class="field">' + lbl('Aliases', 'aliases') + '<input type="text" id="fAliases" value="' + esc((link.aliases || []).join(', ')) + '"></div>' +
      '<div class="field">' + lbl('Description', 'description') + '<textarea id="fDescription">' + esc(link.description || '') + '</textarea></div>' +
      '<div class="field">' + lbl('Notes', 'notes') + '<textarea id="fNotes">' + esc(link.notes || '') + '</textarea></div>' +
      '<div class="stats"><span>Added <b>' + rel(link.created) + '</b></span><span>Last used <b>' + rel(link.lastUsed) + '</b></span><span>Opens <b>' + (link.useCount || 0) + '</b></span><span>Source <b>' + esc(link.source || '') + '</b></span>' +
      (link.snapshotMethod ? '<span>Snapshot <b>' + esc(link.snapshotMethod) + '</b> ' + rel(link.snapshotAt) + '</span>' : '') + '<span>Id <b>' + esc(link.id) + '</b></span></div>' +
      '</div>' +
      '<div class="drawer-foot"><button class="btn primary" id="dSave">Save <kbd>&#8984;S</kbd></button><button class="btn" id="dClose2">Cancel</button><span class="grow" style="flex:1"></span><button class="btn danger" id="dDelete">Delete</button></div>';
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
    drawerChips = chipEditor($('#fTags'), { values: link.tags, all: state.meta ? state.meta.tags.map((t) => t.name) : [] });

    $('#dClose').onclick = closeDrawer;
    $('#dClose2').onclick = closeDrawer;
    $('#dOpen').onclick = () => openLink(link);
    $('#dCopy').onclick = () => copy(link.url, 'URL copied');
    $('#dSave').onclick = saveDrawer;
    $('#dDelete').onclick = async (e) => {
      const b = e.currentTarget;
      if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Confirm delete'; setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Delete'; }, 3000); return; }
      await api('DELETE', '/api/links/' + link.id);
      toast('Deleted');
      closeDrawer();
      await refreshAll();
    };
    $('#dSnapRefresh').onclick = () => snapshotAction(link, {});
    $('#dSnapBrowser').onclick = () => snapshotAction(link, { mode: 'browser' });
    $('#dSnapTile').onclick = () => snapshotAction(link, { mode: 'tile' });
    $('#dSnapFile').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
      await snapshotAction(link, { snapshot: b64 });
    };
    const rm = $('#dSnapRemove');
    if (rm) rm.onclick = async () => { const r = await api('DELETE', '/api/links/' + link.id + '/snapshot'); replaceResult(r.link); openDrawer(r.link); toast('Snapshot removed'); };
    setTimeout(() => $('#fTitle').focus(), 50);
  }

  async function snapshotAction(link, body) {
    const btns = $$('.shot-actions .btn');
    btns.forEach((b) => (b.disabled = true));
    toast(body.snapshot ? 'Uploading' : body.mode === 'browser' ? 'Looking for a browser window showing this page' : 'Capturing snapshot, this can take up to 30 seconds', 3000);
    try {
      const r = await api('POST', '/api/links/' + link.id + '/snapshot', body);
      replaceResult(r.link);
      openDrawer(r.link);
      renderResults();
      toast('Snapshot updated (' + (r.link.snapshotMethod || 'ok') + ')');
    } catch (err) {
      toast('Snapshot failed: ' + err.message, 4000);
      btns.forEach((b) => (b.disabled = false));
    }
  }

  // Two-step delete: first click arms the button for 3 seconds, second click deletes.
  async function confirmDelete(button, link) {
    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      button.textContent = 'Confirm delete';
      clearTimeout(button._disarm);
      button._disarm = setTimeout(() => { button.classList.remove('armed'); button.textContent = 'Delete'; }, 3000);
      return;
    }
    button.disabled = true;
    try {
      await api('DELETE', '/api/links/' + link.id);
      toast('Deleted "' + link.title + '"');
      if (state.editing && state.editing.id === link.id) closeDrawer();
      await refreshAll();
    } catch (err) {
      toast(err.message, 4000);
      button.disabled = false;
    }
  }

  function replaceResult(link) {
    const i = state.results.findIndex((l) => l.id === link.id);
    if (i >= 0) state.results[i] = link;
    state.editing = link;
  }

  async function saveDrawer() {
    const link = state.editing;
    if (!link) return;
    const body = {
      title: $('#fTitle').value,
      tags: drawerChips.get(),
      keyword: $('#fKeyword').value,
      collection: $('#fCollection').value,
      aliases: $('#fAliases').value,
      description: $('#fDescription').value,
      notes: $('#fNotes').value,
    };
    try {
      const r = await api('PUT', '/api/links/' + link.id, body);
      replaceResult(r.link);
      toast('Saved');
      closeDrawer();
      await refreshAll();
    } catch (err) {
      toast(err.message, 4000);
    }
  }

  function closeDrawer() {
    const d = $('#drawer');
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
    state.editing = null;
    if (state.route.linkId) history.replaceState(null, '', '#/');
  }

  async function refreshAll() {
    await loadMeta();
    renderSidebar();
    if (state.route.page === 'links') await doSearch();
  }

  // ------------------------------------------------------------------ add page
  function pageShell(title, inner) {
    $('.top').classList.add('hidden');
    $('#toolbar').innerHTML = '';
    document.title = title + ' | Golinks';
    $('#content').innerHTML = '<div class="page"><h1>' + esc(title) + '</h1>' + inner + '</div>';
  }

  function renderAddPage() {
    pageShell('Add link',
      '<div class="card-box">' +
      '<div class="field">' + lbl('URL', 'url') + '<input type="url" id="aUrl" placeholder="https://..." autofocus><div class="help">Paste a URL and press Enter. Public pages are fetched for title and image. SSO pages come back blank, fill the title yourself; snapshots for those come from the menu bar Shortcut.</div></div>' +
      '<div id="aInfo"></div>' +
      '<div class="field">' + lbl('Title', 'title') + '<input type="text" id="aTitle"></div>' +
      '<div class="field">' + lbl('Tags', 'tags') + '<div id="aTags"></div></div>' +
      '<div class="row2"><div class="field">' + lbl('Go keyword', 'keyword') + '<input type="text" id="aKeyword" placeholder="optional short name"></div>' +
      '<div class="field">' + lbl('Collection', 'collection') + '<input type="text" id="aCollection" list="collections2"><datalist id="collections2">' + (state.meta ? state.meta.collections.map((c) => '<option value="' + esc(c.name) + '">').join('') : '') + '</datalist></div></div>' +
      '<div class="field">' + lbl('Aliases', 'aliases') + '<input type="text" id="aAliases" placeholder="comma separated"></div>' +
      '<div class="field">' + lbl('Description', 'description') + '<textarea id="aDescription"></textarea></div>' +
      '<div class="field">' + lbl('Notes', 'notes') + '<textarea id="aNotes"></textarea></div>' +
      '<div class="field">' + lbl('Snapshot', 'snapshotmode') + '<select id="aSnap"><option value="auto">Auto: og:image, then headless Chrome for public pages, then tile</option><option value="tile">Tile only (fast)</option><option value="none">None</option></select></div>' +
      '<div class="actions"><button class="btn primary" id="aSave">Save link <kbd>&#8984;&#8629;</kbd></button><button class="btn" id="aFetch">Fetch details again</button><span id="aStatus" class="muted small"></span></div>' +
      '</div>');
    const chips = chipEditor($('#aTags'), { all: state.meta ? state.meta.tags.map((t) => t.name) : [] });
    let info = null;
    let captured = null;
    let lastFetched = '';
    const urlEl = $('#aUrl');
    async function fetchInfo(force) {
      const url = urlEl.value.trim();
      if (!url || (!force && url === lastFetched)) return;
      lastFetched = url;
      $('#aStatus').innerHTML = '<span class="spin"></span> fetching';
      $('#aInfo').innerHTML = '';
      try {
        info = await api('POST', '/api/enrich', { url });
      } catch (err) { $('#aStatus').textContent = err.message; return; }
      $('#aStatus').textContent = '';
      if (info.url && info.url !== url) urlEl.value = info.url;
      if (info.title && !$('#aTitle').value) $('#aTitle').value = info.title;
      if (info.description && !$('#aDescription').value) $('#aDescription').value = info.description;
      chips.set([...chips.get(), ...info.tags]);
      chips.setSuggestions(info.suggestedTags);
      let msg = '';
      if (info.duplicate) msg += '<div class="alert warn">Already saved as <a href="#/link/' + esc(info.duplicate.id) + '">' + esc(info.duplicate.title) + '</a>. Saving again will be refused.</div>';
      if (info.loginDetected) msg += '<div class="alert">This page redirected to a sign-in screen, so no title or image was taken from it. Fill in the title yourself; the snapshot will be a tile until you capture one with the Shortcut.</div>';
      else if (info.error) msg += '<div class="alert">Could not fetch the page (' + esc(info.error) + '). You can still save it.</div>';
      else if (info.ogImage) msg += '<div class="alert ok">Found a preview image on the page. It will be used as the snapshot.</div>';
      $('#aInfo').innerHTML = msg;
      if (!$('#aTitle').value) $('#aTitle').focus();
      // If the page is open as the active tab of another browser window, grab a real screenshot.
      captured = null;
      try {
        const cap = await api('POST', '/api/capture', { url: urlEl.value.trim() });
        captured = cap.snapshot;
        if (cap.title && !$('#aTitle').value) $('#aTitle').value = cap.title;
        $('#aInfo').innerHTML = msg + '<div class="alert ok">Screenshot taken from the ' + esc(cap.app) + ' window showing this page. It will be used as the snapshot.</div>';
      } catch (err) { /* not open in a window, or no permission: fall back to auto */ }
    }
    urlEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fetchInfo(true); } });
    urlEl.addEventListener('blur', () => fetchInfo(false));
    urlEl.addEventListener('paste', () => setTimeout(() => fetchInfo(false), 50));
    $('#aFetch').onclick = () => fetchInfo(true);
    async function save() {
      const body = {
        url: urlEl.value, title: $('#aTitle').value, tags: chips.get(), keyword: $('#aKeyword').value, collection: $('#aCollection').value,
        aliases: $('#aAliases').value, description: $('#aDescription').value, notes: $('#aNotes').value, snapshotMode: $('#aSnap').value,
        snapshotUrl: info && info.ogImage ? info.ogImage : undefined, snapshot: captured || undefined, source: 'web', enrich: false,
      };
      if (!body.title && info && !info.title) body.enrich = true;
      $('#aSave').disabled = true;
      try {
        const r = await api('POST', '/api/links', body);
        toast('Saved');
        await loadMeta();
        go('#/link/' + r.link.id);
      } catch (err) {
        $('#aSave').disabled = false;
        if (err.status === 409 && err.data.link) $('#aInfo').innerHTML = '<div class="alert warn">' + esc(err.message) + ': <a href="#/link/' + esc(err.data.link.id) + '">' + esc(err.data.link.title) + '</a></div>';
        else toast(err.message, 4000);
      }
    }
    $('#aSave').onclick = save;
    $('#content').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); } });
    const qs = new URLSearchParams(location.search);
    if (qs.get('url')) { urlEl.value = qs.get('url'); fetchInfo(false); }
    setTimeout(() => urlEl.focus(), 30);
  }

  // ------------------------------------------------------------------ import page
  function renderImportPage() {
    pageShell('Import',
      '<div class="card-box"><h2 style="margin-top:0">From a browser</h2><div class="sources" id="iSources"><span class="spin"></span></div>' +
      '<p class="help small muted">Reads the browser\'s Bookmarks file directly. Folders become collections and a tag. Nothing is written to the browser.</p></div>' +
      '<div class="card-box"><h2 style="margin-top:0">From a file or text</h2>' +
      '<div class="actions"><label class="btn">Choose Bookmarks file<input type="file" id="iFile" class="hidden"></label><span class="muted small">A Chrome-style Bookmarks JSON file (Chrome, Brave, Edge, Chromium).</span></div>' +
      '<div class="field"><label>Or paste text containing URLs</label><textarea id="iText" placeholder="Any text. Every http(s) URL in it is extracted."></textarea></div>' +
      '<div class="actions"><button class="btn" id="iTextBtn">Extract URLs</button></div></div>' +
      '<div id="iPreview"></div>');
    api('GET', '/api/import/sources').then((r) => {
      $('#iSources').innerHTML = r.sources.length
        ? r.sources.map((s) => '<button class="btn" data-src="' + esc(s.name) + '">' + esc(s.name[0].toUpperCase() + s.name.slice(1)) + ' <span class="muted small">' + Math.round(s.size / 1024) + ' KB</span></button>').join('')
        : '<span class="muted">No Chrome-style browser profiles found.</span>';
      $$('#iSources [data-src]').forEach((b) => (b.onclick = () => loadPreview(api('POST', '/api/import/chrome', { source: b.dataset.src }), b.dataset.src)));
    }).catch((e) => { $('#iSources').textContent = e.message; });
    $('#iFile').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const content = await f.text();
      loadPreview(api('POST', '/api/import/chrome', { source: 'file', content }), 'file');
    };
    $('#iTextBtn').onclick = () => loadPreview(api('POST', '/api/import/text', { text: $('#iText').value }), 'text');

    async function loadPreview(promise, source) {
      $('#iPreview').innerHTML = '<div class="card-box"><span class="spin"></span> reading</div>';
      let data;
      try { data = await promise; } catch (err) { $('#iPreview').innerHTML = '<div class="alert error">' + esc(err.message) + '</div>'; return; }
      const items = data.items;
      const render = () => {
        const sel = items.filter((i) => i.selected).length;
        $('#iPreview').innerHTML =
          '<div class="card-box"><h2 style="margin-top:0">Preview: ' + items.length + ' links, ' + data.duplicates + ' already saved</h2>' +
          '<div class="actions"><button class="btn sm" data-sel="new">Select new</button><button class="btn sm" data-sel="all">Select all</button><button class="btn sm" data-sel="none">Select none</button>' +
          '<span class="grow" style="flex:1"></span><label class="small muted">Snapshots <select id="iSnap"><option value="tile">tiles (fast)</option><option value="none">none</option><option value="auto">auto (slow, headless Chrome per link)</option></select></label>' +
          '<button class="btn primary" id="iCommit" ' + (sel ? '' : 'disabled') + '>Import ' + sel + ' link' + (sel === 1 ? '' : 's') + '</button></div>' +
          '<div class="tbl-wrap"><table class="tbl"><thead><tr><th></th><th>Title</th><th>URL</th><th>Folder</th><th>Tags</th><th></th></tr></thead><tbody>' +
          items.map((it, i) => '<tr class="' + (it.duplicate ? 'dup' : '') + '"><td><input type="checkbox" data-i="' + i + '" ' + (it.selected ? 'checked' : '') + '></td>' +
            '<td>' + esc(it.title || '(no title)') + '</td><td class="url" title="' + esc(it.url) + '">' + esc(it.url.replace(/^https?:\/\//, '')) + '</td>' +
            '<td class="small muted">' + esc(it.folder || '') + '</td><td>' + it.tags.map((t) => '<span class="chip" style="font-size:11px">' + esc(t) + '</span>').join(' ') + '</td>' +
            '<td>' + (it.duplicate ? '<span class="badge">saved</span>' : '') + '</td></tr>').join('') +
          '</tbody></table></div></div>';
        $$('#iPreview input[type=checkbox]').forEach((cb) => (cb.onchange = () => { items[Number(cb.dataset.i)].selected = cb.checked; updateCount(); }));
        $$('#iPreview [data-sel]').forEach((b) => (b.onclick = () => { items.forEach((it) => { it.selected = b.dataset.sel === 'all' ? true : b.dataset.sel === 'none' ? false : !it.duplicate; }); render(); }));
        $('#iCommit').onclick = commit;
      };
      const updateCount = () => { const sel = items.filter((i) => i.selected).length; const b = $('#iCommit'); b.disabled = !sel; b.textContent = 'Import ' + sel + ' link' + (sel === 1 ? '' : 's'); };
      const commit = async () => {
        const chosen = items.filter((i) => i.selected);
        const b = $('#iCommit');
        b.disabled = true;
        b.innerHTML = '<span class="spin"></span> importing ' + chosen.length;
        try {
          const r = await api('POST', '/api/import/commit', { items: chosen, source, snapshotMode: $('#iSnap').value });
          toast('Imported ' + r.added + (r.skipped.length ? ', skipped ' + r.skipped.length : ''), 4000);
          await loadMeta();
          go('#/view/added');
        } catch (err) { toast(err.message, 4000); b.disabled = false; b.textContent = 'Import'; }
      };
      render();
    }
  }

  // ------------------------------------------------------------------ settings page
  async function renderSettingsPage() {
    const m = state.meta || (await loadMeta());
    const [health, bm, rules] = await Promise.all([api('GET', '/api/health'), api('GET', '/api/bookmarklet'), api('GET', '/api/rules')]);
    const s = m.settings;
    pageShell('Settings',
      '<div class="card-box"><h2 style="margin-top:0">General</h2>' +
      '<div class="row2"><div class="field"><label>Port</label><input type="number" id="sPort" value="' + s.port + '"><div class="help">Active: ' + health.port + '. Changing the port needs <code>bin/golinks restart</code> and updating the Chrome <code>go</code> keyword and Shortcuts.</div></div>' +
      '<div class="field"><label>Stale after (days)</label><input type="number" id="sStale" value="' + s.staleDays + '"><div class="help">Links not opened for this long show as stale; snapshots older than this get a hint.</div></div></div>' +
      '<div class="row2"><div class="field"><label>Go confidence (min text score)</label><input type="number" step="0.1" id="sGo" value="' + s.goMinScore + '"><div class="help">Lower means <code>go words</code> redirects more eagerly to the best match instead of showing search results.</div></div>' +
      '<div class="field"><label>Browser chrome to crop (points)</label><input type="number" id="sTopCrop" value="' + (s.topCrop ?? 116) + '"><div class="help">Height of tab strip, address bar and bookmarks bar removed from the top of window screenshots. 116 with the bookmarks bar shown, 87 without.</div></div></div>' +
      '<div class="row2"><div class="field checks"><label><input type="checkbox" id="sHeadless" ' + (s.headlessSnapshots ? 'checked' : '') + '> Headless Chrome snapshots for public pages' + (m.chrome ? '' : ' (no Chrome found)') + '</label>' +
      '<label><input type="checkbox" id="sRevisit" ' + (s.snapshotOnRevisit ? 'checked' : '') + '> Snapshot on revisit (used by the open Shortcut)</label></div></div>' +
      '<div class="actions"><button class="btn primary" id="sSave">Save settings</button><span id="sMsg" class="small muted"></span></div></div>' +

      '<div class="card-box"><h2 style="margin-top:0">Templates</h2><p class="small muted">Parameterized go-links. <code>{0}</code> <code>{1}</code> are words after the name, <code>{q}</code> is everything after the name URL-encoded, <code>{*}</code> raw. Example: <code>go jira PROJ-123</code>.</p>' +
      '<div class="field"><textarea class="code" id="sTemplates">' + esc(JSON.stringify(m.templates, null, 2)) + '</textarea></div>' +
      '<div class="actions"><button class="btn" id="sTemplatesSave">Save templates</button><span id="sTemplatesMsg" class="small muted"></span></div></div>' +

      '<div class="card-box"><h2 style="margin-top:0">Tagging rules</h2><p class="small muted">Applied to every new link. <code>match</code> is a case-insensitive regex against the URL; <code>$1</code> in a tag is replaced by the first capture group.</p>' +
      '<div class="field"><textarea class="code" id="sRules">' + esc(JSON.stringify(rules.rules, null, 2)) + '</textarea></div>' +
      '<div class="actions"><button class="btn" id="sRulesSave">Save rules</button><span id="sRulesMsg" class="small muted"></span></div></div>' +

      '<div class="card-box"><h2 style="margin-top:0">Capture from Chrome</h2>' +
      '<p><b>Omnibox:</b> in Chrome go to <code>chrome://settings/searchEngines</code>, add a site search named <code>Go Links</code> with shortcut <code>go</code> and URL <code>http://localhost:' + health.port + '/go/%s</code>. Then type <code>go epdesign</code> or <code>go jira PROJ-123</code> in the address bar.</p>' +
      '<p><b>Bookmarklet:</b> drag this to the bookmarks bar: <a class="btn" id="bmLink" href="' + esc(bm.href) + '" onclick="return false">Add to Links</a> <button class="btn sm ghost" id="bmCopy">Copy code</button></p>' +
      '<p><b>Menu bar and hotkeys:</b> see <code>shortcuts/README.md</code> for the two Apple Shortcuts (search, add current tab with screenshot) and the start/stop entries.</p></div>' +

      '<div class="card-box"><h2 style="margin-top:0">Permissions and health</h2><div id="doctor"><span class="spin"></span> checking</div>' +
      '<div class="actions"><button class="btn" id="doctorRun">Re-check</button><button class="btn" id="doctorCapture">Test screenshot of this tab</button><span id="doctorMsg" class="small muted"></span></div></div>' +

      '<div class="card-box"><h2 style="margin-top:0">Service</h2>' +
      '<div class="shortcuts-help"><span class="muted">Version</span><span>' + esc(health.version) + '</span><span class="muted">PID</span><span>' + health.pid + '</span><span class="muted">Uptime</span><span>' + Math.floor(health.uptimeSec / 60) + ' min</span><span class="muted">Links</span><span>' + health.links + '</span><span class="muted">Pending snapshots</span><span>' + health.pendingSnapshots + '</span></div>' +
      '<div class="actions"><button class="btn danger" id="sQuit">Stop service</button><span class="small muted">Exits cleanly (code 0), so launchd leaves it stopped until login or <code>bin/golinks start</code>.</span></div></div>');

    $('#sSave').onclick = async () => {
      try {
        const r = await api('PUT', '/api/settings', { port: Number($('#sPort').value), staleDays: Number($('#sStale').value), goMinScore: Number($('#sGo').value), topCrop: Number($('#sTopCrop').value), headlessSnapshots: $('#sHeadless').checked, snapshotOnRevisit: $('#sRevisit').checked });
        $('#sMsg').textContent = r.restartRequired ? 'Saved. Restart required for the port change.' : 'Saved.';
        await loadMeta();
      } catch (err) { $('#sMsg').textContent = err.message; }
    };
    $('#sTemplatesSave').onclick = async () => {
      try {
        const t = JSON.parse($('#sTemplates').value);
        await api('PUT', '/api/templates', { templates: t });
        $('#sTemplatesMsg').textContent = 'Saved.';
        await loadMeta();
      } catch (err) { $('#sTemplatesMsg').textContent = err.message; }
    };
    $('#sRulesSave').onclick = async () => {
      try {
        const r = JSON.parse($('#sRules').value);
        await api('PUT', '/api/rules', { rules: r });
        $('#sRulesMsg').textContent = 'Saved.';
      } catch (err) { $('#sRulesMsg').textContent = err.message; }
    };
    $('#bmCopy').onclick = () => copy(bm.href, 'Bookmarklet code copied');
    renderDoctor($('#doctor'));
    $('#doctorRun').onclick = () => renderDoctor($('#doctor'));
    $('#doctorCapture').onclick = async () => {
      $('#doctorMsg').innerHTML = '<span class="spin"></span> capturing';
      try {
        const r = await api('POST', '/api/capture', { url: location.origin + '/' });
        $('#doctorMsg').innerHTML = 'Screenshot works (' + esc(r.app) + '). <img src="' + r.snapshot + '" style="height:60px;vertical-align:middle;border-radius:4px;margin-left:8px">';
      } catch (err) { $('#doctorMsg').textContent = err.message; }
    };
    $('#sQuit').onclick = async (e) => {
      const b = e.currentTarget;
      if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Confirm stop'; setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Stop service'; }, 3000); return; }
      try { await api('POST', '/quit'); } catch { /* connection drops */ }
      $('#content').innerHTML = '<div class="empty"><b>Service stopped</b>Start it again from the menu bar Shortcut or with <code>bin/golinks start</code>.</div>';
      setTimeout(() => setDown(true), 500);
    };
  }

  // ------------------------------------------------------------------ doctor and setup
  async function renderDoctor(el) {
    el.innerHTML = '<span class="spin"></span> checking (this can take a few seconds)';
    let d;
    try { d = await api('GET', '/api/doctor'); } catch (err) { el.innerHTML = '<div class="alert error">' + esc(err.message) + '</div>'; return null; }
    el.innerHTML = '<div class="checks">' + d.checks.map((c) =>
      '<div class="check ' + (c.ok === true ? 'ok' : c.ok === false ? 'fail' : 'skip') + '"><span class="mark">' + (c.ok === true ? '&#10003;' : c.ok === false ? '&#10007;' : '&#8226;') + '</span>' +
      '<div><div>' + esc(c.label) + (c.detail ? ' <span class="muted small">' + esc(c.detail) + '</span>' : '') + '</div>' +
      (c.ok === false && c.fix ? '<div class="small fix">' + esc(c.fix) + '</div>' : '') + '</div></div>').join('') + '</div>' +
      (d.restartNeeded ? '<div class="alert warn">The code on disk is newer than the running service. Run <code>bin/golinks restart</code>.</div>' : '');
    return d;
  }

  async function markSetup(key, value) {
    await api('PUT', '/api/settings', { setup: { [key]: value } });
    await loadMeta();
  }

  async function renderSetupPage() {
    const m = state.meta || (await loadMeta());
    const [health, bm] = await Promise.all([api('GET', '/api/health'), api('GET', '/api/bookmarklet')]);
    const done = (m.settings.setup) || {};
    const goUrl = 'http://localhost:' + health.port + '/go/%s';
    const step = (key, title, body, auto) =>
      '<div class="step ' + (done[key] || auto ? 'done' : '') + '" data-step="' + key + '"><div class="step-head"><span class="mark">' + (done[key] || auto ? '&#10003;' : '') + '</span><h3>' + title + '</h3>' +
      (auto ? '' : '<button class="btn sm ghost" data-toggle="' + key + '">' + (done[key] ? 'Undo' : 'Mark done') + '</button>') + '</div><div class="step-body">' + body + '</div></div>';
    pageShell('Setup checklist',
      '<p class="muted">Five short steps. Everything works without them, but each one makes Links faster to use.</p>' +
      step('service', 'Service is running', 'Version ' + esc(health.version) + ' on port ' + health.port + ', started at login by launchd. Menu bar icon: <code>bin/golinks menubar status</code>.', true) +
      step('go', 'Address bar go-links', '<p>In your browser open the site-search settings and add an entry:</p>' +
        '<div class="kv"><span>Chrome</span><code>chrome://settings/searchEngines</code><span>Brave</span><code>brave://settings/searchEngines</code><span>Edge</span><code>edge://settings/searchEngines</code></div>' +
        '<div class="kv"><span>Name</span><code>Go Links</code><span>Shortcut</span><code>go</code><span>URL</span><code id="goUrl">' + esc(goUrl) + '</code> <button class="btn sm" id="copyGo">Copy URL</button></div>' +
        '<p class="small muted">Then type <code>go</code>, Space, and a keyword such as <code>go expenses</code> or <code>go jira PROJ-123</code>. Safari has no site search; use the menu bar search there.</p>') +
      step('bookmarklet', 'Bookmarklet: save any page with a screenshot', '<p>Drag this button to your bookmarks bar: <a class="btn" href="' + esc(bm.href) + '" onclick="return false">Add to Links</a> <button class="btn sm ghost" id="copyBm">Copy code</button></p><p class="small muted">Click it on any page, including SSO pages. A popup shows the screenshot of the page and suggested tags; Cmd+Enter saves.</p>') +
      step('permissions', 'Allow screenshots of your browser', '<p>macOS must let the service (the <code>node</code> process) read browser tabs and capture the screen. Automation is asked for automatically on first use. Screen Recording has to be enabled by hand:</p>' +
        '<ol class="small"><li>System Settings > Privacy & Security > Screen & System Audio Recording.</li><li>Enable <code>node</code>. If it is missing, press <b>+</b>, then Cmd+Shift+G and paste: <code id="execPath">' + esc(health.execPath) + '</code> <button class="btn sm" id="copyExec">Copy path</button></li><li>Run <code>bin/golinks restart</code>, then Re-check below.</li></ol>' +
        '<div id="setupDoctor"></div><div class="actions"><button class="btn sm" id="setupDoctorRun">Re-check</button></div>') +
      step('menubar', 'Menu bar and hotkeys', '<p>The menu bar icon (link symbol) gives you search, add current tab, open, start and stop. It is installed by <code>bin/golinks install</code>; run <code>bin/golinks menubar install</code> if it is missing.</p><p class="small muted">For global hotkeys (Ctrl+Option+L search, Ctrl+Option+A add) build or import the two Shortcuts described in <code>shortcuts/README.md</code>.</p>') +
      step('import', 'Import your bookmarks', '<p>Bring in Chrome, Brave or Edge bookmarks with a preview and duplicate detection: <a href="#/import" class="btn sm">Open Import</a></p>'));
    $('#copyGo').onclick = () => copy(goUrl, 'go URL copied');
    $('#copyBm').onclick = () => copy(bm.href, 'Bookmarklet code copied');
    $('#copyExec').onclick = () => copy(health.execPath, 'Path copied');
    $$('[data-toggle]').forEach((b) => (b.onclick = async () => { await markSetup(b.dataset.toggle, !done[b.dataset.toggle]); renderSetupPage(); }));
    const dEl = $('#setupDoctor');
    const runDoc = async () => {
      const d = await renderDoctor(dEl);
      if (d) {
        const perms = d.checks.filter((c) => c.id === 'automation' || c.id === 'screen');
        const ok = perms.length && perms.every((c) => c.ok === true);
        if (ok && !done.permissions) { await markSetup('permissions', true); renderSetupPage(); }
      }
    };
    $('#setupDoctorRun').onclick = runDoc;
    runDoc();
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    const qs = new URLSearchParams(location.search);
    if (qs.has('q')) {
      $('#q').value = qs.get('q');
      history.replaceState(null, '', '/' + (location.hash || '#/'));
    }
    await loadMeta();
    if (state.meta && state.meta.counts.all === 0 && !(state.meta.settings.setup && state.meta.settings.setup.seen) && !location.hash) {
      location.hash = '#/setup';
      markSetup('seen', true);
    }
    window.addEventListener('hashchange', onRoute);
    await onRoute();
    if (state.route.page === 'links') $('#q').focus();
    // keep counts and pending snapshots fresh
    setInterval(async () => {
      if (document.hidden) return;
      const before = state.meta && state.meta.pendingSnapshots.length;
      await loadMeta();
      if (state.meta && (before !== state.meta.pendingSnapshots.length)) { renderSidebar(); if (state.route.page === 'links' && !state.editing) doSearch(); }
    }, 5000);
  }
  boot();
})();
