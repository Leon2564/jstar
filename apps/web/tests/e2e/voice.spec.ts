import { test, expect, passAgeGate, signUpByEmail } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Voice input (#72). Headless Chromium has no speech service, so the page gets a stand-in SpeechRecognition that
 * the test drives through `window.__rec` (open, hear words, end, fail). Everything after the recogniser — the
 * press, the live words in the box, the release, the send — is the real app.
 */
async function fakeSpeech(page: Page) {
  await page.addInitScript(() => {
    type Handler = ((e?: unknown) => void) | null;
    class Rec {
      lang = ''; continuous = false; interimResults = false; maxAlternatives = 1;
      onstart: Handler = null; onresult: Handler = null; onerror: Handler = null; onend: Handler = null;
      constructor() { (window as unknown as { __rec: Rec }).__rec = this; }
      start() { setTimeout(() => this.onstart?.(), 10); }
      stop() { setTimeout(() => this.onend?.(), 10); }
      abort() { /* aborted: no more events */ }
      hear(text: string) { this.onresult?.({ results: [Object.assign([{ transcript: text }], { isFinal: false })] }); }
      fail(error: string) { this.onerror?.({ error }); }
    }
    // Newer Chromium has the unprefixed name too; the app prefers it.
    Object.assign(window, { SpeechRecognition: Rec, webkitSpeechRecognition: Rec });
  });
}
const rec = (page: Page, js: string) => page.evaluate(`window.__rec.${js}`);

test.describe('voice input', () => {
  test('chat: hold the mic, the words show as she hears them, let go and they are sent; then text again', async ({ page }) => {
    await fakeSpeech(page);
    await passAgeGate(page);
    await signUpByEmail(page, '/me/chat');
    await expect(page).toHaveURL(/#\/me\/chat/);
    const mic = page.getByTestId('mic');
    const box = page.getByLabel('メッセージ');
    const at = (await mic.boundingBox())!;
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.down();
    await expect(mic).toHaveAttribute('data-phase', 'listening');
    await rec(page, "hear('今日は雨だったよ')");
    await expect(box).toHaveValue('今日は雨だったよ');
    await page.waitForTimeout(400);
    await page.mouse.up();
    await expect(page.locator('.msg.me').last()).toHaveText('今日は雨だったよ');
    await expect(box).toHaveValue('');
    await expect(mic).toHaveAttribute('data-phase', 'idle');
    // Text any time, into the same conversation.
    await expect(page.getByRole('button', { name: '送信' })).toBeDisabled();
    await box.fill('おやすみ');
    await page.getByRole('button', { name: '送信' }).click();
    await expect(page.locator('.msg.me')).toHaveText(['今日は雨だったよ', 'おやすみ']);
  });

  test('chat: a refused microphone explains itself and leaves him typing', async ({ page }) => {
    await fakeSpeech(page);
    await passAgeGate(page);
    await signUpByEmail(page, '/me/chat');
    await page.getByTestId('mic').click();
    await rec(page, "fail('not-allowed')");
    await expect(page.getByText('マイクが使えないので、文字で話しかけてね', { exact: false })).toBeVisible();
    await expect(page.getByLabel('メッセージ')).toBeFocused();
  });

  test('scene: the mic answers her free-talk question by voice, and stops by itself after the silence', async ({ page }) => {
    await fakeSpeech(page);
    await passAgeGate(page);
    await signUpByEmail(page);
    await page.goto('/#/me/scene/demo-evening');
    await page.getByRole('group', { name: 'なんて答える？' }).getByRole('button').first().click();
    await expect(page.getByLabel('あなたの言葉')).toBeVisible();
    // A tap (not a hold) keeps listening; the silence after his words ends it and sends them.
    await page.getByTestId('mic').click();
    await expect(page.getByTestId('mic')).toHaveAttribute('data-phase', 'listening');
    await rec(page, "hear('ただいま、まひろ')");
    await expect(page.getByLabel('あなたの言葉')).toHaveValue('ただいま、まひろ');
    await expect(page.getByTestId('scene-end')).toBeVisible({ timeout: 10_000 });
  });

  test('no mic where there is neither speech recognition nor a server recogniser', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
      delete w.SpeechRecognition;
      delete w.webkitSpeechRecognition;
    });
    await passAgeGate(page);
    await signUpByEmail(page, '/me/chat');
    await expect(page.getByLabel('メッセージ')).toBeVisible();
    await expect(page.getByTestId('mic')).toHaveCount(0);
  });
});
