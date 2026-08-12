import type { WorkflowStatusCategory } from './work-item-configuration'
import type { WorkItemSchedule } from './work-items'
import type {
  PlanningWorkItemDependencySummary,
  ScheduleDependencyConstraint,
  ScheduleDependencyType,
  WorkItemDependencyEndpoint,
  WorkItemScheduleDependency,
} from './schedule-dependencies'

/** Planning API snapshot の現行 schema version です。 */
export const PLANNING_SCHEMA_VERSION = 2 as const

/** Rolling deployment 中に新しい client が受理する旧 Planning API schema version です。 */
export const LEGACY_PLANNING_SCHEMA_VERSION = 1 as const

/** Planning hierarchy に保存できる entity 種別です。 */
export type PlanningEntityType =
  | 'cycle'
  | 'milestone'
  | 'release'
  | 'phase'
  | 'goal'
  | 'initiative'
  | 'roadmap'
  | 'portfolio'

/** Planning entity の lifecycle status です。 */
export type PlanningEntityStatus =
  | 'proposed'
  | 'planned'
  | 'active'
  | 'paused'
  | 'completed'
  | 'canceled'

/** Planning entity の健全性です。 */
export type PlanningHealth = 'unknown' | 'on-track' | 'at-risk' | 'off-track'

/** Planning entity の risk level です。 */
export type PlanningRisk = 'none' | 'low' | 'medium' | 'high' | 'critical'

/** Planning entity の progress 算出方法です。 */
export type PlanningProgressMode = 'automatic' | 'manual'

/** Baseline / forecast で共有する inclusive な calendar date range です。 */
export type PlanningDateRange = {
  /** Range の開始日を表す `YYYY-MM-DD` です。 */
  startDate: string
  /** Range の終了日を表す `YYYY-MM-DD` です。 */
  endDate: string
}

/** Cycle を連続生成するときの cadence です。 */
export type PlanningCadence = {
  /** Cadence の calendar unit です。 */
  unit: 'week' | 'month'
  /** 1 cycle を構成する unit 数です。 */
  count: number
}

/** Cycle 終了時の未完了 Work Item の扱いです。 */
export type CycleCarryOverPolicy = 'move-incomplete' | 'keep-incomplete'

/** Goal / OKR hierarchy での entity の役割です。 */
export type PlanningGoalFramework = 'goal' | 'objective' | 'key-result'

/** Planning entity に追記する status update です。 */
export type PlanningStatusUpdate = {
  /** Entity 内で status update を識別する ID です。 */
  id: string
  /** Update 本文です。 */
  message: string
  /** Update を作成した Workspace member key です。 */
  authorMemberKey: string
  /** Update 時点で明示された health です。 */
  health?: PlanningHealth
  /** Update 時点で明示された risk です。 */
  risk?: PlanningRisk
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
}

