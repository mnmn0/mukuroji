import { expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  isCompleteHandler,
  processWebhookActiveLocatorRollbackPage,
  processWebhookAuthorizationBackfillEvent,
  processWebhookAuthorizationBackfillPage,
  processWebhookAuthorizationBackfillPages,
  startWebhookActiveLocatorRollback,
  startWebhookAuthorizationBackfill,
} from './webhook-authorization-backfill'

const backfillStartedAt = new Date('2026-07-18T00:00:00.000Z')
const afterWriterDrain = new Date('2026-07-18T00:01:01.000Z')
const afterLocatorCleanupDrain = new Date('2026-07-18T00:02:02.000Z')

test('accepts the replaced v1 custom resource delete without v3 validation', async () => {
  await expect(isCompleteHandler({
    RequestType: 'Delete',
    ResourceProperties: { MigrationVersion: 'v1' },
  })).resolves.toEqual({ IsComplete: true })
})

test('deletes the replaced v1 checkpoint without changing its physical ID', async () => {
  const commands: Array<{
    constructor: { name: string }
    input: Record<string, unknown>
  }> = []
  const documentClient = {
    async send(command: {
      constructor: { name: string }
      input: Record<string, unknown>
    }) {
      commands.push(command)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  await expect(processWebhookAuthorizationBackfillEvent({
    RequestType: 'Delete',
    PhysicalResourceId: 'webhook-authorization-projection-backfill-v1',
    ResourceProperties: { MigrationVersion: 'v1' },
  }, documentClient, 'ProjectDirectory')).resolves.toEqual({
    PhysicalResourceId: 'webhook-authorization-projection-backfill-v1',
    SkipMigration: true,
  })
  expect(commands).toHaveLength(1)
  expect(commands[0]?.constructor.name).toBe('DeleteCommand')
  expect(commands[0]?.input).toMatchObject({
    TableName: 'ProjectDirectory',
    Key: {
      directoryId: 'WEBHOOK_AUTHORIZATION_BACKFILL#v1',
      entryKey: 'CHECKPOINT',
    },
  })
})

test('waits for pre-deploy writers to drain before starting the first scan', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const team = {
    directoryId: 'workspace-1',
    entryKey: 'TEAM#active',
    entryType: 'team',
    teamId: 'team-1',
  }
  rows.set(createKey(team), team)
  const fake = createDocumentClient(rows, 10)
  await startWebhookAuthorizationBackfill(
    fake.client,
    'ProjectDirectory',
    backfillStartedAt,
    'DeveloperPlatform',
  )

  const waiting = await processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    new Date('2026-07-18T00:00:59.999Z'),
    'DeveloperPlatform',
  )
  expect(waiting).toMatchObject({
    isComplete: false,
    madeProgress: false,
    checkpoint: {
      phase: 'active-locators',
      revision: 0,
      writerDrainUntil: '2026-07-18T00:01:00.000Z',
    },
  })
  expect(fake.scanCalls()).toBe(0)

  await expect(processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    afterWriterDrain,
    'DeveloperPlatform',
  )).resolves.toMatchObject({
    madeProgress: true,
    checkpoint: {
      phase: 'legacy-locator-cleanup',
      revision: 1,
      writerDrainUntil: '2026-07-18T00:02:01.000Z',
    },
  })
  expect(fake.scanCalls()).toBe(1)
  await expect(processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    new Date('2026-07-18T00:02:00.999Z'),
    'DeveloperPlatform',
  )).resolves.toMatchObject({
    madeProgress: false,
    checkpoint: { phase: 'legacy-locator-cleanup', revision: 1 },
  })
  expect(fake.scanCalls()).toBe(1)
})

test('refreshes the writer drain when resuming an orphaned cutover marker', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const marker = {
    workspaceId: 'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3',
    recordKey: 'STATE',
    entryType: 'webhook-active-locator-migration',
    value: {
      migrationVersion: 'v3',
      state: 'cutover',
      writerDrainUntil: '2026-07-18T00:01:00.000Z',
    },
    version: 7,
  }
  rows.set(createKey(marker), marker)
  const fake = createDocumentClient(rows, 10)

  await startWebhookAuthorizationBackfill(
    fake.client,
    'ProjectDirectory',
    new Date('2026-07-18T04:00:00.000Z'),
    'DeveloperPlatform',
  )

  expect(rows.get(createKey(marker))).toMatchObject({
    value: {
      state: 'cutover',
      writerDrainUntil: '2026-07-18T04:01:00.000Z',
    },
    version: 8,
  })
  expect(rows.get(
    'WEBHOOK_AUTHORIZATION_BACKFILL#v3\0CHECKPOINT',
  )).toMatchObject({
    phase: 'active-locators',
    revision: 0,
    writerDrainUntil: '2026-07-18T04:01:00.000Z',
  })
})

test('backfills primary active locators before completing the legacy fallback boundary', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const subscription = {
    workspaceId: 'workspace-webhook-migration',
    recordKey: 'WEBHOOK#webhook-retained',
    entryType: 'webhook-subscription',
    value: {
      id: 'webhook-retained',
      createdAt: '2026-07-01T00:00:00.000Z',
      status: 'active',
      name: 'Retained',
    },
    lookupKey: 'WEBHOOK#ACTIVE#workspace-webhook-migration',
    lookupSortKey:
      '2026-07-01T00:00:00.000Z#webhook-retained',
    version: 4,
  }
  rows.set(createKey(subscription), subscription)
  const fake = createDocumentClient(rows, 10)
  await startWebhookAuthorizationBackfill(
    fake.client,
    'ProjectDirectory',
    backfillStartedAt,
    'DeveloperPlatform',
  )

  const cutover = await processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    afterWriterDrain,
    'DeveloperPlatform',
  )

  expect(cutover).toMatchObject({
    madeProgress: true,
    checkpoint: {
      phase: 'legacy-locator-cleanup',
      activeLocatorsReconciled: 1,
      legacyLookupsRemoved: 0,
    },
  })
  expect(rows.get(createKey(subscription))).toMatchObject({
    lookupKey: 'WEBHOOK#ACTIVE#workspace-webhook-migration',
  })
  expect(rows.get(
    'workspace-webhook-migration\0' +
      'WEBHOOKACTIVE#2026-07-01T00:00:00.000Z#webhook-retained',
  )).toMatchObject({
    entryType: 'webhook-active-subscription',
    value: { targetRecordKey: 'WEBHOOK#webhook-retained' },
  })
  expect(rows.get(
    'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3\0STATE',
  )).toMatchObject({
    value: { migrationVersion: 'v3', state: 'complete' },
    version: 3,
  })
  const cleanup = await processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    afterLocatorCleanupDrain,
    'DeveloperPlatform',
  )
  expect(cleanup).toMatchObject({
    madeProgress: true,
    checkpoint: {
      phase: 'projection',
      activeLocatorsReconciled: 1,
      legacyLookupsRemoved: 1,
    },
  })
  expect(rows.get(createKey(subscription))).not.toHaveProperty('lookupKey')
  expect(fake.scanLimits()).toEqual([1_000, 1_000])
})

