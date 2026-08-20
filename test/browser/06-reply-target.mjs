/**
 * Does a reply still go where you aimed it?
 *
 * The reply target is armed when you click Reply and read again when you press
 * Save. Everything can move in between: the other person posts, Trello
 * re-renders the feed, you collapse something, you wander to another card. This
 * is the failure class the project has been bitten by twice already — a reply
 * threaded under a stranger's comment, and an abandoned reply tainting the next
 * comment — so each way the gap can be disturbed gets its own case.
 *
 * Every assertion is on the marker in the text Trello stored, not on the
 * rendered tree: that is what other people will see.
 */
import {
  attach, openCard, createCard, post, replyVia, probe, watch,
  rawText, decodeMarker, readTree, stamp, record, summary,
} from './harness.mjs';

const LIST = '6a8508bd571817194e5ba0a4';

const a = await attach(9222, 'A');
const b = await attach(9223, 'B');
console.log(`A = @${a.username}   B = @${b.username}\n`);

const card = await createCard(a, LIST, `reply-target ${new Date().toISOString().slice(0, 16)}`);
const card2 = await createCard(a, LIST, `reply-target-2 ${new Date().toISOString().slice(0, 16)}`);
if (!card.shortLink || !card2.shortLink) { console.error('card creation failed'); process.exit(1); }
console.log(`card:  https://trello.com/c/${card.shortLink}`);
console.log(`card2: https://trello.com/c/${card2.shortLink}\n`);

await openCard(a, card.shortLink);
await openCard(b, card.shortLink);

const s = stamp();
const MINE = `rt-mine-${s}`;
const THEIRS = `rt-theirs-${s}`;

await post(a, MINE);
await post(b, THEIRS);
await watch(a, THEIRS, 20);

const mineId = (await probe(a, MINE)).id;
const theirsId = (await probe(a, THEIRS)).id;
console.log('mine =', mineId, ' theirs =', theirsId);

/** Arm a reply on `needle` without sending, and return the mounted editor. */
async function armReply(sess, needle) {
  const row = sess.page.locator(`[data-tt-id]:has-text(${JSON.stringify(needle)})`).last();
  await row.hover();
  await sess.page.waitForTimeout(250);
  await row.locator('[data-tt="reply"]').first().click({ force: true });
  const ed = sess.page.locator('[data-testid*="comment"] [contenteditable="true"]').first();
  await ed.waitFor({ state: 'visible', timeout: 15000 });
  await sess.page.waitForTimeout(800);
  return ed;
}

async function sendComposer(sess, text) {
  const ed = sess.page.locator('[data-testid*="comment"] [contenteditable="true"]').first();
  await ed.click();
  await ed.type(text, { delay: 10 });
  await sess.page.getByRole('button', { name: /^save$/i }).first().click();
  await sess.page.waitForTimeout(3000);
}

const markerOf = async (sess, needle) => {
  const p = await probe(sess, needle);
  if (!p.id) return { marker: undefined, sent: null };
  const sent = (await rawText(sess, p.id)).text || '';
  return { marker: decodeMarker(sent), sent: sent.replace(/[​‌⁠]/g, ''), depth: p.depth };
};

// ------------------------- 1. another person posts while you are composing
console.log('--- A aims at its OWN comment; B posts mid-compose; A then sends ---');
await armReply(a, MINE);
const INTRUDER = `rt-intruder-${s}`;
await post(b, INTRUDER);                 // arrives on A over the socket
await watch(a, INTRUDER, 20);            // A re-renders with a new row
const AIMED = `rt-aimed-${s}`;
await sendComposer(a, AIMED);

const aimed = await markerOf(a, AIMED);
record('a reply still lands on the comment it was aimed at',
  aimed.marker === mineId,
  `marker=${aimed.marker} expected=${mineId} (intruder was ${(await probe(a, INTRUDER)).id})`);
