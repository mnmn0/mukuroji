import {
  RestoreDrillOrchestratorFailure,
  parseRestoreDrillHandlerRequest,
  type RestoreDrillAwsActionResult,
} from '../modules/restore-drill'
import {
  getRestoreDrillCleanupRuntime,
  getRestoreDrillRunnerRuntime,
} from '../app/composition/restore-drill'

const MAX_IMMEDIATE_STEPS_PER_INVOCATION = 50
const MAX_IMMEDIATE_BATCH_MILLISECONDS = 480_000

/**
 * Advances scheduled/continued restore work or seals a task-catch failure.
 *
 * @param event - Untrusted Lambda payload.
 * @returns Stable secret-free orchestration result.
 */
export async function handler(event: unknown) {
  const request = parseRestoreDrillHandlerRequest(event)
  if (request.action === 'cleanup') {
    throw new RestoreDrillOrchestratorFailure('REQUEST_INVALID')
  }
  const runtime = getRestoreDrillRunnerRuntime()
  if (request.action === 'finalize-failure') {
    return runtime.orchestrator.finalizeFailure(
      request.drillId,
      runtime.operations,
      request.runnerExecutionArn,
    )
  }
  if (request.action === 'finalize-poll-budget-exceeded') {
    return runtime.orchestrator.finalizePollBudgetExceeded(
      request.drillId,
      runtime.operations,
      request.runnerExecutionArn,
    )
  }
  return runtime.orchestrator.advance(
    'event' in request ? request.event : { drillId: request.drillId },
    runtime.operations,
    request.runnerExecutionArn,
  )
}

/**
 * Advances one approval-gated exact cleanup invocation.
 *
 * @param event - Untrusted cleanup Lambda payload including execution identity.
 * @returns Stable secret-free cleanup result.
 */
export async function cleanupHandler(event: unknown) {
  const request = parseRestoreDrillHandlerRequest(event)
  if (request.action !== 'cleanup') {
    throw new RestoreDrillOrchestratorFailure('REQUEST_INVALID')
  }
  const runtime = getRestoreDrillCleanupRuntime()
  return runRestoreDrillImmediateBatch(() => runtime.orchestrator.cleanup(
    {
      ...(request.approvalObjectKey
        ? { approvalObjectKey: request.approvalObjectKey }
        : {}),
      cleanupExecutionArn: request.cleanupExecutionArn,
      cleanupExecutionName: request.cleanupExecutionName,
      drillId: request.drillId,
    },
    runtime.operations,
  ))
}

/**
 * Replays bounded zero-wait durable steps inside one Lambda invocation.
 *
 * @param step - One idempotent orchestrator step that always revalidates its request.
 * @returns The first terminal/external-wait result or the bounded final immediate result.
 */
export async function runRestoreDrillImmediateBatch(
  step: () => Promise<RestoreDrillAwsActionResult>,
): Promise<RestoreDrillAwsActionResult> {
  const deadline = Date.now() + MAX_IMMEDIATE_BATCH_MILLISECONDS
  let result = await step()
  for (let count = 1; count < MAX_IMMEDIATE_STEPS_PER_INVOCATION; count += 1) {
    if (
      result.status !== 'pending' ||
      result.waitSeconds !== 0 ||
      Date.now() >= deadline
    ) return result
    result = await step()
  }
  return result
}
