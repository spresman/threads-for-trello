/**
 * The thread spine is continuous, whatever the rows do underneath it.
 *
 * Each row paints its own piece of every ancestor line, from the top of its box
 * to the bottom, and the pieces abut. The height a row paints for is measured
 * during a repaint, and repaints are driven by a childList observer — so
 * anything that changes a row's height *without* changing the DOM used to leave
 * that row's rail at the old height and open a hole above the row below.
 *
 * Two ways in, both checked here:
 *
 *  - Directly: grow a row by a known amount with no DOM change at all. This
 *    owes nothing to Trello's markup, so it keeps working whatever they restyle.
 *  - As reported: hover a comment. That reveals Trello's "Copy link to comment"
 *    control, and when the author's name and timestamp already fill the header
 *    line it wraps onto a second one and the row grows for as long as the mouse
 *    is there. It needs the header to sit within one control's width of
 *    wrapping, which is why it looked idiosyncratic — one letter either way in
 *    somebody's display name and it never happens. The name is swept to find
 *    that width rather than assumed.
 */
import {
  attach, openCard, createCard, post, replyVia, stamp, record, summary,
} from './harness.mjs';

const LIST = '6a8508bd571817194e5ba0a4';

const a = await attach(9222, 'A');
console.log(`A = @${a.username}\n`);

const card = await createCard(a, LIST, `spine ${new Date().toISOString().slice(0, 16)}`);
if (!card.shortLink) { console.error('card creation failed', card); process.exit(1); }
console.log(`card: https://trello.com/c/${card.shortLink}\n`);
await openCard(a, card.shortLink);

const s = stamp();
const ROOT = `sp-root-${s}`, K1 = `sp-kid1-${s}`, K2 = `sp-kid2-${s}`;
await post(a, ROOT);
await replyVia(a, ROOT, K1);
await replyVia(a, ROOT, K2);
await a.page.waitForTimeout(2500);

/**
 * Rebuild what is actually painted, in screen coordinates, from the path data:
 * the layer has no viewBox, so one user unit is one CSS pixel. Segments that
 * share an x belong to the same spine, and any y between one ending and the
 * next starting is a hole you can see.
 */
const spine = (needle) => a.page.evaluate((t) => {
  const rows = Array.from(document.querySelectorAll('[data-tt-id]'));
  const segs = [];
  for (const row of rows) {
    const svg = row.querySelector(':scope > .tt-rails');
    const path = svg && svg.querySelector('path');
    if (!path) continue;
    // Through the layer's own CTM rather than by adding user units to its
    // screen rect: under a page zoom those are different scales, and the error
    // grows with the coordinate, which shows up as a per-depth step that is not
    // there. At zoom 1 the two agree exactly.
    const ctm = svg.getScreenCTM();
    if (!ctm) continue;
    for (const m of (path.getAttribute('d') || '').matchAll(/M(-?[\d.]+) (-?[\d.]+)V(-?[\d.]+)/g)) {
      segs.push({
        x: +(ctm.a * +m[1] + ctm.e).toFixed(3),
        y0: ctm.d * +m[2] + ctm.f,
        y1: ctm.d * +m[3] + ctm.f,
        d: row.dataset.ttDepth,
      });
    }
  }
  const groups = [];
  for (const g of segs.sort((u, v) => u.x - v.x)) {
    const b = groups.find((q) => Math.abs(q[0].x - g.x) < 8);
    if (b) b.push(g); else groups.push([g]);
  }
  let hole = 0, where = '';
  for (const q of groups) {
    q.sort((u, v) => u.y0 - v.y0);
    for (let i = 0; i < q.length - 1; i++) {
      const h = q[i + 1].y0 - q[i].y1;
      if (h > hole) {
        hole = h;
        where = `x~${q[i].x} d${q[i].d} ends ${q[i].y1.toFixed(1)}, d${q[i + 1].d} starts ${q[i + 1].y0.toFixed(1)}`;
      }
    }
  }
  // Segments grouped together are meant to be one spine, so any disagreement
  // in x between them is a sideways step in it.
  let spread = 0, spreadAt = '';
  for (const q of groups) {
    const xs = q.map((g) => g.x);
    const sp = Math.max(...xs) - Math.min(...xs);
    if (sp > spread) { spread = sp; spreadAt = q.map((g) => `d${g.d}:${g.x}`).join(' '); }
  }
  const target = rows.find((n) => n.innerText.includes(t));
  return {
    rowH: target ? +target.getBoundingClientRect().height.toFixed(1) : null,
    hovered: target ? target.matches(':hover') : false,
    hole: +hole.toFixed(2),
    where,
    spread: +spread.toFixed(3),
    spreadAt,
  };
}, needle);

// --------------------------------------- a row growing with no DOM change

const base = await spine(K1);
record('the spine is unbroken to begin with',
  base.hole < 0.5, `rowH=${base.rowH} hole=${base.hole} ${base.where}`);