test('restores legacy active locators before a v3 rollback completes', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const active = {
    workspaceId: 'workspace-rollback',
    recordKey: 'WEBHOOK#webhook-active',
    entryType: 'webhook-subscription',
    value: {
      id: 'webhook-active',
      createdAt: '2026-07-01T00:00:00.000Z',
      status: 'active',
    },
    version: 5,
  }
  const paused = {
    workspaceId: 'workspace-rollback',
    recordKey: 'WEBHOOK#webhook-paused',
    entryType: 'webhook-subscription',
    value: {
      id: 'webhook-paused',
      createdAt: '2026-07-02T00:00:00.000Z',
      status: 'paused',
    },
    lookupKey: 'WEBHOOK#ACTIVE#workspace-rollback',
    lookupSortKey: '2026-07-02T00:00:00.000Z#webhook-paused',
    version: 3,
  }
  const marker = {
    workspaceId: 'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3',
    recordKey: 'STATE',
    entryType: 'webhook-active-locator-migration',
    value: {
      migrationVersion: 'v3',
      state: 'complete',
      writerDrainUntil: '2026-07-18T00:01:00.000Z',
    },
    version: 2,
  }
  const forwardCheckpoint = {
    directoryId: 'WEBHOOK_AUTHORIZATION_BACKFILL#v3',
    entryKey: 'CHECKPOINT',
    entryType: 'webhook-authorization-backfill-checkpoint',
    migrationVersion: 'v3',
    writerDrainUntil: '2026-07-18T00:02:00.000Z',
    phase: 'projection',
    revision: 4,
    sourceRowsUpdated: 0,
    sourceRowsVerified: 0,
    grantsWritten: 0,
    grantsDeleted: 0,
    cleanupLocatorsWritten: 0,
    activeLocatorsReconciled: 2,
    legacyLookupsRemoved: 1,
  }
  for (const row of [active, paused, marker, forwardCheckpoint]) {
    rows.set(createKey(row), row)
  }
  const fake = createDocumentClient(rows, 10)

  await expect(startWebhookActiveLocatorRollback(
    fake.client,
    'ProjectDirectory',
    'DeveloperPlatform',
    new Date('2026-07-18T03:00:00.000Z'),
  )).resolves.toBe(true)
  expect(rows.get(createKey(marker))).toMatchObject({
    value: {
      state: 'rollback',
      rollbackDrainUntil: '2026-07-18T03:01:00.000Z',
    },
    version: 3,
  })
  expect(rows.has(createKey(forwardCheckpoint))).toBe(false)

  await expect(processWebhookActiveLocatorRollbackPage(
    fake.client,
    'ProjectDirectory',
    'DeveloperPlatform',
    new Date('2026-07-18T03:00:59.999Z'),
  )).resolves.toMatchObject({
    isComplete: false,
    madeProgress: false,
  })
  expect(fake.scanCalls()).toBe(0)

  await expect(processWebhookActiveLocatorRollbackPage(
    fake.client,
    'ProjectDirectory',
    'DeveloperPlatform',
    new Date('2026-07-18T03:01:01.000Z'),
  )).resolves.toMatchObject({
    isComplete: true,
    madeProgress: true,
    checkpoint: { legacyLookupsReconciled: 2 },
  })
  expect(rows.get(createKey(active))).toMatchObject({
    lookupKey: 'WEBHOOK#ACTIVE#workspace-rollback',
    lookupSortKey: '2026-07-01T00:00:00.000Z#webhook-active',
  })
  expect(rows.get(createKey(paused))).not.toHaveProperty('lookupKey')
  expect(rows.has(createKey(marker))).toBe(false)
  expect(rows.has(
    'WEBHOOK_ACTIVE_LOCATOR_ROLLBACK#v3\0CHECKPOINT',
  )).toBe(false)
})

test('retries rollback start when cutover completion wins the marker CAS', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const marker = {
    workspaceId: 'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3',
    recordKey: 'STATE',
    entryType: 'webhook-active-locator-migration',
    value: {
      migrationVersion: 'v3',
      state: 'cutover',
      writerDrainUntil: '2026-07-18T00:01:00.000Z',
    },
    version: 1,
  }
  rows.set(createKey(marker), marker)
  const fake = createDocumentClient(rows, 10)
  fake.completeMarkerBeforeNextRollbackStart()

  await expect(startWebhookActiveLocatorRollback(
    fake.client,
    'ProjectDirectory',
    'DeveloperPlatform',
    new Date('2026-07-18T03:00:00.000Z'),
  )).resolves.toBe(true)
  expect(rows.get(createKey(marker))).toMatchObject({
    value: {
      state: 'rollback',
      rollbackDrainUntil: '2026-07-18T03:01:00.000Z',
    },
    version: 3,
  })
  expect(fake.updateCalls()).toBe(2)
})

