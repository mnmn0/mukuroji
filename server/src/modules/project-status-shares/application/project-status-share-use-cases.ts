import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  parseProjectStatusReport,
  parseProjectStatusShareScope,
  PROJECT_STATUS_REPORT_MAX_BYTES,
  PROJECT_STATUS_SHARE_MAX_DAYS,
  PROJECT_STATUS_SHARE_MAX_PER_PROJECT,
  redactProjectStatusReport,
  type CreateProjectStatusShareResponse,
  type ProjectStatusReport,
  type ProjectStatusShare,
  type ProjectStatusShareListResponse,
  type PublicProjectStatusReportResponse,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../directory'

/** Team and Project of one share request, after the route authorized it. */
export type ProjectStatusShareScopeKey = {
  /** Workspace directory ID. */
  workspaceId: string
  /** Team that owns the Project. */
  teamId: string
  /** Shared Project. */
  projectId: string
}

/** Commit-time inputs shared by share creation and revocation. */
export type ProjectStatusShareMutation<TCallerCheck, TAudit> = {
  /** Mutation time as an ISO timestamp. */
  now: string
  /** Server-built conditions that fail the write when the caller lost access. */
  callerAuthorization: readonly TCallerCheck[]
  /** Audit context of the request, recorded in the same transaction. */
  auditContext: TAudit
}

/** One stored share with the snapshot it publishes. */
export type ProjectStatusShareRecord = {
  /** Share metadata. */
  share: ProjectStatusShare
  /** Redacted report the link publishes. */
  report: ProjectStatusReport
  /** SHA-256 digest of the token secret; the secret itself is never stored. */
  tokenHash: string
}

/** Share found through its token digest. */
export type ProjectStatusShareLookup = ProjectStatusShareRecord & {
  /** Team and Project the share belongs to. */
  scope: ProjectStatusShareScopeKey
}

/** Audit details of one counted view of a public link. */
export type ProjectStatusShareView = {
  /** View time as an ISO timestamp. */
  now: string
  /** Views counted no more often than this: the previous view must be before it. */
  countAfter: string
}

/** Persistence port of Project status share links. */
export type ProjectStatusShareStore<TCallerCheck, TAudit> = {
  /**
   * Reads every share of a Project.
   *
   * @param scope - Team and Project.
   * @returns Shares in any order.
   */
  list(scope: ProjectStatusShareScopeKey): Promise<ProjectStatusShare[]>
  /**
   * Reads one share with a strongly consistent read.
   *
   * @param scope - Team and Project.
   * @param shareId - Share ID.
   * @returns The share and its snapshot, or `null`.
   */
  get(scope: ProjectStatusShareScopeKey, shareId: string): Promise<ProjectStatusShareRecord | null>
  /**
   * Finds the open share whose token secret has the digest.
   *
   * @param workspaceId - Workspace named by the token.
   * @param tokenHash - SHA-256 digest of the token secret.
   * @returns The share, or `null` when no unrevoked share has the digest.
   */
  findByTokenHash(workspaceId: string, tokenHash: string): Promise<ProjectStatusShareLookup | null>
  /**
   * Stores a new share and its token lookup row.
   *
   * @param input - Scope, mutation context, and the record to store.
   */
  create(input: ProjectStatusShareScopeKey & ProjectStatusShareMutation<TCallerCheck, TAudit> & {
    /** Record to store. */
    record: ProjectStatusShareRecord
  }): Promise<void>
  /**
   * Revokes an open share and removes its token lookup row.
   *
   * @param input - Scope, mutation context, and the share read before the change.
   * @returns The revoked share.
   */
  revoke(input: ProjectStatusShareScopeKey & ProjectStatusShareMutation<TCallerCheck, TAudit> & {
    /** Share read before the change. */
    previous: ProjectStatusShareRecord
  }): Promise<ProjectStatusShare>
  /**
   * Counts one view of a public link and records it in audit, unless a view was counted
   * after `view.countAfter`.
   *
   * @param lookup - Share that was opened.
   * @param view - View time and counting window.
   */
  recordView(lookup: ProjectStatusShareLookup, view: ProjectStatusShareView): Promise<void>
}

