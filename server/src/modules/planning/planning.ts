import { createHash } from 'node:crypto'
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
  CYCLE_AUTO_CREATE_LEAD_DAYS,
  CYCLE_ROLLOVER_BATCH_SIZE,
  CYCLE_WORK_ITEMS_BATCH_LIMIT,
  PLANNING_SCHEMA_VERSION,
  PLANNING_UPDATE_CONTENT_VERSION,
  WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS,
  WORK_ITEM_SCHEDULE_MIN_YEAR,
  type ArchivedPlanningEntityPage,
  type ArchivedPlanningEntitySummary,
  type ConfigurePlanningUpdateCadenceInput,
  type CreatePlanningUpdateCommentInput,
  type CreatePlanningDependencyInput,
  type CreatePlanningEntityInput,
  type CreateWorkItemScheduleDependencyInput,
  type CreateNextCycleInput,
  type CycleAutomation,
  type CycleRolloverInput,
  type CycleWorkItemsInput,
  type DuplicatePlanningEntityInput,
  type MovePlanningEntityInput,
  type ListPlanningUpdatesInput,
  type ListPlanningUpdateCommentsInput,
  type ListPlanningUpdateReactionsInput,
  type PlanningCriticalPath,
  type PlanningCadence,
  type PlanningCapacity,
  type PlanningDependency,
  type PlanningEntity,
  type PlanningEntityStatus,
  type PlanningEntityType,
  type PlanningHealth,
  type PlanningMutationResponse,
  type PlanningRestoreSummary,
  type PlanningRevisionInput,
  type PlanningRisk,
  type PlanningSnapshot,
  type PlanningUpdate,
  type PlanningUpdateCadence,
  type PlanningUpdateCadenceMutationResponse,
  type PlanningUpdateChange,
  type PlanningUpdateAcknowledgement,
  type PlanningUpdateComment,
  type PlanningUpdateCommentPage,
  type PlanningUpdateContextSnapshot,
  type PlanningUpdateEvidence,
  type PlanningUpdateHistoryPage,
  type PlanningUpdatePublishResponse,
  type PlanningUpdateReaction,
  type PlanningUpdateReactionInput,
  type PlanningUpdateReactionPage,
  type PlanningUpdateScopeSnapshot,
  type PlanningUpdateTarget,
  type PlanningUpdateTargetSummary,
  type PlanningWorkItemLink,
  type PlanningWorkItemLinkInput,
  type PlanningWorkItemDependencySummary,
  type PlanningWorkItemSummary,
  type ScheduleDependencyConstraint,
  type ScheduleDependencyType,
  type PublishPlanningUpdateInput,
  type RestorePlanningEntityResponse,
  type UpdatePlanningEntityInput,
  type UpdateWorkItemScheduleDependencyInput,
  type WorkItemAffectedProject,
  type WorkItemDependencyCriticalPath,
  type WorkItemDependencyEndpoint,
  type WorkItemSchedule,
  type WorkItemScheduleDependency,
  type WorkItemScheduleDependencyConflict,
  resolvePlanningUpdateReviewerMemberKey,
} from '@mukuroji/contracts'
import {
  createPlanningCycleScheduleRecordKey,
  createPlanningCycleScheduleShard,
} from './cycle-schedule-index'
import {
  createPlanningUpdateNextNotificationAtRecordKey,
  createPlanningUpdateScheduleShard,
  PLANNING_UPDATE_SCHEDULE_DUE_INDEX_NAME,
} from './planning-update-schedule-index'
import {
  bindPlanningRevisionFenceBarrierDocumentClient,
} from '../../infrastructure/runtime/planning-revision-fence-barrier'
import { advancePlanningUpdateActivity, readPlanningUpdateActivity, type PlanningUpdateActivity, type PlanningUpdateActivityKind } from './planning-update-activity'
import { loadServerConfig } from '../../infrastructure/config/server-config'

const META_RECORD_KEY = 'META'
const META_WORKSPACE_KEY_PREFIX = 'FENCE#'
const ENTITY_RECORD_PREFIX = 'ENTITY#'
const DEPENDENCY_RECORD_PREFIX = 'DEPENDENCY#'
const WORK_ITEM_DEPENDENCY_RECORD_PREFIX = 'WORK_ITEM_DEPENDENCY#'
const LINK_RECORD_PREFIX = 'LINK#'
const UPDATE_TARGET_RECORD_PREFIX = 'UPDATE_TARGET#'
const UPDATE_ACTIVITY_RECORD_PREFIX = 'UPDATE_ACTIVITY#'
const UPDATE_RECORD_PREFIX = 'UPDATE#'
const UPDATE_ID_RECORD_PREFIX = 'UPDATE_ID#'
const UPDATE_COMMENT_RECORD_PREFIX = 'UPDATE_COMMENT#'
const UPDATE_COMMENT_ID_RECORD_PREFIX = 'UPDATE_COMMENT_ID#'
const UPDATE_REACTION_RECORD_PREFIX = 'UPDATE_REACTION#'
const UPDATE_ACKNOWLEDGEMENT_RECORD_PREFIX = 'UPDATE_ACK#'
/**
 * Archived entities that left the live graph. No live graph prefix is a prefix of it, so live
 * reads never return these rows and they never count toward the live capacity.
 */
const ARCHIVED_ENTITY_RECORD_PREFIX = 'ARCHIVE_ENTITY#'
/** Dependencies and Work Item link references kept with an archived entity until it is restored. */
const ARCHIVED_REFERENCE_RECORD_PREFIX = 'ARCHIVE_REF#'
const PLANNING_ARCHIVE_SCHEMA_VERSION = 1
/**
 * Transaction items one archive or restore revision may write besides META. Each revision keeps
 * the live graph valid, so a large Cycle moves in several small revisions.
 */
const PLANNING_ARCHIVE_STEP_ITEM_BUDGET = 90
/**
 * Serialized bytes one archive or restore step may write, leaving headroom under
 * `MAX_PLANNING_TRANSACTION_BYTES` for the META fence, conditions and request envelope.
 */
const PLANNING_ARCHIVE_STEP_BYTE_BUDGET = 2_000_000
/** Archive or restore revisions one request commits before it leaves the rest for a later request. */
const PLANNING_ARCHIVE_REQUEST_STEP_LIMIT = 40
/** Attempts per archive or restore revision when a concurrent mutation advances META first. */
const PLANNING_ARCHIVE_STEP_ATTEMPTS = 3
/** Maximum archived entities returned by one archive list page. */
const PLANNING_ARCHIVE_PAGE_LIMIT = 50
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
/**
 * Maximum live graph rows (excluding META) that a row-adding mutation may reach.
 * Mutations that do not add rows stay allowed above it so operators can always shrink the graph.
 */
const PLANNING_LIVE_ROW_CAPACITY = 20_000
/** Live graph row count at which the snapshot reports a `warning` capacity level. */
const PLANNING_LIVE_ROW_WARNING_COUNT = 16_000
/** Maximum UTF-8 JSON bytes of live graph rows that a growing mutation may reach. */
const PLANNING_LIVE_GRAPH_BYTE_CAPACITY = 24_000_000
/** Live graph bytes at which the snapshot reports a `warning` capacity level. */
const PLANNING_LIVE_GRAPH_WARNING_BYTES = 19_200_000
/**
 * Maximum Project / Initiative update targets. Update Feed projections and the per-target
 * activity read are bounded to the same count.
 */
const PLANNING_UPDATE_TARGET_CAPACITY = 2_000
/** Hard safety bound for one strongly consistent live graph read, above the write capacity. */
const PLANNING_LIVE_ROW_READ_LIMIT = 25_000
/** Hard safety bound, in UTF-8 JSON bytes, for the rows of one live graph read. */
const PLANNING_LIVE_GRAPH_READ_BYTE_LIMIT = 32_000_000
/** Maximum compact update activity rows read for one Workspace. */
const PLANNING_UPDATE_ACTIVITY_READ_LIMIT = 2_000
/** Maximum number of Workspaces whose live graph one client keeps in its revision cache. */
const PLANNING_STATE_CACHE_LIMIT = 8
const TRANSACTION_ITEM_LIMIT = 100
const MAX_PLANNING_ROW_BYTES = 300_000
const MAX_PLANNING_TRANSACTION_BYTES = 3_000_000
const MAX_PLANNING_SNAPSHOT_BYTES = 4_000_000
const MAX_DESCRIPTION_BYTES = 20_000
const MAX_UPDATE_TEXT_BYTES = 8_000
const MAX_UPDATE_COMMENT_BYTES = 4_000
const MAX_UPDATE_REACTION_BYTES = 64
const MAX_UPDATE_EVIDENCE = 100
const MAX_UPDATE_HISTORY_PAGE_SIZE = 100
const DEFAULT_UPDATE_HISTORY_PAGE_SIZE = 25
const UPDATE_VERSION_WIDTH = 16
const MAX_REMINDER_HOURS = 24 * 365
const MAX_UPDATE_CADENCE_COUNT = 1_000
const MAX_ROLLOVER_LINK_MUTATIONS = CYCLE_ROLLOVER_BATCH_SIZE
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const planningTimeZoneFormatters = new Map<string, Intl.DateTimeFormat>()

/** Strongly read Planning revision metadata returned by either storage key. */
type PlanningMeta = {
  /** Monotonic revision shared by Planning and source projections. */
  revision: number
  /** Last mutation timestamp, when persisted. */
  updatedAt?: string
  /** Counters that tell Work Item advances apart from Planning structure commits. */
  revisionFence?: PlanningRevisionFence
}

/**
 * META counters that show which writers advanced the shared revision.
 *
 * Canonical Work Item writes add one to both `revision` and `sourceRevisionCount`. Every Planning
 * commit records its own revision and the source count it saw. When the revisions after that
 * commit equal the source advances after it, only Work Items changed the revision since then.
 * A writer that advances `revision` without the counter keeps the two apart, so an unknown
 * writer always counts as a Planning change.
 */
type PlanningRevisionFence = {
  /** Work Item advances counted on META since the counter was created. */
  sourceRevisionCount: number
  /** META revision written by the latest Planning commit, when one wrote the counters. */
  structureRevision?: number
  /** `sourceRevisionCount` at that Planning commit. */
  structureSourceRevisionCount?: number
}

/** Planning mutation attempts while only Work Item writes keep advancing the revision. */
const PLANNING_WORK_ITEM_REBASE_ATTEMPT_LIMIT = 3

/** Strong graph reads attempted while Work Item writes advance META during the read. */
const PLANNING_STABLE_READ_ATTEMPT_LIMIT = 3

/** Mutation options for Planning-only changes that Work Item edits must not block. */
const REBASE_OVER_WORK_ITEM_CHANGES: PlanningMutateOptions = { rebaseOverWorkItemChanges: true }

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
  /** Health transition and cadence recipients read from the state the publish committed against. */
  notification: PlanningUpdatePublishNotificationContext
}

/** Health transition and cadence recipients of one committed update publish. */
export type PlanningUpdatePublishNotificationContext = {
  /** Health of the previous update, or of the Initiative before its first update. */
  previousHealth?: PlanningHealth
  /** Whether the new health is at-risk or off-track and worse than the previous health. */
  healthDegraded: boolean
  /** Update owner of the cadence the publish covered. */
  updateOwnerMemberKey: string
  /** Escalation recipient of the cadence the publish covered, when configured. */
  escalationMemberKey?: string
  /** Reviewer of the cadence the publish covered, when configured. */
  reviewerMemberKey?: string
}

/** Severity order used to decide whether a health change is a degradation. */
const planningHealthSeverity: Record<PlanningHealth, number> = {
  unknown: 0,
  'on-track': 0,
  'at-risk': 1,
  'off-track': 2,
}

/**
 * Reports whether a newly published health is worse than the previous one and needs attention.
 *
 * @param previous - Health before the publish, when known.
 * @param next - Health of the new update.
 * @returns True when the new health is at-risk or off-track and more severe than before.
 */
export function isPlanningHealthDegraded(
  previous: PlanningHealth | undefined,
  next: PlanningHealth,
) {
  return planningHealthSeverity[next] > 0 &&
    planningHealthSeverity[next] > planningHealthSeverity[previous ?? 'unknown']
}

/** Minimal result exposed while preparing a durable Planning cadence receipt. */
export type PlanningUpdateCadenceTransactionResult = {
  /** Identifies a recurring update cadence mutation. */
  kind: 'cadence'
  /** Planning revision produced by the cadence mutation. */
  revision: number
  /** Complete target summary committed by the cadence mutation. */
  updateTarget: PlanningUpdateTargetSummary
}

/** Stored fields of one Planning entity, without values derived from linked Work Items. */
export type PlanningEntityTransactionSnapshot = Omit<
  PlanningEntity,
  'linkedWorkItemCount' | 'progress' | 'rollupHealth'
>

/** Lifecycle change of one Planning entity recorded by its audit event. */
export type PlanningEntityChangeAction =
  | 'created'
  | 'duplicated'
  | 'updated'
  | 'moved'
  | 'archived'
  | 'restored'

/** Minimal result exposed while preparing the audit event of one Planning entity change. */
export type PlanningEntityTransactionResult = {
  /** Identifies a Planning entity lifecycle change. */
  kind: 'entity'
  /** Planning revision produced by the change. */
  revision: number
  /** Lifecycle change committed by the mutation. */
  action: PlanningEntityChangeAction
  /** Entity value committed by the mutation. */
  entity: PlanningEntityTransactionSnapshot
  /** Entity value before the mutation; absent for a created or duplicated entity. */
  previous?: PlanningEntityTransactionSnapshot
  /** Entity copied by a duplication. */
  sourceEntityId?: string
  /** Cycle whose cadence created this Cycle as its next Cycle. */
  previousCycleId?: string
  /** Active descendants whose Team / Project scope followed a move. */
  movedDescendantCount?: number
}

/** Minimal Planning mutation result accepted by a durable receipt contribution. */
export type PlanningMutationTransactionResult =
  | PlanningWorkItemDependencyTransactionResult
  | PlanningUpdateAnnotationTransactionResult
  | PlanningUpdateCadenceTransactionResult
  | PlanningUpdatePublishTransactionResult
  | PlanningEntityTransactionResult

