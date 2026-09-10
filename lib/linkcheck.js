'use strict';

// Dead link check. Fetches a link with a short timeout and classifies the outcome:
//   ok: true   reachable (2xx after redirects)
//   ok: false  broken (404/410/451 at once; network errors and 5xx after two failures in a row)
//   ok: null   unverified: sign-in redirect, 401/403, rate limited, or a first transient failure
// SSO pages cannot be verified from the server, so a login redirect never counts as broken.

const { looksLikeLogin, UA } = require('./enrich');
const { hostname } = require('./url');

const GONE = new Set([404, 410, 451]);
const AUTH = new Set([401, 403, 407]);
const MAX_HTML = 64 * 1024;
// Hosts that answer 404 (not 401 or a sign-in redirect) for private content when you are not
// signed in. A 404 from them cannot be told apart from a deleted page, so it stays unverified.
const PRIVATE_404_HOSTS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|notion\.so|notion\.site|figma\.com|dropbox\.com)$/i;

function findTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

// One request, redirects followed. Reads at most MAX_HTML of an HTML body (for login detection).
async function probe(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en' },
    });
    const type = res.headers.get('content-type') || '';
    let html = '';
    if (res.body && (/text\/html|application\/xhtml/i.test(type) || !type)) {
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
        if (size >= MAX_HTML) { try { await reader.cancel(); } catch { /* ignore */ } break; }
      }
      html = Buffer.concat(chunks).toString('utf8');
    } else if (res.body) {
      try { await res.body.cancel(); } catch { /* ignore */ }
    }
    return { status: res.status, finalUrl: res.url || url, html };
  } finally {
    clearTimeout(timer);
  }
}

// Turns a probe result (or a thrown error) into the check record stored on the link.
// prev is the previous record, used for the failure streak.
function classify(url, result, err, prev = {}, now = new Date()) {
  const at = now.toISOString();
  const fails = Number(prev && prev.fails) || 0;
  const base = { at, status: 0, finalUrl: url, redirected: false, fails: 0, ok: null, reason: '' };
  if (err) {
    const streak = fails + 1;
    const code = err.name === 'AbortError' ? 'timeout' : (err.cause && err.cause.code) || err.code || err.message || 'error';
    return { ...base, fails: streak, ok: streak >= 2 ? false : null, reason: String(code).toLowerCase(), error: err.message || String(code) };
  }
  const status = result.status || 0;
  const finalUrl = result.finalUrl || url;
  const redirected = finalUrl !== url;
  const out = { ...base, status, finalUrl, redirected };
  if (status === 404 && PRIVATE_404_HOSTS.test(hostname(finalUrl) || hostname(url))) return { ...out, ok: null, reason: 'private' };
  if (GONE.has(status)) return { ...out, ok: false, fails: fails + 1, reason: 'gone' };
  if (AUTH.has(status)) return { ...out, ok: null, reason: 'auth' };
  if (status === 429) return { ...out, ok: null, reason: 'ratelimit' };
  if (status >= 500) { const streak = fails + 1; return { ...out, fails: streak, ok: streak >= 2 ? false : null, reason: 'server' }; }
  if (redirected && looksLikeLogin({ finalUrl, title: findTitle(result.html), html: result.html })) return { ...out, ok: null, reason: 'login' };
  if (status >= 200 && status < 400) {
    // A 200 on a page that is itself a sign-in screen (same host) still cannot be verified.
    if (looksLikeLogin({ finalUrl, title: findTitle(result.html), html: result.html })) return { ...out, ok: null, reason: 'login' };
    return { ...out, ok: true, reason: '' };
  }
  return { ...out, ok: null, reason: 'http' };
}

async function checkUrl(url, prev, opts = {}) {
  let result = null;
  let err = null;
  try { result = await probe(url, opts.timeoutMs); } catch (e) { err = e; }
  return classify(url, result, err, prev);
}

// Short human label for the UI and the CLI.
function describe(check) {
  if (!check || !check.at) return 'not checked';
  if (check.ok === true) return 'reachable' + (check.redirected ? ' (redirects)' : '');
  if (check.ok === false) return check.reason === 'gone' ? 'HTTP ' + check.status : check.reason === 'server' ? 'server error ' + check.status : 'unreachable (' + (check.reason || 'error') + ')';
  switch (check.reason) {
    case 'login': return 'sign-in page, cannot verify';
    case 'auth': return 'needs sign-in (HTTP ' + check.status + ')';
    case 'private': return 'HTTP 404, private or gone (open it to tell)';
    case 'ratelimit': return 'rate limited, will retry';
    case 'server': return 'server error ' + check.status + ', will retry';
    case 'http': return 'HTTP ' + check.status + ', will retry';
    default: return 'could not reach (' + (check.reason || 'error') + '), will retry';
  }
}

function isBroken(link) { return Boolean(link && link.check && link.check.ok === false); }
function isUnverified(link) { return Boolean(link && link.check && link.check.at && link.check.ok === null); }

module.exports = { probe, classify, checkUrl, describe, isBroken, isUnverified, findTitle };
