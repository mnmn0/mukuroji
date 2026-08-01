import type { MessageKey } from '../ja'

/**
 * English messages for searchable Project discovery and quick-access actions.
 */
export const projectsMessages = {
  'projects.directory.eyebrow': 'Workspace',
  'projects.directory.title': 'All projects',
  'projects.directory.teamTitle': '{team} projects',
  'projects.directory.description':
    'Search projects across teams and filter them by assignee or status.',
  'projects.directory.teamDescription':
    'Search {team} projects and filter them by assignee or status.',
  'projects.directory.resultCount': '{filtered} of {total}',
  'projects.directory.searchLabel': 'Search projects',
  'projects.directory.searchPlaceholder': 'Search projects, teams, or assignees',
  'projects.directory.teamFilter': 'Team',
  'projects.directory.statusFilter': 'Status',
  'projects.directory.assigneeFilter': 'Assignee',
  'projects.directory.filterAll': 'All',
  'projects.directory.quickAccessOnly': 'Starred only',
  'projects.directory.clearFilters': 'Clear filters',
  'projects.directory.status.active': 'Active',
  'projects.directory.status.attention': 'Needs attention',
  'projects.directory.status.completed': 'Completed',
  'projects.directory.status.notStarted': 'Not started',
  'projects.directory.assignee.unassigned': 'Unassigned',
  'projects.directory.assignee.more': '{count} more',
  'projects.directory.column.project': 'Project',
  'projects.directory.column.team': 'Team',
  'projects.directory.column.status': 'Status',
  'projects.directory.column.assignee': 'Assignee',
  'projects.directory.column.progress': 'Progress',
  'projects.directory.column.workItems': 'Issues',
  'projects.directory.column.actions': 'Actions',
  'projects.directory.workItems': '{open} open of {total}',
  'projects.directory.open': 'Open {name}',
  'projects.directory.quickAccess.add': 'Add {name} to quick access',
  'projects.directory.quickAccess.remove': 'Remove {name} from quick access',
  'projects.directory.quickAccess.saving': 'Saving quick access',
  'projects.directory.quickAccess.unavailable': 'Quick access is temporarily unavailable',
  'projects.quickAccess.feedback.added': 'Added {name} to quick access',
  'projects.quickAccess.feedback.removed': 'Removed {name} from quick access',
  'projects.quickAccess.feedback.error': 'Could not update quick access',
  'projects.quickAccess.feedback.undo': 'Undo',
  'projects.quickAccess.feedback.dismiss': 'Dismiss notification',
  'projects.quickAccess.loadError':
    'Quick access could not be loaded. Project stars are temporarily unavailable.',
  'projects.quickAccess.retry': 'Retry quick access',
  'projects.directory.archive.label': 'Archive {name}',
  'projects.directory.archive.title': 'Archive project',
  'projects.directory.archive.description':
    'Archive {name} and hide it from the directory and sidebar. It cannot currently be restored from this screen.',
  'projects.directory.archive.cancel': 'Cancel',
  'projects.directory.archive.confirm': 'Archive',
  'projects.directory.archive.saving': 'Archiving',
  'projects.directory.archive.error': 'Could not archive the project.',
  'projects.directory.empty.title': 'No projects yet',
  'projects.directory.empty.description':
    'Create a project to start using search and quick access.',
  'projects.directory.emptyFiltered.title': 'No projects match these filters',
  'projects.directory.emptyFiltered.description':
    'Change the search or filter values and try again.',
  'projects.directory.pagination.previous': 'Previous',
  'projects.directory.pagination.next': 'Next',
  'projects.directory.pagination.label': 'Page {page} of {pages}',
} as const satisfies Record<
  Extract<
    MessageKey,
    `projects.directory.${string}` | `projects.quickAccess.${string}`
  >,
  string
>
