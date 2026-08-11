import { defineConfig, devices } from '@playwright/test'

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? '5173')

if (!Number.isInteger(playwrightPort) || playwrightPort < 1 || playwrightPort > 65_535) {
  throw new Error('PLAYWRIGHT_PORT must be an integer between 1 and 65535.')
}

const playwrightBaseUrl = `http://127.0.0.1:${playwrightPort}`

/**
 * mukuroji のブラウザ E2E テスト設定です。
 */
const config = defineConfig({
  testDir: './web/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: playwrightBaseUrl,
    trace: 'on-first-retry',
    timezoneId: 'Asia/Tokyo',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `bun run web:dev -- --host 127.0.0.1 --port ${playwrightPort} --strictPort`,
    url: playwrightBaseUrl,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === 'true',
    timeout: 45_000,
  },
})

export default config
