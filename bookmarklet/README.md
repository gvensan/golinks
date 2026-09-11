# Golinks bookmarklet

The bookmarklet is the capture path that works even when Chrome automation or
screen recording permission is blocked. It runs in the page you are looking at,
so it sees SSO pages exactly as you do, and it opens a small popup served by the
local service where you confirm title and tags.

## Install

1. Open the web UI, go to Setup checklist (or Settings).
2. Drag the "Golinks" button to the bookmarks bar of any browser.
   Alternatively copy the `javascript:` URL shown there and create a bookmark
   with it as the address.

## What it sends

Only to `http://localhost:<port>/add`: the page URL, the document title, the
meta description, up to 500 characters of selected text (saved as notes), and
the `og:image` URL if the page declares one. Nothing leaves the machine.

The popup page suggests tags from `data/rules.json`, warns if the URL is already
saved, and saves with one click or Cmd+Enter.

While the popup is open, the service screenshots the browser window behind it
(the one whose active tab is the page you clicked from) and shows the preview in
the popup. That screenshot becomes the snapshot when you save. It needs the
Automation and Screen Recording permissions described in the top-level README;
until they are granted the popup says why and falls back to og:image or a tile.
