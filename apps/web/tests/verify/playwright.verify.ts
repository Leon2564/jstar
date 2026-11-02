import { defineConfig } from '@playwright/test';
/** Real-time checks that need the network and real audio; never part of ci:local (tests/verify/lipsync.verify.ts). */
const PORT = Number(process.env.PW_PORT || 4394);
export default defineConfig({
  testDir: '.',
  testMatch: /\.verify\.ts$/,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`, locale: 'ja-JP', viewport: { width: 390, height: 844 },
    launchOptions: { executablePath: process.env.CHROME_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] }
  },
  webServer: { command: `npx vite preview --port ${PORT} --strictPort`, url: `http://localhost:${PORT}`, reuseExistingServer: false, cwd: '../..', timeout: 60_000 }
});
