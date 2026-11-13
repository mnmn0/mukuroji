import {
  SCOPED_WORK_ITEM_LEGACY_MAX_ITEMS,
  SCOPED_WORK_ITEM_PAGE_DEFAULT_LIMIT,
  SCOPED_WORK_ITEM_PAGE_MAX_LIMIT,
} from '@mukuroji/contracts'
import { createHash } from 'node:crypto'
import { ProjectDataError } from '../../modules/directory'
import type {
  SortedWorkItemPage,
  SortedWorkItemPagePosition,
  TeamIssueResponseItem,
} from '../../modules/work-items'
import { workItemDependencies } from './app-dependencies'
import { WORK_ITEMS_PAGE_SCAN_BUDGET } from './constants'

/** Team or Project list whose Work Items are read in sort order. */
export type ScopedWorkItemListScope = {
  /** Whether the list belongs to a Team or a Project. */
  kind: 'team' | 'project'
  /** Team ID or Project ID of the list. */
  id: string
  /** Whether archived Work Items are included. */
  includeArchived: boolean
  /** Optional stable Work Item Type filter. */
  workItemTypeId?: string
}

/** Parsed paging parameters of a Team or Project Work Item list request. */
export type ScopedWorkItemPageQuery = {
  /** Whether the request asked for a cursor page instead of the legacy complete list. */
  paged: boolean
  /** Page size when paged. */
  limit: number
  /** Cursor of the requested page. */
  cursor?: string
}

/** One Team or Project page before the route adds its scope-specific fields. */
export type ScopedWorkItemPage = {
  /** Work Items the caller may read, in sort order. */
  issues: TeamIssueResponseItem[]
  /** Opaque cursor for the next page. */
  nextCursor?: string
}

/** Decoded cursor of a Team or Project page. */
type ScopedWorkItemPageCursor = {
  /** Cursor schema version. */
  v: 1
  /** Fingerprint of the list scope and filters the cursor was issued for. */
  f: string
  /** Sort-order key of the last evaluated Work Item. */
  s: number
  /** Team that owns the last evaluated Work Item. */
  t: string
  /** Team-local ID of the last evaluated Work Item. */
  i: string
}

/**
 * Parses the `limit` and `cursor` query parameters of a Team or Project list.
 *
 * A request is paged when it carries `limit` or `cursor`. Without either, the legacy complete
 * list applies, bounded by {@link SCOPED_WORK_ITEM_LEGACY_MAX_ITEMS}.
 *
 * @param readQuery - Reads one query value by name.
 * @returns The parsed paging parameters.
 */
export function readScopedWorkItemPageQuery(
  readQuery: (name: string) => string | undefined,
): ScopedWorkItemPageQuery {
  const rawLimit = readQuery('limit')
  const cursor = readQuery('cursor') || undefined
  return {
    paged: rawLimit !== undefined || cursor !== undefined,
    limit: readScopedWorkItemPageLimit(rawLimit),
    ...(cursor ? { cursor } : {}),
  }
}

/**
 * Reads one page of a Team or Project list and keeps only Work Items the caller may read.
 *
 * DynamoDB evaluates at most {@link WORK_ITEMS_PAGE_SCAN_BUDGET} rows per request, so a page
 * can hold fewer than `limit` Work Items, or none, while `nextCursor` is still set.
 *
 * @param directoryId - Caller's Workspace directory.
 * @param scope - Team or Project list and its filters.
 * @param query - Page size and cursor.
 * @param keepReadable - Drops Work Items the caller may not read.
 * @returns The page and the cursor of the next one.
 */
export async function readScopedWorkItemPage(
  directoryId: string,
  scope: ScopedWorkItemListScope,
  query: Pick<ScopedWorkItemPageQuery, 'limit' | 'cursor'>,
  keepReadable: (issues: TeamIssueResponseItem[]) => TeamIssueResponseItem[] = (issues) => issues,
): Promise<ScopedWorkItemPage> {
  const fingerprint = createScopedWorkItemPageFingerprint(scope)
  const startAfter = decodeScopedWorkItemPageCursor(query.cursor, fingerprint)
  const page = await readSortedPage(directoryId, scope, query.limit, startAfter)
  return {
    issues: keepReadable(page.issues),
    ...(page.nextPosition
      ? { nextCursor: encodeScopedWorkItemPageCursor(page.nextPosition, fingerprint) }
      : {}),
  }
}

/**
 * Reads a whole Team or Project list for a legacy request without `limit` or `cursor`.
 *
 * @param directoryId - Caller's Workspace directory.
 * @param scope - Team or Project list and its filters.
 * @param keepReadable - Drops Work Items the caller may not read.
 * @returns Every readable Work Item of the list.
 * @throws ProjectDataError `413 WorkItemListLimitExceeded` when more than
 *   {@link SCOPED_WORK_ITEM_LEGACY_MAX_ITEMS} Work Items are readable.
 */
