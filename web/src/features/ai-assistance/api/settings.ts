import type {
  AiAssistanceAvailableModel,
  AiAssistanceMemberUsage,
  AiAssistanceTaskUsage,
  AiAssistanceUsageSummary,
  AiAssistanceUsageTotals,
  AiAssistanceExternalProvider,
  AiAssistancePolicy,
  AiAssistancePreference,
  AiAssistanceProvider,
  AiAssistanceProviderCredentialStatus,
  AiAssistanceProviderCredentials,
  AiAssistanceTask,
  UpdateAiAssistancePolicyRequest,
  UpdateAiAssistancePreferenceRequest,
} from '@mukuroji/contracts'
import {
  AI_ASSISTANCE_MAX_AVAILABLE_MODELS,
  AI_ASSISTANCE_MAX_MONTHLY_COST_LIMIT_USD,
  AI_ASSISTANCE_MAX_MONTHLY_TOKEN_LIMIT,
} from '@mukuroji/contracts'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../../../shared/api/mutationHeaders'
import {
  AiAssistanceApiError,
  resolveAiAssistanceApiBaseUrl,
} from './errors'
import { isRecord } from '../../../shared/api/jsonValidation'

const aiAssistanceSettingsApiBaseUrl = `${resolveAiAssistanceApiBaseUrl(import.meta.env)}/ai-assistance`
const aiAssistanceTasks = ['triage', 'summary', 'search', 'planning'] as const satisfies readonly AiAssistanceTask[]
const aiAssistanceProviders = ['bedrock', 'anthropic', 'openai'] as const satisfies readonly AiAssistanceProvider[]
const aiAssistanceExternalProviders = ['anthropic', 'openai'] as const satisfies readonly AiAssistanceExternalProvider[]

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
 * Loads one month's AI usage, caps, and switch state for a Workspace manager.
 *
 * @param accessToken - Bearer token for an authorized Workspace administrator.
 * @param month - Calendar month in UTC, as `YYYY-MM`; the current month when omitted.
 * @returns The validated usage summary.
 */
export async function getAiAssistanceUsage(
  accessToken: string,
  month?: string,
): Promise<AiAssistanceUsageSummary> {
  const query = month === undefined ? '' : `?month=${encodeURIComponent(month)}`
  return parseAiAssistanceUsageSummary(await requestJson(`/usage${query}`, accessToken))
}

/**
 * Loads the key status of every external AI provider for a Workspace manager.
 *
 * @param accessToken - Bearer token for an authorized Workspace administrator.
 * @returns Key-free status per provider.
 */
export async function getAiAssistanceProviderCredentials(
  accessToken: string,
): Promise<AiAssistanceProviderCredentials> {
  return parseAiAssistanceProviderCredentials(await requestJson('/provider-credentials', accessToken))
}

/**
 * Registers or replaces one provider API key; the response never contains the key.
 *
 * @param accessToken - Bearer token for an authorized Workspace administrator.
 * @param provider - External provider the key is for.
 * @param apiKey - Plaintext key typed by the administrator.
 * @param expectedRevision - Key revision observed before editing.
 * @param mutationContext - Idempotency and correlation headers.
 * @returns Key-free status per provider.
 */
export async function putAiAssistanceProviderCredential(
  accessToken: string,
  provider: AiAssistanceExternalProvider,
  apiKey: string,
  expectedRevision: number,
  mutationContext: MutationRequestContext,
): Promise<AiAssistanceProviderCredentials> {
  return parseAiAssistanceProviderCredentials(await requestJson(
    `/provider-credentials/${provider}`,
    accessToken,
    {
      body: JSON.stringify({ apiKey, expectedRevision }),
      headers: createMutationHeaders(mutationContext),
      method: 'PUT',
    },
  ))
}

/**
 * Removes one provider API key.
 *
 * @param accessToken - Bearer token for an authorized Workspace administrator.
 * @param provider - External provider whose key is removed.
 * @param expectedRevision - Key revision observed before removing.
 * @param mutationContext - Idempotency and correlation headers.
 * @returns Key-free status per provider.
 */
