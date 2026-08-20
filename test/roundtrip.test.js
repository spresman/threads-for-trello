/**
 * Integration test for interceptor.js.
 *
 * Loads the real MAIN-world script into a mock page context and drives it
 * through its actual public surface (window.fetch + postMessage), rather than
 * re-implementing the encoder in the test.
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'src', 'interceptor.js');

/**
 * Stand-in for the socket Trello opens to push live board activity. The
 * interceptor wraps this in a Proxy; `emit` plays a server frame back through
 * whatever listener it attached.
 */
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this._listeners = [];
  }
  addEventListener(type, fn) {
    if (type === 'message') this._listeners.push(fn);
  }
  emit(data) {
    for (const fn of this._listeners) fn({ data });
  }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;

function makeContext(fetchImpl) {
  const listeners = [];
  const outbox = [];

  const win = {
    addEventListener: (type, fn) => type === 'message' && listeners.push(fn),
    postMessage: (data) => {
      outbox.push(data);
      // Echo to listeners the way a real page does, so content->page
      // messages reach the interceptor.
      for (const fn of listeners) fn({ source: win, data });
    },
    fetch: fetchImpl,
    XMLHttpRequest: function () {},
    WebSocket: FakeWebSocket,
  };
  win.window = win;

  const ctx = {
    window: win,
    location: { origin: 'https://trello.com' },
    console,
    URL,
    URLSearchParams,
    FormData,
    Request,
    setTimeout,
  };
  ctx.globalThis = ctx;

  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'interceptor.js' });

  return { win, outbox, inject: (msg) => win.postMessage(msg) };
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  PASS  ' + name);
    passed++;
  } catch (err) {
    console.log('  FAIL  ' + name + '\n        ' + err.message);
    process.exitCode = 1;
  }
}

const PARENT_ID = '5f2a9c1b3e4d5a6b7c8d9e0f';
const CARD_URL = 'https://api.trello.com/1/cards/abc123/actions/comments';

// --------------------------------------------------------- outbound tests

console.log('\noutbound: marker injection');

check('urlencoded string body gets a marker appended', () => {
  let seen = null;
  const { win, inject } = makeContext((url, init) => {
    seen = init.body;
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve('') }) });
  });

  inject({ __tt: 'content', type: 'set-parent', parentId: PARENT_ID });
  win.fetch(CARD_URL, { method: 'POST', body: 'text=hello+world' });

  assert.ok(seen, 'fetch was not called');
  const params = new URLSearchParams(seen);
  const text = params.get('text');
  assert.ok(text.startsWith('hello world'), 'original text was mangled: ' + JSON.stringify(text));
  assert.ok(text.length > 'hello world'.length, 'no marker was appended');
});

check('JSON body gets a marker appended', () => {
  let seen = null;
  const { win, inject } = makeContext((url, init) => {
    seen = init.body;
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve('') }) });
  });

  inject({ __tt: 'content', type: 'set-parent', parentId: PARENT_ID });
  win.fetch(CARD_URL, { method: 'POST', body: JSON.stringify({ text: 'hi there' }) });

  const parsed = JSON.parse(seen);
  assert.ok(parsed.text.startsWith('hi there'));
  assert.ok(parsed.text.length > 'hi there'.length, 'no marker was appended');
});

check('query-string text gets a marker appended', () => {
  let seenUrl = null;
  const { win, inject } = makeContext((url) => {
    seenUrl = url;
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve('') }) });
  });

  inject({ __tt: 'content', type: 'set-parent', parentId: PARENT_ID });
  win.fetch(CARD_URL + '?text=inline', { method: 'POST' });

  const text = new URL(seenUrl).searchParams.get('text');
  assert.ok(text.startsWith('inline'));
  assert.ok(text.length > 'inline'.length, 'no marker was appended');
});

