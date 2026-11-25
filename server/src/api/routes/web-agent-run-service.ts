import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import {
  FACTORY_BOARD_COMPLETED_WINDOW_HOURS,
  FACTORY_BOARD_MAX_ACTIVE_RUNS,
  FACTORY_BOARD_MAX_EVALUATED_FINISHED_RUNS,
  FACTORY_BOARD_MAX_EVALUATED_WORK_ITEMS,
  FACTORY_BOARD_REPORT_EXCERPT_MAX_LENGTH,
  classifyFactoryBoardItem,
  type AgentRunReport,
  type AgentRunUsage,
  type AgentRunView,
  type AgentSettings,
  type FactoryBoardItem,
  type FactoryBoardReportSummary,
  type TeamAgentRunBoardResponse,
  type WorkItemAgentRunReportsResponse,
  type WorkItemAgentRunsResponse,
} from '@mukuroji/contracts'
import {
  AgentRunError,
  combineAgentRunUsage,
  createAgentRunIntegrityError,
  createAgentRunNotActiveError,
  createAgentRunReportCommentBody,
  finishAgentRun,
  assertAgentSettingsBriefLimits,
  readUpdateAgentSettingsRequest,
  toAgentRun,
  toAgentRunReport,
  type AgentRunFinishedGroup,
  type StoredAgentRun,
} from '../../modules/agent-runs'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { CognitoServiceError, isCognitoUserNotFoundError, type CognitoUserProfile } from '../../modules/authentication'
import {
  createMutationAuditEventPut,
  getConfiguredAuditTableName,
  type MutationAuditContext,
} from '../../modules/audit/audit'
import { createWorkItemCollaborationEntityKey } from '../../modules/collaboration'
import { ProjectDataError } from '../../modules/directory'
import { isTeamIssueNotFoundError, type TeamIssueResponseItem } from '../../modules/work-items'
import { createWorkItemRevisionConditionCheck } from '../../modules/work-items/adapter-out/dynamodb/work-item-client'
import {
  commitProgressFencedClose,
  createAgentRunAuditPut,
  mapInOrderWithConcurrency,
  retryProgressFencedClose,
  withVisibleProjectBriefs,
} from '../shared/agent-run-access'
import { authenticationDependencies, developerPlatformDependencies, workItemDependencies } from '../shared/app-dependencies'
import {
  canAccessAssignedProject,
  canWorkspaceBusinessWrite,
  requireAssignedProjectPermission,
  requireTeamPermission,
  requireWorkspaceBusinessWrite,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { getTeamIssuesTableName, loadAuthorizedTeamIssue } from '../shared/work-item-access'
import { readAgentRunUsage } from '../shared/agent-run-usage-access'
import { isRecord } from '../shared/value-guards'
import { readWorkspaceMemberNamesForDisplay, type TeamPermissionContext } from '../shared/workspace-access'
import { withCurrentAnswer } from './web-agent-run-answer-service'

/**
 * Checks whether the principal manages the Team.
 *
 * @param principal - Authorized principal.
 * @param teamId - Team ID.
 * @returns True for Team managers and system administrators.
 */
export async function isTeamManager(principal: WorkspacePrincipal, teamId: string): Promise<boolean> {
  try {
    await requireTeamPermission(principal, teamId, 'manager')
    return true
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) return false
    throw error
  }
}

/**
 * Checks the write access a release requires before {@link mayRelease} applies, so the history
 * never offers a release that {@link releaseWebAgentRun} would reject.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param assignedProjectId - Project the run's Work Item is assigned to.
 * @returns True when the viewer may write the Work Item.
 */
async function canWriteForRelease(
  principal: WorkspacePrincipal,
  teamId: string,
  assignedProjectId: string | undefined,
): Promise<boolean> {
  if (!canWorkspaceBusinessWrite(principal)) return false
  try {
    const context = await requireTeamPermission(principal, teamId, 'member')
    requireAssignedProjectPermission(principal, context, assignedProjectId, 'member')
    return true
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) return false
    throw error
  }
}

/**
 * Reads the Team write access a release requires once for a whole board. The Project part of
 * {@link canWriteForRelease} is then checked per Work Item with the returned context.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @returns The viewer's member-level Team context, or undefined when the viewer cannot write.
 */
async function canWriteTeamForRelease(principal: WorkspacePrincipal, teamId: string): Promise<TeamPermissionContext | undefined> {
  if (!canWorkspaceBusinessWrite(principal)) return undefined
  try {
    return await requireTeamPermission(principal, teamId, 'member')
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) return undefined
    throw error
  }
}

/**
 * Checks whether a member may release a run: a Team manager, the member who started it, or the
 * Work Item's current assignee, who is responsible for the work after a reassignment.
 *
 * @param run - Stored run.
 * @param principal - Viewer.
 * @param manager - Whether the viewer manages the Team.
 * @param workItemAssigneeUserId - Current assignee of the run's Work Item.
 * @returns True when the viewer may release the run.
 */
function mayRelease(run: StoredAgentRun, principal: WorkspacePrincipal, manager: boolean, workItemAssigneeUserId: string): boolean {
  return manager || run.assigneeUserId === principal.userKey || workItemAssigneeUserId === principal.userKey
}

