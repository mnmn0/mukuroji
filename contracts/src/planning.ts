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

/** Structured Planning update content の現行 version です。 */
export const PLANNING_UPDATE_CONTENT_VERSION = 1 as const

/** Project または Initiative の定期 update target です。 */
export type PlanningUpdateTarget =
  | {
      /** Directory project を target にする discriminator です。 */
      type: 'project'
      /** Project を所有する Team ID です。 */
      teamId: string
      /** Directory Project ID です。 */
      projectId: string
    }
  | {
      /** Planning initiative を target にする discriminator です。 */
      type: 'initiative'
      /** Initiative の Planning entity ID です。 */
      entityId: string
    }

/** Project / Initiative update の提出 cadence と通知先です。 */
export type PlanningUpdateCadence = {
  /** Update を提出する Workspace member key です。 */
  updateOwnerMemberKey: string
  /** Update の calendar-based interval です。 */
  cadence: PlanningCadence
  /** Due instant の local calendar 解釈に使う IANA time zone です。 */
  timeZone: string
  /** 次回提出期限の ISO 8601 timestamp です。 */
  nextDueAt: string
  /** Due より何時間前に owner へ reminder を送るかを表す非負整数です。 */
  reminderHoursBefore: number
  /** Due より何時間後に escalation するかを表す非負整数です。 */
  escalationHoursAfter?: number
  /** Escalation 通知を受け取る Workspace member key です。 */
  escalationMemberKey?: string
}

/** Health とは独立して算出する update の鮮度状態です。 */
export type PlanningUpdateState =
  | 'not-configured'
  | 'missing'
  | 'current'
  | 'overdue'
  | 'stale'

/** Publish 時に server が canonical state から固定する進捗 snapshot です。 */
export type PlanningUpdateProgressSnapshot = {
  /** 0 以上 100 以下の算出済み progress です。 */
  percent: number
  /** Progress 算出対象となった一意な Work Item 件数です。 */
  linkedWorkItemCount: number
}

/** Publish 時点の target scope です。 */
export type PlanningUpdateScopeSnapshot = {
  /** Target が属する Team ID です。 */
  teamId?: string
  /** Target が属する Project ID です。 */
  projectId?: string
}

/** Publish 時点に target 配下で観測した Milestone です。 */
export type PlanningUpdateMilestoneSnapshot = {
  /** Milestone の Planning entity ID です。 */
  entityId: string
  /** Milestone title です。 */
  title: string
  /** Milestone lifecycle status です。 */
  status: PlanningEntityStatus
  /** Milestone forecast range です。 */
  forecast: PlanningDateRange
}

/** Publish 時点に target と関係する Planning dependency です。 */
export type PlanningUpdateDependencySnapshot = {
  /** Planning dependency ID です。 */
  dependencyId: string
  /** 先行 Planning entity ID です。 */
  predecessorId: string
  /** 後続 Planning entity ID です。 */
  successorId: string
  /** Dependency の scheduling constraint 種別です。 */
  type: PlanningDependencyType
  /** Signed calendar-day lead / lag です。 */
  lagDays: number
}

/** Update 比較の基準となる immutable server snapshot です。 */
export type PlanningUpdateContextSnapshot = {
  /** Submitter が明示した health です。 */
  health: PlanningHealth
  /** Submitter が明示した risk level です。 */
  risk: PlanningRisk
  /** Canonical state から算出した progress です。 */
  progress: PlanningUpdateProgressSnapshot
  /** Target の Team / Project scope です。 */
  scope: PlanningUpdateScopeSnapshot
  /** Target の forecast end date です。 */
  targetDate?: string
  /** Target 配下の active Milestone snapshot です。 */
  milestones: PlanningUpdateMilestoneSnapshot[]
  /** Target に関係する Planning dependency snapshot です。 */
  dependencies: PlanningUpdateDependencySnapshot[]
}

