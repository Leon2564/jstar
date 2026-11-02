import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ArkError, buildBody, createClient, isDone } from '../src/ark';
import { download, ranges, totalFromContentRange } from '../src/download';
import { MOTION_KEYFRAMES, MOTION_SHOTS, SHOTS, STARS, TALENTS, anchorsOf, presenceOf, validate, type Shot } from '../src/manifest';
import { checkReference, hashShot, mergeState, orderReferences, planFor, promptFor, referenceImages } from '../src/generate';
import { referenceAssets, womanPhrase, type Registry, type TalentAsset } from '../src/talents';
import { assetUrl, kindFromFile, libraryRefs, parseMotionPicks, parsePicks, summarize } from '../src/talent';
import { createOpenApi, sign } from '../src/openapi';
import { hostPrivately, presignGet, signPut } from '../src/tos';
import { lastError, serveFiles, tunnelUrlFrom } from '../src/tunnel';
import { relayName, relayUrl } from '../src/relay';
import { CUT_STEP, MAX_SEAM, eyeOpenness, findBlinks, findCuts, judgeFramed, judgeMotion, largestFaces, mad } from '../src/motion';
import { renderPack } from '../src/pack';
import { bestCandidate, candidateName, enterPrompt, keyframePrompt, motionPrompt, pickIdentityRefs, specsFor } from '../src/keyframes';
import { continuityScore } from '../src/continuity';
import type { Ref } from '../src/refs';
import { HQ, SCENE_MEDIA_ID, bestLoop, encodeArgs, loopFilter, renderIndexes, retimeFilter, variantName, variantsFor, variantsForShot, viewTimes } from '../src/process';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('ark client', () => {
  it('builds the ModelArk body: text first, images with roles, silent and unwatermarked', () => {
    const body = buildBody({ model: 'ep-1', prompt: '  a balcony  ', ratio: '16:9', duration: 8, resolution: '1080p', images: [{ url: 'data:image/png;base64,AA', role: 'first_frame' }] });
    expect(body).toEqual({
      model: 'ep-1', ratio: '16:9', duration: 8, resolution: '1080p', generate_audio: false, watermark: false,
      content: [{ type: 'text', text: 'a balcony' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' }, role: 'first_frame' }]
    });
  });
  it('rejects an empty prompt before spending credits', () => {
    expect(() => buildBody({ model: 'ep', prompt: ' ', ratio: '1:1', duration: 5, resolution: '720p' })).toThrow(/empty prompt/);
  });
  it('sends the bearer key and surfaces API errors with their status', async () => {
    const f = vi.fn().mockResolvedValueOnce(json({ id: 'cgt-1' })).mockResolvedValueOnce(json({ error: { message: 'quota' } }, 429));
    const c = createClient('key-123', f as unknown as typeof fetch, 'https://x/api/v3');
    expect(await c.create({ model: 'ep', prompt: 'p', ratio: '1:1', duration: 5, resolution: '720p' })).toBe('cgt-1');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://x/api/v3/contents/generations/tasks');
    expect(init.headers.authorization).toBe('Bearer key-123');
    await expect(c.get('cgt-1')).rejects.toBeInstanceOf(ArkError);
  });
  it('refuses to run without a key', () => {
    expect(() => createClient('')).toThrow(/ARK_API_KEY/);
  });
  it('knows which task states are terminal', () => {
    expect(['queued', 'running'].map((s) => isDone(s as never))).toEqual([false, false]);
    expect(['succeeded', 'failed', 'cancelled', 'expired'].every((s) => isDone(s as never))).toBe(true);
  });
});

describe('chunked download', () => {
  it('splits a file into contiguous ranges that cover every byte', () => {
    const r = ranges(1000, 300);
    expect(r).toEqual([[0, 299], [300, 599], [600, 899], [900, 999]]);
    expect(() => ranges(0)).toThrow();
  });
  it('reads the total size from Content-Range', () => {
    expect(totalFromContentRange('bytes 0-0/1785197')).toBe(1785197);
    expect(() => totalFromContentRange(null)).toThrow();
  });
  it('reassembles parallel chunks in order and retries a failed one', async () => {
    const data = Buffer.from(Array.from({ length: 700_000 }, (_, i) => i % 251));
    let failOnce = true;
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      const [a, b] = /bytes=(\d+)-(\d+)/.exec((init.headers as Record<string, string>).range)!.slice(1).map(Number);
      if (a === 262144 && failOnce) { failOnce = false; throw new Error('reset'); }
      return new Response(data.subarray(a, b + 1), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${data.length}` } });
    });
    const dest = join(mkdtempSync(join(tmpdir(), 'dl-')), 'v.mp4');
    expect(await download('https://x/v.mp4', dest, { fetch: f as unknown as typeof fetch, parallel: 4 })).toBe(data.length);
    expect(readFileSync(dest).equals(data)).toBe(true);
  });
  it('fails loudly when the server ignores ranges', async () => {
    const f = vi.fn(async () => new Response('whole file', { status: 200 }));
    await expect(download('https://x', join(tmpdir(), 'never.mp4'), { fetch: f as unknown as typeof fetch })).rejects.toThrow(/range probe/);
  }, 20_000);
});

describe('world bible and shot list', () => {
  it('is valid', () => {
    expect(validate(SHOTS)).toEqual([]);
  });
  it('gives every talent night/morning/day scenes, a costume and a prop', () => {
    for (const star of STARS) {
      const ids = SHOTS.filter((s) => s.star === star).map((s) => s.id);
      expect(ids).toEqual(expect.arrayContaining([`${star}-night-16x9`, `${star}-night-9x16`, `${star}-morning-9x16`, `${star}-day-9x16`, `${star}-costume`, `${star}-prop`]));
    }
    expect(TALENTS.map((t) => t.star)).toEqual([...STARS]);
  });
  it('never generates a real person except from her verified assets', () => {
    const people = SHOTS.filter((s) => s.category === 'character');
    expect(people.length).toBe(299); // 25 companion/turnaround/portrait + 40 presence + 10 herohd (#24) + 4 motion-pilot clips (#79) + 20 variant clips (#81) + 19 scene clips of her, 6 of them in 16:9, 35 everyday clips (#80) + 120 system/confession clips of her (#55, #71) + 20 promise clips (#59, #67)
    const bad: Shot = { ...people[0], talent: undefined };
    expect(validate([bad])).toEqual([expect.stringMatching(/verified assets/)]);
    expect(validate([{ ...SHOTS[0], prompt: `{WOMAN} ${SHOTS[0].prompt}` }])).toEqual([expect.stringMatching(/only character shots/)]);
  });
  it('keeps every prompt inside the 写真级 boundary', () => {
    const explicit = /\b(nude|naked|topless|lingerie|underwear|sex|erotic|nsfw|bikini|see-through)\b/i;
    for (const s of SHOTS) expect(s.prompt, s.id).not.toMatch(explicit);
  });
  it('asks for empty spaces in every non-character shot', () => {
    for (const s of SHOTS.filter((x) => x.category !== 'character')) expect(s.prompt, s.id).toMatch(/no people/i);
  });
  it('uses a locked-off camera for everything that loops, unless anchored to a keyframe it must return to', () => {
    for (const s of SHOTS.filter((x) => x.loop && !x.frames)) expect(s.prompt, s.id).toMatch(/no camera movement/i);
    // Anchored loops either hold the camera still (#79 motion pilot) or return exactly to the anchor's framing (#24 herohd).
    for (const s of SHOTS.filter((x) => x.loop && x.frames)) expect(s.prompt, s.id).toMatch(/no camera movement|exactly on the first frame's framing/i);
  });
  it('never names photo equipment (the model drew a tripod camera into nana-day)', () => {
    for (const s of SHOTS) expect(s.prompt, s.id).not.toMatch(/tripod|camera rig/i);
  });
  it('asks vertical scenes to stay upright (unpai-morning came out rotated 90°)', () => {
    // Scenes that start and end on stills take their orientation from them.
    for (const s of SHOTS.filter((x) => x.category === 'scene' && x.ratio === '9:16' && !x.frames)) expect(s.prompt, s.id).toMatch(/upright and level/);
  });
  it('keeps any crossfade at or under 0.3 s and locks only loops', () => {
    expect(validate([{ ...SHOTS[0], xfade: 1 }])[0]).toMatch(/crossfade/);
    expect(validate([{ ...SHOTS.find((x) => x.id === 'reveal-burst')!, lock: true }])[0]).toMatch(/only loops/);
  });
  it('dresses every talent as a clothed companion, with Tokyo (not New York) behind eimi', () => {
    const bare = /\b(camisole|strap|strapless|off-the-shoulder|bare shoulders?|swimsuit|swimwear|school uniform|sailor)\b/i;
    for (const t of TALENTS) expect(t.wearing, t.star).not.toMatch(bare);
    expect(TALENTS.find((t) => t.star === 'eimi')!.place.night).toMatch(/Tokyo/);
  });
  it('catches duplicate ids and out-of-range durations', () => {
    const s = SHOTS[0];
    expect(validate([s, s])).toContain(`${s.id}: duplicate id`);
    expect(validate([{ ...s, duration: 30 }])[0]).toMatch(/duration/);
  });
});

describe('resumable generation', () => {
  const shot = SHOTS[0];
  const base = { hash: hashShot(shot), updatedAt: '' };
  it('creates new shots and shots whose prompt changed', () => {
    expect(planFor(shot, undefined)).toBe('create');
    expect(planFor({ ...shot, prompt: `${shot.prompt} more` }, { ...base, status: 'downloaded', file: 'raw/x.mp4' })).toBe('create');
  });
  it('polls a task that is still running instead of paying twice', () => {
    expect(planFor(shot, { ...base, status: 'running', taskId: 'cgt-1' })).toBe('poll');
    expect(planFor(shot, { ...base, status: 'succeeded', taskId: 'cgt-1' })).toBe('poll');
  });
  it('retries failed tasks, re-downloads missing files and re-checks local errors', () => {
    expect(planFor(shot, { ...base, status: 'failed', taskId: 'cgt-1' })).toBe('create');
    expect(planFor(shot, { ...base, status: 'error', taskId: 'cgt-1' })).toBe('poll');
    expect(planFor(shot, { ...base, status: 'error' })).toBe('create');
    expect(planFor(shot, { ...base, status: 'downloaded', file: 'raw/does-not-exist.mp4', taskId: 'cgt-1' })).toBe('poll');
  });
});

describe('real-human assets (Seedance private library)', () => {
  const reg = (assets: TalentAsset[], groupId: string | null = 'group-1'): Registry => ({ mahiro: { groupId, assets }, nana: { groupId: null, assets: [] }, unpai: { groupId: null, assets: [] }, alice: { groupId: null, assets: [] }, eimi: { groupId: null, assets: [] } });
  it('uses faces first, only active or console-accepted assets, at most four', () => {
    const r = reg([
      { id: 'asset-b1', kind: 'body', status: 'Active' }, { id: 'asset-f1', kind: 'face' }, { id: 'asset-x', kind: 'face', status: 'Failed' },
      { id: 'asset-p', kind: 'face', status: 'Processing' }, { id: 'asset-f2', kind: 'face', status: 'Active' }, { id: 'asset-b2', kind: 'body', status: 'Active' },
      { id: 'asset-o', kind: 'other', status: 'Active' }, { id: 'not-an-asset', kind: 'face' }
    ]);
    expect(referenceAssets(r.mahiro).map((a) => a.id)).toEqual(['asset-f1', 'asset-f2', 'asset-b1', 'asset-b2']);
  });
  it('names references the way Seedance requires ("Image N"), never by asset ID', () => {
    expect(womanPhrase(1)).toBe('The woman in Image 1');
    expect(womanPhrase(3)).toMatch(/^The woman shown in Image 1, Image 2 and Image 3 \(all the same person/);
    expect(() => womanPhrase(0)).toThrow();
    const hero = SHOTS.find((x) => x.id === 'mahiro-breath-9x16')!;
    const sent = promptFor(hero, 2);
    expect(sent).toContain('The woman shown in Image 1 and Image 2 (all the same person');
    expect(sent).not.toMatch(/\{WOMAN\}|asset-/);
    expect(promptFor(SHOTS.find((x) => x.id === 'mahiro-night-16x9')!, 0)).not.toMatch(/Image 1/);
  });
  it('opens a non-loop-locked shot with the approved keyframe as Image 1 and keeps her face assets as identity', async () => {
    const shot = SHOTS.find((x) => x.id === 'nana-breath-9x16')!;
    const r = reg([]);
    r.nana = { groupId: 'g', groupType: 'AIGC', assets: [
      { id: 'asset-f1', kind: 'face', status: 'Active' }, { id: 'asset-f2', kind: 'face', status: 'Active' },
      { id: 'asset-k1', kind: 'keyframe', status: 'Active', shot: 'nana-breath-9x16' }, { id: 'asset-k2', kind: 'keyframe', status: 'Active', shot: 'nana-hero-16x9' }
    ] };
    expect((await referenceImages(shot, r))!.map((i) => i.url)).toEqual(['asset://asset-k1', 'asset://asset-f1', 'asset://asset-f2']);
    const sent = promptFor(shot, 3, true);
    expect(sent.startsWith('Image 1 is the first frame of the video')).toBe(true);
    expect(sent).toContain('Images 2 and 3 show the same woman');
  });
  it('locks every companion loop to one keyframe as first and last frame, with no other images', async () => {
    const hero = SHOTS.find((x) => x.id === 'nana-hero-9x16')!;
    expect(hero.lock).toBe(true);
    const r = reg([]);
    r.nana = { groupId: 'g', groupType: 'AIGC', assets: [
      { id: 'asset-f1', kind: 'face', status: 'Active' },
      { id: 'asset-k1', kind: 'keyframe', status: 'Active', shot: 'nana-hero-9x16' }
    ] };
    expect(await referenceImages(hero, r)).toEqual([{ url: 'asset://asset-k1', role: 'first_frame' }, { url: 'asset://asset-k1', role: 'last_frame' }]);
    expect(await referenceImages(SHOTS.find((x) => x.id === 'nana-hero-day-9x16')!, r)).toEqual([]);
    const sent = promptFor(hero, 2, true);
    expect(sent.startsWith('The first frame and the last frame are the same photograph')).toBe(true);
    expect(sent).toContain('The woman in the first frame');
    expect(sent).toMatch(/0-8s: she keeps steady eye contact.*\nAround 2s she blinks once, as fast as a real blink \(a quarter of a second\).*\n3-6s: .*\n6-8s: .*first frame/);
    expect(sent).not.toMatch(/glad|smile warms|eyes smile/);
    expect(sent).toMatch(/Locked-off shot/);
    expect(sent).toMatch(/No subtitles.*no music, no audio/);
    expect(sent).not.toMatch(/slowly blinks|blinks once, slowly/);
    // (hero-morning is v1-anchored with frames now: shots/home-v11.ts, #80)
    for (const star of STARS) for (const kind of ['hero-16x9', 'hero-9x16', 'hero-day-9x16']) {
      const s = SHOTS.find((x) => x.id === `${star}-${kind}`)!;
      expect(s.lock, s.id).toBe(true);
      expect(promptFor(s, 2, true).length, s.id).toBeLessThan(1900);
    }
  });
  it('locks a scene whose motion never repeats to its own poster (no people, so a data: URL)', async () => {
    const day = SHOTS.find((x) => x.id === 'unpai-day-9x16')!;
    expect(day.lock).toBe(true);
    const imgs = (await referenceImages(day))!;
    expect(imgs.map((i) => i.role)).toEqual(['first_frame', 'last_frame']);
    expect(imgs[0].url).toMatch(/^data:image\/jpeg;base64,/);
    expect(promptFor(day, 0)).toMatch(/^The first frame and the last frame are the same picture/);
    expect(await referenceImages(SHOTS.find((x) => x.id === 'unpai-morning-9x16')!)).toEqual([]);
  });
  it('anchors the presence one-shots to her approved v1 hero frame (entrance: wide → v1; reactions: v1 → v1)', async () => {
    const kinds = ['enter', 'react-a', 'react-b', 'react-c'];
    for (const star of STARS) for (const r of ['16x9', '9x16']) for (const k of kinds) {
      const s = SHOTS.find((x) => x.id === `${star}-${k}-${r}`)!;
      expect(s, `${star}-${k}-${r}`).toBeDefined();
      expect(s.loop).toBe(false);
      expect(s.resolution).toBe('1080p');
      expect(s.duration).toBe(k === 'enter' ? 5 : 4);
      expect(s.frames).toEqual({ first: k === 'enter' ? s.id : `${star}-hero-${r}-v1`, last: `${star}-hero-${r}-v1` });
      expect(s.prompt, s.id).not.toMatch(/wearing|Bright soft key light/);
      const sent = promptFor(s, 2);
      expect(sent).toContain('The woman in the first and last frames');
      expect(sent).toMatch(/does not speak/);
      expect(sent).not.toMatch(/glad|smile warms|eyes smile|tripod/i);
      expect(sent.length).toBeLessThan(1900);
    }
    const enter = SHOTS.find((x) => x.id === 'nana-enter-9x16')!;
    expect(enter.prompt).toMatch(/dollies in smoothly.*ends exactly on the last frame/);
    const r = reg([]);
    r.nana = { groupId: 'g', groupType: 'AIGC', assets: [
      { id: 'asset-v2', kind: 'keyframe', status: 'Active', shot: 'nana-hero-9x16' },
      { id: 'asset-hero', kind: 'keyframe', status: 'Active', shot: 'nana-hero-9x16-v1' },
      { id: 'asset-wide', kind: 'keyframe', status: 'Active', shot: 'nana-enter-9x16' }
    ] };
    expect(await referenceImages(enter, r)).toEqual([{ url: 'asset://asset-wide', role: 'first_frame' }, { url: 'asset://asset-hero', role: 'last_frame' }]);
    expect(await referenceImages(SHOTS.find((x) => x.id === 'nana-react-b-9x16')!, r)).toEqual([{ url: 'asset://asset-hero', role: 'first_frame' }, { url: 'asset://asset-hero', role: 'last_frame' }]);
    expect(await referenceImages(SHOTS.find((x) => x.id === 'nana-enter-16x9')!, r)).toEqual([]);
    expect(validate([{ ...enter, lock: true, loop: true }])[0]).toMatch(/frames or lock, not both/);
  });
  it('picks keyframe candidates per shot: explicit, else the judge, else the first', () => {
    expect(parsePicks(undefined)).toEqual({ 'hero-16x9': 'a', 'hero-9x16': 'a', 'hero-morning-9x16': 'a', 'hero-day-9x16': 'a', 'enter-16x9': 'a', 'enter-9x16': 'a', 'hero-16x9-v1': 'a', 'hero-9x16-v1': 'a' });
    expect(parsePicks(undefined, { 'hero-day-9x16': 'c' })['hero-day-9x16']).toBe('c');
    expect(parsePicks('hero-16x9=b', { 'hero-16x9': 'c' })['hero-16x9']).toBe('b');
    expect(() => parsePicks('hero-16x9=Z')).toThrow(/bad pick/);
    expect(() => parsePicks('portrait-9x16=a')).toThrow(/bad pick/);
  });
  it('asks Seedance for a draft only when told to', () => {
    expect(buildBody({ model: 'ep', prompt: 'p', ratio: '9:16', duration: 8, resolution: '1080p', draft: true }).draft).toBe(true);
    expect(buildBody({ model: 'ep', prompt: 'p', ratio: '9:16', duration: 8, resolution: '1080p' })).not.toHaveProperty('draft');
  });
  it('references a talent only through asset:// URIs from her registry', async () => {
    const hero = SHOTS.find((x) => x.id === 'eimi-breath-9x16')!;
    const r = reg([]);
    r.eimi = { groupId: 'g', assets: [{ id: 'asset-e1', kind: 'face', status: 'Active' }, { id: 'asset-e2', kind: 'body', status: 'Active' }] };
    expect(await referenceImages(hero, r)).toEqual([{ url: 'asset://asset-e1', role: 'reference_image' }, { url: 'asset://asset-e2', role: 'reference_image' }]);
    expect(await referenceImages({ ...hero, talent: 'mahiro' }, reg([]))).toEqual([]);
    expect(await referenceImages(SHOTS.find((x) => x.id === 'eimi-prop')!, r)).toEqual([]);
  });
  it('every talent has hero, morning, day, turnaround and portrait shots, all tied to her own assets and fully clothed', () => {
    for (const star of STARS) {
      for (const id of [`${star}-hero-16x9`, `${star}-hero-9x16`, `${star}-hero-morning-9x16`, `${star}-hero-day-9x16`, `${star}-breath-9x16`, `${star}-turnaround`]) {
        const shot = SHOTS.find((x) => x.id === id)!;
        expect(shot.talent, id).toBe(star);
        expect(shot.prompt, id).toContain('{WOMAN}');
        expect(shot.prompt, id).toMatch(/fully clothed/);
        expect(shot.prompt, id).not.toMatch(new RegExp(star, 'i'));
      }
    }
  });
  it('rejects photos the asset library would refuse', () => {
    expect(checkReference(200, 400, 1000).ok).toBe(false);
    expect(checkReference(3000, 900, 1000).reason).toMatch(/aspect/);
    expect(checkReference(1200, 1600, 2_000_000)).toEqual({ ok: true, resize: false });
  });
  it('uploads face views before the rest', () => {
    expect(orderReferences(['04-body-back.jpg', 'notes.txt', 'Portrait.JPG', '01-face-front.jpg'])).toEqual(['Portrait.JPG', '01-face-front.jpg', '04-body-back.jpg']);
    expect(['01-face-front.jpg', '02-face-side.jpg', '03-body-front.jpg', 'portrait.jpg', 'x.png'].map(kindFromFile)).toEqual(['face', 'face', 'body', 'face', 'other']);
  });
  it('builds public asset URLs only over https', () => {
    expect(assetUrl('https://cdn.example.com/refs/mahiro/', '01-face front.jpg')).toBe('https://cdn.example.com/refs/mahiro/01-face%20front.jpg');
    expect(() => assetUrl('http://localhost:8080', 'a.jpg')).toThrow(/https/);
  });
  it('reports which talents are ready', () => {
    const lines = summarize(reg([{ id: 'asset-f1', kind: 'face' }]));
    expect(lines[0]).toMatch(/^mahiro .*ready: 1 reference\(s\) → 60 shots can run/); // with her variant clips (#81), her 4 scene clips, cup 16:9 and 7 everyday clips (#80: hero-morning ×2, idle ×2, talk ×2, talkclose), and her 24 system/confession clips (#55, #71), and her 4 promise clips (#59, #67)
    expect(lines[1]).toMatch(/^nana .*not verified/);
  });
});

describe('BytePlus OpenAPI signing (asset library)', () => {
  const at = new Date('2026-09-24T12:00:00Z');
  it('signs with the documented scope and headers, deterministically', () => {
    const h = sign({ ak: 'AKTEST', sk: 'SKTEST', action: 'ListAssets', body: '{}', date: at });
    expect(h['x-date']).toBe('20260924T120000Z');
    expect(h['x-content-sha256']).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
    expect(h.authorization).toMatch(/^HMAC-SHA256 Credential=AKTEST\/20260924\/ap-southeast-1\/ark\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/);
    expect(sign({ ak: 'AKTEST', sk: 'SKTEST', action: 'ListAssets', body: '{}', date: at }).authorization).toBe(h.authorization);
  });
  it('changes the signature with the action, the body or the secret', () => {
    const base = sign({ ak: 'A', sk: 'S', action: 'GetAsset', body: '{"Id":"asset-1"}', date: at }).authorization;
    expect(sign({ ak: 'A', sk: 'S', action: 'DeleteAsset', body: '{"Id":"asset-1"}', date: at }).authorization).not.toBe(base);
    expect(sign({ ak: 'A', sk: 'S', action: 'GetAsset', body: '{"Id":"asset-2"}', date: at }).authorization).not.toBe(base);
    expect(sign({ ak: 'A', sk: 'T', action: 'GetAsset', body: '{"Id":"asset-1"}', date: at }).authorization).not.toBe(base);
  });
  it('retries a dropped connection but not an API error', async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(new Response(JSON.stringify({ Result: { Items: [] } }), { status: 200 }));
    const call = createOpenApi('A', 'S', f as unknown as typeof fetch);
    expect(await call('ListAssets')).toEqual({ Items: [] });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('surfaces permission errors with their code', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ResponseMetadata: { Error: { Code: 'AccessDenied', Message: 'not authorized' } } }), { status: 403 }));
    const call = createOpenApi('A', 'S', f as unknown as typeof fetch);
    await expect(call('ListAssets')).rejects.toThrow(/AccessDenied/);
    const [url] = f.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://ark.ap-southeast-1.byteplusapi.com/?Action=ListAssets&Version=2024-01-01');
  });
});

describe('private photo hosting (TOS, S3-compatible SigV4)', () => {
  it('matches the published AWS Signature V4 presigned-URL example', () => {
    // docs.aws.amazon.com: "Example: presigned URL" — examplebucket/test.txt, 2013-05-24, 86400 s.
    const url = presignGet({ ak: 'AKIAIOSFODNN7EXAMPLE', sk: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', bucket: 'examplebucket', endpoint: 's3.amazonaws.com', region: 'us-east-1' }, 'test.txt', 86400, new Date('2013-05-24T00:00:00Z'));
    expect(url).toBe('https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });
  it('signs private uploads with a payload hash and no public ACL', () => {
    const { url, headers } = signPut({ ak: 'A', sk: 'S', bucket: 'jstar-refs' }, 'talent-refs/mahiro/01-face-front.jpg', Buffer.from('x'), 'image/jpeg', new Date('2026-09-24T00:00:00Z'));
    expect(url).toBe('https://jstar-refs.tos-s3-ap-southeast-1.bytepluses.com/talent-refs/mahiro/01-face-front.jpg');
    expect(headers['x-amz-content-sha256']).toBe('2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=A\/20260924\/ap-southeast-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(Object.keys(headers)).not.toContain('x-amz-acl');
  });
  it('uploads, then hands over a one-hour link', async () => {
    const f = vi.fn(async () => new Response('', { status: 200 }));
    const link = await hostPrivately({ ak: 'A', sk: 'S', bucket: 'b' }, 'k.jpg', Buffer.from('x'), 'image/jpeg', f as unknown as typeof fetch);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('PUT');
    expect(link).toMatch(/X-Amz-Expires=3600/);
    const fail = vi.fn(async () => new Response('AccessDenied', { status: 403 }));
    await expect(hostPrivately({ ak: 'A', sk: 'S', bucket: 'b' }, 'k.jpg', Buffer.from('x'), 'image/jpeg', fail as unknown as typeof fetch)).rejects.toThrow(/403/);
  });
});

describe('keyframes (gpt-image-2 stills before any video)', () => {
  const ref = (file: string, view: Ref['view'], t: number, quality: number, mouthWidth = 1): Ref => ({ file, face: file, view, t, source: 'DSC.MOV', yaw: 0, quality, facePx: 380, geometry: { eyeWidth: 0.4, eyeOpen: 0.3, faceLength: 0.9, noseWidth: 0.5, mouthWidth, eyeMouth: 1.1, chin: 0.65 } });
  const refs = [ref('head/front-01.jpg', 'front', 10, 0.8), ref('head/front-02.jpg', 'front', 11, 0.79, 1.3), ref('head/front-03.jpg', 'front', 30, 0.7, 1.2), ref('head/left34-01.jpg', 'left34', 20, 0.6), ref('head/right34-01.jpg', 'right34', 40, 0.5), ref('head/profile-01.jpg', 'profile', 50, 0.4)];
  it('uses her best frontal, a smiling frontal from another moment and her best three-quarter view', () => {
    expect(pickIdentityRefs(refs).map((r) => r.file)).toEqual(['head/front-01.jpg', 'head/front-03.jpg', 'head/left34-01.jpg']);
  });
  it('registers the other three-quarter side and a profile in the asset library too', () => {
    expect(libraryRefs(refs).map((r) => r.file)).toEqual(['head/front-01.jpg', 'head/front-03.jpg', 'head/left34-01.jpg', 'head/right34-01.jpg', 'head/profile-01.jpg']);
  });
  it('puts the location last: the scene poster of the same time of day and ratio', async () => {
    const specs = await specsFor(['mahiro'], ['hero-16x9', 'hero-9x16', 'hero-morning-9x16', 'hero-day-9x16']);
    expect(specs.map((s) => s.id)).toEqual(['mahiro-hero-16x9', 'mahiro-hero-9x16', 'mahiro-hero-morning-9x16', 'mahiro-hero-day-9x16']);
    expect(specs.map((s) => s.references.at(-1)!.split('/').slice(-2).join('/'))).toEqual(['mahiro-night-16x9/poster.jpg', 'mahiro-night-9x16/poster.jpg', 'mahiro-morning-9x16/poster.jpg', 'mahiro-day-9x16/poster.jpg']);
    expect(specs.map((s) => s.aspect)).toEqual(['16:9', '9:16', '9:16', '9:16']);
  });
  it('locks her features, lights her face brightly, keeps her fully clothed and stays inside the 写真级 boundary', () => {
    const explicit = /\b(nude|naked|topless|lingerie|underwear|sex|sexy|seductive|erotic|nsfw|bikini|see-through|camisole|gravure)\b/i;
    for (const t of TALENTS) for (const kind of ['hero-16x9', 'hero-9x16', 'hero-morning-9x16', 'hero-day-9x16'] as const) {
      const p = keyframePrompt(t, kind, 3);
      expect(p, t.star).toMatch(/exact likeness of reference image 1/);
      expect(p, t.star).toMatch(/Do not idealize, beautify/);
      expect(p, t.star).toMatch(/fully clothed/);
      expect(p, t.star).toMatch(/looks straight into the lens/);
      expect(p, t.star).toMatch(/closed-mouth smile/);
      expect(p, t.star).toMatch(/bright, soft key light/);
      expect(p, t.star).toContain(t.hair);
      expect(p, t.star).toContain(t.accessories);
      expect(p, t.star).not.toMatch(/no retouching|visible pores/);
      expect(p, t.star).not.toMatch(explicit);
    }
    expect(keyframePrompt(TALENTS[0], 'hero-16x9', 3)).toMatch(/right third.*12% of the frame height below the top edge/s);
  });
  it('builds the entrance keyframe wide from her v1 hero frame only, with no text outfit or light', () => {
    const p = keyframePrompt(TALENTS[1], 'enter-9x16', 1);
    expect(p).toMatch(/Vertical 9:16 wide establishing shot/);
    expect(p).toMatch(/Reference image 2 is the close shot of this exact moment and reference image 1 is a close-up of her face in it/);
    expect(p).toMatch(/push-in from this frame would end exactly on reference image 2/);
    expect(p).toMatch(/out-of-focus foreground/);
    expect(p).toMatch(/exact likeness of reference image 1/);
    expect(p).not.toContain(TALENTS[1].wearing);
    expect(p).not.toContain(TALENTS[1].hair);
    expect(enterPrompt('enter-16x9', ['nose wider'])).toContain('fix these): nose wider.');
  });
  it('names the scene reference right after the identity references and carries the judge\'s corrections', () => {
    const t = TALENTS[0];
    expect(keyframePrompt(t, 'hero-9x16', 3)).toMatch(/Location: reference image 4/);
    expect(keyframePrompt(t, 'hero-day-9x16', 2)).toMatch(/Location: reference image 3 — a quiet café/);
    expect(keyframePrompt(t, 'hero-9x16', 3, ['eyes smaller than references'])).toContain('Corrections from the previous attempt (fix these): eyes smaller than references.');
  });
  it('names candidates a, b, c… and picks the best-scored one', () => {
    expect([0, 1, 2].map((i) => candidateName('eimi-hero-16x9', i))).toEqual(['eimi-hero-16x9-a.png', 'eimi-hero-16x9-b.png', 'eimi-hero-16x9-c.png']);
    const v = (score: number, hair?: number) => ({ score, top: score >= 4, hair, issues: [], lineup: {} });
    expect(bestCandidate([{ file: 'a', round: 1, verdict: v(3, 5) }, { file: 'b', round: 1, verdict: v(4.5, 3) }, { file: 'c', round: 2, verdict: v(4.5, 5) }, { file: 'd', round: 2 }])?.file).toBe('c');
    expect(bestCandidate([{ file: 'a', round: 1, verdict: { ...v(5), error: 'no face' } }])).toBeUndefined();
  });
});

describe('temporary links for talent photos', () => {
  it('serves only the listed files, only under the random token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'serve-'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, '01-face-front.jpg'), 'face');
    writeFileSync(join(dir, 'secret.jpg'), 'nope');
    const { server, port, token } = await serveFiles([join(dir, '01-face-front.jpg')]);
    try {
      const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`);
      const ok = await get(`/${token}/01-face-front.jpg`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('image/jpeg');
      expect(await ok.text()).toBe('face');
      expect((await get(`/${token}/secret.jpg`)).status).toBe(404);
      expect((await get(`/deadbeef/01-face-front.jpg`)).status).toBe(404);
      expect((await get(`/${token}/../secret.jpg`)).status).toBe(404);
      expect((await get('/')).status).toBe(404);
      expect(token).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      server.close();
    }
  });
  it('reads the quick-tunnel hostname from cloudflared output', () => {
    expect(tunnelUrlFrom('INF |  https://calm-river-abc-12.trycloudflare.com                 |')).toBe('https://calm-river-abc-12.trycloudflare.com');
    expect(tunnelUrlFrom('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
  });
  it('names relay objects randomly and builds token URLs only over https', () => {
    const a = relayName('/x/front-01.JPEG'), b = relayName('/x/front-01.jpg');
    expect(a).toMatch(/^[0-9a-f]{24}\.jpg$/);
    expect(a).not.toBe(b);
    expect(relayName('k.png')).toMatch(/\.png$/);
    const t = 'ab'.repeat(32);
    expect(relayUrl('https://r.example.workers.dev/', t, 'n.jpg')).toBe(`https://r.example.workers.dev/${t}/n.jpg`);
    expect(() => relayUrl('http://r.example', t, 'n.jpg')).toThrow(/https/);
    expect(() => relayUrl('https://r.example', 'short', 'n.jpg')).toThrow(/64 hex/);
  });
  it('explains why cloudflared failed (e.g. a proxy that cannot resolve SRV records)', () => {
    const log = '2026-09-24T21:29:25Z ERR edge discovery: error looking up Cloudflare edge IPs event=0\n2026-09-24T21:29:25Z ERR Please try the following things event=0\n2026-09-24T21:34:32Z ERR Serve tunnel error error="TLS handshake with edge error: EOF" connIndex=0 event=0 ip=198.41.200.13\n';
    expect(lastError(log)).toBe(': Serve tunnel error error="TLS handshake with edge error: EOF"');
    expect(lastError('INF all good')).toBe('');
  });
});

describe('state merging', () => {
  it('keeps records written by another run', () => {
    const a = { hash: 'h', status: 'downloaded', updatedAt: '' };
    const b = { hash: 'h', status: 'running', updatedAt: '' };
    expect(mergeState({ x: a }, { y: b, x: { ...a, status: 'stale' } }, ['y'])).toEqual({ x: a, y: b });
  });
});

describe('post-processing', () => {
  it('sizes from the source without upscaling, AV1 first, always even', () => {
    expect(variantsFor({ width: 1920, height: 1080 })).toEqual([
      { width: 1920, height: 1080, codec: 'av1' }, { width: 1920, height: 1080, codec: 'h264' }, { width: 1280, height: 720, codec: 'h264' }
    ]);
    for (const v of variantsFor({ width: 960, height: 960 })) { expect(v.width % 2).toBe(0); expect(v.height % 2).toBe(0); expect(v.width).toBeLessThanOrEqual(960); }
    const tall = variantsFor({ width: 720, height: 1280 });
    expect(tall[2]).toEqual({ width: 480, height: 854, codec: 'h264' });
  });
  it('builds a loop whose short crossfade (≤ 0.3 s) ends on the frame it starts with', () => {
    const f = loopFilter(8);
    expect(f).toContain('trim=start=0.3');
    expect(f).toContain('duration=0.3');
    expect(f).toContain('offset=7.400');
    expect(f).not.toContain('trim=start=0.000');
    const cut = loopFilter(8, 0.25, { start: 0.5, end: 7.5 });
    expect(cut.startsWith('[0:v]trim=start=0.500:end=7.500,setpts=PTS-STARTPTS,split')).toBe(true);
    expect(cut).toContain('offset=6.500');
    expect(loopFilter(8, 0)).toBe('[0:v]format=yuv420p[v]');
    expect(() => loopFilter(0.9)).toThrow(/too short/);
  });
  it('finds the cut points whose frames match best, keeping the full clip when its ends already match', () => {
    const frame = (v: number) => new Uint8Array(16).fill(v);
    // 48 frames at 24 fps: values drift 0→47, except frame 2 and frame 44 are identical (value 100).
    const drift = Array.from({ length: 48 }, (_, i) => frame(i === 2 || i === 44 ? 100 : i * 2));
    expect(bestLoop(drift, 24, 0.5)).toEqual({ start: 2 / 24, end: 44 / 24, diff: 0 });
    const locked = Array.from({ length: 48 }, (_, i) => frame(i === 0 || i === 47 ? 10 : 10 + Math.sin(i) * 20));
    expect(bestLoop(locked, 24, 0.5)).toMatchObject({ start: 0, end: 47 / 24 });
  });
  it('encodes faces at a higher AV1 quality (CRF 32) than scenes (38)', () => {
    expect(encodeArgs('i', 'o', { width: 1920, height: 1080, codec: 'av1', crf: 32 }).join(' ')).toContain('-crf 32');
    expect(encodeArgs('i', 'o', { width: 1920, height: 1080, codec: 'av1' }).join(' ')).toContain('-crf 38');
  });
  it('encodes silent, streamable files', () => {
    const args = encodeArgs('in.mp4', 'out.mp4', { width: 1280, height: 720, codec: 'h264' }, loopFilter(8));
    expect(args).toEqual(expect.arrayContaining(['-an', '+faststart', 'libx264']));
    expect(args.join(' ')).toContain('[l]scale=1280:720');
  });
  it('spaces multi-view stills evenly around the orbit', () => {
    expect(viewTimes(8, 4)).toEqual([0.05, 2.05, 4.05, 6.05]);
  });
  it('writes an index the web app can import', () => {
    const { core: src } = renderIndexes([{ id: 'b', category: 'prop', ratio: '1:1', use: 'x', poster: '/p.jpg', sources: [] }, { id: 'a', category: 'scene', ratio: '16:9', use: 'y', poster: '/q.jpg', sources: [] }]);
    expect(src).toContain('export const MEDIA');
    expect(src.indexOf('"a"')).toBeLessThan(src.indexOf('"b"'));
    expect(src).not.toContain('"use"');
  });
  it('splits the index: scene, variant and morning clips go to the lazy catalogue, the first screens\' stay in the entry', () => {
    const at = (id: string) => ({ id, category: 'character' as const, ratio: '9:16', use: 'u', poster: `/${id}.jpg`, sources: [] });
    const lazy = ['mahiro-scene-welcome-home-cup-9x16', 'nana-talk-16x9', 'nana-talkclose-9x16', 'alice-idle-9x16', 'eimi-sys-goodnight-16x9',
      'unpai-confession-yes-9x16', 'eimi-variant-enter-9x16', 'eimi-variant-close-9x16', 'mahiro-variant-home-9x16', 'mahiro-morning-9x16',
      'mahiro-hero-morning-16x9'];
    const core = ['mahiro-hero-9x16', 'mahiro-herohd-16x9', 'mahiro-breath-9x16', 'mahiro-night-16x9', 'mahiro-day-9x16', 'mahiro-enter-9x16', 'mahiro-react-a-16x9', 'mahiro-costume', 'mahiro-prop', 'loading-stars'];
    for (const id of lazy) expect(SCENE_MEDIA_ID.test(id), id).toBe(true);
    for (const id of core) expect(SCENE_MEDIA_ID.test(id), id).toBe(false);
    const both = renderIndexes([...lazy, ...core].reverse().map(at));
    for (const id of core) { expect(both.core).toContain(`"${id}"`); expect(both.sceneData).not.toContain(`"${id}"`); }
    for (const id of lazy) { expect(both.sceneData).toContain(`"${id}"`); expect(both.core).not.toContain(`"${id}"`); }
    // N-61: the scene catalogue's data is plain JSON (a fetched asset); its .ts reads it for tests and tools.
    expect(Object.keys(JSON.parse(both.sceneData)).sort()).toEqual([...lazy].sort());
    expect(both.scene).toContain('export const SCENE_MEDIA');
    expect(both.scene).toContain("import data from './media.scene.gen.json'");
    expect(both.scene).toContain("import type { MediaEntry } from './media.gen'");
    // Deterministic: the same entries in any order give the same files.
    expect(renderIndexes([...lazy, ...core].map(at))).toEqual(both);
  });

  const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version']); return true; } catch { return false; } })();
  it.skipIf(!hasFfmpeg)('really loops: a 4 s clip becomes a 3.7 s loop that plays in browsers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-'));
    const src = join(dir, 'src.mp4');
    const out = join(dir, 'out.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=4', '-pix_fmt', 'yuv420p', src]);
    execFileSync('ffmpeg', encodeArgs(src, out, { width: 320, height: 180, codec: 'h264' }, loopFilter(4)));
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', out]).toString();
    const info = JSON.parse(probe);
    expect(info.streams).toHaveLength(1); // no audio track
    expect(info.streams[0]).toMatchObject({ codec_name: 'h264', width: 320, height: 180 });
    expect(Number(info.format.duration)).toBeCloseTo(3.7, 1);
  }, 60_000);
});

