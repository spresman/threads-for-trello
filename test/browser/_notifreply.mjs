/**
 * The reported case, exactly: the notified comment is a *reply*, and the
 * account looking at it is the one that was notified.
 *
 * Everything measured so far highlighted the wrong row, or got there the wrong
 * way. A `#comment-` deep link renders like plain navigation — same highlight,
 * permalink intact — while arriving through the bell makes Trello drop the
 * notified comment's permalink, so the two are not the same state and only the
 * bell reproduces it. And the row highlighted was the root, not a reply.
 *
 * So: A posts a root, then a threaded reply to it that mentions B. B, away from
 * the card, gets the notification, opens the drawer and clicks the comment
 * permalink. The reply is then the highlighted row, on B's screen, at depth 1 —
 * and every guide on the card is measured through its own layer's CTM, with the
 * highlighted row's box properties dumped alongside so that whatever Trello is
 * actually doing to it is on the record rather than assumed.
 *
 * Usage: node test/browser/_notifreply.mjs
 */
import {
  attach, openCard, createCard, stamp, reload,
} from './harness.mjs';

const LIST = '6a8508bd571817194e5ba0a4'; // board 1: A admin, B normal member

const a = await attach(9222, 'A');
const b = await attach(9223, 'B');
console.log(`admin=@${a.username}  member=@${b.username}`);

/** The parent marker, as src/interceptor.js writes it. */
const ZW_ZERO = '​', ZW_ONE = '‌', ZW_FENCE = '⁠';
function encodeMarker(actionId) {
  if (!/^[0-9a-f]{24}$/i.test(actionId)) return '';
  let bits = '';
  for (const ch of actionId.toLowerCase()) bits += parseInt(ch, 16).toString(2).padStart(4, '0');
  return ZW_FENCE + Array.from(bits, (x) => (x === '1' ? ZW_ONE : ZW_ZERO)).join('') + ZW_FENCE;
}

// Through the API with a literal "@handle": a mention committed to a chip by
// the composer's autocomplete is stored without the "@" and notifies nobody.
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

const card = await createCard(a, LIST, `notifreply ${new Date().toISOString().slice(0, 16)}`);
console.log(`card: https://trello.com/c/${card.shortLink}`);
await openCard(a, card.shortLink);

const s = stamp();
const ROOT = `nr-root-${s}`, REPLY = `nr-reply-${s}`;

// B must be away from the card or Trello marks the notification read on arrival.
await b.page.goto('https://trello.com/', { waitUntil: 'domcontentloaded' });
await b.page.waitForTimeout(5000);

const rootId = await postApi(a, card.id, ROOT);
console.log(`root id: ${JSON.stringify(rootId)}`);
if (typeof rootId !== 'string') process.exit(1);
await a.page.waitForTimeout(3000);

const replyId = await postApi(a, card.id, `@${b.username} ${REPLY}` + encodeMarker(rootId));
console.log(`reply id: ${JSON.stringify(replyId)} (threaded under the root, mentions @${b.username})`);
if (typeof replyId !== 'string') process.exit(1);
await b.page.waitForTimeout(6000);

