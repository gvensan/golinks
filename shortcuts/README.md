# Hotkeys and menu bar

The menu bar icon (installed by `bin/golinks install`) already gives you search,
add current tab, open, start and stop. Apple Shortcuts are only needed for
**global hotkeys**, because a script cannot register system-wide keys.

## The two Shortcuts

Each is a single **Run Shell Script** action (shell: zsh). The commands use the
stable `~/.golinks` link, so they are identical on every machine.

**Links: search**, hotkey Ctrl+Option+L

```
~/.golinks/bin/golinks search
```

**Links: add current tab**, hotkey Ctrl+Option+A

```
~/.golinks/bin/golinks add-tab
```

Build them once in the Shortcuts app: `+`, add "Run Shell Script", paste the
command, name the Shortcut, open its details (`i`) and set the keyboard
shortcut. "Pin in Menu Bar" is optional since the icon already exists.

### Sharing the Shortcuts with colleagues

Shortcuts can only be created in the app, but they can be exported and signed
so others import them with a double-click:

```
shortcuts sign --mode anyone -i "Links: search.shortcut" -o shortcuts/Links-search.shortcut
shortcuts sign --mode anyone -i "Links: add current tab.shortcut" -o shortcuts/Links-add-current-tab.shortcut
```

Export from the Shortcuts app first (right-click the Shortcut, Share, Export
File, untick iCloud). Commit the signed files to this folder; importers still
set the hotkeys themselves.

## What the scripts do

| Command | Behaviour |
| --- | --- |
| `golinks search [words]` | Dialog asks for a query. Exact keyword or template opens at once, otherwise a pick list. Opens through `/open/:id` so use counts update. Offers to start the service if it is down. |
| `golinks add-tab` | Reads the active tab of the frontmost browser (Chrome, Brave, Edge, Chromium, Safari), screenshots the window below the toolbar, asks for tags with rule suggestions, saves. For an already saved page it offers to refresh the snapshot. |
| `golinks service start\|stop\|toggle\|status` | Used by the menu bar icon. |

Flags for `add-tab`: `--no-shot`, `--no-ask`, `--revisit` (refresh the snapshot
of an existing link and exit), `--app "Brave Browser"`. `LINKS_TOP_CROP`
(default 87) is the browser chrome height cropped from the screenshot.

## Permissions

The first run triggers macOS prompts for the process that runs the script:
Shortcuts when started from a Shortcut, `osascript` when started from the menu
bar icon.

| Prompt | Where to check |
| --- | --- |
| "... wants access to control Google Chrome" (Automation) | System Settings > Privacy & Security > Automation |
| Screen Recording | System Settings > Privacy & Security > Screen & System Audio Recording |
| Notifications | System Settings > Notifications |

If Screen Recording is blocked by device management, add `--no-shot` to the
add-tab command; saving still works and the snapshot falls back to og:image or a
tile. The bookmarklet route (screenshots taken by the `node` service) is
independent of this.