describe('motion QA (blinks and loop seam)', () => {
  const open = (closed: [number, number][], n = 192) => Array.from({ length: n }, (_, i) => (closed.some(([a, b]) => i >= a && i <= b) ? 0.05 : 0.3));
  it('measures blinks as runs of closed frames', () => {
    expect(findBlinks(open([[48, 53]]))).toEqual([{ at: 2, duration: 0.25 }]);
    expect(findBlinks(open([[36, 57], [120, 124]]))).toEqual([{ at: 1.5, duration: 0.92 }, { at: 5, duration: 0.21 }]);
    expect(findBlinks([NaN, 0.3, NaN, 0.3])).toEqual([]);
  });
  it('passes a quick blink with a matching seam and fails the v1-style sleepy blink', () => {
    expect(judgeMotion('a', open([[48, 53]])).ok).toBe(true);
    expect(judgeMotion('b', open([[36, 57]]))).toMatchObject({ ok: false, longest: 0.92 });
    expect(judgeMotion('c', [...open([[48, 53]]).slice(0, -1), 0.2]).ok).toBe(false);
  });
  it('speeds up only slow blinks, to a quarter second, leaving the loop ends untouched', () => {
    expect(retimeFilter([{ at: 2, duration: 0.25 }], 8)).toBeNull();
    const plan = retimeFilter([{ at: 1.71, duration: 0.5 }, { at: 5, duration: 0.2 }], 8)!;
    expect(plan.windows).toEqual([{ start: 1.71 - 1 / 24, end: 2.21 + 1 / 24, factor: 2 }]);
    expect(plan.filter).toMatch(/^\[0:v\]split=3\[i0\]\[i1\]\[i2\];\[i0\]trim=start=0\.000:end=1\.668,setpts=PTS-STARTPTS\[s0\];\[i1\]trim=start=1\.668:end=2\.252,setpts=\(PTS-STARTPTS\)\/2\.000\[s1\];\[i2\]trim=start=2\.252,setpts=PTS-STARTPTS\[s2\];/);
    expect(plan.filter.endsWith('concat=n=3:v=1:a=0,fps=24,format=yuv420p[v]')).toBe(true);
    expect(retimeFilter([{ at: 0, duration: 2 }], 8)).toBeNull();
    expect(retimeFilter([{ at: 3, duration: 0.95 }], 8)!.windows[0].factor).toBe(3);
    expect(retimeFilter([{ at: 3, duration: 1.8 }], 8)).toBeNull();
    // Shot.retimeMax: a 0.75 s glance down at her hands stays as it is; a 0.4 s blink in the same clip is still sped up.
    expect(retimeFilter([{ at: 3, duration: 0.75 }], 8, 24, 0.45)).toBeNull();
    expect(retimeFilter([{ at: 3, duration: 0.75 }, { at: 5, duration: 0.4 }], 8, 24, 0.45)!.windows).toHaveLength(1);
  });
  it('measures how far a frame is from its anchor keyframe', () => {
    expect(mad(new Uint8Array([10, 20, 30]), new Uint8Array([10, 20, 30]))).toBe(0);
    expect(mad(new Uint8Array([0, 0, 0, 0]), new Uint8Array([4, 8, 0, 0]))).toBe(3);
  });
  it('scores continuity like the line-up judge: capped when another talent rates as high or higher', () => {
    expect(continuityScore({ mahiro: 5, nana: 1, unpai: 2, alice: 1, eimi: 1 }, 'mahiro')).toEqual({ score: 5, raw: 5, top: true });
    expect(continuityScore({ mahiro: 4, nana: 4, unpai: 1, alice: 1, eimi: 1 }, 'mahiro')).toEqual({ score: 3.5, raw: 4, top: false });
    expect(continuityScore({ mahiro: 4, nana: 5, unpai: 1, alice: 1, eimi: 1 }, 'mahiro')).toEqual({ score: 2.5, raw: 4, top: false });
  });
  it('HD hero loops: locked at both ends to her approved v1 frame, no crossfade, hq encode, new ids', () => {
    for (const star of STARS) for (const r of ['16x9', '9x16']) {
      const s = SHOTS.find((x) => x.id === `${star}-herohd-${r}`)!;
      expect(s, `${star}-herohd-${r}`).toBeDefined();
      expect(s).toMatchObject({ loop: true, xfade: 0, encode: 'hq', resolution: '1080p', duration: 8, frames: { first: `${star}-hero-${r}-v1`, last: `${star}-hero-${r}-v1` } });
      const sent = promptFor(s, 2);
      expect(sent).toMatch(/start exactly from it and end exactly on it/);
      expect(sent).toMatch(/camera drifts very slowly.*exactly on the first frame's framing/);
      expect(sent).toMatch(/Living light/);
      expect(sent).not.toMatch(/glad|smile warms|eyes smile|wearing|tripod/i);
      expect(sent.length).toBeLessThan(1900);
    }
    expect(validate(SHOTS)).toEqual([]);
    expect(SHOTS.filter((s) => s.encode === 'hq').length).toBe(287); // 10 herohd + 40 presence (#24) + 20 variant clips (#81) + 25 scene clips, 7 in 16:9, 35 everyday clips (#80) + 130 system/confession clips, 45 in 16:9 (#55, #71) + 20 promise clips, 5 in 16:9 (#59, #67)
  });
  it('hq encodes go to new -hq files beside the old ones, at much lower CRFs', () => {
    const v = variantsForShot({ category: 'character', encode: 'hq' }, { width: 1080, height: 1920 });
    expect(v.map(variantName)).toEqual(['av1-1080x1920-hq.mp4', 'h264-1080x1920-hq.mp4', 'h264-720x1280-hq.mp4']);
    expect(v.map((x) => x.crf)).toEqual([HQ.av1, HQ.h264, HQ.h264Small]);
    expect(encodeArgs('i', 'o', v[0]).join(' ')).toMatch(/-crf 20 -svtav1-params tune=0/);
    expect(encodeArgs('i', 'o', v[1]).join(' ')).toContain('-crf 17');
    const old = variantsForShot({ category: 'character' }, { width: 1080, height: 1920 });
    expect(old.map(variantName)).toEqual(['av1-1080x1920.mp4', 'h264-1080x1920.mp4', 'h264-720x1280.mp4']);
    expect(old[0].crf).toBe(32);
    expect(encodeArgs('i', 'o', old[1]).join(' ')).toContain('-crf 24');
  });
});

describe('chained first/last frames (motion pilot, #79)', () => {
  const shot = (id: string) => SHOTS.find((x) => x.id === id)!;
  const reg = (assets: TalentAsset[]): Registry => ({ mahiro: { groupId: 'g', assets }, nana: { groupId: null, assets: [] }, unpai: { groupId: null, assets: [] }, alice: { groupId: null, assets: [] }, eimi: { groupId: 'g', assets } });
  it("chains each of eimi's clips onto the frame the previous one ended on", () => {
    expect(anchorsOf(shot('eimi-leave-9x16'))).toEqual({ first: { keyframe: 'eimi-seated-9x16' }, last: undefined });
    // She leaves, so the next clips start on the empty frame the leave clip actually rendered.
    expect(anchorsOf(shot('eimi-empty-9x16'))).toEqual({ first: { rendered: 'eimi-leave-9x16' }, last: { rendered: 'eimi-leave-9x16' } });
    expect(anchorsOf(shot('eimi-return-9x16'))).toEqual({ first: { rendered: 'eimi-leave-9x16' }, last: { keyframe: 'eimi-gown-9x16' } });
    expect(anchorsOf(shot('eimi-twirl-9x16'))).toEqual({ first: { keyframe: 'eimi-gown-9x16' }, last: { keyframe: 'eimi-gown-9x16' } });
    expect(MOTION_SHOTS.map(presenceOf)).toEqual(['exits', 'empty', 'enters', 'on', 'on']);
  });
  it('refuses broken chains, loops that do not close and a keyframe of her in a scene', () => {
    const leave = shot('eimi-leave-9x16'), empty = shot('eimi-empty-9x16');
    expect(validate([{ ...empty, frames: { first: { after: 'nope' } } }])[0]).toMatch(/chained after nope/);
    expect(validate([leave, { ...empty, frames: { first: { after: 'eimi-leave-9x16' }, last: { still: 'eimi-room-9x16' } } }])).toEqual([expect.stringMatching(/loop must start and end on the same still/)]);
    expect(validate([{ ...empty, frames: { first: 'eimi-gown-9x16', last: 'eimi-gown-9x16' } }])[0]).toMatch(/only character shots/);
    expect(validate([{ ...leave, frames: { first: 'eimi-seated-9x16', last: 'eimi-gown-9x16', end: 'empty' } }])[0]).toMatch(/end 'empty'/);
    const a: Shot = { ...leave, id: 'a', frames: { first: { after: 'b' } } }, b: Shot = { ...leave, id: 'b', frames: { first: 'x', last: { after: 'a' } } };
    expect(() => anchorsOf(a, [a, b])).toThrow(/has no last frame|loops back/);
  });
  it('keeps the fingerprint of every shot without frames (no accidental re-render of the existing shots)', () => {
    const hero = shot('eimi-hero-9x16');
    expect(hashShot(hero)).toBe(createHash('sha256').update(JSON.stringify([hero.model, hero.ratio, hero.resolution, hero.duration, hero.prompt, hero.talent])).digest('hex').slice(0, 16));
    const twirl = shot('eimi-twirl-9x16');
    expect(hashShot(twirl)).not.toBe(hashShot({ ...twirl, frames: { first: 'eimi-seated-9x16', last: 'eimi-seated-9x16' } }));
  });
  it('sends her stills as asset:// frames and skips a clip whose still is not registered yet', async () => {
    const r = reg([{ id: 'asset-g1', kind: 'keyframe', status: 'Active', shot: 'eimi-gown-9x16' }, { id: 'asset-m1', kind: 'keyframe', status: 'Active', shot: 'mahiro-rps-9x16' }]);
    expect(await referenceImages(shot('eimi-twirl-9x16'), r)).toEqual([{ url: 'asset://asset-g1', role: 'first_frame' }, { url: 'asset://asset-g1', role: 'last_frame' }]);
    expect(await referenceImages(shot('mahiro-rps-9x16'), r)).toEqual([{ url: 'asset://asset-m1', role: 'first_frame' }]);
    expect(await referenceImages(shot('eimi-leave-9x16'), reg([]))).toEqual([]);
  });
  it('names the woman by the frame she is in', () => {
    expect(promptFor(shot('eimi-leave-9x16'), 1)).toContain('The woman in the first frame, wearing');
    expect(promptFor(shot('eimi-return-9x16'), 2)).toContain('The woman in the last frame, wearing');
    expect(promptFor(shot('eimi-empty-9x16'), 2)).toMatch(/^The first frame and the last frame are the same picture/);
    for (const s of MOTION_SHOTS) {
      expect(promptFor(s, 2)).not.toMatch(/\{WOMAN\}|eimi|mahiro/i);
      // Emotional cues play as slow eyes-closed smiles (asset-bible §5): describe the face physically.
      expect(s.prompt, s.id).not.toMatch(/happy|glad|delighted|blissful|eyes smile|glances? down/i);
    }
  });
  it('dresses the outfit change as a clothed companion and keeps people out of her empty room', () => {
    const bare = /\b(camisole|strap|strapless|off-the-shoulder|bare shoulders?|cleavage|slit|swimsuit|lingerie)\b/i;
    for (const m of MOTION_KEYFRAMES) expect(m.wearing ?? '', m.name).not.toMatch(bare);
    const room = MOTION_KEYFRAMES.find((m) => m.name === 'eimi-room-9x16')!;
    expect(motionPrompt(room, 0)).toMatch(/No people at all/);
    const gown = motionPrompt(MOTION_KEYFRAMES.find((m) => m.name === 'eimi-gown-9x16')!, 3, ['eyes smaller']);
    expect(gown).toMatch(/Reference image 4 is the base picture/);
    expect(gown).toMatch(/rose satin evening gown with long fitted sleeves, a high modest neckline/);
    expect(gown).toMatch(/Corrections from the previous attempt \(fix these\): eyes smaller/);
  });
  it('registers motion stills by name, with an optional candidate', () => {
    expect(parseMotionPicks('eimi-seated-9x16,eimi-gown-9x16=b')).toEqual([{ name: 'eimi-seated-9x16', letter: undefined }, { name: 'eimi-gown-9x16', letter: 'b' }]);
    expect(() => parseMotionPicks('eimi-hero-9x16')).toThrow(/unknown motion keyframe/);
    expect(() => parseMotionPicks('eimi-gown-9x16=B')).toThrow(/bad pick/);
  });
});

describe('motion QA for framed clips (seams, cuts, faces)', () => {
  const frame = (v: number | ((i: number) => number)) => Uint8Array.from({ length: 4096 }, (_, i) => (typeof v === 'number' ? v : v(i)));
  it('finds a hard cut but not fast motion', () => {
    const still = Array.from({ length: 20 }, () => frame(100));
    expect(findCuts(still)).toEqual([]);
    const cut = [...still.slice(0, 10), ...Array.from({ length: 10 }, () => frame((i) => (i % 2 ? 140 : 70)))];
    expect(findCuts(cut)).toEqual([10]);
    // A hand moving fast changes a lot on every frame: sustained, not a spike.
    const hand = Array.from({ length: 20 }, (_, k) => frame((i) => ((i % 64 < 32) === (k % 2 === 0) ? 100 + 2 * CUT_STEP : 100)));
    expect(findCuts(hand)).toEqual([]);
    expect(mad(frame(10), frame(13))).toBe(3);
  });
  it('requires her face only where a keyframe shows her, and closed seams', () => {
    const leave = SHOTS.find((x) => x.id === 'eimi-leave-9x16')!, twirl = SHOTS.find((x) => x.id === 'eimi-twirl-9x16')!;
    expect(judgeFramed(leave, { longest: 0.2, cuts: [] }, [true, false, false])).toEqual({ ok: true, problems: [] });
    expect(judgeFramed(leave, { longest: 0.2, cuts: [5.08] }, [true, false, true]).problems).toEqual(['she is still in the last frame', 'hard cut at 5.08s']);
    expect(judgeFramed(twirl, { longest: 0.2, loopSeam: 1.5, chainSeam: { after: 'eimi-return-9x16', diff: 1.2 } }, [true, false, true]).ok).toBe(true);
    expect(judgeFramed(twirl, { longest: 0.2, loopSeam: MAX_SEAM + 1 }, [true, true]).problems).toEqual([`loop seam ${MAX_SEAM + 1} > ${MAX_SEAM}`]);
  });
  it('measures eyes only on large, near-frontal faces, and judges the largest faces', () => {
    const g = { eyeWidth: 1, eyeOpen: 0.3, faceLength: 1, noseWidth: 1, mouthWidth: 1, eyeMouth: 1, chin: 1 };
    expect(eyeOpenness({ x: 0, y: 0, w: 120, h: 120, yaw: 5, geometry: g })).toBe(0.3);
    expect(eyeOpenness({ x: 0, y: 0, w: 30, h: 30, yaw: 5, geometry: g })).toBeNaN();
    expect(eyeOpenness({ x: 0, y: 0, w: 120, h: 120, yaw: 60, geometry: g })).toBeNaN();
    expect(largestFaces([0, 50, 60, 55, 0, 10], 2, 2)).toEqual([2, 5]);
  });
  it('renders a private contact sheet that escapes what it shows and loads nothing remote', () => {
    const html = renderPack({ title: 'Pilot <79>', at: 'now', clips: [{ id: 'eimi-twirl-9x16', use: 'turn & show', duration: 6, video: 'clips/eimi-twirl-9x16.mp4', poster: 'stills/p.jpg', retimed: true, attempts: 1, stills: [{ role: 'first', label: 'eimi-gown-9x16', file: 'stills/a.jpg', likeness: 5 }], check: { file: 'x', frames: 144, faceless: 0, blinks: [], longest: 0, seam: 0, loopSeam: 1.48, ok: true } }] });
    expect(html).toContain('<title>Pilot &lt;79&gt;</title>');
    expect(html).toContain('<video src="clips/eimi-twirl-9x16.mp4"');
    expect(html).toContain('turn &amp; show');
    expect(html).toMatch(/likeness 5/);
    expect(html).toMatch(/prefers-color-scheme:dark/);
    expect(html).not.toMatch(/https?:\/\//);
  });
});
