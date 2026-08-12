import {
  createRestoreDrillAwsCleanupOperationsFromEnvironment,
  createRestoreDrillAwsOperationsFromEnvironment,
  type RestoreDrillAwsOperations,
  type RestoreDrillDynamoAggregateCheckpoint,
  type RestoreDrillExportDataFile,
  type RestoreDrillExportManifest,
} from '../../modules/restore-drill/restore-drill-aws'
import {
  AwsRestoreDrillApprovalStore,
  AwsRestoreDrillCleanupExecutionStore,
  AwsRestoreDrillEvidenceStore,
  AwsRestoreDrillMetricSink,
  AwsRestoreDrillStateStore,
  AwsRestoreDrillVerifier,
  RestoreDrillOrchestratorFailure,
  createRestoreDrillOrchestrator,
  type RestoreDrillApprovalReadResult,
  type RestoreDrillApprovalStore,
  type RestoreDrillCleanupExecutionObservation,
  type RestoreDrillCleanupExecutionStore,
  type RestoreDrillCleanupOperations,
  type RestoreDrillExportVersionReader,
  type RestoreDrillFileVerificationEvidence,
  type RestoreDrillFileVerificationResources,
  type RestoreDrillOrchestrator,
  type RestoreDrillPartitionDigestSink,
  type RestoreDrillResourceAggregate,
  type RestoreDrillSemanticClaimPage,
  type RestoreDrillTableTarget,
  type RestoreDrillVerificationResult,
  type RestoreDrillVerifier,
  type RestoreDrillVerifierInput,
} from '../../modules/restore-drill'

/** Reusable full runner composition retained across warm Lambda invocations. */
export type RestoreDrillRunnerRuntime = {
  /** Durable orchestration kernel. */
  readonly orchestrator: RestoreDrillOrchestrator
  /** Full isolated AWS data-plane operations. */
  readonly operations: RestoreDrillAwsOperations
}

/** Reusable least-privilege cleanup composition retained across warm invocations. */
export type RestoreDrillCleanupRuntime = {
  /** Durable orchestration kernel. */
  readonly orchestrator: RestoreDrillOrchestrator
  /** Cleanup-only isolated AWS operations. */
  readonly operations: RestoreDrillCleanupOperations
}

/** Approval boundary that is intentionally unavailable to the runner role. */
class UnavailableRestoreDrillApprovalStore implements RestoreDrillApprovalStore {
  /** @inheritdoc */
  async readImmutable(): Promise<RestoreDrillApprovalReadResult> {
    throw new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID')
  }
}

/** Execution boundary that is intentionally unavailable to the runner role. */
class UnavailableRestoreDrillExecutionStore implements RestoreDrillCleanupExecutionStore {
  /** @inheritdoc */
  async readStatus(): Promise<RestoreDrillCleanupExecutionObservation> {
    throw new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID')
  }
}

/** Verification boundary that is intentionally unavailable to the cleanup role. */
class UnavailableRestoreDrillVerifier implements RestoreDrillVerifier {
  /** @inheritdoc */
  async resolveSemanticSecretVersion(): Promise<string> {
    throw new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID')
  }

  /** @inheritdoc */
  async readSemanticClaimPage(): Promise<RestoreDrillSemanticClaimPage> {
    throw new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID')
  }

  /** @inheritdoc */
  async readSourceExportManifest(
    input: RestoreDrillVerifierInput,
    target: RestoreDrillTableTarget,
    readVersion: RestoreDrillExportVersionReader,
  ): Promise<RestoreDrillExportManifest> {
    void input
    void target
    void readVersion
    throw new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID')
  }

  /** @inheritdoc */
  async aggregateSourceExportFile(
    input: RestoreDrillVerifierInput,
    target: RestoreDrillTableTarget,
    dataFile: RestoreDrillExportDataFile,
    readVersion: RestoreDrillExportVersionReader,
    partitionSink: RestoreDrillPartitionDigestSink,
  ): Promise<RestoreDrillDynamoAggregateCheckpoint> {
    void input
    void target
    void dataFile
    void readVersion
    void partitionSink
    throw new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID')
  }

