/**
 * The models the media pipeline uses, from config/models.json (the one place every model in the product is named).
 * Env vars still win for one-off runs (JUDGE_MODEL, JUDGE_DETAIL_MODEL, OPENROUTER_IMAGE_MODEL, --model).
 */
import models from '../../../config/models.json';

export type VideoTier = keyof typeof models.video.tiers;

export const IMAGE = models.image;
export const JUDGE = models.judge;
/** Video tier → the .env.seedance variable holding that tier's (account-private) endpoint id. */
export const VIDEO_ENDPOINT_ENV = Object.fromEntries(
  Object.entries(models.video.tiers).map(([tier, t]) => [tier, t.endpointEnv])
) as Record<VideoTier, string>;
export default models;
