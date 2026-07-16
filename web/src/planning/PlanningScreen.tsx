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
  PlanningWorkItemLink,
  PlanningWorkItemSummary,
} from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import type { PlanningViewId } from '../routes/paths'
import {
  resolvePlanningMoveSelection,
  resolvePlanningParentCandidates,
  type PlanningMoveSelection,
} from './hierarchy'
import {
  createPlanningEntityDetailKey,
  isOpenPlanningEntity,
  isPlanningWorkItemLinkCandidate,
  resolvePlanningCycleRolloverTargets,
} from './selectors'

/**
 * PlanningScreen が表示する locale 済み文言です。
 */
export type PlanningLabels = {
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
  /** Goal / OKR framework ごとの文言です。 */
  goalFrameworkValues: Record<PlanningGoalFramework, string>
}

/**
 * PlanningScreen の入力です。
 */
export type PlanningScreenProps = {
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
  /** URL から初期選択する entity ID です。 */
  initialSelectedEntityId?: string
  /** Current user が entity の構造を管理できるか判定する callback です。 */
  canManageEntity?: (entity: PlanningEntity) => boolean
  /** Current user が entity に status update を追加できるか判定する callback です。 */
  canUpdateEntityStatus?: (entity: PlanningEntity) => boolean
  /** Current user が canonical Work Item の Planning link を更新できるか判定する callback です。 */
  canUpdateWorkItemLink?: (workItem: PlanningWorkItemSummary) => boolean
  /** Current user が Work Item link から entity を参照できるか判定する callback です。 */
  canLinkEntity?: (entity: PlanningEntity) => boolean
  /** View tab 選択時の callback です。 */
  onViewChange?: (view: PlanningViewId) => void
  /** Snapshot 再取得 callback です。 */
  onRetry?: () => void
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
  ) => void | Promise<void>
  /** Dependency 削除 callback です。 */
  onDeleteDependency?: (dependency: PlanningDependency) => void | Promise<void>
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
}

const timelineEntityTypes = new Set<PlanningEntityType>([
  'cycle',
  'milestone',
  'release',
  'phase',
])
/**
 * Timeline、roadmap、portfolio を同じ snapshot から描画します。
 */
