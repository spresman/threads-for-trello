# Chrome Web Store listing copy

Reference for filling in the Developer Dashboard. Keep this in sync with the
published listing so updates are easy.

---

## Name (max 75 chars)

```
Threads for Trello
```

## Summary / short description (max 132 chars)

```
Collapsible threaded replies on Trello cards — built on your real comments, so mentions, mobile, and the API all keep working.
```

## Category

Productivity (Workflow & Planning)

## Detailed description

```
Threads for Trello adds collapsible, threaded replies to the comments on a
Trello card — without replacing Trello's comment section.

Click Reply on any comment and your reply nests underneath it, connected by a
guide line, with a toggle that collapses everything below. It's the threading
Trello never had, right in the native feed.

The key difference from other tools: this threads your REAL Trello comments.
Every reply is an ordinary Trello comment, so notifications, @mentions,
reactions, editing, mobile, search, export, and the REST API all keep working
exactly as before. Uninstall the extension and the same conversation simply
reads as a flat list — nothing is lost.

FEATURES
• Reply to any comment to start or join a thread
• Collapse/expand threads; each parent shows its direct-reply count
• Guide lines and clean indentation, in light and dark
• Choose nested or flat replies, and set max depth and indent
• Optionally @mention the person you reply to, so they're notified
• Deleted comments that still have replies leave a tidy [deleted] placeholder
  so the thread keeps its shape

PRIVACY
No accounts, no servers, no tracking. Everything runs in your browser on
trello.com. Threading is stored as invisible markers inside your own comments;
collapse state stays local to your browser. See the privacy policy for details.

HOW IT WORKS
Trello comments have no "parent" field, so a reply records its parent's id as
an invisible marker (zero-width characters) appended to the comment text. The
extension reads those markers back out of Trello's own API responses and
re-renders the flat feed as a tree. Because it's still a normal comment, it
degrades gracefully everywhere the extension isn't installed.

Not affiliated with, endorsed by, or sponsored by Atlassian. "Trello" is a
trademark of Atlassian, used here only to describe what this extension works
with.
```

## Single purpose (required)

```
Adds threaded, collapsible replies to the native comment feed on Trello cards.
```

## Permission justifications (required)

- **host permission `https://trello.com/*`**
  ```
  The extension only works on Trello cards. It needs to run on trello.com to
  read the comment data Trello's own API returns and re-render the comment feed
  as threads. It requests access to no other site.
  ```
- **`storage`**
  ```
  Stores the user's settings (nesting mode, depth, indent, mention toggle) and
  which threads they have collapsed, locally in the browser. No data leaves the
  device.
  ```
- **Remote code**: No. All code is bundled in the package; nothing is fetched
  or evaluated at runtime.

## Data usage disclosures (Privacy practices tab)

- Does it collect user data? **No.**
- Certify: not sold to third parties; not used for unrelated purposes; not used
  for creditworthiness/lending.
- Privacy policy URL:
  ```
  https://github.com/spresman/threads-for-trello/blob/main/PRIVACY.md
  ```

## Assets

- Store icon: 128×128 — `icons/icon-128.png`
- Screenshot(s): 1280×800 — see `store-assets/`
- (Optional) small promo tile: 440×280

## Visibility

Public (or Unlisted while testing with a few people first).
