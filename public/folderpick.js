// Folder picker shared by the main UI and the bookmarklet popup.
// folderPicker(container, { value, folders, placeholder, onChange }) -> { get, set, setFolders, focus, input }
//
// The input shows the current path and accepts typing (a path that does not exist yet is
// offered as "Create"). The dropdown shows the folder tree with expand/collapse, the same
// icons as the sidebar, and a "No folder" row. Arrow keys move, Right/Left expand and
// collapse, Enter picks, Escape closes.
(function (global) {
  'use strict';

  const ICONS = {
    closed: '<svg class="fico" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3.2c.4 0 .8.16 1.06.44L8.5 4.7h4.5A1.5 1.5 0 0 1 14.5 6.2v5.3A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-7z" fill="currentColor" opacity=".8"/></svg>',
    open: '<svg class="fico open" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3.2c.4 0 .8.16 1.06.44L8.5 4.7h4A1.5 1.5 0 0 1 14 6.2V7H4.6a1.5 1.5 0 0 0-1.42 1.02L1.5 12.3v-7.8z" fill="currentColor" opacity=".55"/><path d="M4.6 8h9.9a1 1 0 0 1 .95 1.32l-1.1 3.3A2 2 0 0 1 12.45 14H2.3a.8.8 0 0 1-.76-1.05l1.6-4.27A1.5 1.5 0 0 1 4.6 8z" fill="currentColor" opacity=".9"/></svg>',
    chevRight: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevDown: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 6 8 10.5 12.5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    none: '<svg class="fico" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.6" opacity=".7"/></svg>',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function normalize(v) {
    return String(v || '').split(/[\/\\]/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s && s !== '.' && s !== '..').join('/');
  }

  function hl(text, needle) {
    const safe = esc(text);
    if (!needle) return safe;
    const i = text.toLowerCase().indexOf(needle.toLowerCase());
    if (i < 0) return safe;
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + needle.length)) + '</mark>' + esc(text.slice(i + needle.length));
  }

  function folderPicker(container, opts) {
    opts = opts || {};
    let value = normalize(opts.value);
    let folders = [];
    let byParent = new Map();
    let open = false;
    let rows = []; // visible rows in order: { kind: 'none'|'create'|'folder', path, node, depth, hasKids, expanded }
    let hi = -1; // highlighted row index
    const expanded = new Set();

    container.classList.add('fpick');
    container.innerHTML =
      '<div class="fpick-input"><span class="fpick-ico">' + ICONS.closed + '</span>' +
      '<input type="text" autocomplete="off" spellcheck="false" placeholder="' + esc(opts.placeholder || 'No folder') + '" role="combobox" aria-expanded="false" aria-autocomplete="list">' +
      '<button type="button" class="fpick-caret" tabindex="-1" title="Choose a folder">' + ICONS.chevDown + '</button></div>';
    const input = container.querySelector('input');
    const ico = container.querySelector('.fpick-ico');
    const caret = container.querySelector('.fpick-caret');
    const menu = document.createElement('div');
    menu.className = 'fpick-menu';
    menu.setAttribute('role', 'listbox');
    document.body.appendChild(menu);

    function setFolders(list) {
      folders = (list || []).map((f) => (typeof f === 'string' ? { path: f } : f)).map((f) => {
        const path = normalize(f.path);
        const segs = path.split('/');
        return { path, name: f.name || segs[segs.length - 1], parent: f.parent !== undefined ? f.parent : (segs.length > 1 ? segs.slice(0, -1).join('/') : null), depth: f.depth !== undefined ? f.depth : segs.length - 1, count: f.count || 0, total: f.total || 0 };
      }).filter((f) => f.path);
      byParent = new Map();
      for (const f of folders) {
        const k = (f.parent || '').toLowerCase();
        if (!byParent.has(k)) byParent.set(k, []);
        byParent.get(k).push(f);
      }
      for (const list2 of byParent.values()) list2.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      if (open) render();
    }

    function revealValue() {
      const segs = value.split('/');
      for (let i = 1; i < segs.length; i++) expanded.add(segs.slice(0, i).join('/').toLowerCase());
    }

    function exists(path) {
      const k = path.toLowerCase();
      return folders.find((f) => f.path.toLowerCase() === k) || null;
    }

    function updateIcon() {
      ico.innerHTML = value ? ICONS.closed : ICONS.none;
      ico.classList.toggle('nofolder', !value); // not 'empty': the app styles .empty as a full empty state
    }

    function commit(path, keepOpen) {
      value = normalize(path);
      input.value = value;
      updateIcon();
      if (!keepOpen) close();
      if (opts.onChange) opts.onChange(value);
    }

    // ---- rows ----
    function buildRows() {
      const typed = normalize(input.value);
      const filter = typed && typed.toLowerCase() !== value.toLowerCase() ? typed.toLowerCase() : '';
      rows = [];
      if (filter) {
        if (!exists(typed)) rows.push({ kind: 'create', path: typed });
        for (const f of folders) if (f.path.toLowerCase().includes(filter)) rows.push({ kind: 'folder', path: f.path, node: f, depth: 0, flat: true });
        return filter;
      }
      rows.push({ kind: 'none', path: '' });
      const walk = (parentKey) => {
        for (const f of byParent.get(parentKey) || []) {
          const key = f.path.toLowerCase();
          const kids = byParent.get(key) || [];
          const isOpen = kids.length > 0 && expanded.has(key);
          rows.push({ kind: 'folder', path: f.path, node: f, depth: f.depth, hasKids: kids.length > 0, expanded: isOpen });
          if (isOpen) walk(key);
        }
      };
      walk('');
      if (typed && !exists(typed)) rows.splice(1, 0, { kind: 'create', path: typed });
      return '';
    }

    function render() {
      const filter = buildRows();
      if (!rows.length) rows.push({ kind: 'empty' });
      menu.innerHTML = rows.map((r, i) => {
        const cls = 'fpick-row' + (i === hi ? ' hi' : '') + (r.kind === 'folder' && r.path.toLowerCase() === value.toLowerCase() ? ' sel' : '') + (r.kind === 'create' ? ' create' : '') + (r.kind === 'none' ? ' nonef' : '');
        if (r.kind === 'empty') return '<div class="fpick-empty">No folders yet. Type a path such as <code>Work/Projects</code> to create one.</div>';
        if (r.kind === 'none') return '<div class="' + cls + '" data-i="' + i + '" role="option"><span class="tw"></span>' + ICONS.none + '<span class="label">No folder</span></div>';
        if (r.kind === 'create') return '<div class="' + cls + '" data-i="' + i + '" role="option"><span class="tw"></span>' + ICONS.closed + '<span class="label">Create <b>' + esc(r.path) + '</b></span><span class="n">new</span></div>';
        const n = r.node;
        const label = r.flat ? hl(n.path, filter) : esc(n.name);
        const tw = r.flat ? '<span class="tw"></span>' : r.hasKids ? '<button type="button" class="tw" data-tw="' + esc(n.path) + '" tabindex="-1" title="' + (r.expanded ? 'Collapse' : 'Expand') + '">' + (r.expanded ? ICONS.chevDown : ICONS.chevRight) + '</button>' : '<span class="tw"></span>';
        return '<div class="' + cls + '" data-i="' + i + '" role="option" style="padding-left:' + (6 + r.depth * 14) + 'px" title="' + esc(n.path) + '">' + tw + (r.expanded ? ICONS.open : ICONS.closed) + '<span class="label">' + label + '</span>' + (n.total ? '<span class="n" title="' + n.count + ' here, ' + n.total + ' including subfolders">' + n.total + '</span>' : '') + '</div>';
      }).join('');
      const h = menu.querySelector('.fpick-row.hi');
      if (h) h.scrollIntoView({ block: 'nearest' });
    }

    function place() {
      const r = container.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 8;
      const above = r.top - 8;
      const maxH = 300;
      const useAbove = below < Math.min(maxH, 180) && above > below;
      menu.style.left = r.left + 'px';
      menu.style.width = r.width + 'px';
      menu.style.maxHeight = Math.max(120, Math.min(maxH, useAbove ? above : below)) + 'px';
      if (useAbove) { menu.style.top = ''; menu.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
      else { menu.style.bottom = ''; menu.style.top = (r.bottom + 4) + 'px'; }
    }

    function show() {
      if (open) return;
      open = true;
      revealValue();
      hi = -1;
      input.setAttribute('aria-expanded', 'true');
      container.classList.add('open');
      render();
      // highlight the current value so Enter keeps it
      hi = rows.findIndex((r) => r.kind === 'folder' && r.path.toLowerCase() === value.toLowerCase());
      if (hi < 0) hi = 0;
      render();
      place();
      menu.classList.add('show');
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
    }

    function close() {
      if (!open) return;
      open = false;
      input.setAttribute('aria-expanded', 'false');
      container.classList.remove('open');
      menu.classList.remove('show');
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      // typed text that was not picked: keep it as a new path
      const typed = normalize(input.value);
      if (typed !== value) commit(typed, true);
      input.value = value;
    }

    function pick(i) {
      const r = rows[i];
      if (!r) return;
      if (r.kind === 'none') commit('');
      else if (r.kind === 'create' || r.kind === 'folder') commit(r.path);
    }

    function toggle(path) {
      const k = path.toLowerCase();
      if (expanded.has(k)) expanded.delete(k); else expanded.add(k);
      render();
      place();
    }

    // ---- events ----
    input.addEventListener('focus', show);
    input.addEventListener('click', show);
    caret.addEventListener('mousedown', (e) => { e.preventDefault(); if (open) { close(); input.blur(); } else { input.focus(); show(); } });
    input.addEventListener('input', () => { if (!open) show(); hi = 0; render(); place(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); input.value = value; close(); } return; }
      if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); show(); return; }
      if (!open) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.min(rows.length - 1, hi + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(0, hi - 1); render(); }
      else if (e.key === 'ArrowRight' && rows[hi] && rows[hi].hasKids && !rows[hi].expanded) { e.preventDefault(); toggle(rows[hi].path); }
      else if (e.key === 'ArrowLeft' && rows[hi] && rows[hi].kind === 'folder' && !rows[hi].flat) {
        e.preventDefault();
        if (rows[hi].expanded) toggle(rows[hi].path);
        else if (rows[hi].node.parent) { const p = rows[hi].node.parent.toLowerCase(); hi = rows.findIndex((r) => r.kind === 'folder' && r.path.toLowerCase() === p); render(); }
      }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (rows[hi] && rows[hi].kind !== 'empty') pick(hi); else commit(input.value); }
      else if (e.key === 'Tab') { close(); }
    });
    input.addEventListener('blur', () => { setTimeout(() => { if (!menu.contains(document.activeElement) && !container.contains(document.activeElement)) close(); }, 0); });
    menu.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus in the input
      const tw = e.target.closest('[data-tw]');
      if (tw) { toggle(tw.dataset.tw); return; }
      const row = e.target.closest('[data-i]');
      if (row) pick(Number(row.dataset.i));
    });
    menu.addEventListener('mousemove', (e) => {
      const row = e.target.closest('[data-i]');
      if (row && Number(row.dataset.i) !== hi) { hi = Number(row.dataset.i); menu.querySelectorAll('.fpick-row.hi').forEach((x) => x.classList.remove('hi')); row.classList.add('hi'); }
    });
    // remove the detached menu when the container leaves the document
    const mo = new MutationObserver(() => { if (!document.body.contains(container)) { menu.remove(); mo.disconnect(); } });
    mo.observe(document.body, { childList: true, subtree: true });

    input.value = value;
    updateIcon();
    setFolders(opts.folders || []);

    return {
      get: () => value,
      set: (v) => { value = normalize(v); input.value = value; updateIcon(); },
      setFolders,
      focus: () => input.focus(),
      input,
      destroy: () => { menu.remove(); mo.disconnect(); },
    };
  }

  global.folderPicker = folderPicker;
  global.FOLDER_ICONS = ICONS;
})(window);
