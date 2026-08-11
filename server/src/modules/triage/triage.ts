import { createHash } from 'node:crypto'
import type {
  CreateManualTriageEntryInput,
  TriageActionInput,
  TriageBulkActionInput,
  TriageBulkActionResult,
  TriageConfiguration,
  TriageEntry,
  TriageEntryListInput,
  TriageEntryPage,
  TriageMergeReceipt,
  TriageMutationReceipt,
  TriageWorkItemReference,
  TriageWorkItemSourcePage,
  UpdateTriageConfigurationInput,
} from '@mukuroji/contracts'
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import type { MutationAuditContext } from '../audit'

/** DynamoDB condition checks supplied by an authorization boundary. */
export type TriageAuthorizationConditionChecks = NonNullable<
  TransactWriteCommandInput['TransactItems']
>

/** Creates a canonical SHA-256 fingerprint for validated JSON-like input.
 *
 * @param value The semantic input after transport validation.
 * @returns A lowercase hexadecimal SHA-256 digest.
 */
export function createTriageInputFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalizeJson(value))).digest('hex')
}

/** Creates the bounded replay key shared by every per-target bulk action path.
 *
 * @param bulkIdempotencyKey The caller-selected key for the whole bulk request.
 * @param entryId The stable target entry identifier.
 * @returns A fixed-length key that stays within the single-action persistence limit.
 */
export function createTriageBulkTargetIdempotencyKey(
  bulkIdempotencyKey: string,
  entryId: string,
): string {
  return `bulk:${createTriageInputFingerprint({ bulkIdempotencyKey, entryId })}`
}

/** Namespaces an action audit identity by operation and target entry.
 *
 * Triage action receipts are stored below an Entry, while audit event IDs are Workspace-scoped.
 * Hashing the receipt fingerprint with the caller key prevents two Entries using the same HTTP
 * key from producing one immutable audit event ID while retaining semantic replay binding.
 *
 * @param entryId Stable target Triage Entry identifier.
 * @param idempotency Receipt identity bound to semantic input.
 * @returns A bounded audit-only idempotency namespace.
 */
export function createTriageActionAuditIdempotencyKey(
  entryId: string,
  idempotency: TriageIdempotency,
): string {
  return `triage-action:${createTriageInputFingerprint({
    operation: 'triage-action',
    entryId,
    key: idempotency.key,
    fingerprint: idempotency.fingerprint,
  })}`
}

/** Authenticated actor used by triage mutations. */
export type TriageActor = {
  /** Stable Workspace user or service identifier. */
  id: string
}

/** Replay protection supplied by an HTTP or event adapter. */
export type TriageIdempotency = {
  /** Caller-selected idempotency key scoped to the operation. */
  key: string
  /** Stable fingerprint of the validated semantic input. */
  fingerprint: string
}

/** Creates one immutable audit context bound to a target-specific mutation receipt.
 *
 * @param entryId Stable target Triage Entry used to namespace the audit event identity.
 * @param idempotency Replay protection selected for the individual Triage target.
 * @returns The API or semantic-source audit context for that exact target mutation.
 */
export type TriageAuditContextFactory = (
  entryId: string,
  idempotency: TriageIdempotency,
) => MutationAuditContext

/** Work Item resolution contributed by application composition. */
export type TriageWorkItemActionResolution = {
  /** The canonical Work Item selected or created for the action. */
  canonicalWorkItem: TriageWorkItemReference
  /** Duplicate-context preservation receipt for duplicate actions. */
  mergeReceipt?: TriageMergeReceipt
  /** Work Item, collaboration, file, or authorization transaction items to commit atomically. */
  transactItems?: NonNullable<TransactWriteCommandInput['TransactItems']>
}

/** Callback that resolves Work Item-dependent actions before the triage commit. */
export type ResolveTriageWorkItemAction = (
  workspaceId: string,
  entry: TriageEntry,
  actor: TriageActor,
  action: Extract<TriageActionInput, { action: 'accept' | 'duplicate' }>,
  now: string,
) => Promise<TriageWorkItemActionResolution>

