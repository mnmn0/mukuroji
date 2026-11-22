import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page, TestInfo } from '@playwright/test'

/** Repository root, used to resolve the summary file path. */
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))

/** Where the reference coverage summary is written; `coverage/` is not tracked. */
const summaryPath = resolve(repositoryRoot, 'coverage/real-server-smoke/web-js-coverage.json')

/** Number of least-covered files listed in the step summary. */
const listedFileCount = 10

/** One V8 JS coverage entry as Playwright returns it. */
type JsCoverageEntry = Awaited<ReturnType<Page['coverage']['stopJSCoverage']>>[number]

/** Byte coverage of one Web source module. */
export type FileCoverage = {
  /** Source path relative to `web/`. */
  path: string
  /** Bytes of the served module that ran at least once. */
  coveredBytes: number
  /** Bytes of the served module. */
  totalBytes: number
}

/** Reference coverage of the Web sources the smoke suite loaded. It is not a gate. */
export type CoverageSummary = {
  /** Bytes that ran at least once, summed over `files`. */
  coveredBytes: number
  /** Bytes served, summed over `files`. */
  totalBytes: number
  /** Covered share of `totalBytes` as a percentage with one decimal. */
  percent: number
  /** Per-module coverage, least covered first. */
  files: FileCoverage[]
}

/**
 * Reads the `web/src` module path from a Vite dev server URL.
 *
 * @param url - Script URL reported by V8.
 * @returns The path relative to `web/`, or undefined for dependencies and virtual modules.
 */
function readSourcePath(url: string): string | undefined {
  const pathname = URL.canParse(url) ? new URL(url).pathname : ''
  return pathname.startsWith('/src/') ? pathname.slice(1) : undefined
}

/**
 * Marks the bytes of a script that ran at least once.
 *
 * V8 reports nested ranges; a range with `count: 0` inside a function that ran marks code that did not run.
 * Painting the ranges in order, outermost first, leaves each byte with its innermost count.
 * Offsets count UTF-16 code units, which the summary calls bytes for brevity.
 *
 * @param entry - V8 coverage entry with the script source.
 * @returns One flag per byte of module code; 1 means the byte ran.
 */
function markCoveredBytes(entry: JsCoverageEntry): Uint8Array {
  const source = entry.source ?? ''
  // Vite appends an inline source map that the top-level range would count as covered code.
  const sourceMapStart = source.lastIndexOf('\n//# sourceMappingURL=')
  const covered = new Uint8Array(sourceMapStart >= 0 ? sourceMapStart : source.length)
  for (const fn of entry.functions) {
    for (const range of fn.ranges) {
      covered.fill(range.count > 0 ? 1 : 0, range.startOffset, Math.min(range.endOffset, covered.length))
    }
  }
  return covered
}

/**
 * Builds the reference summary from Playwright's JS coverage.
 *
 * @param entries - Entries from `page.coverage.stopJSCoverage()`.
 * @returns Coverage of the `web/src` modules that were loaded.
 */
export function summarizeJsCoverage(entries: JsCoverageEntry[]): CoverageSummary {
  const byPath = new Map<string, Uint8Array>()
  for (const entry of entries) {
    const path = readSourcePath(entry.url)
    if (!path) continue
    const covered = markCoveredBytes(entry)
    const existing = byPath.get(path)
    if (existing && existing.length === covered.length) {
      // A module loaded again after a full navigation adds the code that ran in that document.
      for (let index = 0; index < covered.length; index += 1) existing[index] = (existing[index] ?? 0) | (covered[index] ?? 0)
    } else if (!existing || covered.length > existing.length) {
      byPath.set(path, covered)
    }
  }
  const files = [...byPath].map(([path, covered]): FileCoverage => ({
    path,
    coveredBytes: covered.reduce((sum, value) => sum + value, 0),
    totalBytes: covered.length,
  })).sort((left, right) =>
    left.coveredBytes / Math.max(left.totalBytes, 1) - right.coveredBytes / Math.max(right.totalBytes, 1))
  const coveredBytes = files.reduce((sum, file) => sum + file.coveredBytes, 0)
  const totalBytes = files.reduce((sum, file) => sum + file.totalBytes, 0)
  const percent = totalBytes === 0 ? 0 : Math.round((coveredBytes / totalBytes) * 1_000) / 10
  return { coveredBytes, totalBytes, percent, files }
}

/**
 * Writes the summary to `coverage/`, attaches it to the Playwright report, and prints one line.
 * In GitHub Actions it also appends a table to the job summary. Nothing here fails the test.
 *
 * @param summary - Reference coverage summary.
 * @param testInfo - Test that collected the coverage.
 */
export async function publishCoverageSummary(summary: CoverageSummary, testInfo: TestInfo): Promise<void> {
  const body = `${JSON.stringify(summary, null, 2)}\n`
  await mkdir(dirname(summaryPath), { recursive: true })
  await writeFile(summaryPath, body)
  await testInfo.attach('web-js-coverage.json', { body, contentType: 'application/json' })
  const line = `Reference Web JS coverage (not a gate): ${summary.percent}% of ${summary.totalBytes} bytes in ${summary.files.length} web/src modules.`
  console.log(line)
  const stepSummary = process.env.GITHUB_STEP_SUMMARY
  if (stepSummary) {
    const rows = summary.files.slice(0, listedFileCount).map((file) =>
      `| \`${file.path}\` | ${(Math.round((file.coveredBytes / Math.max(file.totalBytes, 1)) * 1_000) / 10)}% |`)
    await appendFile(stepSummary, [
      '### Real-server smoke: reference coverage', '', line, '',
      '| Least covered module | Covered |', '| --- | --- |', ...rows, '',
    ].join('\n'))
  }
}