export async function deleteAiAssistanceProviderCredential(
  accessToken: string,
  provider: AiAssistanceExternalProvider,
  expectedRevision: number,
  mutationContext: MutationRequestContext,
): Promise<AiAssistanceProviderCredentials> {
  return parseAiAssistanceProviderCredentials(await requestJson(
    `/provider-credentials/${provider}?expectedRevision=${expectedRevision}`,
    accessToken,
    { headers: createMutationHeaders(mutationContext), method: 'DELETE' },
  ))
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

/**
 * Validates and narrows an untrusted Workspace AI policy response.
 *
 * The response must use schema version 1, contain a unique allowlist of one to
 * twenty model IDs with the default included, select at least one supported
 * workflow, use a one-to-365-day retention period, and carry a non-negative
 * revision with a calendar-valid UTC timestamp.
 *
 * @param value - Unknown JSON returned by the settings endpoint.
 * @returns The validated policy when every field satisfies the client contract.
 * @throws {AiAssistanceApiError} If the response is missing, malformed, or out of bounds.
 */
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
    !isOptionalMonthlyTokenLimit(value.monthlyTokenLimit) ||
    !isOptionalMonthlyCostLimit(value.monthlyCostLimitUsd) ||
    !isNonNegativeInteger(value.revision) ||
    !isIsoTimestamp(value.updatedAt)) {
    throw invalidResponseError()
  }

  const availableModels = parseAvailableModels(value.availableModels)
  const monthlyTokenLimit = value.monthlyTokenLimit
  const monthlyCostLimitUsd = value.monthlyCostLimitUsd
  return {
    schemaVersion: 1,
    enabled: value.enabled,
    allowedModelIds: value.allowedModelIds,
    defaultModelId: value.defaultModelId,
    enabledTasks: value.enabledTasks,
    retentionDays: value.retentionDays,
    ...(monthlyTokenLimit === undefined ? {} : { monthlyTokenLimit }),
    ...(monthlyCostLimitUsd === undefined ? {} : { monthlyCostLimitUsd }),
    revision: value.revision,
    updatedAt: value.updatedAt,
    ...(availableModels === undefined ? {} : { availableModels }),
  }
}

/**
 * Checks an optional monthly token cap.
 *
 * @param value - Unknown field value.
 * @returns Whether the value is absent or a positive integer within the server bound.
 */
function isOptionalMonthlyTokenLimit(value: unknown): value is number | undefined {
  return value === undefined || (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= AI_ASSISTANCE_MAX_MONTHLY_TOKEN_LIMIT
  )
}

/**
 * Checks an optional monthly estimated-cost cap.
 *
 * @param value - Unknown field value.
 * @returns Whether the value is absent or a positive USD amount within the server bound.
 */
function isOptionalMonthlyCostLimit(value: unknown): value is number | undefined {
  return value === undefined || (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= AI_ASSISTANCE_MAX_MONTHLY_COST_LIMIT_USD
  )
}

/**
 * Validates the monthly usage response.
 *
 * @param value - Unknown JSON returned by the usage endpoint.
 * @returns The validated summary.
 * @throws {AiAssistanceApiError} If the response is malformed.
 */
function parseAiAssistanceUsageSummary(value: unknown): AiAssistanceUsageSummary {
  if (!isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.month !== 'string' ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.month) ||
    !Array.isArray(value.tasks) ||
    !Array.isArray(value.members) ||
    !isOptionalMonthlyTokenLimit(value.monthlyTokenLimit) ||
    !isOptionalMonthlyCostLimit(value.monthlyCostLimitUsd) ||
    typeof value.warning !== 'boolean' ||
    typeof value.exhausted !== 'boolean' ||
    typeof value.deploymentPaused !== 'boolean') {
    throw invalidResponseError()
  }
  const tasks = value.tasks.map((entry: unknown): AiAssistanceTaskUsage => {
    if (!isRecord(entry) || !isAiAssistanceTask(entry.task)) throw invalidResponseError()
    return { ...parseUsageTotals(entry), task: entry.task }
  })
  const members = value.members.map((entry: unknown): AiAssistanceMemberUsage => {
    if (!isRecord(entry) || !isMemberIdentifier(entry.memberId)) throw invalidResponseError()
    return { ...parseUsageTotals(entry), memberId: entry.memberId }
  })
  const monthlyTokenLimit = value.monthlyTokenLimit
  const monthlyCostLimitUsd = value.monthlyCostLimitUsd
  return {
    schemaVersion: 1,
    month: value.month,
    totals: parseUsageTotals(value.totals),
    tasks,
    members,
    ...(monthlyTokenLimit === undefined ? {} : { monthlyTokenLimit }),
    ...(monthlyCostLimitUsd === undefined ? {} : { monthlyCostLimitUsd }),
    warning: value.warning,
    exhausted: value.exhausted,
    deploymentPaused: value.deploymentPaused,
  }
}

/**
 * Validates the counts of one usage scope.
 *
 * @param value - Unknown totals object.
 * @returns Validated totals.
 * @throws {AiAssistanceApiError} If a count is missing or negative.
 */
function parseUsageTotals(value: unknown): AiAssistanceUsageTotals {
  if (!isRecord(value) ||
    !isNonNegativeInteger(value.generations) ||
    !isNonNegativeInteger(value.inputTokens) ||
    !isNonNegativeInteger(value.outputTokens) ||
    typeof value.costUsd !== 'number' ||
    !Number.isFinite(value.costUsd) ||
    value.costUsd < 0 ||
    !isNonNegativeInteger(value.costUnavailableGenerations)) {
    throw invalidResponseError()
  }
  return {
    generations: value.generations,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    costUsd: value.costUsd,
    costUnavailableGenerations: value.costUnavailableGenerations,
  }
}