/** Canonical Work Item を根拠として参照します。 */
export type PlanningUpdateWorkItemEvidence = {
  /** Work Item evidence の discriminator です。 */
  type: 'work-item'
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Team 内の Work Item ID です。 */
  workItemId: string
}

/** Planning entity を根拠として参照します。 */
export type PlanningUpdateEntityEvidence = {
  /** Planning entity evidence の discriminator です。 */
  type: 'planning-entity'
  /** Planning entity ID です。 */
  entityId: string
}

/** Workspace file を根拠として参照します。 */
export type PlanningUpdateFileEvidence = {
  /** File evidence の discriminator です。 */
  type: 'file'
  /** Workspace 内の File ID です。 */
  fileId: string
  /** File を開くための credential-free HTTPS permalink です。 */
  url: string
}

/** HTTPS link を根拠として参照します。 */
export type PlanningUpdateLinkEvidence = {
  /** Link evidence の discriminator です。 */
  type: 'link'
  /** Evidence の HTTPS URL です。 */
  url: string
  /** Link の任意表示 label です。 */
  label?: string
}

/** Manual update に紐付けられる typed evidence です。 */
export type PlanningUpdateEvidence =
  | PlanningUpdateWorkItemEvidence
  | PlanningUpdateEntityEvidence
  | PlanningUpdateFileEvidence
  | PlanningUpdateLinkEvidence

/** Scalar context field の前回 update との差分です。 */
export type PlanningUpdateScalarChange =
  | {
      /** Health change の discriminator です。 */
      type: 'health'
      /** 前回 update の health です。 */
      before: PlanningHealth
      /** 今回 update の health です。 */
      after: PlanningHealth
    }
  | {
      /** Risk change の discriminator です。 */
      type: 'risk'
      /** 前回 update の risk です。 */
      before: PlanningRisk
      /** 今回 update の risk です。 */
      after: PlanningRisk
    }
  | {
      /** Progress change の discriminator です。 */
      type: 'progress'
      /** 前回 update の progress percentage です。 */
      before: number
      /** 今回 update の progress percentage です。 */
      after: number
    }

/** Forecast target date の前回 update との差分です。 */
export type PlanningUpdateTargetDateChange = {
  /** Target date change の discriminator です。 */
  type: 'target-date'
  /** 前回 update の target date です。 */
  before?: string
  /** 今回 update の target date です。 */
  after?: string
}

/** Scope の前回 update との差分です。 */
export type PlanningUpdateScopeChange = {
  /** Scope change の discriminator です。 */
  type: 'scope'
  /** 前回 update の scope です。 */
  before: PlanningUpdateScopeSnapshot
  /** 今回 update の scope です。 */
  after: PlanningUpdateScopeSnapshot
}

/** Collection context の前回 update との差分です。 */
export type PlanningUpdateCollectionChange = {
  /** 比較対象 collection の discriminator です。 */
  type: 'milestones' | 'dependencies'
  /** 今回追加された canonical ID です。 */
  addedIds: string[]
  /** 今回削除された canonical ID です。 */
  removedIds: string[]
  /** 同じ ID の snapshot 内容が変わった canonical ID です。 */
  changedIds: string[]
}

/** Server が immutable context snapshots から算出した差分です。 */
export type PlanningUpdateChange =
  | PlanningUpdateScalarChange
  | PlanningUpdateTargetDateChange
  | PlanningUpdateScopeChange
  | PlanningUpdateCollectionChange