/**
 * Projects a run for the Web application with the actions the viewer may take.
 *
 * @param run - Stored run.
 * @param canRelease - Whether the viewer may release the run while it is active.
 * @param now - Read time.
 * @param usage - Usage attributed to the run, if any.
 * @param credentialNames - API key names for a Team manager; the starting credential is shown only when given.
 * @returns Run view.
 */
function toAgentRunView(
  run: StoredAgentRun,
  canRelease: boolean,
  now: Date,
  usage?: AgentRunUsage,
  credentialNames?: ReadonlyMap<string, string>,
): AgentRunView {
  const credentialName = credentialNames?.get(run.credentialId)
  return {
    ...toAgentRun(run, now),
    canRelease: run.state === 'active' && canRelease,
    ...(run.resumedFromRunId === undefined ? {} : { resumedFromRunId: run.resumedFromRunId }),
    ...(usage === undefined ? {} : { usage }),
    ...(credentialNames === undefined
      ? {}
      : {
          startedBy: {
            credentialId: run.credentialId,
            ...(credentialName === undefined ? {} : { credentialName }),
            instanceIdHash: run.instanceIdHash,
          },
        }),
  }
}

/**
 * Reads the API key names of a Workspace so a Team manager sees which credential started a run. A
 * failed read only leaves the names out; the credential IDs are still shown.
 *
 * @param manager - Whether the viewer manages the Team; other viewers get no credentials.
 * @param directoryId - Workspace ID.
 * @returns Names by credential ID for a manager, otherwise undefined.
 */
async function readCredentialNamesForManager(manager: boolean, directoryId: string): Promise<ReadonlyMap<string, string> | undefined> {
  if (!manager) return undefined
  try {
    const apiKeys = await developerPlatformDependencies.apiKeys.listApiKeys(directoryId)
    return new Map(apiKeys.map((apiKey) => [apiKey.id, apiKey.name]))
  } catch (error) {
    console.warn('Agent Run credential names could not be read.', error instanceof Error ? error.name : 'unknown')
    return new Map()
  }
}

/**
 * Lists a Work Item's newest runs with the release action each viewer may take. Store cursors,
 * which encode table keys, never leave the server.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @param limit - Number of runs from 1 to 100.
 * @returns Newest runs and whether older ones exist.
 */
