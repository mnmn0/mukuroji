import { defineConfig, devices } from '@playwright/test'

const visualPort = 6007
const visualBaseUrl = `http://127.0.0.1:${visualPort}`

/**
 * Visual regression settings for Storybook screenshots in light and dark themes.
 *
 * Baselines are rendered in the `mcr.microsoft.com/playwright` container that CI
 * also uses, so font and rasterization differences between machines do not cause
 * failures. Build Storybook with `bun run web:build-storybook` first.
 */
const config = defineConfig({
  testDir: './web/visual',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-visual-report' }]],
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.002,
    },
  },
  use: {
    baseURL: visualBaseUrl,
    timezoneId: 'Asia/Tokyo',
    locale: 'ja-JP',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } },
    },
  ],
  webServer: {
    command: `bun scripts/serve-static-directory.ts web/storybook-static ${visualPort}`,
    url: `${visualBaseUrl}/iframe.html`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})

export default config
