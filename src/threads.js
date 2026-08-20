/**
 * Threads for Trello — content script (ISOLATED world).
 *
 * Receives decoded comment data from interceptor.js, works out which DOM node
 * renders which comment, then applies a threaded layout.
 *
 * Layout is done with flexbox `order` + `margin-left` rather than by moving
 * nodes. Trello is a React app; reparenting its nodes invites reconciliation
 * crashes, but restyling them is invisible to React.
 */
(() => {
  'use strict';

  const ZW_CLASS = /[​‌⁠]/g;
  const LOG = (...args) => SETTINGS.debug && console.log('[threads-for-trello]', ...args);

  const SELECTORS = {
    // Fast paths, newest first. Auto-discovery takes over if all miss.
    commentRow: [
      '[data-testid="trello-card-comment"]',
      '[data-testid="card-back-comment"]',
      '[data-testid="comment-container"]',
      '.comment-container',
      '.phenom-comment',
    ],
    // Trello renders a placeholder button that swaps in the real rich-text
    // editor on click, so the skeleton is what exists at rest.
    composer: [
      '[data-testid="card-back-new-comment-input-skeleton"]',
      '[data-testid="card-back-comment-input"]',
      '[data-testid="comment-box-input"]',
      '.comment-box-input',
      '.card-detail-window textarea',
    ],
  };

  const DEFAULTS = {
    // 'nested': a reply attaches to whatever you replied to.
    // 'flat':   a reply attaches to the top of its thread, so it never deepens.
    nestMode: 'nested',
    maxDepth: 4,
    indentPx: 24,
    autoCollapseAt: 0, // collapse threads with > N replies on load; 0 = never
    autoMention: true, // @mention whoever you're replying to, so they're notified
    debug: false,
  };

  let SETTINGS = Object.assign({}, DEFAULTS);

  /**
   * Horizontal home of a thread guide, relative to its level's left edge.
   *
   * Negative on purpose: Trello's comment bubble starts flush at x = 0 and
   * spans the full row width, so any positive offset draws the line straight
   * across the text. Sitting in the gutter keeps guides clear of the bubble
   * while still reading as though they descend from the avatar. `.tt-container`
   * carries matching padding so the outermost level has room.
   */
  /**
   * Guide geometry, measured against Trello's card back.
   *
   * The avatar occupies x 8–32 of a 32px column (scaled to 0.75, anchored
   * right); the comment body starts at x = 36. Rails run down the avatar's
   * centre and start *below* it, so they can never cut through the circle —
   * anchoring them to the avatar's left edge instead meant the origin's
   * horizontal run overlapped it.
   */
  const RAIL_X = 20; // avatar centre
  const AVATAR_LEFT = 8; // avatar's left edge within the row
  const AVATAR_BOTTOM = 40; // where a rail may start without touching it
  // Stop 1px short of the avatar: enough that the stroke never bites into the
  // circle, close enough that the curve reads as reaching it. At 3px the
  // quarter-turn ended with almost no horizontal run and looked like a stub.
  const ELBOW_GAP = 1;
  const ANCHOR = 24; // avatar's vertical centre — where a curve arrives
  const ELBOW_R = 8; // corner radius of the turn
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** id -> {id, parentId, text, date, author} */
  const comments = new Map();
  /** id -> collapsed? */
  let collapsed = new Set();
  /**
   * id -> parentId, remembered across reloads.
   *
   * Trello deletes a comment's action outright — it 404s afterwards — so once
   * the page is reloaded this is the only surviving record of where the deleted
   * comment sat. Its replies still carry a marker pointing at it, but its own
   * marker died with it, leaving its tombstone no choice but to become a root
   * and drag the whole thread to the top of the feed.
   */
  let knownParent = new Map();
  let parentsDirty = false;
  const PARENT_CAP = 5000; // ids are 24 hex chars; well inside the storage quota
  let currentCardKey = null;
  let pendingParent = null;
  let rescanTimer = null;
  let pathTimer = null;
  /** Set once the extension has been reloaded, updated or disabled under us. */
  let retired = false;

  // ------------------------------------------------------------- utilities

  const normalize = (s) =>
    String(s == null ? '' : s)
      .replace(ZW_CLASS, '')
      .replace(/\s+/g, ' ')
      .trim();

  // ------------------------------------------------- extension context death

  /**
   * Is the extension still alive behind this script?
   *
   * When an extension is reloaded, updated or disabled, Chrome leaves the
   * already-injected content script running in open tabs but cuts it off from
   * every chrome.* API. Because each storage call here is wrapped in a catch,
   * the script carried on rendering and looked perfectly healthy while silently
   * persisting nothing — a dead build masquerading as a live one, which cost an
   * entire debugging session and two mis-posted comments.
   *
   * This is not a developer-only condition. Chrome auto-updates extensions in
   * the background, so every user with a Trello tab open lands here on the day
   * you ship a new version.
   */
  function contextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  /**
   * Stand down: stop observing, stop rescanning, drop any pending reply target
   * (the MAIN-world interceptor survives independently and would otherwise
   * stamp a later comment with a stale parent), and say so on screen.
   */
  function retire(where) {
    if (retired) return;
    retired = true;
    console.warn(
      '[threads-for-trello] extension context invalidated (' +
        where +
        ') — reload this tab to resume threading.'
    );
    try {
      observer.disconnect();
    } catch (_) {
      /* already gone */
    }
    clearTimeout(rescanTimer);
    clearInterval(pathTimer);
    try {
      window.postMessage(
        { __tt: 'content', type: 'set-parent', parentId: null, mention: null },
        '*'
      );
    } catch (_) {
      /* ignore */
    }
    showRetiredNotice();
  }

  /**
   * A storage call threw.
   *
   * If the extension is gone, that's the reason, and the script should stand
   * down rather than carry on pretending to persist. Anything else is genuinely
   * unexpected and gets surfaced — the old blanket `catch (_) {}` is what let
   * both cases pass unnoticed.
   */
  function storageFailed(where, err) {
    if (!contextAlive()) return retire(where);
    console.warn('[threads-for-trello] storage failed in ' + where, err);
  }

  /**
   * Styles are inline rather than in threads.css on purpose: Chrome may drop a
   * content script's injected stylesheet when the extension unloads, which is
   * exactly the moment this notice needs to be visible.
   */
  function showRetiredNotice() {
    if (!document.body || document.querySelector('.tt-stale')) return;
    const el = document.createElement('div');
    el.className = 'tt-stale';
    el.textContent = 'Threads for Trello was updated — reload this page to resume threading.';
    el.title = 'Dismiss';
    el.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'max-width:280px',
      'padding:10px 12px',
      'border-radius:6px',
      'background:#172b4d',
      'color:#fff',
      "font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      'box-shadow:0 4px 12px rgba(0,0,0,.3)',
      'cursor:pointer',
    ].join(';');
    el.addEventListener('click', () => el.remove());
    document.body.appendChild(el);
  }

  function cardKey() {
    const m = location.pathname.match(/\/c\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }

  function firstMatch(list, root) {
    for (const sel of list) {
      const found = (root || document).querySelectorAll(sel);
      if (found.length) return Array.from(found);
    }
    return [];
  }

  // ------------------------------------------------------------- messaging

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.__tt !== 'page') return;

    if (msg.type === 'comments' && Array.isArray(msg.comments)) {
      let changed = false;
      for (const c of msg.comments) {
        const prev = comments.get(c.id);
        if (!prev || prev.parentId !== c.parentId || prev.text !== c.text) changed = true;
        comments.set(c.id, c);
        // Record the link while the comment still exists. After it's deleted
        // there is nowhere left to learn it from.
        if (c.parentId && knownParent.get(c.id) !== c.parentId) {
          knownParent.set(c.id, c.parentId);
          parentsDirty = true;
        }
      }
      if (parentsDirty) saveParents();
      if (changed) scheduleRescan();
    }

    if (msg.type === 'reply-sent') {
      clearPendingParent();
      scheduleRescan();
    }
  });

  /**
   * Trello renders "Edit" only on your own comments, which is a reliable
   * ownership tell that needs no member ids or /members/me lookup. ("Delete"
   * won't do — board admins get it on other people's comments too.)
   */
  function isOwnComment(id) {
    const body = bodyById.get(id);
    if (!body) return false;
    const block =
      body.closest('[data-testid="card-back-action-container"]') || body.parentElement;
    if (!block) return false;
    return Array.from(block.querySelectorAll('button')).some((b) =>
      /^edit$/i.test(b.textContent.trim())
    );
  }

  /** Who to @mention for a reply to `id`, or null to mention nobody. */
  function mentionFor(id) {
    if (!SETTINGS.autoMention) return null;
    const c = comments.get(id);
    if (!c || !c.username) return null;
    // Trello never notifies you about your own mention, so it'd be pure noise.
    if (isOwnComment(id)) return null;
    return c.username;
  }

  function setPendingParent(id, mention) {
    pendingParent = id;
    // A freshly armed reply has no draft yet; the empty composer that follows a
    // Reply click must not be read as an abandoned draft (see reconcilePendingReply).
    if (id) pendingDrafted = false;
    window.postMessage(
      { __tt: 'content', type: 'set-parent', parentId: id, mention: mention || null },
      '*'
    );
    document.querySelectorAll('.tt-row--replying').forEach((n) =>
      n.classList.remove('tt-row--replying')
    );
    if (id) {
      const node = nodeById.get(id);
      if (node) node.classList.add('tt-row--replying');
    }
  }

  function clearPendingParent() {
    setPendingParent(null);
  }

  /**
   * A pending reply target must not outlive the composing session that set it.
   *
   * `pendingParent` (and the mention that rides with it) is armed on a Reply
   * click and, until now, only disarmed on send, card navigation, or context
   * death. Abandoning the reply — clearing the drafted text, or clicking away
   * after drafting — left it armed, so the *next* comment posted on the card
   * silently inherited that parent *and* re-@mentioned its author, tagging and
   * notifying someone the user never meant to reply to.
   *
   * We disarm when a composer that *had* content becomes empty. The
   * "had content" guard (`pendingDrafted`) is what keeps this off a genuine
   * reply: right after a Reply click the composer is legitimately empty and
   * still mounting, and that empty state must not read as abandonment. A real
   * send is safe too — the interceptor clears pending via 'reply-sent' before
   * Trello tears the composer down, and a Save click leaves the text in place
   * at the moment it fires — so this never disarms a reply in flight.
   *
   * A mention reply always drafts content (the @handle chip or text), so its
   * higher-stakes case — an unwanted mention on the next comment — is always
   * covered once the draft is cleared.
   */
  let pendingDrafted = false;
  function reconcilePendingReply() {
    if (!pendingParent) return;
    const ed = document.querySelector('[data-testid*="comment"] [contenteditable="true"]');
    if (ed && editorText(ed)) {
      pendingDrafted = true; // a draft exists; this is a live reply
    } else if (pendingDrafted) {
      clearPendingParent(); // draft was cleared/discarded -> reply abandoned
    }
  }
  // Editing the draft down to empty disarms before replacement text is typed.
  document.addEventListener('input', reconcilePendingReply, true);
  // Blurring away after drafting (Trello may discard the draft) disarms too.
  // Deferred a tick so focus moving to the Save button — draft still present —
  // is never mistaken for abandonment.
  document.addEventListener('focusout', () => setTimeout(reconcilePendingReply, 0), true);

  // ----------------------------------------------------- node <-> id match

  /** comment id -> its ordering row, and -> its comment body element. */
  let nodeById = new Map();
  let bodyById = new Map();

  /**
   * Locate the element that renders each comment.
   *
   * Strategy 1: known test ids.
   * Strategy 2: auto-discovery — find the deepest element containing a
   * comment's text, then climb until one step further would swallow a
   * different comment. That ancestor is the comment "row", and it survives
   * Trello renaming its CSS classes.
   */
  function findCommentBodies() {
    const fast = firstMatch(SELECTORS.commentRow);
    if (fast.length) return fast;

    const texts = [];
    for (const c of comments.values()) {
      const t = normalize(c.text);
      if (t.length >= 3) texts.push({ id: c.id, t });
    }
    if (!texts.length) return [];

    const rows = [];
    for (const { t } of texts) {
      let deepest = null;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        if (el.childElementCount > 12) continue;
        if (normalize(el.textContent).includes(t)) deepest = el;
      }
      if (!deepest) continue;

      // Climb while the ancestor still represents exactly one comment.
      let row = deepest;
      while (row.parentElement && row.parentElement !== document.body) {
        const parent = row.parentElement;
        const parentText = normalize(parent.textContent);
        const others = texts.filter((o) => o.t !== t && parentText.includes(o.t));
        if (others.length) break;
        row = parent;
      }
      if (!rows.includes(row)) rows.push(row);
    }
    return rows;
  }

  /**
   * The element rendering a comment is usually buried several levels below the
   * feed list, so it has no siblings and `order` on it does nothing. Climb each
   * body to the ancestor that is a *direct child* of the shared feed container,
   * which is the level where ordering actually applies.
   *
   * The shared container is derived from the comments themselves (lowest common
   * ancestor) rather than hardcoded, so Trello restructuring its card back
   * doesn't break this.
   */
  function normalizeRows(bodies) {
    if (!bodies.length) return { container: null, pairs: [] };

    if (bodies.length === 1) {
      const only = bodies[0];
      const row = only.closest('li') || only.parentElement || only;
      return { container: row.parentElement, pairs: [{ row, body: only }] };
    }

    let lca = bodies[0];
    for (let i = 1; i < bodies.length; i++) {
      while (lca && !lca.contains(bodies[i])) lca = lca.parentElement;
      if (!lca) return { container: null, pairs: [] };
    }
    if (lca === bodies[0]) lca = lca.parentElement;

    const pairs = [];
    for (const body of bodies) {
      let row = body;
      while (row.parentElement && row.parentElement !== lca) row = row.parentElement;
      if (row.parentElement === lca) pairs.push({ row, body });
    }
    return { container: lca, pairs };
  }

  /**
   * Bind rows to comments by Trello's own permalink id.
   *
   * Every comment's timestamp is an anchor of the form `#comment-<actionId>`,
   * which is the authoritative identity — no guessing required. This replaced
   * matching on rendered text, which failed whenever the rendered form differed
   * from the stored form: emoji become <img> and contribute no text, links and
   * attachments render as preview cards bearing no resemblance to the URL, and
   * identical text on two comments was ambiguous. The positional fallback that
   * tried to paper over those cases mis-paired rows and scrambled the feed.
   */
  function bindRows(pairs) {
    const map = new Map();
    for (const { row, body } of pairs) {
      // Scoped to the comment's own action container rather than the whole row.
      // Trello re-renders the feed constantly, and a row read mid-swap can hold
      // one comment's body beside another's timestamp — searching the narrower
      // box shrinks the window in which that pairs across comments.
      const scope = body.closest('[data-testid="card-back-action-container"]') || row;
      const anchor = scope.querySelector('a[href^="#comment-"]');
      if (!anchor) continue;
      const m = (anchor.getAttribute('href') || '').match(/#comment-([0-9a-f]{24})/i);
      const id = m && m[1].toLowerCase();
      // Requires the API data too — the parent marker and author live there.
      if (id && comments.has(id)) map.set(body, id);
    }
    return map;
  }

  /**
   * Which comment does this control belong to? Re-derived from the DOM at the
   * moment of the click, never captured.
   *
   * A pass that reads a row mid-render can pair one comment's body with
   * another's permalink. The binding heals on the next pass — but a control
   * created during the bad pass keeps whatever id it closed over for as long as
   * the button lives, so one transient glitch silently misdirects every later
   * click on it. That's how a reply to your own comment ended up threaded under
   * someone else's, with no @mention to give it away (the mention lookup asked
   * whether the *bound body* was yours, and it was).
   *
   * Reading Trello's own permalink at click time makes the DOM the single
   * source of truth, so nothing we get wrong can outlive one render.
   */
  function idForControl(el) {
    const row = el.closest('[data-tt-id]');
    if (!row) return null;
    const scope = el.closest('[data-testid="card-back-action-container"]') || row;
    const anchor = scope.querySelector('a[href^="#comment-"]');
    const m = anchor && (anchor.getAttribute('href') || '').match(/#comment-([0-9a-f]{24})/i);
    // Tombstones have no permalink; their row id is refreshed every pass.
    return m ? m[1].toLowerCase() : row.dataset.ttId || null;
  }

  // ------------------------------------------------------------ tree model

  /**
   * A tombstone standing in for a deleted comment, so its replies keep their
   * place in the thread instead of collapsing to top level.
   *
   * Appended to the feed rather than spliced into it: paint order is controlled
   * by `order`, so the node can sit last in the DOM and still render in the
   * right place. That keeps us out of the middle of React's child list.
   */
  function ensureGhostRow(container, id) {
    let el = container.querySelector(':scope > [data-tt-ghost="' + id + '"]');
    if (!el) {
      el = document.createElement('li');
      el.className = 'tt-row tt-ghost';
      el.setAttribute('data-tt-ghost', id);
      const label = document.createElement('div');
      label.className = 'tt-ghost__label';
      label.textContent = '[deleted]';
      el.appendChild(label);
      container.appendChild(el);
    }
    el.dataset.ttId = id;
    el.style.position = 'relative';
    return el;
  }

  /**
   * Where does a tombstone belong?
   *
   * The deleted comment is gone from the API, so its own parent link is gone
   * with it — climb the remembered map instead, until we reach an ancestor
   * that's actually on screen. That may itself be a tombstone, since `nodeById`
   * holds those too; deleted ancestors with no surviving replies of their own
   * are skipped rather than stacking up empty tombstones.
   */
  function nearestKnownAncestor(id) {
    let cur = knownParent.get(id);
    const guard = new Set([id]);
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      if (nodeById.has(cur)) return cur;
      cur = knownParent.get(cur);
    }
    return null;
  }

  function buildTree(ghosts) {
    const children = new Map();
    const roots = [];
    // The authoritative parent lookup. Everything downstream — depth, rails,
    // paint order — must use this rather than `comments`, which knows nothing
    // about tombstones: after a reload the deleted comment is gone from the API
    // entirely, so climbing via `comments` stopped dead and its replies were
    // rendered at depth 0, orphaned from the tombstone holding their thread.
    const parentOf = new Map();
    const byDate = Array.from(comments.values()).sort((a, b) =>
      String(a.date).localeCompare(String(b.date))
    );

    for (const c of byDate) {
      // A ghost parent counts as a parent: the comment was deleted, but its
      // tombstone is on screen holding the thread together. Without that, a
      // marker pointing at an unknown comment degrades to a root — orphan-safe,
      // but it breaks the thread apart visually.
      const known =
        c.parentId && (comments.has(c.parentId) || ghosts.has(c.parentId));
      const hasParent = known && c.parentId !== c.id;
      if (!hasParent) {
        roots.push(c.id);
        continue;
      }
      if (!children.has(c.parentId)) children.set(c.parentId, []);
      children.get(c.parentId).push(c.id);
      parentOf.set(c.id, c.parentId);
    }

    // Tombstones are placed last, so the anchor they attach to already holds
    // its real children and the tombstone can be slotted among them by date.
    // A tombstone's own date is unknown, so borrow its earliest reply's — the
    // deleted comment must predate everything replying to it.
    const ghostDate = (gid) => {
      let best = '';
      for (const c of comments.values()) {
        if (c.parentId === gid && (!best || String(c.date) < best)) best = String(c.date);
      }
      return best;
    };

    const ghostRoots = [];
    for (const gid of ghosts) {
      const anchor = nearestKnownAncestor(gid);
      // Never seen this comment before it was deleted (a card opened for the
      // first time after the fact) — nothing to attach it to, so root it.
      if (!anchor) {
        ghostRoots.push(gid);
        continue;
      }
      if (!children.has(anchor)) children.set(anchor, []);
      const arr = children.get(anchor);
      const d = ghostDate(gid);
      let at = arr.findIndex((s) => String((comments.get(s) || {}).date || '') > d);
      if (at < 0) at = arr.length;
      arr.splice(at, 0, gid);
      parentOf.set(gid, anchor);
    }
    // Front of the list, matching where tombstones used to be pushed: `roots`
    // is walked in reverse, so this keeps them walked last.
    roots.unshift(...ghostRoots);

    // Guard against marker cycles.
    const depthOf = new Map();
    const order = [];
    const walk = (id, depth, seen) => {
      if (seen.has(id)) return;
      seen.add(id);
      depthOf.set(id, depth);
      order.push(id);
      for (const kid of children.get(id) || []) walk(kid, depth + 1, seen);
    };
    // Roots newest-first so the feed still reads the way Trello orders it;
    // replies oldest-first so a thread reads top-down in the order it happened.
    const seen = new Set();
    for (const id of roots.slice().reverse()) walk(id, 0, seen);
    for (const c of byDate) if (!seen.has(c.id)) walk(c.id, 0, seen);
    // Safety net: a tombstone whose anchor somehow never got walked would
    // otherwise fall out of `order` entirely and go unstyled — no depth, no
    // indent, no guides.
    for (const gid of ghosts) if (!seen.has(gid)) walk(gid, 0, seen);

    return { children, order, depthOf, parentOf, rootOrder: roots.slice().reverse() };
  }

  /**
   * Does this comment have a later sibling? Determines whether an ancestor's
   * guide rail keeps running past the current row.
   */
  function hasFollowingSibling(id, children, rootOrder, parentOf) {
    const pid = parentOf.get(id) || null;
    // Only siblings with a rendered row count — a deleted one would otherwise
    // keep the rail running down to a reply that no longer exists.
    const sibs = (pid ? children.get(pid) || [] : rootOrder).filter((s) => nodeById.has(s));
    const i = sibs.indexOf(id);
    return i >= 0 && i < sibs.length - 1;
  }

  function descendantsOf(children, id, out) {
    for (const kid of children.get(id) || []) {
      out.push(kid);
      descendantsOf(children, kid, out);
    }
    return out;
  }

  /**
   * Direct replies that are actually on screen.
   *
   * Children, not the whole subtree: "3 replies" means the three rows that
   * appear when you expand, not everything nested beneath them. Each of those
   * carries its own count for what's under it.
   *
   * Tombstones count. A deleted comment still holds a place in the thread, and
   * its replies hang off it rather than off this comment — so leaving it out
   * would report a smaller number than the rows that actually appear.
   *
   * The `comments` map only ever grows — nothing prunes it — so a deleted reply
   * lives on in the model. Counting the model kept the collapse toggle and the
   * parent's rail alive after the reply's row was gone. Collapsed replies are
   * still bound (just hidden), so they correctly continue to count.
   */
  function renderedChildren(children, id) {
    return (children.get(id) || []).filter((k) => nodeById.has(k));
  }

  // --------------------------------------------------------------- render

  function apply() {
    if (retired) return;
    // Checked here rather than only in the storage helpers: this runs on every
    // mutation, so it notices within a frame or two of the extension going away
    // even on a card where nothing is being saved.
    if (!contextAlive()) return retire('apply');
    if (!comments.size) return;

    const key = cardKey();
    if (key !== currentCardKey) {
      currentCardKey = key;
      loadCollapsed(key);
    }

    const bodies = findCommentBodies();
    if (!bodies.length) return LOG('no comment rows found');

    const { container, pairs } = normalizeRows(bodies);
    if (!container || !pairs.length) return LOG('could not resolve a feed container');

    const rowOf = new Map(pairs.map((p) => [p.body, p.row]));
    const bodyToId = bindRows(pairs);
    if (!bodyToId.size) return LOG('no rows matched comment data');

    // Record the feed's own layout before we touch it. `order` is honoured by
    // both flex and grid, so we only impose flex when it's neither — otherwise
    // we'd flatten Trello's column layout for avatar / name / timestamp.
    if (!container.dataset.ttDisplay) {
      container.dataset.ttDisplay = getComputedStyle(container).display;
    }
    const ordersNatively = /flex|grid/.test(container.dataset.ttDisplay);
    container.classList.add('tt-container');
    container.classList.toggle('tt-container--forceflex', !ordersNatively);

    nodeById = new Map();
    bodyById = new Map();
    for (const [body, id] of bodyToId) {
      nodeById.set(id, rowOf.get(body) || body);
      bodyById.set(id, body);
    }

    // A parent referenced by a rendered reply but with no row of its own has
    // been deleted. Stand a tombstone in its place so the thread keeps its
    // shape rather than its replies collapsing to top level. Covers both a
    // deletion during this session and a reload afterwards, where the API no
    // longer returns the comment at all.
    const ghosts = new Set();
    for (const id of bodyToId.values()) {
      const c = comments.get(id);
      const pid = c && c.parentId;
      if (pid && pid !== id && !nodeById.has(pid)) ghosts.add(pid);
    }
    for (const gid of ghosts) {
      const el = ensureGhostRow(container, gid);
      nodeById.set(gid, el);
      bodyById.set(gid, el);
    }
    // Retire tombstones no longer standing in for anything.
    container.querySelectorAll(':scope > .tt-ghost').forEach((el) => {
      if (!ghosts.has(el.dataset.ttId)) el.remove();
    });

    const { children, order, parentOf, rootOrder } = buildTree(ghosts);

    // No `comments.has` guard: after a reload the deleted comment is gone from
    // the API entirely, so a tombstone's id isn't in the map — but its collapsed
    // state still needs to apply to the replies it holds.
    const hidden = new Set();
    for (const id of collapsed) {
      descendantsOf(children, id, []).forEach((d) => hidden.add(d));
    }

    order.forEach((id) => {
      const row = nodeById.get(id);
      const body = bodyById.get(id);
      if (!row || !body) return;

      const kidCount = renderedChildren(children, id).length;
      const isCollapsed = collapsed.has(id);
      const indent = SETTINGS.indentPx;

      // Ancestor chain, root-most first, capped at the nesting limit.
      let chain = [];
      let anc = parentOf.get(id) || null;
      const seenAnc = new Set();
      while (anc && !seenAnc.has(anc)) {
        seenAnc.add(anc);
        chain.unshift(anc);
        anc = parentOf.get(anc) || null;
      }
      if (chain.length > SETTINGS.maxDepth) chain = chain.slice(-SETTINGS.maxDepth);
      const depth = chain.length;

      // Row height feeds the SVG path, so a comment growing taller redraws.
      const spec = {
        rails: [],
        elbow: null,
        parentRail: null,
        // Filled in below, once the row's visibility has been applied.
        rowH: 0,
      };
      // Ancestors above the immediate parent. The line at level L runs from
      // that ancestor down to its children, so it continues past this row only
      // if the child it passes through — chain[L + 1] — has a later sibling.
      // Testing the ancestor itself is wrong: it asks whether the *ancestor*
      // has more siblings, which is a different line entirely.
      for (let i = 0; i < depth - 1; i++) {
        if (hasFollowingSibling(chain[i + 1], children, rootOrder, parentOf)) {
          spec.rails.push(RAIL_X - (depth - i) * indent);
        }
      }
      if (depth > 0) {
        spec.elbow = {
          x: RAIL_X - indent,
          // Curve stops just short of this comment's avatar.
          endX: AVATAR_LEFT - ELBOW_GAP,
          continues: hasFollowingSibling(id, children, rootOrder, parentOf),
        };
      }
      if (kidCount > 0 && !isCollapsed) spec.parentRail = { x: RAIL_X };

      row.classList.add('tt-row');
      // Also inline: React owns `className` on these rows and wipes our class on
      // re-render. The guides are absolutely positioned, so losing the
      // positioned ancestor drops them onto the page origin — the stray rail in
      // the top-left corner. Re-applied every pass, so it self-heals.
      row.style.position = 'relative';
      row.dataset.ttId = id;
      row.dataset.ttDepth = String(depth);
      // Indent with a transform, never margin. Trello lays the comment feed out
      // as a grid whose rows use `grid-template-columns: subgrid` — their
      // children are placed on the *ancestor's* column lines, not the row's own
      // box. Margin pushes the row's box right while those children stay put,
      // which compresses the avatar's track to nothing (measured: 32px → 8 → 0)
      // and slides the avatar under the name. A transform moves the rendered
      // row without touching layout, so the tracks survive intact.
      row.style.marginLeft = '';
      row.style.transform = depth ? 'translateX(' + depth * indent + 'px)' : '';

      // The transform shifts the row right without shrinking it, so the body
      // would run past the panel edge. Pull the content back by the same amount
      // to keep every comment's right edge on the same line.
      const contentEl = row.querySelector('[data-testid="card-back-action-container"]');
      if (contentEl) contentEl.style.marginRight = depth ? depth * indent + 'px' : '';

      // Tag the avatar so CSS can scale it (uniformly — resizing the button
      // without its inner span turns the circle into an oval).
      const avatarSlot = row.firstElementChild;
      const avatar = avatarSlot && avatarSlot.querySelector('button, span');
      if (avatar) avatar.classList.add('tt-avatar');
      row.classList.toggle('tt-row--child', depth > 0);
      row.classList.toggle('tt-row--parent', kidCount > 0);
      row.classList.toggle('tt-row--collapsed', isCollapsed);
      row.style.display = hidden.has(id) ? 'none' : '';

      // A deleted comment can't be replied to or edited, but its thread must
      // still be collapsible — without a toggle, a thread collapsed before the
      // deletion has no way back and its replies look deleted too.
      if (row.classList.contains('tt-ghost')) decorateGhost(row, id, kidCount);
      else decorate(body, id, kidCount);

      // Measured only now, after `display` is set. A row being revealed is
      // still `display: none` earlier in this pass, so it measures 0 and the
      // path collapses to a 1px stub — the broken arc after expanding a thread.
      // Exact, never rounded: rows are ~100.43px, and rounding left every
      // vertical 0.43px short of the boundary.
      spec.rowH = row.getBoundingClientRect().height;
      decorateRails(row, spec);
    });

    // Siblings we don't manage (activity entries, "added this card to X") have
    // Any guide left behind by a re-render — its row replaced or its class
    // stripped — would anchor to whatever ancestor happens to be positioned, or
    // to the page itself. Drop them before they surface somewhere absurd.
    document.querySelectorAll('svg.tt-rails').forEach((s) => {
      const p = s.parentElement;
      if (!p || !p.classList.contains('tt-row')) s.remove();
    });

    // Paint order, assigned by walking Trello's OWN children.
    //
    // Roots keep exactly the position Trello gave them — we have no business
    // deciding the feed's sort, only where replies attach. A thread's replies
    // are pulled up to sit beneath their parent. Anything we didn't bind —
    // activity entries, or a comment whose text failed to match — stays exactly
    // where it was. The previous version parked every unmanaged child at
    // 10000+, which quietly threw unbound comments to the bottom of the feed.
    let seq = 0;
    const placed = new Set();
    const place = (el) => {
      el.style.order = String(seq++);
      placed.add(el);
    };

    for (const child of Array.from(container.children)) {
      if (placed.has(child)) continue;
      const cid = child.dataset ? child.dataset.ttId : null;

      if (cid && nodeById.has(cid)) {
        // Climb to the top of this comment's *rendered* thread, then emit the
        // whole subtree together. Climbing rather than skipping matters for
        // tombstones: they're appended at the end of the DOM, so they'd
        // otherwise be placed last and drag their replies down with them. Found
        // via a reply, the tombstone lands where that reply sits instead.
        let topId = cid;
        const guard = new Set();
        for (;;) {
          if (guard.has(topId)) break;
          guard.add(topId);
          const pid = parentOf.get(topId);
          if (pid && nodeById.has(pid)) topId = pid;
          else break;
        }
        const topRow = nodeById.get(topId);
        if (topRow && placed.has(topRow)) continue;
        for (const sid of [topId].concat(descendantsOf(children, topId, []))) {
          const r = nodeById.get(sid);
          if (r && !placed.has(r)) place(r);
        }
      } else {
        place(child);
      }
    }

    // Safety net: anything skipped above (an orphaned reply whose parent never
    // rendered) still gets a position rather than defaulting to order 0.
    for (const child of Array.from(container.children)) {
      if (!placed.has(child)) place(child);
    }

    LOG('applied', order.length, 'comments');
  }

  /**
   * Trello's own action row (the one carrying Edit / Delete) is the sibling
   * right after the comment body. Docking our controls there makes Reply read
   * as one of the comment's actions instead of floating above the text.
   *
   * Other people's comments have no Edit/Delete but still have the row, so we
   * anchor on position rather than on those buttons. If it's ever absent we
   * create our own row in the same place.
   */
  function controlHost(body) {
    const block =
      body.closest('[data-testid="card-back-action-container"]') ||
      body.closest('li') ||
      body.parentElement;

    // 1. Trello's action row, identified by the controls it carries.
    if (block) {
      const btn = Array.from(block.querySelectorAll('button')).find((b) =>
        /^(edit|delete)$/i.test(b.textContent.trim())
      );
      if (btn && btn.parentElement) return btn.parentElement;
    }

    // 2. Otherwise the row following the comment body. The body sits inside a
    //    wrapper div, so the action row is a sibling of an *ancestor*, not of
    //    the body itself — climb until something has a following sibling.
    //    Comments you can't edit still have this row (it holds reactions).
    let node = body;
    while (node && node !== block) {
      const next = node.nextElementSibling;
      if (next && !next.classList.contains('tt-ownrow')) return next;
      node = node.parentElement;
    }

    // 3. Nothing to dock into — make our own row.
    const parent = body.parentElement;
    if (!parent) return body;
    let own = parent.querySelector(':scope > .tt-ownrow');
    if (!own) {
      own = document.createElement('div');
      own.className = 'tt-ownrow';
      parent.appendChild(own);
    }
    return own;
  }

  /**
   * Trello's own Reply button — the one we hide in favour of ours.
   *
   * Hidden elements still respond to .click(), and clicking it is the only
   * reliable way to get a real mention *node* into the composer (the oval chip)
   * instead of plain "@handle" text. Trello's editor creates that node solely
   * through its own typeahead, and driving the typeahead from outside — insert
   * "@", wait for the popup, filter, select — worked only intermittently.
   */
  function nativeReplyFor(row) {
    return (
      Array.from(row.querySelectorAll('button')).find(
        (b) => !b.hasAttribute('data-tt') && /^reply$/i.test(b.textContent.trim())
      ) || null
    );
  }

  /** Add (or refresh) our controls inside Trello's action row. */
  function decorate(body, id, kidCount) {
    const host = controlHost(body);

    // If we found a real Trello row, drop any fallback row left over from a
    // pass where the action row hadn't rendered yet.
    if (!host.classList.contains('tt-ownrow')) {
      const block = body.closest('[data-testid="card-back-action-container"]');
      if (block) block.querySelectorAll('.tt-ownrow').forEach((n) => n.remove());
    }

    // Drop the wrapper older versions used — it sat inside the row's flex gap
    // and added spacing of its own.
    const stale = host.querySelector(':scope > .tt-controls');
    if (stale) stale.remove();

    // The toggle used to carry a separator dot; clear any left from an
    // earlier version of the extension.
    const staleSep = host.querySelector(':scope > [data-tt="sep-toggle"]');
    if (staleSep) staleSep.remove();

    // Trello re-renders the action row when reactions are added or removed, and
    // controlHost() can then resolve to a different element than last pass. Our
    // controls are left stranded in the old one — the duplicate separators and
    // second Reply that appear after removing a reaction. Sweep anything of
    // ours that isn't in the host we're about to use.
    const blockEl = body.closest('[data-testid="card-back-action-container"]');
    if (blockEl) {
      blockEl.querySelectorAll('[data-tt]').forEach((n) => {
        if (n.parentElement !== host) n.remove();
      });
    }

    // Borrow Trello's own button classes and separator node rather than
    // approximating them, so Reply is indistinguishable from Edit / Delete
    // across themes and any restyle they ship.
    // Descendants, not just direct children, and Reply is accepted too:
    // comments you can't edit have neither Edit nor Delete unless you're a
    // board admin, so Trello's own Reply is the only link-button left to copy —
    // we hide it, but can still clone from it. The label whitelist is
    // deliberate: a reaction chip is also a <button> carrying text (its count),
    // and cloning that gives Reply a grey pill.
    const native = Array.from(host.querySelectorAll('button')).find(
      (c) =>
        !c.hasAttribute('data-tt') && /^(edit|delete|reply)$/i.test(c.textContent.trim())
    );
    const nativeSep = Array.from(host.children).find(
      (c) =>
        c.tagName === 'SPAN' &&
        c.textContent.trim() === '•' &&
        !c.classList.contains('tt-hidden')
    );

    // Trello shows its own Reply on other people's comments. It prefills an
    // @mention but posts a flat comment, so ours supersedes it entirely — same
    // mention, plus threading. Hide it rather than render two buttons called
    // Reply, which is precisely how you end up clicking the wrong one.
    const nativeReply = Array.from(host.children).find(
      (c) =>
        c.tagName === 'BUTTON' &&
        !c.hasAttribute('data-tt') &&
        /^reply$/i.test(c.textContent.trim())
    );
    if (nativeReply && !nativeReply.classList.contains('tt-hidden')) {
      nativeReply.classList.add('tt-hidden');
      // Take its trailing separator too, or the row shows a doubled dot.
      const after = nativeReply.nextElementSibling;
      if (after && !after.hasAttribute('data-tt') && after.textContent.trim() === '•') {
        after.classList.add('tt-hidden');
      }
    }

    const makeSep = (kind) => {
      const s = nativeSep
        ? nativeSep.cloneNode(true)
        : Object.assign(document.createElement('span'), { textContent: '•' });
      s.removeAttribute('data-testid');
      s.setAttribute('data-tt', kind);
      s.classList.add('tt-sep');
      // The separator we clone is often the very one hidden alongside Trello's
      // native Reply, and cloneNode copies that class — which would make our
      // own separator invisible.
      s.classList.remove('tt-hidden');
      return s;
    };

    const makeBtn = (kind, cls) => {
      const b = document.createElement('button');
      b.type = 'button';
      // Native classes carry the colour, underline and hover; ours is only a hook.
      if (native) {
        b.className = native.className;
        // The button we cloned from may be Trello's Reply, which we hide.
        b.classList.remove('tt-hidden');
      } else {
        // Without this the button renders as raw browser chrome — grey box,
        // outset border, wrong size.
        b.classList.add('tt-fallback');
      }
      b.classList.add(cls);
      b.setAttribute('data-tt', kind);
      return b;
    };

    // Appended straight into the row (no wrapper) so its own `gap: 4px` applies.
    let reply = host.querySelector(':scope > [data-tt="reply"]');
    if (!reply) {
      reply = makeBtn('reply', 'tt-reply');
      // Safe to call it "Reply": Trello's own is hidden above, so there's only
      // ever one on the row.
      reply.textContent = 'Reply';
      reply.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Never the captured `id` — see idForControl().
        const target = idForControl(e.currentTarget) || id;
        // Thread position may resolve to an ancestor (flat mode, depth cap), but
        // the person being replied to is always the comment that was clicked.
        const mention = mentionFor(target);
        setPendingParent(resolveReplyTarget(target), mention);

        // Hand the mention to Trello when we can: its Reply inserts a real
        // mention node, ours can only type "@handle" as plain text. Guarded on
        // `mention`, so the autoMention setting still means something and this
        // never fires on your own comments (which have no native Reply anyway).
        const row = e.currentTarget.closest('[data-tt-id]');
        const native = mention && row && !composerHasText() ? nativeReplyFor(row) : null;
        if (native) {
          native.click(); // Trello inserts the chip and mounts the composer
          revealComposer(); // scroll only — touching it now would undo the chip
        } else {
          focusComposer(mention);
        }
      });
      host.appendChild(makeSep('sep-reply'));
      host.appendChild(reply);
    }

    // Trello's emoji wrapper ends with its own "•". On comments where Trello's
    // Reply is hidden, that dot sits directly before ours and you get two.
    // Show ours only when the preceding visible element doesn't already end in
    // one. Re-checked every pass, because the answer changes when a reaction is
    // added or removed and Trello re-renders the row.
    const sepReply = host.querySelector(':scope > [data-tt="sep-reply"]');
    if (sepReply) {
      let prev = sepReply.previousElementSibling;
      while (prev && prev.classList.contains('tt-hidden')) prev = prev.previousElementSibling;
      const alreadySeparated = Boolean(prev && prev.textContent.trim().endsWith('•'));
      sepReply.classList.toggle('tt-hidden', alreadySeparated);
    }

    // Only worth showing when there's a thread to act on.
    const isCollapsed = collapsed.has(id);
    let toggle = host.querySelector(':scope > [data-tt="toggle"]');

    if (kidCount > 0) {
      if (!toggle) {
        toggle = makeBtn('toggle', 'tt-toggle');
        toggle.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          // Same stale-closure hazard as Reply — this one would collapse the
          // wrong thread, which is easier to miss and just as wrong.
          toggleCollapsed(idForControl(e.currentTarget) || id);
        });
        // Leads the row, ahead of the reaction button (which lives in a wrapper
        // that is the row's first child):
        //   ▾ hide  🙂 • Edit • Delete • Reply
        // Deliberately no separator dot: the dots delimit Trello's comment
        // actions, and a plain space keeps the thread control reading as its
        // own thing rather than one more item in that list.
        host.insertBefore(toggle, host.firstChild);
      }
      const label = isCollapsed
        ? '▸ ' + kidCount + (kidCount === 1 ? ' reply' : ' replies')
        : '▾ hide';
      // Only touch the DOM when it actually changed, so this can't feed the
      // MutationObserver.
      if (toggle.textContent !== label) toggle.textContent = label;
      const expanded = String(!isCollapsed);
      if (toggle.getAttribute('aria-expanded') !== expanded) {
        toggle.setAttribute('aria-expanded', expanded);
        toggle.title = isCollapsed ? 'Expand thread' : 'Collapse thread';
      }
    } else if (toggle) {
      const sep = host.querySelector(':scope > [data-tt="sep-toggle"]');
      if (sep) sep.remove();
      toggle.remove();
    }
  }

  /**
   * A tombstone's only control: collapse/expand. There's no Trello action row
   * to dock into and nothing to clone styling from, so it builds its own row
   * and uses the fallback styling.
   */
  function decorateGhost(row, id, kidCount) {
    let bar = row.querySelector(':scope > .tt-ownrow');
    if (!kidCount) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'tt-ownrow';
      row.appendChild(bar);
    }

    let toggle = bar.querySelector('[data-tt="toggle"]');
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'tt-toggle tt-fallback';
      toggle.setAttribute('data-tt', 'toggle');
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleCollapsed(idForControl(e.currentTarget) || id);
      });
      bar.appendChild(toggle);
    }

    const isCollapsed = collapsed.has(id);
    const label = isCollapsed
      ? '▸ ' + kidCount + (kidCount === 1 ? ' reply' : ' replies')
      : '▾ hide';
    if (toggle.textContent !== label) toggle.textContent = label;
  }

  function toggleCollapsed(id) {
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    saveCollapsed();
    apply();
  }

  /**
   * Draw the thread guides for one row. Purely decorative — collapsing is the
   * arrow's job.
   *
   * Comment rows are flat siblings, so an ancestor's line has to be painted
   * *through* every deeper row beneath it to reach its next sibling. Each row
   * therefore draws one rail per ancestor level that still has siblings coming,
   * plus an elbow curving into its own comment.
   *
   * Rails sit 12px right of their level's left edge; a row indented by
   * `depth * indent` sees ancestor level i at `12 - (depth - i) * indent`.
   */
  function decorateRails(row, spec) {
    let layer = row.querySelector(':scope > .tt-rails');
    if (!spec.rails.length && !spec.elbow && !spec.parentRail) {
      if (layer) layer.remove();
      return;
    }
    if (!layer) {
      layer = document.createElementNS(SVG_NS, 'svg');
      layer.setAttribute('class', 'tt-rails');
      // Belt and braces: the CSS sets these too, but on the outermost <svg>
      // the overflow property alone still computed to `hidden`, which clipped
      // every guide (they all sit at negative x).
      layer.setAttribute('width', '100%');
      layer.setAttribute('height', '100%');
      layer.setAttribute('overflow', 'visible');
      // Appended, never inserted first: the layer is absolutely positioned so
      // its DOM position has no visual effect, but making it the row's first
      // child steals any `:first-child` / `:nth-child(1)` rule Trello uses to
      // place the avatar.
      row.appendChild(layer);
    }

    const want = JSON.stringify(spec);
    if (layer.dataset.ttSpec === want) return; // nothing changed; leave the DOM alone
    layer.dataset.ttSpec = want;

    // Overshoot the row boundary by 1px so consecutive rows' lines overlap
    // rather than meeting exactly — sub-pixel row heights otherwise leave a
    // visible hairline between them. Safe because overflow is visible and the
    // next row continues the line at the same x.
    const H = (spec.rowH + 1).toFixed(2);
    const A = ANCHOR;
    const R = ELBOW_R;
    const seg = [];

    // Guides sit to the left of the row, i.e. at negative x. Rather than rely
    // on `overflow: visible` — which computes to `hidden` here whether set by
    // CSS rule or SVG attribute, because Trello's stylesheet outranks ours —
    // widen the canvas leftward and shift every coordinate into it. Nothing is
    // ever outside the viewport, so clipping stops mattering.
    const guidePad = SETTINGS.maxDepth * SETTINGS.indentPx + 24;
    layer.style.left = -guidePad + 'px';
    layer.style.width = 'calc(100% + ' + guidePad + 'px)';
    const X = (v) => v + guidePad;

    // Ancestor lines passing straight through this row.
    for (const x of spec.rails) seg.push(`M${X(x)} 0V${H}`);

    if (spec.elbow) {
      const x = X(spec.elbow.x);
      const turn = `Q${x} ${A} ${x + R} ${A}H${X(spec.elbow.endX)}`;

      if (spec.elbow.continues) {
        // The line carries on past this reply, so it has to be its own subpath.
        // The turn starts on top of it and one stroke paints the union.
        seg.push(`M${x} 0V${H}`);
        seg.push(`M${x} ${A - R}${turn}`);
      } else {
        // ONE unbroken subpath, stem straight into the turn. A second `M` would
        // start a new subpath, and its butt cap meeting the stem's antialiases
        // into a visible seam — a single <path> alone doesn't prevent that.
        seg.push(`M${x} 0V${A - R}${turn}`);
      }
    }

    // A parent's line, dropping from below its own avatar to its replies.
    if (spec.parentRail) seg.push(`M${X(spec.parentRail.x)} ${AVATAR_BOTTOM}V${H}`);

    // ONE path, stroked once. Subpaths may overlap freely — a single stroke
    // operation paints the union, so a branch can't seam against the line it
    // branches from. Separate elements each get their own anti-aliased edge,
    // which is what made the junctions look doubled.
    let path = layer.firstElementChild;
    if (!path) {
      path = document.createElementNS(SVG_NS, 'path');
      layer.appendChild(path);
    }
    path.setAttribute('d', seg.join(''));
  }

  /**
   * Where should a reply to `id` actually attach?
   *  - flat:   always the thread root, so a thread never nests further.
   *  - nested: `id` itself, until maxDepth, then the deepest allowed ancestor.
   */
  function resolveReplyTarget(id) {
    const chainUp = (from) => {
      const chain = [];
      let cur = from;
      const guard = new Set();
      while (cur && comments.has(cur) && !guard.has(cur)) {
        guard.add(cur);
        chain.unshift(cur);
        const parent = comments.get(cur).parentId;
        cur = parent && comments.has(parent) ? parent : null;
      }
      return chain;
    };

    const chain = chainUp(id);
    if (!chain.length) return id;
    if (SETTINGS.nestMode === 'flat') return chain[0];
    return chain[Math.min(chain.length - 1, SETTINGS.maxDepth - 1)];
  }

  // ------------------------------------------------------------- composer

  function findComposer() {
    const fast = firstMatch(SELECTORS.composer);
    if (fast.length) return fast[0];
    const editable = document.querySelector(
      '.card-detail-window [contenteditable="true"], [data-testid*="comment"] [contenteditable="true"]'
    );
    return editable || null;
  }

  /**
   * Poll briefly for the real editor Trello mounts once the skeleton is clicked.
   *
   * Scoped to the composer's own container: a card back holds several
   * contenteditables (title, description), and a document-wide query can
   * happily return the wrong one.
   */
  function whenEditorReady(scope, timeoutMs) {
    const find = () => {
      const local = scope && scope.querySelector && scope.querySelector('[contenteditable="true"]');
      if (local) return local;
      return document.querySelector('[data-testid*="comment"] [contenteditable="true"]');
    };
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const ed = find();
        if (ed) return resolve(ed);
        if (Date.now() - started > timeoutMs) return resolve(null);
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  /**
   * The text the user has actually typed.
   *
   * Trello's composer is ProseMirror, and its "Write a comment…" placeholder is
   * a real <span> widget living inside the contenteditable — aria-hidden and not
   * editable, but very much present in textContent. Reading textContent directly
   * made the "don't disturb text in progress" guard below fire on an *empty*
   * composer, so the mention was never inserted.
   *
   * Keyed on aria-hidden rather than on Trello's class names: aria-hidden marks
   * decoration by definition, while a mention chip (contenteditable="false" but
   * announced to screen readers) still correctly counts as typed text.
   */
  function editorText(editor) {
    const clone = editor.cloneNode(true);
    clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
    return normalize(clone.textContent);
  }

  /**
   * Text already in the composer, so a second Reply click can't stack another
   * mention chip on top of what you were writing. Trello's own Reply has no
   * such guard — ours has always had one, and delegating to Trello would lose
   * it otherwise.
   */
  function composerHasText() {
    const ed = document.querySelector('[data-testid*="comment"] [contenteditable="true"]');
    return ed ? Boolean(editorText(ed)) : false;
  }

  /**
   * Show "@username " in the composer, the way Trello's own Reply does.
   *
   * This is presentation only — the interceptor injects the mention at send
   * time regardless, and de-duplicates, so a reply is tagged whether or not
   * this succeeds.
   */
  function insertMention(editor, username) {
    if (editorText(editor)) return; // don't disturb text already typed
    editor.focus();
    const tag = '@' + username + ' ';
    let ok = false;
    try {
      // Deprecated, but the one insertion path Trello's rich-text editor
      // reliably observes; writing to the DOM directly is discarded on its
      // next render.
      ok = document.execCommand('insertText', false, tag);
    } catch (_) {
      /* fall through */
    }
    if (!ok) {
      // editorText, not textContent — otherwise this writes the placeholder
      // back into the composer as literal text: "@alexh Write a comment…".
      editor.textContent = tag + editorText(editor);
      editor.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: tag, inputType: 'insertText' })
      );
    }
  }

  /**
   * Scroll the composer into view without touching it.
   *
   * Used after handing off to Trello's own Reply, which has already mounted the
   * composer and inserted the mention chip. focusComposer() must NOT be used
   * here: it clicks the composer skeleton to mount the editor, and when the
   * editor is already mounting that second click re-mounts it and the chip is
   * discarded. That is what made every reply *after the first one on a page*
   * arrive with an empty composer — the mention still reached the posted
   * comment, because the interceptor stamps it at send time, so the reply was
   * correctly threaded and the author correctly notified. It simply looked as
   * though nothing had happened, with no way to tell before pressing Send.
   */
  function revealComposer() {
    whenEditorReady(document, 2000).then((ed) => {
      if (ed) ed.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  function focusComposer(mention) {
    const el = findComposer();
    if (!el) return;
    // Captured before the click: the skeleton is replaced by the editor, but
    // its container persists and is where the editor will appear.
    const scope = el.parentElement || el.closest('form, div');
    // The resting state is a placeholder button; clicking it mounts the editor.
    if (el.tagName === 'BUTTON') el.click();
    else if (typeof el.focus === 'function') el.focus();

    // Scroll *after* the editor mounts — it replaces the skeleton and shifts
    // the layout, so scrolling first lands in the wrong place.
    whenEditorReady(scope, 2000).then((ed) => {
      const target = ed || el;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (!ed) return;
      ed.focus();
      if (mention) insertMention(ed, mention);
    });
  }

  // -------------------------------------------------------------- storage

  function storageKey(key) {
    return 'tt:collapsed:' + (key || 'unknown');
  }

  function loadCollapsed(key) {
    collapsed = new Set();
    try {
      chrome.storage.local.get(storageKey(key), (data) => {
        const list = data && data[storageKey(key)];
        if (Array.isArray(list)) {
          collapsed = new Set(list);
          apply();
        }
      });
    } catch (err) {
      storageFailed('loadCollapsed', err);
    }
  }

  /**
   * Keyed globally rather than per card: action ids are unique, and the card's
   * short URL key isn't the 24-hex id the harvest reports, so per-card keying
   * would need a lookup we don't have at load time. Capped so it can't grow
   * without bound over years of use.
   */
  function loadParents() {
    try {
      chrome.storage.local.get('tt:parents', (data) => {
        const obj = data && data['tt:parents'];
        if (obj && typeof obj === 'object') {
          knownParent = new Map(Object.entries(obj));
          apply();
        }
      });
    } catch (err) {
      storageFailed('loadParents', err);
    }
  }

  function saveParents() {
    parentsDirty = false;
    try {
      const entries = Array.from(knownParent).slice(-PARENT_CAP);
      knownParent = new Map(entries);
      chrome.storage.local.set({ 'tt:parents': Object.fromEntries(entries) });
    } catch (err) {
      storageFailed('saveParents', err);
    }
  }

  function saveCollapsed() {
    try {
      chrome.storage.local.set({ [storageKey(currentCardKey)]: Array.from(collapsed) });
    } catch (err) {
      storageFailed('saveCollapsed', err);
    }
  }

  function loadSettings() {
    try {
      chrome.storage.sync.get(DEFAULTS, (data) => {
        SETTINGS = Object.assign({}, DEFAULTS, data || {});
        apply();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        let touched = false;
        for (const k of Object.keys(changes)) {
          if (k in DEFAULTS) {
            SETTINGS[k] = changes[k].newValue;
            touched = true;
          }
        }
        if (touched) apply();
      });
    } catch (err) {
      storageFailed('loadSettings', err);
    }
  }

  // ----------------------------------------------------------- observation

  function scheduleRescan() {
    if (retired) return;
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(apply, 120);
  }

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      // Ignore mutations we caused ourselves.
      if (r.target && r.target.closest && r.target.closest('[data-tt], .tt-rails')) continue;
      scheduleRescan();
      return;
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  let lastPath = location.pathname;
  pathTimer = setInterval(() => {
    if (retired) return;
    if (!contextAlive()) return retire('pathWatch');
    // Trello inserts the @mention chip programmatically, which fires no `input`
    // event, so poll here too: this is what registers that a mention reply has
    // drafted content, so clearing that draft is then recognised as abandonment.
    reconcilePendingReply();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      clearPendingParent();
      scheduleRescan();
    }
  }, 500);

  loadSettings();
  loadParents();
  scheduleRescan();
})();
