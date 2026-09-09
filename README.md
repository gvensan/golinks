# Golinks

Smart bookmarks for macOS that stay on your machine. Type `go expenses` in the
address bar, press one hotkey to save the current tab with a screenshot, search
everything from a menu bar icon, and keep SSO pages (SharePoint, Confluence,
Jira) with real thumbnails because the screenshots are taken in your own browser.

No app is installed and nothing is compiled: a small Node service runs as a
login agent, the UI is a local web page, the menu bar icon is a script. Your data
is plain JSON and JPEG files in this folder.

## Install (2 minutes)

Requirements: macOS, Node 18 or newer (nvm or `brew install node`), Chrome,
Brave, Edge or Safari.

```
git clone git@github.com:gvensan/golinks.git ~/golinks
cd ~/golinks
./install.sh
```

This links the right Node, registers the service to start at login, adds the
menu bar icon, and opens the setup checklist at http://localhost:7777/#/setup.
The checklist walks you through the remaining one-time steps:

1. **Address bar go-links**: add a site search named `Go Links` with shortcut
   `go` and URL `http://localhost:7777/go/%s` (Chrome, Brave and Edge; Safari
   has no site search).
2. **Bookmarklet**: drag "Add to Links" to your bookmarks bar.
3. **Screen Recording for `node`**: System Settings > Privacy & Security >
   Screen & System Audio Recording, enable `node` (the checklist shows the exact
   path to add if it is not listed). Automation permission is requested
   automatically the first time. Then `bin/golinks restart`.
4. **Hotkeys** (optional): two Apple Shortcuts, see `shortcuts/README.md`.
5. **Import** your existing bookmarks from the Import page.

Check everything with `bin/golinks doctor`. Remove everything with
`./uninstall.sh` (your data stays in the folder) or `./uninstall.sh --purge`
(deletes your links and snapshots too).

## Daily use

| Want to | Do |
| --- | --- |
| Open a link fast | Address bar: `go expenses`, `go jira PROJ-123`, `go event portal` |
| Save the page you are on, with screenshot | Click the bookmarklet, or menu bar icon > Add current tab, or Ctrl+Option+A |
| Search from anywhere | Menu bar icon > Search links, or Ctrl+Option+L |
| Browse, edit, tag | Menu bar icon > Open Golinks (or http://localhost:7777) |
| Save from a script | `curl -X POST localhost:7777/api/links -H 'content-type: application/json' -d '{"url":"https://..."}'` |

Web UI keys: arrows move, Enter opens, Cmd+Enter copies the URL, `E` edits,
`L` toggles list and grid, `N` adds, `/` focuses search, Esc closes. Every row
has Edit, Copy and Delete buttons. Hover the `i` next to a field for help.

Search operators: `tag:jira`, `site:atlassian`, `col:onboarding`, `unused:90d`,
`added:7d`, `is:untagged`, `is:stale`, `is:keyword`. Abbreviations match
initials, so `ep` finds "Event Portal design".

**Go keyword**: give a link a short unique name in the edit drawer, then
`go name` opens it directly. **Templates** (Settings) add parameterized ones:
`go jira PROJ-123`, `go conf event portal`. Anything else runs a search and
opens the best match when it is confident, otherwise the UI with results.

## Snapshots

Preference order: a screenshot of your own browser window (the bookmarklet
popup, the Add page and the drawer's "From browser tab" button ask the service
to capture the window whose active tab shows the URL), then the page's og:image,
then headless Chrome for public pages, then a generated tile. Screenshots are
cropped below the toolbar and resized to 960 px JPEG with the system `sips`.

## Commands

```
bin/golinks status | doctor | logs        health, permission checks, log tail
bin/golinks stop | start | restart        control the service
bin/golinks update                        git pull, refresh node link, restart
bin/golinks menubar install|start|stop    menu bar icon
bin/golinks install [--no-menubar]        (re)install the agents
./uninstall.sh [--purge]                  remove agents and links; --purge also deletes your data
```

The service starts at every login. A crash restarts it within seconds; a
deliberate stop (UI, menu bar, `golinks stop`) stays stopped until login or
`start`. When code changes on disk the UI shows "restart needed".

## Where things live

```
server.js, lib/        service: store, search, rules, enrich, snapshots, capture, importer
public/                web UI (no build step)
menubar/menubar.js     menu bar icon (JXA, run by osascript)
shortcuts/             Shortcut helper scripts and setup notes
bookmarklet/           bookmarklet source and notes
launchd/               plist templates rendered by golinks install
data/defaults/         shipped tagging rules and go-link templates (copied on first run)
data/                  YOUR links.json, settings.json, rules.json, templates.json (git ignored)
snapshots/             YOUR thumbnails (git ignored)
~/.golinks        symlink to this folder, used by the Shortcuts
~/Library/LaunchAgents/dev.golinks*.plist   the two login agents
```

Personal data is git-ignored so the code repo can be shared. To sync your own
links between machines, make `data/` and `snapshots/` a private repo of their
own, or set `LINKS_HOME=/path` before `golinks install` to keep them elsewhere
(for example in a synced folder).

## HTTP API

```
GET  /go/:text                 omnibox redirect       GET  /open/:id           record use, redirect
GET  /api/health  /api/meta  /api/doctor
GET  /api/search?q=&tag=&collection=&view=&limit=
GET|POST /api/links            GET|PUT|DELETE /api/links/:id     POST /api/links/:id/use
POST /api/links/:id/snapshot   {snapshot: base64} | {imageUrl} | {mode:"browser"} | {mode:"tile"} | {}
DELETE /api/links/:id/snapshot
POST /api/capture {url}        screenshot of the browser window showing url (data URL)
POST /api/enrich {url, fetch?}
GET  /api/import/sources       POST /api/import/chrome  POST /api/import/text  POST /api/import/commit
GET|PUT /api/settings /api/rules /api/templates      POST /api/tags/rename     GET /api/bookmarklet
POST /quit
```

`POST /api/links` accepts `url, title, description, tags, aliases, keyword,
notes, collection, snapshot (base64), snapshotUrl, snapshotMode (auto|tile|none),
source, enrich (false skips the page fetch), force`. Duplicates return 409 with
the existing link. The service binds 127.0.0.1 only and rejects cross-origin
writes.

## Development

`npm test` runs the unit tests. `bin/golinks run` starts the server in the
foreground. `PLAN.md` has the original design and constraints.