check('non-reply comments are left untouched', () => {
  let seen = null;
  const { win } = makeContext((url, init) => {
    seen = init.body;
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve('') }) });
  });

  win.fetch(CARD_URL, { method: 'POST', body: 'text=plain' });
  assert.strictEqual(seen, 'text=plain');
});

check('unrelated requests are left untouched', () => {
  let seen = null;
  const { win, inject } = makeContext((url, init) => {
    seen = init.body;
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve('') }) });
  });

  inject({ __tt: 'content', type: 'set-parent', parentId: PARENT_ID });
  win.fetch('https://api.trello.com/1/cards/abc123/labels', {
    method: 'POST',
    body: 'text=nope',
  });
  assert.strictEqual(seen, 'text=nope');
});

// ----------------------------------------------------------- mention tests

console.log('\noutbound: @mention injection');

/** Post a reply with a mention and return the text that went out. */
function sentTextWithMention(bodyText, mention) {
  let seen = null;
  const { win, inject } = makeContext((url, init) => {
    seen = init.body;
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve('') }) });
  });
  inject({ __tt: 'content', type: 'set-parent', parentId: PARENT_ID, mention });
  win.fetch(CARD_URL, { method: 'POST', body: 'text=' + encodeURIComponent(bodyText) });
  return new URLSearchParams(seen).get('text');
}

check('reply is prefixed with an @mention of the parent author', () => {
  const text = sentTextWithMention('sounds good', 'alexh');
  assert.ok(text.startsWith('@alexh sounds good'), 'got: ' + JSON.stringify(text.slice(0, 40)));
});

check('an @mention the author already typed is not duplicated', () => {
  const text = sentTextWithMention('@alexh sounds good', 'alexh');
  assert.strictEqual((text.match(/@alexh/g) || []).length, 1);
});

check('a mention Trello inserted as a chip is not duplicated', () => {
  // Trello's own Reply wraps the mention node in zero-width spaces, which \s
  // doesn't match — the naive check missed it and added a second mention.
  const text = sentTextWithMention('​@alexh​ sounds good', 'alexh');
  assert.strictEqual((text.match(/@alexh/g) || []).length, 1);
});

check('a similar-but-different handle still gets mentioned', () => {
  // "@alex" must not satisfy a pending mention of "@alexh".
  const text = sentTextWithMention('@alex sounds good', 'alexh');
  assert.ok(text.startsWith('@alexh @alex'), 'got: ' + JSON.stringify(text.slice(0, 40)));
});

check('no mention is added when none is supplied (own comment)', () => {
  const text = sentTextWithMention('replying to myself', null);
  assert.ok(text.startsWith('replying to myself'), 'got: ' + JSON.stringify(text.slice(0, 40)));
  assert.ok(!text.includes('@'));
});

check('the mention does not survive into the next comment', () => {
  let seen = null;
  const { win, inject } = makeContext((url, init) => {
    seen = init.body;
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve('') }) });
  });
  inject({ __tt: 'content', type: 'set-parent', parentId: PARENT_ID, mention: 'alexh' });
  win.fetch(CARD_URL, { method: 'POST', body: 'text=first' });
  win.fetch(CARD_URL, { method: 'POST', body: 'text=second' });
  assert.strictEqual(seen, 'text=second', 'second comment was altered: ' + seen);
});

// ---------------------------------------------------------- inbound tests

console.log('\ninbound: harvest + decode');

