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
 * Floci と実 server に対して動かす smoke suite の設定です（#417）。
 *
 * `web/e2e` の mock ベースの suite とは分け、API を差し替えずに Web と server の契約を確かめます。
 * 先に `bun run floci:up` で Floci を起動し、`.floci/generated/cognito.env` を作っておきます。
 * server は `server:dev`、Web は `/api` を server へ proxy する `web:dev` で起動します。
 */
const config = defineConfig({
  testDir: './web/e2e-real-server',
  // 各 test は前の test が作った Team と Work Item を使うので、1 worker で順に流します。
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
