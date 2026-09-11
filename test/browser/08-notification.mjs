/**
 * Replying from a notification.
 *
 * Clicking a comment notification opens the card with that comment highlighted,
 * and Trello renders it with `href="#"` where its `#comment-<id>` permalink
 * would normally be. Identity in this extension comes from that permalink, so
 * the notified row was the one row on the card the extension never claimed:
 * unindented, no reply control of ours, and Trello's own Reply still showing.
 * Trello's Reply prefills the @mention but posts a flat comment, so a reply sent
 * from a notification left its thread for good — no marker was written, so no
 * reload could recover it.
 *
 * A #comment- deep link does NOT reproduce this: typed into the address bar it
 * renders exactly like plain navigation, highlight and all. Only the bell does,
 * which is why this suite drives the real notification drawer.
 */
import {
  attach, openCard, createCard, replyVia, probe, watch, reload,
  rawText, decodeMarker, stamp, record, summary,
} from './harness.mjs';

const LIST = '6a8508bd571817194e5ba0a4'; // board 1: A admin, B normal member

const a = await attach(9222, 'A');
const b = await attach(9223, 'B');
console.log(`admin=@${a.username}  member=@${b.username}\n`);

/**
 * Post through the API rather than the composer.
 *
 * A mention has to reach Trello as the literal text "@handle" to notify anyone.
 * Typing it into the composer and letting the autocomplete commit it to a chip
 * stores the handle *without* the "@", which notifies nobody and would leave
 * this suite with an empty notification drawer.
 */
function postApi(s, cardId, text) {
  return s.page.evaluate(async ({ id, text }) => {
    const dsc = document.cookie.match(/(?:^|;\s*)dsc=([^;]+)/)?.[1];
    const r = await fetch(`/1/cards/${id}/actions/comments`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, dsc }),
    });
    return r.ok ? (await r.json()).id : { error: r.status, body: await r.text() };
  }, { id: cardId, text });
}

/** State of one comment's row, keyed by its text. */
function rowState(s, needle) {
  return s.page.evaluate((t) => {
    const el = Array.from(
      document.querySelectorAll('[data-testid="card-back-action-container"]')
    ).find((x) => x.innerText.includes(t));
    if (!el) return { present: false, ghosts: document.querySelectorAll('.tt-ghost').length };
    const row = el.closest('[data-tt-id]');
    const li = el.closest('li');
    const replies = Array.from(el.querySelectorAll('button'))
      .filter((x) => /^reply$/i.test(x.textContent.trim()))
      .map((x) => (x.hasAttribute('data-tt') ? 'ours' : 'native') +
                  (x.classList.contains('tt-hidden') ? '(hidden)' : ''));
    return {
      present: true,
      claimed: Boolean(row),
      id: row ? row.dataset.ttId : null,
      permalink: Boolean(el.querySelector('a[href^="#comment-"]')),
      highlighted: li ? getComputedStyle(li).backgroundColor : null,
      replies: replies.join('+') || 'none',
      ghosts: document.querySelectorAll('.tt-ghost').length,
    };
  }, needle);
}

// ------------------------------------------------------------------- setup
const card = await createCard(a, LIST, `notify ${new Date().toISOString().slice(0, 16)}`);
if (!card.shortLink) { console.error('card creation failed', card); process.exit(1); }
console.log(`card: https://trello.com/c/${card.shortLink}`);
await openCard(a, card.shortLink);

const s = stamp();
const ASKS = `notif-asks-${s}`;
const REPLY = `notif-reply-${s}`;
const LATER = `notif-later-${s}`;

// B has to be away from the card, or Trello marks the notification read on
// arrival and the bell stays empty.
await b.page.goto('https://trello.com/', { waitUntil: 'domcontentloaded' });
await b.page.waitForTimeout(5000);

const askId = await postApi(a, card.id, `@${b.username} ${ASKS} do we have a research note?`);
record('the admin mention posted', typeof askId === 'string', `id=${JSON.stringify(askId)}`);
if (typeof askId !== 'string') process.exit(summary() ? 1 : 0);
await b.page.waitForTimeout(6000);

/**
 * Where a row's thread guides actually land on screen, and how much left
 * padding the row carries.
 *
 * Every guide is drawn into an SVG that is `position: absolute` inside its own
 * row, so its coordinates are relative to that row's padding box. The design
 * assumes every row shares that origin: a parent draws its rail at RAIL_X and
 * its child draws the matching line at RAIL_X - indent while translated right
 * by the same indent, so the two coincide. Trello's notification highlight adds
 * left padding to one row, which moves that row's padding box and took its rail
 * with it — a visible step in the spine directly under the highlighted comment.
 */
function railGeometry(s, needle) {
  return s.page.evaluate((t) => {
    const row = Array.from(document.querySelectorAll('[data-tt-id]'))
      .find((n) => n.innerText.includes(t));
    if (!row) return null;
    const cs = getComputedStyle(row);
    const svg = row.querySelector(':scope > .tt-rails');
    return {
      depth: row.dataset.ttDepth,
      padL: parseFloat(cs.paddingLeft) || 0,
      padVar: cs.getPropertyValue('--tt-padl').trim(),
      railX: svg
        ? Array.from(svg.querySelectorAll('path'))
            .map((p) => +p.getBoundingClientRect().left.toFixed(2))
        : [],
    };
  }, needle);
}

