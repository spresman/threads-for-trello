# Privacy Policy — Threads for Trello

_Last updated: 2026-08-19_

**Threads for Trello does not collect, transmit, sell, or share any personal
data. There is no server, no analytics, and no third party involved.**

The extension runs entirely in your own browser, on `https://trello.com`, and
acts only on the Trello card you are viewing.

## What the extension does with data

- **Threading markers.** When you post a reply, the extension appends an
  invisible marker (96 zero-width characters encoding the parent comment's id)
  to the comment text. This is written to **your own comment in your own Trello
  workspace, through Trello's own API** — the same place your comment already
  goes. Nothing is sent anywhere else. Uninstalling the extension leaves those
  comments intact; they simply read as a flat list again.
- **Local display state.** Which threads you have collapsed, and a map of
  reply→parent relationships (used to keep deleted-comment placeholders in the
  right place), are stored in your browser via `chrome.storage.local`. This
  never leaves your device and is not synced.
- **Settings.** Your preferences (nesting mode, depth, indent, mention toggle)
  are stored via `chrome.storage.sync`, which Chrome may sync across your own
  signed-in browsers. They contain no personal data.

## What it does NOT do

- No data is sent to the developer or any third-party server (there is none).
- No analytics, tracking, advertising, or fingerprinting.
- No reading or storing of your Trello content beyond what is needed to render
  threads on the card you are viewing.
- No selling or sharing of data with anyone.

## Permissions

- **`storage`** — to save your settings and collapse state locally (see above).
- **Host access to `https://trello.com/*`** — required so the extension can run
  on Trello cards and read the comment data Trello's own API returns, in order
  to render replies as threads. It runs on no other sites.

## Contact

Questions or concerns: open an issue at
<https://github.com/spresman/threads-for-trello/issues>.

_Threads for Trello is not affiliated with, endorsed by, or sponsored by
Atlassian. "Trello" is a trademark of Atlassian._
