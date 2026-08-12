import { createMigrationDigest } from './migration-contract'

/** Canonical empty cumulative abandonment-chain root. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST =
  createMigrationDigest({
    kind: 'workspace-search-migration-rehearsal-abandonment-root',
    version: 1,
  })
