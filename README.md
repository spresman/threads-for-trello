# Threads for Trello

Collapsible threaded replies on Trello cards, built on top of **native Trello comments**.

Replying to a comment starts a thread if one doesn't exist, or joins the existing thread if it does. Replies are indented under what they reply to, connected by a guide line, and each parent carries a toggle that collapses or expands everything beneath it.

> Not affiliated with, endorsed by, or sponsored by Atlassian. "Trello" is a trademark of Atlassian, used here only to describe what this extension works with.

## Why a browser extension and not a Power-Up

Trello's Power-Up API has [18 capabilities](https://developer.atlassian.com/cloud/trello/power-ups/capabilities/) and **none of them can touch the native comment feed**. That's why the only existing threading product ([Threaded Comments for Trello](https://trello.com/power-ups/61782018054e2f19837ace09/threaded-comments-for-trello), $10/board/month) renders a *second, parallel* comment section in its own iframe above Trello's real comments.

That split-brain design means its threads aren't real Trello comments — no notifications, no mobile, no search, no export.

This extension threads the real comment feed instead. Replies are ordinary Trello comments, so notifications, mentions, reactions, editing, mobile and the REST API all keep working. Without the extension installed, the same conversation just reads as a flat list.

## How threading is stored

Trello comments have no parent field, so a reply encodes its parent's action id as an **invisible marker** appended to the comment text: 96 zero-width characters (`U+200B` = 0, `U+200C` = 1) fenced by `U+2060`.

People without the extension see nothing unusual — just the comment text.

**Verified against live Trello:** a reply posted through the extension came back after a full reload with all 98 marker characters (96 bits + 2 fences) intact, still correctly nested. Trello does not strip zero-width characters on save.

**The trade-off that remains:** zero-width characters can still be stripped by copy/paste, by editing a comment in some clients, or by future Trello sanitisation. The code is orphan-safe — a reply whose marker is lost or whose parent was deleted degrades to a normal top-level comment rather than disappearing — but it does silently leave its thread. If that bites you, switching to a visible marker is a one-line change in `encodeMarker()`.

## Architecture

| File | World | Role |
|---|---|---|
| `src/interceptor.js` | `MAIN` | Patches `fetch`/`XHR`. Stamps the marker on outgoing replies; deep-scans every API response for `commentCard` actions and decodes their markers. |
| `src/threads.js` | `ISOLATED` | Matches comment data to DOM nodes, builds the tree, applies threaded layout, renders toggle/reply controls. |
| `src/threads.css` | — | Thread lines, indentation, collapse controls. Light + dark. |
| `src/popup.html/js` | — | Settings. |

Three design decisions worth knowing:

- **Threading is read at the network layer, not scraped from the DOM.** Trello's own API responses give us real action ids, so we never have to guess identity from rendered markup or drive the React composer.
- **Layout uses flexbox `order` and `margin-left`, never DOM moves.** Trello is a React app; reparenting its nodes invites reconciliation crashes. Restyling them is invisible to React.
- **Controls dock into Trello's own action row**, rendering as `▾ hide  🙂 • Edit • Delete • Reply`. The row is found by its Edit/Delete controls, falling back to an ancestor-climb for comments you can't edit (those have no Edit/Delete but do have the row, for reactions). The collapse arrow leads the row — inserted at the row's start, ahead of the reaction button, which lives in a wrapper that is itself the row's first child. It's separated by a space rather than a dot: the dots delimit Trello's comment actions, so keeping the thread control out of that run stops it reading as one more of them.

### Matching native chrome

Reply and the collapse arrow **clone Trello's own button `className` and separator node** instead of restyling from scratch, so colour, underline, hover and focus all come from Trello and survive their restyles. They're appended straight into the action row — it already sets `display: flex; gap: 4px`, so a wrapper of our own would have added spacing on top of that. Our classes are query hooks only; the CSS for them is deliberately near-empty.

The one place real styling exists is `.tt-ownrow`, the fallback row built when there's no action row to dock into — there's no native button there to clone.

### Thread guides

The curved guides are **decorative only** (`pointer-events: none`) — collapsing is the arrow's job.

Guides live in the **gutter to the left of each row** (`RAIL_X = -10`), not under the avatar. Trello's comment bubble starts flush at `x = 0` and spans the full row width, so any positive offset paints the line straight across the text. `.tt-container` carries 14px of padding so the outermost level still has room. Lines meet each comment at `--tt-anchor` (24px — the avatar's vertical centre), which is above the bubble at y=64, so the horizontal run lands beside the avatar rather than across the text.

Comment rows are flat siblings with no vertical gap, so every guide runs `top: 0` to `bottom: 0` and lines meet exactly. The subtlety is that an ancestor's line has to be painted *through* deeper rows to reach its next sibling — nothing else draws at that x. So each row emits:

- one **rail** per ancestor level whose line still has somewhere to go,
- an **elbow** curving into its own comment (`border-bottom-left-radius`),
- a **continuation** below the elbow when another reply follows,
- a **parent rail** dropping from its own avatar when it has visible replies.

The rail test is the easy thing to get wrong. For the line at level `L`, the question is whether the *child it passes through* — `chain[L + 1]` — has a later sibling. Testing `chain[L]` asks whether the ancestor itself has more siblings, which is a different line, and leaves visible gaps in deep threads.

## Deleted comments

Deleting a comment that has replies would orphan them, so a **`[deleted]` tombstone** stands in its place and the thread keeps its shape. Deleting a comment with no replies just removes it — tombstones are only created when a rendered reply points at a parent that has no row of its own, and the set is recomputed on every pass, so one disappears as soon as it stops holding anything up.

The awkward part is *where* the tombstone goes. Trello deletes the action outright — `GET /1/actions/<id>` 404s afterwards — so once the page reloads, nothing on the server remembers where that comment sat. Its replies still carry markers pointing at it, but its own marker died with it. A structure like `A → B → C` therefore lost its top half on reload: with `B`'s parent unknowable, its tombstone became a root and dragged `C` to the top of the feed.

So the extension **remembers parent links as it harvests them** (`tt:parents` in `chrome.storage.local`, capped at 5000 entries), which is the only record that survives the deletion. A tombstone climbs that map until it reaches an ancestor that's actually on screen — possibly another tombstone, since deleted ancestors that still hold replies have rows too. Deleted ancestors with *no* surviving replies are skipped rather than stacking up empty tombstones.

**This is per-browser.** Someone who opens the card for the first time *after* the deletion never saw the link, so their tombstone still lands at root. Making it durable across people would mean encoding the whole ancestor chain in each reply's marker — 96 invisible characters per level rather than 96 total — and would only help comments posted after that change.

## Mentions

Trello **does** have a native **Reply** button on other people's comments. It prefills an `@mention` of the author — but it posts an ordinary **flat** comment. It does not thread, and there is no reply control at all on your own comments.

**The extension hides Trello's Reply** (and its orphaned separator dot) and puts its own in the row, so there is only ever one button called Reply. Ours is a superset — same `@mention`, plus threading — so nothing is lost.

This matters more than it sounds. Before it was hidden, other people's comments showed `🙂 • Reply • Delete • Reply`: two identical labels side by side. Clicking the native one produces a normal comment with no marker, which is indistinguishable from the extension being broken.

Our Reply prepends the same `@username`, since our path bypasses Trello's composer and would otherwise notify nobody.

Clicking Reply also **puts the mention into the composer** and scrolls it into view, matching the native behaviour. That's presentation only — the interceptor injects the mention at send time regardless and de-duplicates, so a reply is tagged whether or not the composer insert lands. It's skipped if you've already typed something, so it can't disturb text in progress.

The mention has to be a real **mention node** — the oval chip — not plain `@handle` text. Trello's editor only ever creates one through its own typeahead, and driving that typeahead from outside (insert `@`, wait for the popup, filter, select) worked only intermittently. So Reply **clicks Trello's own hidden Reply button** instead: hidden elements still respond to `.click()`, and Trello does the insertion itself. Ours supplies the threading; theirs supplies the chip.

Two consequences worth knowing:

- Trello wraps the chip in zero-width spaces, and `\s` doesn't match those — so the interceptor's de-dup check strips zero-width characters before testing, or it would miss the chip Trello just inserted and prepend a second copy of the same mention.
- Trello's Reply has no "don't disturb text in progress" guard of its own, so we check the composer first and skip the delegation if you've already started typing.

The scroll happens *after* the editor mounts: Trello's composer is a placeholder button at rest, and clicking it swaps in the real editor, which shifts the layout. Scrolling first lands in the wrong place.

- The handle comes from `memberCreator.username` in the API response — kept separate from `author`, since mentions need the handle rather than the display name.
- **Skipped on your own comments.** Trello never notifies you about your own mention, so it would be pure noise. Ownership is detected by whether Trello rendered an **Edit** button on the comment — that only appears on comments you can edit, and needs no member-id lookup. (Delete is unsuitable: board admins get it on other people's comments too.)
- If you already typed the mention yourself, it isn't duplicated. A near-miss handle (`@alex` when replying to `@alexh`) still gets its own mention.
- In flat mode, or past the depth cap, the reply may *attach* to an ancestor while mentioning the author of the comment you actually clicked.
- Toggle it off in the popup.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Open a Trello card and reload the tab

Works unchanged in Edge and Brave.

## Settings

Click the extension icon:

- **Reply behaviour** — *Nested* (a reply attaches to whatever you replied to) or *Flat* (every reply attaches to the top of its thread, so threads never deepen past one level).
- **Max nesting depth** — default 4. Deeper replies attach to the deepest allowed ancestor.
- **Indent per level** — default 24px. Minimum 16px: below that the guide curve would land inside the comment it connects to.
- **@mention the person you reply to** — default on. See "Mentions" above.
- **Log diagnostics** — prints matching decisions to the console.

## Tests

```
node test/roundtrip.test.js
```

14 tests cover the threading engine: marker injection across all three body shapes Trello might use (urlencoded, JSON, query string), non-replies and unrelated requests left untouched, @mention injection (including no-duplicate, near-miss handles, and not leaking into the next comment), and full encode → API response → decode round-trips including unicode content and deeply nested batch payloads.

## Verified behaviour

Confirmed end-to-end against live Trello (Chrome, August 2026):

- Comment rows bind via `[data-testid="comment-container"]`; auto-discovery not needed.
- Replies nest under their parent, and **stay nested after a full page reload** — the marker survives Trello's backend.
- Nesting works past one level (verified to depth 2).
- Collapse/expand works (`▾ hide` ↔ `▸ 3 replies`), hiding the whole subtree, and the collapsed state persists across reloads.
- `▸ N replies` counts direct replies only — the rows that appear when you expand — not the entire subtree. Each of those carries its own count for what's nested under it. A `[deleted]` tombstone counts, since it appears as a row like any other.
- Unrelated top-level comments stay unthreaded; activity entries stay below the comments.
- Reply and the collapse arrow dock into Trello's `• Edit • Delete` row on every comment.

### Two bugs this testing caught

**`order` was being applied to an only child.** Trello nests each comment several levels below the feed list:

```
UL                                    <- true sibling level
└ LI  [card-back-action]              <- the row that must carry `order`
   └ DIV [card-back-action-container]
      └ DIV [comment-container]       <- what the selector matches
```

Setting `order` on `comment-container` did nothing, because it has no siblings. `normalizeRows()` now derives the feed container as the lowest common ancestor of the comments and climbs each one to the ancestor that is a *direct child* of it. Deriving the container from the comments rather than hardcoding `UL`/`LI` means a Trello restructure doesn't break it.

**Ordering was inverted.** The tree emitted oldest-first, which would have flipped the whole feed. Roots now render newest-first (matching Trello), with replies oldest-first inside each thread so a thread reads top-down.

**Controls docked to the wrong element.** `comment-container` turns out to be wrapped in an extra `<div>`, so it has no next sibling — every comment silently fell back to a self-created row, putting Reply *above* Edit/Delete instead of beside it.

**Guide rails tested the wrong ancestor.** See "Thread guides" above; the symptom was disconnected line stubs in threads deeper than one level.

**Controls captured the comment id.** Reply and the collapse arrow are created once and reused, but their click handlers closed over the id from the pass that built them. Every other piece of state is re-derived each pass and self-heals; a closure doesn't. So a single mis-read of a half-rendered row — pairing one comment's body with another's timestamp — was baked into that button permanently, and it kept sending the wrong parent long after the binding itself had recovered.

The symptom was a reply to your own comment silently threading under someone else's, *and no `@mention` on it* — because `mentionFor()` asked whether the bound body was yours, and it was. Both controls now call `idForControl()`, which re-reads Trello's permalink out of the DOM at click time. Nothing we get wrong can outlive one render.

### After an update

Reloading or updating the extension does **not** re-inject the content script into tabs that are already open. Chrome leaves the old one running but cuts it off from every `chrome.*` API — so it keeps rendering, looks perfectly healthy, and silently stops persisting anything. Chrome auto-updates extensions in the background, so this is the normal path for every user on the day a new version ships, not just a developer annoyance.

The script now detects this (`chrome.runtime.id` goes undefined), stands down cleanly, and shows a "reload this page" notice instead of pretending to work. **When developing: reload the extension, then reload the Trello tab.**

### If it stops working

Enable **Log diagnostics** and check the console:

- `no comment rows found` — `SELECTORS.commentRow` needs updating. Auto-discovery should have caught this, so check it too.
- `could not resolve a feed container` — the comments have no shared ancestor; the card back was restructured.
- `no rows matched comment data` — rows found but text matching failed.

## Limitations

- Threading only reflows comments the extension has seen the API load. Very long comment histories that paginate will thread progressively as pages load.
- Two comments with byte-identical text are matched to DOM nodes in date order; a mismatch is cosmetic and resolves on reload.
- Collapse state is stored per card in `chrome.storage.local` and is local to your browser.
