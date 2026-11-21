import type { DataMigrationDefinition } from '../../modules/data-migration'

/**
 * Every migration the CLI and the data migration Lambda can run, in identifier order.
 *
 * A schema change that must keep stored rows adds its definition here in the
 * same PR, following `docs/data-migration.md`. Definitions live in the module
 * that owns the table and are only listed here.
 */
export const dataMigrationRegistry: readonly DataMigrationDefinition[] = []
