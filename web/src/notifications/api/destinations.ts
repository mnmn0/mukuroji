import {
  NOTIFICATION_DESTINATION_TEST_FAILURE_CODES,
  type NotificationChannelDestination,
  type NotificationChannelDestinationProvider,
  type NotificationDestinationTestResult,
  type NotificationMessageLocale,
  type PersonalSlackDestination,
  type SaveNotificationChannelDestinationRequest,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { NotificationsApiError } from './errors'

const apiBaseUrl = resolveApiBaseUrl()

/** Chat service of every destination this client registers. */
const slackProvider: NotificationChannelDestinationProvider = 'slack'

/** Team, or Project within a Team, that owns a channel destination. */
export type ChannelDestinationOwner = {
  /** Team ID. */
  teamId: string
  /** Project ID; absent for the Team's own channel. */
  projectId?: string
}

/**
 * Builds the URL of the caller's own Slack destination.
 * @returns Absolute API URL.
 */
function personalUrl() {
  return `${apiBaseUrl}/notification-preferences/slack-destination`
}

/**
 * Builds the URL of a Team or Project channel destination.
 * @param owner - Team, or Project within a Team.
 * @returns Absolute API URL.
 */
function channelUrl(owner: ChannelDestinationOwner) {
  const team = `${apiBaseUrl}/teams/${encodeURIComponent(owner.teamId)}`
  return owner.projectId
    ? `${team}/projects/${encodeURIComponent(owner.projectId)}/notification-channel`
    : `${team}/notification-channel`
}

/**
 * Reads whether the caller has a Slack destination.
 * @param accessToken - API access token.
 * @returns Whether a webhook is registered.
 */
export async function getPersonalSlackDestination(accessToken: string): Promise<PersonalSlackDestination> {
  return readPersonal(await request(personalUrl(), accessToken))
}

/**
 * Registers or replaces the caller's Slack webhook.
 * @param accessToken - API access token.
 * @param webhookUrl - Incoming Webhook URL.
 * @returns The new state.
 */
export async function savePersonalSlackDestination(accessToken: string, webhookUrl: string): Promise<PersonalSlackDestination> {
  return readPersonal(await request(personalUrl(), accessToken, { method: 'PUT', body: { webhookUrl } }))
}

/**
 * Removes the caller's Slack webhook.
 * @param accessToken - API access token.
 * @returns The new state.
 */
export async function deletePersonalSlackDestination(accessToken: string): Promise<PersonalSlackDestination> {
  return readPersonal(await request(personalUrl(), accessToken, { method: 'DELETE' }))
}

/**
 * Sends a test message to the caller's Slack webhook.
 * @param accessToken - API access token.
 * @param locale - Language of the test message.
 * @returns Whether Slack accepted it.
 */
export async function testPersonalSlackDestination(
  accessToken: string,
  locale: NotificationMessageLocale,
): Promise<NotificationDestinationTestResult> {
  return readTestResult(await request(`${personalUrl()}/test`, accessToken, { method: 'POST', body: { locale } }))
}

/**
 * Reads a Team or Project channel destination.
 * @param accessToken - API access token.
 * @param owner - Team, or Project within a Team.
 * @returns The destination settings, without the webhook URL.
 */
export async function getChannelDestination(accessToken: string, owner: ChannelDestinationOwner) {
  return readChannel(await request(channelUrl(owner), accessToken))
}

/**
 * Saves a Team or Project channel destination.
 * @param accessToken - API access token.
 * @param owner - Team, or Project within a Team.
 * @param body - Webhook (when replaced), name, language, and the revision read.
 * @returns The saved settings.
 */
export async function saveChannelDestination(
  accessToken: string,
  owner: ChannelDestinationOwner,
  body: SaveNotificationChannelDestinationRequest,
) {
  return readChannel(await request(channelUrl(owner), accessToken, { method: 'PUT', body }))
}

/**
 * Removes a Team or Project channel destination.
 * @param accessToken - API access token.
 * @param owner - Team, or Project within a Team.
 * @param expectedRevision - Revision the caller read.
 * @returns The cleared settings.
 */
export async function deleteChannelDestination(accessToken: string, owner: ChannelDestinationOwner, expectedRevision: number) {
  return readChannel(await request(`${channelUrl(owner)}?expectedRevision=${expectedRevision}`, accessToken, { method: 'DELETE' }))
}

/**
 * Sends a test message to a Team or Project channel.
 * @param accessToken - API access token.
 * @param owner - Team, or Project within a Team.
 * @returns Whether Slack accepted it.
 */
export async function testChannelDestination(accessToken: string, owner: ChannelDestinationOwner) {
  return readTestResult(await request(`${channelUrl(owner)}/test`, accessToken, { method: 'POST', body: {} }))
}

/**
 * Sends one request and returns the parsed body of a success.
 * @param url - API URL.
 * @param accessToken - API access token.
 * @param options - Method and JSON body.
 * @returns Parsed response body.
 * @throws NotificationsApiError for an error status.
 */
async function request(
  url: string,
  accessToken: string,
  options: {
    /** HTTP method. */
    method?: 'PUT' | 'POST' | 'DELETE'
    /** JSON body. */
    body?: unknown
  } = {},
): Promise<unknown> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const data: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new NotificationsApiError(
      response.status,
      readString(data, 'message') ?? 'Unable to complete the notification destination request.',
      readString(data, 'code'),
    )
  }
  return data
}

