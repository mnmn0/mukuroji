import type { DataMigrationDefinition } from '../../src/modules/data-migration'

/** Logical table name the rehearsal migration targets. */
export const REHEARSAL_TABLE = 'rehearsal'

/**
 * Migration used only by the Floci rehearsal: `task` rows move from a text
 * `estimate` (v1) to a numeric `estimatePoints` (v2). It is never registered
 * for real tables.
 *
 * @returns The definition.
 */
export function createRehearsalMigration(): DataMigrationDefinition {
  return {
    id: '0000-rehearsal-task-estimate-points',
    description: 'Rehearsal only: store task estimates as points.',
    table: REHEARSAL_TABLE,
    keyAttributes: ['pk', 'sk'],
    versionAttribute: 'schemaVersion',
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    writerPolicy: 'pause-writers',
    classify: (row) => {
      if (row.entity !== 'task') return 'unrelated'
      if (row.schemaVersion === 1 && typeof row.estimate === 'string') return 'pending'
      if (row.schemaVersion === 2 && typeof row.estimatePoints === 'number' && !('estimate' in row)) {
        return 'migrated'
      }
      return 'unknown'
    },
    transform: (row) => {
      const { estimate, ...rest } = row
      return { ...rest, schemaVersion: 2, estimatePoints: Number(estimate) }
    },
  }
}

/** Seed rows of one rehearsal. */
export type RehearsalSeed = {
  /** Every row to write. */
  readonly rows: readonly Record<string, unknown>[]
  /** Rows at the old schema version. */
  readonly pending: number
  /** Rows already at the new schema version. */
  readonly migrated: number
  /** Rows of other entities. */
  readonly unrelated: number
}

/**
 * Builds old-schema task rows, a few already migrated rows and rows of
 * another entity, spread over several Teams.
 *
 * @param pending - Number of old-schema rows.
 * @returns The seed.
 */
export function createRehearsalSeed(pending: number): RehearsalSeed {
  const rows: Record<string, unknown>[] = []
  for (let index = 0; index < pending; index += 1) {
    rows.push({
      pk: `TEAM#${index % 3}`,
      sk: `TASK#${String(index).padStart(4, '0')}`,
      entity: 'task',
      schemaVersion: 1,
      estimate: String(index % 13),
    })
  }
  const migrated = 3
  for (let index = 0; index < migrated; index += 1) {
    rows.push({ pk: 'TEAM#0', sk: `TASK#M${index}`, entity: 'task', schemaVersion: 2, estimatePoints: index })
  }
  const unrelated = 3
  for (let index = 0; index < unrelated; index += 1) {
    rows.push({ pk: `TEAM#${index}`, sk: 'META', entity: 'team', name: `Team ${index}` })
  }
  return { rows, pending, migrated, unrelated }
}
