import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Installability fields read from the web app manifest.
 */
type ManifestIcon = {
  /** Icon URL relative to the site root. */
  src: string
  /** Space-separated icon sizes. */
  sizes: string
  /** Icon purpose such as `any` or `maskable`. */
  purpose?: string
}

/**
 * Narrows an unknown manifest value to the fields this spec asserts.
 *
 * @param value - Parsed manifest JSON.
 * @returns Manifest fields, or `null` when the shape is invalid.
 */
function readManifest(value: unknown): { startUrl: unknown, scope: unknown, display: unknown, shareTarget: unknown, icons: ManifestIcon[] } | null {
  if (typeof value !== 'object' || value === null || !('icons' in value) || !Array.isArray(value.icons)) {
    return null
  }

  const icons: ManifestIcon[] = []

  for (const icon of value.icons) {
    if (typeof icon === 'object' && icon !== null && 'src' in icon && 'sizes' in icon
      && typeof icon.src === 'string' && typeof icon.sizes === 'string') {
      icons.push({
        src: icon.src,
        sizes: icon.sizes,
        purpose: 'purpose' in icon && typeof icon.purpose === 'string' ? icon.purpose : undefined,
      })
    }
  }

  return {
    startUrl: 'start_url' in value ? value.start_url : undefined,
    scope: 'scope' in value ? value.scope : undefined,
    display: 'display' in value ? value.display : undefined,
    shareTarget: 'share_target' in value ? value.share_target : undefined,
    icons,
  }
}

/**
 * Waits until the service worker controls the current page.
 *
 * @param page - Page that loaded a production build.
 */
async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration()

    return registration?.active?.state === 'activated' && navigator.serviceWorker.controller !== null
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('mukuroji.locale', 'ja')
  })
})

test('manifestはinstallに必要な項目とアイコンを公開する', async ({ page, request }) => {
  await page.goto('/support')

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(manifestHref).toBe('/manifest.webmanifest')
  // index.html declares one theme-color per color scheme; with the default light theme the
  // bootstrap points both at the light canvas so the browser chrome matches the page.
  const themeColors = page.locator('meta[name="theme-color"]')
  await expect(themeColors).toHaveCount(2)
  await expect(themeColors.and(page.locator('[media="(prefers-color-scheme: light)"]'))).toHaveAttribute('content', '#f7f9f8')
  await expect(themeColors.and(page.locator('[media="(prefers-color-scheme: dark)"]'))).toHaveAttribute('content', '#f7f9f8')

  const manifestResponse = await request.get('/manifest.webmanifest')
  expect(manifestResponse.ok()).toBe(true)
  const manifest = readManifest(await manifestResponse.json())

  expect(manifest).not.toBeNull()
  expect(manifest?.startUrl).toBe('/home')
  expect(manifest?.scope).toBe('/')
  expect(manifest?.display).toBe('standalone')
  // The worker keeps shared content out of the URL and opens the confirmation form.
  expect(manifest?.shareTarget).toEqual({
    action: '/share',
    method: 'POST',
    enctype: 'multipart/form-data',
    params: { title: 'title', text: 'text', url: 'url' },
  })
  expect(manifest?.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
  expect(manifest?.icons.some((icon) => icon.purpose === 'maskable')).toBe(true)

  for (const icon of manifest?.icons ?? []) {
    const iconResponse = await request.get(icon.src)
    expect(iconResponse.ok(), icon.src).toBe(true)
    expect(iconResponse.headers()['content-type']).toContain('image/png')
  }
})

test('接続が切れると画面下部にオフラインの案内を出し、復帰すると消して読み上げる', async ({ page, context }) => {
  await page.goto('/support')
  await expect(page.getByTestId('connectivity-notice')).toHaveCount(0)

  await context.setOffline(true)
  await expect(page.getByTestId('connectivity-notice')).toContainText('オフラインです。')
  await expect(page.getByTestId('live-announcer-polite')).toContainText('オフラインです。')

  await context.setOffline(false)
  await expect(page.getByTestId('connectivity-notice')).toHaveCount(0)
  await expect(page.getByTestId('live-announcer-polite')).toContainText('オンラインに戻りました。')
})

test('オフライン時のページ遷移は静的なオフラインページを表示し、オンライン復帰で再取得できる', async ({ page, context }) => {
  await page.goto('/support')
  await waitForServiceWorkerControl(page)

  await context.setOffline(true)
  await page.goto('/privacy')

  await expect(page.getByRole('heading', { level: 1, name: /オフラインです/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '再試行 / Retry' })).toBeVisible()
  // The icon, stylesheet, and script come from the shell cache, not inline markup or the network.
  await expect.poll(() => page.locator('main img').evaluate((image) => {
    return image instanceof HTMLImageElement ? image.naturalWidth : 0
  })).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: '再試行 / Retry' })).toHaveCSS('min-height', '44px')
  expect(await page.locator('script:not([src]), style').count()).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 0,
  )

  await expect(page).toHaveURL('/privacy')

  // Reconnecting fires the `online` event, which reloads the original URL without user action.
  await context.setOffline(false)

  await expect(page.getByRole('heading', { level: 1, name: 'プライバシーポリシー（ドラフト）' })).toBeVisible()
})

