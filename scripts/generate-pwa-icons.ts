import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

/** One raster icon rendered from the brand mark. */
type IconVariant = {
  /** Output file name under `web/public`. */
  fileName: string
  /** Square edge length in CSS pixels. */
  size: number
  /** Fraction of the edge occupied by the mark; maskable icons keep it inside the 80% safe zone. */
  markScale: number
}

/** Background shared with the manifest `background_color` and `theme_color`. */
const iconBackground = '#f7f9f8'

/** Icons referenced by `manifest.webmanifest`, `index.html`, and `offline.html`. */
const iconVariants: IconVariant[] = [
  { fileName: 'pwa-192x192.png', size: 192, markScale: 0.78 },
  { fileName: 'pwa-512x512.png', size: 512, markScale: 0.78 },
  { fileName: 'pwa-maskable-512x512.png', size: 512, markScale: 0.6 },
  { fileName: 'apple-touch-icon.png', size: 180, markScale: 0.74 },
]

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceSvgPath = resolve(repositoryRoot, 'web/src/assets/mukuroji-icon.svg')
const outputDirectory = resolve(repositoryRoot, 'web/public')

/**
 * Renders every PWA icon from the brand SVG with headless Chromium.
 *
 * Set `PWA_ICON_CHROMIUM_PATH` to use a system Chromium instead of the Playwright download.
 *
 * @returns A promise that settles once every icon is written.
 */
async function generatePwaIcons(): Promise<void> {
  const svg = await readFile(sourceSvgPath)
  const markUrl = `data:image/svg+xml;base64,${svg.toString('base64')}`
  const executablePath = process.env.PWA_ICON_CHROMIUM_PATH
  const browser = await chromium.launch(executablePath ? { executablePath } : {})

  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 })

    for (const variant of iconVariants) {
      const markSize = Math.round(variant.size * variant.markScale)

      await page.setViewportSize({ width: variant.size, height: variant.size })
      await page.setContent(
        `<body style="margin:0;width:${variant.size}px;height:${variant.size}px;background:${iconBackground};`
        + 'display:flex;align-items:center;justify-content:center">'
        + `<img src="${markUrl}" alt="" style="width:${markSize}px;height:${markSize}px;object-fit:contain"></body>`,
      )
      await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete))
      await page.screenshot({ path: resolve(outputDirectory, variant.fileName) })
    }
  } finally {
    await browser.close()
  }
}

await generatePwaIcons()
