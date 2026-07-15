import { describe, expect, test } from 'bun:test'
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { WORK_ITEM_SCHEMA_VERSION } from '@mukuroji/contracts'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  hasWorkItemConfigurationMetadata,
  parseArguments,
  planWorkItemConfigurationBackfill,
  runWorkItemConfigurationMigration,
  statusCategoryForLegacyStatus,
} from '../scripts/migrate-work-item-configuration'

const legacyWorkItem = {
  directoryTeamId: 'workspace-1#team#core-team',
  issueId: 'issue-1',
  schemaVersion: WORK_ITEM_SCHEMA_VERSION,
  revision: 3,
  status: 'in-progress',
} as const

function createDocumentClient(
  send: (command: unknown) => Promise<unknown>,
): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient
}

function completeMetadata(item = legacyWorkItem) {
  return {
    ...item,
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: item.status,
    statusCategory: statusCategoryForLegacyStatus(item.status),
    customFieldValues: {},
  }
}

function readCommandName(command: unknown) {
  if (typeof command !== 'object' || command === null) {
    return String(command)
  }
  return Object.getPrototypeOf(command)?.constructor?.name ?? 'Object'
}

describe('Work Item configuration migration', () => {
  test('maps every legacy status to its workflow category', () => {
    expect(statusCategoryForLegacyStatus('todo')).toBe('unstarted')
    expect(statusCategoryForLegacyStatus('in-progress')).toBe('started')
    expect(statusCategoryForLegacyStatus('review')).toBe('started')
    expect(statusCategoryForLegacyStatus('done')).toBe('completed')
    expect(statusCategoryForLegacyStatus('blocked')).toBeUndefined()
    expect(statusCategoryForLegacyStatus(undefined)).toBeUndefined()
  })

  test('plans an additive backfill without changing the source row', () => {
    const source = structuredClone(legacyWorkItem)

    expect(planWorkItemConfigurationBackfill(source)).toEqual({
      action: 'backfill',
      target: {
        directoryTeamId: legacyWorkItem.directoryTeamId,
        issueId: legacyWorkItem.issueId,
        expectedRevision: legacyWorkItem.revision,
        expectedStatus: legacyWorkItem.status,
      },
      updates: {
        workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
        workflowStatusId: 'in-progress',
        statusCategory: 'started',
        customFieldValues: {},
      },
    })
    expect(source).toEqual(legacyWorkItem)
  })

  test('keeps rows with complete matching metadata unchanged', () => {
    const current = {
      ...legacyWorkItem,
      workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
      workflowStatusId: 'in-progress',
      statusCategory: 'started',
      customFieldValues: { estimate: 5 },
    }

    expect(planWorkItemConfigurationBackfill(current)).toEqual({
      action: 'unchanged',
      target: {
        directoryTeamId: legacyWorkItem.directoryTeamId,
        issueId: legacyWorkItem.issueId,
        expectedRevision: legacyWorkItem.revision,
        expectedStatus: legacyWorkItem.status,
      },
    })
    expect(hasWorkItemConfigurationMetadata(current)).toBe(true)
  })

  test('rejects metadata that disagrees with the legacy status', () => {
    expect(planWorkItemConfigurationBackfill({
      ...legacyWorkItem,
      workflowStatusId: 'done',
    })).toEqual({
      action: 'invalid',
      reason: 'workflowStatusId does not match the legacy Work Item status.',
    })
    expect(planWorkItemConfigurationBackfill({
      ...legacyWorkItem,
      statusCategory: 'completed',
    })).toEqual({
      action: 'invalid',
      reason: 'statusCategory does not match the legacy Work Item status.',
    })
    expect(planWorkItemConfigurationBackfill({
      ...legacyWorkItem,
      customFieldValues: [],
    })).toEqual({
      action: 'invalid',
      reason: 'customFieldValues contains an invalid value.',
    })
    expect(planWorkItemConfigurationBackfill({
      ...legacyWorkItem,
      customFieldValues: { nested: { unsafe: true } },
    })).toEqual({
      action: 'invalid',
      reason: 'customFieldValues contains an invalid value.',
    })
    expect(hasWorkItemConfigurationMetadata({
      ...legacyWorkItem,
      workflowStatusId: 'done',
    })).toBe(false)
  })

  test('rejects unsupported Work Item and workflow schema versions', () => {
    expect(planWorkItemConfigurationBackfill({
      ...legacyWorkItem,
      schemaVersion: WORK_ITEM_SCHEMA_VERSION + 1,
    })).toEqual({
      action: 'invalid',
      reason: `Unsupported Work Item schema version: ${WORK_ITEM_SCHEMA_VERSION + 1}.`,
    })
    expect(planWorkItemConfigurationBackfill({
      ...legacyWorkItem,
      workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION + 1,
    })).toEqual({
      action: 'invalid',
      reason: `Unsupported workflow schema version: ${WORK_ITEM_CONFIGURATION_SCHEMA_VERSION + 1}.`,
    })
  })

  test('is idempotent after applying its planned additive updates', () => {
    const first = planWorkItemConfigurationBackfill(legacyWorkItem)
    expect(first.action).toBe('backfill')
    if (first.action !== 'backfill') {
      throw new Error('Expected configuration metadata to require a backfill.')
    }

    const migrated = { ...legacyWorkItem, ...first.updates }
    const second = planWorkItemConfigurationBackfill(migrated)
    const third = planWorkItemConfigurationBackfill(migrated)

    expect(second).toEqual({ action: 'unchanged', target: first.target })
    expect(third).toEqual(second)
    expect(hasWorkItemConfigurationMetadata(migrated)).toBe(true)
  })

  test('scans every page and carries the last evaluated key forward', async () => {
    const scanInputs: ScanCommand['input'][] = []
    const secondWorkItem = {
      ...legacyWorkItem,
      issueId: 'issue-2',
      status: 'done' as const,
    }
    const client = createDocumentClient(async (command) => {
      if (!(command instanceof ScanCommand)) {
        throw new Error(`Unexpected command: ${readCommandName(command)}`)
      }

      scanInputs.push(command.input)
      if (scanInputs.length === 1) {
        return {
          Items: [legacyWorkItem],
          LastEvaluatedKey: {
            directoryTeamId: legacyWorkItem.directoryTeamId,
            issueId: legacyWorkItem.issueId,
          },
        }
      }
      return { Items: [secondWorkItem] }
    })

    const result = await runWorkItemConfigurationMigration({
      tableName: 'work-items',
      client,
      mode: 'dry-run',
      pageSize: 1,
    })

    expect(result).toEqual({
      outcome: 'completed',
      counters: {
        scanned: 2,
        updated: 0,
        unchanged: 0,
        duplicates: 0,
        conflicts: 0,
        wouldUpdate: 2,
        missing: 0,
        invalid: 0,
      },
    })
    expect(scanInputs).toHaveLength(2)
    expect(scanInputs[0]?.Limit).toBe(1)
    expect(scanInputs[0]?.ExclusiveStartKey).toBeUndefined()
    expect(scanInputs[1]?.ExclusiveStartKey).toEqual({
      directoryTeamId: legacyWorkItem.directoryTeamId,
      issueId: legacyWorkItem.issueId,
    })
  })

  test('completes a full paginated preflight and writes nothing when a later row is invalid', async () => {
    const commands: string[] = []
    let scanCount = 0
    const client = createDocumentClient(async (command) => {
      commands.push(readCommandName(command))
      if (command instanceof UpdateCommand) {
        throw new Error('Apply must not start after an invalid preflight.')
      }
      if (!(command instanceof ScanCommand)) {
        throw new Error(`Unexpected command: ${readCommandName(command)}`)
      }

      scanCount += 1
      if (scanCount === 1) {
        return {
          Items: [legacyWorkItem],
          LastEvaluatedKey: {
            directoryTeamId: legacyWorkItem.directoryTeamId,
            issueId: legacyWorkItem.issueId,
          },
        }
      }
      return {
        Items: [{
          ...legacyWorkItem,
          issueId: 'issue-invalid',
          schemaVersion: WORK_ITEM_SCHEMA_VERSION + 1,
        }],
      }
    })

    const result = await runWorkItemConfigurationMigration({
      tableName: 'work-items',
      client,
      mode: 'apply',
      pageSize: 1,
    })

    expect(result.outcome).toBe('preflight-failed')
    expect(result.counters).toMatchObject({ scanned: 2, invalid: 1, updated: 0 })
    expect(commands).toEqual(['ScanCommand', 'ScanCommand'])
  })

  test('counts a conditional race as a duplicate when another writer completed the backfill', async () => {
    const commands: string[] = []
    const client = createDocumentClient(async (command) => {
      commands.push(readCommandName(command))
      if (command instanceof ScanCommand) {
        return { Items: [legacyWorkItem] }
      }
      if (command instanceof UpdateCommand) {
        const error = new Error('A concurrent migration already updated the row.')
        error.name = 'ConditionalCheckFailedException'
        throw error
      }
      if (command instanceof GetCommand) {
        return { Item: completeMetadata() }
      }
      throw new Error(`Unexpected command: ${readCommandName(command)}`)
    })

    const result = await runWorkItemConfigurationMigration({
      tableName: 'work-items',
      client,
      mode: 'apply',
      pageSize: 100,
    })

    expect(result).toEqual({
      outcome: 'completed',
      counters: {
        scanned: 1,
        updated: 0,
        unchanged: 0,
        duplicates: 1,
        conflicts: 0,
        wouldUpdate: 0,
        missing: 0,
        invalid: 0,
      },
    })
    expect(commands).toEqual(['ScanCommand', 'ScanCommand', 'UpdateCommand', 'GetCommand'])
  })

  test('counts a concurrent edit as a conflict and continues the apply pass', async () => {
    const commands: string[] = []
    const secondWorkItem = { ...legacyWorkItem, issueId: 'issue-2' }
    let updateCount = 0
    const client = createDocumentClient(async (command) => {
      commands.push(readCommandName(command))
      if (command instanceof ScanCommand) {
        return { Items: [legacyWorkItem, secondWorkItem] }
      }
      if (command instanceof UpdateCommand) {
        updateCount += 1
        if (updateCount === 1) {
          const error = new Error('The Work Item was edited concurrently.')
          error.name = 'ConditionalCheckFailedException'
          throw error
        }
        return {}
      }
      if (command instanceof GetCommand) {
        return { Item: { ...legacyWorkItem, revision: legacyWorkItem.revision + 1 } }
      }
      throw new Error(`Unexpected command: ${readCommandName(command)}`)
    })

    const result = await runWorkItemConfigurationMigration({
      tableName: 'work-items',
      client,
      mode: 'apply',
      pageSize: 100,
    })

    expect(result).toEqual({
      outcome: 'completed',
      counters: {
        scanned: 2,
        updated: 1,
        unchanged: 0,
        duplicates: 0,
        conflicts: 1,
        wouldUpdate: 0,
        missing: 0,
        invalid: 0,
      },
    })
    expect(commands).toEqual([
      'ScanCommand',
      'ScanCommand',
      'UpdateCommand',
      'GetCommand',
      'UpdateCommand',
    ])
  })

  test('verify reports missing metadata without issuing an update', async () => {
    const commands: string[] = []
    const client = createDocumentClient(async (command) => {
      commands.push(readCommandName(command))
      if (!(command instanceof ScanCommand)) {
        throw new Error(`Unexpected command: ${readCommandName(command)}`)
      }
      return { Items: [legacyWorkItem] }
    })

    const result = await runWorkItemConfigurationMigration({
      tableName: 'work-items',
      client,
      mode: 'verify',
      pageSize: 100,
    })

    expect(result).toEqual({
      outcome: 'completed',
      counters: {
        scanned: 1,
        updated: 0,
        unchanged: 0,
        duplicates: 0,
        conflicts: 0,
        wouldUpdate: 0,
        missing: 1,
        invalid: 0,
      },
    })
    expect(commands).toEqual(['ScanCommand'])
  })

  test('does not allow a successful partial apply', () => {
    expect(() => parseArguments(['--limit', '10'])).toThrow(
      '--limit is only available with --dry-run or --verify.',
    )
    expect(parseArguments(['--dry-run', '--limit', '10'])).toMatchObject({
      limit: 10,
      mode: 'dry-run',
    })
    expect(parseArguments(['--verify', '--limit', '10'])).toMatchObject({
      limit: 10,
      mode: 'verify',
    })
  })

  test('rejects an apply limit at the migration runner boundary', async () => {
    let commandCount = 0
    const client = createDocumentClient(async () => {
      commandCount += 1
      return { Items: [] }
    })

    await expect(runWorkItemConfigurationMigration({
      tableName: 'work-items',
      client,
      mode: 'apply',
      pageSize: 100,
      limit: 10,
    })).rejects.toThrow('--limit is only available with --dry-run or --verify.')
    expect(commandCount).toBe(0)
  })
})
