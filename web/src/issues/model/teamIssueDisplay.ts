import type { WorkItemConfiguration, WorkItemSchedule } from '@mukuroji/contracts'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { type TeamIssue } from '../api'
import { type ProjectDirectoryTeam, type ProjectMember } from '../../projects/api'
import type { WorkItemPriority } from '../../tasks/api'
import { formatTaskScheduleRange, taskScheduleModeLabelKeys } from '../../tasks/model/taskSchedule'
import { WorkItemConfigurationApiError } from '../../work-items/api'
import {
  isCustomFieldApplicable,
  sortCustomFieldDefinitions,
} from '../../work-items/model/customFields'
import {
  formatWorkItemCustomFieldValue,
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
  resolveWorkItemTypeLabel,
  resolveWorkItemTypeCustomFields,
  resolveWorkItemWorkflowStatusLabel,
  createWorkItemTypeWorkflowStatusKey,
  type WorkItemTypeWorkflowStatus,
} from '../../work-items/model/workItemDisplay'
import { type TaskViewGroupValue } from '../../task-views/model/taskViewPresentation'

/** Work Item priorities offered by the Team Work Item forms, highest first. */
export const issuePriorities = ['high', 'medium', 'low'] as const satisfies readonly WorkItemPriority[]

/**
 * Resolves a Team Issue status filter without conflating equal IDs across Type workflows.
 *
 * @param statusFilter - Current UI value, including a legacy bare status ID.
 * @param teamId - Team owning the current Issue surface.
 * @param statuses - Type-qualified statuses available to the Team.
 * @returns A valid Type-qualified filter value or the all-status sentinel.
 */
export function resolveTeamIssueStatusFilter(
  statusFilter: string,
  teamId: string,
  statuses: readonly WorkItemTypeWorkflowStatus[],
): string {
  if (statusFilter === 'all') return 'all'
  if (statuses.some(({ status, workItemTypeId }) =>
    createWorkItemTypeWorkflowStatusKey(teamId, workItemTypeId, status.id) === statusFilter
  )) return statusFilter
  const legacyMatches = statuses.filter(({ status }) => status.id === statusFilter)
  const [legacyMatch] = legacyMatches
  return legacyMatches.length === 1 && legacyMatch
    ? createWorkItemTypeWorkflowStatusKey(teamId, legacyMatch.workItemTypeId, legacyMatch.status.id)
    : 'all'
}

/** Resolves a stable key and visible label for one Team Issue grouping field. */
export function resolveTeamIssueGroupValue(
  issue: TeamIssue,
  field: string,
  configuration: WorkItemConfiguration | undefined,
  activeTeam: ProjectDirectoryTeam | undefined,
  t: (key: MessageKey) => string,
): TaskViewGroupValue {
  let value: string
  switch (field) {
    case 'title': value = resolveIssueTitle(issue, t); break
    case 'status': value = resolveWorkItemWorkflowStatusLabel(issue, configuration); break
    case 'assignee': value = resolveWorkItemAssignee(issue); break
    case 'dueDate': value = issue.dueDate || '—'; break
    case 'priority': value = t(`tasks.priority.${issue.priority}`); break
    case 'workItemType': value = resolveWorkItemTypeLabel(issue, configuration); break
    case 'project': value = resolveAssignedProjectName(issue, activeTeam, t); break
    case 'team': value = activeTeam?.name ?? issue.teamId; break
    default: {
      const customValue = field.startsWith('custom:')
        ? issue.customFieldValues[field.slice('custom:'.length)]
        : undefined
      value = Array.isArray(customValue)
        ? customValue.join(', ')
        : customValue === undefined || customValue === null || customValue === ''
          ? '—'
          : String(customValue)
    }
  }
  return { key: value, label: value }
}

/**
 * Formats a date as a local `YYYY-MM-DD` date input value.
 *
 * @param date - Date to format; defaults to now.
 * @returns The date input value.
 */
