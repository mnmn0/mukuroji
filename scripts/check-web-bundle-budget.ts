import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

/**
 * Size limit for built files whose names match a pattern.
 */
export interface BundleBudgetRule {
  /** Human-readable rule name shown in reports. */
  readonly name: string
  /** Regular expression matched against the path relative to the build directory. */
  readonly pattern: string
  /** Maximum gzip size in KiB for each matching file. */
  readonly maxGzipKiB: number
}

/**
 * Committed Web performance budget.
 */
export interface BundleBudget {
  /** Rules checked in order; a file is checked by the first matching rule. */
  readonly rules: readonly BundleBudgetRule[]
  /** Maximum gzip size in KiB for all JavaScript and CSS files together. */
  readonly totalJavaScriptAndCssGzipKiB: number
}

/**
 * Measured size of one built file.
 */
export interface BuiltFileSize {
  /** Path relative to the build directory, using `/` separators. */
  readonly path: string
  /** Gzip size in bytes. */
  readonly gzipBytes: number
}

/**
 * Result of checking built files against the budget.
 */
export interface BundleBudgetReport {
  /** Human-readable lines describing each checked file and the total. */
  readonly lines: readonly string[]
  /** Budget violations; empty when the build is within budget. */
  readonly violations: readonly string[]
}

/**
 * Parses and validates the committed budget file.
 *
 * @param value - Parsed JSON content of the budget file.
 * @returns The validated budget.
 */
export function parseBundleBudget(value: unknown): BundleBudget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Bundle budget must be a JSON object.')
  }
  const rules: unknown = Reflect.get(value, 'rules')
  const total: unknown = Reflect.get(value, 'totalJavaScriptAndCssGzipKiB')
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('Bundle budget must define at least one rule.')
  }
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) {
    throw new Error('totalJavaScriptAndCssGzipKiB must be a positive number.')
  }
  return {
    rules: rules.map((rule: unknown, index) => {
      const name: unknown = typeof rule === 'object' && rule !== null ? Reflect.get(rule, 'name') : undefined
      const pattern: unknown = typeof rule === 'object' && rule !== null ? Reflect.get(rule, 'pattern') : undefined
      const maxGzipKiB: unknown = typeof rule === 'object' && rule !== null ? Reflect.get(rule, 'maxGzipKiB') : undefined
      if (typeof name !== 'string' || typeof pattern !== 'string' || typeof maxGzipKiB !== 'number' || maxGzipKiB <= 0) {
        throw new Error(`Bundle budget rule ${index} needs a name, pattern, and positive maxGzipKiB.`)
      }
      new RegExp(pattern, 'u')
      return { name, pattern, maxGzipKiB }
    }),
    totalJavaScriptAndCssGzipKiB: total,
  }
}

/**
 * Checks measured file sizes against the budget.
 *
 * Every JavaScript and CSS file must match a rule, so a new unbudgeted chunk fails
 * the check instead of growing silently.
 *
 * @param files - Measured built files.
 * @param budget - Committed budget.
 * @returns Report lines and violations.
 */
export function checkBundleBudget(
  files: readonly BuiltFileSize[],
  budget: BundleBudget,
): BundleBudgetReport {
  const lines: string[] = []
  const violations: string[] = []
  let totalBytes = 0
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const isCode = /\.(?:m?js|css)$/u.test(file.path)
    if (isCode) totalBytes += file.gzipBytes
    const rule = budget.rules.find((candidate) => new RegExp(candidate.pattern, 'u').test(file.path))
    const kib = file.gzipBytes / 1024
    if (!rule) {
      if (isCode) violations.push(`${file.path}: ${kib.toFixed(1)} KiB gzip has no budget rule.`)
      continue
    }
    lines.push(`${file.path}: ${kib.toFixed(1)} / ${rule.maxGzipKiB} KiB gzip (${rule.name})`)
    if (kib > rule.maxGzipKiB) {
      violations.push(`${file.path}: ${kib.toFixed(1)} KiB gzip exceeds ${rule.maxGzipKiB} KiB (${rule.name}).`)
    }
  }
  const totalKiB = totalBytes / 1024
  lines.push(`total JS and CSS: ${totalKiB.toFixed(1)} / ${budget.totalJavaScriptAndCssGzipKiB} KiB gzip`)
  if (totalKiB > budget.totalJavaScriptAndCssGzipKiB) {
    violations.push(`Total JS and CSS ${totalKiB.toFixed(1)} KiB gzip exceeds ${budget.totalJavaScriptAndCssGzipKiB} KiB.`)
  }
  return { lines, violations }
}

/**
 * Measures the gzip size of every file under a build directory.
 *
 * @param directory - Build output directory.
 * @returns Measured files with relative paths.
 */
export function measureBuiltFiles(directory: string): BuiltFileSize[] {
  const files: BuiltFileSize[] = []
  /**
   * Recursively records the gzip size of every file below a directory.
   *
   * @param current - Directory being visited.
   */
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
      } else {
        files.push({
          path: relative(directory, path).split('\\').join('/'),
          gzipBytes: gzipSync(readFileSync(path), { level: 9 }).byteLength,
        })
      }
    }
  }
  walk(directory)
  return files
}

if (import.meta.main) {
  const buildDirectory = process.argv[2] ?? 'web/dist'
  const budgetPath = process.argv[3] ?? 'web/performance-budget.json'
  const budgetJson: unknown = JSON.parse(readFileSync(budgetPath, 'utf8'))
  const report = checkBundleBudget(measureBuiltFiles(buildDirectory), parseBundleBudget(budgetJson))
  for (const line of report.lines) console.log(line)
  if (report.violations.length > 0) {
    for (const violation of report.violations) console.error(`Budget exceeded: ${violation}`)
    process.exit(1)
  }
  console.log('Web bundle is within the performance budget.')
}