/** Full history に保存する immutable structured update です。 */
export type PlanningUpdate = {
  /** Client が割り当てる target-local update ID です。 */
  id: string
  /** Update 対象です。 */
  target: PlanningUpdateTarget
  /** Target 内で単調増加する version です。 */
  version: number
  /** Structured content schema version です。 */
  contentVersion: typeof PLANNING_UPDATE_CONTENT_VERSION
  /** Canonical update が manual publish されたことを示します。 */
  origin: 'manual'
  /** Submitter が明示した health です。 */
  health: PlanningHealth
  /** Submitter が明示した risk level です。 */
  risk: PlanningRisk
  /** Update の executive summary です。 */
  summary: string
  /** Risk の背景と影響です。 */
  riskSummary: string
  /** 今回の decision summary です。 */
  decisionSummary: string
  /** 必要な支援です。 */
  helpNeeded: string
  /** 次に実行する action です。 */
  nextAction: string
  /** Publish 時に server が算出した progress です。 */
  progressSnapshot: PlanningUpdateProgressSnapshot
  /** Publish 時に server が固定した比較用 context です。 */
  contextSnapshot: PlanningUpdateContextSnapshot
  /** 前回 immutable context との差分です。 */
  changes: PlanningUpdateChange[]
  /** Update の根拠一覧です。 */
  evidence: PlanningUpdateEvidence[]
  /** Update を作成した Workspace member key です。 */
  authorMemberKey: string
  /** この update が充足した due occurrence です。 */
  coveredDueAt: string
  /** Publish 日時の ISO 8601 timestamp です。 */
  createdAt: string
}

/** Planning graph snapshot に埋め込む latest update の bounded summary です。 */
export type PlanningLatestUpdateSummary = Pick<
  PlanningUpdate,
  | 'id'
  | 'version'
  | 'health'
  | 'risk'
  | 'summary'
  | 'progressSnapshot'
  | 'authorMemberKey'
  | 'coveredDueAt'
  | 'createdAt'
>