export function formatLocalDateInputValue(date = new Date()) {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

/**
 * Resolves the display title of a Work Item.
 *
 * @param issue - Work Item to display.
 * @param t - Message translator.
 * @returns The Work Item title.
 */
export function resolveIssueTitle(issue: TeamIssue, t: (key: MessageKey) => string) {
  void t
  return resolveWorkItemTitle(issue)
}

/**
 * Formats an explicit schedule without collapsing its mode into a deadline projection.
 *
 * @param schedule - Canonical schedule displayed by the read-only Team detail summary.
 * @param t - Translator used for the schedule mode label.
 * @returns A compact localized mode and date-range description.
 */
export function describeTeamIssueSchedule(
  schedule: WorkItemSchedule,
  t: (key: MessageKey) => string,
): string {
  const range = formatTaskScheduleRange(schedule)
  return `${t(taskScheduleModeLabelKeys[schedule.mode])}${range ? `: ${range}` : ''}`
}

/**
 * Resolves the display name of the Project a Work Item is assigned to.
 *
 * @param issue - Work Item to display.
 * @param team - Team that owns the Work Item.
 * @param t - Message translator.
 * @returns The Project name, or the unassigned label.
 */
export function resolveAssignedProjectName(
  issue: TeamIssue,
  team: ProjectDirectoryTeam | undefined,
  t: (key: MessageKey) => string,
) {
  if (!issue.assignedProjectId) {
    return t('issues.project.unassigned')
  }

  return team?.projects.find((project) => project.id === issue.assignedProjectId)?.name ?? issue.assignedProjectId
}

/**
 * Reads a Work Item priority from submitted form data.
 *
 * @param value - Raw form data entry.
 * @returns The submitted priority, or `medium` when the value is not a known priority.
 */
export function resolveIssuePriority(value: FormDataEntryValue | null): WorkItemPriority {
  return typeof value === 'string' && issuePriorities.includes(value as WorkItemPriority)
    ? value as WorkItemPriority
    : 'medium'
}

/**
 * Formats a Project member as an assignee option label.
 *
 * @param member - Project member to label.
 * @returns The member name with email, or the email alone.
 */
export function formatProjectMemberOption(member: ProjectMember) {
  return member.name ? `${member.name} (${member.email})` : member.email
}

/**
 * Resolves the displayable custom field values of a Work Item.
 *
 * @param issue - Work Item to display.
 * @param configuration - Work Item configuration that defines custom fields.
 * @param locale - Display locale.
 * @param personLabels - Display labels keyed by member key.
 * @returns The custom field label and value entries.
 */
export function resolveIssueCustomFieldEntries(
  issue: TeamIssue,
  configuration: WorkItemConfiguration | undefined,
  locale: Locale,
  personLabels: Readonly<Record<string, string>>,
) {
  if (!configuration) {
    return []
  }

  const t = createTranslator(locale)

  return sortCustomFieldDefinitions(
    resolveWorkItemTypeCustomFields(configuration, issue.workItemTypeId),
  ).flatMap((definition) => {
    const value = issue.customFieldValues?.[definition.id]

    if (
      value === undefined ||
      !isCustomFieldApplicable(definition, issue.assignedProjectId)
    ) {
      return []
    }

    return [{
      definition,
      value: formatWorkItemCustomFieldValue(issue, definition, {
        durationUnitLabels: {
          days: t('workItems.durationUnit.days'),
          hours: t('workItems.durationUnit.hours'),
          minutes: t('workItems.durationUnit.minutes'),
        },
        falseLabel: t('workItems.fields.booleanFalse'),
        locale,
        personLabels,
        trueLabel: t('workItems.fields.booleanTrue'),
      }),
    }]
  })
}

function resolveIssueCustomFieldSearchValues(
  issue: TeamIssue,
  configuration: WorkItemConfiguration | undefined,
  locale: Locale,
  personLabels: Readonly<Record<string, string>>,
) {
  return resolveIssueCustomFieldEntries(issue, configuration, locale, personLabels)
    .flatMap(({ definition, value }) => [definition.name, value])
}

/**
 * Identifies the canonical relation graph conflict returned by relation persistence.
 *
 * @param error - Unknown relation mutation failure.
 * @returns Whether the failure invalidated the retained relation graph revision.
 */
export function isWorkItemRelationGraphConflict(error: unknown): boolean {
  return error instanceof WorkItemConfigurationApiError &&
    error.code === 'WorkItemRelationGraphConflict'
}

/**
 * Matches the localized and formatted display values exposed by the Team Issue surface.
 *
 * @param issue - Team Work Item evaluated by keyword filtering.
 * @param normalizedKeyword - Trimmed lower-case keyword from the active task view.
 * @param team - Active Team directory entry used to resolve Project names.
 * @param configuration - Team workflow and custom-field configuration.
 * @param locale - Locale used to format typed custom-field values.
 * @param personLabels - Person identities mapped to display labels.
 * @param t - Translator used for priority, schedule, and fallback labels.
 * @returns Whether any Team-visible display value contains the keyword.
 */
export function matchesTeamIssueKeyword(
  issue: TeamIssue,
  normalizedKeyword: string,
  team: ProjectDirectoryTeam | undefined,
  configuration: WorkItemConfiguration | undefined,
  locale: Locale,
  personLabels: Readonly<Record<string, string>>,
  t: (key: MessageKey) => string,
): boolean {
  return [
    resolveIssueTitle(issue, t),
    resolveWorkItemAssignee(issue),
    resolveAssignedProjectName(issue, team, t),
    resolveWorkItemWorkflowStatusLabel(issue, configuration),
    resolveWorkItemTypeLabel(issue, configuration),
    t(`tasks.priority.${issue.priority}`),
    issue.dueDate,
    issue.schedule ? describeTeamIssueSchedule(issue.schedule, t) : '',
    ...resolveIssueCustomFieldSearchValues(
      issue,
      configuration,
      locale,
      personLabels,
    ),
  ].some((value) => value.toLocaleLowerCase().includes(normalizedKeyword))
}
