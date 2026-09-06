import { DynamoDBClient, DescribeTableCommand, UpdateTableCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBStreamsClient, DescribeStreamCommand, GetShardIteratorCommand, GetRecordsCommand } from '@aws-sdk/client-dynamodb-streams'
import { SQSClient } from '@aws-sdk/client-sqs'
import { deliverStreamBatch, pollQueue, requireLocalOrigin } from './transport'

if (process.env.NODE_ENV === 'production' || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.AWS_EXECUTION_ENV) {
  throw new Error('Local workers cannot run in a production runtime.')
}
const origin = requireLocalOrigin(process.env.AWS_ENDPOINT_URL ?? '')
// Pin every AWS transport before dynamic imports can create application clients.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('AWS_ENDPOINT_URL') || key.endsWith('_ENDPOINT')) {
    if (process.env[key]) requireLocalOrigin(process.env[key])
  }
}
for (const key of ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL_SQS',
  'AWS_ENDPOINT_URL_DYNAMODB', 'DYNAMODB_ENDPOINT', 'SQS_ENDPOINT', 'COGNITO_ENDPOINT',
  'SECRETS_MANAGER_ENDPOINT', 'AWS_ENDPOINT_URL_SECRETS_MANAGER', 'AWS_ENDPOINT_URL_SECRETSMANAGER']) process.env[key] = origin
process.env.AWS_ACCESS_KEY_ID = 'test'
process.env.AWS_SECRET_ACCESS_KEY = 'test'
process.env.AWS_REGION = 'us-east-1'
delete process.env.AWS_SESSION_TOKEN
process.env.MUKUROJI_LOCAL_AWS_RUNTIME = 'floci'
process.env.PROJECT_DIRECTORY_TABLE_NAME ??= process.env.MUKUROJI_PROJECT_DIRECTORY_TABLE
process.env.WORKSPACE_ACCESS_TABLE_NAME ??= process.env.MUKUROJI_WORKSPACE_ACCESS_TABLE
process.env.SYSTEM_ADMIN_GROUPS ??= process.env.MUKUROJI_SYSTEM_ADMIN_GROUPS
process.env.PROCESSED_AUDIT_EVENTS_TABLE_NAME ??= 'mukuroji-processed-audit-events-local'
process.env.FILE_PROOFING_TABLE_NAME ??= 'mukuroji-file-proofing'
process.env.PLANNING_TABLE_NAME ??= 'mukuroji-planning-local'
process.env.PLANNING_UPDATE_SCHEDULE_INDEX_NAME ??= 'UpdateScheduleDueIndex'
process.env.REQUEST_INTAKE_TABLE_NAME ??= 'mukuroji-request-intake-local'
process.env.AUDIT_EVENTS_TABLE_NAME ??= process.env.MUKUROJI_AUDIT_EVENTS_TABLE