test('fences an in-flight forward cleanup after rollback starts', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const subscription = {
    workspaceId: 'workspace-forward-fence',
    recordKey: 'WEBHOOK#webhook-forward-fence',
    entryType: 'webhook-subscription',
    value: {
      id: 'webhook-forward-fence',
      createdAt: '2026-07-01T00:00:00.000Z',
      status: 'active',
    },
    lookupKey: 'WEBHOOK#ACTIVE#workspace-forward-fence',
    lookupSortKey:
      '2026-07-01T00:00:00.000Z#webhook-forward-fence',
    version: 2,
  }
  for (const row of [
    subscription,
    {
      workspaceId: 'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3',
      recordKey: 'STATE',
      entryType: 'webhook-active-locator-migration',
      value: {
        migrationVersion: 'v3',
        state: 'rollback',
        writerDrainUntil: '2026-07-18T00:01:00.000Z',
        rollbackDrainUntil: '2026-07-18T00:03:00.000Z',
      },
      version: 3,
    },
    {
      directoryId: 'WEBHOOK_AUTHORIZATION_BACKFILL#v3',
      entryKey: 'CHECKPOINT',
      entryType: 'webhook-authorization-backfill-checkpoint',
      migrationVersion: 'v3',
      writerDrainUntil: '2026-07-18T00:02:00.000Z',
      phase: 'legacy-locator-cleanup',
      revision: 1,
      sourceRowsUpdated: 0,
      sourceRowsVerified: 0,
      grantsWritten: 0,
      grantsDeleted: 0,
      cleanupLocatorsWritten: 0,
      activeLocatorsReconciled: 1,
      legacyLookupsRemoved: 0,
    },
  ]) {
    rows.set(createKey(row), row)
  }
  const fake = createDocumentClient(rows, 10)

  await expect(processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    new Date('2026-07-18T00:02:01.000Z'),
    'DeveloperPlatform',
  )).resolves.toMatchObject({
    isComplete: false,
    madeProgress: false,
    checkpoint: {
      phase: 'legacy-locator-cleanup',
      revision: 1,
    },
  })
  expect(rows.get(createKey(subscription))).toHaveProperty(
    'lookupKey',
    'WEBHOOK#ACTIVE#workspace-forward-fence',
  )
})

test('fails closed on a malformed Webhook subscription migration source', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const malformed = {
    workspaceId: 'workspace-malformed-webhook',
    recordKey: 'WEBHOOK#webhook-malformed',
    entryType: 'webhook-subscription',
    value: {
      id: 'webhook-malformed',
      status: 'active',
    },
    lookupKey: 'WEBHOOK#ACTIVE#workspace-malformed-webhook',
    lookupSortKey:
      '2026-07-01T00:00:00.000Z#webhook-malformed',
    version: 1,
  }
  rows.set(createKey(malformed), malformed)
  const fake = createDocumentClient(rows, 10)
  await startWebhookAuthorizationBackfill(
    fake.client,
    'ProjectDirectory',
    backfillStartedAt,
    'DeveloperPlatform',
  )

  await expect(processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    afterWriterDrain,
    'DeveloperPlatform',
  )).rejects.toThrow(
    'Webhook active locator migration source row is invalid.',
  )

  expect(rows.get(
    'WEBHOOK_AUTHORIZATION_BACKFILL#v3\0CHECKPOINT',
  )).toMatchObject({
    phase: 'active-locators',
    revision: 0,
  })
  expect(rows.get(
    'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3\0STATE',
  )).toMatchObject({
    value: { state: 'cutover' },
  })
  expect(fake.scanLimits()).toEqual([1_000])
})

test('reconciles an active locator across a concurrent delivery health update', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const subscription = {
    workspaceId: 'workspace-webhook-health-race',
    recordKey: 'WEBHOOK#webhook-health-race',
    entryType: 'webhook-subscription',
    value: {
      id: 'webhook-health-race',
      createdAt: '2026-07-02T00:00:00.000Z',
      status: 'active',
      failureCount: 0,
      updatedAt: '2026-07-02T00:00:00.000Z',
    },
    lookupKey: 'WEBHOOK#ACTIVE#workspace-webhook-health-race',
    lookupSortKey:
      '2026-07-02T00:00:00.000Z#webhook-health-race',
    version: 4,
  }
  rows.set(createKey(subscription), subscription)
  const fake = createDocumentClient(rows, 10)
  await startWebhookAuthorizationBackfill(
    fake.client,
    'ProjectDirectory',
    backfillStartedAt,
    'DeveloperPlatform',
  )
  fake.advanceWebhookSubscriptionHealthBeforeNextReconcile()

  await expect(processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    afterWriterDrain,
    'DeveloperPlatform',
  )).resolves.toMatchObject({
    madeProgress: true,
    checkpoint: {
      phase: 'legacy-locator-cleanup',
      activeLocatorsReconciled: 1,
    },
  })
  expect(rows.get(createKey(subscription))).toMatchObject({
    version: 5,
    value: {
      failureCount: 1,
      updatedAt: '2026-07-18T00:00:30.000Z',
    },
  })
  expect(rows.get(createKey(subscription))).toHaveProperty(
    'lookupKey',
    'WEBHOOK#ACTIVE#workspace-webhook-health-race',
  )
  expect(rows.has(
    'workspace-webhook-health-race\0' +
      'WEBHOOKACTIVE#2026-07-02T00:00:00.000Z#webhook-health-race',
  )).toBe(true)
})

