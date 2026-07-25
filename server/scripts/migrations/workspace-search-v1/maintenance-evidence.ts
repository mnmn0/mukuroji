import { createHash } from 'node:crypto'
import { MINIMUM_MAINTENANCE_DRAIN_SECONDS } from './migration-contract'

const canonicalTimestampPattern =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u
const maintenanceEvidenceLocatorPattern =
  /^change:[A-Z][A-Z0-9]{1,15}(?:-[A-Z0-9]{1,16}){0,3}$/u
const canonicalJsonIntegerPattern = /^(?:0|-?[1-9][0-9]*)$/u
const jsonNumberTokenPattern =
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u
const minimumDrainMilliseconds = MINIMUM_MAINTENANCE_DRAIN_SECONDS * 1_000

/** Maximum age of drain completion and every surface observation at mutation time. */
export const MAINTENANCE_EVIDENCE_MAX_AGE_SECONDS = 5 * 60

/** Maximum accepted future timestamp drift relative to the operator clock. */
export const MAINTENANCE_EVIDENCE_CLOCK_SKEW_SECONDS = 30

const maximumEvidenceAgeMilliseconds =
  MAINTENANCE_EVIDENCE_MAX_AGE_SECONDS * 1_000
const maximumClockSkewMilliseconds =
  MAINTENANCE_EVIDENCE_CLOCK_SKEW_SECONDS * 1_000

/**
 * Complete ordered set of runtime-control surfaces required by maintenance evidence.
 */
const requiredMaintenanceRuntimeControlSurfaces =
  defineMaintenanceRuntimeControlSurfaces(
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
  )

/** Frozen runtime-control surface source of truth used by evidence producers. */
export const maintenanceRuntimeControlSurfaces =
  requiredMaintenanceRuntimeControlSurfaces

/**
 * Runtime-control surface that can mutate Workspace Search source or target state.
 */
export type MaintenanceRuntimeControlSurface =
  typeof maintenanceRuntimeControlSurfaces[number]

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

/** Trusted invocation context used to reject stale or future maintenance evidence. */
export type MaintenanceEvidenceValidationContext = {
  /** Trusted current time measured immediately before a mutating command. */
  readonly now: Date
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
 * UTC timestamps, fresh observations relative to a trusted invocation clock,
 * and a constrained secret-free external locator.
 *
 * @param bytes - Exact UTF-8 JSON file bytes.
 * @param context - Trusted current time for freshness and clock-skew checks.
 * @returns Validated evidence and the SHA-256 digest of the original bytes.
 * @throws {MaintenanceEvidenceError} When any byte or field is invalid.
 */
export function parseMaintenanceEvidence(
  bytes: Uint8Array,
  context: MaintenanceEvidenceValidationContext,
): ParsedWorkspaceSearchMaintenanceEvidence {
  const fileSha256 = createMaintenanceEvidenceFileDigest(bytes)
  const document = parseJsonObject(bytes)
  const nowMilliseconds = readTrustedNow(context.now)

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
    || drainCompletedMilliseconds > nowMilliseconds + maximumClockSkewMilliseconds
    || nowMilliseconds - drainCompletedMilliseconds
      > maximumEvidenceAgeMilliseconds
  ) {
    return failEvidence()
  }

  const surfaces = parseSurfaceEvidence(
    document.surfaces,
    runtimeRevision,
    drainCompletedMilliseconds,
    nowMilliseconds,
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
    validateStrictEvidenceJson(text)
    parsed = JSON.parse(text)
  } catch {
    return failEvidence()
  }

  return requireRecord(parsed)
}

/**
 * Validates JSON structure before native parsing can collapse duplicate keys or numbers.
 *
 * Maintenance evidence contains only safe integers, so every numeric token must
 * use its canonical integer spelling.
 *
 * @param text - Exact decoded JSON text.
 */
function validateStrictEvidenceJson(text: string): void {
  const end = parseStrictJsonValue(text, skipJsonWhitespace(text, 0), 0)
  if (skipJsonWhitespace(text, end) !== text.length) return failEvidence()
}

/**
 * Parses one strict JSON value for duplicate-key and number-token validation.
 *
 * @param text - Complete JSON text.
 * @param start - Index of the value's first non-whitespace character.
 * @param depth - Current nesting depth.
 * @returns Index immediately after the value.
 */
function parseStrictJsonValue(
  text: string,
  start: number,
  depth: number,
): number {
  if (depth > 64) return failEvidence()
  const character = text[start]
  if (character === '{') return parseStrictJsonObject(text, start, depth + 1)
  if (character === '[') return parseStrictJsonArray(text, start, depth + 1)
  if (character === '"') return parseStrictJsonString(text, start)[1]
  if (text.startsWith('true', start)) return start + 4
  if (text.startsWith('false', start)) return start + 5
  if (text.startsWith('null', start)) return start + 4
  return parseStrictJsonNumber(text, start)
}

/**
 * Parses one JSON object while rejecting decoded duplicate property names.
 *
 * @param text - Complete JSON text.
 * @param start - Index of the opening brace.
 * @param depth - Child value nesting depth.
 * @returns Index immediately after the closing brace.
 */
