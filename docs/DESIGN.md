# Design notes

Why this is built the way it is, and which parts are load-bearing. Read this before changing anything — most of the odd-looking decisions here are scar tissue from a specific failure.

## Why an extension and not a Power-Up

Trello's Power-Up API has [18 capabilities](https://developer.atlassian.com/cloud/trello/power-ups/capabilities/) and **none of them can touch the native comment feed**. The only existing threading product ([Threaded Comments for Trello](https://trello.com/power-ups/61782018054e2f19837ace09/threaded-comments-for-trello), $10/board/month) therefore renders a *second, parallel* comment section in its own iframe above Trello's real comments.

That split-brain design means its threads aren't Trello comments at all: no notifications, no mobile (the `card-back-section` capability is web-only), no search, no export. This extension threads the real feed instead, which is the whole point — and the reason it has to fight Trello's DOM.

## Architecture

| File | World | Role |
|---|---|---|
| `src/interceptor.js` | `MAIN` | Patches `fetch`/`XHR`. Stamps the marker on outgoing replies; deep-scans every API response for `commentCard` actions and decodes their markers. |
| `src/threads.js` | `ISOLATED` | Binds comment data to DOM nodes, builds the tree, applies the threaded layout, renders the toggle and Reply controls. |
| `src/threads.css` | — | Guides, indentation, controls. Light and dark. |
| `src/popup.html/js` | — | Settings. |

The interceptor must run in `MAIN` to patch `window.fetch` in Trello's own context. The layout script runs `ISOLATED` so it can reach `chrome.storage`. They talk over `window.postMessage` with a `__tt` discriminator.

### Threading is read at the network layer, not scraped

Trello's API responses carry real action ids, so identity never has to be inferred from rendered markup and the React composer never has to be driven. This is the single decision most responsible for the thing working at all.

### Identity comes from Trello's permalinks

Every comment's timestamp is an `<a href="#comment-<24 hex>">`. That is the authoritative id, and `bindRows()` uses nothing else.

It used to match on rendered text, which broke whenever the rendered form differed from the stored form: emoji become `<img>` and contribute no text, links and attachments render as preview cards bearing no resemblance to the URL, and two comments with identical text were ambiguous. A positional fallback meant to paper over those cases paired a newest-first DOM list against an oldest-first pool and scrambled the feed. Permalink binding obsoleted all of it.

### Layout restyles, never reparents

Trello is a React app; reparenting its nodes invites reconciliation crashes, but restyling them is invisible to React. So ordering is done with CSS `order` and indentation with `transform: translateX()`.

Two traps here, both paid for in bugs:

- **Never force `display: flex` on the feed.** It's a grid whose rows use `grid-template-columns: subgrid`. `order` is honoured by both, so we only impose flex when the container is neither — forcing it collapsed avatar, name and timestamp onto separate rows.
- **Indent with `transform`, never `margin-left`.** Row children are placed on the *ancestor's* column lines, not the row's own box. Margin pushes the box right while the children stay put, which compressed the avatar's track from 32px to nothing and slid the avatar under the name.

`row.style.position = 'relative'` is set inline every pass, not via a class: React owns `className` on these rows and wipes ours on re-render, and losing the positioned ancestor drops the absolutely-positioned guides onto the page origin — the stray rail that used to appear in the top-left corner of Trello.

### Controls dock into Trello's own action row

Rendering as `▾ hide  🙂 • Edit • Delete • Reply`. The row is found by its Edit/Delete controls, with an ancestor-climb fallback for comments you can't edit — those have no Edit/Delete but do still have the row, for reactions.

Reply and the arrow **clone Trello's own button `className` and separator node** rather than restyling from scratch, so colour, underline, hover and focus come from Trello and survive their restyles. Our classes are query hooks; their CSS is deliberately near-empty. The one place real styling exists is `.tt-ownrow`, the fallback row built when there's nothing to dock into.

The label whitelist for cloning is deliberate (`edit|delete|reply`): a reaction chip is also a `<button>` carrying text — its count — and cloning that gave Reply a grey pill.

The collapse arrow leads the row, separated by a space rather than a dot. The dots delimit Trello's own comment actions; keeping the thread control out of that run stops it reading as one more of them.

## Controls must not capture the comment id

`idForControl()` re-reads the permalink from the DOM at click time. Nothing about a control's identity is closed over.

This is the subtlest bug the project hit. Controls are created once and reused, and their handlers used to close over the id from the pass that built them. Every other piece of state is re-derived each pass and self-heals; a closure doesn't. So a single mis-read of a half-rendered row — one comment's body beside another's timestamp — was baked into that button permanently and kept sending the wrong parent long after the binding recovered.