const queueUrls = ['WORK_ITEM_IMPORT_QUEUE_URL', 'WEBHOOK_DELIVERY_QUEUE_URL', 'CONNECTOR_SYNC_QUEUE_URL'].map((key) => {
  const value = process.env[key]
  if (!value || new URL(value).origin !== origin || new URL(value).username || new URL(value).password) {
    throw new Error(`${key} must point to the configured local AWS origin.`)
  }
  return value
})
const configuration = { endpoint: origin, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }
const dynamo = new DynamoDBClient(configuration)
const streams = new DynamoDBStreamsClient(configuration)
const sqs = new SQSClient(configuration)
const auditTable = process.env.AUDIT_EVENTS_TABLE_NAME
if (!auditTable) throw new Error('Audit table is missing; run floci:up first.')
const { ensureLocalAuditEventsTable } = await import('../../src/modules/audit')
await ensureLocalAuditEventsTable(auditTable, dynamo)
const { ensureLocalAutomationTable } = await import('../../src/modules/automation/adapter-out/dynamodb/automation-repository')
await ensureLocalAutomationTable(process.env.AUTOMATION_TABLE_NAME ?? 'mukuroji-automation-local', dynamo)
const { ensureLocalPlanningTable } = await import('../../src/modules/planning/planning')
await ensureLocalPlanningTable(process.env.PLANNING_TABLE_NAME, dynamo)
const { createProductionWorkItemDependencies } = await import('../../src/app/composition/api-dependencies')
const workspaceId = process.env.MUKUROJI_WORKSPACE_DIRECTORY_ID
if (!workspaceId) throw new Error('Local workspace ID is missing.')
await createProductionWorkItemDependencies().requestIntake.listForms(workspaceId)
let table = await dynamo.send(new DescribeTableCommand({ TableName: auditTable }))
if (!table.Table?.StreamSpecification?.StreamEnabled) {
  await dynamo.send(new UpdateTableCommand({ TableName: auditTable, StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' } }))
  table = await dynamo.send(new DescribeTableCommand({ TableName: auditTable }))
}
const streamArn = table.Table?.LatestStreamArn
if (!streamArn) throw new Error('Local audit stream is unavailable.')

const automation = await import('../../src/handlers/automation-schedule-handler')
const analytics = await import('../../src/handlers/analytics-schedule-handler')
const notifications = await import('../../src/handlers/notification-schedule-handler')
const triage = await import('../../src/handlers/triage-schedule-handler')
const connectors = await import('../../src/handlers/connector-handler')
const imports = await import('../../src/handlers/work-item-import.handler')
const webhook = await import('../../src/handlers/webhook-handler')
const audit = await import('../../src/handlers/audit-projection-handler')
const automationEvents = await import('../../src/handlers/automation-event-handler')

const schedules = [
  { name: 'automation', interval: 60_000, run: () => automation.handler({}) },
  { name: 'triage', interval: 60_000, run: () => triage.handler({}) },
  { name: 'analytics', interval: 300_000, run: () => analytics.handler({}) },
  { name: 'notifications', interval: 3_600_000, run: () => notifications.handler({}) },
  { name: 'connector-poll', interval: 300_000, run: () => connectors.pollHandler({}) },
].map((job) => ({ ...job, next: 0 }))
const queueHandlers = [imports.workItemImportHandler, webhook.deliveryHandler, connectors.queueHandler]
const iterators = new Map<string, string>()
const sequences = new Map<string, string>()
const finishedShards = new Set<string>()
let stopping = false
process.on('SIGINT', () => { stopping = true })
process.on('SIGTERM', () => { stopping = true })
const once = process.argv.includes('--once')

/** Polls audit shards without advancing a checkpoint past a failed fan-out. */
async function pollAudit() {
  let exclusiveStartShardId: string | undefined
  do {
    const description = await streams.send(new DescribeStreamCommand({ StreamArn: streamArn, ExclusiveStartShardId: exclusiveStartShardId }))
    for (const shard of description.StreamDescription?.Shards ?? []) {
      const id = shard.ShardId
      if (!id || finishedShards.has(id)) continue
      if (shard.ParentShardId && !finishedShards.has(shard.ParentShardId)) continue
      let iterator = iterators.get(id)
      if (!iterator) {
        const sequence = sequences.get(id)
        const start = await streams.send(new GetShardIteratorCommand({
          StreamArn: streamArn, ShardId: id,
          ShardIteratorType: sequence ? 'AFTER_SEQUENCE_NUMBER' : 'TRIM_HORIZON',
          ...(sequence ? { SequenceNumber: sequence } : {}),
        }))
        iterator = start.ShardIterator
      }
      if (!iterator) throw new Error('Missing local stream iterator.')
      iterators.set(id, iterator)
      const batch = await streams.send(new GetRecordsCommand({ ShardIterator: iterator, Limit: 25 })).catch((error: unknown) => {
        if (error instanceof Error && error.name === 'ExpiredIteratorException') iterators.delete(id)
        throw error
      })
      const event = { Records: batch.Records ?? [] }
      const sequence = await deliverStreamBatch(event, [audit.handler, automationEvents.handler])
      if (sequence) sequences.set(id, sequence)
      if (batch.NextShardIterator) iterators.set(id, batch.NextShardIterator)
      else finishedShards.add(id)
    }
    exclusiveStartShardId = description.StreamDescription?.LastEvaluatedShardId
  } while (exclusiveStartShardId)
}

/** Runs one job while recording only a bounded, non-sensitive failure name. */
async function attempt(name: string, run: () => Promise<unknown>) {
  try {
    await run()
    if (once) console.info(`local-worker ${name}: ok`)
  } catch (error) {
    console.error(`local-worker ${name}: failed (${error instanceof Error ? error.name : 'unknown'})`)
    if (once) process.exitCode = 1
  }
}

console.info('Local workers ready: schedules, SQS consumers, audit projections. Ctrl+C stops after the current batch.')
do {
  for (const job of schedules) {
    if (stopping) break
    if (Date.now() >= job.next) {
      await attempt(job.name, job.run)
      job.next = Date.now() + job.interval
    }
  }
  for (const [index, handle] of queueHandlers.entries()) {
    if (stopping) break
    const url = queueUrls[index]
    if (url) await attempt(`queue-${index + 1}`, () => pollQueue(sqs, url, handle))
  }
  if (!stopping) await attempt('audit-stream', pollAudit)
  if (!once && !stopping) await Bun.sleep(1_000)
} while (!once && !stopping)
dynamo.destroy()
streams.destroy()
sqs.destroy()
