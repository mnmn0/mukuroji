/**
 * Builds and writes the Workspace audit events that record a runtime-control switch.
 *
 * `scripts/runtime-control.ts` records one event before it changes AppConfig and one after the
 * change finishes or fails, so the Workspace audit log (`/api/audit/events`) shows who switched the
 * application on, off, or to read-only and when. The events go through the same schema builder as
 * the API's audit events and are written with the operator's own AWS credentials.
 */

import {
  type AuditValue,
  type AuditEventV1,
  calculateAuditExpiresAt,
  createAuditEvent,
  createMutationAuditContext,
} from '../server/src/modules/audit/audit'

/** Runtime-control mode as the hosted configuration schema stores it. */
type AuditedRuntimeControlMode = 'enabled' | 'disabled' | 'read-only'

/** Step of a switch that one audit event records. */
export type RuntimeControlAuditPhase = 'started' | 'completed' | 'failed'

/** Short, secret-free reason stored on a `failed` event. */
export type RuntimeControlFailureReason =
  | 'deployment-rolled-back'
  | 'deployment-timeout'
  | 'readiness-timeout'
  | 'error'

/** Event type for each phase. */
export const RUNTIME_CONTROL_AUDIT_EVENT_TYPES: Readonly<Record<RuntimeControlAuditPhase, string>> = Object.freeze({
  started: 'runtime-control.change-started',
  completed: 'runtime-control.change-completed',
  failed: 'runtime-control.change-failed',
})

/** Route-like label stored as the event source, so the audit log names the operator tool. */
const runtimeControlAuditRoute = 'scripts/runtime-control.ts'

/**
 * Where the audit events go and how long they are kept.
 */
export interface RuntimeControlAuditTarget {
  /** Physical name of the stack's `AuditEventsTable` (stack output `AuditEventsTableName`). */
  readonly tableName: string
  /** Canonical Workspace ID of the deployment (stack output `WorkspaceDirectoryId`). */
  readonly workspaceId: string
  /** Stack parameter `AuditRetentionDays`; tenant retention still applies through the projection. */
  readonly retentionDays: number
}

/**
 * GitHub Actions run that started the switch, when the script runs there.
 */
export interface RuntimeControlGitHubRun {
  /** `GITHUB_REPOSITORY`. */
  readonly repository: string
  /** `GITHUB_RUN_ID`. */
  readonly runId: string
  /** `GITHUB_RUN_ATTEMPT`. */
  readonly runAttempt: string
  /** `GITHUB_TRIGGERING_ACTOR`, or `GITHUB_ACTOR` when that is not set. */
  readonly actor: string
  /** Link to the run. */
  readonly runUrl: string
}

/**
 * Facts about one switch that every event of it carries.
 */
export interface RuntimeControlAuditChange {
  /** Random ID of this run of the script; ties its events together and keeps reruns distinct. */
  readonly switchId: string
  /** AppConfig application ID of the control. */
  readonly applicationId: string
  /** AppConfig configuration profile ID of the control. */
  readonly configurationProfileId: string
  /** Mode being deployed. */
  readonly mode: AuditedRuntimeControlMode
  /** Mode of the latest stored hosted version before the switch, when it was readable. */
  readonly previousMode: AuditedRuntimeControlMode | undefined
  /** Revision written into the new document. */
  readonly revision: number
  /** Whether the switch skips the canary strategy. */
  readonly allAtOnce: boolean
  /** STS caller ARN of the credentials that make the change. */
  readonly callerArn: string
  /** GitHub Actions run, when there is one. */
  readonly gitHubRun: RuntimeControlGitHubRun | undefined
}

/**
 * Phase-specific facts of one event.
 */
export interface RuntimeControlAuditStep {
  /** Step that the event records. */
  readonly phase: RuntimeControlAuditPhase
  /** Time of the step. */
  readonly occurredAt: Date
  /** Hosted configuration version, once created. */
  readonly versionNumber?: number
  /** AppConfig deployment number, once started. */
  readonly deploymentNumber?: number
  /** Why the switch failed; only for `failed`. */
  readonly failureReason?: RuntimeControlFailureReason
}

/** DynamoDB attribute value in the JSON shape that `aws dynamodb put-item --item` reads. */
type DynamoDbAttributeValue =
  | { readonly NULL: true }
  | { readonly BOOL: boolean }
  | { readonly N: string }
  | { readonly S: string }
  | { readonly L: readonly DynamoDbAttributeValue[] }
  | { readonly M: Readonly<Record<string, DynamoDbAttributeValue>> }

/**
 * Reads the GitHub Actions run from the environment.
 *
 * @param environment - Process environment.
 * @returns The run, or `undefined` outside GitHub Actions or when its identifiers are missing.
 */
export function readGitHubRun(environment: Readonly<Record<string, string | undefined>>): RuntimeControlGitHubRun | undefined {
  if (environment.GITHUB_ACTIONS !== 'true') return undefined
  const repository = environment.GITHUB_REPOSITORY ?? ''
  const runId = environment.GITHUB_RUN_ID ?? ''
  const runAttempt = environment.GITHUB_RUN_ATTEMPT ?? ''
  const actor = environment.GITHUB_TRIGGERING_ACTOR || environment.GITHUB_ACTOR || ''
  const serverUrl = (environment.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '')
  if (!repository || !runId || !runAttempt || !actor) return undefined
  return {
    repository,
    runId,
    runAttempt,
    actor,
    runUrl: `${serverUrl}/${repository}/actions/runs/${runId}/attempts/${runAttempt}`,
  }
}

