import type { PlanningReadScope, PlanningSnapshot } from '@mukuroji/contracts'
import { readPlanningSnapshot } from './contractValidation'
import { PlanningApiError } from './errors'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

const planningApiBaseUrl = resolveApiBaseUrl()

const defaultPlanningApiErrorMessage = 'Unable to complete the planning request.'

/**
 * 現在 user が参照できる計画 snapshot を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param readScope - 指定すると、その Team / Project / Portfolio だけを読みます。
 * @returns Entity、dependency、Work Item link、critical path を含む snapshot です。
 */
export async function getPlanningSnapshot(accessToken: string, readScope?: PlanningReadScope) {
  const snapshot = await requestPlanningSnapshot(
    `${planningApiBaseUrl}/planning${createPlanningReadScopeQuery(readScope)}`,
    accessToken,
  )
  if (!isSamePlanningReadScope(snapshot.readScope, readScope)) {
    throw new PlanningApiError(200, defaultPlanningApiErrorMessage, 'InvalidPlanningSnapshot')
  }
  return snapshot
}

/**
 * Builds the query string that selects a Planning read scope.
 *
 * @param readScope - Team, Project, or Portfolio to read, or undefined for the whole Workspace.
 * @returns The query string, including its leading `?`, or an empty string.
 */
function createPlanningReadScopeQuery(readScope: PlanningReadScope | undefined) {
  if (readScope === undefined) return ''
  const params = new URLSearchParams()
  if (readScope.type === 'portfolio') {
    params.set('portfolioId', readScope.portfolioId)
  } else {
    params.set('teamId', readScope.teamId)
    if (readScope.type === 'project') params.set('projectId', readScope.projectId)
  }
  return `?${params.toString()}`
}

/**
 * Returns whether the server answered the scope that was asked for.
 *
 * @param received - Scope the snapshot reports.
 * @param requested - Scope the request named.
 * @returns True when both name the same scope, or both are the whole Workspace.
 */
function isSamePlanningReadScope(
  received: PlanningReadScope | undefined,
  requested: PlanningReadScope | undefined,
) {
  if (received === undefined || requested === undefined) return received === requested
  if (received.type === 'portfolio' || requested.type === 'portfolio') {
    return received.type === 'portfolio' && requested.type === 'portfolio' &&
      received.portfolioId === requested.portfolioId
  }
  if (received.type !== requested.type || received.teamId !== requested.teamId) return false
  return received.type === 'team' ||
    requested.type === 'project' && received.projectId === requested.projectId
}

/** Fetches and validates one authoritative Planning snapshot. */
async function requestPlanningSnapshot(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<PlanningSnapshot> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const data = await readJson(response)

  if (!response.ok) {
    const errorData = isErrorResponse(data) ? data : undefined

    throw new PlanningApiError(
      response.status,
      errorData?.message?.trim() || defaultPlanningApiErrorMessage,
      errorData?.code,
    )
  }

  const snapshot = readPlanningSnapshot(data)
  if (!snapshot) {
    throw new PlanningApiError(
      response.status,
      defaultPlanningApiErrorMessage,
      'InvalidPlanningSnapshot',
    )
  }
  return snapshot
}

function isErrorResponse(value: unknown): value is { code?: string; message?: string } {
  if (typeof value !== 'object' || value === null) return false

  const hasValidCode = !('code' in value) || typeof value.code === 'string'
  const hasValidMessage = !('message' in value) || typeof value.message === 'string'
  return hasValidCode && hasValidMessage
}

/** Reads a JSON response without trusting its runtime shape. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()

  if (!text) {
    return undefined
  }

  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return undefined
  }
}
