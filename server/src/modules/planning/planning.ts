import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
  type TableDescription,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  PLANNING_SCHEMA_VERSION,
  PLANNING_UPDATE_CONTENT_VERSION,
  WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS,
  WORK_ITEM_SCHEDULE_MIN_YEAR,
  type ConfigurePlanningUpdateCadenceInput,
  type CreatePlanningUpdateCommentInput,
  type CreatePlanningDependencyInput,
  type CreatePlanningEntityInput,
  type CreateWorkItemScheduleDependencyInput,
  type CycleRolloverInput,
  type DuplicatePlanningEntityInput,
  type MovePlanningEntityInput,
  type ListPlanningUpdatesInput,
  type ListPlanningUpdateCommentsInput,
  type ListPlanningUpdateReactionsInput,
  type PlanningCriticalPath,
  type PlanningCadence,
  type PlanningDependency,
  type PlanningDependencyType,
  type PlanningEntity,
  type PlanningEntityStatus,
  type PlanningEntityType,
  type PlanningHealth,
  type PlanningMutationResponse,
  type PlanningRevisionInput,
  type PlanningRisk,
  type PlanningSnapshot,
  type PlanningStatusUpdate,
  type PlanningStatusUpdateInput,
  type PlanningUpdate,
  type PlanningUpdateCadence,
  type PlanningUpdateCadenceMutationResponse,
  type PlanningUpdateChange,
  type PlanningUpdateComment,
  type PlanningUpdateCommentPage,
  type PlanningUpdateContextSnapshot,
  type PlanningUpdateEvidence,
  type PlanningUpdateHistoryPage,
  type PlanningUpdatePublishResponse,
  type PlanningUpdateReaction,
  type PlanningUpdateReactionInput,
  type PlanningUpdateReactionPage,
  type PlanningUpdateTarget,
  type PlanningUpdateTargetSummary,
  type PlanningWorkItemLink,
  type PlanningWorkItemLinkInput,
  type PlanningWorkItemDependencySummary,
  type PlanningWorkItemSummary,
  type ScheduleDependencyConstraint,
  type PublishPlanningUpdateInput,
  type UpdatePlanningEntityInput,
  type UpdateWorkItemScheduleDependencyInput,
  type WorkItemAffectedProject,
  type WorkItemDependencyCriticalPath,
  type WorkItemDependencyEndpoint,
  type WorkItemSchedule,
  type WorkItemScheduleDependency,
  type WorkItemScheduleDependencyConflict,
} from '@mukuroji/contracts'
import {
  createPlanningUpdateNextNotificationAtRecordKey,
  createPlanningUpdateScheduleShard,
  PLANNING_UPDATE_SCHEDULE_DUE_INDEX_NAME,
} from './planning-update-schedule-index'

const META_RECORD_KEY = 'META'
const META_WORKSPACE_KEY_PREFIX = 'FENCE#'
const ENTITY_RECORD_PREFIX = 'ENTITY#'
const DEPENDENCY_RECORD_PREFIX = 'DEPENDENCY#'
const WORK_ITEM_DEPENDENCY_RECORD_PREFIX = 'WORK_ITEM_DEPENDENCY#'
const LINK_RECORD_PREFIX = 'LINK#'
const UPDATE_TARGET_RECORD_PREFIX = 'UPDATE_TARGET#'
const UPDATE_RECORD_PREFIX = 'UPDATE#'
const UPDATE_ID_RECORD_PREFIX = 'UPDATE_ID#'
const UPDATE_COMMENT_RECORD_PREFIX = 'UPDATE_COMMENT#'
const UPDATE_COMMENT_ID_RECORD_PREFIX = 'UPDATE_COMMENT_ID#'
const UPDATE_REACTION_RECORD_PREFIX = 'UPDATE_REACTION#'
/** Mutable graph row prefixes and their canonical persisted entry types. */
const PLANNING_GRAPH_ROW_QUERIES = [
  { recordPrefix: ENTITY_RECORD_PREFIX, entryType: 'planning-entity' },
  { recordPrefix: DEPENDENCY_RECORD_PREFIX, entryType: 'planning-dependency' },
  {
    recordPrefix: WORK_ITEM_DEPENDENCY_RECORD_PREFIX,
    entryType: 'planning-work-item-dependency',
  },
  { recordPrefix: LINK_RECORD_PREFIX, entryType: 'planning-work-item-link' },
  { recordPrefix: UPDATE_TARGET_RECORD_PREFIX, entryType: 'planning-update-target' },
]
const PLANNING_READ_LIMIT = 2_000
const TRANSACTION_ITEM_LIMIT = 100
const MAX_PLANNING_ROW_BYTES = 300_000
const MAX_PLANNING_TRANSACTION_BYTES = 3_000_000
const MAX_PLANNING_SNAPSHOT_BYTES = 4_000_000
const MAX_DESCRIPTION_BYTES = 20_000
const MAX_STATUS_MESSAGE_BYTES = 8_000
const MAX_STATUS_UPDATES = 32
const MAX_UPDATE_TEXT_BYTES = 8_000
const MAX_UPDATE_COMMENT_BYTES = 4_000
const MAX_UPDATE_REACTION_BYTES = 64
const MAX_UPDATE_EVIDENCE = 100
const MAX_UPDATE_HISTORY_PAGE_SIZE = 100
const DEFAULT_UPDATE_HISTORY_PAGE_SIZE = 25
const UPDATE_VERSION_WIDTH = 16
const MAX_REMINDER_HOURS = 24 * 365
const MAX_UPDATE_CADENCE_COUNT = 1_000
const MAX_ROLLOVER_LINK_MUTATIONS = 49
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const planningTimeZoneFormatters = new Map<string, Intl.DateTimeFormat>()

/** Schema version of the persisted Planning META fencing row. */
export const PLANNING_STORAGE_SCHEMA_VERSION = 1 as const

/** Planning domain / persistence error です。 */
export class PlanningError extends Error {
  /** API response に使う HTTP status です。 */
  readonly status: number
  /** Client が安定判定に使う error code です。 */
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Roll-up 時点の canonical Work Item projection です。 */
export type PlanningWorkItemState = {
  /** 現在 user の planning snapshot に含める Work Item 一覧です。 */
  workItems: readonly PlanningWorkItemSummary[]
}

/** Caller authorization check appended to a Planning DynamoDB mutation transaction. */
export type PlanningCallerAuthorizationConditionCheck = {
  /** Read-only condition against one caller authorization source-of-truth row. */
  ConditionCheck: NonNullable<
    NonNullable<TransactWriteCommandInput['TransactItems']>[number]['ConditionCheck']
  >
}

/** Minimal result exposed while preparing one durable Work Item dependency receipt. */
export type PlanningWorkItemDependencyTransactionResult = {
  /** Whether the committed dependency is present after the mutation or was deleted. */
  kind: 'upsert' | 'delete'
  /** Planning revision produced by the mutation. */
  revision: number
  /** Complete dependency value created, updated, or deleted by the mutation. */
  dependency: WorkItemScheduleDependency
}

/** Minimal result exposed while preparing one durable Planning update annotation receipt. */
export type PlanningUpdateAnnotationTransactionResult =
  | {
      /** Identifies an append-only comment creation. */
      kind: 'comment-create'
      /** Complete comment value committed by the mutation. */
      comment: PlanningUpdateComment
    }
  | {
      /** Identifies a current-member reaction addition. */
      kind: 'reaction-add'
      /** Complete reaction value committed by the mutation. */
      reaction: PlanningUpdateReaction
    }
  | {
      /** Identifies a current-member reaction removal. */
      kind: 'reaction-remove'
      /** Project or Initiative that owns the immutable update. */
      target: PlanningUpdateTarget
      /** Target-local immutable update version. */
      updateVersion: number
      /** Removed reaction token. */
      emoji: string
      /** Workspace member whose reaction was removed. */
      memberKey: string
    }

/** Minimal result exposed while preparing a durable Planning publish receipt. */
export type PlanningUpdatePublishTransactionResult = {
  /** Identifies an immutable structured update publish. */
  kind: 'publish'
  /** Planning revision produced by the publish. */
  revision: number
  /** Complete immutable update value committed by the publish. */
  update: PlanningUpdate
}

/** Minimal Planning mutation result accepted by a durable receipt contribution. */
export type PlanningMutationTransactionResult =
  | PlanningWorkItemDependencyTransactionResult
  | PlanningUpdateAnnotationTransactionResult
  | PlanningUpdatePublishTransactionResult

/** One external DynamoDB action prepared for the Planning mutation transaction. */
type PlanningMutationTransactionContribution = {
  /** Conditional receipt write committed after Planning row mutations. */
  transactWriteItem: NonNullable<TransactWriteCommandInput['TransactItems']>[number]
}

/** Adds one durable completion receipt to a supported Planning mutation transaction. */
export type PlanningMutationTransaction<
  TResult extends PlanningMutationTransactionResult = PlanningWorkItemDependencyTransactionResult,
> = {
  /**
   * Prepares a storage contribution from the minimal committed mutation result.
   *
   * @param result - Exact bounded result produced by the Planning mutation.
   * @returns An opaque storage contribution validated inside the Planning adapter.
   */
  prepare(
    result: TResult,
  ): Promise<unknown>
}

/** Directory 破壊操作の認可に使う Planning entity 参照です。 */
export type PlanningEntityAuthorizationReference = {
  /** Planning entity ID です。 */
  id: string
  /** Relation target 種別を current entity source で検証する型です。 */
  type: PlanningEntityType
  /** Active owner の Workspace member key です。 */
  ownerMemberKey: string
  /** 任意の Team scope です。 */
  teamId?: string
  /** 任意の Project scope です。 */
  projectId?: string
  /** Soft archive 済みの場合の timestamp です。 */
  archivedAt?: string
}

/** Scheduled notification の current visibility 再検証に使う update target 参照です。 */
export type PlanningUpdateTargetAuthorizationReference = {
  /** Project または Initiative の canonical target です。 */
  target: PlanningUpdateTarget
  /** 現在設定されている cadence と notification recipients です。 */
  cadence?: PlanningUpdateCadence
  /** Initiative archive により target が停止済みの場合の timestamp です。 */
  archivedAt?: string
}

/** Read-time filtering 前の破壊操作認可 snapshot です。 */
export type PlanningAuthorizationState = {
  /** 同じ read で取得した Planning global revision です。 */
  revision: number
  /** Owner / scope guard に必要な entity 参照です。 */
  entities: PlanningEntityAuthorizationReference[]
  /** Scope guard に必要な未フィルタ Work Item link です。 */
  workItemLinks: PlanningWorkItemLink[]
  /** Work Item deletion guard に利用する未フィルタ schedule dependency です。 */
  workItemDependencies: WorkItemScheduleDependency[]
  /** Scheduled notification の current target / cadence guard に使う参照です。 */
  updateTargets: PlanningUpdateTargetAuthorizationReference[]
}

/** Planning domain を読み書きする client contract です。 */
export type PlanningClient = {
  /** Workspace planning snapshot を返します。 */
  get(workspaceId: string, workItemState: PlanningWorkItemState): Promise<PlanningSnapshot>
  /** 外部 authorization transaction を束縛する global revision を返します。 */
  getAuthorizationRevision(workspaceId: string): Promise<number>
  /** 認可用に read-time filtering 前の Work Item link を返します。 */
  getWorkItemLinkForAuthorization(
    workspaceId: string,
    teamId: string,
    workItemId: string,
  ): Promise<PlanningWorkItemLink | undefined>
  /** Directory 破壊操作用に未フィルタ参照と同一 read の revision を返します。 */
  getAuthorizationState(workspaceId: string): Promise<PlanningAuthorizationState>
  /** Planning entity を作成します。 */
  create(
    workspaceId: string,
    input: CreatePlanningEntityInput,
    workItemState: PlanningWorkItemState,
  ): Promise<PlanningMutationResponse>
  /** Planning entity の editable fields を更新します。 */
  update(
    workspaceId: string,
    entityId: string,
    input: UpdatePlanningEntityInput,
    workItemState: PlanningWorkItemState,
  ): Promise<PlanningMutationResponse>
  /** Planning entity を soft archive します。 */
  archive(
    workspaceId: string,
    entityId: string,
    input: PlanningRevisionInput,
    workItemState: PlanningWorkItemState,
  ): Promise<PlanningMutationResponse>
  /** Planning entity を履歴・link・edge なしで複製します。 */
  duplicate(
    workspaceId: string,
    entityId: string,
    input: DuplicatePlanningEntityInput,
    workItemState: PlanningWorkItemState,
  ): Promise<PlanningMutationResponse>
  /** Planning entity の hierarchy / Team / Project scope を移動します。 */
  move(
    workspaceId: string,
    entityId: string,
    input: MovePlanningEntityInput,
    workItemState: PlanningWorkItemState,
  ): Promise<PlanningMutationResponse>
  /** Planning entity に status update を追記します。 */
  addStatusUpdate(
    workspaceId: string,
    entityId: string,
    input: PlanningStatusUpdateInput,
    authorMemberKey: string,
    workItemState: PlanningWorkItemState,
  ): Promise<PlanningMutationResponse>
  /** Project / Initiative update cadence を設定または解除します。 */
  configureUpdateCadence(
    workspaceId: string,
    input: ConfigurePlanningUpdateCadenceInput,
    workItemState: PlanningWorkItemState,
    authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
  ): Promise<PlanningUpdateCadenceMutationResponse>
  /** Human-authored structured update を append-only publish します。 */
  publishUpdate(
    workspaceId: string,
    input: PublishPlanningUpdateInput,
    authorMemberKey: string,
    workItemState: PlanningWorkItemState,
    authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
    transaction?: PlanningMutationTransaction<PlanningUpdatePublishTransactionResult>,
  ): Promise<PlanningUpdatePublishResponse>
  /** Target-local immutable update history を新しい順に返します。 */
  listUpdates(
    workspaceId: string,
    input: ListPlanningUpdatesInput,
  ): Promise<PlanningUpdateHistoryPage>
  /**
   * Appends one comment to an immutable Planning update.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param input - Target, immutable update version, client ID, and body.
   * @param authorMemberKey - Authenticated comment author.
   * @param transaction - Optional durable response receipt committed with the comment.
   * @param authorizationConditionChecks - Caller authorization rows guarded during persistence.
   * @returns The committed append-only comment.
   */
  createUpdateComment(
    workspaceId: string,
    input: CreatePlanningUpdateCommentInput,
    authorMemberKey: string,
    transaction?: PlanningMutationTransaction<PlanningUpdateAnnotationTransactionResult>,
    authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
  ): Promise<PlanningUpdateComment>
  /** Immutable update comments を新しい順に page 取得します。 */
  listUpdateComments(
    workspaceId: string,
    input: ListPlanningUpdateCommentsInput,
  ): Promise<PlanningUpdateCommentPage>
  /**
   * Adds the current member's reaction to an immutable Planning update.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param input - Target, immutable update version, and reaction token.
   * @param memberKey - Authenticated reacting member.
   * @param transaction - Optional durable response receipt committed with the reaction.
   * @param authorizationConditionChecks - Caller authorization rows guarded during persistence.
   * @returns The committed reaction.
   */
  addUpdateReaction(
    workspaceId: string,
    input: PlanningUpdateReactionInput,
    memberKey: string,
    transaction?: PlanningMutationTransaction<PlanningUpdateAnnotationTransactionResult>,
    authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
  ): Promise<PlanningUpdateReaction>
  /**
   * Removes the current member's reaction from an immutable Planning update.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param input - Target, immutable update version, and reaction token.
   * @param memberKey - Authenticated reacting member.
   * @param transaction - Optional durable response receipt committed with the removal.
   * @param authorizationConditionChecks - Caller authorization rows guarded during persistence.
   * @returns A promise that resolves after the idempotent removal commits.
   */
  removeUpdateReaction(
    workspaceId: string,
    input: PlanningUpdateReactionInput,
    memberKey: string,
    transaction?: PlanningMutationTransaction<PlanningUpdateAnnotationTransactionResult>,
    authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
  ): Promise<void>
  /** Immutable update reactions を stable key 順に page 取得します。 */
  listUpdateReactions(
    workspaceId: string,
    input: ListPlanningUpdateReactionsInput,
  ): Promise<PlanningUpdateReactionPage>
  /** Planning dependency を作成します。 */
  createDependency(
    workspaceId: string,
    input: CreatePlanningDependencyInput,
    workItemState: PlanningWorkItemState,
  ): Promise<PlanningMutationResponse>
  /** Planning dependency を削除します。 */
  deleteDependency(
    workspaceId: string,
    dependencyId: string,
    input: PlanningRevisionInput,
    workItemState: PlanningWorkItemState,
  ): Promise<PlanningMutationResponse>
  /**
   * Creates one canonical schedule dependency between Work Items.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param input - Candidate dependency and expected Planning revision.
   * @param workItemState - Canonical endpoint schedules and revisions.
   * @param authorizationConditionChecks - Caller authorization rows guarded during persistence.
   * @param transaction - Optional durable completion receipt prepared for the same transaction.
   * @returns The updated Planning snapshot.
   */
  createWorkItemDependency(
    workspaceId: string,
    input: CreateWorkItemScheduleDependencyInput,
    workItemState: PlanningWorkItemState,
    authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
    transaction?: PlanningMutationTransaction<PlanningMutationTransactionResult>,
  ): Promise<PlanningMutationResponse>
  /**
   * Updates editable fields of a canonical Work Item schedule dependency.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param dependencyId - Workspace-local dependency identifier.
   * @param input - Patch and expected Planning revision.
   * @param workItemState - Canonical endpoint schedules and revisions.
   * @param authorizationConditionChecks - Caller authorization rows guarded during persistence.
   * @param transaction - Optional durable completion receipt prepared for the same transaction.
   * @returns The updated Planning snapshot.
   */
  updateWorkItemDependency(
    workspaceId: string,
    dependencyId: string,
    input: UpdateWorkItemScheduleDependencyInput,
    workItemState: PlanningWorkItemState,
    authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
    transaction?: PlanningMutationTransaction<PlanningMutationTransactionResult>,
  ): Promise<PlanningMutationResponse>
  /**
   * Deletes one canonical Work Item schedule dependency.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param dependencyId - Workspace-local dependency identifier.
   * @param input - Expected Planning revision.
   * @param workItemState - Canonical endpoint schedules and revisions.
   * @param authorizationConditionChecks - Caller authorization rows guarded during persistence.
   * @param transaction - Optional durable completion receipt prepared for the same transaction.
   * @returns The updated Planning snapshot.
   */
  deleteWorkItemDependency(
    workspaceId: string,
    dependencyId: string,
    input: PlanningRevisionInput,
    workItemState: PlanningWorkItemState,
    authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
    transaction?: PlanningMutationTransaction<PlanningMutationTransactionResult>,
  ): Promise<PlanningMutationResponse>
  /** Work Item planning link を作成または置換します。 */
  putWorkItemLink(
    workspaceId: string,
    input: PlanningWorkItemLinkInput,
    workItemState: PlanningWorkItemState,
  ): Promise<PlanningMutationResponse>
  /** Work Item planning link を削除します。 */
  deleteWorkItemLink(
    workspaceId: string,
    teamId: string,
    workItemId: string,
    input: PlanningRevisionInput,
    workItemState: PlanningWorkItemState,
  ): Promise<PlanningMutationResponse>
  /** Cycle を完了し、policy に従って未完了 Work Item を rollover します。 */
  rolloverCycle(
    workspaceId: string,
    sourceCycleId: string,
    input: CycleRolloverInput,
    workItemState: PlanningWorkItemState,
  ): Promise<PlanningMutationResponse>
}

/** 永続化する entity から read-time 派生値を除いた shape です。 */
type StoredPlanningEntity = Omit<PlanningEntity, 'linkedWorkItemCount' | 'progress' | 'rollupHealth'>

/** Read-time freshness を除いて UPDATE_TARGET row に保存する state です。 */
type StoredPlanningUpdateTarget = Omit<PlanningUpdateTargetSummary, 'updateState'> & {
  /** Latest immutable update の diff 元となる server context です。 */
  latestContextSnapshot?: PlanningUpdateContextSnapshot
  /** Monthly recurrence が month-end clamp 後も保持する original local day です。 */
  cadenceAnchorDay?: number
  /** Schedule worker が次の未配信 notification stage を指す opaque due-index key です。 */
  nextNotificationAtRecordKey?: string
}

/** Workspace planning graph の永続化 state です。 */
type PlanningWorkspaceState = {
  /** Global optimistic concurrency revision です。 */
  revision: number
  /** Planning entities です。 */
  entities: StoredPlanningEntity[]
  /** Directed dependencies です。 */
  dependencies: PlanningDependency[]
  /** Canonical Work Item 間の directed schedule dependencies です。 */
  workItemDependencies: WorkItemScheduleDependency[]
  /** Work Item links です。 */
  workItemLinks: PlanningWorkItemLink[]
  /** Project / Initiative update target summaries です。 */
  updateTargets: StoredPlanningUpdateTarget[]
  /** Graph の最終更新日時です。 */
  updatedAt?: string
}

/** Canonical Work Item を Planning transaction 内で再検証する条件です。 */
type PlanningWorkItemCondition = {
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Team 内の Work Item ID です。 */
  workItemId: string
  /** Planning 判定に利用した canonical Work Item revision です。 */
  revision: number
}

/** Work Item dependency result captured before the next Planning revision is assigned. */
type PlanningWorkItemDependencyTransactionSource = {
  /** Whether the dependency remains present after the mutation. */
  kind: 'upsert' | 'delete'
  /** Complete dependency value created, updated, or deleted by the mutation. */
  dependency: WorkItemScheduleDependency
}

/** Mutation が返す rollover の追加情報です。 */
type PlanningMutationResult = {
  /** Mutation 後の state です。 */
  state: PlanningWorkspaceState
  /** Rollover で移動した Work Item IDs です。 */
  movedWorkItemIds?: string[]
  /** Rollover で元 Cycle に残した未完了 Work Item IDs です。 */
  retainedWorkItemIds?: string[]
  /** Planning commit と同じ transaction で検証する Work Item revisions です。 */
  workItemConditions?: PlanningWorkItemCondition[]
  /** Minimal Work Item dependency value used to prepare a durable completion receipt. */
  workItemDependencyTransactionSource?: PlanningWorkItemDependencyTransactionSource
  /** 同じ transaction で append-only 保存する structured update です。 */
  publishedUpdate?: PlanningUpdate
}

/** Storage 非依存の Planning mutation 実装です。 */
abstract class BasePlanningClient implements PlanningClient {
  /** Timestamp を生成する clock です。 */
  private readonly now: () => Date

  protected constructor(now: () => Date) {
    this.now = now
  }

  /** Workspace state を storage から読み込みます。 */
  protected abstract readState(workspaceId: string): Promise<PlanningWorkspaceState>

  /** Storage から target-local immutable history の1 pageを返します。 */
  protected abstract readUpdateHistory(
    workspaceId: string,
    target: PlanningUpdateTarget,
    limit: number,
    cursor?: string,
  ): Promise<PlanningUpdateHistoryPage>

  /** Storage で immutable update version の存在を検証します。 */
  protected abstract planningUpdateExists(
    workspaceId: string,
    target: PlanningUpdateTarget,
    updateVersion: number,
  ): Promise<boolean>

  /** Storage に append-only comment を作成します。 */
  protected abstract appendUpdateComment(
    workspaceId: string,
    comment: PlanningUpdateComment,
    transactionContribution?: PlanningMutationTransactionContribution,
    authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
  ): Promise<void>

  /** Storage から update comment の1 pageを返します。 */
  protected abstract readUpdateComments(
    workspaceId: string,
    target: PlanningUpdateTarget,
    updateVersion: number,
    limit: number,
    cursor?: string,
  ): Promise<PlanningUpdateCommentPage>

  /** Storage に current member reaction を作成します。 */
  protected abstract putUpdateReaction(
    workspaceId: string,
    reaction: PlanningUpdateReaction,
    transactionContribution?: PlanningMutationTransactionContribution,
    authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
  ): Promise<void>

  /** Storage から current member reaction を削除します。 */
  protected abstract deleteUpdateReaction(
    workspaceId: string,
    target: PlanningUpdateTarget,
    updateVersion: number,
    emoji: string,
    memberKey: string,
    transactionContribution?: PlanningMutationTransactionContribution,
    authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
  ): Promise<void>

  /** Storage から update reaction の1 pageを返します。 */
  protected abstract readUpdateReactions(
    workspaceId: string,
    target: PlanningUpdateTarget,
    updateVersion: number,
    limit: number,
    cursor?: string,
  ): Promise<PlanningUpdateReactionPage>

  /**
   * Persists one Planning state transition with all revision and authorization guards.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param before - State used for the Planning META revision CAS.
   * @param after - Fully validated replacement state.
   * @param workItemConditions - Canonical endpoint revision guards.
   * @param authorizationConditionChecks - Caller authorization source guards.
   * @param transactionContribution - Optional external action committed after Planning row writes.
   */
  protected abstract commitState(
    workspaceId: string,
    before: PlanningWorkspaceState,
    after: PlanningWorkspaceState,
    workItemConditions?: readonly PlanningWorkItemCondition[],
    authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
    transactionContribution?: PlanningMutationTransactionContribution,
    publishedUpdate?: PlanningUpdate,
  ): Promise<void>

  /** Workspace planning snapshot を返します。 */
  async get(workspaceId: string, workItemState: PlanningWorkItemState) {
    const state = await this.readState(readIdentifier(workspaceId, 'Workspace ID'))
    return createPlanningSnapshot(state, workItemState, this.now().toISOString())
  }

  /** 外部 authorization transaction を束縛する global revision を返します。 */
  async getAuthorizationRevision(workspaceId: string) {
    const state = await this.readState(readIdentifier(workspaceId, 'Workspace ID'))
    return state.revision
  }

  /** Read-time filtering 前の Work Item link を認可判定だけに返します。 */
  async getWorkItemLinkForAuthorization(
    workspaceId: string,
    teamId: string,
    workItemId: string,
  ) {
    const state = await this.readState(readIdentifier(workspaceId, 'Workspace ID'))
    const normalizedTeamId = readIdentifier(teamId, 'Team ID')
    const normalizedWorkItemId = readIdentifier(workItemId, 'Work Item ID')
    const link = state.workItemLinks.find((candidate) =>
      candidate.teamId === normalizedTeamId && candidate.workItemId === normalizedWorkItemId,
    )
    return link ? structuredClone(link) : undefined
  }

  /** 未フィルタ参照と fence revision を一回の storage read から返します。 */
  async getAuthorizationState(workspaceId: string): Promise<PlanningAuthorizationState> {
    const state = await this.readState(readIdentifier(workspaceId, 'Workspace ID'))
    return {
      revision: state.revision,
      entities: state.entities.map((entity) => ({
        id: entity.id,
        type: entity.type,
        ownerMemberKey: entity.ownerMemberKey,
        ...(entity.teamId === undefined ? {} : { teamId: entity.teamId }),
        ...(entity.projectId === undefined ? {} : { projectId: entity.projectId }),
        ...(entity.archivedAt === undefined ? {} : { archivedAt: entity.archivedAt }),
      })),
      workItemLinks: state.workItemLinks.map((link) => structuredClone(link)),
      workItemDependencies: state.workItemDependencies
        .map((dependency) => structuredClone(dependency)),
      updateTargets: state.updateTargets.map((updateTarget) => ({
        target: structuredClone(updateTarget.target),
        ...(updateTarget.cadence === undefined
          ? {}
          : { cadence: structuredClone(updateTarget.cadence) }),
        ...(updateTarget.archivedAt === undefined
          ? {}
          : { archivedAt: updateTarget.archivedAt }),
      })),
    }
  }

