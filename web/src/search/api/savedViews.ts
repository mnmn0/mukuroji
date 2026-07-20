import { type CreateSavedWorkspaceViewInput, type SavedWorkspaceView, type UpdateSavedWorkspaceViewInput } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { WorkspaceSearchApiError, resolveSearchApiBaseUrl } from './errors'

const searchApiBaseUrl = resolveSearchApiBaseUrl(import.meta.env)

/**
 * 現在ユーザーが利用できるpersonal/team/shared saved viewを取得します。
 */
export async function getSavedWorkspaceViews(accessToken: string, signal?: AbortSignal) {
  const views: SavedWorkspaceView[] = []
  const seenViewIds = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  do {
    const query = new URLSearchParams({ limit: '50' })
    if (cursor) {
      query.set('cursor', cursor)
    }
    const response = await requestJson<unknown>(
      `${searchApiBaseUrl}/saved-views?${query.toString()}`,
      accessToken,
      { signal },
    )
    const page = readSavedViewsPage(response)
    for (const view of page.views) {
      if (!seenViewIds.has(view.id)) {
        seenViewIds.add(view.id)
        views.push(view)
      }
    }

    cursor = page.nextCursor && !seenCursors.has(page.nextCursor)
      ? page.nextCursor
      : undefined
    if (cursor) {
      seenCursors.add(cursor)
    }
  } while (cursor)

  return views
}

/**
 * Workspace search stateを新しいsaved viewとして保存します。
 */
export async function createSavedWorkspaceView(
  accessToken: string,
  input: CreateSavedWorkspaceViewInput,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<unknown>(
    `${searchApiBaseUrl}/saved-views`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'POST',
    },
  )

  return readSavedView(response)
}

/**
 * 既存saved viewのquery、layout、共有範囲、favorite状態を更新します。
 */
export async function updateSavedWorkspaceView(
  accessToken: string,
  viewId: string,
  input: UpdateSavedWorkspaceViewInput,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<unknown>(
    `${searchApiBaseUrl}/saved-views/${encodeURIComponent(viewId)}`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'PATCH',
    },
  )

  return readSavedView(response)
}

/**
 * 既存saved viewを削除します。
 */
export async function deleteSavedWorkspaceView(
  accessToken: string,
  viewId: string,
  expectedRevision: number,
  mutationContext: MutationRequestContext,
) {
  const query = new URLSearchParams({ expectedRevision: String(expectedRevision) })

  await requestJson<unknown>(
    `${searchApiBaseUrl}/saved-views/${encodeURIComponent(viewId)}?${query.toString()}`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
  )
}

function readSavedViewsPage(value: unknown) {
  if (Array.isArray(value)) {
    return { views: value as SavedWorkspaceView[] }
  }

  const record = asRecord(value)
  return {
    views: Array.isArray(record.views) ? record.views as SavedWorkspaceView[] : [],
    nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : undefined,
  }
}

function readSavedView(value: unknown) {
  const record = asRecord(value)
  const view = record.view ?? value

  if (!view || typeof view !== 'object') {
    throw new WorkspaceSearchApiError(502, 'Saved view response was invalid.', 'InvalidSavedViewResponse')
  }

  return view as SavedWorkspaceView
}

async function requestJson<TResponse>(
  url: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const body = await readJson(response)

  if (!response.ok) {
    const error = asRecord(body)
    throw new WorkspaceSearchApiError(
      response.status,
      typeof error.message === 'string' ? error.message : 'Unable to complete the search request.',
      typeof error.code === 'string' ? error.code : undefined,
    )
  }

  return body as TResponse
}

async function readJson(response: Response) {
  const text = await response.text()

  if (!text) {
    return undefined
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new WorkspaceSearchApiError(response.status, 'Search API returned invalid JSON.', 'InvalidSearchResponse')
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
