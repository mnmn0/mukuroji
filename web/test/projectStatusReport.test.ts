import { describe, expect, test } from 'bun:test'
import { parseProjectStatusReport } from '@mukuroji/contracts'
import { readZipArchive } from '../src/developer-platform/model/zipArchive'
import {
  buildProjectStatusReport,
  createProjectStatusReportFileName,
  createProjectStatusReportSlides,
  type ProjectStatusReportSource,
} from '../src/projects/model/projectStatusReport'

/** Overview data of one Project, with a member who has no display name. */
const source: ProjectStatusReportSource = {
  locale: 'ja',
  projectName: '基幹刷新',
  teamName: 'コアチーム',
  asOf: new Date('2026-11-23T03:00:00.000Z'),
  updateTarget: {
    target: { type: 'project', teamId: 't', projectId: 'p' },
    updateState: 'current',
    latestVersion: 2,
    updatedAt: '2026-11-22T09:00:00.000Z',
    latestUpdate: {
      id: 'u',
      version: 2,
      health: 'at-risk',
      risk: 'medium',
      summary: '結合試験が遅れています。',
      progressSnapshot: { percent: 40, linkedWorkItemCount: 10 },
      authorMemberKey: 'member-1',
      coveredDueAt: '2026-11-22T09:00:00.000Z',
      createdAt: '2026-11-22T09:00:00.000Z',
    },
  },
  schedule: {
    items: [{
      id: 'm',
      type: 'milestone',
      title: '結合試験完了',
      status: 'active',
      health: 'at-risk',
      progress: 60.4,
      forecastEndDate: '2026-12-08',
      baselineEndDate: '2026-12-01',
      delayDays: 7,
    }],
    hiddenCount: 0,
    delayedCount: 1,
  },
  actionItems: {
    items: [
      { documentId: 'd', documentTitle: '議事録', blockId: 'b', itemId: 'i1', text: '環境を増強する', assigneeMemberKey: 'member-1', dueDate: '2026-11-30', overdue: false, ownerLabel: '山田 花子' },
      { documentId: 'd', documentTitle: '議事録', blockId: 'b', itemId: 'i2', text: 'ベンダーに連絡', assigneeMemberKey: 'member-2', overdue: false, ownerLabel: 'nameless@example.com' },
    ],
    hiddenCount: 0,
    failedDocumentCount: 0,
    hasUnscannedDocuments: false,
  },
  members: [
    { id: 'member-1', email: 'hanako@example.com', name: '山田 花子', workspaceStatus: 'active', role: 'member', updatedAt: '2026-11-01T00:00:00.000Z' },
    { id: 'member-2', email: 'nameless@example.com', workspaceStatus: 'active', role: 'member', updatedAt: '2026-11-01T00:00:00.000Z' },
  ],
}

describe('buildProjectStatusReport', () => {
  test('builds a valid report that names people only by display name', () => {
    const report = buildProjectStatusReport(source)
    expect(parseProjectStatusReport(report)).toEqual({ ok: true, value: report })
    expect(report.health).toMatchObject({ health: 'at-risk', authorName: '山田 花子' })
    expect(report.schedule?.items[0]?.progress).toBe(60)
    expect(report.nextActions?.items).toEqual([
      { text: '環境を増強する', dueDate: '2026-11-30', ownerName: '山田 花子', overdue: false },
      { text: 'ベンダーに連絡', overdue: false },
    ])
    expect(JSON.stringify(report)).not.toContain('example.com')
    expect(report.progress).toBeUndefined()
    expect(report.risks).toBeUndefined()
  })
})

test('writes a one-slide PowerPoint package with the report text', async () => {
  const report = buildProjectStatusReport(source)
  const entries = await readZipArchive(createProjectStatusReportSlides(report), {
    maxEntries: 50,
    maxEntryBytes: 1_000_000,
    maxTotalBytes: 5_000_000,
  })
  expect([...entries.keys()]).toEqual(expect.arrayContaining([
    '[Content_Types].xml',
    '_rels/.rels',
    'ppt/presentation.xml',
    'ppt/slides/slide1.xml',
    'ppt/slideLayouts/slideLayout1.xml',
    'ppt/slideMasters/slideMaster1.xml',
    'ppt/theme/theme1.xml',
  ]))
  const slide = new TextDecoder().decode(entries.get('ppt/slides/slide1.xml'))
  expect(slide).toContain('基幹刷新 進捗レポート')
  expect(slide).toContain('結合試験完了')
  expect(createProjectStatusReportFileName(report, 'pptx')).toBe('基幹刷新-status-2026-11-23.pptx')
})
