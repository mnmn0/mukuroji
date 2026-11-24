import type { DirectoryAdministrationTeam, DirectoryTeamMemberRole } from '@mukuroji/contracts'
import type { ProjectDirectoryProject } from '../api/directory'
import type { TeamProjectMemberAccess } from './teamInsights'

/** One Project a Team member belongs to, with the member's role on it. */
export type TeamProfileMemberProject = {
  /** Project identifier. */
  projectId: string
  /** Project display name. */
  projectName: string
  /** Member's role on the Project. */
  role: DirectoryTeamMemberRole
}

/** One member of a Team, gathered from the members of its Projects. */
export type TeamProfileMember = {
  /** Normalized member key. */
  id: string
  /** Display name, or the email address when no name is known. */
  label: string
  /** Email address. */
  email: string
  /** Projects of the Team the member belongs to, in Team order. */
  projects: TeamProfileMemberProject[]
}

/**
 * Lists the active Projects of a Team as directory Projects, named in the given locale.
 *
 * @param team - Administered Team row.
 * @param locale - Locale of the names.
 * @returns Active Projects in display order.
 */
export function listTeamProfileProjects(
  team: DirectoryAdministrationTeam,
  locale: 'ja' | 'en',
): ProjectDirectoryProject[] {
  return team.projects
    .filter((project) => project.archivedAt === undefined)
    .map((project) => ({ id: project.id, name: locale === 'en' ? project.nameEn : project.nameJa }))
}

/**
 * Gathers the members of a Team from the members of its Projects, one row per member.
 *
 * @param entries - Project member rows of every Project of the Team.
 * @param projects - Projects of the Team in display order.
 * @returns Members sorted by label, each with their Projects in Team order.
 */
export function summarizeTeamProfileMembers(
  entries: readonly TeamProjectMemberAccess[],
  projects: readonly ProjectDirectoryProject[],
): TeamProfileMember[] {
  const projectOrder = new Map(projects.map((project, index) => [project.id, index]))
  const members = new Map<string, TeamProfileMember>()

  for (const entry of entries) {
    const existing = members.get(entry.member.id)
    const member = existing ?? {
      id: entry.member.id,
      label: entry.member.name ?? entry.member.email,
      email: entry.member.email,
      projects: [],
    }
    member.projects.push({
      projectId: entry.projectId,
      projectName: entry.projectName,
      role: entry.member.role,
    })
    members.set(member.id, member)
  }

  return [...members.values()]
    .map((member) => ({
      ...member,
      projects: [...member.projects].sort((left, right) =>
        (projectOrder.get(left.projectId) ?? Number.MAX_SAFE_INTEGER) -
        (projectOrder.get(right.projectId) ?? Number.MAX_SAFE_INTEGER)
      ),
    }))
    .sort((left, right) => left.label.localeCompare(right.label))
}