test('resumes pagewise, waits for the GSI, and skips archived member grants', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  for (const row of [
    {
      directoryId: 'workspace-1',
      entryKey: 'TEAM#active',
      entryType: 'team',
      teamId: 'team-1',
    },
    {
      directoryId: 'workspace-1',
      entryKey: 'TEAM#archived',
      entryType: 'team',
      teamId: 'team-2',
      archivedAt: '2026-07-18T00:00:00.000Z',
    },
    {
      directoryId: 'workspace-1',
      entryKey: 'PROJECT#active',
      entryType: 'project',
      teamId: 'team-1',
      projectId: 'project-1',
    },
    {
      directoryId: 'workspace-1',
      entryKey: 'PROJECT#archived-team',
      entryType: 'project',
      teamId: 'team-2',
      projectId: 'project-1',
    },
    {
      directoryId: 'workspace-1',
      entryKey: 'PROJECT_MEMBER#project-1#creator-1',
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'viewer',
    },
    {
      directoryId: 'workspace-1',
      entryKey: 'PROJECT_MEMBER#project-1#archived-creator',
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'archived-creator',
      role: 'manager',
      archivedAt: '2026-07-18T00:00:00.000Z',
    },
    {
      directoryId: 'WEBHOOK_TEAM_GRANT#workspace-1#creator-1',
      entryKey: 'TEAM#team-2#PROJECT#project-1',
      entryType: 'webhook-team-grant',
      workspaceId: 'workspace-1',
      teamId: 'team-2',
      projectId: 'project-1',
      memberKey: 'creator-1',
      sourceEntryKey: 'PROJECT_MEMBER#project-1#creator-1',
      teamSourceEntryKey: 'TEAM#archived',
      projectSourceEntryKey: 'PROJECT#archived-team',
      webhookAuthorizationKey:
        'WEBHOOK_ACL#TEAM_MEMBER#workspace-1#team-2#creator-1',
      webhookAuthorizationSortKey: 'PROJECT#project-1',
    },
  ]) {
    rows.set(createKey(row), row)
  }
  const fake = createDocumentClient(rows, 3)

  await startWebhookAuthorizationBackfill(
    fake.client,
    'ProjectDirectory',
    backfillStartedAt,
    'DeveloperPlatform',
  )
  await startWebhookAuthorizationBackfill(
    fake.client,
    'ProjectDirectory',
    backfillStartedAt,
    'DeveloperPlatform',
  )

  await expect(processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    afterWriterDrain,
    'DeveloperPlatform',
  )).resolves.toMatchObject({
    madeProgress: true,
    checkpoint: { phase: 'legacy-locator-cleanup' },
  })
  await expect(processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    afterLocatorCleanupDrain,
    'DeveloperPlatform',
  )).resolves.toMatchObject({
    madeProgress: true,
    checkpoint: { phase: 'projection' },
  })
  fake.failNextCheckpointWrite()
  await expect(processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    afterLocatorCleanupDrain,
    'DeveloperPlatform',
  )).rejects.toThrow('interrupted after page writes')

  const scansBeforeBatch = fake.scanCalls()
  let progress = await processWebhookAuthorizationBackfillPages(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    {
      maxPages: 2,
      canProcessNextPage: () => true,
      now: () => afterLocatorCleanupDrain,
      developerPlatformTableName: 'DeveloperPlatform',
    },
  )
  expect(fake.scanCalls() - scansBeforeBatch).toBe(2)
  expect(progress.checkpoint.phase).toBe('projection')
  while (progress.checkpoint.phase === 'projection') {
    progress = await processWebhookAuthorizationBackfillPage(
      fake.client,
      'ProjectDirectory',
      'WebhookAuthorizationIndex',
      afterLocatorCleanupDrain,
      'DeveloperPlatform',
    )
  }
  expect(progress.checkpoint.phase).toBe('verification')

  const revisionBeforeGsiRetry = progress.checkpoint.revision
  const scansBeforeGsiRetry = fake.scanCalls()
  progress = await processWebhookAuthorizationBackfillPages(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    {
      maxPages: 100,
      canProcessNextPage: () => true,
      now: () => afterLocatorCleanupDrain,
      developerPlatformTableName: 'DeveloperPlatform',
    },
  )
  expect(fake.scanCalls() - scansBeforeGsiRetry).toBe(1)
  expect(progress.checkpoint.revision).toBe(revisionBeforeGsiRetry)
  expect(progress.checkpoint.phase).toBe('verification')

  fake.flushGsi()
  for (
    let attempt = 0;
    attempt < 30 && progress.checkpoint.phase !== 'grant-cleanup';
    attempt += 1
  ) {
    progress = await processWebhookAuthorizationBackfillPage(
      fake.client,
      'ProjectDirectory',
      'WebhookAuthorizationIndex',
      afterLocatorCleanupDrain,
      'DeveloperPlatform',
    )
  }
  expect(progress.checkpoint.phase).toBe('grant-cleanup')
  const activeGrantKey =
    'WEBHOOK_TEAM_GRANT#workspace-1#creator-1\0TEAM#team-1#PROJECT#project-1'
  const activeProjectKey = 'workspace-1\0PROJECT#active'
  const activeProject = rows.get(activeProjectKey)!
  for (const field of [
    'entryType',
    'teamId',
    'projectId',
    'memberKey',
    'role',
    'archivedAt',
  ]) {
    delete activeProject[field]
  }
  fake.repairSourceBeforeGrantDelete(
    activeGrantKey,
    activeProjectKey,
    {
      entryType: 'project',
      teamId: 'team-1',
      projectId: 'project-1',
    },
  )
  let malformedRepairRaceRejected = false
  for (
    let attempt = 0;
    attempt < 20 && !malformedRepairRaceRejected;
    attempt += 1
  ) {
    try {
      progress = await processWebhookAuthorizationBackfillPage(
        fake.client,
        'ProjectDirectory',
        'WebhookAuthorizationIndex',
        afterLocatorCleanupDrain,
        'DeveloperPlatform',
      )
    } catch (error) {
      expect(error).toMatchObject({ name: 'ConditionalCheckFailedException' })
      malformedRepairRaceRejected = true
    }
  }
  expect(malformedRepairRaceRejected).toBe(true)
  expect(fake.scanLimits()).toContain(50)
  expect(fake.scanLimits().at(-1)).toBe(1_000)
  expect(rows.has(activeGrantKey)).toBe(true)
  expect(fake.repairedSourceCondition()).toMatchObject({
    ConditionExpression:
      'attribute_not_exists(#entryType) AND attribute_not_exists(#teamId) AND ' +
      'attribute_not_exists(#projectId) AND attribute_not_exists(#memberKey) AND ' +
      'attribute_not_exists(#role) AND attribute_not_exists(#archivedAt)',
  })
  expect(fake.repairedSourceCondition()?.ExpressionAttributeValues)
    .toBeUndefined()

  const staleGrantKey =
    'WEBHOOK_TEAM_GRANT#workspace-1#creator-1\0TEAM#team-2#PROJECT#project-1'
  fake.replaceGrantBeforeNextDelete()
  let replacementRaceRejected = false
  for (let attempt = 0; attempt < 20 && !replacementRaceRejected; attempt += 1) {
    try {
      progress = await processWebhookAuthorizationBackfillPage(
        fake.client,
        'ProjectDirectory',
        'WebhookAuthorizationIndex',
        afterLocatorCleanupDrain,
        'DeveloperPlatform',
      )
    } catch (error) {
      expect(error).toMatchObject({ name: 'ConditionalCheckFailedException' })
      replacementRaceRejected = true
    }
  }
  expect(replacementRaceRejected).toBe(true)
  expect(rows.has(staleGrantKey)).toBe(true)
  rows.get(staleGrantKey)!.projectSourceEntryKey = 'PROJECT#archived-team'
  for (let attempt = 0; attempt < 30 && !progress.isComplete; attempt += 1) {
    progress = await processWebhookAuthorizationBackfillPages(
      fake.client,
      'ProjectDirectory',
      'WebhookAuthorizationIndex',
      {
        maxPages: 2,
        canProcessNextPage: () => true,
        now: () => afterLocatorCleanupDrain,
        developerPlatformTableName: 'DeveloperPlatform',
      },
    )
  }
  expect(progress.isComplete).toBe(true)
  expect(progress.checkpoint).toMatchObject({
    phase: 'complete',
    sourceRowsUpdated: 6,
    sourceRowsVerified: 6,
    grantsWritten: 1,
    grantsDeleted: 1,
    cleanupLocatorsWritten: 1,
  })
  expect(fake.scanCalls()).toBeGreaterThan(6)
  expect(fake.updateCalls()).toBeGreaterThan(6)

  expect(rows.get('workspace-1\0TEAM#active')).toMatchObject({
    webhookAuthorizationKey: 'WEBHOOK_ACL#RESOURCE#workspace-1',
    webhookAuthorizationSortKey: 'TEAM#team-1',
  })
  expect(rows.get('workspace-1\0PROJECT#active')).toMatchObject({
    webhookAuthorizationKey: 'WEBHOOK_ACL#RESOURCE#workspace-1',
    webhookAuthorizationSortKey: 'PROJECT#project-1',
  })
  expect(rows.get(
    'workspace-1\0PROJECT_MEMBER#project-1#creator-1',
  )).toMatchObject({
    webhookAuthorizationKey: 'WEBHOOK_ACL#MEMBER#workspace-1#creator-1',
    webhookAuthorizationSortKey: 'PROJECT#project-1',
  })
  expect([...rows.values()].filter((row) =>
    row.entryType === 'webhook-team-grant'
  )).toEqual([
    expect.objectContaining({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-1',
      memberKey: 'creator-1',
      sourceEntryKey: 'PROJECT_MEMBER#project-1#creator-1',
      teamSourceEntryKey: 'TEAM#active',
      projectSourceEntryKey: 'PROJECT#active',
      webhookAuthorizationKey:
        'WEBHOOK_ACL#TEAM_MEMBER#workspace-1#team-1#creator-1',
    }),
  ])
  expect(rows.has(staleGrantKey)).toBe(false)
  expect([...rows.values()].filter((row) =>
    row.entryType === 'webhook-team-grant-cleanup'
  )).toEqual([
    expect.objectContaining({
      directoryId: 'WEBHOOK_GRANT_CLEANUP#workspace-1#team-1',
      entryKey: 'PROJECT#project-1#MEMBER#creator-1',
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-1',
      memberKey: 'creator-1',
      grantDirectoryId: 'WEBHOOK_TEAM_GRANT#workspace-1#creator-1',
      grantEntryKey: 'TEAM#team-1#PROJECT#project-1',
    }),
  ])

  const scansAtCompletion = fake.scanCalls()
  await expect(processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    afterLocatorCleanupDrain,
    'DeveloperPlatform',
  )).resolves.toMatchObject({ isComplete: true })
  expect(fake.scanCalls()).toBe(scansAtCompletion)
})