/** Public application surface consumed by the triage HTTP adapter. */
export interface TriageClient {
  /** Lists a Team queue.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The Team queue ID.
   * @param input Validated filters and cursor.
   * @returns A bounded queue page.
   */
  listEntries(
    workspaceId: string,
    teamId: string,
    input?: TriageEntryListInput,
  ): Promise<TriageEntryPage>
  /** Strongly reads one Team entry.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The expected Team ID.
   * @param entryId The entry ID.
   * @returns The canonical entry.
   */
  getEntry(workspaceId: string, teamId: string, entryId: string): Promise<TriageEntry>
  /** Applies one replay-safe action.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The expected Team ID.
   * @param entryId The entry ID.
   * @param actor The authenticated actor.
   * @param action The validated action.
   * @param idempotency Replay protection bound to the action.
   * @param auditContext Immutable request and source context for the action audit event.
   * @param configurationRevision Optional Team configuration revision to fence with the action.
   * @param authorizationConditionChecks Caller authorization conditions joined to the action transaction.
   * @returns The mutation receipt.
   */
  applyAction(
    workspaceId: string,
    teamId: string,
    entryId: string,
    actor: TriageActor,
    action: TriageActionInput,
    idempotency: TriageIdempotency,
    auditContext: MutationAuditContext,
    configurationRevision?: number,
    authorizationConditionChecks?: TriageAuthorizationConditionChecks,
  ): Promise<TriageMutationReceipt>
  /** Looks up an existing action receipt before externally composed Work Item creation.
   *
   * @param workspaceId The owning Workspace ID.
   * @param entryId The target triage entry ID.
   * @param idempotency Replay protection bound to the semantic action.
   * @returns The current permission-safe entry receipt, or undefined before the first write.
   */
  getActionReceipt(
    workspaceId: string,
    entryId: string,
    idempotency: TriageIdempotency,
  ): Promise<TriageMutationReceipt | undefined>
  /** Applies a bounded bulk operation with independent conflicts.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The expected Team ID.
   * @param actor The authenticated actor.
   * @param input The validated bulk input.
   * @param idempotencyKey The bulk request idempotency namespace.
   * @param createAuditContext Factory preserving the bulk request while binding each target key.
   * @returns One result per target.
   */
  applyBulkAction(
    workspaceId: string,
    teamId: string,
    actor: TriageActor,
    input: TriageBulkActionInput,
    idempotencyKey: string,
    createAuditContext: TriageAuditContextFactory,
  ): Promise<TriageBulkActionResult>
  /** Reads Team triage settings.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The configured Team ID.
   * @returns The current settings or safe defaults.
   */
  getConfiguration(workspaceId: string, teamId: string): Promise<TriageConfiguration>
  /** Looks up an existing settings replacement receipt before live reference validation.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The configured Team ID.
   * @param idempotency Replay protection bound to the settings replacement.
   * @returns The exact committed configuration, or undefined before the first write.
   */
  getConfigurationUpdateReceipt(
    workspaceId: string,
    teamId: string,
    idempotency: TriageIdempotency,
  ): Promise<TriageConfiguration | undefined>
  /** Replaces Team triage settings conditionally.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The configured Team ID.
   * @param actor The authenticated actor.
   * @param input The validated replacement.
   * @param idempotency Replay protection bound to the settings replacement.
   * @param authorizationConditionChecks Caller authorization conditions joined to the settings transaction.
   * @returns The updated configuration.
   */
  updateConfiguration(
    workspaceId: string,
    teamId: string,
    actor: TriageActor,
    input: UpdateTriageConfigurationInput,
    idempotency: TriageIdempotency,
    authorizationConditionChecks?: TriageAuthorizationConditionChecks,
  ): Promise<TriageConfiguration>
  /** Creates a replay-safe internal manual handoff.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The target Team ID.
   * @param actor The authenticated actor.
   * @param input The validated handoff.
   * @param idempotency Replay protection bound to the handoff.
   * @param authorizationConditionChecks Caller authorization conditions joined to the handoff transaction.
   * @returns The created or replayed entry receipt.
   */
  createManualHandoff(
    workspaceId: string,
    teamId: string,
    actor: TriageActor,
    input: CreateManualTriageEntryInput,
    idempotency: TriageIdempotency,
    authorizationConditionChecks?: TriageAuthorizationConditionChecks,
  ): Promise<TriageMutationReceipt>
  /** Lists source entries attached to a Work Item.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The canonical Work Item Team ID.
   * @param workItemId The canonical Work Item ID.
   * @param limit The bounded page size.
   * @param cursor The opaque next-page cursor.
   * @param visibleProjectIds Optional Project visibility scope used to fill pages safely.
   * @returns The reverse source trace page.
   */
  listWorkItemSources(
    workspaceId: string,
    teamId: string,
    workItemId: string,
    limit?: number,
    cursor?: string,
    visibleProjectIds?: readonly string[],
  ): Promise<TriageWorkItemSourcePage>
}

/** Recursively sorts object keys for a stable semantic fingerprint.
 *
 * @param value The JSON-like value to normalize.
 * @returns A deterministically ordered JSON-like value.
 */
function canonicalizeJson(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) return value
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (isRecord(value)) {
    const normalized: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const entry = value[key]
      if (entry !== undefined) normalized[key] = canonicalizeJson(entry)
    }
    return normalized
  }
  throw new TypeError('Triage fingerprint input must be JSON-compatible.')
}

/** Checks whether an untrusted value is a non-array object.
 *
 * @param value The value to inspect.
 * @returns Whether object fields may be safely enumerated.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
