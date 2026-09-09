// JXA (osascript -l JavaScript): list browser windows (all Spaces, minimised included)
// with their CGWindow ids and whether they are on screen. The window name equals the
// active tab title, which lets us match a tab to a window id and capture that window
// even when another window covers it.
ObjC.import('CoreGraphics');
const opts = $.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements;
const list = $.CGWindowListCopyWindowInfo(opts, $.kCGNullWindowID);
const nsarr = ObjC.castRefToObject(list);
const n = nsarr.count;
const out = [];
for (let i = 0; i < n; i++) {
  const d = nsarr.objectAtIndex(i);
  const owner = ObjC.unwrap(d.objectForKey('kCGWindowOwnerName')) || '';
  const layer = ObjC.unwrap(d.objectForKey('kCGWindowLayer'));
  if (layer !== 0) continue;
  if (!/^(Brave Browser|Google Chrome|Microsoft Edge|Chromium|Safari|Arc)$/.test(owner)) continue;
  out.push({
    id: ObjC.unwrap(d.objectForKey('kCGWindowNumber')),
    owner,
    pid: ObjC.unwrap(d.objectForKey('kCGWindowOwnerPID')),
    name: ObjC.unwrap(d.objectForKey('kCGWindowName')) || '',
    onscreen: Boolean(ObjC.unwrap(d.objectForKey('kCGWindowIsOnscreen'))),
    bounds: ObjC.deepUnwrap(d.objectForKey('kCGWindowBounds')),
  });
}
JSON.stringify(out);
