import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  WorkItemExternalLinksPanel,
} from '../src/work-items/ui/WorkItemExternalLinksPanel'
import { createWorkItemExternalLinksLabels } from '../src/work-items/ui/externalLinkLabels'
import {
  externalLinkInstallationFixtures,
  externalWorkItemLinkFixtures,
} from '../src/work-items/externalLinksFixtures'

const labels = createWorkItemExternalLinksLabels('en')

describe('WorkItemExternalLinksPanel', () => {
  test('shows every linked source, account, status, and direction control', () => {
    const html = renderToStaticMarkup(
      <WorkItemExternalLinksPanel
        canManage
        installations={externalLinkInstallationFixtures}
        labels={labels}
        links={externalWorkItemLinkFixtures}
        onCreate={async () => undefined}
        onUnlink={async () => undefined}
        onUpdateDirection={async () => undefined}
      />,
    )

    expect(html).toContain('GH-29')
    expect(html).toContain('c0ffee2')
    expect(html).toContain('mnmn0')
    expect(html).toContain('mukuroji-platform')
    expect(html).toContain('Synchronized')
    expect(html).toContain('Bidirectional')
    expect(html).toContain('Unlink')
  })

  test('keeps mutation controls unavailable in read-only mode', () => {
    const html = renderToStaticMarkup(
      <WorkItemExternalLinksPanel
        canManage={false}
        installations={externalLinkInstallationFixtures}
        labels={labels}
        links={externalWorkItemLinkFixtures}
      />,
    )

    expect(html).toContain('Read only')
    expect(html).not.toContain('Add external resource')
    expect(html).not.toContain('>Unlink<')
    expect(html).toMatch(/<select[^>]*disabled=""/)
  })

  test('explains how to recover when no connected installation exists', () => {
    const html = renderToStaticMarkup(
      <WorkItemExternalLinksPanel
        canManage
        installations={externalLinkInstallationFixtures.map((installation) => ({
          ...installation,
          status: 'disconnected',
        }))}
        labels={labels}
        links={externalWorkItemLinkFixtures}
        onCreate={async () => undefined}
        onUpdateDirection={async () => undefined}
      />,
    )

    expect(html).toContain('A connected account is required')
    expect(html).toContain('Reconnect this account in Developer Platform')
    expect(html).not.toContain('Add external resource')
    expect(html).toMatch(/<select[^>]*disabled=""/)
  })

  test('uses link snapshots when connector metadata is not available to a viewer', () => {
    const snapshotLink = {
      ...externalWorkItemLinkFixtures[0],
      provider: 'github',
      installationName: 'Product engineering',
      externalAccountName: 'mnmn0',
    }
    const html = renderToStaticMarkup(
      <WorkItemExternalLinksPanel
        canManage={false}
        installations={[]}
        labels={labels}
        links={[snapshotLink]}
      />,
    )

    expect(html).toContain('github')
    expect(html).toContain('Product engineering · mnmn0')
    expect(html).not.toContain('Connection unavailable')
  })

  test('keeps loaded links visible when a later page fails', () => {
    const html = renderToStaticMarkup(
      <WorkItemExternalLinksPanel
        canManage
        hasMore
        installations={externalLinkInstallationFixtures}
        labels={labels}
        links={externalWorkItemLinkFixtures}
        loadMoreErrorMessage={labels.loadMoreError}
        onLoadMore={async () => undefined}
        onRetry={async () => undefined}
      />,
    )

    expect(html).toContain('GH-29')
    expect(html).toContain('Previously loaded links are still shown.')
    expect(html).toContain('Load more')
    expect(html).toContain('Reload')
  })
})
