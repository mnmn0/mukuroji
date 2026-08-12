import type {
  ConfirmedWorkItemSchedule,
  PlanningSnapshot,
} from '@mukuroji/contracts'
import type { ProjectTask } from '../api'

/**
 * Applies compact schedule confirmation results to every matching cached task.
 *
 * A newer cached revision wins over an older confirmation response so a later concurrent update
 * is never replaced while a background revalidation settles.
 *
 * @param tasks - Complete cached tasks that may include direct and dependency-propagated changes.
 * @param confirmedSchedules - Compact canonical results returned by schedule confirmation.
 * @returns Cached tasks with every matching non-newer schedule projection replaced.
 */
export function applyConfirmedSchedulesToTasks(
  tasks: readonly ProjectTask[],
  confirmedSchedules: readonly ConfirmedWorkItemSchedule[],
): ProjectTask[] {
  const confirmedSchedulesByKey = new Map(
    confirmedSchedules.map((confirmedSchedule) => [
      createWorkItemScheduleKey(confirmedSchedule.teamId, confirmedSchedule.id),
      confirmedSchedule,
    ]),
  )

  return tasks.map((task) => {
    const confirmedSchedule = confirmedSchedulesByKey.get(
      createWorkItemScheduleKey(task.teamId, task.id),
    )

    if (!confirmedSchedule || task.revision > confirmedSchedule.revision) {
      return task
    }

    return {
      ...task,
      assignedProjectId: confirmedSchedule.assignedProjectId,
      dueDate: confirmedSchedule.dueDate,
      revision: confirmedSchedule.revision,
      schedule: confirmedSchedule.schedule,
    }
  })
}

/**
 * Applies compact schedule confirmation results to matching Planning Work Item projections.
 *
 * @param snapshot - Cached Planning snapshot, when it has already loaded.
 * @param confirmedSchedules - Compact canonical results returned by schedule confirmation.
 * @returns The snapshot with every matching non-newer Work Item schedule replaced.
 */
export function applyConfirmedSchedulesToPlanningSnapshot(
  snapshot: PlanningSnapshot | undefined,
  confirmedSchedules: readonly ConfirmedWorkItemSchedule[],
): PlanningSnapshot | undefined {
  if (!snapshot) {
    return undefined
  }

  const confirmedSchedulesByKey = new Map(
    confirmedSchedules.map((confirmedSchedule) => [
      createWorkItemScheduleKey(confirmedSchedule.teamId, confirmedSchedule.id),
      confirmedSchedule,
    ]),
  )

  return {
    ...snapshot,
    workItems: snapshot.workItems.map((workItem) => {
      const confirmedSchedule = confirmedSchedulesByKey.get(
        createWorkItemScheduleKey(workItem.teamId, workItem.id),
      )

      if (!confirmedSchedule || workItem.revision > confirmedSchedule.revision) {
        return workItem
      }

      return {
        ...workItem,
        dueDate: confirmedSchedule.dueDate,
        projectId: confirmedSchedule.assignedProjectId,
        revision: confirmedSchedule.revision,
        schedule: confirmedSchedule.schedule,
      }
    }),
  }
}

/**
 * Creates a collision-free key for a Team-local Work Item schedule projection.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Team-local Work Item identifier.
 * @returns A cache-local composite key.
 */
function createWorkItemScheduleKey(teamId: string, workItemId: string): string {
  return JSON.stringify([teamId, workItemId])
}
