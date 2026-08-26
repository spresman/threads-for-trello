# Changelog

Versions here match the `version` in `manifest.json`, which is what Chrome and
the Web Store use to decide whether a user is out of date. Each release is
tagged `v<version>` in git.

## [0.3.2] - 2026-08-26

### Fixed

- **A reply sent from a notification silently left its thread, for good.**
  Clicking a comment notification opens the card with that comment highlighted,
  and Trello renders it with `href="#"` where its `#comment-<id>` permalink
  would be — you are already at it, so it has nowhere to send you. Comment
  identity comes from that permalink, so the notified comment was the one row on
  the card the extension never claimed, which left Trello's own Reply showing
  instead of ours. Trello's Reply prefills the @mention but posts a flat comment,
  so the reply arrived looking correct — mention and all — while carrying no
  parent marker. No reload could recover it, because nothing was ever written to
  recover. The id is still in the URL fragment, so the row is now claimed from
  there.

### Added

- `test/browser/08-notification.mjs` — replying to a comment reached through the
  notification bell, including that the notified row keeps its claim while
  another comment is posting (losing it would tombstone that comment as deleted
  underneath its own replies).

## [0.3.1] - 2026-08-20

### Fixed

- **A thread reported one more reply than it had rows, after deleting a comment
  that had replies.** A comment deleted during the session stays in the
  extension's `comments` map — the API described it before it went — so it was
  already filed under its parent when the tombstone pass filed it a second time.
  The same id appeared twice in the parent's child list, so "2 replies" read as
  "3". Reloading dropped the stale entry and the count corrected itself, which
  is exactly what made it look like a rendering glitch rather than a bug.

### Added

- `test/browser/05-structure.mjs` — the depth cap, collapse/expand, and what the
  reply count counts (direct replies only, tombstones included), checked live on
  both browsers and after a reload.

## [0.3.0] - 2026-08-20

### Fixed

- **Editing a comment silently destroyed its threading.** The parent marker
  lives inside the comment's own text, and an edit is a `PUT /1/actions/<id>`
  carrying the full replacement text — so Trello's editor, which knows nothing
  about the marker, dropped it. The reply left its thread and became a top-level
  comment, taking its own replies with it, for everyone on the card. The
  interceptor now re-attaches the marker as the edit goes out, so an edit is
  lossless rather than merely survivable.

  Edits made where the extension is not running (another client, or retyping
  from a copy/paste) can still lose the marker; that degradation is unchanged
  and documented.

### Added

- `test/browser/04-editing.mjs`, plus four unit tests covering marker repair on
  edit: restored when lost, left alone when already present, never doubled,
  never picking up an `@mention`, and untouched for comments never seen.

## [0.2.1] - 2026-08-20

### Fixed

- **Every reply after the first one on a page opened an empty composer.** After
  handing the mention off to Trello's own Reply (which inserts a real mention
  chip), we also called `focusComposer()`, which clicks the composer skeleton to
  mount the editor. With the editor already mounting, that second click
  re-mounted it and discarded the chip. Replies now only scroll the composer
  into view once Trello has finished with it.

  The mention still reached the *posted* comment in every case -- the
  interceptor stamps it at send time -- so replies were correctly threaded and
  authors were correctly notified throughout. What was lost was any way to see
  that before pressing Send.

### Added

- `test/browser/02-deletion.mjs` -- tombstones across two accounts and reloads.
- `test/browser/03-permissions.mjs` -- ownership and @mention behaviour on
  boards in both admin/normal directions, asserting on the text Trello actually
  stored, not just the composer.

## [0.2.0] — 2026-08-20

### Fixed

- **Comments posted by other people while your tab was open were never
  threaded.** Trello pushes live board activity over a WebSocket, but the
  interceptor patched only `fetch` and `XMLHttpRequest`, so those comments never
  reached the extension. The row was rendered by Trello, ignored by us, and left
  with no threading, no thread guide and no reply control — until some unrelated
  request happened to carry the same action, which is what made it look like it
  "fixed itself later". `WebSocket` is now tapped too, and live comments thread
  within milliseconds.
- **Replies to socket-delivered comments were not `@mentioned`.** WebSocket
  deltas carry only `idMemberCreator`, not the populated `memberCreator` object
  REST responses include, so the author's handle was unknown and the mention was
  silently skipped. The author is now also resolved from `display.entities`.

### Added

- `test/browser/` — an automated two-account harness driving live Trello over
  CDP (see `docs/TESTING.md`), plus `01-live-updates.mjs` covering the above.
- Six unit tests for the WebSocket path, including that patching `WebSocket`
  preserves `instanceof` and the readyState constants.

## [0.1.2] — 2026-08-19

### Added

- Extension icon, wired into the manifest.
- `docs/TESTING.md`, `PRIVACY.md`, store listing copy and `scripts/build.mjs`.

## [0.1.1] — 2026-08-19

### Fixed

- An abandoned reply no longer taints the next comment. Clicking Reply and then
  clearing the composer left the reply target armed, so the next comment posted
  on that card silently inherited the parent *and* re-`@mentioned` its author.

## [0.1.0] — 2026-08-18

Initial release: threaded, collapsible replies on Trello cards, built on native
Trello comments via invisible zero-width parent markers.
