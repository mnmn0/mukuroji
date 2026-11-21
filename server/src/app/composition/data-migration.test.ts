import { describe, expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import {
  createDataMigrationLambdaDependencies,
  createDataMigrationRehearsalDependencies,
  parseDataMigrationTargetTables,
} from './data-migration'

describe('data migration Lambda composition', () => {
  test('reads the allowlist of target tables by logical name', () => {
    expect([...parseDataMigrationTargetTables('{"work-items":"Mukuroji-WorkItemsTable-ABC"}')])
      .toEqual([['work-items', 'Mukuroji-WorkItemsTable-ABC']])
    expect(parseDataMigrationTargetTables('{}').size).toBe(0)
  })

  test('rejects a malformed allowlist', () => {
    for (const value of [undefined, '', '[]', 'null', '{"work-items":1}', '{"Work Items":"t-1"}', '{"work-items":"a b"}']) {
      expect(() => parseDataMigrationTargetTables(value)).toThrow(TypeError)
    }
  })

  test('requires the checkpoint table and builds the dependencies', () => {
    expect(() => createDataMigrationLambdaDependencies({
      AWS_REGION: 'ap-northeast-1',
      DATA_MIGRATION_TARGET_TABLES: '{}',
    })).toThrow(TypeError)
    const dependencies = createDataMigrationLambdaDependencies({
      AWS_REGION: 'ap-northeast-1',
      DATA_MIGRATION_CHECKPOINT_TABLE_NAME: 'Mukuroji-DataMigrationCheckpointTable',
      DATA_MIGRATION_TARGET_TABLES: '{"work-items":"Mukuroji-WorkItemsTable"}',
    })
    expect(dependencies.checkpointTableName).toBe('Mukuroji-DataMigrationCheckpointTable')
    expect(dependencies.targetTables.get('work-items')).toBe('Mukuroji-WorkItemsTable')
  })

  test('builds rehearsal dependencies only for a local emulator endpoint', async () => {
    const input = {
      documentClient: createDynamoDbDocumentClient(new DynamoDBClient({ region: 'ap-northeast-1' })),
      registry: [],
      targetTables: new Map([['rehearsal', 'mukuroji-data-migration-rehearsal-1']]),
      checkpointTableName: 'mukuroji-data-migration-rehearsal-checkpoints-1',
      operator: 'local-emulator',
    }
    const savedEndpoint = process.env.DYNAMODB_ENDPOINT
    try {
      process.env.DYNAMODB_ENDPOINT = 'https://dynamodb.ap-northeast-1.amazonaws.com'
      expect(() => createDataMigrationRehearsalDependencies(input)).toThrow(TypeError)
      process.env.DYNAMODB_ENDPOINT = 'http://localhost:4566'
      const dependencies = createDataMigrationRehearsalDependencies(input)
      expect(await dependencies.verifyOperator({ proof: 'any', binding: 'b', accountId: '000000000000' }))
        .toBe('local-emulator')
      expect(dependencies.writeAuditLog('line')).toBeUndefined()
      expect(dependencies.targetTables.get('rehearsal')).toBe('mukuroji-data-migration-rehearsal-1')
    } finally {
      if (savedEndpoint === undefined) delete process.env.DYNAMODB_ENDPOINT
      else process.env.DYNAMODB_ENDPOINT = savedEndpoint
    }
  })
})
