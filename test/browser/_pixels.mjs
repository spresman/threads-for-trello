/**
 * Read the rendered pixels across the spine, above and below the handover.
 *
 * Every coordinate in this configuration measures exact, so the remaining
 * question is what is actually painted. Screenshot a narrow column straddling
 * the rail, spanning the row boundary, and print the luminance profile of one
 * scanline from each side plus the sub-pixel centre of the line on every
 * scanline. The browser decodes its own screenshot (createImageBitmap into an
 * OffscreenCanvas), so no image decoder is needed here.
 *
 * Reported in device pixels, which is the only unit in which "off by a pixel"
 * means anything.
 *
 * Usage: node test/browser/_pixels.mjs
 */
import { attach, openCard, createCard, post, replyVia, stamp } from './harness.mjs';

const LIST = '6a8508bd571817194e5ba0a4';

const a = await attach(9222, 'A');
const card = await createCard(a, LIST, `pixels ${new Date().toISOString().slice(0, 16)}`);
console.log(`card: https://trello.com/c/${card.shortLink}`);
await openCard(a, card.shortLink);

const s = stamp();
const R = `px-root-${s}`, A1 = `px-a-${s}`, A2 = `px-b-${s}`;
await post(a, R);
await replyVia(a, R, A1);
await replyVia(a, R, A2);
await a.page.waitForTimeout(2500);

const cdp = await a.page.context().newCDPSession(a.page);
const vp = await a.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));

const idOf = (t) => a.page.evaluate((needle) => {
  const el = Array.from(document.querySelectorAll('[data-tt-id]')).find((n) => n.innerText.includes(needle));
  return el ? el.dataset.ttId : null;
}, t);

/** The rail's x, and the y where the root's piece gives way to the reply's. */
const junction = () => a.page.evaluate((t) => {
  const rows = Array.from(document.querySelectorAll('[data-tt-id]'));
  const root = rows.find((n) => n.dataset.ttDepth === '0');
  const kid = rows.find((n) => n.innerText.includes(t));
  if (!root || !kid) return null;
  const svg = root.querySelector(':scope > .tt-rails');
  const path = svg && svg.querySelector('path');
  const ctm = svg && svg.getScreenCTM();
  const m = path && (path.getAttribute('d') || '').match(/M(-?[\d.]+) /);
  if (!ctm || !m) return null;
  return { x: ctm.a * +m[1] + ctm.e, y: kid.getBoundingClientRect().top };
}, A1);

const analyse = (b64, clipX, dpr) => a.page.evaluate(async ({ data, clipX, dpr }) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const cvs = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const lum = (x, y) => {
    const i = (y * bmp.width + x) * 4;
    return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  };
  const rgbAt = (x, y) => {
    const i = (y * bmp.width + x) * 4;
    return `${px[i]},${px[i + 1]},${px[i + 2]}`;
  };
  // Background is the most common luminance on the scanline; the line is
  // whatever departs from it. Works whether the row is dark, light or blue.
  const centre = (y) => {
    const counts = new Map();
    for (let x = 0; x < bmp.width; x++) {
      const k = Math.round(lum(x, y) / 4);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let bg = 0, best = -1;
    for (const [k, n] of counts) if (n > best) { best = n; bg = k * 4; }
    let sw = 0, sxw = 0, peak = 0;
    for (let x = 0; x < bmp.width; x++) {
      const w = Math.abs(lum(x, y) - bg);
      if (w < 6) continue;
      peak = Math.max(peak, w);
      sw += w; sxw += x * w;
    }
    return sw > 10 && peak > 20 ? { c: +(sxw / sw).toFixed(3), bg: +bg.toFixed(0) } : null;
  };
  const profile = (y) => Array.from({ length: bmp.width }, (_, x) => Math.round(lum(x, y))).join(' ');
  const rowOf = (y) => Array.from({ length: bmp.width }, (_, x) => rgbAt(x, y));
  const mid = Math.round(bmp.height / 2);
  const centres = [];
  for (let y = 0; y < bmp.height; y++) centres.push(centre(y));
  return {
    w: bmp.width, h: bmp.height, mid, dpr, clipX,
    aboveProfile: profile(Math.max(0, mid - Math.round(12 * dpr))),
    belowProfile: profile(Math.min(bmp.height - 1, mid + Math.round(12 * dpr))),
    aboveColors: rowOf(Math.max(0, mid - Math.round(12 * dpr))).join(' | '),
    belowColors: rowOf(Math.min(bmp.height - 1, mid + Math.round(12 * dpr))).join(' | '),
    centres,
  };
}, { data: b64, clipX, dpr });

for (const scheme of ['dark', 'light']) {
  await cdp.send('Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await a.page.waitForTimeout(1600);
  for (const dpr of [1, 1.5]) {
    for (const [tag, needle] of [['plain', null], ['highlighted', A1]]) {
      await a.page.evaluate(() => { location.hash = '#none'; });
      await a.page.waitForTimeout(800);
      if (needle) await a.page.evaluate((i) => { location.hash = `#comment-${i}`; }, await idOf(needle));
      await a.page.waitForTimeout(1900);

      await cdp.send('Emulation.setDeviceMetricsOverride',
        { width: vp.w, height: vp.h, deviceScaleFactor: dpr, mobile: false });
      await a.page.waitForTimeout(800);
      const j = await junction();
      if (!j) { console.log(`${scheme}/${dpr}/${tag}: no junction`); continue; }
      const clipX = Math.max(0, Math.round(j.x) - 20);
      const clip = { x: clipX, y: Math.max(0, j.y - 24), width: 28, height: 48 };
      const shot = await a.page.screenshot({ clip, scale: 'device' });
      const r = await analyse(shot.toString('base64'), clipX, dpr);
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await a.page.waitForTimeout(400);

      const ok = r.centres.filter((c) => c !== null);
      const above = r.centres.slice(0, r.mid - 2).filter((c) => c !== null).map((c) => c.c);
      const below = r.centres.slice(r.mid + 2).filter((c) => c !== null).map((c) => c.c);
      const avg = (xs) => (xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : null);
      const ca = avg(above), cb = avg(below);
      console.log(`\n=== ${scheme} dpr=${dpr} ${tag}   railX(css)=${j.x.toFixed(2)} clipX=${clipX} image ${r.w}x${r.h}`);
      console.log(`  line centre above=${ca === null ? 'n/a' : ca.toFixed(3)}  below=${cb === null ? 'n/a' : cb.toFixed(3)}`
        + `  step=${ca !== null && cb !== null ? (cb - ca).toFixed(3) : 'n/a'} device px`);
      console.log(`  scanline above: ${r.aboveProfile}`);
      console.log(`  scanline below: ${r.belowProfile}`);
      if (scheme === 'dark' && tag === 'highlighted') {
        console.log(`  colours above: ${r.aboveColors}`);
        console.log(`  colours below: ${r.belowColors}`);
      }
    }
  }
}

await cdp.send('Emulation.setEmulatedMedia', { features: [] });
console.log(`\ncard: https://trello.com/c/${card.shortLink}`);
process.exit(0);
