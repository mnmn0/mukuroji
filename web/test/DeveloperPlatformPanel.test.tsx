import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeveloperPlatformPanel } from '../src/developer-platform/DeveloperPlatformPanel'
import {
  connectorConflictDeveloperPlatformResourcesFixture,
  developerPlatformLabelsFixture,
  developerSyncConflictsFixture,
  developerPlatformResourcesFixture,
  multipleConnectorAccountsDeveloperPlatformResourcesFixture,
} from '../src/developer-platform/fixtures'

describe('DeveloperPlatformPanel connector management', () => {
  test('reauthorizes a disconnected installation while keeping add-account separate', () => {
    const reauthorizeHtml = renderToStaticMarkup(
      <DeveloperPlatformPanel
        initialSection="connectors"
        labels={developerPlatformLabelsFixture}
        resources={multipleConnectorAccountsDeveloperPlatformResourcesFixture}
        onReauthorizeConnector={async () => undefined}
      />,
    )
    const addAccountHtml = renderToStaticMarkup(
      <DeveloperPlatformPanel
        initialSection="connectors"
        labels={developerPlatformLabelsFixture}
        resources={multipleConnectorAccountsDeveloperPlatformResourcesFixture}
        onConnectConnector={async () => undefined}
      />,
    )

    expect(reauthorizeHtml).toContain('mnmn0')
    expect(reauthorizeHtml).toContain('mnmn0-archive')
    expect(reauthorizeHtml).toContain('mukuroji-gitlab')
    expect(reauthorizeHtml).toContain('2 accounts')
    expect(reauthorizeHtml).toContain('Connect again')
    expect(reauthorizeHtml).not.toContain('Add account')
    expect(addAccountHtml).toContain('Add account')
    expect(addAccountHtml).not.toContain('Connect again')
  })

  test('requires an explicit conflict choice and preserves loaded pages on pagination error', () => {
    const html = renderToStaticMarkup(
      <DeveloperPlatformPanel
        initialSection="connectors"
        labels={developerPlatformLabelsFixture}
        resources={connectorConflictDeveloperPlatformResourcesFixture}
        syncConflicts={developerSyncConflictsFixture}
        syncConflictsHasMore
        syncConflictsLoadMoreErrorMessage={
          developerPlatformLabelsFixture.helpText
            .syncConflictsLoadMoreError
        }
        onLoadMoreSyncConflicts={async () => undefined}
        onResolveSyncConflict={async () => undefined}
        onRetrySyncConflicts={async () => undefined}
      />,
    )

    expect(html).toContain('Ship the public API')
    expect(html).toContain('Choose a resolution')
    expect(html).toContain('Merge fields')
    expect(html).toContain('Previously loaded conflicts are still shown.')
    expect(html).toContain('Load more')
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Resolve conflict<\/button>/,
    )
  })

  test('shows only import projects owned by the selected Team', () => {
    const html = renderToStaticMarkup(
      <DeveloperPlatformPanel
        initialSection="imports"
        importProjectOptions={[
          {
            value: 'project-product',
            label: 'Product project',
            description: 'Product',
            teamId: 'team-product',
          },
          {
            value: 'project-operations',
            label: 'Operations project',
            description: 'Operations',
            teamId: 'team-operations',
          },
        ]}
        importTeamOptions={[
          {
            value: 'team-product',
            label: 'Product',
            description: 'Product Team',
          },
          {
            value: 'team-operations',
            label: 'Operations',
            description: 'Operations Team',
          },
        ]}
        labels={developerPlatformLabelsFixture}
        resources={developerPlatformResourcesFixture}
        onDryRunImport={async () => ({
          errors: [],
          invalidRows: 0,
          sample: [],
          totalRows: 0,
          valid: true,
          validRows: 0,
        })}
      />,
    )

    expect(html).toContain('Product project')
    expect(html).not.toContain('Operations project')
  })
})
