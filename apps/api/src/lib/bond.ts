import type { FastifyInstance } from 'fastify';
import {
  BOND_RULES, USUAL_OUTFIT, answerCall, baseName, callAskDue, callNameAfterDemo, callNameOf, callStageNow, fillName, isLookOf, localText,
  looksOf, WORLD, type BondResT, type CallChange, type Lang, type RelationshipStage, type StarId
} from '@jstar/shared';
import { CATALOG_BY_ID } from '@jstar/shared/catalog';
import { LINES } from '@jstar/shared/lines';
import { nameIn } from '@jstar/shared/kanaName';
import type { Repos, UserRow } from '../db/types';
import { newId } from './crypto';

/** One of her looks as the persona service sees it (#56): what it is, and whether he praises it often. */
export interface AgentLook { id: string; what: string; favorite: boolean }

/**
 * What she calls him now, and the name inside it (null: none she can use). `facts`: her memory of him, when the caller
 * has already read it.
 */
export async function resolveCallName(
  repos: Repos, user: Pick<UserRow, 'id' | 'nickname'>, star: StarId, stage: RelationshipStage, facts?: Record<string, string> | null, lang: Lang = 'ja'
) {
  const [state, set, memory] = await Promise.all([
    repos.bond.get(user.id, star), repos.bond.name(user.id),
    facts === undefined ? repos.chatMemory.get(user.id, star) : Promise.resolve(null)
  ]);
  const name = baseName({ set, facts: facts === undefined ? memory?.facts : facts });
  const callStage = callStageNow(stage, state);
  // Without a name only a form of address that needs none (えいみ's キミ) can be used.
  const template = WORLD[star].callNames[callStage];
  // Round 13: outside Japanese a pronoun is not what she calls him (no "Welcome back, you."): with no name, none.
  // F-12 (#10): his kana name in Latin / Hangul in an en / ko line, as stored in ja / zh-Hant.
  const callName = name ? callNameOf(star, callStage, nameIn(name, lang) ?? name, lang) : template.includes('{name}') || lang !== 'ja' ? null : callNameOf(star, callStage, '', lang);
  return { state, name, callStage, callName };
}

/**
 * What she calls him and how she changes for him, on the server (#56, docs/requirements.md §10.3; rules in
 * packages/shared/src/bond.ts). Her question about a new way to call him uses her #82 lines, which are drafts until
 * native review (#84): outside demo mode she does not ask, and keeps calling him the way he last said yes to.
 */
export function bonds(app: FastifyInstance) {
  const repos = app.repos;
  const offered = (star: StarId) => !LINES[star].draft || app.demo;

  const callNameFor = (user: Pick<UserRow, 'id' | 'nickname'>, star: StarId, stage: RelationshipStage, facts?: Record<string, string> | null, lang?: Lang) =>
    resolveCallName(repos, user, star, stage, facts, lang);

  const describe = (star: StarId, id: string): string => {
    if (id === 'outfit') return `your usual outfit (${USUAL_OUTFIT[star]})`;
    if (id === 'face') return 'your face: your smile, your eyes, your hair';
    const card = CATALOG_BY_ID[id];
    return `the look from your card 「${card ? card.title.ja : id}」`;
  };

  /** Her looks he could praise in this turn, with the ones he praises often marked. */
  async function looksFor(userId: string, star: StarId): Promise<AgentLook[]> {
    const [owned, praise] = await Promise.all([repos.owned.forUser(userId), repos.bond.praise(userId, star)]);
    return looksOf(star, owned.map((o) => o.cardId)).map((id) => ({ id, what: describe(star, id), favorite: (praise[id] ?? 0) >= BOND_RULES.praisedAt }));
  }

  async function view(user: UserRow, star: StarId, lang: Lang): Promise<BondResT> {
    const stage = (await repos.relationship.get(user.id, star))?.stage ?? 'new';
    const [{ state, name, callStage, callName }, praise] = await Promise.all([callNameFor(user, star, stage, undefined, lang), repos.bond.praise(user.id, star)]);
    const asking = offered(star) && name ? callAskDue(stage, state) : null;
    // M7 (C-room): never a question offering the name she already calls him (「可以直接叫你「ケンタ」嗎？」 to ケンタ):
    // in his language the new form is the same (en / ko / zh-Hant drop the Japanese さん / くん) — she does not ask.
    const due = asking && callNameOf(star, asking, nameIn(name, lang) ?? name!, lang) !== callName ? asking : null;
    return {
      star, callName, callStage,
      ask: due ? { to: due, text: fillName(localText(LINES[star].callName[due].ask, lang), nameIn(name, lang) ?? name!) } : null,
      praise
    };
  }

  /**
   * His answer to her question: kept (one conditional write, so a second tab cannot answer again), recorded as
   * `call_name.answered`, and her question and answer go into the conversation, so she remembers she asked.
   * Null when she is not asking about `to` now.
   */
  async function answer(user: UserRow, star: StarId, to: CallChange, accept: boolean, lang: Lang): Promise<{ reply: string; bond: BondResT } | null> {
    if (!offered(star)) return null;
    const stage = (await repos.relationship.get(user.id, star))?.stage ?? 'new';
    const { state, name } = await callNameFor(user, star, stage);
    if (!name) return null;
    const at = new Date().toISOString();
    const next = answerCall(stage, state, to, accept, at);
    if (!next || !(await repos.bond.answer(user.id, star, state?.asked ?? 'new', next))) return null;
    await app.recordEvent(user.id, 'call_name.answered', { star, to, answer: next.lastAnswer! });
    const line = LINES[star].callName[to];
    // F-12: his name as her line in his language writes it (Kenta / 켄타 in en / ko).
    const written = nameIn(name, lang) ?? name;
    const ask = fillName(localText(line.ask, lang), written);
    const reply = fillName(localText(accept ? line.accepted : line.declined, lang), written);
    // Her two lines, a moment apart so the history keeps their order; they cost him nothing and are not a day together.
    await repos.messages.add({ id: newId('msg'), ownerId: user.id, star, role: 'assistant', text: ask, createdAt: at });
    await repos.messages.add({ id: newId('msg'), ownerId: user.id, star, role: 'assistant', text: reply, createdAt: new Date(Date.parse(at) + 1).toISOString() });
    return { reply, bond: await view(user, star, lang) };
  }

  /** The memory model heard him praise some of her looks: one more for each, only looks of hers that exist. */
  async function heard(userId: string, star: StarId, praised: unknown, allowed: string[]): Promise<void> {
    if (!Array.isArray(praised)) return;
    const looks = praised.filter((id): id is string => typeof id === 'string' && allowed.includes(id) && isLookOf(star, id)).slice(0, 3);
    if (looks.length) await repos.bond.addPraise(userId, star, looks, new Date().toISOString(), BOND_RULES.praiseMax);
  }

  /** Demo mode moved the relationship: moved back, she forgets the questions above it, so they can be tried again. */
  async function afterDemo(userId: string, star: StarId, stage: RelationshipStage): Promise<void> {
    const next = callNameAfterDemo(stage, await repos.bond.get(userId, star));
    if (next) await repos.bond.set(userId, star, next);
  }

  return { callNameFor, looksFor, view, answer, heard, afterDemo, offered };
}
