import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  isWeeklyReportDate,
  WEEKLY_REPORT_MAX_MINUTES,
  WEEKLY_REPORT_MAX_SUBMISSIONS,
  WEEKLY_REPORT_MAX_WORK_ITEMS,
  WEEKLY_REPORT_SECTION_NAMES,
  type WeeklyReportItemInput,
  type WeeklyReportNotes,
  type WeeklyReportSectionName,
  type WeeklyReportStoredItem,
} from '@mukuroji/contracts'
import { createMutationAuditEventPut, type MutationAuditContext } from '../../../audit'
import { ProjectDataError } from '../../../directory'
import type {
  SaveWeeklyReportWeekInput,
  StoredWeeklyReportSubmission,
  SubmitWeeklyReportStoreInput,
  WeeklyReportMemberScope,
  WeeklyReportStore as Store,
  WeeklyReportTeamScope,
  WeeklyReportWeekPage,
  WeeklyReportWeekRecord,
} from '../../application/weekly-report-use-cases'

/** DynamoDB condition checks that pin the caller's authorization in the same transaction. */
export type WeeklyReportCallerAuthorizationCheck = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Weekly report persistence bound to DynamoDB authorization fences and the request audit context. */
export type WeeklyReportStore = Store<WeeklyReportCallerAuthorizationCheck, MutationAuditContext>

/** Week row replacement bound to DynamoDB fences. */
type SaveInput = SaveWeeklyReportWeekInput<WeeklyReportCallerAuthorizationCheck, MutationAuditContext>
/** Submission bound to DynamoDB fences. */
type SubmitInput = SubmitWeeklyReportStoreInput<WeeklyReportCallerAuthorizationCheck, MutationAuditContext>

/** Planning-table record type of one member's week. */
const WEEK_TYPE = 'weekly-report'
/** Planning-table record type of one submitted version. */
const SUBMISSION_TYPE = 'weekly-report-submission'
/** Schema version of both row types. */
const SCHEMA_VERSION = 1
/** Most keys one BatchGetItem request may carry. */
const BATCH_GET_LIMIT = 100
/** Attempts of a BatchGetItem request before unprocessed keys are a retryable failure. */
const BATCH_GET_ATTEMPTS = 4

/**
 * Builds the record key prefix of one member's weekly reports in a Team.
 *
 * @param scope - Team and author.
 * @returns The prefix shared by the member's week and submission rows.
 */
function memberPrefix(scope: Pick<WeeklyReportMemberScope, 'teamId' | 'memberKey'>) {
  return `WEEKLY_REPORT#${encodeURIComponent(scope.teamId)}#MEMBER#${encodeURIComponent(scope.memberKey)}`
}

/**
 * Builds the record key of one member's week.
 *
 * @param scope - Team and author.
 * @param weekStart - First day of the week.
 * @returns The week record key.
 */
function weekKey(scope: Pick<WeeklyReportMemberScope, 'teamId' | 'memberKey'>, weekStart: string) {
  return `${memberPrefix(scope)}#W#${weekStart}`
}

/**
 * Builds the record key of one submitted version.
 *
 * @param scope - Team and author.
 * @param weekStart - First day of the week.
 * @param version - Version number.
 * @returns The submission record key; versions sort in order within the week.
 */
function submissionKey(scope: Pick<WeeklyReportMemberScope, 'teamId' | 'memberKey'>, weekStart: string, version: number) {
  return `${memberPrefix(scope)}#S#${weekStart}#${String(version).padStart(4, '0')}`
}

/** Stores each member's week and each submitted version as Planning-table rows. */
export class DynamoDbWeeklyReportStore implements WeeklyReportStore {
  /** Existing Planning table name. */
  private readonly tableName: string
  /** Injected document client. */
  private readonly client: DynamoDBDocumentClient
  /** Audit event table, when audit is configured. */
  private readonly auditTableName: string | undefined