  /** Planning entity を作成します。 */
  async create(
    workspaceId: string,
    input: CreatePlanningEntityInput,
    workItemState: PlanningWorkItemState,
  ) {
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
      if (findEntity(state, input.id)) {
        throw conflict('PlanningEntityExists', `Planning entity "${input.id}" already exists.`)
      }
      const entity = createStoredEntity(input, now)
      if (entity.parentId) requireActiveEntity(state, entity.parentId)
      const next = { ...state, entities: [...state.entities, entity] }
      validatePlanningState(next)
      return { state: next }
    })
  }

  /** Planning entity の editable fields を更新します。 */
  async update(
    workspaceId: string,
    entityId: string,
    input: UpdatePlanningEntityInput,
    workItemState: PlanningWorkItemState,
  ) {
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
      const current = requireActiveEntity(state, entityId)
      if (!isRecord(input.patch)) {
        throw invalid('PlanningPatchInvalid', 'Planning patch must be an object.')
      }
      const patch = input.patch as UpdatePlanningEntityInput['patch']
      const updated: StoredPlanningEntity = {
        ...current,
        ...(patch.title === undefined ? {} : { title: readTitle(patch.title) }),
        ...(patch.ownerMemberKey === undefined
          ? {}
          : { ownerMemberKey: readOwnerMemberKey(patch.ownerMemberKey) }),
        ...(patch.status === undefined ? {} : { status: readEntityStatus(patch.status) }),
        ...(patch.health === undefined ? {} : { health: readHealth(patch.health) }),
        ...(patch.risk === undefined ? {} : { risk: readRisk(patch.risk) }),
        ...(patch.progressMode === undefined
          ? {}
          : { progressMode: readProgressMode(patch.progressMode) }),
        ...(patch.baseline === undefined ? {} : { baseline: readDateRange(patch.baseline, 'Baseline') }),
        ...(patch.forecast === undefined ? {} : { forecast: readDateRange(patch.forecast, 'Forecast') }),
        ...(patch.cadence === undefined ? {} : { cadence: readCadence(patch.cadence) }),
        ...(patch.capacity === undefined ? {} : { capacity: readCapacity(patch.capacity) }),
        ...(patch.carryOverPolicy === undefined
          ? {}
          : { carryOverPolicy: readCarryOverPolicy(patch.carryOverPolicy) }),
        ...(patch.goalFramework === undefined
          ? {}
          : { goalFramework: readGoalFramework(patch.goalFramework) }),
        updatedAt: now,
      }
      if (patch.description !== undefined) {
        const description = readOptionalDescription(patch.description)
        if (description === undefined) delete updated.description
        else updated.description = description
      }
      if (patch.manualProgress !== undefined) {
        if (patch.manualProgress === null) delete updated.manualProgress
        else updated.manualProgress = readProgress(patch.manualProgress, 'Manual progress')
      }
      const next = replaceEntity(state, updated)
      validatePlanningState(next)
      return { state: next }
    })
  }

  /** Planning entity を soft archive します。 */
  async archive(
    workspaceId: string,
    entityId: string,
    input: PlanningRevisionInput,
    workItemState: PlanningWorkItemState,
  ) {
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
      const current = requireActiveEntity(state, entityId)
      if (state.entities.some((entity) => entity.parentId === current.id && !entity.archivedAt)) {
        throw conflict(
          'PlanningEntityHasActiveChildren',
          'Move or archive active child entities before archiving their parent.',
        )
      }
      const workItemConditions: PlanningWorkItemCondition[] = []
      if (current.type === 'cycle') {
        const summaries = createWorkItemMap(workItemState)
        for (const link of state.workItemLinks) {
          if (link.cycleId !== current.id) continue
          const summary = summaries.get(createWorkItemKey(link.teamId, link.workItemId))
          if (!summary) {
            throw new PlanningError(503, 'PlanningWorkItemMissing', 'A linked Work Item is missing.')
          }
          if (summary.statusCategory !== 'completed' && summary.statusCategory !== 'canceled') {
            throw conflict(
              'PlanningCycleHasIncompleteWorkItems',
              'Rollover or unlink incomplete Work Items before archiving this Cycle.',
            )
          }
          workItemConditions.push({
            teamId: link.teamId,
            workItemId: link.workItemId,
            revision: readRevision(summary.revision),
          })
        }
      }
      let next = replaceEntity(state, { ...current, archivedAt: now, updatedAt: now })
      if (current.type === 'initiative') {
        const updateTarget = findStoredPlanningUpdateTarget(next, {
          type: 'initiative',
          entityId: current.id,
        })
        if (updateTarget) {
          next = replacePlanningUpdateTarget(next, {
            ...updateTarget,
            archivedAt: now,
            updatedAt: now,
          })
        }
      }
      return { state: next, workItemConditions }
    })
  }

  /** Planning entity を履歴・link・edge なしで複製します。 */
  async duplicate(
    workspaceId: string,
    entityId: string,
    input: DuplicatePlanningEntityInput,
    workItemState: PlanningWorkItemState,
  ) {
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
      const source = requireActiveEntity(state, entityId)
      const targetId = readIdentifier(input.targetId, 'Target entity ID')
      if (findEntity(state, targetId)) {
        throw conflict('PlanningEntityExists', `Planning entity "${targetId}" already exists.`)
      }
      const copy: StoredPlanningEntity = {
        ...structuredClone(source),
        id: targetId,
        title: input.title === undefined ? `${source.title} copy` : readTitle(input.title),
        parentId: input.parentId === undefined ? source.parentId : readIdentifier(input.parentId, 'Parent ID'),
        statusUpdates: [],
        createdAt: now,
        updatedAt: now,
      }
      delete copy.archivedAt
      if (copy.parentId) requireActiveEntity(state, copy.parentId)
      const next = { ...state, entities: [...state.entities, copy] }
      validatePlanningState(next)
      return { state: next }
    })
  }

  /** Planning entity の hierarchy / Team / Project scope を移動します。 */
  async move(
    workspaceId: string,
    entityId: string,
    input: MovePlanningEntityInput,
    workItemState: PlanningWorkItemState,
  ) {
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
      const current = requireActiveEntity(state, entityId)
      const moved: StoredPlanningEntity = { ...current, updatedAt: now }
      if (input.parentId !== undefined) moved.parentId = readIdentifier(input.parentId, 'Parent ID')
      else delete moved.parentId
      if (input.teamId !== undefined) moved.teamId = readIdentifier(input.teamId, 'Team ID')
      else delete moved.teamId
      if (input.projectId !== undefined) moved.projectId = readIdentifier(input.projectId, 'Project ID')
      else delete moved.projectId
      if (moved.parentId) requireActiveEntity(state, moved.parentId)
      const descendantIds = collectActiveDescendantIds(state.entities, current.id)
      const next = {
        ...state,
        entities: state.entities.map((entity) => {
          if (entity.id === current.id) return moved
          if (!descendantIds.has(entity.id)) return entity
          const descendant = { ...entity, updatedAt: now }
          if (moved.teamId === undefined) delete descendant.teamId
          else descendant.teamId = moved.teamId
          if (moved.projectId === undefined) delete descendant.projectId
          else descendant.projectId = moved.projectId
          return descendant
        }),
      }
      validatePlanningState(next)
      return { state: next }
    })
  }

  /** Planning entity に status update を追記します。 */
  async addStatusUpdate(
    workspaceId: string,
    entityId: string,
    input: PlanningStatusUpdateInput,
    authorMemberKey: string,
    workItemState: PlanningWorkItemState,
  ) {
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
      const current = requireActiveEntity(state, entityId)
      const updateId = readIdentifier(input.id, 'Status update ID')
      if (current.statusUpdates.some((update) => update.id === updateId)) {
        throw conflict('PlanningStatusUpdateExists', `Status update "${updateId}" already exists.`)
      }
      if (current.statusUpdates.length >= MAX_STATUS_UPDATES) {
        throw new PlanningError(
          413,
          'PlanningStatusUpdateLimitExceeded',
          `Planning entities cannot exceed ${MAX_STATUS_UPDATES} status updates.`,
        )
      }
      const message = readMessage(input.message)
      const update = {
        id: updateId,
        message,
        authorMemberKey: readIdentifier(authorMemberKey, 'Author member key'),
        ...(input.health === undefined ? {} : { health: readHealth(input.health) }),
        ...(input.risk === undefined ? {} : { risk: readRisk(input.risk) }),
        createdAt: now,
      }
      const updated: StoredPlanningEntity = {
        ...current,
        ...(input.health === undefined ? {} : { health: readHealth(input.health) }),
        ...(input.risk === undefined ? {} : { risk: readRisk(input.risk) }),
        statusUpdates: [update, ...current.statusUpdates],
        updatedAt: now,
      }
      return { state: replaceEntity(state, updated) }
    })
  }

  /** Project / Initiative update cadence を設定または解除します。 */
  async configureUpdateCadence(
    workspaceId: string,
    input: ConfigurePlanningUpdateCadenceInput,
    workItemState: PlanningWorkItemState,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
  ): Promise<PlanningUpdateCadenceMutationResponse> {
    const result = await this.mutate(
      workspaceId,
      input.expectedRevision,
      workItemState,
      (state, now) => {
        const target = readPlanningUpdateTarget(input.target)
        requirePlanningUpdateTarget(state, target)
        const current = findStoredPlanningUpdateTarget(state, target)
        if (current?.archivedAt) {
          throw conflict('PlanningUpdateTargetArchived', 'Archived update targets cannot change cadence.')
        }
        const cadence = input.cadence === null
          ? undefined
          : readPlanningUpdateCadence(input.cadence)
        const cadenceAnchorDay = cadence?.cadence.unit === 'month'
          ? current?.cadence?.cadence.unit === 'month' &&
            current.cadence.timeZone === cadence.timeZone &&
            current.cadence.nextDueAt === cadence.nextDueAt
            ? current.cadenceAnchorDay
            : planningLocalDateTimeAt(
                Date.parse(cadence.nextDueAt),
                cadence.timeZone,
              ).day
          : undefined
        const updated: StoredPlanningUpdateTarget = {
          target,
          ...(cadence === undefined ? {} : { cadence }),
          ...(cadenceAnchorDay === undefined ? {} : { cadenceAnchorDay }),
          latestVersion: current?.latestVersion ?? 0,
          ...(current?.latestUpdate === undefined
            ? {}
            : { latestUpdate: structuredClone(current.latestUpdate) }),
          ...(current?.latestContextSnapshot === undefined
            ? {}
            : { latestContextSnapshot: structuredClone(current.latestContextSnapshot) }),
          updatedAt: now,
        }
        return { state: replacePlanningUpdateTarget(state, updated) }
      },
      authorizationConditionChecks,
    )
    const updateTarget = result.planning.updateTargets.find((candidate) =>
      planningUpdateTargetsEqual(candidate.target, readPlanningUpdateTarget(input.target))
    )
    if (!updateTarget) {
      throw new PlanningError(503, 'PlanningUpdateUnavailable', 'Updated target is unavailable.')
    }
    return { planning: result.planning, updateTarget }
  }

  /** Human-authored structured update を append-only publish します。 */
  async publishUpdate(
    workspaceId: string,
    input: PublishPlanningUpdateInput,
    authorMemberKey: string,
    workItemState: PlanningWorkItemState,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
    transaction?: PlanningMutationTransaction<PlanningUpdatePublishTransactionResult>,
  ): Promise<PlanningUpdatePublishResponse> {
    const result = await this.mutate(
      workspaceId,
      input.expectedRevision,
      workItemState,
      (state, now) => {
        const target = readPlanningUpdateTarget(input.target)
        requirePlanningUpdateTarget(state, target)
        const current = findStoredPlanningUpdateTarget(state, target)
        if (!current?.cadence) {
          throw conflict(
            'PlanningUpdateCadenceNotConfigured',
            'Configure an update cadence before publishing.',
          )
        }
        if (current.archivedAt) {
          throw conflict('PlanningUpdateTargetArchived', 'Archived update targets cannot publish.')
        }
        const id = readIdentifier(input.id, 'Planning update ID')
        if (current.latestUpdate?.id === id) {
          throw conflict('PlanningUpdateExists', `Planning update "${id}" already exists.`)
        }
        const health = readHealth(input.health)
        const risk = readRisk(input.risk)
        const summary = readPlanningUpdateText(input.summary, 'Summary', true)
        const riskSummary = readPlanningUpdateText(input.riskSummary, 'Risk summary')
        const decisionSummary = readPlanningUpdateText(input.decisionSummary, 'Decision summary')
        const helpNeeded = readPlanningUpdateText(input.helpNeeded, 'Help needed')
        const nextAction = readPlanningUpdateText(input.nextAction, 'Next action')
        const evidence = readPlanningUpdateEvidence(input.evidence)
        requirePlanningUpdateEvidenceExists(state, target, evidence, workItemState)
        const contextSnapshot = createPlanningUpdateContextSnapshot(
          state,
          target,
          health,
          risk,
          workItemState,
        )
        const version = current.latestVersion + 1
        if (!Number.isSafeInteger(version)) {
          throw conflict('PlanningUpdateVersionExhausted', 'Planning update version is exhausted.')
        }
        const update: PlanningUpdate = {
          id,
          target,
          version,
          contentVersion: PLANNING_UPDATE_CONTENT_VERSION,
          origin: 'manual',
          health,
          risk,
          summary,
          riskSummary,
          decisionSummary,
          helpNeeded,
          nextAction,
          progressSnapshot: structuredClone(contextSnapshot.progress),
          contextSnapshot,
          changes: createPlanningUpdateChanges(current.latestContextSnapshot, contextSnapshot),
          evidence,
          authorMemberKey: readIdentifier(authorMemberKey, 'Author member key').toLowerCase(),
          coveredDueAt: current.cadence.nextDueAt,
          createdAt: now,
        }
        const {
          nextNotificationAtRecordKey: _previousNotificationAtRecordKey,
          ...currentWithoutNotificationIndex
        } = current
        const updatedTarget: StoredPlanningUpdateTarget = {
          ...currentWithoutNotificationIndex,
          cadence: {
            ...current.cadence,
            nextDueAt: nextPlanningUpdateDueAt(
              current.cadence,
              now,
              current.cadenceAnchorDay,
            ),
          },
          latestVersion: version,
          latestUpdate: createLatestPlanningUpdateSummary(update),
          latestContextSnapshot: structuredClone(contextSnapshot),
          updatedAt: now,
        }
        let next = replacePlanningUpdateTarget(state, updatedTarget)
        if (target.type === 'initiative') {
          const entity = requireActiveEntity(next, target.entityId)
          next = replaceEntity(next, { ...entity, health, risk, updatedAt: now })
        }
        return { state: next, publishedUpdate: update }
      },
      authorizationConditionChecks,
      transaction,
    )
    if (!result.publishedUpdate) {
      throw new PlanningError(503, 'PlanningUpdateUnavailable', 'Published update is unavailable.')
    }
    return { planning: result.planning, update: result.publishedUpdate }
  }

  /** Target-local immutable update history を新しい順に返します。 */
  async listUpdates(
    workspaceId: string,
    input: ListPlanningUpdatesInput,
  ): Promise<PlanningUpdateHistoryPage> {
    const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    const target = readPlanningUpdateTarget(input.target)
    const limit = readPlanningUpdateHistoryLimit(input.limit)
    const cursor = input.cursor === undefined
      ? undefined
      : readPlanningUpdateHistoryCursor(input.cursor, target)
    return this.readUpdateHistory(normalizedWorkspaceId, target, limit, cursor)
  }

  /** Appends one comment and its optional durable receipt to an immutable update. */
  async createUpdateComment(
    workspaceId: string,
    input: CreatePlanningUpdateCommentInput,
    authorMemberKey: string,
    transaction?: PlanningMutationTransaction<PlanningUpdateAnnotationTransactionResult>,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
  ): Promise<PlanningUpdateComment> {
    const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    const target = readPlanningUpdateTarget(input.target)
    const updateVersion = readPlanningUpdateVersion(input.updateVersion)
    const comment: PlanningUpdateComment = {
      id: readIdentifier(input.id, 'Planning update comment ID'),
      target,
      updateVersion,
      body: readPlanningUpdateCommentBody(input.body),
      authorMemberKey: readOwnerMemberKey(authorMemberKey),
      createdAt: this.now().toISOString(),
    }
    const transactionContribution = transaction
      ? await preparePlanningMutationTransactionContribution(transaction, {
          kind: 'comment-create',
          comment: structuredClone(comment),
        })
      : undefined
    await this.appendUpdateComment(
      normalizedWorkspaceId,
      comment,
      transactionContribution,
      authorizationConditionChecks,
    )
    return structuredClone(comment)
  }

  /** Immutable update comments を新しい順に page 取得します。 */
  async listUpdateComments(
    workspaceId: string,
    input: ListPlanningUpdateCommentsInput,
  ): Promise<PlanningUpdateCommentPage> {
    const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    const target = readPlanningUpdateTarget(input.target)
    const updateVersion = readPlanningUpdateVersion(input.updateVersion)
    await this.requirePlanningUpdateVersionExists(
      normalizedWorkspaceId,
      target,
      updateVersion,
    )
    const limit = readPlanningUpdateHistoryLimit(input.limit)
    const cursor = input.cursor === undefined
      ? undefined
      : readPlanningUpdateAnnotationCursor(input.cursor, 'comment', target, updateVersion)
    return this.readUpdateComments(
      normalizedWorkspaceId,
      target,
      updateVersion,
      limit,
      cursor,
    )
  }

  /** Adds one current-member reaction and its optional durable receipt. */
  async addUpdateReaction(
    workspaceId: string,
    input: PlanningUpdateReactionInput,
    memberKey: string,
    transaction?: PlanningMutationTransaction<PlanningUpdateAnnotationTransactionResult>,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
  ): Promise<PlanningUpdateReaction> {
    const reaction: PlanningUpdateReaction = {
      target: readPlanningUpdateTarget(input.target),
      updateVersion: readPlanningUpdateVersion(input.updateVersion),
      emoji: readPlanningUpdateReaction(input.emoji),
      memberKey: readOwnerMemberKey(memberKey),
      createdAt: this.now().toISOString(),
    }
    const transactionContribution = transaction
      ? await preparePlanningMutationTransactionContribution(transaction, {
          kind: 'reaction-add',
          reaction: structuredClone(reaction),
        })
      : undefined
    await this.putUpdateReaction(
      readIdentifier(workspaceId, 'Workspace ID'),
      reaction,
      transactionContribution,
      authorizationConditionChecks,
    )
    return structuredClone(reaction)
  }

  /** Removes one current-member reaction and commits its optional durable receipt. */
  async removeUpdateReaction(
    workspaceId: string,
    input: PlanningUpdateReactionInput,
    memberKey: string,
    transaction?: PlanningMutationTransaction<PlanningUpdateAnnotationTransactionResult>,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
  ): Promise<void> {
    const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    const target = readPlanningUpdateTarget(input.target)
    const updateVersion = readPlanningUpdateVersion(input.updateVersion)
    const emoji = readPlanningUpdateReaction(input.emoji)
    const normalizedMemberKey = readOwnerMemberKey(memberKey)
    const transactionContribution = transaction
      ? await preparePlanningMutationTransactionContribution(transaction, {
          kind: 'reaction-remove',
          target: structuredClone(target),
          updateVersion,
          emoji,
          memberKey: normalizedMemberKey,
        })
      : undefined
    await this.deleteUpdateReaction(
      normalizedWorkspaceId,
      target,
      updateVersion,
      emoji,
      normalizedMemberKey,
      transactionContribution,
      authorizationConditionChecks,
    )
  }

  /** Immutable update reactions を stable key 順に page 取得します。 */
  async listUpdateReactions(
    workspaceId: string,
    input: ListPlanningUpdateReactionsInput,
  ): Promise<PlanningUpdateReactionPage> {
    const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    const target = readPlanningUpdateTarget(input.target)
    const updateVersion = readPlanningUpdateVersion(input.updateVersion)
    await this.requirePlanningUpdateVersionExists(
      normalizedWorkspaceId,
      target,
      updateVersion,
    )
    const limit = readPlanningUpdateHistoryLimit(input.limit)
    const cursor = input.cursor === undefined
      ? undefined
      : readPlanningUpdateAnnotationCursor(input.cursor, 'reaction', target, updateVersion)
    return this.readUpdateReactions(
      normalizedWorkspaceId,
      target,
      updateVersion,
      limit,
      cursor,
    )
  }

  /**
   * Fails closed when an annotation targets a missing immutable update.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param target - Project or Initiative target.
   * @param updateVersion - Target-local immutable version.
   */
  private async requirePlanningUpdateVersionExists(
    workspaceId: string,
    target: PlanningUpdateTarget,
    updateVersion: number,
  ) {
    if (!await this.planningUpdateExists(workspaceId, target, updateVersion)) {
      throw notFound('PlanningUpdateNotFound', 'Planning update was not found.')
    }
  }

  /** Planning dependency を作成します。 */
  async createDependency(
    workspaceId: string,
    input: CreatePlanningDependencyInput,
    workItemState: PlanningWorkItemState,
  ) {
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
      const id = readIdentifier(input.id, 'Dependency ID')
      if (state.dependencies.some((dependency) => dependency.id === id)) {
        throw conflict('PlanningDependencyExists', `Dependency "${id}" already exists.`)
      }
      const dependency: PlanningDependency = {
        id,
        predecessorId: readIdentifier(input.predecessorId, 'Predecessor ID'),
        successorId: readIdentifier(input.successorId, 'Successor ID'),
        type: readDependencyType(input.type),
        lagDays: readLagDays(input.lagDays),
        ...(input.constraint === undefined
          ? {}
          : { constraint: readDependencyConstraint(input.constraint) }),
        createdAt: now,
      }
      requireActiveEntity(state, dependency.predecessorId)
      requireActiveEntity(state, dependency.successorId)
      const next = { ...state, dependencies: [...state.dependencies, dependency] }
      validatePlanningState(next)
      return { state: next }
    })
  }

  /** Planning dependency を削除します。 */
  async deleteDependency(
    workspaceId: string,
    dependencyId: string,
    input: PlanningRevisionInput,
    workItemState: PlanningWorkItemState,
  ) {
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state) => {
      const id = readIdentifier(dependencyId, 'Dependency ID')
      if (!state.dependencies.some((dependency) => dependency.id === id)) {
        throw notFound('PlanningDependencyNotFound', `Dependency "${id}" was not found.`)
      }
      return {
        state: {
          ...state,
          dependencies: state.dependencies.filter((dependency) => dependency.id !== id),
        },
      }
    })
  }

  /**
   * Creates one canonical schedule dependency between Work Items.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param input - Candidate dependency and expected Planning revision.
   * @param workItemState - Canonical endpoint schedules and revisions.
   * @param authorizationConditionChecks - Caller authorization rows guarded during persistence.
   * @param transaction - Optional durable completion receipt prepared for the same transaction.
   * @returns The updated Planning snapshot.
   */
  async createWorkItemDependency(
    workspaceId: string,
    input: CreateWorkItemScheduleDependencyInput,
    workItemState: PlanningWorkItemState,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
    transaction?: PlanningMutationTransaction,
  ) {
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
      const id = readIdentifier(input.id, 'Work Item dependency ID')
      if (state.workItemDependencies.some((dependency) => dependency.id === id)) {
        throw conflict(
          'PlanningWorkItemDependencyExists',
          `Work Item dependency "${id}" already exists.`,
        )
      }
      const predecessor = readWorkItemDependencyEndpoint(input.predecessor, 'Predecessor')
      const successor = readWorkItemDependencyEndpoint(input.successor, 'Successor')
      const dependency: WorkItemScheduleDependency = {
        id,
        predecessor,
        successor,
        type: readDependencyType(input.type),
        lagDays: readLagDays(input.lagDays),
        ...(input.constraint === undefined
          ? {}
          : { constraint: readDependencyConstraint(input.constraint) }),
        createdAt: now,
        updatedAt: now,
      }
      const workItemConditions = requireWorkItemDependencyEndpoints(workItemState, dependency)
      const next = {
        ...state,
        workItemDependencies: [...state.workItemDependencies, dependency],
      }
      validatePlanningState(next)
      requireCurrentWorkItemDependencyIsSatisfied(workItemState, dependency)
      return {
        state: next,
        workItemConditions,
        workItemDependencyTransactionSource: { kind: 'upsert', dependency },
      }
    }, authorizationConditionChecks, transaction)
  }

  /**
   * Updates editable fields of a canonical Work Item schedule dependency.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param dependencyId - Workspace-local dependency identifier.
   * @param input - Patch and expected Planning revision.
   * @param workItemState - Canonical endpoint schedules and revisions.
   * @param authorizationConditionChecks - Caller authorization rows guarded during persistence.
   * @param transaction - Optional durable completion receipt prepared for the same transaction.
   * @returns The updated Planning snapshot.
   */
  async updateWorkItemDependency(
    workspaceId: string,
    dependencyId: string,
    input: UpdateWorkItemScheduleDependencyInput,
    workItemState: PlanningWorkItemState,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
    transaction?: PlanningMutationTransaction,
  ) {
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
      const id = readIdentifier(dependencyId, 'Work Item dependency ID')
      const current = state.workItemDependencies.find((dependency) => dependency.id === id)
      if (!current) {
        throw notFound(
          'PlanningWorkItemDependencyNotFound',
          `Work Item dependency "${id}" was not found.`,
        )
      }
      if (!isRecord(input.patch)) {
        throw invalid(
          'PlanningWorkItemDependencyPatchInvalid',
          'Work Item dependency patch must be an object.',
        )
      }
      const patchKeys = Object.keys(input.patch)
      if (
        patchKeys.length === 0 ||
        patchKeys.some((key) => key !== 'type' && key !== 'lagDays' && key !== 'constraint')
      ) {
        throw invalid(
          'PlanningWorkItemDependencyPatchInvalid',
          'Work Item dependency patch must contain only editable fields.',
        )
      }
      const updated: WorkItemScheduleDependency = {
        ...current,
        ...(input.patch.type === undefined
          ? {}
          : { type: readDependencyType(input.patch.type) }),
        ...(input.patch.lagDays === undefined
          ? {}
          : { lagDays: readLagDays(input.patch.lagDays) }),
        updatedAt: now,
      }
      if (input.patch.constraint !== undefined) {
        if (input.patch.constraint === null) delete updated.constraint
        else updated.constraint = readDependencyConstraint(input.patch.constraint)
      }
      const workItemConditions = requireWorkItemDependencyEndpoints(workItemState, updated)
      const next = {
        ...state,
        workItemDependencies: state.workItemDependencies.map((dependency) =>
          dependency.id === id ? updated : dependency
        ),
      }
      validatePlanningState(next)
      requireCurrentWorkItemDependencyIsSatisfied(workItemState, updated)
      return {
        state: next,
        workItemConditions,
        workItemDependencyTransactionSource: { kind: 'upsert', dependency: updated },
      }
    }, authorizationConditionChecks, transaction)
  }

  /**
   * Deletes one canonical Work Item schedule dependency.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param dependencyId - Workspace-local dependency identifier.
   * @param input - Expected Planning revision.
   * @param workItemState - Canonical endpoint schedules and revisions.
   * @param authorizationConditionChecks - Caller authorization rows guarded during persistence.
   * @param transaction - Optional durable completion receipt prepared for the same transaction.
   * @returns The updated Planning snapshot.
   */
  async deleteWorkItemDependency(
    workspaceId: string,
    dependencyId: string,
    input: PlanningRevisionInput,
    workItemState: PlanningWorkItemState,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
    transaction?: PlanningMutationTransaction,
  ) {
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state) => {
      const id = readIdentifier(dependencyId, 'Work Item dependency ID')
      const current = state.workItemDependencies.find((dependency) => dependency.id === id)
      if (!current) {
        throw notFound(
          'PlanningWorkItemDependencyNotFound',
          `Work Item dependency "${id}" was not found.`,
        )
      }
      return {
        state: {
          ...state,
          workItemDependencies: state.workItemDependencies.filter((dependency) =>
            dependency.id !== id
          ),
        },
        workItemConditions: requireWorkItemDependencyEndpoints(workItemState, current),
        workItemDependencyTransactionSource: { kind: 'delete', dependency: current },
      }
    }, authorizationConditionChecks, transaction)
  }

  /** Work Item planning link を作成または置換します。 */
  async putWorkItemLink(
    workspaceId: string,
    input: PlanningWorkItemLinkInput,
    workItemState: PlanningWorkItemState,
  ) {
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
      const teamId = readIdentifier(input.teamId, 'Team ID')
      const workItemId = readIdentifier(input.workItemId, 'Work Item ID')
      const summary = requireWorkItem(workItemState, teamId, workItemId)
      const projectId = input.projectId ?? summary.projectId
      const current = state.workItemLinks.find((link) =>
        link.teamId === teamId && link.workItemId === workItemId,
      )
      const link: PlanningWorkItemLink = {
        teamId,
        workItemId,
        ...(projectId === undefined ? {} : { projectId: readIdentifier(projectId, 'Project ID') }),
        ...(input.cycleId === undefined ? {} : { cycleId: readIdentifier(input.cycleId, 'Cycle ID') }),
        ...(input.milestoneId === undefined
          ? {}
          : { milestoneId: readIdentifier(input.milestoneId, 'Milestone ID') }),
        goalIds: readUniqueIdentifiers(input.goalIds, 'Goal ID'),
        createdAt: current?.createdAt ?? now,
      }
      if ((link.projectId ?? summary.projectId) !== summary.projectId) {
        throw invalid('PlanningWorkItemProjectMismatch', 'Work Item link Project does not match the Work Item.')
      }
      validateWorkItemLink(state, link, true)
      const next = {
        ...state,
        workItemLinks: [
          ...state.workItemLinks.filter((candidate) =>
            candidate.teamId !== teamId || candidate.workItemId !== workItemId,
          ),
          link,
        ],
      }
      validateCycleCapacities(next)
      return {
        state: next,
        workItemConditions: [{
          teamId,
          workItemId,
          revision: readRevision(summary.revision),
        }],
      }
    })
  }

  /** Work Item planning link を削除します。 */
  async deleteWorkItemLink(
    workspaceId: string,
    teamId: string,
    workItemId: string,
    input: PlanningRevisionInput,
    workItemState: PlanningWorkItemState,
  ) {
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state) => {
      const normalizedTeamId = readIdentifier(teamId, 'Team ID')
      const normalizedWorkItemId = readIdentifier(workItemId, 'Work Item ID')
      const exists = state.workItemLinks.some((link) =>
        link.teamId === normalizedTeamId && link.workItemId === normalizedWorkItemId,
      )
      if (!exists) {
        throw notFound('PlanningWorkItemLinkNotFound', 'Planning Work Item link was not found.')
      }
      return {
        state: {
          ...state,
          workItemLinks: state.workItemLinks.filter((link) =>
            link.teamId !== normalizedTeamId || link.workItemId !== normalizedWorkItemId,
          ),
        },
      }
    })
  }

  /** Cycle を完了し、policy に従って未完了 Work Item を rollover します。 */
  async rolloverCycle(
    workspaceId: string,
    sourceCycleId: string,
    input: CycleRolloverInput,
    workItemState: PlanningWorkItemState,
  ) {
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
      const source = requireActiveEntity(state, sourceCycleId)
      const target = requireActiveEntity(state, input.targetCycleId)
      if (source.type !== 'cycle' || target.type !== 'cycle') {
        throw invalid('PlanningCycleRequired', 'Cycle rollover requires source and target Cycle entities.')
      }
      if (source.id === target.id) {
        throw invalid('PlanningCycleRolloverSelf', 'A Cycle cannot roll over into itself.')
      }
      if (source.status === 'completed' || source.status === 'canceled') {
        throw conflict('PlanningCycleRolloverSourceClosed', 'A completed or canceled Cycle cannot roll over again.')
      }
      if (target.status === 'completed' || target.status === 'canceled') {
        throw conflict(
          'PlanningCycleRolloverTargetClosed',
          'A completed or canceled Cycle cannot receive rollover Work Items.',
        )
      }
      if (source.teamId !== target.teamId || source.projectId !== target.projectId) {
        throw conflict('PlanningCycleScopeMismatch', 'Source and target Cycles must have the same scope.')
      }
      if (
        source.cadence?.unit !== target.cadence?.unit ||
        source.cadence?.count !== target.cadence?.count
      ) {
        throw conflict(
          'PlanningCycleCadenceMismatch',
          'Source and target Cycles must use the same cadence.',
        )
      }
      if (
        target.baseline.startDate <= source.baseline.endDate ||
        target.forecast.startDate <= source.forecast.endDate
      ) {
        throw conflict(
          'PlanningCycleDateOrderInvalid',
          'Target Cycle dates must start after the source Cycle dates.',
        )
      }
      const summaries = createWorkItemMap(workItemState)
      const movedWorkItemIds: string[] = []
      const retainedWorkItemIds: string[] = []
      const sourceLinks = state.workItemLinks.filter((link) => link.cycleId === source.id)
      if (sourceLinks.length > MAX_ROLLOVER_LINK_MUTATIONS) {
        throw new PlanningError(
          413,
          'PlanningCycleRolloverLimitExceeded',
          `Cycle rollover cannot validate more than ${MAX_ROLLOVER_LINK_MUTATIONS} Work Items at once.`,
        )
      }
      const workItemConditions: PlanningWorkItemCondition[] = []
      const links = state.workItemLinks.map((link) => {
        if (link.cycleId !== source.id) return link
        const summary = summaries.get(createWorkItemKey(link.teamId, link.workItemId))
        if (!summary) {
          throw new PlanningError(503, 'PlanningWorkItemMissing', 'A linked Work Item is missing.')
        }
        if (link.projectId !== summary.projectId) {
          throw conflict(
            'PlanningWorkItemProjectMismatch',
            'A linked Work Item changed Project. Re-link it before rollover.',
          )
        }
        workItemConditions.push({
          teamId: link.teamId,
          workItemId: link.workItemId,
          revision: readRevision(summary.revision),
        })
        if (summary.statusCategory === 'completed' || summary.statusCategory === 'canceled') {
          return link
        }
        if (source.carryOverPolicy === 'move-incomplete') {
          movedWorkItemIds.push(link.workItemId)
          return { ...link, cycleId: target.id }
        }
        retainedWorkItemIds.push(link.workItemId)
        return link
      })
      const completedSource: StoredPlanningEntity = {
        ...source,
        status: 'completed',
        updatedAt: now,
      }
      const next = { ...replaceEntity(state, completedSource), workItemLinks: links }
      validateCycleCapacities(next)
      return {
        state: next,
        movedWorkItemIds: movedWorkItemIds.sort(),
        retainedWorkItemIds: retainedWorkItemIds.sort(),
        workItemConditions,
      }
    })
  }

  /**
   * Validates the global revision, applies a domain mutation, and commits its guarded state.
   *
   * @param workspaceIdValue - Candidate Workspace identifier.
   * @param expectedRevisionValue - Planning revision required by the caller.
   * @param workItemState - Canonical Work Item projection used by the mutation.
   * @param mutation - Pure state transition applied after the revision check.
   * @param authorizationConditionChecks - Caller authorization rows guarded during persistence.
   * @param transaction - Optional durable completion receipt prepared before persistence.
   * @returns The updated Planning snapshot and mutation metadata.
   */
  private async mutate(
    workspaceIdValue: string,
    expectedRevisionValue: number,
    workItemState: PlanningWorkItemState,
    mutation: (state: PlanningWorkspaceState, now: string) => PlanningMutationResult,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
    transaction?: PlanningMutationTransaction<PlanningMutationTransactionResult>,
  ) {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const expectedRevision = readRevision(expectedRevisionValue)
    const before = await this.readState(workspaceId)
    if (before.revision !== expectedRevision) {
      throw conflict('PlanningRevisionConflict', 'Planning changed. Reload and try again.')
    }
    const result = mutation(structuredClone(before), this.now().toISOString())
    validatePlanningState(result.state)
    const after = {
      ...result.state,
      revision: before.revision + 1,
      updatedAt: this.now().toISOString(),
    }
    const planning = createPlanningSnapshot(after, workItemState, this.now().toISOString())
    const transactionResult: PlanningMutationTransactionResult | undefined =
      result.publishedUpdate === undefined
        ? result.workItemDependencyTransactionSource === undefined
          ? undefined
          : {
              ...result.workItemDependencyTransactionSource,
              revision: after.revision,
              dependency: structuredClone(result.workItemDependencyTransactionSource.dependency),
            }
        : {
            kind: 'publish',
            revision: after.revision,
            update: structuredClone(result.publishedUpdate),
          }
    const transactionContribution = transaction
      ? await preparePlanningMutationTransactionContribution(
          transaction,
          transactionResult,
        )
      : undefined
    await this.commitState(
      workspaceId,
      before,
      after,
      result.workItemConditions,
      authorizationConditionChecks,
      transactionContribution,
      result.publishedUpdate,
    )
    return {
      planning,
      movedWorkItemIds: result.movedWorkItemIds ?? [],
      retainedWorkItemIds: result.retainedWorkItemIds ?? [],
      ...(result.publishedUpdate === undefined
        ? {}
        : { publishedUpdate: structuredClone(result.publishedUpdate) }),
    }
  }
}

