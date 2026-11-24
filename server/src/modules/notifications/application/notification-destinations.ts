import {
  NOTIFICATION_CHANNEL_DESTINATION_LABEL_MAX_LENGTH,
  NOTIFICATION_MESSAGE_LOCALES,
  isSlackIncomingWebhookUrl,
  type NotificationChannelDestination,
  type NotificationDestinationTestFailureCode,
  type NotificationDestinationTestResult,
  type NotificationMessageLocale,
} from '@mukuroji/contracts'
import type { AuditTransactWriteItem } from '../../audit'
import type { ChannelDestinationRecord, ChannelDestinationTarget } from '../domain/channel-destination'
import { NotificationError } from '../domain/notification-error'
import type { ChannelSendResult } from './channel-delivery'
import type { ChannelDestinationStore } from './ports/channel-posts'

/** Webhook storage the destination use cases need; it never returns a URL to a client. */
export type NotificationDestinationSecrets = {
  /** Stores or replaces a webhook URL under a server-derived name. */
  put(secretId: string, webhookUrl: string): Promise<void>
  /** Reads a webhook URL, or undefined when none is stored. */
  read(secretId: string): Promise<string | undefined>
  /** Reports whether a webhook is stored. */
  exists(secretId: string): Promise<boolean>
  /** Deletes a webhook; a missing one is not an error. */
  delete(secretId: string): Promise<void>
}

/** Sends the fixed test message to a webhook. */
export type NotificationDestinationTestSender = (
  webhookUrl: string | undefined,
  locale: NotificationMessageLocale,
) => Promise<ChannelSendResult>

/** Validated body of a channel destination save. */
export type ChannelDestinationSaveBody = {
  /** New webhook URL, when the caller replaces it. */
  webhookUrl?: string
  /** Channel name, or undefined to clear it. */
  label?: string
  /** Language of the posts. */
  locale: NotificationMessageLocale
  /** Revision the caller read. */
  expectedRevision: number
}

/**
 * Validates the body of a channel destination save. The URL is checked here so an invalid one
 * is never stored; it is never echoed back in the error.
 *
 * @param value - Parsed request JSON.
 * @returns The validated body.
 * @throws NotificationError (400) for an invalid field.
 */
export function readChannelDestinationSaveBody(value: unknown): ChannelDestinationSaveBody {
  const body = isRecord(value) ? value : {}
  const webhookUrl = body.webhookUrl
  if (webhookUrl !== undefined && !isSlackIncomingWebhookUrl(webhookUrl)) throw invalidWebhook()
  const label = body.label
  if (label !== undefined && (typeof label !== 'string' || label.trim().length > NOTIFICATION_CHANNEL_DESTINATION_LABEL_MAX_LENGTH)) {
    throw new NotificationError(400, 'InvalidNotificationDestination', `Channel name must be at most ${NOTIFICATION_CHANNEL_DESTINATION_LABEL_MAX_LENGTH} characters.`)
  }
  const locale = NOTIFICATION_MESSAGE_LOCALES.find((candidate) => candidate === body.locale)
  if (!locale) throw new NotificationError(400, 'InvalidNotificationDestination', 'Language must be ja or en.')
  const expectedRevision = readRevision(body.expectedRevision)
  const trimmedLabel = typeof label === 'string' ? singleLine(label) : ''
  return {
    ...(typeof webhookUrl === 'string' ? { webhookUrl: webhookUrl.trim() } : {}),
    ...(trimmedLabel ? { label: trimmedLabel } : {}),
    locale,
    expectedRevision,
  }
}

/**
 * Reads the revision of a delete request.
 * @param value - Query value or parsed JSON field.
 * @returns The revision, at least 1.
 * @throws NotificationError (400) when it is missing or not a positive integer.
 */
export function readExpectedRevision(value: unknown): number {
  const revision = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new NotificationError(400, 'InvalidNotificationDestination', 'expectedRevision must be a positive integer.')
  }
  return revision
}

/**
 * Validates the webhook URL of a personal destination save.
 * @param value - Parsed request JSON.
 * @returns The trimmed URL.
 * @throws NotificationError (400) when it is not an official Slack Incoming Webhook URL.
 */
