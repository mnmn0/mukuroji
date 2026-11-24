import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  CALENDAR_FEED_PROJECT_LIMIT,
  CALENDAR_FEED_PUBLIC_PATH_PREFIX,
  type CalendarFeed,
  type CalendarFeedListResponse,
  type IssueCalendarFeedRequest,
  type IssueCalendarFeedResponse,
} from '@mukuroji/contracts'

/** A stored feed with its owner and the digest of its current token secret. */
export type CalendarFeedRecord = CalendarFeed & {
  /** Workspace member key of the owner, whose current permissions bound the feed. */
  memberKey: string
  /** SHA-256 hex digest of the token secret. */
  tokenHash: string
}

/** Owner of the feeds a use case reads or changes. */
export type CalendarFeedOwner = {
  /** Workspace of the owner. */
  workspaceId: string
  /** Workspace member key of the owner. */
  memberKey: string
}

/** Input of {@link CalendarFeedStore.save}. */
export type CalendarFeedSaveInput<AuditContext> = {
  /** Workspace partition. */
  workspaceId: string
  /** Feed to store with its new token digest. */
  record: CalendarFeedRecord
  /** Digest of the token being replaced; absent when the feed is new. */
  previousTokenHash?: string
  /** Audit context of the request, written in the same transaction. */
  auditContext?: AuditContext
  /** Request time. */
  now: string
}

/** Input of {@link CalendarFeedStore.remove}. */
export type CalendarFeedRemoveInput<AuditContext> = {
  /** Workspace partition. */
  workspaceId: string
  /** Feed to delete with its token lookup row. */
  record: CalendarFeedRecord
  /** Audit context of the request, written in the same transaction. */
  auditContext?: AuditContext
  /** Request time. */
  now: string
}

/** Persistence of calendar feeds and their token lookup rows. */
export interface CalendarFeedStore<AuditContext = unknown> {
  /**
   * Lists the feeds one member owns.
   *
   * @param owner - Workspace and member.
   * @returns Every stored feed of the member.
   */
  list(owner: CalendarFeedOwner): Promise<CalendarFeedRecord[]>
  /**
   * Finds the feed whose current token has the digest.
   *
   * @param workspaceId - Workspace named by the token.
   * @param tokenHash - Digest of the token secret.
   * @returns The feed, or `null` when no current token has the digest.
   */
  findByTokenHash(workspaceId: string, tokenHash: string): Promise<CalendarFeedRecord | null>
  /**
   * Stores a new feed, or replaces a feed's token when `previousTokenHash` still matches.
   *
   * @param input - Feed, previous digest, and audit context.
   * @throws CalendarFeedError 409 when the feed changed concurrently.
   */
  save(input: CalendarFeedSaveInput<AuditContext>): Promise<void>
  /**
   * Deletes a feed and its token lookup row while the token is still current.
   *
   * @param input - Feed and audit context.
   * @throws CalendarFeedError 409 when the feed changed concurrently.
   */
  remove(input: CalendarFeedRemoveInput<AuditContext>): Promise<void>
}

/** Error of a calendar feed operation with its HTTP status. */
export class CalendarFeedError extends Error {
  /** HTTP status of the error response. */
  readonly status: 400 | 404 | 409 | 413 | 503
  /** Stable error code. */
  readonly code: string

  /**
   * Creates the error.
   *
   * @param status - HTTP status.
   * @param code - Stable error code.
   * @param message - Message shown to the client.
   * @param options - Optional cause.
   */
  constructor(status: CalendarFeedError['status'], code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CalendarFeedError'
    this.status = status
    this.code = code
  }
}

/** Number of random bytes in a token secret. */
const TOKEN_SECRET_BYTES = 32

/** Base64url length of a token secret. */
const TOKEN_SECRET_LENGTH = 43

/** Largest base64url length of the Workspace part of a token. */
const TOKEN_WORKSPACE_MAX_LENGTH = 512

/** Suffix calendar clients expect on a feed URL. */
const FEED_FILE_SUFFIX = '.ics'

/** Characters of a base64url value without padding. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

/** Decoded feed token. */
export type CalendarFeedToken = {
  /** Workspace whose partition holds the token lookup row. */
  workspaceId: string
  /** SHA-256 hex digest of the secret. */
  tokenHash: string
}

/** Fresh token and its digest. */
type IssuedToken = {
  /** Full token placed in the feed URL. */
  token: string
  /** SHA-256 hex digest of its secret. */
  tokenHash: string
}

