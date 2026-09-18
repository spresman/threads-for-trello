/**
 * Hover a comment at the one name length where doing so makes its row taller,
 * and watch the spine — vertically *and* horizontally.
 *
 * Hover reveals Trello's "Copy link to comment" control. While the header line
 * has room for it nothing moves; within one control's width of wrapping, the
 * line wraps and the row grows for as long as the mouse is there. Since hover
 * is a CSS state and changes nothing in the DOM, no repaint used to follow.
 *
 * `09-spine.mjs` asserts on this; this prints the whole picture around it,
 * which is what you want when it starts failing: row heights, painted segments
 * in screen coordinates, and both the hole between segments that share an x and
 * the spread between segments that ought to. A break can be either — measuring
 * only holes hides a spine that stepped sideways, and vice versa. Row class and
 * padding are printed too, since hover is another CSS state that could walk the
 * same stale-anchor path the notification highlight took (see `_stale.mjs`).
 *
 * Usage: node test/browser/_hover-wrap.mjs
 */
import { attach, openCard, createCard, post, replyVia, stamp } from './harness.mjs';

const LIST = '6a8508bd571817194e5ba0a4';

const a = await attach(9222, 'A');
const card = await createCard(a, LIST, `hv5 ${new Date().toISOString().slice(0, 16)}`);
console.log(`card: https://trello.com/c/${card.shortLink}`);
await openCard(a, card.shortLink);

const s = stamp();
const ROOT = `h5-root-${s}`, K1 = `h5-kid1-${s}`, K2 = `h5-kid2-${s}`;
await post(a, ROOT);
await replyVia(a, ROOT, K1);
await replyVia(a, ROOT, K2);
await a.page.waitForTimeout(2500);

const setName = (needle, txt) => a.page.evaluate(([t, v]) => {
  const row = Array.from(document.querySelectorAll('[data-tt-id]')).find((n) => n.innerText.includes(t));
  if (!row) return null;
  const el = row.querySelector('[data-probe-name]')
    || Array.from(row.querySelectorAll('span'))
      .find((n) => !n.querySelector('*') && /^[A-Za-z][A-Za-z ]{2,40}$/.test((n.textContent || '').trim()));
  if (!el) return null;
  el.setAttribute('data-probe-name', '1');
  el.textContent = v;
  return true;
}, [needle, txt]);

const snap = (needle) => a.page.evaluate((t) => {
  const rows = Array.from(document.querySelectorAll('[data-tt-id]'));
  const segs = [];
  const info = [];
  for (const row of rows) {
    const cs = getComputedStyle(row);
    const svg = row.querySelector(':scope > .tt-rails');
    const path = svg && svg.querySelector('path');
    const r = row.getBoundingClientRect();
    info.push({
      d: row.dataset.ttDepth,
      h: +r.height.toFixed(1),
      padL: parseFloat(cs.paddingLeft) || 0,
      styleL: svg ? svg.style.left : null,
      cls: row.className.split(/\s+/).filter((c) => !c.startsWith('tt-')).sort().join(' '),
      hov: row.matches(':hover'),
    });
    if (!path || !svg) continue;
    const sr = svg.getBoundingClientRect();
    for (const m of (path.getAttribute('d') || '').matchAll(/M(-?[\d.]+) (-?[\d.]+)V(-?[\d.]+)/g)) {
      segs.push({ x: +(sr.left + +m[1]).toFixed(2), y0: sr.top + +m[2], y1: sr.top + +m[3], d: row.dataset.ttDepth });
    }
  }
  // Vertical: holes between segments that share an x (within half a pixel).
  // Horizontal: segments that ought to share an x but do not — grouped loosely,
  // then the spread inside each group.
  const groups = [];
  for (const g of segs.slice().sort((u, v) => u.x - v.x)) {
    const b = groups.find((q) => Math.abs(q.segs[0].x - g.x) < 8);
    if (b) b.segs.push(g); else groups.push({ segs: [g] });
  }
  let hole = 0, holeAt = '', spread = 0, spreadAt = '';
  for (const q of groups) {
    const xs = q.segs.map((g) => g.x);
    const sp = Math.max(...xs) - Math.min(...xs);
    if (sp > spread) { spread = sp; spreadAt = `x~${xs[0].toFixed(1)} [${q.segs.map((g) => `d${g.d}:${g.x}`).join(' ')}]`; }
    const ordered = q.segs.slice().sort((u, v) => u.y0 - v.y0);
    for (let i = 0; i < ordered.length - 1; i++) {
      const h = ordered[i + 1].y0 - ordered[i].y1;
      if (h > hole) { hole = h; holeAt = `x~${xs[0].toFixed(1)} d${ordered[i].d}→d${ordered[i + 1].d}`; }
    }
  }
  return { info, hole: +hole.toFixed(2), holeAt, spread: +spread.toFixed(2), spreadAt };
}, needle);

const unhover = async () => { await a.page.mouse.move(4, 4); await a.page.waitForTimeout(700); };
const hoverAt = async (needle) => {
  const box = await a.page.evaluate((t) => {
    const el = Array.from(document.querySelectorAll('[data-tt-id]')).find((n) => n.innerText.includes(t));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + 130, y: r.top + 14 };
  }, needle);
  if (box) await a.page.mouse.move(box.x, box.y);
};

const show = (label, s) => {
  console.log(`  ${label}`);
  for (const i of s.info) {
    console.log(`      d${i.d} h=${i.h} padL=${i.padL} styleLeft=${i.styleL} hover=${i.hov} cls="${i.cls}"`);
  }
  console.log(`      vertical hole ${s.hole} ${s.holeAt}   horizontal spread ${s.spread} ${s.spreadAt}`);
  return s;
};

const BASE = 'Featherstonehaugh Marchbanks';
for (const k of [4, 5, 6]) {
  const name = BASE + (k ? ' ' + 'ABCDEFGHIJKL'.slice(0, k).split('').join(' ') : '');
  await setName(K1, name);
  await a.page.waitForTimeout(900);
  console.log(`\n\n########## k=${k}  ${JSON.stringify(name)}`);
  await unhover();
  show('not hovering', await snap(K1));
  await hoverAt(K1);
  await a.page.waitForTimeout(50);
  show('hovering, +50ms', await snap(K1));
  await a.page.waitForTimeout(150);
  show('hovering, +200ms', await snap(K1));
  await a.page.waitForTimeout(1300);
  show('hovering, +1500ms', await snap(K1));
  await unhover();
  show('unhovered again', await snap(K1));
}
process.exit(0);