export async function listWebWorkItemAgentRuns(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  limit: number,
): Promise<WorkItemAgentRunsResponse> {
  const { detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
  const page = await workItemDependencies.agentRuns.listWorkItemRuns(principal.directoryId, teamId, workItemId, undefined, limit)
  const [manager, writable] = await Promise.all([
    isTeamManager(principal, teamId),
    canWriteForRelease(principal, teamId, detail.issue.assignedProjectId),
  ])
  const credentialNames = await readCredentialNamesForManager(manager, principal.directoryId)
  const now = new Date()
  // Tokens are visible to every viewer of the Work Item; the estimated cost only to Team managers.
  const usages = await Promise.all(page.runs.map((run) => readAgentRunUsage(principal.directoryId, run, manager)))
  const usageTotal = combineAgentRunUsage(usages)
  return {
    items: page.runs.map((run, index) => toAgentRunView(
      run,
      writable && mayRelease(run, principal, manager, detail.issue.assigneeUserId),
      now,
      usages[index],
      credentialNames,
    )),
    hasMore: page.nextCursor !== undefined,
    ...(usageTotal === undefined ? {} : { usageTotal }),
  }
}

/**
 * Serialized size a page of reports may reach. One report holds at most about 200 KB, so a page
 * always fits the buffered Lambda response limit and still holds several reports.
 */
const maximumReportPageBytes = 1_000_000

/**
 * Lists a Work Item's newest structured reports for anyone who can see the Work Item. Store cursors
 * never leave the server. The page stops early once its serialized size reaches the byte budget.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @param limit - Number of reports from 1 to 100.
 * @returns Newest reports and whether older ones exist.
 */
export async function listWebWorkItemAgentRunReports(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  limit: number,
): Promise<WorkItemAgentRunReportsResponse> {
  await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
  const page = await workItemDependencies.agentRuns.listWorkItemReports(principal.directoryId, teamId, workItemId, undefined, limit)
  const items: AgentRunReport[] = []
  let bytes = 0
  const current = await Promise.all(page.reports.map((stored) => withCurrentAnswer(principal.directoryId, stored)))
  for (const stored of current) {
    const report = toAgentRunReport(stored)
    bytes += Buffer.byteLength(JSON.stringify(report))
    // The newest report is always returned, so a page is never empty while reports exist.
    if (items.length > 0 && bytes > maximumReportPageBytes) return { items, hasMore: true }
    items.push(report)
  }
  return { items, hasMore: page.nextCursor !== undefined }
}

/** Runs and Work Items the board reads per store request; the store and Work Item page maximum. */
const boardPageSize = 100

/** Concurrent per-Work Item reads while the board is assembled. */
const boardReadConcurrency = 10

/** Milliseconds in one hour. */
const millisecondsPerHour = 3_600_000

/**
 * Reads one Work Item strongly for the board, so a move to another Project, an archive, or a deletion
 * takes effect immediately.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @returns The Work Item, or undefined when it was deleted or archived.
 */
async function readBoardWorkItem(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
): Promise<TeamIssueResponseItem | undefined> {
  try {
    const { issue } = await workItemDependencies.teamIssues.getTeamIssueDetail(
      principal.directoryId,
      teamId,
      workItemId,
      { consistentIssueRead: true, includeEvents: false },
    )
    return issue.archivedAt === undefined ? issue : undefined
  } catch (error) {
    if (isTeamIssueNotFoundError(error)) return undefined
    throw error
  }
}

/** Where each board source continues on the next board page; absent sources are finished. */
type FactoryBoardContinuation = {
  /** Cursor of the active-run lease index. */
  active?: string
  /** Cursor of the finished-run index group of runs that did not fail. */
  recent?: string
  /** Cursor of the finished-run index group of failed runs. */
  failed?: string
  /** Cursor of the Team's started Work Item index. */
  started?: string
  /** Start of the completed-lane window the first page used, as an ISO time. */
  since: string
}

/** Longest store cursor a board continuation may carry; store cursors are far shorter. */
const boardContinuationCursorMaxLength = 2_048

/** Source fields of {@link FactoryBoardContinuation}. */
const boardContinuationSources = ['active', 'recent', 'failed', 'started'] as const

/** Envelope version of a sealed board continuation; also bound into its authentication. */
const boardContinuationEnvelope = 'b1'

/** Label that derives the board continuation key from the server cursor secret. */
const boardContinuationKeyLabel = 'mukuroji:factory-board-continuation:v1'

/** Byte lengths of the AES-GCM nonce and tag of a sealed continuation. */
const boardContinuationIvBytes = 12
const boardContinuationTagBytes = 16

/** Base64url text, the only alphabet of a sealed continuation part. */
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u

/** Viewer and Team a board continuation is bound to. */
type FactoryBoardContinuationScope = {
  /** Workspace ID. */
  directoryId: string
  /** Team ID. */
  teamId: string
  /** Viewer the continuation was issued to. */
  userKey: string
}

/** Key derived from the server cursor secret, resolved on first use. */
let boardContinuationKey: Buffer | undefined

/**
 * Returns the AES-256-GCM key of board continuations.
 *
 * @returns 32-byte key used only for board continuations.
 */
function getBoardContinuationKey(): Buffer {
  boardContinuationKey ??= createHmac('sha256', loadServerConfig().publicApiCursorSecret)
    .update(boardContinuationKeyLabel)
    .digest()
  return boardContinuationKey
}

/**
 * Builds the additional authenticated data that binds a continuation to its viewer and Team.
 *
 * @param scope - Viewer and Team.
 * @returns Authenticated data.
 */
function boardContinuationAad(scope: FactoryBoardContinuationScope): Buffer {
  return Buffer.from(JSON.stringify([boardContinuationEnvelope, scope.directoryId, scope.teamId, scope.userKey]), 'utf8')
}

/**
 * Seals the sources left unread so the board can load the rest on request. The store cursors carry
 * DynamoDB keys, and a page can stop on a Work Item the viewer cannot see, so the token is encrypted
 * and authenticated for the viewer and Team: the client can neither read nor forge it.
 *
 * @param continuation - Sources to continue and the completed-lane window.
 * @param scope - Viewer and Team the token is issued to.
 * @returns Opaque token, or undefined when every source was read to its end.
 */
function encodeBoardContinuation(continuation: FactoryBoardContinuation, scope: FactoryBoardContinuationScope): string | undefined {
  if (boardContinuationSources.every((source) => continuation[source] === undefined)) return undefined
  const iv = randomBytes(boardContinuationIvBytes)
  const cipher = createCipheriv('aes-256-gcm', getBoardContinuationKey(), iv, { authTagLength: boardContinuationTagBytes })
  cipher.setAAD(boardContinuationAad(scope))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ version: 1, ...continuation }), 'utf8'), cipher.final()])
  return [boardContinuationEnvelope, iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
}

/**
 * Opens a sealed board continuation token.
 *
 * @param value - Token from the query string.
 * @param scope - Viewer and Team of the request.
 * @returns The token's plaintext.
 * @throws Error when the token is malformed, tampered with, or issued to another viewer or Team.
 */
function openBoardContinuation(value: string, scope: FactoryBoardContinuationScope): unknown {
  const parts = value.split('.')
  if (parts.length !== 4 || parts[0] !== boardContinuationEnvelope || !parts.slice(1).every((part) => base64UrlPattern.test(part))) {
    throw new TypeError('Unsupported continuation envelope.')
  }
  const [, ivText = '', ciphertextText = '', tagText = ''] = parts
  const iv = Buffer.from(ivText, 'base64url')
  const tag = Buffer.from(tagText, 'base64url')
  if (iv.length !== boardContinuationIvBytes || tag.length !== boardContinuationTagBytes) throw new TypeError('Malformed continuation.')
  const decipher = createDecipheriv('aes-256-gcm', getBoardContinuationKey(), iv, { authTagLength: boardContinuationTagBytes })
  decipher.setAAD(boardContinuationAad(scope))
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()])
  return JSON.parse(plaintext.toString('utf8'))
}