The symptom: a reply to your own comment silently threading under someone else's, **with no `@mention` on it** — because the mention lookup asked whether the *bound body* was yours, and it was. That absence was the clue that identified it. If replies ever land oddly again, check whether a mention is missing where one is due.

## Thread guides

Decorative only (`pointer-events: none`) — collapsing is the arrow's job.

Geometry, measured against Trello's card back:

| Constant | Value | Meaning |
|---|---|---|
| `RAIL_X` | 20 | Avatar's horizontal centre; rails run down it |
| `AVATAR_LEFT` | 8 | Avatar's left edge within the row |
| `AVATAR_BOTTOM` | 40 | Where a rail may start without touching the avatar |
| `ANCHOR` | 24 | Avatar's vertical centre — where a curve arrives |
| `ELBOW_R` | 8 | Corner radius of the turn |
| `ELBOW_GAP` | 1 | How far short of the avatar the curve stops |

Rails descend from *beneath* the avatar so they can never cut through the circle. Anchoring them to the avatar's left edge instead meant the horizontal run overlapped it.

Rows are flat siblings with no vertical gap, so an ancestor's line must be painted *through* deeper rows to reach its next sibling — nothing else draws at that x. Each row emits one rail per ancestor level that still has somewhere to go, an elbow curving into its own comment, and a parent rail when it has visible replies.

Four things here are easy to get wrong:

- **The rail test.** For the line at level `L`, the question is whether the *child it passes through* — `chain[L + 1]` — has a later sibling. Testing `chain[L]` asks whether the ancestor has more siblings, which is a different line, and leaves gaps in deep threads.
- **One `<path>` is not enough.** Separate subpaths each get their own anti-aliased end cap, so a stem and its arc seam visibly where they meet. The stem must run *into* the turn as a single unbroken subpath. Overlapping subpaths within one stroke are fine — a single stroke operation paints the union.
- **Row height must not be rounded.** Rows measure ~100.43px; rounding left a 0.43px hairline at every boundary. Exact height plus 1px of overshoot, so consecutive rows overlap instead of meeting.
- **Measure height after setting `display`.** A row being revealed is still `display: none` earlier in the same pass, so it measures 0 and the path collapses to a 1px stub — the broken arc after expanding a thread.

Guides sit at negative x, and `overflow` on the outermost `<svg>` computed to `hidden` regardless of CSS rule or SVG attribute, because Trello's stylesheet outranks ours. Rather than fight that, the canvas is widened leftward by `guidePad` and every coordinate shifted into it, so nothing is ever outside the viewport and clipping stops mattering. (`inset: 0` doesn't size an `<svg>` either — it's a replaced element with an intrinsic 300×150.)

## Deleted comments

A `[deleted]` tombstone stands in for a deleted comment that still has replies, so the thread keeps its shape. Tombstones are only created when a rendered reply points at a parent with no row of its own, and the set is recomputed every pass, so one disappears as soon as it stops holding anything up. A childless deletion therefore leaves nothing behind, for free.

The hard part is *where* the tombstone goes. Trello deletes the action outright — `GET /1/actions/<id>` 404s afterwards — so after a reload nothing on the server remembers where that comment sat. Its replies still carry markers pointing at it; its own marker died with it. `A → B → C` therefore lost its top half: with `B`'s parent unknowable, its tombstone became a root and dragged `C` to the top of the feed.

So parent links are **remembered as they're harvested** (`tt:parents` in `chrome.storage.local`, capped at 5000 entries) — the only record that survives the deletion. A tombstone climbs that map until it reaches an ancestor actually on screen, possibly another tombstone. Deleted ancestors with no surviving replies are skipped rather than stacking up empty tombstones.

**This is per-browser.** Someone opening the card for the first time after the deletion never saw the link, so their tombstone lands at root. Making it durable would mean encoding the whole ancestor chain in each reply's marker — 96 invisible characters per level rather than 96 total — and would only help comments posted after that change.

Everything downstream of the tree (depth, guides, paint order) must resolve parents through the single `parentOf` map that `buildTree()` returns. Three call sites once climbed `comments` independently, which knows nothing about tombstones, so after a reload they stopped dead and tombstone replies rendered at depth 0.

## Mentions

Trello **does** have a native Reply on other people's comments. It prefills an `@mention` but posts an ordinary **flat** comment, and there's no reply control at all on your own comments. The extension hides it — before that, other people's comments showed `🙂 • Reply • Delete • Reply`, two identical labels side by side, and clicking Trello's produced a comment with no marker, indistinguishable from the extension being broken.

