import {
  AGENT_RUN_ARTIFACT_LABEL_MAX_LENGTH,
  AGENT_RUN_ARTIFACT_TYPES,
  AGENT_RUN_ARTIFACT_URL_MAX_LENGTH,
  AGENT_RUN_REPORT_KINDS,
  AGENT_RUN_REPORT_MAX_ITEMS,
  AGENT_RUN_REPORT_MESSAGE_MAX_LENGTH,
  AGENT_RUN_SCHEMA_VERSION,
  AGENT_RUN_VERIFICATION_STATUSES,
  AGENT_RUN_VERIFICATION_TEXT_MAX_LENGTH,
  type AgentRunArtifact,
  type AgentRunReport,
  type AgentRunReportKind,
  type AgentRunVerification,
} from '@mukuroji/contracts'
import { hashAgentInstanceId, readAgentInstanceId } from './agent-run'
import { AgentRunError } from './agent-run-error'

/** Validated structured report request, with the instance ID already hashed. */
export type ValidatedAgentRunReport = {
  /** Hash of the reporting instance ID. */
  instanceIdHash: string
  /** Kind of report. */
  kind: AgentRunReportKind
  /** Message with normalized line endings and no surrounding whitespace. */
  message: string
  /** Verification results. */
  verifications: AgentRunVerification[]
  /** Artifact links. */
  artifacts: AgentRunArtifact[]
  /** Number of changed files. */
  changedFileCount?: number
}

/** Persisted structured report of one run. */
export type StoredAgentRunReport = AgentRunReport & {
  /** Workspace that owns the report. */
  directoryId: string
  /** Member the report is attributed to. */
  createdBy: string
}

/**
 * Checks that a value is a record.
 *
 * @param value - Untrusted value.
 * @returns True for a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rejects unknown fields so that typos never silently drop data.
 *
 * @param value - Request record.
 * @param allowed - Accepted field names.
 * @param pointer - JSON Pointer of the record.
 */
function assertKnownFields(value: Record<string, unknown>, allowed: readonly string[], pointer: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown !== undefined) {
    throw new AgentRunError('validation_failed', `Agent Run report does not accept field "${unknown}".`, {
      pointer: `${pointer}/${unknown}`,
    })
  }
}

/**
 * Checks whether text contains control characters other than line feeds and tabs.
 *
 * @param value - Text to inspect.
 * @returns True when an unsupported control character is present.
 */
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return (code < 32 && character !== '\n' && character !== '\t') || code === 127
  })
}

/**
 * Reads bounded single-line text.
 *
 * @param value - Untrusted value.
 * @param maxLength - Maximum length.
 * @param pointer - JSON Pointer reported on failure.
 * @param label - Field name used in the message.
 * @returns The trimmed text.
 */
function readLine(value: unknown, maxLength: number, pointer: string, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0 || text.length > maxLength || text.includes('\n') || hasControlCharacter(text)) {
    throw new AgentRunError('validation_failed', `${label} must be 1-${maxLength} characters on one line.`, { pointer })
  }
  return text
}

/**
 * Reads one value of a closed set.
 *
 * @param value - Untrusted value.
 * @param allowed - Accepted values.
 * @param pointer - JSON Pointer reported on failure.
 * @param label - Field name used in the message.
 * @returns The matching value.
 */
function readChoice<T extends string>(value: unknown, allowed: readonly T[], pointer: string, label: string): T {
  const match = allowed.find((candidate) => candidate === value)
  if (match === undefined) {
    throw new AgentRunError('validation_failed', `${label} must be one of ${allowed.join(', ')}.`, { pointer })
  }
  return match
}

/**
 * Reads an optional bounded list.
 *
 * @param value - Untrusted value.
 * @param pointer - JSON Pointer of the list.
 * @param label - Field name used in the message.
 * @returns The list items, or an empty list when the field is absent.
 */
function readList(value: unknown, pointer: string, label: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > AGENT_RUN_REPORT_MAX_ITEMS) {
    throw new AgentRunError('validation_failed', `${label} must be a list of at most ${AGENT_RUN_REPORT_MAX_ITEMS} items.`, { pointer })
  }
  return value
}

/**
 * Validates one verification result.
 *
 * @param value - Untrusted value.
 * @param pointer - JSON Pointer of the item.
 * @returns The verification.
 */
function readVerification(value: unknown, pointer: string): AgentRunVerification {
  if (!isRecord(value)) throw new AgentRunError('validation_failed', 'Each verification must be an object.', { pointer })
  assertKnownFields(value, ['command', 'status', 'summary'], pointer)
  return {
    command: readLine(value.command, AGENT_RUN_VERIFICATION_TEXT_MAX_LENGTH, `${pointer}/command`, 'command'),
    status: readChoice(value.status, AGENT_RUN_VERIFICATION_STATUSES, `${pointer}/status`, 'status'),
    ...(value.summary === undefined
      ? {}
      : { summary: readLine(value.summary, AGENT_RUN_VERIFICATION_TEXT_MAX_LENGTH, `${pointer}/summary`, 'summary') }),
  }
}