/**
 * Validates a client-supplied board continuation token for the requesting viewer and Team.
 *
 * @param value - Token from the query string.
 * @param principal - Viewer.
 * @param teamId - Team of the request.
 * @returns Decoded continuation.
 * @throws AgentRunError when the token is malformed, tampered with, or issued for another viewer or Team.
 */
export function readFactoryBoardContinuation(value: string, principal: WorkspacePrincipal, teamId: string): FactoryBoardContinuation {
  const invalid = () => new AgentRunError('validation_failed', 'The board continuation is invalid.', { pointer: '/continuation' })
  if (value.length > boardContinuationCursorMaxLength * boardContinuationSources.length * 2) throw invalid()
  let parsed: unknown
  try {
    parsed = openBoardContinuation(value, { directoryId: principal.directoryId, teamId, userKey: principal.userKey })
  } catch {
    throw invalid()
  }
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.since !== 'string' || !Number.isFinite(Date.parse(parsed.since))) {
    throw invalid()
  }
  const continuation: FactoryBoardContinuation = { since: new Date(parsed.since).toISOString() }
  for (const source of boardContinuationSources) {
    const cursor = parsed[source]
    if (cursor === undefined) continue
    if (typeof cursor !== 'string' || cursor === '' || cursor.length > boardContinuationCursorMaxLength) throw invalid()
    continuation[source] = cursor
  }
  if (boardContinuationSources.every((source) => continuation[source] === undefined)) throw invalid()
  return continuation
}

/**
 * Reads a Team's active runs again from the run rows, because the lease index can still show a run
 * that just finished. Two active runs on one Work Item break the claim invariant and fail closed.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param cursor - Where the previous board page stopped, or undefined for the first page.
 * @returns Active runs by Work Item ID, in lease order, and the cursor of the runs left unread.
 */
async function readBoardActiveRuns(
  principal: WorkspacePrincipal,
  teamId: string,
  cursor: string | undefined,
): Promise<{ runs: Map<string, StoredAgentRun>; nextCursor?: string }> {
  const store = workItemDependencies.agentRuns
  const page = await store.listActiveRuns(principal.directoryId, teamId, cursor, FACTORY_BOARD_MAX_ACTIVE_RUNS)
  const current = await mapInOrderWithConcurrency(page.runs, boardReadConcurrency, async (indexed) => {
    const run = await store.getRun(principal.directoryId, teamId, indexed.runId)
    if (run && run.workItemId !== indexed.workItemId) throw createAgentRunIntegrityError()
    return run?.state === 'active' ? run : undefined
  })
  const runs = new Map<string, StoredAgentRun>()
  for (const run of current) {
    if (!run) continue
    if (runs.has(run.workItemId)) throw createAgentRunIntegrityError()
    runs.set(run.workItemId, run)
  }
  return { runs, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) }
}

/**
 * Reads one group of the finished-run index up to the board bound. The completed lane reads the
 * runs that finished within its window, and the failed lane reads every failed run, which stays on
 * the board without a time limit; the board then shows each Work Item by its newest run. Both come
 * from the finished-run index, newest finish first, so the Team's older finished runs are never
 * read.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param group - Failed runs or the other finished runs.
 * @param since - When given, only runs that finished at or after this ISO time.
 * @param startCursor - Where the previous board page stopped, or undefined for the first page.
 * @returns Work Item IDs and the cursor of the runs left unread.
 */
async function readFinishedRunWorkItemIds(
  principal: WorkspacePrincipal,
  teamId: string,
  group: AgentRunFinishedGroup,
  since: string | undefined,
  startCursor: string | undefined,
): Promise<{ workItemIds: string[]; nextCursor?: string }> {
  const workItemIds = new Set<string>()
  let evaluated = 0
  let cursor = startCursor
  do {
    const limit = Math.min(boardPageSize, FACTORY_BOARD_MAX_EVALUATED_FINISHED_RUNS - evaluated)
    const page = await workItemDependencies.agentRuns.listFinishedRunsByTime(principal.directoryId, teamId, group, since, cursor, limit)
    evaluated += limit
    for (const run of page.runs) workItemIds.add(run.workItemId)
    cursor = page.nextCursor
  } while (cursor !== undefined && evaluated < FACTORY_BOARD_MAX_EVALUATED_FINISHED_RUNS)
  return { workItemIds: [...workItemIds], ...(cursor === undefined ? {} : { nextCursor: cursor }) }
}

/**
 * Collects the Team's `started` Work Items from the sparse started index, most recently updated
 * first, so Work Items in other status categories never use up the bound (ADR 0098). The board
 * reads each of them again strongly and checks the viewer's Project access before it shows them.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param startCursor - Where the previous board page stopped, or undefined for the first page.
 * @returns Work Item IDs and the cursor of the Work Items left unread.
 */
