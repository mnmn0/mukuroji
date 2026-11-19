import type {
  CycleAutomation,
  PlanningEntity,
  PlanningSnapshot,
  PlanningWorkItemLink,
  PlanningWorkItemSummary,
} from '@mukuroji/contracts'
import { CYCLE_WORK_ITEMS_BATCH_LIMIT } from '@mukuroji/contracts'
import { useState } from 'react'
import { resolveCycleBacklog, summarizeCycleCommitment } from '../model/cycles'

/** Localized labels of the Cycle planning panel. */
export type CyclePlanningLabels = {
  /** Panel heading. */
  panel: string
  /** Cycle selector label. */
  select: string
  /** No active Cycle exists. */
  empty: string
  /** Committed Work Items against the capacity. */
  commitment: (count: number, capacity: number) => string
  /** Capacity still available. */
  remaining: (count: number) => string
  /** Work Items carried over into the Cycle. */
  carriedOver: (count: number) => string
  /** Badge on a carried-over Work Item. */
  carriedOverBadge: string
  /** Automation section heading. */
  automation: string
  /** Create-next switch. */
  automationCreateNext: string
  /** Rollover-at-end switch. */
  automationRolloverAtEnd: string
  /** How automation evaluates dates. */
  automationNote: string
  /** Save automation button. */
  automationSave: string
  /** Create next Cycle button. */
  createNext: string
  /** Name of the already created next Cycle. */
  nextExists: (title: string) => string
  /** Backlog section heading. */
  backlog: string
  /** Empty backlog. */
  backlogEmpty: string
  /** Cycle Work Items section heading. */
  items: string
  /** Empty Cycle. */
  itemsEmpty: string
  /** Selects the first items of a list. */
  selectFirst: (count: number) => string
  /** Clears a selection. */
  clearSelection: string
  /** Adds the selected Work Items. */
  add: (count: number) => string
  /** Removes the selected Work Items. */
  remove: (count: number) => string
  /** Selection limit message. */
  selectionLimit: (count: number) => string
}

/** Props of the Cycle planning panel. */
export type CyclePlanningPanelProps = {
  /** Current Planning snapshot. */
  snapshot: PlanningSnapshot
  /** Localized labels. */
  labels: CyclePlanningLabels
  /** Whether the viewer manages a Cycle. */
  canManageEntity?: (entity: PlanningEntity) => boolean
  /** Whether the viewer can link Work Items to a Cycle. */
  canLinkEntity?: (entity: PlanningEntity) => boolean
  /** Whether the viewer can change a Work Item's Planning link. */
  canUpdateWorkItemLink?: (workItem: PlanningWorkItemSummary) => boolean
  /** Creates the next Cycle. */
  onCreateNextCycle?: (cycle: PlanningEntity) => void | Promise<void>
  /** Saves the Cycle automation. */
  onUpdateCycleAutomation?: (
    cycle: PlanningEntity,
    automation: CycleAutomation | null,
  ) => void | Promise<void>
  /** Adds Work Items to, or removes them from, a Cycle. */
  onSetCycleWorkItems?: (
    cycle: PlanningEntity,
    action: 'add' | 'remove',
    workItems: PlanningWorkItemSummary[],
  ) => void | Promise<void>
}

function workItemKey(workItem: Pick<PlanningWorkItemSummary, 'teamId' | 'id'>) {
  return `${workItem.teamId}/${workItem.id}`
}

/**
 * Shows a Cycle's commitment against capacity and carried-over Work Items, its automation, and
 * lets the viewer add or remove many Work Items at once.
 */