/** Snapshot 上の update target cadence と latest state です。 */
export type PlanningUpdateTargetSummary = {
  /** Project または Initiative target です。 */
  target: PlanningUpdateTarget
  /** Configured cadence です。未設定なら updateState は not-configured です。 */
  cadence?: PlanningUpdateCadence
  /** Health とは独立した read-time freshness です。 */
  updateState: PlanningUpdateState
  /** 最後に publish された immutable version。未投稿なら 0 です。 */
  latestVersion: number
  /** Latest update の bounded summary です。 */
  latestUpdate?: PlanningLatestUpdateSummary
  /** Initiative archive に伴い通知を停止した日時です。 */
  archivedAt?: string
  /** Target configuration または latest pointer の更新日時です。 */
  updatedAt: string
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
  /** Cadence と latest update だけを含む bounded target summary 一覧です。 */
  updateTargets: PlanningUpdateTargetSummary[]
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

/** Project / Initiative update cadence を設定または解除する入力です。 */
export type ConfigurePlanningUpdateCadenceInput = {
  /** Cadence を設定する Project または Initiative です。 */
  target: PlanningUpdateTarget
  /** 新しい cadence です。null で解除します。 */
  cadence: PlanningUpdateCadence | null
  /** 読み込み時点の Planning global revision です。 */
  expectedRevision: number
}

/** Human-authored structured update を immutable publish する入力です。 */
export type PublishPlanningUpdateInput = {
  /** Update を publish する Project または Initiative です。 */
  target: PlanningUpdateTarget
  /** Client が割り当てる target-local update ID です。 */
  id: string
  /** Submitter が明示する health です。 */
  health: PlanningHealth
  /** Submitter が明示する risk level です。 */
  risk: PlanningRisk
  /** Update の executive summary です。 */
  summary: string
  /** Risk の背景と影響です。 */
  riskSummary: string
  /** 今回の decision summary です。 */
  decisionSummary: string
  /** 必要な支援です。 */
  helpNeeded: string
  /** 次に実行する action です。 */
  nextAction: string
  /** Update の根拠一覧です。 */
  evidence: PlanningUpdateEvidence[]
  /** 読み込み時点の Planning global revision です。 */
  expectedRevision: number
}

/** Immutable update history を cursor pagination で取得する入力です。 */
export type ListPlanningUpdatesInput = {
  /** History を取得する Project または Initiative です。 */
  target: PlanningUpdateTarget
  /** 1 page に返す件数です。 */
  limit?: number
  /** Server が返した opaque pagination cursor です。 */
  cursor?: string
}

/** Target-local immutable update history の1 page です。 */
export type PlanningUpdateHistoryPage = {
  /** 新しい順に並んだ immutable update 一覧です。 */
  updates: PlanningUpdate[]
  /** 続きがある場合に返す opaque cursor です。 */
  nextCursor?: string
}

/** Immutable Planning update に付与する append-only comment です。 */
export type PlanningUpdateComment = {
  /** Update 内で comment を識別する client-generated ID です。 */
  id: string
  /** Comment 対象の Project または Initiative です。 */
  target: PlanningUpdateTarget
  /** Comment 対象の immutable update version です。 */
  updateVersion: number
  /** Comment 本文です。 */
  body: string
  /** Comment を作成した Workspace member key です。 */
  authorMemberKey: string
  /** Comment 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
}

/** Immutable update comment を作成する入力です。 */
export type CreatePlanningUpdateCommentInput = {
  /** Comment 対象の Project または Initiative です。 */
  target: PlanningUpdateTarget
  /** Comment 対象の immutable update version です。 */
  updateVersion: number
  /** Client-generated comment ID です。 */
  id: string
  /** Comment 本文です。 */
  body: string
}

/** Update comment history を cursor pagination で取得する入力です。 */
export type ListPlanningUpdateCommentsInput = {
  /** Comment 対象の Project または Initiative です。 */
  target: PlanningUpdateTarget
  /** Comment 対象の immutable update version です。 */
  updateVersion: number
  /** 1 page に返す件数です。 */
  limit?: number
  /** Server が返した opaque pagination cursor です。 */
  cursor?: string
}

/** Immutable update comments の1 page です。 */
export type PlanningUpdateCommentPage = {
  /** 新しい順に並んだ append-only comments です。 */
  comments: PlanningUpdateComment[]
  /** 続きがある場合に返す opaque cursor です。 */
  nextCursor?: string
}

/** Immutable Planning update に付与する member reaction です。 */
export type PlanningUpdateReaction = {
  /** Reaction 対象の Project または Initiative です。 */
  target: PlanningUpdateTarget
  /** Reaction 対象の immutable update version です。 */
  updateVersion: number
  /** Unicode emoji または bounded reaction token です。 */
  emoji: string
  /** Reaction を付与した Workspace member key です。 */
  memberKey: string
  /** Reaction 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
}

/** Planning update reaction の追加・削除入力です。 */
export type PlanningUpdateReactionInput = {
  /** Reaction 対象の Project または Initiative です。 */
  target: PlanningUpdateTarget
  /** Reaction 対象の immutable update version です。 */
  updateVersion: number
  /** Unicode emoji または bounded reaction token です。 */
  emoji: string
}

/** Update reactions を cursor pagination で取得する入力です。 */
export type ListPlanningUpdateReactionsInput = {
  /** Reaction 対象の Project または Initiative です。 */
  target: PlanningUpdateTarget
  /** Reaction 対象の immutable update version です。 */
  updateVersion: number
  /** 1 page に返す件数です。 */
  limit?: number
  /** Server が返した opaque pagination cursor です。 */
  cursor?: string
}

/** Immutable update reactions の1 page です。 */
export type PlanningUpdateReactionPage = {
  /** Stable key 順に並んだ member reactions です。 */
  reactions: PlanningUpdateReaction[]
  /** 続きがある場合に返す opaque pagination cursor です。 */
  nextCursor?: string
}

/** Cadence mutation の response です。 */
export type PlanningUpdateCadenceMutationResponse = {
  /** Mutation 後の Planning graph snapshot です。 */
  planning: PlanningSnapshot
  /** Mutation 後の target summary です。 */
  updateTarget: PlanningUpdateTargetSummary
}

/** Manual structured update publish の response です。 */
export type PlanningUpdatePublishResponse = {
  /** Mutation 後の Planning graph snapshot です。 */
  planning: PlanningSnapshot
  /** 今回 append-only 保存した immutable update です。 */
  update: PlanningUpdate
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
