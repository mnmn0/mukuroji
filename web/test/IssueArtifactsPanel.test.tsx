import { describe, expect, test } from 'bun:test'
import type { FileAttachment } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { IssueArtifactsPanel } from '../src/files/IssueArtifactsPanel'
import {
  blockedVideoFileFixture,
  fileArtifactsControllerFixture,
  imageFileFixture,
  scanningPdfFileFixture,
} from '../src/files/fixtures'
import { collaborationWorkspaceMemberFixtures } from '../src/issues/fixtures'

describe('IssueArtifactsPanel', () => {
  test('shows version, scan status, and reviewer actions from server capabilities', () => {
    const html = renderToStaticMarkup(
      <IssueArtifactsPanel
        controller={fileArtifactsControllerFixture}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).toContain('launch-hero.png')
    expect(html).toContain('Version 2')
    expect(html).toContain('Scanning')
    expect(html).toContain('Blocked')
    expect(html).toContain('Approve')
    expect(html).toContain('Request changes')
  })

  test('does not expose upload, replacement, or delete actions in read-only mode', () => {
    const readOnlyFile = {
      ...imageFileFixture,
      capabilities: {
        canAnnotate: false,
        canDelete: false,
        canDownload: true,
        canRequestApproval: false,
        canUploadVersion: false,
      },
    }
    const html = renderToStaticMarkup(
      <IssueArtifactsPanel
        controller={{
          ...fileArtifactsControllerFixture,
          approvals: [],
          capabilities: { canRequestApproval: false, canUpload: false },
          files: [readOnlyFile],
        }}
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).not.toContain('Upload files')
    expect(html).not.toContain('data-testid="file-upload-input"')
    expect(html).not.toContain('data-testid="file-version-upload-input"')
    expect(html).not.toContain('New version')
    expect(html).not.toContain('>Delete<')
    expect(html).toContain('Download')
  })

  test('keeps scanning and blocked files unavailable for preview and download', () => {
    const html = renderToStaticMarkup(
      <IssueArtifactsPanel
        controller={{
          ...fileArtifactsControllerFixture,
          approvals: [],
          files: [scanningPdfFileFixture, blockedVideoFileFixture],
        }}
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    for (const [fileId, status] of [
      [scanningPdfFileFixture.id, 'Scanning'],
      [blockedVideoFileFixture.id, 'Blocked'],
    ] as const) {
      const rowStart = html.indexOf(`data-testid="file-row-${fileId}"`)
      const rowEnd = html.indexOf('</article>', rowStart)
      const rowHtml = html.slice(rowStart, rowEnd)

      expect(rowStart).toBeGreaterThanOrEqual(0)
      expect(rowEnd).toBeGreaterThan(rowStart)
      expect(rowHtml).toContain(status)
      expect(rowHtml).toMatch(/<button[^>]*disabled=""[^>]*>Preview<\/button>/)
      expect(rowHtml).toMatch(/<button[^>]*disabled=""[^>]*>Download<\/button>/)
    }
  })

  test('opens and downloads a clean older version while the latest version is blocked', () => {
    const latestBlockedFile = {
      ...imageFileFixture,
      currentVersion: {
        ...imageFileFixture.currentVersion,
        id: 'version-image-3',
        number: 3,
        scanStatus: 'blocked',
      },
      versionCount: 3,
      versions: [
        {
          ...imageFileFixture.currentVersion,
          id: 'version-image-3',
          number: 3,
          scanStatus: 'blocked',
        },
        ...imageFileFixture.versions,
      ],
    } satisfies FileAttachment
    const html = renderToStaticMarkup(
      <IssueArtifactsPanel
        controller={{
          ...fileArtifactsControllerFixture,
          approvals: [],
          files: [latestBlockedFile],
        }}
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )
    const previewButton = html.match(/<button[^>]*>Preview · Version 2<\/button>/)?.[0]
    const downloadButton = html.match(/<button[^>]*>Download · Version 2<\/button>/)?.[0]

    expect(previewButton).toBeDefined()
    expect(previewButton).not.toContain(' disabled=""')
    expect(downloadButton).toBeDefined()
    expect(downloadButton).not.toContain(' disabled=""')
  })

  test('only exposes guest sharing when the collection grants that capability', () => {
    const html = renderToStaticMarkup(
      <IssueArtifactsPanel
        controller={{
          ...fileArtifactsControllerFixture,
          capabilities: { canRequestApproval: true, canUpload: true },
        }}
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).toContain('Upload files')
    expect(html).not.toContain('Allow guest access')
  })

  test('lets the requester or an explicit canceller cancel a pending approval', () => {
    const requesterHtml = renderToStaticMarkup(
      <IssueArtifactsPanel
        controller={fileArtifactsControllerFixture}
        currentMemberKey="sato@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )
    const capabilityHtml = renderToStaticMarkup(
      <IssueArtifactsPanel
        controller={{
          ...fileArtifactsControllerFixture,
          approvals: [{
            ...fileArtifactsControllerFixture.approvals[0],
            capabilities: { canCancel: true, canDecide: false },
          }],
        }}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(requesterHtml).toContain('Cancel request')
    expect(capabilityHtml).toContain('Cancel request')
  })

  test('renders an automation-created Work Item approval without a file subject', () => {
    const html = renderToStaticMarkup(
      <IssueArtifactsPanel
        controller={{
          ...fileArtifactsControllerFixture,
          approvals: [{
            id: 'approval-work-item-1',
            subjectType: 'work-item',
            revision: 1,
            status: 'pending',
            reviewers: [{ memberKey: 'demo@example.com', status: 'pending' }],
            dueAt: '2026-07-17T00:00:00.000Z',
            requestedByMemberKey: 'automation:rule-1',
            requestedByKind: 'service',
            createdAt: '2026-07-16T00:00:00.000Z',
            updatedAt: '2026-07-16T00:00:00.000Z',
            capabilities: { canCancel: false, canDecide: true },
          }],
          files: [],
        }}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).toContain('Work Item')
    expect(html).toContain('Requested by: Automation')
    expect(html).toContain('Approve')
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('Cancel request')
  })
})