/**
 * Prepares and validates one external transaction contribution without exposing a full snapshot.
 *
 * @param transaction - Caller-provided durable receipt boundary.
 * @param result - Minimal committed dependency result, when the mutation supports receipts.
 * @returns The conditional DynamoDB action that must commit with Planning state.
 */
async function preparePlanningMutationTransactionContribution<
  TResult extends PlanningMutationTransactionResult,
>(
  transaction: PlanningMutationTransaction<TResult>,
  result: TResult | undefined,
): Promise<PlanningMutationTransactionContribution> {
  if (!result) {
    throw new PlanningError(
      503,
      'PlanningIdempotencyUnavailable',
      'The durable Planning mutation receipt is unavailable.',
    )
  }
  try {
    const contribution = await transaction.prepare(result)
    if (!isPlanningMutationTransactionContribution(contribution)) {
      throw new Error('Planning receipt contribution is unavailable.')
    }
    return contribution
  } catch (error) {
    if (error instanceof PlanningError) throw error
    throw new PlanningError(
      503,
      'PlanningIdempotencyUnavailable',
      'The durable Planning mutation receipt could not be prepared.',
    )
  }
}

/**
 * Validates an opaque caller contribution before it crosses into the Planning DynamoDB adapter.
 *
 * @param value - Unknown contribution returned by the application transaction port.
 * @returns Whether the value contains exactly one supported DynamoDB transaction action.
 */
function isPlanningMutationTransactionContribution(
  value: unknown,
): value is PlanningMutationTransactionContribution {
  if (!isRecord(value)) return false
  return isPlanningTransactWriteItem(value.transactWriteItem)
}

/**
 * Validates the required storage fields of one DynamoDB transaction action.
 *
 * @param value - Unknown transaction action candidate.
 * @returns Whether exactly one condition, delete, put, or update action is complete.
 */
function isPlanningTransactWriteItem(
  value: unknown,
): value is NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  if (!isRecord(value)) return false
  const conditionIsValid = isRecord(value.ConditionCheck) &&
    typeof value.ConditionCheck.TableName === 'string' &&
    isRecord(value.ConditionCheck.Key) &&
    typeof value.ConditionCheck.ConditionExpression === 'string'
  const deleteIsValid = isRecord(value.Delete) &&
    typeof value.Delete.TableName === 'string' &&
    isRecord(value.Delete.Key)
  const putIsValid = isRecord(value.Put) &&
    typeof value.Put.TableName === 'string' &&
    isRecord(value.Put.Item)
  const updateIsValid = isRecord(value.Update) &&
    typeof value.Update.TableName === 'string' &&
    isRecord(value.Update.Key) &&
    typeof value.Update.UpdateExpression === 'string'
  return [conditionIsValid, deleteIsValid, putIsValid, updateIsValid]
    .filter(Boolean).length === 1
}

/** Test / local domain 利用向けの in-memory Planning client です。 */
export class InMemoryPlanningClient extends BasePlanningClient {
  /** Workspace ID ごとの永続化 state です。 */
  private readonly states = new Map<string, PlanningWorkspaceState>()
  /** Workspace / target ごとの append-only update history です。 */
  private readonly updateHistories = new Map<string, PlanningUpdate[]>()
  /** Immutable update ごとの append-only comments です。 */
  private readonly updateComments = new Map<string, PlanningUpdateComment[]>()
  /** Immutable update ごとの member reactions です。 */
  private readonly updateReactions = new Map<string, PlanningUpdateReaction[]>()

  constructor(now: () => Date = () => new Date()) {
    super(now)
  }

  /** In-memory state を返します。 */
  protected async readState(workspaceId: string) {
    return structuredClone(this.states.get(workspaceId) ?? createEmptyPlanningState())
  }

  /** In-memory immutable history の1 pageを返します。 */
  protected async readUpdateHistory(
    workspaceId: string,
    target: PlanningUpdateTarget,
    limit: number,
    cursor?: string,
  ): Promise<PlanningUpdateHistoryPage> {
    const history = this.updateHistories.get(createPlanningUpdateHistoryMapKey(workspaceId, target)) ?? []
    const beforeVersion = cursor === undefined
      ? Number.POSITIVE_INFINITY
      : decodePlanningUpdateHistoryCursor(cursor, target)
    const candidates = history
      .filter((update) => update.version < beforeVersion)
      .sort((first, second) => second.version - first.version)
    const updates = candidates.slice(0, limit).map((update) => structuredClone(update))
    const hasMore = candidates.length > updates.length
    const last = updates.at(-1)
    return {
      updates,
      ...(hasMore && last
        ? { nextCursor: createPlanningUpdateHistoryCursor(target, last.version) }
        : {}),
    }
  }

  /** In-memory history で immutable update version の存在を検証します。 */
  protected async planningUpdateExists(
    workspaceId: string,
    target: PlanningUpdateTarget,
    updateVersion: number,
  ) {
    const history = this.updateHistories.get(createPlanningUpdateHistoryMapKey(workspaceId, target))
    return history?.some((update) => update.version === updateVersion) ?? false
  }

  /** In-memory comment collection に append-only comment を追加します。 */
  protected async appendUpdateComment(
    workspaceId: string,
    comment: PlanningUpdateComment,
    _transactionContribution?: PlanningMutationTransactionContribution,
    _authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
  ) {
    if (!await this.planningUpdateExists(workspaceId, comment.target, comment.updateVersion)) {
      throw notFound('PlanningUpdateNotFound', 'Planning update was not found.')
    }
    const key = createPlanningUpdateAnnotationMapKey(
      workspaceId,
      comment.target,
      comment.updateVersion,
    )
    const comments = this.updateComments.get(key) ?? []
    if (comments.some((candidate) => candidate.id === comment.id)) {
      throw conflict('PlanningUpdateCommentExists', 'Planning update comment already exists.')
    }
    this.updateComments.set(key, [...comments, structuredClone(comment)])
  }

  /** In-memory comments の cursor page を返します。 */
  protected async readUpdateComments(
    workspaceId: string,
    target: PlanningUpdateTarget,
    updateVersion: number,
    limit: number,
    cursor?: string,
  ): Promise<PlanningUpdateCommentPage> {
    const key = createPlanningUpdateAnnotationMapKey(workspaceId, target, updateVersion)
    const boundary = cursor === undefined
      ? undefined
      : decodePlanningUpdateAnnotationCursor(cursor, 'comment', target, updateVersion)
    const candidates = (this.updateComments.get(key) ?? [])
      .map((comment) => ({
        comment,
        recordKey: createPlanningUpdateCommentRecordKey(comment),
      }))
      .filter((candidate) => boundary === undefined || candidate.recordKey < boundary)
      .sort((first, second) => compareText(second.recordKey, first.recordKey))
    const page = candidates.slice(0, limit)
    const last = page.at(-1)
    return {
      comments: page.map(({ comment }) => structuredClone(comment)),
      ...(candidates.length > page.length && last
        ? {
            nextCursor: createPlanningUpdateAnnotationCursor(
              'comment', target, updateVersion, last.comment,
            ),
          }
        : {}),
    }
  }

  /** In-memory reaction collection に current member reaction を追加します。 */
  protected async putUpdateReaction(
    workspaceId: string,
    reaction: PlanningUpdateReaction,
    _transactionContribution?: PlanningMutationTransactionContribution,
    _authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
  ) {
    if (!await this.planningUpdateExists(workspaceId, reaction.target, reaction.updateVersion)) {
      throw notFound('PlanningUpdateNotFound', 'Planning update was not found.')
    }
    const key = createPlanningUpdateAnnotationMapKey(
      workspaceId,
      reaction.target,
      reaction.updateVersion,
    )
    const reactions = this.updateReactions.get(key) ?? []
    if (reactions.some((candidate) =>
      candidate.emoji === reaction.emoji && candidate.memberKey === reaction.memberKey
    )) {
      throw conflict('PlanningUpdateReactionExists', 'Planning update reaction already exists.')
    }
    this.updateReactions.set(key, [...reactions, structuredClone(reaction)])
  }

  /** In-memory reaction collection から current member reaction を削除します。 */
  protected async deleteUpdateReaction(
    workspaceId: string,
    target: PlanningUpdateTarget,
    updateVersion: number,
    emoji: string,
    memberKey: string,
    _transactionContribution?: PlanningMutationTransactionContribution,
    _authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
  ) {
    if (!await this.planningUpdateExists(workspaceId, target, updateVersion)) {
      throw notFound('PlanningUpdateNotFound', 'Planning update was not found.')
    }
    const key = createPlanningUpdateAnnotationMapKey(workspaceId, target, updateVersion)
    const reactions = this.updateReactions.get(key) ?? []
    this.updateReactions.set(key, reactions.filter((candidate) =>
      candidate.emoji !== emoji || candidate.memberKey !== memberKey
    ))
  }

  /** In-memory reactions の cursor page を返します。 */
  protected async readUpdateReactions(
    workspaceId: string,
    target: PlanningUpdateTarget,
    updateVersion: number,
    limit: number,
    cursor?: string,
  ): Promise<PlanningUpdateReactionPage> {
    const key = createPlanningUpdateAnnotationMapKey(workspaceId, target, updateVersion)
    const boundary = cursor === undefined
      ? undefined
      : decodePlanningUpdateAnnotationCursor(cursor, 'reaction', target, updateVersion)
    const candidates = (this.updateReactions.get(key) ?? [])
      .map((reaction) => ({
        reaction,
        recordKey: createPlanningUpdateReactionRecordKey(reaction),
      }))
      .filter((candidate) => boundary === undefined || candidate.recordKey < boundary)
      .sort((first, second) => compareText(second.recordKey, first.recordKey))
    const page = candidates.slice(0, limit)
    const last = page.at(-1)
    return {
      reactions: page.map(({ reaction }) => structuredClone(reaction)),
      ...(candidates.length > page.length && last
        ? {
            nextCursor: createPlanningUpdateAnnotationCursor(
              'reaction', target, updateVersion, last.reaction,
            ),
          }
        : {}),
    }
  }

  /** Revision CAS 後に in-memory state を置換します。 */
  protected async commitState(
    workspaceId: string,
    before: PlanningWorkspaceState,
    after: PlanningWorkspaceState,
    _workItemConditions: readonly PlanningWorkItemCondition[] = [],
    _authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
    _transactionContribution?: PlanningMutationTransactionContribution,
    publishedUpdate?: PlanningUpdate,
  ) {
    const current = this.states.get(workspaceId) ?? createEmptyPlanningState()
    if (current.revision !== before.revision) {
      throw conflict('PlanningRevisionConflict', 'Planning changed. Reload and try again.')
    }
    if (publishedUpdate) {
      const key = createPlanningUpdateHistoryMapKey(workspaceId, publishedUpdate.target)
      const currentHistory = this.updateHistories.get(key) ?? []
      if (currentHistory.some((update) =>
        update.version === publishedUpdate.version || update.id === publishedUpdate.id
      )) {
        throw conflict('PlanningUpdateExists', 'Planning update version or ID already exists.')
      }
      this.updateHistories.set(key, [structuredClone(publishedUpdate), ...currentHistory])
    }
    this.states.set(workspaceId, structuredClone(after))
  }
}

/** DynamoDB の Planning table を利用する client です。 */
export class DynamoDbPlanningClient extends BasePlanningClient {
  /** Planning rows を保存する DynamoDB table 名です。 */
  private readonly tableName: string
  /** Canonical Work Item rows を条件検証する DynamoDB table 名です。 */
  private readonly workItemsTableName: string
  /** DynamoDB DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Local bootstrap 用の低レベル DynamoDB client です。 */
  private readonly dynamoDbClient: DynamoDBClient
  /** Local table の自動作成を有効にするかどうかです。 */
  private readonly bootstrapLocalTable: boolean

  constructor(
    tableName = process.env.PLANNING_TABLE_NAME ?? 'mukuroji-planning-local',
    documentClient = createDocumentClient(),
    dynamoDbClient = createDynamoDbClient(),
    bootstrapLocalTable = Boolean(getDynamoDbEndpoint()),
    now: () => Date = () => new Date(),
    workItemsTableName = process.env.MUKUROJI_WORK_ITEMS_TABLE ??
      process.env.WORK_ITEMS_TABLE_NAME ??
      process.env.MUKUROJI_TEAM_ISSUES_TABLE ??
      process.env.TEAM_ISSUES_TABLE_NAME ??
      'mukuroji-team-issues-local',
  ) {
    super(now)
    this.tableName = tableName
    this.workItemsTableName = workItemsTableName
    this.documentClient = documentClient
    this.dynamoDbClient = dynamoDbClient
    this.bootstrapLocalTable = bootstrapLocalTable
  }

  /** Stable global revision に対応する Workspace state を読み込みます。 */
  protected async readState(workspaceId: string) {
    await this.ensureTable()
    const before = await this.readMeta(workspaceId)
    const items: Record<string, unknown>[] = []
    for (const { recordPrefix, entryType } of PLANNING_GRAPH_ROW_QUERIES) {
      let exclusiveStartKey: Record<string, unknown> | undefined
      do {
        const response = await this.documentClient.send(new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression:
            'workspaceId = :workspaceId AND begins_with(recordKey, :recordPrefix)',
          ExpressionAttributeValues: {
            ':workspaceId': workspaceId,
            ':recordPrefix': recordPrefix,
          },
          ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
          ConsistentRead: true,
          Limit: PLANNING_READ_LIMIT - items.length,
        }))
        const pageItems = response.Items ?? []
        if (pageItems.some((item) =>
          typeof item.recordKey !== 'string' ||
          !item.recordKey.startsWith(recordPrefix) ||
          item.entryType !== entryType
        )) {
          throw persistenceInvalid('Planning graph query returned an invalid row.')
        }
        items.push(...pageItems)
        if (items.length >= PLANNING_READ_LIMIT) {
          throw new PlanningError(
            413,
            'PlanningReadLimitExceeded',
            `Planning Workspace cannot exceed ${PLANNING_READ_LIMIT} rows.`,
          )
        }
        exclusiveStartKey = response.LastEvaluatedKey
      } while (exclusiveStartKey)
    }
    const after = await this.readMeta(workspaceId)
    if (before.revision !== after.revision) {
      throw conflict('PlanningRevisionConflict', 'Planning changed while it was being read.')
    }
    if (before.revision === 0 && items.some((item) => item.recordKey !== META_RECORD_KEY)) {
      throw persistenceInvalid('Planning rows exist without metadata.')
    }
    return readPlanningRows(items, before, workspaceId)
  }

  /** DynamoDB target prefix から append-only update history の1 pageを返します。 */
  protected async readUpdateHistory(
    workspaceId: string,
    target: PlanningUpdateTarget,
    limit: number,
    cursor?: string,
  ): Promise<PlanningUpdateHistoryPage> {
    await this.ensureTable()
    const prefix = createPlanningUpdateRecordPrefix(target)
    const beforeVersion = cursor === undefined
      ? undefined
      : decodePlanningUpdateHistoryCursor(cursor, target)
    try {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          'workspaceId = :workspaceId AND begins_with(recordKey, :recordPrefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':recordPrefix': prefix,
        },
        ...(beforeVersion === undefined
          ? {}
          : {
              ExclusiveStartKey: {
                workspaceId,
                recordKey: createPlanningUpdateRecordKey(target, beforeVersion),
              },
            }),
        ConsistentRead: true,
        ScanIndexForward: false,
        Limit: limit + 1,
      }))
      const decoded = (response.Items ?? []).map((item) =>
        readStoredPlanningUpdate(item, workspaceId)
      )
      const updates = decoded.slice(0, limit)
      const last = updates.at(-1)
      return {
        updates,
        ...((decoded.length > updates.length || response.LastEvaluatedKey !== undefined) && last
          ? { nextCursor: createPlanningUpdateHistoryCursor(target, last.version) }
          : {}),
      }
    } catch (error) {
      if (error instanceof PlanningError) throw persistenceInvalid('Stored Planning update is invalid.')
      throw toPersistenceError(error)
    }
  }

  /** Strongly checks one immutable update row before reading annotations. */
  protected async planningUpdateExists(
    workspaceId: string,
    target: PlanningUpdateTarget,
    updateVersion: number,
  ) {
    await this.ensureTable()
    try {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: {
          workspaceId,
          recordKey: createPlanningUpdateRecordKey(target, updateVersion),
        },
        ConsistentRead: true,
      }))
      if (!response.Item) return false
      readStoredPlanningUpdate(response.Item, workspaceId)
      return true
    } catch (error) {
      if (error instanceof PlanningError) {
        throw persistenceInvalid('Stored Planning update is invalid.')
      }
      throw toPersistenceError(error)
    }
  }

  /** Atomically checks the immutable parent and appends one comment row. */
  protected async appendUpdateComment(
    workspaceId: string,
    comment: PlanningUpdateComment,
    transactionContribution?: PlanningMutationTransactionContribution,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
  ) {
    await this.writePlanningUpdateAnnotation(
      workspaceId,
      comment.target,
      comment.updateVersion,
      createPlanningUpdateCommentRow(workspaceId, comment),
      'PlanningUpdateCommentExists',
      'Planning update comment already exists.',
      createPlanningUpdateCommentIdRow(workspaceId, comment),
      transactionContribution,
      authorizationConditionChecks,
    )
  }

  /** Queries one target/version comment prefix without loading update history. */
  protected async readUpdateComments(
    workspaceId: string,
    target: PlanningUpdateTarget,
    updateVersion: number,
    limit: number,
    cursor?: string,
  ): Promise<PlanningUpdateCommentPage> {
    await this.ensureTable()
    const prefix = createPlanningUpdateCommentRecordPrefix(target, updateVersion)
    const recordKey = cursor === undefined
      ? undefined
      : decodePlanningUpdateAnnotationCursor(cursor, 'comment', target, updateVersion)
    try {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          'workspaceId = :workspaceId AND begins_with(recordKey, :recordPrefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':recordPrefix': prefix,
        },
        ...(recordKey === undefined
          ? {}
          : { ExclusiveStartKey: { workspaceId, recordKey } }),
        ConsistentRead: true,
        ScanIndexForward: false,
        Limit: limit + 1,
      }))
      const decoded = (response.Items ?? []).map((item) =>
        readStoredPlanningUpdateComment(item, workspaceId)
      )
      const comments = decoded.slice(0, limit)
      const last = comments.at(-1)
      return {
        comments,
        ...((decoded.length > comments.length || response.LastEvaluatedKey !== undefined) && last
          ? {
              nextCursor: createPlanningUpdateAnnotationCursor(
                'comment',
                target,
                updateVersion,
                last,
              ),
            }
          : {}),
      }
    } catch (error) {
      if (error instanceof PlanningError) {
        throw persistenceInvalid('Stored Planning update comment is invalid.')
      }
      throw toPersistenceError(error)
    }
  }

  /** Atomically checks the immutable parent and creates one member reaction row. */
  protected async putUpdateReaction(
    workspaceId: string,
    reaction: PlanningUpdateReaction,
    transactionContribution?: PlanningMutationTransactionContribution,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
  ) {
    await this.writePlanningUpdateAnnotation(
      workspaceId,
      reaction.target,
      reaction.updateVersion,
      createPlanningUpdateReactionRow(workspaceId, reaction),
      'PlanningUpdateReactionExists',
      'Planning update reaction already exists.',
      undefined,
      transactionContribution,
      authorizationConditionChecks,
    )
  }

  /** Atomically checks the immutable parent and idempotently deletes one reaction. */
  protected async deleteUpdateReaction(
    workspaceId: string,
    target: PlanningUpdateTarget,
    updateVersion: number,
    emoji: string,
    memberKey: string,
    transactionContribution?: PlanningMutationTransactionContribution,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
  ) {
    await this.ensureTable()
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          createPlanningUpdateExistenceCondition(
            this.tableName,
            workspaceId,
            target,
            updateVersion,
          ),
          ...authorizationConditionChecks,
          {
            Delete: {
              TableName: this.tableName,
              Key: {
                workspaceId,
                recordKey: createPlanningUpdateReactionRecordKey({
                  target,
                  updateVersion,
                  emoji,
                  memberKey,
                }),
              },
            },
          },
          ...(transactionContribution === undefined
            ? []
            : [transactionContribution.transactWriteItem]),
        ],
      }))
    } catch (error) {
      if (isPlanningTransactionConditionalFailureAt(error, 0)) {
        throw notFound('PlanningUpdateNotFound', 'Planning update was not found.')
      }
      if (isPlanningCallerAuthorizationTransactionCancellation(error, 1, authorizationConditionChecks.length)) {
        throw conflict(
          'PlanningAuthorizationChanged',
          'Planning authorization changed. Reload and try again.',
        )
      }
      const transactionContributionIndex = 1 + authorizationConditionChecks.length + 1
      if (transactionContribution && isPlanningTransactionConditionalFailureAt(error, transactionContributionIndex)) {
        throw conflict(
          'PlanningIdempotencyConflict',
          'The durable Planning mutation receipt changed. Retry the request.',
        )
      }
      throw toPersistenceError(error)
    }
  }

  /** Queries one target/version reaction prefix without loading update history. */
  protected async readUpdateReactions(
    workspaceId: string,
    target: PlanningUpdateTarget,
    updateVersion: number,
    limit: number,
    cursor?: string,
  ): Promise<PlanningUpdateReactionPage> {
    await this.ensureTable()
    const prefix = createPlanningUpdateReactionRecordPrefix(target, updateVersion)
    const recordKey = cursor === undefined
      ? undefined
      : decodePlanningUpdateAnnotationCursor(cursor, 'reaction', target, updateVersion)
    try {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          'workspaceId = :workspaceId AND begins_with(recordKey, :recordPrefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':recordPrefix': prefix,
        },
        ...(recordKey === undefined
          ? {}
          : { ExclusiveStartKey: { workspaceId, recordKey } }),
        ConsistentRead: true,
        ScanIndexForward: false,
        Limit: limit + 1,
      }))
      const decoded = (response.Items ?? []).map((item) =>
        readStoredPlanningUpdateReaction(item, workspaceId)
      )
      const reactions = decoded.slice(0, limit)
      const last = reactions.at(-1)
      return {
        reactions,
        ...((decoded.length > reactions.length || response.LastEvaluatedKey !== undefined) && last
          ? {
              nextCursor: createPlanningUpdateAnnotationCursor(
                'reaction',
                target,
                updateVersion,
                last,
              ),
            }
          : {}),
      }
    } catch (error) {
      if (error instanceof PlanningError) {
        throw persistenceInvalid('Stored Planning update reaction is invalid.')
      }
      throw toPersistenceError(error)
    }
  }

  /**
   * Commits one append-only annotation with an immutable parent existence condition.
   *
   * @param workspaceId - Owning Workspace partition.
   * @param target - Project or Initiative target.
   * @param updateVersion - Immutable update version.
   * @param row - Fully validated annotation row.
   * @param duplicateCode - Stable duplicate annotation error code.
   * @param duplicateMessage - Safe duplicate annotation error message.
   * @param uniquenessRow - Optional deterministic identity marker committed before the timeline row.
   * @param transactionContribution - Optional durable completion receipt committed last.
   */
  private async writePlanningUpdateAnnotation(
    workspaceId: string,
    target: PlanningUpdateTarget,
    updateVersion: number,
    row: Record<string, unknown>,
    duplicateCode: string,
    duplicateMessage: string,
    uniquenessRow?: Record<string, unknown>,
    transactionContribution?: PlanningMutationTransactionContribution,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
  ) {
    await this.ensureTable()
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          createPlanningUpdateExistenceCondition(
            this.tableName,
            workspaceId,
            target,
            updateVersion,
          ),
          ...authorizationConditionChecks,
          ...(uniquenessRow === undefined
            ? []
            : [{
                Put: {
                  TableName: this.tableName,
                  Item: uniquenessRow,
                  ConditionExpression:
                    'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
                },
              }]),
          {
            Put: {
              TableName: this.tableName,
              Item: row,
              ConditionExpression:
                'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
            },
          },
          ...(transactionContribution === undefined
            ? []
            : [transactionContribution.transactWriteItem]),
        ],
      }))
    } catch (error) {
      if (isPlanningTransactionConditionalFailureAt(error, 0)) {
        throw notFound('PlanningUpdateNotFound', 'Planning update was not found.')
      }
      if (isPlanningCallerAuthorizationTransactionCancellation(error, 1, authorizationConditionChecks.length)) {
        throw conflict(
          'PlanningAuthorizationChanged',
          'Planning authorization changed. Reload and try again.',
        )
      }
      const uniquenessIndex = 1 + authorizationConditionChecks.length
      const rowIndex = uniquenessIndex + (uniquenessRow === undefined ? 0 : 1)
      if (
        uniquenessRow !== undefined && isPlanningTransactionConditionalFailureAt(error, uniquenessIndex) ||
        isPlanningTransactionConditionalFailureAt(error, rowIndex)
      ) {
        throw conflict(duplicateCode, duplicateMessage)
      }
      const transactionContributionIndex = rowIndex + 1
      if (
        transactionContribution &&
        isPlanningTransactionConditionalFailureAt(error, transactionContributionIndex)
      ) {
        throw conflict(
          'PlanningIdempotencyConflict',
          'The durable Planning mutation receipt changed. Retry the request.',
        )
      }
      throw toPersistenceError(error)
    }
  }

  /** META row だけを強整合 read して authorization revision を返します。 */
  override async getAuthorizationRevision(workspaceId: string) {
    await this.ensureTable()
    return (await this.readMeta(
      readIdentifier(workspaceId, 'Workspace ID'),
    )).revision
  }

  /**
   * Persists the META CAS, row changes, endpoint revisions, and caller authorization atomically.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param before - State used for the Planning META revision CAS.
   * @param after - Fully validated replacement state.
   * @param workItemConditions - Canonical endpoint revision guards.
   * @param authorizationConditionChecks - Caller authorization source guards.
   * @param transactionContribution - Optional external action committed after Planning row writes.
   */
  protected async commitState(
    workspaceId: string,
    before: PlanningWorkspaceState,
    after: PlanningWorkspaceState,
    workItemConditions: readonly PlanningWorkItemCondition[] = [],
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
    transactionContribution?: PlanningMutationTransactionContribution,
    publishedUpdate?: PlanningUpdate,
  ) {
    await this.ensureTable()
    const beforeRows = createPlanningRowMap(workspaceId, before)
    const afterRows = createPlanningRowMap(workspaceId, after)
    if (afterRows.size > PLANNING_READ_LIMIT) {
      throw new PlanningError(
        413,
        'PlanningReadLimitExceeded',
        `Planning Workspace cannot exceed ${PLANNING_READ_LIMIT} rows.`,
      )
    }
    const mutations: NonNullable<TransactWriteCommandInput['TransactItems']> = []
    for (const [recordKey, item] of afterRows) {
      if (recordKey === META_RECORD_KEY || recordsEqual(item, beforeRows.get(recordKey))) continue
      if (utf8ByteLength(JSON.stringify(item)) > MAX_PLANNING_ROW_BYTES) {
        throw new PlanningError(
          413,
          'PlanningRowSizeLimitExceeded',
          'A Planning row exceeds the safe DynamoDB item size limit.',
        )
      }
      mutations.push({ Put: { TableName: this.tableName, Item: item } })
    }
    for (const recordKey of beforeRows.keys()) {
      if (recordKey === META_RECORD_KEY || afterRows.has(recordKey)) continue
      mutations.push({ Delete: { TableName: this.tableName, Key: { workspaceId, recordKey } } })
    }
    const canonicalConditions = workItemConditions.map((condition) => ({
      ConditionCheck: {
        TableName: this.workItemsTableName,
        Key: {
          directoryTeamId: `${workspaceId}#team#${condition.teamId}`,
          issueId: condition.workItemId,
        },
        ConditionExpression:
          'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND #revision = :expectedRevision',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ExpressionAttributeValues: { ':expectedRevision': condition.revision },
      },
    }))
    const transactionContributionItems = transactionContribution
      ? [transactionContribution.transactWriteItem]
      : []
    const publishedUpdateItems: NonNullable<TransactWriteCommandInput['TransactItems']> =
      publishedUpdate === undefined
        ? []
        : [
            {
              Put: {
                TableName: this.tableName,
                Item: createPlanningUpdateIdRow(workspaceId, publishedUpdate),
                ConditionExpression:
                  'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: createPlanningUpdateRow(workspaceId, publishedUpdate),
                ConditionExpression:
                  'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
              },
            },
          ]
    if (
      mutations.length + canonicalConditions.length +
        authorizationConditionChecks.length + transactionContributionItems.length +
          publishedUpdateItems.length + 1 >
          TRANSACTION_ITEM_LIMIT
    ) {
      throw new PlanningError(
        413,
        'PlanningMutationLimitExceeded',
        'Planning mutation exceeds the DynamoDB transaction item limit.',
      )
    }
    const meta = afterRows.get(META_RECORD_KEY)!
    const metaMutation = {
      Put: {
        TableName: this.tableName,
        Item: meta,
        ...(before.revision === 0
          ? { ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)' }
          : {
              ConditionExpression: '#revision = :expectedRevision',
              ExpressionAttributeNames: { '#revision': 'revision' },
              ExpressionAttributeValues: { ':expectedRevision': before.revision },
            }),
      },
    }
    if (
      utf8ByteLength(JSON.stringify([
        metaMutation,
        ...canonicalConditions,
        ...authorizationConditionChecks,
        ...mutations,
        ...publishedUpdateItems,
        ...transactionContributionItems,
      ])) >
        MAX_PLANNING_TRANSACTION_BYTES
    ) {
      throw new PlanningError(
        413,
        'PlanningMutationSizeLimitExceeded',
        'Planning mutation exceeds the safe DynamoDB transaction size limit.',
      )
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          metaMutation,
          ...canonicalConditions,
          ...authorizationConditionChecks,
          ...mutations,
          ...publishedUpdateItems,
          ...transactionContributionItems,
        ],
      }))
    } catch (error) {
      const authorizationConditionStartIndex = 1 + canonicalConditions.length
      if (isPlanningCallerAuthorizationTransactionCancellation(
        error,
        authorizationConditionStartIndex,
        authorizationConditionChecks.length,
      )) {
        throw conflict(
          'PlanningAuthorizationChanged',
          'Planning authorization changed. Reload and try again.',
        )
      }
      if (
        isNamedError(error, 'ConditionalCheckFailedException') ||
        isPlanningRevisionTransactionCancellation(error)
      ) {
        throw conflict('PlanningRevisionConflict', 'Planning changed. Reload and try again.')
      }
      if (isPlanningWorkItemTransactionCancellation(error, canonicalConditions.length)) {
        throw conflict(
          'PlanningWorkItemChanged',
          'A canonical Work Item changed. Reload Planning and try again.',
        )
      }
      const publishedUpdateIndex =
        1 + canonicalConditions.length + authorizationConditionChecks.length + mutations.length
      if (
        publishedUpdate &&
        (
          isPlanningTransactionConditionalFailureAt(error, publishedUpdateIndex) ||
          isPlanningTransactionConditionalFailureAt(error, publishedUpdateIndex + 1)
        )
      ) {
        throw conflict('PlanningUpdateExists', 'Planning update version or ID already exists.')
      }
      const transactionContributionIndex =
        1 + canonicalConditions.length + authorizationConditionChecks.length + mutations.length +
          publishedUpdateItems.length
      if (
        transactionContribution &&
        isPlanningTransactionConditionalFailureAt(error, transactionContributionIndex)
      ) {
        throw conflict(
          'PlanningIdempotencyConflict',
          'The durable Planning mutation receipt changed. Retry the request.',
        )
      }
      throw toPersistenceError(error)
    }
  }

  /** Local DynamoDB 利用時だけ table を bootstrap します。 */
  private async ensureTable() {
    if (this.bootstrapLocalTable) {
      await ensureLocalPlanningTable(this.tableName, this.dynamoDbClient)
    }
  }

  /** Workspace の META row を強整合 read します。 */
  private async readMeta(workspaceId: string) {
    try {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: {
          workspaceId: `${META_WORKSPACE_KEY_PREFIX}${workspaceId}`,
          recordKey: META_RECORD_KEY,
        },
        ConsistentRead: true,
      }))
      if (!response.Item) return { revision: 0, updatedAt: undefined }
      if (
        response.Item.entryType !== 'planning-meta' ||
        response.Item.schemaVersion !== PLANNING_STORAGE_SCHEMA_VERSION ||
        !isPositiveInteger(response.Item.revision) ||
        (response.Item.updatedAt !== undefined && (
          typeof response.Item.updatedAt !== 'string' ||
          !Number.isFinite(Date.parse(response.Item.updatedAt))
        ))
      ) {
        throw persistenceInvalid('Planning metadata is invalid.')
      }
      return {
        revision: response.Item.revision,
        updatedAt: response.Item.updatedAt as string | undefined,
      }
    } catch (error) {
      if (error instanceof PlanningError) throw error
      throw toPersistenceError(error)
    }
  }
}