/**
 * Creates a token of the form `base64url(workspaceId).base64url(32 random bytes)`.
 *
 * The Workspace part lets the public route read the lookup row in the Workspace partition; only
 * the secret's digest is stored.
 *
 * @param workspaceId - Workspace of the feed.
 * @param secret - Random secret; generated when omitted (tests pass a fixed one).
 * @returns The token and its digest.
 */
export function createCalendarFeedToken(workspaceId: string, secret?: Buffer): IssuedToken {
  const secretText = (secret ?? randomBytes(TOKEN_SECRET_BYTES)).toString('base64url')
  return {
    token: `${Buffer.from(workspaceId, 'utf8').toString('base64url')}.${secretText}`,
    tokenHash: hashTokenSecret(secretText),
  }
}

/**
 * Decodes a token from the public route, with or without its `.ics` suffix.
 *
 * @param value - Route parameter.
 * @returns The Workspace and secret digest, or `undefined` when the value is not a feed token.
 */
export function parseCalendarFeedToken(value: string | undefined): CalendarFeedToken | undefined {
  if (!value) return undefined
  const token = value.endsWith(FEED_FILE_SUFFIX) ? value.slice(0, -FEED_FILE_SUFFIX.length) : value
  const separator = token.indexOf('.')
  if (separator <= 0) return undefined
  const workspacePart = token.slice(0, separator)
  const secret = token.slice(separator + 1)
  if (
    workspacePart.length > TOKEN_WORKSPACE_MAX_LENGTH ||
    !BASE64URL_PATTERN.test(workspacePart) ||
    secret.length !== TOKEN_SECRET_LENGTH ||
    !BASE64URL_PATTERN.test(secret)
  ) {
    return undefined
  }
  const workspaceId = Buffer.from(workspacePart, 'base64url').toString('utf8')
  // A value that does not round-trip is not one this server issued.
  if (!workspaceId || Buffer.from(workspaceId, 'utf8').toString('base64url') !== workspacePart) {
    return undefined
  }
  return { workspaceId, tokenHash: hashTokenSecret(secret) }
}

/**
 * Hashes a token secret for storage and lookup.
 *
 * @param secret - Base64url secret.
 * @returns SHA-256 hex digest.
 */
function hashTokenSecret(secret: string): string {
  return createHash('sha256').update(`calendar-feed-v1\0${secret}`).digest('hex')
}

/**
 * Builds the public path of a feed token.
 *
 * @param token - Full token.
 * @returns The path under {@link CALENDAR_FEED_PUBLIC_PATH_PREFIX}.
 */
export function calendarFeedPath(token: string): string {
  return `${CALENDAR_FEED_PUBLIC_PATH_PREFIX}${token}${FEED_FILE_SUFFIX}`
}

/**
 * Removes the owner and token digest from a stored feed.
 *
 * @param record - Stored feed.
 * @returns The client view.
 */
export function toCalendarFeed(record: CalendarFeedRecord): CalendarFeed {
  return {
    id: record.id,
    kind: record.kind,
    ...(record.teamId === undefined ? {} : { teamId: record.teamId }),
    ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
    locale: record.locale,
    issuedAt: record.issuedAt,
    createdAt: record.createdAt,
  }
}

/**
 * Orders feeds with the member feed first, then Project feeds by Team and Project ID.
 *
 * @param left - Feed.
 * @param right - Feed.
 * @returns Sort order.
 */
function compareFeeds(left: CalendarFeed, right: CalendarFeed): number {
  if (left.kind !== right.kind) return left.kind === 'member' ? -1 : 1
  const team = (left.teamId ?? '').localeCompare(right.teamId ?? '')
  return team !== 0 ? team : (left.projectId ?? '').localeCompare(right.projectId ?? '')
}

/**
 * Returns whether a stored feed is the one a request names.
 *
 * @param record - Stored feed.
 * @param request - Issue request.
 * @returns Whether both name the member feed, or the same Team and Project.
 */
function isSameFeedTarget(record: CalendarFeedRecord, request: IssueCalendarFeedRequest): boolean {
  if (request.kind === 'member') return record.kind === 'member'
  return record.kind === 'project' &&
    record.teamId === request.teamId &&
    record.projectId === request.projectId
}

/**
 * Lists the caller's feeds without their secrets.
 *
 * @param store - Feed persistence.
 * @param owner - Caller.
 * @returns The feeds, member feed first.
 */
