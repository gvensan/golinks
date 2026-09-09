// "Add to Links" bookmarklet source. The service serves a minified javascript: URL
// at GET /api/bookmarklet with __PORT__ filled in. Keep this file free of
// single-line comments at the end of code lines; the minifier drops whole-line
// comments only.
(function () {
  var d = document;
  var m = function (n) {
    var e = d.querySelector('meta[property="' + n + '"],meta[name="' + n + '"]');
    return e ? e.content : '';
  };
  var sel = String(window.getSelection ? window.getSelection() : '').slice(0, 500);
  var q = 'url=' + encodeURIComponent(location.href) +
    '&title=' + encodeURIComponent(d.title || '') +
    '&description=' + encodeURIComponent(m('description') || m('og:description') || '') +
    '&selection=' + encodeURIComponent(sel) +
    '&image=' + encodeURIComponent(m('og:image') || m('twitter:image') || '');
  var w = window.open('http://localhost:__PORT__/add?' + q, 'golinks', 'width=540,height=700,menubar=no,toolbar=no,location=no,status=no');
  if (!w) { location.href = 'http://localhost:__PORT__/add?' + q; }
})();