/** Planning hierarchy に保存する versioned entity です。 */
export type PlanningEntity = {
  /** Workspace 内で entity を識別する ID です。 */
  id: string
  /** Entity の planning 種別です。 */
  type: PlanningEntityType
  /** UI に表示する title です。 */
  title: string
  /** Entity の説明です。UTF-8 で20 KBまでです。 */
  description?: string
  /** Hierarchy 上の親 entity ID です。 */
  parentId?: string
  /** Team scope の entity が参照する Team ID です。 */
  teamId?: string
  /** Project scope の entity が参照する Project ID です。 */
  projectId?: string
  /** Entity owner の Workspace member key です。 */
  ownerMemberKey: string
  /** Entity の lifecycle status です。 */
  status: PlanningEntityStatus
  /** Entity 自身に設定された health です。 */
  health: PlanningHealth
  /** 子孫を含めて算出した worst health です。 */
  rollupHealth: PlanningHealth
  /** Entity 自身に設定された risk level です。 */
  risk: PlanningRisk
  /** Progress の算出方法です。 */
  progressMode: PlanningProgressMode
  /** Manual mode で指定する 0 以上 100 以下の progress です。 */
  manualProgress?: number
  /** Read 時に算出した 0 以上 100 以下の progress です。 */
  progress: number
  /** Entity 直下または子孫から roll-up した一意な Work Item 件数です。 */
  linkedWorkItemCount: number
  /** 計画承認時点などに固定した baseline range です。 */
  baseline: PlanningDateRange
  /** 現在予測している forecast range です。 */
  forecast: PlanningDateRange
  /** Cycle の繰り返し間隔です。 */
  cadence?: PlanningCadence
  /** Cycle が保持できる Work Item 件数の非負整数です。 */
  capacity?: number
  /** Cycle rollover 時の未完了 Work Item policy です。 */
  carryOverPolicy?: CycleCarryOverPolicy
  /** Goal/OKR hierarchy 上の役割です。 */
  goalFramework?: PlanningGoalFramework
  /** 新しい順に最大32件保持する status update 一覧です。 */
  statusUpdates: PlanningStatusUpdate[]
  /** Soft archive した日時の ISO 8601 timestamp です。 */
  archivedAt?: string
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
  /** 最終更新日時の ISO 8601 timestamp です。 */
  updatedAt: string
}

/** Backwards-compatible name for a planning-entity dependency type. */
export type PlanningDependencyType = ScheduleDependencyType

/** Planning entity 間の directed dependency です。 */
export type PlanningDependency = {
  /** Workspace 内で dependency を識別する ID です。 */
  id: string
  /** Dependency の先行 entity ID です。 */
  predecessorId: string
  /** Dependency の後続 entity ID です。 */
  successorId: string
  /** Scheduling 制約の種別です。 */
  type: PlanningDependencyType
  /** Signed calendar-day offset; positive values are lag and negative values are lead. */
  lagDays: number
  /** Optional explicit date constraint on the successor planning entity. */
  constraint?: ScheduleDependencyConstraint
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
}