/**
 * Validates a personal destination response.
 * @param value - Parsed body.
 * @returns The state.
 * @throws NotificationsApiError for an unexpected body.
 */
function readPersonal(value: unknown): PersonalSlackDestination {
  if (!isRecord(value) || typeof value.configured !== 'boolean') throw unexpected()
  return { configured: value.configured }
}

/**
 * Validates a channel destination response.
 * @param value - Parsed body.
 * @returns The settings.
 * @throws NotificationsApiError for an unexpected body.
 */
function readChannel(value: unknown): NotificationChannelDestination {
  if (!isRecord(value)) throw unexpected()
  const { scope, teamId, projectId, configured, label, locale, updatedAt, revision, canManage } = value
  if (
    (scope !== 'team' && scope !== 'project') || typeof teamId !== 'string' ||
    (projectId !== undefined && typeof projectId !== 'string') || typeof configured !== 'boolean' ||
    (label !== undefined && typeof label !== 'string') || (locale !== 'ja' && locale !== 'en') ||
    (updatedAt !== undefined && typeof updatedAt !== 'string') || typeof revision !== 'number' ||
    typeof canManage !== 'boolean'
  ) throw unexpected()
  return {
    scope,
    teamId,
    ...(typeof projectId === 'string' ? { projectId } : {}),
    configured,
    ...(configured ? { provider: slackProvider } : {}),
    ...(typeof label === 'string' ? { label } : {}),
    locale,
    ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
    revision,
    canManage,
  }
}

/**
 * Validates a test result response.
 * @param value - Parsed body.
 * @returns The result.
 * @throws NotificationsApiError for an unexpected body.
 */
function readTestResult(value: unknown): NotificationDestinationTestResult {
  if (!isRecord(value) || typeof value.delivered !== 'boolean') throw unexpected()
  const code = NOTIFICATION_DESTINATION_TEST_FAILURE_CODES.find((candidate) => candidate === value.code)
  return { delivered: value.delivered, ...(code ? { code } : {}) }
}

/**
 * Builds the error of a response this client does not understand.
 * @returns A 502 error.
 */
function unexpected() {
  return new NotificationsApiError(502, 'The notification destination response was not understood.')
}

/**
 * Reads a non-empty string field from an untrusted object.
 * @param value - Untrusted value.
 * @param field - Field name.
 * @returns The string, or undefined.
 */
function readString(value: unknown, field: string) {
  if (!isRecord(value)) return undefined
  const text = value[field]
  return typeof text === 'string' && text.trim() ? text : undefined
}

/**
 * Narrows an untrusted value to a plain object.
 * @param value - Untrusted value.
 * @returns Whether it is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