export function CyclePlanningPanel({
  canLinkEntity,
  canManageEntity,
  canUpdateWorkItemLink,
  labels,
  onCreateNextCycle,
  onSetCycleWorkItems,
  onUpdateCycleAutomation,
  snapshot,
}: CyclePlanningPanelProps) {
  const cycles = snapshot.entities.filter((entity) => entity.type === 'cycle' && !entity.archivedAt)
  const [selectedId, setSelectedId] = useState(
    () => cycles.find((cycle) => cycle.status === 'active')?.id ?? cycles[0]?.id ?? '',
  )
  const cycle = cycles.find((candidate) => candidate.id === selectedId) ?? cycles[0]
  if (!cycle) {
    return (
      <section className="workbench-panel grid gap-3 p-5" data-testid="cycle-planning">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]">{labels.panel}</h2>
        <p className="text-sm font-medium text-[var(--workbench-muted)]">{labels.empty}</p>
      </section>
    )
  }
  return (
    <section className="workbench-panel grid gap-5 p-5" data-testid="cycle-planning">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]">{labels.panel}</h2>
        <label className="grid min-w-56 gap-2 text-sm font-semibold text-[var(--workbench-text)] max-[760px]:w-full">
          {labels.select}
          <select
            className="workbench-input h-10 px-3"
            data-testid="cycle-planning-select"
            value={cycle.id}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {cycles.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.title}</option>
            ))}
          </select>
        </label>
      </div>
      <CycleDetail
        canLink={canLinkEntity?.(cycle) ?? true}
        canManage={canManageEntity?.(cycle) ?? true}
        canUpdateWorkItemLink={canUpdateWorkItemLink}
        cycle={cycle}
        key={cycle.id}
        labels={labels}
        onCreateNextCycle={onCreateNextCycle}
        onSetCycleWorkItems={onSetCycleWorkItems}
        onUpdateCycleAutomation={onUpdateCycleAutomation}
        snapshot={snapshot}
      />
    </section>
  )
}

