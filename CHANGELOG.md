# Changelog

Versions here match the `version` in `manifest.json`, which is what Chrome and
the Web Store use to decide whether a user is out of date. Each release is
tagged `v<version>` in git.

## [0.3.5] - 2026-09-18

### Fixed

- **The thread spine still stepped sideways under a comment reached from a
  notification — but only some of the time.** 0.3.4 measured the highlight's
  padding during a repaint and anchored the rails to the row's content box with
  it, which is right, but it left *when* that measurement happens to luck.
  Trello switches the highlight on and off by rewriting the row's `class`, and a
  class change is an attribute mutation, which the observer driving every
  repaint does not watch — it watches `childList`. So the padding moved under a
  layer that had already been anchored, and stayed wrong until some unrelated
  DOM churn happened to trigger a rescan. Whether anything did was chance, which
  is exactly why the step came and went. Measured with nothing else touching the
  page: a 12px break when the class arrives, and 12px the other way when it
  leaves — a rail left over from the highlight sits that far right of the spine
  once the highlight is gone. The row's `class` is now watched directly, scoped
  to the comment feed, and re-anchoring is separated from drawing: what a rail
  looks like depends on the thread, where it starts depends on the padding, and
  the two are no longer cached together.

- **A hovered comment broke the spine beneath it, for as long as the mouse was
  there.** Hovering reveals Trello's "Copy link to comment" control, and when
  the author's name and the timestamp already fill the header line, that control
  wraps onto a second line and the row grows by about 20px. Nothing is inserted
  or removed to make that happen — hover is a CSS state — so the observer that
  drives every repaint never heard about it, and the row's guides kept the
  height they had been drawn for: the row grew, its rail did not, and a hole
  opened between it and the row below. Measured at 19px, lasting as long as the
  mouse stayed and closing when it left. It looked idiosyncratic because it
  needs the header to sit within one control's width of wrapping — in a sweep of
  display-name lengths exactly one of thirteen triggered it, one letter either
  side of which nothing happened at all. Rows are now measured by a
  `ResizeObserver`, on the border box, so the guides follow any size change
  whether or not anything in the DOM moved.

### Added

- `test/browser/09-spine.mjs` — the guides staying continuous when a row changes
  size: once by growing a row with no DOM change at all, which owes nothing to
  Trello's markup, and once through the reported hover, sweeping the display
  name to find the width where it wraps rather than assuming one.

## [0.3.4] - 2026-09-11

### Fixed

- **The thread spine stepped sideways under a comment reached from a
  notification.** Trello highlights the comment you were notified about by
  growing its row outward — a 4px left border, 12px of left padding and 16px of
  right padding — while leaving the content where it was, which is why the
  comment looks unmoved and only the guides appear to jump. Each row's rails are
  drawn into an SVG that is absolutely positioned inside it, so they are
  measured from that row's *padding box*, and the whole design depends on every
  row sharing that origin: a parent draws its rail at `RAIL_X` and its child
  draws the matching line at `RAIL_X - indent` while translated right by the
  same indent, so the two land on one screen x. The highlight moved one row's
  padding box and took its rail with it, breaking the spine by exactly the
  padding. Rails are now measured from the row's content box instead. The
  padding is read off the live computed style rather than assumed, so it is 0
  on an ordinary row and follows Trello if they ever retune the highlight.
  Measured on a highlighted parent and its reply: 1064 vs 1076 before, 578 vs
  578 after.

- **The replying ring was off by the same padding on a highlighted comment.**
  It is drawn against the row's padding box too. The padding is now published
  as `--tt-padl` / `--tt-padr` — CSS cannot read an element's own padding —
  and the ring holds its 2px and 6px gaps on a highlighted row exactly as it
  does everywhere else.

## [0.3.3] - 2026-08-26

### Fixed

- **The blue ring around the comment you are replying to was cut by the thread
  guide crossing it.** Comment rows are `position: relative` with `z-index:
  auto`, which is not a stacking context, so a row's rail — absolutely
  positioned at `z-index: 0` — painted into the ancestor's positioned layer and
  landed on top of the ring. Raising the row does not help: it lifts the rail
  with it. The ring is now a positioned pseudo-element that outranks the rail
  inside the row, which is the only way an element can win against its own
  descendant. Measured at depth 3: every rail/ring crossing reads the accent
  colour where it read the guide's grey before.

- **The ring overhung the panel on deep threads and was clipped.** A row keeps
  its full width when it is indented — the indent is a transform, and the
  content is pulled back by an equal margin so every comment's right edge stays
  on one line. The ring was drawn against the row's box, so it stuck out past
  the content by exactly the indent. It now follows the content, and holds a
  6px gap from the avatar's left edge and the comment box's right edge at every
  depth.

- **Clicking Reply shifted the whole activity feed sideways.** Mounting the
  composer makes the panel taller, a vertical scrollbar appears, and every
  comment box in the feed loses its width at that instant (measured: 15px). The
  scrollbar gutter is now reserved up front, so the width does not change when
  it appears. Two smaller sources went with it: `scrollIntoView` has no way to
  say "leave x alone" and scrolled sideways on indented rows, and `focus()`
  scrolls its element into view on both axes. Replying now scrolls vertically
  only — verified as zero horizontal movement on every row.

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
