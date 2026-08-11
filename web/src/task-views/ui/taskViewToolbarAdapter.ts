import type {
  SavedTaskView,
  TaskViewMigrationWarning,
} from '@mukuroji/contracts'
import type { TaskViewOption } from './TaskViewToolbar'

/**
 * Maps a persisted task view to the presentation model consumed by the shared toolbar.
 *
 * @param view - Persisted task view with viewer-specific lifecycle preferences.
 * @returns A compact toolbar option with personal and Team defaults separated.
 */
export function createTaskViewOption(view: SavedTaskView): TaskViewOption {
  return {
    canEdit: view.canEdit,
    favorite: view.preference.favorite,
    id: view.id,
    isPersonalDefault: view.preference.isPersonalDefault,
    isTeamDefault: view.preference.isTeamDefault,
    name: view.name,
    pinned: view.preference.pinned,
    ...(view.teamId ? { teamId: view.teamId } : {}),
    visibility: view.visibility,
  }
}

/**
 * Formats one safe migration warning without exposing a redacted identifier.
 *
 * @param warning - Migration result returned by the task-view controller.
 * @returns A stable short explanation for the toolbar warning list.
 */
export function formatTaskViewMigrationWarning(
  warning: TaskViewMigrationWarning,
): string {
  return warning.referenceId
    ? `${warning.code}: ${warning.referenceId}`
    : `${warning.code} (${warning.section})`
}
