import { describe, expect, test } from 'bun:test'
import {
  createProjectStatusReportOutline,
  isProjectStatusReportTimestamp,
  isProjectStatusReportWithinScope,
  parseProjectStatusReport,
  parseProjectStatusShareScope,
  parsePublicProjectStatusReportResponse,
  redactProjectStatusReport,
  renderProjectStatusReportMarkdown,
  type ProjectStatusReport,
  type ProjectStatusShareScope,
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

test('keeps the incomplete flag of the next actions and rejects a malformed one', () => {
  const incomplete = { ...report, nextActions: { items: [], hiddenCount: 0, incomplete: true } }
  expect(parseProjectStatusReport(incomplete)).toEqual({ ok: true, value: incomplete })
  expect(redactProjectStatusReport(incomplete, { sections: ['nextActions'], showPeopleNames: false }).nextActions)
    .toEqual({ items: [], hiddenCount: 0, incomplete: true })
  expect(parseProjectStatusReport({ ...report, nextActions: { items: [], hiddenCount: 0, incomplete: 'yes' } }).ok).toBe(false)
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
  expect(parsePublicProjectStatusReportResponse({ report, expiresAt: '2026-13-01T00:00:00Z' })).toBeUndefined()
})

test('accepts only timestamps that name a real date and time', () => {
  expect(isProjectStatusReportTimestamp('2026-11-24T03:00:00.000Z')).toBe(true)
  expect(isProjectStatusReportTimestamp('2026-11-24T03:00:00Z')).toBe(true)
  expect(isProjectStatusReportTimestamp('2026-02-30T00:00:00Z')).toBe(false)
  expect(isProjectStatusReportTimestamp('2026-11-24T24:00:00Z')).toBe(false)
  expect(isProjectStatusReportTimestamp('2026-11-24')).toBe(false)
})

test('tells whether a stored snapshot holds anything outside its share scope', () => {
  const scope: ProjectStatusShareScope = { sections: ['health', 'nextActions'], showPeopleNames: false }
  const redacted = redactProjectStatusReport(report, scope)
  expect(isProjectStatusReportWithinScope(redacted, scope)).toBe(true)
  expect(isProjectStatusReportWithinScope(report, scope)).toBe(false)
  if (!redacted.health) throw new Error('The redacted report keeps the health section.')
  expect(isProjectStatusReportWithinScope({ ...redacted, health: { ...redacted.health, authorName: '山田' } }, scope)).toBe(false)
})

test('keeps an action with a line break as one Markdown list item and marks notes', () => {
  const multiline: ProjectStatusReport = {
    ...report,
    nextActions: { items: [{ text: '確認する\n- 次回の候補', overdue: false }], hiddenCount: 1, incomplete: true },
  }
  const markdown = renderProjectStatusReportMarkdown(multiline)
  expect(markdown).toContain('- 確認する - 次回の候補')
  expect(markdown).not.toContain('\n- 次回の候補')
  const actions = createProjectStatusReportOutline(multiline).sections.find((section) => section.section === 'nextActions')
  expect(actions?.lines).toHaveLength(3)
  expect(actions?.noteCount).toBe(2)
})