/**
 * Validates an artifact URL. The server never fetches or resolves it, so only its form is checked:
 * HTTPS with a host, no embedded credentials, and a bounded length.
 *
 * @param value - Untrusted value.
 * @param pointer - JSON Pointer reported on failure.
 * @returns The URL as sent.
 */
export function readAgentRunArtifactUrl(value: unknown, pointer: string): string {
  /**
   * Builds the rejection for an unsupported URL.
   *
   * @returns Validation error with the `invalid_artifact_url` reason.
   */
  const invalid = () => new AgentRunError(
    'validation_failed',
    `Artifact url must be an https URL of at most ${AGENT_RUN_ARTIFACT_URL_MAX_LENGTH} characters without credentials.`,
    { reason: 'invalid_artifact_url', pointer },
  )
  if (typeof value !== 'string' || value.length === 0 || value.length > AGENT_RUN_ARTIFACT_URL_MAX_LENGTH) throw invalid()
  if (value !== value.trim() || /\s/.test(value) || hasControlCharacter(value)) throw invalid()
  // The authority must follow the lowercase scheme directly, so the stored text reads as it parses.
  if (!value.startsWith('https://') || value.startsWith('https:///')) throw invalid()
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw invalid()
  }
  if (parsed.protocol !== 'https:' || parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') throw invalid()
  return value
}

/**
 * Validates one artifact link.
 *
 * @param value - Untrusted value.
 * @param pointer - JSON Pointer of the item.
 * @returns The artifact.
 */
function readArtifact(value: unknown, pointer: string): AgentRunArtifact {
  if (!isRecord(value)) throw new AgentRunError('validation_failed', 'Each artifact must be an object.', { pointer })
  assertKnownFields(value, ['type', 'url', 'label'], pointer)
  return {
    type: readChoice(value.type, AGENT_RUN_ARTIFACT_TYPES, `${pointer}/type`, 'type'),
    url: readAgentRunArtifactUrl(value.url, `${pointer}/url`),
    ...(value.label === undefined
      ? {}
      : { label: readLine(value.label, AGENT_RUN_ARTIFACT_LABEL_MAX_LENGTH, `${pointer}/label`, 'label') }),
  }
}

/**
 * Validates a structured report request body.
 *
 * @param value - Untrusted JSON body.
 * @returns Report input with a hashed instance ID.
 */
export function readReportAgentRunRequest(value: unknown): ValidatedAgentRunReport {
  if (!isRecord(value)) throw new AgentRunError('validation_failed', 'Agent Run report body is required.')
  assertKnownFields(value, ['instanceId', 'kind', 'message', 'verifications', 'artifacts', 'changedFileCount'], '')
  const message = typeof value.message === 'string' ? value.message.replace(/\r\n?/g, '\n').trim() : ''
  if (message.length === 0 || message.length > AGENT_RUN_REPORT_MESSAGE_MAX_LENGTH || hasControlCharacter(message)) {
    throw new AgentRunError(
      'validation_failed',
      `message must be 1-${AGENT_RUN_REPORT_MESSAGE_MAX_LENGTH} characters without control characters.`,
      { pointer: '/message' },
    )
  }
  const changedFileCount = value.changedFileCount
  if (changedFileCount !== undefined && (typeof changedFileCount !== 'number' || !Number.isSafeInteger(changedFileCount) || changedFileCount < 0)) {
    throw new AgentRunError('validation_failed', 'changedFileCount must be a non-negative integer.', { pointer: '/changedFileCount' })
  }
  return {
    instanceIdHash: hashAgentInstanceId(readAgentInstanceId(value.instanceId, '/instanceId')),
    kind: value.kind === undefined ? 'progress' : readChoice(value.kind, AGENT_RUN_REPORT_KINDS, '/kind', 'kind'),
    message,
    verifications: readList(value.verifications, '/verifications', 'verifications')
      .map((item, index) => readVerification(item, `/verifications/${index}`)),
    artifacts: readList(value.artifacts, '/artifacts', 'artifacts')
      .map((item, index) => readArtifact(item, `/artifacts/${index}`)),
    ...(changedFileCount === undefined ? {} : { changedFileCount }),
  }
}

/**
 * Builds the comment body saved with a report: the run's agent label, then the message.
 *
 * @param agentName - Display name recorded on the run.
 * @param message - Validated message.
 * @returns Comment body.
 */
export function createAgentRunReportCommentBody(agentName: string, message: string): string {
  return `[${agentName}]\n\n${message}`
}

/**
 * Projects a stored report for API responses.
 *
 * @param report - Stored report.
 * @returns Public report.
 */
export function toAgentRunReport(report: StoredAgentRunReport): AgentRunReport {
  return {
    schemaVersion: AGENT_RUN_SCHEMA_VERSION,
    runId: report.runId,
    teamId: report.teamId,
    workItemId: report.workItemId,
    sequence: report.sequence,
    kind: report.kind,
    commentId: report.commentId,
    verifications: report.verifications.map((verification) => ({ ...verification })),
    artifacts: report.artifacts.map((artifact) => ({ ...artifact })),
    ...(report.changedFileCount === undefined ? {} : { changedFileCount: report.changedFileCount }),
    createdAt: report.createdAt,
  }
}
