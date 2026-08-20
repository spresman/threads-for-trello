/**
 * Shared plumbing for the live-Trello browser tests (see docs/TESTING.md).
 *
 * Two Chrome-for-Testing instances, each logged into a different Trello
 * account, each with the extension loaded, attached over CDP. Assertions read
 * the extension's own DOM contract rather than visible text:
 *
 *   [data-tt-id]       the action id a row has been bound to
 *   [data-tt-depth]    nesting depth (0 = root)
 *   [data-tt="reply"]  our reply control
 *   [data-tt="toggle"] the collapse toggle on a parent
 *   .tt-ghost          a [deleted] tombstone
 *   .tt-hidden         Trello's own control, suppressed by us
 */
import { chromium } from 'playwright-core';

export const PORTS = { a: 9222, b: 9223 };

export async function attach(port, label) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('trello.com')) || (await ctx.newPage());
  const me = await page.evaluate(async () => {
    const r = await fetch('/1/members/me?fields=id,username', { credentials: 'include' });
    return r.ok ? r.json() : null;
  });
  if (!me) throw new Error(`port ${port} is not logged into Trello`);
  return { port, label, browser, page, me, username: me.username, id: me.id };
}

export async function openCard(s, shortLink) {
  await s.page.goto(`https://trello.com/c/${shortLink}`, { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(1500);
  await s.page
    .waitForFunction(
      () =>
        document.querySelector('[data-tt-id]') ||
        document.querySelector('[data-testid*="comment"]'),
      { timeout: 20000 }
    )
    .catch(() => {});
  await s.page.waitForTimeout(2500);
}

/** Is our MAIN-world interceptor actually installed on this page? */
export function interceptorLive(s) {
  return s.page.evaluate(() => !/\[native code\]/.test(String(window.fetch)));
}

// ------------------------------------------------------------------ reading

/** The full rendered tree, as the extension sees it. */
export function readTree(s) {
  return s.page.evaluate(() => {
    const perma = new Set();
    for (const a of document.querySelectorAll('a[href^="#comment-"]')) {
      const m = (a.getAttribute('href') || '').match(/#comment-([0-9a-f]{24})/i);
      if (m) perma.add(m[1].toLowerCase());
    }
    const rows = Array.from(document.querySelectorAll('[data-tt-id]')).map((el) => ({
      id: el.dataset.ttId,
      depth: Number(el.dataset.ttDepth ?? -1),
      ghost: el.classList.contains('tt-ghost'),
      hasReply: Boolean(el.querySelector('[data-tt="reply"]')),
      hasToggle: Boolean(el.querySelector('[data-tt="toggle"]')),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50),
    }));
    return { perma: [...perma], rows, claimed: rows.map((r) => r.id) };
  });
}

/** Locate a comment by a unique substring: is it in the DOM, and did we claim it? */
export function probe(s, needle) {
  return s.page.evaluate((t) => {
    const all = Array.from(
      document.querySelectorAll(
        '[data-testid="card-back-action-container"], [data-testid="trello-card-comment"], li'
      )
    ).filter((el) => el.textContent.includes(t));
    // Innermost container that still holds the text.
    const hit = all.length ? all.reduce((a, b) => (a.contains(b) ? b : a)) : null;
    if (!hit) return { present: false };
    const row = hit.closest('[data-tt-id]') || hit.querySelector('[data-tt-id]');
    const scope = hit.closest('[data-testid="card-back-action-container"]') || hit;
    const link = scope.querySelector('a[href^="#comment-"]');
    const m = link && (link.getAttribute('href') || '').match(/#comment-([0-9a-f]{24})/i);
    return {
      present: true,
      claimed: Boolean(row),
      id: m ? m[1].toLowerCase() : null,
      depth: row ? Number(row.dataset.ttDepth ?? -1) : null,
      hasOurReply: Boolean((row || hit).querySelector('[data-tt="reply"]')),
      nativeReplyVisible: Array.from((row || hit).querySelectorAll('button')).some(
        (b) =>
          /^reply$/i.test(b.textContent.trim()) &&
          !b.classList.contains('tt-hidden') &&
          !b.hasAttribute('data-tt')
      ),
    };
  }, needle);
}

/**
 * Poll until `needle` is both present and claimed by the extension.
 * Returns ms elapsed for each milestone, or null if it never happened.
 */
export async function watch(s, needle, seconds = 25) {
  const t0 = Date.now();
  let presentAt = null;
  let claimedAt = null;
  while (Date.now() - t0 < seconds * 1000) {
    const p = await probe(s, needle);
    if (p.present && presentAt === null) presentAt = Date.now() - t0;
    if (p.claimed) {
      claimedAt = Date.now() - t0;
      break;
    }
    await s.page.waitForTimeout(400);
  }
  return { presentAt, claimedAt };
}

// ------------------------------------------------------------------ writing

async function editorEl(s) {
  const ed = s.page.locator('[data-testid*="comment"] [contenteditable="true"]').first();
  await ed.waitFor({ state: 'visible', timeout: 15000 });
  return ed;
}

async function openComposer(s) {
  if (await s.page.locator('[data-testid*="comment"] [contenteditable="true"]').count()) return;
  await s.page
    .locator(
      '[data-testid="card-back-new-comment-input-skeleton"], [data-testid="card-back-comment-input"], [data-testid="comment-box-input"]'
    )
    .first()
    .click();
}

async function save(s) {
  const btn = s.page.getByRole('button', { name: /^save$/i }).first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
  await s.page.waitForTimeout(2500);
}

/** Post a fresh top-level comment through the real composer. */
export async function post(s, text) {
  await openComposer(s);
  const ed = await editorEl(s);
  await ed.click();
  await ed.type(text, { delay: 10 });
  await save(s);
}

/**
 * Click OUR reply control on the row containing `needle`, then send `text`.
 * Returns what the composer showed before sending, so the @mention chip can
 * be asserted on.
 */
export async function replyVia(s, needle, text, waitForMentionMs = 6000) {
  const row = s.page.locator(`[data-tt-id]:has-text(${JSON.stringify(needle)})`).last();
  // Our control clones Trello's own button class, so it inherits Trello's
  // hover gating — it is not clickable until the row is hovered.
  await row.hover();
  await s.page.waitForTimeout(300);
  await row.locator('[data-tt="reply"]').first().click({ force: true });
  const ed = await editorEl(s);
  await ed.click();

  // How long until the composer actually shows something? The placeholder is a
  // real aria-hidden span inside the contenteditable, so it has to be stripped
  // the same way the extension's own editorText() strips it — otherwise an
  // empty composer reads as the text "Write a comment…".
  const t0 = Date.now();
  let seen = '';
  while (Date.now() - t0 < waitForMentionMs) {
    seen = await ed.evaluate((el) => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
      return clone.textContent.replace(/\s+/g, ' ').trim();
    });
    if (seen) break;
    await s.page.waitForTimeout(100);
  }
  const mentionMs = seen ? Date.now() - t0 : null;

  await ed.type(text, { delay: 10 });
  await save(s);
  return { composer: seen, mentionMs };
}

/**
 * Delete a comment through Trello's own API, from inside a logged-in page.
 * The CSRF token (`dsc`) must travel in the body — in the query string Trello
 * answers "CSRF detected".
 */
export function deleteComment(s, actionId) {
  return s.page.evaluate(async (id) => {
    const dsc = document.cookie.match(/(?:^|;\s*)dsc=([^;]+)/)?.[1];
    const r = await fetch(`/1/actions/${id}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dsc }),
    });
    return { ok: r.ok, status: r.status };
  }, actionId);
}

/**
 * Edit a comment through Trello's own UI, replacing its text.
 * This is the path that risks stripping the invisible marker: the text goes
 * through Trello's editor and back out again.
 */
export async function editComment(s, needle, newText) {
  const row = s.page.locator(`[data-tt-id]:has-text(${JSON.stringify(needle)})`).last();
  await row.hover();
  await s.page.waitForTimeout(300);
  const edit = row.getByRole('button', { name: /^edit$/i }).first();
  await edit.click({ force: true });
  const ed = s.page.locator('[contenteditable="true"]').filter({ hasText: needle }).first();
  await ed.waitFor({ state: 'visible', timeout: 15000 });
  await ed.click();
  // Select-all then type, the way a person editing a comment would.
  await s.page.keyboard.press('Control+A');
  await s.page.keyboard.type(newText, { delay: 10 });
  await s.page.getByRole('button', { name: /^save$/i }).first().click();
  await s.page.waitForTimeout(3000);
}

/** Create a card on a list, returning {shortLink, id}. */
export function createCard(s, idList, name) {
  return s.page.evaluate(async ({ idList, name }) => {
    const dsc = document.cookie.match(/(?:^|;\s*)dsc=([^;]+)/)?.[1];
    const r = await fetch('/1/cards', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idList, name, dsc }),
    });
    return r.ok ? r.json() : { error: r.status, body: await r.text() };
  }, { idList, name });
}

/** Reload and wait for the extension to settle. */
export async function reload(s, ms = 6000) {
  await s.page.reload({ waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(ms);
}

/** Every tombstone currently rendered, with its depth. */
export function ghosts(s) {
  return s.page.evaluate(() =>
    Array.from(document.querySelectorAll('.tt-ghost')).map((el) => ({
      id: el.dataset.ttId,
      depth: Number(el.dataset.ttDepth ?? -1),
    }))
  );
}

/** Read a comment's stored text straight from the API, markers and all. */
export function rawText(s, actionId) {
  return s.page.evaluate(async (id) => {
    const r = await fetch(`/1/actions/${id}?fields=data,date`, { credentials: 'include' });
    if (!r.ok) return { status: r.status };
    const j = await r.json();
    return { status: 200, text: j.data?.text ?? null };
  }, actionId);
}

const ZERO = '​';
const ONE = '‌';
const FENCE = '⁠';

/** Decode our zero-width marker from raw comment text. */
export function decodeMarker(text) {
  const m = String(text || '').match(
    new RegExp(FENCE + '([' + ZERO + ONE + ']{96})' + FENCE)
  );
  if (!m) return null;
  let hex = '';
  for (let i = 0; i < 96; i += 4) {
    hex += parseInt(
      Array.from(m[1].slice(i, i + 4), (c) => (c === ONE ? '1' : '0')).join(''),
      2
    ).toString(16);
  }
  return hex;
}

export const stamp = () => Math.random().toString(36).slice(2, 7);

// ------------------------------------------------------------------ report

const results = [];
export function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const tag = pass === true ? '  PASS' : pass === false ? '  FAIL' : '  INFO';
  console.log(`${tag}  ${name}${detail ? `\n        ${detail}` : ''}`);
}
export function summary() {
  const failed = results.filter((r) => r.pass === false);
  console.log(`\n${'='.repeat(70)}`);
  console.log(
    `${results.filter((r) => r.pass === true).length} passed, ${failed.length} failed, ` +
      `${results.filter((r) => r.pass === null).length} info`
  );
  for (const r of failed) console.log(`  FAILED: ${r.name}`);
  return failed.length;
}
