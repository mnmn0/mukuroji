import type {
  AiAssistancePolicy,
  AiAssistancePreference,
  AiAssistanceTask,
  UpdateAiAssistancePolicyRequest,
  UpdateAiAssistancePreferenceRequest,
} from '@mukuroji/contracts'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../../../shared/api/mutationHeaders'
import {
  AiAssistanceApiError,
  resolveAiAssistanceApiBaseUrl,
} from './errors'

const aiAssistanceSettingsApiBaseUrl = `${resolveAiAssistanceApiBaseUrl(import.meta.env)}/ai-assistance`
const aiAssistanceTasks = ['triage', 'summary', 'search', 'planning'] as const satisfies readonly AiAssistanceTask[]

/**
 * Loads the active Workspace AI policy for an authorized administrator.
 *
 * @param accessToken - Bearer token for the active Workspace member.
 * @returns The validated revisioned Workspace policy.
 */
export async function getAiAssistancePolicy(accessToken: string): Promise<AiAssistancePolicy> {
  return parseAiAssistancePolicy(await requestJson('/policy', accessToken))
}

/**
 * Replaces the Workspace AI policy using optimistic concurrency.
 *
 * @param accessToken - Bearer token for an authorized Workspace administrator.
 * @param input - Complete revision-fenced policy replacement.
 * @param mutationContext - Idempotency and correlation headers.
 * @returns The validated updated Workspace policy.
 */
export async function updateAiAssistancePolicy(
  accessToken: string,
  input: UpdateAiAssistancePolicyRequest,
  mutationContext: MutationRequestContext,
): Promise<AiAssistancePolicy> {
  return parseAiAssistancePolicy(await requestJson('/policy', accessToken, {
    body: JSON.stringify(input),
    headers: createMutationHeaders(mutationContext),
    method: 'PUT',
  }))
}

/**
 * Loads the active member's personal AI opt-out preference.
 *
 * @param accessToken - Bearer token for the active Workspace member.
 * @returns The validated revisioned member preference.
 */
export async function getAiAssistancePreference(
  accessToken: string,
): Promise<AiAssistancePreference> {
  return parseAiAssistancePreference(await requestJson('/preferences/me', accessToken))
}

/**
 * Replaces the active member's personal AI preference using optimistic concurrency.
 *
 * @param accessToken - Bearer token for the active Workspace member.
 * @param input - Revision-fenced personal preference replacement.
 * @param mutationContext - Idempotency and correlation headers.
 * @returns The validated updated member preference.
 */
export async function updateAiAssistancePreference(
  accessToken: string,
  input: UpdateAiAssistancePreferenceRequest,
  mutationContext: MutationRequestContext,
): Promise<AiAssistancePreference> {
  return parseAiAssistancePreference(await requestJson('/preferences/me', accessToken, {
    body: JSON.stringify(input),
    headers: createMutationHeaders(mutationContext),
    method: 'PUT',
  }))
}

/** Validates an untrusted Workspace AI policy response. */
function parseAiAssistancePolicy(value: unknown): AiAssistancePolicy {
  if (!isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.enabled !== 'boolean' ||
    !isModelIdArray(value.allowedModelIds) ||
    hasDuplicates(value.allowedModelIds) ||
    !isIdentifier(value.defaultModelId) ||
    !value.allowedModelIds.includes(value.defaultModelId) ||
    !Array.isArray(value.enabledTasks) ||
    value.enabledTasks.length < 1 ||
    value.enabledTasks.length > aiAssistanceTasks.length ||
    !value.enabledTasks.every(isAiAssistanceTask) ||
    hasDuplicates(value.enabledTasks) ||
    !isRetentionDays(value.retentionDays) ||
    !isNonNegativeInteger(value.revision) ||
    !isIsoTimestamp(value.updatedAt)) {
    throw invalidResponseError()
  }

  return {
    schemaVersion: 1,
    enabled: value.enabled,
    allowedModelIds: value.allowedModelIds,
    defaultModelId: value.defaultModelId,
    enabledTasks: value.enabledTasks,
    retentionDays: value.retentionDays,
    revision: value.revision,
    updatedAt: value.updatedAt,
  }
}

/** Validates an untrusted personal AI preference response. */
function parseAiAssistancePreference(value: unknown): AiAssistancePreference {
  if (!isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.enabled !== 'boolean' ||
    !isNonNegativeInteger(value.revision) ||
    !isIsoTimestamp(value.updatedAt)) {
    throw invalidResponseError()
  }

  return {
    schemaVersion: 1,
    enabled: value.enabled,
    revision: value.revision,
    updatedAt: value.updatedAt,
  }
}

/** Performs one authenticated AI settings request and classifies stable API errors. */
async function requestJson(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${aiAssistanceSettingsApiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })
  } catch {
    throw new AiAssistanceApiError(0, 'Unable to complete the AI settings request.', 'AiAssistanceNetworkError')
  }

  const value = await readJson(response)
  if (!response.ok) {
    const error = isRecord(value) ? value : {}
    throw new AiAssistanceApiError(
      response.status,
      typeof error.message === 'string'
        ? error.message
        : 'Unable to complete the AI settings request.',
      typeof error.code === 'string' ? error.code : undefined,
    )
  }

  return value
}

/** Reads one required JSON settings response. */
async function readJson(response: Response): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch {
    throw invalidResponseError(response.status)
  }
  if (!text) throw invalidResponseError(response.status)

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw invalidResponseError(response.status)
  }
}

/** Creates a stable invalid-response error at the API trust boundary. */
function invalidResponseError(status = 502): AiAssistanceApiError {
  return new AiAssistanceApiError(
    status,
    'AI assistance API returned an invalid settings response.',
    'InvalidAiAssistanceResponse',
  )
}

/** Narrows an unknown JSON value to a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validates the bounded Bedrock model allowlist returned by the API. */
function isModelIdArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 20 &&
    value.every(isIdentifier)
}

/** Validates one normalized bounded identifier. */
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 256 &&
    value === value.trim()
}

/** Validates a supported AI workflow discriminator. */
function isAiAssistanceTask(value: unknown): value is AiAssistanceTask {
  return typeof value === 'string' && aiAssistanceTasks.some((task) => task === value)
}

/** Validates a non-negative integer. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Validates the server-supported AI audit retention range. */
function isRetentionDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 365
}

/** Returns whether a validated primitive array contains a repeated value. */
function hasDuplicates(values: readonly unknown[]): boolean {
  return new Set(values).size !== values.length
}

/** Validates the UTC ISO 8601 timestamp shape emitted by the server. */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/u.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const leapYear = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1] ?? 0
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth &&
    hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 &&
    second >= 0 && second <= 59 && Number.isFinite(Date.parse(value))
}