The mention has to be a real **mention node** (the oval chip), not plain `@handle` text. Trello's editor only creates one through its own typeahead, and driving that typeahead from outside — insert `@`, wait for the popup, filter, select — worked only intermittently. So Reply **clicks Trello's own hidden button**: hidden elements still respond to `.click()`. Ours supplies the threading, theirs supplies the chip.

Consequences:

- Trello wraps the chip in zero-width spaces, which `\s` doesn't match. The interceptor's de-dup check strips zero-width characters before testing, or it would miss the chip Trello just inserted and prepend a second copy of the same mention.
- Trello's Reply has no "don't disturb text in progress" guard, so we check the composer first and skip the delegation if you've started typing.
- The send-time injection in `stamp()` is the real guarantee. The composer insert is presentation; if it fails, the reply is still tagged.

`editorText()` exists because Trello's composer is ProseMirror and its "Write a comment…" placeholder is a real `<span>` inside the contenteditable — `aria-hidden`, not editable, but present in `textContent`. Reading `textContent` directly made the "already typed something" guard fire on an *empty* composer, so the mention was never inserted. It strips `aria-hidden` nodes only: a mention chip is `contenteditable="false"` but announced to screen readers, so it still correctly counts as text.

Ownership (for suppressing self-mentions) is detected by whether Trello rendered an **Edit** button — that only appears on comments you can edit, and needs no member-id lookup. Delete is unsuitable: board admins get it on other people's comments too. This is a DOM heuristic and the weakest link in the mention path; comparing `idMemberCreator` against your own member id would be sturdier.

The scroll happens *after* the editor mounts: the composer is a placeholder button at rest, and clicking it swaps in the real editor, which shifts the layout.

## The extension context can die underneath you

When an extension is reloaded, updated or disabled, Chrome leaves the already-injected content script running in open tabs but cuts it off from every `chrome.*` API.

Every storage call here was once wrapped in a bare `catch (_) {}`, so the script carried on rendering and looked perfectly healthy while silently persisting nothing — a dead build masquerading as a live one. That cost a full debugging session and two mis-posted comments, and it is **not** a developer-only condition: Chrome auto-updates extensions in the background, so every user with a Trello tab open lands here the day a new version ships.

`contextAlive()` checks `chrome.runtime.id`; `retire()` disconnects the observer, clears both timers, clears the interceptor's pending reply target (it lives in the page and survives independently, so a stale parent could otherwise stamp a later comment), and shows a notice. That notice uses inline styles on purpose — Chrome may drop the injected stylesheet at exactly the moment it's needed.

`storageFailed()` retires on a dead context and *logs* anything else. The general lesson: a silent catch turned every subsequent bug into a mystery, because the failure and the healthy state were indistinguishable.

## DOM structure Trello imposes

```
UL                                    <- true sibling level; the feed container
└ LI  [card-back-action]              <- the row that must carry `order`
   └ DIV [card-back-action-container]
      └ DIV [comment-container]       <- what the selector matches
```

`order` on `comment-container` does nothing — it has no siblings. `normalizeRows()` derives the feed container as the lowest common ancestor of the comments and climbs each one to the ancestor that is a direct child of it. Deriving it from the comments rather than hardcoding `UL`/`LI` means a Trello restructure doesn't break it.

Similarly, `comment-container` is wrapped in an extra `<div>`, so it has no next sibling — which is why `controlHost()` climbs rather than taking `nextElementSibling`.

## Ordering

Roots keep exactly the position Trello gave them; we have no business deciding the feed's sort, only where replies attach. Replies run oldest-first inside a thread so it reads top-down.

Paint order is assigned by walking Trello's *own* children and pulling each thread's replies up beneath their parent. Anything unbound — activity entries, a comment whose data hasn't loaded — stays exactly where it was. An earlier version parked every unmanaged child at `order: 10000+`, which quietly threw unbound comments to the bottom of the feed.

A thread is emitted at the position of its topmost *rendered* member, found by climbing. That matters for tombstones: they're appended at the end of the DOM, so placing them where they sit would drag their replies down with them.

## If it stops working

Enable **Log diagnostics** and check the console:

- `no comment rows found` — `SELECTORS.commentRow` needs updating.
- `could not resolve a feed container` — the comments have no shared ancestor; the card back was restructured.
- `no rows matched comment data` — rows were found, but none carried a `#comment-` permalink matching harvested data. Either the permalink markup changed or the API responses aren't being harvested.

## Not yet verified

- **The mention chip on the wire.** Its shape in the editor is confirmed; what Trello serialises on send is not. The de-dup is written to be safe either way, but it hasn't been observed.
- **Whether `@mention` notifications actually arrive.** String handling and suppression are tested; delivery needs a second person to confirm.
