import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SWRConfig } from 'swr'
import { getProjectDeliverables } from '../src/files/api/deliverables'
import {
  fileAnnotationFixtures,
  fileArtifactsControllerFixture,
  imageFileFixture,
  projectDeliverableFixtures,
  projectDeliverablesControllerFixture,
} from '../src/files/fixtures'
import { useFileArtifacts, type FileArtifactsController } from '../src/files/mutations/useFileArtifacts'
import { createProjectDeliverablesCsv } from '../src/files/model/projectDeliverables'
import { loadAllProjectDeliverables } from '../src/files/queries/useProjectDeliverables'
import { IssueArtifactsPanel } from '../src/files/ui/IssueArtifactsPanel'
import { ProjectDeliverablesPanel } from '../src/files/ui/ProjectDeliverablesPanel'
import { collaborationWorkspaceMemberFixtures } from '../src/issues/fixtures'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Project deliverables', () => {
  test('requests a filtered page and rejects a malformed response', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ deliverables: projectDeliverableFixtures, nextCursor: 'next' }), {
        status: 200,
      })
    }) as typeof fetch

    const page = await getProjectDeliverables('core', 'project/1', 'token', {
      approval: 'unapproved',
      unresolvedOnly: true,
      cursor: 'cursor-1',
    })

    expect(urls).toEqual([
      '/api/teams/core/projects/project%2F1/deliverables?approval=unapproved&unresolvedOnly=true&cursor=cursor-1',
    ])
    expect(page.nextCursor).toBe('next')
    expect(page.deliverables).toHaveLength(projectDeliverableFixtures.length)

    globalThis.fetch = (async () => new Response(JSON.stringify({ deliverables: [{ file: {} }] }))) as typeof fetch
    await expect(getProjectDeliverables('core', 'project-1', 'token', { approval: 'all', unresolvedOnly: false }))
      .rejects.toMatchObject({ status: 502 })
  })

  test('reads every page for the CSV export', async () => {
    const cursors: Array<string | null> = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const cursor = new URL(String(input), 'https://app.example.test').searchParams.get('cursor')
      cursors.push(cursor)
      return new Response(JSON.stringify(cursor
        ? { deliverables: projectDeliverableFixtures.slice(1) }
        : { deliverables: projectDeliverableFixtures.slice(0, 1), nextCursor: 'page-2' }))
    }) as typeof fetch

    const deliverables = await loadAllProjectDeliverables('core', 'refero', 'token', {
      approval: 'all',
      unresolvedOnly: false,
    })

    expect(cursors).toEqual([null, 'page-2'])
    expect(deliverables.map((deliverable) => deliverable.file.id))
      .toEqual(projectDeliverableFixtures.map((deliverable) => deliverable.file.id))
  })

  test('rejects a page whose row lacks a field the list or the CSV reads', async () => {
    const [workItemRow, projectRow] = projectDeliverableFixtures
    const fileWithoutUpdatedAt = Object.fromEntries(
      Object.entries(workItemRow!.file).filter(([key]) => key !== 'updatedAt'),
    )
    const ownerWithoutTitle = Object.fromEntries(
      Object.entries(workItemRow!.owner).filter(([key]) => key !== 'title'),
    )
    const malformedRows: unknown[] = [
      { ...workItemRow, file: fileWithoutUpdatedAt },
      { ...workItemRow, file: { ...workItemRow!.file, currentVersion: {} } },
      { ...workItemRow, file: { ...workItemRow!.file, currentVersion: { ...workItemRow!.file.currentVersion, number: '1' } } },
      { ...workItemRow, file: { ...workItemRow!.file, currentVersion: { ...workItemRow!.file.currentVersion, scanStatus: 'unknown' } } },
      { ...workItemRow, owner: ownerWithoutTitle },
      { ...workItemRow, owner: { ...workItemRow!.owner, issueId: undefined } },
      { ...projectRow, owner: { kind: 'project', teamId: 'core-team' } },
      { ...workItemRow, approvalState: 'archived' },
      { ...workItemRow, unresolvedAnnotationCount: -1 },
    ]
    for (const row of malformedRows) {
      globalThis.fetch = (async () => new Response(JSON.stringify({ deliverables: [projectRow, row] }))) as typeof fetch
      await expect(getProjectDeliverables('core', 'project-1', 'token', { approval: 'all', unresolvedOnly: false }))
        .rejects.toMatchObject({ status: 502, code: 'InvalidDeliverableResponse' })
    }
  })

  test('reads a long continuation to its end and stops on a repeated cursor', async () => {
    const pageCount = 150
    let requests = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests += 1
      const cursor = new URL(String(input), 'https://app.example.test').searchParams.get('cursor')
      const index = cursor ? Number(cursor.replace('page-', '')) : 0
      return new Response(JSON.stringify(index + 1 < pageCount
        ? { deliverables: [], nextCursor: `page-${index + 1}` }
        : { deliverables: projectDeliverableFixtures.slice(0, 1) }))
    }) as typeof fetch

    const deliverables = await loadAllProjectDeliverables('core', 'refero', 'token', {
      approval: 'all',
      unresolvedOnly: false,
    })
    expect(requests).toBe(pageCount)
    expect(deliverables).toHaveLength(1)

    requests = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests += 1
      const cursor = new URL(String(input), 'https://app.example.test').searchParams.get('cursor')
      return new Response(JSON.stringify({ deliverables: [], nextCursor: cursor === 'page-1' ? 'page-2' : 'page-1' }))
    }) as typeof fetch
    await expect(loadAllProjectDeliverables('core', 'refero', 'token', { approval: 'all', unresolvedOnly: false }))
      .rejects.toThrow('repeated cursor')
    expect(requests).toBe(3)
  })

  test('exports owner, version, approval, and open comments with spreadsheet-safe cells', () => {
    const csv = createProjectDeliverablesCsv([
      ...projectDeliverableFixtures.slice(0, 2),
      { ...projectDeliverableFixtures[2]!, file: { ...projectDeliverableFixtures[2]!.file, name: '=cmd.mp4' } },
    ], {
      headers: {
        file: 'File',
        owner: 'Owner',
        version: 'Version',
        scan: 'Scan',
        approval: 'Approval',
        annotations: 'Open',
        updatedAt: 'Updated',
      },
      owner: (owner) => owner.kind === 'project' ? 'Project' : `${owner.key ?? ''}:${owner.title}`,
      scan: (status) => status,
      approval: (state) => state,
    })
    const lines = csv.trimEnd().split('\r\n')

    expect(lines[0]).toBe('"File","Owner","Version","Scan","Approval","Open","Updated"')
    expect(lines[1]).toContain('"launch-hero.png","CORE-12:初回オンボーディングの離脱要因を減らす","v2"')
    expect(lines[1]).toContain('"pending","1"')
    expect(lines[2]).toContain('"Project"')
    expect(lines[3]).toContain('"\'=cmd.mp4"')
  })

  test('shows rows, filters, and paging of the deliverables list', () => {
    const html = renderToStaticMarkup(
      <ProjectDeliverablesPanel
        controller={projectDeliverablesControllerFixture}
        exportFileName="refero-deliverables"
        locale="en"
        onDownloadCsv={() => undefined}
      />,
    )

    expect(html).toContain('Deliverables')
    expect(html).toContain('CORE-12 初回オンボーディングの離脱要因を減らす')
    expect(html).toContain('project-plan.pdf')
    expect(html).toContain('Awaiting decision')
    expect(html).toContain('Not requested')
    expect(html).toContain('Not approved')
    expect(html).toContain('Load more')
    expect(html).toContain('Export CSV')

    const emptyHtml = renderToStaticMarkup(
      <ProjectDeliverablesPanel
        controller={{ ...projectDeliverablesControllerFixture, deliverables: [], hasMore: false }}
        exportFileName="refero-deliverables"
        locale="en"
        onDownloadCsv={() => undefined}
      />,
    )
    expect(emptyHtml).toContain('No deliverables match the filters.')
    expect(emptyHtml).not.toContain('Load more')
  })

  test('offers a retry that keeps loaded rows and asks for a Team when none is chosen', () => {
    const failedHtml = renderToStaticMarkup(
      <ProjectDeliverablesPanel
        controller={{ ...projectDeliverablesControllerFixture, hasError: true, hasMore: false }}
        exportFileName="refero-deliverables"
        locale="en"
        onDownloadCsv={() => undefined}
      />,
    )
    expect(failedHtml).toContain('project-plan.pdf')
    expect(failedHtml).toContain('Could not load deliverables.')
    expect(failedHtml).toContain('>Retry</button>')

    const unscopedHtml = renderToStaticMarkup(
      <ProjectDeliverablesPanel
        controller={{ ...projectDeliverablesControllerFixture, deliverables: [], hasMore: false, isScoped: false }}
        exportFileName="refero-deliverables"
        locale="en"
        onDownloadCsv={() => undefined}
      />,
    )
    expect(unscopedHtml).toContain('Deliverables appear once the Team is known.')
    expect(unscopedHtml).not.toContain('No deliverables match the filters.')
  })

  test('reloads the files and the deliverables after a new annotation', async () => {
    const requests: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      requests.push(`${method} ${String(input)}`)
      return new Response(JSON.stringify(method === 'POST'
        ? { annotation: fileAnnotationFixtures[0] }
        : { files: [], approvals: [], capabilities: { canUpload: true, canRequestApproval: true, canGrantGuestAccess: false } }))
    }) as typeof fetch
    let deliverableRefreshes = 0
    let controller: FileArtifactsController | undefined

    /** Captures the file controller of a Project scope. */
    function ControllerProbe() {
      controller = useFileArtifacts({
        accessToken: 'token',
        onRefreshed: () => {
          deliverableRefreshes += 1
        },
        scope: { kind: 'project', teamId: 'core', projectId: 'refero' },
      })
      return null
    }
    renderToStaticMarkup(
      <SWRConfig value={{ provider: () => new Map(), revalidateOnMount: false }}>
        <ControllerProbe />
      </SWRConfig>,
    )
    if (!controller) throw new Error('The file controller was not rendered.')

    const annotation = await controller.createAnnotation(imageFileFixture, imageFileFixture.currentVersion, {
      anchor: { kind: 'image', x: 0.5, y: 0.5 },
      bodyMarkdown: 'Check the contrast.',
    })

    expect(annotation?.id).toBe(fileAnnotationFixtures[0]!.id)
    expect(requests[0]).toStartWith('POST /api/teams/core/projects/refero/files/')
    // The file collection reload ends by reloading the deliverables list.
    expect(deliverableRefreshes).toBe(1)
  })

  test('treats an annotation that is already gone as deleted and reloads the lists', async () => {
    const requests: string[] = []
    let deleteStatus = 404
    let deleteCode = 'AnnotationNotFound'
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      requests.push(`${method} ${String(input)}`)
      if (method === 'DELETE') {
        return new Response(JSON.stringify({ code: deleteCode, message: 'gone' }), { status: deleteStatus })
      }
      return new Response(JSON.stringify(
        { files: [], approvals: [], capabilities: { canUpload: true, canRequestApproval: true, canGrantGuestAccess: false } },
      ))
    }) as typeof fetch
    let deliverableRefreshes = 0
    let controller: FileArtifactsController | undefined

    /** Captures the file controller of a Project scope. */
    function ControllerProbe() {
      controller = useFileArtifacts({
        accessToken: 'token',
        onRefreshed: () => {
          deliverableRefreshes += 1
        },
        scope: { kind: 'project', teamId: 'core', projectId: 'refero' },
      })
      return null
    }
    renderToStaticMarkup(
      <SWRConfig value={{ provider: () => new Map(), revalidateOnMount: false }}>
        <ControllerProbe />
      </SWRConfig>,
    )
    if (!controller) throw new Error('The file controller was not rendered.')

    const annotation = fileAnnotationFixtures[0]!
    expect(await controller.deleteAnnotation(imageFileFixture, imageFileFixture.currentVersion, annotation))
      .toBe(true)
    expect(requests).toEqual([
      `DELETE /api/teams/core/projects/refero/files/${imageFileFixture.id}/versions/${imageFileFixture.currentVersion.id}/annotations/${annotation.id}`,
    ])
    // The file collection reload ends by reloading the deliverables list.
    expect(deliverableRefreshes).toBe(1)

    // Another failure is still a failure and reloads nothing.
    deleteStatus = 403
    deleteCode = 'AnnotationDeleteDenied'
    const originalConsoleError = console.error
    console.error = () => undefined
    try {
      expect(await controller.deleteAnnotation(imageFileFixture, imageFileFixture.currentVersion, annotation))
        .toBe(false)
    } finally {
      console.error = originalConsoleError
    }
    expect(deliverableRefreshes).toBe(1)
  })

  test('shows open review comments on files and approval requests', () => {
    const html = renderToStaticMarkup(
      <IssueArtifactsPanel
        controller={{
          ...fileArtifactsControllerFixture,
          files: fileArtifactsControllerFixture.files.map((file, index) =>
            index === 0 ? { ...file, unresolvedAnnotationCount: 2 } : file
          ),
        }}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).toContain('2 open comments')
    expect(html).toContain('data-testid="approval-unresolved-approval-launch-hero"')
  })
})