export function PlanningScreen({
  activeView,
  canLinkEntity,
  canManageEntity,
  canUpdateEntityStatus,
  canUpdateWorkItemLink,
  errorMessage,
  initialSelectedEntityId,
  isLoading = false,
  labels,
  onAddStatusUpdate,
  onArchiveEntity,
  onChangeMilestoneDate,
  onCreateDependency,
  onCreateEntity,
  onDeleteDependency,
  onDeleteWorkItemLink,
  onDuplicateEntity,
  onMoveEntity,
  onOpenWorkItem,
  onSaveWorkItemLink,
  onRetry,
  onRolloverCycle,
  onViewChange,
  snapshot,
}: PlanningScreenProps) {
  const activeEntities = useMemo(
    () => snapshot?.entities.filter((entity) => !entity.archivedAt) ?? [],
    [snapshot],
  )
  const [selectedEntityId, setSelectedEntityId] = useState(initialSelectedEntityId)
  const selectedEntity = activeEntities.find((entity) => entity.id === selectedEntityId) ??
    activeEntities.find((entity) => entity.type === 'goal') ?? activeEntities[0]

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
          {(['timeline', 'roadmap', 'portfolio'] as const).map((view) => (
            <button
              aria-selected={activeView === view}
              className={activeView === view
                ? 'workbench-button-primary min-h-10 px-4'
                : 'workbench-button-secondary min-h-10 px-4'}
              data-testid={`planning-view-${view}`}
              key={view}
              role="tab"
              type="button"
              onClick={() => onViewChange?.(view)}
            >
              {labels[view]}
            </button>
          ))}
        </div>
      </header>

      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
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
        {isLoading ? (
          <p className="py-16 text-center text-sm font-semibold text-[var(--workbench-muted)]">
            {labels.loading}
          </p>
        ) : activeEntities.length === 0 ? (
          <>
            <section className="workbench-panel px-6 py-16 text-center">
              <h2 className="text-lg font-semibold text-[var(--workbench-text)]">{labels.emptyTitle}</h2>
              <p className="mt-2 text-sm font-medium text-[var(--workbench-muted)]">{labels.emptyDescription}</p>
            </section>
            {snapshot ? (
              <CreateEntityPanel
                canManageEntity={canManageEntity}
                entities={[]}
                labels={labels}
                onCreate={onCreateEntity}
              />
            ) : null}
          </>
        ) : snapshot ? (
          <>
            {activeView === 'timeline' ? (
              <TimelineView
                canManageEntity={canManageEntity}
                canUpdateEntityStatus={canUpdateEntityStatus}
                labels={labels}
                selectedEntity={selectedEntity}
                snapshot={snapshot}
                onAddStatusUpdate={onAddStatusUpdate}
                onArchiveEntity={onArchiveEntity}
                onChangeMilestoneDate={onChangeMilestoneDate}
                onCreateDependency={onCreateDependency}
                onDeleteDependency={onDeleteDependency}
                onDuplicateEntity={onDuplicateEntity}
                onMoveEntity={onMoveEntity}
                onRolloverCycle={onRolloverCycle}
                onSelectEntity={setSelectedEntityId}
              />
            ) : null}
            {activeView === 'roadmap' ? (
              <RoadmapView
                canLinkEntity={canLinkEntity}
                canManageEntity={canManageEntity}
                canUpdateEntityStatus={canUpdateEntityStatus}
                canUpdateWorkItemLink={canUpdateWorkItemLink}
                labels={labels}
                selectedEntity={selectedEntity}
                snapshot={snapshot}
                onArchiveEntity={onArchiveEntity}
                onAddStatusUpdate={onAddStatusUpdate}
                onDeleteWorkItemLink={onDeleteWorkItemLink}
                onDuplicateEntity={onDuplicateEntity}
                onMoveEntity={onMoveEntity}
                onOpenWorkItem={onOpenWorkItem}
                onSaveWorkItemLink={onSaveWorkItemLink}
                onSelectEntity={setSelectedEntityId}
              />
            ) : null}
            {activeView === 'portfolio' ? (
              <PortfolioView labels={labels} snapshot={snapshot} />
            ) : null}
            <CreateEntityPanel
              canManageEntity={canManageEntity}
              entities={activeEntities}
              labels={labels}
              onCreate={onCreateEntity}
            />
          </>
        ) : null}
      </div>
    </section>
  )
}

