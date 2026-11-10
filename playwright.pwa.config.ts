import { defineConfig, devices } from '@playwright/test'

const playwrightPreviewPort = Number(process.env.PLAYWRIGHT_PREVIEW_PORT ?? '4173')

if (!Number.isInteger(playwrightPreviewPort) || playwrightPreviewPort < 1 || playwrightPreviewPort > 65_535) {
  throw new Error('PLAYWRIGHT_PREVIEW_PORT must be an integer between 1 and 65535.')
}

const playwrightPreviewBaseUrl = `http://127.0.0.1:${playwrightPreviewPort}`

/**
 * PWA の E2E テスト設定です。
 *
 * service worker は production build でだけ登録されるため、通常の E2E とは分けて
 * `web:build` 後の `web:preview` に対して実行します。
 */
const config = defineConfig({
  testDir: './web/e2e',
  testMatch: /pwa\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-pwa' }]],
  use: {
    baseURL: playwrightPreviewBaseUrl,
    trace: 'on-first-retry',
    timezoneId: 'Asia/Tokyo',
    serviceWorkers: 'allow',
  },
  projects: [
    {
      name: 'mobile-pwa',
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: {
    command: `bun run web:build && bun run web:preview -- --host 127.0.0.1 --port ${playwrightPreviewPort} --strictPort`,
    url: playwrightPreviewBaseUrl,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === 'true',
    timeout: 180_000,
  },
})

export default config
