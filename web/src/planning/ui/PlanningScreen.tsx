import type {
  CreatePlanningEntityInput,
  PlanningDependency,
  PlanningDependencyType,
  PlanningEntity,
  PlanningEntityStatus,
  PlanningEntityType,
  PlanningGoalFramework,
  PlanningHealth,
  PlanningRisk,
  PlanningSnapshot,
  ScheduleDependencyConstraint,
  WorkItemDependencyEndpoint,
  WorkItemScheduleDependency,
  WorkItemScheduleDependencyPatch,
  PlanningWorkItemLink,
  PlanningWorkItemSummary,
  WorkItemAffectedProject,
} from '@mukuroji/contracts'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
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
  /** Duplicate target ID field の文言です。 */
  duplicateId: string
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
  /** Portfolio section の見出しです。 */
  portfolioTitle: string
  /** Portfolio section の説明です。 */
  portfolioDescription: string
  /** Entity name の列見出しです。 */
  entity: string
  /** Entity ID field の文言です。 */
  entityId: string
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
  /** Status update section の見出しです。 */
  statusUpdate: string
  /** Status update message field の文言です。 */
  statusMessage: string
  /** Status update 追加ボタンの文言です。 */
  addStatusUpdate: string
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
  dependencyTypes: Record<PlanningDependencyType, string>
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
  /** Current user が entity に status update を追加できるか判定する callback です。 */
  canUpdateEntityStatus?: (entity: PlanningEntity) => boolean
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
    type: PlanningDependencyType,
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
  /** Entity archive callback です。 */
  onArchiveEntity?: (entity: PlanningEntity) => void | Promise<void>
  /** Entity duplicate callback です。 */
  onDuplicateEntity?: (entity: PlanningEntity, targetId: string) => void | Promise<void>
  /** Entity move callback です。 */
  onMoveEntity?: (
    entity: PlanningEntity,
    target: PlanningMoveSelection,
  ) => void | Promise<void>
  /** Entity へ status update を追加する callback です。 */
  onAddStatusUpdate?: (
    entity: PlanningEntity,
    message: string,
    health: PlanningHealth,
    risk: PlanningRisk,
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
}

