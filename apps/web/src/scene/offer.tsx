/**
 * Her offers (#65): entering her room is where a scene begins. The companion home is her idle scene; as he enters
 * (or sits there quietly for a while, or opens an inbox item that names a scene) the server may offer one — her
 * proposal, or one the moment calls for — as one line of hers and a yes / not now. Never forced: "not now" rests
 * that scene for a while, and ignoring it lets it lapse.
 *
 * Kept apart from the player: the home must not load the engine or the scripts, so the offer carries its title and
 * the clips it plays, and an offer whose clips this build does not have is never shown.
 */
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { SceneInviteT, SceneOfferViewT } from '@jstar/shared/contracts';
import { localText } from '@jstar/shared/domain';
import type { StarId } from '../data/cast';
import type { Key } from '../i18n';
import { useT } from '../lib/store';
import { media, mediaFor, preloadClips } from '../components/stage';
import { loadSceneMedia } from '../data/media';
import { http, serverMode } from '../services/http';

export type Offer = SceneOfferViewT;

/**
 * Every clip exists in this build's catalogue, as an exact id or a family (scene/stage.tsx clipEntry). Scene clips
 * count once the scene catalogue has loaded (data/media.ts `loadSceneMedia`), which roomOffer awaits.
 */
export const playable = (ids: readonly string[]): boolean =>
  ids.every((id) => !!(media(id) ?? mediaFor(id, true) ?? mediaFor(id, false)));

/** An offer's clips in this screen's orientation, and her seated loops (#80) the first shot plays over. */
export function offerClips(ids: readonly string[], star: string) {
  const portrait = typeof window === 'undefined' || window.innerHeight >= window.innerWidth;
  return [...ids.slice(0, 2), `${star}-idle`, `${star}-talk`].map((id) => media(id) ?? mediaFor(id, portrait));
}

/** Her offer for this moment, or null (prototype mode, nothing to offer, the API down, clips missing). */
export async function roomOffer(star: StarId, inboxId?: string): Promise<Offer | null> {
  return serverMode() ? (await roomAnswer(star, inboxId)).offer : null;
}

/**
 * Her offer and (C-room N1) her invitation's scene: `invite` says whether the scene an inbox item names can start
 * now or when it can (「今晚見」); null when nothing can be promised for it or the server did not say. Server mode only.
 */
export async function roomAnswer(star: StarId, inboxId?: string): Promise<{ offer: Offer | null; invite: SceneInviteT | null }> {
  try {
    // The scene clips it names are in the lazy scene catalogue: judged once that is here.
    // The catalogue failing only keeps her offer back (its clips cannot be judged); what her invitation can be stays.
    const [{ offer, invite }, media] = await Promise.all([http.sceneRoom(star, inboxId), loadSceneMedia().then(() => true, () => false)]);
    return { offer: offer && media && offer.star === star && playable(offer.media) ? offer : null, invite: invite ?? null };
  } catch {
    return { offer: null, invite: null };
  }
}

/** "Not now": best effort — if it is lost, the offer simply lapses. */
export function declineOffer(id: string) {
  if (serverMode()) void http.sceneOfferDecline(id).catch(() => undefined);
}

/** The scene player's address; an accepted offer rides along so the start is counted as hers (or the moment's). */
export const sceneLink = (sceneId: string, offerId?: string) => `/me/scene/${sceneId}${offerId ? `?offer=${encodeURIComponent(offerId)}` : ''}`;

const chip = { background: 'rgba(255, 255, 255, 0.85)', color: 'var(--navy)', minHeight: 44, display: 'inline-flex', alignItems: 'center' } as const;

/** Her line and the two answers, in place of her greeting. */
export function OfferBubble({ offer, first, onDecline }: { offer: Offer; first: string; onDecline: () => void }) {
  const t = useT();
  const line = t(`scene.offer.${offer.source}.${offer.star}` as Key, { title: localText(offer.title, t.lang) });
  // N-17: her yes is a tap away — the scene's clips and her loops start loading now.
  useEffect(() => { preloadClips(offerClips(offer.media, offer.star)); }, [offer.media, offer.star]);
  return (
    <div role="group" aria-label={t('scene.offer.label', { first })} data-testid="scene-offer" className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p className="msg her greet">{line}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Link to={sceneLink(offer.sceneId, offer.id)} className="chip" style={chip} data-testid="scene-offer-yes">{t('scene.offer.yes')}</Link>
        <button type="button" className="chip" style={chip} onClick={onDecline} data-testid="scene-offer-no">{t('scene.offer.no')}</button>
      </div>
    </div>
  );
}