export async function listCalendarFeedsUseCase<AuditContext>(
  store: CalendarFeedStore<AuditContext>,
  owner: CalendarFeedOwner,
): Promise<CalendarFeedListResponse> {
  const records = await store.list(owner)
  return { feeds: records.map(toCalendarFeed).sort(compareFeeds) }
}

/** Request-scoped inputs of {@link issueCalendarFeedUseCase}. */
export type IssueCalendarFeedOptions<AuditContext> = {
  /** Request time. */
  now: string
  /** Audit context written with the feed. */
  auditContext?: AuditContext
  /** Creates a token; tests pass a fixed one. */
  createToken?: (workspaceId: string) => IssuedToken
  /** Creates a feed ID; tests pass a fixed one. */
  createId?: () => string
}

/**
 * Issues the member feed or a Project feed, or replaces its token when it already exists, so
 * the previous URL stops working at once. The caller has already checked that it can read the
 * Project of a Project feed.
 *
 * @param store - Feed persistence.
 * @param owner - Caller.
 * @param request - Validated request.
 * @param options - Request time, audit context, and generators.
 * @returns The feed and its tokenized path, shown once.
 * @throws CalendarFeedError 413 when the caller already holds the most Project feeds.
 */
export async function issueCalendarFeedUseCase<AuditContext>(
  store: CalendarFeedStore<AuditContext>,
  owner: CalendarFeedOwner,
  request: IssueCalendarFeedRequest,
  options: IssueCalendarFeedOptions<AuditContext>,
): Promise<IssueCalendarFeedResponse> {
  const records = await store.list(owner)
  const existing = records.find((record) => isSameFeedTarget(record, request))
  if (
    !existing &&
    request.kind === 'project' &&
    records.filter((record) => record.kind === 'project').length >= CALENDAR_FEED_PROJECT_LIMIT
  ) {
    throw new CalendarFeedError(
      413,
      'CalendarFeedLimitExceeded',
      `A member can hold at most ${CALENDAR_FEED_PROJECT_LIMIT} Project calendar feeds.`,
    )
  }
  const issued = (options.createToken ?? createCalendarFeedToken)(owner.workspaceId)
  const record: CalendarFeedRecord = {
    id: existing?.id ?? (options.createId ?? randomUUID)(),
    kind: request.kind,
    ...(request.kind === 'project' ? { teamId: request.teamId, projectId: request.projectId } : {}),
    locale: request.locale ?? existing?.locale ?? 'ja',
    issuedAt: options.now,
    createdAt: existing?.createdAt ?? options.now,
    memberKey: owner.memberKey,
    tokenHash: issued.tokenHash,
  }
  await store.save({
    workspaceId: owner.workspaceId,
    record,
    ...(existing ? { previousTokenHash: existing.tokenHash } : {}),
    ...(options.auditContext === undefined ? {} : { auditContext: options.auditContext }),
    now: options.now,
  })
  return { feed: toCalendarFeed(record), feedPath: calendarFeedPath(issued.token) }
}

/**
 * Revokes one of the caller's feeds; its URL then answers 404.
 *
 * @param store - Feed persistence.
 * @param owner - Caller.
 * @param feedId - Feed to revoke.
 * @param options - Request time and audit context.
 * @throws CalendarFeedError 404 when the caller has no such feed.
 */
export async function revokeCalendarFeedUseCase<AuditContext>(
  store: CalendarFeedStore<AuditContext>,
  owner: CalendarFeedOwner,
  feedId: string,
  options: { now: string, auditContext?: AuditContext },
): Promise<void> {
  const record = (await store.list(owner)).find((candidate) => candidate.id === feedId)
  if (!record) throw new CalendarFeedError(404, 'CalendarFeedNotFound', 'Calendar feed was not found.')
  await store.remove({
    workspaceId: owner.workspaceId,
    record,
    ...(options.auditContext === undefined ? {} : { auditContext: options.auditContext }),
    now: options.now,
  })
}

/**
 * Resolves a public feed token to its current feed.
 *
 * @param store - Feed persistence.
 * @param value - Token route parameter.
 * @returns The Workspace and feed, or `undefined` for an unknown, malformed, replaced, or revoked
 *   token.
 */
export async function resolveCalendarFeedTokenUseCase<AuditContext>(
  store: CalendarFeedStore<AuditContext>,
  value: string | undefined,
): Promise<{ workspaceId: string, record: CalendarFeedRecord } | undefined> {
  const token = parseCalendarFeedToken(value)
  if (!token) return undefined
  const record = await store.findByTokenHash(token.workspaceId, token.tokenHash)
  return record ? { workspaceId: token.workspaceId, record } : undefined
}