/** One external DynamoDB action prepared for the Planning mutation transaction. */
type PlanningMutationTransactionContribution = {
  /** Conditional receipt write committed after Planning row mutations. */
  transactWriteItem: NonNullable<TransactWriteCommandInput['TransactItems']>[number]
  /** Append-only audit outbox writes committed after the receipt, at most two. */
  additionalTransactWriteItems?: NonNullable<TransactWriteCommandInput['TransactItems']>
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
  /**
   * Whether `prepare` builds an independent contribution for each commit attempt, so the mutation
   * may still be rebased over canonical Work Item writes. Only an append-only audit write without a
   * durable receipt qualifies: a receipt is prepared for one exact revision. Such a transaction is
   * also skipped by a step that changes no entity, such as an intermediate Cycle rollover batch.
   */
  rebaseSafe?: boolean
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

/** Entity ID が確定した Planning entity 作成入力です。ID は呼び出し元が指定するか API が採番します。 */
export type PlanningEntityCreation = CreatePlanningEntityInput & {
  /** Workspace 内で一意な新しい entity ID です。 */
  id: string
}

/** 複製先 ID が確定した Planning entity 複製入力です。ID は呼び出し元が指定するか API が採番します。 */
export type PlanningEntityDuplication = DuplicatePlanningEntityInput & {
  /** Workspace 内で一意な複製後の entity ID です。 */
  targetId: string
}

/** Planning domain を読み書きする client contract です。 */
export type PlanningClient = {
  /** Reads bounded compact activity without scanning immutable updates or annotations.
   * @param workspaceId - Authenticated Workspace.
   * @returns Current target activity projections, requiring per-target authorization before use.
   */
  getUpdateActivities(workspaceId: string): Promise<PlanningUpdateActivity[]>
  /** Workspace planning snapshot を返します。 */
  get(workspaceId: string, workItemState: PlanningWorkItemState): Promise<PlanningSnapshot>
  /** 外部 authorization transaction を束縛する global revision を返します。 */
  getAuthorizationRevision(workspaceId: string): Promise<number>
  /**
   * Returns whether only canonical Work Item writes advanced the revision between two reads.
   *
   * @param workspaceId - Owning Workspace.
   * @param expectedRevision - Revision the caller read.
   * @param observedRevision - Newer revision read for authorization.
   * @returns True when the Planning graph is the same at both revisions.
   */
  isWorkItemOnlyRevisionAdvance(
    workspaceId: string,
    expectedRevision: number,
    observedRevision: number,
  ): Promise<boolean>
  /** 認可用に read-time filtering 前の Work Item link を返します。 */
  getWorkItemLinkForAuthorization(
    workspaceId: string,
    teamId: string,
    workItemId: string,
  ): Promise<PlanningWorkItemLink | undefined>
  /** Directory 破壊操作用に未フィルタ参照と同一 read の revision を返します。 */
  getAuthorizationState(workspaceId: string): Promise<PlanningAuthorizationState>
  /**
   * Planning entity を作成します。
   *
   * `authorizationConditionChecks` re-check the caller's authorization sources in the same
   * transaction as the write.
   */
  create(
    workspaceId: string,
    input: PlanningEntityCreation,
    workItemState: PlanningWorkItemState,
    transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>,
    authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
  ): Promise<PlanningMutationResponse>
  /** Planning entity の editable fields を更新します。 */
  update(
    workspaceId: string,
    entityId: string,
    input: UpdatePlanningEntityInput,
    workItemState: PlanningWorkItemState,
    transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>,
  ): Promise<PlanningMutationResponse>
  /**
   * Planning entity を archive し、archive 済み entity とその link 参照・dependency を live graph から
   * 退避します。退避は live graph を整合させたまま数十 row ずつ別 revision で進みます。
   */
  archive(
    workspaceId: string,
    entityId: string,
    input: PlanningRevisionInput,
    workItemState: PlanningWorkItemState,
    transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>,
  ): Promise<PlanningMutationResponse>
  /** 退避済み entity を active に戻し、戻せる link 参照と dependency を live graph へ戻します。 */
  restore(
    workspaceId: string,
    entityId: string,
    input: PlanningRevisionInput,
    workItemState: PlanningWorkItemState,
    options?: PlanningRestoreOptions,
  ): Promise<RestorePlanningEntityResponse>
  /** 退避済み entity を ID 順の cursor page で返します。呼び出し側が scope を認可します。 */
  listArchivedEntities(
    workspaceId: string,
    input: { limit?: number; cursor?: string },
  ): Promise<ArchivedPlanningEntityPage>
  /** 退避済み entity の summary を返します。退避されていなければ `undefined` です。 */
  getArchivedEntity(
    workspaceId: string,
    entityId: string,
  ): Promise<ArchivedPlanningEntitySummary | undefined>
  /** Planning entity を履歴・link・edge なしで複製します。 */
  duplicate(
    workspaceId: string,
    entityId: string,
    input: PlanningEntityDuplication,
    workItemState: PlanningWorkItemState,
    transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>,
  ): Promise<PlanningMutationResponse>
  /** Planning entity の hierarchy / Team / Project scope を移動します。 */
  move(
    workspaceId: string,
    entityId: string,
    input: MovePlanningEntityInput,
    workItemState: PlanningWorkItemState,
    transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>,
  ): Promise<PlanningMutationResponse>
  /** Project / Initiative update cadence を設定または解除します。 */
  configureUpdateCadence(
    workspaceId: string,
    input: ConfigurePlanningUpdateCadenceInput,
    workItemState: PlanningWorkItemState,
    authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
    transaction?: PlanningMutationTransaction<PlanningUpdateCadenceTransactionResult>,
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
    transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>,
  ): Promise<PlanningMutationResponse>
  /** Cadence に従って次の Cycle を作ります。 */
  createNextCycle(
    workspaceId: string,
    sourceCycleId: string,
    input: CreateNextCycleInput,
    workItemState: PlanningWorkItemState,
    transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>,
  ): Promise<PlanningMutationResponse & { cycleId: string }>
  /** 複数の Work Item を Cycle に入れる、または Cycle から外します。 */
  setCycleWorkItems(
    workspaceId: string,
    cycleId: string,
    input: CycleWorkItemsInput,
    workItemState: PlanningWorkItemState,
  ): Promise<PlanningMutationResponse>
  /** Cycle の自動化を1段階だけ進めます。 */
  runCycleAutomationStep(
    workspaceId: string,
    cycleId: string,
    loadWorkItems: CycleAutomationWorkItemLoader,
  ): Promise<CycleAutomationStepResult>
}

/**
 * Reads the canonical Work Items linked to a Cycle for an automation step.
 *
 * @param links - Live links of the Cycle being rolled over.
 * @returns Work Item projection that covers those links.
 */
export type CycleAutomationWorkItemLoader = (
  links: readonly PlanningWorkItemLink[],
) => Promise<PlanningWorkItemState>

/** Result of one Cycle automation step. */
export type CycleAutomationStepResult =
  | {
      /** Nothing is due for this Cycle now. */
      action: 'idle'
    }
  | {
      /** The next Cycle was created. */
      action: 'created-next'
      /** Created Cycle ID. */
      cycleId: string
    }
  | {
      /** One rollover batch was committed. */
      action: 'rolled-over'
      /** Moved Work Item count in this batch. */
      movedCount: number
      /** Incomplete Work Items still waiting in the source Cycle. */
      remainingWorkItemCount: number
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
  /** META counters read with `revision`, when the stored row has them. */
  revisionFence?: PlanningRevisionFence
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

/** How one Planning mutation treats a revision that moved after the caller's read. */
type PlanningMutateOptions = {
  /**
   * Accepts a caller revision that only canonical Work Item writes have advanced since, and
   * retries the commit when such a write lands first. Only for mutations whose result does not
   * depend on Work Item state, or that guard every Work Item they read with its own revision.
   */
  rebaseOverWorkItemChanges?: boolean
}

/** Mutation が返す rollover の追加情報です。 */
type PlanningMutationResult = {
  /** Mutation 後の state です。 */
  state: PlanningWorkspaceState
  /** Rollover で移動した Work Item IDs です。 */
  movedWorkItemIds?: string[]
  /** Rollover で元 Cycle に残した未完了 Work Item IDs です。 */
  retainedWorkItemIds?: string[]
  /** Rollover でまだ移動していない未完了 Work Item の件数です。 */
  remainingWorkItemCount?: number
  /** Planning commit と同じ transaction で検証する Work Item revisions です。 */
  workItemConditions?: PlanningWorkItemCondition[]
  /** Minimal Work Item dependency value used to prepare a durable completion receipt. */
  workItemDependencyTransactionSource?: PlanningWorkItemDependencyTransactionSource
  /** 同じ transaction で append-only 保存する structured update です。 */
  publishedUpdate?: PlanningUpdate
  /** Health transition and cadence recipients of the published update. */
  publishedUpdateNotification?: PlanningUpdatePublishNotificationContext
  /** Target whose summary is retained for a durable cadence receipt. */
  planningUpdateCadenceTransactionTarget?: PlanningUpdateTarget
  /** Archive rows written or removed in the same transaction as the live graph change. */
  archiveChanges?: PlanningArchiveChange[]
  /** Entity lifecycle change exposed to an audit contribution. */
  entityTransactionSource?: Omit<PlanningEntityTransactionResult, 'kind' | 'revision'>
}

/** One archive row write that commits with a Planning revision. */
type PlanningArchiveChange =
  | {
      /** Writes or replaces the row. */
      kind: 'put'
      /** Complete archive row, including its Workspace partition and sort key. */
      row: Record<string, unknown>
      /** Fails the transaction instead of replacing a row another archive already wrote. */
      requireAbsent?: boolean
    }
  | {
      /** Removes the row. */
      kind: 'delete'
      /** Sort key of the archive row in the Workspace partition. */
      recordKey: string
      /**
       * Fails the transaction when the row is already gone, so a reference consumed by a
       * concurrent restore is never applied twice.
       */
      requireExisting?: boolean
    }

/** Which field of a Work Item link pointed at an archived entity. */
type PlanningArchivedLinkReferenceKind = 'cycle' | 'milestone' | 'goal'

/** A Work Item link reference removed from the live graph together with its archived entity. */
type PlanningArchivedLinkReference = {
  /** Kind of archive reference row. */
  kind: 'link'
  /** Archived entity that owns this reference. */
  entityId: string
  /** Link field that pointed at the entity. */
  reference: PlanningArchivedLinkReferenceKind
  /** Link as it was when the reference was removed. */
  link: PlanningWorkItemLink
}

/** A dependency removed from the live graph together with one of its archived endpoints. */
type PlanningArchivedDependency = {
  /** Kind of archive reference row. */
  kind: 'dependency'
  /** Archived endpoint that owns this dependency until it is restored. */
  entityId: string
  /** Dependency as it was when it left the live graph. */
  dependency: PlanningDependency
}

/** Archive rows of one entity. */
type PlanningArchivedEntityBundle = {
  /** Archived entity row, absent when the entity is not in the archive. */
  entity?: StoredPlanningEntity
  /** Dependencies and link references owned by the entity. */
  references: (PlanningArchivedDependency | PlanningArchivedLinkReference)[]
}

/** Caller-specific checks a restore applies to the references it brings back. */
export type PlanningRestoreOptions = {
  /**
   * Whether the caller may manage an entity at its current scope. Checked for the restored entity
   * and each live dependency counterpart on every step; a denied counterpart's edge stays
   * archived, and a denied restored entity stops the restore.
   */
  canManageEntity?: (
    counterpart: Pick<PlanningEntity, 'id' | 'teamId' | 'projectId'>,
  ) => Promise<boolean>
  /** Whether the caller may write links of Work Items in this scope; denied links stay archived. */
  canRestoreLinkTo?: (workItem: { teamId: string; projectId?: string }) => Promise<boolean>
  /**
   * Caller authorization rows guarded by every restore revision, so a membership or Enterprise
   * control change during the restore stops it instead of letting later steps use the old grant.
   */
  authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[]
  /** Optional audit write committed with the revision that makes the entity active again. */
  transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>
}

/** One archive or restore revision planned against a fresh live graph. */
type PlanningArchiveStep = {
  /** Valid live graph after the step. */
  state: PlanningWorkspaceState
  /** Archive rows written with the step. */
  archiveChanges: PlanningArchiveChange[]
  /** Canonical Work Item revisions the step relies on. */
  workItemConditions?: PlanningWorkItemCondition[]
}

/** Storage 非依存の Planning mutation 実装です。 */
abstract class BasePlanningClient implements PlanningClient {
  /** Reads compact source-owned activity; callers must authorize targets before exposing signals. */
  abstract getUpdateActivities(workspaceId: string): Promise<PlanningUpdateActivity[]>
  /** Timestamp を生成する clock です。 */
  private readonly now: () => Date

  protected constructor(now: () => Date) {
    this.now = now
  }

  /**
   * Whether every canonical Work Item write advances this Planning META revision in its own
   * transaction, so the caller's expectedRevision CAS also detects a changed Work Item.
   *
   * @returns False unless the storage shares its META with the canonical Work Item writers.
   */
  protected workItemWritesAdvanceRevision() {
    return false
  }

  /** Workspace state を storage から読み込みます。 */
  protected abstract readState(workspaceId: string): Promise<PlanningWorkspaceState>

  /**
   * Strongly reads only the revision metadata, without the graph.
   *
   * @param workspaceId - Normalized Workspace identifier.
   * @returns The current revision and its Work Item counters.
   */
  protected abstract readRevisionMeta(workspaceId: string): Promise<PlanningMeta>

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
   * @param publishedUpdate - Optional immutable update appended in the same transaction.
   * @param archiveChanges - Archive rows written or removed in the same transaction.
   */
  protected abstract commitState(
    workspaceId: string,
    before: PlanningWorkspaceState,
    after: PlanningWorkspaceState,
    workItemConditions?: readonly PlanningWorkItemCondition[],
    authorizationConditionChecks?: readonly PlanningCallerAuthorizationConditionCheck[],
    transactionContribution?: PlanningMutationTransactionContribution,
    publishedUpdate?: PlanningUpdate,
    archiveChanges?: readonly PlanningArchiveChange[],
  ): Promise<void>

  /**
   * Reads the archive rows of one entity.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param entityId - Archived entity identifier.
   * @returns The archived entity, when present, and every reference it owns.
   */
  protected abstract readArchivedEntityBundle(
    workspaceId: string,
    entityId: string,
  ): Promise<PlanningArchivedEntityBundle>

  /**
   * Reads one archived entity row without its references.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param entityId - Archived entity identifier.
   * @returns The archived entity, or `undefined` when it is not in the archive.
   */
  protected abstract readArchivedEntity(
    workspaceId: string,
    entityId: string,
  ): Promise<StoredPlanningEntity | undefined>

  /**
   * Reads archived entities in ID order.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param limit - Maximum entities in the page.
   * @param afterEntityId - Exclusive ID the page starts after.
   * @returns The page and whether more entities follow it.
   */
  protected abstract readArchivedEntityPage(
    workspaceId: string,
    limit: number,
    afterEntityId?: string,
  ): Promise<{ entities: StoredPlanningEntity[]; hasMore: boolean }>

  /** Workspace planning snapshot を返します。 */
  async get(workspaceIdValue: string, workItemState: PlanningWorkItemState) {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const state = await this.readState(workspaceId)
    return createPlanningSnapshot(
      state,
      workItemState,
      this.now().toISOString(),
      createPlanningCapacity(measurePlanningLiveGraph(workspaceId, state)),
    )
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

  /**
   * Planning entity を作成します。
   *
   * @param workspaceId - Workspace directory identifier.
   * @param input - Entity to create, with the expected Planning revision.
   * @param workItemState - Canonical Work Item state for roll-ups.
   * @param transaction - Optional receipt or audit contribution.
   * @param authorizationConditionChecks - Caller authorization checks committed with the write.
   * @returns The Planning snapshot after the write.
   */
  async create(
    workspaceId: string,
    input: PlanningEntityCreation,
    workItemState: PlanningWorkItemState,
    transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
  ) {
    await this.requireIdNotArchived(workspaceId, input.id)
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
      if (findEntity(state, input.id)) {
        throw conflict('PlanningEntityExists', `Planning entity "${input.id}" already exists.`)
      }
      const entity = createStoredEntity(input, now)
      if (entity.parentId) requireActiveEntity(state, entity.parentId)
      const next = { ...state, entities: [...state.entities, entity] }
      validatePlanningState(next)
      return {
        state: next,
        entityTransactionSource: { action: 'created', entity: structuredClone(entity) },
      }
    }, authorizationConditionChecks, transaction, REBASE_OVER_WORK_ITEM_CHANGES)
  }

  /** Planning entity の editable fields を更新します。 */
  async update(
    workspaceId: string,
    entityId: string,
    input: UpdatePlanningEntityInput,
    workItemState: PlanningWorkItemState,
    transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>,
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
      if (patch.automation !== undefined) {
        const automation = patch.automation === null
          ? undefined
          : readCycleAutomation(patch.automation)
        if (automation === undefined) delete updated.automation
        else updated.automation = automation
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
      requireCycleChainCompatible(next, updated)
      return {
        state: next,
        entityTransactionSource: {
          action: 'updated',
          entity: structuredClone(updated),
          previous: structuredClone(current),
        },
      }
    }, [], transaction, REBASE_OVER_WORK_ITEM_CHANGES)
  }

  /**
   * Planning entity を archive し、archive 済み entity を live graph から退避します。
   *
   * Archive 自体は 1 revision で確定します。退避はその後の別 revision で進み、途中で失敗しても
   * archive は取り消さず、次の archive が続きを退避します。
   */
  async archive(
    workspaceId: string,
    entityId: string,
    input: PlanningRevisionInput,
    workItemState: PlanningWorkItemState,
    transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>,
  ) {
    const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    const current = await this.readState(normalizedWorkspaceId)
    const live = findEntity(current, entityId)
    let response: PlanningMutationResponse | undefined
    if (live?.archivedAt === undefined) {
      response = await this.archiveInLiveGraph(
        normalizedWorkspaceId,
        entityId,
        input,
        workItemState,
        transaction,
      )
    } else if (current.revision !== readRevision(input.expectedRevision)) {
      throw conflict('PlanningRevisionConflict', 'Planning changed. Reload and try again.')
    }
    // An entity archived earlier but still live resumes moving its rows out of the live graph.
    let compacted = false
    try {
      for (let step = 0; step < PLANNING_ARCHIVE_REQUEST_STEP_LIMIT; step += 1) {
        const committed = await this.commitArchiveStep(
          normalizedWorkspaceId,
          (state) => planArchiveCompactionStep(normalizedWorkspaceId, state),
          undefined,
        )
        if (!committed) break
        compacted = true
      }
    } catch (error) {
      // The archive revision is committed. Remaining rows move on the next archive request.
      if (!(error instanceof PlanningError) || error.status >= 500) console.error(error)
    }
    if (response && !compacted) return response
    try {
      return {
        movedWorkItemIds: [],
        retainedWorkItemIds: [],
        ...response,
        planning: await this.get(normalizedWorkspaceId, workItemState),
      }
    } catch (error) {
      if (response) return response
      throw error
    }
  }

  /**
   * 退避済み entity を active に戻し、戻せる link 参照と dependency を live graph に戻します。
   *
   * 最初の revision は呼び出し元の `expectedRevision` で entity を戻します。参照はその後の revision で
   * 数十件ずつ戻します。途中で止まった場合、同じ entity の復元を再実行すると続きを戻します。
   */
  async restore(
    workspaceIdValue: string,
    entityIdValue: string,
    input: PlanningRevisionInput,
    workItemState: PlanningWorkItemState,
    options: PlanningRestoreOptions = {},
  ): Promise<RestorePlanningEntityResponse> {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const entityId = readIdentifier(entityIdValue, 'Planning entity ID')
    const authorizationChecks = options.authorizationConditionChecks ?? []
    const bundle = await this.readArchivedEntityBundle(workspaceId, entityId)
    const archivedEntity = bundle.entity
    if (archivedEntity) {
      await this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
        const next = restoreArchivedEntity(state, archivedEntity, now)
        return {
          state: next,
          archiveChanges: [{
            kind: 'delete',
            recordKey: createArchivedEntityRecordKey(entityId),
            requireExisting: true,
          }],
          entityTransactionSource: createRestoredEntityTransactionSource(
            next,
            entityId,
            archivedEntity,
          ),
        }
      }, authorizationChecks, options.transaction)
    } else {
      const live = findEntity(await this.readState(workspaceId), entityId)
      if (!live) {
        throw notFound('PlanningArchivedEntityNotFound', 'Archived Planning entity was not found.')
      }
      if (live.archivedAt) {
        // Archived but still live: kept for its update target, kept for a live child, or not yet
        // moved out. Clearing the archive state restores it in place.
        await this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
          const next = unarchiveLiveEntity(state, entityId, now)
          return {
            state: next,
            entityTransactionSource: createRestoredEntityTransactionSource(
              next,
              entityId,
              findEntity(state, entityId),
            ),
          }
        }, authorizationChecks, options.transaction)
      }
    }
    const summary: PlanningRestoreSummary = {
      restoredLinkCount: 0,
      droppedLinkCount: 0,
      restoredDependencyCount: 0,
      retainedDependencyCount: 0,
      droppedDependencyCount: 0,
      pendingReferenceCount: 0,
    }
    // Only grows: an archived counterpart leaves the archive solely by becoming live again.
    const archivedCounterpartIds = new Set<string>()
    const workItems = createWorkItemMap(workItemState)
    const linkDecisions = new Map<string, boolean>()
    // A link whose Work Item the caller cannot see or write (or that no longer exists) stays
    // archived, so a restore by a caller with narrower Work Item access never discards it.
    const isRestorable = async (
      reference: PlanningArchivedDependency | PlanningArchivedLinkReference,
    ) => {
      if (reference.kind !== 'link') return true
      const summary = workItems.get(createWorkItemKey(reference.link.teamId, reference.link.workItemId))
      if (!summary) return false
      if (!options.canRestoreLinkTo) return true
      const scope = {
        teamId: reference.link.teamId,
        ...(summary.projectId === undefined ? {} : { projectId: summary.projectId }),
      }
      const scopeKey = JSON.stringify([scope.teamId, scope.projectId ?? null])
      let allowed = linkDecisions.get(scopeKey)
      if (allowed === undefined) {
        allowed = await options.canRestoreLinkTo(scope)
        linkDecisions.set(scopeKey, allowed)
      }
      return allowed
    }
    const scopeDecisions = new Map<string, boolean>()
    try {
      for (
        let step = 0;
        step < PLANNING_ARCHIVE_REQUEST_STEP_LIMIT && bundle.references.length > 0;
        step += 1
      ) {
        let planned: PlanningArchiveRestorePlan | undefined
        await this.commitArchiveStep(workspaceId, async (state, now) => {
          planned = undefined
          // A concurrent archive may have taken the entity out again; its references then stay
          // archived with it instead of being consumed against a missing target.
          const target = findEntity(state, entityId)
          if (!target || target.archivedAt !== undefined) return undefined
          // Keyed by scope, not ID: a counterpart moved to another scope is authorized again.
          const canManage = async (entity: StoredPlanningEntity) => {
            if (!options.canManageEntity) return true
            const scopeKey = JSON.stringify([entity.teamId ?? null, entity.projectId ?? null])
            let allowed = scopeDecisions.get(scopeKey)
            if (allowed === undefined) {
              allowed = await options.canManageEntity(entity)
              scopeDecisions.set(scopeKey, allowed)
            }
            return allowed
          }
          // The restored entity may have moved to a scope the caller does not manage.
          if (!await canManage(target)) return undefined
          // Read after the revision-bound graph, like the counterparts below: every archive row
          // change moves the revision, so a committed step consumed exactly the rows it read. A
          // reference restored, recreated and archived again by another request is planned from
          // its current row, never from the copy this request read first.
          const pending: (PlanningArchivedDependency | PlanningArchivedLinkReference)[] = []
          for (const reference of (await this.readArchivedEntityBundle(workspaceId, entityId)).references) {
            if (await isRestorable(reference)) pending.push(reference)
          }
          // Read after the revision-bound graph: a counterpart archived later moves the revision,
          // so the CAS rejects this step instead of dropping a dependency it could have kept.
          await this.collectArchivedCounterparts(
            workspaceId,
            state,
            entityId,
            pending,
            archivedCounterpartIds,
          )
          const deniedCounterpartIds = new Set<string>()
          for (const reference of pending) {
            if (reference.kind !== 'dependency') continue
            const counterpart = findEntity(state, reference.dependency.predecessorId === entityId
              ? reference.dependency.successorId
              : reference.dependency.predecessorId)
            if (counterpart && !await canManage(counterpart)) deniedCounterpartIds.add(counterpart.id)
          }
          // Edges kept for a counterpart the caller cannot manage are skipped before planning, so
          // they never take the budget of a step from the references that can still be restored.
          const plannable = pending.filter((reference) =>
            reference.kind !== 'dependency' ||
            !deniedCounterpartIds.has(reference.dependency.predecessorId === entityId
              ? reference.dependency.successorId
              : reference.dependency.predecessorId)
          )
          planned = planArchiveRestoreStep(workspaceId, state, entityId, plannable, {
            archivedCounterpartIds,
            deniedCounterpartIds,
            workItems,
            now,
          })
          // Only skipped references: nothing to commit, and no empty revision.
          return planned.step.archiveChanges.length === 0 ? undefined : planned.step
        }, workItemState, authorizationChecks)
        if (!planned) break
        summary.restoredLinkCount += planned.counts.restoredLinkCount
        summary.droppedLinkCount += planned.counts.droppedLinkCount
        summary.restoredDependencyCount += planned.counts.restoredDependencyCount
        summary.retainedDependencyCount += planned.counts.retainedDependencyCount
        summary.droppedDependencyCount += planned.counts.droppedDependencyCount
      }
    } catch (error) {
      if (!(error instanceof PlanningError) || error.status >= 500) throw error
      // A revoked grant fails the request: the snapshot would be filtered with the old grant.
      if (error.code === 'PlanningAuthorizationChanged') throw error
      // Capacity or a concurrent mutation stopped the restore; the rest stays in the archive.
    }
    // Re-read so references consumed by a concurrent restore are not reported as pending.
    summary.pendingReferenceCount =
      (await this.readArchivedEntityBundle(workspaceId, entityId)).references.length
    return { planning: await this.get(workspaceId, workItemState), restore: summary }
  }

  /** 退避済み entity を ID 順の cursor page で返します。 */
  async listArchivedEntities(
    workspaceIdValue: string,
    input: { limit?: number; cursor?: string },
  ): Promise<ArchivedPlanningEntityPage> {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const limit = input.limit === undefined ? PLANNING_ARCHIVE_PAGE_LIMIT : input.limit
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PLANNING_ARCHIVE_PAGE_LIMIT) {
      throw invalid('PlanningArchivePageLimitInvalid', 'Archived Planning page limit is invalid.')
    }
    const afterEntityId = input.cursor === undefined
      ? undefined
      : readArchivedEntityCursor(input.cursor)
    const page = await this.readArchivedEntityPage(workspaceId, limit, afterEntityId)
    const last = page.entities.at(-1)
    return {
      entities: page.entities.map(createArchivedEntitySummary),
      ...(page.hasMore && last ? { nextCursor: createArchivedEntityCursor(last.id) } : {}),
    }
  }

  /** 退避済み entity の summary を返します。 */
  async getArchivedEntity(workspaceIdValue: string, entityIdValue: string) {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const entityId = readIdentifier(entityIdValue, 'Planning entity ID')
    const entity = await this.readArchivedEntity(workspaceId, entityId)
    return entity ? createArchivedEntitySummary(entity) : undefined
  }

  /**
   * Rejects a new entity ID that an archived entity still owns, so the archived entity stays restorable.
   *
   * An ID enters the archive only from the live graph, where the same check already rejects it, so
   * reading the archive before the revision CAS cannot race with an archive of the same ID.
   *
   * @param workspaceIdValue - Owning Workspace identifier.
   * @param entityIdValue - Requested new entity ID.
   */
  private async requireIdNotArchived(workspaceIdValue: string, entityIdValue: unknown) {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const entityId = readIdentifier(entityIdValue, 'Planning entity ID')
    if (await this.readArchivedEntity(workspaceId, entityId)) {
      throw conflict(
        'PlanningEntityExists',
        `Planning entity "${entityId}" is archived. Restore it or choose another ID.`,
      )
    }
  }

  /**
   * Adds the dependency counterparts that are absent from the live graph but still archived.
   *
   * @param workspaceId - Normalized Workspace identifier.
   * @param state - Live graph the next restore step is planned against.
   * @param entityId - Entity being restored.
   * @param pending - Archived references not yet processed.
   * @param archivedCounterpartIds - Known archived counterparts; updated in place.
   */
  private async collectArchivedCounterparts(
    workspaceId: string,
    state: PlanningWorkspaceState,
    entityId: string,
    pending: readonly (PlanningArchivedDependency | PlanningArchivedLinkReference)[],
    archivedCounterpartIds: Set<string>,
  ) {
    const checked = new Set<string>()
    for (const reference of pending) {
      if (reference.kind !== 'dependency') continue
      const counterpartId = reference.dependency.predecessorId === entityId
        ? reference.dependency.successorId
        : reference.dependency.predecessorId
      if (
        checked.has(counterpartId) ||
        archivedCounterpartIds.has(counterpartId) ||
        findEntity(state, counterpartId)
      ) {
        continue
      }
      checked.add(counterpartId)
      if (await this.readArchivedEntity(workspaceId, counterpartId)) {
        archivedCounterpartIds.add(counterpartId)
      }
    }
  }

  /**
   * Commits one archive or restore revision planned against the current live graph.
   *
   * @param workspaceId - Normalized Workspace identifier.
   * @param plan - Pure planner; returns `undefined` when nothing is left to do.
   * @param growth - Work Items of a step that may grow the live graph; the step must then fit the
   * live capacity and the snapshot response limit. Omitted for steps that only shrink the graph.
   * @param authorizationConditionChecks - Caller authorization rows guarded by the revision.
   * @returns Whether a revision was committed.
   */
  private async commitArchiveStep(
    workspaceId: string,
    plan: (
      state: PlanningWorkspaceState,
      now: string,
    ) => PlanningArchiveStep | undefined | Promise<PlanningArchiveStep | undefined>,
    growth: PlanningWorkItemState | undefined,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
  ) {
    for (let attempt = 1; ; attempt += 1) {
      const before = await this.readState(workspaceId)
      const now = this.now().toISOString()
      const step = await plan(structuredClone(before), now)
      if (!step) return false
      validatePlanningState(step.state)
      if (growth) {
        const afterUsage = measurePlanningLiveGraph(workspaceId, step.state)
        requirePlanningLiveCapacity(
          before,
          measurePlanningLiveGraph(workspaceId, before),
          step.state,
          afterUsage,
        )
        // Like `mutate`, never commit a graph whose snapshot can no longer be returned.
        createPlanningSnapshot(
          { ...step.state, revision: before.revision + 1, updatedAt: now },
          growth,
          now,
          createPlanningCapacity(afterUsage),
        )
      }
      try {
        await this.commitState(
          workspaceId,
          before,
          { ...step.state, revision: before.revision + 1, updatedAt: now },
          step.workItemConditions ?? [],
          authorizationConditionChecks,
          undefined,
          undefined,
          step.archiveChanges,
        )
        return true
      } catch (error) {
        if (
          attempt < PLANNING_ARCHIVE_STEP_ATTEMPTS &&
          error instanceof PlanningError &&
          error.code === 'PlanningRevisionConflict'
        ) {
          continue
        }
        throw error
      }
    }
  }

  /** Planning entity を live graph の中で soft archive します。 */
  private async archiveInLiveGraph(
    workspaceId: string,
    entityId: string,
    input: PlanningRevisionInput,
    workItemState: PlanningWorkItemState,
    transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>,
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
      // Where every canonical Work Item write advances META, the caller's expectedRevision CAS
      // already fails if a linked Work Item changed after the caller's snapshot, so a Cycle with any
      // number of links fits one transaction. Elsewhere each linked Work Item is guarded itself.
      const guardEachWorkItem = !this.workItemWritesAdvanceRevision()
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
          if (guardEachWorkItem) {
            workItemConditions.push({
              teamId: link.teamId,
              workItemId: link.workItemId,
              revision: readRevision(summary.revision),
            })
          }
        }
      }
      const archived: StoredPlanningEntity = { ...current, archivedAt: now, updatedAt: now }
      let next = replaceEntity(state, archived)
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
      return {
        state: next,
        workItemConditions,
        entityTransactionSource: {
          action: 'archived',
          entity: structuredClone(archived),
          previous: structuredClone(current),
        },
      }
    }, [], transaction)
  }

  /** Planning entity を履歴・link・edge なしで複製します。 */
  async duplicate(
    workspaceId: string,
    entityId: string,
    input: PlanningEntityDuplication,
    workItemState: PlanningWorkItemState,
    transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>,
  ) {
    await this.requireIdNotArchived(workspaceId, input.targetId)
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
        createdAt: now,
        updatedAt: now,
      }
      delete copy.archivedAt
      delete copy.nextCycleId
      // Automation runs without the caller's permissions, so only a manager turns it on.
      delete copy.automation
      if (copy.parentId) requireActiveEntity(state, copy.parentId)
      const next = { ...state, entities: [...state.entities, copy] }
      validatePlanningState(next)
      return {
        state: next,
        entityTransactionSource: {
          action: 'duplicated',
          entity: structuredClone(copy),
          sourceEntityId: source.id,
        },
      }
    }, [], transaction, REBASE_OVER_WORK_ITEM_CHANGES)
  }

  /** Planning entity の hierarchy / Team / Project scope を移動します。 */
  async move(
    workspaceId: string,
    entityId: string,
    input: MovePlanningEntityInput,
    workItemState: PlanningWorkItemState,
    transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>,
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
      for (const entity of next.entities) {
        if (entity.id === current.id || descendantIds.has(entity.id)) requireCycleChainCompatible(next, entity)
      }
      return {
        state: next,
        entityTransactionSource: {
          action: 'moved',
          entity: structuredClone(moved),
          previous: structuredClone(current),
          movedDescendantCount: descendantIds.size,
        },
      }
    }, [], transaction, REBASE_OVER_WORK_ITEM_CHANGES)
  }

  /** Project / Initiative update cadence を設定または解除します。 */
  async configureUpdateCadence(
    workspaceId: string,
    input: ConfigurePlanningUpdateCadenceInput,
    workItemState: PlanningWorkItemState,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
    transaction?: PlanningMutationTransaction<PlanningUpdateCadenceTransactionResult>,
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
        return {
          state: replacePlanningUpdateTarget(state, updated),
          planningUpdateCadenceTransactionTarget: target,
        }
      },
      authorizationConditionChecks,
      transaction,
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
        const previousHealth = current.latestUpdate?.health ?? (
          target.type === 'initiative'
            ? requireActiveEntity(state, target.entityId).health
            : undefined
        )
        const publishedUpdateNotification: PlanningUpdatePublishNotificationContext = {
          ...(previousHealth ? { previousHealth } : {}),
          healthDegraded: isPlanningHealthDegraded(previousHealth, health),
          updateOwnerMemberKey: current.cadence.updateOwnerMemberKey,
          ...(current.cadence.escalationMemberKey
            ? { escalationMemberKey: current.cadence.escalationMemberKey }
            : {}),
          ...(resolvePlanningUpdateReviewerMemberKey(current.cadence)
            ? { reviewerMemberKey: resolvePlanningUpdateReviewerMemberKey(current.cadence) }
            : {}),
        }
        let next = replacePlanningUpdateTarget(state, updatedTarget)
        if (target.type === 'initiative') {
          const entity = requireActiveEntity(next, target.entityId)
          next = replaceEntity(next, { ...entity, health, risk, updatedAt: now })
        }
        return { state: next, publishedUpdate: update, publishedUpdateNotification }
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
      ...(readPlanningUpdateAcknowledgementFlag(input.acknowledgement)
        ? { acknowledgement: true as const }
        : {}),
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
    }, [], undefined, REBASE_OVER_WORK_ITEM_CHANGES)
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
    }, [], undefined, REBASE_OVER_WORK_ITEM_CHANGES)
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
        // The carry-over history describes how the Work Item reached its current Cycle.
        ...(current?.cycleId !== undefined && current.cycleId === input.cycleId
          ? readCarryOverHistory(current)
          : {}),
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
    }, [], undefined, REBASE_OVER_WORK_ITEM_CHANGES)
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

  /**
   * Cycle を完了し、policy に従って未完了 Work Item を rollover します。
   *
   * 1回で移動する link は {@link MAX_ROLLOVER_LINK_MUTATIONS} 件までです。残りがある間は元の Cycle を
   * 完了せず、残数を返します。同じ呼び出しを繰り返すと続きを移動し、最後の呼び出しで完了します。
   */
  async rolloverCycle(
    workspaceId: string,
    sourceCycleId: string,
    input: CycleRolloverInput,
    workItemState: PlanningWorkItemState,
    transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>,
  ) {
    // Where every canonical Work Item write advances META, the caller's expectedRevision CAS already
    // fails if a linked Work Item changed after the caller's snapshot. Elsewhere each Work Item the
    // step depends on is guarded itself.
    const guardEachWorkItem = !this.workItemWritesAdvanceRevision()
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
      const sourceLinks = state.workItemLinks
        .filter((link) => link.cycleId === source.id)
        .sort(comparePlanningWorkItemLinks)
      const incompleteLinks: PlanningWorkItemLink[] = []
      const conditionByKey = new Map<string, PlanningWorkItemCondition>()
      for (const link of sourceLinks) {
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
        conditionByKey.set(createWorkItemKey(link.teamId, link.workItemId), {
          teamId: link.teamId,
          workItemId: link.workItemId,
          revision: readRevision(summary.revision),
        })
        if (summary.statusCategory !== 'completed' && summary.statusCategory !== 'canceled') {
          incompleteLinks.push(link)
        }
      }
      const moving = source.carryOverPolicy === 'move-incomplete'
        ? incompleteLinks.slice(0, MAX_ROLLOVER_LINK_MUTATIONS)
        : []
      const remainingWorkItemCount = source.carryOverPolicy === 'move-incomplete'
        ? incompleteLinks.length - moving.length
        : 0
      const completesSource = remainingWorkItemCount === 0
      // The completing step relies on every source link's status, so it guards all of them; an
      // intermediate step only relies on the incomplete links it moves.
      const guardedLinks = completesSource ? sourceLinks : moving
      if (guardEachWorkItem && guardedLinks.length > MAX_ROLLOVER_LINK_MUTATIONS) {
        throw new PlanningError(
          413,
          'PlanningCycleRolloverLimitExceeded',
          `Cycle rollover cannot validate more than ${MAX_ROLLOVER_LINK_MUTATIONS} Work Items at once.`,
        )
      }
      const workItemConditions = guardEachWorkItem
        ? guardedLinks.map((link) => conditionByKey.get(createWorkItemKey(link.teamId, link.workItemId))!)
        : []
      const movingKeys = new Set(moving.map((link) => createWorkItemKey(link.teamId, link.workItemId)))
      const links = state.workItemLinks.map((link) =>
        movingKeys.has(createWorkItemKey(link.teamId, link.workItemId))
          ? { ...link, cycleId: target.id, carriedOverFromCycleId: source.id, carriedOverAt: now }
          : link
      )
      const retainedWorkItemIds = source.carryOverPolicy === 'move-incomplete'
        ? []
        : incompleteLinks.map((link) => link.workItemId)
      const nextSource: StoredPlanningEntity = completesSource
        ? { ...source, status: 'completed', updatedAt: now }
        : source
      const next = { ...replaceEntity(state, nextSource), workItemLinks: links }
      validateCycleCapacities(next)
      return {
        state: next,
        movedWorkItemIds: moving.map((link) => link.workItemId).sort(),
        retainedWorkItemIds: retainedWorkItemIds.sort(),
        remainingWorkItemCount,
        workItemConditions,
        ...(completesSource
          ? {
              entityTransactionSource: {
                action: 'updated' as const,
                entity: structuredClone(nextSource),
                previous: structuredClone(source),
              },
            }
          : {}),
      }
    }, [], transaction)
  }

  /** Cadence に従って次の Cycle を作り、元の Cycle に `nextCycleId` を記録します。 */
  async createNextCycle(
    workspaceId: string,
    sourceCycleId: string,
    input: CreateNextCycleInput,
    workItemState: PlanningWorkItemState,
    transaction?: PlanningMutationTransaction<PlanningEntityTransactionResult>,
  ) {
    const normalizedSourceId = readIdentifier(sourceCycleId, 'Cycle ID')
    const nextCycleId = createNextCycleId(normalizedSourceId)
    await this.requireIdNotArchived(workspaceId, nextCycleId)
    const response = await this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
      const source = requireActiveEntity(state, normalizedSourceId)
      if (source.type !== 'cycle' || !source.cadence) {
        throw invalid('PlanningCycleRequired', 'The next Cycle can be created only from a Cycle.')
      }
      if (source.status === 'canceled') {
        throw conflict('PlanningCycleCanceled', 'A canceled Cycle has no next Cycle.')
      }
      if (source.nextCycleId !== undefined) {
        throw conflict('PlanningCycleNextExists', 'The next Cycle has already been created.')
      }
      if (findEntity(state, nextCycleId)) {
        throw conflict('PlanningEntityExists', `Planning entity "${nextCycleId}" already exists.`)
      }
      const range = createNextCycleRange(source, source.cadence)
      const created: StoredPlanningEntity = {
        id: nextCycleId,
        type: 'cycle',
        title: createNextCycleTitle(source.title),
        ...(source.teamId === undefined ? {} : { teamId: source.teamId }),
        ...(source.projectId === undefined ? {} : { projectId: source.projectId }),
        ownerMemberKey: source.ownerMemberKey,
        status: 'planned',
        health: 'unknown',
        risk: 'none',
        progressMode: 'automatic',
        baseline: { ...range },
        forecast: { ...range },
        cadence: { ...source.cadence },
        ...(source.capacity === undefined ? {} : { capacity: source.capacity }),
        ...(source.carryOverPolicy === undefined ? {} : { carryOverPolicy: source.carryOverPolicy }),
        ...(source.automation === undefined ? {} : { automation: { ...source.automation } }),
        createdAt: now,
        updatedAt: now,
      }
      validateEntityFields(created)
      const next = {
        ...replaceEntity(state, { ...source, nextCycleId, updatedAt: now }),
      }
      next.entities = [...next.entities, created]
      validatePlanningState(next)
      return {
        state: next,
        entityTransactionSource: {
          action: 'created',
          entity: structuredClone(created),
          previousCycleId: source.id,
        },
      }
    }, [], transaction)
    return { ...response, cycleId: nextCycleId }
  }

  /** 複数の Work Item を1回で Cycle に入れる、または Cycle から外します。 */
  async setCycleWorkItems(
    workspaceId: string,
    cycleId: string,
    input: CycleWorkItemsInput,
    workItemState: PlanningWorkItemState,
  ) {
    const items = readCycleWorkItemReferences(input.workItems)
    if (input.action !== 'add' && input.action !== 'remove') {
      throw invalid('PlanningCycleWorkItemsActionInvalid', 'Cycle Work Item action must be add or remove.')
    }
    return this.mutate(workspaceId, input.expectedRevision, workItemState, (state, now) => {
      const cycle = requireActiveEntity(state, cycleId)
      if (cycle.type !== 'cycle') {
        throw invalid('PlanningCycleRequired', 'Work Items can be added only to a Cycle.')
      }
      if (input.action === 'add' && (cycle.status === 'completed' || cycle.status === 'canceled')) {
        throw conflict('PlanningEntityClosed', 'Completed or canceled Planning entities cannot receive links.')
      }
      const linksByKey = new Map(state.workItemLinks.map((link) =>
        [createWorkItemKey(link.teamId, link.workItemId), link] as const
      ))
      const workItemConditions: PlanningWorkItemCondition[] = []
      for (const item of items) {
        const summary = requireWorkItem(workItemState, item.teamId, item.workItemId)
        const key = createWorkItemKey(item.teamId, item.workItemId)
        const current = linksByKey.get(key)
        if (input.action === 'add') {
          if (current?.cycleId === cycle.id) continue
          if (current !== undefined && current.projectId !== summary.projectId) {
            throw conflict(
              'PlanningWorkItemProjectMismatch',
              'A linked Work Item changed Project. Re-link it before changing its Cycle.',
            )
          }
          const link: PlanningWorkItemLink = current === undefined
            ? {
                teamId: item.teamId,
                workItemId: item.workItemId,
                ...(summary.projectId === undefined ? {} : { projectId: summary.projectId }),
                cycleId: cycle.id,
                goalIds: [],
                createdAt: now,
              }
            : withoutCarryOverHistory({ ...current, cycleId: cycle.id })
          validateWorkItemLink(state, link)
          linksByKey.set(key, link)
        } else {
          if (current?.cycleId !== cycle.id) continue
          const link = withoutCarryOverHistory({ ...current })
          delete link.cycleId
          if (link.milestoneId === undefined && link.goalIds.length === 0) linksByKey.delete(key)
          else linksByKey.set(key, link)
        }
        workItemConditions.push({
          teamId: item.teamId,
          workItemId: item.workItemId,
          revision: readRevision(summary.revision),
        })
      }
      const next = { ...state, workItemLinks: [...linksByKey.values()] }
      validateCycleCapacities(next)
      return { state: next, workItemConditions }
    }, [], undefined, REBASE_OVER_WORK_ITEM_CHANGES)
  }

  /**
   * Cycle の自動化を1段階だけ進めます。
   *
   * 期日を過ぎていれば次の Cycle を作り、終了日を過ぎていれば rollover を1 batch だけ実行します。
   * 呼び出し元は `idle` が返るまで繰り返します。
   *
   * @param workspaceId - Owning Workspace.
   * @param cycleId - Cycle found through the schedule index.
   * @param loadWorkItems - Reads the canonical Work Items linked to the Cycle.
   * @returns What this step did.
   */
  async runCycleAutomationStep(
    workspaceId: string,
    cycleId: string,
    loadWorkItems: CycleAutomationWorkItemLoader,
  ): Promise<CycleAutomationStepResult> {
    const state = await this.readState(readIdentifier(workspaceId, 'Workspace ID'))
    const cycle = findEntity(state, cycleId)
    if (!cycle) return { action: 'idle' }
    const action = resolveDueCycleAutomation(cycle, state, this.now())
    if (action === undefined) return { action: 'idle' }
    if (action === 'create-next') {
      const response = await this.createNextCycle(
        workspaceId,
        cycle.id,
        { expectedRevision: state.revision },
        { workItems: [] },
      )
      return { action: 'created-next', cycleId: response.cycleId }
    }
    const links = state.workItemLinks.filter((link) => link.cycleId === cycle.id)
    const workItemState = await loadWorkItems(links)
    const response = await this.rolloverCycle(
      workspaceId,
      cycle.id,
      { targetCycleId: cycle.nextCycleId!, expectedRevision: state.revision },
      workItemState,
    )
    return {
      action: 'rolled-over',
      movedCount: response.movedWorkItemIds.length,
      remainingWorkItemCount: response.remainingWorkItemCount ?? 0,
    }
  }

  /**
   * Returns whether a caller's revision still describes the current Planning graph.
   *
   * The revision may be older than the current one when only canonical Work Item writes advanced
   * it since then. Mutations that do not depend on Work Item state accept such a revision.
   *
   * @param workspaceIdValue - Candidate Workspace identifier.
   * @param expectedRevisionValue - Planning revision the caller read.
   * @param observedRevisionValue - Newer revision the caller has just read and authorized against.
   * @returns True when Planning did not change between the two revisions.
   */
  async isWorkItemOnlyRevisionAdvance(
    workspaceIdValue: string,
    expectedRevisionValue: number,
    observedRevisionValue: number,
  ) {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const expectedRevision = readRevision(expectedRevisionValue)
    const observedRevision = readRevision(observedRevisionValue)
    if (expectedRevision === observedRevision) return true
    if (expectedRevision > observedRevision) return false
    const meta = await this.readRevisionMeta(workspaceId)
    return observedRevision <= meta.revision &&
      isWorkItemOnlyRevisionAdvance(meta, expectedRevision)
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
   * @param options - Whether the mutation may rebase over Work Item-only revision advances.
   * @returns The updated Planning snapshot and mutation metadata.
   */
  private async mutate(
    workspaceIdValue: string,
    expectedRevisionValue: number,
    workItemState: PlanningWorkItemState,
    mutation: (state: PlanningWorkspaceState, now: string) => PlanningMutationResult,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[] = [],
    transaction?: PlanningMutationTransaction<PlanningMutationTransactionResult>,
    options: PlanningMutateOptions = {},
  ) {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const expectedRevision = readRevision(expectedRevisionValue)
    // A durable receipt is prepared once for one exact revision, so it is never rebased.
    const rebase = options.rebaseOverWorkItemChanges === true &&
      (transaction === undefined || transaction.rebaseSafe === true)
    for (let attempt = 1; ; attempt += 1) {
      const before = await this.readState(workspaceId)
      if (
        before.revision !== expectedRevision &&
        !(rebase && isWorkItemOnlyRevisionAdvance(before, expectedRevision))
      ) {
        throw conflict('PlanningRevisionConflict', 'Planning changed. Reload and try again.')
      }
      try {
        return await this.commitMutation(
          workspaceId,
          before,
          workItemState,
          mutation,
          authorizationConditionChecks,
          transaction,
        )
      } catch (error) {
        // Another write landed between the read and the commit. Each attempt re-reads the graph
        // and is accepted again only if Planning itself is still unchanged since the caller's read.
        if (
          rebase &&
          attempt < PLANNING_WORK_ITEM_REBASE_ATTEMPT_LIMIT &&
          error instanceof PlanningError &&
          error.code === 'PlanningRevisionConflict'
        ) {
          continue
        }
        throw error
      }
    }
  }

  /**
   * Applies a domain mutation to one strongly read graph and commits it with a revision CAS.
   *
   * @param workspaceId - Normalized Workspace identifier.
   * @param before - Graph read for this attempt; its revision is the commit's CAS value.
   * @param workItemState - Canonical Work Item projection used by the mutation.
   * @param mutation - Pure state transition applied to a copy of `before`.
   * @param authorizationConditionChecks - Caller authorization rows guarded during persistence.
   * @param transaction - Optional durable completion receipt prepared before persistence.
   * @returns The updated Planning snapshot and mutation metadata.
   */
  private async commitMutation(
    workspaceId: string,
    before: PlanningWorkspaceState,
    workItemState: PlanningWorkItemState,
    mutation: (state: PlanningWorkspaceState, now: string) => PlanningMutationResult,
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[],
    transaction: PlanningMutationTransaction<PlanningMutationTransactionResult> | undefined,
  ) {
    const result = mutation(structuredClone(before), this.now().toISOString())
    validatePlanningState(result.state)
    const afterUsage = measurePlanningLiveGraph(workspaceId, result.state)
    requirePlanningLiveCapacity(
      before,
      measurePlanningLiveGraph(workspaceId, before),
      result.state,
      afterUsage,
    )
    const after = {
      ...result.state,
      revision: before.revision + 1,
      updatedAt: this.now().toISOString(),
    }
    const planning = createPlanningSnapshot(
      after,
      workItemState,
      this.now().toISOString(),
      createPlanningCapacity(afterUsage),
    )
    const cadenceTransactionTarget = result.planningUpdateCadenceTransactionTarget
    const cadenceTarget = cadenceTransactionTarget === undefined
      ? undefined
      : planning.updateTargets.find((candidate) =>
          planningUpdateTargetsEqual(
            candidate.target,
            cadenceTransactionTarget,
          )
        )
    if (cadenceTransactionTarget !== undefined && !cadenceTarget) {
      throw new PlanningError(
        503,
        'PlanningUpdateUnavailable',
        'Updated cadence target is unavailable.',
      )
    }
    const transactionResult: PlanningMutationTransactionResult | undefined =
      result.entityTransactionSource !== undefined
        ? { ...result.entityTransactionSource, kind: 'entity', revision: after.revision }
        : result.publishedUpdate === undefined
        ? cadenceTarget === undefined
          ? result.workItemDependencyTransactionSource === undefined
            ? undefined
            : {
                ...result.workItemDependencyTransactionSource,
                revision: after.revision,
                dependency: structuredClone(result.workItemDependencyTransactionSource.dependency),
              }
          : {
              kind: 'cadence',
              revision: after.revision,
              updateTarget: structuredClone(cadenceTarget),
            }
        : {
            kind: 'publish',
            revision: after.revision,
            update: structuredClone(result.publishedUpdate),
            notification: requirePublishedUpdateNotification(result.publishedUpdateNotification),
          }
    // An audit-only transaction has nothing to record for a step that changes no entity.
    const transactionContribution = transaction &&
        !(transactionResult === undefined && transaction.rebaseSafe === true)
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
      result.archiveChanges ?? [],
    )
    return {
      planning,
      movedWorkItemIds: result.movedWorkItemIds ?? [],
      retainedWorkItemIds: result.retainedWorkItemIds ?? [],
      ...(result.remainingWorkItemCount === undefined
        ? {}
        : { remainingWorkItemCount: result.remainingWorkItemCount }),
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
 * @returns Whether the value contains one receipt action and at most two audit Put actions.
 */
function isPlanningMutationTransactionContribution(
  value: unknown,
): value is PlanningMutationTransactionContribution {
  if (!isRecord(value)) return false
  const additional = value.additionalTransactWriteItems
  return isPlanningTransactWriteItem(value.transactWriteItem) && (
    additional === undefined ||
    Array.isArray(additional) && additional.length <= 2 &&
      additional.every((item) => isRecord(item) && isRecord(item.Put) && isPlanningTransactWriteItem(item))
  )
}

/**
 * Lists every DynamoDB action of an optional caller contribution in commit order.
 *
 * @param contribution - Validated caller contribution.
 * @returns The receipt write followed by its audit outbox writes.
 */
function planningTransactionContributionItems(
  contribution: PlanningMutationTransactionContribution | undefined,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  return contribution
    ? [contribution.transactWriteItem, ...(contribution.additionalTransactWriteItems ?? [])]
    : []
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
  /** Compact activity isolated by Workspace and qualified target. */
  private readonly updateActivities = new Map<string, PlanningUpdateActivity>()

  /** Returns copies of bounded compact activity without annotation history reads.
   * @param workspaceId - Owning Workspace.
   * @returns Current source-owned activity projections.
   */
  async getUpdateActivities(workspaceId: string): Promise<PlanningUpdateActivity[]> {
    const prefix = `${JSON.stringify(workspaceId)}:`
    const activities = [...this.updateActivities].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value))
    if (activities.length > PLANNING_UPDATE_ACTIVITY_READ_LIMIT) throw new PlanningError(413, 'PlanningActivityLimitExceeded', 'Planning activity exceeds the bounded read limit.')
    return activities
  }

  /** Records current-version activity in the same synchronous source mutation step. */
  private recordUpdateActivity(workspaceId: string, annotation: PlanningUpdateComment | PlanningUpdateReaction, kind: PlanningUpdateActivityKind) {
    const target = this.states.get(workspaceId)?.updateTargets.find((item) => planningUpdateTargetsEqual(item.target, annotation.target))
    if (!target || target.archivedAt || target.latestVersion !== annotation.updateVersion) return
    const key = `${JSON.stringify(workspaceId)}:${createPlanningUpdateTargetRecordSuffix(annotation.target)}`
    const actor = 'authorMemberKey' in annotation ? annotation.authorMemberKey : annotation.memberKey
    this.updateActivities.set(key, advancePlanningUpdateActivity(this.updateActivities.get(key), annotation.target, annotation.updateVersion, kind, actor, annotation.createdAt))
  }
  /** Workspace ID ごとの永続化 state です。 */
  private readonly states = new Map<string, PlanningWorkspaceState>()
  /** Workspace / target ごとの append-only update history です。 */
  private readonly updateHistories = new Map<string, PlanningUpdate[]>()
  /** Immutable update ごとの append-only comments です。 */
  private readonly updateComments = new Map<string, PlanningUpdateComment[]>()
  /** Immutable update ごとの member reactions です。 */
  private readonly updateReactions = new Map<string, PlanningUpdateReaction[]>()
  /** Workspace ごとの archive row です。DynamoDB と同じ row shape で保存します。 */
  private readonly archives = new Map<string, Map<string, Record<string, unknown>>>()

  constructor(now: () => Date = () => new Date()) {
    super(now)
  }

  /** In-memory archive から entity とその参照を返します。 */
  protected async readArchivedEntityBundle(
    workspaceId: string,
    entityId: string,
  ): Promise<PlanningArchivedEntityBundle> {
    const rows = this.archives.get(workspaceId) ?? new Map<string, Record<string, unknown>>()
    const entityRow = rows.get(createArchivedEntityRecordKey(entityId))
    const prefix = createArchivedReferenceRecordPrefix(entityId)
    return {
      ...(entityRow === undefined
        ? {}
        : { entity: readArchivedEntityRow(structuredClone(entityRow), workspaceId) }),
      references: [...rows.entries()]
        .filter(([recordKey]) => recordKey.startsWith(prefix))
        .sort(([first], [second]) => compareText(first, second))
        .map(([, row]) => readArchivedReferenceRow(structuredClone(row), workspaceId, entityId)),
    }
  }

  /** In-memory archive から entity row を返します。 */
  protected async readArchivedEntity(workspaceId: string, entityId: string) {
    const row = this.archives.get(workspaceId)?.get(createArchivedEntityRecordKey(entityId))
    return row === undefined ? undefined : readArchivedEntityRow(structuredClone(row), workspaceId)
  }

  /** In-memory archive の entity を record key 順に返します。 */
  protected async readArchivedEntityPage(
    workspaceId: string,
    limit: number,
    afterEntityId?: string,
  ) {
    const after = afterEntityId === undefined
      ? undefined
      : createArchivedEntityRecordKey(afterEntityId)
    const rows = [...(this.archives.get(workspaceId) ?? new Map<string, Record<string, unknown>>())]
      .filter(([recordKey]) =>
        recordKey.startsWith(ARCHIVED_ENTITY_RECORD_PREFIX) && (after === undefined || recordKey > after)
      )
      .sort(([first], [second]) => compareText(first, second))
    return {
      entities: rows.slice(0, limit).map(([, row]) =>
        readArchivedEntityRow(structuredClone(row), workspaceId)
      ),
      hasMore: rows.length > limit,
    }
  }

  /** In-memory state を返します。DynamoDB の revision cache と同じく、読み取り側は変更できません。 */
  protected async readState(workspaceId: string) {
    return deepFreeze(structuredClone(this.states.get(workspaceId) ?? createEmptyPlanningState()))
  }

  /**
   * Returns the in-memory revision and its Work Item counters.
   *
   * @param workspaceId - Normalized Workspace identifier.
   * @returns The current revision metadata.
   */
  protected async readRevisionMeta(workspaceId: string): Promise<PlanningMeta> {
    const state = this.states.get(workspaceId)
    return {
      revision: state?.revision ?? 0,
      ...(state?.revisionFence === undefined ? {} : { revisionFence: { ...state.revisionFence } }),
    }
  }

  /**
   * Advances the revision the way a canonical Work Item write advances the shared DynamoDB META.
   *
   * The in-memory Work Item clients do not share this store, so callers that model a Work Item
   * write against this client call it themselves.
   *
   * @param workspaceIdValue - Workspace whose Work Item changed.
   * @param updatedAt - Timestamp of the Work Item write.
   */
  recordWorkItemRevision(workspaceIdValue: string, updatedAt = new Date().toISOString()) {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const current = this.states.get(workspaceId) ?? createEmptyPlanningState()
    this.states.set(workspaceId, {
      ...structuredClone(current),
      revision: current.revision + 1,
      revisionFence: {
        ...current.revisionFence,
        sourceRevisionCount: (current.revisionFence?.sourceRevisionCount ?? 0) + 1,
      },
      updatedAt,
    })
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
    const updates = candidates.slice(0, limit).map((update) => {
      const copy = structuredClone(update)
      const acknowledgement = (this.updateComments.get(
        createPlanningUpdateAnnotationMapKey(workspaceId, target, update.version),
      ) ?? []).find((comment) => comment.acknowledgement)
      return acknowledgement
        ? {
            ...copy,
            acknowledgement: {
              memberKey: acknowledgement.authorMemberKey,
              commentId: acknowledgement.id,
              acknowledgedAt: acknowledgement.createdAt,
            },
          }
        : copy
    })
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
    if (comment.acknowledgement && comments.some((candidate) => candidate.acknowledgement)) {
      throw planningUpdateAlreadyAcknowledged()
    }
    this.updateComments.set(key, [...comments, structuredClone(comment)])
    this.recordUpdateActivity(workspaceId, comment, comment.acknowledgement ? 'acknowledgement' : 'comment')
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
    this.recordUpdateActivity(workspaceId, reaction, 'reaction')
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
    archiveChanges: readonly PlanningArchiveChange[] = [],
  ) {
    const current = this.states.get(workspaceId) ?? createEmptyPlanningState()
    if (current.revision !== before.revision) {
      throw conflict('PlanningRevisionConflict', 'Planning changed. Reload and try again.')
    }
    if (archiveChanges.some((change) =>
      change.kind === 'delete'
        ? change.requireExisting === true &&
          !this.archives.get(workspaceId)?.has(change.recordKey)
        : change.requireAbsent === true &&
          this.archives.get(workspaceId)?.has(String(change.row.recordKey)) === true
    )) {
      throw conflict(
        'PlanningArchiveChanged',
        'Archived Planning references changed. Run the restore again.',
      )
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
    if (archiveChanges.length > 0) {
      const archive = this.archives.get(workspaceId) ?? new Map<string, Record<string, unknown>>()
      for (const change of archiveChanges) {
        if (change.kind === 'put') {
          archive.set(String(change.row.recordKey), structuredClone(change.row))
        } else {
          archive.delete(change.recordKey)
        }
      }
      this.archives.set(workspaceId, archive)
    }
    this.states.set(workspaceId, {
      ...structuredClone(after),
      revisionFence: createCommittedRevisionFence({
        ...after,
        // The CAS above proves no Work Item write landed since `before` was read.
        revisionFence: current.revisionFence,
      }),
    })
  }
}

/** DynamoDB の Planning table を利用する client です。 */
export class DynamoDbPlanningClient extends BasePlanningClient {
  /** Reads bounded activity projections with strict identity and pagination checks.
   * @param workspaceId - Authenticated owning Workspace.
   * @returns Compact activity without annotation/history reads.
   */
  async getUpdateActivities(workspaceId: string): Promise<PlanningUpdateActivity[]> {
    await this.ensureTable()
    const activities: PlanningUpdateActivity[] = []
    const identities = new Set<string>()
    let cursor: Record<string, unknown> | undefined
    let bytes = 0
    let pages = 0
    try {
      do {
        const response = await this.documentClient.send(new QueryCommand({ TableName: this.tableName, KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)', ExpressionAttributeValues: { ':workspaceId': workspaceId, ':prefix': UPDATE_ACTIVITY_RECORD_PREFIX }, ConsistentRead: true, Limit: PLANNING_UPDATE_ACTIVITY_READ_LIMIT + 1 - activities.length, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }))
        for (const row of response.Items ?? []) {
          const activity = readStoredPlanningUpdateActivity(row, workspaceId)
          const identity = createPlanningUpdateTargetRecordSuffix(activity.target)
          if (identities.has(identity)) throw persistenceInvalid('Duplicate activity projection.')
          identities.add(identity)
          activities.push(activity)
          bytes += Buffer.byteLength(JSON.stringify(row), 'utf8')
        }
        cursor = response.LastEvaluatedKey
        pages += 1
        if (activities.length > PLANNING_UPDATE_ACTIVITY_READ_LIMIT || bytes > MAX_PLANNING_SNAPSHOT_BYTES || cursor && (pages >= 20 || !response.Items?.length)) throw new PlanningError(413, 'PlanningActivityLimitExceeded', 'Planning activity exceeds the bounded read limit.')
      } while (cursor)
      return activities
    } catch (error) { throw toPersistenceError(error) }
  }

  /** Prepares a fenced compact activity write without overwriting the canonical target. */
  private async prepareUpdateActivity(workspaceId: string, target: PlanningUpdateTarget, version: number, activity: { /** Added annotation kind. */ kind: PlanningUpdateActivityKind; /** Server-resolved actor. */ memberKey: string; /** Source timestamp. */ at: string }): Promise<NonNullable<TransactWriteCommandInput['TransactItems']>> {
    const targetKey = createPlanningUpdateTargetRecordKey(target)
    const recordKey = `${UPDATE_ACTIVITY_RECORD_PREFIX}${createPlanningUpdateTargetRecordSuffix(target)}`
    const source = await this.documentClient.send(new GetCommand({ TableName: this.tableName, Key: { workspaceId, recordKey: targetKey }, ConsistentRead: true }))
    if (!source.Item) return []
    if (source.Item.workspaceId !== workspaceId || source.Item.entryType !== 'planning-update-target') throw persistenceInvalid('Invalid activity source target.')
    let current: StoredPlanningUpdateTarget
    try { current = readStoredPlanningUpdateTarget(source.Item) } catch { throw persistenceInvalid('Invalid activity source target.') }
    if (!planningUpdateTargetsEqual(current.target, target)) throw persistenceInvalid('Mismatched activity source target.')
    if (current.latestVersion !== version || current.archivedAt) return []
    const stored = await this.documentClient.send(new GetCommand({ TableName: this.tableName, Key: { workspaceId, recordKey }, ConsistentRead: true }))
    if (stored.Item && stored.Item.recordKey !== recordKey) throw persistenceInvalid('Mismatched activity identity.')
    const previous = stored.Item === undefined ? undefined : readStoredPlanningUpdateActivity(stored.Item, workspaceId)
    const next = advancePlanningUpdateActivity(previous, target, version, activity.kind, activity.memberKey, activity.at)
    return [{ ConditionCheck: { TableName: this.tableName, Key: { workspaceId, recordKey: targetKey }, ConditionExpression: '#version = :version AND #type = :type AND attribute_not_exists(archivedAt)', ExpressionAttributeNames: { '#version': 'latestVersion', '#type': 'entryType' }, ExpressionAttributeValues: { ':version': version, ':type': 'planning-update-target' } } }, { Put: { TableName: this.tableName, Item: { workspaceId, recordKey, entryType: 'planning-update-activity', schemaVersion: 1, ...next }, ConditionExpression: previous ? '#revision = :revision AND #schema = :schema AND #type = :type' : 'attribute_not_exists(recordKey)', ...(previous ? { ExpressionAttributeNames: { '#revision': 'revision', '#schema': 'schemaVersion', '#type': 'entryType' }, ExpressionAttributeValues: { ':revision': previous.revision, ':schema': 1, ':type': 'planning-update-activity' } } : {}) } }]
  }
  /** Planning rows を保存する DynamoDB table 名です。 */
  private readonly tableName: string
  /** Canonical Work Item rows を条件検証する DynamoDB table 名です。 */
  private readonly workItemsTableName: string
  /** DynamoDB DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Local bootstrap 用の低レベル DynamoDB client です。 */
  private readonly dynamoDbClient: DynamoDBClient
  /**
   * Graphs decoded at one META revision, without `UPDATE_TARGET#` rows, in LRU order.
   * Values are deeply frozen so no reader can change a graph shared across requests.
   */
  private readonly graphCache = new Map<string, PlanningWorkspaceState>()
  /** Local table の自動作成を有効にするかどうかです。 */
  private readonly bootstrapLocalTable: boolean
  /** Whether canonical Work Item writes advance this table's META revision. */
  private readonly sharesRevisionWithWorkItems: boolean

  constructor(
    tableName = loadServerConfig().environment.PLANNING_TABLE_NAME ?? 'mukuroji-planning-local',
    documentClient = createDocumentClient(),
    dynamoDbClient = createDynamoDbClient(),
    bootstrapLocalTable = Boolean(getDynamoDbEndpoint()),
    now: () => Date = () => new Date(),
    workItemsTableName = loadServerConfig().environment.WORK_ITEMS_TABLE_NAME ??
      'mukuroji-team-issues-local',
    // The canonical Work Item client advances Planning META only when PLANNING_TABLE_NAME is set.
    sharesRevisionWithWorkItems = Boolean(loadServerConfig().environment.PLANNING_TABLE_NAME?.trim()),
  ) {
    super(now)
    this.tableName = tableName
    this.workItemsTableName = workItemsTableName
    this.documentClient = documentClient
    this.dynamoDbClient = dynamoDbClient
    this.bootstrapLocalTable = bootstrapLocalTable
    this.sharesRevisionWithWorkItems = sharesRevisionWithWorkItems
  }

  /**
   * Returns whether the deployed Work Item writers advance this table's META revision.
   *
   * @returns True when the Planning table name is configured, so Work Item writers share this META.
   */
  protected override workItemWritesAdvanceRevision() {
    return this.sharesRevisionWithWorkItems
  }

  /**
   * Reads the Workspace graph that belongs to one stable META revision.
   *
   * Graph rows other than `UPDATE_TARGET#` are written only by `commitState`, in the same
   * transaction as the META revision CAS, so a decoded graph is reused while the strongly read
   * META revision and timestamp are unchanged. `UPDATE_TARGET#` rows are always re-read because
   * the notification schedule advances their due-index attributes without a META write.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @returns The live graph state at one stable revision.
   */
  protected async readState(workspaceId: string) {
    await this.ensureTable()
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.readStableState(workspaceId)
      } catch (error) {
        // Canonical Work Item writes advance META at any time; a read retries past them.
        if (
          attempt < PLANNING_STABLE_READ_ATTEMPT_LIMIT &&
          error instanceof PlanningError &&
          error.code === 'PlanningRevisionConflict'
        ) {
          continue
        }
        throw error
      }
    }
  }

  /**
   * Strongly reads META, then the graph rows, then META again.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @returns The live graph state at one stable revision.
   */
  private async readStableState(workspaceId: string) {
    const before = await this.readMeta(workspaceId)
    const cached = this.readCachedGraph(workspaceId, before)
    const items = await this.queryLiveGraphRows(
      workspaceId,
      cached === undefined
        ? PLANNING_GRAPH_ROW_QUERIES
        : PLANNING_GRAPH_ROW_QUERIES.filter(({ recordPrefix }) =>
            recordPrefix === UPDATE_TARGET_RECORD_PREFIX
          ),
    )
    const after = await this.readMeta(workspaceId)
    if (before.revision !== after.revision) {
      throw conflict('PlanningRevisionConflict', 'Planning changed while it was being read.')
    }
    if (before.revision === 0 && items.some((item) => item.recordKey !== META_RECORD_KEY)) {
      throw persistenceInvalid('Planning rows exist without metadata.')
    }
    if (cached !== undefined) return readPlanningUpdateTargetRows(items, cached, workspaceId)
    const state = readPlanningRows(items, before, workspaceId)
    this.storeCachedGraph(workspaceId, state)
    return state
  }

  /**
   * Strongly queries the requested live graph prefixes with hard row and byte bounds.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param queries - Graph prefixes and their expected entry types.
   * @returns Every row under the requested prefixes.
   */
  private async queryLiveGraphRows(
    workspaceId: string,
    queries: readonly (typeof PLANNING_GRAPH_ROW_QUERIES)[number][],
  ) {
    const items: Record<string, unknown>[] = []
    let bytes = 0
    for (const { recordPrefix, entryType } of queries) {
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
          Limit: PLANNING_LIVE_ROW_READ_LIMIT + 1 - items.length,
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
        for (const item of pageItems) bytes += utf8ByteLength(JSON.stringify(item))
        if (items.length > PLANNING_LIVE_ROW_READ_LIMIT || bytes > PLANNING_LIVE_GRAPH_READ_BYTE_LIMIT) {
          throw new PlanningError(
            413,
            'PlanningReadLimitExceeded',
            `Planning Workspace cannot be read beyond ${PLANNING_LIVE_ROW_READ_LIMIT} live rows.`,
          )
        }
        exclusiveStartKey = response.LastEvaluatedKey
        if (exclusiveStartKey !== undefined && pageItems.length === 0) {
          throw persistenceInvalid('Planning graph query returned an empty continuation page.')
        }
      } while (exclusiveStartKey)
    }
    return items
  }

  /**
   * Returns the cached graph only when it belongs to the strongly read META row.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param meta - META row read before the graph query.
   * @returns The cached frozen graph, or undefined on a miss.
   */
  private readCachedGraph(workspaceId: string, meta: PlanningMeta) {
    const cached = this.graphCache.get(workspaceId)
    if (
      cached === undefined ||
      meta.revision === 0 ||
      cached.revision !== meta.revision ||
      cached.updatedAt !== meta.updatedAt
    ) {
      return undefined
    }
    this.graphCache.delete(workspaceId)
    this.graphCache.set(workspaceId, cached)
    return cached
  }

  /**
   * Caches one decoded graph, evicting the least recently used Workspace beyond the bound.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param state - Fully validated graph decoded at one stable revision.
   */
  private storeCachedGraph(workspaceId: string, state: PlanningWorkspaceState) {
    if (state.revision === 0) return
    this.graphCache.delete(workspaceId)
    this.graphCache.set(workspaceId, deepFreeze(structuredClone({ ...state, updateTargets: [] })))
    while (this.graphCache.size > PLANNING_STATE_CACHE_LIMIT) {
      const oldest = this.graphCache.keys().next().value
      if (oldest === undefined) break
      this.graphCache.delete(oldest)
    }
  }

  /** Archive の entity row と、その entity が持つ参照 row を強整合で読みます。 */
  protected async readArchivedEntityBundle(
    workspaceId: string,
    entityId: string,
  ): Promise<PlanningArchivedEntityBundle> {
    await this.ensureTable()
    const entity = await this.readArchivedEntity(workspaceId, entityId)
    const prefix = createArchivedReferenceRecordPrefix(entityId)
    const references: PlanningArchivedEntityBundle['references'] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :recordPrefix)',
        ExpressionAttributeValues: { ':workspaceId': workspaceId, ':recordPrefix': prefix },
        ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
        ConsistentRead: true,
      }))
      const items = response.Items ?? []
      for (const item of items) {
        if (typeof item.recordKey !== 'string' || !item.recordKey.startsWith(prefix)) {
          throw persistenceInvalid('Archived Planning reference query returned an invalid row.')
        }
        references.push(readArchivedReferenceRow(item, workspaceId, entityId))
      }
      exclusiveStartKey = response.LastEvaluatedKey
      if (exclusiveStartKey !== undefined && items.length === 0) {
        throw persistenceInvalid('Archived Planning reference query returned an empty continuation page.')
      }
    } while (exclusiveStartKey)
    return { ...(entity === undefined ? {} : { entity }), references }
  }

  /** Archive の entity row を強整合で読みます。 */
  protected async readArchivedEntity(workspaceId: string, entityId: string) {
    await this.ensureTable()
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: createArchivedEntityRecordKey(entityId) },
      ConsistentRead: true,
    }))
    return response.Item === undefined
      ? undefined
      : readArchivedEntityRow(response.Item, workspaceId)
  }

  /** Archive の entity row を record key 順に 1 page 読みます。 */
  protected async readArchivedEntityPage(
    workspaceId: string,
    limit: number,
    afterEntityId?: string,
  ) {
    await this.ensureTable()
    const entities: StoredPlanningEntity[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined = afterEntityId === undefined
      ? undefined
      : { workspaceId, recordKey: createArchivedEntityRecordKey(afterEntityId) }
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :recordPrefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':recordPrefix': ARCHIVED_ENTITY_RECORD_PREFIX,
        },
        ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
        ConsistentRead: true,
        Limit: limit + 1 - entities.length,
      }))
      const items = response.Items ?? []
      for (const item of items) {
        if (
          typeof item.recordKey !== 'string' ||
          !item.recordKey.startsWith(ARCHIVED_ENTITY_RECORD_PREFIX)
        ) {
          throw persistenceInvalid('Archived Planning entity query returned an invalid row.')
        }
        entities.push(readArchivedEntityRow(item, workspaceId))
      }
      exclusiveStartKey = response.LastEvaluatedKey
      if (exclusiveStartKey !== undefined && items.length === 0) {
        throw persistenceInvalid('Archived Planning entity query returned an empty continuation page.')
      }
    } while (exclusiveStartKey && entities.length <= limit)
    return { entities: entities.slice(0, limit), hasMore: entities.length > limit }
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
      const pageUpdates = decoded.slice(0, limit)
      const acknowledgements = await this.readUpdateAcknowledgements(
        workspaceId,
        target,
        pageUpdates.map((update) => update.version),
      )
      const updates = pageUpdates.map((update) => {
        const acknowledgement = acknowledgements.get(update.version)
        return acknowledgement ? { ...update, acknowledgement } : update
      })
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

  /**
   * Reads the acknowledgement rows of one history page in a single bounded range query.
   *
   * @param workspaceId - Owning Workspace partition.
   * @param target - Canonical update target.
   * @param versions - Versions on the history page.
   * @returns Acknowledgements keyed by update version.
   */
  private async readUpdateAcknowledgements(
    workspaceId: string,
    target: PlanningUpdateTarget,
    versions: readonly number[],
  ): Promise<Map<number, PlanningUpdateAcknowledgement>> {
    const acknowledgements = new Map<number, PlanningUpdateAcknowledgement>()
    if (versions.length === 0) return acknowledgements
    const lowest = Math.min(...versions)
    const highest = Math.max(...versions)
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          'workspaceId = :workspaceId AND recordKey BETWEEN :lowest AND :highest',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':lowest': createPlanningUpdateAcknowledgementRecordKey(target, lowest),
          ':highest': createPlanningUpdateAcknowledgementRecordKey(target, highest),
        },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        ConsistentRead: true,
      }))
      for (const item of response.Items ?? []) {
        const { updateVersion, acknowledgement } = readStoredPlanningUpdateAcknowledgement(
          item,
          workspaceId,
          target,
        )
        acknowledgements.set(updateVersion, acknowledgement)
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return acknowledgements
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
      {
        kind: comment.acknowledgement ? 'acknowledgement' : 'comment',
        memberKey: comment.authorMemberKey,
        at: comment.createdAt,
      },
      comment.acknowledgement ? createPlanningUpdateAcknowledgementRow(workspaceId, comment) : undefined,
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
      { kind: 'reaction', memberKey: reaction.memberKey, at: reaction.createdAt },
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
          ...planningTransactionContributionItems(transactionContribution),
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
    activity?: { /** Added annotation kind. */ kind: PlanningUpdateActivityKind; /** Authenticated actor. */ memberKey: string; /** Source timestamp. */ at: string },
    acknowledgementRow?: Record<string, unknown>,
  ) {
    await this.ensureTable()
    const activityWrites = activity ? await this.prepareUpdateActivity(workspaceId, target, updateVersion, activity).catch((error: unknown) => { throw toPersistenceError(error) }) : []
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
          ...(acknowledgementRow === undefined
            ? []
            : [{
                Put: {
                  TableName: this.tableName,
                  Item: acknowledgementRow,
                  ConditionExpression:
                    'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
                },
              }]),
          ...activityWrites,
          ...planningTransactionContributionItems(transactionContribution),
        ],
      }))
    } catch (error) {
      if (activityWrites.length && isNamedError(error, 'TransactionCanceledException') && (!isRecord(error) || !Array.isArray(error.CancellationReasons) || error.CancellationReasons.length !== 2 + authorizationConditionChecks.length + (uniquenessRow ? 1 : 0) + (acknowledgementRow ? 1 : 0) + activityWrites.length + planningTransactionContributionItems(transactionContribution).length)) throw toPersistenceError(error)
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
      const acknowledgementIndex = rowIndex + 1
      if (acknowledgementRow !== undefined && isPlanningTransactionConditionalFailureAt(error, acknowledgementIndex)) {
        throw planningUpdateAlreadyAcknowledged()
      }
      const activityIndex = acknowledgementIndex + (acknowledgementRow === undefined ? 0 : 1)
      if (activityWrites.some((_, index) => isPlanningTransactionConditionalFailureAt(error, activityIndex + index))) throw conflict('PlanningUpdateActivityConflict', 'Update activity or the latest version changed. Retry with current authorization.')
      const transactionContributionIndex = activityIndex + activityWrites.length
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
    archiveChanges: readonly PlanningArchiveChange[] = [],
  ) {
    await this.ensureTable()
    const beforeRows = createPlanningRowMap(workspaceId, before)
    // The META CAS below proves no Work Item write advanced the counters since `before` was read.
    const afterRows = createPlanningRowMap(workspaceId, {
      ...after,
      revisionFence: before.revisionFence,
    })
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
    const guardedArchiveDeleteOffsets: number[] = []
    for (const change of archiveChanges) {
      if (change.kind === 'delete') {
        if (change.requireExisting) guardedArchiveDeleteOffsets.push(mutations.length)
        mutations.push({
          Delete: {
            TableName: this.tableName,
            Key: { workspaceId, recordKey: change.recordKey },
            ...(change.requireExisting
              ? { ConditionExpression: 'attribute_exists(recordKey)' }
              : {}),
          },
        })
        continue
      }
      if (change.row.workspaceId !== workspaceId) {
        throw persistenceInvalid('Planning archive row belongs to another Workspace.')
      }
      if (utf8ByteLength(JSON.stringify(change.row)) > MAX_PLANNING_ROW_BYTES) {
        throw new PlanningError(
          413,
          'PlanningRowSizeLimitExceeded',
          'A Planning archive row exceeds the safe DynamoDB item size limit.',
        )
      }
      if (change.requireAbsent) guardedArchiveDeleteOffsets.push(mutations.length)
      mutations.push({
        Put: {
          TableName: this.tableName,
          Item: change.row,
          ...(change.requireAbsent
            ? { ConditionExpression: 'attribute_not_exists(recordKey)' }
            : {}),
        },
      })
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
    const transactionContributionItems = planningTransactionContributionItems(transactionContribution)
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
          publishedUpdateItems.length + 2 >
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
      const mutationStartIndex =
        1 + canonicalConditions.length + authorizationConditionChecks.length
      if (guardedArchiveDeleteOffsets.some((offset) =>
        isPlanningTransactionConditionalFailureAt(error, mutationStartIndex + offset)
      )) {
        throw conflict(
          'PlanningArchiveChanged',
          'Archived Planning references changed. Run the restore again.',
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

  /**
   * Strongly reads the META row without the graph.
   *
   * @param workspaceId - Normalized Workspace identifier.
   * @returns The current revision metadata.
   */
  protected async readRevisionMeta(workspaceId: string) {
    await this.ensureTable()
    return this.readMeta(workspaceId)
  }

  /** Local DynamoDB 利用時だけ table を bootstrap します。 */
  private async ensureTable() {
    if (this.bootstrapLocalTable) {
      await ensureLocalPlanningTable(this.tableName, this.dynamoDbClient)
    }
  }

  /**
   * Strongly reads the META row in the isolated `FENCE#` revision partition.
   *
   * @param workspaceId - Workspace identifier whose revision is requested.
   * @returns The current Planning revision metadata, or revision 0 before the first write.
   */
  private async readMeta(workspaceId: string): Promise<PlanningMeta> {
    try {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: {
          workspaceId: `${META_WORKSPACE_KEY_PREFIX}${workspaceId}`,
          recordKey: META_RECORD_KEY,
        },
        ConsistentRead: true,
      }))
      return readPlanningMetaItem(response.Item) ?? { revision: 0 }
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
  if (value.type === 'team') {
    return {
      type: 'team',
      teamId: readIdentifier(value.teamId, 'Update target Team ID'),
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
  if (target.type === 'project') return `project\u0000${target.teamId}\u0000${target.projectId}`
  return target.type === 'team'
    ? `team\u0000${target.teamId}`
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
  const rawNextDueAt = readPlanningUpdateNextDueAt(value.nextDueAt)
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
    ...(value.reviewerMemberKey === undefined
      ? {}
      : { reviewerMemberKey: readOwnerMemberKey(value.reviewerMemberKey) }),
  }
}

/**
 * Validates a cadence deadline with an explicit timezone offset.
 *
 * @param value - Untrusted cadence deadline candidate.
 * @returns The original timestamp after offset validation.
 */
function readPlanningUpdateNextDueAt(value: unknown) {
  const timestamp = readTimestamp(value, 'Planning update next due timestamp')
  if (
    !/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp)
  ) {
    throw invalid(
      'PlanningUpdateCadenceInvalid',
      'Planning update next due timestamp must include an explicit timezone offset.',
    )
  }
  return timestamp
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
  const latestUpdate = target.latestUpdate === undefined
    ? undefined
    : {
        ...structuredClone(target.latestUpdate),
        ...(target.latestContextSnapshot === undefined
          ? {}
          : { capturedScope: structuredClone(target.latestContextSnapshot.scope) }),
      }
  return {
    target: structuredClone(target.target),
    ...(target.cadence === undefined ? {} : { cadence: structuredClone(target.cadence) }),
    updateState: createPlanningUpdateState(target, evaluatedAt),
    latestVersion: target.latestVersion,
    ...(latestUpdate === undefined ? {} : { latestUpdate }),
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
    capturedScope: structuredClone(update.contextSnapshot.scope),
  }
}

/**
 * Builds one validated stored Planning entity from create input.
 *
 * @param input - Untrusted entity create input.
 * @param now - Timestamp recorded as both creation and update time.
 * @returns The canonical stored entity.
 */
function createStoredEntity(input: PlanningEntityCreation, now: string): StoredPlanningEntity {
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
    ...optionalCycleAutomation(input.automation),
    ...(input.goalFramework === undefined
      ? {}
      : { goalFramework: readGoalFramework(input.goalFramework) }),
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
  validatePlanningUpdateTargets(state)
  validateCycleCapacities(state)
}

/**
 * Validates update target rows and their consistency with Initiative entities.
 *
 * @param state - Graph whose update targets are checked.
 */
function validatePlanningUpdateTargets(state: PlanningWorkspaceState) {
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
}

/**
 * Validates the field-level invariants of one stored Planning entity.
 *
 * @param entity - Stored entity candidate.
 */
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
    if (entity.automation !== undefined) readCycleAutomation(entity.automation)
    if (entity.nextCycleId !== undefined) {
      readIdentifier(entity.nextCycleId, 'Next Cycle ID')
      if (entity.nextCycleId === entity.id) {
        throw invalid('PlanningCycleNextInvalid', 'A Cycle cannot be its own next Cycle.')
      }
    }
  } else if (
    entity.cadence ||
    entity.capacity !== undefined ||
    entity.carryOverPolicy ||
    entity.automation !== undefined ||
    entity.nextCycleId !== undefined
  ) {
    throw invalid('PlanningCycleFieldsInvalid', 'Only Cycle entities can define cycle fields.')
  }
  if (entity.goalFramework !== undefined && entity.type !== 'goal') {
    throw invalid('PlanningGoalFrameworkInvalid', 'Only Goal entities can define goalFramework.')
  }
  if (entity.goalFramework !== undefined) readGoalFramework(entity.goalFramework)
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

/** Persisted size of a live graph, measured as the rows a commit writes. */
type PlanningLiveGraphUsage = {
  /** Live graph rows, excluding the revision META row. */
  rows: number
  /** UTF-8 JSON bytes of those rows, matching the accounting of a cold graph read. */
  bytes: number
}

/**
 * Measures the rows and bytes that a state persists, excluding the revision META row.
 *
 * @param workspaceId - Owning Workspace identifier included in every row.
 * @param state - Live Planning graph.
 * @returns Row count and UTF-8 JSON bytes of the persisted rows.
 */
function measurePlanningLiveGraph(
  workspaceId: string,
  state: PlanningWorkspaceState,
): PlanningLiveGraphUsage {
  let rows = 0
  let bytes = 0
  for (const [recordKey, row] of createPlanningRowMap(workspaceId, state)) {
    if (recordKey === META_RECORD_KEY) continue
    rows += 1
    bytes += Buffer.byteLength(JSON.stringify(row), 'utf8')
  }
  return { rows, bytes }
}

/**
 * Describes how much of the live graph capacity a measured graph uses.
 *
 * @param usage - Measured live graph rows and bytes.
 * @returns Row and byte usage, capacities, warning thresholds, and level.
 */
function createPlanningCapacity(usage: PlanningLiveGraphUsage): PlanningCapacity {
  return {
    level: usage.rows >= PLANNING_LIVE_ROW_CAPACITY ||
        usage.bytes >= PLANNING_LIVE_GRAPH_BYTE_CAPACITY
      ? 'full'
      : usage.rows >= PLANNING_LIVE_ROW_WARNING_COUNT ||
          usage.bytes >= PLANNING_LIVE_GRAPH_WARNING_BYTES
        ? 'warning'
        : 'normal',
    liveRowCount: usage.rows,
    liveRowCapacity: PLANNING_LIVE_ROW_CAPACITY,
    warningRowCount: PLANNING_LIVE_ROW_WARNING_COUNT,
    liveByteCount: usage.bytes,
    liveByteCapacity: PLANNING_LIVE_GRAPH_BYTE_CAPACITY,
    warningByteCount: PLANNING_LIVE_GRAPH_WARNING_BYTES,
  }
}

/**
 * Rejects a mutation that grows the live graph beyond its row, byte, or update target capacity.
 *
 * Mutations that do not grow the exceeded dimension stay allowed above the capacity, so a
 * Workspace can always be brought back under it by editing, unlinking, deleting, or moving data.
 * The byte capacity stays below the hard read bound, so a committed graph remains readable.
 *
 * @param before - Graph read for the mutation.
 * @param beforeUsage - Persisted size of `before`.
 * @param after - Validated graph the mutation would persist.
 * @param afterUsage - Persisted size of `after`.
 */
function requirePlanningLiveCapacity(
  before: PlanningWorkspaceState,
  beforeUsage: PlanningLiveGraphUsage,
  after: PlanningWorkspaceState,
  afterUsage: PlanningLiveGraphUsage,
) {
  if (
    afterUsage.rows > PLANNING_LIVE_ROW_CAPACITY && afterUsage.rows > beforeUsage.rows ||
    afterUsage.bytes > PLANNING_LIVE_GRAPH_BYTE_CAPACITY && afterUsage.bytes > beforeUsage.bytes
  ) {
    throw new PlanningError(
      413,
      'PlanningCapacityExceeded',
      `Planning Workspace cannot exceed ${PLANNING_LIVE_ROW_CAPACITY} live rows or ` +
        `${PLANNING_LIVE_GRAPH_BYTE_CAPACITY} bytes.`,
    )
  }
  if (
    after.updateTargets.length > PLANNING_UPDATE_TARGET_CAPACITY &&
    after.updateTargets.length > before.updateTargets.length
  ) {
    throw new PlanningError(
      413,
      'PlanningCapacityExceeded',
      `Planning Workspace cannot exceed ${PLANNING_UPDATE_TARGET_CAPACITY} update targets.`,
    )
  }
}

function createPlanningSnapshot(
  state: PlanningWorkspaceState,
  workItemState: PlanningWorkItemState,
  evaluatedAt: string,
  capacity: PlanningCapacity,
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
    capacity,
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
  if (target.type === 'team') return { teamId: target.teamId }
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
    affectedMilestoneIds: [...affectedMilestoneIds].sort(compareText),
  }
}

