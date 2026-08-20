/**
 * Threads for Trello — page-context interceptor (MAIN world).
 *
 * Runs inside Trello's own JS context so it can patch fetch/XHR. Two jobs:
 *
 *   1. OUTBOUND — when the user submits a reply, append an invisible
 *      zero-width marker encoding the parent comment's action id.
 *   2. INBOUND  — deep-scan every API response for commentCard actions,
 *      decode their markers, and hand a clean {id, parentId, text} list
 *      to the content script.
 *
 * Working at the network layer (rather than the DOM) means we get Trello's
 * real action ids for free and never have to drive the React composer.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- marker

  // Binary encoding over two zero-width codepoints, fenced by WORD JOINER.
  // A 24-char hex action id becomes 96 invisible characters.
  const ZW_ZERO = '​'; // ZERO WIDTH SPACE        -> bit 0
  const ZW_ONE = '‌'; // ZERO WIDTH NON-JOINER   -> bit 1
  const ZW_FENCE = '⁠'; // WORD JOINER             -> delimiter
  const ID_HEX_LEN = 24;
  const ID_BIT_LEN = ID_HEX_LEN * 4;

  const MARKER_RE = new RegExp(
    ZW_FENCE + '([' + ZW_ZERO + ZW_ONE + ']{' + ID_BIT_LEN + '})' + ZW_FENCE
  );

  function encodeMarker(actionId) {
    if (!/^[0-9a-f]{24}$/i.test(actionId)) return '';
    let bits = '';
    for (const ch of actionId.toLowerCase()) {
      bits += parseInt(ch, 16).toString(2).padStart(4, '0');
    }
    const body = Array.from(bits, (b) => (b === '1' ? ZW_ONE : ZW_ZERO)).join('');
    return ZW_FENCE + body + ZW_FENCE;
  }

  /** @returns {{parentId: string|null, text: string}} */
  function decodeMarker(text) {
    if (typeof text !== 'string') return { parentId: null, text: '' };
    const m = text.match(MARKER_RE);
    if (!m) return { parentId: null, text };
    let hex = '';
    for (let i = 0; i < ID_BIT_LEN; i += 4) {
      const nibble = Array.from(m[1].slice(i, i + 4), (c) => (c === ZW_ONE ? '1' : '0')).join('');
      hex += parseInt(nibble, 2).toString(16);
    }
    return { parentId: hex, text: text.replace(MARKER_RE, '') };
  }

  /**
   * Rewrite an outgoing reply: prepend an @mention of whoever we're replying to
   * (so Trello notifies them — it has no native reply, so nothing else would)
   * and append the invisible parent marker.
   */
  function stamp(text, parentId) {
    let out = String(text == null ? '' : text);

    if (pendingMention) {
      const tag = '@' + pendingMention;
      const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Don't double-tag if the mention is already there — whether the author
      // typed it or Trello's Reply inserted it as a mention chip. The chip is
      // wrapped in zero-width spaces, which `\s` does not match, so testing the
      // raw text would miss it and prepend a second copy of the same mention.
      const probe = out.replace(new RegExp('[' + ZW_ZERO + ZW_ONE + ZW_FENCE + ']', 'g'), '');
      if (!new RegExp('(^|\\s)' + escaped + '(\\s|$)').test(probe)) {
        out = tag + ' ' + out;
      }
    }

    const marker = encodeMarker(parentId);
    if (!marker) return out;
    // Trailing position keeps the marker clear of Trello's markdown parsing
    // and out of the way if a client ever renders it literally.
    return out + marker;
  }

  // ----------------------------------------------------------------- state

  let pendingParentId = null;
  let pendingMention = null;

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.__tt !== 'content') return;
    if (msg.type === 'set-parent') {
      pendingParentId = msg.parentId || null;
      pendingMention = msg.mention || null;
    }
  });

  function send(type, payload) {
    window.postMessage(Object.assign({ __tt: 'page', type }, payload), '*');
  }

  // -------------------------------------------------------------- outbound

  const COMMENT_POST_RE = /\/actions\/comments/;

  function isCommentPost(url, method) {
    return (
      typeof url === 'string' &&
      COMMENT_POST_RE.test(url) &&
      String(method || 'GET').toUpperCase() === 'POST'
    );
  }

  /** Rewrite whichever body shape Trello happens to use. */
  function stampBody(body, parentId) {
    if (body instanceof URLSearchParams) {
      if (!body.has('text')) return { body, done: false };
      body.set('text', stamp(body.get('text'), parentId));
      return { body, done: true };
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      if (!body.has('text')) return { body, done: false };
      body.set('text', stamp(body.get('text'), parentId));
      return { body, done: true };
    }
    if (typeof body === 'string' && body.length) {
      // JSON payload
      if (/^\s*[{[]/.test(body)) {
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed.text === 'string') {
            parsed.text = stamp(parsed.text, parentId);
            return { body: JSON.stringify(parsed), done: true };
          }
        } catch (_) {
          /* fall through */
        }
        return { body, done: false };
      }
      // urlencoded payload
      try {
        const params = new URLSearchParams(body);
        if (params.has('text')) {
          params.set('text', stamp(params.get('text'), parentId));
          return { body: params.toString(), done: true };
        }
      } catch (_) {
        /* fall through */
      }
    }
    return { body, done: false };
  }

  /** Trello also accepts ?text= in the query string. */
  function stampUrl(url, parentId) {
    try {
      const u = new URL(url, location.origin);
      if (!u.searchParams.has('text')) return { url, done: false };
      u.searchParams.set('text', stamp(u.searchParams.get('text'), parentId));
      return { url: u.toString(), done: true };
    } catch (_) {
      return { url, done: false };
    }
  }

  // --------------------------------------------------------------- inbound

  /**
   * Deep-scan an arbitrary JSON payload for commentCard actions. Trello moves
   * comments between /cards/:id/actions, /batch, and other shapes, so we walk
   * the whole structure rather than pinning to one endpoint.
   */
  /**
   * Who wrote this action?
   *
   * REST responses carry a populated `memberCreator`. WebSocket deltas do not —
   * they carry only `idMemberCreator`, and put the human-readable identity
   * under `display.entities.memberCreator` instead. Without this fallback a comment
   * that arrived over the socket threads correctly but has no username, so
   * replying to it silently skips the @mention that notifies its author.
   */
  function creatorOf(node) {
    // Any populated memberCreator wins, even one carrying only a display name:
    // REST payloads vary in which fields they include.
    if (node.memberCreator && (node.memberCreator.username || node.memberCreator.fullName)) {
      return node.memberCreator;
    }
    const viaDisplay =
      node.display && node.display.entities && node.display.entities.memberCreator;
    if (viaDisplay && viaDisplay.username) return viaDisplay;
    if (Array.isArray(node.entities)) {
      const hit = node.entities.find(
        (e) => e && e.type === 'member' && e.username && e.id === node.idMemberCreator
      );
      if (hit) return hit;
    }
    return null;
  }

  function harvest(node, out, depth) {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) {
      for (const item of node) harvest(item, out, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    if (node.type === 'commentCard' && typeof node.id === 'string' && node.data) {
      const raw = node.data.text;
      if (typeof raw === 'string') {
        const { parentId, text } = decodeMarker(raw);
        const creator = creatorOf(node);
        out.push({
          id: node.id,
          parentId,
          text,
          date: node.date || null,
          cardId:
            (node.data.card && node.data.card.id) || node.data.idCard || null,
          author: (creator && (creator.fullName || creator.text || creator.username)) || null,
          // Kept separate from `author`: @mentions need the handle, not the
          // display name.
          username: (creator && creator.username) || null,
        });
      }
    }

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value && typeof value === 'object') harvest(value, out, depth + 1);
    }
  }

  function inspectPayload(text) {
    if (!text || typeof text !== 'string') return;
    if (text.indexOf('commentCard') === -1) return; // cheap bail-out
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      return;
    }
    const found = [];
    harvest(parsed, found, 0);
    if (found.length) send('comments', { comments: found });
  }

  // ---------------------------------------------------------------- patches

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let request = input;
      let options = init;

      try {
        const url = typeof request === 'string' ? request : request && request.url;
        const method =
          (options && options.method) || (request && request.method) || 'GET';

        if (pendingParentId && isCommentPost(url, method)) {
          const parentId = pendingParentId;
          let handled = false;

          if (options && 'body' in options) {
            const res = stampBody(options.body, parentId);
            if (res.done) {
              options = Object.assign({}, options, { body: res.body });
              handled = true;
            }
          }
          if (!handled) {
            const res = stampUrl(url, parentId);
            if (res.done) {
              if (typeof request === 'string') request = res.url;
              else request = new Request(res.url, request);
              handled = true;
            }
          }
          if (handled) {
            pendingParentId = null;
            pendingMention = null;
            send('reply-sent', { parentId });
          }
        }
      } catch (_) {
        /* never break Trello */
      }

      return origFetch.call(this, request, options).then((response) => {
        try {
          response
            .clone()
            .text()
            .then(inspectPayload)
            .catch(() => {});
        } catch (_) {
          /* ignore */
        }
        return response;
      });
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      this.__ttMethod = method;
      this.__ttUrl = url;
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      try {
        if (pendingParentId && isCommentPost(this.__ttUrl, this.__ttMethod)) {
          const res = stampBody(body, pendingParentId);
          if (res.done) {
            body = res.body;
            send('reply-sent', { parentId: pendingParentId });
            pendingParentId = null;
            pendingMention = null;
          }
        }
      } catch (_) {
        /* ignore */
      }

      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            inspectPayload(this.responseText);
          } else if (this.responseType === 'json' && this.response) {
            const found = [];
            harvest(this.response, found, 0);
            if (found.length) send('comments', { comments: found });
          }
        } catch (_) {
          /* ignore */
        }
      });

      return origSend.call(this, body);
    };
  }

  /**
   * Trello pushes live board activity over `wss://trello.com/1/Session/socket`.
   * A comment posted by someone else while your tab is open arrives *only*
   * there — it never touches fetch or XHR, so before this tap the extension
   * simply never learned about it. React rendered the comment, threads.js saw
   * an id it had no data for, and refused to claim the row: no threading, no
   * reply control, no @mention. It appeared to fix itself "later", which was
   * really the next unrelated REST call happening to carry the same action.
   *
   * A Proxy rather than a wrapper function so `instanceof`, the readyState
   * constants and everything else about WebSocket stay exactly as they were.
   * The listener is passive: it reads frames and never blocks, alters or
   * consumes them.
   */
  const OrigWebSocket = window.WebSocket;
  if (typeof OrigWebSocket === 'function') {
    window.WebSocket = new Proxy(OrigWebSocket, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget);
        try {
          ws.addEventListener('message', (ev) => {
            try {
              // Binary frames are Trello's own protocol chatter, never actions.
              if (typeof ev.data === 'string') inspectPayload(ev.data);
            } catch (_) {
              /* never break Trello */
            }
          });
        } catch (_) {
          /* ignore */
        }
        return ws;
      },
    });
  }

  send('ready', {});
})();
