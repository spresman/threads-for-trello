# Threads for Trello

Collapsible threaded replies on Trello cards, built on top of **native Trello comments**.

Replying to a comment starts a thread if one doesn't exist, or joins the existing one if it does. Replies indent under what they reply to, connected by a guide line, and each parent gets a toggle that collapses everything beneath it.

> Not affiliated with, endorsed by, or sponsored by Atlassian. "Trello" is a trademark of Atlassian, used here only to describe what this extension works with.

## Install

1. Download this repository (**Code → Download ZIP**) and unzip it somewhere permanent — Chrome loads the extension from that folder, so moving or deleting it breaks the extension.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. **Load unpacked** → select the unzipped folder.
4. Open a Trello card and reload the tab.

Works unchanged in Edge and Brave.

**After updating the extension, reload your open Trello tabs.** Chrome leaves the old script running in tabs that are already open, and it can't reach browser storage any more. It notices and shows a "reload this page" notice rather than pretending to work.

## How it works

Trello comments have no parent field, so a reply records its parent's id as an **invisible marker** appended to the comment text — 96 zero-width characters. The extension reads those markers back out of Trello's own API responses and re-renders the flat feed as a tree.

Everything stays a real Trello comment, so **notifications, mentions, reactions, editing, mobile and the REST API all keep working**. Uninstall the extension and the same conversation simply reads as a flat list. Nothing is stored on any server; there is no server.

The trade-off: zero-width characters can be stripped by copy/paste or by editing a comment in some clients. A reply that loses its marker degrades to a normal top-level comment rather than disappearing — but it does quietly leave its thread.

**Worth telling your team:** the extension writes invisible characters into comment text. It's their own content in their own workspace, but people should know rather than discover it.

## Settings

Click the extension icon:

| Setting | Default | Notes |
|---|---|---|
| **Reply behaviour** | Nested | *Nested*: a reply attaches to what you replied to. *Flat*: it attaches to the top of the thread, so threads never deepen. |
| **Max nesting depth** | 4 | Deeper replies attach to the deepest allowed ancestor instead. |
| **Indent per level** | 24px | Minimum 16px — below that the guide curve lands inside the comment it connects to. |
| **@mention the person you reply to** | on | Skipped on your own comments; Trello doesn't notify you about yourself. |
| **Log diagnostics** | off | Prints matching decisions to the console. |

## Behaviour worth knowing

**Replies are `@mentioned`.** Clicking Reply on someone else's comment tags them, so they're notified — Trello's own Reply does the same, but posts a flat comment. Ours hides theirs and supersedes it.

**Deleted comments leave a `[deleted]` tombstone** if they had replies, so the thread keeps its shape. Deleting a childless comment just removes it.

**`▸ N replies` counts direct replies only** — the rows that appear when you expand — not the whole subtree. Collapsing still hides everything beneath.

**Collapse state is per-browser**, stored locally and never synced.

## Limitations

- Very long comment histories thread progressively as Trello pages them in.
- A tombstone's position is remembered per-browser. Someone opening a card for the first time *after* a deletion sees that tombstone at top level.
- Chrome, Edge and Brave only. Firefox and Safari would each need a port.

## Tests

```
node test/roundtrip.test.js
```

21 tests over the marker engine: injection across every request shape Trello uses, `@mention` handling, full encode → API → decode round-trips, and the live WebSocket path.

There is also an automated two-account browser suite in `test/browser/` that drives live Trello over CDP.

For the DOM behaviour — threading, guides, collapse, the composer/mention path and tombstones — see [`docs/TESTING.md`](docs/TESTING.md), which covers driving the extension against live Trello (including why current Chrome needs **Chrome for Testing** to load it unpacked).

## Building for the Chrome Web Store

```
npm run build      # or: node scripts/build.mjs
```

Produces `dist/threads-for-trello-<version>.zip` containing only what ships
(`manifest.json`, `src/`, `icons/`), which you upload to the [Developer
Dashboard](https://chrome.google.com/webstore/devconsole). Bump `version` in
`manifest.json` (and `package.json`) before each store update. Listing copy and
the publishing checklist live in [`docs/store-listing.md`](docs/store-listing.md).

## Privacy

No data is collected, transmitted, or shared; there is no server. Threading is
stored as invisible markers inside your own comments, and collapse state stays
local to your browser. Full details in [`PRIVACY.md`](PRIVACY.md).

## Design notes

[`docs/DESIGN.md`](docs/DESIGN.md) covers the architecture, the DOM constraints Trello imposes, how the thread guides are drawn, and the bugs that shaped the current design — worth reading before changing anything.

## Licence

MIT — see [LICENSE](LICENSE).