test('stops a multi-page invocation when its time budget is exhausted', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  for (let index = 0; index < 6; index += 1) {
    const row = {
      directoryId: 'workspace-1',
      entryKey: `TEAM#${index}`,
      entryType: 'team',
      teamId: `team-${index}`,
    }
    rows.set(createKey(row), row)
  }
  const fake = createDocumentClient(rows, 3)
  await startWebhookAuthorizationBackfill(
    fake.client,
    'ProjectDirectory',
    backfillStartedAt,
    'DeveloperPlatform',
  )
  await processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    afterWriterDrain,
    'DeveloperPlatform',
  )
  await processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    afterLocatorCleanupDrain,
    'DeveloperPlatform',
  )

  const scansBeforeBudgetedPage = fake.scanCalls()
  const progress = await processWebhookAuthorizationBackfillPages(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    {
      maxPages: 100,
      canProcessNextPage: () => false,
      now: () => afterLocatorCleanupDrain,
      developerPlatformTableName: 'DeveloperPlatform',
    },
  )

  expect(progress.isComplete).toBe(false)
  expect(progress.madeProgress).toBe(true)
  expect(progress.checkpoint).toMatchObject({
    phase: 'projection',
    revision: 3,
    sourceRowsUpdated: 2,
  })
  expect(fake.scanCalls() - scansBeforeBudgetedPage).toBe(1)
})