/**
 * Finds the conflicts of one schedule dependency between two Work Items.
 *
 * Creating a dependency is rejected while it has a conflict, so an import checks its dependencies
 * against the schedules it is about to create.
 *
 * @param dependency - Candidate dependency between the two Work Items.
 * @param predecessor - Predecessor summary; its identity must match the dependency.
 * @param successor - Successor summary; its identity must match the dependency.
 * @returns Conflicts of the dependency, empty when the schedules satisfy it.
 */
export function findWorkItemDependencyScheduleConflicts(
  dependency: WorkItemScheduleDependency,
  predecessor: PlanningWorkItemSummary,
  successor: PlanningWorkItemSummary,
): WorkItemScheduleDependencyConflict[] {
  return calculateWorkItemDependencyConflicts([dependency], new Map([
    [createWorkItemKey(predecessor.teamId, predecessor.id), predecessor],
    [createWorkItemKey(successor.teamId, successor.id), successor],
  ]))
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
  type: ScheduleDependencyType,
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
  type: ScheduleDependencyType,
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
  type: ScheduleDependencyType,
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
  type: ScheduleDependencyType,
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
    ...createCommittedRevisionFence(state),
  })
  for (const entity of state.entities) {
    const recordKey = createEntityRecordKey(entity.id)
    const cycleDueAt = resolveCycleAutomationDueAt(entity, state)
    rows.set(recordKey, {
      workspaceId,
      recordKey,
      entryType: 'planning-entity',
      ...entity,
      // Sparse due-index attributes let the Cycle schedule find due Cycles without a scan.
      ...(cycleDueAt === undefined
        ? {}
        : {
            updateScheduleShard: createPlanningCycleScheduleShard(workspaceId, recordKey),
            nextNotificationAtRecordKey: createPlanningCycleScheduleRecordKey(
              workspaceId,
              recordKey,
              cycleDueAt,
            ),
          }),
    })
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
  meta: PlanningMeta,
  workspaceId: string,
): PlanningWorkspaceState {
  const state: PlanningWorkspaceState = {
    revision: meta.revision,
    ...(meta.revisionFence === undefined ? {} : { revisionFence: { ...meta.revisionFence } }),
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
        row.entryType === 'planning-update-reaction' ||
        row.entryType === 'planning-update-acknowledgement'
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

/**
 * Combines freshly read `UPDATE_TARGET#` rows with a graph cached at the same META revision.
 *
 * @param rows - Untrusted update target rows read between two matching META reads.
 * @param cached - Frozen graph decoded earlier at the same revision, without update targets.
 * @param workspaceId - Owning Workspace identifier.
 * @returns The current graph; cached collections stay frozen and must not be mutated.
 */
function readPlanningUpdateTargetRows(
  rows: readonly Record<string, unknown>[],
  cached: PlanningWorkspaceState,
  workspaceId: string,
): PlanningWorkspaceState {
  try {
    const updateTargets = rows.map((row) => {
      if (row.workspaceId !== workspaceId || row.entryType !== 'planning-update-target') {
        throw persistenceInvalid('Planning update target row is invalid.')
      }
      return readStoredPlanningUpdateTarget(row)
    })
    const state = { ...cached, updateTargets }
    validatePlanningUpdateTargets(state)
    return state
  } catch (error) {
    if (error instanceof PlanningError && error.code === 'InvalidPlanningData') throw error
    throw persistenceInvalid('Stored Planning data failed validation.')
  }
}

/**
 * Decodes one canonical ENTITY row.
 *
 * @param row - Untrusted DynamoDB row.
 * @returns Validated stored Planning entity.
 */
function readStoredPlanningEntity(row: Record<string, unknown>): StoredPlanningEntity {
  const id = readIdentifier(row.id, 'Planning entity ID')
  if (row.recordKey !== createEntityRecordKey(id)) {
    throw invalid('PlanningRecordKeyInvalid', 'Planning entity record key does not match its ID.')
  }
  const description = row.description === undefined
    ? undefined
    : readRequiredDescription(row.description)
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
    ...optionalCycleAutomation(row.automation),
    ...(row.nextCycleId === undefined
      ? {}
      : { nextCycleId: readIdentifier(row.nextCycleId, 'Next Cycle ID') }),
    ...(row.goalFramework === undefined
      ? {}
      : { goalFramework: readGoalFramework(row.goalFramework) }),
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

/** Strictly decodes one compact activity row and its Workspace/target identity. */
function readStoredPlanningUpdateActivity(row: Record<string, unknown>, workspaceId: string): PlanningUpdateActivity {
  const value = readPlanningUpdateActivity(row)
  if (!value || row.workspaceId !== workspaceId || row.entryType !== 'planning-update-activity' || row.schemaVersion !== 1 || row.recordKey !== `${UPDATE_ACTIVITY_RECORD_PREFIX}${createPlanningUpdateTargetRecordSuffix(value.target)}`) throw persistenceInvalid('Invalid Planning activity projection.')
  return value
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
  const capturedScope = value.capturedScope === undefined
    ? undefined
    : readPlanningUpdateScopeSnapshot(value.capturedScope, 'Latest update scope')
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
    ...(capturedScope === undefined ? {} : { capturedScope }),
  }
}

/**
 * Decodes a Team / Project scope stored with a bounded immutable update summary.
 *
 * @param value - Untrusted scope candidate.
 * @param label - Human-readable field name used in validation errors.
 * @returns Validated Planning update scope.
 */
function readPlanningUpdateScopeSnapshot(
  value: unknown,
  label: string,
): PlanningUpdateScopeSnapshot {
  if (!isRecord(value)) {
    throw invalid('PlanningUpdateContextInvalid', `${label} is invalid.`)
  }
  const scope = {
    ...(value.teamId === undefined
      ? {}
      : { teamId: readIdentifier(value.teamId, `${label} Team ID`) }),
    ...(value.projectId === undefined
      ? {}
      : { projectId: readIdentifier(value.projectId, `${label} Project ID`) }),
  }
  if (scope.projectId !== undefined && scope.teamId === undefined) {
    throw invalid('PlanningUpdateContextInvalid', `${label} Project ID requires a Team ID.`)
  }
  return scope
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
    ...readCarryOverHistory(row),
    createdAt: readTimestamp(row.createdAt, 'Work Item link timestamp'),
  }
}

/** Result of planning one restore revision, with what it did to each processed reference. */
type PlanningArchiveRestorePlan = {
  /** Revision to commit. */
  step: PlanningArchiveStep
  /** Per-outcome counts of the consumed references. */
  counts: Omit<PlanningRestoreSummary, 'pendingReferenceCount'>
}

/**
 * Returns the next archived entity whose rows may leave the live graph.
 *
 * An entity leaves only after its children, because an active or archived child in the live graph
 * still resolves its parent there. Initiatives with an update target stay live: their target row
 * and immutable update history are resolved through the live graph by notifications and the
 * Update Feed, and the target cap already bounds them.
 *
 * @param state - Current live graph.
 * @returns The archived entity with the smallest ID that can move, or `undefined`.
 */
function findCompactableArchivedEntity(state: PlanningWorkspaceState) {
  const parentIds = new Set(state.entities.flatMap((entity) =>
    entity.parentId === undefined ? [] : [entity.parentId]
  ))
  let candidate: StoredPlanningEntity | undefined
  for (const entity of state.entities) {
    if (entity.archivedAt === undefined || parentIds.has(entity.id)) continue
    if (
      entity.type === 'initiative' &&
      findStoredPlanningUpdateTarget(state, { type: 'initiative', entityId: entity.id })
    ) {
      continue
    }
    if (!candidate || entity.id < candidate.id) candidate = entity
  }
  return candidate
}

/**
 * Returns which field of a Work Item link points at an entity.
 *
 * @param link - Live Work Item link.
 * @param entityId - Entity identifier.
 * @returns The referencing field, or `undefined` when the link does not point at the entity.
 */
function readLinkReferenceKind(
  link: PlanningWorkItemLink,
  entityId: string,
): PlanningArchivedLinkReferenceKind | undefined {
  if (link.cycleId === entityId) return 'cycle'
  if (link.milestoneId === entityId) return 'milestone'
  if (link.goalIds.includes(entityId)) return 'goal'
  return undefined
}

/**
 * Removes one entity reference from a Work Item link.
 *
 * @param link - Live Work Item link.
 * @param reference - Field that points at the entity.
 * @param entityId - Entity identifier.
 * @returns The remaining link, or `undefined` when it no longer has a Cycle, Milestone, or Goal.
 */
function removeLinkReference(
  link: PlanningWorkItemLink,
  reference: PlanningArchivedLinkReferenceKind,
  entityId: string,
): PlanningWorkItemLink | undefined {
  const next: PlanningWorkItemLink = { ...link, goalIds: [...link.goalIds] }
  if (reference === 'cycle') delete next.cycleId
  else if (reference === 'milestone') delete next.milestoneId
  else next.goalIds = next.goalIds.filter((goalId) => goalId !== entityId)
  return next.cycleId === undefined && next.milestoneId === undefined && next.goalIds.length === 0
    ? undefined
    : next
}

/**
 * Plans one revision that moves archived rows out of the live graph.
 *
 * Dependencies and link references of the chosen entity move first, a bounded number per revision.
 * The entity row moves in the revision that leaves nothing in the live graph pointing at it, so
 * every intermediate revision passes {@link validatePlanningState}.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param state - Current live graph; not mutated.
 * @returns The next revision, or `undefined` when no archived entity can move.
 */
function planArchiveCompactionStep(
  workspaceId: string,
  state: PlanningWorkspaceState,
): PlanningArchiveStep | undefined {
  const entity = findCompactableArchivedEntity(state)
  if (!entity) return undefined
  let budget = PLANNING_ARCHIVE_STEP_ITEM_BUDGET
  let bytes = 0
  const archiveChanges: PlanningArchiveChange[] = []
  /** Whether a change of this many bytes still fits; the first change always does. */
  const fits = (cost: number) =>
    archiveChanges.length === 0 || bytes + cost <= PLANNING_ARCHIVE_STEP_BYTE_BUDGET
  const movedDependencyIds = new Set<string>()
  for (const dependency of state.dependencies) {
    if (budget < 2) break
    if (dependency.predecessorId !== entity.id && dependency.successorId !== entity.id) continue
    const row = createArchivedReferenceRow(workspaceId, {
      kind: 'dependency',
      entityId: entity.id,
      dependency,
    })
    const cost = estimateArchiveStepBytes(row)
    if (!fits(cost)) break
    archiveChanges.push({ kind: 'put', row })
    movedDependencyIds.add(dependency.id)
    budget -= 2
    bytes += cost
  }
  const dependencies = state.dependencies.filter((dependency) =>
    !movedDependencyIds.has(dependency.id)
  )
  const workItemLinks: PlanningWorkItemLink[] = []
  for (const link of state.workItemLinks) {
    const reference = readLinkReferenceKind(link, entity.id)
    if (reference === undefined || budget < 2) {
      workItemLinks.push(link)
      continue
    }
    const row = createArchivedReferenceRow(workspaceId, {
      kind: 'link',
      entityId: entity.id,
      reference,
      link,
    })
    const remaining = removeLinkReference(link, reference, entity.id)
    const cost = estimateArchiveStepBytes(row) + (remaining ? estimateArchiveStepBytes(remaining) : 0)
    if (!fits(cost)) {
      workItemLinks.push(link)
      continue
    }
    archiveChanges.push({ kind: 'put', row })
    budget -= 2
    bytes += cost
    if (remaining) workItemLinks.push(remaining)
  }
  const referenced = dependencies.some((dependency) =>
    dependency.predecessorId === entity.id || dependency.successorId === entity.id
  ) || workItemLinks.some((link) => readLinkReferenceKind(link, entity.id) !== undefined)
  let entities = state.entities
  const entityRow = createArchivedEntityRow(workspaceId, entity)
  if (!referenced && budget >= 2 && fits(estimateArchiveStepBytes(entityRow))) {
    entities = entities.filter((candidate) => candidate.id !== entity.id)
    archiveChanges.push({ kind: 'put', row: entityRow })
  }
  return { state: { ...state, entities, dependencies, workItemLinks }, archiveChanges }
}

/**
 * Describes a restore for the entity audit event.
 *
 * @param state - Live graph after the restore.
 * @param entityId - Restored entity.
 * @param previous - Archived entity value before the restore, when it was read.
 * @returns The restored entity change without its committed revision.
 * @throws PlanningError when the restored entity is missing from the graph.
 */
function createRestoredEntityTransactionSource(
  state: PlanningWorkspaceState,
  entityId: string,
  previous: StoredPlanningEntity | undefined,
): Omit<PlanningEntityTransactionResult, 'kind' | 'revision'> {
  const entity = findEntity(state, entityId)
  if (!entity) {
    throw new PlanningError(503, 'PlanningUnavailable', 'Restored Planning entity is unavailable.')
  }
  return {
    action: 'restored',
    entity: structuredClone(entity),
    ...(previous === undefined ? {} : { previous: structuredClone(previous) }),
  }
}

/**
 * Returns the live graph with an archived entity active again.
 *
 * @param state - Current live graph.
 * @param archived - Entity read from the archive.
 * @param now - Restore timestamp.
 * @returns The live graph with the entity added without `archivedAt`.
 */
function restoreArchivedEntity(
  state: PlanningWorkspaceState,
  archived: StoredPlanningEntity,
  now: string,
): PlanningWorkspaceState {
  if (findEntity(state, archived.id)) {
    throw conflict('PlanningEntityExists', `Planning entity "${archived.id}" already exists.`)
  }
  if (archived.parentId !== undefined) {
    const parent = findEntity(state, archived.parentId)
    if (!parent || parent.archivedAt) {
      throw conflict(
        'PlanningRestoreParentUnavailable',
        'Restore the parent Planning entity before this entity.',
      )
    }
  }
  const restored: StoredPlanningEntity = { ...structuredClone(archived), updatedAt: now }
  delete restored.archivedAt
  return { ...state, entities: [...state.entities, restored] }
}

/**
 * Returns the live graph with an archived entity that is still live made active again.
 *
 * @param state - Current live graph.
 * @param entityId - Archived live entity.
 * @param now - Restore timestamp.
 * @returns The live graph with `archivedAt` cleared on the entity and its update target.
 */
function unarchiveLiveEntity(
  state: PlanningWorkspaceState,
  entityId: string,
  now: string,
): PlanningWorkspaceState {
  const current = findEntity(state, entityId)
  if (!current?.archivedAt) {
    throw conflict('PlanningRevisionConflict', 'Planning changed. Reload and try again.')
  }
  if (current.parentId !== undefined) {
    const parent = findEntity(state, current.parentId)
    if (!parent || parent.archivedAt) {
      throw conflict(
        'PlanningRestoreParentUnavailable',
        'Restore the parent Planning entity before this entity.',
      )
    }
  }
  const restored: StoredPlanningEntity = { ...current, updatedAt: now }
  delete restored.archivedAt
  let next = replaceEntity(state, restored)
  if (current.type === 'initiative') {
    const target = findStoredPlanningUpdateTarget(next, { type: 'initiative', entityId })
    if (target?.archivedAt !== undefined) {
      const active: StoredPlanningUpdateTarget = { ...target, updatedAt: now }
      delete active.archivedAt
      // The schedule index is derived again from the cadence when the row is written.
      delete active.nextNotificationAtRecordKey
      next = replacePlanningUpdateTarget(next, active)
    }
  }
  return next
}

/**
 * Returns whether adding a dependency keeps the live dependency graph valid.
 *
 * @param state - Current live graph.
 * @param dependency - Candidate dependency whose endpoints are both live.
 * @returns Whether the dependency is new, not a duplicate edge, acyclic, and satisfies its constraint.
 */
function canRestoreDependency(state: PlanningWorkspaceState, dependency: PlanningDependency) {
  if (state.dependencies.some((candidate) =>
    candidate.id === dependency.id ||
    candidate.predecessorId === dependency.predecessorId &&
      candidate.successorId === dependency.successorId
  )) {
    return false
  }
  const successor = findEntity(state, dependency.successorId)
  if (!successor) return false
  if (dependency.constraint !== undefined) {
    try {
      requirePlanningDependencyConstraintIsSatisfied(successor, dependency.constraint)
    } catch {
      return false
    }
  }
  const adjacency = new Map<string, string[]>()
  for (const candidate of state.dependencies) {
    const targets = adjacency.get(candidate.predecessorId) ?? []
    targets.push(candidate.successorId)
    adjacency.set(candidate.predecessorId, targets)
  }
  const visited = new Set<string>()
  const queue = [dependency.successorId]
  while (queue.length > 0) {
    const id = queue.pop()!
    if (id === dependency.predecessorId) return false
    if (visited.has(id)) continue
    visited.add(id)
    queue.push(...adjacency.get(id) ?? [])
  }
  return true
}

/**
 * Returns the live link after putting one archived reference back, or `undefined` when it cannot return.
 *
 * A reference returns only when the Work Item still exists, its link has no other value in the same
 * field, and the result passes link and Cycle capacity validation.
 *
 * @param state - Current live graph that already contains the restored entity.
 * @param reference - Archived link reference.
 * @param summary - Current canonical Work Item, when it still exists.
 * @param now - Restore timestamp for a newly created link.
 * @returns The link to store.
 */
function restoreLinkReference(
  state: PlanningWorkspaceState,
  reference: PlanningArchivedLinkReference,
  summary: PlanningWorkItemSummary | undefined,
  now: string,
): PlanningWorkItemLink | undefined {
  if (!summary) return undefined
  const { teamId, workItemId } = reference.link
  const current = state.workItemLinks.find((link) =>
    link.teamId === teamId && link.workItemId === workItemId
  )
  if (current && current.projectId !== summary.projectId) return undefined
  const link: PlanningWorkItemLink = current
    ? { ...current, goalIds: [...current.goalIds] }
    : {
        teamId,
        workItemId,
        ...(summary.projectId === undefined ? {} : { projectId: summary.projectId }),
        goalIds: [],
        createdAt: now,
      }
  if (reference.reference === 'cycle') {
    if (link.cycleId !== undefined) return undefined
    link.cycleId = reference.entityId
  } else if (reference.reference === 'milestone') {
    if (link.milestoneId !== undefined) return undefined
    link.milestoneId = reference.entityId
  } else {
    if (link.goalIds.includes(reference.entityId) || link.goalIds.length >= 100) return undefined
    link.goalIds = [...link.goalIds, reference.entityId].sort()
  }
  try {
    validateWorkItemLink(state, link)
  } catch {
    return undefined
  }
  if (reference.reference === 'cycle') {
    const cycle = findEntity(state, reference.entityId)
    const linked = state.workItemLinks.filter((candidate) =>
      candidate.cycleId === reference.entityId
    ).length
    if (!cycle || linked + 1 > (cycle.capacity ?? 0)) return undefined
  }
  return link
}

/**
 * Plans one revision that returns archived references of a restored entity to the live graph.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param state - Current live graph; not mutated.
 * @param entityId - Restored entity identifier.
 * @param pending - Archive references not yet processed, in archive order.
 * @param context - Archived counterparts, canonical Work Items, and the restore timestamp.
 * @returns The revision and the outcome of the references it consumes.
 */
function planArchiveRestoreStep(
  workspaceId: string,
  state: PlanningWorkspaceState,
  entityId: string,
  pending: readonly (PlanningArchivedDependency | PlanningArchivedLinkReference)[],
  context: {
    /** Dependency counterparts that are still archived. */
    archivedCounterpartIds: ReadonlySet<string>
    /** Live dependency counterparts the caller may not manage. */
    deniedCounterpartIds: ReadonlySet<string>
    /** Canonical Work Items by qualified key. */
    workItems: ReadonlyMap<string, PlanningWorkItemSummary>
    /** Restore timestamp. */
    now: string
  },
): PlanningArchiveRestorePlan {
  const counts = {
    restoredLinkCount: 0,
    droppedLinkCount: 0,
    restoredDependencyCount: 0,
    retainedDependencyCount: 0,
    droppedDependencyCount: 0,
  }
  const archiveChanges: PlanningArchiveChange[] = []
  const workItemConditions: PlanningWorkItemCondition[] = []
  let next: PlanningWorkspaceState = { ...state }
  let budget = PLANNING_ARCHIVE_STEP_ITEM_BUDGET
  let bytes = 0
  let processedCount = 0
  for (const reference of pending) {
    if (budget < 3) break
    // Size by the rows this reference writes: a restored link merges into the current live row,
    // which may have grown since the reference was archived.
    const merged = reference.kind === 'link'
      ? restoreLinkReference(
        next,
        reference,
        context.workItems.get(createWorkItemKey(reference.link.teamId, reference.link.workItemId)),
        context.now,
      )
      : undefined
    const cost = estimateArchiveStepBytes(reference) + (merged ? estimateArchiveStepBytes(merged) : 0)
    if (processedCount > 0 && bytes + cost > PLANNING_ARCHIVE_STEP_BYTE_BUDGET) break
    bytes += cost
    const recordKey = createArchivedReferenceRecordKey(reference)
    if (reference.kind === 'dependency') {
      const { dependency } = reference
      const counterpartId = dependency.predecessorId === entityId
        ? dependency.successorId
        : dependency.predecessorId
      if (context.deniedCounterpartIds.has(counterpartId) && findEntity(next, counterpartId)) {
        // The caller cannot manage the counterpart, so the edge stays archived for someone who can.
        processedCount += 1
        continue
      }
      if (findEntity(next, counterpartId)) {
        if (canRestoreDependency(next, dependency)) {
          next = { ...next, dependencies: [...next.dependencies, dependency] }
          counts.restoredDependencyCount += 1
        } else {
          counts.droppedDependencyCount += 1
        }
        budget -= 2
      } else if (context.archivedCounterpartIds.has(counterpartId)) {
        archiveChanges.push({
          kind: 'put',
          row: createArchivedReferenceRow(workspaceId, { ...reference, entityId: counterpartId }),
          requireAbsent: true,
        })
        counts.retainedDependencyCount += 1
        budget -= 2
      } else {
        counts.droppedDependencyCount += 1
        budget -= 1
      }
    } else {
      const summary = context.workItems.get(
        createWorkItemKey(reference.link.teamId, reference.link.workItemId),
      )
      const link = merged
      if (link && summary) {
        next = {
          ...next,
          workItemLinks: [
            ...next.workItemLinks.filter((candidate) =>
              candidate.teamId !== link.teamId || candidate.workItemId !== link.workItemId
            ),
            link,
          ],
        }
        workItemConditions.push({
          teamId: link.teamId,
          workItemId: link.workItemId,
          revision: readRevision(summary.revision),
        })
        counts.restoredLinkCount += 1
        budget -= 3
      } else {
        counts.droppedLinkCount += 1
        budget -= 1
        if (summary) {
          // The drop is decided against this Work Item summary, so a later change to the Work Item
          // must abort the step instead of losing a reference that has become valid again.
          workItemConditions.push({
            teamId: reference.link.teamId,
            workItemId: reference.link.workItemId,
            revision: readRevision(summary.revision),
          })
          budget -= 1
        }
      }
    }
    archiveChanges.push({ kind: 'delete', recordKey, requireExisting: true })
    processedCount += 1
  }
  return {
    step: { state: next, archiveChanges, workItemConditions },
    counts,
  }
}

/**
 * Builds the public summary of an archived entity.
 *
 * @param entity - Archived entity.
 * @returns Summary fields shown in the archive list.
 */
function createArchivedEntitySummary(entity: StoredPlanningEntity): ArchivedPlanningEntitySummary {
  return {
    id: entity.id,
    type: entity.type,
    title: entity.title,
    ...(entity.parentId === undefined ? {} : { parentId: entity.parentId }),
    ...(entity.teamId === undefined ? {} : { teamId: entity.teamId }),
    ...(entity.projectId === undefined ? {} : { projectId: entity.projectId }),
    ownerMemberKey: entity.ownerMemberKey,
    archivedAt: entity.archivedAt ?? entity.updatedAt,
  }
}

/**
 * Encodes the exclusive start of the next archive list page.
 *
 * @param entityId - Last entity ID of the current page.
 * @returns Opaque cursor.
 */
function createArchivedEntityCursor(entityId: string) {
  return Buffer.from(JSON.stringify({ v: 1, after: entityId }), 'utf8').toString('base64url')
}

/**
 * Estimates the serialized bytes one archive row adds to a step transaction.
 *
 * @param value - Row or record written by the step.
 * @returns JSON size plus a fixed allowance for the table name, key and condition envelope.
 */
function estimateArchiveStepBytes(value: unknown) {
  return utf8ByteLength(JSON.stringify(value)) + 512
}

/**
 * Decodes an archive list cursor.
 *
 * @param cursor - Untrusted opaque cursor.
 * @returns The exclusive entity ID the next page starts after.
 */
function readArchivedEntityCursor(cursor: unknown) {
  // A 256-character ID JSON-escapes to at most 1,536 bytes, about 2,100 base64url characters.
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 4_096) {
    throw invalid('PlanningArchiveCursorInvalid', 'Archived Planning cursor is invalid.')
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      typeof payload !== 'object' || payload === null ||
      !('v' in payload) || payload.v !== 1 || !('after' in payload)
    ) {
      throw new Error('Invalid cursor payload.')
    }
    return readIdentifier(payload.after, 'Archived Planning cursor')
  } catch {
    throw invalid('PlanningArchiveCursorInvalid', 'Archived Planning cursor is invalid.')
  }
}

