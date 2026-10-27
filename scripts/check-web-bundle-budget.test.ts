import { describe, expect, test } from 'bun:test'
import { checkBundleBudget, parseBundleBudget, readInitialAssetPaths } from './check-web-bundle-budget'

const budget = parseBundleBudget({
  rules: [
    { name: 'main JS', pattern: '^assets/main-[\\w-]+\\.js$', maxGzipKiB: 10 },
    { name: 'main CSS', pattern: '^assets/main-[\\w-]+\\.css$', maxGzipKiB: 2 },
  ],
  totalJavaScriptAndCssGzipKiB: 11,
  initialJavaScriptAndCssGzipKiB: 10,
})

const initialPaths = ['assets/main-a1.js', 'assets/main-a1.css']

describe('checkBundleBudget', () => {
  test('passes builds within every limit', () => {
    const report = checkBundleBudget([
      { path: 'assets/main-a1.js', gzipBytes: 8 * 1024 },
      { path: 'assets/main-a1.css', gzipBytes: 1024 },
      { path: 'index.html', gzipBytes: 400 },
    ], budget, initialPaths)

    expect(report.violations).toEqual([])
    expect(report.lines.slice(-2)).toEqual([
      'total JS and CSS: 9.0 / 11 KiB gzip',
      'initial JS and CSS: 9.0 / 10 KiB gzip',
    ])
  })

  test('reports a file over its rule and a total over the limit', () => {
    const report = checkBundleBudget([
      { path: 'assets/main-a1.js', gzipBytes: 10.5 * 1024 },
      { path: 'assets/main-a1.css', gzipBytes: 1.5 * 1024 },
    ], budget, initialPaths)

    expect(report.violations).toEqual([
      'assets/main-a1.js: 10.5 KiB gzip exceeds 10 KiB (main JS).',
      'Total JS and CSS 12.0 KiB gzip exceeds 11 KiB.',
      'Initial JS and CSS 12.0 KiB gzip exceeds 10 KiB.',
    ])
  })

  test('counts only files loaded before the first render toward the initial limit', () => {
    const lazyBudget = parseBundleBudget({
      rules: [
        { name: 'main JS', pattern: '^assets/main-[\\w-]+\\.js$', maxGzipKiB: 10 },
        { name: 'route chunk', pattern: '^assets/[\\w.-]+\\.js$', maxGzipKiB: 10 },
      ],
      totalJavaScriptAndCssGzipKiB: 20,
      initialJavaScriptAndCssGzipKiB: 8,
    })
    const files = [
      { path: 'assets/main-a1.js', gzipBytes: 5 * 1024 },
      { path: 'assets/vendor-b2.js', gzipBytes: 4 * 1024 },
      { path: 'assets/SettingsPage-c3.js', gzipBytes: 9 * 1024 },
    ]

    expect(checkBundleBudget(files, lazyBudget, ['assets/main-a1.js']).violations).toEqual([])
    // A shared chunk preloaded by index.html is part of the first render.
    expect(checkBundleBudget(files, lazyBudget, ['assets/main-a1.js', 'assets/vendor-b2.js']).violations)
      .toEqual(['Initial JS and CSS 9.0 KiB gzip exceeds 8 KiB.'])
    expect(checkBundleBudget(files, lazyBudget, ['assets/main-a1.js', 'assets/missing-d4.js']).violations)
      .toEqual(['assets/missing-d4.js: loaded by index.html but missing from the build output.'])
  })

  test('rejects a new JavaScript chunk without a budget rule', () => {
    const report = checkBundleBudget([
      { path: 'assets/main-a1.js', gzipBytes: 1024 },
      { path: 'assets/charts-b2.js', gzipBytes: 1024 },
      { path: 'assets/logo-c3.svg', gzipBytes: 50 * 1024 },
    ], budget, ['assets/main-a1.js'])

    expect(report.violations).toEqual(['assets/charts-b2.js: 1.0 KiB gzip has no budget rule.'])
  })
})

describe('readInitialAssetPaths', () => {
  test('lists scripts, module preloads, and stylesheets from the built page', () => {
    const html = [
      '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
      '<link rel="manifest" href="/manifest.webmanifest" />',
      '<link rel="stylesheet" href="https://fonts.example.com/font.css">',
      '<script src="/theme-bootstrap.js"></script>',
      '<script type="module" crossorigin src="/assets/main-a1.js"></script>',
      '<link rel="modulepreload" crossorigin href="/assets/vendor-b2.js">',
      '<link rel="stylesheet" crossorigin href="/assets/main-a1.css">',
      '<script>window.inline = true</script>',
    ].join('\n')

    expect(readInitialAssetPaths(html)).toEqual([
      'theme-bootstrap.js',
      'assets/main-a1.js',
      'assets/vendor-b2.js',
      'assets/main-a1.css',
    ])
  })
})

describe('parseBundleBudget', () => {
  test('rejects malformed budgets', () => {
    expect(() => parseBundleBudget([])).toThrow('JSON object')
    expect(() => parseBundleBudget({ rules: [], totalJavaScriptAndCssGzipKiB: 1, initialJavaScriptAndCssGzipKiB: 1 })).toThrow('at least one rule')
    expect(() => parseBundleBudget({ rules: [{ name: 'x', pattern: '.', maxGzipKiB: 0 }], totalJavaScriptAndCssGzipKiB: 1, initialJavaScriptAndCssGzipKiB: 1 })).toThrow('positive maxGzipKiB')
    // JSON.parse turns 1e309 into Infinity, which would never flag an oversized file.
    expect(() => parseBundleBudget({ rules: [{ name: 'x', pattern: '.', maxGzipKiB: Number.POSITIVE_INFINITY }], totalJavaScriptAndCssGzipKiB: 1, initialJavaScriptAndCssGzipKiB: 1 })).toThrow('positive maxGzipKiB')
    expect(() => parseBundleBudget({ rules: [{ name: 'x', pattern: '.', maxGzipKiB: 1 }], totalJavaScriptAndCssGzipKiB: -1, initialJavaScriptAndCssGzipKiB: 1 })).toThrow('positive number')
    expect(() => parseBundleBudget({ rules: [{ name: 'x', pattern: '.', maxGzipKiB: 1 }], totalJavaScriptAndCssGzipKiB: 1 })).toThrow('initialJavaScriptAndCssGzipKiB')
  })
})