/**
 * Builds the schema-v1 audit event for one step of a switch.
 *
 * The idempotency key binds the run's switch ID and the phase, so a retried write of the same step
 * produces the same event ID and the conditional put refuses a duplicate, while a rerun after a
 * failure (which may reuse the revision) gets new events.
 *
 * @param target - Audit table, Workspace, and retention.
 * @param change - Facts shared by every step of the switch.
 * @param step - The step to record.
 * @returns The audit event to store.
 */
export function buildRuntimeControlAuditEvent(
  target: RuntimeControlAuditTarget,
  change: RuntimeControlAuditChange,
  step: RuntimeControlAuditStep,
): AuditEventV1 {
  const occurredAt = step.occurredAt.toISOString()
  const controlId = `appconfig:${change.applicationId}:${change.configurationProfileId}`
  const context = createMutationAuditContext({
    workspaceId: target.workspaceId,
    actor: {
      id: change.callerArn,
      kind: 'service',
      displayName: change.gitHubRun ? `GitHub Actions (${change.gitHubRun.actor})` : 'AWS operator',
    },
    idempotencyKey: `runtime-control-v1:${change.switchId}:${step.phase}`,
    occurredAt,
    // Every step of one switch shares the correlation ID.
    correlationId: `runtime-control:${change.switchId}`,
    request: {
      method: 'OPERATOR',
      path: runtimeControlAuditRoute,
      body: { mode: change.mode, revision: change.revision, allAtOnce: change.allAtOnce, phase: step.phase },
    },
    source: { kind: 'system', method: 'OPERATOR', route: runtimeControlAuditRoute },
  })
  const runtimeControl: Record<string, AuditValue> = {
    switchId: change.switchId,
    mode: change.mode,
    revision: change.revision,
    strategy: change.allAtOnce ? 'all-at-once' : 'canary',
    ...(change.previousMode ? { previousMode: change.previousMode } : {}),
    ...(step.versionNumber === undefined ? {} : { hostedVersionNumber: step.versionNumber }),
    ...(step.deploymentNumber === undefined ? {} : { deploymentNumber: step.deploymentNumber }),
    ...(step.failureReason ? { failureReason: step.failureReason } : {}),
    ...(change.gitHubRun
      ? {
          gitHub: {
            repository: change.gitHubRun.repository,
            runId: change.gitHubRun.runId,
            runAttempt: change.gitHubRun.runAttempt,
            actor: change.gitHubRun.actor,
            runUrl: change.gitHubRun.runUrl,
          },
        }
      : {}),
  }
  return createAuditEvent({
    context,
    eventType: RUNTIME_CONTROL_AUDIT_EVENT_TYPES[step.phase],
    entity: { type: 'runtime-control', id: controlId },
    action: step.phase,
    changes: [{
      field: 'mode',
      ...(change.previousMode ? { before: change.previousMode } : {}),
      after: change.mode,
    }],
    summary: summarize(change, step),
    expiresAt: calculateAuditExpiresAt(occurredAt, target.retentionDays),
    // The audit view publishes only allowlisted metadata keys; `runtimeControl` is one of them.
    metadata: { runtimeControl },
    // Operator events are records only; Automation and notifications must not act on them.
    outboxStatus: 'suppressed',
  })
}

/**
 * Writes the activity summary of one step.
 *
 * @param change - Facts shared by every step.
 * @param step - The step.
 * @returns A short English summary.
 */
function summarize(change: RuntimeControlAuditChange, step: RuntimeControlAuditStep): string {
  const via = change.allAtOnce ? ' all at once' : ''
  if (step.phase === 'started') return `Started switching runtime control to ${change.mode}${via}.`
  if (step.phase === 'completed') return `Runtime control is ${change.mode}.`
  return `Switching runtime control to ${change.mode} failed (${step.failureReason ?? 'error'}).`
}

/**
 * Converts an audit event into the DynamoDB JSON that `aws dynamodb put-item --item` reads.
 *
 * @param event - The audit event.
 * @returns The item as DynamoDB JSON text.
 */
export function toDynamoDbItemJson(event: AuditEventV1): string {
  const item: Record<string, DynamoDbAttributeValue> = {}
  for (const [key, value] of Object.entries(event)) {
    if (value !== undefined) item[key] = toAttributeValue(value)
  }
  return JSON.stringify(item)
}

/**
 * Converts one JSON value into a DynamoDB attribute value.
 *
 * @param value - JSON value from the audit event.
 * @returns The attribute value.
 * @throws TypeError for a value that JSON cannot carry.
 */
function toAttributeValue(value: unknown): DynamoDbAttributeValue {
  if (value === null) return { NULL: true }
  if (typeof value === 'boolean') return { BOOL: value }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Audit item numbers must be finite.')
    return { N: String(value) }
  }
  if (typeof value === 'string') return { S: value }
  if (Array.isArray(value)) return { L: value.map(toAttributeValue) }
  if (typeof value === 'object') {
    const map: Record<string, DynamoDbAttributeValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) map[key] = toAttributeValue(entry)
    }
    return { M: map }
  }
  throw new TypeError(`Audit items cannot hold a ${typeof value}.`)
}

/**
 * Builds the `aws dynamodb put-item` arguments that store an event once.
 *
 * @param tableName - Audit table name.
 * @param region - AWS region.
 * @param itemPath - File that holds the item's DynamoDB JSON.
 * @returns Arguments after `aws`.
 */
export function buildAuditPutItemArguments(tableName: string, region: string, itemPath: string): string[] {
  return [
    'dynamodb', 'put-item', '--region', region, '--table-name', tableName,
    '--item', `file://${itemPath}`,
    '--condition-expression', 'attribute_not_exists(#directoryId) AND attribute_not_exists(#eventId)',
    '--expression-attribute-names', '{"#directoryId":"directoryId","#eventId":"eventId"}',
  ]
}