/** Round-trip: capture what the encoder produced, feed it back as an API response. */
function roundTrip(bodyText, wrap) {
  let stamped = null;
  const { win, outbox, inject } = makeContext((url, init) => {
    stamped = new URLSearchParams(init.body).get('text');
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve('') }) });
  });

  inject({ __tt: 'content', type: 'set-parent', parentId: PARENT_ID });
  win.fetch(CARD_URL, { method: 'POST', body: 'text=' + encodeURIComponent(bodyText) });

  const payload = wrap({
    id: '60b1c2d3e4f5a6b7c8d9e0f1',
    type: 'commentCard',
    date: '2026-08-12T10:00:00.000Z',
    memberCreator: { fullName: 'Sam Presman' },
    data: { text: stamped, card: { id: 'card9' } },
  });

  return new Promise((resolve) => {
    const { win: win2 } = makeContext(() =>
      Promise.resolve({
        clone: () => ({ text: () => Promise.resolve(JSON.stringify(payload)) }),
      })
    );
    // Re-wire outbox capture on the second context.
    const captured = [];
    const origPost = win2.postMessage;
    win2.postMessage = (d) => {
      captured.push(d);
      origPost(d);
    };
    win2.fetch('https://api.trello.com/1/cards/card9/actions').then(() => {
      setTimeout(() => resolve({ captured, stamped, outbox }), 0);
    });
  });
}

const pending = [];

pending.push(
  roundTrip('Let us wait for QA.', (action) => [action]).then(({ captured, stamped }) => {
    check('marker survives encode -> API response -> decode (array payload)', () => {
      const msg = captured.find((m) => m && m.type === 'comments');
      assert.ok(msg, 'no comments message was emitted');
      const c = msg.comments[0];
      assert.strictEqual(c.parentId, PARENT_ID, 'parent id did not round-trip');
      assert.strictEqual(c.text, 'Let us wait for QA.', 'visible text was not cleaned');
      assert.strictEqual(c.author, 'Sam Presman');
      assert.notStrictEqual(stamped, c.text, 'stamped text should differ from clean text');
    });
  })
);

pending.push(
  roundTrip('Nested payload', (action) => ({
    data: { board: { cards: [{ actions: [action] }] } },
  })).then(({ captured }) => {
    check('deep-scan finds comments nested inside batch-style payloads', () => {
      const msg = captured.find((m) => m && m.type === 'comments');
      assert.ok(msg, 'no comments message was emitted');
      assert.strictEqual(msg.comments[0].parentId, PARENT_ID);
      assert.strictEqual(msg.comments[0].text, 'Nested payload');
    });
  })
);

pending.push(
  roundTrip('Unicode ✅ emoji and “quotes”', (action) => [action]).then(({ captured }) => {
    check('marker survives alongside unicode content', () => {
      const msg = captured.find((m) => m && m.type === 'comments');
      const c = msg.comments[0];
      assert.strictEqual(c.parentId, PARENT_ID);
      assert.strictEqual(c.text, 'Unicode ✅ emoji and “quotes”');
    });
  })
);

// Plain comment with no marker at all.
pending.push(
  Promise.resolve().then(() => {
    const payload = [
      {
        id: '60b1c2d3e4f5a6b7c8d9e0f2',
        type: 'commentCard',
        date: '2026-08-12T09:00:00.000Z',
        data: { text: 'A normal top-level comment' },
      },
    ];
    const captured = [];
    const { win } = makeContext(() =>
      Promise.resolve({
        clone: () => ({ text: () => Promise.resolve(JSON.stringify(payload)) }),
      })
    );
    const orig = win.postMessage;
    win.postMessage = (d) => {
      captured.push(d);
      orig(d);
    };
    return win.fetch('https://api.trello.com/1/cards/card9/actions').then(
      () =>
        new Promise((r) =>
          setTimeout(() => {
            check('unmarked comments decode as roots with parentId null', () => {
              const msg = captured.find((m) => m && m.type === 'comments');
              assert.ok(msg);
              assert.strictEqual(msg.comments[0].parentId, null);
              assert.strictEqual(msg.comments[0].text, 'A normal top-level comment');
            });
            r();
          }, 0)
        )
    );
  })
);

// ------------------------------------------------------- websocket tests

console.log('\ninbound: live WebSocket frames');

