/**
 * Registry of each talent's Seedance real-human assets (assets/talents.json).
 *
 * Seedance only generates a real person from assets in the private real-human library: the talent
 * verifies herself once (liveness, on her phone), her photos are checked against that face, and each
 * accepted photo gets an asset ID that video requests reference as `asset://<id>`. Local photos are
 * refused by the API ("may contain real person"), so character shots draw only from this registry.
 */
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Star } from './manifest';

export type AssetKind = 'face' | 'body' | 'other' | 'keyframe';
/** `shot` ties a keyframe asset to the character shot it opens (e.g. mahiro-hero-16x9). */
export interface TalentAsset { id: string; kind: AssetKind; status?: 'Processing' | 'Active' | 'Failed' | string; source?: string; shot?: string }
/** groupType records which library the assets live in (LivenessFace = real-person verified, AIGC = virtual library). */
export interface TalentEntry { groupId: string | null; groupType?: 'LivenessFace' | 'AIGC'; assets: TalentAsset[] }
export type Registry = Record<Star, TalentEntry>;

export const MAX_REFERENCE_IMAGES = 4;
const ASSET_ID = /^asset-[A-Za-z0-9-]+$/;

export const isAssetId = (s: string) => ASSET_ID.test(s);

export async function loadRegistry(file: string): Promise<Registry> {
  const raw = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : {};
  const out = {} as Registry;
  for (const star of ['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as Star[]) out[star] = { groupId: raw[star]?.groupId ?? null, ...(raw[star]?.groupType ? { groupType: raw[star].groupType } : {}), assets: Array.isArray(raw[star]?.assets) ? raw[star].assets : [] };
  return out;
}

export async function saveRegistry(file: string, reg: Registry): Promise<void> {
  const current = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : {};
  await writeFile(`${file}.tmp`, `${JSON.stringify({ _comment: current._comment, ...reg }, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/**
 * Usable references for one talent: faces first (identity), then full body (proportions and hair),
 * at most four. Assets still processing or failed are left out; unknown status (added by hand from
 * the console, where only accepted assets are listed) counts as usable.
 */
export function referenceAssets(entry: TalentEntry): TalentAsset[] {
  const order: Record<AssetKind, number> = { face: 0, body: 1, other: 2, keyframe: 3 };
  return entry.assets
    .filter((a) => a.kind !== 'keyframe' && usable(a))
    .sort((a, b) => order[a.kind] - order[b.kind])
    .slice(0, MAX_REFERENCE_IMAGES);
}

const usable = (a: TalentAsset) => isAssetId(a.id) && (a.status === undefined || a.status === 'Active');

/** The approved still that opens a given shot, if one has been uploaded (media:keyframes → talent keyframes). */
export function keyframeAsset(entry: TalentEntry, shotId: string): TalentAsset | undefined {
  return entry.assets.find((a) => a.kind === 'keyframe' && a.shot === shotId && usable(a));
}

/**
 * Seedance requires prompts to name assets as "Image N" (their order among images in the request),
 * never by asset ID. All references are the same person, so the prompt says so.
 */
export function womanPhrase(n: number): string {
  if (n <= 0) throw new Error('no reference images');
  if (n === 1) return 'The woman in Image 1';
  const list = Array.from({ length: n }, (_, i) => `Image ${i + 1}`);
  return `The woman shown in ${list.slice(0, -1).join(', ')} and ${list[n - 1]} (all the same person, same face and hairstyle)`;
}

export const registryPath = (root: string) => join(root, 'assets/talents.json');
