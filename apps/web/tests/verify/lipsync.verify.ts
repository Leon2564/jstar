import { test, expect, passAgeGate, signUpByEmail } from '../e2e/fixtures';

/**
 * #73 QA 53be1c0, measured in a real browser with real audio (not part of ci:local: it plays her voice in real time
 * and fetches the renders from test.jstarcards.ai). Run: npx playwright test -c tests/verify/playwright.verify.ts
 * Prints per line: how late her mouth comes after her voice starts, the drift while shown, and the pose difference
 * between her render and the clip under it at the hand back.
 */
test('scene lip-sync against her voice, in a real browser', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__E2E__ = false;
    localStorage.setItem('jstar.sound', 'on');
    const log: Record<string, unknown>[] = (w.__lip = []);
    const auds: HTMLAudioElement[] = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (this instanceof HTMLAudioElement && /\/voice\/scene\//.test(this.src)) {
        auds.push(this);
        this.addEventListener('playing', () => log.push({ ev: 'voice', src: this.src.split('/').pop(), t: performance.now() - this.currentTime * 1000 }), { once: true });
      }
      return play.call(this);
    };
    let wasOn: HTMLVideoElement | null = null;
    let last: { base: number; render: number } | null = null;
    const mounted = new Set<string>();
    const tick = () => {
      const aud = auds[auds.length - 1] ?? null;
      document.querySelectorAll<HTMLVideoElement>('[data-testid="lipsync"] video').forEach((m) => {
        const s = m.getAttribute('src')?.split('/').pop() ?? '';
        if (!mounted.has(s)) { mounted.add(s); log.push({ ev: 'mount', src: s, t: performance.now() }); }
      });
      const v = document.querySelector<HTMLVideoElement>('[data-lipsync="on"] video');
      const base = document.querySelector<HTMLVideoElement>('.scn-layer.on video');
      if (v && v !== wasOn) log.push({ ev: 'on', src: v.getAttribute('src')?.split('/').pop(), t: performance.now(), audio: aud?.currentTime });
      if (v && aud && !aud.paused) log.push({ ev: 'drift', d: v.currentTime - aud.currentTime });
      if (v && base) last = { base: base.currentTime % (base.duration || 1e9), render: v.currentTime % (base.duration || 1e9) };
      if (!v && wasOn && last) log.push({ ev: 'off', diff: Math.abs(last.base - last.render), t: performance.now() });
      wasOn = v;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // The renders: from a local copy of the batch when there is one (LIPSYNC_RENDERS=<dir of <clip>/<file>.mp4>, so
  // the network is not what is measured), else fetched from the test site.
  const local = process.env.LIPSYNC_RENDERS;
  await page.route('**/lipsync/v1/**', async (route) => {
    const u = new URL(route.request().url());
    if (local) { await route.fulfill({ path: `${local}/${u.pathname.replace('/lipsync/v1/', '')}`, contentType: 'video/mp4' }); return; }
    const r = await route.fetch({ url: `https://test.jstarcards.ai${u.pathname}` });
    await route.fulfill({ response: r });
  });
  await passAgeGate(page);
  await signUpByEmail(page);
  await page.getByTestId('room-index-open').click();
  await page.getByTestId('demo-menu-open').click();
  await page.getByTestId('scene-entry').click();
  await page.getByRole('group', { name: 'なんて答える？' }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500); // he reads the choices
  await page.getByRole('group', { name: 'なんて答える？' }).getByRole('button', { name: /今日はちょっと疲れた/ }).click({ timeout: 30_000 });

  // Her lines play in real time: until her last one (「もうこんな時間」) is up.
  await expect(page.getByTestId('scene-sub')).toContainText('もうこんな時間', { timeout: 60_000 });
  const log = await page.evaluate(() => (window as unknown as { __lip: Record<string, number | string>[] }).__lip);
  const voices = log.filter((e) => e.ev === 'voice');
  const ons = log.filter((e) => e.ev === 'on');
  const drifts = log.filter((e) => e.ev === 'drift').map((e) => Math.abs(e.d as number));
  const offs = log.filter((e) => e.ev === 'off');
  const lags = ons.map((o) => {
    const v = voices.find((x) => String(o.src).startsWith(String(x.src).replace('.mp3', '')));
    return v ? Math.round((o.t as number) - (v.t as number)) : null;
  });
  drifts.sort((a, b) => a - b);
  const p = (q: number) => Math.round((drifts[Math.floor(q * (drifts.length - 1))] ?? 0) * 1000);
  const mounts = log.filter((e) => e.ev === 'mount');
  const ahead = voices.map((v) => {
    const m = mounts.find((x) => String(x.src).startsWith(String(v.src).replace('.mp3', '')));
    return m ? Math.round((v.t as number) - (m.t as number)) : null;
  });
  console.log('LIPSYNC', JSON.stringify({ loadedAheadMs: ahead,
    lines: voices.length, shown: ons.length, mouthAfterVoiceMs: lags, audioTimeAtShow: ons.map((o) => o.audio),
    driftMs: { p50: p(0.5), p95: p(0.95), max: p(1), samples: drifts.length },
    handBackPoseDiffMs: offs.map((o) => Math.round((o.diff as number) * 1000))
  }));
  expect(ons.length).toBeGreaterThan(0);
});
