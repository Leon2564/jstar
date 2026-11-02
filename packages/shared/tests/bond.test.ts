import { describe, expect, it } from 'vitest';
import {
  BOND_RULES, STAR_IDS, VARIANT_CARDS, WORLD, answerCall, baseName, callAskDue, callNameAfterDemo, callNameOf, callStageNow, callStageOf,
  cleanCallName, fillName, freshCallName, isLookOf, lookWeight, looksOf, pickLook
} from '../src';
import { LINES } from '../src/lines';

const AT = '2026-11-02T12:00:00.000Z';

describe('what she calls him (#56)', () => {
  it('one name, three forms: さん → くん → the name alone', () => {
    expect(['new', 'familiar', 'lover'].map((s) => callNameOf('mahiro', s as 'new', 'ケンタ'))).toEqual(['ケンタさん', 'ケンタくん', 'ケンタ']);
    // えいみ keeps キミ as lovers (plan v2), and needs no name for it.
    expect(callNameOf('eimi', 'lover', 'ケンタ')).toBe('キミ');
    // N-09: さん / くん / キミ are Japanese; in another language she uses his name as he set it.
    expect(['new', 'familiar', 'lover'].map((s) => callNameOf('mahiro', s as 'new', 'ケンタ', 'en'))).toEqual(['ケンタ', 'ケンタ', 'ケンタ']);
    // えいみ's キミ is her pet name for him in his language, as her lines promise it (#171) — never "you" as a name.
    expect(['en', 'ko', 'zh-Hant'].map((l) => callNameOf('eimi', 'lover', 'ケンタ', l))).toEqual(['darling', '자기', '親愛的']);
    expect(['en', 'ko', 'zh-Hant'].map((l) => callNameOf('eimi', 'lover', '', l))).toEqual(['darling', '자기', '親愛的']);
    expect(['en', 'ko', 'zh-Hant'].map((l) => callNameOf('eimi', 'familiar', 'ケンタ', l))).toEqual(['ケンタ', 'ケンタ', 'ケンタ']);
    expect(callNameOf('mahiro', 'new', 'ケンちゃん', 'ko')).toBe('ケンちゃん');
  });

  it('ambiguous and the confession keep familiar', () => {
    expect(['new', 'familiar', 'ambiguous', 'confession_ready', 'lover'].map((s) => callStageOf(s as 'new'))).toEqual(['new', 'familiar', 'familiar', 'familiar', 'lover']);
  });

  it('she asks once per change; yes moves her on, no keeps the old form', () => {
    expect(callAskDue('new', null)).toBeNull();
    expect(callAskDue('familiar', null)).toBe('familiar');
    const yes = answerCall('familiar', null, 'familiar', true, AT)!;
    expect(yes).toEqual({ stage: 'familiar', asked: 'familiar', lastAnswer: 'accepted', answeredAt: AT });
    expect(callAskDue('ambiguous', yes)).toBeNull();
    expect(answerCall('familiar', yes, 'familiar', false, AT)).toBeNull();

    const no = answerCall('familiar', null, 'familiar', false, AT)!;
    expect(no).toMatchObject({ stage: 'new', asked: 'familiar', lastAnswer: 'declined' });
    expect(callStageNow('confession_ready', no)).toBe('new');
    expect(callAskDue('lover', no)).toBe('lover');
    expect(callStageNow('lover', answerCall('lover', no, 'lover', true, AT))).toBe('lover');
  });

  it('never answers a question she is not asking', () => {
    expect(answerCall('new', null, 'familiar', true, AT)).toBeNull();
    // A skipped change: she asks only about the stage the relationship stands at.
    expect(callAskDue('lover', null)).toBe('lover');
    expect(answerCall('lover', null, 'familiar', true, AT)).toBeNull();
  });

  it('never calls him closer than the relationship is, and the demo moving back lets her ask again', () => {
    const lover = { ...freshCallName(), stage: 'lover' as const, asked: 'lover' as const };
    expect(callStageNow('familiar', lover)).toBe('familiar');
    expect(callNameAfterDemo('familiar', lover)).toMatchObject({ stage: 'familiar', asked: 'familiar' });
    expect(callNameAfterDemo('lover', lover)).toBeNull();
    expect(callNameAfterDemo('new', null)).toBeNull();
  });

  it('fills her lines, keeping a name that carries its own ending', () => {
    expect(fillName('{name}くんって呼んでもいい？', 'ケンタ')).toBe('ケンタくんって呼んでもいい？');
    expect(fillName('{name}くんって呼んでもいい？', 'ケンちゃん')).toBe('ケンちゃんって呼んでもいい？');
    expect(fillName('Can I call you {name}-kun?', 'Ken')).toBe('Can I call you Ken-kun?');
    expect(fillName('{name}、{name}くん', '$&')).toBe('$&、$&くん');
    for (const star of STAR_IDS) {
      for (const to of ['familiar', 'lover'] as const) {
        for (const l of ['ja', 'zh-Hant', 'en'] as const) expect(fillName(LINES[star].callName[to].ask[l], 'ケンタ'), `${star} ${to} ${l}`).not.toContain('{name}');
      }
    }
  });

  it('his name: what he set, then what he told her — never the account nickname (his e-mail handle, round 10)', () => {
    expect(baseName({ set: 'ケン', facts: { name: 'ケンタ' } })).toBe('ケン');
    expect(baseName({ facts: { call_name: 'ケンちゃん', name: 'ケンタ' } })).toBe('ケンちゃん');
    expect(baseName({ facts: { name: 'ケンタ' } })).toBe('ケンタ');
    expect(baseName({ facts: {} })).toBeNull();
    expect(baseName({})).toBeNull();
  });

  it('a name he sets is short and carries no contact details', () => {
    expect(cleanCallName('  ｹﾝ  ')).toBe('ケン');
    expect(cleanCallName('ケン　タ')).toBe('ケン タ');
    expect(cleanCallName('あ'.repeat(BOND_RULES.nameMax))).toBe('あ'.repeat(BOND_RULES.nameMax));
    for (const bad of ['', '   ', 'あ'.repeat(BOND_RULES.nameMax + 1), 'a@b.jp', 'http://x', 'www.x.com', 'ken.com', '080-1234-5678', '{name}', '<i>', 'a\u0000b', 3]) {
      expect(cleanCallName(bad), String(bad)).toBeNull();
    }
  });

  it('world.ts and her lines agree on every change', () => {
    for (const star of STAR_IDS) {
      expect(LINES[star].callName.familiar.to).toBe(WORLD[star].callNames.familiar);
      expect(LINES[star].callName.lover.to).toBe(WORLD[star].callNames.lover);
    }
  });
});

