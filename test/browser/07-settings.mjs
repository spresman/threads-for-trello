/**
 * The popup settings, driven through the extension's own storage.
 *
 *   nestMode   'nested' (default) | 'flat'
 *   maxDepth   how deep replies may nest before attaching to an ancestor
 *   indentPx   horizontal step per level
 *
 * threads.js watches chrome.storage.onChanged for the sync area, so each of
 * these should take effect on an open card with no reload — that is the part
 * most likely to rot, because it is the only path where a setting changes
 * without apply() being triggered by a DOM mutation.
 *
 * Settings are restored to defaults at the end, pass or fail.
 */
import {
  attach, openCard, createCard, post, replyVia, probe, watch, readTree,
  setSettings, getSettings, resetSettings, indentOf, reload,
  rawText, decodeMarker, stamp, record, summary,
} from './harness.mjs';

const LIST = '6a8508bd571817194e5ba0a4';

const a = await attach(9222, 'A');
const b = await attach(9223, 'B');
console.log(`A = @${a.username}   B = @${b.username}\n`);

let failures = 0;
try {
  await resetSettings(a);
  record('settings start from defaults',
    Object.keys(await getSettings(a)).length === 0,
    JSON.stringify(await getSettings(a)));

  // ------------------------------------------------------------- indentPx
  const card = await createCard(a, LIST, `settings ${new Date().toISOString().slice(0, 16)}`);
  console.log(`card: https://trello.com/c/${card.shortLink}\n`);
  await openCard(a, card.shortLink);

  const s = stamp();
  const ROOT = `se-root-${s}`;
  const D1 = `se-d1-${s}`;
  const D2 = `se-d2-${s}`;
  await post(a, ROOT);
  await replyVia(a, ROOT, D1);
  await replyVia(a, D1, D2);

  console.log('--- indentPx ---');
  record('default indent is 24px per level',
    (await indentOf(a, D1)) === 24 && (await indentOf(a, D2)) === 48,
    `d1=${await indentOf(a, D1)} d2=${await indentOf(a, D2)}`);

  await setSettings(a, { indentPx: 40 });
  await a.page.waitForTimeout(1500);
  record('changing indentPx re-renders without a reload',
    (await indentOf(a, D1)) === 40 && (await indentOf(a, D2)) === 80,
    `d1=${await indentOf(a, D1)} d2=${await indentOf(a, D2)} (expected 40/80)`);

  await setSettings(a, { indentPx: 16 });
  await a.page.waitForTimeout(1500);
  record('the documented 16px minimum is honoured',
    (await indentOf(a, D1)) === 16,
    `d1=${await indentOf(a, D1)}`);

  await setSettings(a, { indentPx: 24 });
  await a.page.waitForTimeout(1200);

  // ------------------------------------------------------------- maxDepth
  console.log('\n--- maxDepth ---');
  await setSettings(a, { maxDepth: 2 });
  await a.page.waitForTimeout(1500);
  record('lowering maxDepth re-flattens what is already on screen',
    (await probe(a, D2)).depth === 2,
    `d2 depth=${(await probe(a, D2)).depth} (cap 2)`);

  const D3 = `se-d3-${s}`;
  await replyVia(a, D2, D3);
  const d3Marker = decodeMarker((await rawText(a, (await probe(a, D3)).id)).text);
  record('a new reply past the cap attaches to the deepest allowed ancestor',
    (await probe(a, D3)).depth === 2 && d3Marker === (await probe(a, D1)).id,
    `depth=${(await probe(a, D3)).depth} marker=${d3Marker} d1=${(await probe(a, D1)).id}`);

  await setSettings(a, { maxDepth: 4 });
  await a.page.waitForTimeout(1500);
  record('raising maxDepth again restores the deeper nesting',
    (await probe(a, D2)).depth === 2 && (await probe(a, D3)).depth === 2,
    `d2=${(await probe(a, D2)).depth} d3=${(await probe(a, D3)).depth}`);

  // ------------------------------------------------------------- flat mode
  console.log('\n--- flat mode ---');
  const card2 = await createCard(a, LIST, `settings-flat ${new Date().toISOString().slice(0, 16)}`);
  console.log(`card2: https://trello.com/c/${card2.shortLink}`);
  await openCard(a, card2.shortLink);
  await openCard(b, card2.shortLink);

  const f = stamp();
  const FROOT = `sf-root-${f}`;
  const FA = `sf-a-${f}`;
  await post(a, FROOT);
  await replyVia(a, FROOT, FA);

  await setSettings(a, { nestMode: 'flat' });
  await a.page.waitForTimeout(1500);
  record('flat mode is active',
    (await getSettings(a)).nestMode === 'flat',
    JSON.stringify(await getSettings(a)));

  // Replying to a depth-1 comment must attach to the TOP of its thread.
  const FB = `sf-b-${f}`;
  await replyVia(a, FA, FB);
  const fbId = (await probe(a, FB)).id;
  const fbMarker = decodeMarker((await rawText(a, fbId)).text);
  record('in flat mode a reply attaches to the top of the thread',
    fbMarker === (await probe(a, FROOT)).id,
    `marker=${fbMarker} root=${(await probe(a, FROOT)).id} (nested mode would give ${(await probe(a, FA)).id})`);
  record('so the thread never deepens past one level',
    (await probe(a, FB)).depth === 1,
    `depth=${(await probe(a, FB)).depth} (expected 1)`);

  // B is still in nested mode: settings are per-browser, and the marker is
  // what travels, so B must see exactly the same shape.
  await watch(b, FB, 20);
  record('the other browser sees the same shape regardless of its own setting',
    (await probe(b, FB)).depth === 1,
    `B depth=${(await probe(b, FB)).depth}`);

  // Flat mode changes where the marker points, and must not disturb who gets
  // mentioned: the person replied to, not the owner of the thread it flattens
  // into.
  const THEIRS = `sf-theirs-${f}`;
  await post(b, THEIRS);
  await watch(a, THEIRS, 20);
  await replyVia(a, THEIRS, `sf-toThem-${f}`);
  const toThemRaw = (await rawText(a, (await probe(a, `sf-toThem-${f}`)).id)).text || '';
  record('in flat mode the mention still names the person replied to',
    toThemRaw.includes(`@${b.username}`),
    `sent=${JSON.stringify(toThemRaw.replace(/[​‌⁠]/g, ''))}`);

  await setSettings(a, { nestMode: 'nested' });
  await a.page.waitForTimeout(1500);
  record('switching back to nested does not rewrite existing comments',
    decodeMarker((await rawText(a, fbId)).text) === (await probe(a, FROOT)).id,
    'the stored marker is unchanged; only new replies differ');

  // --------------------------------------------- settings survive a reload
  console.log('\n--- persistence ---');
  await setSettings(a, { indentPx: 32, maxDepth: 3, nestMode: 'flat' });
  await reload(a);
  const persisted = await getSettings(a);
  record('settings survive a reload',
    persisted.indentPx === 32 && persisted.maxDepth === 3 && persisted.nestMode === 'flat',
    JSON.stringify(persisted));
  record('and are applied to the rendered rows after reload',
    (await indentOf(a, FA)) === 32,
    `indent=${await indentOf(a, FA)} (expected 32)`);

  console.log('\nfinal tree (A):');
  console.dir((await readTree(a)).rows, { depth: null });
  console.log(`\ncard: https://trello.com/c/${card2.shortLink}`);
} finally {
  await resetSettings(a);
  await resetSettings(b);
  console.log('\nsettings reset to defaults on both browsers.');
  failures = summary();
  await a.browser.close();
  await b.browser.close();
}
process.exit(failures ? 1 : 0);