  /**
   * Creates the store.
   *
   * @param tableName - Existing Planning table.
   * @param client - Configured document client.
   * @param auditTableName - Audit event table written in the same transaction, when configured.
   */
  constructor(tableName: string, client: DynamoDBDocumentClient, auditTableName?: string) {
    this.tableName = tableName
    this.client = client
    this.auditTableName = auditTableName
  }

  /**
   * Reads one member's week with a strongly consistent read.
   *
   * @param scope - Author.
   * @param weekStart - First day of the week.
   * @returns The validated week, or `null`.
   */
  async getWeek(scope: WeeklyReportMemberScope, weekStart: string): Promise<WeeklyReportWeekRecord | null> {
    const { Item: row } = await this.client
      .send(new GetCommand({
        TableName: this.tableName,
        Key: { workspaceId: scope.workspaceId, recordKey: weekKey(scope, weekStart) },
        ConsistentRead: true,
      }))
      .catch((error: unknown) => storageFailure(error))
    return row ? parseWeekRow(row, scope, weekStart) : null
  }

  /**
   * Reads the same week of several members in batches, retrying unprocessed keys.
   *
   * @param scope - Team.
   * @param memberKeys - Normalized member keys.
   * @param weekStart - First day of the week.
   * @returns Weeks keyed by member key.
   */
  async getWeeks(scope: WeeklyReportTeamScope, memberKeys: readonly string[], weekStart: string): Promise<Map<string, WeeklyReportWeekRecord>> {
    const weeks = new Map<string, WeeklyReportWeekRecord>()
    const unique = [...new Set(memberKeys)]
    const memberByRecordKey = new Map(unique.map((memberKey) => [weekKey({ ...scope, memberKey }, weekStart), memberKey]))
    for (let offset = 0; offset < unique.length; offset += BATCH_GET_LIMIT) {
      let keys: Record<string, unknown>[] = unique
        .slice(offset, offset + BATCH_GET_LIMIT)
        .map((memberKey) => ({ workspaceId: scope.workspaceId, recordKey: weekKey({ ...scope, memberKey }, weekStart) }))
      for (let attempt = 0; keys.length > 0; attempt += 1) {
        if (attempt >= BATCH_GET_ATTEMPTS) throw retryableFailure()
        const response = await this.client
          .send(new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: keys, ConsistentRead: true } } }))
          .catch((error: unknown) => storageFailure(error))
        for (const row of response.Responses?.[this.tableName] ?? []) {
          const memberKey = typeof row.recordKey === 'string' ? memberByRecordKey.get(row.recordKey) : undefined
          if (memberKey === undefined) throw corruptReport()
          weeks.set(memberKey, parseWeekRow(row, { ...scope, memberKey }, weekStart))
        }
        keys = response.UnprocessedKeys?.[this.tableName]?.Keys ?? []
      }
    }
    return weeks
  }

  /**
   * Lists one member's weeks, newest first, following pages until the page is full.
   *
   * @param scope - Author.
   * @param options - Page size, exclusive upper bound, and whether to skip weeks never submitted.
   * @returns One page.
   */
  async listWeeks(
    scope: WeeklyReportMemberScope,
    options: { limit: number; before?: string; submittedOnly: boolean },
  ): Promise<WeeklyReportWeekPage> {
    const weeks: WeeklyReportWeekRecord[] = []
    const prefix = `${memberPrefix(scope)}#W#`
    let exclusiveStartKey: Record<string, unknown> | undefined = options.before === undefined
      ? undefined
      : { workspaceId: scope.workspaceId, recordKey: weekKey(scope, options.before) }
    do {
      const page = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#workspaceId = :workspaceId AND begins_with(#recordKey, :prefix)',
        ...(options.submittedOnly ? { FilterExpression: '#submissionCount > :zero' } : {}),
        ExpressionAttributeNames: {
          '#workspaceId': 'workspaceId',
          '#recordKey': 'recordKey',
          ...(options.submittedOnly ? { '#submissionCount': 'submissionCount' } : {}),
        },
        ExpressionAttributeValues: {
          ':workspaceId': scope.workspaceId,
          ':prefix': prefix,
          ...(options.submittedOnly ? { ':zero': 0 } : {}),
        },
        ScanIndexForward: false,
        Limit: options.limit + 1 - weeks.length,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })).catch((error: unknown) => storageFailure(error))
      for (const row of page.Items ?? []) {
        const weekStart = typeof row.weekStart === 'string' ? row.weekStart : ''
        weeks.push(parseWeekRow(row, scope, weekStart))
      }
      exclusiveStartKey = page.LastEvaluatedKey
    } while (exclusiveStartKey && weeks.length <= options.limit)
    return { weeks: weeks.slice(0, options.limit), hasMore: weeks.length > options.limit }
  }

  /**
   * Reads one submitted version.
   *
   * @param scope - Author.
   * @param weekStart - First day of the week.
   * @param version - Version number.
   * @returns The validated version, or `null`.
   */
  async getSubmission(scope: WeeklyReportMemberScope, weekStart: string, version: number): Promise<StoredWeeklyReportSubmission | null> {
    const { Item: row } = await this.client
      .send(new GetCommand({
        TableName: this.tableName,
        Key: { workspaceId: scope.workspaceId, recordKey: submissionKey(scope, weekStart, version) },
        ConsistentRead: true,
      }))
      .catch((error: unknown) => storageFailure(error))
    return row ? parseSubmissionRow(row, scope, weekStart, version) : null
  }

  /**
   * Replaces a week's notes when the row still has the previous revision.
   *
   * @param input - Replacement input.
   */
  async saveDraft(input: SaveInput): Promise<void> {
    requireCallerAuthorization(input.callerAuthorization)
    const audit = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'team.weekly_report_draft_saved',
      entityType: 'team',
      entityId: input.teamId,
      target: { type: WEEK_TYPE, id: `${input.memberKey}#${input.next.weekStart}` },
      action: 'weekly_report_draft_saved',
      occurredAt: input.now,
      changes: [],
      metadata: { teamId: input.teamId, weekStart: input.next.weekStart, revision: input.next.revision },
    })
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          this.weekPut(input),
          ...input.callerAuthorization,
          ...(audit ? [audit] : []),
        ],
      }))
    } catch (error) {
      storageFailure(error, 1 + input.callerAuthorization.length + (audit ? 1 : 0))
    }
  }

  /**
   * Adds a submitted version and advances the week row in one transaction.
   *
   * @param input - Submission input.
   */
  async submit(input: SubmitInput): Promise<void> {
    requireCallerAuthorization(input.callerAuthorization)
    const audit = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'team.weekly_report_submitted',
      entityType: 'team',
      entityId: input.teamId,
      target: { type: SUBMISSION_TYPE, id: `${input.memberKey}#${input.submission.weekStart}#${input.submission.version}` },
      action: 'weekly_report_submitted',
      occurredAt: input.now,
      changes: [],
      metadata: {
        teamId: input.teamId,
        weekStart: input.submission.weekStart,
        version: input.submission.version,
        workItemCount: input.submission.items.length,
      },
    })
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          this.weekPut(input),
          {
            Put: {
              TableName: this.tableName,
              Item: {
                workspaceId: input.workspaceId,
                recordKey: submissionKey(input, input.submission.weekStart, input.submission.version),
                entryType: SUBMISSION_TYPE,
                schemaVersion: SCHEMA_VERSION,
                teamId: input.teamId,
                memberKey: input.memberKey,
                ...input.submission,
              },
              ConditionExpression: 'attribute_not_exists(recordKey)',
            },
          },
          ...input.callerAuthorization,
          ...(audit ? [audit] : []),
        ],
      }))
    } catch (error) {
      storageFailure(error, 2 + input.callerAuthorization.length + (audit ? 1 : 0))
    }
  }

  /**
   * Builds the guarded Put of a week row.
   *
   * @param input - Replacement input.
   * @returns The transaction item.
   */
  private weekPut(input: SaveInput) {
    return {
      Put: {
        TableName: this.tableName,
        Item: {
          workspaceId: input.workspaceId,
          recordKey: weekKey(input, input.next.weekStart),
          entryType: WEEK_TYPE,
          schemaVersion: SCHEMA_VERSION,
          teamId: input.teamId,
          memberKey: input.memberKey,
          ...input.next,
        },
        ...(input.previous
          ? {
              ConditionExpression: '#type = :type AND #revision = :revision AND #submissionCount = :submissionCount',
              ExpressionAttributeNames: { '#type': 'entryType', '#revision': 'revision', '#submissionCount': 'submissionCount' },
              ExpressionAttributeValues: {
                ':type': WEEK_TYPE,
                ':revision': input.previous.revision,
                ':submissionCount': input.previous.submissionCount,
              },
            }
          : { ConditionExpression: 'attribute_not_exists(recordKey)' }),
      },
    }
  }
}

