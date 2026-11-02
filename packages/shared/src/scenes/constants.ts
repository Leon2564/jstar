/** Script vocabulary shared by the zod schema, the engine and the web player (no zod here, so the player stays light). */

/** Camera: wide (her in the room), empty (the room without her, used to bridge cuts), enter, close, detail. */
export const SHOTS = ['wide', 'empty', 'enter', 'close', 'detail'] as const;
export const SLOTS = ['morning', 'day', 'evening', 'night'] as const;
export const WEATHERS = ['clear', 'cloudy', 'rain', 'snow'] as const;
export const MINIGAMES = ['rps', 'ogiri', 'praise', 'bargain', 'danmaku'] as const;
export const RPS_HANDS = ['rock', 'scissors', 'paper'] as const;
/**
 * Script variables (#63): facts about the moment, fixed when the run starts, that a line (`line.variants[].when`) or a
 * clip (`clip.variants[].when`) may be written for. `hot`: a heatwave in her city (weather.ts WEATHER_EVENT_RULES.hotC
 * or a heat warning) — アリス turns the dance down because of the heat (#69). `variant`: he owns her variant card
 * (VARIANT_CARDS, #75) — えいみ's reward outfit is that card's own footage (#70, #76).
 */
export const SCENE_VARS = ['hot', 'variant'] as const;

/** The demo scene reachable from the companion home in demo / prototype mode (scenes/mahiro/demo-evening.json). */
export const DEMO_SCENE_ID = 'demo-evening';