test('service workerはページやAPI応答を保存せず、静的なbuild成果物だけをcacheする', async ({ page }) => {
  await page.goto('/support')
  await waitForServiceWorkerControl(page)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  const cachedPaths = await page.evaluate(async () => {
    const paths: string[] = []

    for (const name of await caches.keys()) {
      const cache = await caches.open(name)

      for (const cachedRequest of await cache.keys()) {
        paths.push(new URL(cachedRequest.url).pathname)
      }
    }

    return paths
  })

  const offlineShellPaths = ['/offline.html', '/offline.css', '/offline.js', '/pwa-192x192.png']

  expect(cachedPaths).toEqual(expect.arrayContaining(offlineShellPaths))
  expect(cachedPaths.some((path) => path.startsWith('/assets/'))).toBe(true)

  for (const path of cachedPaths) {
    expect(offlineShellPaths.includes(path) || path.startsWith('/assets/'), path).toBe(true)
  }
})

test('共有された内容はURLに載せずworkerが端末内に保持し、確認画面へIDだけを渡す', async ({ page }) => {
  await page.goto('/support')
  await waitForServiceWorkerControl(page)

  // Submit the same multipart form the share sheet posts to the manifest share target.
  await page.evaluate(() => {
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = '/share'
    form.enctype = 'multipart/form-data'
    for (const [name, value] of [['title', 'Secret bug'], ['text', 'confidential details'], ['url', 'https://example.com/x']]) {
      const input = document.createElement('input')
      input.type = 'hidden'
      input.name = name
      input.value = value
      form.append(input)
    }
    document.body.append(form)
    form.submit()
  })

  // Signed out, the form sends the person to sign-in and keeps only the opaque ID for the return.
  await page.waitForURL((url) => url.pathname === '/' && (url.searchParams.get('returnTo') ?? '').startsWith('/share?shared='))
  const returnTo = new URL(page.url()).searchParams.get('returnTo') ?? ''
  expect(returnTo).toMatch(/^\/share\?shared=[0-9a-f-]{36}$/)
  expect(page.url()).not.toContain('confidential')
  expect(page.url()).not.toContain('Secret')

  const stored = await page.evaluate(async (id) => {
    const cache = await caches.open('mukuroji-share-inbox-v1')
    const response = await cache.match(`/__mukuroji/share/${id}`)
    return response ? await response.json() : null
  }, new URLSearchParams(returnTo.split('?')[1]).get('shared'))
  expect(stored).toMatchObject({ title: 'Secret bug', text: 'confidential details', url: 'https://example.com/x' })
})