/** Isolated store for route and application tests. */
export class InMemoryWeeklyReportStore implements WeeklyReportStore {
  /** Week rows keyed by Workspace, Team, member, and week. */
  private readonly weeks = new Map<string, WeeklyReportWeekRecord>()
  /** Submission rows keyed by Workspace, Team, member, week, and version. */
  private readonly submissions = new Map<string, StoredWeeklyReportSubmission>()

  /**
   * Reads a copy of one member's week.
   *
   * @param scope - Author.
   * @param weekStart - First day of the week.
   * @returns The week, or `null`.
   */
  async getWeek(scope: WeeklyReportMemberScope, weekStart: string): Promise<WeeklyReportWeekRecord | null> {
    const week = this.weeks.get(memoryKey(scope, weekStart))
    return week ? structuredClone(week) : null
  }

  /**
   * Reads copies of the same week of several members.
   *
   * @param scope - Team.
   * @param memberKeys - Normalized member keys.
   * @param weekStart - First day of the week.
   * @returns Weeks keyed by member key.
   */
  async getWeeks(scope: WeeklyReportTeamScope, memberKeys: readonly string[], weekStart: string): Promise<Map<string, WeeklyReportWeekRecord>> {
    const weeks = new Map<string, WeeklyReportWeekRecord>()
    for (const memberKey of memberKeys) {
      const week = this.weeks.get(memoryKey({ ...scope, memberKey }, weekStart))
      if (week) weeks.set(memberKey, structuredClone(week))
    }
    return weeks
  }

