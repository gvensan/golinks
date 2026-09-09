'use strict';

// Server-side page enrichment for public pages: title, description, og:image,
// favicon, login-page detection. Never used for SSO pages by design; the
// caller decides, and login detection guards against saving a sign-in screen.

const { suggestTags } = require('./rules');
const { cleanUrl } = require('./url');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Golinks/1.0';
const MAX_BYTES = 600 * 1024;

const LOGIN_HOST = /(^|\.)(login|sso|auth|signin|accounts|okta|auth0|id|idp|adfs|sts)\./i;
const LOGIN_PATH = /\/(login|signin|sign-in|sso|saml|oauth2?|authorize|auth|idp|account\/login)(\/|\?|$)/i;
const LOGIN_TITLE = /\b(sign in|log in|login|signin|authenticate|authentication|okta|single sign[- ]on|sso)\b/i;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ').trim();
}

function metaContent(html, name) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i');
  const tag = re.exec(html);
  if (!tag) return '';
  const c = /content=["']([^"']*)["']/i.exec(tag[0]);
  return c ? decodeEntities(c[1]) : '';
}

function findTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]) : '';
}

function findFavicon(html, base) {
  const links = html.match(/<link[^>]+>/gi) || [];
  let best = null;
  for (const tag of links) {
    const rel = /rel=["']([^"']*)["']/i.exec(tag);
    if (!rel || !/icon/i.test(rel[1])) continue;
    const href = /href=["']([^"']*)["']/i.exec(tag);
    if (!href) continue;
    try { best = new URL(decodeEntities(href[1]), base).toString(); } catch { /* ignore */ }
    if (/apple-touch/i.test(rel[1])) break;
  }
  if (!best) {
    try { best = new URL('/favicon.ico', base).toString(); } catch { /* ignore */ }
  }
  return best;
}

async function fetchText(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en' },
    });
    const type = res.headers.get('content-type') || '';
    let text = '';
    if (/text\/html|application\/xhtml/i.test(type) || !type) {
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
        if (size >= MAX_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } break; }
      }
      text = Buffer.concat(chunks).toString('utf8');
    }
    return { ok: res.ok, status: res.status, finalUrl: res.url || url, contentType: type, html: text };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeLogin({ finalUrl, title, html }) {
  try {
    const u = new URL(finalUrl);
    if (LOGIN_HOST.test(u.hostname) || LOGIN_PATH.test(u.pathname)) return true;
  } catch { /* ignore */ }
  if (title && LOGIN_TITLE.test(title)) return true;
  if (html && /<input[^>]+type=["']password["']/i.test(html) && !/<article|<main/i.test(html)) return true;
  return false;
}

// opts.fetch=false -> rules only, no network. Used by the bookmarklet popup and the Shortcut.
async function enrich(url, rules, opts = {}) {
  const clean = cleanUrl(url);
  if (!clean) return { error: 'invalid url' };
  const { tags, suggested } = suggestTags(clean, rules);
  const out = { url: clean, finalUrl: clean, title: '', description: '', ogImage: '', favicon: '', tags, suggestedTags: suggested, fetched: false, loginDetected: false, status: 0 };
  if (opts.fetch === false) return out;
  try {
    const res = await fetchText(clean, opts.timeoutMs);
    out.fetched = true;
    out.status = res.status;
    out.finalUrl = res.finalUrl;
    if (res.html && res.ok) {
      out.title = metaContent(res.html, 'og:title') || findTitle(res.html);
      out.description = metaContent(res.html, 'description') || metaContent(res.html, 'og:description') || '';
      const og = metaContent(res.html, 'og:image') || metaContent(res.html, 'twitter:image');
      if (og) { try { out.ogImage = new URL(og, res.finalUrl).toString(); } catch { /* ignore */ } }
      out.favicon = findFavicon(res.html, res.finalUrl) || '';
    }
    out.loginDetected = looksLikeLogin({ finalUrl: res.finalUrl, title: out.title, html: res.html });
    if (out.loginDetected) {
      // Do not keep data from a sign-in page.
      out.title = '';
      out.description = '';
      out.ogImage = '';
    }
    if (!res.ok && res.status >= 400) out.error = `HTTP ${res.status}`;
  } catch (err) {
    out.error = err.name === 'AbortError' ? 'timeout' : err.message;
  }
  return out;
}

module.exports = { enrich, looksLikeLogin, decodeEntities, UA };
