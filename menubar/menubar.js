// Golinks menu bar icon. Plain JXA run by the system's osascript, no app bundle,
// no compiled code. Started by launchd (see launchd/dev.golinks.menubar.plist.tmpl).
//
//   osascript -l JavaScript menubar/menubar.js
//
// Menu: search, add current tab, open web UI, service start/stop, quit icon.
ObjC.import('Cocoa');
ObjC.import('Foundation');

const ROOT = (() => {
  // Directory of this script: ROOT/menubar/menubar.js
  const argv = ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments);
  const me = argv.find((a) => /menubar\.js$/.test(a)) || '';
  const dir = me ? $.NSString.stringWithString(me).stringByDeletingLastPathComponent.stringByDeletingLastPathComponent.js : $.NSFileManager.defaultManager.currentDirectoryPath.js;
  return dir;
})();
const HOME_DIR = $.NSProcessInfo.processInfo.environment.objectForKey('LINKS_HOME').js || ROOT;

function readPort() {
  const env = $.NSProcessInfo.processInfo.environment.objectForKey('LINKS_PORT');
  if (!env.isNil() && Number(env.js)) return Number(env.js);
  try {
    const text = $.NSString.stringWithContentsOfFileEncodingError(`${HOME_DIR}/data/settings.json`, $.NSUTF8StringEncoding, null).js;
    return JSON.parse(text).port || 7777;
  } catch (e) { return 7777; }
}
const PORT = readPort();
const BASE = `http://127.0.0.1:${PORT}`;

function httpGet(url, timeoutSec = 1.5) {
  const req = $.NSMutableURLRequest.requestWithURL($.NSURL.URLWithString(url));
  req.setTimeoutInterval(timeoutSec);
  const err = Ref();
  const resp = Ref();
  const data = $.NSURLConnection.sendSynchronousRequestReturningResponseError(req, resp, err);
  if (data.isNil()) return null;
  return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
}

function serviceUp() {
  return Boolean(httpGet(`${BASE}/api/health`));
}

function run(args) {
  // Fire and forget a helper; the helpers show their own dialogs and notifications.
  const task = $.NSTask.alloc.init;
  task.setLaunchPath(`${ROOT}/bin/golinks`);
  task.setArguments(args);
  task.setStandardOutput($.NSFileHandle.fileHandleWithNullDevice);
  task.setStandardError($.NSFileHandle.fileHandleWithNullDevice);
  try { task.launch; } catch (e) { /* ignore */ }
}

function openUrl(url) {
  $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(url));
}

if (!$.LinksMenuController) {
  ObjC.registerSubclass({
    name: 'LinksMenuController',
    superclass: 'NSObject',
    protocols: ['NSMenuDelegate'],
    methods: {
      'search:': { types: ['void', ['id']], implementation: function () { run(['search']); } },
      'addTab:': { types: ['void', ['id']], implementation: function () { run(['add-tab']); } },
      'openUI:': { types: ['void', ['id']], implementation: function () { openUrl(`${BASE}/`); } },
      'openAdd:': { types: ['void', ['id']], implementation: function () { openUrl(`${BASE}/#/add`); } },
      'openSettings:': { types: ['void', ['id']], implementation: function () { openUrl(`${BASE}/#/settings`); } },
      'toggleService:': { types: ['void', ['id']], implementation: function () { run(['service', 'toggle']); } },
      'quitIcon:': { types: ['void', ['id']], implementation: function () { $.NSApplication.sharedApplication.terminate(null); } },
      'menuNeedsUpdate:': {
        types: ['void', ['id']],
        implementation: function (menu) {
          const up = serviceUp();
          const status = menu.itemWithTag(1);
          status.setTitle(up ? `Service running on :${PORT}` : 'Service stopped');
          const toggle = menu.itemWithTag(2);
          toggle.setTitle(up ? 'Stop service' : 'Start service');
          const needs = menu.itemWithTag(3);
          needs.setEnabled(up);
        },
      },
    },
  });
}

const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);

const controller = $.LinksMenuController.alloc.init;
const item = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
let image = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription('link', 'Golinks');
if (image.isNil()) image = $.NSImage.imageNamed('NSLinkTemplate');
if (!image.isNil()) { image.setTemplate(true); item.button.setImage(image); } else { item.button.setTitle('Links'); }
item.button.setToolTip('Golinks');

const menu = $.NSMenu.alloc.initWithTitle('Golinks');
menu.setAutoenablesItems(false);
menu.setDelegate(controller);

function add(title, action, key, tag) {
  const mi = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, action ? action : null, key || '');
  if (action) mi.setTarget(controller);
  if (tag) mi.setTag(tag);
  mi.setEnabled(true);
  menu.addItem(mi);
  return mi;
}

const status = add('Service', null, '', 1);
status.setEnabled(false);
menu.addItem($.NSMenuItem.separatorItem);
add('Search links', 'search:', 'l');
add('Add current tab with screenshot', 'addTab:', 'a');
add('Add a link', 'openAdd:', '');
menu.addItem($.NSMenuItem.separatorItem);
add('Open Golinks', 'openUI:', 'o').setTag(3);
add('Settings', 'openSettings:', '');
add('Start service', 'toggleService:', '', 2);
menu.addItem($.NSMenuItem.separatorItem);
add('Quit menu bar icon', 'quitIcon:', 'q');

item.setMenu(menu);
app.run;