describe('she is changed by him (#56)', () => {
  const variant = VARIANT_CARDS.find((id) => id.includes('-mahiro-'))!;

  it('her looks: her own two, and her variant card only when he owns it', () => {
    expect(looksOf('mahiro', [])).toEqual(['outfit', 'face']);
    expect(looksOf('mahiro', ['s1-mahiro-01', variant, variant, 's1-nana-30'])).toEqual(['outfit', 'face', variant]);
    expect(isLookOf('mahiro', variant)).toBe(true);
    expect(isLookOf('nana', variant)).toBe(false);
    expect(isLookOf('mahiro', 'bikini')).toBe(false);
  });

  it('a variant card praised three times weighs twice as much', () => {
    expect(BOND_RULES).toMatchObject({ praisedAt: 3, praisedWeight: 2 });
    expect([0, 1, 2, 3, 10].map((n) => lookWeight(variant, n))).toEqual([1, 1, 1, 2, 2]);
    expect([0, 3].map((n) => lookWeight('outfit', n))).toEqual([1, 2]);
    // Her close-up joins only once he praised her face.
    expect([0, 1, 3].map((n) => lookWeight('face', n))).toEqual([0, 1, 2]);
  });

  it('the home pick follows the weights: twice as likely after three praises', () => {
    const share = (praised: number) => {
      const weights = [{ id: 'outfit', weight: lookWeight('outfit', 0) }, { id: variant, weight: lookWeight(variant, praised) }];
      const picks = Array.from({ length: 300 }, (_, i) => pickLook(weights, i / 300));
      return picks.filter((p) => p === variant).length / picks.length;
    };
    expect(share(2)).toBeCloseTo(1 / 2, 2);
    expect(share(3)).toBeCloseTo(2 / 3, 2);
  });

  it('picks nothing from nothing, and never a look that weighs nothing', () => {
    expect(pickLook([], 0.5)).toBeNull();
    expect(pickLook([{ id: 'face', weight: 0 }], 0.5)).toBeNull();
    expect(pickLook([{ id: 'face', weight: 0 }, { id: 'outfit', weight: 1 }], 0)).toBe('outfit');
    expect(pickLook([{ id: 'outfit', weight: 1 }, { id: 'face', weight: 0 }], 0.9999999)).toBe('outfit');
  });
});
