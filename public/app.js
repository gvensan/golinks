/* Golinks web UI. Vanilla JS, no build step. */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    route: { page: 'links', tag: null, folder: null, view: null, linkId: null },
    q: '',
    layout: 'list',
    results: [],
    total: 0,
    terms: [],
    selected: 0,
    meta: null,
    editing: null,
    showAllTags: false,
    tagFilter: '',
    folderFilter: '',
    expanded: new Set(),
    collapsed: new Set(), // sidebar sections folded away: 'tags', 'folders'
    sideWidth: null, // px chosen by dragging the divider; null means size to content
    lastFolder: null, // folder most recently browsed; prefills the Add page
    down: false,
  };
  const TOP_TAGS = 12;
  try { state.layout = localStorage.getItem('links.layout') || 'list'; } catch { /* ignore */ }
  try { state.expanded = new Set(JSON.parse(localStorage.getItem('links.folders.open') || '[]')); } catch { /* ignore */ }
  try { state.collapsed = new Set(JSON.parse(localStorage.getItem('links.side.collapsed') || '[]')); } catch { /* ignore */ }
  try { const w = Number(localStorage.getItem('links.side.width')); if (w) state.sideWidth = w; } catch { /* ignore */ }
  function saveExpanded() { try { localStorage.setItem('links.folders.open', JSON.stringify([...state.expanded])); } catch { /* ignore */ } }
  function saveCollapsed() { try { localStorage.setItem('links.side.collapsed', JSON.stringify([...state.collapsed])); } catch { /* ignore */ } }

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
    try { await navigator.clipboard.writeText(text); toast(msg || 'Copied'); return true; } catch { /* fall through */ }
    // Fallback when the async clipboard is unavailable (no focus, older browser): select and copy.
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      toast(ok ? (msg || 'Copied') : 'Copy failed, select the text and press Cmd+C', ok ? 2200 : 4000);
      return ok;
    } catch { toast('Copy failed, select the text and press Cmd+C', 4000); return false; }
  }

  // In-app modal replacing the browser's prompt/confirm. Resolves with the entered text
  // (or true for a plain confirm) and null when cancelled. opts: { title, message, value,
  // placeholder, help, ok, danger, list (datalist values), input (false for confirm only) }.
  function dialog(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const withInput = opts.input !== false;
      const withCheck = Boolean(opts.checkbox);
      const el = document.createElement('div');
      el.id = 'modal';
      el.innerHTML = '<div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="modalTitle">' +
        '<h3 id="modalTitle">' + esc(opts.title || '') + '</h3>' +
        (opts.message ? '<p class="modal-msg">' + opts.message + '</p>' : '') +
        (withInput ? '<div class="field"><input type="text" id="modalInput" value="' + esc(opts.value || '') + '" placeholder="' + esc(opts.placeholder || '') + '" autocomplete="off" spellcheck="false"' + (opts.list ? ' list="modalList"' : '') + '>' +
          (opts.list ? '<datalist id="modalList">' + opts.list.map((v) => '<option value="' + esc(v) + '">').join('') + '</datalist>' : '') +
          (opts.help ? '<div class="help">' + opts.help + '</div>' : '') + '</div>' : '') +
        (withCheck ? '<label class="modal-check"><input type="checkbox" id="modalCheck"' + (opts.checked ? ' checked' : '') + '> ' + opts.checkbox + '</label>' : '') +
        '<div class="actions modal-actions"><button class="btn" id="modalCancel">Cancel</button><button class="btn ' + (opts.danger ? 'danger' : 'primary') + '" id="modalOk">' + esc(opts.ok || 'OK') + '</button></div></div>';
      document.body.appendChild(el);
      const input = $('#modalInput', el);
      const done = (value) => {
        el.remove();
        if (prev && prev.focus && document.body.contains(prev)) prev.focus();
        resolve(value);
      };
      const check = $('#modalCheck', el);
      const ok = () => {
        if (!withInput) return done(withCheck ? { ok: true, checked: check.checked } : true);
        const v = input.value.trim();
        const bad = !v || (opts.validate && opts.validate(v));
        if (bad) { input.focus(); input.classList.add('invalid'); if (typeof bad === 'string') toast(bad, 2500); return; }
        done(withCheck ? { value: v, checked: check.checked } : v);
      };
      $('#modalOk', el).onclick = ok;
      $('#modalCancel', el).onclick = () => done(null);
      el.addEventListener('mousedown', (e) => { if (e.target === el) done(null); });
      // Keys stay inside the dialog so the app shortcuts (Esc closes drawer, E edits) do not fire.
      el.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
        else if (e.key === 'Enter' && !(e.target.tagName === 'BUTTON' && e.target.id === 'modalCancel')) { e.preventDefault(); ok(); }
      });
      if (input) input.addEventListener('input', () => input.classList.remove('invalid'));
      requestAnimationFrame(() => { el.classList.add('show'); const f = input || $('#modalOk', el); f.focus(); if (input) input.select(); });
    });
  }

  function lbl(text, tipKey) {
    return '<label>' + text + (tipKey ? '<span class="info" tabindex="0" data-tip="' + esc(TIPS[tipKey]) + '">i</span>' : '') + '</label>';
  }
  const TIPS = {"title": "Name shown in lists and matched first by search. Defaults to the page title.", "url": "The address this link opens. Fixed once saved; duplicates are detected on it.", "tags": "Short labels for filtering (click a tag in the sidebar) and search (tag:name). Rules add some automatically. Type a tag and press Enter or comma.", "keyword": "Unique short name for the Chrome address bar: type \":go name\" to open this link instantly. Letters, digits, dots and dashes.", "folder": "Optional folder this link lives in. Use / for nesting, for example Work/Projects. Typing a new path creates the folder. The folder view lists links in it and its subfolders and can open or copy them all at once.", "aliases": "Other names search should match, comma separated. Initials work too: \"ep\" finds an alias \"event portal\".", "description": "Longer summary, searched with lower weight than the title. Filled from the page when it is public.", "notes": "Your own notes, searched. The bookmarklet puts the text you had selected on the page here.", "snapshot": "Where the thumbnail comes from. From browser tab screenshots your own browser window (works for SSO pages). Auto refresh tries the page preview image, then headless Chrome for public pages, then a tile.", "snapshotmode": "How the thumbnail is produced after saving. Auto tries the page preview image, then headless Chrome for public pages, then a tile. If the page is open in a browser tab on this Space, a screenshot of it is used instead."};

  // One line of description (or the first line of notes) for lists; CSS adds the ellipsis.
  function blurb(link) {
    const src = String(link.description || '').trim() || String(link.notes || '').trim();
    if (!src) return '';
    return src.split(/\r?\n/).find((l) => l.trim()) || '';
  }

  function snapshotUrl(link) {
    return link.snapshot ? '/' + link.snapshot + '?v=' + encodeURIComponent(link.snapshotAt || '') : '';
  }

  function tileHtml(link, cls) {
    const h = hue(host(link.url));
    const letter = (host(link.url)[0] || '?').toUpperCase();
    return '<div class="' + cls + '" style="background:linear-gradient(135deg,hsl(' + h + ' 55% 26%),hsl(' + ((h + 40) % 360) + ' 50% 38%))">' + esc(letter) + '</div>';
  }

  // Folder paths for hashes and API calls: "Work/Projects" -> "Work/Projects" with only
  // the segments encoded, so the hash stays readable.
  function folderHash(path) { return '#/folder/' + path.split('/').map(encodeURIComponent).join('/'); }
  function folderSegments(path) { return path ? path.split('/') : []; }

  // ------------------------------------------------------------------ routing
  function parseHash() {
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    const r = { page: 'links', tag: null, folder: null, view: null, linkId: null };
    const [head, ...rest] = h.split('/');
    const val = rest.join('/');
    if (head === 'tag' && val) r.tag = val;
    else if ((head === 'folder' || head === 'col') && val) r.folder = val.replace(/^\/+|\/+$/g, '');
    else if (head === 'view' && val) r.view = val;
    else if (head === 'link' && val) r.linkId = val;
    else if (head === 'add') r.page = 'add';
    else if (head === 'settings') { r.page = 'settings'; r.tab = ['general', 'setup', 'import', 'export'].includes(rest[0]) ? rest[0] : 'general'; }
    else if (head === 'setup' || head === 'import' || head === 'export') { r.page = 'settings'; r.tab = head; }
    return r;
  }

  function go(hash) {
    if (location.hash === hash) onRoute(); else location.hash = hash;
  }

  async function onRoute() {
    state.route = parseHash();
    if (state.route.folder) state.lastFolder = state.route.folder;
    if (state.route.page !== 'links' && $('#drawer').classList.contains('open')) closeDrawer();
    if (state.route.page === 'links') {
      renderLinksChrome();
      await doSearch();
      if (state.route.linkId) {
        const link = state.results.find((l) => l.id === state.route.linkId) || (await api('GET', '/api/links/' + state.route.linkId).then((r) => r.link).catch(() => null));
        if (link) openDrawer(link);
      }
    } else if (state.route.page === 'add') renderAddPage();
    else if (state.route.page === 'settings') renderSettingsPage(state.route.tab);
    renderSidebar();
    $('#fab').classList.toggle('hidden', state.route.page === 'add');
  }

  // ------------------------------------------------------------------ sidebar
  async function loadMeta() {
    try { state.meta = await api('GET', '/api/meta'); } catch { /* banner shown */ }
    return state.meta;
  }

  // Sidebar icons: 16px line icons on a 16-unit grid, stroke follows the text colour.
  const svg = (paths, extra) => '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"' + (extra || '') + '>' + paths + '</svg>';
  const NAV_ICONS = {
    all: svg('<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>'),
    recent: svg('<circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8l2.25 1.5"/>'),
    mostused: svg('<path d="M8 2.3l1.8 3.7 4 .55-2.9 2.8.7 4L8 11.4l-3.6 1.95.7-4-2.9-2.8 4-.55z"/>'),
    keywords: svg('<path d="M2.5 8h10M9 4.5 12.5 8 9 11.5"/>'),
    untagged: svg('<path d="M8.6 2.5H3.3a.8.8 0 0 0-.8.8v5.3c0 .21.08.42.23.57l5.1 5.1a.8.8 0 0 0 1.13 0l4.54-4.54a.8.8 0 0 0 0-1.13l-5.1-5.1a.8.8 0 0 0-.57-.23z" stroke-dasharray="2.2 1.6"/><circle cx="5.6" cy="5.6" r=".9" fill="currentColor" stroke="none"/>'),
    stale: svg('<path d="M4.5 2.5h7M4.5 13.5h7M5 2.5v2.2c0 1.6 3 2.6 3 3.3s-3 1.7-3 3.3v2.2M11 2.5v2.2c0 1.6-3 2.6-3 3.3s3 1.7 3 3.3v2.2"/>'),
    unfiled: svg('<rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke-dasharray="2.2 1.6"/>'),
    setup: svg('<circle cx="8" cy="8" r="5.75"/><path d="M5.4 8.2 7.2 10l3.4-3.8"/>'),
    settings: svg('<circle cx="8" cy="8" r="2.1"/><path d="M8 1.9v1.6M8 12.5v1.6M1.9 8h1.6M12.5 8h1.6M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M3.7 12.3l1.1-1.1M11.2 4.8l1.1-1.1"/>'),
    import: svg('<path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 12.5h10"/>'),
    export: svg('<path d="M8 10.5V3M4.8 6 8 2.8 11.2 6M3 12.5h10"/>'),
    restart: svg('<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"/>'),
  };

  function navItem(hash, label, count, ico, active) {
    return '<a href="' + hash + '" class="' + (active ? 'active' : '') + '"><span class="ico">' + (ico || '') + '</span><span class="label">' + esc(label) + '</span>' + (count != null ? '<span class="n">' + count + '</span>' : '') + '</a>';
  }

  // Folder and chevron icons come from folderpick.js so the sidebar and the picker match.
  const FOLDER_ICO = window.FOLDER_ICONS.closed;
  const FOLDER_OPEN_ICO = window.FOLDER_ICONS.open;
  const CHEV_RIGHT = window.FOLDER_ICONS.chevRight;
  const CHEV_DOWN = window.FOLDER_ICONS.chevDown;

  function renderSidebar() {
    const m = state.meta;
    const r = state.route;
    const isLinks = r.page === 'links';
    const c = m ? m.counts : {};
    let html = '<div class="brand"><img src="/favicon.svg" alt=""> Golinks <span class="ver">' + (m ? 'v' + esc(m.version) : '') + '</span></div>';
    html += '<div class="nav">';
    html += navItem('#/', 'All links', c.all, NAV_ICONS.all, isLinks && !r.tag && !r.folder && !r.view);
    html += navItem('#/view/recent', 'Recent', c.recent, NAV_ICONS.recent, r.view === 'recent');
    html += navItem('#/view/mostused', 'Most used', c.mostused, NAV_ICONS.mostused, r.view === 'mostused');
    html += navItem('#/view/keywords', 'Go keywords', c.keywords, NAV_ICONS.keywords, r.view === 'keywords');
    html += navItem('#/view/untagged', 'Untagged', c.untagged, NAV_ICONS.untagged, r.view === 'untagged');
    html += navItem('#/view/stale', 'Stale', c.stale, NAV_ICONS.stale, r.view === 'stale');
    html += '</div>';

    // Section header: the caret and title fold the section; the buttons after it are actions.
    const section = (key, title, count, actions) => {
      const open = !state.collapsed.has(key);
      return '<h4 class="sec' + (open ? ' open' : '') + '"><button class="sec-toggle" data-sec="' + key + '" title="' + (open ? 'Collapse' : 'Expand') + ' ' + title.toLowerCase() + '" aria-expanded="' + open + '"><span class="car">' + (open ? '&#9662;' : '&#9656;') + '</span>' + title + (count && !open ? '<span class="cnt">' + count + '</span>' : '') + '</button><span class="sec-acts">' + (open ? actions : '') + '</span></h4>';
    };
    const tagCount = m ? m.tags.length : 0;
    html += section('tags', 'Tags', tagCount, tagCount > TOP_TAGS ? '<button id="toggleTags">' + (state.showAllTags ? 'top ' + TOP_TAGS : 'all ' + tagCount) + '</button>' : '');
    if (!state.collapsed.has('tags')) {
      if (tagCount) {
        if (tagCount > 6) html += '<div class="side-filter"><input type="text" id="tagFilter" placeholder="Filter tags" value="' + esc(state.tagFilter) + '" autocomplete="off" spellcheck="false"></div>';
        html += '<div class="badges" id="tagList"></div>';
      } else html += '<div class="side-note">No tags yet. Tags come from rules and from you.</div>';
    }

    const folderCount = m ? m.folders.length : 0;
    const anyOpen = m && m.folders.some((f) => state.expanded.has(f.path.toLowerCase()));
    const anyParent = m && m.folders.some((f) => f.depth > 0);
    html += section('folders', 'Folders', folderCount,
      (anyParent ? '<button id="treeAll" title="' + (anyOpen ? 'Collapse every folder' : 'Expand every folder') + '">' + (anyOpen ? 'collapse all' : 'expand all') + '</button>' : '') +
      '<button id="newFolder" title="New folder">+ new</button>');
    if (!state.collapsed.has('folders')) {
      if (folderCount) {
        if (folderCount > 6) html += '<div class="side-filter"><input type="text" id="folderFilter" placeholder="Filter folders" value="' + esc(state.folderFilter) + '" autocomplete="off" spellcheck="false"></div>';
        html += '<div class="tree nav" id="folderTree"></div>';
      } else html += '<div class="side-note">No folders yet. Create one here or type a folder like <code>Work/Projects</code> when editing a link.</div>';
      if (c.unfiled != null && folderCount) html += '<div class="nav">' + navItem('#/view/unfiled', 'Unfiled', c.unfiled, NAV_ICONS.unfiled, r.view === 'unfiled').replace('<a ', '<a data-drop-folder="" ') + '</div>';
    }

    html += '<div class="spacer"></div><div class="nav foot">';
    if (m && m.restartNeeded) html += '<a href="#/settings" class="restart-note" title="The code on disk is newer than the running service">' + NAV_ICONS.restart + ' restart needed</a>';
    if (m && m.pendingSnapshots.length) html += '<div class="side-progress" title="Snapshots are captured one at a time in the background"><span class="spin"></span> capturing ' + m.pendingSnapshots.length + ' snapshot' + (m.pendingSnapshots.length === 1 ? '' : 's') + '</div>';
    if (m && m.browserBatch && m.browserBatch.running) html += '<a href="#/settings" class="side-progress" title="Your browser is opening each page to take its screenshot. Stop it from Settings."><span class="spin"></span> browser capture ' + m.browserBatch.done + '/' + m.browserBatch.total + '</a>';
    // The checklist entry disappears once the required steps are done; it stays reachable in Settings.
    if (!m || !m.setupComplete) html += navItem('#/settings/setup', 'Setup checklist', null, NAV_ICONS.setup, r.page === 'settings' && r.tab === 'setup');
    html += navItem('#/settings', 'Settings', null, NAV_ICONS.settings, r.page === 'settings' && r.tab !== 'setup');
    html += '</div>';
    $('#side').innerHTML = html;
    renderTagList();
    renderFolderTree();
    applySideWidth();

    $$('[data-sec]').forEach((b) => (b.onclick = () => {
      const k = b.dataset.sec;
      if (state.collapsed.has(k)) state.collapsed.delete(k); else state.collapsed.add(k);
      saveCollapsed();
      renderSidebar();
    }));
    const ta = $('#treeAll');
    if (ta) ta.onclick = () => {
      if (anyOpen) state.expanded.clear();
      else for (const f of m.folders) state.expanded.add(f.path.toLowerCase());
      saveExpanded();
      renderSidebar();
    };

    const tt = $('#toggleTags');
    if (tt) tt.onclick = () => { state.showAllTags = !state.showAllTags; state.tagFilter = ''; renderSidebar(); };
    const tf = $('#tagFilter');
    if (tf) tf.oninput = () => { state.tagFilter = tf.value; renderTagList(); };
    const ff = $('#folderFilter');
    if (ff) ff.oninput = () => { state.folderFilter = ff.value; renderFolderTree(); applySideWidth(); };
    [tf, ff].forEach((el) => el && el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { el.value = ''; el.oninput(); el.blur(); }
      if (e.key === 'Enter') { const first = $(el === tf ? '#tagList a' : '#folderTree a'); if (first) go(first.getAttribute('href')); }
    }));
    const nf = $('#newFolder');
    if (nf) nf.onclick = () => createFolder(state.route.folder ? state.route.folder + '/' : '');
  }

  // ---- sidebar width: sized to the widest visible folder row unless the user dragged the divider
  const SIDE_MIN = 280, SIDE_MAX = 600, SIDE_DRAG_MIN = 200;
  function measureSide() {
    let need = SIDE_MIN;
    for (const a of $$('#folderTree a')) {
      const label = $('.label', a), n = $('.n', a);
      if (!label) continue;
      // twisty + icon + label + gaps + count + row padding + sidebar padding, plus slack so the
      // bold active label never gets an ellipsis
      const w = (parseFloat(a.style.paddingLeft) || 0) + 16 + 17 + label.scrollWidth + 12 + (n ? n.offsetWidth : 0) + 8 + 20 + 24;
      if (w > need) need = w;
    }
    return Math.round(Math.min(need, SIDE_MAX, window.innerWidth * 0.45));
  }
  function setSideWidth(px) {
    document.documentElement.style.setProperty('--side-w', px + 'px');
  }
  function applySideWidth() {
    setSideWidth(state.sideWidth || measureSide());
  }
  (function initResizer() {
    const rz = $('#sideResizer');
    if (!rz) return;
    let startX = 0, startW = 0;
    const onMove = (e) => {
      const w = Math.max(SIDE_DRAG_MIN, Math.min(SIDE_MAX, startW + (e.clientX - startX)));
      state.sideWidth = w;
      setSideWidth(w);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing');
      rz.classList.remove('dragging');
      try { localStorage.setItem('links.side.width', String(state.sideWidth)); } catch { /* ignore */ }
    };
    rz.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = $('#side').getBoundingClientRect().width;
      document.body.classList.add('resizing');
      rz.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    // Double-click goes back to sizing by content.
    rz.addEventListener('dblclick', () => {
      state.sideWidth = null;
      try { localStorage.removeItem('links.side.width'); } catch { /* ignore */ }
      applySideWidth();
      toast('Sidebar width follows the content again');
    });
    window.addEventListener('resize', () => { if (!state.sideWidth) applySideWidth(); });
  })();

  // Top tags as badges; the filter box searches all of them.
  function renderTagList() {
    const el = $('#tagList');
    if (!el || !state.meta) return;
    const f = state.tagFilter.trim().toLowerCase();
    const all = state.meta.tags;
    const list = f ? all.filter((t) => t.name.includes(f)) : state.showAllTags ? all : all.slice(0, TOP_TAGS);
    el.innerHTML = list.map((t) => '<a href="#/tag/' + encodeURIComponent(t.name) + '" class="tag-badge' + (state.route.tag === t.name ? ' active' : '') + '" title="' + t.count + ' link' + (t.count === 1 ? '' : 's') + '">' + (f ? hl(t.name, [f]) : esc(t.name)) + '<span class="n">' + t.count + '</span></a>').join('') +
      (f && !list.length ? '<span class="side-note">No tag matches "' + esc(state.tagFilter) + '"</span>' : '') +
      (!f && !state.showAllTags && all.length > TOP_TAGS ? '<button class="tag-badge more" id="moreTags">+' + (all.length - TOP_TAGS) + ' more</button>' : '');
    const more = $('#moreTags');
    if (more) more.onclick = () => { state.showAllTags = true; renderSidebar(); };
  }

  // Folder tree. Nodes stay collapsed unless opened, an ancestor of the current folder,
  // or matched by the filter (which also reveals their ancestors).
  function renderFolderTree() {
    const el = $('#folderTree');
    if (!el || !state.meta) return;
    const f = state.folderFilter.trim().toLowerCase();
    const active = (state.route.folder || '').toLowerCase();
    const byParent = new Map();
    for (const n of state.meta.folders) {
      const key = (n.parent || '').toLowerCase();
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(n);
    }
    const matches = (n) => !f || n.name.toLowerCase().includes(f);
    const anyMatch = (n) => matches(n) || (byParent.get(n.path.toLowerCase()) || []).some(anyMatch);
    const render = (nodes) => nodes.filter(anyMatch).map((n) => {
      const key = n.path.toLowerCase();
      const kids = byParent.get(key) || [];
      const isActive = active === key;
      const open = kids.length && (f ? kids.some(anyMatch) : state.expanded.has(key) || active.startsWith(key + '/'));
      return '<div class="tnode">' +
        '<a href="' + folderHash(n.path) + '" class="' + (isActive ? 'active' : '') + '" style="padding-left:' + (6 + n.depth * 14) + 'px" title="' + esc(n.path) + '" data-drop-folder="' + esc(n.path) + '" data-drag-folder="' + esc(n.path) + '" draggable="true">' +
        (kids.length ? '<button class="tw" data-tw="' + esc(n.path) + '" title="' + (open ? 'Collapse' : 'Expand') + '" aria-expanded="' + Boolean(open) + '">' + (open ? CHEV_DOWN : CHEV_RIGHT) + '</button>' : '<span class="tw"></span>') +
        (open ? FOLDER_OPEN_ICO : FOLDER_ICO) + '<span class="label">' + (f ? hl(n.name, [f]) : esc(n.name)) + '</span><span class="n" title="' + n.count + ' here, ' + n.total + ' including subfolders">' + n.total + '</span></a>' +
        (open ? render(kids) : '') + '</div>';
    }).join('');
    const html = render(byParent.get('') || []);
    el.innerHTML = '<div class="drop-root" data-drop-root="1">' + NAV_ICONS.unfiled + ' Top level</div>' + (html || '<span class="side-note">No folder matches "' + esc(state.folderFilter) + '"</span>');
    $$('[data-tw]', el).forEach((b) => (b.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const key = b.dataset.tw.toLowerCase();
      if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
      saveExpanded();
      renderSidebar();
    }));
  }

  async function createFolder(prefill) {
    const path = await dialog({ title: 'New folder', value: prefill || '', placeholder: 'Work/Projects', ok: 'Create', list: state.meta ? state.meta.folders.map((f) => f.path) : [], help: 'Use <code>/</code> for nesting, for example <code>Work/Projects</code>. Missing parents are created too.' });
    if (path == null) return;
    try {
      const r = await api('POST', '/api/folders', { path });
      toast(r.existed ? 'Folder already exists' : 'Folder created');
      await loadMeta();
      for (let i = 1; i < folderSegments(r.folder.path).length; i++) state.expanded.add(folderSegments(r.folder.path).slice(0, i).join('/').toLowerCase());
      saveExpanded();
      go(folderHash(r.folder.path));
    } catch (err) { toast(err.message, 4000); }
  }

  async function renameFolder(from) {
    const to = await dialog({ title: 'Rename or move folder', message: 'Current path: <code>' + esc(from) + '</code>', value: from, ok: 'Move', list: state.meta ? state.meta.folders.map((f) => f.path).filter((p) => p !== from) : [], help: 'Give the full new path. A different parent moves the folder, for example <code>Archive/' + esc(folderSegments(from).pop()) + '</code>. Links inside and subfolders follow.' });
    if (to == null || to === from) return;
    try {
      const r = await api('POST', '/api/folders/rename', { from, to });
      toast('Moved ' + r.changed + ' link' + (r.changed === 1 ? '' : 's') + ' to ' + r.to);
      await loadMeta();
      go(folderHash(r.to));
    } catch (err) { toast(err.message, 4000); }
  }

  async function deleteFolder(button, path) {
    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      button.textContent = 'Confirm: links move up';
      clearTimeout(button._disarm);
      button._disarm = setTimeout(() => { button.classList.remove('armed'); button.textContent = 'Delete folder'; }, 4000);
      return;
    }
    try {
      const r = await api('POST', '/api/folders/delete', { path, links: 'parent' });
      toast('Folder deleted, ' + r.moved + ' link' + (r.moved === 1 ? '' : 's') + (r.parent ? ' moved to ' + r.parent : ' unfiled'));
      await loadMeta();
      go(r.parent ? folderHash(r.parent) : '#/');
    } catch (err) { toast(err.message, 4000); }
  }

  // ------------------------------------------------------------------ links view
  function renderLinksChrome() {
    $('.top').classList.remove('hidden');
    const r = state.route;
    document.title = (r.tag ? '#' + r.tag : r.folder ? r.folder : r.view ? r.view : 'Golinks') + (r.tag || r.folder || r.view ? ' | Golinks' : '');
  }

  function renderToolbar() {
    const r = state.route;
    if (r.page !== 'links') { $('#toolbar').innerHTML = ''; return; }
    let html = '<span>' + state.total + ' link' + (state.total === 1 ? '' : 's') + '</span>';
    if (r.tag) html += '<span class="chip filter">tag: ' + esc(r.tag) + ' <button data-clear title="clear">&times;</button></span>';
    if (r.folder) {
      const segs = folderSegments(r.folder);
      html += '<span class="chip filter crumbs">' + FOLDER_ICO + segs.map((seg, i) => '<a href="' + folderHash(segs.slice(0, i + 1).join('/')) + '"' + (i === segs.length - 1 ? ' class="cur"' : '') + '>' + esc(seg) + '</a>').join('<span class="sep">/</span>') + ' <button data-clear title="clear">&times;</button></span>';
    }
    if (r.view) html += '<span class="chip filter">' + esc(r.view) + ' <button data-clear title="clear">&times;</button></span>';
    if (r.folder && state.results.length) html += '<button class="btn sm" id="openAll">Open all</button><button class="btn sm" id="copyAll">Copy all URLs</button>';
    if (r.folder) html += '<button class="btn sm ghost" id="subFolder" title="Create a folder inside this one">Subfolder</button><button class="btn sm ghost" id="renameFolder" title="Rename or move this folder">Rename</button><button class="btn sm ghost danger" id="deleteFolder" title="Delete this folder and its subfolders; links move to the parent">Delete folder</button>';
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
    const sf = $('#subFolder');
    if (sf) sf.onclick = () => createFolder(r.folder + '/');
    const rf = $('#renameFolder');
    if (rf) rf.onclick = () => renameFolder(r.folder);
    const df = $('#deleteFolder');
    if (df) df.onclick = () => deleteFolder(df, r.folder);
    const rt = $('#renameTag');
    if (rt) rt.onclick = async () => {
      const to = await dialog({ title: 'Rename tag', message: 'Renames <code>' + esc(r.tag) + '</code> on every link that has it.', value: r.tag, ok: 'Rename', list: state.meta ? state.meta.tags.map((t) => t.name).filter((t) => t !== r.tag) : [], help: 'Lower-case letters, digits, dots and dashes. Choosing an existing tag merges into it.' });
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
    if (r.folder) params.set('folder', r.folder);
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
      const r = state.route;
      c.innerHTML = '<div class="empty"><b>' + (state.q ? 'No matches for "' + esc(state.q) + '"' : r.folder ? 'Empty folder' : 'Nothing here yet') + '</b>' +
        (state.q ? 'Try fewer words, or operators like <code>tag:jira</code>, <code>in:work</code>, <code>site:atlassian</code>, <code>unused:90d</code>.'
          : r.folder ? 'Move links here from their edit drawer (Folder field), or <a href="#/add">add a link</a> and set its folder to <code>' + esc(r.folder) + '</code>.'
          : 'Add a link with the Shortcut, the bookmarklet, or <a href="#/add">Add link</a>. Or <a href="#/settings/import">import</a> your bookmarks.') +
        '</div>';
      return;
    }
    const terms = state.terms;
    if (state.layout === 'grid') {
      c.innerHTML = '<div class="grid">' + state.results.map((l, i) => {
        const shot = l.snapshot ? '<img src="' + esc(snapshotUrl(l)) + '" alt="" loading="lazy" draggable="false">' : tileHtml(l, 'none');
        return '<div class="card' + (i === state.selected ? ' selected' : '') + '" data-i="' + i + '" data-id="' + esc(l.id) + '" draggable="true">' +
          '<div class="shot">' + shot + (l.snapshotPending ? '<span class="pend spin"></span>' : '') + (l.snapshotStale ? '<span class="pend badge warn">old snapshot</span>' : '') + '</div>' +
          '<div class="body"><div class="title" title="' + esc(l.title) + '">' + hl(l.title, terms) + '</div>' +
          (blurb(l) ? '<div class="desc" title="' + esc(blurb(l)) + '">' + hl(blurb(l), terms) + '</div>' : '') +
          '<div class="host">' + (l.keyword ? '<span class="chip kw">go ' + esc(l.keyword) + '</span>' : '') + '<span class="h" title="' + esc(l.url) + '">' + esc(host(l.url)) + '</span></div>' +
          (l.folder ? '<div class="host folder"><a class="fpath" href="' + folderHash(l.folder) + '" title="' + esc(l.folder) + '">' + FOLDER_ICO + '<span class="fl">' + esc(folderSegments(l.folder).join(' / ')) + '</span></a></div>' : '') +
          (l.tags.length ? '<div class="tags">' + l.tags.map((t) => '<span class="chip">' + hl(t, terms) + '</span>').join('') + '</div>' : '') +
          '<div class="meta"><span>' + (l.lastUsed ? 'used ' + rel(l.lastUsed) : 'added ' + rel(l.created)) + '</span><span>' + (l.useCount ? l.useCount + ' open' + (l.useCount === 1 ? '' : 's') : '') + (l.stale ? ' <span class="badge warn">stale</span>' : '') + '</span></div>' +
          '<div class="acts"><button class="btn sm" data-edit title="Edit (E)">Edit</button><button class="btn sm ghost" data-copy title="Copy URL (C)">Copy</button><button class="btn sm ghost danger" data-del title="Delete (click twice)">Delete</button></div>' +
          '</div></div>';
      }).join('') + '</div>';
    } else {
      c.innerHTML = '<div class="list">' + state.results.map((l, i) => {
        const shot = l.snapshot ? '<img class="thumb" src="' + esc(snapshotUrl(l)) + '" alt="" loading="lazy" draggable="false">' : tileHtml(l, 'thumb none');
        return '<div class="row' + (i === state.selected ? ' selected' : '') + '" data-i="' + i + '" data-id="' + esc(l.id) + '" draggable="true">' + shot +
          '<div class="main"><div class="title"><span class="t" title="' + esc(l.title) + '">' + hl(l.title, terms) + '</span>' + (l.keyword ? '<span class="chip kw">go ' + esc(l.keyword) + '</span>' : '') + (l.snapshotPending ? '<span class="spin" title="capturing snapshot"></span>' : '') + '</div>' +
          (blurb(l) ? '<div class="desc" title="' + esc(blurb(l)) + '">' + hl(blurb(l), terms) + '</div>' : '') +
          '<div class="sub"><span class="host" title="' + esc(l.url) + '">' + esc(host(l.url)) + '</span>' + (l.folder ? '<span class="sep"></span><a class="fpath" href="' + folderHash(l.folder) + '" title="' + esc(l.folder) + '">' + FOLDER_ICO + '<span class="fl">' + esc(l.folder) + '</span></a>' : '') +
          (l.tags.length ? '<span class="sep"></span><span class="tags">' + l.tags.map((t) => '<span class="chip">' + hl(t, terms) + '</span>').join('') + '</span>' : '') + '</div></div>' +
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
    if (e.target.closest('a.fpath')) return; // folder breadcrumb: let the hash change
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

  // ------------------------------------------------------------------ drag a link onto a folder
  // Rows and cards are draggable; folder rows in the sidebar (and Unfiled) accept the drop.
  // The move is confirmed in the in-app dialog before anything is saved.
  let dragId = null;
  let hoverTimer = null;
  $('#content').addEventListener('dragstart', (e) => {
    const item = e.target.closest('.row, .card');
    if (!item) { e.preventDefault(); return; }
    dragId = item.dataset.id;
    const link = state.results.find((l) => l.id === dragId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', link ? link.url : dragId);
    e.dataTransfer.setData('application/x-golinks-id', dragId);
    setTimeout(() => { if (dragId) { item.classList.add('dragging'); document.body.classList.add('dragging-link'); } }, 0);
    preview.style.display = 'none';
    // A compact ghost instead of the whole row or card, so the sidebar stays visible while dragging.
    if (e.dataTransfer.setDragImage && link) {
      const ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.innerHTML = (link.snapshot ? '<img src="' + esc(snapshotUrl(link)) + '" alt="">' : tileHtml(link, 'tile')) + '<span>' + esc(link.title) + '</span>';
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 18, 18);
      setTimeout(() => ghost.remove(), 0);
    }
  });
  $('#content').addEventListener('dragend', (e) => {
    const item = e.target.closest('.row, .card');
    if (item) item.classList.remove('dragging');
    document.body.classList.remove('dragging-link');
    $$('#side .drop').forEach((el) => el.classList.remove('drop'));
    dragId = null;
  });
  const side = $('#side');
  // ---- folders can be dragged onto other folders (or "Top level") to move them
  let dragFolder = null;
  side.addEventListener('dragstart', (e) => {
    const a = e.target.closest('[data-drag-folder]');
    if (!a) return;
    dragFolder = a.dataset.dragFolder;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragFolder);
    e.dataTransfer.setData('application/x-golinks-folder', dragFolder);
    // Chrome cancels a drag when the source moves out from under the pointer during
    // dragstart, so anything that changes layout (the Top level zone, dimming) waits a tick.
    setTimeout(() => { if (dragFolder) { document.body.classList.add('dragging-folder'); a.classList.add('dragging'); } }, 0);
    if (e.dataTransfer.setDragImage) {
      const ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.innerHTML = FOLDER_ICO + '<span>' + esc(folderSegments(dragFolder).pop()) + '</span>';
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 14, 14);
      setTimeout(() => ghost.remove(), 0);
    }
  });
  side.addEventListener('dragend', () => {
    dragFolder = null;
    document.body.classList.remove('dragging-folder');
    $$('#side .dragging, #side .drop').forEach((el) => el.classList.remove('dragging', 'drop'));
  });
  // A folder may not be dropped on itself, inside itself, or on its current parent.
  const folderDropOk = (from, toParent) => {
    const f = from.toLowerCase(), p = (toParent || '').toLowerCase();
    if (!p) return folderSegments(from).length > 1; // to top level: only if nested now
    if (p === f || p.startsWith(f + '/')) return false;
    return (folderSegments(from).slice(0, -1).join('/').toLowerCase()) !== p;
  };
  const dropTarget = (e) => e.target.closest('[data-drop-folder], [data-drop-root]');
  side.addEventListener('dragover', (e) => {
    const t = dropTarget(e);
    if (dragFolder && t) {
      const toParent = t.dataset.dropRoot ? '' : t.dataset.dropFolder;
      if (!folderDropOk(dragFolder, toParent)) { e.dataTransfer.dropEffect = 'none'; return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!t.classList.contains('drop')) { $$('#side .drop').forEach((el) => el.classList.remove('drop')); t.classList.add('drop'); }
      return;
    }
    if (!dragId || !t || t.dataset.dropRoot) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!t.classList.contains('drop')) {
      $$('#side .drop').forEach((el) => el.classList.remove('drop'));
      t.classList.add('drop');
      // hovering a collapsed folder for a moment opens it so subfolders can be reached
      clearTimeout(hoverTimer);
      const tw = t.querySelector('[data-tw]');
      if (tw && tw.title === 'Expand') hoverTimer = setTimeout(() => { state.expanded.add(t.dataset.dropFolder.toLowerCase()); saveExpanded(); renderFolderTree(); }, 650);
    }
  });
  side.addEventListener('dragleave', (e) => {
    const t = dropTarget(e);
    if (t && !t.contains(e.relatedTarget)) { t.classList.remove('drop'); clearTimeout(hoverTimer); }
  });
  side.addEventListener('drop', async (e) => {
    const t = dropTarget(e);
    if (!t) return;
    e.preventDefault();
    clearTimeout(hoverTimer);
    $$('#side .drop').forEach((el) => el.classList.remove('drop'));
    const movingFolder = e.dataTransfer.getData('application/x-golinks-folder') || dragFolder;
    if (movingFolder) {
      dragFolder = null;
      document.body.classList.remove('dragging-folder');
      const toParent = t.dataset.dropRoot ? '' : t.dataset.dropFolder;
      if (!folderDropOk(movingFolder, toParent)) return;
      const name = folderSegments(movingFolder).pop();
      const to = toParent ? toParent + '/' + name : name;
      const node = state.meta && state.meta.folders.find((f) => f.path.toLowerCase() === movingFolder.toLowerCase());
      const count = node ? node.total : 0;
      const ok = await dialog({
        input: false, ok: 'Move',
        title: (toParent ? 'Move into ' + toParent + '?' : 'Move to the top level?'),
        message: (() => {
          const hasKids = node && state.meta.folders.some((f) => f.parent && f.parent.toLowerCase() === movingFolder.toLowerCase());
          const along = [count ? count + ' link' + (count === 1 ? '' : 's') : '', hasKids ? 'its subfolders' : ''].filter(Boolean).join(' and ');
          return 'Folder <b>' + esc(name) + '</b> becomes <code>' + esc(to) + '</code>' + (along ? ', taking ' + along + ' along.' : '.');
        })(),
      });
      if (!ok) return;
      try {
        const r = await api('POST', '/api/folders/rename', { from: movingFolder, to });
        if (toParent) state.expanded.add(toParent.toLowerCase());
        saveExpanded();
        toast('Moved to ' + r.to + (r.changed ? ' with ' + r.changed + ' link' + (r.changed === 1 ? '' : 's') : ''));
        await loadMeta();
        if (state.route.folder && folderSegments(state.route.folder).join('/').toLowerCase().startsWith(movingFolder.toLowerCase())) go(folderHash(r.to + state.route.folder.slice(movingFolder.length)));
        else await refreshAll();
      } catch (err) { toast(err.message, 4000); }
      return;
    }
    if (t.dataset.dropRoot) return;
    const id = e.dataTransfer.getData('application/x-golinks-id') || dragId;
    document.body.classList.remove('dragging-link');
    dragId = null;
    const link = state.results.find((l) => l.id === id);
    if (!link) return;
    const folder = t.dataset.dropFolder || '';
    if ((link.folder || '') === folder) { toast(folder ? 'Already in ' + folder : 'Already unfiled'); return; }
    const ok = await dialog({
      input: false, ok: 'Move',
      title: folder ? 'Move to ' + folder + '?' : 'Remove from its folder?',
      message: '<b>' + esc(link.title) + '</b>' + (link.folder ? ' leaves <code>' + esc(link.folder) + '</code>' : '') + (folder ? ' and goes into <code>' + esc(folder) + '</code>.' : ' and becomes unfiled.'),
    });
    if (!ok) return;
    try {
      const r = await api('PUT', '/api/links/' + link.id, { folder });
      replaceResult(r.link);
      toast(folder ? 'Moved to ' + folder : 'Moved out of its folder');
      await refreshAll();
    } catch (err) { toast(err.message, 4000); }
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
  let drawerFolder = null;
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
      '<div class="shot-actions"><button class="btn sm primary" id="dSnapBrowser" title="Screenshot this page through your browser: uses the tab if it is open, otherwise opens it in a tab for a few seconds and closes it (works for SSO pages)">From browser tab</button>' +
      '<button class="btn sm" id="dSnapRefresh" title="Automatic: page preview image (og:image), else headless Chrome for public pages, else a tile">Auto refresh</button>' +
      '<button class="btn sm" id="dSnapTile" title="Generate a coloured tile with the site favicon">Tile</button><label class="btn sm" title="Use an image file from disk">Upload<input type="file" id="dSnapFile" accept="image/*" class="hidden"></label>' +
      (link.snapshot ? '<button class="btn sm ghost" id="dSnapRemove" title="Delete the snapshot; the list shows a letter tile">Remove</button>' : '') +
      (link.snapshotStale ? '<span class="badge warn">snapshot older than ' + (state.meta ? state.meta.settings.staleDays : 90) + ' days</span>' : '') + '</div>' +
      '<div class="field">' + lbl('Title', 'title') + '<input type="text" id="fTitle" value="' + esc(link.title) + '"></div>' +
      '<div class="field">' + lbl('URL', 'url') + '<div class="readonly-url" title="' + esc(link.url) + '">' + esc(link.url) + '</div></div>' +
      '<div class="field">' + lbl('Tags', 'tags') + '<div id="fTags"></div></div>' +
      '<div class="row2"><div class="field">' + lbl('Go keyword', 'keyword') + '<input type="text" id="fKeyword" value="' + esc(link.keyword || '') + '" placeholder="epdesign"><div class="sug hidden" id="fSugKeywords"></div><div class="help">Type <code>:go ' + esc(link.keyword || 'name') + '</code> in Chrome</div></div>' +
      '<div class="field">' + lbl('Folder', 'folder') + '<div id="fFolder"></div><div class="sug hidden" id="fSugFolders"></div><div class="help">Pick from the tree or type a new path with <code>/</code></div></div></div>' +
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
    if (drawerFolder) drawerFolder.destroy();
    drawerFolder = folderPicker($('#fFolder'), { value: link.folder || '', folders: state.meta ? state.meta.folders : [] });
    // Suggestions from the URL and from similar links, shown as chips to click
    api('GET', '/api/links/' + link.id + '/suggest').then((r) => {
      if (!state.editing || state.editing.id !== link.id || !$('#fFolder')) return;
      const items = suggestItems(r.suggest);
      drawerChips.setSuggestions(items.tags.map((t) => t.value));
      suggestChips($('#fSugFolders'), items.folders, { label: 'Suggested', onPick: (it) => drawerFolder.set(it.value) });
      suggestChips($('#fSugKeywords'), items.keywords, { label: 'Suggested', onPick: (it) => { $('#fKeyword').value = it.value; } });
    }).catch(() => { /* suggestions are optional */ });

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
    toast(body.snapshot ? 'Uploading' : body.mode === 'browser' ? 'Looking for the page in your browser; if it is not open, a tab opens for a few seconds' : 'Capturing snapshot, this can take up to 30 seconds', 4000);
    try {
      const dirty = drawerDirty(link);
      const r = await api('POST', '/api/links/' + link.id + '/snapshot', body);
      replaceResult(r.link);
      renderResults();
      // A browser capture is usually the last thing wanted from the drawer: close it, unless
      // there are unsaved edits, which would be lost.
      if (body.mode === 'browser' && !dirty) {
        closeDrawer();
        toast('Snapshot updated' + (r.app ? ' from ' + r.app : ''));
      } else if (dirty) {
        // keep the form as typed: swap only the picture and re-enable the buttons
        const shotEl = $('#drawer .shot-edit');
        if (shotEl) shotEl.innerHTML = r.link.snapshot ? '<img src="' + esc(snapshotUrl(r.link)) + '" alt="">' : '<div class="none">no snapshot</div>';
        btns.forEach((b) => (b.disabled = false));
        toast('Snapshot updated' + (r.app ? ' from ' + r.app : '') + '. Your unsaved edits are still here, press Save when done.', 4000);
      } else {
        openDrawer(r.link);
        toast('Snapshot updated' + (r.app ? ' from ' + r.app : '') + ' (' + (r.link.snapshotMethod || 'ok') + ')');
      }
    } catch (err) {
      toast('Snapshot failed: ' + err.message, 4000);
      btns.forEach((b) => (b.disabled = false));
    }
  }

  // True when a field in the drawer differs from the saved link.
  function drawerDirty(link) {
    if (!$('#fTitle')) return false;
    const list = (s) => String(s || '').split(/[,\n]+/).map((x) => x.trim()).filter(Boolean).join(',');
    return $('#fTitle').value !== (link.title || '')
      || $('#fKeyword').value.trim() !== (link.keyword || '')
      || (drawerFolder ? drawerFolder.get() : '') !== (link.folder || '')
      || list($('#fAliases').value) !== list((link.aliases || []).join(','))
      || $('#fDescription').value !== (link.description || '')
      || $('#fNotes').value !== (link.notes || '')
      || (drawerChips ? drawerChips.get().join(',') : '') !== (link.tags || []).join(',');
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
      folder: drawerFolder ? drawerFolder.get() : '',
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
    if (drawerFolder) { drawerFolder.destroy(); drawerFolder = null; }
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
      '<div class="field">' + lbl('URL', 'url') + '<input type="url" id="aUrl" placeholder="https://..." autofocus><div class="help">Paste a URL and press Enter. Public pages are fetched for title and image. SSO pages come back blank, fill the title yourself; for those, save from the bookmarklet or the add-tab Shortcut to get a real screenshot.</div></div>' +
      '<div id="aInfo"></div>' +
      '<div class="field">' + lbl('Title', 'title') + '<input type="text" id="aTitle"></div>' +
      '<div class="field">' + lbl('Tags', 'tags') + '<div id="aTags"></div></div>' +
      '<div class="row2"><div class="field">' + lbl('Go keyword', 'keyword') + '<input type="text" id="aKeyword" placeholder="optional short name"><div class="sug hidden" id="aSugKeywords"></div></div>' +
      '<div class="field">' + lbl('Folder', 'folder') + '<div id="aFolder"></div><div class="sug hidden" id="aSugFolders"></div><div class="help">Pick from the tree or type a new path with <code>/</code></div></div></div>' +
      '<div class="field">' + lbl('Aliases', 'aliases') + '<input type="text" id="aAliases" placeholder="comma separated"></div>' +
      '<div class="field">' + lbl('Description', 'description') + '<textarea id="aDescription"></textarea></div>' +
      '<div class="field">' + lbl('Notes', 'notes') + '<textarea id="aNotes"></textarea></div>' +
      '<div class="field">' + lbl('Snapshot', 'snapshotmode') + '<select id="aSnap"><option value="auto">Auto: og:image, then headless Chrome for public pages, then tile</option><option value="tile">Tile only (fast)</option><option value="none">None</option></select></div>' +
      '<div class="actions"><button class="btn primary" id="aSave">Save link <kbd>&#8984;&#8629;</kbd></button><button class="btn" id="aFetch">Fetch details again</button><span id="aStatus" class="muted small"></span></div>' +
      '</div>');
    const chips = chipEditor($('#aTags'), { all: state.meta ? state.meta.tags.map((t) => t.name) : [] });
    const folderPick = folderPicker($('#aFolder'), { value: state.lastFolder || '', folders: state.meta ? state.meta.folders : [] });
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
      const items = suggestItems(info.suggest);
      chips.setSuggestions(items.tags.map((t) => t.value));
      suggestChips($('#aSugFolders'), items.folders, { label: 'Suggested', onPick: (it) => folderPick.set(it.value) });
      if (!info.duplicate) suggestChips($('#aSugKeywords'), items.keywords, { label: 'Suggested', onPick: (it) => { $('#aKeyword').value = it.value; } });
      let msg = '';
      if (info.duplicate) msg += '<div class="alert warn">Already saved as <a href="#/link/' + esc(info.duplicate.id) + '">' + esc(info.duplicate.title) + '</a>. Saving again will be refused.</div>';
      if (info.loginDetected) msg += '<div class="alert">This page redirected to a sign-in screen, so no title or image was taken from it. Fill in the title yourself; the snapshot will be a tile until you capture one with the Shortcut.</div>';
      else if (info.error) msg += '<div class="alert">Could not fetch the page (' + esc(info.error) + '). You can still save it.</div>';
      else if (info.ogImage) msg += '<div class="alert ok">Found a preview image on the page. It will be used as the snapshot.</div>';
      $('#aInfo').innerHTML = msg;
      if (!$('#aTitle').value) $('#aTitle').focus();
      // If the page is open in a browser tab on this Space, grab a real screenshot.
      captured = null;
      try {
        const cap = await api('POST', '/api/capture', { url: urlEl.value.trim(), open: false });
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
        url: urlEl.value, title: $('#aTitle').value, tags: chips.get(), keyword: $('#aKeyword').value, folder: folderPick.get(),
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
  const FORMAT_LABELS = { chrome: 'Chrome-style Bookmarks JSON', golinks: 'Golinks JSON export', html: 'Bookmarks HTML', csv: 'CSV', xlsx: 'Excel workbook', markdown: 'Markdown', text: 'Text with URLs', file: 'file' };
  function renderImportPage() {
    tabShell(
      '<div class="card-box"><h2 style="margin-top:0">From a browser profile</h2><div class="sources" id="iSources"><span class="spin"></span></div>' +
      '<p class="help small muted">Reads the browser\'s Bookmarks file directly. Bookmark folders become folders here, nesting included, plus a tag for the innermost one. Nothing is written to the browser.</p></div>' +
      '<div class="card-box"><h2 style="margin-top:0">From a file</h2>' +
      '<div class="actions"><label class="btn primary">Choose file<input type="file" id="iFile" class="hidden" accept=".json,.html,.htm,.csv,.xlsx,.md,.txt"></label><span class="muted small">Golinks JSON, browser bookmarks HTML (exported by Chrome, Brave, Edge, Safari, Firefox), Chrome Bookmarks JSON, CSV or Excel with a header row, Markdown, or any text with URLs. The format is detected from the file.</span></div>' +
      '<div class="field" style="margin-top:14px"><label>Or paste text containing URLs</label><textarea id="iText" placeholder="Any text or Markdown. Every http(s) URL in it is extracted; [title](url) keeps the title."></textarea></div>' +
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
      const binary = /\.xlsx$/i.test(f.name);
      const content = binary
        ? await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(f); })
        : await f.text();
      loadPreview(api('POST', '/api/import/file', { name: f.name, content, encoding: binary ? 'base64' : 'text' }), 'file');
      e.target.value = '';
    };
    $('#iTextBtn').onclick = () => loadPreview(api('POST', '/api/import/text', { text: $('#iText').value }), 'text');

    async function loadPreview(promise, source) {
      $('#iPreview').innerHTML = '<div class="card-box"><span class="spin"></span> reading</div>';
      let data;
      try { data = await promise; } catch (err) { $('#iPreview').innerHTML = '<div class="alert error">' + esc(err.message) + '</div>'; return; }
      const items = data.items;
      if (data.format) source = data.format;
      const render = () => {
        const sel = items.filter((i) => i.selected).length;
        $('#iPreview').innerHTML =
          '<div class="card-box"><h2 style="margin-top:0">Preview: ' + items.length + ' links, ' + data.duplicates + ' already saved' + (data.format ? ' <span class="badge">' + esc(FORMAT_LABELS[data.format] || data.format) + (data.name ? ': ' + esc(data.name) : '') + '</span>' : '') + '</h2>' +
          (!items.length ? '<p class="muted">Nothing to import was found in this file.</p>' : '') +
          '<div class="actions"><button class="btn sm" data-sel="new">Select new</button><button class="btn sm" data-sel="all">Select all</button><button class="btn sm" data-sel="none">Select none</button>' +
          '<span class="grow" style="flex:1"></span><label class="small muted" title="Screenshots are captured in the background after the import, one link at a time. Public pages get a real capture; pages behind sign-in get a tile you can replace later from the edit drawer.">Snapshots <select id="iSnap"><option value="browser">screenshots through my browser (opens each page; works for sign-in pages)</option><option value="auto">screenshots in the background (public pages only; others get a tile)</option><option value="tile">tiles only (instant)</option><option value="none">none</option></select></label>' +
          '<button class="btn primary" id="iCommit" ' + (sel ? '' : 'disabled') + '>Import ' + sel + ' link' + (sel === 1 ? '' : 's') + '</button></div>' +
          '<div class="tbl-wrap"><table class="tbl"><thead><tr><th></th><th>Title</th><th>URL</th><th>Folder</th><th>Tags</th><th></th></tr></thead><tbody>' +
          items.map((it, i) => '<tr class="' + (it.duplicate ? 'dup' : '') + '"><td><input type="checkbox" data-i="' + i + '" ' + (it.selected ? 'checked' : '') + '></td>' +
            '<td>' + esc(it.title || '(no title)') + '</td><td class="url" title="' + esc(it.url) + '">' + esc(it.url.replace(/^https?:\/\//, '')) + '</td>' +
            '<td class="small muted">' + esc(it.folder || '') + '</td><td>' + (it.keyword ? '<span class="chip kw">go ' + esc(it.keyword) + '</span> ' : '') + it.tags.map((t) => '<span class="chip" style="font-size:11px">' + esc(t) + '</span>').join(' ') + '</td>' +
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
          const mode = $('#iSnap').value;
          const r = await api('POST', '/api/import/commit', { items: chosen, source, snapshotMode: mode === 'browser' ? 'none' : mode });
          let note = '';
          if (mode === 'browser' && r.ids.length) {
            try { await api('POST', '/api/snapshots/browser', { ids: r.ids }); note = '. Your browser will now open each page for a few seconds to take its screenshot.'; }
            catch (err) { note = '. Browser capture could not start: ' + err.message; }
          } else if (mode === 'auto' && r.added) note = '. Screenshots are being captured in the background.';
          toast('Imported ' + r.added + (r.skipped.length ? ', skipped ' + r.skipped.length : '') + note, 6000);
          await loadMeta();
          go('#/view/added');
        } catch (err) { toast(err.message, 4000); b.disabled = false; b.textContent = 'Import'; }
      };
      render();
    }
  }

  // ------------------------------------------------------------------ settings page (tabs)
  const SETTINGS_TABS = [['general', 'Settings', 'settings'], ['setup', 'Setup checklist', 'setup'], ['import', 'Import', 'import'], ['export', 'Export', 'export']];
  let settingsSeq = 0;
  async function renderSettingsPage(tab) {
    tab = tab || 'general';
    const seq = ++settingsSeq;
    pageShell('Settings',
      '<div class="tabs" role="tablist">' + SETTINGS_TABS.map(([k, label, ico]) => '<a role="tab" href="#/settings' + (k === 'general' ? '' : '/' + k) + '" class="tab' + (k === tab ? ' on' : '') + '" aria-selected="' + (k === tab) + '">' + NAV_ICONS[ico] + esc(label) + (k === 'setup' && state.meta && !state.meta.setupComplete ? '<span class="dot" title="Steps left"></span>' : '') + '</a>').join('') + '</div>' +
      '<div id="tabBody"><div class="card-box"><span class="spin"></span></div></div>');
    document.title = SETTINGS_TABS.find((t) => t[0] === tab)[1] + ' | Golinks';
    const guard = () => seq === settingsSeq && $('#tabBody');
    if (tab === 'setup') await renderSetupPage(guard);
    else if (tab === 'import') renderImportPage();
    else if (tab === 'export') await renderExportTab();
    else await renderGeneralTab(guard);
  }
  function tabShell(inner) { const b = $('#tabBody'); if (b) b.innerHTML = inner; }

  async function renderGeneralTab(guard) {
    const m = state.meta || (await loadMeta());
    const [health, bm, rules] = await Promise.all([api('GET', '/api/health'), api('GET', '/api/bookmarklet'), api('GET', '/api/rules')]);
    if (guard && !guard()) return;
    const s = m.settings;
    tabShell(
      '<div class="card-box"><h2 style="margin-top:0">General</h2>' +
      '<div class="row2"><div class="field"><label>Port</label><input type="number" id="sPort" value="' + s.port + '"><div class="help">Active: ' + health.port + '. Changing the port needs <code>bin/golinks restart</code> and updating the Chrome <code>:go</code> keyword and Shortcuts.</div></div>' +
      '<div class="field"><label>Stale after (days)</label><input type="number" id="sStale" value="' + s.staleDays + '"><div class="help">Links not opened for this long show as stale; snapshots older than this get a hint.</div></div></div>' +
      '<div class="row2"><div class="field"><label>Go confidence (min text score)</label><input type="number" step="0.1" id="sGo" value="' + s.goMinScore + '"><div class="help">Lower means <code>:go words</code> redirects more eagerly to the best match instead of showing search results.</div></div>' +
      '<div class="field"><label>Browser chrome to crop (points)</label><input type="number" id="sTopCrop" value="' + (s.topCrop ?? 116) + '"><div class="help">Height of tab strip, address bar and bookmarks bar removed from the top of window screenshots. 116 with the bookmarks bar shown, 87 without.</div></div></div>' +
      '<div class="row2"><div class="field checks"><label><input type="checkbox" id="sHeadless" ' + (s.headlessSnapshots ? 'checked' : '') + '> Headless Chrome snapshots for public pages' + (m.chrome ? '' : ' (no Chrome found)') + '</label>' +
      '<label><input type="checkbox" id="sRevisit" ' + (s.snapshotOnRevisit ? 'checked' : '') + '> Snapshot on revisit (used by the open Shortcut)</label></div></div>' +
      '<div class="actions"><button class="btn primary" id="sSave">Save settings</button><span id="sMsg" class="small muted"></span></div></div>' +

      '<div class="card-box"><h2 style="margin-top:0">Templates</h2><p class="small muted">Parameterized go-links. <code>{0}</code> <code>{1}</code> are words after the name, <code>{q}</code> is everything after the name URL-encoded, <code>{*}</code> raw. Example: <code>:go jira PROJ-123</code>.</p>' +
      '<div class="field"><textarea class="code" id="sTemplates">' + esc(JSON.stringify(m.templates, null, 2)) + '</textarea></div>' +
      '<div class="actions"><button class="btn" id="sTemplatesSave">Save templates</button><span id="sTemplatesMsg" class="small muted"></span></div></div>' +

      '<div class="card-box"><h2 style="margin-top:0">Tagging rules</h2><p class="small muted">Applied to every new link. <code>match</code> is a case-insensitive regex against the URL; <code>$1</code> in a tag is replaced by the first capture group.</p>' +
      '<div class="field"><textarea class="code" id="sRules">' + esc(JSON.stringify(rules.rules, null, 2)) + '</textarea></div>' +
      '<div class="actions"><button class="btn" id="sRulesSave">Save rules</button><span id="sRulesMsg" class="small muted"></span></div></div>' +

      '<div class="card-box"><h2 style="margin-top:0">Capture from Chrome</h2>' +
      '<p><b>Omnibox:</b> in Chrome go to <code>chrome://settings/searchEngines</code>, add a site search named <code>Go Links</code> with shortcut <code>:go</code> and URL <code>http://localhost:' + health.port + '/go/%s</code>. Then type <code>:go epdesign</code> or <code>:go jira PROJ-123</code> in the address bar.</p>' +
      '<p><b>Bookmarklet:</b> drag this to the bookmarks bar: <a class="btn" id="bmLink" href="' + esc(bm.href) + '" onclick="return false">Add to Golinks</a> <button class="btn sm ghost" id="bmCopy">Copy code</button></p>' +
      '<p><b>Hotkeys (optional):</b> see <code>shortcuts/README.md</code> for the two Apple Shortcuts (search, add current tab with screenshot).</p></div>' +

      '<div class="card-box"><h2 style="margin-top:0">Permissions and health</h2><div id="doctor"><span class="spin"></span> checking</div>' +
      '<div class="actions"><button class="btn" id="doctorRun">Re-check</button><button class="btn" id="doctorCapture">Test screenshot of this tab</button><span id="doctorMsg" class="small muted"></span></div></div>' +

      '<div class="card-box"><h2 style="margin-top:0">Snapshots</h2>' +
      '<p class="small muted">' + (m.snapshotStats ? m.snapshotStats.missing + ' link' + (m.snapshotStats.missing === 1 ? ' has' : 's have') + ' no snapshot and ' + m.snapshotStats.tiles + ' ' + (m.snapshotStats.tiles === 1 ? 'has' : 'have') + ' a generated tile. ' : '') + 'Capturing runs in the background, one link at a time: the page preview image first, then headless Chrome for public pages. Pages behind sign-in keep a tile; use the bookmarklet or the edit drawer for a real screenshot of those.</p>' +
      '<div class="actions"><button class="btn" id="sSnapMissing">Capture missing</button><button class="btn" id="sSnapTiles">Capture missing and replace tiles</button><span id="sSnapMsg" class="small muted">' + (m.pendingSnapshots.length ? m.pendingSnapshots.length + ' in progress' : '') + '</span></div>' +
      '<h3 style="margin-top:16px;font-size:13.5px">Through your browser</h3>' +
      '<p class="small muted">For pages behind sign-in. Each page is opened in a new tab of your front browser window for a few seconds, screenshotted through your own session, and the tab is closed. Keep the browser on this Space while it runs; pages that land on a sign-in screen are skipped and keep their tile.</p>' +
      '<div class="actions"><button class="btn primary" id="sSnapBrowser">Capture tiles through my browser</button><button class="btn" id="sSnapBrowserAll">Recapture everything</button><button class="btn danger hidden" id="sSnapBrowserStop">Stop</button><span id="sSnapBrowserMsg" class="small muted"></span></div>' +
      '<div id="sSnapBrowserLog" class="small muted" style="margin-top:8px"></div></div>' +

      '<div class="card-box danger-zone"><h2 style="margin-top:0">Delete all links</h2>' +
      '<p class="small muted">Removes every link and its snapshot from this Mac. Settings, tagging rules and templates stay. <a href="#/settings/export">Export</a> first if you may want them back.</p>' +
      '<div class="actions"><button class="btn danger" id="sWipe">Delete all ' + health.links + ' link' + (health.links === 1 ? '' : 's') + '</button><span id="sWipeMsg" class="small muted"></span></div></div>' +

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
    const queueSnaps = async (only) => {
      try {
        const r = await api('POST', '/api/snapshots/refresh', { only });
        $('#sSnapMsg').textContent = r.queued ? 'Queued ' + r.queued + ' link' + (r.queued === 1 ? '' : 's') + ', ' + r.pending + ' in progress.' : 'Nothing to capture.';
        await loadMeta(); renderSidebar();
      } catch (err) { $('#sSnapMsg').textContent = err.message; }
    };
    $('#sSnapMissing').onclick = () => queueSnaps('missing');
    $('#sSnapTiles').onclick = () => queueSnaps('tiles');
    // browser batch: confirm, start, then poll progress while this tab is open
    let batchTimer = null;
    const renderBatch = (b) => {
      const msg = $('#sSnapBrowserMsg'), stop = $('#sSnapBrowserStop'), logEl = $('#sSnapBrowserLog');
      if (!msg) { clearInterval(batchTimer); return; }
      stop.classList.toggle('hidden', !b.running);
      $('#sSnapBrowser').disabled = b.running; $('#sSnapBrowserAll').disabled = b.running;
      if (b.running) msg.innerHTML = '<span class="spin"></span> ' + b.done + ' of ' + b.total + (b.current ? ', now: ' + esc(b.current.title || b.current.id) : '') + (b.app ? ' (' + esc(b.app) + ')' : '');
      else if (b.finishedAt) msg.textContent = (b.stopRequested ? 'Stopped. ' : 'Done. ') + b.ok + ' captured, ' + b.skipped.length + ' skipped' + (b.error ? '. ' + b.error : '.');
      else msg.textContent = '';
      logEl.innerHTML = b.skipped.length ? 'Skipped: ' + b.skipped.slice(-8).map((s) => '<a href="#/link/' + esc(s.id) + '">' + esc(s.title || s.id) + '</a> <span class="muted">(' + esc(s.reason) + ')</span>').join(', ') : '';
      if (!b.running && batchTimer) { clearInterval(batchTimer); batchTimer = null; loadMeta().then(renderSidebar); }
    };
    const pollBatch = () => { clearInterval(batchTimer); batchTimer = setInterval(async () => { try { renderBatch((await api('GET', '/api/snapshots/browser')).batch); } catch { clearInterval(batchTimer); } }, 1500); };
    const startBatch = async (only) => {
      const n = only === 'all' ? health.links : (m.snapshotStats ? m.snapshotStats.missing + m.snapshotStats.tiles : 0);
      if (!n) { toast('Nothing to capture'); return; }
      const ok = await dialog({ input: false, ok: 'Start', title: 'Capture ' + n + ' page' + (n === 1 ? '' : 's') + ' through your browser?',
        message: 'Each page opens in a new tab of your front browser window for a few seconds and is closed again. About ' + Math.ceil(n * 6 / 60) + ' minute' + (Math.ceil(n * 6 / 60) === 1 ? '' : 's') + ' in total; keep the browser on this Space meanwhile. You can stop at any time.' });
      if (!ok) return;
      try {
        const r = await api('POST', '/api/snapshots/browser', { only });
        if (!r.started) { $('#sSnapBrowserMsg').textContent = r.reason || 'Nothing to capture.'; return; }
        renderBatch(r.batch); pollBatch(); loadMeta().then(renderSidebar);
      } catch (err) { $('#sSnapBrowserMsg').textContent = err.message; }
    };
    $('#sSnapBrowser').onclick = () => startBatch('tiles');
    $('#sSnapBrowserAll').onclick = () => startBatch('all');
    $('#sSnapBrowserStop').onclick = async () => { renderBatch((await api('POST', '/api/snapshots/browser/stop')).batch); };
    if (m.browserBatch) { renderBatch(m.browserBatch); if (m.browserBatch.running) pollBatch(); }
    $('#sWipe').onclick = async () => {
      if (!health.links) { toast('There are no links to delete'); return; }
      const r = await dialog({
        title: 'Delete all ' + health.links + ' links?',
        message: 'This removes every link and snapshot and cannot be undone. Type <b>DELETE</b> to confirm.',
        placeholder: 'DELETE', ok: 'Delete everything', danger: true,
        validate: (v) => (v === 'DELETE' ? '' : 'Type DELETE in capitals to confirm'),
        checkbox: 'Also remove the ' + (m.folders ? m.folders.length : 0) + ' folder' + (m.folders && m.folders.length === 1 ? '' : 's'),
      });
      if (!r) return;
      const b = $('#sWipe');
      b.disabled = true;
      try {
        const res = await api('POST', '/api/links/delete-all', { confirm: 'DELETE', folders: r.checked });
        $('#sWipeMsg').textContent = 'Deleted ' + res.deleted + ' link' + (res.deleted === 1 ? '' : 's') + (res.foldersRemoved ? ' and ' + res.foldersRemoved + ' folders' : '') + '.';
        toast('All links deleted');
        await loadMeta();
        renderSidebar();
        renderSettingsPage('general');
      } catch (err) { $('#sWipeMsg').textContent = err.message; b.disabled = false; }
    };
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
      $('#content').innerHTML = '<div class="empty"><b>Service stopped</b>Start it again with <code>bin/golinks start</code>.</div>';
      setTimeout(() => setDown(true), 500);
    };
  }

  // ------------------------------------------------------------------ export tab
  async function renderExportTab() {
    const m = state.meta || (await loadMeta());
    const formats = m.exportFormats || [];
    const HELP = {
      json: 'Every field of every link plus the folder list. The format for backups and for moving Golinks between machines.',
      html: 'The bookmarks file browsers import (Chrome, Brave, Edge, Safari, Firefox). Folders nest; tags and keywords are kept in attributes.',
      csv: 'One row per link with url, title, folder, tags, keyword, description, notes, dates and use count. Opens in Excel, Numbers and Sheets.',
      xlsx: 'Excel workbook with a frozen header row and filters, same columns as CSV.',
      md: 'Markdown list grouped by folder, with keyword and tags after each link.',
      txt: 'Plain URLs, one per line.',
    };
    tabShell(
      '<div class="card-box"><h2 style="margin-top:0">Export links</h2>' +
      '<div class="row2"><div class="field"><label>Format</label><select id="xFormat">' + formats.map((f) => '<option value="' + esc(f.id) + '">' + esc(f.label) + ' (.' + esc(f.ext) + ')</option>').join('') + '</select><div class="help" id="xHelp"></div></div>' +
      '<div class="field"><label>Scope</label><select id="xScope"><option value="all">All links</option><option value="folder">One folder and its subfolders</option><option value="tag">One tag</option></select>' +
      '<div id="xFolderWrap" class="hidden" style="margin-top:6px"><div id="xFolder"></div></div>' +
      '<div id="xTagWrap" class="hidden" style="margin-top:6px"><select id="xTag">' + (m.tags || []).map((t) => '<option value="' + esc(t.name) + '">' + esc(t.name) + ' (' + t.count + ')</option>').join('') + '</select></div></div></div>' +
      '<div class="actions"><button class="btn primary" id="xGo">Download</button><span id="xInfo" class="small muted"></span></div>' +
      '<p class="small muted" style="margin-top:12px">Snapshots are not part of an export; they live in the <code>snapshots/</code> folder next to your data. Everything exported here can be imported again from the Import tab.</p></div>' +

      '<div class="card-box"><h2 style="margin-top:0">Just the URLs</h2>' +
      '<p class="small muted">Lists the URLs for the scope chosen above, one per line, here on the page so you can copy them into a message, a document or another tool.</p>' +
      '<div class="actions"><button class="btn" id="xShow">Show URLs</button><button class="btn hidden" id="xCopy">Copy to clipboard</button><label class="small muted hidden" id="xTitlesWrap"><input type="checkbox" id="xTitles"> include titles</label><span id="xUrlInfo" class="small muted"></span></div>' +
      '<div id="xUrlWrap" class="hidden"><textarea class="code urls" id="xUrls" readonly spellcheck="false"></textarea></div></div>');
    const fmt = $('#xFormat'), scope = $('#xScope'), info = $('#xInfo');
    const picker = folderPicker($('#xFolder'), { value: state.lastFolder || '', folders: m.folders, placeholder: 'Choose a folder', onChange: () => { preview(); if (shown) showUrls(); } });
    const params = () => {
      const p = new URLSearchParams({ format: fmt.value });
      if (scope.value === 'folder' && picker.get()) p.set('folder', picker.get());
      if (scope.value === 'tag' && $('#xTag').value) p.set('tag', $('#xTag').value);
      return p;
    };
    async function preview() {
      $('#xHelp').textContent = HELP[fmt.value] || '';
      $('#xFolderWrap').classList.toggle('hidden', scope.value !== 'folder');
      $('#xTagWrap').classList.toggle('hidden', scope.value !== 'tag');
      if (scope.value === 'folder' && !picker.get()) { info.textContent = 'Pick a folder.'; return; }
      try {
        const r = await api('GET', '/api/export?' + params() + '&preview=1');
        info.textContent = r.count + ' link' + (r.count === 1 ? '' : 's') + ' as ' + r.filename;
        $('#xGo').disabled = !r.count;
      } catch (err) { info.textContent = err.message; }
    }
    fmt.onchange = preview; scope.onchange = preview; $('#xTag').onchange = preview;
    // URLs on the page: fetch the plain export (or Markdown when titles are wanted) and show it.
    let shown = false;
    async function showUrls() {
      if (scope.value === 'folder' && !picker.get()) { $('#xUrlInfo').textContent = 'Pick a folder first.'; return; }
      const p = params();
      p.set('format', 'txt');
      if ($('#xTitles').checked) p.set('format', 'md');
      $('#xUrlInfo').innerHTML = '<span class="spin"></span>';
      try {
        const res = await fetch('/api/export?' + p);
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        let text = await res.text();
        if ($('#xTitles').checked) {
          // Markdown -> "Title  URL" lines, skipping headings
          text = text.split('\n').map((l) => { const m = /^- \[(.*?)\]\((https?:[^)]+)\)/.exec(l); return m ? (m[1] ? m[1] + '  ' + m[2] : m[2]) : ''; }).filter(Boolean).join('\n') + '\n';
        }
        const n = text.split('\n').filter(Boolean).length;
        const ta = $('#xUrls');
        ta.value = text;
        ta.rows = Math.min(24, Math.max(4, n + 1));
        $('#xUrlWrap').classList.remove('hidden');
        $('#xCopy').classList.remove('hidden');
        $('#xTitlesWrap').classList.remove('hidden');
        $('#xUrlInfo').textContent = n + ' URL' + (n === 1 ? '' : 's');
        shown = true;
      } catch (err) { $('#xUrlInfo').textContent = err.message; }
    }
    $('#xShow').onclick = showUrls;
    $('#xTitles').onchange = () => { if (shown) showUrls(); };
    $('#xCopy').onclick = () => { const ta = $('#xUrls'); ta.select(); copy(ta.value, 'Copied ' + $('#xUrlInfo').textContent); };
    $('#xUrls').addEventListener('focus', (e) => e.target.select());
    scope.addEventListener('change', () => { if (shown) showUrls(); });
    $('#xTag').addEventListener('change', () => { if (shown) showUrls(); });
    $('#xGo').onclick = () => {
      // a plain navigation lets the browser save the attachment
      const a = document.createElement('a');
      a.href = '/api/export?' + params();
      a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
      toast('Export started');
    };
    preview();
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

  async function renderSetupPage(guard) {
    const m = await loadMeta();
    const [health, bm] = await Promise.all([api('GET', '/api/health'), api('GET', '/api/bookmarklet')]);
    if (guard && !guard()) return;
    const done = (m.settings.setup) || {};
    const goUrl = 'http://localhost:' + health.port + '/go/%s';
    const step = (key, title, body, auto) =>
      '<div class="step ' + (done[key] || auto ? 'done' : '') + '" data-step="' + key + '"><div class="step-head"><span class="mark">' + (done[key] || auto ? '&#10003;' : '') + '</span><h3>' + title + '</h3>' +
      (auto ? '' : '<button class="btn sm ghost" data-toggle="' + key + '">' + (done[key] ? 'Undo' : 'Mark done') + '</button>') + '</div><div class="step-body">' + body + '</div></div>';
    tabShell(
      '<p class="muted">Three short steps and one optional. Everything works without them, but each one makes Golinks faster to use.' + (m.setupComplete ? ' <b>All done.</b> This checklist no longer shows in the sidebar.' : '') + '</p>' +
      step('service', 'Service is running', 'Version ' + esc(health.version) + ' on port ' + health.port + ', started at login by launchd. Check with <code>bin/golinks status</code>.', true) +
      step('go', 'Address bar go-links', '<p>In your browser open the site-search settings and add an entry:</p>' +
        '<div class="kv"><span>Chrome</span><code>chrome://settings/searchEngines</code><span>Brave</span><code>brave://settings/searchEngines</code><span>Edge</span><code>edge://settings/searchEngines</code></div>' +
        '<div class="kv"><span>Name</span><code>Go Links</code><span>Shortcut</span><code>:go</code><span>URL</span><code id="goUrl">' + esc(goUrl) + '</code> <button class="btn sm" id="copyGo">Copy URL</button></div>' +
        '<p class="small muted">Then type <code>:go</code>, Space, and a keyword such as <code>:go expenses</code> or <code>:go jira PROJ-123</code>. Safari has no site search; use the web UI or the search Shortcut there.</p>') +
      step('bookmarklet', 'Bookmarklet: save any page with a screenshot', '<p>Drag this button to your bookmarks bar: <a class="btn" href="' + esc(bm.href) + '" onclick="return false">Add to Golinks</a> <button class="btn sm ghost" id="copyBm">Copy code</button></p><p class="small muted">Click it on any page, including SSO pages. A popup shows the screenshot of the page and suggested tags; Cmd+Enter saves.</p>') +
      step('permissions', 'Allow screenshots of your browser', '<p>macOS must let the service (the <code>node</code> process) read browser tabs and capture the screen. Automation is asked for automatically on first use. Screen Recording has to be enabled by hand:</p>' +
        '<ol class="small"><li>System Settings > Privacy & Security > Screen & System Audio Recording.</li><li>Enable <code>node</code>. If it is missing, press <b>+</b>, then Cmd+Shift+G and paste: <code id="execPath">' + esc(health.execPath) + '</code> <button class="btn sm" id="copyExec">Copy path</button></li><li>Run <code>bin/golinks restart</code>, then Re-check below.</li></ol>' +
        '<div id="setupDoctor"></div><div class="actions"><button class="btn sm" id="setupDoctorRun">Re-check</button></div>') +
      step('import', 'Import your bookmarks <span class="opt">optional</span>', '<p>Bring in browser bookmarks, a Golinks export, a bookmarks HTML file, CSV, Excel or Markdown with a preview and duplicate detection: <a href="#/settings/import" class="btn sm">Open Import</a></p>'));
    $('#copyGo').onclick = () => copy(goUrl, 'go URL copied');
    $('#copyBm').onclick = () => copy(bm.href, 'Bookmarklet code copied');
    $('#copyExec').onclick = () => copy(health.execPath, 'Path copied');
    $$('[data-toggle]').forEach((b) => (b.onclick = async () => { await markSetup(b.dataset.toggle, !done[b.dataset.toggle]); renderSidebar(); renderSettingsPage('setup'); }));
    const dEl = $('#setupDoctor');
    const runDoc = async () => {
      const d = await renderDoctor(dEl);
      if (d) {
        const perms = d.checks.filter((c) => c.id === 'automation' || c.id === 'screen');
        const ok = perms.length && perms.every((c) => c.ok === true);
        if (ok && !done.permissions) { await markSetup('permissions', true); renderSidebar(); renderSettingsPage('setup'); }
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
      location.hash = '#/settings/setup';
      markSetup('seen', true);
    }
    window.addEventListener('hashchange', onRoute);
    await onRoute();
    if (state.route.page === 'links') $('#q').focus();
    // keep counts and pending snapshots fresh
    setInterval(async () => {
      if (document.hidden) return;
      const before = state.meta && (state.meta.pendingSnapshots.length + ':' + (state.meta.browserBatch ? state.meta.browserBatch.done + '/' + state.meta.browserBatch.running : ''));
      await loadMeta();
      const after = state.meta && (state.meta.pendingSnapshots.length + ':' + (state.meta.browserBatch ? state.meta.browserBatch.done + '/' + state.meta.browserBatch.running : ''));
      if (state.meta && before !== after) { renderSidebar(); if (state.route.page === 'links' && !state.editing) doSearch(); }
    }, 5000);
  }
  boot();
})();
