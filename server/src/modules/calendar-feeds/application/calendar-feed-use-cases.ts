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
export type CalendarFeedSaveInput<AuditContext, Completion = never> = {
  /** Workspace partition. */
  workspaceId: string
  /** Feed to store with its new token digest. */
  record: CalendarFeedRecord
  /** Digest of the token being replaced; absent when the feed is new. */
  previousTokenHash?: string
  /** Audit context of the request, written in the same transaction. */
  auditContext?: AuditContext
  /**
   * Idempotency receipt write prepared by {@link CalendarFeedIssueReceipts}, committed in the same
   * transaction so a lost response can be replayed.
   */
  receiptCompletion?: Completion
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
export interface CalendarFeedStore<AuditContext = unknown, Completion = never> {
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
   * @param input - Feed, previous digest, audit context, and receipt.
   * @throws CalendarFeedError `conflict` when the feed changed concurrently.
   */
  save(input: CalendarFeedSaveInput<AuditContext, Completion>): Promise<void>
  /**
   * Deletes a feed and its token lookup row while the token is still current.
   *
   * @param input - Feed and audit context.
   * @throws CalendarFeedError `conflict` when the feed changed concurrently.
   */
  remove(input: CalendarFeedRemoveInput<AuditContext>): Promise<void>
}

/**
 * Kind of a calendar feed failure. The HTTP adapter maps it to a status; the application does
 * not know HTTP.
 */
export type CalendarFeedErrorCategory =
  | 'invalid-input'
  | 'not-found'
  | 'conflict'
  | 'limit-exceeded'
  | 'unavailable'

/** Error of a calendar feed operation with a stable code and category. */
export class CalendarFeedError extends Error {
  /** Kind of failure. */
  readonly category: CalendarFeedErrorCategory
  /** Stable error code. */
  readonly code: string

  /**
   * Creates the error.
   *
   * @param category - Kind of failure.
   * @param code - Stable error code.
   * @param message - Message shown to the client.
   * @param options - Optional cause.
   */
  constructor(category: CalendarFeedErrorCategory, code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CalendarFeedError'
    this.category = category
    this.code = code
  }
}

/** Identity of one issue request in the idempotency store. */
export type CalendarFeedIssueReceiptKey = {
  /** Workspace of the request. */
  workspaceId: string
  /** Caller namespace of the request key. */
  credentialId: string
  /** Caller-provided `Idempotency-Key`. */
  idempotencyKey: string
  /** Digest binding the key to the owner and request body. */
  requestFingerprint: string
}

/** Decision of {@link CalendarFeedIssueReceipts.reserve}. */
export type CalendarFeedIssueReceiptDecision =
  | {
      /** This request owns the key. */
      status: 'reserved'
      /** Ownership token used to complete or release the key. */
      reservationId: string
    }
  | {
      /** Another request with the key has not finished. */
      status: 'in-progress'
    }
  | {
      /** A request with the key committed; its response is replayed. */
      status: 'replay'
      /** Stored response. */
      response: unknown
    }

/**
 * Durable receipts of issue requests, so a client that lost the one-time URL gets it back by
 * retrying with the same `Idempotency-Key` instead of rotating the token again.
 *
 * `reserve` throws {@link CalendarFeedError} `conflict` when the key was used for another request.
 */
export interface CalendarFeedIssueReceipts<Completion> {
  /** Reserves the key, or returns the committed response. */
  reserve(key: CalendarFeedIssueReceiptKey): Promise<CalendarFeedIssueReceiptDecision>
  /**
   * Prepares the receipt write committed with the feed, or returns `undefined` when the store
   * cannot join the transaction and {@link complete} must run after the save.
   */
  prepareCompletion(
    key: CalendarFeedIssueReceiptKey & {
      /** Ownership token. */
      reservationId: string
      /** Response to replay. */
      response: IssueCalendarFeedResponse
    },
  ): Promise<Completion | undefined>
  /** Stores the receipt after a save that could not include it. */
  complete(
    key: CalendarFeedIssueReceiptKey & {
      /** Ownership token. */
      reservationId: string
      /** Response to replay. */
      response: IssueCalendarFeedResponse
    },
  ): Promise<void>
  /** Releases the key of a request that did not commit. */
  release(
    key: CalendarFeedIssueReceiptKey & {
      /** Ownership token. */
      reservationId: string
    },
  ): Promise<void>
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
export type IssueCalendarFeedOptions<AuditContext, Completion> = {
  /** Request time. */
  now: string
  /** Audit context written with the feed. */
  auditContext?: AuditContext
  /** Checks that the owner can read the Project of a Project feed, with the feed-read rule. */
  canReadProject: (owner: CalendarFeedOwner, teamId: string, projectId: string) => Promise<boolean>
  /** Receipt store and the request key, when the client sent one. */
  idempotency?: {
    /** Receipt store. */
    receipts: CalendarFeedIssueReceipts<Completion>
    /** Caller-provided `Idempotency-Key`. */
    key: string
  }
  /** Creates a token; tests pass a fixed one. */
  createToken?: (workspaceId: string) => IssuedToken
  /** Creates a feed ID; tests pass a fixed one. */
  createId?: () => string
}

/**
 * Issues the member feed or a Project feed, or replaces its token when it already exists, so
 * the previous URL stops working at once.
 *
 * With an `Idempotency-Key`, the response is stored with the feed in one transaction, and a retry
 * of a committed request returns the same URL without another write.
 *
 * @param store - Feed persistence.
 * @param owner - Caller.
 * @param request - Validated request.
 * @param options - Request time, audit context, Project check, receipts, and generators.
 * @returns The feed and its tokenized path, shown once.
 * @throws CalendarFeedError `not-found` when the owner cannot read the Project, `limit-exceeded`
 *   when the caller already holds the most Project feeds, and `conflict` while the same key is in
 *   progress or was used for another request.
 */
export async function issueCalendarFeedUseCase<AuditContext, Completion>(
  store: CalendarFeedStore<AuditContext, Completion>,
  owner: CalendarFeedOwner,
  request: IssueCalendarFeedRequest,
  options: IssueCalendarFeedOptions<AuditContext, Completion>,
): Promise<IssueCalendarFeedResponse> {
  if (request.kind === 'project' && !await options.canReadProject(owner, request.teamId, request.projectId)) {
    throw new CalendarFeedError('not-found', 'ProjectNotFound', `Project "${request.projectId}" was not found.`)
  }
  const receiptKey = options.idempotency ? createIssueReceiptKey(owner, request, options.idempotency.key) : undefined
  if (!options.idempotency || !receiptKey) return issueFeed(store, owner, request, options)
  const { receipts } = options.idempotency
  const decision = await receipts.reserve(receiptKey)
  if (decision.status === 'replay') return readIssueReceipt(decision.response)
  if (decision.status === 'in-progress') {
    throw new CalendarFeedError(
      'conflict',
      'CalendarFeedIssueInProgress',
      'The same calendar feed request is still in progress. Retry shortly.',
    )
  }
  const owned = { ...receiptKey, reservationId: decision.reservationId }
  let response: IssueCalendarFeedResponse
  let completed = false
  try {
    response = await issueFeed(store, owner, request, options, async (prepared) => {
      const completion = await receipts.prepareCompletion({ ...owned, response: prepared })
      completed = completion !== undefined
      return completion
    })
  } catch (error) {
    await receipts.release(owned).catch(() => undefined)
    throw error
  }
  if (!completed) await receipts.complete({ ...owned, response })
  return response
}

/**
 * Stores the feed with a new token.
 *
 * @param store - Feed persistence.
 * @param owner - Caller.
 * @param request - Validated request.
 * @param options - Request time, audit context, and generators.
 * @param prepareReceipt - Prepares the receipt write for the response, when the request has a key.
 * @returns The feed and its tokenized path.
 */
async function issueFeed<AuditContext, Completion>(
  store: CalendarFeedStore<AuditContext, Completion>,
  owner: CalendarFeedOwner,
  request: IssueCalendarFeedRequest,
  options: IssueCalendarFeedOptions<AuditContext, Completion>,
  prepareReceipt?: (response: IssueCalendarFeedResponse) => Promise<Completion | undefined>,
): Promise<IssueCalendarFeedResponse> {
  const records = await store.list(owner)
  const existing = records.find((record) => isSameFeedTarget(record, request))
  if (
    !existing &&
    request.kind === 'project' &&
    records.filter((record) => record.kind === 'project').length >= CALENDAR_FEED_PROJECT_LIMIT
  ) {
    throw new CalendarFeedError(
      'limit-exceeded',
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
  const response = { feed: toCalendarFeed(record), feedPath: calendarFeedPath(issued.token) }
  const receiptCompletion = prepareReceipt ? await prepareReceipt(response) : undefined
  await store.save({
    workspaceId: owner.workspaceId,
    record,
    ...(existing ? { previousTokenHash: existing.tokenHash } : {}),
    ...(options.auditContext === undefined ? {} : { auditContext: options.auditContext }),
    ...(receiptCompletion === undefined ? {} : { receiptCompletion }),
    now: options.now,
  })
  return response
}

/**
 * Binds an `Idempotency-Key` to the owner and the request body.
 *
 * @param owner - Caller.
 * @param request - Validated request.
 * @param key - Caller-provided key.
 * @returns The receipt key, or `undefined` when the key is unusable and the request runs without
 *   a receipt.
 */
function createIssueReceiptKey(
  owner: CalendarFeedOwner,
  request: IssueCalendarFeedRequest,
  key: string,
): CalendarFeedIssueReceiptKey | undefined {
  if (key === '' || key.length > 256 || [...key].some((character) => character < ' ' || character === '\x7f')) return undefined
  const memberDigest = createHash('sha256').update(`calendar-feed-owner-v1\0${owner.memberKey}`).digest('hex')
  return {
    workspaceId: owner.workspaceId,
    credentialId: `calendar-feed-${memberDigest.slice(0, 40)}`,
    idempotencyKey: key,
    requestFingerprint: createHash('sha256').update(JSON.stringify([
      'calendar-feed-issue-v1',
      owner.workspaceId,
      owner.memberKey,
      request.kind,
      request.kind === 'project' ? request.teamId : '',
      request.kind === 'project' ? request.projectId : '',
      request.locale ?? '',
    ])).digest('hex'),
  }
}

/**
 * Validates a replayed issue response.
 *
 * @param value - Stored response.
 * @returns The response.
 * @throws CalendarFeedError `unavailable` when the receipt is malformed.
 */
function readIssueReceipt(value: unknown): IssueCalendarFeedResponse {
  const body = isRecord(value) && value.status === 201 ? value.body : value
  if (
    isRecord(body) &&
    typeof body.feedPath === 'string' &&
    body.feedPath.startsWith(CALENDAR_FEED_PUBLIC_PATH_PREFIX) &&
    isRecord(body.feed)
  ) {
    const feed = body.feed
    if (
      typeof feed.id === 'string' &&
      (feed.kind === 'member' || feed.kind === 'project') &&
      (feed.locale === 'ja' || feed.locale === 'en') &&
      typeof feed.issuedAt === 'string' &&
      typeof feed.createdAt === 'string'
    ) {
      return {
        feed: {
          id: feed.id,
          kind: feed.kind,
          ...(typeof feed.teamId === 'string' ? { teamId: feed.teamId } : {}),
          ...(typeof feed.projectId === 'string' ? { projectId: feed.projectId } : {}),
          locale: feed.locale,
          issuedAt: feed.issuedAt,
          createdAt: feed.createdAt,
        },
        feedPath: body.feedPath,
      }
    }
  }
  throw new CalendarFeedError('unavailable', 'CalendarFeedReceiptInvalid', 'Calendar feed receipt is unavailable.')
}

/**
 * Checks for a plain object.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Revokes one of the caller's feeds; its URL then answers 404.
 *
 * @param store - Feed persistence.
 * @param owner - Caller.
 * @param feedId - Feed to revoke.
 * @param options - Request time and audit context.
 * @throws CalendarFeedError `not-found` when the caller has no such feed.
 */
export async function revokeCalendarFeedUseCase<AuditContext>(
  store: CalendarFeedStore<AuditContext>,
  owner: CalendarFeedOwner,
  feedId: string,
  options: { now: string, auditContext?: AuditContext },
): Promise<void> {
  const record = (await store.list(owner)).find((candidate) => candidate.id === feedId)
  if (!record) throw new CalendarFeedError('not-found', 'CalendarFeedNotFound', 'Calendar feed was not found.')
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