/**
 * Creates the sort key of an archived entity row.
 *
 * @param entityId - Archived entity identifier.
 * @returns Size-checked sort key.
 */
function createArchivedEntityRecordKey(entityId: string) {
  return readRecordKey(
    `${ARCHIVED_ENTITY_RECORD_PREFIX}${
      boundArchivedKeyPart(ARCHIVED_ENTITY_RECORD_PREFIX, encodeRecordKeyIdentifier(entityId), 0, entityId)
    }`,
    'Archived Planning entity record key',
  )
}

/** Bytes kept free after an archived reference prefix for the longest digested reference suffix. */
const ARCHIVED_REFERENCE_SUFFIX_RESERVE = 'DEPENDENCY#'.length + 65

/**
 * Keeps an archive key part within the DynamoDB sort-key limit.
 *
 * Archive keys concatenate identifiers that each fit their live key, so a long encoded part is
 * replaced by `#` and its SHA-256 digest. `encodeURIComponent` never emits `#`, so a digest
 * cannot collide with an encoded identifier; the row itself keeps the full identifiers.
 *
 * @param prefix - Key text before the part.
 * @param encoded - URI-encoded part.
 * @param reservedBytes - Bytes that must stay free after the part.
 * @param source - Unencoded value digested when the part does not fit.
 * @returns The encoded part, or its digest form.
 */
