'use strict';

// URL helpers: cleaning, dedupe keys, hostnames.

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|mc_cid|mc_eid|igshid|ref_src|_hsenc|_hsmi|hsCtaTracking|yclid|msclkid)$/i;

function parse(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[\w.-]+\.[a-z]{2,}([/:?#]|$)/i.test(s)) s = 'https://' + s;
    else return null;
  }
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u;
  } catch {
    return null;
  }
}

// Clean a URL for storage: lowercase host, drop tracking params, keep everything else.
function cleanUrl(input) {
  const u = parse(input);
  if (!u) return null;
  u.hostname = u.hostname.toLowerCase();
  const drop = [];
  for (const k of u.searchParams.keys()) if (TRACKING_PARAMS.test(k)) drop.push(k);
  for (const k of drop) u.searchParams.delete(k);
  return u.toString();
}

// Key used for duplicate detection. Ignores scheme, www., fragment, trailing slash, param order.
function dedupeKey(input) {
  const u = parse(input);
  if (!u) return null;
  let host = u.hostname.toLowerCase().replace(/^www\./, '');
  let path = u.pathname.replace(/\/+$/, '') || '/';
  const params = [];
  for (const [k, v] of u.searchParams.entries()) if (!TRACKING_PARAMS.test(k)) params.push(k + '=' + v);
  params.sort();
  return host + path + (params.length ? '?' + params.join('&') : '');
}

function hostname(input) {
  const u = parse(input);
  return u ? u.hostname.toLowerCase() : '';
}

// "docs.example.com" -> "example", "acme.atlassian.net" -> "atlassian"
function domainLabel(input) {
  const host = hostname(input).replace(/^www\./, '');
  if (!host) return '';
  const parts = host.split('.');
  if (parts.length >= 2) {
    // handle co.uk style suffixes loosely
    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];
    if (parts.length >= 3 && secondLast.length <= 3 && last.length <= 3) return parts[parts.length - 3];
    return secondLast;
  }
  return parts[0];
}

module.exports = { parse, cleanUrl, dedupeKey, hostname, domainLabel };
