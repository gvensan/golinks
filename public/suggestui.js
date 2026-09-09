// Suggestion chips shared by the main UI and the bookmarklet popup.
// suggestChips(container, items, { onPick, label, empty }) renders clickable chips.
// Each item: { text, hint, why, kind } where kind is 'folder' | 'tag' | 'keyword'.
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function suggestChips(container, items, opts) {
    opts = opts || {};
    if (!container) return;
    if (!items || !items.length) { container.innerHTML = ''; container.classList.add('hidden'); return; }
    container.classList.remove('hidden');
    const ico = (kind) => kind === 'folder' && global.FOLDER_ICONS ? global.FOLDER_ICONS.closed : kind === 'keyword' ? '<span class="sug-k">go</span>' : '';
    container.innerHTML = (opts.label ? '<span class="sug-label">' + esc(opts.label) + '</span>' : '') +
      items.map((it, i) => '<button type="button" class="chip soft suggest sug-' + esc(it.kind || 'tag') + '" data-i="' + i + '" title="' + esc(it.why || '') + '">' + ico(it.kind) + esc(it.text) + (it.hint ? '<span class="sug-hint">' + esc(it.hint) + '</span>' : '') + '</button>').join('');
    container.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const it = items[Number(b.dataset.i)];
      if (opts.onPick) opts.onPick(it, b);
      if (opts.removeOnPick !== false) { b.remove(); if (!container.querySelector('[data-i]')) container.classList.add('hidden'); }
    };
  }

  // Turns the server's suggest object into chip items per field.
  function itemsFrom(suggest) {
    const s = suggest || {};
    return {
      folders: (s.folders || []).map((f) => ({ kind: 'folder', text: f.path, hint: f.count ? String(f.count) : '', why: f.why, value: f.path })),
      tags: (s.tags || []).map((t) => ({ kind: 'tag', text: t.name, why: t.why, value: t.name })),
      keywords: (s.keywords || []).map((k) => ({ kind: 'keyword', text: k.keyword, why: k.why, value: k.keyword })),
    };
  }

  // "By Author, published 2026-01-02" line from suggest.details, or ''.
  function detailsLine(details) {
    if (!details) return '';
    const parts = [];
    if (details.author) parts.push('By ' + details.author);
    if (details.published) { const d = new Date(details.published); parts.push('published ' + (isNaN(d) ? details.published : d.toISOString().slice(0, 10))); }
    return parts.join(', ');
  }

  global.suggestChips = suggestChips;
  global.suggestItems = itemsFrom;
  global.suggestDetailsLine = detailsLine;
})(window);