export function readPersonalSlackWebhookUrl(value: unknown): string {
  const url = isRecord(value) ? value.webhookUrl : undefined
  if (!isSlackIncomingWebhookUrl(url)) throw invalidWebhook()
  return url.trim()
}

/**
 * Builds the settings-screen view of a channel destination.
 * @param target - Team or Project.
 * @param record - Saved settings, or undefined.
 * @param canManage - Whether the caller may change it.
 * @returns The public view, without the webhook URL.
 */
export function toPublicChannelDestination(
  target: ChannelDestinationTarget,
  record: ChannelDestinationRecord | undefined,
  canManage: boolean,
): NotificationChannelDestination {
  return {
    scope: target.scope,
    teamId: target.teamId,
    ...(target.scope === 'project' ? { projectId: target.projectId } : {}),
    configured: Boolean(record),
    ...(record ? { provider: record.provider, updatedAt: record.updatedAt } : {}),
    ...(record?.label ? { label: record.label } : {}),
    locale: record?.locale ?? 'ja',
    revision: record?.revision ?? 0,
    canManage,
  }
}

/** Inputs of a channel destination save. */
export type SaveChannelDestinationCommand = {
  /** Canonical Workspace ID. */
  workspaceId: string
  /** Team or Project. */
  target: ChannelDestinationTarget
  /** Server-derived secret name of one webhook version of the target. */
  secretIdOf(secretVersion: string): string
  /** Fresh version a new webhook is stored under. */
  newSecretVersion: string
  /** Validated body. */
  body: ChannelDestinationSaveBody
  /** Member who saves. */
  memberKey: string
  /** Save time. */
  now: Date
  /** Commit-time authorization fences. */
  authorizationConditionChecks: readonly AuditTransactWriteItem[]
  /** Audit event built for this save. */
  auditPut?: AuditTransactWriteItem
}

/**
 * Saves a channel destination. A new webhook is written to Secrets Manager under a new version
 * first, and the fenced settings save switches to that version, so a save rejected by its revision
 * or authorization fences never changes where posts go. The candidate is removed after a rejected
 * save and the replaced version after a committed one. A first save needs a webhook.
 *
 * @param store - Settings store.
 * @param secrets - Webhook storage.
 * @param command - Target, body, caller, and fences.
 * @returns The saved settings.
 */
export async function saveChannelDestination(
  store: ChannelDestinationStore,
  secrets: Pick<NotificationDestinationSecrets, 'put' | 'delete'>,
  command: SaveChannelDestinationCommand,
): Promise<ChannelDestinationRecord> {
  const current = await store.get(command.workspaceId, command.target)
  if ((current?.revision ?? 0) !== command.body.expectedRevision) {
    throw new NotificationError(409, 'NotificationDestinationConflict', 'The destination changed before this change was saved. Reload and try again.')
  }
  if (!current && !command.body.webhookUrl) {
    throw new NotificationError(400, 'InvalidNotificationDestination', 'A Slack Incoming Webhook URL is required.')
  }
  const replacesWebhook = Boolean(command.body.webhookUrl)
  const secretVersion = replacesWebhook ? command.newSecretVersion : current?.secretVersion
  if (!secretVersion) {
    throw new NotificationError(400, 'InvalidNotificationDestination', 'A Slack Incoming Webhook URL is required.')
  }
  if (command.body.webhookUrl) await secrets.put(command.secretIdOf(secretVersion), command.body.webhookUrl)
  let record: ChannelDestinationRecord
  try {
    record = await store.save({
      workspaceId: command.workspaceId,
      target: command.target,
      ...(command.body.label ? { label: command.body.label } : {}),
      locale: command.body.locale,
      expectedRevision: command.body.expectedRevision,
      secretVersion,
      updatedBy: command.memberKey,
      now: command.now,
      authorizationConditionChecks: command.authorizationConditionChecks,
      ...(command.auditPut ? { auditPut: command.auditPut } : {}),
    })
  } catch (error) {
    // The settings still point at the previous version; drop the unused candidate.
    if (replacesWebhook) await deleteQuietly(secrets, command.secretIdOf(secretVersion))
    throw error
  }
  if (replacesWebhook && current && current.secretVersion !== secretVersion) {
    await deleteQuietly(secrets, command.secretIdOf(current.secretVersion))
  }
  return record
}

