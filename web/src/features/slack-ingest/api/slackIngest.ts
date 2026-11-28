import {
  isSlackChannelId,
  parseSlackChannelTarget,
  type SlackChannelSummary,
  type SlackChannelTarget,
  type SlackIngestStatusResponse,
  type SlackMessageView,
  type WorkItemSlackMessagesResponse,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../../shared/api/apiBaseUrl'
import { createMutationHeaders, type MutationRequestContext } from '../../../shared/api/mutationHeaders'

/** Base URL of the Workspace administration routes. */
const workspaceApiBaseUrl = resolveApiBaseUrl('workspace')

/** Base URL of the Work Item routes. */
const workItemsApiBaseUrl = resolveApiBaseUrl()

/** Error of a Slack ingest request with its HTTP status and stable code. */
export class SlackIngestApiError extends Error {
  /** HTTP status, or 0 when the request did not reach the server. */
  readonly status: number
  /** Stable server code, when the server returned one. */
  readonly code?: string

  /**
   * Creates the error.
   *
   * @param status - HTTP status.
   * @param message - Message.
   * @param code - Server code.
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'SlackIngestApiError'
    this.status = status
    if (code !== undefined) this.code = code
  }
}

/**
 * Returns whether a value is a plain object.
 *
 * @param value - Value to check.
 * @returns Whether it is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Creates the error for a response that does not match the contract.
 *
 * @returns The error.
 */
function invalidResponse(): SlackIngestApiError {
  return new SlackIngestApiError(502, 'Slack ingest response was malformed.')
}

/**
 * Sends an authenticated request and reads its JSON body.
 *
 * @param url - Absolute or base-relative URL.
 * @param accessToken - Access token.
 * @param init - Request options.
 * @returns The parsed body.
 * @throws SlackIngestApiError when the request fails.
 */
async function requestJson(url: string, accessToken: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, ...init.headers } })
  } catch {
    throw new SlackIngestApiError(0, 'Slack ingest request failed.')
  }
  let body: unknown
  try {
    const text = await response.text()
    body = text ? JSON.parse(text) : undefined
  } catch {
    throw new SlackIngestApiError(response.ok ? 502 : response.status, 'Slack ingest response was malformed.')
  }
  if (!response.ok) {
    throw new SlackIngestApiError(
      response.status,
      isRecord(body) && typeof body.message === 'string' ? body.message : 'Slack ingest request failed.',
      isRecord(body) && typeof body.code === 'string' ? body.code : undefined,
    )
  }
  return body
}

/**
 * Validates one channel of a response.
 *
 * @param value - Raw channel.
 * @returns The channel.
 */
function parseChannel(value: unknown): SlackChannelSummary {
  if (
    !isRecord(value) ||
    !isSlackChannelId(value.channelId) ||
    typeof value.isPrivate !== 'boolean' ||
    (value.membership !== 'joined' && value.membership !== 'left') ||
    typeof value.updatedAt !== 'string'
  ) {
    throw invalidResponse()
  }
  let target: SlackChannelTarget | undefined
  try {
    target = value.target === undefined ? undefined : parseSlackChannelTarget(value.target)
  } catch {
    throw invalidResponse()
  }
  const backfill = value.backfill
  const status = isRecord(backfill) ? backfill.status : undefined
  return {
    channelId: value.channelId,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    isPrivate: value.isPrivate,
    membership: value.membership,
    ...(target ? { target } : {}),
    ...(isRecord(backfill) && typeof backfill.importedCount === 'number' &&
      (status === 'pending' || status === 'running' || status === 'completed' || status === 'failed')
      ? { backfill: { status, importedCount: backfill.importedCount } }
      : {}),
    updatedAt: value.updatedAt,
  }
}

/**
 * Reads the Slack app status, retention, and channels of the Workspace.
 *
 * @param accessToken - Administrator access token.
 * @returns The status.
 */