function TimelineView({
  canManageEntity,
  canUpdateEntityStatus,
  labels,
  onAddStatusUpdate,
  onArchiveEntity,
  onChangeMilestoneDate,
  onCreateDependency,
  onDeleteDependency,
  onDuplicateEntity,
  onMoveEntity,
  onRolloverCycle,
  onSelectEntity,
  selectedEntity,
  snapshot,
}: {
  canManageEntity?: PlanningScreenProps['canManageEntity']
  canUpdateEntityStatus?: PlanningScreenProps['canUpdateEntityStatus']
  labels: PlanningLabels
  onAddStatusUpdate?: PlanningScreenProps['onAddStatusUpdate']
  onArchiveEntity?: PlanningScreenProps['onArchiveEntity']
  onChangeMilestoneDate?: PlanningScreenProps['onChangeMilestoneDate']
  onCreateDependency?: PlanningScreenProps['onCreateDependency']
  onDeleteDependency?: PlanningScreenProps['onDeleteDependency']
  onDuplicateEntity?: PlanningScreenProps['onDuplicateEntity']
  onMoveEntity?: PlanningScreenProps['onMoveEntity']
  onRolloverCycle?: PlanningScreenProps['onRolloverCycle']
  onSelectEntity: (entityId: string) => void
  selectedEntity?: PlanningEntity
  snapshot: PlanningSnapshot
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
          <table className="w-full min-w-[900px] border-collapse text-left">
            <thead>
              <tr className="workbench-table-head">
                <th className="px-5 py-3" scope="col">{labels.entity}</th>
                <th className="px-5 py-3" scope="col">{labels.baseline}</th>
                <th className="px-5 py-3" scope="col">{labels.forecast}</th>
                <th className="px-5 py-3" scope="col">{labels.progress}</th>
                <th className="px-5 py-3" scope="col">{labels.health}</th>
              </tr>
            </thead>
            <tbody>
              {entities.map((entity) => {
                const critical = criticalEntityIds.has(entity.id)
                return (
                  <tr
                    className={`border-b border-[var(--workbench-border)] ${critical ? 'bg-red-50/70' : 'bg-white'}`}
                    data-critical={critical ? 'true' : 'false'}
                    data-testid={`timeline-entity-${entity.id}`}
                    key={entity.id}
                  >
                    <td className="px-5 py-4">
                      <button className="text-left" type="button" onClick={() => onSelectEntity(entity.id)}>
                        <span className="block text-sm font-semibold text-[var(--workbench-text)]">{entity.title}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
                          {labels.entityTypes[entity.type]}
                          {critical ? <span className="workbench-badge-danger">{labels.criticalPath}</span> : null}
                        </span>
                      </button>
                    </td>
                    <td className="px-5 py-4 text-sm font-medium text-[var(--workbench-muted)]">
                      {formatRange(entity.baseline)}
                    </td>
                    <td className="px-5 py-4 text-sm font-semibold text-[var(--workbench-text)]">
                      {formatRange(entity.forecast)}
                    </td>
                    <td className="px-5 py-4">
                      <Progress value={entity.progress} labels={labels} />
                    </td>
                    <td className="px-5 py-4">
                      <HealthBadge health={entity.rollupHealth} labels={labels} />
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
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--workbench-border)] p-3" key={dependency.id}>
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
      {detailEntity ? (
        <div
          className="grid grid-cols-2 items-start gap-5 max-[900px]:grid-cols-1"
          data-testid="planning-timeline-entity-detail"
          key={`timeline-detail:${createPlanningEntityDetailKey(detailEntity)}`}
        >
          <StatusUpdateEditor
            entity={detailEntity}
            labels={labels}
            onAdd={(canUpdateEntityStatus?.(detailEntity) ?? true)
              ? onAddStatusUpdate
              : undefined}
          />
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
        const lagDays = Math.max(0, Math.trunc(Number(data.get('lagDays')) || 0))
        if (predecessorId && successorId && predecessorId !== successorId) {
          void onCreate?.(predecessorId, successorId, type, lagDays)
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
  canUpdateEntityStatus,
  canUpdateWorkItemLink,
  labels,
  onAddStatusUpdate,
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
  canUpdateEntityStatus?: PlanningScreenProps['canUpdateEntityStatus']
  canUpdateWorkItemLink?: PlanningScreenProps['canUpdateWorkItemLink']
  labels: PlanningLabels
  onAddStatusUpdate?: PlanningScreenProps['onAddStatusUpdate']
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
  const canUpdateSelectedEntityStatus = selectedEntity
    ? canUpdateEntityStatus?.(selectedEntity) ?? true
    : false

  return (
    <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(300px,0.8fr)] items-start gap-5 max-[1000px]:grid-cols-1" data-testid="planning-roadmap">
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
      <div className="grid content-start gap-5">
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
            <StatusUpdateEditor
              entity={selectedEntity}
              key={`roadmap-status:${createPlanningEntityDetailKey(selectedEntity)}`}
              labels={labels}
              onAdd={canUpdateSelectedEntityStatus ? onAddStatusUpdate : undefined}
            />
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
        className={`grid w-full grid-cols-[minmax(0,1fr)_100px_110px] items-center gap-3 rounded-lg border p-3 text-left ${selectedEntityId === entity.id ? 'border-[#6fbfb4] bg-[#e5f7f4]' : 'border-[var(--workbench-border)] bg-white hover:border-[#99d7cf]'}`}
        data-testid={`roadmap-entity-${entity.id}`}
        style={{ paddingLeft: `${12 + depth * 20}px` }}
        type="button"
        onClick={() => onSelectEntity(entity.id)}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-[var(--workbench-text)]">{entity.title}</span>
          <span className="mt-1 block text-xs font-medium text-[var(--workbench-muted)]">
            {labels.entityTypes[entity.type]} · {labels.workItemCount(entity.linkedWorkItemCount)}
          </span>
        </span>
        <span className="text-sm font-semibold text-[var(--workbench-text)]">{labels.percent(entity.progress)}</span>
        <HealthBadge health={entity.rollupHealth} labels={labels} />
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
  canManageEntity,
  entities,
  labels,
  onCreate,
}: {
  canManageEntity?: PlanningScreenProps['canManageEntity']
  entities: PlanningEntity[]
  labels: PlanningLabels
  onCreate?: PlanningScreenProps['onCreateEntity']
}) {
  const [entityType, setEntityType] = useState<PlanningEntityType>(() =>
    resolveInitialEntityType(entities),
  )
  const [goalFramework, setGoalFramework] = useState<PlanningGoalFramework>('goal')
  const parentCandidates = resolvePlanningParentCandidates(entities, entityType, goalFramework)
    .filter((entity) => canManageEntity?.(entity) ?? true)
  const requiresParent = entityType !== 'portfolio' && entityType !== 'cycle'
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
        <label className="grid gap-2 text-sm font-semibold">{labels.dependencyType}<select className="workbench-input h-10 px-3" name="entityType" value={entityType} onChange={(event) => setEntityType(event.target.value as PlanningEntityType)}>{(Object.keys(labels.entityTypes) as PlanningEntityType[]).map((type) => <option key={type} value={type}>{labels.entityTypes[type]}</option>)}</select></label>
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
        <label className="grid gap-2 text-sm font-semibold">{labels.moveTarget}<select className="workbench-input h-10 px-3" defaultValue={parentCandidates[0]?.id ?? ''} disabled={!requiresParent} key={`parent:${entityType}:${goalFramework}`} name="parentId" required={requiresParent}>{requiresParent ? null : <option value="">{labels.moveToRoot}</option>}{parentCandidates.map((entity) => <option key={entity.id} value={entity.id}>{entity.title}</option>)}</select></label>
        <PlanningInput label={labels.team} name="teamId" required={entityType === 'cycle'} />
        <PlanningInput label={labels.project} name="projectId" />
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
      <button className="workbench-button-primary min-h-10 px-4 disabled:opacity-50" disabled={!onCreate || (requiresParent && parentCandidates.length === 0)} type="submit">{labels.create}</button>
    </form>
  )
}

function StatusUpdateEditor({
  entity,
  labels,
  onAdd,
}: {
  entity: PlanningEntity
  labels: PlanningLabels
  onAdd?: PlanningScreenProps['onAddStatusUpdate']
}) {
  return (
    <section className="workbench-panel grid gap-4 p-5" data-testid="planning-status-update">
      <h2 className="text-base font-semibold text-[var(--workbench-text)]">{labels.statusUpdate}</h2>
      <div className="grid gap-3" data-testid="planning-status-update-history">
        {entity.statusUpdates.map((update) => (
          <article className="rounded-lg border border-[var(--workbench-border)] bg-white p-3" key={update.id}>
            <p className="text-sm font-medium text-[var(--workbench-text)]">{update.message}</p>
            <p className="mt-2 text-xs font-medium text-[var(--workbench-muted)]">
              {labels.statusUpdateMeta(update.authorMemberKey, update.createdAt)}
            </p>
            {update.health || update.risk ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {update.health ? <HealthBadge health={update.health} labels={labels} /> : null}
                {update.risk ? (
                  <span className="workbench-badge">{labels.risk}: {labels.riskValues[update.risk]}</span>
                ) : null}
              </div>
            ) : null}
          </article>
        ))}
        {entity.statusUpdates.length === 0 ? (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">{labels.noStatusUpdates}</p>
        ) : null}
      </div>
      <form className="grid gap-3 border-t border-[var(--workbench-border)] pt-4" onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const message = String(data.get('message') ?? '').trim()
        const health = readHealth(data.get('health'))
        const risk = readRisk(data.get('risk'))
        if (message) void onAdd?.(entity, message, health, risk)
      }}>
        <label className="grid gap-2 text-sm font-semibold">{labels.statusMessage}<textarea className="workbench-input min-h-20 p-3" name="message" required /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-2 text-sm font-semibold">{labels.health}<select className="workbench-input h-10 px-3" defaultValue={entity.health} name="health">{(Object.keys(labels.healthValues) as PlanningHealth[]).map((value) => <option key={value} value={value}>{labels.healthValues[value]}</option>)}</select></label>
          <label className="grid gap-2 text-sm font-semibold">{labels.risk}<select className="workbench-input h-10 px-3" defaultValue={entity.risk} name="risk">{(Object.keys(labels.riskValues) as PlanningRisk[]).map((value) => <option key={value} value={value}>{labels.riskValues[value]}</option>)}</select></label>
        </div>
        <button className="workbench-button-primary min-h-10 px-4 disabled:opacity-50" disabled={!onAdd} type="submit">{labels.addStatusUpdate}</button>
      </form>
    </section>
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

function PortfolioView({ labels, snapshot }: { labels: PlanningLabels; snapshot: PlanningSnapshot }) {
  const rows = snapshot.entities.filter((entity) =>
    !entity.archivedAt && ['portfolio', 'roadmap', 'initiative'].includes(entity.type),
  )
  return (
    <section className="workbench-panel overflow-hidden" data-testid="planning-portfolio">
      <PlanningSectionHeader title={labels.portfolioTitle} description={labels.portfolioDescription} />
      <div className="overflow-x-auto border-t border-[var(--workbench-border)]">
        <table className="w-full min-w-[900px] border-collapse text-left">
          <thead><tr className="workbench-table-head"><th className="px-5 py-3">{labels.entity}</th><th className="px-5 py-3">{labels.progress}</th><th className="px-5 py-3">{labels.reportedHealth}</th><th className="px-5 py-3">{labels.rollupHealth}</th><th className="px-5 py-3">{labels.risk}</th><th className="px-5 py-3">{labels.linkedWorkItems}</th><th className="px-5 py-3">{labels.forecast}</th></tr></thead>
          <tbody>{rows.map((entity) => <tr className="border-b border-[var(--workbench-border)] bg-white" data-testid={`portfolio-entity-${entity.id}`} key={entity.id}><td className="px-5 py-4"><span className="block text-sm font-semibold">{entity.title}</span><span className="mt-1 block text-xs text-[var(--workbench-muted)]">{labels.entityTypes[entity.type]}</span></td><td className="px-5 py-4"><Progress labels={labels} value={entity.progress} /></td><td className="px-5 py-4"><HealthBadge health={entity.health} labels={labels} /></td><td className="px-5 py-4"><HealthBadge health={entity.rollupHealth} labels={labels} /></td><td className="px-5 py-4 text-sm font-semibold">{labels.riskValues[entity.risk]}</td><td className="px-5 py-4 text-sm font-semibold">{labels.workItemCount(entity.linkedWorkItemCount)}</td><td className="px-5 py-4 text-sm font-medium">{formatRange(entity.forecast)}</td></tr>)}</tbody>
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
  return <span className={classes[health]}>{labels.healthValues[health]}</span>
}

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

function readDependencyType(value: FormDataEntryValue | null): PlanningDependencyType {
  return value === 'start-to-start' || value === 'finish-to-finish' ? value : 'finish-to-start'
}

function readHealth(value: FormDataEntryValue | null): PlanningHealth {
  return value === 'on-track' || value === 'at-risk' || value === 'off-track' ? value : 'unknown'
}

function readRisk(value: FormDataEntryValue | null): PlanningRisk {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical' ? value : 'none'
}