/** Checks a share request depends on outside this module. */
export type ProjectStatusShareCreateChecks = {
  /**
   * Confirms the customer, and the contact when given, exist and may be named by the caller.
   *
   * @param customerId - Customer ID.
   * @param contactId - Contact ID of that customer.
   * @throws ProjectDataError when the customer or contact cannot be used.
   */
  verifyCustomerContact(customerId: string, contactId: string | undefined): Promise<void>
}

/** Checks a public view depends on outside this module. */
export type ProjectStatusPublicViewChecks = {
  /**
   * Refuses a Workspace that is not active, such as a closed one.
   *
   * @param workspaceId - Workspace of the share.
   */
  assertWorkspaceActive(workspaceId: string): Promise<void>
  /**
   * Tells whether the Project still exists in its Team and is not archived.
   *
   * @param scope - Team and Project of the share.
   * @returns Whether the Project is active.
   */
  isProjectActive(scope: ProjectStatusShareScopeKey): Promise<boolean>
}

/** Most share rows, including revoked and expired ones, one Project keeps. */
const PROJECT_STATUS_SHARE_MAX_STORED = 300
/** Longest label of a share link. */
const LABEL_MAX_LENGTH = 100
/** Longest customer or contact ID accepted. */
const REFERENCE_MAX_LENGTH = 200
/** Bytes of randomness in a token secret. */
const TOKEN_SECRET_BYTES = 32
/** Length of a base64url-encoded token secret. */
const TOKEN_SECRET_LENGTH = 43
/** Longest Workspace ID a token may name. */
const WORKSPACE_ID_MAX_LENGTH = 200
/** Shortest time between two counted views of one link. */
const VIEW_COUNT_INTERVAL_MS = 60_000
/** Control characters rejected in labels and IDs. */
// eslint-disable-next-line no-control-regex -- these control characters are what the check rejects.
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/u

/**
 * Reads the share links of a Project, newest first.
 *
 * @param store - Share persistence.
 * @param scope - Authorized Team and Project.
 * @returns The list response.
 */
export async function listProjectStatusSharesUseCase<TCallerCheck, TAudit>(
  store: ProjectStatusShareStore<TCallerCheck, TAudit>,
  scope: ProjectStatusShareScopeKey,
): Promise<ProjectStatusShareListResponse> {
  const shares = await store.list(scope)
  shares.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
  return { shares }
}

/**
 * Creates a read-only share link that publishes a redacted report snapshot.
 *
 * Sections outside the chosen scope and, unless kept, people's names are removed before the
 * snapshot is stored, so the public page can only ever return what the creator chose.
 *
 * @param store - Share persistence.
 * @param scope - Authorized Team and Project.
 * @param body - Untrusted request body.
 * @param mutation - Mutation time, caller fences, audit context, creator, and outside checks.
 * @returns The share and the URL that carries its token, which is not stored.
 * @throws ProjectDataError 400 for invalid input and 413 for a full Project or a large report.
 */
export async function createProjectStatusShareUseCase<TCallerCheck, TAudit>(
  store: ProjectStatusShareStore<TCallerCheck, TAudit>,
  scope: ProjectStatusShareScopeKey,
  body: unknown,
  mutation: ProjectStatusShareMutation<TCallerCheck, TAudit> & {
    /** Workspace member key of the creator. */
    createdByMemberKey: string
    /** Checks that read other modules. */
    checks: ProjectStatusShareCreateChecks
  },
): Promise<CreateProjectStatusShareResponse> {
  const input = readCreateInput(body)
  if (input.customerId !== undefined) {
    await mutation.checks.verifyCustomerContact(input.customerId, input.contactId)
  }
  const existing = await store.list(scope)
  const nowTime = Date.parse(mutation.now)
  const open = existing.filter((share) => share.revokedAt === undefined && Date.parse(share.expiresAt) > nowTime)
  if (open.length >= PROJECT_STATUS_SHARE_MAX_PER_PROJECT || existing.length >= PROJECT_STATUS_SHARE_MAX_STORED) {
    throw new ProjectDataError(
      413,
      'ProjectStatusShareLimitReached',
      `A Project can have at most ${PROJECT_STATUS_SHARE_MAX_PER_PROJECT} open share links. Revoke one that is no longer needed.`,
    )
  }
  const report = redactProjectStatusReport(input.report, input.scope)
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') > PROJECT_STATUS_REPORT_MAX_BYTES) {
    throw new ProjectDataError(413, 'ProjectStatusReportTooLarge', 'The report is too large to share.')
  }
  const secret = randomBytes(TOKEN_SECRET_BYTES).toString('base64url')
  const token = `${Buffer.from(scope.workspaceId, 'utf8').toString('base64url')}.${secret}`
  const expiresAt = new Date(Date.parse(mutation.now) + input.expiresInDays * 86_400_000).toISOString()
  const share: ProjectStatusShare = {
    id: `pss_${randomBytes(16).toString('hex')}`,
    teamId: scope.teamId,
    projectId: scope.projectId,
    label: input.label,
    sections: input.scope.sections,
    showPeopleNames: input.scope.showPeopleNames,
    expiresAt,
    createdAt: mutation.now,
    createdByMemberKey: mutation.createdByMemberKey,
    reportAsOf: report.asOf,
    viewCount: 0,
    ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
    ...(input.contactId === undefined ? {} : { contactId: input.contactId }),
  }
  await store.create({
    ...scope,
    now: mutation.now,
    callerAuthorization: mutation.callerAuthorization,
    auditContext: mutation.auditContext,
    record: { share, report, tokenHash: hashTokenSecret(secret) },
  })
  return { share, url: `/share/project-status/${encodeURIComponent(token)}` }
}

