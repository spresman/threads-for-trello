# Changelog

Versions here match the `version` in `manifest.json`, which is what Chrome and
the Web Store use to decide whether a user is out of date. Each release is
tagged `v<version>` in git.

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
