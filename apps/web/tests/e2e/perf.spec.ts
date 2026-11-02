import { SLOW, test, expect } from './fixtures';
import fs from 'node:fs';
import zlib from 'node:zlib';

test('bundle budget', async () => {
  const files = fs.readdirSync('dist/assets');
  const gz = (f: string) => zlib.gzipSync(fs.readFileSync(`dist/assets/${f}`)).length;
  const size = (pred: (f: string) => boolean) => files.filter(pred).reduce((n, f) => n + gz(f), 0);
  // The entry is what index.html loads (a lazy chunk named after an index.ts module is not the entry).
  const html = fs.readFileSync('dist/index.html', 'utf8');
  const entryJs = /<script[^>]+src="\/?assets\/([^"]+\.js)"/.exec(html)?.[1];
  const entryCssFile = /<link[^>]+href="\/?assets\/([^"]+\.css)"/.exec(html)?.[1];
  expect(entryJs).toBeTruthy();
  const entry = size((f) => f === entryJs);
  // The card catalog (150 cards, titles, lines and SSR/UR stories in three languages) is content, loaded lazily
  // with the collection and gacha; it has its own budget so it cannot hide code growth.
  const cards = size((f) => /^cards-.*\.js$/.test(f));
  const js = size((f) => f.endsWith('.js')) - cards;
  const css = size((f) => f.endsWith('.css'));
  const entryCss = size((f) => f === entryCssFile);
  console.log('PERF bundle gzip', JSON.stringify({ entryKB: +(entry / 1024).toFixed(1), cardsKB: +(cards / 1024).toFixed(1), allJsKB: +(js / 1024).toFixed(1), cssKB: +(css / 1024).toFixed(1), entryCssKB: +(entryCss / 1024).toFixed(1) }));
  // 95 KiB: the Japanese dictionary ships in the entry (no flash of untranslated text) and grows with features;
  // everything else — card catalog, legal texts, gacha code, pages — is lazy. LCP is budgeted separately below.
  // v1.1 moved it from 95 to 100 KiB: its screens add their Japanese strings to that dictionary (7.9 → 11.3 KiB gzip).
  // Splitting per-route dictionaries out of the entry is the follow-up if it keeps growing.
  // Nest (v1.1 complete: voice minutes, variant panel, scene music) adds the last of its strings: 100 → 104 KiB.
  // The media catalogue (media.gen.ts) shipped in the entry and #80's morning and 16:9 clips grew it: 104 → 108 KiB.
  // Split since: the scenes' clips (scene shots, talk / idle loops, system scenes, confession, variant entrance and
  // exit) are a lazy catalogue (media.scene.gen.json, fetched: src/data/media.ts); the entry keeps the first screens' clips: 102 KiB.
  // Every variant clip (her variant home loops too) and her morning clips joined that lazy catalogue since
  // (101.8 → 100.9 KiB): her room waits for it only in the morning or when he owns her variant card.
  // v1.1.1 member acceptance (B-findings H1–M11): the shell carries the offline line and the log-out notice (M3, M10),
  // English counts of one and quotes (L2), and the account flows' strings join the Japanese dictionary that ships here
  // (OTP reasons and resend, the nickname, the push offer…). 27 dead keys came out first; 103.1 KiB measured: 102 → 104 KiB.
  // UX round 1, guest paths: the build writes media.gen.ts as a compact table rebuilt at load (vite.config.ts
  // compactMedia; the same object, tests/unit/guestUx.test.tsx), 3 KiB lighter, which pays for the hero's face placement
  // (H1) and the round's strings: 103.1 → 101.3 KiB.
  expect(entry).toBeLessThan(104 * 1024);
  // All JS, lazy chunks included: the 150-card catalog in three languages, legal texts and the three other dictionaries.
  // v1.1 (scene player, alarm, confession, weather room, voice…) are lazy route chunks: 200 → 260 KiB in all.
  // Nest completes v1.1: Korean on every scene and line text, the stream, morning scene, variant panel, music and
  // hands-free, memory titles in every language — all lazy route chunks (the entry stays under its own budget above): 260 → 345 KiB in all.
  // Her room v2 (A2「夜畫廊」, #163–#169: the room layer, its 目錄, her call, the visual system) is a lazy route chunk: 345 → 352 KiB.
  // Her room's QA fixes (#175's round: ② going on, her suggestions, her call's kind, the inbox read again): 352 → 356 KiB.
  // Her lip-sync (#73: the scene player's and her room's lip-synced layer, the render requests): 356 → 358 KiB. The list
  // of renders (data/lipsync.gen.json) is fetched as a file, like the scene catalogue, not bundled as code.
  // Her runtime voice's last pieces (#73: the streamed first sentence with its fallback, the queue by audio time, the
  // English splitter, blob: clips in scenes), also lazy, landed on top of it: both together measure 357.8 KiB, so
  // 358 → 359 KiB keeps a little headroom (the entry stays 101.9 KiB, under its own budget above).
  // Her recorded lines in step with her voice (#73, QA of 53be1c0: renders loaded ahead, the per-frame sync on her voice
  // clock, the clip lined up at the hand back; all in the lazy scene player): 359.7 KiB measured, so 359 → 361 KiB.
  // The v1.1 acceptance round (10/3): her room rebuilt as B「電影字幕」 (subtitle paging by her voice), the logic and
  // visual-system fixes from the UI/UX pass (#164–#170, #55, #56, #64–#68) and #165's voice-note length — all lazy,
  // none in the entry. 361 KiB left 59 B, so 361 → 368 KiB, once, for the whole round.
  // v1.1.1 member acceptance: the account screens on the night, the OTP resend, the nickname, the push offer and the
  // four dictionaries' new strings, all lazy but the entry's share above: 370.4 KiB measured, so 368 → 372 KiB.
  // UX round 1, guest paths (all lazy; the entry got lighter, above): the trial's retry, end button and night look,
  // the gallery's card preview, the SSR/UR reveal laid out from her face box, the 404 and legal pages, the install sheet,
  // Hangul names, pick / code form / events on the night: 371.6 → 373.5 KiB measured, so 372 → 374 KiB.
  // D-scenes acceptance of 47b0fcb (all lazy, none in the entry): subtitles paged by her voice, quotes per language and
  // phrase breaks (lib/lines.ts, scene/phrases.tsx), the scene player's end states, retries, paused countdowns and
  // lip-sync start, the weather kept off her face, the call banner: 377.05 KiB measured, so 374 → 378 KiB, once.
  // v1.1.2 re-test, her room (C-room N1–N10, L3, L9, L10, P2): her own 約定 and 記錄 sheets, 「今晚見」 and its promise,
  // her call paged like her room, the call-elsewhere line, the input's voice meter as a tap, and their words in four
  // languages — all in the lazy member chunk. Trimmed first: the dead chat.level key (four dictionaries), and the
  // prototype's invitation check loads its own small entry (scenes/invite.ts, scenes/timing.ts) instead of the whole
  // scenes index (which kept every engine export: 1.6 KiB): 380.9 KiB measured, so 378 → 381 KiB, once.
  // v1.1.3: #219's step bookkeeping in the lazy scene player (answers name their step and seq) lands on #218's 380.9:
  // 381.4 KiB measured, so 381 → 382 KiB.
  expect(js).toBeLessThan(382 * 1024);
  // CSS is split like JS: what the first paint waits for (the entry sheet) is held tight; lazy sheets (scene
  // player, reveal, home) load with their own routes. v1.1 adds whole screens (scene player, notifications, her
  // inbox, relationship), so the all-CSS cap moved from 20 to 26 KiB while the entry sheet keeps a hard 11 KiB.
  expect(entryCss).toBeLessThan(11 * 1024);
  // The card tier frames from the physical-card deck (UR gold filigree, SSR red foil, SR holo, R silver, N line) are
  // lazy card-page CSS: 26 → 28 KiB in all; the entry sheet stays under its own 11 KiB.
  // #162: the visual system's components (system/system.css, with her room) and its /#/design page are lazy CSS too:
  // 28 → 32 KiB in all; the entry sheet keeps its 11 KiB (the tokens moved there from global.css, not grew).
  // Her room v2 (#163–#169: room.css, lazy with her room): 32 → 34 KiB in all; the entry sheet keeps its 11 KiB.
  // The v1.1 acceptance round: #207's A2 scene and log-in sheets (lazy) measure 34.7 KiB, and room B adds 1.8 KiB in
  // round 2: 36.5 KiB, so 34 → 37 KiB once for the round (the entry sheet keeps its own 11 KiB cap above).
  // v1.1.1 member acceptance: her chat on the night (M9, lazy), the gacha's link row, the offline line and the cursor
  // light kept off the member pages (entry, still under its 11 KiB): 37.05 KiB measured, so 37 → 38 KiB.
  // UX round 1, guest paths: the trial (on her chat's .chat-night, plus its still, failed mark and end), the gallery's
  // preview (gift.css's night sheet, reused), pick / code form / events on the night, the PV arrows (lazy), and the
  // hero's one-screen rules (entry, still under its 11 KiB): 37.5 → 38.8 KiB measured, so 38 → 39.3 KiB.
  // D-scenes acceptance: the last member pages on the night (system.css .js-nightpage), the gallery, legal pages and
  // 404 on the night, the scene's paged subtitles, title row, pillarbox and weather mask (lazy; dead room.css selectors
  // trimmed first): 39.49 KiB measured, so 39.3 → 39.6 KiB.
  // v1.1.2 re-test, member and public pages: five more member pages on the night (system.css .js-nightpage: the iPhone
  // steps, a night sheet), the offline line docked under the header band (entry), the alarm's weekday states, the
  // gallery preview as a centred modal and /events' width. Trimmed first: the preview reuses the gift sheet (its own
  // `call` rules dropped) and the night-document rule lost its duplicate selector list: 39.63 KiB measured, so
  // 39.6 → 39.7 KiB (the entry sheet stays under its 11 KiB).
  // v1.1.2 re-test, her room: the status line on one line (N10), the offline line docked in her top band (N6), the
  // input's voice minutes as a button (B-L4), 目錄 kept off her hair at 740×675, and 約定 / 記錄 as her room's sheets
  // (L9; gift.css's night sheet reused, their own rules compacted first): 39.99 KiB measured, so 39.7 → 40.1 KiB, once.
  expect(css).toBeLessThan(40.1 * 1024);
  // Korean joined the catalog as its fourth language (N-06: 150 titles and lines, 25 stories): 100 → 115 KiB.
  expect(cards).toBeLessThan(115 * 1024);
});