/**
 * Validates the optional server-owned deployment model list.
 *
 * @param value - Unknown `availableModels` field.
 * @returns The validated list, or undefined when absent.
 * @throws {AiAssistanceApiError} If the field is present but malformed.
 */
function parseAvailableModels(value: unknown): AiAssistanceAvailableModel[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > AI_ASSISTANCE_MAX_AVAILABLE_MODELS) throw invalidResponseError()
  return value.map((entry: unknown) => {
    if (!isRecord(entry) || !isIdentifier(entry.modelId)) throw invalidResponseError()
    const provider = aiAssistanceProviders.find((candidate) => candidate === entry.provider)
    if (provider === undefined) throw invalidResponseError()
    return { modelId: entry.modelId, provider }
  })
}

/**
 * Validates the key-free provider status response.
 *
 * @param value - Unknown JSON returned by the provider key endpoints.
 * @returns Validated status per provider.
 * @throws {AiAssistanceApiError} If the response is malformed.
 */
function parseAiAssistanceProviderCredentials(value: unknown): AiAssistanceProviderCredentials {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.providers)) {
    throw invalidResponseError()
  }
  const providers = value.providers.map((entry: unknown): AiAssistanceProviderCredentialStatus => {
    if (!isRecord(entry) ||
      typeof entry.deploymentEnabled !== 'boolean' ||
      typeof entry.configured !== 'boolean' ||
      !isNonNegativeInteger(entry.revision) ||
      (entry.keyHint !== undefined && (typeof entry.keyHint !== 'string' || entry.keyHint.length !== 4)) ||
      (entry.updatedAt !== undefined && !isIsoTimestamp(entry.updatedAt))) {
      throw invalidResponseError()
    }
    const provider = aiAssistanceExternalProviders.find((candidate) => candidate === entry.provider)
    if (provider === undefined) throw invalidResponseError()
    return {
      provider,
      deploymentEnabled: entry.deploymentEnabled,
      configured: entry.configured,
      ...(typeof entry.keyHint === 'string' ? { keyHint: entry.keyHint } : {}),
      revision: entry.revision,
      ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}),
    }
  })
  return { schemaVersion: 1, providers }
}

/** Validates an untrusted personal AI preference response. */
function parseAiAssistancePreference(value: unknown): AiAssistancePreference {
  if (!isRecord(value) ||
    value.schemaVersion !== 1 ||
    (value.deploymentEnabled !== undefined && typeof value.deploymentEnabled !== 'boolean') ||
    typeof value.enabled !== 'boolean' ||
    !isNonNegativeInteger(value.revision) ||
    !isIsoTimestamp(value.updatedAt)) {
    throw invalidResponseError()
  }

  return {
    schemaVersion: 1,
    enabled: value.enabled,
    ...(typeof value.deploymentEnabled === 'boolean' ? { deploymentEnabled: value.deploymentEnabled } : {}),
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

/**
 * Reads and parses one required JSON settings response.
 *
 * Empty bodies, body-read failures, and malformed JSON are converted to the
 * same stable invalid-response error so callers never handle transport details.
 *
 * @param response - Fetch response whose body must contain JSON.
 * @returns The untrusted parsed JSON value for a subsequent schema validator.
 * @throws {AiAssistanceApiError} If the body cannot be read, is empty, or is not valid JSON.
 */
async function readJson(response: Response): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch {
    throw invalidResponseError(response.status)
  }
  if (!text) throw invalidResponseError(response.status)

  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
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

/** Validates the bounded model allowlist returned by the API. */
function isModelIdArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 20 &&
    value.every(isIdentifier)
}

/** Validates one normalized bounded identifier. */
/** Longest member identifier the server records in a usage counter. */
const MAX_MEMBER_IDENTIFIER_LENGTH = 320

/**
 * Checks a member identifier from a usage summary, which allows up to 320 characters like the
 * server's member counters.
 *
 * @param value - Unknown value from the response.
 * @returns Whether the value is a trimmed, non-empty member identifier.
 */
function isMemberIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_MEMBER_IDENTIFIER_LENGTH &&
    value === value.trim()
}

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

/**
 * Validates the server's UTC ISO 8601 timestamp representation.
 *
 * Only a `Z` designator is accepted; the date and clock fields are checked for
 * real Gregorian calendar values, with at most three fractional-second digits.
 *
 * @param value - Unknown timestamp value from an API response.
 * @returns Whether the value is a calendar-valid UTC timestamp in the contract format.
 */
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
