import { describe, expect, test } from 'bun:test'
import {
  completeDeveloperConnectorCatalog,
  filterDeveloperConnectorCatalog,
  flattenDeveloperSyncConflicts,
  formatConflictMergeDraft,
  formatSyncConflictValue,
  isDeveloperSyncConflictResolution,
  parseConflictMergedValues,
  replaceResolvedSyncConflictPages,
} from '../src/developer-platform/model/connectors'
import { toLocalEndOfDayIso } from '../src/developer-platform/model/credentials'
import {
  formatConnectorProviderName,
  interpolate,
} from '../src/developer-platform/model/displayFormatting'
import {
  filterImportProjectOptions,
  selectLatestImport,
  updateImportMapping,
} from '../src/developer-platform/model/transfers'
import {
  developerPlatformLabelsFixture,
  developerPlatformResourcesFixture,
  developerSyncConflictsFixture,
} from '../src/developer-platform/fixtures'
import { buildConnectorAuthorizationReturnUrl } from '../src/developer-platform/mutations/connectorAuthorization'
import { runDeveloperPlatformMutation } from '../src/developer-platform/mutations/runDeveloperPlatformMutation'

describe('Developer Platform connector model', () => {
  test('completes and filters connector catalog with installed account metadata', () => {
    const catalog = completeDeveloperConnectorCatalog(
      developerPlatformLabelsFixture.connectorCatalog,
      developerPlatformResourcesFixture.connectors,
      developerPlatformLabelsFixture.helpText.installedConnector,
    )

    expect(catalog.length).toBeGreaterThanOrEqual(
      developerPlatformLabelsFixture.connectorCatalog.length,
    )
    expect(
      filterDeveloperConnectorCatalog(
        catalog,
        developerPlatformResourcesFixture.connectors,
        'github',
      ).map((item) => item.provider),
    ).toContain('github')
    expect(
      filterDeveloperConnectorCatalog(
        catalog,
        developerPlatformResourcesFixture.connectors,
        'no-such-provider-account',
      ),
    ).toEqual([])
  })

  test('flattens conflict pages while keeping the latest item for each ID', () => {
    const conflict = developerSyncConflictsFixture[0]

    expect(conflict).toBeDefined()
    if (!conflict) return

    const duplicate = {
      ...conflict,
      detectedAt: '2099-01-01T00:00:00.000Z',
    }
    const flattened = flattenDeveloperSyncConflicts([
      { items: [conflict] },
      { items: [duplicate] },
    ])

    expect(flattened).toHaveLength(1)
    expect(flattened[0]?.detectedAt).toBe(duplicate.detectedAt)
  })

  test('replaces a resolved conflict in every loaded cache page', () => {
    const conflict = developerSyncConflictsFixture[0]

    expect(conflict).toBeDefined()
    if (!conflict) return

    const resolvedConflict = {
      ...conflict,
      detectedAt: '2099-01-01T00:00:00.000Z',
    }
    const pages = replaceResolvedSyncConflictPages(
      [
        { items: [conflict] },
        { items: [conflict], nextCursor: 'next-page' },
      ],
      resolvedConflict,
    )

    expect(pages?.[0]?.items[0]).toBe(resolvedConflict)
    expect(pages?.[1]?.items[0]).toBe(resolvedConflict)
    expect(pages?.[1]?.nextCursor).toBe('next-page')
  })

  test('formats and parses conflict merge drafts without trusting invalid JSON', () => {
    const conflict = developerSyncConflictsFixture[0]

    expect(conflict).toBeDefined()
    if (!conflict) return

    expect(formatSyncConflictValue('', 'N/A')).toBe('""')
    expect(formatSyncConflictValue(undefined, 'N/A')).toBe('N/A')
    expect(formatSyncConflictValue({ state: 'open' }, 'N/A')).toBe(
      '{\n  "state": "open"\n}',
    )
    expect(formatConflictMergeDraft(undefined)).toBe('null')
    expect(
      parseConflictMergedValues(conflict, {
        [conflict.fields[0]?.field ?? 'title']: '"Merged title"',
      }),
    ).toBeObject()
    expect(() =>
      parseConflictMergedValues(conflict, {
        [conflict.fields[0]?.field ?? 'title']: '{invalid',
      }),
    ).toThrow()
  })

  test('narrows supported conflict resolution values', () => {
    expect(isDeveloperSyncConflictResolution('merge')).toBe(true)
    expect(isDeveloperSyncConflictResolution('overwrite')).toBe(false)
  })
})

describe('Developer Platform transfer and display model', () => {
  test('updates import mappings immutably and filters projects by Team', () => {
    const mappings = [
      { sourceField: 'Title', targetField: 'title' },
      { sourceField: 'State', targetField: 'status' },
    ]
    const updated = updateImportMapping(
      mappings,
      0,
      'sourceField',
      'Summary',
    )
    const projectOptions = [
      { teamId: 'team-a', value: 'project-a' },
      { teamId: 'team-b', value: 'project-b' },
    ]

    expect(updated).not.toBe(mappings)
    expect(updated[0]?.sourceField).toBe('Summary')
    expect(mappings[0]?.sourceField).toBe('Title')
    expect(filterImportProjectOptions(projectOptions, 'team-b')).toEqual([
      projectOptions[1],
    ])
  })

  test('selects the latest import without mutating aggregate order', () => {
    const imports = [...developerPlatformResourcesFixture.imports].reverse()
    const originalOrder = imports.map((item) => item.id)
    const expected = [...imports].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    )[0]

    expect(selectLatestImport(imports)?.id).toBe(expected?.id)
    expect(imports.map((item) => item.id)).toEqual(originalOrder)
  })

  test('normalizes credential expiry and localized display helpers', () => {
    expect(toLocalEndOfDayIso('2026-07-23')).toBe(
      new Date('2026-07-23T23:59:59.999').toISOString(),
    )
    expect(formatConnectorProviderName('github-enterprise')).toBe(
      'Github Enterprise',
    )
    expect(
      interpolate('{valid} of {total}', { total: 4, valid: 3 }),
    ).toBe('3 of 4')
  })
})

describe('Developer Platform mutation refresh', () => {
  test('refreshes after a successful mutation and returns its result', async () => {
    let refreshCount = 0

    const result = await runDeveloperPlatformMutation(
      async () => ({ secret: 'one-time-secret' }),
      async () => {
        refreshCount += 1
      },
    )

    expect(result).toEqual({ secret: 'one-time-secret' })
    expect(refreshCount).toBe(1)
  })

  test('preserves a one-time result when refresh fails', async () => {
    const result = await runDeveloperPlatformMutation(
      async () => ({ secret: 'one-time-secret' }),
      async () => {
        throw new Error('refresh failed')
      },
    )

    expect(result).toEqual({ secret: 'one-time-secret' })
  })

  test('does not refresh after a rejected mutation', async () => {
    let refreshCount = 0

    await expect(
      runDeveloperPlatformMutation(
        async () => {
          throw new Error('mutation failed')
        },
        async () => {
          refreshCount += 1
        },
      ),
    ).rejects.toThrow('mutation failed')
    expect(refreshCount).toBe(0)
  })
})

describe('Developer Platform connector authorization', () => {
  test('preserves route state and selects connectors in the return URL', () => {
    expect(
      buildConnectorAuthorizationReturnUrl(
        'https://app.example.test/workspace?developerSection=imports&filter=open#details',
      ),
    ).toBe(
      '/workspace?developerSection=connectors&filter=open#details',
    )
  })
})