  /**
   * Lists copies of one member's weeks, newest first.
   *
   * @param scope - Author.
   * @param options - Page size, exclusive upper bound, and whether to skip weeks never submitted.
   * @returns One page.
   */
  async listWeeks(
    scope: WeeklyReportMemberScope,
    options: { limit: number; before?: string; submittedOnly: boolean },
  ): Promise<WeeklyReportWeekPage> {
    const prefix = memoryKey(scope, '').slice(0, -2)
    const weeks = [...this.weeks.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, week]) => week)
      .filter((week) => (options.before === undefined || week.weekStart < options.before) && (!options.submittedOnly || week.submissionCount > 0))
      .sort((left, right) => right.weekStart.localeCompare(left.weekStart))
    return { weeks: weeks.slice(0, options.limit).map((week) => structuredClone(week)), hasMore: weeks.length > options.limit }
  }

  /**
   * Reads a copy of one submitted version.
   *
   * @param scope - Author.
   * @param weekStart - First day of the week.
   * @param version - Version number.
   * @returns The version, or `null`.
   */
  async getSubmission(scope: WeeklyReportMemberScope, weekStart: string, version: number): Promise<StoredWeeklyReportSubmission | null> {
    const submission = this.submissions.get(`${memoryKey(scope, weekStart)}#${version}`)
    return submission ? structuredClone(submission) : null
  }

  /**
   * Replaces a week's notes when the row still has the previous revision.
   *
   * @param input - Replacement input.
   */
  async saveDraft(input: SaveInput): Promise<void> {
    requireCallerAuthorization(input.callerAuthorization)
    this.replaceWeek(input)
  }

  /**
   * Adds a submitted version and advances the week row.
   *
   * @param input - Submission input.
   */
  async submit(input: SubmitInput): Promise<void> {
    requireCallerAuthorization(input.callerAuthorization)
    const key = `${memoryKey(input, input.submission.weekStart)}#${input.submission.version}`
    if (this.submissions.has(key)) throw conflict()
    // Checking and writing happen without an await in between, like one transaction.
    this.replaceWeek(input)
    this.submissions.set(key, structuredClone(input.submission))
  }

  /**
   * Replaces a week row when it still matches the previous one.
   *
   * @param input - Replacement input.
   */
  private replaceWeek(input: SaveInput) {
    const key = memoryKey(input, input.next.weekStart)
    const current = this.weeks.get(key)
    const matches = input.previous
      ? current !== undefined && current.revision === input.previous.revision && current.submissionCount === input.previous.submissionCount
      : current === undefined
    if (!matches) throw conflict()
    this.weeks.set(key, structuredClone(input.next))
  }
}

