/**
 * Every row in a branching thread, taken in turn as the highlighted one.
 *
 * The earlier probes highlighted rows in a straight chain: root, its reply, its
 * reply's reply. That misses every case where a row paints a line for an
 * *ancestor* it is not a direct child of — the through-rails a row draws when
 * someone above it still has siblings coming. This tree has both:
 *
 *   R          root
 *   +- A       reply, has a following sibling and a child of its own
 *   |  +- C
 *   +- B
 *
 * so A draws an elbow and a parent rail, C draws a through-rail for R as well
 * as its own elbow, and B closes R's line off.
 *
 * Each row's painted lines are reconstructed in screen coordinates from the
 * path data and grouped by the spine they belong to; anything but a zero spread
 * inside a group is a step you can see. Reported per highlighted row, and
 * across a few page zooms, since fractional zoom is where a layout that is
 * exact in whole pixels stops being exact.
 *
 * Usage: node test/browser/_spine3.mjs
 */
import { attach, openCard, createCard, post, replyVia, stamp } from './harness.mjs';

const LIST = '6a8508bd571817194e5ba0a4';

const a = await attach(9222, 'A');
const card = await createCard(a, LIST, `spine3 ${new Date().toISOString().slice(0, 16)}`);
console.log(`card: https://trello.com/c/${card.shortLink}`);
await openCard(a, card.shortLink);

const s = stamp();
const R = `s3-root-${s}`, A = `s3-a-${s}`, B = `s3-b-${s}`, C = `s3-c-${s}`;
await post(a, R);
await replyVia(a, R, A);
await replyVia(a, A, C);
await replyVia(a, R, B);
await a.page.waitForTimeout(3000);

const measure = () => a.page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-tt-id]'));
  const segs = [];
  const info = [];
  for (const row of rows) {
    const cs = getComputedStyle(row);
    const r = row.getBoundingClientRect();
    const svg = row.querySelector(':scope > .tt-rails');
    const path = svg && svg.querySelector('path');
    const bordL = parseFloat(cs.borderLeftWidth) || 0;
    const padL = parseFloat(cs.paddingLeft) || 0;
    info.push({
      d: row.dataset.ttDepth,
      txt: row.innerText.replace(/\s+/g, ' ').slice(0, 12),
      rowL: +r.left.toFixed(3),
      bordL,
      padL,
      marL: parseFloat(cs.marginLeft) || 0,
      contentL: +(r.left + bordL + padL).toFixed(3),
      padVar: cs.getPropertyValue('--tt-padl').trim(),
      styleL: svg ? svg.style.left : null,
      hi: cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : '',
    });
    if (!path || !svg) continue;
    // Through the layer's own CTM, not by adding user units to its screen rect:
    // under page zoom those are different scales, and the error is proportional
    // to the coordinate, so it shows up as a per-depth step that is not there.
    const ctm = svg.getScreenCTM();
    if (!ctm) continue;
    const xs = [];
    for (const m of (path.getAttribute('d') || '').matchAll(/M(-?[\d.]+) (-?[\d.]+)V(-?[\d.]+)/g)) {
      const x = +(ctm.a * +m[1] + ctm.e).toFixed(3);
      xs.push(x);
      segs.push({ x, d: row.dataset.ttDepth });
    }
    // Cross-check the mapping against what the browser says it painted.
    if (xs.length) {
      const drift = Math.abs(Math.min(...xs) - path.getBoundingClientRect().left);
      if (drift > 1.5) info[info.length - 1].ctmDrift = +drift.toFixed(2);
    }
  }
  // Group verticals that are meant to be the same spine. The grouping window is
  // well under one indent so two different levels can never be merged.
  const groups = [];
  for (const g of segs.sort((u, v) => u.x - v.x)) {
    const b = groups.find((q) => Math.abs(q[0].x - g.x) < 8);
    if (b) b.push(g); else groups.push([g]);
  }
  return {
    info,
    spines: groups.filter((q) => q.length > 1).map((q) => ({
      x: q[0].x,
      spread: +(Math.max(...q.map((g) => g.x)) - Math.min(...q.map((g) => g.x))).toFixed(3),
      at: q.map((g) => `d${g.d}:${g.x}`).join(' '),
    })),
  };
});

const idOf = (t) => a.page.evaluate((needle) => {
  const el = Array.from(document.querySelectorAll('[data-tt-id]')).find((n) => n.innerText.includes(needle));
  return el ? el.dataset.ttId : null;
}, t);

const setZoom = (z) => a.page.evaluate((v) => {
  document.documentElement.style.zoom = v === 1 ? '' : String(v);
}, z);

let broken = 0;
for (const zoom of [1, 1.1, 1.25, 1.5, 0.9]) {
  await setZoom(zoom);
  await a.page.waitForTimeout(1500);
  console.log(`\n\n################ page zoom ${zoom}`);

  for (const [label, needle] of [['none', null], ['ROOT', R], ['A (reply, d1)', A], ['C (d2)', C], ['B (reply, d1)', B]]) {
    await a.page.evaluate(() => { location.hash = '#none'; });
    await a.page.waitForTimeout(900);
    if (needle) {
      const id = await idOf(needle);
      await a.page.evaluate((i) => { location.hash = `#comment-${i}`; }, id);
    }
    await a.page.waitForTimeout(2200);
    const m = await measure();
    const bad = m.spines.filter((q) => q.spread > 0.01);
    const tag = bad.length ? '  <-- BROKEN' : '';
    console.log(`\n  highlighted: ${label}${tag}`);
    for (const i of m.info) {
      console.log(`      d${i.d} ${JSON.stringify(i.txt).padEnd(15)} rowL=${i.rowL} bordL=${i.bordL} padL=${i.padL} marL=${i.marL} contentL=${i.contentL} --tt-padl=${i.padVar} left=${i.styleL} ${i.hi}${i.ctmDrift ? `  CTM DRIFT ${i.ctmDrift}` : ''}`);
    }
    for (const q of m.spines) {
      console.log(`      spine x~${q.x.toFixed(2)} spread=${q.spread} [${q.at}]${q.spread > 0.01 ? '   *** STEP ***' : ''}`);
    }
    if (bad.length) broken++;
  }
}
await setZoom(1);
console.log(`\n\n${broken} configuration(s) showed a step.`);
process.exit(0);
