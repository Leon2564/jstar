import { SLOW, test, expect } from './fixtures';

/**
 * Interaction latency via the Event Timing API (the basis of INP):
 * every tap/keypress in a scripted session, on a 4x throttled CPU, must paint its response quickly.
 */
test('taps respond quickly on a throttled phone (INP-style)', async ({ page, context }) => {
  test.skip(!!process.env.CI, 'CPU-throttled timings on a shared CI runner measure the runner, not the page; run locally');
  test.setTimeout(90_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(() => {
    localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'ja', user: { via: 'email', nickname: 'k' }, points: 5000 }));
    const w = window as unknown as { __ev: { name: string; d: number }[] };
    w.__ev = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as PerformanceEventTiming[]) if (e.interactionId) w.__ev.push({ name: e.name, d: e.duration });
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  });
  await page.goto('/#/me/home');
  const tabs = page.getByRole('navigation', { name: 'メイン' });
  // Her room (A2 room v2): the five are in its 目錄; picking one opens her room. Her memories lead on to the cards.
  for (const id of ['nana', 'unpai', 'alice']) {
    await page.getByTestId('room-index-open').click();
    await page.getByTestId(`star-rule-${id}`).click();
  }
  await page.getByTestId('room-index-open').click();
  await page.getByTestId('room-memories').click();
  await tabs.getByRole('link', { name: 'カード', exact: true }).click();
  await page.getByRole('tab', { name: '思い出カード' }).click();
  await tabs.getByRole('link', { name: 'ガチャ', exact: true }).click();
  await page.getByRole('button', { name: '10回引く' }).click();
  await page.getByRole('button', { name: 'すべてめくる' }).click();
  await page.getByRole('link', { name: 'カードを見る' }).click();
  await page.goto('/#/me/chat');
  await page.getByLabel('メッセージ').pressSequentially('こんばんは、今日もおつかれさま', { delay: 20 });
  await page.getByRole('button', { name: '送信' }).click();
  await page.waitForTimeout(800);
  const ev = await page.evaluate(() => (window as unknown as { __ev: { name: string; d: number }[] }).__ev);
  const worst = ev.reduce((m, e) => Math.max(m, e.d), 0);
  console.log('INTERACTION worst events', JSON.stringify([...ev].sort((a, b) => b.d - a.d).slice(0, 4)));
  const p75 = [...ev].map((e) => e.d).sort((a, b) => a - b)[Math.floor(ev.length * 0.75)] ?? 0;
  console.log('INTERACTION', JSON.stringify({ count: ev.length, p75, worst }));
  expect(worst).toBeLessThan(200 * SLOW);
});

test('route changes paint within a frame budget (no blocking work on navigation)', async ({ page }) => {
  test.skip(!!process.env.CI, 'CPU-throttled timings on a shared CI runner measure the runner, not the page; run locally');
  await page.addInitScript(() => localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'ja', user: { via: 'email', nickname: 'k' } })));
  await page.goto('/#/me/home');
  await page.waitForTimeout(1500); // idle prefetch of route chunks
  const times = await page.evaluate(async () => {
    const out: number[] = [];
    for (const href of ['#/me/cards', '#/me/gacha', '#/me/mypage', '#/me/home', '#/stars', '#/gallery']) {
      const link = document.createElement('a');
      link.href = href;
      const t0 = performance.now();
      window.location.hash = href.slice(1);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      let n = 0;
      while (document.body.dataset.route !== href.slice(1) && n++ < 50) await new Promise((r) => setTimeout(r, 10));
      out.push(Math.round(performance.now() - t0));
    }
    return out;
  });
  console.log('NAV ms', JSON.stringify(times));
  expect(Math.max(...times)).toBeLessThan(150 * SLOW);
});

test('reduced-motion users get no animations and no auto-rotation', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', locale: 'ja-JP' });
  await ctx.addInitScript(() => localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'ja' })));
  const page = await ctx.newPage();
  await page.goto('/#/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('唯井まひろ');
  const anim = await page.evaluate(() => document.getAnimations().length);
  expect(anim).toBe(0);
  await page.waitForTimeout(7600);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('唯井まひろ');
  await ctx.close();
});
