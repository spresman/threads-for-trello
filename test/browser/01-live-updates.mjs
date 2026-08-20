/**
 * The largest known break: comments that arrive over Trello's WebSocket.
 *
 * src/interceptor.js patches fetch and XMLHttpRequest only. Trello pushes live
 * board activity over a socket, so a comment posted by someone else while your
 * tab is open never passes through the interceptor. threads.js gates on that
 * data (`comments.has(id)` in bindRows), so the row is never claimed: no
 * threading, no rail, and no reply control of ours on it.
 *
 * A: sampresman1 (board admin)   B: schmule (normal member)
 */
import {
  attach, openCard, interceptorLive, readTree, probe, watch,
  post, replyVia, rawText, decodeMarker, stamp, record, summary,
} from './harness.mjs';

const BOARD = 'E1TfK1Kk';
const LIST = '6a8508bd571817194e5ba0a4';

const a = await attach(9222, 'A');
const b = await attach(9223, 'B');
console.log(`A = @${a.username}   B = @${b.username}\n`);

// Fresh card per run, so nothing here depends on leftovers.
const card = await a.page.evaluate(async ({ list, name }) => {
  const dsc = document.cookie.match(/(?:^|;\s*)dsc=([^;]+)/)?.[1];
  const r = await fetch('/1/cards', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idList: list, name, dsc }),
  });
  return r.ok ? await r.json() : { error: r.status, body: await r.text() };
}, { list: LIST, name: `socket probe ${new Date().toISOString().slice(0, 16)}` });

if (!card.shortLink) {
  console.error('could not create card:', card);
  process.exit(1);
}
console.log(`card: https://trello.com/c/${card.shortLink}\n`);

await openCard(a, card.shortLink);
await openCard(b, card.shortLink);

record('interceptor installed on A', await interceptorLive(a));
record('interceptor installed on B', await interceptorLive(b));

const s = stamp();
const ROOT = `probe-root-${s}`;
const REPLY = `probe-reply-${s}`;
const CROSS = `probe-cross-${s}`;

// ---------------------------------------------------------------- 1. own post
console.log('\n--- A posts a root comment (B is watching, will not navigate) ---');
await post(a, ROOT);

const ownSeen = await probe(a, ROOT);
record(
  'A: own new comment is claimed immediately',
  ownSeen.claimed === true,
  `present=${ownSeen.present} claimed=${ownSeen.claimed} id=${ownSeen.id}`
);

const bRoot = await watch(b, ROOT, 25);
record(
  'B: sees A’s comment in the DOM (socket delivery works)',
  bRoot.presentAt !== null,
  `visible after ${bRoot.presentAt}ms`
);
record(
  'B: claims A’s comment without navigating',
  bRoot.claimedAt !== null,
  bRoot.claimedAt !== null
    ? `claimed after ${bRoot.claimedAt}ms`
    : 'NEVER claimed — no [data-tt-id], no reply control, cannot be threaded'
);

const bProbeRoot = await probe(b, ROOT);
record(
  'B: our reply control exists on A’s comment',
  bProbeRoot.hasOurReply === true,
  `hasOurReply=${bProbeRoot.hasOurReply} nativeReplyVisible=${bProbeRoot.nativeReplyVisible}`
);

// ------------------------------------------------------- 2. threaded reply
console.log('\n--- A replies to its own comment via our control ---');
await replyVia(a, ROOT, REPLY);

const aReply = await probe(a, REPLY);
record(
  'A: own reply nests under its parent',
  aReply.depth === 1,
  `depth=${aReply.depth} (expected 1)`
);

const marker = aReply.id ? decodeMarker((await rawText(a, aReply.id)).text) : null;
record(
  'A: reply carries a marker pointing at the root',
  marker === bProbeRoot.id || marker === ownSeen.id,
  `marker=${marker} root=${ownSeen.id}`
);

const bReply = await watch(b, REPLY, 25);
record(
  'B: sees the reply in the DOM',
  bReply.presentAt !== null,
  `visible after ${bReply.presentAt}ms`
);
record(
  'B: threads the reply without navigating',
  bReply.claimedAt !== null,
  bReply.claimedAt !== null ? `claimed after ${bReply.claimedAt}ms` : 'NEVER claimed'
);

console.log('\nB tree BEFORE reload:');
console.dir(await readTree(b), { depth: null });

// ------------------------------ 3. what a user does next: reply to it anyway
console.log('\n--- B replies to A’s (unclaimed) comment, as a user would ---');
const bCanUseOurs = (await probe(b, ROOT)).hasOurReply;
if (bCanUseOurs) {
  const composerShowed = await replyVia(b, ROOT, CROSS);
  record(
    'B: composer shows the @mention before sending',
    /@/.test(composerShowed),
    `composer contained: ${JSON.stringify(composerShowed)}`
  );
} else {
  record(
    'B: had to fall back to Trello’s native Reply',
    null,
    'our control was absent, so the reply cannot carry a marker'
  );
  await post(b, CROSS);
}

const crossProbe = await probe(b, CROSS);
const crossRaw = crossProbe.id ? await rawText(b, crossProbe.id) : null;
const crossMarker = crossRaw ? decodeMarker(crossRaw.text) : null;
record(
  'B’s reply to A carries a parent marker',
  crossMarker !== null,
  crossMarker
    ? `marker=${crossMarker}`
    : 'NO MARKER — posted as a standalone top-level comment'
);

// -------------------------------------------------------- 4. the late render
console.log('\n--- B reloads: the "late render" ---');
await b.page.reload({ waitUntil: 'domcontentloaded' });
await b.page.waitForTimeout(6000);

const afterRoot = await probe(b, ROOT);
const afterReply = await probe(b, REPLY);
record(
  'B: after reload, A’s comment is finally claimed',
  afterRoot.claimed === true,
  `claimed=${afterRoot.claimed} depth=${afterRoot.depth}`
);
record(
  'B: after reload, the reply is nested',
  afterReply.depth === 1,
  `depth=${afterReply.depth} (expected 1)`
);

console.log('\nB tree AFTER reload:');
console.dir(await readTree(b), { depth: null });

console.log(`\ncard: https://trello.com/c/${card.shortLink}`);
const failures = summary();
await a.browser.close();
await b.browser.close();
process.exit(failures ? 1 : 0);
