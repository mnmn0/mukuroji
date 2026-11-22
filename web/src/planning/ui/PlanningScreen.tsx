import type {
  CreatePlanningEntityInput,
  PlanningDependency,
  PlanningEntity,
  PlanningEntityPatch,
  PlanningEntityStatus,
  PlanningEntityType,
  PlanningGoalFramework,
  PlanningHealth,
  PlanningRisk,
  PlanningCapacity,
  PlanningSnapshot,
  ScheduleDependencyConstraint,
  ScheduleDependencyType,
  WorkItemDependencyEndpoint,
  WorkItemScheduleDependency,
  WorkItemScheduleDependencyPatch,
  PlanningWorkItemLink,
  PlanningWorkItemSummary,
  WorkItemAffectedProject,
} from '@mukuroji/contracts'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type { WorkItemDependencyCreateDraft } from '../../work-items/model/workItemDependencies'
import { WorkItemDependencyPanel } from '../../work-items/ui/WorkItemDependencyPanel'
import {
  createPlanningDependencyAnchorId,
  resolvePlanningViewTabTarget,
  type PlanningViewId,
} from '../../shared/routing/paths'
import {
  resolvePlanningMoveSelection,
  resolvePlanningParentCandidates,
  type PlanningMoveSelection,
} from '../model/hierarchy'
import type { PlanningScope } from '../model/permissions'
import {
  createPlanningUpdateEvidenceCandidates,
  createMissingPlanningTargetUpdateView,
  planningUpdateTargetsAreEqual,
  type PlanningStatusUpdateDraft,
  type PlanningTargetUpdateView,
  type PlanningUpdateCadenceDraft,
  type PlanningUpdateCollaborationController,
  type PlanningUpdateTargetDetailView,
  type PlanningUpdateTargetSummaryView,
  type PlanningUpdateTargetView,
} from '../model/statusUpdateView'
import {
  createPlanningEntityDetailKey,
  isOpenPlanningEntity,
  isPlanningWorkItemLinkCandidate,
  resolvePlanningCycleRolloverTargets,
} from '../model/selectors'
import { createPlanningUpdateTargetKey } from '../model/targetKey'
import type { PlanningTargetBaselineDelays } from '../model/baselineDelayEvidence'
import type { CrossProjectTimelineDirectoryTeam } from '../model/crossProjectTimeline'
import {
  CrossProjectTimelineChart,
  type CrossProjectTimelineLabels,
} from './CrossProjectTimelineChart'
import {
  PlanningArchivePanel,
  type PlanningArchiveController,
  type PlanningArchiveLabels,
} from './PlanningArchivePanel'
import { CyclePlanningPanel, type CyclePlanningLabels, type CyclePlanningPanelProps } from './CyclePlanningPanel'
import {
  PlanningEntityEditor,
  type PlanningEntityEditorLabels,
} from './PlanningEntityEditor'
import {
  collectPlanningOwnerCandidates,
  countCycleWorkItems,
  DEFAULT_CYCLE_CAPACITY,
  resolvePlanningOwnerOptions,
  type PlanningOwnerOption,
} from '../model/entityEditor'
import {
  PlanningLatestUpdateSummary,
  PlanningUpdateDetailPane,
  PlanningUpdateFreshnessBadge,
  type PlanningUpdateLabels,
  type PlanningStatusUpdateAiAssistance,
} from './PlanningUpdatePrimitives'

/**
 * PlanningScreen が表示する locale 済み文言です。
 */
export type PlanningLabels = PlanningUpdateLabels & {
  /** Cycle planning panel の文言です。 */
  cyclePlanning: CyclePlanningLabels
  /** Planning 画面の eyebrow です。 */
  eyebrow: string
  /** Planning 画面の見出しです。 */
  title: string
  /** Planning 画面の説明です。 */
  description: string
  /** View tablist の accessible name です。 */
  viewTabs: string
  /** Timeline tab の文言です。 */
  timeline: string
  /** Roadmap tab の文言です。 */
  roadmap: string
  /** Portfolio tab の文言です。 */
  portfolio: string
  /** 初回 loading の文言です。 */
  loading: string
  /** Planning API error の fallback 文言です。 */
  error: string
  /** API 再試行ボタンの文言です。 */
  retry: string
  /** Empty state の見出しです。 */
  emptyTitle: string
  /** Empty state の説明です。 */
  emptyDescription: string
  /** Project 横断 timeline chart の文言です。 */
  crossProjectTimeline: CrossProjectTimelineLabels
  /** Timeline section の見出しです。 */
  timelineTitle: string
  /** Timeline section の説明です。 */
  timelineDescription: string
  /** Baseline date の列見出しです。 */
  baseline: string
  /** Forecast date の列見出しです。 */
  forecast: string
  /** Progress の列見出しです。 */
  progress: string
  /** Owner の列見出しです。 */
  owner: string
  /** Placeholder of the owner picker in the create form. */
  ownerPlaceholder: string
  /** Health の列見出しです。 */
  health: string
  /** Risk の列見出しです。 */
  risk: string
  /** Status の列見出しです。 */
  status: string
  /** Linked Work Item 件数の列見出しです。 */
  linkedWorkItems: string
  /** Critical path の badge 文言です。 */
  criticalPath: string
  /** Critical path 日数を表示する formatter です。 */
  criticalPathDays: (days: number) => string
  /** Entity slack 日数を表示する formatter です。 */
  slackDays: (days: number) => string
  /** 百分率を表示する formatter です。 */
  percent: (value: number) => string
  /** Work Item 件数を表示する formatter です。 */
  workItemCount: (count: number) => string
  /** Milestone 編集 section の見出しです。 */
  milestoneEditor: string
  /** Milestone forecast date field の文言です。 */
  milestoneDate: string
  /** 保存ボタンの文言です。 */
  save: string
  /** Dependency 編集 section の見出しです。 */
  dependencyEditor: string
  /** Dependency predecessor field の文言です。 */
  predecessor: string
  /** Dependency successor field の文言です。 */
  successor: string
  /** Dependency type field の文言です。 */
  dependencyType: string
  /** Dependency lag 日数 field の文言です。 */
  dependencyLag: string
  /** Dependency 追加ボタンの文言です。 */
  addDependency: string
  /** Cycle rollover section の見出しです。 */
  cycleRollover: string
  /** Rollover 元 Cycle field の文言です。 */
  sourceCycle: string
  /** Rollover 先 Cycle field の文言です。 */
  targetCycle: string
  /** Cycle rollover 実行ボタンの文言です。 */
  rollover: string
  /** Closed Cycle が rollover できないことを示す文言です。 */
  closedCycleRollover: string
  /** 条件を満たす rollover target がない場合の文言です。 */
  noRolloverTarget: string
  /** Cycle capacity を表示する formatter です。 */
  capacity: (value: number) => string
  /** Roadmap section の見出しです。 */
  roadmapTitle: string
  /** Roadmap section の説明です。 */
  roadmapDescription: string
  /** Goal から辿れる Work Item section の見出しです。 */
  goalWorkItems: string
  /** Goal に Work Item がない場合の文言です。 */
  noGoalWorkItems: string
  /** Work Item を開くボタンの文言です。 */
  openWorkItem: string
  /** Entity 操作 section の見出しです。 */
  entityActions: string
  /** Archive ボタンの文言です。 */
  archive: string
  /** Duplicate ボタンの文言です。 */
  duplicate: string
  /** Move target field の文言です。 */
  moveTarget: string
  /** Root へ移動する option の文言です。 */
  moveToRoot: string
  /** Move ボタンの文言です。 */
  move: string
  /** 操作権限がない場合の文言です。 */
  readOnly: string
  /** Live Planning graph の使用量を表示する formatter です。 */
  capacityUsage: (capacity: PlanningCapacity) => string
  /** 使用量が警告閾値を超えたときの案内です。 */
  capacityWarning: string
  /** 使用量が上限に達したときの案内です。 */
  capacityFull: string
  /** Archive 済みの計画の一覧と復元の文言です。 */
  archivedPlans: PlanningArchiveLabels
  /** 選択中の entity を編集する form の文言です。 */
  entityEditor: PlanningEntityEditorLabels
  /** Portfolio section の見出しです。 */
  portfolioTitle: string
  /** Portfolio section の説明です。 */
  portfolioDescription: string
  /** Entity name の列見出しです。 */
  entity: string
  /** Entity type field の文言です。 */
  entityType: string
  /** Team scope field の文言です。 */
  team: string
  /** Project scope field の文言です。 */
  project: string
  /** Date range 開始 field の文言です。 */
  startDate: string
  /** Date range 終了 field の文言です。 */
  endDate: string
  /** Entity 作成 section の見出しです。 */
  createEntity: string
  /** Entity 作成ボタンの文言です。 */
  create: string
  /** Cadence week option の文言です。 */
  cadenceWeek: string
  /** Cadence month option の文言です。 */
  cadenceMonth: string
  /** Carry-over move option の文言です。 */
  carryOverMove: string
  /** Carry-over keep option の文言です。 */
  carryOverKeep: string
  /** Work Item link editor の見出しです。 */
  workItemLinkEditor: string
  /** Work Item field の文言です。 */
  workItem: string
  /** Cycle field の文言です。 */
  cycle: string
  /** Milestone field の文言です。 */
  milestone: string
  /** Goal field の文言です。 */
  goal: string
  /** Goal / OKR framework field の文言です。 */
  goalFramework: string
  /** Work Item link 保存ボタンの文言です。 */
  linkWorkItem: string
  /** Work Item link 削除ボタンの文言です。 */
  unlinkWorkItem: string
  /** Dependency 削除ボタンの文言です。 */
  deleteDependency: string
  /** Reported health を示す文言です。 */
  reportedHealth: string
  /** Roll-up health を示す文言です。 */
  rollupHealth: string
  /** Status update 履歴が空の場合の文言です。 */
  noStatusUpdates: string
  /** Status update の author と日時を表示する formatter です。 */
  statusUpdateMeta: (authorMemberKey: string, createdAt: string) => string
  /** Planning entity type ごとの文言です。 */
  entityTypes: Record<PlanningEntityType, string>
  /** Planning entity status ごとの文言です。 */
  statuses: Record<PlanningEntityStatus, string>
  /** Planning health ごとの文言です。 */
  healthValues: Record<PlanningHealth, string>
  /** Planning risk ごとの文言です。 */
  riskValues: Record<PlanningRisk, string>
  /** Dependency type ごとの文言です。 */
  dependencyTypes: Record<ScheduleDependencyType, string>
  /** Work Item dependency editor の locale 済み文言を解決します。 */
  workItemDependencyT: (key: MessageKey) => string
  /** Goal / OKR framework ごとの文言です。 */
  goalFrameworkValues: Record<PlanningGoalFramework, string>
}

/**
 * PlanningScreen の入力です。
 */
