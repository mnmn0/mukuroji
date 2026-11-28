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
import type { ChannelDestinationStore, RetiredChannelSecret, RetiredChannelSecretStore } from './ports/channel-posts'

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
 * @param removedRevision - Revision of a removed destination, which the next save must name.
 * @returns The public view, without the webhook URL.
 */
export function toPublicChannelDestination(
  target: ChannelDestinationTarget,
  record: ChannelDestinationRecord | undefined,
  canManage: boolean,
  removedRevision = 0,
): NotificationChannelDestination {
  return {
    scope: target.scope,
    teamId: target.teamId,
    ...(target.scope === 'project' ? { projectId: target.projectId } : {}),
    configured: Boolean(record),
    ...(record ? { provider: record.provider, updatedAt: record.updatedAt } : {}),
    ...(record?.label ? { label: record.label } : {}),
    locale: record?.locale ?? 'ja',
    revision: record?.revision ?? removedRevision,
    canManage,
  }
}

/** Change to the caller's own Slack destination. */
export type PersonalSlackDestinationCommand = {
  /** Server-derived secret name of the caller. */
  secretId: string
  /** Audit event without the URL, or undefined when auditing is not configured. */
  auditPut?: AuditTransactWriteItem
}

/**
 * Stores the caller's own webhook, then records the change.
 * @param secrets - Webhook storage.
 * @param audit - Audit writer.
 * @param command - Secret name, validated URL, and audit event.
 */
export async function savePersonalSlackDestination(
  secrets: Pick<NotificationDestinationSecrets, 'put'>,
  audit: Pick<ChannelDestinationStore, 'recordAudit'>,
  command: PersonalSlackDestinationCommand & {
    /** Validated official Slack webhook URL. */
    webhookUrl: string
  },
): Promise<void> {
  await secrets.put(command.secretId, command.webhookUrl)
  if (command.auditPut) await audit.recordAudit(command.auditPut)
}

/**
 * Removes the caller's own webhook, then records the change.
 * @param secrets - Webhook storage.
 * @param audit - Audit writer.
 * @param command - Secret name and audit event.
 */
export async function deletePersonalSlackDestination(
  secrets: Pick<NotificationDestinationSecrets, 'delete'>,
  audit: Pick<ChannelDestinationStore, 'recordAudit'>,
  command: PersonalSlackDestinationCommand,
): Promise<void> {
  await secrets.delete(command.secretId)
  if (command.auditPut) await audit.recordAudit(command.auditPut)
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
 * save and the replaced version after a committed one; the replaced version is recorded with the
 * save, so a failed deletion is retried by the channel worker (ADR 0121). A first save needs a webhook.
 *
 * @param store - Settings store and record of retired webhook versions.
 * @param secrets - Webhook storage.
 * @param command - Target, body, caller, and fences.
 * @returns The saved settings.
 */
export async function saveChannelDestination(
  store: ChannelDestinationStore & Pick<RetiredChannelSecretStore, 'forgetRetiredSecret'>,
  secrets: Pick<NotificationDestinationSecrets, 'put' | 'delete'>,
  command: SaveChannelDestinationCommand,
): Promise<ChannelDestinationRecord> {
  const current = await store.get(command.workspaceId, command.target)
  const revision = current?.revision ?? await store.getRevision(command.workspaceId, command.target)
  if (revision !== command.body.expectedRevision) {
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
  const retiredSecretVersion = replacesWebhook && current && current.secretVersion !== secretVersion ? current.secretVersion : undefined
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
      ...(retiredSecretVersion ? { retiredSecretVersion } : {}),
    })
  } catch (error) {
    // Only a definite rejection leaves the settings on the previous version. When the outcome is
    // unknown (a lost response), the save may have committed, so the candidate is kept.
    if (replacesWebhook && error instanceof NotificationError && error.status === 409) {
      await deleteQuietly(secrets, command.secretIdOf(secretVersion))
    }
    throw error
  }
  if (retiredSecretVersion) {
    await deleteRetiredSecret(store, secrets, command.secretIdOf, { workspaceId: command.workspaceId, target: command.target, secretVersion: retiredSecretVersion }, command.now)
  }
  return record
}

/**
 * Deletes a retired webhook version right after the change that retired it, and marks its record
 * done. A failure leaves the record, so the channel worker deletes the secret later.
 *
 * @param store - Record of retired webhook versions.
 * @param secrets - Webhook storage.
 * @param secretIdOf - Secret name of a version of the target.
 * @param secret - Retired version.
 * @param now - Time of the change.
 */
