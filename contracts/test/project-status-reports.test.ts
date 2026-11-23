import { describe, expect, test } from 'bun:test'
import {
  parseProjectStatusReport,
  parseProjectStatusShareScope,
  parsePublicProjectStatusReportResponse,
  redactProjectStatusReport,
  renderProjectStatusReportMarkdown,
  type ProjectStatusReport,
} from '../src/project-status-reports'

/** Report with a name in the update and in an action item. */
const report: ProjectStatusReport = {
  schemaVersion: 1,
  locale: 'ja',
  projectName: '基幹 *刷新*',
  teamName: 'コア',
  asOf: '2026-11-23T03:00:00.000Z',
  health: {
    health: 'on-track',
    risk: 'low',
    summary: '順調です。\n来週リリース。',
    publishedAt: '2026-11-22T09:00:00.000Z',
    authorName: '山田',
  },
  progress: {
    totalCount: 2,
    openCount: 1,
    inProgressCount: 1,
    doneCount: 1,
    completionRate: 50,
    overdueCount: 0,
    blockedCount: 0,
  },
  nextActions: {
    items: [{ text: '<script>', ownerName: '佐藤', overdue: true, dueDate: '2026-11-20' }],
    hiddenCount: 2,
  },
}

describe('parseProjectStatusReport', () => {
  test('rebuilds a report and drops unknown fields', () => {
    const parsed = parseProjectStatusReport({ ...report, extra: 'x', health: { ...report.health, email: 'a@example.com' } })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toEqual(report)
    expect(JSON.stringify(parsed.value)).not.toContain('example.com')
  })

  test('rejects out-of-range values, control characters, and too many rows', () => {
    expect(parseProjectStatusReport({ ...report, schemaVersion: 2 }).ok).toBe(false)
    expect(parseProjectStatusReport({ ...report, projectName: 'a\u0007' }).ok).toBe(false)
    expect(parseProjectStatusReport({ ...report, progress: { ...report.progress, completionRate: 120 } }).ok).toBe(false)
    expect(parseProjectStatusReport({
      ...report,
      nextActions: { hiddenCount: 0, items: Array.from({ length: 51 }, () => ({ text: 'a', overdue: false })) },
    }).ok).toBe(false)
  })
})

describe('share scope and redaction', () => {
  test('orders sections and rejects unknown ones', () => {
    expect(parseProjectStatusShareScope(['progress', 'health', 'progress'], false))
      .toEqual({ ok: true, value: { sections: ['health', 'progress'], showPeopleNames: false } })
    expect(parseProjectStatusShareScope(['budget'], false).ok).toBe(false)
    expect(parseProjectStatusShareScope([], true).ok).toBe(false)
    expect(parseProjectStatusShareScope(['health'], 'yes').ok).toBe(false)
  })

  test('keeps only chosen sections and removes names unless kept', () => {
    const hidden = redactProjectStatusReport(report, { sections: ['health', 'nextActions'], showPeopleNames: false })
    expect(hidden.progress).toBeUndefined()
    expect(hidden.health?.authorName).toBeUndefined()
    expect(hidden.nextActions?.items[0]?.ownerName).toBeUndefined()
    const shown = redactProjectStatusReport(report, { sections: ['nextActions'], showPeopleNames: true })
    expect(shown.health).toBeUndefined()
    expect(shown.nextActions?.items[0]?.ownerName).toBe('佐藤')
  })
})

test('renders Markdown with escaped report text', () => {
  const markdown = renderProjectStatusReportMarkdown(report)
  expect(markdown).toContain('# 基幹 \\*刷新\\* 進捗レポート')
  expect(markdown).toContain('## 状況')
  expect(markdown).toContain('- 順調です。')
  expect(markdown).toContain('\\<script\\>（期限 2026-11-20・超過） 担当: 佐藤')
  expect(markdown).toContain('- ほか 2件')
})

test('validates the public response', () => {
  expect(parsePublicProjectStatusReportResponse({ report, expiresAt: '2026-12-01T00:00:00.000Z' })?.report).toEqual(report)
  expect(parsePublicProjectStatusReportResponse({ report, expiresAt: 'soon' })).toBeUndefined()
})