export type PlanningScreenProps = {
  /** Optional AI generation access; target identity and revision are derived from the visible snapshot. */
  aiAssistance?: PlanningScreenAiAssistance
  /** 現在表示している Planning view です。 */
  activeView: PlanningViewId
  /** 画面で使う locale 済み文言です。 */
  labels: PlanningLabels
  /** API から取得した planning snapshot です。 */
  snapshot?: PlanningSnapshot
  /** 初回 snapshot を読み込み中かどうかです。 */
  isLoading?: boolean
  /** Snapshot 取得または mutation の error message です。 */
  errorMessage?: string
  /** Recoverable Project directory or role verification error shown without hiding Planning data. */
  accessErrorMessage?: string
  /** URL から初期選択する entity ID です。 */
  initialSelectedEntityId?: string
  /** URL から初期選択する Project または Initiative update target です。 */
  initialSelectedUpdateTarget?: PlanningUpdateTargetView
  /** 表示可能な Project / Initiative update stream です。 */
  updateTargetDetails?: readonly PlanningUpdateTargetDetailView[]
  /** 選択 target の full immutable history を読み込み中かどうかです。 */
  isUpdateHistoryLoading?: boolean
  /** 選択 target に次の immutable history page があるかどうかです。 */
  hasMoreUpdateHistory?: boolean
  /** 選択 target の次の immutable history page を読み込み中かどうかです。 */
  isLoadingMoreUpdateHistory?: boolean
  /** 選択 target の history query error message です。 */
  updateHistoryErrorMessage?: string
  /** 選択 target の watch/export/comment/reaction controller です。 */
  updateCollaboration?: PlanningUpdateCollaborationController
  /** Current user が entity の構造を管理できるか判定する callback です。 */
  canManageEntity?: (entity: PlanningEntity) => boolean
  /** Current user が entity を指定 scope に作成できるか判定する callback です。 */
  canCreateInScope?: (scope: PlanningScope) => boolean
  /** Entity 作成 form に表示する管理可能な Team / Project scope です。 */
  createScopeTeams?: readonly ProjectDirectoryTeam[]
  /** Readable Project directory used to name groups on the cross-Project timeline. */
  directoryTeams?: readonly CrossProjectTimelineDirectoryTeam[]
  /**
   * Workspace members suggested by the owner fields of the create form and the entity editor.
   * The owner can always be typed as a member key.
   */
  ownerOptions?: readonly PlanningOwnerOption[]
  /** Message shown when some or all members could not be loaded for the owner fields. */
  ownerOptionsErrorMessage?: string
  /** Reloads the owner field members after a failure. */
  onRetryOwnerOptions?: () => void
  /** Current user が target の update schedule を管理できるか判定する callback です。 */
  canManageUpdateCadence?: (target: PlanningUpdateTargetView) => boolean
  /** Current user が target に manual update を公開できるか判定する callback です。 */
  canPublishUpdate?: (target: PlanningUpdateTargetView) => boolean
  /** Current user が canonical Work Item の Planning link を更新できるか判定する callback です。 */
  canUpdateWorkItemLink?: (workItem: PlanningWorkItemSummary) => boolean
  /** Current user が canonical dependency endpoint を管理できるか判定する callback です。 */
  canManageWorkItemDependencyEndpoint?: (endpoint: WorkItemDependencyEndpoint) => boolean
  /** Current user が Work Item link から entity を参照できるか判定する callback です。 */
  canLinkEntity?: (entity: PlanningEntity) => boolean
  /** View tab 選択時の callback です。 */
  onViewChange?: (view: PlanningViewId) => void
  /** Project または Initiative update target 選択時の callback です。 */
  onSelectUpdateTarget?: (target: PlanningUpdateTargetView) => void
  /** Snapshot 再取得 callback です。 */
  onRetry?: () => void
  /** Retries Project directory and role verification queries. */
  onRetryAccess?: () => void
  /** 選択 target の immutable history を再取得する callback です。 */
  onRetryUpdateHistory?: () => void
  /** 選択 target の次の immutable history page を取得する callback です。 */
  onLoadMoreUpdateHistory?: () => void | Promise<void>
  /** Planning entity 作成 callback です。 */
  onCreateEntity?: (
    input: Omit<CreatePlanningEntityInput, 'expectedRevision'>,
  ) => void | Promise<void>
  /** Milestone forecast date 保存 callback です。 */
  onChangeMilestoneDate?: (entity: PlanningEntity, date: string) => void | Promise<void>
  /** Dependency 作成 callback です。 */
  onCreateDependency?: (
    predecessorId: string,
    successorId: string,
    type: ScheduleDependencyType,
    lagDays: number,
    constraint?: ScheduleDependencyConstraint,
  ) => void | Promise<void>
  /** Dependency 削除 callback です。 */
  onDeleteDependency?: (dependency: PlanningDependency) => void | Promise<void>
  /** Canonical Work Item schedule dependency 作成 callback です。 */
  onCreateWorkItemDependency?: (
    input: WorkItemDependencyCreateDraft,
  ) => void | Promise<void>
  /** Canonical Work Item schedule dependency 削除 callback です。 */
  onDeleteWorkItemDependency?: (
    dependency: WorkItemScheduleDependency,
  ) => void | Promise<void>
  /** Canonical Work Item schedule dependency 更新 callback です。 */
  onUpdateWorkItemDependency?: (
    dependency: WorkItemScheduleDependency,
    patch: WorkItemScheduleDependencyPatch,
  ) => void | Promise<void>
  /** Cycle rollover callback です。 */
  onRolloverCycle?: (
    sourceCycle: PlanningEntity,
    targetCycleId: string,
  ) => void | Promise<void>
  /** 次の Cycle を作る callback です。 */
  onCreateNextCycle?: CyclePlanningPanelProps['onCreateNextCycle']
  /** Cycle の自動化を保存する callback です。 */
  onUpdateCycleAutomation?: CyclePlanningPanelProps['onUpdateCycleAutomation']
  /** 複数の Work Item を Cycle に入れる、または外す callback です。 */
  onSetCycleWorkItems?: CyclePlanningPanelProps['onSetCycleWorkItems']
  /** Timeline で Cycle を選んだときに表示する burndown を描きます。省略すると表示しません。 */
  renderCycleBurndown?: (cycle: PlanningEntity) => ReactNode
  /** Entity archive callback です。 */
  onArchiveEntity?: (entity: PlanningEntity) => void | Promise<void>
  /** Archive 済みの計画の一覧と復元です。省略すると一覧を表示しません。 */
  archive?: PlanningArchiveController
  /** Entity duplicate callback です。 */
  onDuplicateEntity?: (entity: PlanningEntity) => void | Promise<void>
  /** Entity move callback です。 */
  onMoveEntity?: (
    entity: PlanningEntity,
    target: PlanningMoveSelection,
  ) => void | Promise<void>
  /** 選択中の entity の title・owner・status・health・risk・progress・日付を保存する callback です。 */
  onUpdateEntity?: (
    entity: PlanningEntity,
    patch: PlanningEntityPatch,
  ) => void | Promise<void>
  /** Project または Initiative の recurring update schedule を保存する callback です。 */
  onSaveUpdateCadence?: (
    target: PlanningUpdateTargetView,
    draft: PlanningUpdateCadenceDraft,
  ) => void | Promise<void>
  /** Project または Initiative の structured manual update を公開する callback です。 */
  onPublishUpdate?: (
    target: PlanningUpdateTargetView,
    draft: PlanningStatusUpdateDraft,
  ) => void | Promise<void>
  /** Work Item planning link 保存 callback です。 */
  onSaveWorkItemLink?: (
    workItem: PlanningWorkItemSummary,
    cycleId: string | undefined,
    milestoneId: string | undefined,
    goalIds: string[],
  ) => void | Promise<void>
  /** Work Item planning link 削除 callback です。 */
  onDeleteWorkItemLink?: (workItem: PlanningWorkItemSummary) => void | Promise<void>
  /** Goal から Work Item を開く callback です。 */
  onOpenWorkItem?: (workItem: PlanningWorkItemSummary) => void
  /** Dependency summary から影響 Project を開く callback です。 */
  onOpenProject?: (project: WorkItemAffectedProject) => void
  /** Dependency summary から影響 Milestone を開く callback です。 */
  onOpenMilestone?: (milestoneId: string) => void
  /**
   * Records behind the schedule baseline in the selected update target, which the composer can
   * attach as evidence. They are shown only while their target is the one shown.
   */
  updateBaselineDelays?: PlanningTargetBaselineDelays
}

/** Authentication and locale used to derive a selected target's AI source. */
export type PlanningScreenAiAssistance = {
  /** Active Workspace member bearer token. */
  accessToken: string
  /** Reports authenticated AI failures to the owning Planning route session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /** Locale sent to Bedrock and used for draft presentation. */
  locale: Locale
}

const timelineEntityTypes = new Set<PlanningEntityType>([
  'cycle',
  'milestone',
  'release',
  'phase',
])
const planningViews: readonly PlanningViewId[] = ['timeline', 'roadmap', 'portfolio']

/**
 * Timeline、roadmap、portfolio を同じ snapshot から描画します。
 */