export async function readScopedWorkItemsWithinLegacyLimit(
  directoryId: string,
  scope: ScopedWorkItemListScope,
  keepReadable: (issues: TeamIssueResponseItem[]) => TeamIssueResponseItem[] = (issues) => issues,
): Promise<TeamIssueResponseItem[]> {
  const issues: TeamIssueResponseItem[] = []
  let startAfter: SortedWorkItemPagePosition | undefined
  do {
    const page = await readSortedPage(
      directoryId,
      scope,
      SCOPED_WORK_ITEM_PAGE_MAX_LIMIT,
      startAfter,
    )
    issues.push(...keepReadable(page.issues))
    if (issues.length > SCOPED_WORK_ITEM_LEGACY_MAX_ITEMS) {
      throw new ProjectDataError(
        413,
        'WorkItemListLimitExceeded',
        `This ${scope.kind === 'team' ? 'Team' : 'Project'} has more than ` +
          `${SCOPED_WORK_ITEM_LEGACY_MAX_ITEMS} Work Items. Request pages with limit and cursor.`,
      )
    }
    startAfter = page.nextPosition
  } while (startAfter)
  return issues
}

/**
 * Reads one bounded sort-order page through the Work Item port.
 *
 * @param directoryId - Caller's Workspace directory.
 * @param scope - Team or Project list and its filters.
 * @param limit - Largest number of Work Items to return.
 * @param startAfter - Position to resume after.
 * @returns The page and where the next page starts.
 */
function readSortedPage(
  directoryId: string,
  scope: ScopedWorkItemListScope,
  limit: number,
  startAfter: SortedWorkItemPagePosition | undefined,
): Promise<SortedWorkItemPage> {
  const options = {
    limit,
    maxEvaluatedRows: WORK_ITEMS_PAGE_SCAN_BUDGET,
    includeArchived: scope.includeArchived,
    ...(scope.workItemTypeId ? { workItemTypeId: scope.workItemTypeId } : {}),
    ...(startAfter ? { startAfter } : {}),
  }
  return scope.kind === 'team'
    ? workItemDependencies.teamIssues.getTeamIssuePage(directoryId, scope.id, options)
    : workItemDependencies.teamIssues.getProjectIssuePage(directoryId, scope.id, options)
}

/**
 * Normalizes a requested page size.
 *
 * @param value - Raw `limit` query value.
 * @returns A page size between 1 and the contract maximum.
 */
function readScopedWorkItemPageLimit(value: string | undefined): number {
  if (value === undefined || value === '') return SCOPED_WORK_ITEM_PAGE_DEFAULT_LIMIT
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SCOPED_WORK_ITEM_PAGE_MAX_LIMIT) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemPageLimit',
      `Work Item page limit must be between 1 and ${SCOPED_WORK_ITEM_PAGE_MAX_LIMIT}.`,
    )
  }
  return limit
}

/**
 * Creates a fingerprint that binds a cursor to its list scope and filters.
 *
 * @param scope - Team or Project list and its filters.
 * @returns A short digest.
 */
function createScopedWorkItemPageFingerprint(scope: ScopedWorkItemListScope): string {
  const canonical = JSON.stringify([
    scope.kind,
    scope.id,
    scope.includeArchived,
    scope.workItemTypeId ?? null,
  ])
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 16)
}

/**
 * Encodes the position after which the next page starts.
 *
 * @param position - Last evaluated Work Item.
 * @param fingerprint - Fingerprint of the list scope and filters.
 * @returns Opaque cursor string.
 */
function encodeScopedWorkItemPageCursor(
  position: SortedWorkItemPagePosition,
  fingerprint: string,
): string {
  const cursor: ScopedWorkItemPageCursor = {
    v: 1,
    f: fingerprint,
    s: position.sortOrder,
    t: position.teamId,
    i: position.issueId,
  }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/**
 * Decodes and validates a page cursor.
 *
 * @param value - Opaque cursor from the request.
 * @param fingerprint - Fingerprint of the current request's scope and filters.
 * @returns The position to resume after, or `undefined` for the first page.
 */
function decodeScopedWorkItemPageCursor(
  value: string | undefined,
  fingerprint: string,
): SortedWorkItemPagePosition | undefined {
  if (value === undefined || value === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw invalidScopedWorkItemPageCursor()
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('v' in parsed) || parsed.v !== 1 ||
    !('f' in parsed) || parsed.f !== fingerprint ||
    !('s' in parsed) || typeof parsed.s !== 'number' || !Number.isFinite(parsed.s) ||
    !('t' in parsed) || typeof parsed.t !== 'string' || !parsed.t ||
    !('i' in parsed) || typeof parsed.i !== 'string' || !parsed.i
  ) {
    throw invalidScopedWorkItemPageCursor()
  }
  return { sortOrder: parsed.s, teamId: parsed.t, issueId: parsed.i }
}

/**
 * Creates the error for a malformed cursor or one issued for another list or filter.
 *
 * @returns The 400 project data error.
 */
function invalidScopedWorkItemPageCursor(): ProjectDataError {
  return new ProjectDataError(
    400,
    'InvalidWorkItemPageCursor',
    'Work Item page cursor is invalid or was issued for different filters.',
  )
}