/** The exact envelope Trello pushes for a new comment, captured from the wire. */
function socketFrame(text, extra) {
  return JSON.stringify({
    notify: {
      event: 'updateModels',
      typeName: 'Action',
      deltas: [
        Object.assign(
          {
            id: '60b1c2d3e4f5a6b7c8d9e0f3',
            idMemberCreator: '6a7cc7bd3a34a51309785d98',
            type: 'commentCard',
            date: '2026-08-20T17:43:18.024Z',
            data: { idCard: 'card9', idAuthor: '6a7cc7bd3a34a51309785d98', text },
            display: {
              translationKey: 'action_comment_on_card',
              entities: {
                memberCreator: {
                  type: 'member',
                  id: '6a7cc7bd3a34a51309785d98',
                  username: 'sampresman1',
                  text: 'Sam Presman',
                },
              },
            },
          },
          extra || {}
        ),
      ],
    },
  });
}

/** Open a socket through the (patched) constructor and play a frame down it. */
function pushFrame(frame) {
  const captured = [];
  const { win } = makeContext(() => Promise.resolve({ clone: () => ({ text: () => Promise.resolve('') }) }));
  const orig = win.postMessage;
  win.postMessage = (d) => {
    captured.push(d);
    orig(d);
  };
  const ws = new win.WebSocket('wss://trello.com/1/Session/socket');
  ws.emit(frame);
  return captured.find((m) => m && m.type === 'comments');
}

check('a comment arriving over the socket is harvested', () => {
  const msg = pushFrame(socketFrame('hello from the socket'));
  assert.ok(msg, 'no comments message was emitted for a socket frame');
  assert.strictEqual(msg.comments[0].id, '60b1c2d3e4f5a6b7c8d9e0f3');
  assert.strictEqual(msg.comments[0].text, 'hello from the socket');
});

check('socket deltas resolve the author from display.entities', () => {
  const msg = pushFrame(socketFrame('who wrote this'));
  // Without this the reply @mention is silently skipped: mentionFor() needs
  // a username, and socket deltas carry only idMemberCreator.
  assert.strictEqual(msg.comments[0].username, 'sampresman1');
  assert.strictEqual(msg.comments[0].author, 'Sam Presman');
});

check('a marked reply arriving over the socket keeps its parent', () => {
  // Same encoder the outbound path uses, so this is a true round-trip.
  let stamped = null;
  const { win, inject } = makeContext((url, init) => {
    stamped = new URLSearchParams(init.body).get('text');
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve('') }) });
  });
  inject({ __tt: 'content', type: 'set-parent', parentId: PARENT_ID });
  win.fetch(CARD_URL, { method: 'POST', body: 'text=threaded' });

  const msg = pushFrame(socketFrame(stamped));
  assert.strictEqual(msg.comments[0].parentId, PARENT_ID);
  assert.strictEqual(msg.comments[0].text, 'threaded');
});

check('the socket delta carries the card id', () => {
  const msg = pushFrame(socketFrame('scoped'));
  assert.strictEqual(msg.comments[0].cardId, 'card9');
});

check('non-comment socket chatter is ignored', () => {
  assert.strictEqual(
    pushFrame(JSON.stringify({ notify: { event: 'updateModels', typeName: 'Board', deltas: [{ id: 'b1' }] } })),
    undefined
  );
  assert.strictEqual(pushFrame('{"reqid":0,"result":true}'), undefined);
  assert.strictEqual(pushFrame('not json at all'), undefined);
});

check('patching WebSocket preserves instanceof and its constants', () => {
  const { win } = makeContext(() => Promise.resolve({ clone: () => ({ text: () => Promise.resolve('') }) }));
  const ws = new win.WebSocket('wss://trello.com/1/Session/socket');
  assert.ok(ws instanceof win.WebSocket, 'instanceof broke');
  assert.strictEqual(win.WebSocket.OPEN, 1, 'readyState constants were lost');
  assert.strictEqual(ws.url, 'wss://trello.com/1/Session/socket');
});

Promise.all(pending).then(() => {
  console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : '') + '\n');
});