async function readStartedWorkItemIds(
  principal: WorkspacePrincipal,
  teamId: string,
  startCursor: string | undefined,
): Promise<{ workItemIds: string[]; nextCursor?: string }> {
  const workItemIds: string[] = []
  let evaluated = 0
  let cursor = startCursor
  do {
    const limit = Math.min(boardPageSize, FACTORY_BOARD_MAX_EVALUATED_WORK_ITEMS - evaluated)
    const page = await workItemDependencies.teamIssues.listStartedWorkItemIds(principal.directoryId, teamId, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    })
    evaluated += limit
    workItemIds.push(...page.workItemIds)
    cursor = page.nextCursor
  } while (cursor !== undefined && evaluated < FACTORY_BOARD_MAX_EVALUATED_WORK_ITEMS)
  return { workItemIds, ...(cursor === undefined ? {} : { nextCursor: cursor }) }
}

/**
 * Removes the agent label the server put in front of a report message and shortens the rest.
 *
 * @param body - Current comment body.
 * @param agentName - Agent name of the run.
 * @returns Excerpt, or undefined when nothing remains.
 */
function toReportExcerpt(body: string, agentName: string): string | undefined {
  const label = createAgentRunReportCommentBody(agentName, '')
  const message = (body.startsWith(label) ? body.slice(label.length) : body).trim()
  if (message === '') return undefined
  return [...message].slice(0, FACTORY_BOARD_REPORT_EXCERPT_MAX_LENGTH).join('')
}

/**
 * Summarizes the latest report of a run with the start of its comment. The comment is read at request
 * time, so an edited or deleted comment never shows its earlier text on the board.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param run - Run on the tile.
 * @returns Report summary, or undefined when the run has no report.
 */
async function readBoardReportSummary(
  principal: WorkspacePrincipal,
  teamId: string,
  run: StoredAgentRun,
): Promise<FactoryBoardReportSummary | undefined> {
  if (run.reportCount === 0) return undefined
  const page = await workItemDependencies.agentRuns.listWorkItemReports(principal.directoryId, teamId, run.workItemId, undefined, 1)
  const latest = page.reports[0]
  // The newest report of the Work Item belongs to its newest run whenever that run has reports.
  if (!latest || latest.runId !== run.runId) return undefined
  const report = toAgentRunReport(latest)
  const comment = await workItemDependencies.collaboration.getCommentSnapshot({
    entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, run.workItemId),
    commentId: report.commentId,
  })
  const excerpt = comment && comment.deletedAt === undefined ? toReportExcerpt(comment.bodyMarkdown, run.agentName) : undefined
  const verificationCounts = { passed: 0, failed: 0, skipped: 0 }
  for (const verification of report.verifications) verificationCounts[verification.status] += 1
  return {
    runId: report.runId,
    sequence: report.sequence,
    kind: report.kind,
    createdAt: report.createdAt,
    ...(excerpt === undefined ? {} : { excerpt }),
    verificationCounts,
    artifactCount: report.artifacts.length,
    ...(report.changedFileCount === undefined ? {} : { changedFileCount: report.changedFileCount }),
  }
}

/** Longest time the board waits for assignee profiles before it shows the rest by member ID. */
const boardProfileDeadlineMs = 2_000

/**
 * Reads the profiles of the members assigned to board Work Items, so the board can show names
 * instead of member IDs. An empty member ID is not looked up. A profile that is missing, fails to
 * load, or is not read within the deadline is left out, and that member keeps showing by ID; a
 * profile lookup never fails or stalls the board. Lookups already sent when the deadline passes are
 * left to finish, since the user directory port takes no abort signal, but no new one starts.
 *
 * @param log - Request correlation ID and Team, logged with a failed lookup.
 * @param userIds - Assignee member IDs.
 * @returns Profiles read by the deadline, by member ID.
 */
async function readBoardAssigneeProfiles(
  log: { correlationId: string | undefined; teamId: string },
  userIds: string[],
): Promise<Map<string, CognitoUserProfile>> {
  const unique = [...new Set(userIds)].filter((userId) => userId !== '')
  const byUserId = new Map<string, CognitoUserProfile>()
  let expired = false
  const lookups = mapInOrderWithConcurrency(unique, boardReadConcurrency, async (userId) => {
    if (expired) return
    try {
      const profile = await authenticationDependencies.cognito.getUserProfile(userId)
      if (!expired) byUserId.set(userId, profile)
    } catch (error) {
      if (!isCognitoUserNotFoundError(error)) {
        // The error message can carry the member's address, so only its code is logged.
        const code = error instanceof CognitoServiceError ? error.code : error instanceof Error ? error.name : 'Unknown'
        console.warn('Failed to read a Factory board assignee profile:', { ...log, code })
      }
    }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, boardProfileDeadlineMs)
  })
  await Promise.race([lookups, deadline])
  clearTimeout(timer)
  expired = true
  return new Map(byUserId)
}

/**
 * Reads the Workspace member names the board shows for assignees, within the same deadline as the
 * profile lookups. A failed or late read yields undefined, so the board still returns and shows
 * those assignees by email or member ID; a name lookup never fails or stalls the board.
 *
 * @param log - Request correlation ID and Team, logged with a failed read.
 * @param directoryId - Workspace ID.
 * @returns Name per lower-cased member key, or undefined when the names were not read in time.
 */
