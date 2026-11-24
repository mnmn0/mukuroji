import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { getProjectDeliverables } from '../src/files/api/deliverables'
import {
  fileArtifactsControllerFixture,
  projectDeliverableFixtures,
  projectDeliverablesControllerFixture,
} from '../src/files/fixtures'
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