export function PlanningScreen({
  accessErrorMessage,
  activeView,
  aiAssistance,
  archive,
  canCreateInScope,
  canLinkEntity,
  canManageUpdateCadence,
  canManageEntity,
  canManageWorkItemDependencyEndpoint,
  canPublishUpdate,
  canUpdateWorkItemLink,
  createScopeTeams = [],
  directoryTeams,
  errorMessage,
  onRetryOwnerOptions,
  ownerOptions = [],
  ownerOptionsErrorMessage,
  hasMoreUpdateHistory = false,
  initialSelectedEntityId,
  initialSelectedUpdateTarget,
  isLoading = false,
  isUpdateHistoryLoading = false,
  isLoadingMoreUpdateHistory = false,
  labels,
  onArchiveEntity,
  onChangeMilestoneDate,
  onCreateDependency,
  onCreateWorkItemDependency,
  onCreateEntity,
  onDeleteDependency,
  onDeleteWorkItemDependency,
  onDeleteWorkItemLink,
  onDuplicateEntity,
  onMoveEntity,
  onUpdateEntity,
  onLoadMoreUpdateHistory,
  onOpenMilestone,
  onOpenProject,
  onOpenWorkItem,
  onPublishUpdate,
  onSaveUpdateCadence,
  onSaveWorkItemLink,
  onSelectUpdateTarget,
  onRetry,
  onRetryAccess,
  onRetryUpdateHistory,
  onRolloverCycle,
  onCreateNextCycle,
  onUpdateCycleAutomation,
  onSetCycleWorkItems,
  onViewChange,
  onUpdateWorkItemDependency,
  renderCycleBurndown,
  snapshot,
  updateCollaboration,
  updateBaselineDelays,
  updateHistoryErrorMessage,
  updateTargetDetails = [],
}: PlanningScreenProps) {
  const activeEntities = useMemo(
    () => snapshot?.entities.filter((entity) => !entity.archivedAt) ?? [],
    [snapshot],
  )
  const moveScope: PlanningMoveScope = {
    allowWorkspace: canCreateInScope?.({}) ?? true,
    teams: filterPlanningScopeTeams(createScopeTeams, canCreateInScope),
  }
  const resolvedOwnerOptions = resolvePlanningOwnerOptions(
    ownerOptions,
    collectPlanningOwnerCandidates(activeEntities),
  )
  const ownerNotice = ownerOptionsErrorMessage ? (
    <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--workbench-danger)]" role="status">
      {ownerOptionsErrorMessage}
      {onRetryOwnerOptions ? (
        <button className="workbench-button-secondary min-h-8 px-3" type="button" onClick={onRetryOwnerOptions}>
          {labels.retry}
        </button>
      ) : null}
    </p>
  ) : undefined
  const [selectedEntityId, setSelectedEntityId] = useState(initialSelectedEntityId)
  const [selectedUpdateTarget, setSelectedUpdateTarget] = useState(initialSelectedUpdateTarget)
  const [isAiOperationPending, setIsAiOperationPending] = useState(false)
  const isAiOperationPendingRef = useRef(false)
  const pendingViewFocus = useRef<PlanningViewId | undefined>(undefined)

  /** Keeps Planning target controls fenced while an AI operation is pending. */
  const reportAiOperationPending = (pending: boolean) => {
    isAiOperationPendingRef.current = pending
    setIsAiOperationPending(pending)
  }
  const selectedEntity = activeEntities.find((entity) => entity.id === selectedEntityId) ??
    activeEntities.find((entity) => entity.type === 'goal') ?? activeEntities[0]
  const resolvedSelectedUpdateTarget = selectedUpdateTarget ??
    (selectedEntity ? resolvePlanningEntityUpdateTarget(selectedEntity) : undefined)
  const selectedEntityUpdateTarget = selectedEntity
    ? resolvePlanningEntityUpdateTarget(selectedEntity)
    : undefined
  const selectedUpdateDetail = resolvedSelectedUpdateTarget
    ? resolvePlanningUpdateTargetDetail(updateTargetDetails, resolvedSelectedUpdateTarget)
    : undefined
  const selectedUpdateSummary = selectedUpdateDetail?.summary ?? (
    selectedEntity && selectedEntityUpdateTarget && resolvedSelectedUpdateTarget &&
      planningUpdateTargetsAreEqual(selectedEntityUpdateTarget, resolvedSelectedUpdateTarget)
      ? createPlanningUpdateTargetSummary(
          selectedEntity,
          resolvedSelectedUpdateTarget,
          createScopeTeams,
        )
      : undefined
  )
  const selectedUpdateView = selectedUpdateDetail?.updateView ?? (
    resolvedSelectedUpdateTarget
      ? createMissingPlanningTargetUpdateView(resolvedSelectedUpdateTarget)
      : undefined
  )
  const selectedUpdateEvidenceCandidates = snapshot && resolvedSelectedUpdateTarget
    ? createPlanningUpdateEvidenceCandidates(snapshot, resolvedSelectedUpdateTarget)
    : undefined
  const canPublishSelectedUpdate = resolvedSelectedUpdateTarget
    ? canPublishUpdate?.(resolvedSelectedUpdateTarget) ?? true
    : false
  const selectedBaselineDelays = updateBaselineDelays && resolvedSelectedUpdateTarget &&
    onPublishUpdate && canPublishSelectedUpdate &&
    planningUpdateTargetsAreEqual(updateBaselineDelays.target, resolvedSelectedUpdateTarget)
    ? updateBaselineDelays.delays
    : undefined
  const selectedAiAssistance: PlanningStatusUpdateAiAssistance | undefined =
    aiAssistance && snapshot && resolvedSelectedUpdateTarget && onPublishUpdate && canPublishSelectedUpdate
      ? {
          accessToken: aiAssistance.accessToken,
          onAuthenticatedApiError: aiAssistance.onAuthenticatedApiError,
          isAiOperationPending,
          onOperationPendingChange: reportAiOperationPending,
          locale: aiAssistance.locale,
          source: {
            expectedRevision: snapshot.revision,
            target: resolvedSelectedUpdateTarget,
            type: 'planning-target',
          },
        }
      : undefined

  /** Selects a planning row and forwards its Project or Initiative update target. */
  const handleSelectEntity = (entityId: string) => {
    if (isAiOperationPendingRef.current) return
    const entity = activeEntities.find((candidate) => candidate.id === entityId)
    const target = entity ? resolvePlanningEntityUpdateTarget(entity) : undefined
    setSelectedEntityId(entityId)
    setSelectedUpdateTarget(target)
    if (target) onSelectUpdateTarget?.(target)
  }

  useEffect(() => {
    if (pendingViewFocus.current !== activeView) return
    document.getElementById(`planning-view-${activeView}`)?.focus()
    pendingViewFocus.current = undefined
  }, [activeView])

  const handleViewTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    view: PlanningViewId,
  ) => {
    const nextView = resolvePlanningViewTabTarget(view, event.key)
    if (!nextView) return

    event.preventDefault()
    pendingViewFocus.current = nextView
    onViewChange?.(nextView)
  }

  return (
    <section className="workbench-main min-h-svh bg-[var(--workbench-bg)]" data-testid="planning-screen">
      <header className="workbench-header px-[clamp(20px,3vw,34px)] py-5">
        <p className="workbench-eyebrow">{labels.eyebrow}</p>
        <h1 className="workbench-title mt-2 text-page-title">{labels.title}</h1>
        <p className="workbench-description mt-2 max-w-[820px]">{labels.description}</p>
        {snapshot ? (
          <p
            className="mt-2 text-xs font-medium text-[var(--workbench-muted)]"
            data-testid="planning-capacity-usage"
          >
            {labels.capacityUsage(snapshot.capacity)}
          </p>
        ) : null}
        <div
          aria-label={labels.viewTabs}
          className="mt-5 flex flex-wrap gap-2"
          role="tablist"
        >
          {planningViews.map((view) => (
            <button
              aria-controls="planning-view-panel"
              aria-selected={activeView === view}
              className={activeView === view
                ? 'workbench-button-primary min-h-10 px-4'
                : 'workbench-button-secondary min-h-10 px-4'}
              data-testid={`planning-view-${view}`}
              id={`planning-view-${view}`}
              key={view}
              tabIndex={activeView === view ? 0 : -1}
              role="tab"
              type="button"
              onClick={() => onViewChange?.(view)}
              onKeyDown={(event) => handleViewTabKeyDown(event, view)}
            >
              {labels[view]}
            </button>
          ))}
        </div>
      </header>

      <div
        aria-labelledby={`planning-view-${activeView}`}
        className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5"
        id="planning-view-panel"
        role="tabpanel"
        tabIndex={0}
      >
        {snapshot && snapshot.capacity.level !== 'normal' ? (
          <div
            className={snapshot.capacity.level === 'full'
              ? 'rounded-lg border border-red-200 bg-red-50 px-4 py-3'
              : 'rounded-lg border border-amber-300 bg-amber-50 px-4 py-3'}
            data-testid="planning-capacity-warning"
            role="status"
          >
            <p
              className={snapshot.capacity.level === 'full'
                ? 'max-w-[820px] text-sm font-semibold text-fg-red-800'
                : 'max-w-[820px] text-sm font-semibold text-fg-amber-900'}
            >
              {snapshot.capacity.level === 'full' ? labels.capacityFull : labels.capacityWarning}
            </p>
          </div>
        ) : null}
        {errorMessage ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3" role="alert">
            <p className="text-sm font-semibold text-fg-red-800">{errorMessage || labels.error}</p>
            {onRetry ? (
              <button className="workbench-button-secondary min-h-9 px-3" onClick={onRetry} type="button">
                {labels.retry}
              </button>
            ) : null}
          </div>
        ) : null}
        {accessErrorMessage ? (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
            data-testid="planning-access-error"
            role="alert"
          >
            <p className="max-w-[820px] text-sm font-semibold text-fg-amber-900">
              {accessErrorMessage}
            </p>
            {onRetryAccess ? (
              <button
                className="workbench-button-secondary min-h-9 px-3"
                onClick={onRetryAccess}
                type="button"
              >
                {labels.retry}
              </button>
            ) : null}
          </div>
        ) : null}
        {isLoading ? (
          <p className="py-16 text-center text-sm font-semibold text-[var(--workbench-muted)]">
            {labels.loading}
          </p>
        ) : snapshot ? (
          <div
            className={selectedUpdateSummary && selectedUpdateView
              ? 'grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(360px,440px)] items-start gap-5 max-[1180px]:grid-cols-1'
              : 'grid min-w-0 grid-cols-1 gap-5'}
            data-testid="planning-view-layout"
          >
            <div className="grid min-w-0 content-start gap-5">
              {activeEntities.length === 0 ? (
                <section className="workbench-panel px-6 py-16 text-center">
                  <h2 className="text-lg font-semibold text-[var(--workbench-text)]">{labels.emptyTitle}</h2>
                  <p className="mt-2 text-sm font-medium text-[var(--workbench-muted)]">{labels.emptyDescription}</p>
                </section>
              ) : null}
              {activeEntities.length > 0 && activeView === 'timeline' ? (
                <TimelineView
                  canManageEntity={canManageEntity}
                  directoryTeams={directoryTeams}
                  moveScope={moveScope}
                  canManageWorkItemDependencyEndpoint={canManageWorkItemDependencyEndpoint}
                  labels={labels}
                  isAiOperationPending={isAiOperationPending}
                  selectedEntity={selectedEntity}
                  snapshot={snapshot}
                  updateTargetDetails={updateTargetDetails}
                  onArchiveEntity={onArchiveEntity}
                  onChangeMilestoneDate={onChangeMilestoneDate}
                  onCreateDependency={onCreateDependency}
                  onCreateWorkItemDependency={onCreateWorkItemDependency}
                  onDeleteDependency={onDeleteDependency}
                  onDeleteWorkItemDependency={onDeleteWorkItemDependency}
                  onDuplicateEntity={onDuplicateEntity}
                  onMoveEntity={onMoveEntity}
                  onOpenMilestone={onOpenMilestone}
                  onOpenProject={onOpenProject}
                  onOpenWorkItem={onOpenWorkItem}
                  onRolloverCycle={onRolloverCycle}
                  onSelectEntity={handleSelectEntity}
                  onUpdateWorkItemDependency={onUpdateWorkItemDependency}
                  renderCycleBurndown={renderCycleBurndown}
                />
              ) : null}
              {activeEntities.length > 0 && activeView === 'timeline' ? (
                <CyclePlanningPanel
                  canLinkEntity={canLinkEntity}
                  canManageEntity={canManageEntity}
                  canUpdateWorkItemLink={canUpdateWorkItemLink}
                  labels={labels.cyclePlanning}
                  snapshot={snapshot}
                  onCreateNextCycle={onCreateNextCycle}
                  onSetCycleWorkItems={onSetCycleWorkItems}
                  onUpdateCycleAutomation={onUpdateCycleAutomation}
                />
              ) : null}
              {activeEntities.length > 0 && activeView === 'roadmap' ? (
                <RoadmapView
                  canLinkEntity={canLinkEntity}
                  moveScope={moveScope}
                  canManageEntity={canManageEntity}
                  canUpdateWorkItemLink={canUpdateWorkItemLink}
                  labels={labels}
                  isAiOperationPending={isAiOperationPending}
                  selectedEntity={selectedEntity}
                  snapshot={snapshot}
                  onArchiveEntity={onArchiveEntity}
                  onDeleteWorkItemLink={onDeleteWorkItemLink}
                  onDuplicateEntity={onDuplicateEntity}
                  onMoveEntity={onMoveEntity}
                  onOpenWorkItem={onOpenWorkItem}
                  onSaveWorkItemLink={onSaveWorkItemLink}
                  onSelectEntity={handleSelectEntity}
                />
              ) : null}
              {activeEntities.length > 0 && activeView === 'portfolio' ? (
                <PortfolioView
                  labels={labels}
                  isAiOperationPending={isAiOperationPending}
                  onSelectEntity={handleSelectEntity}
                  snapshot={snapshot}
                  updateTargetDetails={updateTargetDetails}
                />
              ) : null}
              {selectedEntity ? (
                <PlanningEntityEditor
                  cycleWorkItemCount={countCycleWorkItems(selectedEntity.id, snapshot.workItemLinks)}
                  disabled={isAiOperationPending}
                  entity={selectedEntity}
                  key={`planning-entity-editor:${selectedEntity.id}`}
                  labels={labels.entityEditor}
                  ownerCandidates={collectPlanningOwnerCandidates(activeEntities)}
                  ownerNotice={ownerNotice}
                  ownerOptions={ownerOptions}
                  onSave={onUpdateEntity && (canManageEntity?.(selectedEntity) ?? true)
                    ? onUpdateEntity
                    : undefined}
                />
              ) : null}
              <CreateEntityPanel
                canCreateInScope={canCreateInScope}
                canManageEntity={canManageEntity}
                createScopeTeams={createScopeTeams}
                entities={activeEntities}
                labels={labels}
                onCreate={onCreateEntity}
                ownerNotice={ownerNotice}
                ownerOptions={resolvedOwnerOptions}
              />
              {archive ? (
                <PlanningArchivePanel
                  archive={archive}
                  entityTypes={labels.entityTypes}
                  labels={labels.archivedPlans}
                  retry={labels.retry}
                />
              ) : null}
            </div>
            {selectedUpdateSummary && selectedUpdateView && resolvedSelectedUpdateTarget ? (
              <PlanningUpdateDetailPane
                aiAssistance={selectedAiAssistance}
                baselineDelays={selectedBaselineDelays}
                evidenceCandidates={selectedUpdateEvidenceCandidates}
                key={createPlanningUpdateTargetKey(resolvedSelectedUpdateTarget)}
                labels={labels}
                summary={selectedUpdateSummary}
                updateView={selectedUpdateView}
                collaboration={updateCollaboration}
                historyErrorMessage={updateHistoryErrorMessage}
                hasMoreHistory={hasMoreUpdateHistory}
                isHistoryLoading={isUpdateHistoryLoading}
                isLoadingMoreHistory={isLoadingMoreUpdateHistory}
                onLoadMoreHistory={onLoadMoreUpdateHistory}
                onPublish={onPublishUpdate && canPublishSelectedUpdate
                  ? (draft) => onPublishUpdate(resolvedSelectedUpdateTarget, draft)
                  : undefined}
                onSaveCadence={onSaveUpdateCadence && (canManageUpdateCadence?.(resolvedSelectedUpdateTarget) ?? true)
                  ? (draft) => onSaveUpdateCadence(resolvedSelectedUpdateTarget, draft)
                  : undefined}
                onRetryHistory={onRetryUpdateHistory}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function TimelineView({
  canManageEntity,
  canManageWorkItemDependencyEndpoint,
  directoryTeams,
  isAiOperationPending = false,
  labels,
  moveScope,
  onArchiveEntity,
  onChangeMilestoneDate,
  onCreateDependency,
  onCreateWorkItemDependency,
  onDeleteDependency,
  onDeleteWorkItemDependency,
  onDuplicateEntity,
  onMoveEntity,
  onOpenMilestone,
  onOpenProject,
  onOpenWorkItem,
  onRolloverCycle,
  onUpdateWorkItemDependency,
  onSelectEntity,
  renderCycleBurndown,
  selectedEntity,
  snapshot,
  updateTargetDetails,
}: {
  canManageEntity?: PlanningScreenProps['canManageEntity']
  canManageWorkItemDependencyEndpoint?: PlanningScreenProps['canManageWorkItemDependencyEndpoint']
  /** Readable Project directory used to name cross-Project timeline groups. */
  directoryTeams?: PlanningScreenProps['directoryTeams']
  /** Whether AI review is pending and target selection must remain stable. */
  isAiOperationPending?: boolean
  labels: PlanningLabels
  /** Team / Project scopes offered when a Portfolio or Cycle moves to the root. */
  moveScope: PlanningMoveScope
  onArchiveEntity?: PlanningScreenProps['onArchiveEntity']
  onChangeMilestoneDate?: PlanningScreenProps['onChangeMilestoneDate']
  onCreateDependency?: PlanningScreenProps['onCreateDependency']
  onCreateWorkItemDependency?: PlanningScreenProps['onCreateWorkItemDependency']
  onDeleteDependency?: PlanningScreenProps['onDeleteDependency']
  onDeleteWorkItemDependency?: PlanningScreenProps['onDeleteWorkItemDependency']
  onDuplicateEntity?: PlanningScreenProps['onDuplicateEntity']
  onMoveEntity?: PlanningScreenProps['onMoveEntity']
  onOpenMilestone?: PlanningScreenProps['onOpenMilestone']
  onOpenProject?: PlanningScreenProps['onOpenProject']
  onOpenWorkItem?: PlanningScreenProps['onOpenWorkItem']
  onRolloverCycle?: PlanningScreenProps['onRolloverCycle']
  onUpdateWorkItemDependency?: PlanningScreenProps['onUpdateWorkItemDependency']
  onSelectEntity: (entityId: string) => void
  renderCycleBurndown?: PlanningScreenProps['renderCycleBurndown']
  selectedEntity?: PlanningEntity
  snapshot: PlanningSnapshot
  updateTargetDetails: readonly PlanningUpdateTargetDetailView[]
}) {
  const entities = snapshot.entities.filter(
    (entity) => !entity.archivedAt && timelineEntityTypes.has(entity.type),
  )
  const cycles = entities.filter((entity) => entity.type === 'cycle')
  const manageableEntities = entities.filter((entity) => canManageEntity?.(entity) ?? true)
  const manageableCycles = cycles.filter((entity) => canManageEntity?.(entity) ?? true)
  const milestone = selectedEntity?.type === 'milestone'
    ? selectedEntity
    : entities.find((entity) => entity.type === 'milestone')
  const detailEntity = selectedEntity && timelineEntityTypes.has(selectedEntity.type)
    ? selectedEntity
    : undefined
  const criticalEntityIds = new Set(snapshot.criticalPath.entityIds)

  return (
    <div className="grid gap-5" data-testid="planning-timeline">
      <CrossProjectTimelineChart
        criticalEntityIds={criticalEntityIds}
        dependencies={snapshot.dependencies}
        directory={directoryTeams}
        disabled={isAiOperationPending}
        entities={snapshot.entities}
        entityTypes={labels.entityTypes}
        labels={labels.crossProjectTimeline}
        onOpenProject={onOpenProject}
        onSelectEntity={onSelectEntity}
      />
      <section className="workbench-panel overflow-hidden">
        <PlanningSectionHeader
          description={labels.timelineDescription}
          title={labels.timelineTitle}
        />
        <div className="overflow-x-auto border-t border-[var(--workbench-border)]">
          <table className="w-full min-w-full border-collapse text-left min-[761px]:min-w-[1180px]">
            <thead>
              <tr className="workbench-table-head">
                <th className="px-5 py-3" scope="col">{labels.entity}</th>
                <th className="px-5 py-3 max-[760px]:hidden" scope="col">{labels.baseline}</th>
                <th className="px-5 py-3 max-[760px]:hidden" scope="col">{labels.forecast}</th>
                <th className="px-5 py-3 max-[760px]:hidden" scope="col">{labels.progress}</th>
                <th className="px-5 py-3 max-[760px]:hidden" scope="col">{labels.health}</th>
                <th className="px-5 py-3 max-[760px]:hidden" scope="col">{labels.updateState}</th>
                <th className="px-5 py-3 max-[760px]:hidden" scope="col">{labels.latestUpdate}</th>
              </tr>
            </thead>
            <tbody>
              {entities.map((entity) => {
                const critical = criticalEntityIds.has(entity.id)
                const updateView = resolvePlanningEntityUpdateView(entity, updateTargetDetails)
                return (
                  <tr
                    className={`border-b border-[var(--workbench-border)] ${critical ? 'bg-red-50/70' : 'bg-surface'}`}
                    data-critical={critical ? 'true' : 'false'}
                    data-testid={`timeline-entity-${entity.id}`}
                    key={entity.id}
                  >
                    <td className="w-full px-5 py-4">
                      <button className="min-w-0 max-w-full text-left disabled:cursor-not-allowed disabled:opacity-50" disabled={isAiOperationPending} type="button" onClick={() => onSelectEntity(entity.id)}>
                        <span className="block truncate text-sm font-semibold text-[var(--workbench-text)]">{entity.title}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
                          {labels.entityTypes[entity.type]}
                          {critical ? <span className="workbench-badge-danger">{labels.criticalPath}</span> : null}
                        </span>
                      </button>
                      {updateView ? (
                        <div
                          className="mt-3 hidden min-w-0 gap-2 max-[760px]:grid"
                          data-testid={`timeline-update-summary-${entity.id}`}
                        >
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <HealthBadge health={entity.rollupHealth} labels={labels} />
                            <PlanningUpdateFreshnessBadge freshness={updateView.freshness} labels={labels} />
                          </div>
                          <PlanningLatestUpdateSummary labels={labels} updateView={updateView} />
                        </div>
                      ) : null}
                    </td>
                    <td className="px-5 py-4 text-sm font-medium text-[var(--workbench-muted)] max-[760px]:hidden">
                      {formatRange(entity.baseline)}
                    </td>
                    <td className="px-5 py-4 text-sm font-semibold text-[var(--workbench-text)] max-[760px]:hidden">
                      {formatRange(entity.forecast)}
                    </td>
                    <td className="px-5 py-4 max-[760px]:hidden">
                      <Progress value={entity.progress} labels={labels} />
                    </td>
                    <td className="px-5 py-4 max-[760px]:hidden">
                      <HealthBadge health={entity.rollupHealth} labels={labels} />
                    </td>
                    <td className="px-5 py-4 max-[760px]:hidden">
                      {updateView ? (
                        <PlanningUpdateFreshnessBadge freshness={updateView.freshness} labels={labels} />
                      ) : <span className="text-sm text-[var(--workbench-muted)]">—</span>}
                    </td>
                    <td className="px-5 py-4 max-[760px]:hidden">
                      {updateView ? (
                        <PlanningLatestUpdateSummary labels={labels} updateView={updateView} />
                      ) : <span className="text-sm text-[var(--workbench-muted)]">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-[var(--workbench-border)] px-5 py-3 text-xs font-semibold text-[var(--workbench-muted)]">
          {labels.criticalPathDays(snapshot.criticalPath.totalDurationDays)}
        </p>
      </section>

      {detailEntity?.type === 'cycle' && renderCycleBurndown
        ? renderCycleBurndown(detailEntity)
        : null}

      <div className="grid grid-cols-3 gap-5 max-[1100px]:grid-cols-1">
        <MilestoneEditor
          entity={milestone}
          key={milestone ? createPlanningEntityDetailKey(milestone) : 'empty-milestone'}
          labels={labels}
          onChange={milestone && (canManageEntity?.(milestone) ?? true)
            ? onChangeMilestoneDate
            : undefined}
        />
        <DependencyEditor
          entities={manageableEntities}
          labels={labels}
          onCreate={onCreateDependency}
        />
        <CycleRollover
          cycles={manageableCycles}
          labels={labels}
          onRollover={onRolloverCycle}
        />
      </div>
      <section className="workbench-panel p-5">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]">{labels.dependencyEditor}</h2>
        <div className="mt-4 grid gap-2">
          {snapshot.dependencies.map((dependency) => (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--workbench-border)] p-3 target:border-[var(--workbench-primary)] target:bg-tone-e5f7f4"
              id={createPlanningDependencyAnchorId(dependency.id)}
              key={dependency.id}
              tabIndex={-1}
            >
              <p className="text-sm font-semibold text-[var(--workbench-text)]">
                {resolveEntityTitle(snapshot.entities, dependency.predecessorId)} → {resolveEntityTitle(snapshot.entities, dependency.successorId)}
              </p>
              {onDeleteDependency && dependencyEntitiesAreManageable(
                dependency,
                snapshot.entities,
                canManageEntity,
              ) ? (
                <button className="workbench-button-secondary min-h-9 px-3" type="button" onClick={() => void onDeleteDependency(dependency)}>
                  {labels.deleteDependency}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </section>
      <section className="workbench-panel p-5" data-testid="planning-work-item-dependencies">
        <WorkItemDependencyPanel
          canManageEndpoint={canManageWorkItemDependencyEndpoint}
          onCreate={onCreateWorkItemDependency}
          onDelete={onDeleteWorkItemDependency}
          onOpenMilestone={onOpenMilestone}
          onOpenProject={onOpenProject}
          onOpenWorkItem={onOpenWorkItem}
          onUpdate={onUpdateWorkItemDependency}
          snapshot={snapshot}
          t={labels.workItemDependencyT}
        />
      </section>
      {detailEntity ? (
        <div
          className="grid grid-cols-1 items-start gap-5"
          data-testid="planning-timeline-entity-detail"
          key={`timeline-detail:${createPlanningEntityDetailKey(detailEntity)}`}
        >
          <EntityActions
            canManageEntity={canManageEntity}
            entities={snapshot.entities.filter((entity) => !entity.archivedAt)}
            entity={detailEntity}
            labels={labels}
            moveScope={moveScope}
            onArchive={(canManageEntity?.(detailEntity) ?? true)
              ? onArchiveEntity
              : undefined}
            onDuplicate={(canManageEntity?.(detailEntity) ?? true)
              ? onDuplicateEntity
              : undefined}
            onMove={(canManageEntity?.(detailEntity) ?? true)
              ? onMoveEntity
              : undefined}
          />
        </div>
      ) : null}
    </div>
  )
}

function MilestoneEditor({
  entity,
  labels,
  onChange,
}: {
  entity?: PlanningEntity
  labels: PlanningLabels
  onChange?: PlanningScreenProps['onChangeMilestoneDate']
}) {
  if (!entity) {
    return <section className="workbench-panel p-5"><h2 className="font-semibold">{labels.milestoneEditor}</h2></section>
  }

  return (
    <form
      className="workbench-panel grid content-start gap-4 p-5"
      data-testid="milestone-date-editor"
      onSubmit={(event) => {
        event.preventDefault()
        const date = String(new FormData(event.currentTarget).get('milestoneDate') ?? '')
        if (date) void onChange?.(entity, date)
      }}
    >
      <h2 className="text-base font-semibold text-[var(--workbench-text)]">{labels.milestoneEditor}</h2>
      <p className="text-sm font-semibold text-[var(--workbench-muted)]">{entity.title}</p>
      <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
        {labels.milestoneDate}
        <input className="workbench-input h-10 px-3" defaultValue={entity.forecast.endDate} name="milestoneDate" type="date" />
      </label>
      <button className="workbench-button-primary min-h-10 px-4 disabled:opacity-50" disabled={!onChange} type="submit">
        {labels.save}
      </button>
    </form>
  )
}

function DependencyEditor({
  entities,
  labels,
  onCreate,
}: {
  entities: PlanningEntity[]
  labels: PlanningLabels
  onCreate?: PlanningScreenProps['onCreateDependency']
}) {
  const [constraintValidationMessage, setConstraintValidationMessage] = useState<string>()
  return (
    <form
      className="workbench-panel grid content-start gap-4 p-5"
      data-testid="dependency-editor"
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const predecessorId = String(data.get('predecessorId') ?? '')
        const successorId = String(data.get('successorId') ?? '')
        const type = readDependencyType(data.get('dependencyType'))
        const lagDays = Math.trunc(Number(data.get('lagDays')) || 0)
        const constraint = readPlanningDependencyConstraint(data)
        if (data.get('constraintKind') && !constraint) {
          setConstraintValidationMessage(
            labels.workItemDependencyT('workItems.dependencies.invalid'),
          )
          return
        }
        setConstraintValidationMessage(undefined)
        if (predecessorId && successorId && predecessorId !== successorId) {
          void onCreate?.(predecessorId, successorId, type, lagDays, constraint)
        }
      }}
    >
      <h2 className="text-base font-semibold text-[var(--workbench-text)]">{labels.dependencyEditor}</h2>
      <EntitySelect entities={entities} label={labels.predecessor} name="predecessorId" />
      <EntitySelect defaultValue={entities[1]?.id} entities={entities} label={labels.successor} name="successorId" />
      <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
        {labels.dependencyType}
        <select className="workbench-input h-10 px-3" name="dependencyType">
          {(Object.keys(labels.dependencyTypes) as ScheduleDependencyType[]).map((type) => (
            <option key={type} value={type}>{labels.dependencyTypes[type]}</option>
          ))}
        </select>
      </label>
      <PlanningInput defaultValue="0" label={labels.dependencyLag} name="lagDays" type="number" />
      <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
        {labels.workItemDependencyT('workItems.dependencies.constraint.kind')}
        <select className="workbench-input h-10 px-3" name="constraintKind">
          <option value="">{labels.workItemDependencyT('workItems.dependencies.constraint.none')}</option>
          <option value="on">{labels.workItemDependencyT('workItems.dependencies.constraint.kind.on')}</option>
          <option value="not-before">{labels.workItemDependencyT('workItems.dependencies.constraint.kind.not-before')}</option>
          <option value="not-after">{labels.workItemDependencyT('workItems.dependencies.constraint.kind.not-after')}</option>
        </select>
      </label>
      <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
        {labels.workItemDependencyT('workItems.dependencies.constraint.anchor')}
        <select className="workbench-input h-10 px-3" name="constraintAnchor">
          <option value="start">{labels.workItemDependencyT('workItems.dependencies.constraint.anchor.start')}</option>
          <option value="finish">{labels.workItemDependencyT('workItems.dependencies.constraint.anchor.finish')}</option>
        </select>
      </label>
      <PlanningInput label={labels.workItemDependencyT('workItems.dependencies.constraint.date')} name="constraintDate" type="date" />
      {constraintValidationMessage ? (
        <p className="text-sm font-semibold text-fg-red-700" role="alert">
          {constraintValidationMessage}
        </p>
      ) : null}
      <button className="workbench-button-primary min-h-10 px-4 disabled:opacity-50" disabled={!onCreate || entities.length < 2} type="submit">
        {labels.addDependency}
      </button>
    </form>
  )
}

function CycleRollover({
  cycles,
  labels,
  onRollover,
}: {
  cycles: PlanningEntity[]
  labels: PlanningLabels
  onRollover?: PlanningScreenProps['onRolloverCycle']
}) {
  const [selectedSourceId, setSelectedSourceId] = useState(cycles[0]?.id ?? '')
  const source = cycles.find((cycle) => cycle.id === selectedSourceId) ?? cycles[0]
  const targetCycles = resolvePlanningCycleRolloverTargets(source, cycles)
  const sourceIsClosed = source !== undefined && !isOpenPlanningEntity(source)
  return (
    <form
      className="workbench-panel grid content-start gap-4 p-5"
      data-testid="cycle-rollover"
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const targetCycleId = String(data.get('targetCycleId') ?? '')
        if (source && targetCycleId && source.id !== targetCycleId) {
          void onRollover?.(source, targetCycleId)
        }
      }}
    >
      <h2 className="text-base font-semibold text-[var(--workbench-text)]">{labels.cycleRollover}</h2>
      <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
        {labels.sourceCycle}
        <select
          className="workbench-input h-10 px-3"
          name="sourceCycleId"
          value={source?.id ?? ''}
          onChange={(event) => setSelectedSourceId(event.target.value)}
        >
          {cycles.map((cycle) => (
            <option key={cycle.id} value={cycle.id}>{cycle.title}</option>
          ))}
        </select>
      </label>
      {source?.capacity !== undefined ? (
        <p className="text-sm font-medium text-[var(--workbench-muted)]">{labels.capacity(source.capacity)}</p>
      ) : null}
      {sourceIsClosed ? (
        <p className="text-sm font-medium text-[var(--workbench-muted)]" data-testid="cycle-rollover-closed">
          {labels.closedCycleRollover}
        </p>
      ) : targetCycles.length === 0 ? (
        <p className="text-sm font-medium text-[var(--workbench-muted)]" data-testid="cycle-rollover-no-target">
          {labels.noRolloverTarget}
        </p>
      ) : (
        <>
          <EntitySelect
            defaultValue={targetCycles[0]?.id}
            entities={targetCycles}
            key={`rollover-target:${source?.id ?? ''}`}
            label={labels.targetCycle}
            name="targetCycleId"
          />
          <button className="workbench-button-primary min-h-10 px-4 disabled:opacity-50" disabled={!onRollover} type="submit">
            {labels.rollover}
          </button>
        </>
      )}
    </form>
  )
}

function RoadmapView({
  canLinkEntity,
  canManageEntity,
  canUpdateWorkItemLink,
  isAiOperationPending = false,
  labels,
  moveScope,
  onArchiveEntity,
  onDeleteWorkItemLink,
  onDuplicateEntity,
  onMoveEntity,
  onOpenWorkItem,
  onSaveWorkItemLink,
  onSelectEntity,
  selectedEntity,
  snapshot,
}: {
  canLinkEntity?: PlanningScreenProps['canLinkEntity']
  canManageEntity?: PlanningScreenProps['canManageEntity']
  canUpdateWorkItemLink?: PlanningScreenProps['canUpdateWorkItemLink']
  /** Whether AI review is pending and target selection must remain stable. */
  isAiOperationPending?: boolean
  labels: PlanningLabels
  /** Team / Project scopes offered when a Portfolio or Cycle moves to the root. */
  moveScope: PlanningMoveScope
  onArchiveEntity?: PlanningScreenProps['onArchiveEntity']
  onDeleteWorkItemLink?: PlanningScreenProps['onDeleteWorkItemLink']
  onDuplicateEntity?: PlanningScreenProps['onDuplicateEntity']
  onMoveEntity?: PlanningScreenProps['onMoveEntity']
  onOpenWorkItem?: PlanningScreenProps['onOpenWorkItem']
  onSaveWorkItemLink?: PlanningScreenProps['onSaveWorkItemLink']
  onSelectEntity: (entityId: string) => void
  selectedEntity?: PlanningEntity
  snapshot: PlanningSnapshot
}) {
  const activeEntities = snapshot.entities.filter((entity) => !entity.archivedAt)
  const entities = activeEntities.filter((entity) => entity.type !== 'cycle')
  const childrenByParent = groupChildren(entities)
  const roots = entities.filter((entity) => !entity.parentId || !entities.some((candidate) => candidate.id === entity.parentId))
  const goalWorkItems = selectedEntity?.type === 'goal'
    ? resolveGoalWorkItems(snapshot, selectedEntity.id)
    : []
  const canManageSelectedEntity = selectedEntity
    ? canManageEntity?.(selectedEntity) ?? true
    : false

  return (
    <div className="grid items-start gap-5" data-testid="planning-roadmap">
      <section className="workbench-panel overflow-hidden">
        <PlanningSectionHeader title={labels.roadmapTitle} description={labels.roadmapDescription} />
        <div className="grid gap-2 border-t border-[var(--workbench-border)] p-4">
          {roots.map((entity) => (
            <RoadmapNode
              childrenByParent={childrenByParent}
              depth={0}
              entity={entity}
              key={entity.id}
              labels={labels}
              selectedEntityId={selectedEntity?.id}
              isAiOperationPending={isAiOperationPending}
              onSelectEntity={onSelectEntity}
            />
          ))}
        </div>
      </section>
      <div className="grid content-start gap-5 min-[760px]:grid-cols-2">
        <section className="workbench-panel p-5" data-testid="goal-work-items">
          <h2 className="text-base font-semibold text-[var(--workbench-text)]">{labels.goalWorkItems}</h2>
          <div className="mt-4 grid gap-2">
            {goalWorkItems.map((workItem) => {
              const trace = resolveWorkItemStrategicTrace(snapshot, workItem)
              return (
                <button
                  className="rounded-lg border border-[var(--workbench-border)] bg-surface p-3 text-left hover:border-[var(--workbench-primary)]"
                  disabled={isAiOperationPending}
                  key={`${workItem.teamId}:${workItem.id}`}
                  type="button"
                  onClick={() => onOpenWorkItem?.(workItem)}
                >
                  <span className="block text-sm font-semibold text-[var(--workbench-text)]">{workItem.title}</span>
                  {trace.length > 0 ? (
                    <span
                      className="mt-1 block text-xs font-medium text-[var(--workbench-muted)]"
                      data-testid={`planning-work-item-trace-${workItem.id}`}
                    >
                      {trace.map((entity) => entity.title).join(' › ')}
                    </span>
                  ) : null}
                  <span className="mt-1 block text-xs font-medium text-[var(--workbench-muted)]">{labels.openWorkItem}</span>
                </button>
              )
            })}
            {goalWorkItems.length === 0 ? <p className="text-sm font-medium text-[var(--workbench-muted)]">{labels.noGoalWorkItems}</p> : null}
          </div>
        </section>
        {selectedEntity ? (
          <>
            <EntityActions
              canManageEntity={canManageEntity}
              entities={entities}
              entity={selectedEntity}
              key={`roadmap-actions:${createPlanningEntityDetailKey(selectedEntity)}`}
              labels={labels}
              moveScope={moveScope}
              onArchive={canManageSelectedEntity ? onArchiveEntity : undefined}
              onDuplicate={canManageSelectedEntity ? onDuplicateEntity : undefined}
              onMove={canManageSelectedEntity ? onMoveEntity : undefined}
            />
          </>
        ) : null}
        <WorkItemLinkEditor
          canLinkEntity={canLinkEntity}
          canUpdateWorkItemLink={canUpdateWorkItemLink}
          entities={snapshot.entities}
          labels={labels}
          snapshot={snapshot}
          onDelete={onDeleteWorkItemLink}
          onSave={onSaveWorkItemLink}
        />
      </div>
    </div>
  )
}

function RoadmapNode({
  childrenByParent,
  depth,
  entity,
  isAiOperationPending = false,
  labels,
  onSelectEntity,
  selectedEntityId,
}: {
  childrenByParent: Map<string, PlanningEntity[]>
  depth: number
  entity: PlanningEntity
  /** Whether AI review is pending and target selection must remain stable. */
  isAiOperationPending?: boolean
  labels: PlanningLabels
  onSelectEntity: (entityId: string) => void
  selectedEntityId?: string
}) {
  return (
    <div>
      <button
        aria-current={selectedEntityId === entity.id ? 'true' : undefined}
        className={`grid w-full min-w-0 grid-cols-[minmax(0,1fr)_minmax(72px,auto)] items-center gap-2 rounded-lg border p-3 text-left min-[640px]:grid-cols-[minmax(0,1fr)_100px_110px] min-[640px]:gap-3 ${selectedEntityId === entity.id ? 'border-tone-6fbfb4 bg-tone-e5f7f4' : 'border-[var(--workbench-border)] bg-surface hover:border-tone-99d7cf'}`}
        data-testid={`roadmap-entity-${entity.id}`}
        disabled={isAiOperationPending}
        style={{
          paddingLeft: `clamp(12px, calc(12px + ${depth * 2.5}vw), ${12 + depth * 20}px)`,
        }}
        type="button"
        onClick={() => onSelectEntity(entity.id)}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-[var(--workbench-text)]">{entity.title}</span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs font-medium text-[var(--workbench-muted)]">
            <span className="max-w-full truncate whitespace-nowrap">
              {labels.entityTypes[entity.type]}
            </span>
            <span aria-hidden="true">·</span>
            <span className="whitespace-nowrap">
              {labels.workItemCount(entity.linkedWorkItemCount)}
            </span>
          </span>
        </span>
        <span className="grid min-w-[72px] justify-items-end gap-1 min-[640px]:contents">
          <span className="whitespace-nowrap text-sm font-semibold text-[var(--workbench-text)]">
            {labels.percent(entity.progress)}
          </span>
          <HealthBadge health={entity.rollupHealth} labels={labels} />
        </span>
      </button>
      <div className="mt-2 grid gap-2">
        {(childrenByParent.get(entity.id) ?? []).map((child) => (
          <RoadmapNode
            childrenByParent={childrenByParent}
            depth={depth + 1}
            entity={child}
            key={child.id}
            labels={labels}
            isAiOperationPending={isAiOperationPending}
            selectedEntityId={selectedEntityId}
            onSelectEntity={onSelectEntity}
          />
        ))}
      </div>
    </div>
  )
}

function EntityActions({
  canManageEntity,
  entities,
  entity,
  labels,
  moveScope,
  onArchive,
  onDuplicate,
  onMove,
}: {
  canManageEntity?: PlanningScreenProps['canManageEntity']
  entities: PlanningEntity[]
  entity: PlanningEntity
  labels: PlanningLabels
  /** Team / Project scopes offered when a Portfolio or Cycle moves to the root. */
  moveScope: PlanningMoveScope
  onArchive?: PlanningScreenProps['onArchiveEntity']
  onDuplicate?: PlanningScreenProps['onDuplicateEntity']
  onMove?: PlanningScreenProps['onMoveEntity']
}) {
  const currentParent = entity.parentId
    ? entities.find((candidate) => candidate.id === entity.parentId)
    : undefined
  const canDuplicate = Boolean(
    onDuplicate && (
      !entity.parentId ||
      (currentParent !== undefined && (canManageEntity?.(currentParent) ?? true))
    ),
  )
  const moveTargets = resolvePlanningParentCandidates(entities, entity.type, entity.goalFramework)
    .filter((candidate) =>
      candidate.id !== entity.id && (canManageEntity?.(candidate) ?? true),
    )
  const canMoveToRoot = entity.type === 'portfolio' || entity.type === 'cycle'
  const canMove = Boolean(onMove && (canMoveToRoot || moveTargets.length > 0))
  const canMutate = Boolean(onArchive || canDuplicate || canMove)
  const defaultMoveParentId = moveTargets.some((candidate) => candidate.id === entity.parentId)
    ? entity.parentId
    : moveTargets[0]?.id ?? ''
  return (
    <section className="workbench-panel grid gap-4 p-5" data-testid="planning-entity-actions">
      <h2 className="text-base font-semibold text-[var(--workbench-text)]">{labels.entityActions}</h2>
      <p className="text-sm font-semibold text-[var(--workbench-muted)]">{entity.title}</p>
      {onArchive ? <button className="workbench-button-secondary min-h-10 px-4" type="button" onClick={() => void onArchive(entity)}>{labels.archive}</button> : null}
      {canDuplicate && onDuplicate ? (
        <button className="workbench-button-secondary min-h-10 px-4" type="button" onClick={() => void onDuplicate(entity)}>{labels.duplicate}</button>
      ) : null}
      {canMove && onMove ? (
        <form className="grid gap-2" onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          const target = resolvePlanningMoveSelection(
            entities,
            String(data.get('parentId') ?? ''),
            String(data.get('teamId') ?? ''),
            String(data.get('projectId') ?? ''),
          )
          if (target) void onMove(entity, target)
        }}>
          <label className="grid gap-2 text-sm font-semibold">{labels.moveTarget}<select className="workbench-input h-10 px-3" defaultValue={canMoveToRoot ? '' : defaultMoveParentId} name="parentId" required={!canMoveToRoot}>{canMoveToRoot ? <option value="">{labels.moveToRoot}</option> : null}{moveTargets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select></label>
          {canMoveToRoot ? (
            <RootMoveScopeFields
              entity={entity}
              labels={labels}
              scope={moveScope}
            />
          ) : null}
          <button className="workbench-button-secondary min-h-10 px-4" type="submit">{labels.move}</button>
        </form>
      ) : null}
      {!canMutate ? <p className="text-sm font-medium text-[var(--workbench-muted)]">{labels.readOnly}</p> : null}
    </section>
  )
}

function CreateEntityPanel({
  canCreateInScope,
  canManageEntity,
  createScopeTeams,
  entities,
  labels,
  onCreate,
  ownerNotice,
  ownerOptions,
}: {
  canCreateInScope?: PlanningScreenProps['canCreateInScope']
  canManageEntity?: PlanningScreenProps['canManageEntity']
  createScopeTeams: readonly ProjectDirectoryTeam[]
  entities: PlanningEntity[]
  labels: PlanningLabels
  onCreate?: PlanningScreenProps['onCreateEntity']
  /** Notice under the owner field, such as a member-list load failure with a retry button. */
  ownerNotice?: ReactNode
  /** Members suggested by the owner field; the owner can still be typed. */
  ownerOptions: readonly PlanningOwnerOption[]
}) {
  const ownerListId = useId()
  const [entityType, setEntityType] = useState<PlanningEntityType>(() =>
    resolveInitialEntityType(entities),
  )
  const [goalFramework, setGoalFramework] = useState<PlanningGoalFramework>('goal')
  const canCreateInWorkspace = canCreateInScope?.({}) ?? true
  const manageableScopeTeams = filterPlanningScopeTeams(createScopeTeams, canCreateInScope)
  const [selectedTeamId, setSelectedTeamId] = useState(
    canCreateInWorkspace ? '' : manageableScopeTeams[0]?.id ?? '',
  )
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const parentCandidates = resolvePlanningParentCandidates(entities, entityType, goalFramework)
    .filter((entity) => canManageEntity?.(entity) ?? true)
  const requiresParent = entityType !== 'portfolio' && entityType !== 'cycle'
  const selectedTeam = manageableScopeTeams.find((team) => team.id === selectedTeamId)
  const selectedProject = selectedTeam?.projects.find(
    (project) => project.id === selectedProjectId,
  )
  const selectedRootScope: PlanningScope = {
    ...(selectedTeam ? { teamId: selectedTeam.id } : {}),
    ...(selectedProject ? { projectId: selectedProject.id } : {}),
  }
  const canCreateInSelectedRootScope = entityType !== 'cycle' || selectedTeam !== undefined
    ? canCreateInScope?.(selectedRootScope) ?? true
    : false
  return (
    <form
      className="workbench-panel grid gap-4 p-5"
      data-testid="planning-create-entity"
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const startDate = String(data.get('startDate') ?? '')
        const endDate = entityType === 'milestone'
          ? startDate
          : String(data.get('endDate') ?? '')
        const baseline = {
          startDate,
          endDate,
        }
        const parentId = String(data.get('parentId') ?? '') || undefined
        const parent = parentId
          ? entities.find((entity) => entity.id === parentId)
          : undefined
        const requestedTeamId = String(data.get('teamId') ?? '').trim()
        const requestedProjectId = String(data.get('projectId') ?? '').trim()
        const teamId = parent?.teamId ?? (requestedTeamId || undefined)
        const projectId = parent?.projectId ?? (requestedProjectId || undefined)
        if (canCreateInScope && !canCreateInScope({ teamId, projectId })) return
        const input: Omit<CreatePlanningEntityInput, 'expectedRevision'> = {
          type: entityType,
          title: String(data.get('title') ?? '').trim(),
          ownerMemberKey: String(data.get('ownerMemberKey') ?? '').trim(),
          status: 'planned',
          health: 'unknown',
          risk: 'none',
          progressMode: 'automatic',
          baseline,
          forecast: baseline,
          ...(parentId ? { parentId } : {}),
          ...(teamId ? { teamId } : {}),
          ...(projectId ? { projectId } : {}),
          ...(entityType === 'goal' ? { goalFramework } : {}),
          ...(entityType === 'cycle' ? {
            cadence: {
              unit: data.get('cadenceUnit') === 'month' ? 'month' : 'week',
              count: Math.max(1, Math.trunc(Number(data.get('cadenceCount'))) || 1),
            },
            // A Cycle refuses links beyond its capacity, so never create one that holds nothing.
            capacity: Math.max(1, Math.trunc(Number(data.get('capacity'))) || DEFAULT_CYCLE_CAPACITY),
            carryOverPolicy: data.get('carryOverPolicy') === 'keep-incomplete'
              ? 'keep-incomplete'
              : 'move-incomplete',
          } : {}),
        }
        if (input.title && input.ownerMemberKey && baseline.startDate && baseline.endDate) {
          void onCreate?.(input)
        }
      }}
    >
      <h2 className="text-base font-semibold text-[var(--workbench-text)]">{labels.createEntity}</h2>
      <div className="grid grid-cols-4 gap-3 max-[1000px]:grid-cols-2 max-[640px]:grid-cols-1">
        <PlanningInput label={labels.entity} name="title" required />
        <label className="grid gap-2 text-sm font-semibold">{labels.entityType}<select className="workbench-input h-10 px-3" name="entityType" value={entityType} onChange={(event) => setEntityType(event.target.value as PlanningEntityType)}>{(Object.keys(labels.entityTypes) as PlanningEntityType[]).map((type) => <option key={type} value={type}>{labels.entityTypes[type]}</option>)}</select></label>
        <div className="grid content-start gap-2">
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {labels.owner}
            <input autoComplete="off" className="workbench-input h-10 px-3" list={ownerListId} name="ownerMemberKey" placeholder={labels.ownerPlaceholder} required type="text" />
            <datalist id={ownerListId}>
              {ownerOptions.map((option) => (
                <option key={option.memberKey} label={option.label} value={option.memberKey} />
              ))}
            </datalist>
          </label>
          {ownerNotice}
        </div>
        {entityType === 'goal' ? (
          <label className="grid gap-2 text-sm font-semibold">
            {labels.goalFramework}
            <select
              className="workbench-input h-10 px-3"
              name="goalFramework"
              value={goalFramework}
              onChange={(event) => setGoalFramework(event.target.value as PlanningGoalFramework)}
            >
              {(Object.keys(labels.goalFrameworkValues) as PlanningGoalFramework[]).map((value) => (
                <option key={value} value={value}>{labels.goalFrameworkValues[value]}</option>
              ))}
            </select>
          </label>
        ) : null}
        {requiresParent ? (
          <label className="grid gap-2 text-sm font-semibold">{labels.moveTarget}<select className="workbench-input h-10 px-3" defaultValue={parentCandidates[0]?.id ?? ''} key={`parent:${entityType}:${goalFramework}`} name="parentId" required>{parentCandidates.map((entity) => <option key={entity.id} value={entity.id}>{entity.title}</option>)}</select></label>
        ) : (
          <>
            <label className="grid gap-2 text-sm font-semibold">
              {labels.team}
              <select
                className="workbench-input h-10 px-3"
                name="teamId"
                required={entityType === 'cycle'}
                value={selectedTeam?.id ?? ''}
                onChange={(event) => {
                  setSelectedTeamId(event.target.value)
                  setSelectedProjectId('')
                }}
              >
                {entityType !== 'cycle' && canCreateInWorkspace ? <option value="">-</option> : null}
                {manageableScopeTeams.map((team) => (
                  <option key={team.id} value={team.id}>{team.name}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-sm font-semibold">
              {labels.project}
              <select
                className="workbench-input h-10 px-3"
                disabled={!selectedTeam}
                name="projectId"
                value={selectedProject?.id ?? ''}
                onChange={(event) => setSelectedProjectId(event.target.value)}
              >
                <option value="">-</option>
                {selectedTeam?.projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <PlanningInput label={labels.startDate} name="startDate" required type="date" />
        {entityType === 'milestone' ? null : (
          <PlanningInput label={labels.endDate} name="endDate" required type="date" />
        )}
      </div>
      {entityType === 'cycle' ? (
        <div className="workbench-panel-muted grid grid-cols-4 gap-3 p-4 max-[800px]:grid-cols-2 max-[520px]:grid-cols-1">
          <PlanningInput label={labels.entityEditor.cadenceCount} min={1} name="cadenceCount" required type="number" defaultValue="2" />
          <label className="grid gap-2 text-sm font-semibold">{labels.entityEditor.cadenceUnit}<select className="workbench-input h-10 px-3" name="cadenceUnit"><option value="week">{labels.cadenceWeek}</option><option value="month">{labels.cadenceMonth}</option></select></label>
          <PlanningInput label={labels.entityEditor.capacity} min={1} name="capacity" required type="number" defaultValue={String(DEFAULT_CYCLE_CAPACITY)} />
          <label className="grid gap-2 text-sm font-semibold">{labels.entityEditor.carryOverPolicy}<select className="workbench-input h-10 px-3" name="carryOverPolicy"><option value="move-incomplete">{labels.carryOverMove}</option><option value="keep-incomplete">{labels.carryOverKeep}</option></select></label>
        </div>
      ) : null}
      <button className="workbench-button-primary min-h-10 px-4 disabled:opacity-50" disabled={!onCreate || (requiresParent ? parentCandidates.length === 0 : !canCreateInSelectedRootScope)} type="submit">{labels.create}</button>
    </form>
  )
}

function WorkItemLinkEditor({
  canLinkEntity,
  canUpdateWorkItemLink,
  entities,
  labels,
  onDelete,
  onSave,
  snapshot,
}: {
  canLinkEntity?: PlanningScreenProps['canLinkEntity']
  canUpdateWorkItemLink?: PlanningScreenProps['canUpdateWorkItemLink']
  entities: PlanningEntity[]
  labels: PlanningLabels
  onDelete?: PlanningScreenProps['onDeleteWorkItemLink']
  onSave?: PlanningScreenProps['onSaveWorkItemLink']
  snapshot: PlanningSnapshot
}) {
  const editableWorkItems = snapshot.workItems.filter(
    (workItem) => canUpdateWorkItemLink?.(workItem) ?? true,
  )
  const [selectedWorkItemKey, setSelectedWorkItemKey] = useState(
    editableWorkItems[0] ? `${editableWorkItems[0].teamId}\0${editableWorkItems[0].id}` : '',
  )
  const selectedWorkItem = editableWorkItems.find(
    (item) => `${item.teamId}\0${item.id}` === selectedWorkItemKey,
  )
  const linkableEntities = selectedWorkItem
    ? entities.filter((entity) =>
        (canLinkEntity?.(entity) ?? true) &&
        isPlanningWorkItemLinkCandidate(entity, selectedWorkItem),
      )
    : []
  const cycles = linkableEntities.filter((entity) => entity.type === 'cycle')
  const milestones = linkableEntities.filter((entity) => entity.type === 'milestone')
  const goals = linkableEntities.filter((entity) => entity.type === 'goal')
  const currentLink = selectedWorkItem
    ? snapshot.workItemLinks.find((link) =>
        link.teamId === selectedWorkItem.teamId && link.workItemId === selectedWorkItem.id,
      )
    : undefined
  return (
    <form className="workbench-panel grid gap-3 p-5" data-testid="planning-work-item-link" onSubmit={(event) => {
      event.preventDefault()
      if (!selectedWorkItem) return
      const data = new FormData(event.currentTarget)
      const cycleId = String(data.get('cycleId') ?? '') || undefined
      const milestoneId = String(data.get('milestoneId') ?? '') || undefined
      const goalIds = data.getAll('goalIds').map(String).filter(Boolean)
      void onSave?.(selectedWorkItem, cycleId, milestoneId, goalIds)
    }}>
      <h2 className="text-base font-semibold text-[var(--workbench-text)]">{labels.workItemLinkEditor}</h2>
      <label className="grid gap-2 text-sm font-semibold">{labels.workItem}<select className="workbench-input h-10 px-3" name="workItem" value={selectedWorkItemKey} onChange={(event) => setSelectedWorkItemKey(event.target.value)}>{editableWorkItems.map((item) => <option key={`${item.teamId}:${item.id}`} value={`${item.teamId}\0${item.id}`}>{item.title}</option>)}</select></label>
      {selectedWorkItem?.projectId ? <p className="text-xs font-semibold text-[var(--workbench-muted)]">{labels.project}: {selectedWorkItem.projectId}</p> : null}
      <OptionalEntitySelect
        defaultValue={currentLink?.cycleId}
        entities={cycles}
        key={`${selectedWorkItemKey}:cycle`}
        label={labels.cycle}
        name="cycleId"
      />
      <OptionalEntitySelect
        defaultValue={currentLink?.milestoneId}
        entities={milestones}
        key={`${selectedWorkItemKey}:milestone`}
        label={labels.milestone}
        name="milestoneId"
      />
      <MultiEntitySelect
        defaultValue={currentLink?.goalIds ?? []}
        entities={goals}
        key={`${selectedWorkItemKey}:goals`}
        label={labels.goal}
        name="goalIds"
      />
      <div className="flex flex-wrap gap-2">
        <button className="workbench-button-primary min-h-10 px-4 disabled:opacity-50" disabled={!onSave || !selectedWorkItem} type="submit">{labels.linkWorkItem}</button>
        <button className="workbench-button-secondary min-h-10 px-4 disabled:opacity-50" disabled={!onDelete || !currentLink || !selectedWorkItem || !linkEntitiesAreEditable(currentLink, entities, canLinkEntity)} type="button" onClick={() => { if (selectedWorkItem && currentLink) void onDelete?.(selectedWorkItem) }}>{labels.unlinkWorkItem}</button>
      </div>
    </form>
  )
}

function PortfolioView({
  isAiOperationPending = false,
  labels,
  onSelectEntity,
  snapshot,
  updateTargetDetails,
}: {
  /** Whether AI review is pending and target selection must remain stable. */
  isAiOperationPending?: boolean
  labels: PlanningLabels
  onSelectEntity: (entityId: string) => void
  snapshot: PlanningSnapshot
  updateTargetDetails: readonly PlanningUpdateTargetDetailView[]
}) {
  const rows = snapshot.entities.filter((entity) =>
    !entity.archivedAt && ['portfolio', 'roadmap', 'initiative'].includes(entity.type),
  )
  return (
    <section className="workbench-panel overflow-hidden" data-testid="planning-portfolio">
      <PlanningSectionHeader title={labels.portfolioTitle} description={labels.portfolioDescription} />
      <div className="overflow-x-auto border-t border-[var(--workbench-border)]">
        <table className="w-full min-w-full border-collapse text-left min-[761px]:min-w-[1320px]">
          <thead>
            <tr className="workbench-table-head">
              <th className="px-5 py-3" scope="col">{labels.entity}</th>
              <th className="px-5 py-3 max-[760px]:hidden" scope="col">{labels.progress}</th>
              <th className="px-5 py-3 max-[760px]:hidden" scope="col">{labels.reportedHealth}</th>
              <th className="px-5 py-3 max-[760px]:hidden" scope="col">{labels.rollupHealth}</th>
              <th className="px-5 py-3 max-[760px]:hidden" scope="col">{labels.updateState}</th>
              <th className="px-5 py-3 max-[760px]:hidden" scope="col">{labels.latestUpdate}</th>
              <th className="px-5 py-3 max-[760px]:hidden" scope="col">{labels.risk}</th>
              <th className="px-5 py-3 max-[760px]:hidden" scope="col">{labels.linkedWorkItems}</th>
              <th className="px-5 py-3 max-[760px]:hidden" scope="col">{labels.forecast}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entity) => {
              const updateView = resolvePlanningEntityUpdateView(entity, updateTargetDetails)
              return (
                <tr className="border-b border-[var(--workbench-border)] bg-surface" data-testid={`portfolio-entity-${entity.id}`} key={entity.id}>
                  <td className="w-full px-5 py-4">
                    <button className="min-w-0 max-w-full text-left disabled:cursor-not-allowed disabled:opacity-50" disabled={isAiOperationPending} onClick={() => onSelectEntity(entity.id)} type="button">
                      <span className="block truncate text-sm font-semibold">{entity.title}</span>
                      <span className="mt-1 block text-xs text-[var(--workbench-muted)]">{labels.entityTypes[entity.type]}</span>
                    </button>
                    {updateView ? (
                      <div
                        className="mt-3 hidden min-w-0 gap-2 max-[760px]:grid"
                        data-testid={`portfolio-update-summary-${entity.id}`}
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <HealthBadge
                            health={entity.health}
                            labels={labels}
                          />
                          <PlanningUpdateFreshnessBadge freshness={updateView.freshness} labels={labels} />
                        </div>
                        <PlanningLatestUpdateSummary labels={labels} updateView={updateView} />
                      </div>
                    ) : null}
                  </td>
                  <td className="px-5 py-4 max-[760px]:hidden"><Progress labels={labels} value={entity.progress} /></td>
                  <td className="px-5 py-4 max-[760px]:hidden"><HealthBadge health={entity.health} labels={labels} /></td>
                  <td className="px-5 py-4 max-[760px]:hidden"><HealthBadge health={entity.rollupHealth} labels={labels} /></td>
                  <td className="px-5 py-4 max-[760px]:hidden">
                    {updateView ? (
                      <PlanningUpdateFreshnessBadge freshness={updateView.freshness} labels={labels} />
                    ) : <span className="text-sm text-[var(--workbench-muted)]">—</span>}
                  </td>
                  <td className="px-5 py-4 max-[760px]:hidden">
                    {updateView ? (
                      <PlanningLatestUpdateSummary labels={labels} updateView={updateView} />
                    ) : <span className="text-sm text-[var(--workbench-muted)]">—</span>}
                  </td>
                  <td className="px-5 py-4 text-sm font-semibold max-[760px]:hidden">{labels.riskValues[entity.risk]}</td>
                  <td className="px-5 py-4 text-sm font-semibold max-[760px]:hidden">{labels.workItemCount(entity.linkedWorkItemCount)}</td>
                  <td className="px-5 py-4 text-sm font-medium max-[760px]:hidden">{formatRange(entity.forecast)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function PlanningSectionHeader({ description, title }: { description: string; title: string }) {
  return <div className="px-5 py-4"><h2 className="text-base font-semibold text-[var(--workbench-text)]">{title}</h2><p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">{description}</p></div>
}

function EntitySelect({ defaultValue, entities, label, name }: { defaultValue?: string; entities: PlanningEntity[]; label: string; name: string }) {
  return <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">{label}<select className="workbench-input h-10 px-3" defaultValue={defaultValue} name={name}>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.title}</option>)}</select></label>
}

function OptionalEntitySelect({ defaultValue, entities, label, name }: { defaultValue?: string; entities: PlanningEntity[]; label: string; name: string }) {
  return <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">{label}<select className="workbench-input h-10 px-3" defaultValue={defaultValue ?? ''} name={name}><option value="">—</option>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.title}</option>)}</select></label>
}

function MultiEntitySelect({ defaultValue, entities, label, name }: { defaultValue: string[]; entities: PlanningEntity[]; label: string; name: string }) {
  return <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">{label}<select className="workbench-input min-h-24 p-2" defaultValue={defaultValue} multiple name={name}>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.title}</option>)}</select></label>
}

/** Team / Project scopes a Portfolio or Cycle can move to at the root of the plan. */
type PlanningMoveScope = {
  /** Whether the root move may clear the Team and keep the entity Workspace-wide. */
  allowWorkspace: boolean
  /** Teams, each with the Projects, where the current user may place Planning roots. */
  teams: readonly ProjectDirectoryTeam[]
}

/**
 * Keeps the Teams and Projects where the current user may create or place a Planning root.
 *
 * @param teams - Manageable Team / Project directory passed to the screen.
 * @param canCreateInScope - Optional scope permission check.
 * @returns Teams the user may use, each limited to the Projects the user may use.
 */
function filterPlanningScopeTeams(
  teams: readonly ProjectDirectoryTeam[],
  canCreateInScope: PlanningScreenProps['canCreateInScope'],
): ProjectDirectoryTeam[] {
  return teams.flatMap((team) =>
    canCreateInScope?.({ teamId: team.id }) === false
      ? []
      : [{
          ...team,
          projects: team.projects.filter((project) =>
            canCreateInScope?.({ teamId: team.id, projectId: project.id }) ?? true),
        }],
  )
}

/**
 * Lets the user pick the destination Team and Project when a Portfolio or Cycle moves to the root.
 *
 * The entity's current Team and Project stay selectable even when the directory no longer lists
 * them, so opening the form never silently moves the entity elsewhere.
 *
 * @param props - Entity being moved, labels and the allowed scopes.
 * @returns Team and Project selects named `teamId` and `projectId`.
 */
function RootMoveScopeFields({
  entity,
  labels,
  scope,
}: {
  /** Entity being moved. */
  entity: PlanningEntity
  /** Screen labels. */
  labels: PlanningLabels
  /** Team / Project scopes the entity may move to. */
  scope: PlanningMoveScope
}) {
  const teamRequired = entity.type === 'cycle' || !scope.allowWorkspace
  const teams: ProjectDirectoryTeam[] = entity.teamId && !scope.teams.some((team) => team.id === entity.teamId)
    ? [...scope.teams, { id: entity.teamId, name: entity.teamId, projects: [] }]
    : [...scope.teams]
  const [teamId, setTeamId] = useState(() =>
    entity.teamId ?? (teamRequired ? teams[0]?.id ?? '' : ''))
  const [projectId, setProjectId] = useState(entity.projectId ?? '')
  const selectedTeam = teams.find((team) => team.id === teamId)
  const projects = selectedTeam && teamId === entity.teamId && entity.projectId &&
    !selectedTeam.projects.some((project) => project.id === entity.projectId)
    ? [...selectedTeam.projects, { id: entity.projectId, name: entity.projectId }]
    : selectedTeam?.projects ?? []
  return (
    <div className="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1" data-testid="planning-root-move-scope">
      <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
        {labels.team}
        <select
          className="workbench-input h-10 px-3"
          name="teamId"
          required={teamRequired}
          value={teamId}
          onChange={(event) => {
            setTeamId(event.target.value)
            setProjectId('')
          }}
        >
          {teamRequired ? null : <option value="">-</option>}
          {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
        </select>
      </label>
      <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
        {labels.project}
        <select
          className="workbench-input h-10 px-3"
          disabled={!selectedTeam}
          name="projectId"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">-</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
    </div>
  )
}

function PlanningInput({ defaultValue, label, min, name, required = false, type = 'text' }: { defaultValue?: string; label: string; min?: number; name: string; required?: boolean; type?: 'date' | 'number' | 'text' }) {
  return <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">{label}<input className="workbench-input h-10 px-3" defaultValue={defaultValue} min={min} name={name} required={required} step={type === 'number' ? 1 : undefined} type={type} /></label>
}

function Progress({ labels, value }: { labels: PlanningLabels; value: number }) {
  const normalized = Math.max(0, Math.min(100, value))
  return <div className="grid min-w-[120px] gap-1"><span className="text-xs font-semibold text-[var(--workbench-muted)]">{labels.percent(normalized)}</span><div aria-label={labels.progress} aria-valuemax={100} aria-valuemin={0} aria-valuenow={normalized} className="h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar"><div className="h-full rounded-full bg-[var(--workbench-primary)]" style={{ width: `${normalized}%` }} /></div></div>
}

function HealthBadge({ health, labels }: { health: PlanningHealth; labels: PlanningLabels }) {
  const classes: Record<PlanningHealth, string> = { unknown: 'workbench-badge', 'on-track': 'workbench-badge-success', 'at-risk': 'workbench-badge-warning', 'off-track': 'workbench-badge-danger' }
  return <span className={`${classes[health]} whitespace-nowrap`}>{labels.healthValues[health]}</span>
}

/**
 * Resolves the Project or Initiative update target represented by a planning row.
 *
 * @param entity - Planning entity rendered by a list or hierarchy row.
 * @returns A canonical update target, or undefined for non-target aggregate rows.
 */
function resolvePlanningEntityUpdateTarget(
  entity: PlanningEntity,
): PlanningUpdateTargetView | undefined {
  if (entity.type === 'initiative') {
    return { type: 'initiative', entityId: entity.id }
  }
  if (entity.teamId && entity.projectId) {
    return {
      type: 'project',
      projectId: entity.projectId,
      teamId: entity.teamId,
    }
  }
  return undefined
}

/**
 * Creates fallback target display metadata from one visible planning entity.
 *
 * @param entity - Visible planning entity that resolved to the target.
 * @param target - Canonical Project or Initiative update target.
 * @returns Display metadata used until an authoritative target projection loads.
 */
function createPlanningUpdateTargetSummary(
  entity: PlanningEntity,
  target: PlanningUpdateTargetView,
  scopeTeams: readonly ProjectDirectoryTeam[],
): PlanningUpdateTargetSummaryView {
  const team = target.type === 'project'
    ? scopeTeams.find((candidate) => candidate.id === target.teamId)
    : undefined
  const project = target.type === 'project'
    ? team?.projects.find((candidate) => candidate.id === target.projectId)
    : undefined
  return {
    context: target.type === 'project' ? team?.name ?? entity.teamId : undefined,
    health: entity.health,
    ownerMemberKey: entity.ownerMemberKey,
    progress: entity.progress,
    target,
    title: target.type === 'project' ? project?.name ?? target.projectId : entity.title,
  }
}

/**
 * Finds the loaded detail projection matching a canonical update target.
 *
 * @param details - Visible update target projections.
 * @param target - Canonical target selected by the route or a row.
 * @returns The matching projection, or undefined while it is not loaded.
 */
function resolvePlanningUpdateTargetDetail(
  details: readonly PlanningUpdateTargetDetailView[],
  target: PlanningUpdateTargetView,
) {
  return details.find((detail) => planningUpdateTargetsAreEqual(detail.summary.target, target))
}

/**
 * Resolves a row's update projection while preserving an explicit not-configured state.
 *
 * @param entity - Planning row being rendered.
 * @param details - Loaded Project and Initiative update projections.
 * @returns A loaded or fallback update projection, or undefined for non-target rows.
 */
function resolvePlanningEntityUpdateView(
  entity: PlanningEntity,
  details: readonly PlanningUpdateTargetDetailView[],
): PlanningTargetUpdateView | undefined {
  const target = resolvePlanningEntityUpdateTarget(entity)
  if (!target) return undefined
  return resolvePlanningUpdateTargetDetail(details, target)?.updateView ??
    createMissingPlanningTargetUpdateView(target)
}

/**
 * Creates a collision-resistant React key for a Project or Initiative target.
 *
 * @param target - Canonical update target.
 * @returns A key that preserves Team identity for duplicate Project IDs.
 */
function groupChildren(entities: PlanningEntity[]) {
  const result = new Map<string, PlanningEntity[]>()
  for (const entity of entities) {
    if (!entity.parentId) continue
    result.set(entity.parentId, [...(result.get(entity.parentId) ?? []), entity])
  }
  return result
}

function resolveGoalWorkItems(snapshot: PlanningSnapshot, goalId: string) {
  const contributingEntityIds = resolveActiveSubtreeEntityIds(snapshot.entities, goalId)
  const keys = new Set(snapshot.workItemLinks
    .filter((link) => [link.cycleId, link.milestoneId, ...link.goalIds]
      .some((entityId) => entityId !== undefined && contributingEntityIds.has(entityId)))
    .map((link) => `${link.teamId}\0${link.workItemId}`))
  return snapshot.workItems.filter((workItem) => keys.has(`${workItem.teamId}\0${workItem.id}`))
}

function resolveActiveSubtreeEntityIds(entities: readonly PlanningEntity[], goalId: string) {
  const childrenByParent = groupChildren([...entities])
  const selectedGoal = entities.find((entity) => entity.id === goalId)
  const result = new Set<string>()
  if (
    !selectedGoal ||
    selectedGoal.type !== 'goal' ||
    selectedGoal.archivedAt ||
    selectedGoal.status === 'canceled'
  ) {
    return result
  }
  result.add(goalId)
  const pending = [...(childrenByParent.get(goalId) ?? [])]

  while (pending.length > 0) {
    const entity = pending.pop()!
    if (result.has(entity.id)) continue
    if (entity.archivedAt || entity.status === 'canceled') continue
    result.add(entity.id)
    pending.push(...(childrenByParent.get(entity.id) ?? []))
  }

  return result
}

function resolveWorkItemStrategicTrace(
  snapshot: PlanningSnapshot,
  workItem: PlanningWorkItemSummary,
) {
  const link = snapshot.workItemLinks.find((candidate) =>
    candidate.teamId === workItem.teamId && candidate.workItemId === workItem.id,
  )
  if (!link) return []

  const entitiesById = new Map(snapshot.entities.map((entity) => [entity.id, entity]))
  const result: PlanningEntity[] = []
  const includedIds = new Set<string>()
  const strategicTypes = new Set<PlanningEntityType>([
    'goal',
    'initiative',
    'roadmap',
    'portfolio',
  ])

  for (const referenceId of [link.milestoneId, ...link.goalIds]) {
    if (!referenceId) continue
    const chain: PlanningEntity[] = []
    const visitedIds = new Set<string>()
    let entity = entitiesById.get(referenceId)
    while (entity && !visitedIds.has(entity.id)) {
      if (entity.archivedAt || entity.status === 'canceled') {
        chain.length = 0
        break
      }
      visitedIds.add(entity.id)
      if (strategicTypes.has(entity.type)) chain.unshift(entity)
      entity = entity.parentId ? entitiesById.get(entity.parentId) : undefined
    }
    for (const candidate of chain) {
      if (candidate.archivedAt || includedIds.has(candidate.id)) continue
      includedIds.add(candidate.id)
      result.push(candidate)
    }
  }

  return result
}

function resolveEntityTitle(entities: PlanningEntity[], entityId: string) {
  return entities.find((entity) => entity.id === entityId)?.title ?? entityId
}

function resolveInitialEntityType(entities: PlanningEntity[]): PlanningEntityType {
  if (entities.length === 0 || !entities.some((entity) => entity.type === 'portfolio')) {
    return 'portfolio'
  }
  if (entities.some((entity) => entity.type === 'initiative')) return 'goal'
  if (entities.some((entity) => entity.type === 'roadmap')) return 'initiative'
  return 'roadmap'
}

function dependencyEntitiesAreManageable(
  dependency: PlanningDependency,
  entities: readonly PlanningEntity[],
  canManageEntity?: PlanningScreenProps['canManageEntity'],
) {
  return [dependency.predecessorId, dependency.successorId].every((entityId) => {
    const entity = entities.find((candidate) => candidate.id === entityId)
    return entity !== undefined && (canManageEntity?.(entity) ?? true)
  })
}

function linkEntitiesAreEditable(
  link: PlanningWorkItemLink,
  entities: readonly PlanningEntity[],
  canLinkEntity?: PlanningScreenProps['canLinkEntity'],
) {
  const entityIds = [
    ...(link.cycleId ? [link.cycleId] : []),
    ...(link.milestoneId ? [link.milestoneId] : []),
    ...link.goalIds,
  ]
  return entityIds.every((entityId) => {
    const entity = entities.find((candidate) => candidate.id === entityId)
    return entity !== undefined && (canLinkEntity?.(entity) ?? true)
  })
}

function formatRange(range: PlanningEntity['forecast']) {
  return range.startDate === range.endDate ? range.endDate : `${range.startDate} – ${range.endDate}`
}

/** Narrows a dependency type while retaining all four start/finish relationships. */
function readDependencyType(value: FormDataEntryValue | null): ScheduleDependencyType {
  return value === 'start-to-start' ||
    value === 'finish-to-finish' ||
    value === 'start-to-finish'
    ? value
    : 'finish-to-start'
}

/** Reads a complete optional Planning dependency date constraint. */
function readPlanningDependencyConstraint(
  data: FormData,
): ScheduleDependencyConstraint | undefined {
  const kindValue = String(data.get('constraintKind') ?? '')
  if (!kindValue) return undefined
  const kind = kindValue === 'on' || kindValue === 'not-before' || kindValue === 'not-after'
    ? kindValue
    : undefined
  const anchorValue = String(data.get('constraintAnchor') ?? '')
  const anchor = anchorValue === 'start' || anchorValue === 'finish'
    ? anchorValue
    : undefined
  const date = String(data.get('constraintDate') ?? '')
  return kind && anchor && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? { anchor, date, kind }
    : undefined
}