async function readBoardWorkspaceNames(
  log: { correlationId: string | undefined; teamId: string },
  directoryId: string,
): Promise<Map<string, string | undefined> | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), boardProfileDeadlineMs)
  })
  const read = readWorkspaceMemberNamesForDisplay(directoryId).catch((error: unknown) => {
    const code = error instanceof Error ? error.name : 'Unknown'
    console.warn('Failed to read Factory board assignee names:', { ...log, code })
    return undefined
  })
  try {
    return await Promise.race([read, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Lists the Factory board of a Team for anyone who can view the Team: the Work Items of active runs,
 * of runs that finished within the completed-lane window, of failed runs, and the `started` Work
 * Items, each with its active or newest run and that run's latest report. Only Work Items the
 * viewer can see and that belong to a lane are returned. Every source is read up to a fixed bound;
 * a source that stopped early sets its `...HasMore` flag and continues from the returned
 * `continuation` token on the next request, which reads only the sources left unread.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param correlationId - Correlation ID of the request, logged with a failed profile lookup.
 * @param continuation - Sources to continue from a previous page, or undefined for the first page.
 * @returns Board items, the bounds that were reached, and the token of the next page.
 */
export async function listWebTeamAgentRunBoard(
  principal: WorkspacePrincipal,
  teamId: string,
  correlationId?: string,
  continuation?: FactoryBoardContinuation,
): Promise<TeamAgentRunBoardResponse> {
  const permission = await requireTeamPermission(principal, teamId, 'viewer')
  const completedWindow = FACTORY_BOARD_COMPLETED_WINDOW_HOURS * millisecondsPerHour
  // Every page of one board is evaluated at the first page's read time: the completed-lane window
  // starts where the first page started it, and lanes and stalled leases use the same time, so a
  // later page neither drops a run the first page's window holds nor classifies it differently.
  const now = continuation === undefined ? new Date() : new Date(Date.parse(continuation.since) + completedWindow)
  const since = continuation?.since ?? new Date(now.getTime() - completedWindow).toISOString()
  const empty: { workItemIds: string[]; nextCursor?: string } = { workItemIds: [] }
  const noActiveRuns: { runs: Map<string, StoredAgentRun>; nextCursor?: string } = { runs: new Map() }
  const [active, recent, failed, started, manager, writable] = await Promise.all([
    continuation === undefined || continuation.active !== undefined
      ? readBoardActiveRuns(principal, teamId, continuation?.active)
      : noActiveRuns,
    continuation === undefined || continuation.recent !== undefined
      ? readFinishedRunWorkItemIds(principal, teamId, 'other', since, continuation?.recent)
      : empty,
    continuation === undefined || continuation.failed !== undefined
      ? readFinishedRunWorkItemIds(principal, teamId, 'failed', undefined, continuation?.failed)
      : empty,
    continuation === undefined || continuation.started !== undefined
      ? readStartedWorkItemIds(principal, teamId, continuation?.started)
      : empty,
    isTeamManager(principal, teamId),
    canWriteTeamForRelease(principal, teamId),
  ])
  const credentialNames = await readCredentialNamesForManager(manager, principal.directoryId)
  const finished = { workItemIds: [...new Set([...recent.workItemIds, ...failed.workItemIds])] }
  const nextContinuation = encodeBoardContinuation({
    since,
    ...(active.nextCursor !== undefined ? { active: active.nextCursor } : {}),
    ...(recent.nextCursor !== undefined ? { recent: recent.nextCursor } : {}),
    ...(failed.nextCursor !== undefined ? { failed: failed.nextCursor } : {}),
    ...(started.nextCursor !== undefined ? { started: started.nextCursor } : {}),
  }, { directoryId: principal.directoryId, teamId, userKey: principal.userKey })
  const workItemIds = [...new Set([...active.runs.keys(), ...finished.workItemIds, ...started.workItemIds])]
  const store = workItemDependencies.agentRuns
  const items = await mapInOrderWithConcurrency(workItemIds, boardReadConcurrency, async (workItemId) => {
    const workItem = await readBoardWorkItem(principal, teamId, workItemId)
    if (!workItem || !canAccessAssignedProject(principal, permission, workItem.assignedProjectId, 'viewer')) return undefined
    const run = active.runs.get(workItemId) ??
      (await store.listWorkItemRuns(principal.directoryId, teamId, workItemId, undefined, 1)).runs[0]
    const latestReport = run ? await readBoardReportSummary(principal, teamId, run) : undefined
    const canRelease = run !== undefined && writable !== undefined &&
      canAccessAssignedProject(principal, writable, workItem.assignedProjectId, 'member') &&
      mayRelease(run, principal, manager, workItem.assigneeUserId)
    const item: FactoryBoardItem = {
      workItem: {
        id: workItem.id,
        title: workItem.title,
        workflowStatusId: workItem.workflowStatusId,
        statusCategory: workItem.statusCategory,
        ...(workItem.assignedProjectId === undefined ? {} : { assignedProjectId: workItem.assignedProjectId }),
        assigneeUserId: workItem.assigneeUserId,
      },
      ...(run === undefined ? {} : { run: toAgentRunView(run, canRelease, now, undefined, credentialNames) }),
      ...(latestReport === undefined ? {} : { latestReport }),
    }
    return classifyFactoryBoardItem(item, now) === undefined ? undefined : item
  })
  const boardItems = items.flatMap((item) => item ? [item] : [])
  const log = { correlationId, teamId }
  const assigneeIds = boardItems.map((item) => item.workItem.assigneeUserId)
  const [profiles, workspaceNames] = await Promise.all([
    readBoardAssigneeProfiles(log, assigneeIds),
    assigneeIds.some((userId) => userId !== '')
      ? readBoardWorkspaceNames(log, principal.directoryId)
      : Promise.resolve(new Map<string, string | undefined>()),
  ])
  return {
    generatedAt: now.toISOString(),
    items: boardItems.map((item) => {
      const profile = profiles.get(item.workItem.assigneeUserId)
      if (!profile) return item
      // Members rename themselves on their Workspace member row (ADR 0074); Cognito keeps the
      // sign-up name, so the member row's name wins and a cleared one shows the email. Without
      // the member rows the sign-up name could be stale, so the assignee shows by email.
      const memberKey = profile.email.trim().toLowerCase()
      const name = workspaceNames === undefined
        ? undefined
        : workspaceNames.has(memberKey) ? workspaceNames.get(memberKey) : profile.name
      return {
        ...item,
        workItem: {
          ...item.workItem,
          ...(name === undefined || name === '' ? {} : { assigneeName: name }),
          ...(profile.email === '' ? {} : { assigneeEmail: profile.email }),
        },
      }
    }),
    activeRunsHasMore: active.nextCursor !== undefined,
    finishedRunsHasMore: (recent.nextCursor !== undefined) ||
      (failed.nextCursor !== undefined),
    startedWorkItemsHasMore: started.nextCursor !== undefined,
    ...(nextContinuation === undefined ? {} : { continuation: nextContinuation }),
  }
}

/**
 * Releases an active run for a Team manager, the member who started it, or the Work Item's current
 * assignee. When only the current assignment grants the authority, the release commits only while
 * the Work Item is still at the revision that was read.
 *
 * @param principal - Releasing member.
 * @param teamId - Team ID.
 * @param runId - Run ID.
 * @param auditContext - Audit context of the request.
 * @returns The released run; a repeated release returns it unchanged.
 */
export async function releaseWebAgentRun(
  principal: WorkspacePrincipal,
  teamId: string,
  runId: string,
  auditContext: MutationAuditContext,
): Promise<AgentRunView> {
  requireWorkspaceBusinessWrite(principal)
  const store = workItemDependencies.agentRuns
  // The returned run is built from the run as read, so a report or heartbeat that commits first
  // sends the release back to read the run again.
  return retryProgressFencedClose(async () => {
    const run = await store.getRun(principal.directoryId, teamId, runId)
    if (!run) throw new AgentRunError('not_found', 'Agent Run was not found.')
    const { detail } = await loadAuthorizedTeamIssue(principal, teamId, run.workItemId, 'member')
    const manager = await isTeamManager(principal, teamId)
    if (!mayRelease(run, principal, manager, detail.issue.assigneeUserId)) {
      throw new AgentRunError('forbidden', 'Only the Work Item assignee or a Team manager can release an Agent Run.')
    }
    const now = new Date()
    if (run.state !== 'active') {
      if (run.outcome === 'released') return toAgentRunView(run, true, now)
      throw createAgentRunNotActiveError()
    }
    const released = finishAgentRun(run, 'released', principal.userKey, now)
    const auditPut = createAgentRunAuditPut(auditContext, released, 'released', 'Agent Run was released by a member.')
    const closeItems = store.createCloseItems(released, undefined, true)
    const assignmentOnly = !manager && run.assigneeUserId !== principal.userKey
    const committed = await commitProgressFencedClose([
      ...closeItems,
      ...(assignmentOnly
        ? [createWorkItemRevisionConditionCheck(
            getTeamIssuesTableName(),
            principal.directoryId,
            teamId,
            run.workItemId,
            detail.issue.revision,
          )]
        : []),
      ...(auditPut ? [auditPut] : []),
    ], closeItems.length, run)
    return committed ? toAgentRunView(released, true, now) : undefined
  })
}

/**
 * Measures a brief for the audit trail without recording its text.
 *
 * @param brief - Brief, if any.
 * @returns UTF-8 size in bytes; `0` when there is none.
 */
function briefBytes(brief: string | undefined): number {
  return brief === undefined ? 0 : Buffer.byteLength(brief, 'utf8')
}

/**
 * Reads Team Agent settings for a Team the viewer can see.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @returns Current settings or the defaults.
 */
export async function getWebAgentSettings(principal: WorkspacePrincipal, teamId: string): Promise<AgentSettings> {
  const permission = await requireTeamPermission(principal, teamId, 'viewer')
  return withVisibleProjectBriefs(principal, permission, await workItemDependencies.agentRuns.getSettings(principal.directoryId, teamId))
}

/**
 * Saves Team Agent settings for a Team manager with revision CAS and an audit event. The body is
 * validated only after the caller is authorized.
 *
 * @param principal - Team manager.
 * @param teamId - Team ID.
 * @param body - Untrusted request body.
 * @param auditContext - Audit context of the request.
 * @returns Saved settings.
 */
export async function updateWebAgentSettings(
  principal: WorkspacePrincipal,
  teamId: string,
  body: unknown,
  auditContext: MutationAuditContext,
): Promise<AgentSettings> {
  requireWorkspaceBusinessWrite(principal)
  const permission = await requireTeamPermission(principal, teamId, 'manager')
  const requested = readUpdateAgentSettingsRequest(body)
  const store = workItemDependencies.agentRuns
  const before = await store.getSettings(principal.directoryId, teamId)
  // Briefs belong to the Team's Projects. A manager sees and edits only the briefs of Projects they
  // can view; the others are kept as saved, and briefs of Projects no longer in the Team are dropped.
  const teamProjectIds = new Set(permission.team.projects.map((project) => project.id))
  for (const projectId of Object.keys(requested.projectBriefs)) {
    if (!teamProjectIds.has(projectId)) {
      throw new AgentRunError('validation_failed', 'A Project brief must name a Project of the Team.', {
        pointer: `/projectBriefs/${projectId.replaceAll('~', '~0').replaceAll('/', '~1')}`,
      })
    }
    requireAssignedProjectPermission(principal, permission, projectId, 'viewer')
  }
  const hiddenBriefs = Object.fromEntries(Object.entries(before.projectBriefs)
    .filter(([projectId]) => teamProjectIds.has(projectId) && !canAccessAssignedProject(principal, permission, projectId, 'viewer')))
  const update = {
    ...requested,
    projectBriefs: { ...requested.projectBriefs, ...hiddenBriefs },
    keptProjectIds: Object.keys(hiddenBriefs),
  }
  assertAgentSettingsBriefLimits(update)
  const now = new Date()
  const auditPut = createMutationAuditEventPut(getConfiguredAuditTableName(), auditContext, {
    directoryId: principal.directoryId,
    eventType: 'agent-settings.updated',
    entityType: 'agent-settings',
    entityId: `team/${teamId}/agent-settings`,
    action: 'updated',
    occurredAt: now.toISOString(),
    summary: 'Agent settings were updated.',
    changes: [
      { field: 'leaseMinutes', before: before.leaseMinutes, after: update.leaseMinutes },
      { field: 'acceptNewRuns', before: before.acceptNewRuns, after: update.acceptNewRuns },
      {
        field: 'allowTakeoverAfterLeaseExpiry',
        before: before.allowTakeoverAfterLeaseExpiry,
        after: update.allowTakeoverAfterLeaseExpiry,
      },
      { field: 'readyStatusIds', before: before.readyStatusIds.join(','), after: update.readyStatusIds.join(',') },
      { field: 'resumableStatusIds', before: before.resumableStatusIds.join(','), after: update.resumableStatusIds.join(',') },
      { field: 'requireAcceptanceCriteria', before: before.requireAcceptanceCriteria, after: update.requireAcceptanceCriteria },
      { field: 'acceptanceCriteriaFieldId', before: before.acceptanceCriteriaFieldId ?? '', after: update.acceptanceCriteriaFieldId ?? '' },
      { field: 'fileFailedRunsToTriage', before: before.fileFailedRunsToTriage, after: update.fileFailedRunsToTriage },
      { field: 'fileStalledRunsToTriage', before: before.fileStalledRunsToTriage, after: update.fileStalledRunsToTriage },
      { field: 'notifyAssigneeOfRunEvents', before: before.notifyAssigneeOfRunEvents, after: update.notifyAssigneeOfRunEvents },
      // Briefs are long user text, so the audit records only their size.
      { field: 'brief.bytes', before: briefBytes(before.brief), after: briefBytes(update.brief) },
      ...[...new Set([...Object.keys(before.projectBriefs), ...Object.keys(update.projectBriefs)])].map((projectId) => ({
        field: `projectBriefs.${projectId}.bytes`,
        before: briefBytes(Object.hasOwn(before.projectBriefs, projectId) ? before.projectBriefs[projectId] : undefined),
        after: briefBytes(Object.hasOwn(update.projectBriefs, projectId) ? update.projectBriefs[projectId] : undefined),
      })),
    ].filter((change) => change.before !== change.after),
    metadata: { adapter: 'agent-settings', teamId, beforeRevision: update.expectedRevision },
  })
  // A retry with the same Idempotency-Key replays the committed save instead of failing its revision check.
  const mutationKey = createHash('sha256')
    .update(`agent-settings\0${principal.userKey}\0${auditContext.idempotencyKeyHash}`)
    .digest('hex')
  const saved = await store.saveSettings(principal.directoryId, teamId, update, principal.userKey, now, mutationKey, auditPut ? [auditPut] : [])
  return withVisibleProjectBriefs(principal, permission, saved)
}
