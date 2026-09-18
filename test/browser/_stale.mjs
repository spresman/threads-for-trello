/**
 * Does the rail origin survive Trello turning the notification highlight on or
 * off?
 *
 * The row's left padding is measured during a paint and the rail layer anchored
 * to the content box with it. The highlight, though, is a *class* on the row,
 * and before 0.3.5 the only observer watched `childList` — so an attribute
 * change triggered no rescan, and the rail was re-anchored only if something
 * else happened to dirty the DOM at about the same moment. That was luck, not
 * design, and it read as a 12px step that came and went.
 *
 * Toggle the class with nothing else going on and see whether the rails follow.
 * `08-notification.mjs` asserts on this; this prints the geometry either side
 * of each toggle, which is what you want when it starts failing.
 *
 * Usage: node test/browser/_stale.mjs
 */
import { attach, openCard, createCard, post, replyVia, stamp } from './harness.mjs';

const LIST = '6a8508bd571817194e5ba0a4';
const HILITE = 'weK44ygheGqjx5'; // Trello's "you were notified about this one" class

const a = await attach(9222, 'A');
const card = await createCard(a, LIST, `stale ${new Date().toISOString().slice(0, 16)}`);
console.log(`card: https://trello.com/c/${card.shortLink}`);
await openCard(a, card.shortLink);

const s = stamp();
const ROOT = `st-root-${s}`, KID = `st-kid-${s}`;
await post(a, ROOT);
await replyVia(a, ROOT, KID);
await a.page.waitForTimeout(2500);

const measure = () => a.page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-tt-id]')).map((row) => {
    const cs = getComputedStyle(row);
    const svg = row.querySelector(':scope > .tt-rails');
    const path = svg && svg.querySelector('path');
    const sr = svg ? svg.getBoundingClientRect() : null;
    const dd = path ? path.getAttribute('d') || '' : '';
    return {
      d: row.dataset.ttDepth,
      padL: parseFloat(cs.paddingLeft) || 0,
      padVar: cs.getPropertyValue('--tt-padl').trim(),
      styleL: svg ? svg.style.left : null,
      lines: sr ? Array.from(dd.matchAll(/M(-?[\d.]+)/g)).map((m) => +(sr.left + +m[1]).toFixed(2)) : [],
    };
  }));

const report = async (label) => {
  const rows = await measure();
  const spine = rows.map((r) => `d${r.d}:padL=${r.padL} left=${r.styleL} lines=[${r.lines.join(',')}]`).join('\n      ');
  // The root's spine line and its child's stem must land on the same screen x.
  const d0 = rows.find((r) => r.d === '0'), d1 = rows.find((r) => r.d === '1');
  const gap = d0 && d1 && d0.lines.length && d1.lines.length
    ? +(d1.lines[0] - d0.lines[0]).toFixed(2) : null;
  console.log(`\n${label}\n      ${spine}\n      SPINE GAP (child - root) = ${gap}${gap ? '   <-- BROKEN' : ''}`);
  return gap;
};

const setClass = (on) => a.page.evaluate(([cls, want]) => {
  const row = Array.from(document.querySelectorAll('[data-tt-id]'))
    .find((n) => n.dataset.ttDepth === '0');
  if (!row) return 'no row';
  row.classList.toggle(cls, want);
  return row.className;
}, [HILITE, on]);

await report('BASELINE, no highlight');

console.log('\n\n########## 1. highlight ON, attribute change only, nothing else touched');
await setClass(true);
await a.page.waitForTimeout(4000);
const onGap = await report('4s after adding the class');

console.log('\n\n########## 2. a childList mutation anywhere (what normally rescues it)');
await a.page.evaluate(() => {
  const n = document.createElement('div');
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 10);
});
await a.page.waitForTimeout(1500);
await report('after an unrelated DOM change');

console.log('\n\n########## 3. highlight OFF again, attribute change only');
await setClass(false);
await a.page.waitForTimeout(4000);
const offGap = await report('4s after removing the class');

console.log(`\n\nRESULT: adding the class left a ${onGap}px step; removing it left a ${offGap}px step.`);
process.exit(0);