// Padding set on the row's own style attribute: no node added or removed and no
// class touched, so nothing either repaint observer watches has happened. The
// row is simply taller than its rails were drawn for.
const grow = (px) => a.page.evaluate(([t, v]) => {
  const row = Array.from(document.querySelectorAll('[data-tt-id]')).find((n) => n.innerText.includes(t));
  if (!row) return null;
  row.style.paddingBottom = v ? v + 'px' : '';
  return +row.getBoundingClientRect().height.toFixed(1);
}, [K1, px]);

const grown = await grow(40);
await a.page.waitForTimeout(1200);
const after = await spine(K1);
// Padding replaces the 8px the row already had rather than adding to it, so
// the row gains a little less than the 40px asked for.
record('growing a row with no DOM change actually grows it',
  grown !== null && after.rowH >= base.rowH + 25,
  `${base.rowH} -> ${after.rowH} (+${(after.rowH - base.rowH).toFixed(1)})`);
record('the rails follow a height change nothing else can see',
  after.hole < 0.5, `rowH=${after.rowH} hole=${after.hole} ${after.where}`);

await grow(0);
await a.page.waitForTimeout(1200);
const shrunk = await spine(K1);
record('and follow it back down again',
  shrunk.hole < 0.5 && shrunk.rowH === base.rowH,
  `rowH=${shrunk.rowH} hole=${shrunk.hole} ${shrunk.where}`);

// ------------------------------------------------ the reported hover case

const setName = (txt) => a.page.evaluate(([t, v]) => {
  const row = Array.from(document.querySelectorAll('[data-tt-id]')).find((n) => n.innerText.includes(t));
  if (!row) return false;
  const el = row.querySelector('[data-tt-test-name]')
    || Array.from(row.querySelectorAll('span'))
      .find((n) => !n.querySelector('*') && /^[A-Za-z][A-Za-z ]{2,40}$/.test((n.textContent || '').trim()));
  if (!el) return false;
  el.setAttribute('data-tt-test-name', '1');
  el.textContent = v;
  return true;
}, [K1, txt]);

const unhover = async () => { await a.page.mouse.move(4, 4); await a.page.waitForTimeout(600); };
const hoverRow = async () => {
  const box = await a.page.evaluate((t) => {
    const el = Array.from(document.querySelectorAll('[data-tt-id]')).find((n) => n.innerText.includes(t));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + 130, y: r.top + 14 };
  }, K1);
  if (box) await a.page.mouse.move(box.x, box.y);
};

// One letter at a time: the window where hover changes anything is only as wide
// as the control it reveals, and a word-sized step walks straight over it.
const BASE = 'Featherstonehaugh Marchbanks';
let found = null;
for (let k = 0; k <= 12 && !found; k++) {
  const extra = k ? ' ' + 'ABCDEFGHIJKL'.slice(0, k).split('').join(' ') : '';
  if (!(await setName(BASE + extra))) break;
  await a.page.waitForTimeout(800);
  await unhover();
  const off = await spine(K1);
  await hoverRow();
  await a.page.waitForTimeout(900);
  const on = await spine(K1);
  if (off.rowH !== null && on.rowH !== null && on.rowH > off.rowH + 0.5 && on.hovered) {
    found = { k, off, on };
  }
}
await unhover();

if (!found) {
  // Neither a pass nor a failure: Trello's header has stopped being able to
  // wrap under the hover control, so there is nothing here left to get wrong.
  record('hovering can still change a row height at some name length', null,
    'no name length between 28 and 52 characters made the row grow on hover');
} else {
  record('hovering a comment grows its row at the wrapping width', true,
    `name +${found.k} letters: ${found.off.rowH} -> ${found.on.rowH}`);
  record('the spine holds while that row is hovered',
    found.on.hole < 0.5,
    `rowH=${found.on.rowH} hole=${found.on.hole} ${found.on.where}`);
  const settled = await spine(K1);
  record('and closes up again when the mouse leaves',
    settled.hole < 0.5, `rowH=${settled.rowH} hole=${settled.hole}`);
}

console.log(`\ncard: https://trello.com/c/${card.shortLink}`);
// ------------------------------- a highlighted row on a scaled display

// Trello's highlight is `margin-left: -16px` + `border-left: 4px` +
// `padding-left: 12px`, which cancels exactly in whole pixels. A border and a
// padding are each snapped to whole *device* pixels, though, so on a scaled
// display they stop cancelling and the row's content genuinely moves about a
// device pixel - invisible on a 24px avatar, very visible on a line running the
// height of the feed. A page zoom reproduces that snapping faithfully: measured
// at devicePixelRatio 2.2 the 4px border reports back as 3.63636px, and so it
// does at zoom 1.1. Emulating a device scale factor over CDP does not - the
// border stays a clean 4px - so zoom is what this uses.
const setZoom = (z) => a.page.evaluate((v) => {
  document.documentElement.style.zoom = v === 1 ? '' : String(v);
}, z);

