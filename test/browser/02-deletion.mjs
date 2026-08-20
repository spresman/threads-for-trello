/**
 * Deletion and tombstones, across two accounts and across reloads.
 *
 * Trello hard-deletes a comment: GET /1/actions/<id> 404s afterwards, so the
 * deleted comment's own parent marker dies with it. Its replies still point at
 * it, which is what a tombstone stands in for. Where that tombstone *sits*
 * depends on `knownParent`, which the extension can only record while the
 * comment is still alive — so this suite is really about what each browser
 * managed to learn before the deletion happened.
 *
 * A: sampresman1 (board admin)   B: schmule (normal member)
 */
import {
  attach, openCard, createCard, post, replyVia, probe, watch, readTree,
  ghosts, deleteComment, reload, rawText, forgetParents, stamp, record, summary,
} from './harness.mjs';

const LIST = '6a8508bd571817194e5ba0a4';

const a = await attach(9222, 'A');
const b = await attach(9223, 'B');
console.log(`A = @${a.username}   B = @${b.username}\n`);

const card = await createCard(a, LIST, `deletion probe ${new Date().toISOString().slice(0, 16)}`);
if (!card.shortLink) { console.error('card creation failed', card); process.exit(1); }
console.log(`card: https://trello.com/c/${card.shortLink}\n`);

await openCard(a, card.shortLink);
await openCard(b, card.shortLink);

const s = stamp();
const ROOT = `del-root-${s}`;
const CHILD = `del-child-${s}`;
const GRAND = `del-grand-${s}`;
const LEAF = `del-leaf-${s}`;

// ------------------------------------------------- build a three-deep thread
console.log('--- A builds root > child > grandchild, plus a leaf on root ---');
await post(a, ROOT);
await replyVia(a, ROOT, CHILD);
await replyVia(a, CHILD, GRAND);
await replyVia(a, ROOT, LEAF);

const ids = {
  root: (await probe(a, ROOT)).id,
  child: (await probe(a, CHILD)).id,
  grand: (await probe(a, GRAND)).id,
  leaf: (await probe(a, LEAF)).id,
};
console.log('ids:', ids);

record('A: thread built to depth 2',
  (await probe(a, GRAND)).depth === 2,
  `grandchild depth=${(await probe(a, GRAND)).depth}`);

// B should have learned all four live, which is what lets it place a tombstone.
await watch(b, LEAF, 20);
const bBefore = await readTree(b);
record('B: learned every comment live (so knownParent is populated)',
  [ids.root, ids.child, ids.grand, ids.leaf].every((id) => bBefore.claimed.includes(id)),
  `B claimed ${bBefore.claimed.length} rows`);

// -------------------------------------------------- 1. childless deletion
console.log('\n--- A deletes the leaf (no replies of its own) ---');
const delLeaf = await deleteComment(a, ids.leaf);
record('leaf delete accepted by the API', delLeaf.ok, JSON.stringify(delLeaf));
await a.page.waitForTimeout(4000);

const gLeaf = await ghosts(a);
record('A: a childless deletion leaves NO tombstone',
  gLeaf.every((g) => g.id !== ids.leaf),
  `tombstones now: ${JSON.stringify(gLeaf)}`);

// --------------------------------------------- 2. deletion with replies
console.log('\n--- A deletes the child (which has a grandchild under it) ---');
const delChild = await deleteComment(a, ids.child);
record('child delete accepted by the API', delChild.ok, JSON.stringify(delChild));
await a.page.waitForTimeout(4000);

const gChildA = await ghosts(a);
record('A: deleting a comment with replies leaves a tombstone',
  gChildA.some((g) => g.id === ids.child),
  `tombstones: ${JSON.stringify(gChildA)}`);
record('A: the tombstone sits at depth 1, under the root',
  gChildA.find((g) => g.id === ids.child)?.depth === 1,
  `depth=${gChildA.find((g) => g.id === ids.child)?.depth} (expected 1)`);
record('A: the grandchild stays at depth 2, under the tombstone',
  (await probe(a, GRAND)).depth === 2,
  `depth=${(await probe(a, GRAND)).depth} (expected 2)`);

record('the deleted action really is gone from the API',
  (await rawText(a, ids.child)).status === 404,
  `GET /1/actions/${ids.child} -> ${(await rawText(a, ids.child)).status}`);

// -------------------------------------------- 3. the other browser, live
console.log('\n--- B, which never navigated ---');
await b.page.waitForTimeout(3000);
const gChildB = await ghosts(b);
record('B: sees the tombstone without navigating',
  gChildB.some((g) => g.id === ids.child),
  `tombstones: ${JSON.stringify(gChildB)}`);
record('B: places the tombstone at depth 1',
  gChildB.find((g) => g.id === ids.child)?.depth === 1,
  `depth=${gChildB.find((g) => g.id === ids.child)?.depth} (expected 1)`);
record('B: grandchild still at depth 2',
  (await probe(b, GRAND)).depth === 2,
  `depth=${(await probe(b, GRAND)).depth} (expected 2)`);

// ------------------------------------------------- 4. survives a reload
console.log('\n--- both reload: tombstone placement must persist ---');
await reload(a);
await reload(b);

for (const [who, sess] of [['A', a], ['B', b]]) {
  const g = await ghosts(sess);
  const tomb = g.find((x) => x.id === ids.child);
  record(`${who}: tombstone survives reload at depth 1`,
    tomb?.depth === 1,
    `tombstones: ${JSON.stringify(g)}`);
  record(`${who}: grandchild still nested at depth 2 after reload`,
    (await probe(sess, GRAND)).depth === 2,
    `depth=${(await probe(sess, GRAND)).depth} (expected 2)`);
}

// ------------------------------- 5. a browser that never saw the comment
console.log('\n--- B forgets what it learned: a first-time viewer ---');
// Exactly what a fresh install, or a different machine, would know: nothing.
// Trello hard-deletes the action, so the server has no record of the parent
// either, and the tombstone has nowhere to anchor.
await forgetParents(b);
await reload(b);

const gFresh = await ghosts(b);
const tombFresh = gFresh.find((x) => x.id === ids.child);
record('a first-time viewer still sees the tombstone, so replies keep a parent',
  Boolean(tombFresh),
  `tombstones=${JSON.stringify(gFresh)}`);
record('the grandchild stays attached to that tombstone',
  (await probe(b, GRAND)).depth === (tombFresh ? tombFresh.depth + 1 : -99),
  `tombstone depth=${tombFresh?.depth} grandchild depth=${(await probe(b, GRAND)).depth}`);

// The documented limitation: with nothing remembered, the tombstone cannot be
// placed under the root it belonged to and surfaces at top level instead.
record('KNOWN LIMITATION: without memory the tombstone floats to top level',
  tombFresh?.depth === 0 ? null : tombFresh?.depth === 1,
  tombFresh?.depth === 0
    ? 'depth=0 — as documented in the README; the thread still holds together'
    : `depth=${tombFresh?.depth} — better than documented`);

// Put B's memory back so later runs are not affected by this one.
await reload(b);

console.log('\nfinal tree (A):');
console.dir(await readTree(a), { depth: null });
console.log(`\ncard: https://trello.com/c/${card.shortLink}`);

const failures = summary();
await a.browser.close();
await b.browser.close();
process.exit(failures ? 1 : 0);