const localTableInitializers = new Map<string, Promise<void>>()

/** Local DynamoDB に CDK 互換の Planning table を作成します。 */
export async function ensureLocalPlanningTable(tableName: string, client: DynamoDBClient) {
  const current = localTableInitializers.get(tableName)
  if (current) return current
  const initialization = (async () => {
    try {
      const response = await client.send(new DescribeTableCommand({ TableName: tableName }))
      if (!isPlanningTableDescription(response.Table)) {
        throw new Error(`Local DynamoDB table "${tableName}" has an incompatible schema.`)
      }
      return
    } catch (error) {
      if (!isNamedError(error, 'ResourceNotFoundException')) throw error
    }
    await client.send(new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'workspaceId', AttributeType: 'S' },
        { AttributeName: 'recordKey', AttributeType: 'S' },
        { AttributeName: 'updateScheduleShard', AttributeType: 'S' },
        { AttributeName: 'nextNotificationAtRecordKey', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'workspaceId', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [{
        IndexName: PLANNING_UPDATE_SCHEDULE_DUE_INDEX_NAME,
        KeySchema: [
          { AttributeName: 'updateScheduleShard', KeyType: 'HASH' },
          { AttributeName: 'nextNotificationAtRecordKey', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      }],
      BillingMode: 'PAY_PER_REQUEST',
    }))
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName })
  })()
  localTableInitializers.set(tableName, initialization)
  try {
    await initialization
  } catch (error) {
    localTableInitializers.delete(tableName)
    throw error
  }
}

function createEmptyPlanningState(): PlanningWorkspaceState {
  return {
    revision: 0,
    entities: [],
    dependencies: [],
    workItemDependencies: [],
    workItemLinks: [],
    updateTargets: [],
  }
}

/**
 * Normalizes one Project or Initiative update target.
 *
 * @param value - Untrusted target candidate.
 * @returns Canonical target identity.
 */
function readPlanningUpdateTarget(value: unknown): PlanningUpdateTarget {
  if (!isRecord(value)) {
    throw invalid('PlanningUpdateTargetInvalid', 'Planning update target must be an object.')
  }
  if (value.type === 'project') {
    return {
      type: 'project',
      teamId: readIdentifier(value.teamId, 'Update target Team ID'),
      projectId: readIdentifier(value.projectId, 'Update target Project ID'),
    }
  }
  if (value.type === 'initiative') {
    return {
      type: 'initiative',
      entityId: readIdentifier(value.entityId, 'Update target Initiative ID'),
    }
  }
  throw invalid('PlanningUpdateTargetInvalid', 'Planning update target type is invalid.')
}

/**
 * Creates a stable logical key for one update target.
 *
 * @param target - Canonical Project or Initiative target.
 * @returns Target-local identity string.
 */
function createPlanningUpdateTargetIdentity(target: PlanningUpdateTarget) {
  return target.type === 'project'
    ? `project\u0000${target.teamId}\u0000${target.projectId}`
    : `initiative\u0000${target.entityId}`
}

/**
 * Compares canonical update targets by logical identity.
 *
 * @param first - First target.
 * @param second - Second target.
 * @returns Whether both values identify the same target.
 */
function planningUpdateTargetsEqual(
  first: PlanningUpdateTarget,
  second: PlanningUpdateTarget,
) {
  return createPlanningUpdateTargetIdentity(first) === createPlanningUpdateTargetIdentity(second)
}

/**
 * Ensures an Initiative target points at one active Initiative entity.
 *
 * Project existence and access are validated against Directory by the application boundary.
 *
 * @param state - Current canonical Planning state.
 * @param target - Candidate update target.
 */
function requirePlanningUpdateTarget(
  state: PlanningWorkspaceState,
  target: PlanningUpdateTarget,
) {
  if (target.type !== 'initiative') return
  const entity = requireActiveEntity(state, target.entityId)
  if (entity.type !== 'initiative') {
    throw invalid(
      'PlanningUpdateTargetInvalid',
      'Initiative update targets must reference an Initiative entity.',
    )
  }
}

/**
 * Finds one stored target without exposing its mutable reference to callers.
 *
 * @param state - Current Planning state.
 * @param target - Target to locate.
 * @returns Matching stored target when configured or historically known.
 */
function findStoredPlanningUpdateTarget(
  state: PlanningWorkspaceState,
  target: PlanningUpdateTarget,
) {
  return state.updateTargets.find((candidate) =>
    planningUpdateTargetsEqual(candidate.target, target)
  )
}

/**
 * Replaces or inserts one update target in canonical state.
 *
 * @param state - Current Planning state.
 * @param updated - Validated replacement target.
 * @returns State with exactly one matching target.
 */
function replacePlanningUpdateTarget(
  state: PlanningWorkspaceState,
  updated: StoredPlanningUpdateTarget,
): PlanningWorkspaceState {
  const exists = state.updateTargets.some((candidate) =>
    planningUpdateTargetsEqual(candidate.target, updated.target)
  )
  return {
    ...state,
    updateTargets: exists
      ? state.updateTargets.map((candidate) =>
          planningUpdateTargetsEqual(candidate.target, updated.target) ? updated : candidate
        )
      : [...state.updateTargets, updated],
  }
}

/**
 * Validates and normalizes an update cadence.
 *
 * @param value - Untrusted cadence candidate.
 * @returns Canonical owner, calendar cadence, timezone, and notification offsets.
 */
function readPlanningUpdateCadence(value: unknown): PlanningUpdateCadence {
  if (!isRecord(value)) {
    throw invalid('PlanningUpdateCadenceInvalid', 'Planning update cadence must be an object.')
  }
  const updateOwnerMemberKey = readOwnerMemberKey(value.updateOwnerMemberKey)
  const cadence = readCadence(value.cadence)
  if (cadence.count > MAX_UPDATE_CADENCE_COUNT) {
    throw invalid(
      'PlanningUpdateCadenceInvalid',
      `Planning update cadence count cannot exceed ${MAX_UPDATE_CADENCE_COUNT}.`,
    )
  }
  const timeZone = readPlanningTimeZone(value.timeZone)
  const rawNextDueAt = readTimestamp(value.nextDueAt, 'Planning update next due timestamp')
  const nextDueAt = new Date(Date.parse(rawNextDueAt)).toISOString()
  const reminderHoursBefore = readPlanningUpdateHourOffset(
    value.reminderHoursBefore,
    'Reminder hours before',
  )
  const hasEscalationHours = value.escalationHoursAfter !== undefined
  const hasEscalationMember = value.escalationMemberKey !== undefined
  if (hasEscalationHours !== hasEscalationMember) {
    throw invalid(
      'PlanningUpdateEscalationInvalid',
      'Escalation hours and member must be configured together.',
    )
  }
  return {
    updateOwnerMemberKey,
    cadence,
    timeZone,
    nextDueAt,
    reminderHoursBefore,
    ...(hasEscalationHours && hasEscalationMember
      ? {
          escalationHoursAfter: readPlanningUpdateHourOffset(
            value.escalationHoursAfter,
            'Escalation hours after',
          ),
          escalationMemberKey: readOwnerMemberKey(value.escalationMemberKey),
        }
      : {}),
  }
}

/**
 * Validates an IANA timezone identifier.
 *
 * @param value - Untrusted timezone candidate.
 * @returns Accepted timezone identifier.
 */
function readPlanningTimeZone(value: unknown) {
  const timeZone = readIdentifier(value, 'Planning update time zone')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
  } catch {
    throw invalid('PlanningUpdateTimeZoneInvalid', 'Planning update time zone is invalid.')
  }
  return timeZone
}

/**
 * Validates one bounded reminder or escalation hour offset.
 *
 * @param value - Untrusted integer offset.
 * @param label - Field label used in validation errors.
 * @returns Non-negative bounded hour count.
 */
function readPlanningUpdateHourOffset(value: unknown, label: string) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_REMINDER_HOURS
  ) {
    throw invalid(
      'PlanningUpdateCadenceInvalid',
      `${label} must be an integer from 0 through ${MAX_REMINDER_HOURS}.`,
    )
  }
  return value
}

/**
 * Advances a cadence until its next occurrence is strictly after publication.
 *
 * Advancement is anchored to the configured occurrence rather than submission time,
 * preserving local wall-clock time through DST and clamping month-end dates.
 *
 * @param cadence - Current cadence whose nextDueAt is being fulfilled.
 * @param publishedAt - Manual publication timestamp.
 * @param anchorDay - Original monthly local day retained across month-end clamps.
 * @returns Next future ISO timestamp.
 */
function nextPlanningUpdateDueAt(
  cadence: PlanningUpdateCadence,
  publishedAt: string,
  anchorDay?: number,
) {
  const published = Date.parse(publishedAt)
  let candidate = cadence.nextDueAt
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    candidate = addPlanningUpdateCadenceOccurrence(candidate, cadence, anchorDay)
    if (Date.parse(candidate) > published) return candidate
  }
  throw invalid('PlanningUpdateCadenceInvalid', 'Planning update cadence cannot be advanced safely.')
}

/**
 * Adds one local calendar cadence interval to an ISO timestamp.
 *
 * @param timestamp - Existing due occurrence.
 * @param cadence - Calendar unit, count, and timezone.
 * @param anchorDay - Original monthly local day retained across month-end clamps.
 * @returns Next occurrence preserving local wall-clock components.
 */
function addPlanningUpdateCadenceOccurrence(
  timestamp: string,
  cadence: PlanningUpdateCadence,
  anchorDay?: number,
) {
  const instant = Date.parse(timestamp)
  const local = planningLocalDateTimeAt(instant, cadence.timeZone)
  let year = local.year
  let month = local.month
  let day = local.day
  if (cadence.cadence.unit === 'week') {
    const date = new Date(Date.UTC(year, month - 1, day + cadence.cadence.count * 7))
    year = date.getUTCFullYear()
    month = date.getUTCMonth() + 1
    day = date.getUTCDate()
  } else {
    const monthIndex = year * 12 + month - 1 + cadence.cadence.count
    year = Math.floor(monthIndex / 12)
    month = monthIndex % 12 + 1
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    day = Math.min(anchorDay ?? day, lastDay)
  }
  const next = resolvePlanningLocalDateTime(
    year,
    month,
    day,
    local.hour,
    local.minute,
    local.second,
    new Date(instant).getUTCMilliseconds(),
    cadence.timeZone,
  )
  if (next === undefined) {
    throw invalid('PlanningUpdateCadenceInvalid', 'Planning update cadence occurrence is invalid.')
  }
  return new Date(next).toISOString()
}

/**
 * Reads numeric local date-time components at one UTC instant.
 *
 * @param timestamp - UTC epoch milliseconds.
 * @param timeZone - Validated IANA timezone.
 * @returns Local calendar and wall-clock components.
 */
function planningLocalDateTimeAt(timestamp: number, timeZone: string) {
  let formatter = planningTimeZoneFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    planningTimeZoneFormatters.set(timeZone, formatter)
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(timestamp)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )
  if (
    !Number.isFinite(parts.year) ||
    !Number.isFinite(parts.month) ||
    !Number.isFinite(parts.day) ||
    !Number.isFinite(parts.hour) ||
    !Number.isFinite(parts.minute) ||
    !Number.isFinite(parts.second)
  ) {
    throw invalid('PlanningUpdateTimeZoneInvalid', 'Planning update local time is invalid.')
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
}

/**
 * Resolves one desired local time to a UTC instant.
 *
 * Ambiguous fall-back times select the earlier instant. Nonexistent spring-forward
 * times advance to the first valid local minute on the requested date.
 *
 * @param year - Local year.
 * @param month - Local month from one through twelve.
 * @param day - Local calendar day.
 * @param hour - Local hour.
 * @param minute - Local minute.
 * @param second - Local second.
 * @param millisecond - Millisecond component.
 * @param timeZone - Validated IANA timezone.
 * @returns Resolved epoch milliseconds, if the local date remains representable.
 */
function resolvePlanningLocalDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  timeZone: string,
) {
  const desired = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  let estimate = desired
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = planningLocalDateTimeAt(estimate, timeZone)
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
      millisecond,
    )
    estimate += desired - observedAsUtc
  }
  const exact: number[] = []
  for (let offsetMinutes = -180; offsetMinutes <= 180; offsetMinutes += 15) {
    const candidate = estimate + offsetMinutes * 60_000
    const observed = planningLocalDateTimeAt(candidate, timeZone)
    if (Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
      millisecond,
    ) === desired) {
      exact.push(candidate)
    }
  }
  if (exact.length > 0) return Math.min(...exact)
  let gapCandidate: { local: number; instant: number } | undefined
  for (
    let candidate = estimate - 3 * 3_600_000;
    candidate <= estimate + 3 * 3_600_000;
    candidate += 60_000
  ) {
    const observed = planningLocalDateTimeAt(candidate, timeZone)
    const observedLocal = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
      millisecond,
    )
    if (
      observed.year === year &&
      observed.month === month &&
      observed.day === day &&
      observedLocal > desired &&
      (
        gapCandidate === undefined ||
        observedLocal < gapCandidate.local ||
        (observedLocal === gapCandidate.local && candidate < gapCandidate.instant)
      )
    ) {
      gapCandidate = { local: observedLocal, instant: candidate }
    }
  }
  return gapCandidate?.instant
}

/**
 * Calculates freshness independently from the latest health value.
 *
 * @param target - Stored target cadence and latest pointer.
 * @param evaluatedAt - Read-time ISO timestamp.
 * @returns Deterministic update freshness state.
 */
function createPlanningUpdateState(
  target: StoredPlanningUpdateTarget,
  evaluatedAt: string,
): PlanningUpdateTargetSummary['updateState'] {
  if (!target.cadence) return 'not-configured'
  const now = Date.parse(evaluatedAt)
  const due = Date.parse(target.cadence.nextDueAt)
  if (now >= due) return 'overdue'
  if (!target.latestUpdate) return 'missing'
  const reminderAt = due - target.cadence.reminderHoursBefore * 3_600_000
  return now >= reminderAt ? 'stale' : 'current'
}

/**
 * Removes server-only diff context and adds read-time freshness.
 *
 * @param target - Stored update target.
 * @param evaluatedAt - Snapshot evaluation timestamp.
 * @returns Bounded graph summary.
 */
function createPlanningUpdateTargetSummary(
  target: StoredPlanningUpdateTarget,
  evaluatedAt: string,
): PlanningUpdateTargetSummary {
  return {
    target: structuredClone(target.target),
    ...(target.cadence === undefined ? {} : { cadence: structuredClone(target.cadence) }),
    updateState: createPlanningUpdateState(target, evaluatedAt),
    latestVersion: target.latestVersion,
    ...(target.latestUpdate === undefined
      ? {}
      : { latestUpdate: structuredClone(target.latestUpdate) }),
    ...(target.archivedAt === undefined ? {} : { archivedAt: target.archivedAt }),
    updatedAt: target.updatedAt,
  }
}

/**
 * Creates the bounded latest pointer embedded in graph snapshots.
 *
 * @param update - Newly published immutable update.
 * @returns Fields required by list and dashboard surfaces.
 */
function createLatestPlanningUpdateSummary(update: PlanningUpdate) {
  return {
    id: update.id,
    version: update.version,
    health: update.health,
    risk: update.risk,
    summary: update.summary,
    progressSnapshot: structuredClone(update.progressSnapshot),
    authorMemberKey: update.authorMemberKey,
    coveredDueAt: update.coveredDueAt,
    createdAt: update.createdAt,
  }
}

function createStoredEntity(input: CreatePlanningEntityInput, now: string): StoredPlanningEntity {
  const description = readOptionalDescription(input.description)
  const entity: StoredPlanningEntity = {
    id: readIdentifier(input.id, 'Planning entity ID'),
    type: readEntityType(input.type),
    title: readTitle(input.title),
    ...(description === undefined ? {} : { description }),
    ...(input.parentId ? { parentId: readIdentifier(input.parentId, 'Parent ID') } : {}),
    ...(input.teamId ? { teamId: readIdentifier(input.teamId, 'Team ID') } : {}),
    ...(input.projectId ? { projectId: readIdentifier(input.projectId, 'Project ID') } : {}),
    ownerMemberKey: readOwnerMemberKey(input.ownerMemberKey),
    status: readEntityStatus(input.status),
    health: readHealth(input.health),
    risk: readRisk(input.risk),
    progressMode: readProgressMode(input.progressMode),
    ...(input.manualProgress === undefined
      ? {}
      : { manualProgress: readProgress(input.manualProgress, 'Manual progress') }),
    baseline: readDateRange(input.baseline, 'Baseline'),
    forecast: readDateRange(input.forecast, 'Forecast'),
    ...(input.cadence === undefined ? {} : { cadence: readCadence(input.cadence) }),
    ...(input.capacity === undefined ? {} : { capacity: readCapacity(input.capacity) }),
    ...(input.carryOverPolicy === undefined
      ? {}
      : { carryOverPolicy: readCarryOverPolicy(input.carryOverPolicy) }),
    ...(input.goalFramework === undefined
      ? {}
      : { goalFramework: readGoalFramework(input.goalFramework) }),
    statusUpdates: [],
    createdAt: now,
    updatedAt: now,
  }
  validateEntityFields(entity)
  return entity
}

function validatePlanningState(state: PlanningWorkspaceState) {
  const ids = new Set<string>()
  for (const entity of state.entities) {
    validateEntityFields(entity)
    if (ids.has(entity.id)) throw persistenceInvalid(`Duplicate planning entity "${entity.id}".`)
    ids.add(entity.id)
  }
  for (const entity of state.entities) validateHierarchy(entity, state.entities)
  validateDependencies(state)
  validateWorkItemDependencies(state.workItemDependencies)
  for (const link of state.workItemLinks) validateWorkItemLink(state, link)
  const updateTargetKeys = new Set<string>()
  for (const target of state.updateTargets) {
    validateStoredPlanningUpdateTarget(target)
    const key = createPlanningUpdateTargetIdentity(target.target)
    if (updateTargetKeys.has(key)) {
      throw persistenceInvalid('Planning update targets must be unique.')
    }
    updateTargetKeys.add(key)
    if (target.target.type === 'initiative') {
      const entity = findEntity(state, target.target.entityId)
      if (!entity || entity.type !== 'initiative') {
        throw persistenceInvalid('Planning update target initiative is invalid.')
      }
      if (entity.archivedAt !== target.archivedAt) {
        throw persistenceInvalid('Planning update target archive state is inconsistent.')
      }
    }
  }
  validateCycleCapacities(state)
}

function validateEntityFields(entity: StoredPlanningEntity) {
  readIdentifier(entity.id, 'Planning entity ID')
  readEntityType(entity.type)
  readTitle(entity.title)
  if (entity.description !== undefined) readOptionalDescription(entity.description)
  if (entity.parentId !== undefined) readIdentifier(entity.parentId, 'Parent ID')
  if (entity.teamId !== undefined) readIdentifier(entity.teamId, 'Team ID')
  if (entity.projectId !== undefined) readIdentifier(entity.projectId, 'Project ID')
  if (entity.projectId !== undefined && entity.teamId === undefined) {
    throw invalid(
      'PlanningProjectTeamRequired',
      'A Project-scoped Planning entity requires its owning Team scope.',
    )
  }
  readOwnerMemberKey(entity.ownerMemberKey)
  readEntityStatus(entity.status)
  readHealth(entity.health)
  readRisk(entity.risk)
  readProgressMode(entity.progressMode)
  readDateRange(entity.baseline, 'Baseline')
  readDateRange(entity.forecast, 'Forecast')
  if (entity.progressMode === 'manual' && entity.manualProgress === undefined) {
    throw invalid('PlanningManualProgressRequired', 'Manual progress mode requires manualProgress.')
  }
  if (entity.manualProgress !== undefined) readProgress(entity.manualProgress, 'Manual progress')
  if (entity.type === 'milestone') {
    if (
      entity.baseline.startDate !== entity.baseline.endDate ||
      entity.forecast.startDate !== entity.forecast.endDate
    ) {
      throw invalid('PlanningMilestoneDateInvalid', 'Milestone baseline and forecast must each be a single day.')
    }
  }
  if (entity.type === 'cycle') {
    if (!entity.teamId) throw invalid('PlanningCycleTeamRequired', 'Cycle requires a Team scope.')
    if (!entity.cadence || entity.capacity === undefined || !entity.carryOverPolicy) {
      throw invalid('PlanningCycleFieldsRequired', 'Cycle requires cadence, capacity, and carry-over policy.')
    }
    readCadence(entity.cadence)
    readCapacity(entity.capacity)
    readCarryOverPolicy(entity.carryOverPolicy)
  } else if (entity.cadence || entity.capacity !== undefined || entity.carryOverPolicy) {
    throw invalid('PlanningCycleFieldsInvalid', 'Only Cycle entities can define cycle fields.')
  }
  if (entity.goalFramework !== undefined && entity.type !== 'goal') {
    throw invalid('PlanningGoalFrameworkInvalid', 'Only Goal entities can define goalFramework.')
  }
  if (entity.goalFramework !== undefined) readGoalFramework(entity.goalFramework)
  validateStatusUpdates(entity.statusUpdates)
  if (entity.archivedAt !== undefined) readTimestamp(entity.archivedAt, 'Archived timestamp')
  readTimestamp(entity.createdAt, 'Created timestamp')
  readTimestamp(entity.updatedAt, 'Updated timestamp')
}

function validateHierarchy(entity: StoredPlanningEntity, entities: readonly StoredPlanningEntity[]) {
  if (!entity.parentId) {
    if (entity.type !== 'portfolio' && entity.type !== 'cycle') {
      throw invalid('PlanningParentRequired', `Planning entity type "${entity.type}" requires a parent.`)
    }
    return
  }
  if (entity.type === 'portfolio' || entity.type === 'cycle') {
    throw invalid('PlanningRootRequired', `Planning entity type "${entity.type}" must be a root.`)
  }
  const parent = entities.find((candidate) => candidate.id === entity.parentId)
  if (!parent) throw invalid('PlanningParentNotFound', `Parent "${entity.parentId}" was not found.`)
  if (parent.archivedAt && !entity.archivedAt) {
    throw persistenceInvalid('An active Planning entity cannot have an archived parent.')
  }
  const allowedParents: Record<Exclude<PlanningEntityType, 'cycle' | 'portfolio'>, PlanningEntityType[]> = {
    roadmap: ['portfolio'],
    initiative: ['roadmap'],
    goal: ['initiative'],
    phase: ['goal', 'initiative', 'roadmap'],
    milestone: ['phase', 'goal', 'initiative', 'roadmap'],
    release: ['phase', 'goal', 'initiative', 'roadmap'],
  }
  const hierarchyAllowed = entity.type === 'goal' && entity.goalFramework === 'key-result'
    ? parent.type === 'goal' && parent.goalFramework === 'objective'
    : allowedParents[entity.type].includes(parent.type)
  if (!hierarchyAllowed) {
    throw invalid(
      'PlanningHierarchyInvalid',
      `Planning entity type "${entity.type}" cannot be a child of "${parent.type}".`,
    )
  }
  if (!entity.archivedAt && parent.teamId && parent.teamId !== entity.teamId) {
    throw conflict('PlanningTeamScopeMismatch', 'Child and parent Team scopes do not match.')
  }
  if (!entity.archivedAt && parent.projectId && parent.projectId !== entity.projectId) {
    throw conflict('PlanningProjectScopeMismatch', 'Child and parent Project scopes do not match.')
  }
  const visited = new Set([entity.id])
  let cursor: StoredPlanningEntity | undefined = parent
  while (cursor) {
    if (visited.has(cursor.id)) throw conflict('PlanningHierarchyCycle', 'Planning hierarchy contains a cycle.')
    visited.add(cursor.id)
    cursor = cursor.parentId
      ? entities.find((candidate) => candidate.id === cursor!.parentId)
      : undefined
  }
}

