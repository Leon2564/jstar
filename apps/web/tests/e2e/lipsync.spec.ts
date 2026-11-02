import { test, expect, passAgeGate, signUpByEmail } from './fixtures';

/**
 * #73 her recorded lines lip-synced (lib/lipsync.ts, components/lipsyncVideo.tsx): while she says a line that was
 * rendered onto the clip on screen, the scene player loads its render (`/lipsync/v1/<clip>/<voice>-<w>x<h>.mp4`). The
 * render failing (here: 404) changes nothing — the scene plays on over her clip, as before.
 */
test('scene: her rendered line is loaded over her talk loop, and a missing render is a clean fallback', async ({ page }) => {
  await page.route('**/lipsync/v1/**', (route) => route.fulfill({ status: 404, body: '' }));
  // e2e lines last a moment: every lip-sync layer the player mounts is recorded as it appears.
  // Each is kept with the subtitle on screen when it appeared: a render is loaded ahead of its line (QA 53be1c0).
  await page.addInitScript(() => {
    const w = window as unknown as { __lipsync: string[]; __lipsyncSub: Record<string, string> };
    const seen: string[] = (w.__lipsync = []);
    w.__lipsyncSub = {};
    new MutationObserver(() => {
      document.querySelectorAll<HTMLVideoElement>('[data-testid="lipsync"] video').forEach((v) => {
        const s = v.getAttribute('src');
        if (s && !seen.includes(s)) { seen.push(s); w.__lipsyncSub[s] = document.querySelector('[data-testid="scene-sub"]')?.textContent ?? ''; }
      });
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src'] });
  });
  await passAgeGate(page);
  await signUpByEmail(page);
  await page.getByTestId('room-index-open').click();
  await page.getByTestId('demo-menu-open').click();
  await page.getByTestId('scene-entry').click();
  await expect(page).toHaveURL(/#\/me\/scene\/demo-evening$/);
  // His answer: her next lines are rendered on her talk loop (data/lipsync.gen.json); the layer comes with them.
  await page.getByRole('group', { name: 'なんて答える？' }).getByRole('button', { name: /今日はちょっと疲れた/ }).click();
  const seen = () => page.evaluate(() => (window as unknown as { __lipsync: string[] }).__lipsync);
  await expect.poll(async () => (await seen()).length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect((await seen())[0]).toMatch(/^\/lipsync\/v1\/mahiro-talk-(9x16|16x9)\/[0-9a-f]{12}-\d+x\d+\.mp4$/);
  // Loaded ahead: her line after next (「ちょっと待ってて」, 9b348e787efb) had its render mounted before it was said.
  await expect.poll(async () => (await seen()).some((s) => s.includes('9b348e787efb')), { timeout: 15_000 }).toBe(true);
  const subs = await page.evaluate(() => (window as unknown as { __lipsyncSub: Record<string, string> }).__lipsyncSub);
  const away = Object.entries(subs).find(([s]) => s.includes('9b348e787efb'));
  expect(away?.[1] ?? '').not.toContain('ちょっと待ってて');
  // Failed renders: never shown, and the scene goes on to his free answer.
  await expect(page.getByLabel('あなたの言葉')).toBeVisible();
  await expect(page.locator('[data-lipsync="on"]')).toHaveCount(0);
});

/**
 * #73 her room without lip-sync for her runtime voice (no voice offered, as in prototype mode): her room is exactly as
 * before — no lip-sync layer over her talk loop, and no warm-up or render request is ever sent.
 */
test('room: with her runtime voice off, no lip-sync layer and no lip-sync traffic', async ({ page }) => {
  const calls: string[] = [];
  await page.route('**/v1/lipsync**', (route) => { calls.push(route.request().url()); return route.fulfill({ status: 404, body: '' }); });
  await passAgeGate(page);
  await signUpByEmail(page);
  await expect(page.getByTestId('room-index-open')).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('lipsync')).toHaveCount(0);
  expect(calls).toEqual([]);
});
