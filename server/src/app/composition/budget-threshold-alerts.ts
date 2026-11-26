import {
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  TIME_BUDGET_ALERT_PERCENT_DEFAULT,
  type ProjectExpense,
  type TimeBudget,
  type TimeEntry,
  type TenantProfile,
  type EnterpriseIdentitySnapshot,
} from '@mukuroji/contracts'
import { evaluateEnterpriseProjectManager, listEnterpriseProjectManagerKeys } from '../../modules/enterprise-identity'
import type {
  BudgetAlertProject,
  ScheduledBudgetThresholdReader,
  ScheduledProjectBudgetStatus,
} from '../../modules/notifications'
import { loadProjectBudgetConsumption } from '../../modules/project-budget'

/** Reads the budget threshold reader needs (ADR 0105). */
export type BudgetThresholdReaderSources = {
  /** Lists a Workspace's active Projects with their charter owner and managers. */
  readProjects(workspaceId: string): Promise<readonly BudgetAlertProject[]>
  /** Reads the Workspace profile for its time zone and status. */
  readProfile(workspaceId: string): Promise<Pick<TenantProfile, 'calendar' | 'status'> | undefined>
  /** Reads the default budget of a Project. */
  getBudget(workspaceId: string, teamId: string, projectId: string): Promise<TimeBudget | undefined>
  /** Lists the time entries of a Project that start within the UTC instants. */
  listEntries(input: {
    /** Workspace directory ID. */
    workspaceId: string
    /** Team ID. */
    teamId: string
    /** Project ID. */
    projectId: string
    /** Inclusive lower instant. */
    from: string
    /** Upper instant. */
    to: string
  }): Promise<readonly TimeEntry[]>
  /** Reads every expense of a Project. */
  listExpenses(workspaceId: string, teamId: string, projectId: string): Promise<readonly ProjectExpense[]>
  /** Reads the Workspace's Enterprise roles, when the deployment has them. */
  readEnterpriseSnapshot?(workspaceId: string): Promise<EnterpriseIdentitySnapshot>
}

/**
 * Narrows a Project's managers to those delivery will accept. A member an Enterprise role governs
 * counts only while that role manages the Project, and a member it does not govern counts by their
 * manager row. Members an Enterprise role makes managers are added. An owner whose standing
 * depends on sign-in groups is not preferred, so the other managers are told as well (ADR 0105).
 *
 * @param snapshot - Enterprise state of the Workspace.
 * @param project - Project with its charter owner and manager members.
 * @returns The effective managers and the owner to prefer.
 */
function selectEffectiveManagers(
  snapshot: EnterpriseIdentitySnapshot,
  project: BudgetAlertProject,
): Pick<BudgetAlertProject, 'managerMemberKeys' | 'ownerMemberKey'> {
  const legacy = new Set(project.managerMemberKeys)
  const statusOf = (memberKey: string) => evaluateEnterpriseProjectManager(snapshot, memberKey, project.teamId, project.projectId)
  const candidates = [...new Set([...project.managerMemberKeys, ...listEnterpriseProjectManagerKeys(snapshot, project.teamId, project.projectId)])]
  const managerMemberKeys = candidates.filter((memberKey) => {
    const status = statusOf(memberKey)
    return status === 'manager' || (status !== 'not-manager' && legacy.has(memberKey))
  })
  const owner = project.ownerMemberKey
  return {
    managerMemberKeys,
    ...(owner === undefined || statusOf(owner) === 'unknown' ? {} : { ownerMemberKey: owner }),
  }
}

/**
 * Adapts the Project Directory, time tracking, and Project expenses to the schedule's budget
 * threshold reader.
 *
 * Each Project's use is measured in the Workspace time zone the same way as the Project budget
 * report: time cost plus approved expenses in the budget currency. A Workspace being closed is
 * not checked. The managers are the Project's manager members and the members an Enterprise role
 * makes managers of the Project or its Team.
 *
 * @param sources - Directory, profile, budget, entry, and expense reads.
 * @returns Reader of budget use per active Project.
 */
export function createBudgetThresholdReader(sources: BudgetThresholdReaderSources): ScheduledBudgetThresholdReader {
  return {
    async listProjectBudgetStatuses(workspaceId, now) {
      const profile = await sources.readProfile(workspaceId)
      if (profile && profile.status !== 'active') return []
      const timeZone = (profile?.calendar ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS).timeZone
      const statuses: ScheduledProjectBudgetStatus[] = []
      let enterprise: EnterpriseIdentitySnapshot | undefined
      for (const project of await sources.readProjects(workspaceId)) {
        const consumption = await loadProjectBudgetConsumption(
          { workspaceId, teamId: project.teamId, projectId: project.projectId },
          timeZone,
          now,
          sources,
        )
        if (!consumption) continue
        const { budget } = consumption
        enterprise ??= await sources.readEnterpriseSnapshot?.(workspaceId)
        const { managerMemberKeys, ownerMemberKey } = enterprise
          ? selectEffectiveManagers(enterprise, project)
          : project
        statuses.push({
          teamId: project.teamId,
          projectId: project.projectId,
          amountMinor: budget.amountMinor,
          currency: budget.currency,
          ...(budget.periodFrom === undefined ? {} : { periodFrom: budget.periodFrom }),
          ...(budget.periodTo === undefined ? {} : { periodTo: budget.periodTo }),
          alertPercent: budget.alertPercent ?? TIME_BUDGET_ALERT_PERCENT_DEFAULT,
          consumedPercent: consumption.consumedPercent,
          ...(ownerMemberKey === undefined ? {} : { ownerMemberKey }),
          managerMemberKeys,
        })
      }
      return statuses
    },
  }
}
