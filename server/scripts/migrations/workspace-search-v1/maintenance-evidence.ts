import { createHash } from 'node:crypto'

const canonicalTimestampPattern =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u
const maintenanceEvidenceLocatorPattern =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
const minimumDrainMilliseconds = 15 * 60 * 1_000

/**
 * Runtime-control surface that can mutate Workspace Search source or target state.
 */
export type MaintenanceRuntimeControlSurface =
  | 'analytics-schedule'
  | 'api'
  | 'audit-projection'
  | 'automation-event'
  | 'automation-schedule'
  | 'connector-poll'
  | 'connector-sync'
  | 'enterprise-identity-maintenance'
  | 'enterprise-scim-group-job'
  | 'notification-schedule'
  | 'realtime'
  | 'request-intake-email'
  | 'webhook-delivery'
  | 'work-item-import'

/**
 * Complete ordered set of runtime-control surfaces required by maintenance evidence.
 */
export const maintenanceRuntimeControlSurfaces:
readonly MaintenanceRuntimeControlSurface[] = [
  'analytics-schedule',
  'api',
  'audit-projection',
  'automation-event',
  'automation-schedule',
  'connector-poll',
  'connector-sync',
  'enterprise-identity-maintenance',
  'enterprise-scim-group-job',
  'notification-schedule',
  'realtime',
  'request-intake-email',
  'webhook-delivery',
  'work-item-import',
]

/**
 * Current disabled observation for one runtime-control surface.
 */
export type MaintenanceRuntimeSurfaceEvidence = {
  /** Stable application surface observed by runtime-control telemetry. */
  readonly surface: MaintenanceRuntimeControlSurface
  /** Effective fail-closed mode observed for the surface. */
  readonly mode: 'disabled'
  /** Freshness state observed for the surface. */
  readonly status: 'current'
  /** Positive safe runtime-control revision shared by the evidence set. */
  readonly revision: number
  /** Canonical UTC time at which the surface observation was recorded. */
  readonly observedAt: string
}

/**
 * Version-one evidence required before the migration may mutate production.
 */
export type WorkspaceSearchMaintenanceEvidence = {
  /** Evidence contract version. */
  readonly schemaVersion: 1
  /** Secret-free reference to the reviewed external maintenance record. */
  readonly locator: string
  /** Globally observed runtime-control mode. */
  readonly runtimeMode: 'disabled'
  /** Positive safe runtime-control revision applied to every surface. */
  readonly runtimeRevision: number
  /** Canonical UTC beginning of the zero-mutation drain observation. */
  readonly drainStartedAt: string
  /** Canonical UTC end of the zero-mutation drain observation. */
  readonly drainCompletedAt: string
  /** Writer mutations observed during the complete drain interval. */
  readonly observedWriterMutations: 0
  /** Current disabled observations for all fourteen mutating surfaces. */
  readonly surfaces: readonly MaintenanceRuntimeSurfaceEvidence[]
}

/**
 * Validated evidence paired with the digest of its exact source bytes.
 */
export type ParsedWorkspaceSearchMaintenanceEvidence = {
  /** Fully validated version-one maintenance evidence. */
  readonly evidence: WorkspaceSearchMaintenanceEvidence
  /** Lowercase SHA-256 digest of the exact input file bytes. */
  readonly fileSha256: string
}

/**
 * Stable raw-value-free failure raised for invalid maintenance evidence.
 */
export class MaintenanceEvidenceError extends Error {
  /** Secret-free machine-readable failure code. */
  readonly code = 'INVALID_MAINTENANCE_EVIDENCE'

  /**
   * Creates a raw-value-free maintenance-evidence failure.
   */
  constructor() {
    super('INVALID_MAINTENANCE_EVIDENCE')
    this.name = 'MaintenanceEvidenceError'
  }
}

/**
 * Computes the digest used to bind a run to exact maintenance evidence bytes.
 *
 * @param bytes - Exact bytes read from the operator-supplied evidence file.
 * @returns Lowercase SHA-256 digest.
 */
export function createMaintenanceEvidenceFileDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Parses strict version-one maintenance evidence and digests its exact file bytes.
 *
 * The parser accepts only a current disabled observation for every required
 * runtime surface, a zero-mutation drain of at least fifteen minutes, canonical
 * UTC timestamps, and a constrained secret-free external locator.
 *
 * @param bytes - Exact UTF-8 JSON file bytes.
 * @returns Validated evidence and the SHA-256 digest of the original bytes.
 * @throws {MaintenanceEvidenceError} When any byte or field is invalid.
 */
export function parseMaintenanceEvidence(
  bytes: Uint8Array,
): ParsedWorkspaceSearchMaintenanceEvidence {
  const fileSha256 = createMaintenanceEvidenceFileDigest(bytes)
  const document = parseJsonObject(bytes)

  requireExactKeys(document, [
    'drainCompletedAt',
    'drainStartedAt',
    'locator',
    'observedWriterMutations',
    'runtimeMode',
    'runtimeRevision',
    'schemaVersion',
    'surfaces',
  ])

  if (document.schemaVersion !== 1) return failEvidence()
  if (document.runtimeMode !== 'disabled') return failEvidence()
  if (document.observedWriterMutations !== 0) return failEvidence()

  const locator = requireMaintenanceEvidenceLocator(document.locator)
  const runtimeRevision = requirePositiveSafeInteger(document.runtimeRevision)
  const drainStartedAt = requireCanonicalTimestamp(document.drainStartedAt)
  const drainCompletedAt = requireCanonicalTimestamp(document.drainCompletedAt)
  const drainStartedMilliseconds = Date.parse(drainStartedAt)
  const drainCompletedMilliseconds = Date.parse(drainCompletedAt)

  if (
    drainCompletedMilliseconds - drainStartedMilliseconds
    < minimumDrainMilliseconds
  ) {
    return failEvidence()
  }

  const surfaces = parseSurfaceEvidence(
    document.surfaces,
    runtimeRevision,
    drainCompletedMilliseconds,
  )

  return {
    evidence: {
      schemaVersion: 1,
      locator,
      runtimeMode: 'disabled',
      runtimeRevision,
      drainStartedAt,
      drainCompletedAt,
      observedWriterMutations: 0,
      surfaces,
    },
    fileSha256,
  }
}

