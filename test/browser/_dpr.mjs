/**
 * Does the highlighted reply's spine step under display scaling, or in dark
 * mode?
 *
 * Under a CSS page zoom, a border is snapped to whole device pixels before
 * layout — Trello's 4px highlight border reports back as 3.63636px at zoom 1.1
 * — and its highlight is `margin-left: -16px` + `border-left: 4px` +
 * `padding-left: 12px`, which only cancels exactly while all three survive that
 * snapping. Windows display scaling reaches the page as `devicePixelRatio`
 * rather than as zoom, so the question is whether it snaps the same way. Dark
 * mode is swept alongside it, in case Trello styles the highlight differently
 * there.
 *
 * The bell-arrival highlight and a `#comment-` deep link give a row identical
 * box properties — measured: border 4px, padding 12/16, margin -16/-16 — so the
 * deep link stands in for the geometry, and does not consume a notification per
 * combination.
 *
 * Note the two spreads are computed differently on purpose. Rows are indented
 * by a transform, so each row's avatar sits one indent right of its parent's
 * and the indent has to come off before they are comparable. The rails are the
 * opposite: a child draws its line at RAIL_X - indent precisely so that it
 * lands on the same screen x as its parent's, so they are compared raw.
 *
 * Usage: node test/browser/_dpr.mjs
 */
import { attach, openCard, createCard, post, replyVia, stamp } from './harness.mjs';

const LIST = '6a8508bd571817194e5ba0a4';

const a = await attach(9222, 'A');
const card = await createCard(a, LIST, `dpr ${new Date().toISOString().slice(0, 16)}`);
console.log(`card: https://trello.com/c/${card.shortLink}`);
await openCard(a, card.shortLink);

const s = stamp();
const R = `dp-root-${s}`, A = `dp-a-${s}`;
await post(a, R);
await replyVia(a, R, A);
await a.page.waitForTimeout(2500);

const cdp = await a.page.context().newCDPSession(a.page);
const vp = await a.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));

const idOf = (t) => a.page.evaluate((needle) => {
  const el = Array.from(document.querySelectorAll('[data-tt-id]')).find((n) => n.innerText.includes(needle));
  return el ? el.dataset.ttId : null;
}, t);

const measure = () => a.page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-tt-id]'));
  return {
    dpr: window.devicePixelRatio,
    rows: rows.map((row) => {
      const cs = getComputedStyle(row);
      const svg = row.querySelector(':scope > .tt-rails');
      const path = svg && svg.querySelector('path');
      const ctm = svg && svg.getScreenCTM();
      const slot = row.firstElementChild;
      const depth = +row.dataset.ttDepth || 0;
      return {
        d: String(depth),
        indent: depth * 24,
        bordCS: +(parseFloat(cs.borderLeftWidth) || 0).toFixed(5),
        padCS: +(parseFloat(cs.paddingLeft) || 0).toFixed(5),
        marCS: +(parseFloat(cs.marginLeft) || 0).toFixed(5),
        line: cs.getPropertyValue('--tt-line').trim(),
        slotL: slot ? +slot.getBoundingClientRect().left.toFixed(4) : null,
        // Every vertical the row paints, in screen coordinates.
        railX: ctm && path
          ? Array.from((path.getAttribute('d') || '').matchAll(/M(-?[\d.]+) (-?[\d.]+)V/g))
              .map((m) => +(ctm.a * +m[1] + ctm.e).toFixed(4))
          : [],
        hi: cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : '',
      };
    }),
  };
});

/** Widest disagreement between rails that are meant to be the same spine. */
const railSpread = (rows) => {
  const xs = rows.flatMap((r) => r.railX);
  if (xs.length < 2) return null;
  const groups = [];
  for (const x of xs.sort((u, v) => u - v)) {
    const g = groups.find((q) => Math.abs(q[0] - x) < 8);
    if (g) g.push(x); else groups.push([x]);
  }
  return +Math.max(...groups.map((g) => Math.max(...g) - Math.min(...g))).toFixed(4);
};

/** Avatars sit one indent apart by design, so the indent comes off first. */
const avatarSpread = (rows) => {
  const vs = rows.map((r) => (r.slotL === null ? null : r.slotL - r.indent)).filter((v) => v !== null);
  return vs.length < 2 ? null : +(Math.max(...vs) - Math.min(...vs)).toFixed(4);
};

for (const scheme of ['light', 'dark']) {
  await cdp.send('Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await a.page.waitForTimeout(2000);
  const bg = await a.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  console.log(`\n\n######## prefers-color-scheme: ${scheme}  (page background ${bg})`);
  console.log('\n  dpr    border  padding  margin   --tt-line      highlight bg          avatar   rail');
  for (const dpr of [1, 1.1, 1.25, 1.4, 1.5, 1.75, 2]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: vp.w, height: vp.h, deviceScaleFactor: dpr, mobile: false });
    await a.page.waitForTimeout(1100);
    await a.page.evaluate(() => { location.hash = '#none'; });
    await a.page.waitForTimeout(800);
    await a.page.evaluate((i) => { location.hash = `#comment-${i}`; }, await idOf(A));
    await a.page.waitForTimeout(1900);

    const m = await measure();
    const hl = m.rows.find((r) => r.hi) || {};
    const av = avatarSpread(m.rows), rl = railSpread(m.rows);
    console.log(
      `  ${String(dpr).padEnd(6)} ${String(hl.bordCS ?? '?').padEnd(7)} ${String(hl.padCS ?? '?').padEnd(8)}`
      + ` ${String(hl.marCS ?? '?').padEnd(8)} ${String(hl.line || '(default)').padEnd(14)}`
      + ` ${String(hl.hi || '(none)').padEnd(21)} ${String(av).padStart(7)} ${String(rl).padStart(6)}`
      + (rl !== null && rl > 0.01 ? '   *** STEP ***' : '')
    );
  }
}

await cdp.send('Emulation.clearDeviceMetricsOverride');
await cdp.send('Emulation.setEmulatedMedia', { features: [] });
console.log(`\ncard: https://trello.com/c/${card.shortLink}`);
process.exit(0);
