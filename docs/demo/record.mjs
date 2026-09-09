// Scripted walkthrough of Golinks in headless Chrome, captured as PNG frames with a caption
// bar and a cursor drawn into the page. Frames are listed in frames.txt for ffmpeg concat.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:7790';
const OUT = process.argv[3];
const FPS = 8;
const W = 1280, H = 800;
const proc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${W},${H}`, '--remote-debugging-port=9370', '--user-data-dir=' + OUT + '/profile', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, id = 0; const waiting = new Map(); const errors = [];
const send = (method, params) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((d) => d.result && d.result.result && d.result.result.value);

// ---- frame capture at a steady rate, in the background
let frame = 0; let recording = false; let capturing = false;
const list = [];
async function grab() {
  if (capturing) return; capturing = true;
  try {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s.result && s.result.data) { const f = `f${String(frame++).padStart(5, '0')}.png`; fs.writeFileSync(`${OUT}/frames/${f}`, Buffer.from(s.result.data, 'base64')); list.push(f); }
  } finally { capturing = false; }
}
let ticker = null;
function startRecording() { recording = true; ticker = setInterval(() => { if (recording) grab(); }, 1000 / FPS); }
function stopRecording() { recording = false; clearInterval(ticker); }

// ---- overlay: caption bar and cursor
const OVERLAY = `(() => {
  if (document.getElementById('demoCap')) return;
  const st = document.createElement('style');
  st.textContent = '#demoCap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);max-width:78%;background:rgba(17,20,26,.92);color:#fff;font:500 17px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,sans-serif;padding:11px 18px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);z-index:9999;pointer-events:none;opacity:0;transition:opacity .25s;letter-spacing:.01em;text-align:center}#demoCap.show{opacity:1}#demoCap b{color:#5fe0b0;font-weight:600}#demoCap kbd{background:#2a313b;border-radius:5px;padding:1px 7px;font:13px ui-monospace,Menlo,monospace;color:#e6e9ee}#demoCur{position:fixed;width:18px;height:18px;border-radius:50%;background:rgba(10,159,120,.85);border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);z-index:10000;pointer-events:none;transform:translate(-50%,-50%);transition:left .05s linear,top .05s linear,transform .1s}#demoCur.down{transform:translate(-50%,-50%) scale(.7);background:#ff8a4c}';
  document.head.appendChild(st);
  const c = document.createElement('div'); c.id = 'demoCap'; document.body.appendChild(c);
  const cur = document.createElement('div'); cur.id = 'demoCur'; cur.style.left = '640px'; cur.style.top = '400px'; document.body.appendChild(cur);
})()`;
async function overlay() { await ev(OVERLAY); }
async function caption(html, ms) {
  await overlay();
  await ev(`(() => { const c = document.getElementById('demoCap'); c.innerHTML = ${JSON.stringify(html)}; c.classList.add('show'); })()`);
  if (ms) await sleep(ms);
}
async function captionOff() { await ev("(() => { const c = document.getElementById('demoCap'); if (c) c.classList.remove('show'); })()"); }

let mouse = { x: 640, y: 400 };
async function moveTo(x, y, ms = 500) {
  const steps = Math.max(6, Math.round(ms / 40));
  const sx = mouse.x, sy = mouse.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease in-out
    mouse = { x: sx + (x - sx) * e, y: sy + (y - sy) * e };
    await ev(`(() => { const c = document.getElementById('demoCur'); if (c) { c.style.left='${mouse.x}px'; c.style.top='${mouse.y}px'; } })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mouse.x, y: mouse.y });
    await sleep(ms / steps);
  }
}
async function click(x, y) {
  await moveTo(x, y);
  await ev("(() => { const c = document.getElementById('demoCur'); if (c) c.classList.add('down'); })()");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await ev("(() => { const c = document.getElementById('demoCur'); if (c) c.classList.remove('down'); })()");
  await sleep(120);
}
const rect = async (sel) => { const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }); })()`); return r ? JSON.parse(r) : null; };
async function clickSel(sel, dx = 0.5, dy = 0.5) { const r = await rect(sel); if (!r) { errors.push('missing ' + sel); return false; } await click(r.x + r.w * dx, r.y + r.h * dy); return true; }
async function hoverSel(sel) { const r = await rect(sel); if (r) await moveTo(r.x + r.w / 2, r.y + r.h / 2); }
async function type(text, perChar = 70) {
  for (const ch of text) { await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }); await sleep(perChar); }
}
async function key(key, code, vk) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }); }
async function nav(hash, ms = 900) { await ev(`location.hash = ${JSON.stringify(hash)}`); await sleep(ms); await overlay(); }

try {
  let targets;
  for (let i = 0; i < 40; i++) { try { targets = await (await fetch('http://127.0.0.1:9370/json')).json(); break; } catch { await sleep(200); } }
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.text); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.navigate', { url: BASE + '/#/' }); await sleep(1800);
  await ev("localStorage.setItem('links.layout','grid'); localStorage.setItem('links.folders.open', JSON.stringify(['dev','learning'])); localStorage.setItem('links.side.width','300');");
  await ev("location.reload()"); await sleep(2200);
  await overlay();
  startRecording();

  // 1. intro
  await caption('<b>Golinks</b> keeps your bookmarks on your own Mac: searchable, with real screenshots, folders and tags.', 4200);
  await moveTo(700, 300, 900);
  await caption('Everything runs from a small local service. The UI is a plain web page, nothing is installed in the browser.', 4000);
  await caption('Cards show a screenshot of the page, the title, one line of description, host, folder and tags.', 1200);
  await hoverSel('.card:nth-child(2)'); await sleep(1400);
  await hoverSel('.card:nth-child(5)'); await sleep(1600);

  // 2. search
  await clickSel('#q');
  await caption('Search matches titles, tags, folders and even <b>initials</b>. Type a few letters and results filter as you go.', 800);
  await type('react'); await sleep(2200);
  await ev("document.querySelector('#q').value=''; document.querySelector('#q').dispatchEvent(new Event('input'))"); await sleep(400);
  await caption('Operators narrow things down: <kbd>tag:docs</kbd>, <kbd>in:dev</kbd>, <kbd>unused:90d</kbd>, <kbd>is:untagged</kbd>.', 600);
  await type('tag:docs'); await sleep(2400);
  await ev("document.querySelector('#q').value=''; document.querySelector('#q').dispatchEvent(new Event('input'))"); await sleep(300);
  await type('in:dev k8s'); await sleep(2400);
  await ev("document.querySelector('#q').value=''; document.querySelector('#q').dispatchEvent(new Event('input'))"); await sleep(500);
  await caption('Abbreviations work as well: <kbd>eda</kbd> finds "Event-driven architecture" by its initials.', 600);
  await type('eda'); await sleep(2400);
  await ev("document.querySelector('#q').value=''; document.querySelector('#q').dispatchEvent(new Event('input'))"); await sleep(500);
  await caption('Arrow keys move, <kbd>Enter</kbd> opens, <kbd>Cmd+Enter</kbd> copies the URL, <kbd>E</kbd> edits.', 600);
  for (let i = 0; i < 4; i++) { await key('ArrowDown', 'ArrowDown', 40); await sleep(450); }
  await sleep(1200);

  // 3. go keywords
  await nav('#/view/keywords', 700);
  await caption('Every link can have a <b>go keyword</b>. In the address bar, type <kbd>:go react</kbd> and you are there. Templates handle <kbd>:go gh nodejs/node</kbd> too.', 5200);
  await nav('#/view/mostused', 700);
  await caption('<b>Recent</b> and <b>Most used</b> rank by how often and how recently you open things. Search results use the same signal.', 3600);

  // 4. sidebar: tags and folders
  await nav('#/', 600);
  await caption('The sidebar shows your most used <b>tags</b> as badges and your <b>folders</b> as a tree. Both have a filter box.', 1200);
  await clickSel('#tagFilter'); await type('de'); await sleep(1600);
  await clickSel('#tagList .tag-badge'); await sleep(1800);
  await ev("(() => { const f = document.querySelector('#tagFilter'); if (f) { f.value=''; f.dispatchEvent(new Event('input')); } })()");
  await caption('Folders nest as deep as you like. Click the chevrons to expand and collapse, or use expand all.', 800);
  await clickSel('[data-tw="Learning"]'); await sleep(900);
  await clickSel('[data-drop-folder="Dev/Docs"]', 0.4); await sleep(1600);
  await caption('A folder view lists its links and those of its subfolders, with <b>Open all</b>, <b>Copy all URLs</b>, rename, subfolder and delete.', 3400);
  await clickSel('[data-drop-folder="Dev"]', 0.4); await sleep(1400);
  await hoverSel('#renameFolder'); await sleep(900);

  // 5. list view and drawer
  await clickSel('[data-layout="list"]'); await sleep(900);
  await caption('List view puts the title, a line of description, host, folder and tags on each row. Hover a row for a large preview.', 1200);
  await hoverSel('.row:nth-child(2) .main'); await sleep(2400);
  await hoverSel('.row:nth-child(4) .main'); await sleep(1600);
  await clickSel('[data-layout="grid"]'); await sleep(700);

  // 6. drag a card to a folder
  await caption('Drag a card onto a folder to move it. A confirmation shows where it goes.', 1000);
  {
    const src = await rect('.card:nth-child(3) .title');
    const dst = await rect('[data-drop-folder="Dev/Tools"]');
    if (src && dst) {
      await moveTo(src.x + 40, src.y + 10, 500);
      await ev("(() => { const c = document.getElementById('demoCur'); if (c) c.classList.add('down'); })()");
      await send('Input.setInterceptDrags', { enabled: true });
      let data = null; const h = (m) => { const d = JSON.parse(m.data); if (d.method === 'Input.dragIntercepted') data = d.params.data; };
      ws.addEventListener('message', h);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mouse.x, y: mouse.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 6; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mouse.x + i * 3, y: mouse.y + i * 2, button: 'left', buttons: 1 }); await sleep(40); }
      await sleep(200);
      if (data) {
        const tx = dst.x + 60, ty = dst.y + dst.h / 2;
        const steps = 18; const sx = mouse.x, sy = mouse.y;
        for (let i = 1; i <= steps; i++) { const x = sx + (tx - sx) * i / steps, y = sy + (ty - sy) * i / steps; await ev(`(() => { const c = document.getElementById('demoCur'); if (c) { c.style.left='${x}px'; c.style.top='${y}px'; } })()`); await send('Input.dispatchDragEvent', { type: i === 1 ? 'dragEnter' : 'dragOver', x, y, data }); await sleep(45); }
        await sleep(500);
        await send('Input.dispatchDragEvent', { type: 'drop', x: tx, y: ty, data });
        mouse = { x: tx, y: ty };
      }
      ws.removeEventListener('message', h);
      await send('Input.setInterceptDrags', { enabled: false });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mouse.x, y: mouse.y, button: 'left', clickCount: 1 });
      await ev("(() => { const c = document.getElementById('demoCur'); if (c) c.classList.remove('down'); })()");
      await sleep(900);
      await caption('Folders can be dragged too, onto another folder or to the top level.', 600);
      await clickSel('#modalOk'); await sleep(1400);
    }
  }

  // 7. edit drawer with suggestions
  await caption('Open a link to edit it. Tags, folder and keyword get <b>suggestions</b> from the URL, the page and your other links.', 800);
  await clickSel('.card:nth-child(1) [data-edit]'); await sleep(2000);
  await hoverSel('#fTags .chips-suggest .chip'); await sleep(1400);
  await hoverSel('#fSugKeywords [data-i], #fSugFolders [data-i]'); await sleep(1400);
  await caption('<b>From browser tab</b> takes a real screenshot through your own browser, so pages behind sign-in work too.', 3000);
  await hoverSel('#dSnapBrowser'); await sleep(1400);
  await hoverSel('#dSnapRefresh'); await sleep(600);
  await clickSel('#dClose'); await sleep(600);

  // 8. add page
  await nav('#/add', 900);
  await caption('Adding a link: paste a URL and the title, description and preview image are fetched. The <b>bookmarklet</b> does the same from any page, with a screenshot.', 800);
  await clickSel('#aUrl'); await ev("document.querySelector('#aUrl').focus()");
  await type('https://developer.mozilla.org/en-US/docs/Web/CSS', 35);
  await key('Enter', 'Enter', 13);
  for (let i = 0; i < 30; i++) { await sleep(300); if (await ev("!!document.querySelector('#aSugKeywords [data-i], #aSugFolders [data-i]')")) break; }
  await sleep(1200);
  await caption('Suggested tags, folder and keyword appear as chips. Nothing is applied until you click.', 1200);
  await clickSel('#aTags .chips-suggest .chip'); await sleep(900);
  await clickSel('#aSugFolders [data-i]'); await sleep(1100);
  await clickSel('#aSugKeywords [data-i]'); await sleep(1400);
  await caption('Save, and the new link opens in its drawer with the preview image already fetched.', 600);
  await clickSel('#aSave'); await sleep(2600);
  await clickSel('#dClose'); await sleep(500);

  // 9. settings: export
  await nav('#/settings/setup', 1400);
  await caption('Setup is a short checklist: the <kbd>:go</kbd> address bar shortcut, the bookmarklet, and screen recording permission for real screenshots.', 4200);
  await nav('#/settings/export', 1200);
  await caption('<b>Export</b> writes Golinks JSON, browser bookmarks HTML, CSV, Excel, Markdown or plain URLs, for everything or one folder or tag.', 3600);
  await clickSel('#xShow'); await sleep(1800);
  await caption('Or list just the URLs on the page and copy them to the clipboard.', 2600);
  await nav('#/settings/import', 1000);
  await caption('<b>Import</b> reads browser profiles and every one of those formats back, with a preview and duplicate detection. Screenshots are captured through your browser afterwards.', 4400);

  // 10. outro
  await nav('#/', 900);
  await moveTo(700, 380, 800);
  await caption('<b>Golinks</b>: install in two minutes, your data stays in a folder you own. See the README for setup.', 5000);
  await captionOff(); await sleep(600);
  stopRecording();
  await sleep(300);
  fs.writeFileSync(`${OUT}/frames.txt`, list.map((f) => `file '${OUT}/frames/${f}'\nduration ${(1 / FPS).toFixed(4)}`).join('\n') + `\nfile '${OUT}/frames/${list[list.length - 1]}'\n`);
  console.log('frames:', list.length, 'seconds:', (list.length / FPS).toFixed(1), '| issues:', errors.length ? errors.join(' | ') : 'none');
} finally { if (ws) ws.close(); proc.kill(); }
