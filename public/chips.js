// Tag chip editor shared by the main UI and the bookmarklet popup.
// chipEditor(container, { values, suggestions, placeholder, onChange }) -> { get, set, addSuggestion }
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function slug(t) {
    return String(t || '').toLowerCase().trim().replace(/[^a-z0-9._+-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  function chipEditor(container, opts) {
    opts = opts || {};
    let values = [];
    let suggestions = [];
    let all = [];

    container.classList.add('chips-wrap');
    const box = document.createElement('div');
    box.className = 'chips';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = opts.placeholder || 'add tag, Enter or comma';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const sug = document.createElement('div');
    sug.className = 'chips-suggest';
    box.appendChild(input);
    container.appendChild(box);
    container.appendChild(sug);

    function render() {
      box.querySelectorAll('.chip').forEach((c) => c.remove());
      for (const v of values) {
        const c = document.createElement('span');
        c.className = 'chip';
        c.innerHTML = esc(v) + ' <button type="button" title="remove" data-v="' + esc(v) + '">&times;</button>';
        box.insertBefore(c, input);
      }
      renderSuggestions();
    }

    function renderSuggestions() {
      const typed = slug(input.value);
      const pool = [];
      for (const s of suggestions) if (!values.includes(s)) pool.push(s);
      if (typed) {
        for (const s of all) if (s.startsWith(typed) && !values.includes(s) && !pool.includes(s)) pool.push(s);
      }
      const show = pool.slice(0, 12);
      sug.innerHTML = show.map((s) => '<span class="chip soft suggest" data-v="' + esc(s) + '">+ ' + esc(s) + '</span>').join('');
    }

    function add(v) {
      const s = slug(v);
      if (!s || values.includes(s)) return;
      values.push(s);
      input.value = '';
      render();
      if (opts.onChange) opts.onChange(values.slice());
    }

    function remove(v) {
      values = values.filter((x) => x !== v);
      render();
      if (opts.onChange) opts.onChange(values.slice());
    }

    box.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) { remove(b.dataset.v); return; }
      input.focus();
    });
    sug.addEventListener('click', (e) => {
      const c = e.target.closest('[data-v]');
      if (c) { add(c.dataset.v); input.focus(); }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab' && input.value.trim()) {
        if (input.value.trim()) { e.preventDefault(); add(input.value); }
        else if (e.key === 'Enter') { /* let the form handle Enter */ }
      } else if (e.key === 'Backspace' && !input.value && values.length) {
        remove(values[values.length - 1]);
      } else if (e.key === 'Escape') {
        input.value = '';
        renderSuggestions();
      }
    });
    input.addEventListener('input', renderSuggestions);
    input.addEventListener('blur', () => { if (input.value.trim()) add(input.value); });

    const api = {
      get: () => values.slice(),
      set: (v) => { values = []; (v || []).forEach((x) => { const s = slug(x); if (s && !values.includes(s)) values.push(s); }); render(); },
      setSuggestions: (v) => { suggestions = (v || []).map(slug).filter(Boolean); renderSuggestions(); },
      setAll: (v) => { all = (v || []).map(slug).filter(Boolean); renderSuggestions(); },
      add,
      focus: () => input.focus(),
      input,
    };
    api.set(opts.values || []);
    api.setSuggestions(opts.suggestions || []);
    api.setAll(opts.all || []);
    return api;
  }

  global.chipEditor = chipEditor;
  global.slugTag = slug;
})(window);