  /** @inheritdoc */
  async finalizeFileVerification(
    input: RestoreDrillVerifierInput,
    evidence: RestoreDrillFileVerificationEvidence,
  ): Promise<RestoreDrillFileVerificationResources> {
    void input
    void evidence
    throw new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID')
  }

  /** @inheritdoc */
  async assembleVerification(
    input: RestoreDrillVerifierInput,
    sourceFileResource: RestoreDrillResourceAggregate,
    restoreFileResource: RestoreDrillResourceAggregate,
    sourceResources: readonly RestoreDrillResourceAggregate[],
    restoreResources: readonly RestoreDrillResourceAggregate[],
    workItemsSchemaStatus: 'fail' | 'pass',
    crossDomainStatus: 'fail' | 'pass',
  ): Promise<RestoreDrillVerificationResult> {
    void input
    void sourceFileResource
    void restoreFileResource
    void sourceResources
    void restoreResources
    void workItemsSchemaStatus
    void crossDomainStatus
    throw new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID')
  }
}

let runnerRuntime: RestoreDrillRunnerRuntime | undefined
let cleanupRuntime: RestoreDrillCleanupRuntime | undefined

/**
 * Creates or reuses the full runner composition without cleanup privileges.
 *
 * @returns Warm-invocation runner runtime.
 */
export function getRestoreDrillRunnerRuntime(): RestoreDrillRunnerRuntime {
  if (runnerRuntime) return runnerRuntime
  const aws = createRestoreDrillAwsOperationsFromEnvironment()
  const state = new AwsRestoreDrillStateStore(
    aws.configuration.stateTableName,
    aws.configuration.region,
  )
  const evidence = new AwsRestoreDrillEvidenceStore(aws.configuration)
  const metrics = new AwsRestoreDrillMetricSink(
    aws.configuration.metricNamespace,
    aws.configuration.region,
  )
  const verifier = new AwsRestoreDrillVerifier(aws.configuration)
  runnerRuntime = {
    operations: aws.operations,
    orchestrator: createRestoreDrillOrchestrator({
      approvals: new UnavailableRestoreDrillApprovalStore(),
      evidence,
      executions: new UnavailableRestoreDrillExecutionStore(),
      metrics,
      state,
      verifier,
    }),
  }
  return runnerRuntime
}

/**
 * Creates or reuses the source-free cleanup composition.
 *
 * @returns Warm-invocation cleanup runtime.
 */
export function getRestoreDrillCleanupRuntime(): RestoreDrillCleanupRuntime {
  if (cleanupRuntime) return cleanupRuntime
  const authorizedApproverRoleArn = readRequiredEnvironment(
    'AUTHORIZED_APPROVER_ROLE_ARN',
  )
  const cleanupWorkflowName = readRequiredEnvironment('CLEANUP_WORKFLOW_NAME')
  const aws = createRestoreDrillAwsCleanupOperationsFromEnvironment()
  const state = new AwsRestoreDrillStateStore(
    aws.configuration.stateTableName,
    aws.configuration.region,
  )
  const evidence = new AwsRestoreDrillEvidenceStore(aws.configuration)
  const metrics = new AwsRestoreDrillMetricSink(
    aws.configuration.metricNamespace,
    aws.configuration.region,
  )
  cleanupRuntime = {
    operations: aws.operations,
    orchestrator: createRestoreDrillOrchestrator({
      approvals: new AwsRestoreDrillApprovalStore(
        aws.configuration,
        authorizedApproverRoleArn,
      ),
      evidence,
      executions: new AwsRestoreDrillCleanupExecutionStore(
        aws.configuration.region,
        aws.configuration.accountId,
        cleanupWorkflowName,
      ),
      metrics,
      state,
      verifier: new UnavailableRestoreDrillVerifier(),
    }),
  }
  return cleanupRuntime
}

/**
 * Reads one mandatory Lambda environment value without including it in errors.
 *
 * @param name - Exact environment variable name.
 * @returns Trimmed non-empty value.
 */
function readRequiredEnvironment(name: string): string {
  const value = process.env[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID')
  }
  return value.trim()
}
