import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import type { WorkItemCollection } from '@mukuroji/contracts'
import { CollectionApiError, getCollectionItems, getCollections } from '../src/features/collections/api/collections'
import { toCollectionCandidates } from '../src/features/collections/model/collectionCandidates'
import { resolveCollectionErrorMessageKey } from '../src/features/collections/model/collectionErrors'
import { CollectionsWorkspace, type CollectionsWorkspaceProps } from '../src/features/collections/ui/CollectionsWorkspace'
import { createTranslator } from '../src/shared/i18n/i18n'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const collection: WorkItemCollection = {
  collectionId: 'c1',
  name: 'Launch',
  description: 'Q4 launch work',
  createdBy: 'demo@example.com',
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
  revision: 2,
}

/**
 * Renders the workspace with defaults.
 *
 * @param overrides - Props to replace.
 * @returns Static markup.
 */
function render(overrides: Partial<CollectionsWorkspaceProps> = {}) {
  const props: CollectionsWorkspaceProps = {
    t: createTranslator('en'),
    collections: [collection],
    collectionsFailed: false,
    onRetryCollections: () => undefined,
    onRetryItems: () => undefined,
    candidateQuery: 'page',
    onSearchCandidates: () => undefined,
    candidatesFailed: false,
    onRetryCandidates: () => undefined,
    selectedId: 'c1',
    items: [{ teamId: 'core-team', issueId: 'onboarding', title: 'Reduce onboarding friction', statusCategory: 'started', assignedProjectId: 'refero', addedAt: '2026-10-16T00:00:00.000Z' }],
    itemsFailed: false,
    candidates: [
      { teamId: 'core-team', issueId: 'onboarding', title: 'Reduce onboarding friction' },
      { teamId: 'core-team', issueId: 'pricing', title: 'Pricing page' },
    ],
    canEdit: true,
    pending: false,
    workItemHref: (teamId, issueId) => `/teams/${teamId}/issues?issueId=${issueId}`,
    onSelect: () => undefined,
    onCreate: async () => true,
    onRename: async () => true,
    onDelete: () => undefined,
    onAddItem: () => undefined,
    onRemoveItem: () => undefined,
    ...overrides,
  }
  return renderToStaticMarkup(<MemoryRouter><CollectionsWorkspace {...props} /></MemoryRouter>)
}

describe('CollectionsWorkspace', () => {
  test('links each readable Work Item to its canonical detail and offers only unlisted candidates', () => {
    const markup = render()
    expect(markup).toContain('href="/teams/core-team/issues?issueId=onboarding"')
    expect(markup).toContain('In progress · refero')
    expect(markup).toContain('Only Work Items you can view are shown.')
    expect(markup).toContain('>Pricing page (core-team / pricing)</option>')
    expect(markup).not.toContain('>Reduce onboarding friction (core-team / onboarding)</option>')
    expect(markup).toContain('aria-label="Remove from Collection: Reduce onboarding friction"')
  })

  test('asks for a search before offering candidates and reports an empty search', () => {
    const before = render({ candidateQuery: '', candidates: undefined })
    expect(before).toContain('Find Work Items to add')
    expect(before).not.toContain('Add a Work Item')
    expect(render({ candidates: undefined })).toContain('Searching Work Items')
    const empty = render({ candidates: [{ teamId: 'core-team', issueId: 'onboarding', title: 'Reduce onboarding friction' }] })
    expect(empty).toContain('No Work Items to add match this search.')
    expect(empty).not.toContain('Add a Work Item')
  })

  test('shows a permission-denied state instead of a retryable failure', () => {
    const markup = render({ accessDenied: true, collections: undefined, collectionsFailed: true })
    expect(markup).toContain('You do not have permission to view Collections.')
    expect(markup).not.toContain('>Retry</button>')
    expect(markup).not.toContain('view-only access')
  })

  test('reports a selected Collection that the list does not contain', () => {
    const markup = render({ selectedId: 'deleted', items: undefined })
    expect(markup).toContain('role="alert">This Collection does not exist or was deleted.')
    expect(markup).not.toContain('Choose a Collection from the list.')
  })

  test('edits descriptions in a multi-line field so line breaks survive', () => {
    expect(render({ selectedId: undefined })).toContain('<textarea')
    // The read-only view keeps line breaks and wraps long words.
    expect(render()).toMatch(/<p class="[^"]*whitespace-pre-wrap break-words[^"]*">Q4 launch work<\/p>/u)
  })

  test('hides every change control for view-only members', () => {
    const markup = render({ canEdit: false })
    expect(markup).toContain('You have view-only access')
    expect(markup).not.toContain('New Collection')
    expect(markup).not.toContain('Remove from Collection')
    expect(markup).not.toContain('Add a Work Item')
    expect(markup).not.toContain('Find Work Items to add')
  })

  test('reports loading failures and the latest action error', () => {
    const markup = render({ collections: undefined, collectionsFailed: true, errorMessage: 'The Collection changed.' })
    expect(markup).toContain('Collections could not be loaded.')
    expect(markup).toContain('role="alert">The Collection changed.')
    expect(markup).toContain('>Retry</button>')
  })

  test('keeps loaded data visible when a refresh or the candidate list fails', () => {
    const markup = render({ collectionsFailed: true, itemsFailed: true, candidatesFailed: true })
    expect(markup).toContain('The latest state could not be loaded.')
    expect(markup).toContain('Reduce onboarding friction')
    expect(markup).toContain('Work Items to add could not be searched.')
    expect(markup).not.toContain('Add a Work Item')
    expect(markup.match(/>Retry<\/button>/gu)).toHaveLength(3)
  })
})