/** Authentication and locale used to derive a selected target's AI source. */
export type PlanningScreenAiAssistance = {
  /** Active Workspace member bearer token. */
  accessToken: string
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
  canCreateInScope,
  canLinkEntity,
  canManageUpdateCadence,
  canManageEntity,
  canManageWorkItemDependencyEndpoint,
  canPublishUpdate,
  canUpdateWorkItemLink,
  createScopeTeams = [],
  errorMessage,
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
  onViewChange,
  onUpdateWorkItemDependency,
  snapshot,
  updateCollaboration,
  updateHistoryErrorMessage,
  updateTargetDetails = [],
}: PlanningScreenProps) {
  const activeEntities = useMemo(
    () => snapshot?.entities.filter((entity) => !entity.archivedAt) ?? [],
    [snapshot],
  )
  const [selectedEntityId, setSelectedEntityId] = useState(initialSelectedEntityId)
  const [selectedUpdateTarget, setSelectedUpdateTarget] = useState(initialSelectedUpdateTarget)
  const pendingViewFocus = useRef<PlanningViewId | undefined>(undefined)
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
  const selectedAiAssistance: PlanningStatusUpdateAiAssistance | undefined =
    aiAssistance && snapshot && resolvedSelectedUpdateTarget && onPublishUpdate && canPublishSelectedUpdate
      ? {
          accessToken: aiAssistance.accessToken,
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
        {errorMessage ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3" role="alert">
            <p className="text-sm font-semibold text-red-800">{errorMessage || labels.error}</p>
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
            <p className="max-w-[820px] text-sm font-semibold text-amber-900">
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
                  canManageWorkItemDependencyEndpoint={canManageWorkItemDependencyEndpoint}
                  labels={labels}
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
                />
              ) : null}
              {activeEntities.length > 0 && activeView === 'roadmap' ? (
                <RoadmapView
                  canLinkEntity={canLinkEntity}
                  canManageEntity={canManageEntity}
                  canUpdateWorkItemLink={canUpdateWorkItemLink}
                  labels={labels}
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
                  onSelectEntity={handleSelectEntity}
                  snapshot={snapshot}
                  updateTargetDetails={updateTargetDetails}
                />
              ) : null}
              <CreateEntityPanel
                canCreateInScope={canCreateInScope}
                canManageEntity={canManageEntity}
                createScopeTeams={createScopeTeams}
                entities={activeEntities}
                labels={labels}
                onCreate={onCreateEntity}
              />
            </div>
            {selectedUpdateSummary && selectedUpdateView && resolvedSelectedUpdateTarget ? (
              <PlanningUpdateDetailPane
                aiAssistance={selectedAiAssistance}
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
  labels,
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
  selectedEntity,
  snapshot,
  updateTargetDetails,
}: {
  canManageEntity?: PlanningScreenProps['canManageEntity']
  canManageWorkItemDependencyEndpoint?: PlanningScreenProps['canManageWorkItemDependencyEndpoint']
  labels: PlanningLabels
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
                    className={`border-b border-[var(--workbench-border)] ${critical ? 'bg-red-50/70' : 'bg-white'}`}
                    data-critical={critical ? 'true' : 'false'}
                    data-testid={`timeline-entity-${entity.id}`}
                    key={entity.id}
                  >
                    <td className="w-full px-5 py-4">
                      <button className="min-w-0 max-w-full text-left" type="button" onClick={() => onSelectEntity(entity.id)}>
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
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--workbench-border)] p-3 target:border-[var(--workbench-primary)] target:bg-[#e5f7f4]"
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
          {(Object.keys(labels.dependencyTypes) as PlanningDependencyType[]).map((type) => (
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
        <p className="text-sm font-semibold text-red-700" role="alert">
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
  labels,
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
  labels: PlanningLabels
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
                  className="rounded-lg border border-[var(--workbench-border)] bg-white p-3 text-left hover:border-[var(--workbench-primary)]"
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
  labels,
  onSelectEntity,
  selectedEntityId,
}: {
  childrenByParent: Map<string, PlanningEntity[]>
  depth: number
  entity: PlanningEntity
  labels: PlanningLabels
  onSelectEntity: (entityId: string) => void
  selectedEntityId?: string
}) {
  return (
    <div>
      <button
        aria-current={selectedEntityId === entity.id ? 'true' : undefined}
        className={`grid w-full min-w-0 grid-cols-[minmax(0,1fr)_minmax(72px,auto)] items-center gap-2 rounded-lg border p-3 text-left min-[640px]:grid-cols-[minmax(0,1fr)_100px_110px] min-[640px]:gap-3 ${selectedEntityId === entity.id ? 'border-[#6fbfb4] bg-[#e5f7f4]' : 'border-[var(--workbench-border)] bg-white hover:border-[#99d7cf]'}`}
        data-testid={`roadmap-entity-${entity.id}`}
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
  onArchive,
  onDuplicate,
  onMove,
}: {
  canManageEntity?: PlanningScreenProps['canManageEntity']
  entities: PlanningEntity[]
  entity: PlanningEntity
  labels: PlanningLabels
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
        <form className="grid gap-2" onSubmit={(event) => {
          event.preventDefault()
          const targetId = String(new FormData(event.currentTarget).get('targetId') ?? '').trim()
          if (targetId) void onDuplicate(entity, targetId)
        }}>
          <label className="grid gap-2 text-sm font-semibold">{labels.duplicateId}<input className="workbench-input h-10 px-3" name="targetId" required /></label>
          <button className="workbench-button-secondary min-h-10 px-4" type="submit">{labels.duplicate}</button>
        </form>
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
            <div className="grid grid-cols-2 gap-3" data-testid="planning-root-move-scope">
              <PlanningInput
                defaultValue={entity.teamId}
                label={labels.team}
                name="teamId"
                required={entity.type === 'cycle'}
              />
              <PlanningInput
                defaultValue={entity.projectId}
                label={labels.project}
                name="projectId"
              />
            </div>
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
}: {
  canCreateInScope?: PlanningScreenProps['canCreateInScope']
  canManageEntity?: PlanningScreenProps['canManageEntity']
  createScopeTeams: readonly ProjectDirectoryTeam[]
  entities: PlanningEntity[]
  labels: PlanningLabels
  onCreate?: PlanningScreenProps['onCreateEntity']
}) {
  const [entityType, setEntityType] = useState<PlanningEntityType>(() =>
    resolveInitialEntityType(entities),
  )
  const [goalFramework, setGoalFramework] = useState<PlanningGoalFramework>('goal')
  const canCreateInWorkspace = canCreateInScope?.({}) ?? true
  const manageableScopeTeams = createScopeTeams.flatMap((team) =>
    canCreateInScope?.({ teamId: team.id }) === false
      ? []
      : [{
          ...team,
          projects: team.projects.filter((project) =>
            canCreateInScope?.({ teamId: team.id, projectId: project.id }) ?? true),
        }],
  )
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
          id: String(data.get('entityId') ?? '').trim(),
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
              count: Math.max(1, Number(data.get('cadenceCount')) || 1),
            },
            capacity: Math.max(0, Number(data.get('capacity')) || 0),
            carryOverPolicy: data.get('carryOverPolicy') === 'keep-incomplete'
              ? 'keep-incomplete'
              : 'move-incomplete',
          } : {}),
        }
        if (input.id && input.title && input.ownerMemberKey && baseline.startDate && baseline.endDate) {
          void onCreate?.(input)
        }
      }}
    >
      <h2 className="text-base font-semibold text-[var(--workbench-text)]">{labels.createEntity}</h2>
      <div className="grid grid-cols-4 gap-3 max-[1000px]:grid-cols-2 max-[640px]:grid-cols-1">
        <PlanningInput label={labels.entityId} name="entityId" required />
        <PlanningInput label={labels.entity} name="title" required />
        <label className="grid gap-2 text-sm font-semibold">{labels.entityType}<select className="workbench-input h-10 px-3" name="entityType" value={entityType} onChange={(event) => setEntityType(event.target.value as PlanningEntityType)}>{(Object.keys(labels.entityTypes) as PlanningEntityType[]).map((type) => <option key={type} value={type}>{labels.entityTypes[type]}</option>)}</select></label>
        <PlanningInput label={labels.owner} name="ownerMemberKey" required />
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
          <label className="grid gap-2 text-sm font-semibold">{labels.cycle}<select className="workbench-input h-10 px-3" name="cadenceUnit"><option value="week">{labels.cadenceWeek}</option><option value="month">{labels.cadenceMonth}</option></select></label>
          <PlanningInput label={labels.cycle} name="cadenceCount" type="number" defaultValue="2" />
          <PlanningInput label={labels.capacity(0)} name="capacity" type="number" defaultValue="0" />
          <label className="grid gap-2 text-sm font-semibold">{labels.cycleRollover}<select className="workbench-input h-10 px-3" name="carryOverPolicy"><option value="move-incomplete">{labels.carryOverMove}</option><option value="keep-incomplete">{labels.carryOverKeep}</option></select></label>
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
  labels,
  onSelectEntity,
  snapshot,
  updateTargetDetails,
}: {
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
                <tr className="border-b border-[var(--workbench-border)] bg-white" data-testid={`portfolio-entity-${entity.id}`} key={entity.id}>
                  <td className="w-full px-5 py-4">
                    <button className="min-w-0 max-w-full text-left" onClick={() => onSelectEntity(entity.id)} type="button">
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

function PlanningInput({ defaultValue, label, name, required = false, type = 'text' }: { defaultValue?: string; label: string; name: string; required?: boolean; type?: 'date' | 'number' | 'text' }) {
  return <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">{label}<input className="workbench-input h-10 px-3" defaultValue={defaultValue} name={name} required={required} type={type} /></label>
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
function readDependencyType(value: FormDataEntryValue | null): PlanningDependencyType {
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