function validateDependencies(state: PlanningWorkspaceState) {
  const ids = new Set<string>()
  const edges = new Set<string>()
  const adjacency = new Map<string, string[]>()
  for (const dependency of state.dependencies) {
    if (ids.has(dependency.id)) throw persistenceInvalid(`Duplicate dependency "${dependency.id}".`)
    ids.add(dependency.id)
    readIdentifier(dependency.id, 'Dependency ID')
    readDependencyType(dependency.type)
    readLagDays(dependency.lagDays)
    const constraint = dependency.constraint === undefined
      ? undefined
      : readDependencyConstraint(dependency.constraint)
    if (dependency.predecessorId === dependency.successorId) {
      throw invalid('PlanningDependencySelf', 'An entity cannot depend on itself.')
    }
    const edge = `${dependency.predecessorId}\u0000${dependency.successorId}`
    if (edges.has(edge)) {
      throw conflict(
        'PlanningDependencyDuplicate',
        'Only one dependency can connect the same predecessor and successor.',
      )
    }
    edges.add(edge)
    const predecessor = findEntity(state, dependency.predecessorId)
    const successor = findEntity(state, dependency.successorId)
    if (!predecessor || !successor) {
      throw invalid('PlanningDependencyEntityNotFound', 'Planning dependency references a missing entity.')
    }
    if (constraint !== undefined) {
      requirePlanningDependencyConstraintIsSatisfied(successor, constraint)
    }
    const targets = adjacency.get(dependency.predecessorId) ?? []
    targets.push(dependency.successorId)
    adjacency.set(dependency.predecessorId, targets)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw conflict('PlanningDependencyCycle', 'Planning dependencies contain a cycle.')
    if (visited.has(id)) return
    visiting.add(id)
    for (const target of adjacency.get(id) ?? []) visit(target)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of adjacency.keys()) visit(id)
}

/**
 * Enforces one explicit dependency constraint against the successor forecast.
 *
 * Persisted Planning dependency constraints are invariants rather than advisory
 * annotations, so both dependency creation and later forecast updates pass through
 * this check via {@link validatePlanningState}.
 *
 * @param successor - Successor Planning entity whose forecast owns the constrained anchor.
 * @param constraint - Validated explicit successor date constraint.
 */
function requirePlanningDependencyConstraintIsSatisfied(
  successor: StoredPlanningEntity,
  constraint: ScheduleDependencyConstraint,
): void {
  const actualDate = constraint.anchor === 'start'
    ? successor.forecast.startDate
    : successor.forecast.endDate
  if (!satisfiesDependencyConstraint(actualDate, constraint)) {
    throw conflict(
      'PlanningDependencyConstraintViolation',
      'Planning dependency constraint conflicts with the successor forecast.',
    )
  }
}

/**
 * Validates identities and acyclicity of the persisted qualified Work Item graph.
 *
 * @param dependencies - Persisted Work Item schedule dependencies.
 */