function parseStrictJsonObject(
  text: string,
  start: number,
  depth: number,
): number {
  const keys = new Set<string>()
  let index = skipJsonWhitespace(text, start + 1)
  if (text[index] === '}') return index + 1

  while (index < text.length) {
    if (text[index] !== '"') return failEvidence()
    const [key, afterKey] = parseStrictJsonString(text, index)
    if (keys.has(key)) return failEvidence()
    keys.add(key)

    index = skipJsonWhitespace(text, afterKey)
    if (text[index] !== ':') return failEvidence()
    index = skipJsonWhitespace(text, index + 1)
    index = parseStrictJsonValue(text, index, depth)
    index = skipJsonWhitespace(text, index)
    if (text[index] === '}') return index + 1
    if (text[index] !== ',') return failEvidence()
    index = skipJsonWhitespace(text, index + 1)
  }
  return failEvidence()
}

/**
 * Parses one JSON array and validates every nested value.
 *
 * @param text - Complete JSON text.
 * @param start - Index of the opening bracket.
 * @param depth - Child value nesting depth.
 * @returns Index immediately after the closing bracket.
 */
function parseStrictJsonArray(
  text: string,
  start: number,
  depth: number,
): number {
  let index = skipJsonWhitespace(text, start + 1)
  if (text[index] === ']') return index + 1

  while (index < text.length) {
    index = parseStrictJsonValue(text, index, depth)
    index = skipJsonWhitespace(text, index)
    if (text[index] === ']') return index + 1
    if (text[index] !== ',') return failEvidence()
    index = skipJsonWhitespace(text, index + 1)
  }
  return failEvidence()
}

/**
 * Parses and decodes one JSON string token.
 *
 * @param text - Complete JSON text.
 * @param start - Index of the opening quote.
 * @returns Decoded string and index immediately after the closing quote.
 */
function parseStrictJsonString(
  text: string,
  start: number,
): readonly [string, number] {
  let index = start + 1
  while (index < text.length) {
    const character = text[index]
    if (character === '"') {
      const token = text.slice(start, index + 1)
      const decoded: unknown = JSON.parse(token)
      if (typeof decoded !== 'string') return failEvidence()
      return [decoded, index + 1]
    }
    if (!character || character.charCodeAt(0) < 0x20) return failEvidence()
    if (character !== '\\') {
      index += 1
      continue
    }

    const escape = text[index + 1]
    if (escape === 'u') {
      if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(index + 2, index + 6))) {
        return failEvidence()
      }
      index += 6
      continue
    }
    if (!escape || !'"\\/bfnrt'.includes(escape)) return failEvidence()
    index += 2
  }
  return failEvidence()
}

/**
 * Parses one JSON number and requires a canonical safe-integer token.
 *
 * @param text - Complete JSON text.
 * @param start - Index of the number token.
 * @returns Index immediately after the number.
 */
function parseStrictJsonNumber(text: string, start: number): number {
  const token = jsonNumberTokenPattern.exec(text.slice(start))?.[0]
  if (!token || !canonicalJsonIntegerPattern.test(token)) {
    return failEvidence()
  }
  const value = Number(token)
  if (!Number.isSafeInteger(value)) return failEvidence()
  return start + token.length
}

/**
 * Skips JSON's four permitted whitespace characters.
 *
 * @param text - Complete JSON text.
 * @param start - Initial index.
 * @returns First index that is not JSON whitespace.
 */
function skipJsonWhitespace(text: string, start: number): number {
  let index = start
  while (
    text[index] === ' ' ||
    text[index] === '\t' ||
    text[index] === '\r' ||
    text[index] === '\n'
  ) {
    index += 1
  }
  return index
}

/**
 * Parses and validates the complete set of surface observations.
 *
 * @param value - Untrusted surface observation array.
 * @param runtimeRevision - Required global runtime-control revision.
 * @param drainCompletedMilliseconds - End of the completed drain interval.
 * @param nowMilliseconds - Trusted invocation time.
 * @returns Validated observations in the canonical surface order.
 */
function parseSurfaceEvidence(
  value: unknown,
  runtimeRevision: number,
  drainCompletedMilliseconds: number,
  nowMilliseconds: number,
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
    const observedMilliseconds = Date.parse(observedAt)
    if (
      observedMilliseconds < drainCompletedMilliseconds
      || observedMilliseconds > nowMilliseconds + maximumClockSkewMilliseconds
      || nowMilliseconds - observedMilliseconds
        > maximumEvidenceAgeMilliseconds
    ) {
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
 * Reads a valid trusted clock value supplied by the invoking command.
 *
 * @param value - Trusted current Date.
 * @returns Finite epoch milliseconds.
 */
function readTrustedNow(value: Date): number {
  if (!(value instanceof Date)) return failEvidence()
  const milliseconds = value.getTime()
  if (!Number.isFinite(milliseconds)) return failEvidence()
  return milliseconds
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
 * Requires a structured external change-record identifier.
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
  for (const surface of maintenanceRuntimeControlSurfaces) {
    if (value === surface) return surface
  }
  return failEvidence()
}

/**
 * Preserves the exact literal tuple used as the maintenance-surface source of truth.
 *
 * @param surfaces - Ordered runtime-control surface names.
 * @returns The same ordered literal tuple.
 */
function defineMaintenanceRuntimeControlSurfaces<
  const Surfaces extends readonly string[],
>(...surfaces: Surfaces): Readonly<Surfaces> {
  return Object.freeze(surfaces)
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
