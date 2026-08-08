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
  WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS,
  WORK_ITEM_SCHEDULE_MIN_YEAR,
  type CreatePlanningDependencyInput,
  type CreatePlanningEntityInput,
  type CreateWorkItemScheduleDependencyInput,
  type CycleRolloverInput,
  type DuplicatePlanningEntityInput,
  type MovePlanningEntityInput,
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
  type PlanningWorkItemLink,
  type PlanningWorkItemLinkInput,
  type PlanningWorkItemDependencySummary,
  type PlanningWorkItemSummary,
  type ScheduleDependencyConstraint,
  type UpdatePlanningEntityInput,
  type UpdateWorkItemScheduleDependencyInput,
  type WorkItemAffectedProject,
  type WorkItemDependencyCriticalPath,
  type WorkItemDependencyEndpoint,
  type WorkItemSchedule,
  type WorkItemScheduleDependency,
  type WorkItemScheduleDependencyConflict,
} from '@mukuroji/contracts'

const META_RECORD_KEY = 'META'
const ENTITY_RECORD_PREFIX = 'ENTITY#'
const DEPENDENCY_RECORD_PREFIX = 'DEPENDENCY#'
const WORK_ITEM_DEPENDENCY_RECORD_PREFIX = 'WORK_ITEM_DEPENDENCY#'
const LINK_RECORD_PREFIX = 'LINK#'
const PLANNING_READ_LIMIT = 2_000
const TRANSACTION_ITEM_LIMIT = 100
const MAX_PLANNING_ROW_BYTES = 300_000
const MAX_PLANNING_TRANSACTION_BYTES = 3_000_000
const MAX_PLANNING_SNAPSHOT_BYTES = 4_000_000
const MAX_DESCRIPTION_BYTES = 20_000
const MAX_STATUS_MESSAGE_BYTES = 8_000
const MAX_STATUS_UPDATES = 32
const MAX_ROLLOVER_LINK_MUTATIONS = 49
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

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

/** One external DynamoDB action prepared for the Planning mutation transaction. */
type PlanningMutationTransactionContribution = {
  /** Conditional receipt write committed after Planning row mutations. */
  transactWriteItem: NonNullable<TransactWriteCommandInput['TransactItems']>[number]
}

/** Adds one durable completion receipt to a Work Item dependency mutation transaction. */
export type PlanningMutationTransaction = {
  /**
   * Prepares a storage contribution from the minimal committed dependency result.
   *
   * @param result - Exact dependency and Planning revision produced by the mutation.
   * @returns An opaque storage contribution validated inside the Planning adapter.
   */
  prepare(
    result: PlanningWorkItemDependencyTransactionResult,
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
    transaction?: PlanningMutationTransaction,
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
    transaction?: PlanningMutationTransaction,
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
    transaction?: PlanningMutationTransaction,
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
  ): Promise<void>

  /** Workspace planning snapshot を返します。 */
  async get(workspaceId: string, workItemState: PlanningWorkItemState) {
    const state = await this.readState(readIdentifier(workspaceId, 'Workspace ID'))
    return createPlanningSnapshot(state, workItemState)
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
      const next = replaceEntity(state, { ...current, archivedAt: now, updatedAt: now })
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
    transaction?: PlanningMutationTransaction,
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
    const planning = createPlanningSnapshot(after, workItemState)
    const transactionContribution = transaction
      ? await preparePlanningMutationTransactionContribution(
          transaction,
          result.workItemDependencyTransactionSource === undefined
            ? undefined
            : {
                ...result.workItemDependencyTransactionSource,
                revision: after.revision,
                dependency: structuredClone(
                  result.workItemDependencyTransactionSource.dependency,
                ),
              },
        )
      : undefined
    await this.commitState(
      workspaceId,
      before,
      after,
      result.workItemConditions,
      authorizationConditionChecks,
      transactionContribution,
    )
    return {
      planning,
      movedWorkItemIds: result.movedWorkItemIds ?? [],
      retainedWorkItemIds: result.retainedWorkItemIds ?? [],
    } satisfies PlanningMutationResponse
  }
}

/**
 * Prepares and validates one external transaction contribution without exposing a full snapshot.
 *
 * @param transaction - Caller-provided durable receipt boundary.
 * @param result - Minimal committed dependency result, when the mutation supports receipts.
 * @returns The conditional DynamoDB action that must commit with Planning state.
 */
async function preparePlanningMutationTransactionContribution(
  transaction: PlanningMutationTransaction,
  result: PlanningWorkItemDependencyTransactionResult | undefined,
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

  constructor(now: () => Date = () => new Date()) {
    super(now)
  }

  /** In-memory state を返します。 */
  protected async readState(workspaceId: string) {
    return structuredClone(this.states.get(workspaceId) ?? createEmptyPlanningState())
  }

  /** Revision CAS 後に in-memory state を置換します。 */
  protected async commitState(
    workspaceId: string,
    before: PlanningWorkspaceState,
    after: PlanningWorkspaceState,
  ) {
    const current = this.states.get(workspaceId) ?? createEmptyPlanningState()
    if (current.revision !== before.revision) {
      throw conflict('PlanningRevisionConflict', 'Planning changed. Reload and try again.')
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
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId',
        ExpressionAttributeValues: { ':workspaceId': workspaceId },
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
      }))
      items.push(...(response.Items ?? []))
      if (items.length > PLANNING_READ_LIMIT) {
        throw new PlanningError(
          413,
          'PlanningReadLimitExceeded',
          `Planning Workspace cannot exceed ${PLANNING_READ_LIMIT} rows.`,
        )
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    const after = await this.readMeta(workspaceId)
    if (before.revision !== after.revision) {
      throw conflict('PlanningRevisionConflict', 'Planning changed while it was being read.')
    }
    if (before.revision === 0 && items.some((item) => item.recordKey !== META_RECORD_KEY)) {
      throw persistenceInvalid('Planning rows exist without metadata.')
    }
    return readPlanningRows(items, before, workspaceId)
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
    if (
      mutations.length + canonicalConditions.length +
        authorizationConditionChecks.length + transactionContributionItems.length + 1 >
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
      const transactionContributionIndex =
        1 + canonicalConditions.length + authorizationConditionChecks.length + mutations.length
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
        Key: { workspaceId, recordKey: META_RECORD_KEY },
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
      ],
      KeySchema: [
        { AttributeName: 'workspaceId', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
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
    workspaceId,
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
    table.KeySchema.some((key) => key.AttributeName === 'recordKey' && key.KeyType === 'RANGE')
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