describe('toCollectionCandidates', () => {
  test('reads Team and Work Item IDs from Work Item search results only', () => {
    const base = { title: 'T', url: '/x', highlights: [] }
    expect(toCollectionCandidates([
      { ...base, id: 'team/チーム/a/issue/課題/1', entityType: 'work-item', teamId: 'チーム/a' },
      { ...base, id: 'team/core/issue/x/comment/c1', entityType: 'comment', teamId: 'core' },
      { ...base, id: 'team/core/issue/', entityType: 'work-item', teamId: 'core' },
      { ...base, id: 'team/other/issue/x', entityType: 'work-item', teamId: 'core' },
      { ...base, id: 'team/core/issue/x', entityType: 'work-item' },
      { id: 'team/core/issue/y', entityType: 'work-item', teamId: 'core', title: 42 },
      null,
    ])).toEqual([{ teamId: 'チーム/a', issueId: '課題/1', title: 'T' }])
  })
})

describe('Collection API', () => {
  test('rejects malformed responses and keeps the API error code', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ collections: [], canWrite: 'yes' }))
    await expect(getCollections('token')).rejects.toMatchObject({ status: 502 })
    globalThis.fetch = async () => new Response(JSON.stringify({ collections: [{ name: 'Missing ID' }], canWrite: true }))
    await expect(getCollections('token')).rejects.toMatchObject({ status: 502 })
    globalThis.fetch = async () => new Response(JSON.stringify({ collections: [{ ...collection, revision: 0 }], canWrite: true }))
    await expect(getCollections('token')).rejects.toMatchObject({ status: 502 })
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'CollectionNotFound', message: 'Not found' }), { status: 404 })
    const failure = await getCollectionItems('token', 'c1').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CollectionApiError)
    expect(failure).toMatchObject({ status: 404, code: 'CollectionNotFound' })
  })

  test('maps failures to actionable messages', () => {
    expect(resolveCollectionErrorMessageKey(409, 'CollectionConflict')).toBe('collections.error.conflict')
    expect(resolveCollectionErrorMessageKey(409, 'CollectionItemLimitReached')).toBe('collections.error.limit')
    expect(resolveCollectionErrorMessageKey(409, 'CollectionDeleted')).toBe('collections.error.createdDeleted')
    expect(resolveCollectionErrorMessageKey(404, 'CollectionWorkItemNotFound')).toBe('collections.error.notFound')
    expect(resolveCollectionErrorMessageKey(403, 'CollectionAuthorizationChanged')).toBe('collections.error.denied')
    expect(resolveCollectionErrorMessageKey(undefined, undefined)).toBe('collections.error.generic')
  })
})