/**
 * Parses UTF-8 JSON bytes into a plain object.
 *
 * @param bytes - Untrusted evidence bytes.
 * @returns Parsed plain object.
 */
function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return failEvidence()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return failEvidence()
  }

  return requireRecord(parsed)
}

/**
 * Parses and validates the complete set of surface observations.
 *
 * @param value - Untrusted surface observation array.
 * @param runtimeRevision - Required global runtime-control revision.
 * @param drainCompletedMilliseconds - End of the completed drain interval.
 * @returns Validated observations in the canonical surface order.
 */
function parseSurfaceEvidence(
  value: unknown,
  runtimeRevision: number,
  drainCompletedMilliseconds: number,
): readonly MaintenanceRuntimeSurfaceEvidence[] {
  if (!Array.isArray(value)) return failEvidence()
  if (value.length !== maintenanceRuntimeControlSurfaces.length) {
    return failEvidence()
  }

  const observations = new Map<
  MaintenanceRuntimeControlSurface,
  MaintenanceRuntimeSurfaceEvidence
  >()

  for (const untrustedObservation of value) {
    const record = requireRecord(untrustedObservation)
    requireExactKeys(record, [
      'mode',
      'observedAt',
      'revision',
      'status',
      'surface',
    ])

    const surface = requireSurface(record.surface)
    if (observations.has(surface)) return failEvidence()
    if (record.mode !== 'disabled') return failEvidence()
    if (record.status !== 'current') return failEvidence()
    if (record.revision !== runtimeRevision) return failEvidence()

    const observedAt = requireCanonicalTimestamp(record.observedAt)
    if (Date.parse(observedAt) < drainCompletedMilliseconds) {
      return failEvidence()
    }

    observations.set(surface, {
      surface,
      mode: 'disabled',
      status: 'current',
      revision: runtimeRevision,
      observedAt,
    })
  }

  const ordered: MaintenanceRuntimeSurfaceEvidence[] = []
  for (const surface of maintenanceRuntimeControlSurfaces) {
    const observation = observations.get(surface)
    if (!observation) return failEvidence()
    ordered.push(observation)
  }
  return ordered
}

/**
 * Requires an exact canonical UTC timestamp.
 *
 * @param value - Untrusted timestamp.
 * @returns Canonical timestamp.
 */
function requireCanonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') return failEvidence()
  if (!canonicalTimestampPattern.test(value)) return failEvidence()

  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return failEvidence()
  if (new Date(milliseconds).toISOString() !== value) return failEvidence()
  return value
}

/**
 * Requires a constrained secret-free external evidence locator.
 *
 * @param value - Untrusted locator.
 * @returns Validated locator.
 */
function requireMaintenanceEvidenceLocator(value: unknown): string {
  if (typeof value !== 'string') return failEvidence()
  if (!maintenanceEvidenceLocatorPattern.test(value)) return failEvidence()
  return value
}

/**
 * Requires a positive safe integer.
 *
 * @param value - Untrusted numeric value.
 * @returns Validated integer.
 */
function requirePositiveSafeInteger(value: unknown): number {
  if (typeof value !== 'number') return failEvidence()
  if (!Number.isSafeInteger(value) || value < 1) return failEvidence()
  return value
}

/**
 * Narrows a surface name without a type assertion.
 *
 * @param value - Untrusted surface name.
 * @returns Validated maintenance surface.
 */
function requireSurface(value: unknown): MaintenanceRuntimeControlSurface {
  if (value === 'analytics-schedule') return value
  if (value === 'api') return value
  if (value === 'audit-projection') return value
  if (value === 'automation-event') return value
  if (value === 'automation-schedule') return value
  if (value === 'connector-poll') return value
  if (value === 'connector-sync') return value
  if (value === 'enterprise-identity-maintenance') return value
  if (value === 'enterprise-scim-group-job') return value
  if (value === 'notification-schedule') return value
  if (value === 'realtime') return value
  if (value === 'request-intake-email') return value
  if (value === 'webhook-delivery') return value
  if (value === 'work-item-import') return value
  return failEvidence()
}

/**
 * Requires a plain record suitable for strict field validation.
 *
 * @param value - Untrusted value.
 * @returns Plain record.
 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return failEvidence()
  return value
}

/**
 * Checks whether a value is a non-array object.
 *
 * @param value - Value to inspect.
 * @returns Whether the value is a plain validation record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Requires exactly the expected object fields.
 *
 * @param record - Parsed object.
 * @param expected - Complete expected field list.
 */
function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(record).sort()
  const sortedExpected = [...expected].sort()
  if (actual.length !== sortedExpected.length) return failEvidence()

  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== sortedExpected[index]) return failEvidence()
  }
}

/**
 * Raises the stable raw-value-free validation failure.
 *
 * @returns Never returns.
 */
function failEvidence(): never {
  throw new MaintenanceEvidenceError()
}
