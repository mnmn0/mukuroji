import type {
  CreateWorkItemScheduleDependencyInput,
  PlanningRevisionInput,
  PlanningSnapshot,
  UpdateWorkItemScheduleDependencyInput,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { isPlanningSnapshot } from '../../shared/api/contractValidation'
import { PlanningApiError } from './errors'

const planningApiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL ?? '/api')
const defaultPlanningApiErrorMessage = 'Unable to complete the planning request.'

/**
 * Creates one canonical Work Item schedule dependency.
 *
 * @param accessToken - Session bearer token.
 * @param input - Cross-Team endpoints, scheduling rule, and observed graph revision.
 * @param mutationContext - Stable idempotency and correlation identifiers.
 * @returns The updated authoritative planning snapshot.
 */
export function createWorkItemScheduleDependency(
  accessToken: string,
  input: CreateWorkItemScheduleDependencyInput,
  mutationContext: MutationRequestContext,
): Promise<PlanningSnapshot> {
  return requestMutation(
    `${planningApiBaseUrl}/planning/work-item-dependencies`,
    accessToken,
    'POST',
    input,
    mutationContext,
  )
}

/**
 * Updates the scheduling rule of one canonical Work Item dependency.
 *
 * @param accessToken - Session bearer token.
 * @param dependencyId - Workspace-local dependency identifier.
 * @param input - Replacement fields and observed graph revision.
 * @param mutationContext - Stable idempotency and correlation identifiers.
 * @returns The updated authoritative planning snapshot.
 */
export function updateWorkItemScheduleDependency(
  accessToken: string,
  dependencyId: string,
  input: UpdateWorkItemScheduleDependencyInput,
  mutationContext: MutationRequestContext,
): Promise<PlanningSnapshot> {
  return requestMutation(
    `${planningApiBaseUrl}/planning/work-item-dependencies/${encodeURIComponent(dependencyId)}`,
    accessToken,
    'PATCH',
    input,
    mutationContext,
  )
}

/**
 * Deletes one canonical Work Item schedule dependency.
 *
 * @param accessToken - Session bearer token.
 * @param dependencyId - Workspace-local dependency identifier.
 * @param input - Observed planning graph revision.
 * @param mutationContext - Stable idempotency and correlation identifiers.
 * @returns The updated authoritative planning snapshot.
 */
export function deleteWorkItemScheduleDependency(
  accessToken: string,
  dependencyId: string,
  input: PlanningRevisionInput,
  mutationContext: MutationRequestContext,
): Promise<PlanningSnapshot> {
  return requestMutation(
    `${planningApiBaseUrl}/planning/work-item-dependencies/${encodeURIComponent(dependencyId)}`,
    accessToken,
    'DELETE',
    input,
    mutationContext,
  )
}

/** Sends one idempotent planning mutation and validates its response status. */
async function requestMutation(
  path: string,
  accessToken: string,
  method: 'DELETE' | 'PATCH' | 'POST',
  input: unknown,
  mutationContext: MutationRequestContext,
): Promise<PlanningSnapshot> {
  const response = await fetch(path, {
    body: JSON.stringify(input),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    method,
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

  if (!isPlanningSnapshot(data)) {
    throw new PlanningApiError(
      response.status,
      defaultPlanningApiErrorMessage,
      'InvalidPlanningSnapshot',
    )
  }

  return data
}

/** Returns whether an unknown response exposes safe optional error fields. */
function isErrorResponse(value: unknown): value is { code?: string; message?: string } {
  if (typeof value !== 'object' || value === null) return false
  const codeIsValid = !('code' in value) || typeof value.code === 'string'
  const messageIsValid = !('message' in value) || typeof value.message === 'string'
  return codeIsValid && messageIsValid
}

/** Reads JSON while retaining an unknown type boundary. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return undefined
  }
}

/** Removes trailing slashes from a configured API base URL. */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