record('and it did not pick up a stray @mention',
  !/@/.test(aimed.sent || ''),
  `sent=${JSON.stringify(aimed.sent)}`);

// ------------------------------- 2. abandoning a reply must not taint the next
console.log('\n--- A arms a reply on B’s comment, drafts, clears it, posts something else ---');
const ed = await armReply(a, THEIRS);
await ed.click();
await ed.type('draft that will be thrown away', { delay: 8 });
await a.page.waitForTimeout(600);
await a.page.keyboard.press('Control+A');
await a.page.keyboard.press('Backspace');
await a.page.waitForTimeout(1500);

const FRESH = `rt-fresh-${s}`;
await sendComposer(a, FRESH);
const fresh = await markerOf(a, FRESH);
record('an abandoned reply does not thread the next comment',
  fresh.marker === null,
  `marker=${fresh.marker} (expected none)`);
record('an abandoned reply does not @mention anyone',
  !/@/.test(fresh.sent || ''),
  `sent=${JSON.stringify(fresh.sent)}`);

// ------------------------------------ 3. collapsing mid-compose
console.log('\n--- A aims at B’s comment, collapses a thread, then sends ---');
await armReply(a, THEIRS);
const rootToggle = a.page.locator(`[data-tt-id]:has-text(${JSON.stringify(MINE)})`).last();
await rootToggle.hover();
await a.page.waitForTimeout(250);
const tg = rootToggle.locator('[data-tt="toggle"]').first();
if (await tg.count()) {
  await tg.click({ force: true });
  await a.page.waitForTimeout(1200);
}
const AFTER_COLLAPSE = `rt-collapse-${s}`;
await sendComposer(a, AFTER_COLLAPSE);
const afterCollapse = await markerOf(a, AFTER_COLLAPSE);
record('collapsing another thread mid-compose does not move the target',
  afterCollapse.marker === theirsId,
  `marker=${afterCollapse.marker} expected=${theirsId}`);
record('replying to someone else still @mentions them',
  (afterCollapse.sent || '').includes(`@${b.username}`),
  `sent=${JSON.stringify(afterCollapse.sent)}`);

// -------------------------------- 4. navigating away clears the target
console.log('\n--- A arms a reply, navigates to another card, posts there ---');
await armReply(a, THEIRS);
await openCard(a, card2.shortLink);
const ELSEWHERE = `rt-elsewhere-${s}`;
await post(a, ELSEWHERE);
const elsewhere = await markerOf(a, ELSEWHERE);
record('a reply armed on another card does not follow you',
  elsewhere.marker === null,
  `marker=${elsewhere.marker} (expected none)`);
record('and no @mention follows you either',
  !/@/.test(elsewhere.sent || ''),
  `sent=${JSON.stringify(elsewhere.sent)}`);

// ------------------------------------------------ 5. both replying at once
console.log('\n--- A and B reply to different comments at the same time ---');
await openCard(a, card.shortLink);
await watch(a, THEIRS, 20);
const A_SIM = `rt-simA-${s}`;
const B_SIM = `rt-simB-${s}`;
await Promise.all([replyVia(a, MINE, A_SIM), replyVia(b, THEIRS, B_SIM)]);
await a.page.waitForTimeout(3000);

const simA = await markerOf(a, A_SIM);
await watch(a, B_SIM, 20);
const simB = await markerOf(a, B_SIM);
record('simultaneous replies each keep their own target (A)',
  simA.marker === mineId,
  `marker=${simA.marker} expected=${mineId}`);
record('simultaneous replies each keep their own target (B)',
  simB.marker === theirsId,
  `marker=${simB.marker} expected=${theirsId}`);

console.log('\nfinal tree (A):');
console.dir((await readTree(a)).rows, { depth: null });
console.log(`\ncard: https://trello.com/c/${card.shortLink}`);

const failures = summary();
await a.browser.close();
await b.browser.close();
process.exit(failures ? 1 : 0);
