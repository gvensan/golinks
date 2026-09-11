// "Golinks" bookmarklet source. The service serves a minified javascript: URL
// at GET /api/bookmarklet with __PORT__ filled in. Keep this file free of
// single-line comments at the end of code lines; the minifier drops whole-line
// comments only.
//
// Besides url, title, description, selection and og:image it collects page metadata
// the popup turns into suggestions: keywords, site name, breadcrumbs, author, published
// date and canonical URL. It runs inside the page, so this works on SSO pages too.
(function () {
  var d = document;
  var m = function (n) {
    var e = d.querySelector('meta[property="' + n + '"],meta[name="' + n + '"]');
    return e ? e.content : '';
  };
  var texts = function (sel, max) {
    var out = [];
    var els = d.querySelectorAll(sel);
    for (var i = 0; i < els.length && out.length < max; i++) {
      var t = (els[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 60 && out.indexOf(t) < 0) out.push(t);
    }
    return out;
  };
  var sel = String(window.getSelection ? window.getSelection() : '').slice(0, 500);

  var keywords = [];
  var push = function (k) { k = String(k || '').trim(); if (k && keywords.indexOf(k) < 0 && keywords.length < 12) keywords.push(k); };
  m('keywords').split(/[,;]/).forEach(push);
  d.querySelectorAll('meta[property="article:tag"],meta[name="article:tag"]').forEach(function (e) { push(e.content); });
  texts('a.topic-tag, a[href*="jql=labels"], [data-testid*="labels"] a, .aui-label, .label-list a', 8).forEach(push);

  var crumbs = texts('nav[aria-label*="readcrumb" i] a, nav[aria-label*="readcrumb" i] li, #breadcrumbs a, .breadcrumbs a, ol.breadcrumb a, .ms-Breadcrumb a, [data-automationid="breadcrumb"] a, [class*="Breadcrumb"] a', 6);
  var space = m('ajs-space-name');
  if (space && crumbs.indexOf(space) < 0) crumbs.unshift(space);
  try {
    var lds = d.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < lds.length; i++) {
      var j = JSON.parse(lds[i].textContent);
      var arr = Array.isArray(j) ? j : (j['@graph'] || [j]);
      arr.forEach(function (n) {
        if (!n) return;
        if (n['@type'] === 'BreadcrumbList' && n.itemListElement) {
          n.itemListElement.forEach(function (it) { var nm = it && (it.name || (it.item && it.item.name)); if (nm && crumbs.indexOf(nm) < 0 && crumbs.length < 6) crumbs.push(String(nm)); });
        }
        if (n.keywords) String(Array.isArray(n.keywords) ? n.keywords.join(',') : n.keywords).split(/[,;]/).forEach(push);
      });
    }
  } catch (e) {}

  var canon = d.querySelector('link[rel="canonical"]');
  var meta = {
    keywords: keywords,
    siteName: m('og:site_name') || m('application-name') || '',
    breadcrumbs: crumbs,
    author: m('author') || m('article:author') || m('twitter:creator') || '',
    published: m('article:published_time') || m('date') || m('dc.date') || '',
    canonical: canon ? canon.href : '',
    title: d.title || ''
  };

  var mj = JSON.stringify(meta);
  if (mj.length > 3000) { meta.keywords = meta.keywords.slice(0, 4); meta.breadcrumbs = meta.breadcrumbs.slice(0, 3); mj = JSON.stringify(meta); }
  var q = 'url=' + encodeURIComponent(location.href) +
    '&title=' + encodeURIComponent(d.title || '') +
    '&description=' + encodeURIComponent(m('description') || m('og:description') || '') +
    '&selection=' + encodeURIComponent(sel) +
    '&image=' + encodeURIComponent(m('og:image') || m('twitter:image') || '') +
    '&meta=' + encodeURIComponent(mj);
  var w = window.open('http://localhost:__PORT__/add?' + q, 'golinks', 'width=560,height=880,resizable=yes,scrollbars=yes,menubar=no,toolbar=no,location=no,status=no');
  if (!w) { location.href = 'http://localhost:__PORT__/add?' + q; }
})();
