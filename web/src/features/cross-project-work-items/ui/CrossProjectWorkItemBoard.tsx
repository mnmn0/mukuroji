import type { CanonicalWorkItem, ResolvedWorkItemConfiguration } from '@mukuroji/contracts'
import { useMemo } from 'react'
import type { ProjectDirectoryTeam } from '../../../projects/api/directory'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { CompactTaskCard } from '../../../work-items/ui/WorkspaceWorkItemPrimitives'
import {
  createCrossProjectWorkItemBoardLane,
  type CrossProjectWorkItemGroup,
  type CrossProjectWorkItemGrouping,
} from '../model/crossProjectWorkItems'

/** Props of {@link CrossProjectWorkItemBoard}. */
export type CrossProjectWorkItemBoardProps = {
  /** Grouped, filtered Work Items; each group becomes one swimlane. */
  groups: CrossProjectWorkItemGroup[]
  /** Grouping of the list, which decides the card fields and the heading of the unassigned lane. */
  grouping: CrossProjectWorkItemGrouping
  /** Resolved Team configurations used for columns and status labels, keyed by Team ID. */
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>
  /** Workspace directory used for Team and Project names. */
  teams: readonly ProjectDirectoryTeam[]
  /** Translation function for the current locale. */
  t: (key: MessageKey) => string
  /** Opens one Work Item in its Team or Project route. */
  onOpenWorkItem: (workItem: CanonicalWorkItem) => void
}

/**
 * Renders the cross-Project Work Items as a read-only board: one swimlane per group, with the
 * workflow status columns of the Teams in that swimlane.
 *
 * Cards only open the Work Item; status changes stay in the Project and Team views, where the
 * viewer's write permission is checked per Work Item.
 *
 * @param props - Groups, configurations, directory, and the open callback.
 * @returns One board section per group.
 */
export function CrossProjectWorkItemBoard({
  groups,
  grouping,
  configurationsByTeam,
  teams,
  t,
  onOpenWorkItem,
}: CrossProjectWorkItemBoardProps) {
  const lanes = useMemo(
    () => groups.map((group) => ({
      group,
      lane: createCrossProjectWorkItemBoardLane(group.workItems, configurationsByTeam, teams),
    })),
    [configurationsByTeam, groups, teams],
  )
  // The swimlane already names the Project or the owner, so the card shows the other one.
  const cardFields = grouping === 'assignee'
    ? ['title', 'project', 'dueDate', 'priority']
    : ['title', 'assignee', 'dueDate', 'priority']

  /**
   * Renders one read-only card.
   *
   * @param workItem - Work Item shown by the card.
   * @param showStatus - Whether the card shows its status, for cards outside the status columns.
   * @returns The card element.
   */
  const renderCard = (workItem: CanonicalWorkItem, showStatus: boolean) => {
    const team = teams.find((candidate) => candidate.id === workItem.teamId)
    const project = team?.projects.find((candidate) => candidate.id === workItem.assignedProjectId)
    return (
      <li key={`${workItem.teamId}:${workItem.id}`}>
        <CompactTaskCard
          configuration={configurationsByTeam[workItem.teamId]?.configuration}
          density="compact"
          onOpenTask={onOpenWorkItem}
          projectLabel={project ? `${project.name} · ${team?.name ?? workItem.teamId}` : undefined}
          t={t}
          task={workItem}
          testId="cross-project-work-item-card"
          visibleFields={showStatus ? [...cardFields, 'status'] : cardFields}
        />
      </li>
    )
  }

  return (
    <div className="grid gap-4" data-testid="cross-project-work-item-board">
      {lanes.map(({ group, lane }) => {
        const heading = group.isUnassigned
          ? t(grouping === 'assignee'
            ? 'workItems.crossProject.group.noAssignee'
            : 'workItems.crossProject.group.noProject')
          : group.label
        return (
          <section
            aria-label={heading}
            className="workbench-panel grid gap-3 px-4 py-3"
            data-testid="cross-project-work-item-lane"
            key={group.key}
          >
            <h2 className="flex items-baseline gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              <span>{heading}</span>
              {group.detail ? (
                <span className="text-xs font-normal text-[var(--workbench-muted)]">{group.detail}</span>
              ) : null}
              <span className="workbench-badge px-2 text-xs">{group.workItems.length}</span>
            </h2>
            <div className="grid auto-cols-[minmax(220px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2 max-[760px]:grid-flow-row max-[760px]:grid-cols-1 max-[760px]:overflow-visible">
              {lane.columns.map((column) => (
                <section
                  aria-label={column.label}
                  className="grid content-start gap-2 rounded-lg bg-[var(--workbench-surface-muted)] p-2"
                  data-testid="cross-project-work-item-column"
                  key={column.key}
                >
                  <h3 className="flex items-center justify-between gap-2 px-1 text-xs font-semibold text-[var(--workbench-muted)]">
                    <span className="truncate">{column.label}</span>
                    <span>{column.workItems.length}</span>
                  </h3>
                  <ul className="grid gap-2">
                    {column.workItems.map((workItem) => renderCard(workItem, false))}
                  </ul>
                </section>
              ))}
              {lane.unplacedWorkItems.length > 0 ? (
                <section
                  aria-label={t('workItems.crossProject.board.unplaced')}
                  className="grid content-start gap-2 rounded-lg bg-[var(--workbench-surface-muted)] p-2"
                  data-testid="cross-project-work-item-column"
                >
                  <h3 className="flex items-center justify-between gap-2 px-1 text-xs font-semibold text-[var(--workbench-muted)]">
                    <span className="truncate">{t('workItems.crossProject.board.unplaced')}</span>
                    <span>{lane.unplacedWorkItems.length}</span>
                  </h3>
                  <ul className="grid gap-2">
                    {lane.unplacedWorkItems.map((workItem) => renderCard(workItem, true))}
                  </ul>
                </section>
              ) : null}
            </div>
          </section>
        )
      })}
    </div>
  )
}
