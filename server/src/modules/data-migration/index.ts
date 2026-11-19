/** Pure migration contract: definitions, checkpoints, counters and failure codes. */
export {
  assertValidDataMigrationRegistry,
  DATA_MIGRATION_MAX_PAGE_SIZE,
  DataMigrationFailure,
  type DataMigrationCheckpoint,
  type DataMigrationCounters,
  type DataMigrationDefinition,
  type DataMigrationFailureCode,
  type DataMigrationRow,
  type DataMigrationRowClass,
  type DataMigrationWriterPolicy,
} from './domain/data-migration'
/** Ports the runner and verifier depend on. */
export type {
  DataMigrationCheckpointStore,
  DataMigrationClock,
  DataMigrationReplaceOutcome,
  DataMigrationRowPage,
  DataMigrationRowStore,
} from './application/ports/data-migration-ports'
/** Bounded, resumable runner. */
export {
  runDataMigration,
  type DataMigrationPartitionReport,
  type DataMigrationRunReport,
  type RunDataMigrationInput,
} from './application/use-cases/run-data-migration'
/** Read-only completion check. */
export {
  verifyDataMigration,
  type DataMigrationVerificationReport,
  type VerifyDataMigrationInput,
} from './application/use-cases/verify-data-migration'
/** DynamoDB adapters. */
export {
  createDynamoDbDataMigrationRowStore,
  DATA_MIGRATION_MAX_SEGMENTS,
} from './adapter-out/dynamodb/dynamodb-data-migration-row-store'
export {
  createDynamoDbDataMigrationCheckpointStore,
  ensureLocalDataMigrationCheckpointTable,
} from './adapter-out/dynamodb/dynamodb-data-migration-checkpoint-store'
