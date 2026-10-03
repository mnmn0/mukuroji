import { createInboxDigestRecipientAuthorization, runWithAppDependencies } from '../../api/api-router'
import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { DynamoDbInboxDigestCheckpoints, DynamoDbInboxDigestStore, runInboxDigestWorker } from '../../modules/update-feed'
import { createProductionAppDependencies } from './api-dependencies'
import { createProductionTenantAvailability } from './tenant-administration'

/** Creates a disabled-by-default worker using the same member and Feed authorization as reads.
 * @returns A bounded handler; disabled invocations perform no AWS calls.
 */
export function createProductionInboxDigestWorkerHandler() {
  if (process.env.INBOX_DIGEST_WORKER_ENABLED !== 'true') return async () => ({ processed: 0, delivered: 0, failed: 0, disabled: true })
  const planningTable = process.env.PLANNING_TABLE_NAME?.trim()
  const notificationsTable = process.env.NOTIFICATIONS_TABLE_NAME?.trim()
  if (!planningTable || !notificationsTable || !process.env.ENTERPRISE_IDENTITY_TABLE_NAME?.trim()) throw new Error('Inbox digest worker resources are not configured')
  const dependencies = createProductionAppDependencies()
  const client = createDynamoDbDocumentClient(createDynamoDbClient())
  const metadata = new DynamoDbInboxDigestStore(planningTable, notificationsTable, client)
  const checkpoints = new DynamoDbInboxDigestCheckpoints(planningTable, client)
  const tenant = createProductionTenantAvailability()
  const locale = process.env.INBOX_DIGEST_LOCALE === 'en' ? 'en' : 'ja'
  return () => runWithAppDependencies(dependencies, async () => {
    const start = Date.now()
    const result = { processed: 0, delivered: 0, failed: 0, disabled: false }
    const delivery = createInboxDigestRecipientAuthorization((recipient, checks) => {
      const guard = tenant.createActiveWriteCondition(recipient.workspaceId)
      if (!guard.ConditionCheck?.ConditionExpression) throw new Error('Tenant write guard unavailable')
      // Background consent delivery requires an existing active tenant profile;
      // unlike legacy reads, an absent tenant cannot pass the commit boundary.
      return metadata.withCallerAuthorization([...checks, { ConditionCheck: { ...guard.ConditionCheck, ConditionExpression: `attribute_exists(recordKey) AND (${guard.ConditionCheck.ConditionExpression})` } }], locale)
    }, (workspaceId) => tenant.isActive(workspaceId), locale)
    const firstShard = Math.floor(start / 60_000) % 16
    for (let offset = 0; offset < 16 && Date.now() < start + 150_000; offset++) {
      const shard = (firstShard + offset) % 16
      const progress = await runInboxDigestWorker({
        checkpoints, delivery, now: Date.now,
        async listDue(currentShard, cursor, limit) {
          const page = await metadata.listDue(currentShard, limit, decodeCursor(cursor, currentShard))
          const recipients = []
          for (const recipient of page.recipients) if (!await checkpoints.isQuarantined(recipient, Date.now())) recipients.push(recipient)
          return { recipients, ...(page.cursor ? { cursor: JSON.stringify(page.cursor) } : {}) }
        },
      }, shard)
      result.processed += progress.processed; result.delivered += progress.delivered; result.failed += progress.failed
    }
    if (result.failed) console.error('InboxDigestWorkerFailures', { failed: result.failed })
    return result
  })
}

/** Validates a persisted internal GSI cursor without accepting arbitrary physical keys. */
function decodeCursor(cursor: string | undefined, shard: number): Record<string, unknown> | undefined {
  if (cursor === undefined) return undefined
  if (cursor.length > 4096) throw new Error('Invalid Inbox digest cursor')
  const value: unknown = JSON.parse(cursor)
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('workspaceId' in value) || typeof value.workspaceId !== 'string' || !('recordKey' in value) || typeof value.recordKey !== 'string' || !value.recordKey.startsWith('UPDATE_FEED_INBOX_DIGEST#') || !('inboxDigestShard' in value) || value.inboxDigestShard !== `inbox-digest#${shard}` || !('inboxDigestDueAt' in value) || typeof value.inboxDigestDueAt !== 'number' || !Number.isSafeInteger(value.inboxDigestDueAt)) throw new Error('Invalid Inbox digest cursor')
  return { workspaceId: value.workspaceId, recordKey: value.recordKey, inboxDigestShard: value.inboxDigestShard, inboxDigestDueAt: value.inboxDigestDueAt }
}