/**
 * Builds the in-memory key of one member's week.
 *
 * @param scope - Author.
 * @param weekStart - First day of the week.
 * @returns The key.
 */
function memoryKey(scope: WeeklyReportMemberScope, weekStart: string) {
  return JSON.stringify([scope.workspaceId, scope.teamId, scope.memberKey, weekStart])
}

/**
 * Refuses a write without the caller's commit-time authorization fences.
 *
 * @param checks - Caller authorization checks.
 */
function requireCallerAuthorization(checks: readonly unknown[]) {
  if (checks.length === 0) {
    throw new ProjectDataError(503, 'WeeklyReportAuthorizationUnavailable', 'Caller authorization is unavailable.')
  }
}

/**
 * Narrows an unknown value to a plain object.
 *
 * @param value - Value to check.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks whether a value is a non-negative integer.
 *
 * @param value - Value to check.
 * @returns Whether the value is a count.
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Validates stored notes.
 *
 * @param value - Raw notes.
 * @returns The notes.
 * @throws ProjectDataError when the notes are malformed.
 */
function parseStoredNotes(value: unknown): WeeklyReportNotes {
  if (!isRecord(value) || typeof value.issues !== 'string' || typeof value.reflection !== 'string') throw corruptReport()
  return { issues: value.issues, reflection: value.reflection }
}

/**
 * Validates a stored week row.
 *
 * @param row - Raw DynamoDB item.
 * @param scope - Expected Workspace, Team, and author.
 * @param weekStart - Expected week.
 * @returns The week.
 * @throws ProjectDataError when the row is malformed or belongs to another scope.
 */
