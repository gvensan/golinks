'use strict';

// Snapshots: base64 uploads from the Shortcut or web UI, og:image download,
// headless Chrome screenshot for public pages, generated SVG tile fallback.
// Image resizing and JPEG conversion use macOS sips (already on the machine).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { hostname, domainLabel } = require('./url');
const { UA } = require('./enrich');

const { HOME_DIR } = require('./store');
const SNAP_DIR = path.join(HOME_DIR, 'snapshots');
const WIDTH = 480;

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function ensureDir() {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
}

function chromeBinary() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

function hasSips() {
  return fs.existsSync('/usr/bin/sips');
}

function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 6 && buf.toString('ascii', 0, 6) === 'GIF8') return 'gif';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 300)).trim().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}

function removeAll(id) {
  ensureDir();
  for (const f of fs.readdirSync(SNAP_DIR)) {
    if (f.startsWith(id + '.')) {
      try { fs.unlinkSync(path.join(SNAP_DIR, f)); } catch { /* ignore */ }
    }
  }
}

// Resize to WIDTH and convert to JPEG with sips. Falls back to keeping the original.
function normalizeImage(srcPath, id) {
  ensureDir();
  const out = path.join(SNAP_DIR, `${id}.jpg`);
  if (hasSips()) {
    const r = spawnSync('/usr/bin/sips', ['-Z', String(WIDTH * 2), '-s', 'format', 'jpeg', '-s', 'formatOptions', '78', srcPath, '--out', out], { timeout: 20000 });
    if (r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) return `snapshots/${id}.jpg`;
  }
  const ext = sniff(fs.readFileSync(srcPath)) || 'bin';
  const keep = path.join(SNAP_DIR, `${id}.${ext}`);
  fs.copyFileSync(srcPath, keep);
  return `snapshots/${id}.${ext}`;
}

function tmpFile(ext) {
  return path.join(os.tmpdir(), `golinks-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

function saveBuffer(id, buf) {
  const kind = sniff(buf);
  if (!kind) throw new Error('unrecognized image data');
  removeAll(id);
  ensureDir();
  if (kind === 'svg') {
    const p = path.join(SNAP_DIR, `${id}.svg`);
    fs.writeFileSync(p, buf);
    return `snapshots/${id}.svg`;
  }
  const tmp = tmpFile(kind);
  fs.writeFileSync(tmp, buf);
  try {
    return normalizeImage(tmp, id);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// Accepts a data: URL or raw base64.
function saveFromBase64(id, data) {
  let b64 = String(data || '');
  const m = /^data:[^;,]+;base64,(.*)$/s.exec(b64);
  if (m) b64 = m[1];
  const buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  if (!buf.length) throw new Error('empty snapshot');
  return saveBuffer(id, buf);
}

async function fetchBytes(url, limit = 6 * 1024 * 1024, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'image/*,*/*;q=0.5' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('image too large'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

async function saveFromImageUrl(id, imageUrl) {
  const buf = await fetchBytes(imageUrl);
  const kind = sniff(buf);
  if (!kind) throw new Error('not an image');
  return saveBuffer(id, buf);
}

// Headless Chrome screenshot. Returns the relative snapshot path or throws.
function headless(id, url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const bin = chromeBinary();
    if (!bin) return reject(new Error('no Chrome binary found'));
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golinks-chrome-'));
    const shot = tmpFile('png');
    const args = [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--mute-audio', '--virtual-time-budget=6000',
      `--user-data-dir=${userDir}`, `--window-size=1280,800`, `--screenshot=${shot}`, url,
    ];
    const child = spawn(bin, args, { stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); cleanup(); reject(err); });
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        if (!fs.existsSync(shot) || fs.statSync(shot).size === 0) throw new Error('headless screenshot failed');
        const rel = normalizeImage(shot, id);
        resolve(rel);
      } catch (err) {
        reject(err);
      } finally {
        cleanup();
      }
    });
    function cleanup() {
      try { fs.unlinkSync(shot); } catch { /* ignore */ }
      try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
}

// ---- generated tile ----

function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function tileSvg(url, title, faviconDataUri) {
  const host = hostname(url).replace(/^www\./, '') || 'link';
  const label = domainLabel(url) || host;
  const hue = hashHue(host);
  const letter = (label[0] || '?').toUpperCase();
  const t = escapeXml(String(title || '').slice(0, 60));
  const icon = faviconDataUri
    ? `<image href="${faviconDataUri}" x="32" y="32" width="56" height="56"/>`
    : `<circle cx="60" cy="60" r="30" fill="hsl(${hue} 60% 40%)"/><text x="60" y="72" font-size="34" font-weight="700" text-anchor="middle" fill="#fff" font-family="-apple-system, Helvetica, Arial, sans-serif">${escapeXml(letter)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 22%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 50% 34%)"/></linearGradient></defs>
<rect width="480" height="300" fill="url(#g)"/>
${icon}
<text x="32" y="150" font-size="22" fill="#fff" fill-opacity="0.92" font-family="-apple-system, Helvetica, Arial, sans-serif" font-weight="600">${escapeXml(host)}</text>
<text x="32" y="184" font-size="16" fill="#fff" fill-opacity="0.75" font-family="-apple-system, Helvetica, Arial, sans-serif">${t}</text>
</svg>
`;
}

async function faviconDataUri(faviconUrl) {
  if (!faviconUrl) return '';
  try {
    const buf = await fetchBytes(faviconUrl, 200 * 1024, 5000);
    const kind = sniff(buf);
    const mime = kind === 'jpg' ? 'image/jpeg' : kind === 'png' ? 'image/png' : kind === 'svg' ? 'image/svg+xml' : kind === 'gif' ? 'image/gif' : kind === 'webp' ? 'image/webp' : buf[0] === 0 && buf[1] === 0 && buf[2] === 1 ? 'image/x-icon' : null;
    if (!mime) return '';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

async function saveTile(id, url, title, faviconUrl) {
  removeAll(id);
  ensureDir();
  let iconUrl = faviconUrl;
  if (!iconUrl) { try { iconUrl = new URL('/favicon.ico', url).toString(); } catch { iconUrl = ''; } }
  const icon = await faviconDataUri(iconUrl);
  const p = path.join(SNAP_DIR, `${id}.svg`);
  fs.writeFileSync(p, tileSvg(url, title, icon));
  return `snapshots/${id}.svg`;
}

// Best effort in order: og:image, headless Chrome (public, non-login pages), tile.
// info comes from enrich(); returns { snapshot, method }.
async function captureBest(id, url, info = {}, opts = {}) {
  const attempts = [];
  if (info.ogImage) {
    try { return { snapshot: await saveFromImageUrl(id, info.ogImage), method: 'og:image' }; } catch (err) { attempts.push('og:image: ' + err.message); }
  }
  const publicPage = info.fetched && !info.loginDetected && info.status && info.status < 400;
  if (opts.headless !== false && publicPage) {
    try { return { snapshot: await headless(id, url), method: 'headless' }; } catch (err) { attempts.push('headless: ' + err.message); }
  }
  try {
    return { snapshot: await saveTile(id, url, info.title, info.favicon), method: 'tile', attempts };
  } catch (err) {
    attempts.push('tile: ' + err.message);
    return { snapshot: null, method: 'none', attempts };
  }
}

module.exports = { SNAP_DIR, saveFromBase64, saveFromImageUrl, headless, saveTile, captureBest, removeAll, chromeBinary, tileSvg };