function boundArchivedKeyPart(prefix: string, encoded: string, reservedBytes: number, source: string) {
  return utf8ByteLength(prefix) + utf8ByteLength(encoded) + reservedBytes <= 1_024
    ? encoded
    : `#${createHash('sha256').update(source).digest('hex')}`
}

/**
 * Creates the sort-key prefix of every reference an archived entity owns.
 *
 * @param entityId - Archived entity identifier.
 * @returns Sort-key prefix ending with `#`.
 */
function createArchivedReferenceRecordPrefix(entityId: string) {
  return readRecordKey(
    `${ARCHIVED_REFERENCE_RECORD_PREFIX}${
      boundArchivedKeyPart(
        ARCHIVED_REFERENCE_RECORD_PREFIX,
        encodeRecordKeyIdentifier(entityId),
        1 + ARCHIVED_REFERENCE_SUFFIX_RESERVE,
        entityId,
      )
    }#`,
    'Archived Planning reference record prefix',
  )
}

/**
 * Creates the sort key of one archived dependency or link reference.
 *
 * @param reference - Archived reference.
 * @returns Size-checked sort key under the owning entity's prefix.
 */
function createArchivedReferenceRecordKey(
  reference: PlanningArchivedDependency | PlanningArchivedLinkReference,
) {
  const prefix = createArchivedReferenceRecordPrefix(reference.entityId)
  const kindPrefix = `${prefix}${reference.kind === 'dependency' ? 'DEPENDENCY#' : 'LINK#'}`
  return readRecordKey(
    `${kindPrefix}${
      reference.kind === 'dependency'
        // A dependency ID can be reused once its edge left the live graph, so the archived key
        // also names the endpoints, which no other edge with the same ID can share.
        ? boundArchivedKeyPart(
          kindPrefix,
          [
            reference.dependency.id,
            reference.dependency.predecessorId,
            reference.dependency.successorId,
          ].map(encodeRecordKeyIdentifier).join('#'),
          0,
          JSON.stringify([
            reference.dependency.id,
            reference.dependency.predecessorId,
            reference.dependency.successorId,
          ]),
        )
        : boundArchivedKeyPart(
          kindPrefix,
          `${encodeRecordKeyIdentifier(reference.link.teamId)}#${
            encodeRecordKeyIdentifier(reference.link.workItemId)
          }`,
          0,
          JSON.stringify([reference.link.teamId, reference.link.workItemId]),
        )
    }`,
    'Archived Planning reference record key',
  )
}

