import { describe, expect, test } from 'bun:test'
import { checkBundleBudget, parseBundleBudget } from './check-web-bundle-budget'

const budget = parseBundleBudget({
  rules: [
    { name: 'main JS', pattern: '^assets/main-[\\w-]+\\.js$', maxGzipKiB: 10 },
    { name: 'main CSS', pattern: '^assets/main-[\\w-]+\\.css$', maxGzipKiB: 2 },
  ],
  totalJavaScriptAndCssGzipKiB: 11,
})

describe('checkBundleBudget', () => {
  test('passes builds within every limit', () => {
    const report = checkBundleBudget([
      { path: 'assets/main-a1.js', gzipBytes: 8 * 1024 },
      { path: 'assets/main-a1.css', gzipBytes: 1024 },
      { path: 'index.html', gzipBytes: 400 },
    ], budget)

    expect(report.violations).toEqual([])
    expect(report.lines.at(-1)).toBe('total JS and CSS: 9.0 / 11 KiB gzip')
  })

  test('reports a file over its rule and a total over the limit', () => {
    const report = checkBundleBudget([
      { path: 'assets/main-a1.js', gzipBytes: 10.5 * 1024 },
      { path: 'assets/main-a1.css', gzipBytes: 1.5 * 1024 },
    ], budget)

    expect(report.violations).toEqual([
      'assets/main-a1.js: 10.5 KiB gzip exceeds 10 KiB (main JS).',
      'Total JS and CSS 12.0 KiB gzip exceeds 11 KiB.',
    ])
  })

  test('rejects a new JavaScript chunk without a budget rule', () => {
    const report = checkBundleBudget([
      { path: 'assets/main-a1.js', gzipBytes: 1024 },
      { path: 'assets/charts-b2.js', gzipBytes: 1024 },
      { path: 'assets/logo-c3.svg', gzipBytes: 50 * 1024 },
    ], budget)

    expect(report.violations).toEqual(['assets/charts-b2.js: 1.0 KiB gzip has no budget rule.'])
  })
})

describe('parseBundleBudget', () => {
  test('rejects malformed budgets', () => {
    expect(() => parseBundleBudget([])).toThrow('JSON object')
    expect(() => parseBundleBudget({ rules: [], totalJavaScriptAndCssGzipKiB: 1 })).toThrow('at least one rule')
    expect(() => parseBundleBudget({ rules: [{ name: 'x', pattern: '.', maxGzipKiB: 0 }], totalJavaScriptAndCssGzipKiB: 1 })).toThrow('positive maxGzipKiB')
    // JSON.parse turns 1e309 into Infinity, which would never flag an oversized file.
    expect(() => parseBundleBudget({ rules: [{ name: 'x', pattern: '.', maxGzipKiB: Number.POSITIVE_INFINITY }], totalJavaScriptAndCssGzipKiB: 1 })).toThrow('positive maxGzipKiB')
    expect(() => parseBundleBudget({ rules: [{ name: 'x', pattern: '.', maxGzipKiB: 1 }], totalJavaScriptAndCssGzipKiB: -1 })).toThrow('positive number')
  })
})
