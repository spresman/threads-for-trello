/**
 * Does arriving from the bell scroll the card sideways?
 *
 * Reported: clicking a mention in the notification drawer centres the comment
 * (Trello's blue highlight), and everything shifts right so the comments above
 * it are cut off. Rows are indented by a transform, so a threaded row's box
 * overflows its container on the right by depth * indent; `scrollIntoView`
 * with its default `inline: 'nearest'` scrolls that overflow sideways, even on
 * an `overflow-x: hidden` ancestor. Our own scrolling already pins x — this
 * checks Trello's.
 *
 * A posts a chain root -> d1 -> d2 -> d3, the deepest mentioning B. B, away
 * from the card, clicks the drawer's permalink; every scrolled ancestor's
 * scrollLeft is then dumped. The deep link is measured afterwards for contrast.
 *
 * Usage: node test/browser/_bellscroll.mjs [depth]
 */
import { attach, openCard, createCard, stamp } from './harness.mjs';

const LIST = '6a8508bd571817194e5ba0a4';
const DEPTH = +(process.argv[2] || 3);

const a = await attach(9222, 'A');
const b = await attach(9223, 'B');

const ZW_ZERO = '​', ZW_ONE = '‌', ZW_FENCE = '⁠';
function encodeMarker(id) {
  let bits = '';
  for (const ch of id.toLowerCase()) bits += parseInt(ch, 16).toString(2).padStart(4, '0');
  return ZW_FENCE + Array.from(bits, (x) => (x === '1' ? ZW_ONE : ZW_ZERO)).join('') + ZW_FENCE;
}
function postApi(s, cardId, text) {
  return s.page.evaluate(async ({ id, text }) => {
    const dsc = document.cookie.match(/(?:^|;\s*)dsc=([^;]+)/)?.[1];
    const r = await fetch(`/1/cards/${id}/actions/comments`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, dsc }),
    });
    return r.ok ? (await r.json()).id : { error: r.status };
  }, { id: cardId, text });
}

const card = await createCard(a, LIST, `bellscroll ${new Date().toISOString().slice(0, 16)}`);
console.log(`card: https://trello.com/c/${card.shortLink}`);
await openCard(a, card.shortLink);
await b.page.goto('https://trello.com/', { waitUntil: 'domcontentloaded' });
await b.page.waitForTimeout(5000);

const s = stamp();
let parent = await postApi(a, card.id, `bs-d0-${s}`);
for (let d = 1; d <= DEPTH; d++) {
  await a.page.waitForTimeout(1500);
  const text = (d === DEPTH ? `@${b.username} ` : '') + `bs-d${d}-${s}` + encodeMarker(parent);
  parent = await postApi(a, card.id, text);
  if (typeof parent !== 'string') { console.log('post failed', parent); process.exit(1); }
}
const target = parent;
await b.page.waitForTimeout(6000);

const scrolls = (sess) => sess.page.evaluate(() => {
  const out = [];
  for (const n of document.querySelectorAll('*')) {
    if (n.scrollLeft || n.scrollWidth > n.clientWidth + 1) {
      const cs = getComputedStyle(n);
      if (n.scrollLeft || /auto|scroll|hidden|clip/.test(cs.overflowX)) {
        if (n.scrollWidth > n.clientWidth + 1 || n.scrollLeft) {
          out.push(`${n.tagName.toLowerCase()}${n.dataset.testid ? '[' + n.dataset.testid + ']' : ''}`
            + ` ox=${cs.overflowX} left=${n.scrollLeft} sw=${n.scrollWidth} cw=${n.clientWidth}`);
        }
      }
    }
  }
  const rows = Array.from(document.querySelectorAll('[data-tt-id]')).map((r) =>
    `d${r.dataset.ttDepth} x=${r.getBoundingClientRect().left.toFixed(1)}`);
  // How far the notified (highlighted) row sits from the panel's vertical centre.
  const hl = Array.from(document.querySelectorAll('[data-tt-id]'))
    .find((r) => getComputedStyle(r).backgroundColor !== 'rgba(0, 0, 0, 0)');
  const aside = hl && hl.closest('aside');
  let off = null;
  if (hl && aside) {
    const h = hl.getBoundingClientRect(), p = aside.getBoundingClientRect();
    off = +((h.top + h.height / 2) - (p.top + p.height / 2)).toFixed(1);
  }
  // Where the notified row's bar is painted, against where a flat comment's
  // would be: a depth-0 row's left edge, less Trello's 16px pull-out.
  let bar = null;
  const d0 = document.querySelector('[data-tt-depth="0"]');
  if (hl && d0) {
    const cs = getComputedStyle(hl), pb = getComputedStyle(hl, '::before');
    const r = hl.getBoundingClientRect();
    const drawn = pb.content !== 'none' && pb.content !== 'normal'
      ? r.left + parseFloat(cs.borderLeftWidth) + parseFloat(pb.left)
      : r.left;
    bar = {
      depth: hl.dataset.ttDepth, notified: hl.dataset.ttNotified || '',
      barX: +drawn.toFixed(2), flatBarX: +(d0.getBoundingClientRect().left - 16).toFixed(2),
      width: pb.width, colour: pb.borderLeftColor, fill: pb.backgroundColor,
    };
  }
  return { bar, out, rows, winX: window.scrollX, centreOff: off, top: aside ? aside.scrollTop : null };
});

await b.page.reload({ waitUntil: 'domcontentloaded' });
await b.page.waitForTimeout(6000);
await b.page.evaluate(() => document.querySelector('[data-testid="header-notifications-button"]')?.click());
await b.page.waitForTimeout(4000);
const link = b.page.locator(`a[href*="#comment-${target}"]`).first();
if (!(await link.count())) { console.log('no permalink in drawer'); process.exit(1); }
await link.click({ timeout: 15000 });
for (const t of [1500, 4000, 9000]) {
  await b.page.waitForTimeout(t === 1500 ? 1500 : t - 1500);
  console.log(`\n=== B via bell, +${t}ms`, JSON.stringify(await scrolls(b), null, 1));
}

await openCard(b, card.shortLink);
await b.page.waitForTimeout(4000);
console.log('\n=== B plain open', JSON.stringify(await scrolls(b), null, 1));
await b.page.evaluate((i) => { location.hash = `#comment-${i}`; }, target);
await b.page.waitForTimeout(4000);
console.log('\n=== B deep link', JSON.stringify(await scrolls(b), null, 1));
console.log(`\ncard: https://trello.com/c/${card.shortLink}`);
process.exit(0);