/**
 * Creates an archived entity row.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param entity - Archived entity.
 * @returns DynamoDB row.
 */
function createArchivedEntityRow(workspaceId: string, entity: StoredPlanningEntity) {
  return {
    workspaceId,
    recordKey: createArchivedEntityRecordKey(entity.id),
    entryType: 'planning-archived-entity',
    schemaVersion: PLANNING_ARCHIVE_SCHEMA_VERSION,
    entity,
  }
}

/**
 * Creates an archived dependency or link reference row.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param reference - Archived reference.
 * @returns DynamoDB row.
 */
function createArchivedReferenceRow(
  workspaceId: string,
  reference: PlanningArchivedDependency | PlanningArchivedLinkReference,
) {
  return {
    workspaceId,
    recordKey: createArchivedReferenceRecordKey(reference),
    entryType: reference.kind === 'dependency'
      ? 'planning-archived-dependency'
      : 'planning-archived-link-reference',
    schemaVersion: PLANNING_ARCHIVE_SCHEMA_VERSION,
    ...reference,
  }
}

/**
 * Decodes an archived entity row.
 *
 * @param row - Untrusted DynamoDB row.
 * @param workspaceId - Expected Workspace identifier.
 * @returns The archived entity.
 */
function readArchivedEntityRow(
  row: Record<string, unknown>,
  workspaceId: string,
): StoredPlanningEntity {
  try {
    if (
      row.workspaceId !== workspaceId ||
      row.entryType !== 'planning-archived-entity' ||
      row.schemaVersion !== PLANNING_ARCHIVE_SCHEMA_VERSION ||
      typeof row.entity !== 'object' || row.entity === null || Array.isArray(row.entity)
    ) {
      throw persistenceInvalid('Archived Planning entity row is invalid.')
    }
    const source = row.entity as Record<string, unknown>
    const entity = readStoredPlanningEntity({
      ...source,
      recordKey: createEntityRecordKey(readIdentifier(source.id, 'Planning entity ID')),
    })
    if (row.recordKey !== createArchivedEntityRecordKey(entity.id) || entity.archivedAt === undefined) {
      throw persistenceInvalid('Archived Planning entity row is invalid.')
    }
    return entity
  } catch {
    throw persistenceInvalid('Archived Planning entity row is invalid.')
  }
}

