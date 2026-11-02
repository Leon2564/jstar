/**
 * C-room N1, for her room in prototype mode: a scene's script by id and when it can be played (the server's
 * lib/sceneTriggers.ts `inviteFor` does the same). Its own entry, so her room loads only this — not the engine's
 * every export with it (`@jstar/shared/scenes` is the player's).
 */
export { sceneById } from './index';
export { inviteTiming, jstSlot } from './timing';