export async function getSlackIngestStatus(accessToken: string): Promise<SlackIngestStatusResponse> {
  const body = await requestJson(`${workspaceApiBaseUrl}/workspace/slack-ingest`, accessToken)
  if (
    !isRecord(body) ||
    typeof body.configured !== 'boolean' ||
    typeof body.workspaceId !== 'string' ||
    typeof body.retentionDays !== 'number' ||
    typeof body.settingsRevision !== 'number' ||
    !Array.isArray(body.channels)
  ) {
    throw invalidResponse()
  }
  return {
    configured: body.configured,
    workspaceId: body.workspaceId,
    ...(typeof body.slackTeamId === 'string' ? { slackTeamId: body.slackTeamId } : {}),
    retentionDays: body.retentionDays,
    settingsRevision: body.settingsRevision,
    channels: body.channels.map(parseChannel),
  }
}

/**
 * Maps a channel to a Team or Project, or unmaps it.
 *
 * @param accessToken - Administrator access token.
 * @param channelId - Channel ID.
 * @param target - Target, or `null` to unmap.
 * @param context - Mutation context shared with retries.
 * @returns The channel after the change.
 */
export async function updateSlackChannelTarget(
  accessToken: string,
  channelId: string,
  target: SlackChannelTarget | null,
  context: MutationRequestContext,
): Promise<SlackChannelSummary> {
  return parseChannel(await requestJson(
    `${workspaceApiBaseUrl}/workspace/slack-ingest/channels/${encodeURIComponent(channelId)}/target`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({ target }),
      headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
    },
  ))
}

/**
 * Saves the retention.
 *
 * @param accessToken - Administrator access token.
 * @param retentionDays - Days to keep messages.
 * @param expectedRevision - Revision read.
 * @param context - Mutation context shared with retries.
 */
export async function updateSlackIngestSettings(
  accessToken: string,
  retentionDays: number,
  expectedRevision: number,
  context: MutationRequestContext,
): Promise<void> {
  await requestJson(`${workspaceApiBaseUrl}/workspace/slack-ingest/settings`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ retentionDays, expectedRevision }),
    headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
  })
}

/**
 * Validates one message of a response.
 *
 * @param value - Raw message.
 * @returns The message.
 */
function parseMessage(value: unknown): SlackMessageView {
  if (
    !isRecord(value) ||
    !isSlackChannelId(value.channelId) ||
    typeof value.ts !== 'string' ||
    typeof value.authorId !== 'string' ||
    typeof value.text !== 'string' ||
    typeof value.postedAt !== 'string' ||
    typeof value.permalink !== 'string' ||
    !value.permalink.startsWith('https://')
  ) {
    throw invalidResponse()
  }
  return {
    channelId: value.channelId,
    ...(typeof value.channelName === 'string' ? { channelName: value.channelName } : {}),
    ts: value.ts,
    ...(typeof value.threadTs === 'string' ? { threadTs: value.threadTs } : {}),
    authorId: value.authorId,
    ...(typeof value.authorName === 'string' ? { authorName: value.authorName } : {}),
    text: value.text,
    postedAt: value.postedAt,
    ...(typeof value.editedAt === 'string' ? { editedAt: value.editedAt } : {}),
    permalink: value.permalink,
  }
}

/**
 * Lists the Slack messages that mention a Work Item's key.
 *
 * @param accessToken - Access token.
 * @param teamId - Team of the Work Item.
 * @param workItemId - Work Item ID.
 * @returns Messages newest first.
 */
export async function listWorkItemSlackMessages(
  accessToken: string,
  teamId: string,
  workItemId: string,
): Promise<WorkItemSlackMessagesResponse> {
  const body = await requestJson(
    `${workItemsApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(workItemId)}/slack-messages`,
    accessToken,
  )
  if (!isRecord(body) || !Array.isArray(body.messages) || typeof body.truncated !== 'boolean') throw invalidResponse()
  return { messages: body.messages.map(parseMessage), truncated: body.truncated }
}