/**
 * Decodes an archived dependency or link reference row.
 *
 * @param row - Untrusted DynamoDB row.
 * @param workspaceId - Expected Workspace identifier.
 * @param entityId - Expected owning entity.
 * @returns The archived reference.
 */
function readArchivedReferenceRow(
  row: Record<string, unknown>,
  workspaceId: string,
  entityId: string,
): PlanningArchivedDependency | PlanningArchivedLinkReference {
  try {
    if (
      row.workspaceId !== workspaceId ||
      row.schemaVersion !== PLANNING_ARCHIVE_SCHEMA_VERSION ||
      row.entityId !== entityId
    ) {
      throw persistenceInvalid('Archived Planning reference row is invalid.')
    }
    let reference: PlanningArchivedDependency | PlanningArchivedLinkReference
    if (row.entryType === 'planning-archived-dependency' && row.kind === 'dependency') {
      const source = readRecordObject(row.dependency)
      reference = {
        kind: 'dependency',
        entityId,
        dependency: readStoredPlanningDependency({
          ...source,
          recordKey: createDependencyRecordKey(readIdentifier(source.id, 'Dependency ID')),
        }),
      }
      const { predecessorId, successorId } = reference.dependency
      if (predecessorId !== entityId && successorId !== entityId) {
        throw persistenceInvalid('Archived Planning dependency does not touch its entity.')
      }
    } else if (row.entryType === 'planning-archived-link-reference' && row.kind === 'link') {
      const source = readRecordObject(row.link)
      const link = readStoredPlanningWorkItemLink({
        ...source,
        recordKey: createLinkRecordKey(
          readIdentifier(source.teamId, 'Team ID'),
          readIdentifier(source.workItemId, 'Work Item ID'),
        ),
      })
      if (
        row.reference !== 'cycle' && row.reference !== 'milestone' && row.reference !== 'goal' ||
        readLinkReferenceKind(link, entityId) !== row.reference
      ) {
        throw persistenceInvalid('Archived Planning link reference is invalid.')
      }
      reference = { kind: 'link', entityId, reference: row.reference, link }
    } else {
      throw persistenceInvalid('Archived Planning reference row is invalid.')
    }
    if (row.recordKey !== createArchivedReferenceRecordKey(reference)) {
      throw persistenceInvalid('Archived Planning reference record key is invalid.')
    }
    return reference
  } catch {
    throw persistenceInvalid('Archived Planning reference row is invalid.')
  }
}

/**
 * Returns a nested stored object.
 *
 * @param value - Untrusted nested value.
 * @returns The value as a record.
 */
function readRecordObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw persistenceInvalid('Archived Planning row has an invalid nested value.')
  }
  return value as Record<string, unknown>
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
  if (target.type === 'project') {
    return `PROJECT#${encodeRecordKeyIdentifier(target.teamId)}#${encodeRecordKeyIdentifier(target.projectId)}`
  }
  return target.type === 'team'
    ? `TEAM#${encodeRecordKeyIdentifier(target.teamId)}`
    : `INITIATIVE#${encodeRecordKeyIdentifier(target.entityId)}`
}

/**
 * Returns the notification context that every publish mutation records with its update.
 *
 * @param value - Context returned by the publish mutation.
 * @returns A copy of the context.
 * @throws PlanningError when the publish mutation did not record it.
 */