// --------------------------------------------------- arrive through the bell
await b.page.reload({ waitUntil: 'domcontentloaded' });
await b.page.waitForTimeout(6000);
const bell = b.page.locator('[data-testid="header-notifications-button"]').first();
const bellLabel = await bell.getAttribute('aria-label');
record('the member has an unread notification', !/^0 /.test(bellLabel || ''), `bell=${bellLabel}`);
// Dispatched in the page rather than through Playwright: Trello floats a
// `role="presentation"` layer over the header, and a real click refuses to land
// on anything underneath it ("intercepts pointer events") until it clears,
// which it does not reliably do. The bell itself is visible and enabled the
// whole time, so clicking it directly is the interaction we mean to test.
await b.page.evaluate(() => {
  const el = document.querySelector('[data-testid="header-notifications-button"]');
  if (el) el.click();
});
await b.page.waitForTimeout(4000);

const permalink = b.page.locator(`a[href*="#comment-${askId}"]`).first();
if (!(await permalink.count())) {
  record('the drawer offers the comment permalink', false, 'no #comment- link in the drawer');
  process.exit(summary() ? 1 : 0);
}
await permalink.click({ timeout: 15000 });
await b.page.waitForTimeout(9000);

const arrived = await rowState(b, ASKS);
console.log(`\narrived: ${JSON.stringify(arrived)}\n`);

record('Trello withholds the permalink from the notified comment',
  arrived.present && arrived.permalink === false,
  `permalink=${arrived.permalink} background=${arrived.highlighted}`);
record('the notified comment is claimed anyway',
  arrived.claimed && arrived.id === askId,
  `claimed=${arrived.claimed} id=${arrived.id} expected=${askId}`);
record('our Reply is on it and Trello own Reply is hidden',
  arrived.replies === 'native(hidden)+ours',
  `replies=${arrived.replies}`);

// ------------------------------------------------ replying from that view
const r = await replyVia(b, ASKS, REPLY);
const rp = await probe(b, REPLY);
const raw = rp.id ? (await rawText(b, rp.id)).text || '' : '';
const marker = decodeMarker(raw);
record('a reply sent from the notification view carries the marker',
  marker === askId,
  `marker=${marker} expected=${askId} composer=${JSON.stringify(r.composer)}`);
record('and it renders as a child',
  rp.depth === 1, `depth=${rp.depth}`);
record('the reply @mentions the admin',
  raw.includes(`@${a.username}`),
  `sent=${JSON.stringify(raw.replace(/[​‌⁠]/g, ''))}`);

// ---------------------------------- the notified row must hold its claim
// A comment being posted renders optimistically with no permalink of its own,
// so for a moment two rows on the card lack one. If the notified row lost its
// claim there it would drop out of the tree while its reply stayed in it, and
// the reply's now-missing parent would be tombstoned as deleted.
let lostClaim = 0;
let sawGhost = 0;
let samples = 0;
const posting = postApi(b, card.id, LATER);
while (samples < 60) {
  const st = await rowState(b, ASKS);
  samples++;
  if (st.present && !st.claimed) lostClaim++;
  if (st.ghosts) sawGhost++;
  await b.page.waitForTimeout(100);
}
await posting;
await b.page.waitForTimeout(3000);
record('the notified row never loses its claim while another comment posts',
  lostClaim === 0, `unclaimed in ${lostClaim}/${samples} samples`);
record('nothing is tombstoned as deleted during that window',
  sawGhost === 0, `tombstones in ${sawGhost}/${samples} samples`);

// ---------------------------------------------------------- no regression
// A reload keeps the fragment, so Trello still considers this the notified
// comment and still withholds its permalink. What has to survive is the claim.
await reload(b, 8000);
const afterReload = await rowState(b, ASKS);
record('the claim survives a reload of the permalink URL',
  afterReload.claimed && afterReload.id === askId,
  JSON.stringify(afterReload));
const replyAfter = await probe(b, REPLY);
record('the reply is still threaded after the reload',
  replyAfter.depth === 1, `depth=${replyAfter.depth}`);

// ------------------------------------------- the spine under the highlight
const gParent = await railGeometry(b, ASKS);
const gChild = await railGeometry(b, REPLY);
// Guard against the assertion below going vacuous: it only proves anything
// while Trello is still padding the highlighted row.
record('the highlighted row carries left padding Trello added',
  !!gParent && gParent.padL > 0 && gParent.padVar === gParent.padL + 'px',
  `padL=${gParent && gParent.padL} --tt-padl=${gParent && gParent.padVar}`);
const spineGap =
  gParent && gChild && gParent.railX.length && gChild.railX.length
    ? Math.abs(gParent.railX[0] - gChild.railX[0])
    : null;
record('the parent rail lines up with its child under the highlight',
  spineGap !== null && spineGap < 0.5,
  `parent=${JSON.stringify(gParent && gParent.railX)} child=${JSON.stringify(gChild && gChild.railX)} gap=${spineGap}`);

// Drop the fragment and Trello restores the permalink, which puts the row back
// on the ordinary binding path — the fallback has to go quiet, not linger.
await openCard(b, card.shortLink);
await reload(b, 8000);
const plain = await rowState(b, ASKS);
record('without the fragment the permalink returns and binding is normal',
  plain.claimed && plain.permalink === true && plain.id === askId,
  JSON.stringify(plain));

// The admin, who navigated normally, sees the same thread.
await openCard(a, card.shortLink);
await watch(a, REPLY, 20);
const adminSees = await probe(a, REPLY);
record('the admin sees the reply threaded too',
  adminSees.depth === 1, `depth=${adminSees.depth}`);

process.exit(summary() ? 1 : 0);