function parseWeekRow(row: Record<string, unknown>, scope: WeeklyReportMemberScope, weekStart: string): WeeklyReportWeekRecord {
  if (
    !isWeeklyReportDate(weekStart) ||
    row.workspaceId !== scope.workspaceId ||
    row.recordKey !== weekKey(scope, weekStart) ||
    row.entryType !== WEEK_TYPE ||
    row.schemaVersion !== SCHEMA_VERSION ||
    row.teamId !== scope.teamId ||
    row.memberKey !== scope.memberKey ||
    row.weekStart !== weekStart ||
    !isCount(row.revision) || row.revision < 1 ||
    !isCount(row.submissionCount) || row.submissionCount > WEEKLY_REPORT_MAX_SUBMISSIONS ||
    typeof row.updatedAt !== 'string' ||
    (row.lastSubmittedAt !== undefined && typeof row.lastSubmittedAt !== 'string') ||
    (row.lastSubmissionReceipt !== undefined && typeof row.lastSubmissionReceipt !== 'string') ||
    (row.lastSubmissionKey !== undefined && typeof row.lastSubmissionKey !== 'string')
  ) {
    throw corruptReport()
  }
  return {
    weekStart,
    revision: row.revision,
    updatedAt: row.updatedAt,
    notes: parseStoredNotes(row.notes),
    submissionCount: row.submissionCount,
    ...(typeof row.lastSubmittedAt === 'string' ? { lastSubmittedAt: row.lastSubmittedAt } : {}),
    ...(typeof row.lastSubmissionReceipt === 'string' ? { lastSubmissionReceipt: row.lastSubmissionReceipt } : {}),
    ...(typeof row.lastSubmissionKey === 'string' ? { lastSubmissionKey: row.lastSubmissionKey } : {}),
  }
}

/**
 * Validates stored Work Item rows.
 *
 * @param value - Raw rows.
 * @returns The rows.
 * @throws ProjectDataError when a row is malformed.
 */
function parseStoredRows(value: unknown): WeeklyReportItemInput[] {
  if (!Array.isArray(value) || value.length > WEEKLY_REPORT_MAX_WORK_ITEMS) throw corruptReport()
  return value.map((row: unknown) => {
    if (
      !isRecord(row) ||
      typeof row.workItemId !== 'string' ||
      !isCount(row.minutes) ||
      row.minutes > WEEKLY_REPORT_MAX_MINUTES
    ) {
      throw corruptReport()
    }
    return { workItemId: row.workItemId, minutes: row.minutes }
  })
}

/**
 * Validates one stored resolved Work Item.
 *
 * @param value - Raw item.
 * @returns The item.
 * @throws ProjectDataError when the item is malformed.
 */
function parseStoredItem(value: unknown): WeeklyReportStoredItem {
  if (
    !isRecord(value) ||
    typeof value.workItemId !== 'string' ||
    typeof value.title !== 'string' ||
    (value.key !== undefined && typeof value.key !== 'string') ||
    (value.projectId !== undefined && typeof value.projectId !== 'string') ||
    (value.plannedEndDate !== undefined && typeof value.plannedEndDate !== 'string')
  ) {
    throw corruptReport()
  }
  return {
    workItemId: value.workItemId,
    title: value.title,
    ...(typeof value.key === 'string' ? { key: value.key } : {}),
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
    ...(typeof value.plannedEndDate === 'string' ? { plannedEndDate: value.plannedEndDate } : {}),
  }
}

/**
 * Validates a stored submission row.
 *
 * @param row - Raw DynamoDB item.
 * @param scope - Expected Workspace, Team, and author.
 * @param weekStart - Expected week.
 * @param version - Expected version.
 * @returns The submission.
 * @throws ProjectDataError when the row is malformed or belongs to another scope.
 */
function parseSubmissionRow(
  row: Record<string, unknown>,
  scope: WeeklyReportMemberScope,
  weekStart: string,
  version: number,
): StoredWeeklyReportSubmission {
  if (
    row.workspaceId !== scope.workspaceId ||
    row.recordKey !== submissionKey(scope, weekStart, version) ||
    row.entryType !== SUBMISSION_TYPE ||
    row.schemaVersion !== SCHEMA_VERSION ||
    row.teamId !== scope.teamId ||
    row.memberKey !== scope.memberKey ||
    row.weekStart !== weekStart ||
    row.version !== version ||
    typeof row.submittedAt !== 'string' ||
    !isWeeklyReportDate(row.weekEnd) ||
    !isCount(row.totalMinutes) ||
    typeof row.timeIsPartial !== 'boolean' ||
    !isRecord(row.sections) ||
    !Array.isArray(row.items) ||
    row.items.length > WEEKLY_REPORT_MAX_WORK_ITEMS
  ) {
    throw corruptReport()
  }
  const rawSections = row.sections
  const sections: Record<WeeklyReportSectionName, WeeklyReportItemInput[]> = {
    completed: parseStoredRows(rawSections.completed),
    started: parseStoredRows(rawSections.started),
    overdue: parseStoredRows(rawSections.overdue),
    upcoming: parseStoredRows(rawSections.upcoming),
  }
  if (Object.keys(rawSections).some((name) => !WEEKLY_REPORT_SECTION_NAMES.some((known) => known === name))) throw corruptReport()
  return {
    version,
    submittedAt: row.submittedAt,
    weekStart,
    weekEnd: row.weekEnd,
    sections,
    time: parseStoredRows(row.time),
    items: row.items.map(parseStoredItem),
    totalMinutes: row.totalMinutes,
    timeIsPartial: row.timeIsPartial,
    notes: parseStoredNotes(row.notes),
  }
}

