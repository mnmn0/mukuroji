import { describe, expect, test } from 'bun:test'
import { createPendingTaskRow, createTaskEstimateMigration } from '../test-support/data-migration-fakes'
import {
  assertValidDataMigrationDefinition,
  assertValidDataMigrationRegistry,
  classifyDataMigrationRow,
  transformDataMigrationRow,
} from './data-migration'

describe('data migration definition', () => {
  test('accepts a valid definition', () => {
    expect(() => assertValidDataMigrationDefinition(createTaskEstimateMigration())).not.toThrow()
    expect(() => assertValidDataMigrationDefinition(createTaskEstimateMigration({
      writerPolicy: 'revision-fenced',
      revisionAttribute: 'revision',
    }))).not.toThrow()
  })

  test.each([
    ['an id without a sequence', { id: 'task-estimate' }],
    ['a physical-looking table', { table: 'Mukuroji-WorkItems' }],
    ['a version jump', { toSchemaVersion: 3 }],
    ['a version stored in a key', { versionAttribute: 'pk' }],
    ['three key attributes', { keyAttributes: ['pk', 'sk', 'gsi'] }],
    ['a fenced policy without a revision', { writerPolicy: 'revision-fenced' as const }],
    ['a paused policy with a revision', { revisionAttribute: 'revision' }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => assertValidDataMigrationDefinition(createTaskEstimateMigration(overrides)))
      .toThrow('DEFINITION_INVALID')
  })

  test('rejects duplicate identifiers in a registry', () => {
    expect(() => assertValidDataMigrationRegistry([createTaskEstimateMigration(), createTaskEstimateMigration()]))
      .toThrow('DEFINITION_INVALID')
  })

  test('treats a throwing classifier as an unknown row', () => {
    const definition = createTaskEstimateMigration({ classify: () => { throw new Error('boom') } })
    expect(classifyDataMigrationRow(definition, createPendingTaskRow(1))).toBe('unknown')
  })

  test('validates the transformed row', () => {
    const definition = createTaskEstimateMigration()
    expect(transformDataMigrationRow(definition, createPendingTaskRow(4))).toMatchObject({ schemaVersion: 2, estimatePoints: 4 })
    const fenced = createTaskEstimateMigration({
      writerPolicy: 'revision-fenced',
      revisionAttribute: 'revision',
      transform: (row) => ({ ...createTaskEstimateMigration().transform(row), revision: 99 }),
    })
    expect(() => transformDataMigrationRow(fenced, { ...createPendingTaskRow(4), revision: 1 })).toThrow('TRANSFORM_INVALID')
    const throwing = createTaskEstimateMigration({ transform: () => { throw new Error('boom') } })
    expect(() => transformDataMigrationRow(throwing, createPendingTaskRow(4))).toThrow('TRANSFORM_INVALID')
  })
})
