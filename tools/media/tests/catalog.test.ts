import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BANNED, CATALOG_OUT, build, cardId, spokenSeconds, storyChars, tierOf, validate, type Card } from '../src/catalog';
import { headBox, photoHeadBox, photosOf, pick, viewOf } from '../src/refs';
import { LOOK, anonScene, promptFor } from '../src/cards';

describe('card catalog (docs/catalog-spec.md)', () => {
  it('maps positions to tiers: 01–10 N, 11–18 R, 19–25 SR, 26–29 SSR, 30 UR', () => {
    expect([1, 10, 11, 18, 19, 25, 26, 29, 30].map(tierOf)).toEqual(['N', 'N', 'R', 'R', 'SR', 'SR', 'SSR', 'SSR', 'UR']);
    expect(cardId('mahiro', 7)).toBe('s1-mahiro-07');
  });

  it('source files build into a catalog that passes every contract check', async () => {
    const cards = await build();
    expect(validate(cards)).toEqual([]);
  });

  it('the committed catalog.s1.json is the build output (run npm run media:catalog after editing sources)', async () => {
    const committed = JSON.parse(readFileSync(CATALOG_OUT, 'utf8')) as Card[];
    expect(committed).toEqual(await build());
  });

  it('catches contract breaks', async () => {
    const cards = await build();
    const broken = structuredClone(cards);
    broken[0].title.ja = broken[1].title.ja;
    broken[5].scene = 'a woman in lingerie';
    delete broken[25].story;
    broken[2].story = broken[25 + 1].story;
    const errors = validate(broken).join('\n');
    expect(errors).toMatch(/not unique/);
    expect(errors).toMatch(/clothed companion/);
    expect(errors).toMatch(/SSR\/UR needs a story/);
    expect(errors).toMatch(/only SSR\/UR have stories/);
  });

  it('keeps scenes inside the clothed companion tone', () => {
    for (const w of ['lingerie', 'bikini', 'school uniform', 'swimsuit', 'nude']) expect(BANNED.test(`she wears a ${w}`)).toBe(true);
    for (const w of ['cardigan', 'yukata', 'evening gown', 'pajamas buttoned to the collar']) expect(BANNED.test(`she wears a ${w}`)).toBe(false);
  });

  it('measures lines and stories the way the spec counts them', () => {
    expect(spokenSeconds('おはよ。コーヒー、あなたの分もいれといたよ。')).toBeLessThan(12);
    expect(spokenSeconds('あ'.repeat(90))).toBeGreaterThan(12);
    expect(storyChars('あい う\nえ')).toBe(4);
  });
});

describe('card art prompts', () => {
  it('every card prompt locks identity, stays clothed and never names the talent', async () => {
    for (const card of await build()) {
      const p = promptFor(card, 5, ['eyes smaller than references']);
      expect(p).toMatch(/exact likeness/);
      expect(p).toMatch(/fully and modestly clothed/);
      expect(p).toContain(anonScene(card.scene));
      expect(p).toMatch(/Correct these differences/);
      expect(BANNED.test(p.replace(/^Constraints:.*$/m, ''))).toBe(false); // the constraints line names what is forbidden
      expect(p).not.toMatch(/Mahiro|Nana|Unpai|Alice|Eimi|唯井|八木|うんぱい|七瀬|深田/);
    }
  });

  it('keeps the hair colours the past review flagged', () => {
    expect(LOOK.alice).toMatch(/burgundy/);
    expect(LOOK.unpai).toMatch(/caramel/);
    expect(LOOK.unpai).toMatch(/NOT bright orange/);
    expect(LOOK.mahiro).toMatch(/aegyo-sal/);
  });
});

describe('reference extraction', () => {
  it('classifies head pose', () => {
    expect([0, 12, -20, 45].map(viewOf)).toEqual(['front', 'left34', 'right34', 'profile']);
  });

  it('keeps picks apart in time and fills view quotas first', () => {
    const f = (t: number, yaw: number, quality: number) => ({ file: `${t}`, t, source: 'a', face: { x: 0, y: 0, w: 300, h: 300, yaw, quality } });
    const frames = [f(1, 0, 0.9), f(1.2, 0, 0.95), f(5, 0, 0.5), f(9, 20, 0.3), f(12, -20, 0.2), f(15, 50, 0.1)];
    const chosen = pick(frames, 4);
    const ts = chosen.map((c) => c.t).sort((a, b) => a - b);
    for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(1.5);
    expect(chosen.some((c) => c.face.yaw === 20)).toBe(true);
  });

  it('crops head and hair only, inside the frame', () => {
    const b = headBox({ x: 1700, y: 540, w: 360, h: 360 }, 3840, 2160);
    expect(b.side).toBe(684);
    expect(b.y + b.side).toBeLessThan(540 + 360 + 200);
    expect(headBox({ x: 10, y: 5, w: 400, h: 400 }, 800, 600)).toMatchObject({ x: 0, y: 0 });
  });

  it('card photos: single-talent shots only, cropped tighter under the chin', () => {
    const p = (star: string | string[] | null, tier = 'N') => ({ file: `${tier}/${star}.jpg`, tier, code: null, star, starSource: 'filename', shot: 1 });
    expect(photosOf([p('mahiro'), p('nana'), p(['mahiro', 'nana'], 'TR'), p(null, 'SR'), p('mahiro', 'UR')], 'mahiro').map((x) => x.tier)).toEqual(['N', 'UR']);
    const f = { x: 1000, y: 800, w: 400, h: 400 };
    const photo = photoHeadBox(f, 2400, 3600), clip = headBox(f, 2400, 3600);
    expect(photo.y + photo.side).toBeLessThan(clip.y + clip.side);
    expect(photo.y + photo.side).toBeLessThanOrEqual(f.y + f.h + 0.1 * f.w);
  });
});