function CycleDetail({
  canLink,
  canManage,
  canUpdateWorkItemLink,
  cycle,
  labels,
  onCreateNextCycle,
  onSetCycleWorkItems,
  onUpdateCycleAutomation,
  snapshot,
}: {
  canLink: boolean
  canManage: boolean
  canUpdateWorkItemLink?: CyclePlanningPanelProps['canUpdateWorkItemLink']
  cycle: PlanningEntity
  labels: CyclePlanningLabels
  onCreateNextCycle?: CyclePlanningPanelProps['onCreateNextCycle']
  onSetCycleWorkItems?: CyclePlanningPanelProps['onSetCycleWorkItems']
  onUpdateCycleAutomation?: CyclePlanningPanelProps['onUpdateCycleAutomation']
  snapshot: PlanningSnapshot
}) {
  const summary = summarizeCycleCommitment(cycle, snapshot.workItemLinks)
  const open = cycle.status !== 'completed' && cycle.status !== 'canceled'
  const nextCycle = cycle.nextCycleId === undefined
    ? undefined
    : snapshot.entities.find((entity) => entity.id === cycle.nextCycleId)
  const workItemsByKey = new Map(snapshot.workItems.map((workItem) => [workItemKey(workItem), workItem]))
  const cycleLinks = snapshot.workItemLinks.filter((link) => link.cycleId === cycle.id)
  const cycleItems = cycleLinks
    .map((link) => ({ link, workItem: workItemsByKey.get(`${link.teamId}/${link.workItemId}`) }))
    .filter((entry): entry is { link: PlanningWorkItemLink; workItem: PlanningWorkItemSummary } =>
      entry.workItem !== undefined
    )
  const canChangeItems = Boolean(onSetCycleWorkItems) && canLink
  const backlog = resolveCycleBacklog(cycle, snapshot)
    .filter((workItem) => canUpdateWorkItemLink?.(workItem) ?? true)
  const overCapacity = summary.committed > summary.capacity
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold" data-testid="cycle-planning-summary">
        <span className={overCapacity ? 'workbench-badge-danger' : 'workbench-badge'}>
          {labels.commitment(summary.committed, summary.capacity)}
        </span>
        <span className="text-[var(--workbench-muted)]">
          {labels.remaining(Math.max(0, summary.capacity - summary.committed))}
        </span>
        {summary.carriedOver > 0 ? (
          <span className="workbench-badge" data-testid="cycle-planning-carried-over">
            {labels.carriedOver(summary.carriedOver)}
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-5 max-[1100px]:grid-cols-1">
        <CycleAutomationForm
          canManage={canManage && open && Boolean(onUpdateCycleAutomation)}
          cycle={cycle}
          labels={labels}
          onSave={onUpdateCycleAutomation}
        />
        <div className="grid content-start gap-3">
          {nextCycle ? (
            <p className="text-sm font-semibold text-[var(--workbench-text)]" data-testid="cycle-planning-next">
              {labels.nextExists(nextCycle.title)}
            </p>
          ) : (
            <button
              className="workbench-button-secondary min-h-10 px-4 disabled:opacity-50"
              data-testid="cycle-planning-create-next"
              disabled={!canManage || !onCreateNextCycle || cycle.status === 'canceled'}
              type="button"
              onClick={() => void onCreateNextCycle?.(cycle)}
            >
              {labels.createNext}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-5 max-[1100px]:grid-cols-1">
        <WorkItemSelection
          actionLabel={labels.add}
          disabled={!canChangeItems || !open}
          emptyLabel={labels.backlogEmpty}
          items={backlog.map((workItem) => ({ workItem }))}
          labels={labels}
          testId="cycle-planning-backlog"
          title={labels.backlog}
          onSubmit={(workItems) => onSetCycleWorkItems?.(cycle, 'add', workItems)}
        />
        <WorkItemSelection
          actionLabel={labels.remove}
          disabled={!canChangeItems}
          emptyLabel={labels.itemsEmpty}
          items={cycleItems.map(({ link, workItem }) => ({
            workItem,
            carriedOver: link.carriedOverFromCycleId !== undefined,
            // A read-only Work Item cannot be selected, so it cannot fail a whole removal.
            locked: !(canUpdateWorkItemLink?.(workItem) ?? true),
          }))}
          labels={labels}
          testId="cycle-planning-items"
          title={labels.items}
          onSubmit={(workItems) => onSetCycleWorkItems?.(cycle, 'remove', workItems)}
        />
      </div>
    </div>
  )
}

function CycleAutomationForm({
  canManage,
  cycle,
  labels,
  onSave,
}: {
  canManage: boolean
  cycle: PlanningEntity
  labels: CyclePlanningLabels
  onSave?: CyclePlanningPanelProps['onUpdateCycleAutomation']
}) {
  return (
    <form
      className="grid content-start gap-3"
      data-testid="cycle-planning-automation"
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const createNext = data.get('createNext') === 'on'
        const rolloverAtEnd = data.get('rolloverAtEnd') === 'on'
        void onSave?.(cycle, createNext || rolloverAtEnd ? { createNext, rolloverAtEnd } : null)
      }}
    >
      <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{labels.automation}</h3>
      <label className="flex items-start gap-2 text-sm font-medium text-[var(--workbench-text)]">
        <input
          className="mt-1"
          defaultChecked={cycle.automation?.createNext ?? false}
          disabled={!canManage}
          name="createNext"
          type="checkbox"
        />
        {labels.automationCreateNext}
      </label>
      <label className="flex items-start gap-2 text-sm font-medium text-[var(--workbench-text)]">
        <input
          className="mt-1"
          defaultChecked={cycle.automation?.rolloverAtEnd ?? false}
          disabled={!canManage}
          name="rolloverAtEnd"
          type="checkbox"
        />
        {labels.automationRolloverAtEnd}
      </label>
      <p className="text-xs font-medium text-[var(--workbench-muted)]">{labels.automationNote}</p>
      {canManage ? (
        <button className="workbench-button-secondary min-h-10 justify-self-start px-4" type="submit">
          {labels.automationSave}
        </button>
      ) : null}
    </form>
  )
}

function WorkItemSelection({
  actionLabel,
  disabled,
  emptyLabel,
  items,
  labels,
  onSubmit,
  testId,
  title,
}: {
  actionLabel: (count: number) => string
  disabled: boolean
  emptyLabel: string
  items: Array<{ workItem: PlanningWorkItemSummary; carriedOver?: boolean; locked?: boolean }>
  labels: CyclePlanningLabels
  onSubmit: (workItems: PlanningWorkItemSummary[]) => void | Promise<void>
  testId: string
  title: string
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const selectable = items.filter(({ locked }) => !locked)
  const available = new Set(selectable.map(({ workItem }) => workItemKey(workItem)))
  const selectedKeys = [...selected].filter((key) => available.has(key))
  const limitReached = selectedKeys.length >= CYCLE_WORK_ITEMS_BATCH_LIMIT
  const toggle = (key: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set([...current].filter((candidate) => available.has(candidate)))
      if (checked && next.size < CYCLE_WORK_ITEMS_BATCH_LIMIT) next.add(key)
      else next.delete(key)
      return next
    })
  }
  return (
    <form
      className="grid content-start gap-3"
      data-testid={testId}
      onSubmit={async (event) => {
        event.preventDefault()
        const keys = new Set(selectedKeys)
        const workItems = items
          .map(({ workItem }) => workItem)
          .filter((workItem) => keys.has(workItemKey(workItem)))
        if (workItems.length === 0) return
        await onSubmit(workItems)
        setSelected(new Set())
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{title}</h3>
        {!disabled && selectable.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            <button
              className="workbench-button-secondary min-h-8 px-3 text-xs"
              type="button"
              onClick={() => setSelected(new Set(
                selectable.slice(0, CYCLE_WORK_ITEMS_BATCH_LIMIT).map(({ workItem }) => workItemKey(workItem)),
              ))}
            >
              {labels.selectFirst(Math.min(selectable.length, CYCLE_WORK_ITEMS_BATCH_LIMIT))}
            </button>
            {selectedKeys.length > 0 ? (
              <button
                className="workbench-button-secondary min-h-8 px-3 text-xs"
                type="button"
                onClick={() => setSelected(new Set())}
              >
                {labels.clearSelection}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="text-sm font-medium text-[var(--workbench-muted)]">{emptyLabel}</p>
      ) : (
        <ul className="grid max-h-72 gap-1 overflow-y-auto rounded-lg border border-[var(--workbench-border)] p-2">
          {items.map(({ workItem, carriedOver, locked }) => {
            const key = workItemKey(workItem)
            const checked = selected.has(key)
            return (
              <li key={key}>
                <label className="flex min-w-0 items-center gap-2 rounded px-2 py-1 text-sm text-[var(--workbench-text)]">
                  <input
                    checked={checked}
                    disabled={disabled || locked || (!checked && limitReached)}
                    type="checkbox"
                    onChange={(event) => toggle(key, event.target.checked)}
                  />
                  <span className="min-w-0 flex-1 truncate">{workItem.title}</span>
                  {carriedOver ? (
                    <span className="workbench-badge shrink-0 text-xs">{labels.carriedOverBadge}</span>
                  ) : null}
                </label>
              </li>
            )
          })}
        </ul>
      )}
      {limitReached ? (
        <p className="text-xs font-medium text-[var(--workbench-muted)]">
          {labels.selectionLimit(CYCLE_WORK_ITEMS_BATCH_LIMIT)}
        </p>
      ) : null}
      {!disabled ? (
        <button
          className="workbench-button-primary min-h-10 justify-self-start px-4 disabled:opacity-50"
          disabled={selectedKeys.length === 0}
          type="submit"
        >
          {actionLabel(selectedKeys.length)}
        </button>
      ) : null}
    </form>
  )
}
