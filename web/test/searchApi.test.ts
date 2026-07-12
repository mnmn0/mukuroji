import { afterEach, describe, expect, test } from 'bun:test'
import {
  SAVED_VIEW_SCHEMA_VERSION,
  SEARCH_SCHEMA_VERSION,
  type SavedWorkspaceView,
  type WorkspaceSearchResult,
} from '@mukuroji/contracts'
import { getSavedWorkspaceViews, searchWorkspaceAcrossCursors } from '../src/search/api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Workspace search cursor aggregation', () => {
  test('continues after an empty scan page until a permitted match is found', async () => {
    const requests = installSearchResponses([
      { results: [], nextCursor: 'scan/page-2' },
      { results: [createResult('match-1')] },
    ])

    const response = await searchWorkspaceAcrossCursors(
      'access-token',
      { keyword: 'launch' },
      { resultLimit: 12, pageLimit: 5 },
    )

    expect(response.results.map((result) => result.id)).toEqual(['match-1'])
    expect(requests).toHaveLength(2)
    expect(new URL(requests[1] ?? '', 'https://example.test').searchParams.get('cursor')).toBe('scan/page-2')
  })

  test('aggregates at most the safe result cap and stops early', async () => {
    const requests = installSearchResponses([
      { results: createResults('first', 7), nextCursor: 'next-page' },
      { results: createResults('second', 8), nextCursor: 'unused-page' },
      { results: [createResult('must-not-load')] },
    ])

    const response = await searchWorkspaceAcrossCursors(
      'access-token',
      { keyword: 'launch' },
      { resultLimit: 99, pageLimit: 5 },
    )

    expect(response.results).toHaveLength(12)
    expect(response.results.at(-1)?.id).toBe('second-5')
    expect(requests).toHaveLength(2)
    expect(new URL(requests[1] ?? '', 'https://example.test').searchParams.get('limit')).toBe('5')
  })

  test('stops after the safe page cap when no scan page contains a match', async () => {
    const requests = installSearchResponses(Array.from({ length: 6 }, (_, index) => ({
      results: [],
      nextCursor: `page-${index + 2}`,
    })))

    const response = await searchWorkspaceAcrossCursors(
      'access-token',
      { keyword: 'missing' },
      { resultLimit: 12, pageLimit: 99 },
    )

    expect(response.results).toEqual([])
    expect(requests).toHaveLength(5)
  })
})

describe('Saved Workspace view pagination', () => {
  test('follows opaque cursors and removes repeated views', async () => {
    const requests: Request[] = []
    const firstView = createSavedView('first-view')
    const secondView = createSavedView('second-view')

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const resolvedInput = typeof input === 'string' && input.startsWith('/')
        ? new URL(input, 'https://example.test')
        : input
      const request = new Request(resolvedInput, init)
      requests.push(request)
      const cursor = new URL(request.url).searchParams.get('cursor')
      const response = cursor
        ? { views: [firstView, secondView] }
        : { views: [firstView], nextCursor: 'saved/page-2' }

      return Response.json(response)
    }) as typeof fetch

    const views = await getSavedWorkspaceViews('access-token')

    expect(views.map((view) => view.id)).toEqual(['first-view', 'second-view'])
    expect(requests).toHaveLength(2)
    expect(new URL(requests[1]?.url ?? '').searchParams.get('cursor')).toBe('saved/page-2')
    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer access-token')
  })

  test('stops when the API repeats a cursor', async () => {
    let requestCount = 0
    globalThis.fetch = (async () => {
      requestCount += 1
      return Response.json({ views: [], nextCursor: 'repeated-cursor' })
    }) as typeof fetch

    await getSavedWorkspaceViews('access-token')

    expect(requestCount).toBe(2)
  })
})

function createResults(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => createResult(`${prefix}-${index + 1}`))
}

function createResult(id: string): WorkspaceSearchResult {
  return {
    entityType: 'work-item',
    highlights: [],
    id,
    teamId: 'core-team',
    title: id,
    url: `/teams/core-team/issues/${id}`,
  }
}

function createSavedView(id: string): SavedWorkspaceView {
  return {
    canEdit: true,
    createdAt: '2026-07-12T00:00:00.000Z',
    favorite: false,
    filters: {},
    id,
    isDefault: false,
    layout: {
      columns: ['title', 'type'],
      mode: 'table',
      sort: [{ field: 'relevance', direction: 'desc' }],
    },
    name: id,
    ownerUserId: 'demo@example.com',
    pinned: false,
    revision: 1,
    schemaVersion: SAVED_VIEW_SCHEMA_VERSION,
    updatedAt: '2026-07-12T00:00:00.000Z',
    visibility: 'personal',
  }
}

function installSearchResponses(
  responses: Array<{ results: WorkspaceSearchResult[]; nextCursor?: string }>,
) {
  const requests: string[] = []

  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const response = responses[requests.length - 1]
    if (!response) {
      throw new Error('Unexpected search request.')
    }

    return new Response(JSON.stringify({
      schemaVersion: SEARCH_SCHEMA_VERSION,
      ...response,
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch

  return requests
}
