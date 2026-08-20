# Testing

Two layers: the marker-engine unit tests, and a browser harness for exercising
the extension against live Trello (the only way to test the DOM behaviour —
threading, guides, collapse, the composer/mention path, tombstones).

## Unit tests

```
node test/roundtrip.test.js
```

Covers the marker engine: injection across every request shape Trello uses,
`@mention` de-duplication, full encode → API → decode round-trips, and the
live-WebSocket path (frame harvesting, author resolution from
`display.entities`, and that patching `WebSocket` preserves `instanceof` and
the readyState constants).

## Automated browser suite

`test/browser/` drives two logged-in accounts against live Trello over CDP.

```
powershell -ExecutionPolicy Bypass -File test/browser/relaunch.ps1   # start/restart both browsers
node test/browser/01-live-updates.mjs                                # run a suite
```

`relaunch.ps1` is also how you pick up a code change — Chrome does not
re-inject a content script into tabs that are already open, so the browsers
must be restarted after every edit or you will be testing the old build.

`harness.mjs` holds the shared plumbing: `attach`, `openCard`, `post`,
`replyVia`, `probe`, `watch`, `readTree`, `rawText`, `decodeMarker`. Assertions
read the extension's DOM contract (`[data-tt-id]`, `[data-tt-depth]`,
`[data-tt="reply"]`, `.tt-ghost`) rather than visible text.

Three things that will waste an hour if you don't know them:

- Our reply control clones Trello's own button class, so it inherits Trello's
  hover gating. You must `hover()` the row before the control is clickable.
- Each suite creates its own card, so runs never depend on leftovers.
- The extension's settings and its tombstone memory live in `chrome.storage`,
  which page scripts cannot reach — content scripts run in an isolated world.
  `harness.mjs` gets in by opening one of the extension's *own* pages
  (`setSettings`, `getSettings`, `resetSettings`, `forgetParents`). Finding the
  extension id is the awkward part: an extension loaded with `--load-extension`
  is not written to the profile's Preferences, so the id is read off
  `chrome://extensions`, which only works because Playwright's selectors pierce
  shadow roots. Plain `page.evaluate` cannot see that page's contents.

## Manual / agent-driven browser testing

### Why Chrome for Testing, not your everyday Chrome

Recent stable Chrome (137+, and confirmed on 151) **blocks loading unpacked
extensions from the command line** — the `--load-extension` switch is ignored,
and "Load unpacked" in the UI can silently fail. This is an anti-malware change,
not a bug in the extension.

For **end users this doesn't matter** — install from the Chrome Web Store, where
packed extensions are unaffected. But for automated/local testing you need a
build that still honours `--load-extension`: **Chrome for Testing** (the Chromium
that Playwright downloads) does.

> If you distribute by "Download ZIP → Load unpacked" (see the README), be aware
> that path is now unreliable for non-developers on current Chrome. Prefer the
> Web Store.

### One-time setup

```
npm init -y
npm install playwright-core        # to drive an already-running browser over CDP
npm install playwright             # to fetch a Chrome-for-Testing binary
npx playwright install chromium
node -e "console.log(require('playwright').chromium.executablePath())"   # its path
```

### Launch a test browser with the extension loaded

```
"<chrome-for-testing>/chrome.exe" \
  --remote-debugging-port=9222 \
  --remote-allow-origins=* \
  --user-data-dir=./profile \
  --load-extension=<repo-root> \
  --disable-extensions-except=<repo-root> \
  --no-first-run --no-default-browser-check \
  --new-window "https://trello.com/login"
```

- `<repo-root>` is the folder containing `manifest.json`.
- The profile dir persists your Trello login between runs, so you log in once.
- `--remote-allow-origins=*` is required for a CDP client to attach on Chrome
  111+.

Log into Trello in that window, then attach and drive it from Node:

```js
const { chromium } = require('playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => p.url().includes('trello.com'));
// ... automate: open a card, click .tt-reply, type, assert on [data-tt-id] rows
await browser.close(); // detaches only; leaves the browser running
```

Confirm the extension is live on a card: `window.fetch` should be patched
(its source mentions the interceptor) and comment rows should carry
`[data-tt-id]`, with a `.tt-reply` control and `.tt-toggle` on threaded parents.

### Reading the rendered tree

The extension marks each comment row with `data-tt-id` (the action id) and the
classes `tt-row`, `tt-row--child`, `tt-row--parent`, `tt-row--collapsed`.
Indentation is a `translateX` on the row (read it off the computed `transform`
matrix); ordering is CSS `order`; tombstones are `.tt-ghost`. Asserting on these
is more robust than scraping visible text.

### Testing @mentions without notifying real people

Replying to someone else's comment `@mentions` them, which sends a real
notification. Use **two Trello accounts you control** on the same board — one
per browser profile / debugging port (e.g. 9222 and 9223), each with the
extension loaded. Never test mentions against a colleague's account. Replies to
your own comments are not mentioned (by design), so a single account can't
exercise the mention path.

### Scaffolding test data quickly

You can build boards/cards/comments through Trello's internal API using the
logged-in session — no API key needed — by calling it from inside a logged-in
page with `page.evaluate`. The CSRF token lives in the `dsc` cookie and **must
be sent in the POST body**, not the query string (query-string `dsc` returns
`CSRF detected`). To seed a threaded comment directly, append an encoded marker
(the 96 zero-width chars for the parent's action id — see `src/interceptor.js`)
to the reply's text.

## Regression checklist

Threading (reply indents; parent gets a toggle) · nesting depth + the
`maxDepth` cap · collapse/expand and the direct-reply count · flat mode ·
settings (indent, depth) from the popup · cross-account `@mention` insertion +
delivery · self-mention suppression · deleted-comment tombstones (childless
removes cleanly; with-replies leaves `[deleted]`; empty deleted ancestors don't
stack; leaf deletion clears tombstones) · reload persistence · marker-loss
degradation (a reply that loses its marker becomes a top-level comment) ·
**abandoned reply must not taint the next comment** (clear the composer after a
Reply click, post something else — it must not thread or `@mention`) ·
**live cross-user rendering** (someone else's comment must thread without you
navigating) · **editing must not break threading** (edit a reply's text; it must
stay in its thread) · **the @mention must appear in the composer on the second
and later replies of a page, not only the first**.

The suites in `test/browser/`:

| suite | covers |
|---|---|
| `01-live-updates` | someone else's comment threading live, over the WebSocket |
| `02-deletion` | tombstones, across both accounts and reloads |
| `03-permissions` | ownership and `@mention` on boards in both admin/normal directions |
| `04-editing` | marker survival when a comment is edited |
| `05-structure` | depth cap, collapse/expand, direct-reply counts |
| `06-reply-target` | a reply landing where it was aimed when the feed moves mid-compose |
| `07-settings` | flat mode, `maxDepth`, `indentPx`, applied live and after reload |

Run them all with `npm run test:live` (after `npm run browsers`).
