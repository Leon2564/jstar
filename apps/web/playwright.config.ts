import { defineConfig, devices } from '@playwright/test';

/**
 * PW_PORT gives a run its own preview server (npm run ci:local uses one), so a preview another checkout left
 * running on 4173 is never tested by mistake. Unset: 4173, reusing a server already there.
 */
const PORT = Number(process.env.PW_PORT || 4173);
const OWN_SERVER = !!process.env.PW_PORT;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['iPhone 13'],
    locale: 'ja-JP',
    browserName: 'chromium',
    // CHROME_PATH pins a local browser; otherwise Playwright's own (npx playwright install chromium).
    ...(process.env.CHROME_PATH ? { launchOptions: { executablePath: process.env.CHROME_PATH } } : {}),
    trace: 'off'
  },
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !OWN_SERVER,
    timeout: 60_000
  }
});
