import { defineConfig, devices } from '@playwright/test'

const webPort = Number(process.env.PLAYWRIGHT_PORT ?? '5173')
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT ?? '3000')

for (const [name, port] of [['PLAYWRIGHT_PORT', webPort], ['PLAYWRIGHT_API_PORT', apiPort]] as const) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`)
  }
}

const webBaseUrl = `http://127.0.0.1:${webPort}`
const apiBaseUrl = `http://127.0.0.1:${apiPort}`

/**
 * Config for the smoke suite that runs against Floci and the real server (#417).
 *
 * Kept apart from the mock-based `web/e2e` suite; it checks the Web and server contract without stubbing the API.
 * Run `bun run floci:up` first so `.floci/generated/cognito.env` exists.
 * Starts the server with `server:dev` and the Web with `web:dev`, which proxies `/api` to the server.
 */
const config = defineConfig({
  testDir: './web/e2e-real-server',
  // Tests reuse the Team and Work Item created by earlier tests, so run them serially on one worker.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-real-server' }]],
  use: {
    baseURL: webBaseUrl,
    trace: 'retain-on-failure',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'bun run server:dev',
      url: `${apiBaseUrl}/api/health`,
      reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === 'true',
      timeout: 60_000,
      env: { PORT: String(apiPort) },
    },
    {
      command: `bun run web:dev -- --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: webBaseUrl,
      reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === 'true',
      timeout: 45_000,
      env: { VITE_API_PROXY_TARGET: apiBaseUrl },
    },
  ],
})

export default config
