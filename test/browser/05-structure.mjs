/**
 * Thread structure: the depth cap, collapse, and what the reply count counts.
 *
 * The count on a parent is deliberately its *direct* replies — the rows that
 * appear when you expand it — not its whole subtree. Collapsing still hides
 * everything beneath. A tombstone counts as a direct reply, because it occupies
 * a row like any other.
 *
 * The depth cap (default 4) means a reply deeper than that attaches to the
 * deepest allowed ancestor instead of nesting further.
 */
import {
  attach, openCard, createCard, post, replyVia, probe, watch, readTree,
  deleteComment, ghosts, reload, stamp, record, summary,
} from './harness.mjs';

const LIST = '6a8508bd571817194e5ba0a4';
const MAX_DEPTH = 4; // manifest default

const a = await attach(9222, 'A');
const b = await attach(9223, 'B');
console.log(`A = @${a.username}   B = @${b.username}\n`);

const card = await createCard(a, LIST, `structure ${new Date().toISOString().slice(0, 16)}`);
if (!card.shortLink) { console.error('card creation failed', card); process.exit(1); }
console.log(`card: https://trello.com/c/${card.shortLink}\n`);
await openCard(a, card.shortLink);
await openCard(b, card.shortLink);

const s = stamp();

/** Read a parent's toggle label. */
const toggleLabel = (sess, needle) =>
  sess.page.evaluate((t) => {
    const row = Array.from(document.querySelectorAll('[data-tt-id]')).find((n) => n.innerText.includes(t));
    const tg = row && row.querySelector('[data-tt="toggle"]');
    return tg ? tg.textContent.trim() : null;
  }, needle);

const clickToggle = async (sess, needle) => {
  const row = sess.page.locator(`[data-tt-id]:has-text(${JSON.stringify(needle)})`).last();
  await row.hover();
  await sess.page.waitForTimeout(250);
  await row.locator('[data-tt="toggle"]').first().click({ force: true });
  await sess.page.waitForTimeout(1200);
};

/** Is the row containing `needle` visible on screen? */
const isVisible = (sess, needle) =>
  sess.page.evaluate((t) => {
    const row = Array.from(document.querySelectorAll('[data-tt-id]')).find((n) => n.innerText.includes(t));
    if (!row) return null;
    const cs = getComputedStyle(row);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && row.offsetParent !== null;
  }, needle);

// ------------------------------------------------------- 1. the depth cap
console.log('--- A builds a chain 6 deep; the cap is ' + MAX_DEPTH + ' ---');
const chain = [];
for (let i = 0; i < 6; i++) chain.push(`st-d${i}-${s}`);

await post(a, chain[0]);
for (let i = 1; i < chain.length; i++) await replyVia(a, chain[i - 1], chain[i]);

const depths = [];
for (const c of chain) depths.push((await probe(a, c)).depth);
console.log('depths:', depths.join(' -> '));

record('the chain nests normally up to the cap',
  depths.slice(0, MAX_DEPTH + 1).every((d, i) => d === i),
  `first ${MAX_DEPTH + 1} depths = ${depths.slice(0, MAX_DEPTH + 1).join(',')}`);

record(`nothing nests deeper than ${MAX_DEPTH}`,
  depths.every((d) => d <= MAX_DEPTH),
  `max observed = ${Math.max(...depths)}`);

record('replies past the cap attach to the deepest allowed ancestor',
  depths.slice(MAX_DEPTH).every((d) => d === MAX_DEPTH),
  `depths at/after the cap = ${depths.slice(MAX_DEPTH).join(',')}`);

// ------------------------------------------- 2. the count is DIRECT replies
console.log('\n--- A gives one root three direct replies, one of which has its own ---');
const ROOT = `st-root-${s}`;
const K1 = `st-k1-${s}`;
const K2 = `st-k2-${s}`;
const K3 = `st-k3-${s}`;
const GRAND = `st-grand-${s}`;

await post(a, ROOT);
await replyVia(a, ROOT, K1);
await replyVia(a, ROOT, K2);
await replyVia(a, ROOT, K3);
await replyVia(a, K1, GRAND);   // subtree is now 4, direct replies are 3

await clickToggle(a, ROOT); // collapse to reveal the count
const collapsedLabel = await toggleLabel(a, ROOT);
record('a collapsed parent counts its DIRECT replies, not its subtree',
  collapsedLabel === '▸ 3 replies',
  `label=${JSON.stringify(collapsedLabel)} (subtree is 4, direct is 3)`);

record('collapsing hides the whole subtree, not just direct replies',
  (await isVisible(a, GRAND)) === false && (await isVisible(a, K1)) === false,
  `K1 visible=${await isVisible(a, K1)} GRAND visible=${await isVisible(a, GRAND)}`);

await clickToggle(a, ROOT); // expand again
record('expanding restores the subtree',
  (await isVisible(a, GRAND)) === true,
  `GRAND visible=${await isVisible(a, GRAND)}`);
record('an expanded parent shows the hide affordance',
  (await toggleLabel(a, ROOT)) === '▾ hide',
  `label=${JSON.stringify(await toggleLabel(a, ROOT))}`);

// ------------------------------------ 3. a tombstone counts as a direct reply
console.log('\n--- A deletes K2 (childless) and K1 (has a reply) ---');
const k2Id = (await probe(a, K2)).id;
await deleteComment(a, k2Id);
await a.page.waitForTimeout(3500);

await clickToggle(a, ROOT);
const afterChildless = await toggleLabel(a, ROOT);
record('deleting a childless reply lowers the count',
  afterChildless === '▸ 2 replies',
  `label=${JSON.stringify(afterChildless)} (expected 2)`);
await clickToggle(a, ROOT);

const k1Id = (await probe(a, K1)).id;
await deleteComment(a, k1Id);
await a.page.waitForTimeout(3500);

const g = await ghosts(a);
record('deleting a reply that has its own reply leaves a tombstone',
  g.some((x) => x.id === k1Id),
  `tombstones=${JSON.stringify(g)}`);

await clickToggle(a, ROOT);
const withTomb = await toggleLabel(a, ROOT);
record('a tombstone still counts as a direct reply',
  withTomb === '▸ 2 replies',
  `label=${JSON.stringify(withTomb)} (K3 + the [deleted] row)`);
await clickToggle(a, ROOT);

// ------------------------------------------ 4. the other browser agrees
console.log('\n--- B, live ---');
await watch(b, K3, 20);
await b.page.waitForTimeout(2500);
await clickToggle(b, ROOT);
const bLabel = await toggleLabel(b, ROOT);
record('B computes the same count without navigating',
  bLabel === '▸ 2 replies',
  `label=${JSON.stringify(bLabel)}`);
await clickToggle(b, ROOT);

// -------------------------------------- 5. collapse state survives a reload
console.log('\n--- collapse state persists across a reload ---');
await clickToggle(a, ROOT);
await reload(a);
record('a collapsed thread is still collapsed after reload',
  (await isVisible(a, K3)) === false,
  `K3 visible=${await isVisible(a, K3)}`);
record('and still reports the same count',
  (await toggleLabel(a, ROOT)) === '▸ 2 replies',
  `label=${JSON.stringify(await toggleLabel(a, ROOT))}`);

console.log('\nfinal tree (A):');
console.dir((await readTree(a)).rows, { depth: null });
console.log(`\ncard: https://trello.com/c/${card.shortLink}`);

const failures = summary();
await a.browser.close();
await b.browser.close();
process.exit(failures ? 1 : 0);
