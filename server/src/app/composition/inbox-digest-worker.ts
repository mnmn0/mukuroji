import { createInboxDigestRecipientAuthorization, runWithAppDependencies } from '../../api/api-router'
import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { DynamoDbInboxDigestCheckpoints, DynamoDbInboxDigestStore, runInboxDigestWorkerInvocation } from '../../modules/update-feed'
import { createInboxDigestAppDependencies } from './inbox-digest-dependencies'
import { DynamoDbTenantAdministrationClient, TenantAdministrationError } from '../../modules/tenant-administration'
import { PlanningError } from '../../modules/planning'

/** Creates a disabled-by-default worker using the same member and Feed authorization as reads.
 * @returns A bounded handler; disabled invocations perform no AWS calls.
 */
export function createProductionInboxDigestWorkerHandler() {
  if (process.env.INBOX_DIGEST_WORKER_ENABLED !== 'true') return async () => ({ processed: 0, delivered: 0, failed: 0, disabled: true })
  const planningTable = process.env.PLANNING_TABLE_NAME?.trim()
  const notificationsTable = process.env.NOTIFICATIONS_TABLE_NAME?.trim()
  const tenantTable = process.env.TENANT_ADMINISTRATION_TABLE_NAME?.trim()
  const enterpriseTable = process.env.ENTERPRISE_IDENTITY_TABLE_NAME?.trim()
  const required = ['WORKSPACE_ACCESS_TABLE_NAME', 'PROJECT_DIRECTORY_TABLE_NAME', 'COLLABORATION_TABLE_NAME', 'COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID']
  if (!planningTable || !notificationsTable || !tenantTable || !enterpriseTable || required.some((name) => !process.env[name]?.trim())) throw new Error('Inbox digest worker resources are not configured')
  const dependencies = createInboxDigestAppDependencies(planningTable, enterpriseTable)
  const client = createDynamoDbDocumentClient(createDynamoDbClient())
  const metadata = new DynamoDbInboxDigestStore(planningTable, notificationsTable, client)
  const checkpoints = new DynamoDbInboxDigestCheckpoints(planningTable, client)
  const tenant = new DynamoDbTenantAdministrationClient(tenantTable, client)
  const locale = process.env.INBOX_DIGEST_LOCALE === 'en' ? 'en' : 'ja'
  return () => runWithAppDependencies(dependencies, async () => {
    const delivery = createInboxDigestRecipientAuthorization((recipient, checks) => {
      const guard = tenant.createActiveWriteCondition(recipient.workspaceId)
      if (!guard.ConditionCheck?.ConditionExpression) throw new Error('Tenant write guard unavailable')
      // Background consent delivery requires an existing active tenant profile;
      // unlike legacy reads, an absent tenant cannot pass the commit boundary.
      return metadata.withCallerAuthorization([...checks, { ConditionCheck: { ...guard.ConditionCheck, ConditionExpression: `attribute_exists(recordKey) AND (${guard.ConditionCheck.ConditionExpression})` } }], locale)
    }, async (workspaceId) => {
      try { await tenant.assertActive(workspaceId); return true }
      catch (error) {
        if (error instanceof TenantAdministrationError && (error.code === 'TenantClosing' || error.code === 'TenantClosed')) return false
        throw error
      }
    }, locale)
    const result = await runInboxDigestWorkerInvocation({
        checkpoints, delivery: { ...delivery, deferDenied: (recipient) => metadata.deferDenied(recipient) }, now: Date.now,
        async listDue(currentShard, cursor, limit) {
          const page = await metadata.listDue(currentShard, limit, decodeCursor(cursor, currentShard))
          const recipients = []
          for (const recipient of page.recipients) if (!await checkpoints.isQuarantined(recipient, Date.now(), currentShard) && !await checkpoints.isExhausted(recipient, Date.now(), currentShard)) recipients.push(recipient)
          return { recipients, ...(page.cursor ? { cursor: JSON.stringify(page.cursor) } : {}) }
        },
      })
    if (result.failed) console.error('InboxDigestWorkerFailures', { failed: result.failed })
    return { ...result, disabled: false }
  })
}

/** Validates a persisted internal GSI cursor without accepting arbitrary physical keys.
 * @param cursor - Persisted worker continuation, never a user request.
 * @param shard - Currently owned shard.
 * @returns Reconstructed SDK key or a typed invocation failure.
 */
export function decodeCursor(cursor: string | undefined, shard: number): Record<string, unknown> | undefined {
  if (cursor === undefined) return undefined
  /** Keeps persisted physical coordinates out of invocation errors. */
  const corrupt = () => new PlanningError(502, 'UpdateFeedDigestCorruptState', 'Inbox digest continuation is unavailable.')
  if (cursor.length > 4096) throw corrupt()
  let value: unknown
  try { value = JSON.parse(cursor) } catch { throw corrupt() }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('workspaceId' in value) || typeof value.workspaceId !== 'string' || !value.workspaceId.trim() || !('recordKey' in value) || typeof value.recordKey !== 'string' || !value.recordKey.startsWith('UPDATE_FEED_INBOX_DIGEST#') || !('inboxDigestShard' in value) || value.inboxDigestShard !== `inbox-digest#${shard}` || !('inboxDigestDueAt' in value) || typeof value.inboxDigestDueAt !== 'number' || !Number.isSafeInteger(value.inboxDigestDueAt) || value.inboxDigestDueAt < 0) throw corrupt()
  return { workspaceId: value.workspaceId, recordKey: value.recordKey, inboxDigestShard: value.inboxDigestShard, inboxDigestDueAt: value.inboxDigestDueAt }
}
