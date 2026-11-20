import { describe, expect, test } from 'bun:test'
import {
  createDataMigrationLambdaDependencies,
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
})