function requirePublishedUpdateNotification(
  value: PlanningUpdatePublishNotificationContext | undefined,
): PlanningUpdatePublishNotificationContext {
  if (!value) {
    throw new PlanningError(503, 'PlanningUpdateUnavailable', 'Published update is unavailable.')
  }
  return { ...value }
}

/**
 * Returns the identifier that notification metadata stores for one update target.
 *
 * @param target - Project, Team, or Initiative update target.
 * @returns Project ID, Team ID, or Initiative entity ID.
 */
export function readPlanningUpdateTargetId(target: PlanningUpdateTarget): string {
  if (target.type === 'project') return target.projectId
  return target.type === 'team' ? target.teamId : target.entityId
}

/**
 * Creates the sort key of one UPDATE_TARGET row.
 *
 * @param target - Canonical target.
 * @returns Size-checked DynamoDB sort key.
 */
export function createPlanningUpdateTargetRecordKey(target: PlanningUpdateTarget): string {
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
 * Reads the optional acknowledgement flag of an update comment.
 *
 * @param value - Untrusted `acknowledgement` value.
 * @returns Whether the comment records the reviewer acknowledgement.
 * @throws PlanningError when the value is neither absent nor `true`.
 */
function readPlanningUpdateAcknowledgementFlag(value: unknown): boolean {
  if (value === undefined) return false
  if (value === true) return true
  throw invalid(
    'PlanningUpdateAcknowledgementInvalid',
    'Planning update acknowledgement must be true when present.',
  )
}

/**
 * Creates the conflict raised when a version already has its reviewer acknowledgement.
 *
 * @returns Planning conflict error.
 */
function planningUpdateAlreadyAcknowledged() {
  return conflict(
    'PlanningUpdateAlreadyAcknowledged',
    'This Planning update version is already acknowledged.',
  )
}

/**
 * Creates the target-bound sort-key prefix of acknowledgement rows.
 *
 * @param target - Canonical update target.
 * @returns DynamoDB sort-key prefix.
 */
function createPlanningUpdateAcknowledgementRecordPrefix(target: PlanningUpdateTarget) {
  return readRecordKey(
    `${UPDATE_ACKNOWLEDGEMENT_RECORD_PREFIX}${createPlanningUpdateTargetRecordSuffix(target)}#`,
    'Planning update acknowledgement record prefix',
  )
}

/**
 * Creates the one acknowledgement key allowed for an immutable update version.
 *
 * @param target - Canonical update target.
 * @param updateVersion - Immutable target-local version.
 * @returns Zero-padded DynamoDB sort key.
 */
function createPlanningUpdateAcknowledgementRecordKey(
  target: PlanningUpdateTarget,
  updateVersion: number,
) {
  return readRecordKey(
    `${createPlanningUpdateAcknowledgementRecordPrefix(target)}` +
      `${String(readPlanningUpdateVersion(updateVersion)).padStart(UPDATE_VERSION_WIDTH, '0')}`,
    'Planning update acknowledgement record key',
  )
}

/**
 * Creates the acknowledgement row written atomically with its acknowledgement comment.
 *
 * @param workspaceId - Owning Workspace partition.
 * @param comment - Validated acknowledgement comment.
 * @returns DynamoDB row that is unique per immutable update version.
 */
function createPlanningUpdateAcknowledgementRow(
  workspaceId: string,
  comment: PlanningUpdateComment,
) {
  const row = {
    workspaceId,
    recordKey: createPlanningUpdateAcknowledgementRecordKey(comment.target, comment.updateVersion),
    entryType: 'planning-update-acknowledgement',
    target: structuredClone(comment.target),
    updateVersion: comment.updateVersion,
    memberKey: comment.authorMemberKey,
    commentId: comment.id,
    acknowledgedAt: comment.createdAt,
  }
  requirePlanningAnnotationRowSize(row)
  return row
}

/**
 * Decodes one acknowledgement row.
 *
 * @param row - Untrusted DynamoDB row.
 * @param workspaceId - Expected Workspace partition.
 * @param target - Expected update target.
 * @returns Version and validated acknowledgement.
 */
function readStoredPlanningUpdateAcknowledgement(
  row: Record<string, unknown>,
  workspaceId: string,
  target: PlanningUpdateTarget,
): { updateVersion: number, acknowledgement: PlanningUpdateAcknowledgement } {
  if (row.workspaceId !== workspaceId || row.entryType !== 'planning-update-acknowledgement') {
    throw persistenceInvalid('Planning update acknowledgement row scope is invalid.')
  }
  const updateVersion = readPlanningUpdateVersion(row.updateVersion)
  if (
    !planningUpdateTargetsEqual(readPlanningUpdateTarget(row.target), target) ||
    row.recordKey !== createPlanningUpdateAcknowledgementRecordKey(target, updateVersion)
  ) {
    throw persistenceInvalid('Planning update acknowledgement row key is invalid.')
  }
  return {
    updateVersion,
    acknowledgement: {
      memberKey: readOwnerMemberKey(row.memberKey),
      commentId: readIdentifier(row.commentId, 'Planning update comment ID'),
      acknowledgedAt: readTimestamp(row.acknowledgedAt, 'Planning update acknowledgement timestamp'),
    },
  }
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
    ...(readPlanningUpdateAcknowledgementFlag(row.acknowledgement)
      ? { acknowledgement: true as const }
      : {}),
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

function readGoalFramework(value: unknown): NonNullable<PlanningEntity['goalFramework']> {
  if (value === 'goal' || value === 'objective' || value === 'key-result') return value
  throw invalid('PlanningGoalFrameworkInvalid', 'Planning goalFramework is invalid.')
}

function readCarryOverPolicy(value: unknown): NonNullable<PlanningEntity['carryOverPolicy']> {
  if (value === 'move-incomplete' || value === 'keep-incomplete') return value
  throw invalid('PlanningCarryOverPolicyInvalid', 'Cycle carry-over policy is invalid.')
}

/** Prefix of the server-derived ID of a next Cycle. */
const NEXT_CYCLE_ID_PREFIX = 'cycle-next-'

/**
 * Derives the ID of the Cycle created after a source Cycle, so a retried creation cannot add two.
 *
 * @param sourceCycleId - Source Cycle ID.
 * @returns Stable next Cycle ID.
 */
function createNextCycleId(sourceCycleId: string) {
  return `${NEXT_CYCLE_ID_PREFIX}${createHash('sha256').update(sourceCycleId).digest('hex').slice(0, 32)}`
}

/** Last day covered by a Cycle, counting a forecast that runs past the baseline. */
function cycleEndDate(cycle: StoredPlanningEntity) {
  return cycle.forecast.endDate > cycle.baseline.endDate
    ? cycle.forecast.endDate
    : cycle.baseline.endDate
}

/**
 * Computes the date range of the Cycle that follows a source Cycle.
 *
 * @param source - Source Cycle.
 * @param cadence - Source Cycle cadence.
 * @returns Range starting the day after the source ends and spanning one cadence.
 */
function createNextCycleRange(source: StoredPlanningEntity, cadence: PlanningCadence) {
  const startDate = shiftIsoDate(cycleEndDate(source), 1)
  const endDate = startDate === undefined
    ? undefined
    : cadence.unit === 'week'
      ? shiftIsoDate(startDate, cadence.count * 7 - 1)
      : shiftIsoDate(addIsoDateMonths(startDate, cadence.count), -1)
  if (startDate === undefined || endDate === undefined) {
    throw invalid('PlanningCycleNextDateInvalid', 'The next Cycle dates are out of range.')
  }
  return { startDate, endDate }
}

/** Adds calendar months to a date, clamping the day to the end of the target month. */
function addIsoDateMonths(value: string, months: number) {
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  const monthIndex = year * 12 + month - 1 + months
  const targetYear = Math.floor(monthIndex / 12)
  const targetMonth = monthIndex % 12
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay))).toISOString().slice(0, 10)
}

/**
 * Names the next Cycle by advancing the last number in the source title.
 *
 * @param title - Source Cycle title.
 * @returns `Sprint 13` after `Sprint 12`, or the title followed by ` 2` when it has no number.
 */
function createNextCycleTitle(title: string) {
  const match = /^(.*?)(\d+)(\D*)$/u.exec(title)
  if (!match) return readTitle(`${title} 2`)
  const [, prefix = '', digits = '', suffix = ''] = match
  const next = String(BigInt(digits) + 1n).padStart(digits.length, '0')
  return readTitle(`${prefix}${next}${suffix}`)
}

/**
 * Returns when the next automation step of a Cycle becomes due.
 *
 * Cycle dates have no time zone, so a date passes at 00:00 UTC of the following day.
 *
 * @param entity - Planning entity.
 * @param state - Live graph used to check the next Cycle.
 * @returns ISO timestamp, or undefined when nothing is pending.
 */
function resolveCycleAutomationDueAt(
  entity: StoredPlanningEntity,
  state: PlanningWorkspaceState,
) {
  if (
    entity.type !== 'cycle' ||
    entity.archivedAt !== undefined ||
    entity.automation === undefined ||
    entity.status === 'completed' ||
    entity.status === 'canceled'
  ) {
    return undefined
  }
  const endDate = cycleEndDate(entity)
  const rolloverDate = shiftIsoDate(endDate, 1)
  if (entity.nextCycleId === undefined) {
    const createDate = entity.automation.createNext
      ? shiftIsoDate(endDate, -CYCLE_AUTO_CREATE_LEAD_DAYS)
      : rolloverDate
    return createDate === undefined ? undefined : `${createDate}T00:00:00.000Z`
  }
  if (!entity.automation.rolloverAtEnd || rolloverDate === undefined) return undefined
  const next = findEntity(state, entity.nextCycleId)
  if (
    next === undefined ||
    next.archivedAt !== undefined ||
    next.status === 'completed' ||
    next.status === 'canceled'
  ) {
    return undefined
  }
  return `${rolloverDate}T00:00:00.000Z`
}

/**
 * Rejects an edit that would make a Cycle's automated rollover into its next Cycle impossible.
 *
 * Automation creates the next Cycle once and records it, so an accepted edit that breaks the
 * scope, cadence, or date order would leave the automated rollover failing on every run.
 *
 * @param state - Graph after the edit.
 * @param entity - Edited entity.
 */
function requireCycleChainCompatible(state: PlanningWorkspaceState, entity: StoredPlanningEntity) {
  if (entity.type !== 'cycle') return
  const isPending = (cycle: StoredPlanningEntity) =>
    cycle.archivedAt === undefined && cycle.status !== 'completed' && cycle.status !== 'canceled'
  const pairs: Array<[StoredPlanningEntity, StoredPlanningEntity]> = []
  const next = entity.nextCycleId === undefined ? undefined : findEntity(state, entity.nextCycleId)
  if (next) pairs.push([entity, next])
  for (const candidate of state.entities) {
    if (candidate.id !== entity.id && candidate.nextCycleId === entity.id) pairs.push([candidate, entity])
  }
  for (const [source, target] of pairs) {
    if (source.automation?.rolloverAtEnd !== true || !isPending(source) || !isPending(target)) continue
    if (
      target.baseline.startDate <= source.baseline.endDate ||
      target.forecast.startDate <= source.forecast.endDate ||
      source.teamId !== target.teamId ||
      source.projectId !== target.projectId ||
      source.cadence?.unit !== target.cadence?.unit ||
      source.cadence?.count !== target.cadence?.count
    ) {
      throw conflict(
        'PlanningCycleNextIncompatible',
        `Cycle "${target.id}" must keep the scope and cadence of Cycle "${source.id}" and start after it ends. ` +
          'Change both Cycles together, or roll over by hand first.',
      )
    }
  }
}

/**
 * Decides which automation step of a Cycle is due now.
 *
 * @param cycle - Cycle entity.
 * @param state - Live graph.
 * @param now - Current time.
 * @returns The due step, or undefined.
 */
function resolveDueCycleAutomation(
  cycle: StoredPlanningEntity,
  state: PlanningWorkspaceState,
  now: Date,
): 'create-next' | 'rollover' | undefined {
  const dueAt = resolveCycleAutomationDueAt(cycle, state)
  if (dueAt === undefined || Date.parse(dueAt) > now.getTime()) return undefined
  if (cycle.nextCycleId === undefined) return 'create-next'
  // A predecessor still rolling into this Cycle goes first. Completing this Cycle earlier would
  // stop the predecessor's rollover and strand its unfinished Work Items.
  const predecessorPending = state.entities.some((candidate) =>
    candidate.id !== cycle.id &&
    candidate.nextCycleId === cycle.id &&
    resolveCycleAutomationDueAt(candidate, state) !== undefined
  )
  return predecessorPending ? undefined : 'rollover'
}

/** Validates the Work Item references of a Cycle bulk change. */
function readCycleWorkItemReferences(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > CYCLE_WORK_ITEMS_BATCH_LIMIT) {
    throw invalid(
      'PlanningCycleWorkItemsInvalid',
      `Choose 1 to ${CYCLE_WORK_ITEMS_BATCH_LIMIT} Work Items.`,
    )
  }
  const keys = new Set<string>()
  return value.map((item: unknown) => {
    if (!isRecord(item)) {
      throw invalid('PlanningCycleWorkItemsInvalid', 'Cycle Work Item reference is invalid.')
    }
    const teamId = readIdentifier(item.teamId, 'Team ID')
    const workItemId = readIdentifier(item.workItemId, 'Work Item ID')
    const key = createWorkItemKey(teamId, workItemId)
    if (keys.has(key)) {
      throw invalid('PlanningCycleWorkItemsInvalid', 'Cycle Work Items must be unique.')
    }
    keys.add(key)
    return { teamId, workItemId }
  })
}

/** Drops the carry-over history of a link whose Cycle is changed by hand. */
function withoutCarryOverHistory(link: PlanningWorkItemLink): PlanningWorkItemLink {
  const result = { ...link }
  delete result.carriedOverFromCycleId
  delete result.carriedOverAt
  return result
}

/**
 * Validates a Cycle automation setting.
 *
 * @param value - Untrusted automation candidate.
 * @returns Canonical automation, or undefined when every switch is off.
 */
function readCycleAutomation(value: unknown): CycleAutomation | undefined {
  if (
    !isRecord(value) ||
    typeof value.createNext !== 'boolean' ||
    typeof value.rolloverAtEnd !== 'boolean' ||
    Object.keys(value).some((key) => key !== 'createNext' && key !== 'rolloverAtEnd')
  ) {
    throw invalid('PlanningCycleAutomationInvalid', 'Cycle automation is invalid.')
  }
  if (!value.createNext && !value.rolloverAtEnd) return undefined
  return { createNext: value.createNext, rolloverAtEnd: value.rolloverAtEnd }
}

/** Returns the stored automation field, omitted when absent or fully disabled. */
function optionalCycleAutomation(value: unknown): { automation?: CycleAutomation } {
  if (value === undefined) return {}
  const automation = readCycleAutomation(value)
  return automation === undefined ? {} : { automation }
}

/** Reads the optional carry-over history of a Work Item link. */
function readCarryOverHistory(
  source: Record<string, unknown>,
): Pick<PlanningWorkItemLink, 'carriedOverFromCycleId' | 'carriedOverAt'> {
  if (source.carriedOverFromCycleId === undefined && source.carriedOverAt === undefined) return {}
  return {
    carriedOverFromCycleId: readIdentifier(source.carriedOverFromCycleId, 'Carried-over Cycle ID'),
    carriedOverAt: readTimestamp(source.carriedOverAt, 'Carried-over timestamp'),
  }
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

function readDependencyType(value: unknown): ScheduleDependencyType {
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
  const environment = loadServerConfig().environment
  const endpoint = getDynamoDbEndpoint()
  return new DynamoDBClient({
    region: environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION ?? 'ap-northeast-1',
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: environment.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: environment.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  })
}

/** Creates the default Planning DocumentClient with its migration barrier. */
function createDocumentClient(client = createDynamoDbClient()) {
  return bindPlanningRevisionFenceBarrierDocumentClient(
    DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    }),
    loadServerConfig().environment.PLANNING_TABLE_NAME,
  )
}

function getDynamoDbEndpoint() {
  const environment = loadServerConfig().environment
  return environment.DYNAMODB_ENDPOINT ??
    environment.AWS_ENDPOINT_URL_DYNAMODB ??
    environment.AWS_ENDPOINT_URL
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Validates one stored Planning META item without trusting its physical key.
 *
 * @param item - Raw DynamoDB item returned for a META key.
 * @returns Validated revision metadata, or undefined when the item is absent.
 */
function readPlanningMetaItem(
  item: Record<string, unknown> | undefined,
): PlanningMeta | undefined {
  if (!item) return undefined
  if (
    item.entryType !== 'planning-meta' ||
    item.schemaVersion !== PLANNING_STORAGE_SCHEMA_VERSION ||
    !isPositiveInteger(item.revision) ||
    (item.updatedAt !== undefined && (
      typeof item.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(item.updatedAt))
    ))
  ) {
    throw persistenceInvalid('Planning metadata is invalid.')
  }
  const revisionFence = readPlanningRevisionFence(
    readOptionalStoredCounter(item.sourceRevisionCount),
    readOptionalStoredCounter(item.structureRevision),
    readOptionalStoredCounter(item.structureSourceRevisionCount),
  )
  return {
    revision: item.revision,
    ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
    ...(revisionFence === undefined ? {} : { revisionFence }),
  }
}

/**
 * Validates an optional stored META counter.
 *
 * @param value - Untrusted attribute value.
 * @returns The counter, or undefined when it is absent.
 */
function readOptionalStoredCounter(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw persistenceInvalid('Planning metadata is invalid.')
  }
  return value
}

/**
 * Builds the revision fence from validated META counters.
 *
 * @param sourceRevisionCount - Work Item advance counter, when stored.
 * @param structureRevision - Revision of the latest Planning commit that wrote counters.
 * @param structureSourceRevisionCount - Work Item counter at that Planning commit.
 * @returns The fence, or undefined before any Work Item write or Planning commit stored counters.
 */
function readPlanningRevisionFence(
  sourceRevisionCount: number | undefined,
  structureRevision: number | undefined,
  structureSourceRevisionCount: number | undefined,
): PlanningRevisionFence | undefined {
  if (sourceRevisionCount === undefined) return undefined
  // Both structure attributes are written together; a half-written pair is ignored.
  return structureRevision === undefined || structureSourceRevisionCount === undefined
    ? { sourceRevisionCount }
    : { sourceRevisionCount, structureRevision, structureSourceRevisionCount }
}

/**
 * Returns whether only canonical Work Item writes advanced META after a caller's revision.
 *
 * Every increment after the latest Planning commit must be a counted Work Item increment, and
 * the caller must have read that commit. A META row without counters is treated as changed.
 *
 * @param meta - Strongly read revision and counters.
 * @param expectedRevision - Revision the caller read.
 * @returns True when the Planning graph at `expectedRevision` equals the graph at `meta.revision`.
 */
function isWorkItemOnlyRevisionAdvance(
  meta: Pick<PlanningMeta, 'revision' | 'revisionFence'>,
  expectedRevision: number,
) {
  if (meta.revision === expectedRevision) return true
  const fence = meta.revisionFence
  if (
    fence?.structureRevision === undefined ||
    fence.structureSourceRevisionCount === undefined ||
    expectedRevision < fence.structureRevision ||
    expectedRevision > meta.revision
  ) {
    return false
  }
  return meta.revision - fence.structureRevision ===
    fence.sourceRevisionCount - fence.structureSourceRevisionCount
}

/**
 * Marks a graph about to be committed as the latest Planning change on META.
 *
 * The commit's CAS on `revision` means no Work Item write landed since `state` was read, so its
 * counter is still current.
 *
 * @param state - Graph carrying the revision it commits and the counter it was read with.
 * @returns META counters to persist with the commit.
 */
function createCommittedRevisionFence(state: PlanningWorkspaceState): Required<PlanningRevisionFence> {
  const sourceRevisionCount = state.revisionFence?.sourceRevisionCount ?? 0
  return {
    sourceRevisionCount,
    structureRevision: state.revision,
    structureSourceRevisionCount: sourceRevisionCount,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recursively freezes a structured-clone-safe value so shared reads cannot mutate it.
 *
 * @param value - Plain data value to freeze in place.
 * @returns The same value, frozen.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
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