/** Every guide on the card, in screen coordinates, plus each row's own box. */
const measure = (sess) => sess.page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-tt-id]'));
  const segs = [];
  const info = [];
  for (const row of rows) {
    const cs = getComputedStyle(row);
    const r = row.getBoundingClientRect();
    const svg = row.querySelector(':scope > .tt-rails');
    const path = svg && svg.querySelector('path');
    const ctm = svg && svg.getScreenCTM();
    const slot = row.firstElementChild;
    const box = row.querySelector('[data-testid="card-back-action-container"]');
    const depth = +row.dataset.ttDepth || 0;
    const railX = ctm && path
      ? Array.from((path.getAttribute('d') || '').matchAll(/M(-?[\d.]+) /g))
          .map((m) => +(ctm.a * +m[1] + ctm.e).toFixed(3))
      : [];
    info.push({
      d: String(depth),
      txt: row.innerText.replace(/\s+/g, ' ').slice(0, 14),
      rowL: +r.left.toFixed(3),
      slotL: slot ? +slot.getBoundingClientRect().left.toFixed(3) : null,
      boxL: box ? +box.getBoundingClientRect().left.toFixed(3) : null,
      // Whatever Trello is doing to the notified row, in full.
      bord: cs.borderLeftWidth + '/' + cs.borderRightWidth,
      pad: cs.paddingLeft + '/' + cs.paddingRight,
      mar: cs.marginLeft + '/' + cs.marginRight,
      outline: cs.outlineStyle === 'none' ? '' : `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineOffset}`,
      shadow: cs.boxShadow === 'none' ? '' : cs.boxShadow.slice(0, 48),
      bg: cs.backgroundColor,
      transform: cs.transform === 'none' ? '' : cs.transform,
      padVar: cs.getPropertyValue('--tt-padl').trim(),
      styleL: svg ? svg.style.left : null,
      scale: ctm ? +ctm.a.toFixed(4) : null,
      railX,
    });
    for (const x of railX) segs.push({ x, d: String(depth) });
  }
  const groups = [];
  for (const g of segs.sort((u, v) => u.x - v.x)) {
    const q = groups.find((k) => Math.abs(k[0].x - g.x) < 8);
    if (q) q.push(g); else groups.push([g]);
  }
  return {
    dpr: window.devicePixelRatio,
    info,
    spines: groups.filter((q) => q.length > 1).map((q) => ({
      x: q[0].x,
      spread: +(Math.max(...q.map((g) => g.x)) - Math.min(...q.map((g) => g.x))).toFixed(3),
      at: q.map((g) => `d${g.d}:${g.x}`).join(' '),
    })),
  };
});

const show = (label, m) => {
  console.log(`\n=== ${label}   (devicePixelRatio ${m.dpr})`);
  for (const i of m.info) {
    console.log(`  d${i.d} ${JSON.stringify(i.txt).padEnd(17)} rowL=${i.rowL} slotL=${i.slotL} boxL=${i.boxL} scale=${i.scale}`);
    console.log(`      border=${i.bord} padding=${i.pad} margin=${i.mar} --tt-padl=${i.padVar} left=${i.styleL}`);
    if (i.outline) console.log(`      OUTLINE ${i.outline}`);
    if (i.shadow) console.log(`      SHADOW ${i.shadow}`);
    if (i.bg !== 'rgba(0, 0, 0, 0)') console.log(`      BG ${i.bg}`);
    console.log(`      rails=[${i.railX.join(', ')}]`);
  }
  for (const q of m.spines) {
    console.log(`  spine x~${q.x.toFixed(2)} spread=${q.spread} [${q.at}]${q.spread > 0.01 ? '   *** STEP ***' : ''}`);
  }
};

// ------------------------------------------------- B arrives via the bell
await b.page.reload({ waitUntil: 'domcontentloaded' });
await b.page.waitForTimeout(6000);
const bellLabel = await b.page.locator('[data-testid="header-notifications-button"]').first().getAttribute('aria-label');
console.log(`\nbell: ${bellLabel}`);
await b.page.evaluate(() => {
  const el = document.querySelector('[data-testid="header-notifications-button"]');
  if (el) el.click();
});
await b.page.waitForTimeout(4000);

const permalink = b.page.locator(`a[href*="#comment-${replyId}"]`).first();
if (!(await permalink.count())) {
  console.log('no #comment- link for the reply in the drawer; cannot reproduce the arrival');
  process.exit(1);
}
await permalink.click({ timeout: 15000 });
await b.page.waitForTimeout(9000);

show('B, arrived from the bell on the REPLY', await measure(b));
console.log('\n(same card, account A, which was never notified)');
await openCard(a, card.shortLink);
await a.page.waitForTimeout(3000);
show('A, no notification, no highlight', await measure(a));

// And on B once the highlight is gone, to confirm it is the highlight doing it.
await openCard(b, card.shortLink);
await reload(b, 8000);
show('B again, plain navigation, highlight cleared', await measure(b));

console.log(`\ncard: https://trello.com/c/${card.shortLink}`);
process.exit(0);