/**
 * Revokes a share link; revoking a revoked link returns it unchanged.
 *
 * @param store - Share persistence.
 * @param scope - Authorized Team and Project.
 * @param shareId - Share to revoke.
 * @param mutation - Mutation time, caller fences, and audit context.
 * @returns The revoked share.
 * @throws ProjectDataError 404 when the share does not exist.
 */
export async function revokeProjectStatusShareUseCase<TCallerCheck, TAudit>(
  store: ProjectStatusShareStore<TCallerCheck, TAudit>,
  scope: ProjectStatusShareScopeKey,
  shareId: string,
  mutation: ProjectStatusShareMutation<TCallerCheck, TAudit>,
): Promise<ProjectStatusShare> {
  const previous = await store.get(scope, shareId)
  if (!previous) throw new ProjectDataError(404, 'ProjectStatusShareNotFound', 'The share link was not found.')
  if (previous.share.revokedAt !== undefined) return previous.share
  return store.revoke({ ...scope, ...mutation, previous })
}

/**
 * Resolves a public share token to the report it publishes and counts the view.
 *
 * Every failure, including a revoked or expired link, a closed Workspace, and an archived
 * Project, answers the same 404 so that the response does not tell which links ever existed.
 *
 * @param store - Share persistence.
 * @param token - Untrusted token from the URL.
 * @param now - Request time.
 * @param checks - Workspace and Project lifecycle checks.
 * @returns The published report and the link expiry.
 * @throws ProjectDataError 404 when the link does not publish anything.
 */
export async function readPublicProjectStatusReportUseCase<TCallerCheck, TAudit>(
  store: ProjectStatusShareStore<TCallerCheck, TAudit>,
  token: string,
  now: Date,
  checks: ProjectStatusPublicViewChecks,
): Promise<{ response: PublicProjectStatusReportResponse; lookup: ProjectStatusShareLookup }> {
  const parsed = parseToken(token)
  if (!parsed) throw publicNotFound()
  const tokenHash = hashTokenSecret(parsed.secret)
  const lookup = await store.findByTokenHash(parsed.workspaceId, tokenHash)
  if (
    !lookup ||
    !sameDigest(lookup.tokenHash, tokenHash) ||
    lookup.share.revokedAt !== undefined ||
    Date.parse(lookup.share.expiresAt) <= now.getTime()
  ) {
    throw publicNotFound()
  }
  try {
    await checks.assertWorkspaceActive(lookup.scope.workspaceId)
  } catch {
    throw publicNotFound()
  }
  if (!await checks.isProjectActive(lookup.scope)) throw publicNotFound()
  return {
    response: { report: lookup.report, expiresAt: lookup.share.expiresAt },
    lookup,
  }
}

/**
 * Counts a public view, at most once a minute per link.
 *
 * @param store - Share persistence.
 * @param lookup - Share that was opened.
 * @param now - Request time.
 */
