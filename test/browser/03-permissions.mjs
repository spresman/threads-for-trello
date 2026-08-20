/**
 * Ownership and board permissions.
 *
 * `isOwnComment()` decides whether to @mention, and it does so by looking for
 * an "Edit" button on the comment — because Trello renders Edit only on your
 * own comments, while board *admins* get "Delete" on everyone's. If that ever
 * regressed to keying off Delete, an admin would stop being mentioned on other
 * people's comments and would start mentioning themselves on their own.
 *
 * So each direction has to be exercised from both sides of the permission line:
 *
 *   board 1 (E1TfK1Kk)  A = admin,  B = normal
 *   board 2 (created)   B = admin,  A = normal
 */
import {
  attach, openCard, createCard, post, replyVia, probe, watch,
  rawText, decodeMarker, stamp, record, summary, readTree,
} from './harness.mjs';

const BOARD1 = { shortLink: 'E1TfK1Kk', list: '6a8508bd571817194e5ba0a4', admin: 'A' };
const BOARD2_NAME = 'TT TEST 2 - schmule admin';

const a = await attach(9222, 'A');
const b = await attach(9223, 'B');
console.log(`A = @${a.username}   B = @${b.username}\n`);

// ------------------------------------------- find or create the mirror board
const board2 = await b.page.evaluate(async ({ name, inviteeId }) => {
  const dsc = document.cookie.match(/(?:^|;\s*)dsc=([^;]+)/)?.[1];
  const j = async (u, opts) => {
    const r = await fetch(u, { credentials: 'include', ...opts });
    return r.ok ? r.json() : { error: r.status, body: await r.text() };
  };
  const mine = await j('/1/members/me/boards?fields=id,name,shortLink&filter=open');
  let board = Array.isArray(mine) ? mine.find((x) => x.name === name) : null;
  if (!board) {
    board = await j('/1/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, defaultLists: false, dsc }),
    });
    if (!board.id) return board;
  }
  // Idempotent: re-adding an existing member just reasserts the role.
  await j(`/1/boards/${board.id}/members/${inviteeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'normal', dsc }),
  });
  let lists = await j(`/1/boards/${board.id}/lists?fields=id,name`);
  if (!lists.length) {
    lists = [
      await j('/1/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Testing', idBoard: board.id, dsc }),
      }),
    ];
  }
  const memberships = await j(`/1/boards/${board.id}/memberships?member=true&member_fields=username`);
  return { board, list: lists[0].id, memberships };
}, { name: BOARD2_NAME, inviteeId: a.id });

if (!board2.list) { console.error('board 2 setup failed', board2); process.exit(1); }
console.log(`board 2: ${board2.board.shortLink}  roles:`,
  board2.memberships.map((m) => `@${m.member?.username}=${m.memberType}`).join(' '));

record('board 2 has the roles reversed',
  board2.memberships.some((m) => m.member?.username === b.username && m.memberType === 'admin') &&
  board2.memberships.some((m) => m.member?.username === a.username && m.memberType === 'normal'),
  board2.memberships.map((m) => `@${m.member?.username}=${m.memberType}`).join(' '));

// -------------------------------------------------------------- the scenarios
const CASES = [
  { name: 'board 1 (A admin, B normal)', list: BOARD1.list, owner: a, other: b, ownerRole: 'admin', otherRole: 'normal' },
  { name: 'board 2 (B admin, A normal)', list: board2.list, owner: b, other: a, ownerRole: 'admin', otherRole: 'normal' },
];

for (const c of CASES) {
  console.log(`\n${'='.repeat(66)}\n${c.name}\n${'='.repeat(66)}`);
  const card = await createCard(c.owner, c.list, `perm probe ${new Date().toISOString().slice(0, 16)}`);
  if (!card.shortLink) { console.error('card creation failed', card); process.exit(1); }
  console.log(`card: https://trello.com/c/${card.shortLink}`);

  await openCard(c.owner, card.shortLink);
  await openCard(c.other, card.shortLink);

  const s = stamp();
  const ADMIN_SAYS = `perm-admin-${s}`;
  const OTHER_SAYS = `perm-other-${s}`;
  const SELF_REPLY = `perm-self-${s}`;
  const CROSS_REPLY = `perm-cross-${s}`;

  // The admin posts; the normal member posts.
  await post(c.owner, ADMIN_SAYS);
  await watch(c.other, ADMIN_SAYS, 20);
  await post(c.other, OTHER_SAYS);
  await watch(c.owner, OTHER_SAYS, 20);

  // 1. Admin replies to their OWN comment -> no self-mention.
  const selfR = await replyVia(c.owner, ADMIN_SAYS, SELF_REPLY);
  record(`${c.name}: admin replying to self is NOT @mentioned`,
    !/@/.test(selfR.composer),
    `composer=${JSON.stringify(selfR.composer)} after ${selfR.mentionMs}ms`);

  const selfProbe = await probe(c.owner, SELF_REPLY);
  record(`${c.name}: self-reply nests under the admin's own comment`,
    selfProbe.depth === 1,
    `depth=${selfProbe.depth}`);
  const selfMarker = decodeMarker((await rawText(c.owner, selfProbe.id)).text);
  const adminId = (await probe(c.owner, ADMIN_SAYS)).id;
  record(`${c.name}: self-reply's marker points at the admin's own comment`,
    selfMarker === adminId,
    `marker=${selfMarker} expected=${adminId}`);

  // 2. Admin replies to the OTHER person's comment -> mention, despite having
  //    Delete on it (which is the trap isOwnComment must not fall into).
  const crossR = await replyVia(c.owner, OTHER_SAYS, CROSS_REPLY);
  record(`${c.name}: admin replying to a member IS @mentioned`,
    crossR.composer.includes(`@${c.other.username}`),
    `composer=${JSON.stringify(crossR.composer)} after ${crossR.mentionMs}ms`);

  const crossProbe = await probe(c.owner, CROSS_REPLY);
  const crossRaw = (await rawText(c.owner, crossProbe.id)).text || '';
  const crossMarker = decodeMarker(crossRaw);
  const otherId = (await probe(c.owner, OTHER_SAYS)).id;
  record(`${c.name}: cross-reply's marker points at the member's comment`,
    crossMarker === otherId,
    `marker=${crossMarker} expected=${otherId}`);

  // What actually notifies the person: the text Trello stored.
  record(`${c.name}: the SENT comment contains @${c.other.username}`,
    crossRaw.includes(`@${c.other.username}`),
    `sent=${JSON.stringify(crossRaw.replace(/[​‌⁠]/g, ''))}`);

  const selfSent = (await rawText(c.owner, selfProbe.id)).text || '';
  record(`${c.name}: a self-reply does NOT mention you`,
    !selfSent.includes(`@${c.owner.username}`),
    `sent=${JSON.stringify(selfSent.replace(/[​‌⁠]/g, ''))}`);

  // Regression: every reply after the first on a page used to open an empty
  // composer, because focusComposer() re-mounted the editor and discarded the
  // chip Trello had just inserted.
  const SECOND_CROSS = `perm-cross2-${s}`;
  const cross2R = await replyVia(c.owner, OTHER_SAYS, SECOND_CROSS);
  record(`${c.name}: a SECOND reply on the same page still shows the @mention`,
    cross2R.composer.includes(`@${c.other.username}`),
    `composer=${JSON.stringify(cross2R.composer)} after ${cross2R.mentionMs}ms`);

  const cross2Raw = (await rawText(c.owner, (await probe(c.owner, SECOND_CROSS)).id)).text || '';
  record(`${c.name}: the second reply's SENT text contains the mention too`,
    cross2Raw.includes(`@${c.other.username}`),
    `sent=${JSON.stringify(cross2Raw.replace(/[​‌⁠]/g, ''))}`);
  record(`${c.name}: the mention is not duplicated`,
    (cross2Raw.match(new RegExp(`@${c.other.username}`, 'g')) || []).length === 1,
    `count=${(cross2Raw.match(new RegExp(`@${c.other.username}`, 'g')) || []).length}`);

  // 3. The admin can Delete the other person's comment; that must not read as
  //    ownership.
  const controls = await c.owner.page.evaluate((t) => {
    const el = Array.from(document.querySelectorAll('[data-tt-id]')).find((n) => n.innerText.includes(t));
    return el ? Array.from(el.querySelectorAll('button')).map((x) => x.textContent.trim()).filter(Boolean) : null;
  }, OTHER_SAYS);
  record(`${c.name}: admin sees Delete but not Edit on a member's comment`,
    Boolean(controls && controls.some((x) => /^delete$/i.test(x)) && !controls.some((x) => /^edit$/i.test(x))),
    `buttons=${JSON.stringify(controls)}`);

  // 4. The normal member's own view: reply to self, no mention.
  const otherSelf = `perm-oself-${s}`;
  await watch(c.other, CROSS_REPLY, 20);
  const otherR = await replyVia(c.other, OTHER_SAYS, otherSelf);
  record(`${c.name}: normal member replying to self is NOT @mentioned`,
    !/@/.test(otherR.composer),
    `composer=${JSON.stringify(otherR.composer)} after ${otherR.mentionMs}ms`);

  const oProbe = await probe(c.other, otherSelf);
  record(`${c.name}: normal member's self-reply threads under their own comment`,
    oProbe.depth === 1,
    `depth=${oProbe.depth}`);
  const oMarker = decodeMarker((await rawText(c.other, oProbe.id)).text);
  const otherIdOnOther = (await probe(c.other, OTHER_SAYS)).id;
  record(`${c.name}: normal member's marker points at their own comment`,
    oMarker === otherIdOnOther,
    `marker=${oMarker} expected=${otherIdOnOther}`);

  console.log(`tree (${c.ownerRole} view):`);
  console.dir((await readTree(c.owner)).rows, { depth: null });
}

const failures = summary();
await a.browser.close();
await b.browser.close();
process.exit(failures ? 1 : 0);