test('top page on a throttled mid-range phone', async ({ page, context }) => {
  test.skip(!!process.env.CI, 'CPU-throttled timings on a shared CI runner measure the runner, not the page; run locally');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(() => {
    localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true }));
    (window as unknown as { __lcp: number }).__lcp = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as unknown as { __lcp: number }).__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    (window as unknown as { __long: number }).__long = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as unknown as { __long: number }).__long += e.duration - 50; }).observe({ type: 'longtask', buffered: true });
  });
  await page.goto('/#/loading?next=/');
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.waitForTimeout(3000);
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1;
    return { fcp: Math.round(fcp), lcp: Math.round((window as unknown as { __lcp: number }).__lcp), dcl: Math.round(nav.domContentLoadedEventEnd), tbt: Math.round((window as unknown as { __long: number }).__long) };
  });
  console.log('PERF slow4g+4xCPU', JSON.stringify(m));
  expect(m.fcp).toBeLessThan(3000 * SLOW);
  expect(m.lcp).toBeLessThan(4000 * SLOW);
  expect(m.tbt).toBeLessThan(600 * SLOW);
});

test('top page idles without re-rendering every frame', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true })));
  await page.goto('/#/');
  await page.getByRole('heading', { level: 1 }).waitFor();
  const mutations = await page.evaluate(() => new Promise<number>((res) => {
    let n = 0;
    const mo = new MutationObserver((l) => { n += l.length; });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    setTimeout(() => { mo.disconnect(); res(n); }, 3000);
  }));
  console.log('PERF top idle DOM mutations / 3s', mutations);
  expect(mutations).toBeLessThan(30);
});

test('long chat history stays responsive', async ({ page }) => {
  await page.addInitScript(() => {
    const msgs = Array.from({ length: 200 }, (_, i) => ({ id: String(i), from: i % 2 ? 'her' : 'me', text: 'メッセージ '.repeat(10) + i }));
    localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, user: { via: 'email', nickname: 'k' }, chats: { mahiro: msgs } }));
  });
  const t0 = Date.now();
  await page.goto('/#/me/chat');
  await page.getByText('メッセージ メッセージ', { exact: false }).last().waitFor();
  const t = Date.now() - t0;
  console.log('PERF chat 200 msgs render ms', t);
  expect(t).toBeLessThan(3000 * SLOW);
});