export async function recordPublicProjectStatusViewUseCase<TCallerCheck, TAudit>(
  store: ProjectStatusShareStore<TCallerCheck, TAudit>,
  lookup: ProjectStatusShareLookup,
  now: Date,
): Promise<void> {
  await store.recordView(lookup, {
    now: now.toISOString(),
    countAfter: new Date(now.getTime() - VIEW_COUNT_INTERVAL_MS).toISOString(),
  })
}

/**
 * Hashes a token secret for storage and lookup.
 *
 * @param secret - Token secret.
 * @returns Hexadecimal SHA-256 digest.
 */
export function hashTokenSecret(secret: string) {
  return createHash('sha256').update(`project-status-share-v1\0${secret}`).digest('hex')
}

/**
 * Splits a public token into the Workspace it names and its secret.
 *
 * @param token - Untrusted token.
 * @returns The parts, or `undefined` when the token is malformed.
 */
function parseToken(token: string) {
  const parts = token.split('.')
  if (parts.length !== 2) return undefined
  const [encodedWorkspace, secret] = parts
  if (!encodedWorkspace || !secret || secret.length !== TOKEN_SECRET_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(secret)) {
    return undefined
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(encodedWorkspace)) return undefined
  const workspaceId = Buffer.from(encodedWorkspace, 'base64url').toString('utf8')
  if (
    workspaceId.length === 0 ||
    workspaceId.length > WORKSPACE_ID_MAX_LENGTH ||
    CONTROL_CHARACTER.test(workspaceId) ||
    workspaceId.includes('�') ||
    Buffer.from(workspaceId, 'utf8').toString('base64url') !== encodedWorkspace
  ) {
    return undefined
  }
  return { workspaceId, secret }
}

/**
 * Compares two hexadecimal digests in constant time.
 *
 * @param left - Stored digest.
 * @param right - Computed digest.
 * @returns Whether the digests are equal.
 */
function sameDigest(left: string, right: string) {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

/**
 * Creates the uniform error of a public link that publishes nothing.
 *
 * @returns The error.
 */
function publicNotFound() {
  return new ProjectDataError(404, 'ProjectStatusShareNotFound', 'This link is invalid or no longer available.')
}

/**
 * Validates untrusted share creation input.
 *
 * @param body - Request body.
 * @returns The normalized input.
 * @throws ProjectDataError 400 for the first problem found.
 */
function readCreateInput(body: unknown) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('The request body must be an object.')
  const record = Object.fromEntries(Object.entries(body))
  const report = parseProjectStatusReport(record.report)
  if (!report.ok) throw invalid(report.message)
  const scope = parseProjectStatusShareScope(record.sections, record.showPeopleNames)
  if (!scope.ok) throw invalid(scope.message)
  const label = typeof record.label === 'string' ? record.label.trim() : ''
  if (label.length === 0 || label.length > LABEL_MAX_LENGTH || CONTROL_CHARACTER.test(label)) {
    throw invalid(`The label is required and must be at most ${LABEL_MAX_LENGTH} characters.`)
  }
  const expiresInDays = record.expiresInDays
  if (
    typeof expiresInDays !== 'number' ||
    !Number.isSafeInteger(expiresInDays) ||
    expiresInDays < 1 ||
    expiresInDays > PROJECT_STATUS_SHARE_MAX_DAYS
  ) {
    throw invalid(`expiresInDays must be an integer from 1 to ${PROJECT_STATUS_SHARE_MAX_DAYS}.`)
  }
  const customerId = readReference(record.customerId, 'customerId')
  const contactId = readReference(record.contactId, 'contactId')
  if (contactId !== undefined && customerId === undefined) throw invalid('A contact needs its customer.')
  return { report: report.value, scope: scope.value, label, expiresInDays, customerId, contactId }
}

/**
 * Reads an optional customer or contact ID.
 *
 * @param value - Untrusted input.
 * @param name - Field name used in messages.
 * @returns The ID, or `undefined` when absent or empty.
 */
function readReference(value: unknown, name: string) {
  if (value === undefined || value === null || value === '') return undefined
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length > REFERENCE_MAX_LENGTH ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw invalid(`${name} is invalid.`)
  }
  return value
}

/**
 * Creates the error of invalid share input.
 *
 * @param message - Problem found.
 * @returns The error.
 */
function invalid(message: string) {
  return new ProjectDataError(400, 'InvalidProjectStatusShare', message)
}