/**
 * Deletes a webhook version that no settings point at. A failure leaves an unused secret, which
 * Workspace closure removes with the rest of the namespace.
 * @param secrets - Webhook storage.
 * @param secretId - Secret name.
 */
async function deleteQuietly(secrets: Pick<NotificationDestinationSecrets, 'delete'>, secretId: string) {
  try {
    await secrets.delete(secretId)
  } catch {
    // Unreferenced; nothing reads it.
  }
}

/** Inputs of a channel destination delete. */
export type DeleteChannelDestinationCommand = {
  /** Canonical Workspace ID. */
  workspaceId: string
  /** Team or Project. */
  target: ChannelDestinationTarget
  /** Server-derived secret name of one webhook version of the target. */
  secretIdOf(secretVersion: string): string
  /** Revision the caller read. */
  expectedRevision: number
  /** Commit-time authorization fences. */
  authorizationConditionChecks: readonly AuditTransactWriteItem[]
  /** Audit event built for this delete. */
  auditPut?: AuditTransactWriteItem
}

/**
 * Deletes a channel destination: the settings row first, so posts stop at once, then the secret.
 * Queued posts whose destination is gone are dropped when they come due.
 *
 * @param store - Settings store.
 * @param secrets - Webhook storage.
 * @param command - Target, revision, and fences.
 */
export async function deleteChannelDestination(
  store: ChannelDestinationStore,
  secrets: Pick<NotificationDestinationSecrets, 'delete'>,
  command: DeleteChannelDestinationCommand,
): Promise<void> {
  const current = await store.get(command.workspaceId, command.target)
  if (!current || current.revision !== command.expectedRevision) {
    throw new NotificationError(409, 'NotificationDestinationConflict', 'The destination changed before this change was saved. Reload and try again.')
  }
  await store.delete({
    workspaceId: command.workspaceId,
    target: command.target,
    expectedRevision: command.expectedRevision,
    authorizationConditionChecks: command.authorizationConditionChecks,
    ...(command.auditPut ? { auditPut: command.auditPut } : {}),
  })
  await deleteQuietly(secrets, command.secretIdOf(current.secretVersion))
}

/**
 * Sends the fixed test message to a stored webhook and reports the outcome without the
 * provider's response.
 *
 * @param secrets - Webhook storage.
 * @param secretId - Server-derived secret name.
 * @param locale - Language of the test message.
 * @param send - Test message transport.
 * @returns Whether the chat service accepted the message.
 */
export async function testNotificationDestination(
  secrets: Pick<NotificationDestinationSecrets, 'read'>,
  secretId: string,
  locale: NotificationMessageLocale,
  send: NotificationDestinationTestSender,
): Promise<NotificationDestinationTestResult> {
  const webhookUrl = await secrets.read(secretId)
  if (webhookUrl === undefined) return { delivered: false, code: 'DestinationNotConfigured' }
  const result = await send(webhookUrl, locale)
  if (result.succeeded) return { delivered: true }
  return { delivered: false, code: toTestFailureCode(result.code) }
}

/**
 * Maps a transport code to a public test failure code.
 * @param code - Transport code.
 * @returns The public code.
 */
function toTestFailureCode(code: string | undefined): NotificationDestinationTestFailureCode {
  if (code === 'SlackDestinationInvalid' || code === 'SlackDeliveryRejected') return code
  return 'SlackDeliveryUnavailable'
}

/**
 * Builds the stable error of an invalid webhook URL, without echoing it.
 * @returns A 400 error.
 */
function invalidWebhook(): NotificationError {
  return new NotificationError(400, 'InvalidNotificationDestination', 'Enter a Slack Incoming Webhook URL that starts with https://hooks.slack.com/services/.')
}

/**
 * Reads the revision of a save.
 * @param value - Parsed field.
 * @returns The revision, 0 or more.
 * @throws NotificationError (400) when it is not a non-negative integer.
 */
function readRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new NotificationError(400, 'InvalidNotificationDestination', 'expectedRevision must be a non-negative integer.')
  }
  return value
}

/**
 * Collapses a channel name to one trimmed line.
 * @param value - Typed name.
 * @returns Name without control characters.
 */
function singleLine(value: string): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f ? ' ' : character
  }).join('').trim()
}

/**
 * Reports whether a value is a plain object.
 * @param value - Parsed JSON.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
