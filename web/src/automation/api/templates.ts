import {
  AUTOMATION_SCHEMA_VERSION,
  type ApplyAutomationTemplateInput,
  type AutomationTemplate,
  type AutomationTemplateApplication,
  type AutomationTemplateKind,
  type CreateAutomationTemplateInput,
  type UpdateAutomationTemplateInput,
} from '@mukuroji/contracts'
import { isNonnegativeSafeInteger, isRecord } from '../../shared/api/jsonValidation'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { AutomationApiError, resolveAutomationApiBaseUrl } from './errors'

/** Template kinds accepted from the template collection response. */
const automationTemplateKinds: readonly AutomationTemplateKind[] = ['work-item', 'project', 'workflow']

const automationApiBaseUrl = resolveAutomationApiBaseUrl(import.meta.env)

const defaultAutomationApiErrorMessage = 'Unable to complete the automation request.'

/**
 * Workspace の automation template を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @returns Template 一覧です。
 */
export function getAutomationTemplates(accessToken: string) {
  return requestCollection(
    `${automationApiBaseUrl}/automation/templates`,
    accessToken,
    'templates',
    isAutomationTemplate,
  )
}

/**
 * Automation template を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Template editor で作成した入力です。
 * @param mutationContext - Retry 間で共有する mutation request context です。
 * @returns 作成した template です。
 */
export function createAutomationTemplate(
  accessToken: string,
  input: CreateAutomationTemplateInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<AutomationTemplate>(
    `${automationApiBaseUrl}/automation/templates`,
    accessToken,
    'POST',
    input,
    mutationContext,
  )
}

/**
 * Automation template を部分更新します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param templateId - 更新対象 template ID です。
 * @param input - Template の部分更新入力です。
 * @param mutationContext - Retry 間で共有する mutation request context です。
 * @returns 更新した template です。
 */
export function updateAutomationTemplate(
  accessToken: string,
  templateId: string,
  input: UpdateAutomationTemplateInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<AutomationTemplate>(
    `${automationApiBaseUrl}/automation/templates/${encodeURIComponent(templateId)}`,
    accessToken,
    'PATCH',
    input,
    mutationContext,
  )
}

/**
 * Automation template の複製を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param templateId - 複製元 template ID です。
 * @param mutationContext - Retry 間で共有する mutation request context です。
 * @returns 作成した template です。
 */
export function duplicateAutomationTemplate(
  accessToken: string,
  templateId: string,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<AutomationTemplate>(
    `${automationApiBaseUrl}/automation/templates/${encodeURIComponent(templateId)}/duplicate`,
    accessToken,
    'POST',
    undefined,
    mutationContext,
  )
}

/**
 * Project または Workflow template を immutable version pin 付きで適用します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param templateId - 適用対象 template ID です。
 * @param input - Team または configuration scope を含む適用先です。
 * @param mutationContext - Idempotency-Key を固定する mutation context です。
 * @returns Durable application receipt です。
 */
export function applyAutomationTemplate(
  accessToken: string,
  templateId: string,
  input: ApplyAutomationTemplateInput,
  mutationContext: MutationRequestContext,
) {
  return requestMutation<AutomationTemplateApplication>(
    `${automationApiBaseUrl}/automation/templates/${encodeURIComponent(templateId)}/applications`,
    accessToken,
    'POST',
    input,
    mutationContext,
  )
}

/**
 * Durable template application の最新状態を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param applicationId - Application receipt ID です。
 * @returns 最新 application receipt です。
 */
export function getAutomationTemplateApplication(
  accessToken: string,
  applicationId: string,
) {
  return requestJson<AutomationTemplateApplication>(
    `${automationApiBaseUrl}/automation/template-applications/${encodeURIComponent(applicationId)}`,
    accessToken,
  )
}

/**
 * Loads the canonical collection property returned by an automation list endpoint.
 *
 * @param url - Collection endpoint URL.
 * @param accessToken - Access token used for the Authorization header.
 * @param collectionKey - Response property that owns the collection.
 * @param isItem - Runtime guard for one collection entry.
 * @returns Validated collection entries.
 * @throws AutomationApiError when the response does not contain a valid collection.
 */
async function requestCollection<TItem>(
  url: string,
  accessToken: string,
  collectionKey: string,
  isItem: (value: unknown) => value is TItem,
): Promise<TItem[]> {
  const response = await requestJson<unknown>(url, accessToken)
  const collection = isRecord(response) ? response[collectionKey] : undefined

  if (!Array.isArray(collection) || !collection.every(isItem)) {
    throw new AutomationApiError(
      502,
      'Automation API returned an invalid response.',
      'InvalidAutomationResponse',
    )
  }

  return collection
}

/**
 * Returns whether a collection entry has the automation template fields used by the Web client.
 *
 * @param value - Unknown entry from the template collection response.
 * @returns Whether the entry is a versioned automation template.
 */
function isAutomationTemplate(value: unknown): value is AutomationTemplate {
  return isRecord(value) &&
    value.schemaVersion === AUTOMATION_SCHEMA_VERSION &&
    typeof value.id === 'string' &&
    typeof value.workspaceId === 'string' &&
    automationTemplateKinds.some((kind) => kind === value.kind) &&
    typeof value.name === 'string' &&
    typeof value.enabled === 'boolean' &&
    isNonnegativeSafeInteger(value.version) &&
    isNonnegativeSafeInteger(value.revision) &&
    isRecord(value.payload) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
}

function requestMutation<TResponse>(
  url: string,
  accessToken: string,
  method: 'DELETE' | 'PATCH' | 'POST',
  input: unknown,
  mutationContext: MutationRequestContext,
) {
  return requestJson<TResponse>(url, accessToken, {
    body: input === undefined ? undefined : JSON.stringify(input),
    headers: {
      ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...createMutationHeaders(mutationContext),
    },
    method,
  })
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
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    const error = toRecord(data)
    const message = typeof error.message === 'string' && error.message.trim()
      ? error.message
      : defaultAutomationApiErrorMessage
    const code = typeof error.code === 'string' ? error.code : undefined

    throw new AutomationApiError(response.status, message, code)
  }

  return data as TResponse
}

async function readJson<TResponse>(response: Response): Promise<TResponse> {
  const text = await response.text()

  if (!text) return {} as TResponse

  try {
    return JSON.parse(text) as TResponse
  } catch {
    throw new AutomationApiError(
      response.status,
      'Automation API returned invalid JSON.',
      'InvalidAutomationResponse',
    )
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
}
