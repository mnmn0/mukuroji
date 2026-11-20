import type { ProjectDirectoryTeam } from '../../projects/api'
import type { TeamProjectMemberAccess } from '../../projects/model/teamInsights'

/**
 * One selectable value of a Workspace Search ID filter such as assignee, Team, or Project.
 */
export type SearchFilterOption = {
  /** Canonical ID written into the Search filter. */
  value: string
  /** Human-readable name shown in the picker. */
  label: string
  /** Secondary text, such as an email or the Teams that contain a Project. */
  description?: string
}

/**
 * Creates Team filter options from the Project directory, sorted by name.
 *
 * @param teams - Teams visible to the current user.
 * @returns One option per Team ID.
 */
export function createSearchTeamFilterOptions(
  teams: readonly ProjectDirectoryTeam[],
): SearchFilterOption[] {
  const optionsById = new Map<string, SearchFilterOption>()
  for (const team of teams) {
    if (!optionsById.has(team.id)) {
      optionsById.set(team.id, { label: team.name || team.id, value: team.id })
    }
  }
  return sortSearchFilterOptions([...optionsById.values()])
}

/**
 * Creates Project filter options from the Project directory.
 *
 * The Search filter matches a bare Project ID, so a Project listed under several Teams becomes
 * one option whose description names every Team that lists it.
 *
 * @param teams - Teams visible to the current user, each with its Projects.
 * @returns One option per Project ID, sorted by name.
 */
export function createSearchProjectFilterOptions(
  teams: readonly ProjectDirectoryTeam[],
): SearchFilterOption[] {
  const projectsById = new Map<string, { name: string; teamNames: string[] }>()
  for (const team of teams) {
    for (const project of team.projects) {
      const current = projectsById.get(project.id)
      const teamName = team.name || team.id
      if (current) {
        if (!current.teamNames.includes(teamName)) current.teamNames.push(teamName)
      } else {
        projectsById.set(project.id, { name: project.name || project.id, teamNames: [teamName] })
      }
    }
  }
  return sortSearchFilterOptions([...projectsById.entries()].map(([id, project]) => ({
    description: project.teamNames.join(', '),
    label: project.name,
    value: id,
  })))
}

/**
 * Creates member filter options from the members of the visible Projects.
 *
 * Inactive members stay selectable because past Work Items can still be assigned to them.
 *
 * @param members - Project members, possibly repeated across Projects.
 * @returns One option per member ID, sorted by display name.
 */
export function createSearchMemberFilterOptions(
  members: readonly TeamProjectMemberAccess[],
): SearchFilterOption[] {
  const optionsById = new Map<string, SearchFilterOption>()
  for (const { member } of members) {
    if (optionsById.has(member.id)) continue
    const label = member.name?.trim() || member.username?.trim() || member.email || member.id
    optionsById.set(member.id, {
      ...(member.email && member.email !== label ? { description: member.email } : {}),
      label,
      value: member.id,
    })
  }
  return sortSearchFilterOptions([...optionsById.values()])
}

/**
 * Adds selected values that are missing from the known options, so a filter from a URL or saved
 * view stays visible and removable even when its ID is no longer listed.
 *
 * @param options - Options known from the directory or member lists.
 * @param selectedValues - Values currently in the Search filter.
 * @returns The known options followed by the unknown selected IDs.
 */
export function includeSelectedSearchFilterOptions(
  options: readonly SearchFilterOption[],
  selectedValues: readonly string[],
): SearchFilterOption[] {
  const knownValues = new Set(options.map((option) => option.value))
  const missing = selectedValues
    .filter((value, index) => !knownValues.has(value) && selectedValues.indexOf(value) === index)
    .map((value) => ({ label: value, value }))
  return [...options, ...missing]
}

/**
 * Narrows options by a typed query over name, description, and ID.
 *
 * @param options - Options to narrow.
 * @param query - Text typed into the picker.
 * @returns Options whose label, description, or ID contains the query.
 */
export function filterSearchFilterOptions(
  options: readonly SearchFilterOption[],
  query: string,
): SearchFilterOption[] {
  const normalizedQuery = normalizeSearchFilterText(query)
  if (!normalizedQuery) return [...options]
  return options.filter((option) => [option.label, option.description ?? '', option.value]
    .some((text) => normalizeSearchFilterText(text).includes(normalizedQuery)))
}

/**
 * Normalizes picker text for case- and width-insensitive matching.
 *
 * @param value - Text to normalize.
 * @returns NFKC-normalized, lower-cased, trimmed text.
 */
function normalizeSearchFilterText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().trim()
}

/**
 * Sorts options by label, then by ID for stable order between equal names.
 *
 * @param options - Options to sort.
 * @returns A new sorted array.
 */
function sortSearchFilterOptions(options: SearchFilterOption[]) {
  return options.sort((first, second) =>
    first.label.localeCompare(second.label) || first.value.localeCompare(second.value))
}
