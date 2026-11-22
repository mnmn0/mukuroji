import type { AnalyticsGroupLabelLookup } from '@mukuroji/contracts'
import type { createTranslator, MessageKey } from '../../shared/i18n/i18n'
import type { ProjectDirectoryTeam } from '../../projects/api'

/** Display names that replace internal IDs in Analytics results. */
export type AnalyticsDisplayNames = {
  /** Team names keyed by Team ID. */
  teams: ReadonlyMap<string, string>
  /** Project names keyed by Project ID. */
  projects: ReadonlyMap<string, string>
  /** Member display names keyed by member key. */
  members: ReadonlyMap<string, string>
  /** `Team · Work Item Type` names keyed by Team-qualified Work Item Type key. */
  workItemTypes: ReadonlyMap<string, string>
}

/** Workflow status categories whose labels the Work Item messages define. */
const STATUS_CATEGORY_MESSAGE_KEYS: Readonly<Record<string, MessageKey>> = {
  backlog: 'workItems.statusCategory.backlog',
  unstarted: 'workItems.statusCategory.unstarted',
  started: 'workItems.statusCategory.started',
  completed: 'workItems.statusCategory.completed',
  canceled: 'workItems.statusCategory.canceled',
}

/**
 * Collects the names Analytics results show in place of Team, Project, member, and Work Item Type
 * IDs.
 *
 * @param teams - Visible Teams with their Projects.
 * @param workItemTypes - Work Item Type options with their filter keys and labels.
 * @param members - Members with display names; a member without a name shows the email.
 * @returns The display names.
 */
export function createAnalyticsDisplayNames(
  teams: readonly ProjectDirectoryTeam[],
  workItemTypes: readonly { filterValue: string; label: string }[],
  members: readonly { id: string; email: string; name?: string }[] = [],
): AnalyticsDisplayNames {
  return {
    teams: new Map(teams.map((team) => [team.id, team.name])),
    projects: new Map(teams.flatMap((team) =>
      team.projects.map((project): [string, string] => [project.id, project.name])
    )),
    members: new Map(members.map((member) => [member.id, member.name?.trim() || member.email])),
    workItemTypes: new Map(workItemTypes.map((type) => [type.filterValue, type.label])),
  }
}

/**
 * Creates the lookup that resolves Analytics group labels for the current locale.
 *
 * @param names - Display names.
 * @param t - Translator of the current locale.
 * @returns The lookup for `resolveAnalyticsGroupLabel`.
 */
export function createAnalyticsGroupLabelLookup(
  names: AnalyticsDisplayNames,
  t: ReturnType<typeof createTranslator>,
): AnalyticsGroupLabelLookup {
  return {
    team: (teamId) => names.teams.get(teamId),
    project: (projectId) => names.projects.get(projectId),
    member: (memberKey) => names.members.get(memberKey),
    workItemType: (key) => names.workItemTypes.get(key),
    statusCategory: (category) => {
      const key = Object.hasOwn(STATUS_CATEGORY_MESSAGE_KEYS, category)
        ? STATUS_CATEGORY_MESSAGE_KEYS[category]
        : undefined
      return key === undefined ? undefined : t(key)
    },
    unset: t('analytics.group.unset'),
  }
}
