import { defineConfig, devices } from '@playwright/test'

/**
 * Reads a TCP port from the environment.
 *
 * @param name - Environment variable that may override the port.
 * @param fallback - Port used when the variable is unset.
 * @returns A validated port number.
 */
function readPort(name: string, fallback: string): number {
  const port = Number(process.env[name] ?? fallback)

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`)
  }

  return port
}

const playwrightPort = readPort('PLAYWRIGHT_PORT', '5173')
const playwrightPreviewPort = readPort('PLAYWRIGHT_PREVIEW_PORT', '4173')

const playwrightBaseUrl = `http://127.0.0.1:${playwrightPort}`
const playwrightPreviewBaseUrl = `http://127.0.0.1:${playwrightPreviewPort}`

/** Specs that need a production build because the service worker only registers there. */
const productionBuildSpecs = /pwa\.spec\.ts$/

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
      testIgnore: productionBuildSpecs,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-pwa',
      testMatch: productionBuildSpecs,
      use: {
        ...devices['Pixel 7'],
        baseURL: playwrightPreviewBaseUrl,
        serviceWorkers: 'allow',
      },
    },
  ],
  webServer: [
    {
      command: `bun run web:dev -- --host 127.0.0.1 --port ${playwrightPort} --strictPort`,
      url: playwrightBaseUrl,
      reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === 'true',
      timeout: 45_000,
    },
    {
      command: `bun run web:build && bun run web:preview -- --host 127.0.0.1 --port ${playwrightPreviewPort} --strictPort`,
      url: playwrightPreviewBaseUrl,
      reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === 'true',
      timeout: 180_000,
    },
  ],
})

export default config