/** Planning entity と canonical Work Item の関連です。 */
export type PlanningWorkItemLink = {
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Team 内の Work Item ID です。 */
  workItemId: string
  /** Work Item の遂行先 Project ID です。 */
  projectId?: string
  /** Work Item が所属する Cycle ID です。 */
  cycleId?: string
  /** Work Item が寄与する Milestone ID です。 */
  milestoneId?: string
  /** Work Item が寄与する Goal / OKR entity ID 一覧です。 */
  goalIds: string[]
  /** Link 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
}

/** Roll-up と critical path に必要な canonical Work Item projection です。 */
export type PlanningWorkItemSummary = {
  /** Team 内の Work Item ID です。 */
  id: string
  /** Planning mutation の transaction condition に使う canonical revision です。 */
  revision: number
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Work Item title です。 */
  title: string
  /** Work Item の遂行先 Project ID です。 */
  projectId?: string
  /** Workflow を横断して利用する status category です。 */
  statusCategory: WorkflowStatusCategory
  /** Work Item 期限日です。 */
  dueDate: string
  /** Canonical Work Item schedule used by planning timelines and impact previews. */
  schedule: WorkItemSchedule
}

/** Planning snapshot から算出した critical path です。 */
export type PlanningCriticalPath = {
  /** Critical path 上の entity ID を先頭から並べた配列です。 */
  entityIds: string[]
  /** Critical path の合計 calendar day 数です。 */
  totalDurationDays: number
  /** Entity ID ごとの total slack day 数です。 */
  slackByEntityId: Record<string, number>
}

/** Planning API が返す Workspace 単位の整合した snapshot です。 */
export type PlanningSnapshot = {
  /** Snapshot schema version です。 */
  schemaVersion: typeof PLANNING_SCHEMA_VERSION
  /** Workspace planning graph の optimistic concurrency revision です。 */
  revision: number
  /** Archive 済みを含む planning entity 一覧です。 */
  entities: PlanningEntity[]
  /** Entity 間 dependency 一覧です。 */
  dependencies: PlanningDependency[]
  /** Canonical schedule dependencies between visible Work Items. */
  workItemDependencies: WorkItemScheduleDependency[]
  /** Planning entity と Work Item の link 一覧です。 */
  workItemLinks: PlanningWorkItemLink[]
  /** Roll-up に利用した Work Item projection 一覧です。 */
  workItems: PlanningWorkItemSummary[]
  /** Snapshot から算出した critical path です。 */
  criticalPath: PlanningCriticalPath
  /** Work Item dependency graph summary derived from this exact snapshot. */
  workItemDependencySummary: PlanningWorkItemDependencySummary
  /** 永続化済み graph の最終更新日時です。 */
  updatedAt?: string
}

/** Planning entity 作成 API の入力です。 */
export type CreatePlanningEntityInput = {
  /** 新しい entity ID です。 */
  id: string
  /** 新しい entity の種別です。 */
  type: PlanningEntityType
  /** 新しい entity の title です。 */
  title: string
  /** 新しい entity の説明です。 */
  description?: string
  /** Hierarchy 上の親 entity ID です。 */
  parentId?: string
  /** Team scope の Team ID です。 */
  teamId?: string
  /** Project scope の Project ID です。 */
  projectId?: string
  /** Owner の Workspace member key です。 */
  ownerMemberKey: string
  /** 初期 lifecycle status です。 */
  status: PlanningEntityStatus
  /** 初期 health です。 */
  health: PlanningHealth
  /** 初期 risk level です。 */
  risk: PlanningRisk
  /** Progress の算出方法です。 */
  progressMode: PlanningProgressMode
  /** Manual mode の progress です。 */
  manualProgress?: number
  /** Baseline range です。 */
  baseline: PlanningDateRange
  /** Forecast range です。 */
  forecast: PlanningDateRange
  /** Cycle cadence です。 */
  cadence?: PlanningCadence
  /** Cycle が保持できる Work Item 件数の非負整数です。 */
  capacity?: number
  /** Cycle rollover policy です。 */
  carryOverPolicy?: CycleCarryOverPolicy
  /** Goal/OKR hierarchy 上の役割です。 */
  goalFramework?: PlanningGoalFramework
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** Planning entity に適用できる field patch です。 */
export type PlanningEntityPatch = {
  /** 変更後の title です。 */
  title?: string
  /** 変更後の20 KB以下の description です。null で削除します。 */
  description?: string | null
  /** 変更後の owner Workspace member key です。 */
  ownerMemberKey?: string
  /** 変更後の lifecycle status です。 */
  status?: PlanningEntityStatus
  /** 変更後の health です。 */
  health?: PlanningHealth
  /** 変更後の risk level です。 */
  risk?: PlanningRisk
  /** 変更後の progress mode です。 */
  progressMode?: PlanningProgressMode
  /** 変更後の manual progress です。null で削除します。 */
  manualProgress?: number | null
  /** 変更後の baseline range です。 */
  baseline?: PlanningDateRange
  /** 変更後の forecast range です。 */
  forecast?: PlanningDateRange
  /** 変更後の Cycle cadence です。 */
  cadence?: PlanningCadence
  /** 変更後の Work Item 件数単位の Cycle capacity です。 */
  capacity?: number
  /** 変更後の Cycle rollover policy です。 */
  carryOverPolicy?: CycleCarryOverPolicy
  /** 変更後の Goal/OKR hierarchy 上の役割です。 */
  goalFramework?: PlanningGoalFramework
}

/** Planning entity 更新 API の入力です。 */
export type UpdatePlanningEntityInput = {
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
  /** Entity に適用する field patch です。 */
  patch: PlanningEntityPatch
}

/** Planning dependency 作成 API の入力です。 */
export type CreatePlanningDependencyInput = {
  /** 新しい dependency ID です。 */
  id: string
  /** 先行 entity ID です。 */
  predecessorId: string
  /** 後続 entity ID です。 */
  successorId: string
  /** Scheduling 制約の種別です。 */
  type: PlanningDependencyType
  /** Signed calendar-day lead or lag. */
  lagDays: number
  /** Optional explicit date constraint on the successor planning entity. */
  constraint?: ScheduleDependencyConstraint
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** Input used to create one canonical cross-Team Work Item schedule dependency. */
export type CreateWorkItemScheduleDependencyInput = {
  /** New Workspace-local dependency identifier. */
  id: string
  /** Work Item whose schedule drives the dependency. */
  predecessor: WorkItemDependencyEndpoint
  /** Work Item whose schedule is constrained. */
  successor: WorkItemDependencyEndpoint
  /** Start/finish boundary relationship. */
  type: ScheduleDependencyType
  /** Signed calendar-day lead or lag. */
  lagDays: number
  /** Optional explicit date constraint on the successor schedule. */
  constraint?: ScheduleDependencyConstraint
  /** Planning graph revision observed before the mutation. */
  expectedRevision: number
}

/** Editable fields of a canonical Work Item schedule dependency. */
export type WorkItemScheduleDependencyPatch = {
  /** Replacement start/finish boundary relationship. */
  type?: ScheduleDependencyType
  /** Replacement signed calendar-day lead or lag. */
  lagDays?: number
  /** Replacement constraint, or null to remove the current constraint. */
  constraint?: ScheduleDependencyConstraint | null
}

/** Input used to update a canonical Work Item schedule dependency. */
export type UpdateWorkItemScheduleDependencyInput = {
  /** Planning graph revision observed before the mutation. */
  expectedRevision: number
  /** Dependency fields to replace. */
  patch: WorkItemScheduleDependencyPatch
}

/** ID を path で指定する planning mutation の revision 入力です。 */
export type PlanningRevisionInput = {
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** Planning Work Item link upsert API の入力です。 */
export type PlanningWorkItemLinkInput = {
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Team 内の Work Item ID です。 */
  workItemId: string
  /** Work Item の遂行先 Project ID です。 */
  projectId?: string
  /** Work Item が所属する Cycle ID です。 */
  cycleId?: string
  /** Work Item が寄与する Milestone ID です。 */
  milestoneId?: string
  /** Work Item が寄与する Goal / OKR entity ID 一覧です。 */
  goalIds: string[]
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** Planning entity 複製 API の入力です。 */
export type DuplicatePlanningEntityInput = {
  /** 複製後の entity ID です。 */
  targetId: string
  /** 複製後に上書きする title です。 */
  title?: string
  /** 複製後の親 entity ID です。 */
  parentId?: string
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** Planning entity と子孫 subtree を原子的に move する API の入力です。 */
export type MovePlanningEntityInput = {
  /** Move 後の親 entity ID です。省略時は root へ移動します。 */
  parentId?: string
  /** Entity と子孫へ適用する Move 後の Team scope です。 */
  teamId?: string
  /** Entity と子孫へ適用する Move 後の Project scope です。 */
  projectId?: string
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** Planning entity status update 追加 API の入力です。 */
export type PlanningStatusUpdateInput = {
  /** 新しい status update ID です。 */
  id: string
  /** Status update 本文です。 */
  message: string
  /** Update と同時に設定する health です。 */
  health?: PlanningHealth
  /** Update と同時に設定する risk level です。 */
  risk?: PlanningRisk
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** Cycle rollover API の入力です。 */
export type CycleRolloverInput = {
  /** 未完了 Work Item の移動先 Cycle ID です。一度に検証できる link は49件までです。 */
  targetCycleId: string
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** Planning mutation の共通 response です。 */
export type PlanningMutationResponse = {
  /** Mutation 後に roll-up と critical path を再計算した snapshot です。 */
  planning: PlanningSnapshot
  /** Cycle rollover で移動した Work Item ID 一覧です。 */
  movedWorkItemIds: string[]
  /** Cycle rollover で元 Cycle に残した Work Item ID 一覧です。 */
  retainedWorkItemIds: string[]
}
