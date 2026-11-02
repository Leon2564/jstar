import { test, expect, passAgeGate, signUpByEmail } from './fixtures';

/**
 * The system scenes (#71), prototype mode: one opened by its address (as an offer or her message leads there) loads
 * on its own and plays with the existing footage — her whisper close, his goodnight, the lights out. The clock is
 * pinned to a late evening in Japan so nothing in the room depends on when the suite runs.
 */
test.describe('system scenes', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-09T23:10:00+09:00') });
  });

  test('her goodnight whisper: close, "just a little longer", the next whisper, then the lights go out', async ({ page }) => {
    await passAgeGate(page);
    await signUpByEmail(page);
    await page.goto('/#/me/scene/whisper-mahiro-1');
    const scene = page.getByTestId('scene');
    // Her close shot: her own whisper by the bed (#71, `<star>-sys-whisper`), no longer her breathing loop standing in.
    await expect(scene.locator('.scn-layer.on')).toHaveAttribute('data-clip', /^mahiro-sys-whisper-/);
    await expect(page.getByTestId('scene-sub')).toContainText('おやすみ。今日もいちばん近くで');
    await page.getByTestId('scene-choices').getByRole('button', { name: /もう少しだけ/ }).click();
    await expect(scene).toHaveAttribute('data-played', /^answer~stay more lights end$/);
    const end = page.getByTestId('scene-end');
    await expect(end).toBeVisible();
    await expect(end.getByRole('heading', { name: 'おやすみ。また明日ね。' })).toBeVisible();
    await expect(end).toContainText('まひろとの親密度 +3');
  });

  test('her birthday: the gift, her thanks, and the memory card kept with her', async ({ page }) => {
    await passAgeGate(page);
    await signUpByEmail(page);
    await page.goto('/#/me/scene/her-birthday-alice');
    await page.getByTestId('scene-choices').getByRole('button', { name: /手紙を渡す/ }).click();
    const end = page.getByTestId('scene-end');
    await expect(end).toBeVisible();
    await expect(end).toContainText('一緒に祝った誕生日');
    await page.goto('/#/me/cards?tab=memory');
    await expect(page.getByRole('img', { name: /一緒に祝った誕生日/ })).toHaveCount(1);
  });
});
