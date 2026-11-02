# Star Genesis · First Five — card catalog contract (v1.0)

One source of truth for the 150 digital cards. The content workstream produces it; the API seeds from it; the web app renders it.
Decisions behind it: 5 tiers N/R/SR/SSR/UR, 5 talents × 30 cards, all AI-generated, clothed companion tone (docs: 正式产品决策).

## Files

| Path | Written by | What |
|---|---|---|
| `packages/shared/src/catalog.s1.json` | content | The catalog array (schema below). Committed. |
| `apps/web/public/cards/<id>/card.webp` | content | 1080×1508 (63:88), quality 82 |
| `apps/web/public/cards/<id>/card-sm.webp` | content | 360×503, quality 78 |
| `apps/web/public/cards/<id>/lock.webp` | content | 360×503 heavily blurred + darkened, for the public gallery (not owned) |
| `apps/web/public/voice/<id>.mp3` | voice | Card voice line, mono 48 kbps, −16 LUFS |
| `apps/web/public/voice/greet/<star>-<slot>.mp3` | voice | Home greetings (slots below) |
| `tools/media/cards/` | content | Prompts, candidates, review sheets (candidates/out are gitignored) |

No frame, rarity badge or text is painted into the art: the app draws frames per tier and all text in 4 languages.

## Schema (`catalog.s1.json` = array of)

```ts
{
  id: string;            // "s1-mahiro-01" … "s1-mahiro-30" (01–10 N, 11–18 R, 19–25 SR, 26–29 SSR, 30 UR)
  star: 'mahiro' | 'nana' | 'unpai' | 'alice' | 'eimi';
  tier: 'N' | 'R' | 'SR' | 'SSR' | 'UR';
  title: { ja: string; 'zh-Hant': string; en: string };   // unique per card, ≤ 14 ja chars
  scene: string;          // one line, English, what the image shows (for alt text and regeneration)
  line: { ja: string; 'zh-Hant': string; en: string };    // voice line she says (ja is recorded; ≤ 12 s spoken)
  story?: { ja: string[]; 'zh-Hant': string[]; en: string[] };  // SSR and UR only: 2 episodes, 300–500 ja chars each
  art: string;            // "/cards/<id>/card.webp"
  voice?: string;         // "/voice/<id>.mp3" when recorded
}
```

Per talent: N 10, R 8, SR 7, SSR 4, UR 1. Tier rates (shared/rules.ts): N 55%, R 28%, SR 12%, SSR 4.5%, UR 0.5%.

## Variant cards (v1.1, #75)

Five of the 150 cards are also "another her": one per talent, no new pool, drawn exactly like the other cards of their
tier (same published rates). Which five is configuration, not catalogue data: `VARIANT_CARDS` in
`packages/shared/src/rules.ts`. **Provisional** until the owner picks them (#84): each talent's UR (`s1-<star>-30`).

`CATALOG` attaches `variant` to those cards (`CardDef.variant`, `packages/shared/src/domain.ts`); its ids follow the
talent, so they stay the same whichever card is picked:

```ts
variant: {
  scene: 'variant-<star>-1',          // her dress-up entrance = layer 1 (script by #76)
  enterClip: '<star>-variant-enter',  // media ids of the web catalogue (clips by #81)
  closeClip: '<star>-variant-close',
  homeVideo: '<star>-variant-home',   // home idle video, opened at level 10
  layers: [{ level: 1, scene: 'variant-<star>-1' }, { level: 3, … }, { level: 6, … }, { level: 10, … }]
}
```

`catalogProblems` checks that every selected card exists and carries its variant, at most one per talent, with the
layer levels of `VARIANT_RULES.layerLevels`. Affinity, 心意 and the thresholds: docs/requirements.md §14.1.

A variant's **Pickup** (#78) is not catalogue data either: the admin schedules it (`/v1/admin/pickups`), and it is her
regular pool with that card at `PICKUP_RULES.share` of SSR-or-better draws for the announced window. The catalogue and
the regular pools' rates are unchanged by it (docs/compliance-jp.md §3.1).

## Content rules

- Clothed companion tone: daily life, dates, home wear, formal wear. No lingerie, swimwear, nudity or school uniforms. Adults only in look and styling.
- Likeness: every card is judged against the talent's references; below the threshold it is regenerated, never shipped.
- Tier feel: N = everyday moments; R = outings; SR = special dates; SSR = intimate close-ups (still clothed); UR = the signature piece of each talent.
- Titles and lines are warm, first-person-to-you, never explicit.

## Home greeting slots (voice)

`morning`, `day`, `evening`, `night`, `welcome` (first visit), `return` (came back after 2+ days), `levelup`, `gacha-ssr`.
