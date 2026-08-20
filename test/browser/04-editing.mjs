/**
 * Editing a comment, and what it does to the invisible parent marker.
 *
 * The marker lives inside the comment's own text, so any path that rewrites
 * that text can destroy it. Editing is the obvious one: the text goes into
 * Trello's rich-text editor and comes back out again, and a zero-width
 * character has no visible presence for the editor to preserve on purpose.
 *
 * The README already warns this can happen ("a reply that loses its marker
 * degrades to a normal top-level comment"). This suite establishes which of
 * the two it actually is, so the documentation states a fact rather than a
 * hedge — and so a future change that makes it worse is caught.
 */
import {
  attach, openCard, createCard, post, replyVia, editComment, probe, watch,
  readTree, rawText, decodeMarker, reload, stamp, record, summary,
} from './harness.mjs';

const LIST = '6a8508bd571817194e5ba0a4';

const a = await attach(9222, 'A');
const b = await attach(9223, 'B');
console.log(`A = @${a.username}   B = @${b.username}\n`);

const card = await createCard(a, LIST, `edit probe ${new Date().toISOString().slice(0, 16)}`);
if (!card.shortLink) { console.error('card creation failed', card); process.exit(1); }
console.log(`card: https://trello.com/c/${card.shortLink}\n`);

await openCard(a, card.shortLink);
await openCard(b, card.shortLink);

const s = stamp();
const ROOT = `ed-root-${s}`;
const CHILD = `ed-child-${s}`;
const CHILD2 = `ed-child2-${s}`;

await post(a, ROOT);
await replyVia(a, ROOT, CHILD);
await replyVia(a, CHILD, CHILD2);

const rootId = (await probe(a, ROOT)).id;
const childId = (await probe(a, CHILD)).id;
const child2Id = (await probe(a, CHILD2)).id;

record('setup: reply is threaded under the root',
  (await probe(a, CHILD)).depth === 1,
  `depth=${(await probe(a, CHILD)).depth}`);

const beforeRaw = (await rawText(a, childId)).text || '';
record('setup: the reply carries a marker',
  decodeMarker(beforeRaw) === rootId,
  `marker=${decodeMarker(beforeRaw)} root=${rootId}`);

// ------------------------------------------------- 1. edit a REPLY's text
console.log('--- A edits the reply (select-all, retype) ---');
const EDITED = `ed-child-edited-${s}`;
await editComment(a, CHILD, EDITED);

const afterRaw = (await rawText(a, childId)).text || '';
const afterMarker = decodeMarker(afterRaw);
record('after editing, the marker survives in the stored text',
  afterMarker === rootId,
  afterMarker
    ? `marker=${afterMarker} root=${rootId}`
    : `MARKER LOST — stored text is now ${JSON.stringify(afterRaw.replace(/[​‌⁠]/g, ''))}`);

const editedProbe = await probe(a, EDITED);
record('after editing, the reply is still nested',
  editedProbe.depth === 1,
  editedProbe.depth === 1
    ? 'depth=1'
    : `depth=${editedProbe.depth} — the reply has escaped its thread`);

record('after editing, its own child is still nested under it',
  (await probe(a, CHILD2)).depth === 2,
  `depth=${(await probe(a, CHILD2)).depth} (expected 2)`);

// -------------------------------------------- 2. does the edit reach B live?
const bEdit = await watch(b, EDITED, 25);
record('B sees the edited text without navigating',
  bEdit.presentAt !== null,
  `visible after ${bEdit.presentAt}ms`);
record('B still has the edited reply threaded',
  (await probe(b, EDITED)).depth === 1,
  `depth=${(await probe(b, EDITED)).depth} (expected 1)`);

// ------------------------------------------------- 3. survives a reload
console.log('\n--- both reload ---');
await reload(a);
await reload(b);
for (const [who, sess] of [['A', a], ['B', b]]) {
  record(`${who}: edited reply still nested after reload`,
    (await probe(sess, EDITED)).depth === 1,
    `depth=${(await probe(sess, EDITED)).depth} (expected 1)`);
}

// -------------------------------------- 4. editing a PARENT with replies
console.log('\n--- A edits the ROOT, which has replies under it ---');
const ROOT_EDITED = `ed-root-edited-${s}`;
await editComment(a, ROOT, ROOT_EDITED);

record('editing a parent does not disturb its replies',
  (await probe(a, EDITED)).depth === 1 && (await probe(a, CHILD2)).depth === 2,
  `child depth=${(await probe(a, EDITED)).depth} grandchild depth=${(await probe(a, CHILD2)).depth}`);

const rootRawAfter = (await rawText(a, rootId)).text || '';
record('a root comment has no marker to lose',
  decodeMarker(rootRawAfter) === null,
  `marker=${decodeMarker(rootRawAfter)}`);

// ------------------------------- 5. degradation, if the marker is lost
if (afterMarker !== rootId) {
  record('a marker-less reply degrades to top level rather than vanishing',
    editedProbe.present === true && editedProbe.depth === 0,
    `present=${editedProbe.present} depth=${editedProbe.depth}`);
}

console.log('\nfinal tree (A):');
console.dir((await readTree(a)).rows, { depth: null });
console.log(`\ncard: https://trello.com/c/${card.shortLink}`);

const failures = summary();
await a.browser.close();
await b.browser.close();
process.exit(failures ? 1 : 0);