function validateWorkItemDependencies(
  dependencies: readonly WorkItemScheduleDependency[],
) {
  const ids = new Set<string>()
  const edges = new Set<string>()
  const adjacency = new Map<string, string[]>()
  for (const dependency of dependencies) {
    const id = readIdentifier(dependency.id, 'Work Item dependency ID')
    if (ids.has(id)) {
      throw persistenceInvalid(`Duplicate Work Item dependency "${id}".`)
    }
    ids.add(id)
    const predecessor = readWorkItemDependencyEndpoint(dependency.predecessor, 'Predecessor')
    const successor = readWorkItemDependencyEndpoint(dependency.successor, 'Successor')
    const predecessorKey = createWorkItemKey(predecessor.teamId, predecessor.workItemId)
    const successorKey = createWorkItemKey(successor.teamId, successor.workItemId)
    if (predecessorKey === successorKey) {
      throw invalid(
        'PlanningWorkItemDependencySelf',
        'A Work Item cannot depend on itself.',
      )
    }
    const edge = `${predecessorKey}\u0001${successorKey}`
    if (edges.has(edge)) {
      throw conflict(
        'PlanningWorkItemDependencyDuplicate',
        'Only one dependency can connect the same Work Item predecessor and successor.',
      )
    }
    edges.add(edge)
    readDependencyType(dependency.type)
    readLagDays(dependency.lagDays)
    if (dependency.constraint !== undefined) readDependencyConstraint(dependency.constraint)
    readTimestamp(dependency.createdAt, 'Work Item dependency creation timestamp')
    readTimestamp(dependency.updatedAt, 'Work Item dependency update timestamp')
    const targets = adjacency.get(predecessorKey) ?? []
    targets.push(successorKey)
    adjacency.set(predecessorKey, targets)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  /** Visits one qualified endpoint while detecting a directed back edge. */
  const visit = (key: string) => {
    if (visiting.has(key)) {
      throw conflict(
        'PlanningWorkItemDependencyCycle',
        'Work Item dependencies contain a cycle.',
      )
    }
    if (visited.has(key)) return
    visiting.add(key)
    for (const target of adjacency.get(key) ?? []) visit(target)
    visiting.delete(key)
    visited.add(key)
  }
  for (const key of adjacency.keys()) visit(key)
}

function validateWorkItemLink(
  state: PlanningWorkspaceState,
  link: PlanningWorkItemLink,
  requireActive = false,
) {
  const references = [
    ...(link.cycleId ? [[link.cycleId, 'cycle'] as const] : []),
    ...(link.milestoneId ? [[link.milestoneId, 'milestone'] as const] : []),
    ...link.goalIds.map((goalId) => [goalId, 'goal'] as const),
  ]
  if (references.length === 0) {
    throw invalid(
      'PlanningWorkItemLinkTargetRequired',
      'Planning Work Item link requires a Cycle, Milestone, or Goal.',
    )
  }
  for (const [entityId, type] of references) {
    const entity = requireActive ? requireActiveEntity(state, entityId) : findEntity(state, entityId)
    if (!entity) {
      throw invalid('PlanningWorkItemLinkEntityNotFound', `Planning link target "${entityId}" was not found.`)
    }
    if (entity.type !== type) {
      throw invalid('PlanningWorkItemLinkTypeInvalid', `Planning link target "${entityId}" is not a ${type}.`)
    }
    if (
      requireActive &&
      (entity.status === 'completed' || entity.status === 'canceled')
    ) {
      throw conflict('PlanningEntityClosed', 'Completed or canceled Planning entities cannot receive links.')
    }
    if (entity.teamId && entity.teamId !== link.teamId) {
      throw conflict('PlanningWorkItemTeamMismatch', 'Planning entity and Work Item Team scopes do not match.')
    }
    if (entity.projectId && entity.projectId !== link.projectId) {
      throw conflict('PlanningWorkItemProjectMismatch', 'Planning entity and Work Item Project scopes do not match.')
    }
  }
}

function validateCycleCapacities(state: PlanningWorkspaceState) {
  const linkCountByCycle = new Map<string, number>()
  for (const link of state.workItemLinks) {
    if (!link.cycleId) continue
    linkCountByCycle.set(link.cycleId, (linkCountByCycle.get(link.cycleId) ?? 0) + 1)
  }
  for (const entity of state.entities) {
    if (entity.type !== 'cycle' || entity.archivedAt) continue
    if ((linkCountByCycle.get(entity.id) ?? 0) > (entity.capacity ?? 0)) {
      throw conflict(
        'PlanningCycleCapacityExceeded',
        `Cycle "${entity.id}" does not have enough Work Item capacity.`,
      )
    }
  }
}

function createPlanningSnapshot(
  state: PlanningWorkspaceState,
  workItemState: PlanningWorkItemState,
  evaluatedAt: string,
): PlanningSnapshot {
  const workItemMap = createWorkItemMap(workItemState)
  const visibleLinks = state.workItemLinks
    .filter((link) => {
      const summary = workItemMap.get(createWorkItemKey(link.teamId, link.workItemId))
      return summary !== undefined && link.projectId === summary.projectId
    })
    .map((link) => structuredClone(link))
    .sort(comparePlanningWorkItemLinks)
  const visibleWorkItemDependencies = state.workItemDependencies
    .filter((dependency) =>
      workItemMap.has(createWorkItemKey(
        dependency.predecessor.teamId,
        dependency.predecessor.workItemId,
      )) &&
      workItemMap.has(createWorkItemKey(
        dependency.successor.teamId,
        dependency.successor.workItemId,
      ))
    )
    .map((dependency) => structuredClone(dependency))
    .sort((first, second) => compareText(first.id, second.id))
  const visibleWorkItems = [...workItemState.workItems]
    .map((item) => structuredClone(item))
    .sort(comparePlanningWorkItems)
  const visibleState = { ...state, workItemLinks: visibleLinks }
  const rollups = calculateRollups(visibleState, workItemMap)
  const entities = state.entities.map((entity) => {
    const rollup = rollups.get(entity.id) ?? {
      progress: 0,
      rollupHealth: 'unknown' as const,
      linkedWorkItemCount: 0,
    }
    return { ...structuredClone(entity), ...rollup } satisfies PlanningEntity
  }).sort((first, second) => compareText(first.id, second.id))
  const snapshot = {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    revision: state.revision,
    entities,
    dependencies: structuredClone(state.dependencies)
      .sort((first, second) => compareText(first.id, second.id)),
    workItemDependencies: visibleWorkItemDependencies,
    workItemLinks: visibleLinks,
    workItems: visibleWorkItems,
    updateTargets: state.updateTargets
      .map((target) => createPlanningUpdateTargetSummary(target, evaluatedAt))
      .sort((first, second) => compareText(
        createPlanningUpdateTargetIdentity(first.target),
        createPlanningUpdateTargetIdentity(second.target),
      )),
    criticalPath: calculateCriticalPath(state),
    workItemDependencySummary: createPlanningWorkItemDependencySummary(
      visibleWorkItemDependencies,
      visibleWorkItems,
      visibleLinks,
    ),
    ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
  } satisfies PlanningSnapshot
  if (utf8ByteLength(JSON.stringify(snapshot)) > MAX_PLANNING_SNAPSHOT_BYTES) {
    throw new PlanningError(
      413,
      'PlanningSnapshotSizeLimitExceeded',
      'Planning snapshot exceeds the safe API response size limit.',
    )
  }
  return snapshot
}

/**
 * Captures the canonical target state used for immutable comparisons.
 *
 * @param state - Current Planning graph.
 * @param target - Project or Initiative being updated.
 * @param health - Human-declared health for this update.
 * @param risk - Human-declared risk for this update.
 * @param workItemState - Canonical Work Item projection used for progress.
 * @returns Immutable server-derived context snapshot.
 */
function createPlanningUpdateContextSnapshot(
  state: PlanningWorkspaceState,
  target: PlanningUpdateTarget,
  health: PlanningHealth,
  risk: PlanningRisk,
  workItemState: PlanningWorkItemState,
): PlanningUpdateContextSnapshot {
  const scope = createPlanningUpdateVisibilityEnvelope(state, target)
  const visibleWorkItems = createPlanningUpdateVisibleWorkItemMap(state, target, workItemState)
  const canonicalState = {
    ...state,
    entities: state.entities.filter((entity) =>
      isInsidePlanningUpdateVisibilityEnvelope(scope, entity.teamId, entity.projectId)
    ),
    workItemLinks: state.workItemLinks.filter((link) => {
      const workItem = visibleWorkItems.get(createWorkItemKey(link.teamId, link.workItemId))
      return workItem !== undefined && link.projectId === workItem.projectId
    }),
  }
  const relevantEntityIds = new Set<string>()
  let targetDate: string | undefined
  let progress: PlanningUpdateContextSnapshot['progress']
  if (target.type === 'initiative') {
    const initiative = requireActiveEntity(state, target.entityId)
    relevantEntityIds.add(initiative.id)
    for (const id of collectActiveDescendantIds(canonicalState.entities, initiative.id)) {
      relevantEntityIds.add(id)
    }
    targetDate = initiative.forecast.endDate
    const rollup = calculateRollups(canonicalState, visibleWorkItems).get(initiative.id)
    progress = {
      percent: rollup?.progress ?? 0,
      linkedWorkItemCount: rollup?.linkedWorkItemCount ?? 0,
    }
  } else {
    const scopedEntities = canonicalState.entities.filter((entity) => !entity.archivedAt)
    for (const entity of scopedEntities) relevantEntityIds.add(entity.id)
    targetDate = scopedEntities
      .map((entity) => entity.forecast.endDate)
      .sort(compareText)
      .at(-1)
    const scopedWorkItems = [...visibleWorkItems.values()]
    const scores = scopedWorkItems
      .map((workItem) => workItemStatusScore(workItem.statusCategory))
      .filter((score) => score !== undefined)
    progress = {
      percent: scores.length === 0
        ? 0
        : roundProgress(scores.reduce<number>((sum, score) => sum + score, 0) / scores.length),
      linkedWorkItemCount: scopedWorkItems.length,
    }
  }
  const visibleEntityIds = new Set(canonicalState.entities.map((entity) => entity.id))
  const milestones = canonicalState.entities
    .filter((entity) =>
      entity.type === 'milestone' &&
      !entity.archivedAt &&
      relevantEntityIds.has(entity.id)
    )
    .map((entity) => ({
      entityId: entity.id,
      title: entity.title,
      status: entity.status,
      forecast: structuredClone(entity.forecast),
    }))
    .sort((first, second) => compareText(first.entityId, second.entityId))
  const dependencies = state.dependencies
    .filter((dependency) =>
      (
        relevantEntityIds.has(dependency.predecessorId) ||
        relevantEntityIds.has(dependency.successorId)
      ) &&
      visibleEntityIds.has(dependency.predecessorId) &&
      visibleEntityIds.has(dependency.successorId)
    )
    .map((dependency) => ({
      dependencyId: dependency.id,
      predecessorId: dependency.predecessorId,
      successorId: dependency.successorId,
      type: dependency.type,
      lagDays: dependency.lagDays,
    }))
    .sort((first, second) => compareText(first.dependencyId, second.dependencyId))
  return {
    health,
    risk,
    progress,
    scope,
    ...(targetDate === undefined ? {} : { targetDate }),
    milestones,
    dependencies,
  }
}

/**
 * Derives the scope shared by every viewer of one update target.
 *
 * Project-scoped targets use an exact Team/Project pair, Team-scoped
 * Initiatives exclude Project descendants, and Workspace Initiatives include
 * the complete Workspace graph.
 *
 * @param state - Current canonical Planning state.
 * @param target - Project or Initiative update target.
 * @returns Scope used to bound immutable context and evidence.
 */
function createPlanningUpdateVisibilityEnvelope(
  state: PlanningWorkspaceState,
  target: PlanningUpdateTarget,
): PlanningUpdateContextSnapshot['scope'] {
  if (target.type === 'project') {
    return { teamId: target.teamId, projectId: target.projectId }
  }
  const initiative = requireActiveEntity(state, target.entityId)
  return {
    ...(initiative.teamId === undefined ? {} : { teamId: initiative.teamId }),
    ...(initiative.projectId === undefined ? {} : { projectId: initiative.projectId }),
  }
}

/**
 * Checks whether one Planning or Work Item scope belongs to a target envelope.
 *
 * @param envelope - Canonical target scope.
 * @param teamId - Candidate Team scope.
 * @param projectId - Candidate Project scope.
 * @returns Whether the candidate is safe for every viewer of the target.
 */
function isInsidePlanningUpdateVisibilityEnvelope(
  envelope: PlanningUpdateContextSnapshot['scope'],
  teamId: string | undefined,
  projectId: string | undefined,
) {
  if (envelope.projectId !== undefined) {
    return teamId === envelope.teamId && projectId === envelope.projectId
  }
  if (envelope.teamId !== undefined) {
    return teamId === envelope.teamId && projectId === undefined
  }
  return true
}

/**
 * Selects canonical Work Items inside one update target visibility envelope.
 *
 * @param state - Current canonical Planning graph.
 * @param target - Project or Initiative update target.
 * @param workItemState - Canonical Work Item projection visible to the publisher.
 * @returns Qualified Work Item map bounded to the immutable update scope.
 */
function createPlanningUpdateVisibleWorkItemMap(
  state: PlanningWorkspaceState,
  target: PlanningUpdateTarget,
  workItemState: PlanningWorkItemState,
) {
  const scope = createPlanningUpdateVisibilityEnvelope(state, target)
  return new Map([...createWorkItemMap(workItemState)].filter(([, workItem]) =>
    isInsidePlanningUpdateVisibilityEnvelope(scope, workItem.teamId, workItem.projectId)
  ))
}

/**
 * Computes typed changes between the previous and current immutable contexts.
 *
 * @param previous - Previous published context, absent for version one.
 * @param current - Newly captured context.
 * @returns Stable ordered field and collection changes.
 */
function createPlanningUpdateChanges(
  previous: PlanningUpdateContextSnapshot | undefined,
  current: PlanningUpdateContextSnapshot,
): PlanningUpdateChange[] {
  if (!previous) return []
  const changes: PlanningUpdateChange[] = []
  if (previous.health !== current.health) {
    changes.push({ type: 'health', before: previous.health, after: current.health })
  }
  if (previous.risk !== current.risk) {
    changes.push({ type: 'risk', before: previous.risk, after: current.risk })
  }
  if (previous.progress.percent !== current.progress.percent) {
    changes.push({
      type: 'progress',
      before: previous.progress.percent,
      after: current.progress.percent,
    })
  }
  if (previous.targetDate !== current.targetDate) {
    changes.push({
      type: 'target-date',
      ...(previous.targetDate === undefined ? {} : { before: previous.targetDate }),
      ...(current.targetDate === undefined ? {} : { after: current.targetDate }),
    })
  }
  if (!recordsEqual(previous.scope, current.scope)) {
    changes.push({
      type: 'scope',
      before: structuredClone(previous.scope),
      after: structuredClone(current.scope),
    })
  }
  const milestoneChange = createPlanningUpdateCollectionChange(
    'milestones',
    previous.milestones,
    current.milestones,
    (value) => value.entityId,
  )
  if (milestoneChange) changes.push(milestoneChange)
  const dependencyChange = createPlanningUpdateCollectionChange(
    'dependencies',
    previous.dependencies,
    current.dependencies,
    (value) => value.dependencyId,
  )
  if (dependencyChange) changes.push(dependencyChange)
  return changes
}

/**
 * Diffs one canonical collection by identity and serialized content.
 *
 * @param type - Collection change discriminator.
 * @param previous - Previous collection snapshot.
 * @param current - Current collection snapshot.
 * @param identify - Stable canonical identity selector.
 * @returns Collection change when at least one identity or value differs.
 */
function createPlanningUpdateCollectionChange<T>(
  type: 'milestones' | 'dependencies',
  previous: readonly T[],
  current: readonly T[],
  identify: (value: T) => string,
): PlanningUpdateChange | undefined {
  const previousById = new Map(previous.map((value) => [identify(value), value]))
  const currentById = new Map(current.map((value) => [identify(value), value]))
  const addedIds = [...currentById.keys()]
    .filter((id) => !previousById.has(id))
    .sort(compareText)
  const removedIds = [...previousById.keys()]
    .filter((id) => !currentById.has(id))
    .sort(compareText)
  const changedIds = [...currentById.keys()]
    .filter((id) => previousById.has(id) && !recordsEqual(previousById.get(id), currentById.get(id)))
    .sort(compareText)
  if (addedIds.length === 0 && removedIds.length === 0 && changedIds.length === 0) {
    return undefined
  }
  return { type, addedIds, removedIds, changedIds }
}

/**
 * Revalidates evidence references owned by Planning and Work Items.
 *
 * Decision and File ownership is revalidated by their application adapters.
 *
 * @param state - Current Planning state.
 * @param target - Target whose common visibility envelope bounds evidence.
 * @param evidence - Normalized evidence references.
 * @param workItemState - Canonical Work Item projection.
 */
function requirePlanningUpdateEvidenceExists(
  state: PlanningWorkspaceState,
  target: PlanningUpdateTarget,
  evidence: readonly PlanningUpdateEvidence[],
  workItemState: PlanningWorkItemState,
) {
  const workItems = createPlanningUpdateVisibleWorkItemMap(state, target, workItemState)
  const scope = createPlanningUpdateVisibilityEnvelope(state, target)
  for (const item of evidence) {
    if (item.type === 'work-item') {
      const workItem = workItems.get(createWorkItemKey(item.teamId, item.workItemId))
      if (!workItem) {
        throw invalid(
          'PlanningUpdateEvidenceInvalid',
          'Evidence Work Item is unavailable for this update target.',
        )
      }
    }
    if (item.type === 'planning-entity') {
      const entity = findEntity(state, item.entityId)
      if (
        !entity ||
        !isInsidePlanningUpdateVisibilityEnvelope(scope, entity.teamId, entity.projectId)
      ) {
        throw invalid(
          'PlanningUpdateEvidenceInvalid',
          'Evidence Planning entity is unavailable for this update target.',
        )
      }
    }
  }
}

function calculateRollups(
  state: PlanningWorkspaceState,
  workItems: ReadonlyMap<string, PlanningWorkItemSummary>,
) {
  const linksByEntity = new Map<string, Set<string>>()
  for (const link of state.workItemLinks) {
    const key = createWorkItemKey(link.teamId, link.workItemId)
    for (const entityId of [link.cycleId, link.milestoneId, ...link.goalIds]) {
      if (!entityId) continue
      const links = linksByEntity.get(entityId) ?? new Set<string>()
      links.add(key)
      linksByEntity.set(entityId, links)
    }
  }
  const childrenByParent = new Map<string, StoredPlanningEntity[]>()
  for (const entity of state.entities) {
    if (!entity.parentId) continue
    const children = childrenByParent.get(entity.parentId) ?? []
    children.push(entity)
    childrenByParent.set(entity.parentId, children)
  }
  const cache = new Map<string, {
    /** Progress aggregation units keyed by entity or Work Item. */
    units: Map<string, number>
    /** Unique linked Work Item keys. */
    linkedKeys: Set<string>
    /** Worst health across the subtree. */
    health: PlanningHealth
  }>()
  const visit = (entity: StoredPlanningEntity) => {
    const cached = cache.get(entity.id)
    if (cached) return cached
    if (entity.archivedAt || entity.status === 'canceled') {
      const excluded = {
        units: new Map<string, number>(),
        linkedKeys: new Set<string>(),
        health: 'unknown' as PlanningHealth,
      }
      cache.set(entity.id, excluded)
      return excluded
    }
    const units = new Map<string, number>()
    const linkedKeys = new Set<string>()
    for (const key of linksByEntity.get(entity.id) ?? []) {
      const workItem = workItems.get(key)
      if (!workItem) continue
      linkedKeys.add(key)
      const score = workItemStatusScore(workItem.statusCategory)
      if (score !== undefined) units.set(`work-item:${key}`, score)
    }
    let health = effectiveEntityHealth(entity)
    for (const child of childrenByParent.get(entity.id) ?? []) {
      const childRollup = visit(child)
      for (const key of childRollup.linkedKeys) linkedKeys.add(key)
      for (const [key, score] of childRollup.units) units.set(key, score)
      health = worstHealth(health, childRollup.health)
    }
    if (entity.status === 'completed') {
      units.clear()
      units.set(`entity:${entity.id}`, 100)
    } else if (entity.progressMode === 'manual') {
      units.clear()
      units.set(`entity:${entity.id}`, entity.manualProgress ?? 0)
    } else if (units.size === 0) {
      const score = planningStatusScore(entity.status)
      if (score !== undefined) units.set(`entity:${entity.id}`, score)
    }
    const result = { units, linkedKeys, health }
    cache.set(entity.id, result)
    return result
  }
  const rollups = new Map<string, {
    /** Calculated progress percentage. */
    progress: number
    /** Calculated worst health. */
    rollupHealth: PlanningHealth
    /** Unique linked Work Item count. */
    linkedWorkItemCount: number
  }>()
  for (const entity of state.entities) {
    const result = visit(entity)
    const scores = [...result.units.values()]
    rollups.set(entity.id, {
      progress: scores.length === 0
        ? 0
        : roundProgress(scores.reduce((total, score) => total + score, 0) / scores.length),
      rollupHealth: result.health,
      linkedWorkItemCount: result.linkedKeys.size,
    })
  }
  return rollups
}

function calculateCriticalPath(state: PlanningWorkspaceState): PlanningCriticalPath {
  const activeEntities = state.entities
    .filter((entity) => !entity.archivedAt && entity.status !== 'canceled')
    .sort((first, second) => compareText(first.id, second.id))
  const activeById = new Map(activeEntities.map((entity) => [entity.id, entity]))
  const dependencies = state.dependencies.filter((dependency) =>
    activeById.has(dependency.predecessorId) && activeById.has(dependency.successorId),
  ).sort((first, second) => compareText(first.id, second.id))
  const participatingIds = new Set(dependencies.flatMap((dependency) => [
    dependency.predecessorId,
    dependency.successorId,
  ]))
  const entities = activeEntities.filter((entity) => participatingIds.has(entity.id))
  const incomingCount = new Map(entities.map((entity) => [entity.id, 0]))
  const outgoing = new Map<string, PlanningDependency[]>()
  for (const dependency of dependencies) {
    incomingCount.set(dependency.successorId, (incomingCount.get(dependency.successorId) ?? 0) + 1)
    const edges = outgoing.get(dependency.predecessorId) ?? []
    edges.push(dependency)
    outgoing.set(dependency.predecessorId, edges)
  }
  const pending = entities.map((entity) => entity.id).filter((id) => incomingCount.get(id) === 0).sort()
  const order: string[] = []
  while (pending.length > 0) {
    const id = pending.shift()!
    order.push(id)
    for (const dependency of outgoing.get(id) ?? []) {
      const count = (incomingCount.get(dependency.successorId) ?? 0) - 1
      incomingCount.set(dependency.successorId, count)
      if (count === 0) {
        pending.push(dependency.successorId)
        pending.sort()
      }
    }
  }
  if (order.length !== entities.length) {
    throw new PlanningError(503, 'PlanningDependencyCycle', 'Stored planning dependencies contain a cycle.')
  }
  const durations = new Map(entities.map((entity) => [entity.id, durationDays(entity.forecast ?? entity.baseline)]))
  const earliestStart = new Map(entities.map((entity) => [entity.id, 0]))
  const pathPredecessor = new Map<string, string>()
  const pathDepth = new Map(entities.map((entity) => [entity.id, 0]))
  for (const predecessorId of order) {
    const predecessorStart = earliestStart.get(predecessorId) ?? 0
    const predecessorDuration = durations.get(predecessorId) ?? 0
    for (const dependency of outgoing.get(predecessorId) ?? []) {
      const successorDuration = durations.get(dependency.successorId) ?? 0
      const candidate = dependencyStartConstraint(
        dependency.type,
        predecessorStart,
        predecessorDuration,
        successorDuration,
        dependency.lagDays,
      )
      const currentStart = earliestStart.get(dependency.successorId) ?? 0
      const currentPredecessor = pathPredecessor.get(dependency.successorId)
      if (
        candidate > currentStart ||
        (candidate === currentStart && (!currentPredecessor || predecessorId < currentPredecessor))
      ) {
        earliestStart.set(dependency.successorId, candidate)
        pathPredecessor.set(dependency.successorId, predecessorId)
        pathDepth.set(dependency.successorId, (pathDepth.get(predecessorId) ?? 0) + 1)
      }
    }
  }
  let totalDurationDays = 0
  let endId: string | undefined
  let endPathDepth = -1
  for (const id of order) {
    const finish = (earliestStart.get(id) ?? 0) + (durations.get(id) ?? 0)
    const candidatePathDepth = pathDepth.get(id) ?? 0
    const candidateIsSink = (outgoing.get(id)?.length ?? 0) === 0
    const currentIsSink = endId !== undefined && (outgoing.get(endId)?.length ?? 0) === 0
    if (
      finish > totalDurationDays ||
      (
        finish === totalDurationDays &&
        (
          candidatePathDepth > endPathDepth ||
          (
            candidatePathDepth === endPathDepth &&
            (candidateIsSink !== currentIsSink ? candidateIsSink : !endId || id < endId)
          )
        )
      )
    ) {
      totalDurationDays = finish
      endId = id
      endPathDepth = candidatePathDepth
    }
  }
  const latestStart = new Map(order.map((id) => [id, totalDurationDays - (durations.get(id) ?? 0)]))
  for (const predecessorId of [...order].reverse()) {
    const predecessorDuration = durations.get(predecessorId) ?? 0
    for (const dependency of outgoing.get(predecessorId) ?? []) {
      const successorDuration = durations.get(dependency.successorId) ?? 0
      const successorLatest = latestStart.get(dependency.successorId) ?? 0
      const candidate = dependencyLatestStartConstraint(
        dependency.type,
        successorLatest,
        predecessorDuration,
        successorDuration,
        dependency.lagDays,
      )
      latestStart.set(predecessorId, Math.min(latestStart.get(predecessorId) ?? candidate, candidate))
    }
  }
  const entityIds: string[] = []
  let cursor = endId
  while (cursor) {
    entityIds.unshift(cursor)
    cursor = pathPredecessor.get(cursor)
  }
  return {
    entityIds,
    totalDurationDays,
    slackByEntityId: Object.fromEntries(order.map((id) => [
      id,
      Math.max(0, (latestStart.get(id) ?? 0) - (earliestStart.get(id) ?? 0)),
    ])),
  }
}

/**
 * Rejects canonical Work Item deletion while any incoming or outgoing schedule edge remains.
 *
 * Call this inside a stable Planning authorization read and carry that read's global revision
 * into the canonical Work Item delete transaction so a concurrent edge creation cannot race it.
 *
 * @param dependencies - Unfiltered Workspace Work Item dependencies from authorization state.
 * @param teamId - Team that owns the Work Item being deleted.
 * @param workItemId - Team-local Work Item identifier being deleted.
 * @throws {PlanningError} With `PlanningWorkItemDependencyInUse` when an edge still exists.
 */
export function requirePlanningWorkItemHasNoScheduleDependencies(
  dependencies: readonly WorkItemScheduleDependency[],
  teamId: string,
  workItemId: string,
) {
  const key = createWorkItemKey(
    readIdentifier(teamId, 'Team ID'),
    readIdentifier(workItemId, 'Work Item ID'),
  )
  const dependency = dependencies.find((candidate) =>
    createWorkItemKey(candidate.predecessor.teamId, candidate.predecessor.workItemId) === key ||
    createWorkItemKey(candidate.successor.teamId, candidate.successor.workItemId) === key
  )
  if (dependency !== undefined) {
    throw conflict(
      'PlanningWorkItemDependencyInUse',
      'Remove all incoming and outgoing schedule dependencies before deleting this Work Item.',
    )
  }
}

/**
 * Derives management signals from exactly the Work Item dependency edges visible in a snapshot.
 *
 * @param dependencies - Dependencies whose two endpoints are visible.
 * @param workItems - Visible canonical Work Item summaries.
 * @param links - Visible Planning links used to resolve affected milestones.
 * @returns Critical-path, conflict, blocker, Project, and Milestone summaries.
 */
export function createPlanningWorkItemDependencySummary(
  dependencies: readonly WorkItemScheduleDependency[],
  workItems: readonly PlanningWorkItemSummary[],
  links: readonly PlanningWorkItemLink[],
): PlanningWorkItemDependencySummary {
  const workItemMap = new Map(workItems.map((item) => [
    createWorkItemKey(item.teamId, item.id),
    item,
  ]))
  const visibleDependencies = dependencies.filter((dependency) =>
    workItemMap.has(createWorkItemKey(
      dependency.predecessor.teamId,
      dependency.predecessor.workItemId,
    )) &&
    workItemMap.has(createWorkItemKey(
      dependency.successor.teamId,
      dependency.successor.workItemId,
    ))
  )
  const endpointKeys = new Set<string>()
  let unresolvedBlockerCount = 0
  for (const dependency of visibleDependencies) {
    const predecessorKey = createWorkItemKey(
      dependency.predecessor.teamId,
      dependency.predecessor.workItemId,
    )
    const successorKey = createWorkItemKey(
      dependency.successor.teamId,
      dependency.successor.workItemId,
    )
    endpointKeys.add(predecessorKey)
    endpointKeys.add(successorKey)
    const predecessor = workItemMap.get(predecessorKey)
    if (
      predecessor &&
      predecessor.statusCategory !== 'completed' &&
      predecessor.statusCategory !== 'canceled'
    ) {
      unresolvedBlockerCount += 1
    }
  }
  const affectedProjects = new Map<string, WorkItemAffectedProject>()
  for (const key of endpointKeys) {
    const workItem = workItemMap.get(key)
    if (workItem?.projectId !== undefined) {
      affectedProjects.set(`${workItem.teamId}\0${workItem.projectId}`, {
        teamId: workItem.teamId,
        projectId: workItem.projectId,
      })
    }
  }
  const affectedMilestoneIds = new Set<string>()
  for (const link of links) {
    if (
      link.milestoneId !== undefined &&
      endpointKeys.has(createWorkItemKey(link.teamId, link.workItemId))
    ) {
      affectedMilestoneIds.add(link.milestoneId)
    }
  }
  return {
    criticalPath: calculateWorkItemDependencyCriticalPath(visibleDependencies, workItemMap),
    conflicts: calculateWorkItemDependencyConflicts(visibleDependencies, workItemMap),
    unresolvedBlockerCount,
    affectedProjects: [...affectedProjects.values()].sort((first, second) =>
      compareText(first.teamId, second.teamId) || compareText(first.projectId, second.projectId)
    ),
    affectedProjectIds: [...new Set([...affectedProjects.values()].map(({ projectId }) => projectId))]
      .sort(compareText),
    affectedMilestoneIds: [...affectedMilestoneIds].sort(compareText),
  }
}

/**
 * Calculates stable lower-bound and explicit-constraint conflicts for visible dependencies.
 *
 * @param dependencies - Dependencies whose endpoints may be inspected.
 * @param workItems - Visible canonical Work Item summaries keyed by qualified identity.
 * @returns Deterministically ordered dependency conflicts.
 */
function calculateWorkItemDependencyConflicts(
  dependencies: readonly WorkItemScheduleDependency[],
  workItems: ReadonlyMap<string, PlanningWorkItemSummary>,
) {
  const conflicts: WorkItemScheduleDependencyConflict[] = []
  for (const dependency of dependencies) {
    const predecessor = workItems.get(createWorkItemKey(
      dependency.predecessor.teamId,
      dependency.predecessor.workItemId,
    ))
    const successor = workItems.get(createWorkItemKey(
      dependency.successor.teamId,
      dependency.successor.workItemId,
    ))
    if (!predecessor || !successor) continue
    let hasMissingScheduleConflict = false
    const predecessorAnchor = readScheduleAnchor(
      predecessor.schedule,
      dependency.type === 'finish-to-start' || dependency.type === 'finish-to-finish'
        ? 'finish'
        : 'start',
    )
    const successorAnchor = readScheduleAnchor(
      successor.schedule,
      dependency.type === 'finish-to-start' || dependency.type === 'start-to-start'
        ? 'start'
        : 'finish',
    )
    if (predecessorAnchor === undefined || successorAnchor === undefined) {
      conflicts.push({
        code: 'missing-schedule',
        dependencyId: dependency.id,
        workItem: structuredClone(dependency.successor),
      })
      hasMissingScheduleConflict = true
    } else {
      const requiredDate = shiftIsoDate(
        predecessorAnchor,
        dependency.lagDays + (dependency.type === 'finish-to-start' ? 1 : 0),
      )
      if (requiredDate === undefined || successorAnchor < requiredDate) {
        conflicts.push({
          code: 'dependency-violation',
          dependencyId: dependency.id,
          workItem: structuredClone(dependency.successor),
          ...(requiredDate === undefined ? {} : { requiredDate }),
          actualDate: successorAnchor,
        })
      }
    }
    if (dependency.constraint === undefined) continue
    const constrainedAnchor = readScheduleAnchor(
      successor.schedule,
      dependency.constraint.anchor,
    )
    if (constrainedAnchor === undefined) {
      if (!hasMissingScheduleConflict) {
        conflicts.push({
          code: 'missing-schedule',
          dependencyId: dependency.id,
          workItem: structuredClone(dependency.successor),
        })
      }
      continue
    }
    if (!satisfiesDependencyConstraint(constrainedAnchor, dependency.constraint)) {
      conflicts.push({
        code: 'constraint-violation',
        dependencyId: dependency.id,
        workItem: structuredClone(dependency.successor),
        requiredDate: dependency.constraint.date,
        actualDate: constrainedAnchor,
      })
    }
  }
  return conflicts.sort((first, second) =>
    compareText(first.dependencyId, second.dependencyId) ||
    compareText(first.code, second.code) ||
    compareText(first.requiredDate ?? '', second.requiredDate ?? '')
  )
}

/**
 * Calculates the longest topological path through visible Work Item dependencies.
 *
 * @param dependencies - Visible acyclic Work Item dependency edges.
 * @param workItems - Visible canonical Work Item summaries keyed by qualified identity.
 * @returns A deterministic critical path and slack for every participating Work Item.
 */
function calculateWorkItemDependencyCriticalPath(
  dependencies: readonly WorkItemScheduleDependency[],
  workItems: ReadonlyMap<string, PlanningWorkItemSummary>,
): WorkItemDependencyCriticalPath {
  const participatingKeys = new Set<string>()
  const incomingCount = new Map<string, number>()
  const outgoing = new Map<string, WorkItemScheduleDependency[]>()
  for (const dependency of dependencies) {
    const predecessorKey = createWorkItemKey(
      dependency.predecessor.teamId,
      dependency.predecessor.workItemId,
    )
    const successorKey = createWorkItemKey(
      dependency.successor.teamId,
      dependency.successor.workItemId,
    )
    participatingKeys.add(predecessorKey)
    participatingKeys.add(successorKey)
    if (!incomingCount.has(predecessorKey)) incomingCount.set(predecessorKey, 0)
    incomingCount.set(successorKey, (incomingCount.get(successorKey) ?? 0) + 1)
    const edges = outgoing.get(predecessorKey) ?? []
    edges.push(dependency)
    outgoing.set(predecessorKey, edges)
  }
  const pending = [...participatingKeys]
    .filter((key) => incomingCount.get(key) === 0)
    .sort(compareText)
  const order: string[] = []
  while (pending.length > 0) {
    const key = pending.shift()
    if (key === undefined) break
    order.push(key)
    for (const dependency of outgoing.get(key) ?? []) {
      const successorKey = createWorkItemKey(
        dependency.successor.teamId,
        dependency.successor.workItemId,
      )
      const count = (incomingCount.get(successorKey) ?? 0) - 1
      incomingCount.set(successorKey, count)
      if (count === 0) {
        pending.push(successorKey)
        pending.sort(compareText)
      }
    }
  }
  if (order.length !== participatingKeys.size) {
    throw new PlanningError(
      503,
      'PlanningWorkItemDependencyCycle',
      'Stored Work Item dependencies contain a cycle.',
    )
  }
  const durations = new Map<string, number>()
  const scheduleSpans = new Map<string, number>()
  for (const key of order) {
    const schedule = workItems.get(key)?.schedule
    durations.set(key, schedule === undefined ? 0 : workItemScheduleDurationDays(schedule))
    scheduleSpans.set(key, schedule === undefined ? 0 : workItemScheduleSpanDays(schedule))
  }
  const earliestStart = new Map(order.map((key) => [key, 0]))
  const pathPredecessor = new Map<string, string>()
  const pathDepth = new Map(order.map((key) => [key, 0]))
  for (const predecessorKey of order) {
    const predecessorStart = earliestStart.get(predecessorKey) ?? 0
    const predecessorSpan = scheduleSpans.get(predecessorKey) ?? 0
    for (const dependency of outgoing.get(predecessorKey) ?? []) {
      const successorKey = createWorkItemKey(
        dependency.successor.teamId,
        dependency.successor.workItemId,
      )
      const successorSpan = scheduleSpans.get(successorKey) ?? 0
      const candidate = workItemDependencyStartConstraint(
        dependency.type,
        predecessorStart,
        predecessorSpan,
        successorSpan,
        dependency.lagDays,
      )
      const currentStart = earliestStart.get(successorKey) ?? 0
      const currentPredecessor = pathPredecessor.get(successorKey)
      if (
        candidate > currentStart ||
        (
          candidate === currentStart &&
          (currentPredecessor === undefined || predecessorKey < currentPredecessor)
        )
      ) {
        earliestStart.set(successorKey, candidate)
        pathPredecessor.set(successorKey, predecessorKey)
        pathDepth.set(successorKey, (pathDepth.get(predecessorKey) ?? 0) + 1)
      }
    }
  }
  let totalDurationDays = 0
  let endKey: string | undefined
  let endPathDepth = -1
  for (const key of order) {
    const finish = (earliestStart.get(key) ?? 0) + (durations.get(key) ?? 0)
    const candidatePathDepth = pathDepth.get(key) ?? 0
    const candidateIsSink = (outgoing.get(key)?.length ?? 0) === 0
    const currentIsSink = endKey !== undefined && (outgoing.get(endKey)?.length ?? 0) === 0
    if (
      finish > totalDurationDays ||
      (
        finish === totalDurationDays &&
        (
          candidatePathDepth > endPathDepth ||
          (
            candidatePathDepth === endPathDepth &&
            (candidateIsSink !== currentIsSink
              ? candidateIsSink
              : endKey === undefined || key < endKey)
          )
        )
      )
    ) {
      totalDurationDays = finish
      endKey = key
      endPathDepth = candidatePathDepth
    }
  }
  const latestStart = new Map(order.map((key) => [
    key,
    totalDurationDays - (durations.get(key) ?? 0),
  ]))
  for (const predecessorKey of [...order].reverse()) {
    const predecessorSpan = scheduleSpans.get(predecessorKey) ?? 0
    for (const dependency of outgoing.get(predecessorKey) ?? []) {
      const successorKey = createWorkItemKey(
        dependency.successor.teamId,
        dependency.successor.workItemId,
      )
      const successorSpan = scheduleSpans.get(successorKey) ?? 0
      const candidate = workItemDependencyLatestStartConstraint(
        dependency.type,
        latestStart.get(successorKey) ?? 0,
        predecessorSpan,
        successorSpan,
        dependency.lagDays,
      )
      latestStart.set(
        predecessorKey,
        Math.min(latestStart.get(predecessorKey) ?? candidate, candidate),
      )
    }
  }
  const pathKeys: string[] = []
  let cursor = endKey
  while (cursor !== undefined) {
    pathKeys.unshift(cursor)
    cursor = pathPredecessor.get(cursor)
  }
  return {
    workItems: pathKeys.flatMap((key) => {
      const item = workItems.get(key)
      return item === undefined ? [] : [{ teamId: item.teamId, workItemId: item.id }]
    }),
    totalDurationDays,
    slackByWorkItemKey: Object.fromEntries(order.flatMap((key) => {
      const item = workItems.get(key)
      if (item === undefined) return []
      return [[
        createWorkItemSlackKey(item.teamId, item.id),
        Math.max(0, (latestStart.get(key) ?? 0) - (earliestStart.get(key) ?? 0)),
      ]]
    })),
  }
}

/**
 * Returns one schedule boundary without inferring dates for an unscheduled Work Item.
 *
 * @param schedule - Canonical Work Item schedule.
 * @param anchor - Boundary requested by a dependency or explicit constraint.
 * @returns The local ISO date, or undefined when no schedule exists.
 */
function readScheduleAnchor(
  schedule: WorkItemSchedule,
  anchor: ScheduleDependencyConstraint['anchor'],
) {
  if (schedule.mode === 'unscheduled') return undefined
  if (schedule.mode === 'due-date') {
    return anchor === 'finish' ? schedule.dueDate : undefined
  }
  return anchor === 'start' ? schedule.startDate : schedule.endDate
}

/**
 * Tests an explicit successor boundary against its persisted date constraint.
 *
 * @param actualDate - Current successor boundary date.
 * @param constraint - Explicit equality, lower-bound, or upper-bound rule.
 * @returns Whether the current date satisfies the rule.
 */
function satisfiesDependencyConstraint(
  actualDate: string,
  constraint: ScheduleDependencyConstraint,
) {
  if (constraint.kind === 'on') return actualDate === constraint.date
  if (constraint.kind === 'not-before') return actualDate >= constraint.date
  return actualDate <= constraint.date
}

/**
 * Shifts a validated local date by a signed number of UTC calendar days.
 *
 * @param value - Local ISO date.
 * @param days - Signed calendar-day offset.
 * @returns Shifted ISO date, or undefined when arithmetic leaves the supported range.
 */
function shiftIsoDate(value: string, days: number) {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`) + days * 86_400_000
  if (!Number.isFinite(timestamp)) return undefined
  const shifted = new Date(timestamp)
  if (Number.isNaN(shifted.getTime())) return undefined
  const result = shifted.toISOString().slice(0, 10)
  return ISO_DATE_PATTERN.test(result) && Number(result.slice(0, 4)) >= WORK_ITEM_SCHEDULE_MIN_YEAR
    ? result
    : undefined
}

/**
 * Creates the reversible public record key used by critical-path slack output.
 *
 * @param teamId - Owning Team identifier.
 * @param workItemId - Team-local Work Item identifier.
 * @returns Percent-encoded `teamId/workItemId` key without delimiter collisions.
 */
function createWorkItemSlackKey(teamId: string, workItemId: string) {
  return `${encodeURIComponent(teamId)}/${encodeURIComponent(workItemId)}`
}

/**
 * Returns the calendar duration reported for one Work Item in critical-path output.
 *
 * @param schedule - Canonical schedule whose duration is required.
 * @returns Calendar days occupied by the schedule; milestones and unscheduled items use zero.
 */
function workItemScheduleDurationDays(schedule: WorkItemSchedule) {
  if (schedule.mode === 'unscheduled' || schedule.mode === 'milestone') return 0
  if (schedule.mode === 'due-date') return 1
  return durationDays({ startDate: schedule.startDate, endDate: schedule.endDate })
}

/**
 * Returns the inclusive boundary span used to translate start and finish constraints.
 *
 * @param schedule - Canonical schedule whose boundary span is required.
 * @returns Inclusive calendar span, with scheduled single-date items represented by one.
 */
function workItemScheduleSpanDays(schedule: WorkItemSchedule) {
  if (schedule.mode === 'unscheduled') return 0
  if (schedule.mode === 'due-date' || schedule.mode === 'milestone') return 1
  return durationDays({ startDate: schedule.startDate, endDate: schedule.endDate })
}

/**
 * Converts a Work Item dependency into a successor earliest-start lower bound.
 *
 * @param type - Dependency boundary relationship.
 * @param predecessorStart - Predecessor earliest-start offset.
 * @param predecessorSpan - Inclusive predecessor schedule span.
 * @param successorSpan - Inclusive successor schedule span.
 * @param lagDays - Signed lead or lag.
 * @returns Successor earliest-start lower bound.
 */
function workItemDependencyStartConstraint(
  type: PlanningDependencyType,
  predecessorStart: number,
  predecessorSpan: number,
  successorSpan: number,
  lagDays: number,
) {
  if (type === 'start-to-start') return predecessorStart + lagDays
  if (type === 'finish-to-finish') {
    return predecessorStart + predecessorSpan + lagDays - successorSpan
  }
  if (type === 'start-to-finish') {
    return predecessorStart + lagDays - successorSpan + 1
  }
  return predecessorStart + predecessorSpan + lagDays
}

/**
 * Converts a successor latest-start value into a predecessor latest-start upper bound.
 *
 * @param type - Dependency boundary relationship.
 * @param successorLatestStart - Successor latest-start offset.
 * @param predecessorSpan - Inclusive predecessor schedule span.
 * @param successorSpan - Inclusive successor schedule span.
 * @param lagDays - Signed lead or lag.
 * @returns Predecessor latest-start upper bound.
 */
function workItemDependencyLatestStartConstraint(
  type: PlanningDependencyType,
  successorLatestStart: number,
  predecessorSpan: number,
  successorSpan: number,
  lagDays: number,
) {
  if (type === 'start-to-start') return successorLatestStart - lagDays
  if (type === 'finish-to-finish') {
    return successorLatestStart + successorSpan - predecessorSpan - lagDays
  }
  if (type === 'start-to-finish') {
    return successorLatestStart + successorSpan - 1 - lagDays
  }
  return successorLatestStart - predecessorSpan - lagDays
}

/**
 * Resolves the earliest successor start imposed by one Planning entity dependency.
 *
 * @param type - Dependency boundary relationship.
 * @param predecessorStart - Predecessor earliest-start offset.
 * @param predecessorDuration - Inclusive predecessor duration.
 * @param successorDuration - Inclusive successor duration.
 * @param lagDays - Signed lead or lag.
 * @returns Successor earliest-start lower bound.
 */
function dependencyStartConstraint(
  type: PlanningDependencyType,
  predecessorStart: number,
  predecessorDuration: number,
  successorDuration: number,
  lagDays: number,
) {
  if (type === 'start-to-start') return predecessorStart + lagDays
  if (type === 'finish-to-finish') {
    return predecessorStart + predecessorDuration + lagDays - successorDuration
  }
  if (type === 'start-to-finish') {
    return predecessorStart + lagDays - successorDuration + 1
  }
  return predecessorStart + predecessorDuration + lagDays
}

/**
 * Resolves the latest predecessor start allowed by one Planning entity dependency.
 *
 * @param type - Dependency boundary relationship.
 * @param successorLatestStart - Successor latest-start offset.
 * @param predecessorDuration - Inclusive predecessor duration.
 * @param successorDuration - Inclusive successor duration.
 * @param lagDays - Signed lead or lag.
 * @returns Predecessor latest-start upper bound.
 */
function dependencyLatestStartConstraint(
  type: PlanningDependencyType,
  successorLatestStart: number,
  predecessorDuration: number,
  successorDuration: number,
  lagDays: number,
) {
  if (type === 'start-to-start') return successorLatestStart - lagDays
  if (type === 'finish-to-finish') {
    return successorLatestStart + successorDuration - predecessorDuration - lagDays
  }
  if (type === 'start-to-finish') {
    return successorLatestStart + successorDuration - 1 - lagDays
  }
  return successorLatestStart - predecessorDuration - lagDays
}

function createPlanningRowMap(workspaceId: string, state: PlanningWorkspaceState) {
  const rows = new Map<string, Record<string, unknown>>()
  rows.set(META_RECORD_KEY, {
    workspaceId: `${META_WORKSPACE_KEY_PREFIX}${workspaceId}`,
    recordKey: META_RECORD_KEY,
    entryType: 'planning-meta',
    schemaVersion: PLANNING_STORAGE_SCHEMA_VERSION,
    revision: state.revision,
    updatedAt: state.updatedAt,
  })
  for (const entity of state.entities) {
    const recordKey = createEntityRecordKey(entity.id)
    rows.set(recordKey, { workspaceId, recordKey, entryType: 'planning-entity', ...entity })
  }
  for (const dependency of state.dependencies) {
    const recordKey = createDependencyRecordKey(dependency.id)
    rows.set(recordKey, { workspaceId, recordKey, entryType: 'planning-dependency', ...dependency })
  }
  for (const dependency of state.workItemDependencies) {
    const recordKey = createWorkItemDependencyRecordKey(dependency.id)
    rows.set(recordKey, {
      workspaceId,
      recordKey,
      entryType: 'planning-work-item-dependency',
      ...dependency,
    })
  }
  for (const link of state.workItemLinks) {
    const recordKey = createLinkRecordKey(link.teamId, link.workItemId)
    rows.set(recordKey, { workspaceId, recordKey, entryType: 'planning-work-item-link', ...link })
  }
  for (const target of state.updateTargets) {
    const recordKey = createPlanningUpdateTargetRecordKey(target.target)
    rows.set(recordKey, {
      workspaceId,
      recordKey,
      entryType: 'planning-update-target',
      ...target,
      ...(target.cadence === undefined || target.archivedAt !== undefined
        ? {}
        : {
            updateScheduleShard: createPlanningUpdateScheduleShard(workspaceId, recordKey),
            nextNotificationAtRecordKey: target.nextNotificationAtRecordKey ??
              createPlanningUpdateNextNotificationAtRecordKey(
                workspaceId,
                recordKey,
                target.cadence.nextDueAt,
                target.cadence.reminderHoursBefore,
              ),
          }),
    })
  }
  return rows
}

function readPlanningRows(
  rows: readonly Record<string, unknown>[],
  meta: { revision: number; updatedAt?: string },
  workspaceId: string,
): PlanningWorkspaceState {
  const state: PlanningWorkspaceState = {
    revision: meta.revision,
    entities: [],
    dependencies: [],
    workItemDependencies: [],
    workItemLinks: [],
    updateTargets: [],
    ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {}),
  }
  try {
    for (const row of rows) {
      if (row.workspaceId !== workspaceId) {
        throw persistenceInvalid('Planning row belongs to another Workspace.')
      }
      if (row.recordKey === META_RECORD_KEY) continue
      if (row.entryType === 'planning-entity') {
        state.entities.push(readStoredPlanningEntity(row))
      } else if (row.entryType === 'planning-dependency') {
        state.dependencies.push(readStoredPlanningDependency(row))
      } else if (row.entryType === 'planning-work-item-dependency') {
        state.workItemDependencies.push(readStoredPlanningWorkItemDependency(row))
      } else if (row.entryType === 'planning-work-item-link') {
        state.workItemLinks.push(readStoredPlanningWorkItemLink(row))
      } else if (row.entryType === 'planning-update-target') {
        state.updateTargets.push(readStoredPlanningUpdateTarget(row))
      } else if (
        row.entryType === 'planning-update' ||
        row.entryType === 'planning-update-id' ||
        row.entryType === 'planning-update-comment' ||
        row.entryType === 'planning-update-comment-id' ||
        row.entryType === 'planning-update-reaction'
      ) {
        continue
      } else {
        throw persistenceInvalid('Planning row has an unknown entry type.')
      }
    }
    validatePlanningState(state)
    return state
  } catch (error) {
    if (error instanceof PlanningError && error.code === 'InvalidPlanningData') throw error
    throw persistenceInvalid('Stored Planning data failed validation.')
  }
}

function readStoredPlanningEntity(row: Record<string, unknown>): StoredPlanningEntity {
  const id = readIdentifier(row.id, 'Planning entity ID')
  if (row.recordKey !== createEntityRecordKey(id)) {
    throw invalid('PlanningRecordKeyInvalid', 'Planning entity record key does not match its ID.')
  }
  const description = row.description === undefined
    ? undefined
    : readRequiredDescription(row.description)
  const statusUpdates = readStoredStatusUpdates(row.statusUpdates)
  const entity: StoredPlanningEntity = {
    id,
    type: readEntityType(row.type),
    title: readTitle(row.title),
    ...(description === undefined ? {} : { description }),
    ...(row.parentId === undefined
      ? {}
      : { parentId: readIdentifier(row.parentId, 'Parent ID') }),
    ...(row.teamId === undefined
      ? {}
      : { teamId: readIdentifier(row.teamId, 'Team ID') }),
    ...(row.projectId === undefined
      ? {}
      : { projectId: readIdentifier(row.projectId, 'Project ID') }),
    ownerMemberKey: readOwnerMemberKey(row.ownerMemberKey),
    status: readEntityStatus(row.status),
    health: readHealth(row.health),
    risk: readRisk(row.risk),
    progressMode: readProgressMode(row.progressMode),
    ...(row.manualProgress === undefined
      ? {}
      : { manualProgress: readProgress(row.manualProgress, 'Manual progress') }),
    baseline: readDateRange(row.baseline, 'Baseline'),
    forecast: readDateRange(row.forecast, 'Forecast'),
    ...(row.cadence === undefined ? {} : { cadence: readCadence(row.cadence) }),
    ...(row.capacity === undefined ? {} : { capacity: readCapacity(row.capacity) }),
    ...(row.carryOverPolicy === undefined
      ? {}
      : { carryOverPolicy: readCarryOverPolicy(row.carryOverPolicy) }),
    ...(row.goalFramework === undefined
      ? {}
      : { goalFramework: readGoalFramework(row.goalFramework) }),
    statusUpdates,
    ...(row.archivedAt === undefined
      ? {}
      : { archivedAt: readTimestamp(row.archivedAt, 'Archived timestamp') }),
    createdAt: readTimestamp(row.createdAt, 'Created timestamp'),
    updatedAt: readTimestamp(row.updatedAt, 'Updated timestamp'),
  }
  validateEntityFields(entity)
  return entity
}

function readStoredPlanningDependency(row: Record<string, unknown>): PlanningDependency {
  const id = readIdentifier(row.id, 'Dependency ID')
  if (row.recordKey !== createDependencyRecordKey(id)) {
    throw invalid('PlanningRecordKeyInvalid', 'Planning dependency record key does not match its ID.')
  }
  return {
    id,
    predecessorId: readIdentifier(row.predecessorId, 'Predecessor ID'),
    successorId: readIdentifier(row.successorId, 'Successor ID'),
    type: readDependencyType(row.type),
    lagDays: readLagDays(row.lagDays),
    ...(row.constraint === undefined
      ? {}
      : { constraint: readDependencyConstraint(row.constraint) }),
    createdAt: readTimestamp(row.createdAt, 'Dependency timestamp'),
  }
}

/**
 * Decodes one canonical UPDATE_TARGET row.
 *
 * @param row - Untrusted DynamoDB row.
 * @returns Validated target configuration and latest pointer.
 */
function readStoredPlanningUpdateTarget(
  row: Record<string, unknown>,
): StoredPlanningUpdateTarget {
  const target = readPlanningUpdateTarget(row.target)
  if (row.recordKey !== createPlanningUpdateTargetRecordKey(target)) {
    throw invalid(
      'PlanningRecordKeyInvalid',
      'Planning update target record key does not match its target.',
    )
  }
  const cadence = row.cadence === undefined
    ? undefined
    : readPlanningUpdateCadence(row.cadence)
  const cadenceAnchorDay = cadence?.cadence.unit === 'month'
    ? row.cadenceAnchorDay === undefined
      ? planningLocalDateTimeAt(Date.parse(cadence.nextDueAt), cadence.timeZone).day
      : readPlanningUpdateCadenceAnchorDay(row.cadenceAnchorDay)
    : undefined
  const stored: StoredPlanningUpdateTarget = {
    target,
    ...(cadence === undefined ? {} : { cadence }),
    ...(cadenceAnchorDay === undefined ? {} : { cadenceAnchorDay }),
    latestVersion: readPlanningUpdateVersion(row.latestVersion, true),
    ...(row.latestUpdate === undefined
      ? {}
      : { latestUpdate: readPlanningLatestUpdateSummary(row.latestUpdate) }),
    ...(row.latestContextSnapshot === undefined
      ? {}
      : { latestContextSnapshot: readPlanningUpdateContextSnapshot(row.latestContextSnapshot) }),
    ...(row.nextNotificationAtRecordKey === undefined
      ? {}
      : { nextNotificationAtRecordKey: readIdentifier(
          row.nextNotificationAtRecordKey,
          'Planning update notification index key',
        ) }),
    ...(row.archivedAt === undefined
      ? {}
      : { archivedAt: readTimestamp(row.archivedAt, 'Update target archived timestamp') }),
    updatedAt: readTimestamp(row.updatedAt, 'Update target timestamp'),
  }
  validateStoredPlanningUpdateTarget(stored)
  return stored
}

/**
 * Validates cross-field invariants of one stored target.
 *
 * @param target - Stored target candidate.
 */
function validateStoredPlanningUpdateTarget(target: StoredPlanningUpdateTarget) {
  readPlanningUpdateTarget(target.target)
  if (target.cadence !== undefined) readPlanningUpdateCadence(target.cadence)
  if (target.cadence?.cadence.unit === 'month') {
    readPlanningUpdateCadenceAnchorDay(target.cadenceAnchorDay)
  } else if (target.cadenceAnchorDay !== undefined) {
    throw invalid(
      'PlanningUpdateCadenceInvalid',
      'Only monthly Planning update cadence can store an anchor day.',
    )
  }
  readPlanningUpdateVersion(target.latestVersion, true)
  if (target.latestVersion === 0 && (
    target.latestUpdate !== undefined || target.latestContextSnapshot !== undefined
  )) {
    throw invalid(
      'PlanningUpdateTargetInvalid',
      'An unversioned update target cannot have a latest update.',
    )
  }
  if (target.latestVersion > 0 && (
    target.latestUpdate === undefined || target.latestContextSnapshot === undefined
  )) {
    throw invalid(
      'PlanningUpdateTargetInvalid',
      'A versioned update target requires a latest update and context.',
    )
  }
  if (target.latestUpdate && target.latestUpdate.version !== target.latestVersion) {
    throw invalid(
      'PlanningUpdateTargetInvalid',
      'Latest update version does not match its target pointer.',
    )
  }
  if (target.archivedAt !== undefined) {
    readTimestamp(target.archivedAt, 'Update target archived timestamp')
  }
  readTimestamp(target.updatedAt, 'Update target timestamp')
}

/**
 * Validates the original local day retained by monthly cadence.
 *
 * @param value - Stored day-of-month candidate.
 * @returns Integer day from one through thirty-one.
 */
function readPlanningUpdateCadenceAnchorDay(value: unknown) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 31
  ) {
    throw invalid('PlanningUpdateCadenceInvalid', 'Planning update cadence anchor day is invalid.')
  }
  return value
}

/**
 * Decodes the bounded latest update embedded in an UPDATE_TARGET row.
 *
 * @param value - Untrusted latest summary candidate.
 * @returns Validated latest update summary.
 */
function readPlanningLatestUpdateSummary(
  value: unknown,
): NonNullable<PlanningUpdateTargetSummary['latestUpdate']> {
  if (!isRecord(value)) {
    throw invalid('PlanningUpdateInvalid', 'Latest Planning update summary is invalid.')
  }
  return {
    id: readIdentifier(value.id, 'Planning update ID'),
    version: readPlanningUpdateVersion(value.version),
    health: readHealth(value.health),
    risk: readRisk(value.risk),
    summary: readPlanningUpdateText(value.summary, 'Summary', true),
    progressSnapshot: readPlanningUpdateProgressSnapshot(value.progressSnapshot),
    authorMemberKey: readOwnerMemberKey(value.authorMemberKey),
    coveredDueAt: readTimestamp(value.coveredDueAt, 'Covered due timestamp'),
    createdAt: readTimestamp(value.createdAt, 'Planning update timestamp'),
  }
}

/**
 * Decodes one immutable UPDATE row and verifies its physical identity.
 *
 * @param row - Untrusted DynamoDB row.
 * @param workspaceId - Workspace partition expected by the caller.
 * @returns Validated immutable Planning update.
 */
function readStoredPlanningUpdate(
  row: Record<string, unknown>,
  workspaceId: string,
): PlanningUpdate {
  if (row.workspaceId !== workspaceId || row.entryType !== 'planning-update') {
    throw persistenceInvalid('Planning update row scope is invalid.')
  }
  const target = readPlanningUpdateTarget(row.target)
  const version = readPlanningUpdateVersion(row.version)
  if (row.recordKey !== createPlanningUpdateRecordKey(target, version)) {
    throw persistenceInvalid('Planning update row key is invalid.')
  }
  if (row.contentVersion !== PLANNING_UPDATE_CONTENT_VERSION || row.origin !== 'manual') {
    throw persistenceInvalid('Planning update content version is invalid.')
  }
  const contextSnapshot = readPlanningUpdateContextSnapshot(row.contextSnapshot)
  const update: PlanningUpdate = {
    id: readIdentifier(row.id, 'Planning update ID'),
    target,
    version,
    contentVersion: PLANNING_UPDATE_CONTENT_VERSION,
    origin: 'manual',
    health: readHealth(row.health),
    risk: readRisk(row.risk),
    summary: readPlanningUpdateText(row.summary, 'Summary', true),
    riskSummary: readPlanningUpdateText(row.riskSummary, 'Risk summary'),
    decisionSummary: readPlanningUpdateText(row.decisionSummary, 'Decision summary'),
    helpNeeded: readPlanningUpdateText(row.helpNeeded, 'Help needed'),
    nextAction: readPlanningUpdateText(row.nextAction, 'Next action'),
    progressSnapshot: readPlanningUpdateProgressSnapshot(row.progressSnapshot),
    contextSnapshot,
    changes: readPlanningUpdateChanges(row.changes),
    evidence: readPlanningUpdateEvidence(row.evidence),
    authorMemberKey: readOwnerMemberKey(row.authorMemberKey),
    coveredDueAt: readTimestamp(row.coveredDueAt, 'Covered due timestamp'),
    createdAt: readTimestamp(row.createdAt, 'Planning update timestamp'),
  }
  if (
    update.health !== contextSnapshot.health ||
    update.risk !== contextSnapshot.risk ||
    !recordsEqual(update.progressSnapshot, contextSnapshot.progress)
  ) {
    throw persistenceInvalid('Planning update context does not match its content.')
  }
  return update
}

/**
 * Validates a target-local immutable version.
 *
 * @param value - Untrusted version candidate.
 * @param allowZero - Whether an empty target pointer may use zero.
 * @returns Safe integer version.
 */
function readPlanningUpdateVersion(value: unknown, allowZero = false) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    throw invalid('PlanningUpdateVersionInvalid', 'Planning update version is invalid.')
  }
  return value
}

/**
 * Normalizes one structured update text field.
 *
 * @param value - Untrusted text candidate.
 * @param label - Field label used in validation errors.
 * @param required - Whether empty text is rejected.
 * @returns Trimmed bounded text.
 */
function readPlanningUpdateText(value: unknown, label: string, required = false) {
  if (typeof value !== 'string' || !isWellFormedText(value)) {
    throw invalid('PlanningUpdateContentInvalid', `${label} must be text.`)
  }
  const normalized = value.trim()
  if (required && !normalized) {
    throw invalid('PlanningUpdateContentInvalid', `${label} is required.`)
  }
  if (utf8ByteLength(normalized) > MAX_UPDATE_TEXT_BYTES) {
    throw invalid(
      'PlanningUpdateContentInvalid',
      `${label} cannot exceed ${MAX_UPDATE_TEXT_BYTES} UTF-8 bytes.`,
    )
  }
  return normalized
}

/**
 * Normalizes one required append-only comment body.
 *
 * @param value - Untrusted comment body.
 * @returns Trimmed UTF-8 bounded comment text.
 */
function readPlanningUpdateCommentBody(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || !isWellFormedText(value)) {
    throw invalid('PlanningUpdateCommentInvalid', 'Planning update comment body is required.')
  }
  const body = value.trim()
  if (utf8ByteLength(body) > MAX_UPDATE_COMMENT_BYTES) {
    throw invalid(
      'PlanningUpdateCommentInvalid',
      `Planning update comment cannot exceed ${MAX_UPDATE_COMMENT_BYTES} UTF-8 bytes.`,
    )
  }
  return body
}

/**
 * Normalizes one bounded Unicode reaction token.
 *
 * @param value - Untrusted emoji or reaction token.
 * @returns Trimmed reaction identity.
 */
function readPlanningUpdateReaction(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || !isWellFormedText(value)) {
    throw invalid('PlanningUpdateReactionInvalid', 'Planning update reaction is required.')
  }
  const emoji = value.trim()
  if (utf8ByteLength(emoji) > MAX_UPDATE_REACTION_BYTES) {
    throw invalid(
      'PlanningUpdateReactionInvalid',
      `Planning update reaction cannot exceed ${MAX_UPDATE_REACTION_BYTES} UTF-8 bytes.`,
    )
  }
  return emoji
}

/**
 * Validates server-derived progress values.
 *
 * @param value - Untrusted progress snapshot candidate.
 * @returns Canonical progress snapshot.
 */
function readPlanningUpdateProgressSnapshot(
  value: unknown,
): PlanningUpdateContextSnapshot['progress'] {
  if (!isRecord(value)) {
    throw invalid('PlanningUpdateContextInvalid', 'Planning update progress is invalid.')
  }
  const linkedWorkItemCount = value.linkedWorkItemCount
  if (
    typeof linkedWorkItemCount !== 'number' ||
    !Number.isSafeInteger(linkedWorkItemCount) ||
    linkedWorkItemCount < 0
  ) {
    throw invalid('PlanningUpdateContextInvalid', 'Linked Work Item count is invalid.')
  }
  return {
    percent: readProgress(value.percent, 'Planning update progress'),
    linkedWorkItemCount,
  }
}

/**
 * Decodes one immutable server context snapshot.
 *
 * @param value - Untrusted context candidate.
 * @returns Validated context used for historical comparison.
 */
function readPlanningUpdateContextSnapshot(value: unknown): PlanningUpdateContextSnapshot {
  if (!isRecord(value) || !isRecord(value.scope)) {
    throw invalid('PlanningUpdateContextInvalid', 'Planning update context is invalid.')
  }
  const scope = {
    ...(value.scope.teamId === undefined
      ? {}
      : { teamId: readIdentifier(value.scope.teamId, 'Context Team ID') }),
    ...(value.scope.projectId === undefined
      ? {}
      : { projectId: readIdentifier(value.scope.projectId, 'Context Project ID') }),
  }
  if (scope.projectId !== undefined && scope.teamId === undefined) {
    throw invalid('PlanningUpdateContextInvalid', 'Project context requires a Team ID.')
  }
  if (!Array.isArray(value.milestones) || !Array.isArray(value.dependencies)) {
    throw invalid('PlanningUpdateContextInvalid', 'Planning update context collections are invalid.')
  }
  const milestones = value.milestones.map((candidate) => {
    if (!isRecord(candidate)) {
      throw invalid('PlanningUpdateContextInvalid', 'Milestone context is invalid.')
    }
    return {
      entityId: readIdentifier(candidate.entityId, 'Context Milestone ID'),
      title: readTitle(candidate.title),
      status: readEntityStatus(candidate.status),
      forecast: readDateRange(candidate.forecast, 'Context Milestone forecast'),
    }
  })
  const dependencies = value.dependencies.map((candidate) => {
    if (!isRecord(candidate)) {
      throw invalid('PlanningUpdateContextInvalid', 'Dependency context is invalid.')
    }
    return {
      dependencyId: readIdentifier(candidate.dependencyId, 'Context dependency ID'),
      predecessorId: readIdentifier(candidate.predecessorId, 'Context predecessor ID'),
      successorId: readIdentifier(candidate.successorId, 'Context successor ID'),
      type: readDependencyType(candidate.type),
      lagDays: readLagDays(candidate.lagDays),
    }
  })
  requireUniqueCollectionIds(
    milestones.map((milestone) => milestone.entityId),
    'Context Milestone IDs',
  )
  requireUniqueCollectionIds(
    dependencies.map((dependency) => dependency.dependencyId),
    'Context dependency IDs',
  )
  return {
    health: readHealth(value.health),
    risk: readRisk(value.risk),
    progress: readPlanningUpdateProgressSnapshot(value.progress),
    scope,
    ...(value.targetDate === undefined
      ? {}
      : { targetDate: readIsoDate(value.targetDate, 'Context target date') }),
    milestones,
    dependencies,
  }
}

/**
 * Normalizes typed evidence references and rejects duplicates.
 *
 * @param value - Untrusted evidence list.
 * @returns Canonical evidence references.
 */
function readPlanningUpdateEvidence(value: unknown): PlanningUpdateEvidence[] {
  if (!Array.isArray(value) || value.length > MAX_UPDATE_EVIDENCE) {
    throw invalid('PlanningUpdateEvidenceInvalid', 'Planning update evidence list is invalid.')
  }
  const evidence = value.map((candidate): PlanningUpdateEvidence => {
    if (!isRecord(candidate)) {
      throw invalid('PlanningUpdateEvidenceInvalid', 'Planning update evidence is invalid.')
    }
    if (candidate.type === 'work-item') {
      return {
        type: 'work-item',
        teamId: readIdentifier(candidate.teamId, 'Evidence Team ID'),
        workItemId: readIdentifier(candidate.workItemId, 'Evidence Work Item ID'),
      }
    }
    if (candidate.type === 'planning-entity') {
      return {
        type: 'planning-entity',
        entityId: readIdentifier(candidate.entityId, 'Evidence Planning entity ID'),
      }
    }
    if (candidate.type === 'decision') {
      return {
        type: 'decision',
        decisionId: readIdentifier(candidate.decisionId, 'Evidence Decision ID'),
        url: readPlanningUpdateEvidenceUrl(candidate.url),
      }
    }
    if (candidate.type === 'file') {
      return {
        type: 'file',
        fileId: readIdentifier(candidate.fileId, 'Evidence File ID'),
        url: readPlanningUpdateEvidenceUrl(candidate.url),
      }
    }
    if (candidate.type === 'link') {
      const url = readPlanningUpdateEvidenceUrl(candidate.url)
      return {
        type: 'link',
        url,
        ...(candidate.label === undefined
          ? {}
          : { label: readPlanningUpdateText(candidate.label, 'Evidence link label') }),
      }
    }
    throw invalid('PlanningUpdateEvidenceInvalid', 'Planning update evidence type is invalid.')
  })
  const keys = evidence.map((candidate) => JSON.stringify(candidate))
  requireUniqueCollectionIds(keys, 'Planning update evidence')
  return evidence
}

/**
 * Restricts link evidence to bounded credential-free HTTPS URLs.
 *
 * @param value - Untrusted URL candidate.
 * @returns Canonical HTTPS URL string.
 */
function readPlanningUpdateEvidenceUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2_048 || !isWellFormedText(value)) {
    throw invalid('PlanningUpdateEvidenceInvalid', 'Evidence URL is invalid.')
  }
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search
    ) throw new Error('invalid')
    return url.toString()
  } catch {
    throw invalid('PlanningUpdateEvidenceInvalid', 'Evidence URL must use HTTPS.')
  }
}

/**
 * Decodes server-generated context changes from persistence.
 *
 * @param value - Untrusted change list.
 * @returns Validated typed changes.
 */
function readPlanningUpdateChanges(value: unknown): PlanningUpdateChange[] {
  if (!Array.isArray(value) || value.length > 7) {
    throw invalid('PlanningUpdateChangeInvalid', 'Planning update change list is invalid.')
  }
  return value.map((candidate): PlanningUpdateChange => {
    if (!isRecord(candidate)) {
      throw invalid('PlanningUpdateChangeInvalid', 'Planning update change is invalid.')
    }
    if (candidate.type === 'health') {
      return { type: 'health', before: readHealth(candidate.before), after: readHealth(candidate.after) }
    }
    if (candidate.type === 'risk') {
      return { type: 'risk', before: readRisk(candidate.before), after: readRisk(candidate.after) }
    }
    if (candidate.type === 'progress') {
      return {
        type: 'progress',
        before: readProgress(candidate.before, 'Previous update progress'),
        after: readProgress(candidate.after, 'Current update progress'),
      }
    }
    if (candidate.type === 'target-date') {
      return {
        type: 'target-date',
        ...(candidate.before === undefined
          ? {}
          : { before: readIsoDate(candidate.before, 'Previous target date') }),
        ...(candidate.after === undefined
          ? {}
          : { after: readIsoDate(candidate.after, 'Current target date') }),
      }
    }
    if (candidate.type === 'scope') {
      const before = readPlanningUpdateContextSnapshot({
        health: 'unknown', risk: 'none', progress: { percent: 0, linkedWorkItemCount: 0 },
        scope: candidate.before, milestones: [], dependencies: [],
      }).scope
      const after = readPlanningUpdateContextSnapshot({
        health: 'unknown', risk: 'none', progress: { percent: 0, linkedWorkItemCount: 0 },
        scope: candidate.after, milestones: [], dependencies: [],
      }).scope
      return { type: 'scope', before, after }
    }
    if (candidate.type === 'milestones' || candidate.type === 'dependencies') {
      const addedIds = readUniqueIdentifiers(candidate.addedIds, 'Added context ID')
      const removedIds = readUniqueIdentifiers(candidate.removedIds, 'Removed context ID')
      const changedIds = readUniqueIdentifiers(candidate.changedIds, 'Changed context ID')
      return { type: candidate.type, addedIds, removedIds, changedIds }
    }
    throw invalid('PlanningUpdateChangeInvalid', 'Planning update change type is invalid.')
  })
}

/**
 * Rejects duplicate values in one canonical collection.
 *
 * @param values - Comparable string values.
 * @param label - Collection label used in validation errors.
 */
function requireUniqueCollectionIds(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) {
    throw invalid('PlanningUpdateContextInvalid', `${label} cannot contain duplicates.`)
  }
}

/**
 * Reads and validates one persisted Work Item dependency row.
 *
 * @param row - DynamoDB row to decode.
 * @returns Canonical Work Item schedule dependency.
 */
function readStoredPlanningWorkItemDependency(
  row: Record<string, unknown>,
): WorkItemScheduleDependency {
  const id = readIdentifier(row.id, 'Work Item dependency ID')
  if (row.recordKey !== createWorkItemDependencyRecordKey(id)) {
    throw invalid(
      'PlanningRecordKeyInvalid',
      'Planning Work Item dependency record key does not match its ID.',
    )
  }
  return {
    id,
    predecessor: readWorkItemDependencyEndpoint(row.predecessor, 'Predecessor'),
    successor: readWorkItemDependencyEndpoint(row.successor, 'Successor'),
    type: readDependencyType(row.type),
    lagDays: readLagDays(row.lagDays),
    ...(row.constraint === undefined
      ? {}
      : { constraint: readDependencyConstraint(row.constraint) }),
    createdAt: readTimestamp(row.createdAt, 'Work Item dependency creation timestamp'),
    updatedAt: readTimestamp(row.updatedAt, 'Work Item dependency update timestamp'),
  }
}

function readStoredPlanningWorkItemLink(row: Record<string, unknown>): PlanningWorkItemLink {
  const teamId = readIdentifier(row.teamId, 'Team ID')
  const workItemId = readIdentifier(row.workItemId, 'Work Item ID')
  if (row.recordKey !== createLinkRecordKey(teamId, workItemId)) {
    throw invalid('PlanningRecordKeyInvalid', 'Planning Work Item link record key is invalid.')
  }
  return {
    teamId,
    workItemId,
    ...(row.projectId === undefined
      ? {}
      : { projectId: readIdentifier(row.projectId, 'Project ID') }),
    ...(row.cycleId === undefined
      ? {}
      : { cycleId: readIdentifier(row.cycleId, 'Cycle ID') }),
    ...(row.milestoneId === undefined
      ? {}
      : { milestoneId: readIdentifier(row.milestoneId, 'Milestone ID') }),
    goalIds: readUniqueIdentifiers(row.goalIds, 'Goal ID'),
    createdAt: readTimestamp(row.createdAt, 'Work Item link timestamp'),
  }
}

function readStoredStatusUpdates(value: unknown) {
  validateStatusUpdates(value)
  return value.map((update) => ({
    id: update.id,
    message: update.message,
    authorMemberKey: update.authorMemberKey,
    ...(update.health === undefined ? {} : { health: update.health }),
    ...(update.risk === undefined ? {} : { risk: update.risk }),
    createdAt: update.createdAt,
  }))
}

function replaceEntity(state: PlanningWorkspaceState, entity: StoredPlanningEntity) {
  return {
    ...state,
    entities: state.entities.map((candidate) => candidate.id === entity.id ? entity : candidate),
  }
}

function findEntity(state: PlanningWorkspaceState, entityId: string) {
  const id = readIdentifier(entityId, 'Planning entity ID')
  return state.entities.find((entity) => entity.id === id)
}

function collectActiveDescendantIds(
  entities: readonly StoredPlanningEntity[],
  parentId: string,
) {
  const childrenByParent = new Map<string, StoredPlanningEntity[]>()
  for (const entity of entities) {
    if (!entity.parentId) continue
    const children = childrenByParent.get(entity.parentId) ?? []
    children.push(entity)
    childrenByParent.set(entity.parentId, children)
  }
  const descendants = new Set<string>()
  const visited = new Set<string>()
  const pending = [...(childrenByParent.get(parentId) ?? [])]
  while (pending.length > 0) {
    const entity = pending.pop()!
    if (visited.has(entity.id)) continue
    visited.add(entity.id)
    if (!entity.archivedAt) descendants.add(entity.id)
    pending.push(...(childrenByParent.get(entity.id) ?? []))
  }
  return descendants
}

function requireActiveEntity(state: PlanningWorkspaceState, entityId: string) {
  const entity = findEntity(state, entityId)
  if (!entity) throw notFound('PlanningEntityNotFound', `Planning entity "${entityId}" was not found.`)
  if (entity.archivedAt) throw conflict('PlanningEntityArchived', `Planning entity "${entityId}" is archived.`)
  return entity
}

function createWorkItemMap(state: PlanningWorkItemState) {
  return new Map(state.workItems.map((item) => [createWorkItemKey(item.teamId, item.id), item]))
}

function requireWorkItem(state: PlanningWorkItemState, teamId: string, workItemId: string) {
  const item = createWorkItemMap(state).get(createWorkItemKey(teamId, workItemId))
  if (!item) throw notFound('PlanningWorkItemNotFound', 'Work Item was not found in planning state.')
  return item
}

/**
 * Resolves both dependency endpoints and creates canonical revision conditions.
 *
 * @param state - Canonical Work Items visible to the mutation.
 * @param dependency - Dependency whose endpoints must exist.
 * @returns Revision conditions for predecessor and successor rows.
 */
function requireWorkItemDependencyEndpoints(
  state: PlanningWorkItemState,
  dependency: WorkItemScheduleDependency,
) {
  const predecessor = requireWorkItem(
    state,
    dependency.predecessor.teamId,
    dependency.predecessor.workItemId,
  )
  const successor = requireWorkItem(
    state,
    dependency.successor.teamId,
    dependency.successor.workItemId,
  )
  return [predecessor, successor].map((summary) => ({
    teamId: summary.teamId,
    workItemId: summary.id,
    revision: readRevision(summary.revision),
  }))
}

/**
 * Rejects a candidate edge when its current endpoint schedules cannot satisfy it.
 *
 * Existing persisted edges are intentionally evaluated only in derived summaries so a later
 * Work Item schedule change can surface a conflict without corrupting the Planning graph. This
 * pre-commit guard therefore applies only to the edge being created or updated.
 *
 * @param state - Canonical Work Item schedules visible to the mutation.
 * @param dependency - Candidate dependency after input normalization.
 */
function requireCurrentWorkItemDependencyIsSatisfied(
  state: PlanningWorkItemState,
  dependency: WorkItemScheduleDependency,
) {
  const workItems = new Map(state.workItems.map((workItem) => [
    createWorkItemKey(workItem.teamId, workItem.id),
    workItem,
  ]))
  if (calculateWorkItemDependencyConflicts([dependency], workItems).length > 0) {
    throw conflict(
      'PlanningWorkItemDependencyConflict',
      'Work Item dependency conflicts with the current endpoint schedules or constraint.',
    )
  }
}

/**
 * Validates a qualified Work Item dependency endpoint.
 *
 * @param value - Endpoint value from an input or persisted row.
 * @param label - Boundary name included in validation errors.
 * @returns Normalized Team and Work Item identity.
 */
function readWorkItemDependencyEndpoint(
  value: unknown,
  label: string,
): WorkItemDependencyEndpoint {
  if (!isRecord(value)) {
    throw invalid(
      'PlanningWorkItemDependencyEndpointInvalid',
      `${label} Work Item dependency endpoint must be an object.`,
    )
  }
  return {
    teamId: readIdentifier(value.teamId, `${label} Team ID`),
    workItemId: readIdentifier(value.workItemId, `${label} Work Item ID`),
  }
}

function createWorkItemKey(teamId: string, workItemId: string) {
  return `${teamId}\u0000${workItemId}`
}

function comparePlanningWorkItemLinks(
  first: PlanningWorkItemLink,
  second: PlanningWorkItemLink,
) {
  return compareText(
    createWorkItemKey(first.teamId, first.workItemId),
    createWorkItemKey(second.teamId, second.workItemId),
  )
}

function comparePlanningWorkItems(
  first: PlanningWorkItemSummary,
  second: PlanningWorkItemSummary,
) {
  return compareText(
    createWorkItemKey(first.teamId, first.id),
    createWorkItemKey(second.teamId, second.id),
  )
}

function compareText(first: string, second: string) {
  if (first < second) return -1
  if (first > second) return 1
  return 0
}

function createEntityRecordKey(id: string) {
  return readRecordKey(
    `${ENTITY_RECORD_PREFIX}${encodeRecordKeyIdentifier(id)}`,
    'Planning entity record key',
  )
}

function createDependencyRecordKey(id: string) {
  return readRecordKey(
    `${DEPENDENCY_RECORD_PREFIX}${encodeRecordKeyIdentifier(id)}`,
    'Planning dependency record key',
  )
}

/**
 * Creates the DynamoDB sort key for one Work Item dependency.
 *
 * @param id - Workspace-local dependency identifier.
 * @returns Encoded and size-checked record key.
 */
function createWorkItemDependencyRecordKey(id: string) {
  return readRecordKey(
    `${WORK_ITEM_DEPENDENCY_RECORD_PREFIX}${encodeRecordKeyIdentifier(id)}`,
    'Planning Work Item dependency record key',
  )
}

function createLinkRecordKey(teamId: string, workItemId: string) {
  return readRecordKey(
    `${LINK_RECORD_PREFIX}${encodeRecordKeyIdentifier(teamId)}#${encodeRecordKeyIdentifier(workItemId)}`,
    'Planning Work Item link record key',
  )
}

