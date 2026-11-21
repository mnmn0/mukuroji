/** Pure migration contract: definitions, checkpoints, counters and failure codes. */
export {
  assertValidDataMigrationRegistry,
  DATA_MIGRATION_MAX_PAGE_SIZE,
  DATA_MIGRATION_MAX_SEGMENTS,
  DataMigrationFailure,
  type DataMigrationCheckpoint,
  type DataMigrationCounters,
  type DataMigrationDefinition,
  type DataMigrationDeriveDefinition,
  type DataMigrationTransformDefinition,
  DATA_MIGRATION_MAX_DERIVED_ROWS,
  type DataMigrationFailureCode,
  type DataMigrationRow,
  type DataMigrationRowClass,
  type DataMigrationRunRecord,
  type DataMigrationWriterPolicy,
} from './domain/data-migration'
/** Ports the runner and verifier depend on. */
export type {
  DataMigrationCheckpointStore,
  DataMigrationClock,
  DataMigrationOperatorProofRequest,
  DataMigrationOperatorVerifier,
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
} from './adapter-out/dynamodb/dynamodb-data-migration-row-store'
export {
  createDynamoDbDataMigrationCheckpointStore,
  ensureLocalDataMigrationCheckpointTable,
} from './adapter-out/dynamodb/dynamodb-data-migration-checkpoint-store'
/** Defaults shared by the CLI and the Lambda. */
export {
  DATA_MIGRATION_INVOCATION_DEFAULTS,
  type DataMigrationInvocationDefaults,
} from './application/data-migration-invocation-defaults'
/** Lambda invocation adapter. */
export {
  computeDataMigrationRequestBinding,
  handleDataMigrationInvocation,
  parseDataMigrationInvocation,
  type DataMigrationInvocationContext,
  type DataMigrationInvocationDependencies,
  type DataMigrationInvocationErrorCode,
  type DataMigrationInvocationRequest,
  type DataMigrationInvocationResponse,
} from './adapter-in/lambda/data-migration-invocation'
/** Operator identity proof checked against STS. */
export {
  createStsDataMigrationOperatorVerifier,
  DATA_MIGRATION_OPERATOR_PROOF_HEADER,
  DATA_MIGRATION_OPERATOR_PROOF_MAX_EXPIRES_SECONDS,
  DataMigrationOperatorProofError,
  type StsDataMigrationOperatorVerifierOptions,
} from './adapter-out/sts/sts-data-migration-operator-verifier'