async function deleteRetiredSecret(
  store: Pick<RetiredChannelSecretStore, 'forgetRetiredSecret'>,
  secrets: Pick<NotificationDestinationSecrets, 'delete'>,
  secretIdOf: (secretVersion: string) => string,
  secret: Pick<RetiredChannelSecret, 'workspaceId' | 'target' | 'secretVersion'>,
  now: Date,
): Promise<void> {
  try {
    await secrets.delete(secretIdOf(secret.secretVersion))
    await store.forgetRetiredSecret(secret, now)
  } catch {
    // The record stays due; the channel worker retries the deletion.
  }
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
  /** Delete time. */
  now: Date
  /** Commit-time authorization fences. */
  authorizationConditionChecks: readonly AuditTransactWriteItem[]
  /** Audit event built for this delete. */
  auditPut?: AuditTransactWriteItem
}

/**
 * Deletes a channel destination: the settings row first, so posts stop at once, then the secret.
 * The webhook version is recorded with the settings delete, so when the secret cannot be deleted
 * now, the channel worker retries it (ADR 0121). Queued posts whose destination is gone are
 * dropped when they come due.
 *
 * @param store - Settings store and record of retired webhook versions.
 * @param secrets - Webhook storage.
 * @param command - Target, revision, and fences.
 */
export async function deleteChannelDestination(
  store: ChannelDestinationStore & Pick<RetiredChannelSecretStore, 'forgetRetiredSecret'>,
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
    retiredSecretVersion: current.secretVersion,
    now: command.now,
    authorizationConditionChecks: command.authorizationConditionChecks,
    ...(command.auditPut ? { auditPut: command.auditPut } : {}),
  })
  await deleteRetiredSecret(store, secrets, command.secretIdOf, {
    workspaceId: command.workspaceId, target: command.target, secretVersion: current.secretVersion,
  }, command.now)
}

/** Retired versions one worker run deletes. */
const retiredSecretsPerRun = 20

/** Deletion attempts the worker makes before it gives up on a retired version and alarms. */
const maximumRetiredSecretAttempts = 8

/** Dependencies of the scheduled deletion of retired webhook versions. */
export type RetiredChannelSecretCleanupDependencies = {
  /** Record of retired webhook versions. */
  store: RetiredChannelSecretStore
  /** Webhook storage. */
  secrets: Pick<NotificationDestinationSecrets, 'delete'>
  /** Server-derived secret name of a version of a Workspace's Team or Project destination. */
  secretIdOf(workspaceId: string, target: ChannelDestinationTarget, secretVersion: string): string
  /** Current time. */
  now(): Date
}

/**
 * Deletes webhook versions whose deletion failed when their settings were removed or replaced.
 * A failed attempt waits longer each time; after {@link maximumRetiredSecretAttempts} the version is
 * moved aside, and the run fails so the scheduled-jobs alarm reports it.
 *
 * @param dependencies - Record, webhook storage, secret naming, and clock.
 * @returns Number of secrets deleted.
 * @throws Error when a version was given up on or a record could not be read.
 */
export async function deleteDueRetiredChannelSecrets(dependencies: RetiredChannelSecretCleanupDependencies): Promise<number> {
  const { secrets: due, invalidCount } = await dependencies.store.listDueRetiredSecrets(dependencies.now(), retiredSecretsPerRun)
  let deleted = 0
  let exhaustedCount = 0
  for (const secret of due) {
    try {
      await dependencies.secrets.delete(dependencies.secretIdOf(secret.workspaceId, secret.target, secret.secretVersion))
    } catch {
      const exhausted = secret.attempts + 1 >= maximumRetiredSecretAttempts
      if (exhausted) exhaustedCount += 1
      // 10, 20, 40 minutes and so on, up to about a day.
      const delayMs = Math.min(10 * 60_000 * 2 ** secret.attempts, 24 * 60 * 60_000)
      await dependencies.store.deferRetiredSecret(secret, new Date(dependencies.now().getTime() + delayMs), exhausted)
      continue
    }
    await dependencies.store.forgetRetiredSecret(secret, dependencies.now())
    deleted += 1
  }
  if (invalidCount > 0 || exhaustedCount > 0) {
    throw new Error(`Retired channel webhooks: ${exhaustedCount} could not be deleted, ${invalidCount} unreadable records.`)
  }
  return deleted
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