/**
 * Creates the encoded target suffix shared by UPDATE_TARGET and UPDATE rows.
 *
 * @param target - Canonical Project or Initiative target.
 * @returns DynamoDB-safe target suffix.
 */
function createPlanningUpdateTargetRecordSuffix(target: PlanningUpdateTarget) {
  return target.type === 'project'
    ? `PROJECT#${encodeRecordKeyIdentifier(target.teamId)}#${encodeRecordKeyIdentifier(target.projectId)}`
    : `INITIATIVE#${encodeRecordKeyIdentifier(target.entityId)}`
}

/**
 * Creates the sort key of one UPDATE_TARGET row.
 *
 * @param target - Canonical target.
 * @returns Size-checked DynamoDB sort key.
 */
function createPlanningUpdateTargetRecordKey(target: PlanningUpdateTarget) {
  return readRecordKey(
    `${UPDATE_TARGET_RECORD_PREFIX}${createPlanningUpdateTargetRecordSuffix(target)}`,
    'Planning update target record key',
  )
}

/**
 * Creates the canonical Planning UPDATE_TARGET key for a Team-qualified Project.
 *
 * @param teamId - Owning Team identifier.
 * @param projectId - Team-local Project identifier.
 * @returns DynamoDB sort key for the Project target row.
 */
export function createPlanningUpdateProjectTargetRecordKey(
  teamId: string,
  projectId: string,
): string {
  return createPlanningUpdateTargetRecordKey({ type: 'project', teamId, projectId })
}

/**
 * Creates the target-bound sort-key prefix used to page immutable updates.
 *
 * @param target - Canonical target.
 * @returns DynamoDB sort-key prefix.
 */
function createPlanningUpdateRecordPrefix(target: PlanningUpdateTarget) {
  return readRecordKey(
    `${UPDATE_RECORD_PREFIX}${createPlanningUpdateTargetRecordSuffix(target)}#`,
    'Planning update record prefix',
  )
}

/**
 * Creates one lexicographically ordered immutable update sort key.
 *
 * @param target - Canonical target.
 * @param version - Positive target-local version.
 * @returns Zero-padded DynamoDB sort key.
 */
function createPlanningUpdateRecordKey(target: PlanningUpdateTarget, version: number) {
  const normalizedVersion = readPlanningUpdateVersion(version)
  return readRecordKey(
    `${createPlanningUpdateRecordPrefix(target)}${String(normalizedVersion).padStart(UPDATE_VERSION_WIDTH, '0')}`,
    'Planning update record key',
  )
}

/**
 * Creates the deterministic target-scoped identity marker key for one update ID.
 *
 * @param target - Canonical Project or Initiative target.
 * @param updateId - Validated client-generated immutable update ID.
 * @returns Size-checked DynamoDB sort key.
 */
function createPlanningUpdateIdRecordKey(
  target: PlanningUpdateTarget,
  updateId: string,
) {
  return readRecordKey(
    `${UPDATE_ID_RECORD_PREFIX}${createPlanningUpdateTargetRecordSuffix(target)}#` +
      `${encodeRecordKeyIdentifier(readIdentifier(updateId, 'Planning update ID'))}`,
    'Planning update ID record key',
  )
}

/**
 * Creates one deterministic identity marker committed with an immutable update row.
 *
 * @param workspaceId - Owning Workspace partition.
 * @param update - Validated immutable update.
 * @returns Minimal DynamoDB marker row excluded from graph and history reads.
 */
function createPlanningUpdateIdRow(workspaceId: string, update: PlanningUpdate) {
  return {
    workspaceId,
    recordKey: createPlanningUpdateIdRecordKey(update.target, update.id),
    entryType: 'planning-update-id',
    target: structuredClone(update.target),
    updateId: update.id,
    updateVersion: update.version,
  }
}

/**
 * Creates and size-checks one immutable Planning update row.
 *
 * @param workspaceId - Owning Workspace partition.
 * @param update - Validated immutable update.
 * @returns DynamoDB document row.
 */
function createPlanningUpdateRow(workspaceId: string, update: PlanningUpdate) {
  const row = {
    workspaceId,
    recordKey: createPlanningUpdateRecordKey(update.target, update.version),
    entryType: 'planning-update',
    ...update,
  }
  if (utf8ByteLength(JSON.stringify(row)) > MAX_PLANNING_ROW_BYTES) {
    throw new PlanningError(
      413,
      'PlanningRowSizeLimitExceeded',
      'A Planning update row exceeds the safe DynamoDB item size limit.',
    )
  }
  return row
}

/**
 * Creates the version-qualified prefix for append-only comment rows.
 *
 * @param target - Canonical update target.
 * @param updateVersion - Immutable target-local version.
 * @returns DynamoDB comment prefix.
 */
function createPlanningUpdateCommentRecordPrefix(
  target: PlanningUpdateTarget,
  updateVersion: number,
) {
  return readRecordKey(
    `${UPDATE_COMMENT_RECORD_PREFIX}${createPlanningUpdateTargetRecordSuffix(target)}#` +
      `${String(readPlanningUpdateVersion(updateVersion)).padStart(UPDATE_VERSION_WIDTH, '0')}#`,
    'Planning update comment record prefix',
  )
}

/**
 * Creates a chronological append-only comment row key.
 *
 * @param comment - Validated comment.
 * @returns DynamoDB comment sort key.
 */
function createPlanningUpdateCommentRecordKey(
  comment: Pick<PlanningUpdateComment, 'target' | 'updateVersion' | 'id' | 'createdAt'>,
) {
  const timestamp = Date.parse(comment.createdAt)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw invalid('PlanningUpdateCommentInvalid', 'Planning update comment timestamp is invalid.')
  }
  return readRecordKey(
    `${createPlanningUpdateCommentRecordPrefix(comment.target, comment.updateVersion)}` +
      `${String(timestamp).padStart(UPDATE_VERSION_WIDTH, '0')}#` +
      `${encodeRecordKeyIdentifier(comment.id)}`,
    'Planning update comment record key',
  )
}

/**
 * Creates and size-checks one append-only comment row.
 *
 * @param workspaceId - Owning Workspace partition.
 * @param comment - Validated immutable comment.
 * @returns DynamoDB document row.
 */