function createDocumentClient(
  rows: Map<string, Record<string, unknown>>,
  pageSize: number,
) {
  const visibleGsiKeys = new Set<string>()
  let checkpointWriteFailure = false
  let advanceWebhookSubscriptionHealth = false
  let completeMarkerBeforeRollbackStart = false
  let replaceGrantBeforeDelete = false
  let sourceRepairBeforeDelete: {
    grantKey: string
    sourceKey: string
    replacement: Record<string, unknown>
  } | undefined
  let repairedSourceCondition: {
    ConditionExpression: string
    ExpressionAttributeValues?: Record<string, unknown>
  } | undefined
  let scans = 0
  const scanLimits: number[] = []
  let updates = 0
  const client = {
    async send(command: {
      constructor: { name: string }
      input: Record<string, unknown>
    }) {
      if (command.constructor.name === 'ScanCommand') {
        scans += 1
        scanLimits.push(Number(command.input.Limit))
        const developerPlatform =
          command.input.TableName === 'DeveloperPlatform'
        const values = [...rows.values()]
          .filter((row) =>
            developerPlatform
              ? typeof row.workspaceId === 'string'
              : typeof row.directoryId === 'string'
          )
          .sort(compareRows)
        const startKey = command.input.ExclusiveStartKey as
          | Record<string, unknown>
          | undefined
        const startIndex = startKey
          ? values.findIndex((row) => createKey(row) === createKey(startKey)) + 1
          : 0
        const page = values.slice(startIndex, startIndex + pageSize)
        return {
          Items: page,
          ...(startIndex + page.length < values.length && page.at(-1)
            ? {
                LastEvaluatedKey: createPrimaryKey(page.at(-1)!),
              }
            : {}),
        }
      }
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as Record<string, unknown>
        return { Item: rows.get(createKey(key)) }
      }
      if (command.constructor.name === 'UpdateCommand') {
        updates += 1
        const key = command.input.Key as Record<string, string>
        const values = command.input.ExpressionAttributeValues as
          Record<string, unknown>
        const stored = rows.get(createKey(key))
        if (
          key.workspaceId === 'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3'
        ) {
          const markerValue = stored?.value as
            | Record<string, unknown>
            | undefined
          if (
            completeMarkerBeforeRollbackStart &&
            stored &&
            markerValue
          ) {
            completeMarkerBeforeRollbackStart = false
            markerValue.state = 'complete'
            stored.version = Number(stored.version) + 1
          }
          if (
            !stored ||
            !markerValue ||
            stored.entryType !== values[':entryType'] ||
            stored.version !== values[':expectedVersion'] ||
            markerValue.migrationVersion !== values[':migrationVersion'] ||
            markerValue.state !== values[':expectedState']
          ) throw conditionalFailure()
          markerValue.state = values[':rollback']
          markerValue.rollbackDrainUntil = values[':rollbackDrainUntil']
          stored.version = Number(stored.version) + 1
          return {}
        }
        if (key.workspaceId !== undefined) {
          const storedValue = stored?.value as
            | Record<string, unknown>
            | undefined
          if (
            !stored ||
            !storedValue ||
            stored.entryType !== values[':entryType'] ||
            storedValue.id !== values[':id'] ||
            storedValue?.createdAt !== values[':createdAt'] ||
            storedValue?.status !== values[':status'] ||
            (
              values[':observedLookupKey'] === undefined
                ? stored.lookupKey !== undefined
                : stored.lookupKey !== values[':observedLookupKey']
            ) ||
            (
              values[':observedLookupSortKey'] === undefined
                ? stored.lookupSortKey !== undefined
                : stored.lookupSortKey !== values[':observedLookupSortKey']
            ) ||
            (
              values[':expiresAt'] === undefined
                ? stored.expiresAt !== undefined
                : stored.expiresAt !== values[':expiresAt']
            )
          ) throw conditionalFailure()
          if (command.input.UpdateExpression ===
            'REMOVE lookupKey, lookupSortKey') {
            delete stored.lookupKey
            delete stored.lookupSortKey
          } else {
            stored.lookupKey = values[':lookupKey']
            stored.lookupSortKey = values[':lookupSortKey']
          }
          return {}
        }
        if (!stored || stored.entryType !== values[':entryType']) {
          throw conditionalFailure()
        }
        stored.webhookAuthorizationKey = values[':authorizationKey']
        stored.webhookAuthorizationSortKey = values[':authorizationSortKey']
        return {}
      }
      if (command.constructor.name === 'DeleteCommand') {
        const key = command.input.Key as Record<string, unknown>
        rows.delete(createKey(key))
        return {}
      }
      if (command.constructor.name === 'QueryCommand') {
        const values = command.input.ExpressionAttributeValues as Record<string, string>
        const matching = [...rows.values()]
          .filter((row) =>
            visibleGsiKeys.has(createKey(row)) &&
            row.webhookAuthorizationKey === values[':authorizationKey'] &&
            row.webhookAuthorizationSortKey === values[':authorizationSortKey']
          )
          .sort(compareRows)
        const startKey = command.input.ExclusiveStartKey as {
          directoryId?: string
          entryKey?: string
        } | undefined
        const startIndex = startKey
          ? matching.findIndex((row) =>
              row.directoryId === startKey.directoryId &&
              row.entryKey === startKey.entryKey
            ) + 1
          : 0
        const limit = command.input.Limit as number
        const page = matching.slice(startIndex, startIndex + limit)
        return {
          Items: page.map((row) => ({
            directoryId: row.directoryId,
            entryKey: row.entryKey,
          })),
          ...(startIndex + page.length < matching.length && page.at(-1)
            ? {
                LastEvaluatedKey: {
                  directoryId: page.at(-1)!.directoryId,
                  entryKey: page.at(-1)!.entryKey,
                },
              }
            : {}),
        }
      }
      if (command.constructor.name === 'PutCommand') {
        const item = command.input.Item as Record<string, unknown>
        const key = createKey(item)
        if (command.input.ConditionExpression === 'attribute_not_exists(directoryId)') {
          if (rows.has(key)) throw conditionalFailure()
          rows.set(key, item)
          return {}
        }
        if (
          command.input.ConditionExpression ===
            'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)'
        ) {
          if (rows.has(key)) throw conditionalFailure()
          rows.set(key, item)
          return {}
        }
        if (
          typeof command.input.ConditionExpression === 'string' &&
          command.input.ConditionExpression.includes('#revision')
        ) {
          if (checkpointWriteFailure) {
            checkpointWriteFailure = false
            throw new Error('interrupted after page writes')
          }
          const existing = rows.get(key)
          const values = command.input.ExpressionAttributeValues as Record<string, unknown>
          if (
            !existing ||
            existing.entryType !== values[':entryType'] ||
            existing.revision !== values[':expectedRevision']
          ) {
            throw conditionalFailure()
          }
          rows.set(key, item)
          return {}
        }
        rows.set(key, item)
        return {}
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        const transactItems = command.input.TransactItems as Array<{
          ConditionCheck?: {
            Key: Record<string, unknown>
            ConditionExpression: string
            ExpressionAttributeNames?: Record<string, string>
            ExpressionAttributeValues?: Record<string, unknown>
          }
          Delete?: {
            Key: Record<string, unknown>
            ConditionExpression?: string
            ExpressionAttributeValues?: Record<string, unknown>
          }
          Put?: {
            Item: Record<string, unknown>
            ConditionExpression?: string
            ExpressionAttributeValues?: Record<string, unknown>
          }
          Update?: {
            Key: Record<string, unknown>
            UpdateExpression: string
            ConditionExpression?: string
            ExpressionAttributeValues?: Record<string, unknown>
          }
        }>
        if (advanceWebhookSubscriptionHealth) {
          const subscriptionMutation = transactItems
            .map((item) => item.Update ?? item.ConditionCheck)
            .find((mutation) =>
              mutation?.Key.workspaceId !== undefined &&
              mutation.Key.workspaceId !==
                'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3'
            )
          if (subscriptionMutation) {
            advanceWebhookSubscriptionHealth = false
            const existing = rows.get(createKey(subscriptionMutation.Key))!
            const value = existing.value as Record<string, unknown>
            existing.value = {
              ...value,
              failureCount: Number(value.failureCount ?? 0) + 1,
              updatedAt: '2026-07-18T00:00:30.000Z',
            }
            existing.version = Number(existing.version) + 1
          }
        }
        for (const item of transactItems) {
          if (
            item.Put?.ConditionExpression ===
              'attribute_not_exists(directoryId)' &&
            rows.has(createKey(item.Put.Item))
          ) {
            throw transactionFailure()
          }
          if (
            item.Put?.ConditionExpression?.includes('#revision')
          ) {
            if (checkpointWriteFailure) {
              checkpointWriteFailure = false
              throw new Error('interrupted after page writes')
            }
            const existing = rows.get(createKey(item.Put.Item))
            const values = item.Put.ExpressionAttributeValues ?? {}
            if (
              !existing ||
              existing.entryType !== values[':entryType'] ||
              existing.revision !== values[':expectedRevision']
            ) throw transactionFailure()
          }
          if (item.Update?.Key.workspaceId ===
            'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3') {
            const existing = rows.get(createKey(item.Update.Key))
            const value = existing?.value as
              | Record<string, unknown>
              | undefined
            const values = item.Update.ExpressionAttributeValues ?? {}
            if (
              existing?.entryType !== 'webhook-active-locator-migration' ||
              value?.migrationVersion !== 'v3' ||
              value.state !== 'cutover' ||
              (
                values[':expectedVersion'] !== undefined &&
                existing.version !== values[':expectedVersion']
              )
            ) throw transactionFailure()
          }
          if (
            (item.Update ?? item.ConditionCheck)?.Key.workspaceId !== undefined &&
            (item.Update ?? item.ConditionCheck)!.Key.workspaceId !==
              'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3'
          ) {
            const subscriptionMutation = (item.Update ??
              item.ConditionCheck)!
            const existing = rows.get(createKey(subscriptionMutation.Key))
            const values =
              subscriptionMutation.ExpressionAttributeValues ?? {}
            const value = existing?.value as
              | Record<string, unknown>
              | undefined
            if (
              !existing ||
              !value ||
              existing.entryType !== values[':entryType'] ||
              (
                ':version' in values &&
                existing.version !== values[':version']
              ) ||
              value.id !== values[':id'] ||
              value?.createdAt !== values[':createdAt'] ||
              value?.status !== values[':status'] ||
              (
                values[':lookupKey'] === undefined
                  ? existing.lookupKey !== undefined
                  : existing.lookupKey !== values[':lookupKey']
              ) ||
              (
                values[':lookupSortKey'] === undefined
                  ? existing.lookupSortKey !== undefined
                  : existing.lookupSortKey !== values[':lookupSortKey']
              ) ||
              (
                values[':expiresAt'] === undefined
                  ? existing.expiresAt !== undefined
                  : existing.expiresAt !== values[':expiresAt']
              )
            ) throw transactionFailure()
          }
        }
        if (sourceRepairBeforeDelete) {
          const repair = sourceRepairBeforeDelete
          const targetsGrant = transactItems.some((item) =>
            item.Delete &&
            createKey(item.Delete.Key) === repair.grantKey
          )
          if (targetsGrant) {
            sourceRepairBeforeDelete = undefined
            const condition = transactItems.find((item) => item.ConditionCheck)
              ?.ConditionCheck
            if (condition) {
              repairedSourceCondition = {
                ConditionExpression: condition.ConditionExpression,
                ...(condition.ExpressionAttributeValues
                  ? {
                      ExpressionAttributeValues:
                        condition.ExpressionAttributeValues,
                    }
                  : {}),
              }
            }
            Object.assign(rows.get(repair.sourceKey)!, repair.replacement)
          }
        }
        if (
          replaceGrantBeforeDelete &&
          transactItems.some((item) =>
            String(item.Delete?.Key.directoryId ?? '')
              .startsWith('WEBHOOK_TEAM_GRANT#')
          )
        ) {
          replaceGrantBeforeDelete = false
          const grantDelete = transactItems.find((item) =>
            String(item.Delete?.Key.directoryId ?? '')
              .startsWith('WEBHOOK_TEAM_GRANT#')
          )!.Delete!
          const replacement = rows.get(
            createKey(grantDelete.Key),
          )
          if (replacement) {
            replacement.projectSourceEntryKey = 'PROJECT#replacement-after-read'
          }
        }
        for (const item of transactItems) {
          if (!item.ConditionCheck) continue
          const source = rows.get(createKey(item.ConditionCheck.Key))
          if (
            item.ConditionCheck.Key.workspaceId ===
              'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3'
          ) {
            const values =
              item.ConditionCheck.ExpressionAttributeValues ?? {}
            const markerValue = source?.value as
              | Record<string, unknown>
              | undefined
            if (
              !source ||
              !markerValue ||
              source.entryType !== values[':migrationEntryType'] ||
              markerValue.migrationVersion !== values[':migrationVersion'] ||
              markerValue.state !== values[':migrationState']
            ) throw transactionFailure()
            continue
          }
          if (item.ConditionCheck.Key.workspaceId !== undefined) continue
          if (item.ConditionCheck.ConditionExpression ===
            'attribute_not_exists(directoryId)') {
            if (source) throw conditionalFailure()
            continue
          }
          const values = item.ConditionCheck.ExpressionAttributeValues ?? {}
          if (item.ConditionCheck.ConditionExpression.includes(
            'attribute_not_exists(archivedAt)',
          ) && (
            !source ||
            source.entryType !== values[':entryType'] ||
            source.archivedAt !== undefined
          )) {
            throw conditionalFailure()
          }
          if (!item.ConditionCheck.ConditionExpression.includes(
            'attribute_not_exists(archivedAt)',
          )) {
            const names = item.ConditionCheck.ExpressionAttributeNames ?? {}
            for (const [placeholder, field] of Object.entries(names)) {
              if (source?.[field] !== values[`:${placeholder.slice(1)}`]) {
                throw conditionalFailure()
              }
            }
          }
        }
        for (const item of transactItems) {
          if (!item.Delete?.ConditionExpression) continue
          const current = rows.get(createKey(item.Delete.Key))
          const values = item.Delete.ExpressionAttributeValues ?? {}
          if (
            item.Delete.Key.workspaceId ===
              'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3'
          ) {
            const markerValue = current?.value as
              | Record<string, unknown>
              | undefined
            if (
              !current ||
              !markerValue ||
              current.entryType !== values[':migrationEntryType'] ||
              markerValue.migrationVersion !== values[':migrationVersion'] ||
              markerValue.state !== values[':rollback']
            ) throw transactionFailure()
            continue
          }
          if (
            item.Delete.Key.directoryId ===
              'WEBHOOK_ACTIVE_LOCATOR_ROLLBACK#v3'
          ) {
            if (
              !current ||
              current.entryType !== values[':checkpointEntryType'] ||
              current.revision !== values[':revision']
            ) throw transactionFailure()
            continue
          }
          for (const [placeholder, expected] of Object.entries(values)) {
            const field = placeholder === ':entryType'
              ? 'entryType'
              : placeholder.slice(1)
            if (current?.[field] !== expected) throw conditionalFailure()
          }
        }
        for (const item of transactItems) {
          if (item.Delete) {
            rows.delete(createKey(item.Delete.Key))
          }
          if (item.Put) rows.set(createKey(item.Put.Item), item.Put.Item)
          if (item.Update?.Key.workspaceId ===
            'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3') {
            const existing = rows.get(createKey(item.Update.Key))!
            const value = existing.value as Record<string, unknown>
            const values = item.Update.ExpressionAttributeValues ?? {}
            if (
              item.Update.UpdateExpression.includes('#writerDrainUntil')
            ) {
              value.writerDrainUntil = values[':writerDrainUntil']
            } else {
              value.state = 'complete'
            }
            existing.version = Number(existing.version) + 1
          }
          if (
            item.Update?.Key.workspaceId !== undefined &&
            item.Update.Key.workspaceId !==
              'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3'
          ) {
            const existing = rows.get(createKey(item.Update.Key))!
            delete existing.lookupKey
            delete existing.lookupSortKey
          }
        }
        return {}
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    },
  } as unknown as DynamoDBDocumentClient
  return {
    client,
    failNextCheckpointWrite() {
      checkpointWriteFailure = true
    },
    advanceWebhookSubscriptionHealthBeforeNextReconcile() {
      advanceWebhookSubscriptionHealth = true
    },
    completeMarkerBeforeNextRollbackStart() {
      completeMarkerBeforeRollbackStart = true
    },
    replaceGrantBeforeNextDelete() {
      replaceGrantBeforeDelete = true
    },
    repairSourceBeforeGrantDelete(
      grantKey: string,
      sourceKey: string,
      replacement: Record<string, unknown>,
    ) {
      sourceRepairBeforeDelete = { grantKey, sourceKey, replacement }
    },
    repairedSourceCondition() {
      return repairedSourceCondition
    },
    flushGsi() {
      for (const row of rows.values()) {
        if (typeof row.webhookAuthorizationKey === 'string') {
          visibleGsiKeys.add(createKey(row))
        }
      }
    },
    scanCalls() {
      return scans
    },
    scanLimits() {
      return [...scanLimits]
    },
    updateCalls() {
      return updates
    },
  }
}

function createKey(row: Record<string, unknown>) {
  if (
    typeof row.directoryId === 'string' &&
    typeof row.entryKey === 'string'
  ) return `${row.directoryId}\0${row.entryKey}`
  if (
    typeof row.workspaceId === 'string' &&
    typeof row.recordKey === 'string'
  ) return `${row.workspaceId}\0${row.recordKey}`
  throw new TypeError('Test row key is invalid.')
}

function createPrimaryKey(row: Record<string, unknown>) {
  return typeof row.directoryId === 'string'
    ? {
        directoryId: row.directoryId,
        entryKey: row.entryKey,
      }
    : {
        workspaceId: row.workspaceId,
        recordKey: row.recordKey,
      }
}

function compareRows(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
) {
  return createKey(first).localeCompare(createKey(second))
}

function conditionalFailure() {
  return Object.assign(new Error('Conditional update failed.'), {
    name: 'ConditionalCheckFailedException',
  })
}

function transactionFailure() {
  return Object.assign(new Error('Transaction condition failed.'), {
    name: 'TransactionCanceledException',
  })
}