/**
 * Creates the error for a malformed stored report.
 *
 * @returns The error.
 */
function corruptReport() {
  return new ProjectDataError(502, 'WeeklyReportCorruptState', 'The stored weekly report is invalid.')
}

/**
 * Creates the error for a week changed since it was read.
 *
 * @returns The error.
 */
function conflict() {
  return new ProjectDataError(409, 'WeeklyReportConflict', 'The weekly report or your permissions changed. Reload and try again.')
}

/**
 * Reads the cancellation reason codes of a cancelled transaction.
 *
 * @param error - Thrown SDK error.
 * @returns The codes in transaction order, or `undefined` for any other error.
 */
function readCancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('name' in error) ||
    error.name !== 'TransactionCanceledException' ||
    !('CancellationReasons' in error) ||
    !Array.isArray(error.CancellationReasons)
  ) {
    return undefined
  }
  return error.CancellationReasons.map((reason: unknown) =>
    typeof reason === 'object' && reason !== null && 'Code' in reason ? String(reason.Code) : undefined)
}

/** DynamoDB cancellation codes that mean the request may succeed if retried. */
const TRANSIENT_CANCELLATION_CODES = ['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError']

/**
 * Maps a DynamoDB failure to a Project data error.
 *
 * A transaction cancelled only by failed conditions is a conflict. One cancelled by throttling
 * or a competing transaction is retryable, and any other failure is a storage failure.
 *
 * @param error - Thrown SDK error.
 * @param transactionSize - Number of items in the cancelled transaction, or 0 for a plain read.
 * @returns Never; always throws.
 */
function storageFailure(error: unknown, transactionSize = 0): never {
  if (error instanceof ProjectDataError) throw error
  const codes = readCancellationCodes(error)
  if (codes && transactionSize > 0 && codes.length === transactionSize) {
    const isConditionOrNone = (code: string | undefined) => code === 'None' || code === 'ConditionalCheckFailed'
    if (codes.includes('ConditionalCheckFailed') && codes.every(isConditionOrNone)) throw conflict()
    if (
      codes.some((code) => code !== undefined && TRANSIENT_CANCELLATION_CODES.includes(code)) &&
      codes.every((code) => isConditionOrNone(code) || (code !== undefined && TRANSIENT_CANCELLATION_CODES.includes(code)))
    ) {
      throw retryableFailure()
    }
  }
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined
  if (
    typeof name === 'string' &&
    ['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded', 'InternalServerError', 'TransactionInProgressException', 'TimeoutError'].includes(name)
  ) {
    throw retryableFailure()
  }
  throw new ProjectDataError(502, 'WeeklyReportStorageFailure', 'Weekly report storage request failed.')
}

/**
 * Creates the error for a storage failure that may succeed when retried.
 *
 * @returns The error.
 */
function retryableFailure() {
  return new ProjectDataError(503, 'WeeklyReportRetryable', 'Weekly report storage is temporarily unavailable.')
}
