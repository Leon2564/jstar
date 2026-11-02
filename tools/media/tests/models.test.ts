import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, MODELS as CARD_MODELS } from '../src/cards';
import { CONTINUITY_MODEL } from '../src/continuity';
import { DETAIL_MODEL, JUDGE_MODEL } from '../src/judge';
import { MODELS as VIDEO_MODELS, SHOTS } from '../src/manifest';
import models from '../src/models';

/** config/models.json is the one place models are named; these guard its shape and that the tools read it. */
describe('config/models.json', () => {
  const entries = [...Object.values(models.chat), ...Object.values(models.image), ...Object.values(models.judge),
    ...Object.values(models.video.tiers), ...Object.values(models.voice), ...Object.values(models.music)];

  it('every entry names a model, how it is reached and what it is for', () => {
    for (const e of entries) {
      expect(e.model).toMatch(/\S/);
      expect(e.via).toMatch(/^(openrouter|byteplus-ark|byteplus-voice|dashscope-intl|fish-audio|local)$/);
      expect(e.use).toMatch(/\S/);
    }
  });

  it('card art defaults to the configured model', () => {
    expect(DEFAULT_MODEL.id).toBe(models.image.cardArt.model);
    expect(Object.values(CARD_MODELS).some((m) => m.id === DEFAULT_MODEL.id)).toBe(true);
  });

  it('judges use the configured models unless overridden for a run', () => {
    if (!process.env.JUDGE_MODEL) expect([JUDGE_MODEL, CONTINUITY_MODEL]).toEqual([models.judge.likeness.model, models.judge.continuity.model]);
    if (!process.env.JUDGE_DETAIL_MODEL) expect(DETAIL_MODEL).toBe(models.judge.detail.model);
  });

  it('every video shot picks a configured tier with an endpoint variable', () => {
    for (const s of SHOTS) expect(VIDEO_MODELS[s.model], s.id).toMatch(/^SEEDANCE_EP_[A-Z0-9]+$/);
  });
});