const highlight = async (needle) => {
  await a.page.evaluate(() => { location.hash = '#none'; });
  await a.page.waitForTimeout(800);
  const id = await a.page.evaluate((t) => {
    const el = Array.from(document.querySelectorAll('[data-tt-id]')).find((n) => n.innerText.includes(t));
    return el ? el.dataset.ttId : null;
  }, needle);
  await a.page.evaluate((i) => { location.hash = `#comment-${i}`; }, id);
  await a.page.waitForTimeout(2000);
};

const borderOf = () => a.page.evaluate(() => {
  const row = Array.from(document.querySelectorAll('[data-tt-id]'))
    .find((n) => getComputedStyle(n).backgroundColor !== 'rgba(0, 0, 0, 0)');
  return row ? getComputedStyle(row).borderLeftWidth : null;
});

for (const zoom of [1, 1.1]) {
  await setZoom(zoom);
  await a.page.waitForTimeout(1500);
  await highlight(K1);
  const bord = await borderOf();
  const g = await spine(K1);
  if (zoom !== 1) {
    // Without this the next assertion proves nothing: it only bites while the
    // browser is actually snapping the highlight's border away from 4px.
    record('a scaled display really does snap the highlight border',
      bord !== null && bord !== '4px', `border-left=${bord} at zoom ${zoom}`);
  }
  // 1/64px is Chrome's LayoutUnit granularity and the floor of what any
  // measurement here can resolve, so the bar sits just above it.
  record(`the highlighted reply spine lines up at zoom ${zoom}`,
    g.spread < 0.03, `border-left=${bord} spread=${g.spread} [${g.spreadAt}]`);
}
await setZoom(1);
await a.page.waitForTimeout(1200);

// ------------------------------------- the panel and the highlight's bar

// An indented row is shifted right by a transform, so its box overhangs the
// panel by its indent. The panel is `overflow-x: hidden`, which stops a user
// scrolling sideways but not a script, and Trello's scroll to a notified
// comment used to scroll into the overhang - cutting off the comments above
// it. And the highlight's bar, drawn on the row's own left edge, sat a whole
// indent in from where it sits on a flat comment. Both are checked on the
// highlighted depth-1 reply, at zoom 1, where screen and CSS pixels agree.
const panel = () => a.page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-tt-id]'));
  const hl = rows.find((n) => getComputedStyle(n).backgroundColor !== 'rgba(0, 0, 0, 0)');
  const root = rows.find((n) => n.dataset.ttDepth === '0');
  const sideways = [];
  for (let n = root && root.parentElement; n && n !== document.body; n = n.parentElement) {
    if (n.scrollLeft) sideways.push(`${n.tagName.toLowerCase()}:${n.scrollLeft}`);
  }
  if (!hl || !root) return { sideways, bar: null, flat: null };
  const cs = getComputedStyle(hl), pb = getComputedStyle(hl, '::before');
  const drawn = pb.content === 'none' || pb.content === 'normal'
    ? hl.getBoundingClientRect().left
    : hl.getBoundingClientRect().left + parseFloat(cs.borderLeftWidth) + parseFloat(pb.left);
  return {
    sideways,
    bar: +drawn.toFixed(2),
    // A flat comment's highlight is pulled 16px out past its row.
    flat: +(root.getBoundingClientRect().left - parseFloat(cs.marginLeft) * -1).toFixed(2),
    depth: hl.dataset.ttDepth,
  };
});

await highlight(K1);
const p1 = await panel();
record('arriving at a highlighted reply leaves the panel unscrolled sideways',
  p1.sideways.length === 0, p1.sideways.join(' ') || 'scrollLeft 0 throughout');
record("the highlight's bar sits where a flat comment's does",
  p1.bar !== null && Math.abs(p1.bar - p1.flat) < 0.5,
  `depth ${p1.depth}: bar x=${p1.bar}, flat comment's bar x=${p1.flat}`);

// Whatever does the scrolling. Set directly, so this does not depend on
// Trello choosing to scroll on any particular arrival.
const shoved = await a.page.evaluate(() => {
  const root = document.querySelector('[data-tt-depth="0"]');
  for (let n = root.parentElement; n && n !== document.body; n = n.parentElement) {
    if (getComputedStyle(n).overflowX === 'hidden' && n.scrollWidth > n.clientWidth) {
      n.scrollLeft = 30;
      return n.scrollLeft;
    }
  }
  return 0;
});
await a.page.waitForTimeout(400);
const p2 = await panel();
record('the panel can be scrolled sideways by a script at all', shoved > 0,
  `scrollLeft reached ${shoved} before the extension put it back`);
record('and a sideways scroll from any script is put straight back',
  p2.sideways.length === 0, p2.sideways.join(' ') || 'scrollLeft 0');

const failures = summary();
await a.browser.close();
process.exit(failures ? 1 : 0);