function createPlanningUpdateCommentRow(
  workspaceId: string,
  comment: PlanningUpdateComment,
) {
  const row = {
    workspaceId,
    recordKey: createPlanningUpdateCommentRecordKey(comment),
    entryType: 'planning-update-comment',
    ...comment,
  }
  requirePlanningAnnotationRowSize(row)
  return row
}

/**
 * Creates the deterministic uniqueness key for one client-generated comment ID.
 *
 * @param comment - Validated comment identity and target.
 * @returns DynamoDB marker sort key independent of comment creation time.
 */
function createPlanningUpdateCommentIdRecordKey(
  comment: Pick<PlanningUpdateComment, 'target' | 'updateVersion' | 'id'>,
) {
  return readRecordKey(
    `${UPDATE_COMMENT_ID_RECORD_PREFIX}${createPlanningUpdateTargetRecordSuffix(comment.target)}#` +
      `${String(readPlanningUpdateVersion(comment.updateVersion)).padStart(UPDATE_VERSION_WIDTH, '0')}#` +
      `${encodeRecordKeyIdentifier(readIdentifier(comment.id, 'Planning update comment ID'))}`,
    'Planning update comment ID record key',
  )
}

/**
 * Creates a deterministic marker that makes comment IDs target/version-local unique.
 *
 * @param workspaceId - Owning Workspace partition.
 * @param comment - Comment whose identity is reserved atomically.
 * @returns DynamoDB uniqueness marker row.
 */
function createPlanningUpdateCommentIdRow(
  workspaceId: string,
  comment: PlanningUpdateComment,
) {
  const row = {
    workspaceId,
    recordKey: createPlanningUpdateCommentIdRecordKey(comment),
    entryType: 'planning-update-comment-id',
    target: structuredClone(comment.target),
    updateVersion: comment.updateVersion,
    commentId: comment.id,
    commentRecordKey: createPlanningUpdateCommentRecordKey(comment),
    createdAt: comment.createdAt,
  }
  requirePlanningAnnotationRowSize(row)
  return row
}

/**
 * Decodes one append-only comment row.
 *
 * @param row - Untrusted DynamoDB row.
 * @param workspaceId - Expected Workspace partition.
 * @returns Validated Planning update comment.
 */
function readStoredPlanningUpdateComment(
  row: Record<string, unknown>,
  workspaceId: string,
): PlanningUpdateComment {
  if (row.workspaceId !== workspaceId || row.entryType !== 'planning-update-comment') {
    throw persistenceInvalid('Planning update comment row scope is invalid.')
  }
  const comment: PlanningUpdateComment = {
    id: readIdentifier(row.id, 'Planning update comment ID'),
    target: readPlanningUpdateTarget(row.target),
    updateVersion: readPlanningUpdateVersion(row.updateVersion),
    body: readPlanningUpdateCommentBody(row.body),
    authorMemberKey: readOwnerMemberKey(row.authorMemberKey),
    createdAt: readTimestamp(row.createdAt, 'Planning update comment timestamp'),
  }
  if (row.recordKey !== createPlanningUpdateCommentRecordKey(comment)) {
    throw persistenceInvalid('Planning update comment row key is invalid.')
  }
  return comment
}

/**
 * Creates the version-qualified prefix for member reaction rows.
 *
 * @param target - Canonical update target.
 * @param updateVersion - Immutable target-local version.
 * @returns DynamoDB reaction prefix.
 */
function createPlanningUpdateReactionRecordPrefix(
  target: PlanningUpdateTarget,
  updateVersion: number,
) {
  return readRecordKey(
    `${UPDATE_REACTION_RECORD_PREFIX}${createPlanningUpdateTargetRecordSuffix(target)}#` +
      `${String(readPlanningUpdateVersion(updateVersion)).padStart(UPDATE_VERSION_WIDTH, '0')}#`,
    'Planning update reaction record prefix',
  )
}

/**
 * Creates the unique reaction row key for one emoji and member.
 *
 * @param reaction - Reaction identity and target.
 * @returns DynamoDB reaction sort key.
 */
function createPlanningUpdateReactionRecordKey(
  reaction: Pick<PlanningUpdateReaction, 'target' | 'updateVersion' | 'emoji' | 'memberKey'>,
) {
  return readRecordKey(
    `${createPlanningUpdateReactionRecordPrefix(reaction.target, reaction.updateVersion)}` +
      `${encodeRecordKeyIdentifier(readPlanningUpdateReaction(reaction.emoji))}#` +
      `${encodeRecordKeyIdentifier(readOwnerMemberKey(reaction.memberKey))}`,
    'Planning update reaction record key',
  )
}

/**
 * Creates and size-checks one member reaction row.
 *
 * @param workspaceId - Owning Workspace partition.
 * @param reaction - Validated member reaction.
 * @returns DynamoDB document row.
 */
function createPlanningUpdateReactionRow(
  workspaceId: string,
  reaction: PlanningUpdateReaction,
) {
  const row = {
    workspaceId,
    recordKey: createPlanningUpdateReactionRecordKey(reaction),
    entryType: 'planning-update-reaction',
    ...reaction,
  }
  requirePlanningAnnotationRowSize(row)
  return row
}

/**
 * Decodes one member reaction row.
 *
 * @param row - Untrusted DynamoDB row.
 * @param workspaceId - Expected Workspace partition.
 * @returns Validated member reaction.
 */
function readStoredPlanningUpdateReaction(
  row: Record<string, unknown>,
  workspaceId: string,
): PlanningUpdateReaction {
  if (row.workspaceId !== workspaceId || row.entryType !== 'planning-update-reaction') {
    throw persistenceInvalid('Planning update reaction row scope is invalid.')
  }
  const reaction: PlanningUpdateReaction = {
    target: readPlanningUpdateTarget(row.target),
    updateVersion: readPlanningUpdateVersion(row.updateVersion),
    emoji: readPlanningUpdateReaction(row.emoji),
    memberKey: readOwnerMemberKey(row.memberKey),
    createdAt: readTimestamp(row.createdAt, 'Planning update reaction timestamp'),
  }
  if (row.recordKey !== createPlanningUpdateReactionRecordKey(reaction)) {
    throw persistenceInvalid('Planning update reaction row key is invalid.')
  }
  return reaction
}

/**
 * Enforces the safe DynamoDB row-size boundary for annotation rows.
 *
 * @param row - Comment or reaction row.
 */
function requirePlanningAnnotationRowSize(row: Record<string, unknown>) {
  if (utf8ByteLength(JSON.stringify(row)) > MAX_PLANNING_ROW_BYTES) {
    throw new PlanningError(
      413,
      'PlanningRowSizeLimitExceeded',
      'A Planning update annotation row exceeds the safe DynamoDB item size limit.',
    )
  }
}

/**
 * Creates the immutable update existence check shared by annotation writes.
 *
 * @param tableName - Planning DynamoDB table.
 * @param workspaceId - Owning Workspace partition.
 * @param target - Canonical update target.
 * @param updateVersion - Immutable target-local version.
 * @returns DynamoDB transaction condition.
 */
function createPlanningUpdateExistenceCondition(
  tableName: string,
  workspaceId: string,
  target: PlanningUpdateTarget,
  updateVersion: number,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: {
        workspaceId,
        recordKey: createPlanningUpdateRecordKey(target, updateVersion),
      },
      ConditionExpression:
        'attribute_exists(workspaceId) AND attribute_exists(recordKey) AND ' +
        '#entryType = :planningUpdateEntryType',
      ExpressionAttributeNames: { '#entryType': 'entryType' },
      ExpressionAttributeValues: { ':planningUpdateEntryType': 'planning-update' },
    },
  }
}

/**
 * Creates the in-memory Workspace and target history key.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param target - Canonical target.
 * @returns Collision-safe map key.
 */
function createPlanningUpdateHistoryMapKey(
  workspaceId: string,
  target: PlanningUpdateTarget,
) {
  return `${workspaceId}\u0001${createPlanningUpdateTargetIdentity(target)}`
}

/**
 * Creates the in-memory annotation key for one immutable update version.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param target - Canonical update target.
 * @param updateVersion - Immutable target-local version.
 * @returns Collision-safe map key.
 */
function createPlanningUpdateAnnotationMapKey(
  workspaceId: string,
  target: PlanningUpdateTarget,
  updateVersion: number,
) {
  return `${createPlanningUpdateHistoryMapKey(workspaceId, target)}\u0001` +
    `${readPlanningUpdateVersion(updateVersion)}`
}

/** Versioned target-bound public cursor payload. */
type PlanningUpdateHistoryCursorPayload = {
  /** Cursor schema version. */
  version: 1
  /** Logical target binding. */
  targetKey: string
  /** Last version returned by the previous page. */
  beforeVersion: number
}

/** Logical annotation boundary carried by a public cursor. */
type PlanningUpdateAnnotationCursorBoundary =
  | {
      /** Boundary discriminator. */
      kind: 'comment'
      /** Comment identity. */
      id: string
      /** Comment creation timestamp used for chronological ordering. */
      createdAt: string
    }
  | {
      /** Boundary discriminator. */
      kind: 'reaction'
      /** Reaction token. */
      emoji: string
      /** Reacting member identity. */
      memberKey: string
    }

/** Versioned and scope-bound annotation cursor payload. */
type PlanningUpdateAnnotationCursorPayload = {
  /** Cursor schema version. */
  version: 1
  /** Annotation collection discriminator. */
  kind: 'comment' | 'reaction'
  /** Logical target binding. */
  targetKey: string
  /** Immutable update version binding. */
  updateVersion: number
  /** Last logical annotation returned by the previous page. */
  boundary: PlanningUpdateAnnotationCursorBoundary
}

/**
 * Encodes a scope-bound opaque update history cursor.
 *
 * @param target - Target whose history is being paged.
 * @param beforeVersion - Last version returned by the current page.
 * @returns Base64url cursor.
 */
function createPlanningUpdateHistoryCursor(
  target: PlanningUpdateTarget,
  beforeVersion: number,
) {
  const payload: PlanningUpdateHistoryCursorPayload = {
    version: 1,
    targetKey: createPlanningUpdateTargetIdentity(target),
    beforeVersion: readPlanningUpdateVersion(beforeVersion),
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Validates a cursor before passing it to a storage adapter.
 *
 * @param cursor - Untrusted public cursor.
 * @param target - Expected target scope.
 * @returns Original canonical cursor.
 */
function readPlanningUpdateHistoryCursor(cursor: unknown, target: PlanningUpdateTarget) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 2_048) {
    throw invalid('PlanningUpdateCursorInvalid', 'Planning update cursor is invalid.')
  }
  decodePlanningUpdateHistoryCursor(cursor, target)
  return cursor
}

/**
 * Decodes and revalidates a target-bound history cursor.
 *
 * @param cursor - Opaque cursor returned by this module.
 * @param target - Target expected by the current request.
 * @returns Exclusive upper version boundary.
 */
function decodePlanningUpdateHistoryCursor(
  cursor: string,
  target: PlanningUpdateTarget,
) {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.targetKey !== createPlanningUpdateTargetIdentity(target)
    ) {
      throw new Error('invalid')
    }
    return readPlanningUpdateVersion(value.beforeVersion)
  } catch {
    throw invalid('PlanningUpdateCursorInvalid', 'Planning update cursor is invalid.')
  }
}

/**
 * Applies defaults and bounds to one public history page size.
 *
 * @param value - Optional untrusted limit.
 * @returns Page size from one through the configured maximum.
 */
function readPlanningUpdateHistoryLimit(value: unknown) {
  if (value === undefined) return DEFAULT_UPDATE_HISTORY_PAGE_SIZE
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_UPDATE_HISTORY_PAGE_SIZE
  ) {
    throw invalid(
      'PlanningUpdateHistoryLimitInvalid',
      `Planning update history limit must be from 1 through ${MAX_UPDATE_HISTORY_PAGE_SIZE}.`,
    )
  }
  return value
}

/**
 * Encodes a target/version-bound opaque annotation cursor.
 *
 * @param kind - Comment or reaction collection.
 * @param target - Canonical update target.
 * @param updateVersion - Immutable target-local version.
 * @param annotation - Last returned logical annotation.
 * @returns Base64url cursor.
 */
function createPlanningUpdateAnnotationCursor(
  kind: 'comment' | 'reaction',
  target: PlanningUpdateTarget,
  updateVersion: number,
  annotation: PlanningUpdateComment | PlanningUpdateReaction,
) {
  const boundary: PlanningUpdateAnnotationCursorBoundary = kind === 'comment'
    ? 'id' in annotation
      ? {
          kind: 'comment',
          id: readIdentifier(annotation.id, 'Planning update comment ID'),
          createdAt: readTimestamp(annotation.createdAt, 'Planning update comment timestamp'),
        }
      : (() => {
          throw invalid('PlanningUpdateCursorInvalid', 'Planning update comment cursor is invalid.')
        })()
    : 'emoji' in annotation
      ? {
          kind: 'reaction',
          emoji: readPlanningUpdateReaction(annotation.emoji),
          memberKey: readOwnerMemberKey(annotation.memberKey),
        }
      : (() => {
          throw invalid('PlanningUpdateCursorInvalid', 'Planning update reaction cursor is invalid.')
        })()
  const payload: PlanningUpdateAnnotationCursorPayload = {
    version: 1,
    kind,
    targetKey: createPlanningUpdateTargetIdentity(target),
    updateVersion: readPlanningUpdateVersion(updateVersion),
    boundary,
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Validates an annotation cursor before passing it to storage.
 *
 * @param cursor - Untrusted public cursor.
 * @param kind - Expected annotation collection.
 * @param target - Expected target scope.
 * @param updateVersion - Expected immutable update version.
 * @returns Original canonical cursor.
 */
function readPlanningUpdateAnnotationCursor(
  cursor: unknown,
  kind: 'comment' | 'reaction',
  target: PlanningUpdateTarget,
  updateVersion: number,
) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 4_096) {
    throw invalid('PlanningUpdateCursorInvalid', 'Planning update annotation cursor is invalid.')
  }
  decodePlanningUpdateAnnotationCursor(cursor, kind, target, updateVersion)
  return cursor
}

/**
 * Decodes and revalidates a scope-bound annotation cursor.
 *
 * @param cursor - Opaque cursor returned by this module.
 * @param kind - Expected annotation collection.
 * @param target - Expected target scope.
 * @param updateVersion - Expected immutable update version.
 * @returns Exclusive DynamoDB record-key boundary derived from the logical cursor.
 */
function decodePlanningUpdateAnnotationCursor(
  cursor: string,
  kind: 'comment' | 'reaction',
  target: PlanningUpdateTarget,
  updateVersion: number,
) {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.kind !== kind ||
      value.targetKey !== createPlanningUpdateTargetIdentity(target) ||
      value.updateVersion !== updateVersion ||
      !isRecord(value.boundary)
    ) {
      throw new Error('invalid')
    }
    if (kind === 'comment') {
      if (
        value.boundary.kind !== 'comment' ||
        typeof value.boundary.id !== 'string' ||
        typeof value.boundary.createdAt !== 'string'
      ) {
        throw new Error('invalid')
      }
      return createPlanningUpdateCommentRecordKey({
        target,
        updateVersion,
        id: readIdentifier(value.boundary.id, 'Planning update comment ID'),
        createdAt: readTimestamp(
          value.boundary.createdAt,
          'Planning update comment timestamp',
        ),
      })
    }
    if (
      value.boundary.kind !== 'reaction' ||
      typeof value.boundary.emoji !== 'string' ||
      typeof value.boundary.memberKey !== 'string'
    ) {
      throw new Error('invalid')
    }
    return createPlanningUpdateReactionRecordKey({
      target,
      updateVersion,
      emoji: readPlanningUpdateReaction(value.boundary.emoji),
      memberKey: readOwnerMemberKey(value.boundary.memberKey),
    })
  } catch {
    throw invalid('PlanningUpdateCursorInvalid', 'Planning update annotation cursor is invalid.')
  }
}

function encodeRecordKeyIdentifier(value: string) {
  if (!isWellFormedText(value)) {
    throw invalid('PlanningIdentifierInvalid', 'Planning identifier contains invalid Unicode.')
  }
  return encodeURIComponent(value)
}

function readRecordKey(value: string, label: string) {
  if (utf8ByteLength(value) > 1_024) {
    throw invalid('PlanningRecordKeyInvalid', `${label} exceeds the DynamoDB key size limit.`)
  }
  return value
}

function durationDays(range: { startDate: string; endDate: string }) {
  const start = Date.parse(`${range.startDate}T00:00:00.000Z`)
  const end = Date.parse(`${range.endDate}T00:00:00.000Z`)
  return Math.floor((end - start) / 86_400_000) + 1
}

function effectiveEntityHealth(entity: StoredPlanningEntity) {
  if (entity.risk === 'critical' || entity.risk === 'high') return 'off-track' as const
  if (entity.risk === 'medium') return worstHealth(entity.health, 'at-risk')
  return entity.health
}

function worstHealth(first: PlanningHealth, second: PlanningHealth): PlanningHealth {
  const weight: Record<PlanningHealth, number> = {
    unknown: 0,
    'on-track': 1,
    'at-risk': 2,
    'off-track': 3,
  }
  return weight[first] >= weight[second] ? first : second
}

function planningStatusScore(status: PlanningEntityStatus) {
  if (status === 'completed') return 100
  if (status === 'canceled') return undefined
  if (status === 'active' || status === 'paused') return 50
  return 0
}

function workItemStatusScore(status: PlanningWorkItemSummary['statusCategory']) {
  if (status === 'completed') return 100
  if (status === 'canceled') return undefined
  if (status === 'started') return 50
  return 0
}

function roundProgress(value: number) {
  return Math.round(value * 100) / 100
}

function readDateRange(value: unknown, label: string) {
  if (!isRecord(value)) throw invalid('PlanningDateRangeInvalid', `${label} must be an object.`)
  const startDate = readIsoDate(value.startDate, `${label} start date`)
  const endDate = readIsoDate(value.endDate, `${label} end date`)
  if (startDate > endDate) {
    throw invalid('PlanningDateRangeInvalid', `${label} start date cannot be after its end date.`)
  }
  return { startDate, endDate }
}

function readIsoDate(value: unknown, label: string) {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    throw invalid('PlanningDateInvalid', `${label} must use YYYY-MM-DD.`)
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw invalid('PlanningDateInvalid', `${label} is not a calendar date.`)
  }
  return value
}

function readCadence(value: unknown): PlanningCadence {
  if (!isRecord(value) || (value.unit !== 'week' && value.unit !== 'month')) {
    throw invalid('PlanningCadenceInvalid', 'Cycle cadence is invalid.')
  }
  const count = value.count
  if (!isPositiveInteger(count)) {
    throw invalid('PlanningCadenceInvalid', 'Cycle cadence count must be a positive integer.')
  }
  return { unit: value.unit, count }
}

function readCapacity(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid('PlanningCapacityInvalid', 'Cycle capacity must be a non-negative integer.')
  }
  return value
}

function readProgress(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw invalid('PlanningProgressInvalid', `${label} must be between 0 and 100.`)
  }
  return value
}

function readLagDays(value: unknown) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Math.abs(value) > WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS
  ) {
    throw invalid(
      'PlanningDependencyLagInvalid',
      `Dependency lagDays must be a signed integer from -${WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS} ` +
        `through ${WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS}.`,
    )
  }
  return value
}

/**
 * Validates an explicit dependency date constraint.
 *
 * @param value - Constraint value from an input or persisted row.
 * @returns Normalized successor boundary constraint.
 */
function readDependencyConstraint(value: unknown): ScheduleDependencyConstraint {
  if (!isRecord(value)) {
    throw invalid(
      'PlanningDependencyConstraintInvalid',
      'Dependency constraint must be an object.',
    )
  }
  if (value.anchor !== 'start' && value.anchor !== 'finish') {
    throw invalid(
      'PlanningDependencyConstraintInvalid',
      'Dependency constraint anchor must be start or finish.',
    )
  }
  if (value.kind !== 'on' && value.kind !== 'not-before' && value.kind !== 'not-after') {
    throw invalid(
      'PlanningDependencyConstraintInvalid',
      'Dependency constraint kind is invalid.',
    )
  }
  const date = readIsoDate(value.date, 'Dependency constraint date')
  if (Number(date.slice(0, 4)) < WORK_ITEM_SCHEDULE_MIN_YEAR) {
    throw invalid(
      'PlanningDependencyConstraintInvalid',
      `Dependency constraint date must be between ${WORK_ITEM_SCHEDULE_MIN_YEAR}-01-01 and 9999-12-31.`,
    )
  }
  return {
    anchor: value.anchor,
    kind: value.kind,
    date,
  }
}

function readRevision(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid('PlanningRevisionInvalid', 'Planning expectedRevision must be a non-negative integer.')
  }
  return value
}

function readIdentifier(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 256 ||
    !isWellFormedText(value)
  ) {
    throw invalid('PlanningIdentifierInvalid', `${label} is invalid.`)
  }
  return value
}

function readOwnerMemberKey(value: unknown) {
  return readIdentifier(value, 'Owner member key').toLowerCase()
}

function readUniqueIdentifiers(values: unknown, label: string) {
  if (!Array.isArray(values) || values.length > 100) {
    throw invalid('PlanningIdentifierInvalid', `${label} list is invalid.`)
  }
  const normalized = values.map((value) => readIdentifier(value, label))
  if (new Set(normalized).size !== normalized.length) {
    throw invalid('PlanningIdentifierInvalid', `${label} list cannot contain duplicates.`)
  }
  return normalized.sort()
}

function readTitle(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 500 ||
    !isWellFormedText(value)
  ) {
    throw invalid('PlanningTitleInvalid', 'Planning title is required and cannot exceed 500 characters.')
  }
  return value.trim()
}

function readOptionalDescription(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !isWellFormedText(value)) {
    throw invalid('PlanningDescriptionInvalid', 'Planning description must be text.')
  }
  const description = value.trim()
  if (!description) return undefined
  if (utf8ByteLength(description) > MAX_DESCRIPTION_BYTES) {
    throw invalid(
      'PlanningDescriptionInvalid',
      `Planning description cannot exceed ${MAX_DESCRIPTION_BYTES} UTF-8 bytes.`,
    )
  }
  return description
}

function readRequiredDescription(value: unknown) {
  const description = readOptionalDescription(value)
  if (description === undefined) {
    throw invalid('PlanningDescriptionInvalid', 'Stored Planning description is invalid.')
  }
  return description
}

function readMessage(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    !isWellFormedText(value) ||
    utf8ByteLength(value.trim()) > MAX_STATUS_MESSAGE_BYTES
  ) {
    throw invalid('PlanningStatusUpdateInvalid', 'Status update message is invalid.')
  }
  return value.trim()
}

function readGoalFramework(value: unknown): NonNullable<PlanningEntity['goalFramework']> {
  if (value === 'goal' || value === 'objective' || value === 'key-result') return value
  throw invalid('PlanningGoalFrameworkInvalid', 'Planning goalFramework is invalid.')
}

function readCarryOverPolicy(value: unknown): NonNullable<PlanningEntity['carryOverPolicy']> {
  if (value === 'move-incomplete' || value === 'keep-incomplete') return value
  throw invalid('PlanningCarryOverPolicyInvalid', 'Cycle carry-over policy is invalid.')
}

function readTimestamp(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    !value ||
    !isWellFormedText(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw invalid('PlanningTimestampInvalid', `${label} is invalid.`)
  }
  return value
}

function validateStatusUpdates(value: unknown): asserts value is PlanningStatusUpdate[] {
  if (!Array.isArray(value) || value.length > MAX_STATUS_UPDATES) {
    throw invalid('PlanningStatusUpdateInvalid', 'Planning status update history is invalid.')
  }
  const ids = new Set<string>()
  for (const candidate of value) {
    if (!isRecord(candidate)) {
      throw invalid('PlanningStatusUpdateInvalid', 'Planning status update history is invalid.')
    }
    const id = readIdentifier(candidate.id, 'Status update ID')
    if (ids.has(id)) {
      throw invalid('PlanningStatusUpdateInvalid', 'Planning status update IDs must be unique.')
    }
    ids.add(id)
    readMessage(candidate.message)
    readIdentifier(candidate.authorMemberKey, 'Author member key')
    if (candidate.health !== undefined) readHealth(candidate.health)
    if (candidate.risk !== undefined) readRisk(candidate.risk)
    readTimestamp(candidate.createdAt, 'Status update timestamp')
  }
}

function readEntityType(value: unknown): PlanningEntityType {
  if (
    value === 'cycle' || value === 'milestone' || value === 'release' || value === 'phase' ||
    value === 'goal' || value === 'initiative' || value === 'roadmap' || value === 'portfolio'
  ) return value
  throw invalid('PlanningEntityTypeInvalid', 'Planning entity type is invalid.')
}

function readEntityStatus(value: unknown): PlanningEntityStatus {
  if (
    value === 'proposed' || value === 'planned' || value === 'active' || value === 'paused' ||
    value === 'completed' || value === 'canceled'
  ) return value
  throw invalid('PlanningStatusInvalid', 'Planning entity status is invalid.')
}

function readHealth(value: unknown): PlanningHealth {
  if (value === 'unknown' || value === 'on-track' || value === 'at-risk' || value === 'off-track') return value
  throw invalid('PlanningHealthInvalid', 'Planning health is invalid.')
}

function readRisk(value: unknown): PlanningRisk {
  if (value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'critical') {
    return value
  }
  throw invalid('PlanningRiskInvalid', 'Planning risk is invalid.')
}

function readProgressMode(value: unknown): PlanningEntity['progressMode'] {
  if (value === 'automatic' || value === 'manual') return value
  throw invalid('PlanningProgressModeInvalid', 'Planning progress mode is invalid.')
}

function readDependencyType(value: unknown): PlanningDependencyType {
  if (
    value === 'finish-to-start' ||
    value === 'start-to-start' ||
    value === 'finish-to-finish' ||
    value === 'start-to-finish'
  ) return value
  throw invalid('PlanningDependencyTypeInvalid', 'Planning dependency type is invalid.')
}

function recordsEqual(first: unknown, second: unknown) {
  return JSON.stringify(first) === JSON.stringify(second)
}

function isPlanningTableDescription(table: TableDescription | undefined) {
  return table?.KeySchema?.some((key) => key.AttributeName === 'workspaceId' && key.KeyType === 'HASH') &&
    table.KeySchema.some((key) => key.AttributeName === 'recordKey' && key.KeyType === 'RANGE') &&
    table.GlobalSecondaryIndexes?.some((index) =>
      index.IndexName === PLANNING_UPDATE_SCHEDULE_DUE_INDEX_NAME &&
      index.KeySchema?.some((key) =>
        key.AttributeName === 'updateScheduleShard' && key.KeyType === 'HASH'
      ) &&
      index.KeySchema.some((key) =>
        key.AttributeName === 'nextNotificationAtRecordKey' && key.KeyType === 'RANGE'
      )
    ) === true
}

function createDynamoDbClient() {
  const endpoint = getDynamoDbEndpoint()
  return new DynamoDBClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-northeast-1',
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  })
}

function createDocumentClient(client = createDynamoDbClient()) {
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  })
}

function getDynamoDbEndpoint() {
  return process.env.DYNAMODB_ENDPOINT ??
    process.env.AWS_ENDPOINT_URL_DYNAMODB ??
    process.env.AWS_ENDPOINT_URL
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).length
}

function isWellFormedText(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xDC00 || next > 0xDFFF) return false
      index += 1
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false
    }
  }
  return true
}

function isNamedError(error: unknown, name: string) {
  return error instanceof Error && error.name === name || isRecord(error) && error.name === name
}

function isPlanningRevisionTransactionCancellation(error: unknown) {
  return isPlanningTransactionConditionalFailureAt(error, 0)
}

/**
 * Detects one conditional failure when every cancellation reason is safely classifiable.
 *
 * @param error - DynamoDB transaction error.
 * @param index - Transaction action index to inspect.
 * @returns Whether the selected action failed its condition without an infrastructure reason.
 */
function isPlanningTransactionConditionalFailureAt(error: unknown, index: number) {
  if (!isNamedError(error, 'TransactionCanceledException') || !isRecord(error)) {
    return false
  }
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons) || !isRecord(reasons[index])) return false
  return reasons[index].Code === 'ConditionalCheckFailed' && reasons.every((reason) =>
    isRecord(reason) && (reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed')
  )
}

function isPlanningWorkItemTransactionCancellation(
  error: unknown,
  workItemConditionCount: number,
) {
  if (
    workItemConditionCount === 0 ||
    !isNamedError(error, 'TransactionCanceledException') ||
    !isRecord(error)
  ) {
    return false
  }
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons) || reasons.length < workItemConditionCount + 1) return false
  const workItemReasons = reasons.slice(1, workItemConditionCount + 1)
  const failed = workItemReasons.some((reason) =>
    isRecord(reason) && reason.Code === 'ConditionalCheckFailed'
  )
  return failed && reasons.every((reason) =>
    isRecord(reason) && (reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed')
  )
}

/**
 * Detects a conditional failure in the caller-authorization portion of a transaction.
 *
 * @param error - DynamoDB transaction error.
 * @param startIndex - First caller authorization check in the transaction.
 * @param conditionCount - Number of caller authorization checks.
 * @returns Whether a caller authorization row changed without an unrelated cancellation reason.
 */
function isPlanningCallerAuthorizationTransactionCancellation(
  error: unknown,
  startIndex: number,
  conditionCount: number,
) {
  if (
    conditionCount === 0 ||
    !isNamedError(error, 'TransactionCanceledException') ||
    !isRecord(error)
  ) {
    return false
  }
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons) || reasons.length < startIndex + conditionCount) return false
  const authorizationReasons = reasons.slice(startIndex, startIndex + conditionCount)
  const failed = authorizationReasons.some((reason) =>
    isRecord(reason) && reason.Code === 'ConditionalCheckFailed'
  )
  return failed && reasons.every((reason) =>
    isRecord(reason) && (reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed')
  )
}

function invalid(code: string, message: string) {
  return new PlanningError(400, code, message)
}

function notFound(code: string, message: string) {
  return new PlanningError(404, code, message)
}

function conflict(code: string, message: string) {
  return new PlanningError(409, code, message)
}

function persistenceInvalid(_message: string) {
  return new PlanningError(503, 'InvalidPlanningData', 'Stored Planning data is invalid.')
}

function toPersistenceError(error: unknown) {
  if (error instanceof PlanningError) return error
  const code = isRecord(error) && typeof error.name === 'string'
    ? error.name
    : 'PlanningUnavailable'
  return new PlanningError(503, code, 'Planning storage is unavailable.')
}
